import JSZip from 'jszip';
import type { NormalizedPoint, TumorGroundTruthRow, TumorThreshold, ViewerTransform } from '../../../db/schema';
import type { ViewportSize } from '../../viewTransform';
import type { TumorHarnessCaseV1, TumorHarnessDatasetV1, TumorHarnessPropagationScenarioV1 } from './dataset';
import { bytesToBase64 } from './base64';
import { remapPointsToImage01, remapPolygonToImage01 } from './canonicalize';
import { loadCornerstoneSliceToGrayscale } from './loadCornerstoneGrayscale';
import { generateSyntheticPaintPointsFromGt } from './syntheticPaint';
import { getSortedSopInstanceUidsForSeries } from '../../localApi';

export type ExportTumorHarnessDatasetInput = {
  maxEvalDim: number;

  // Export per-slice cases for all GT rows.
  gtRows: TumorGroundTruthRow[];
  paintPointsPerCase?: number;

  // Optional propagation scenario derived from the current paint gesture.
  propagationScenario?: {
    comboId: string;
    dateIso: string;
    studyId: string;
    seriesUid: string;

    startEffectiveIndex: number;
    startSopInstanceUid: string;

    paintPointsViewer01: NormalizedPoint[];
    paintPointsViewTransform?: ViewerTransform | null;
    viewportSize: ViewportSize;

    threshold?: TumorThreshold;

    stop?: {
      minAreaPx: number;
      maxMissesInARow: number;
    };

    // How many slices to include beyond the GT min/max range.
    marginSlices?: number;
  };

  onProgress?: (msg: string) => void;
};

function sanitizeNumber(v: number): number {
  return Number.isFinite(v) ? v : 0;
}

function safeViewportSize(v: { w: number; h: number } | null | undefined): ViewportSize {
  const w = Math.max(1, Math.round(sanitizeNumber(v?.w ?? 0)));
  const h = Math.max(1, Math.round(sanitizeNumber(v?.h ?? 0)));
  return { w, h };
}

function downloadBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  try {
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.rel = 'noopener';
    a.click();
  } finally {
    URL.revokeObjectURL(url);
  }
}

export async function exportTumorHarnessDatasetToZip(input: ExportTumorHarnessDatasetInput): Promise<{
  dataset: TumorHarnessDatasetV1;
  zipBlob: Blob;
}> {
  const maxEvalDim = Math.max(16, Math.round(input.maxEvalDim));
  const paintPointsPerCase = Math.max(8, Math.round(input.paintPointsPerCase ?? 24));

  const cases: TumorHarnessCaseV1[] = [];

  const gtRows = input.gtRows.filter((r) => (r.polygon?.points?.length ?? 0) >= 3);

  input.onProgress?.(`Export: building cases from ${gtRows.length} GT rows…`);

  for (let i = 0; i < gtRows.length; i++) {
    const r = gtRows[i]!;

    input.onProgress?.(`Export: loading GT slice ${i + 1}/${gtRows.length}…`);

    const img = await loadCornerstoneSliceToGrayscale({ sopInstanceUid: r.sopInstanceUid, maxEvalDim });
    const imageSize = { w: img.w, h: img.h };

    // Prefer recorded viewport size; fall back to the common capture size.
    const viewport = safeViewportSize(r.viewportSize ?? { w: 512, h: 512 });

    const gtPolygonImage01 = remapPolygonToImage01({
      polygon: r.polygon,
      viewportSize: viewport,
      fromViewTransform: r.viewTransform,
      imageSize,
    });

    const paintPointsImage01 = generateSyntheticPaintPointsFromGt(gtPolygonImage01, r.id, paintPointsPerCase);

    cases.push({
      id: r.id,
      comboId: r.comboId,
      dateIso: r.dateIso,
      studyId: r.studyId,
      seriesUid: r.seriesUid,
      sopInstanceUid: r.sopInstanceUid,
      image: {
        w: img.w,
        h: img.h,
        sourceW: img.sourceW,
        sourceH: img.sourceH,
        grayB64: bytesToBase64(img.gray),
      },
      gtPolygonImage01,
      paintPointsImage01,
    });
  }

  let propagationScenarios: TumorHarnessPropagationScenarioV1[] | undefined;

  if (input.propagationScenario) {
    const s = input.propagationScenario;

    input.onProgress?.('Export: building propagation scenario…');

    const uids = await getSortedSopInstanceUidsForSeries(s.seriesUid);
    const uidToIndex = new Map<string, number>();
    for (let idx = 0; idx < uids.length; idx++) {
      const uid = uids[idx];
      if (uid) uidToIndex.set(uid, idx);
    }

    const gtInSeries = gtRows.filter((r) => r.seriesUid === s.seriesUid);
    const gtIdxs = gtInSeries
      .map((r) => uidToIndex.get(r.sopInstanceUid))
      .filter((v): v is number => typeof v === 'number' && Number.isFinite(v));

    const margin = Math.max(0, Math.round(s.marginSlices ?? 2));
    let minIdx = gtIdxs.length ? Math.max(0, Math.min(...gtIdxs) - margin) : Math.max(0, s.startEffectiveIndex - margin);
    let maxIdx = gtIdxs.length
      ? Math.min(uids.length - 1, Math.max(...gtIdxs) + margin)
      : Math.min(uids.length - 1, s.startEffectiveIndex + margin);

    const startIdx = Math.max(0, Math.min(uids.length - 1, Math.round(s.startEffectiveIndex)));

    // Always include the start slice, even if GT range is elsewhere.
    minIdx = Math.min(minIdx, startIdx);
    maxIdx = Math.max(maxIdx, startIdx);

    // Precompute GT polygons per SOP in image coords (using each row's saved viewport size).
    const gtBySop = new Map<string, { polygon: TumorGroundTruthRow['polygon']; viewTransform?: ViewerTransform; viewportSize?: ViewportSize }>();
    for (const r of gtInSeries) {
      gtBySop.set(r.sopInstanceUid, { polygon: r.polygon, viewTransform: r.viewTransform, viewportSize: r.viewportSize });
    }

    const frames: TumorHarnessPropagationScenarioV1['frames'] = [];

    for (let idx = minIdx; idx <= maxIdx; idx++) {
      const sop = uids[idx];
      if (!sop) continue;

      input.onProgress?.(`Export: loading series slice ${idx + 1}/${uids.length}…`);

      const img = await loadCornerstoneSliceToGrayscale({ sopInstanceUid: sop, maxEvalDim });
      const imageSize = { w: img.w, h: img.h };

      const gt = gtBySop.get(sop);
      const gtPolygonImage01 = gt
        ? remapPolygonToImage01({
            polygon: gt.polygon,
            viewportSize: safeViewportSize(gt.viewportSize ?? { w: 512, h: 512 }),
            fromViewTransform: gt.viewTransform,
            imageSize,
          })
        : undefined;

      frames.push({
        effectiveIndex: idx,
        sopInstanceUid: sop,
        image: {
          w: img.w,
          h: img.h,
          sourceW: img.sourceW,
          sourceH: img.sourceH,
          grayB64: bytesToBase64(img.gray),
        },
        gtPolygonImage01,
      });

      // Small yield to keep the UI responsive.
      await new Promise<void>((resolve) => window.setTimeout(resolve, 0));
    }

    // Convert recorded start paint points to image coords at the start frame's eval size.
    const startFrame = frames.find((f) => f.effectiveIndex === startIdx);
    if (!startFrame) {
      throw new Error('Propagation scenario export failed: start frame not found in exported range');
    }

    const startPaintImage01 = remapPointsToImage01({
      points: s.paintPointsViewer01,
      viewportSize: safeViewportSize(s.viewportSize),
      fromViewTransform: s.paintPointsViewTransform,
      imageSize: { w: startFrame.image.w, h: startFrame.image.h },
    });

    const scenario: TumorHarnessPropagationScenarioV1 = {
      id: `${s.seriesUid}::start=${startIdx}::${new Date().toISOString()}`,
      comboId: s.comboId,
      dateIso: s.dateIso,
      studyId: s.studyId,
      seriesUid: s.seriesUid,
      frames,
      start: {
        effectiveIndex: startIdx,
        sopInstanceUid: s.startSopInstanceUid,
        paintPointsImage01: startPaintImage01,
        threshold: s.threshold,
      },
      stop: s.stop,
      note: 'Frames are downsampled+normalized DICOM pixel data. Start paint points are exported from the overlay and remapped into image coords.',
    };

    propagationScenarios = [scenario];
  }

  const dataset: TumorHarnessDatasetV1 = {
    version: 1,
    generatedAtIso: new Date().toISOString(),
    settings: { maxEvalDim },
    cases,
    propagationScenarios,
    note: 'Generated from MiraViewer IndexedDB GT polygons and Cornerstone pixel data. GT is remapped via saved viewTransform + viewportSize into image coordinates.',
  };

  const zip = new JSZip();
  zip.file('dataset.json', JSON.stringify(dataset, null, 2));

  input.onProgress?.('Export: creating zip…');

  const zipBlob = await zip.generateAsync({
    type: 'blob',
    compression: 'DEFLATE',
    compressionOptions: { level: 6 },
  });

  return { dataset, zipBlob };
}

export async function exportTumorHarnessDatasetAndDownload(input: ExportTumorHarnessDatasetInput): Promise<void> {
  const { zipBlob } = await exportTumorHarnessDatasetToZip(input);

  const dt = new Date();
  const stamp = `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}-${String(dt.getDate()).padStart(2, '0')}_${String(
    dt.getHours()
  ).padStart(2, '0')}${String(dt.getMinutes()).padStart(2, '0')}${String(dt.getSeconds()).padStart(2, '0')}`;

  downloadBlob(zipBlob, `miraviewer_tumor_harness_${stamp}.zip`);
}
