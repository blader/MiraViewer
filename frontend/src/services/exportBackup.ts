import JSZip from 'jszip';
import { getDB } from '../db/db';
import type { DicomStudy, DicomSeries, DicomInstance } from '../db/schema';

export type ExportProgress = {
  stage: 'collecting' | 'zipping' | 'finalizing';
  current: number;
  total: number;
  detail?: string;
};

function sanitizeFilename(name: string): string {
  if (!name) return 'unknown';
  return name.replace(/[\\/:"*?<>|]+/g, '_').trim().slice(0, 80);
}

function formatStudyFolder(study: DicomStudy): string {
  const date = study.studyDate || 'unknown_date';
  const desc = sanitizeFilename(study.studyDescription || study.modality || 'study');
  return `${date}_${desc}`;
}

function formatSeriesFolder(series: DicomSeries): string {
  const num = Number.isFinite(series.seriesNumber) ? String(series.seriesNumber).padStart(2, '0') : '00';
  const desc = sanitizeFilename(series.seriesDescription || 'series');
  return `${num}_${desc}`;
}

function toMetadata(instance: DicomInstance) {
  return {
    sopInstanceUid: instance.sopInstanceUid,
    seriesInstanceUid: instance.seriesInstanceUid,
    studyInstanceUid: instance.studyInstanceUid,
    instanceNumber: instance.instanceNumber,
    rows: instance.rows,
    columns: instance.columns,
    sliceLocation: instance.sliceLocation ?? null,
    imagePositionPatient: instance.imagePositionPatient ?? null,
    imageOrientationPatient: instance.imageOrientationPatient ?? null,
    pixelSpacing: instance.pixelSpacing ?? null,
    sliceThickness: instance.sliceThickness ?? null,
    windowCenter: instance.windowCenter ?? null,
    windowWidth: instance.windowWidth ?? null,
  };
}

async function toArrayBuffer(value: unknown): Promise<ArrayBuffer> {
  if (value instanceof ArrayBuffer) return value;
  if (ArrayBuffer.isView(value)) return value.buffer;
  if (value && typeof (value as Blob).arrayBuffer === 'function') {
    return (value as Blob).arrayBuffer();
  }
  // Fallback: wrap into a Blob
  return new Blob([value as BlobPart]).arrayBuffer();
}

export async function exportStudiesToZip(
  studyIds: string[],
  onProgress?: (p: ExportProgress) => void
): Promise<Blob> {
  const db = await getDB();
  const zip = new JSZip();
  const exportedAt = new Date().toISOString();

  const manifest = {
    exportedAt,
    studyIds,
    version: 1,
  };
  zip.file('export.json', JSON.stringify(manifest, null, 2));

  let totalSteps = 0;
  let currentStep = 0;

  // Pre-count for progress
  for (const studyId of studyIds) {
    const series = await db.getAllFromIndex('series', 'by-study', studyId);
    for (const s of series) {
      const instances = await db.getAllFromIndex('instances', 'by-series', s.seriesInstanceUid);
      totalSteps += instances.length;
    }
  }

  for (const studyId of studyIds) {
    const study = await db.get('studies', studyId);
    if (!study) continue;

    const studyFolder = zip.folder(formatStudyFolder(study));
    if (!studyFolder) continue;

    studyFolder.file('study.json', JSON.stringify(study, null, 2));

    const series = await db.getAllFromIndex('series', 'by-study', studyId);
    for (const s of series) {
      const seriesFolder = studyFolder.folder(formatSeriesFolder(s));
      if (!seriesFolder) continue;

      seriesFolder.file('series.json', JSON.stringify(s, null, 2));

      const instances = await db.getAllFromIndex('instances', 'by-series', s.seriesInstanceUid);
      instances.sort((a, b) => a.instanceNumber - b.instanceNumber);

      const instanceMeta: ReturnType<typeof toMetadata>[] = [];
      for (const inst of instances) {
        instanceMeta.push(toMetadata(inst));

        const filename = `${String(inst.instanceNumber).padStart(4, '0')}_${inst.sopInstanceUid}.dcm`;
        // Convert to ArrayBuffer to ensure JSZip can reliably consume the blob across environments.
        // This avoids rare incompatibilities with Blob implementations (e.g. test runners).
        const buffer = await toArrayBuffer(inst.fileBlob);
        seriesFolder.file(filename, buffer);

        currentStep++;
        onProgress?.({
          stage: 'collecting',
          current: currentStep,
          total: Math.max(totalSteps, 1),
          detail: `Series ${s.seriesNumber || 0} · ${inst.instanceNumber || 0}`,
        });
      }

      seriesFolder.file('instances.json', JSON.stringify(instanceMeta, null, 2));
    }
  }

  onProgress?.({ stage: 'zipping', current: 0, total: 100 });

  const blob = await zip.generateAsync(
    { type: 'blob', compression: 'DEFLATE', compressionOptions: { level: 6 } },
    (metadata) => {
      onProgress?.({
        stage: 'zipping',
        current: Math.round(metadata.percent),
        total: 100,
      });
    }
  );

  onProgress?.({ stage: 'finalizing', current: 1, total: 1 });
  return blob;
}
