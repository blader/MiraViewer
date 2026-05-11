import cornerstone from 'cornerstone-core';
import { getDB } from '../../db/db';
import type { DicomInstance } from '../../db/schema';
import type { SvrParams, SvrProgress, SvrResult, SvrRoi, SvrSelectedSeries } from '../../types/svr';
import { getSortedSopInstanceUidsForSeries } from '../localApi';
import type { SliceGeometry } from './dicomGeometry';
import { getSliceGeometryFromInstance, sliceCornersMm } from './dicomGeometry';
import type { VolumeDims } from './trilinear';
import type { SvrReconstructionGrid, SvrReconstructionOptions } from './reconstructionCore';
import { reconstructVolumeFromSlices, refineVolumeInPlace, resampleVolumeToGridTrilinear } from './reconstructionCore';
import { computeSvrDownsampleSize } from './downsample';
import { resample2dAreaAverage, resample2dLanczos3 } from './resample2d';
import type { Vec3 } from './vec3';
import { dot, v3 } from './vec3';
import { boundsCornersMm, cropSliceToRoiInPlace } from './sliceRoiCrop';
import { generateVolumePreviews } from './volumePreview';
import { debugSvrLog, isDebugSvrEnabled } from '../debugSvr';
import { clamp01 } from '../math';
import {
  applyRigidToSeriesSlices,
  boundsCenterMm,
  buildSeriesSamples,
  mat3FromEulerXYZ,
  optimizeRigidNcc,
  scoreNcc,
  type BoundsMm,
  type LoadedSlice,
} from './rigidRegistration';
import { assertNotAborted, yieldToMain } from './svrUtils';

type SvrSliceResampleKernel = 'area' | 'lanczos3';

function getSvrSliceResampleKernel(debug?: boolean): SvrSliceResampleKernel {
  if (!debug) return 'area';

  try {
    const v = localStorage.getItem('miraviewer:svr-resample-kernel');
    return v === 'lanczos3' ? 'lanczos3' : 'area';
  } catch {
    return 'area';
  }
}

function boundsFromRoi(roi: SvrRoi): BoundsMm {
  return {
    min: v3(roi.boundsMm.min[0], roi.boundsMm.min[1], roi.boundsMm.min[2]),
    max: v3(roi.boundsMm.max[0], roi.boundsMm.max[1], roi.boundsMm.max[2]),
  };
}

function intersectBoundsMm(a: BoundsMm, b: BoundsMm): BoundsMm {
  return {
    min: v3(Math.max(a.min.x, b.min.x), Math.max(a.min.y, b.min.y), Math.max(a.min.z, b.min.z)),
    max: v3(Math.min(a.max.x, b.max.x), Math.min(a.max.y, b.max.y), Math.min(a.max.z, b.max.z)),
  };
}

function assertNonEmptyBounds(bounds: BoundsMm, label: string): void {
  if (!(bounds.min.x < bounds.max.x && bounds.min.y < bounds.max.y && bounds.min.z < bounds.max.z)) {
    throw new Error(`SVR ROI does not overlap reconstruction bounds (${label})`);
  }
}

async function rigidAlignSeriesInRoi(params: {
  allSlices: LoadedSlice[];
  selectedSeries: SvrSelectedSeries[];
  roiBounds: BoundsMm;
  dims: VolumeDims;
  originMm: Vec3;
  voxelSizeMm: number;
  roi: SvrRoi;
  signal?: AbortSignal;
  onProgress?: (p: SvrProgress) => void;
  debug: boolean;
}): Promise<void> {
  const { allSlices, selectedSeries, roiBounds, dims, voxelSizeMm, roi, signal, onProgress, debug } = params;

  // This stage exists because multi-plane fusion is extremely sensitive to even small spatial-tag mismatches.
  // If series are misregistered, SVR will smear details rather than sharpen them.

  const bySeries = new Map<string, LoadedSlice[]>();
  for (const s of allSlices) {
    const arr = bySeries.get(s.seriesUid);
    if (arr) arr.push(s);
    else bySeries.set(s.seriesUid, [s]);
  }

  const labelByUid = new Map<string, string>();
  for (const s of selectedSeries) labelByUid.set(s.seriesUid, s.label);

  const roiReferenceUid = roi.sourceSeriesUid ?? null;
  let referenceUid: string | null = null;

  if (roiReferenceUid && bySeries.has(roiReferenceUid)) {
    referenceUid = roiReferenceUid;
  } else {
    let bestCount = -1;
    for (const [uid, arr] of bySeries) {
      if (arr.length > bestCount) {
        referenceUid = uid;
        bestCount = arr.length;
      }
    }
  }

  const centerMm = boundsCenterMm(roiBounds);

  // Power-user memory optimization:
  // ROI-rigid alignment builds "leave-one-out" reference volumes that are only used for scoring.
  // Using the full reconstruction grid here can be unnecessarily expensive for large volumes.
  let scoreMaxDim = 160;
  try {
    const raw = localStorage.getItem('miraviewer:svr-roi-rigid-score-max-dim');
    if (raw) {
      scoreMaxDim = Math.max(64, Math.min(256, Math.round(Number(raw))));
    }
  } catch {
    // Ignore.
  }

  const scoreGridSelected = chooseOutputGrid({ bounds: roiBounds, voxelSizeMm, maxDim: scoreMaxDim });
  const scoreGrid: SvrReconstructionGrid = {
    dims: scoreGridSelected.dims,
    originMm: scoreGridSelected.originMm,
    voxelSizeMm: scoreGridSelected.voxelSizeMm,
  };

  debugSvrLog(
    'registration.roi-rigid.plan',
    {
      referenceUid,
      centerMm: {
        x: Number(centerMm.x.toFixed(3)),
        y: Number(centerMm.y.toFixed(3)),
        z: Number(centerMm.z.toFixed(3)),
      },
      fineGrid: { dims, voxelSizeMm: Number(voxelSizeMm.toFixed(4)) },
      scoreGrid: { dims: scoreGrid.dims, voxelSizeMm: Number(scoreGrid.voxelSizeMm.toFixed(4)), maxDim: scoreMaxDim },
    },
    debug,
  );

  // Align each non-reference series to the reconstruction of the other series.
  const seriesUids = Array.from(bySeries.keys());
  for (let idx = 0; idx < seriesUids.length; idx++) {
    assertNotAborted(signal);

    const uid = seriesUids[idx];
    if (!uid) continue;
    if (referenceUid && uid === referenceUid) continue;

    const movingSlices = bySeries.get(uid);
    if (!movingSlices || movingSlices.length === 0) continue;

    onProgress?.({
      phase: 'initializing',
      current: 57,
      total: 100,
      message: `ROI rigid align… (${labelByUid.get(uid) ?? uid})`,
    });

    // Build a reference volume from all other series (used only for scoring).
    const otherSlices: LoadedSlice[] = [];
    for (const [otherUid, slices] of bySeries) {
      if (otherUid === uid) continue;
      otherSlices.push(...slices);
    }

    if (otherSlices.length === 0) continue;

    const refGrid: SvrReconstructionGrid = scoreGrid;
    const refOptions: SvrReconstructionOptions = {
      iterations: 0,
      stepSize: 0,
      clampOutput: true,
      psfMode: 'none',
      robustLoss: 'none',
      robustDelta: 0.1,
      laplacianWeight: 0,
    };

    const refVol = await reconstructVolumeFromSlices({
      slices: otherSlices,
      grid: refGrid,
      options: refOptions,
      hooks: {
        signal,
        yieldToMain,
      },
    });

    // Extract samples from the moving series within the ROI bounds.
    const samples = buildSeriesSamples({ slices: movingSlices, roiBounds: roiBounds, maxSamples: 40_000, signal });

    if (samples.count < 1024) {
      console.warn('[svr] ROI rigid alignment: too few samples inside ROI; skipping series', {
        seriesUid: uid,
        label: labelByUid.get(uid) ?? uid,
        samples: samples.count,
      });
      continue;
    }

    const before = scoreNcc({
      samples,
      refVolume: refVol,
      dims: scoreGrid.dims,
      originMm: scoreGrid.originMm,
      voxelSizeMm: scoreGrid.voxelSizeMm,
      centerMm,
      rigid: { tx: 0, ty: 0, tz: 0, rx: 0, ry: 0, rz: 0 },
    });

    const opt = await optimizeRigidNcc({
      samples,
      refVolume: refVol,
      dims: scoreGrid.dims,
      originMm: scoreGrid.originMm,
      voxelSizeMm: scoreGrid.voxelSizeMm,
      centerMm,
      signal,
    });

    const after = scoreNcc({
      samples,
      refVolume: refVol,
      dims: scoreGrid.dims,
      originMm: scoreGrid.originMm,
      voxelSizeMm: scoreGrid.voxelSizeMm,
      centerMm,
      rigid: opt.best,
    });

    // Only apply if the score actually improved.
    if (!(after.ncc > before.ncc + 1e-3)) {
      debugSvrLog(
        'registration.roi-rigid.skip',
        {
          seriesUid: uid,
          label: labelByUid.get(uid) ?? uid,
          nccBefore: before.ncc,
          nccAfter: after.ncc,
          used: after.used,
        },
        debug,
      );
      continue;
    }

    const rot = mat3FromEulerXYZ(opt.best.rx, opt.best.ry, opt.best.rz);
    const tMm = v3(opt.best.tx, opt.best.ty, opt.best.tz);

    applyRigidToSeriesSlices({ slices: movingSlices, centerMm, rot, tMm });

    console.info('[svr] ROI rigid series alignment applied', {
      seriesUid: uid,
      label: labelByUid.get(uid) ?? uid,
      nccBefore: Number(before.ncc.toFixed(4)),
      nccAfter: Number(after.ncc.toFixed(4)),
      usedSamples: after.used,
      evals: opt.evals,
      translateMm: {
        x: Number(opt.best.tx.toFixed(3)),
        y: Number(opt.best.ty.toFixed(3)),
        z: Number(opt.best.tz.toFixed(3)),
      },
      rotateDeg: {
        x: Number((opt.best.rx * (180 / Math.PI)).toFixed(3)),
        y: Number((opt.best.ry * (180 / Math.PI)).toFixed(3)),
        z: Number((opt.best.rz * (180 / Math.PI)).toFixed(3)),
      },
    });

    debugSvrLog(
      'registration.roi-rigid',
      {
        seriesUid: uid,
        label: labelByUid.get(uid) ?? uid,
        samples: samples.count,
        usedSamples: after.used,
        nccBefore: before.ncc,
        nccAfter: after.ncc,
        evals: opt.evals,
        translateMm: { x: opt.best.tx, y: opt.best.ty, z: opt.best.tz },
        rotateRad: { x: opt.best.rx, y: opt.best.ry, z: opt.best.rz },
      },
      debug,
    );

    await yieldToMain();
  }
}

async function loadSeriesSlices(params: {
  series: SvrSelectedSeries;
  sliceDownsampleMode: SvrParams['sliceDownsampleMode'];
  sliceDownsampleMaxSize: number;
  targetVoxelSizeMm: number;
  maxIntensitySamples: number;
  signal?: AbortSignal;
  onProgress?: (p: SvrProgress) => void;
  progressBase: { current: number; total: number };
  debug?: boolean;
}): Promise<{ slices: LoadedSlice[]; intensitySamples: number[] }> {
  const {
    series,
    sliceDownsampleMode,
    sliceDownsampleMaxSize,
    targetVoxelSizeMm,
    maxIntensitySamples,
    signal,
    onProgress,
    progressBase,
    debug,
  } = params;

  const db = await getDB();
  const uids = await getSortedSopInstanceUidsForSeries(series.seriesUid);

  const slices: LoadedSlice[] = [];

  // Deterministic sampling for robust global normalization.
  const intensitySamples: number[] = [];
  let intensityApproxMin = Number.POSITIVE_INFINITY;
  let intensityApproxMax = Number.NEGATIVE_INFINITY;

  const perSliceTarget = Math.max(64, Math.ceil(maxIntensitySamples / Math.max(1, uids.length)));

  const resampleKernel = getSvrSliceResampleKernel(debug);
  debugSvrLog(
    'slice.downsample',
    {
      seriesUid: series.seriesUid,
      label: series.label,
      kernel: resampleKernel,
    },
    !!debug,
  );

  for (let i = 0; i < uids.length; i++) {
    assertNotAborted(signal);

    const sopInstanceUid = uids[i];
    if (!sopInstanceUid) continue;

    const inst = (await db.get('instances', sopInstanceUid)) as DicomInstance | undefined;
    if (!inst) continue;

    const sliceThicknessMm =
      typeof inst.sliceThickness === 'number' && inst.sliceThickness > 0 ? inst.sliceThickness : null;
    const spacingBetweenSlicesMm =
      typeof inst.spacingBetweenSlices === 'number' && inst.spacingBetweenSlices > 0 ? inst.spacingBetweenSlices : null;

    const geom: SliceGeometry = getSliceGeometryFromInstance(inst);

    const { dsRows, dsCols } = computeSvrDownsampleSize({
      rows: geom.rows,
      cols: geom.cols,
      maxSize: sliceDownsampleMaxSize,
      mode: sliceDownsampleMode,
      rowSpacingMm: geom.rowSpacingMm,
      colSpacingMm: geom.colSpacingMm,
      targetVoxelSizeMm,
    });

    // Adjust spacings for the downsampled grid (physical FOV preserved).
    const rowSpacingDsMm = geom.rowSpacingMm * (geom.rows / dsRows);
    const colSpacingDsMm = geom.colSpacingMm * (geom.cols / dsCols);

    // Decode pixels via Cornerstone (uses our miradb: loader + codecs).
    const imageId = `miradb:${sopInstanceUid}`;
    const image = await cornerstone.loadImage(imageId);

    const getPixelData = (image as unknown as { getPixelData?: () => ArrayLike<number> }).getPixelData;
    if (typeof getPixelData !== 'function') {
      throw new Error('Cornerstone image did not expose getPixelData()');
    }

    const pixelData = getPixelData.call(image);

    // Higher-fidelity downsampling (anti-aliasing) to reduce aliasing.
    // Default is box/area averaging; Lanczos is available behind a debug flag.
    const down =
      resampleKernel === 'lanczos3'
        ? resample2dLanczos3(pixelData, geom.rows, geom.cols, dsRows, dsCols)
        : resample2dAreaAverage(pixelData, geom.rows, geom.cols, dsRows, dsCols);

    // Apply modality scaling when available. (Linear, so applying post-downsample is equivalent.)
    const slope =
      typeof (image as unknown as { slope?: unknown }).slope === 'number'
        ? (image as unknown as { slope: number }).slope
        : 1;
    const intercept =
      typeof (image as unknown as { intercept?: unknown }).intercept === 'number'
        ? (image as unknown as { intercept: number }).intercept
        : 0;

    if (slope !== 1 || intercept !== 0) {
      for (let p = 0; p < down.length; p++) {
        down[p] = down[p] * slope + intercept;
      }
    }

    // Best-effort: drop the decoded DICOM image from Cornerstone's global image cache.
    // SVR decoding loads many slices; letting them accumulate in the cache can cause large
    // memory spikes and crashes, especially in power-user runs.
    try {
      cornerstone.imageCache?.removeImageLoadObject?.(imageId);
    } catch {
      // Ignore.
    }

    // Sample intensities deterministically for robust global normalization.
    if (intensitySamples.length < maxIntensitySamples) {
      const stride = Math.max(1, Math.floor(down.length / perSliceTarget));
      for (let p = 0; p < down.length && intensitySamples.length < maxIntensitySamples; p += stride) {
        const v = down[p] ?? 0;
        if (!Number.isFinite(v)) continue;
        intensitySamples.push(v);
        if (v < intensityApproxMin) intensityApproxMin = v;
        if (v > intensityApproxMax) intensityApproxMax = v;
      }
    }

    slices.push({
      seriesUid: series.seriesUid,
      sopInstanceUid,
      pixels: down,
      dsRows,
      dsCols,
      srcRows: geom.rows,
      srcCols: geom.cols,
      rowSpacingMm: geom.rowSpacingMm,
      colSpacingMm: geom.colSpacingMm,
      sliceThicknessMm,
      spacingBetweenSlicesMm,
      ippMm: geom.ippMm,
      rowDir: geom.rowDir,
      colDir: geom.colDir,
      normalDir: geom.normalDir,
      rowSpacingDsMm,
      colSpacingDsMm,
    });

    if (i % 8 === 0) {
      onProgress?.({
        phase: 'loading',
        current: progressBase.current + i,
        total: progressBase.total,
        message: `Decoding slices (${series.label}) ${i + 1}/${uids.length}`,
      });
      await yieldToMain();
    }
  }

  if (debug && slices.length > 0) {
    const s0 = slices[0];
    const n0 = s0.normalDir;

    let minAbsNDot = 1;
    const along: number[] = [];

    for (const s of slices) {
      const n = s.normalDir;
      const absDot = Math.abs(dot(n, n0));
      if (absDot < minAbsNDot) minAbsNDot = absDot;

      // Use the normal from the first slice to compute approximate slice-to-slice spacing.
      along.push(dot(s.ippMm, n0));
    }

    along.sort((a, b) => a - b);
    const deltas: number[] = [];
    for (let i = 0; i < along.length - 1; i++) {
      const d = Math.abs((along[i + 1] ?? 0) - (along[i] ?? 0));
      if (Number.isFinite(d) && d > 0) deltas.push(d);
    }
    deltas.sort((a, b) => a - b);
    const sliceSpacingMm = deltas.length
      ? deltas.length % 2 === 1
        ? deltas[Math.floor(deltas.length / 2)]
        : ((deltas[deltas.length / 2 - 1] ?? 0) + (deltas[deltas.length / 2] ?? 0)) / 2
      : null;

    const median = (values: Array<number | null>): number | null => {
      const v = values
        .filter((x) => typeof x === 'number' && Number.isFinite(x))
        .sort((a, b) => (a as number) - (b as number));
      if (v.length === 0) return null;
      const mid = Math.floor(v.length / 2);
      return v.length % 2 === 1 ? (v[mid] as number) : ((v[mid - 1] as number) + (v[mid] as number)) / 2;
    };

    const sliceThicknessMedianMm = median(slices.map((s) => s.sliceThicknessMm));
    const spacingBetweenSlicesMedianMm = median(slices.map((s) => s.spacingBetweenSlicesMm));

    debugSvrLog(
      'series.loaded',
      {
        label: series.label,
        seriesUid: series.seriesUid,
        loadedSlices: slices.length,
        srcRows: s0.srcRows,
        srcCols: s0.srcCols,
        dsRows: s0.dsRows,
        dsCols: s0.dsCols,
        rowSpacingMm: s0.rowSpacingMm,
        colSpacingMm: s0.colSpacingMm,
        rowSpacingDsMm: s0.rowSpacingDsMm,
        colSpacingDsMm: s0.colSpacingDsMm,
        approxSliceSpacingMm: sliceSpacingMm,
        sliceThicknessMedianMm,
        spacingBetweenSlicesMedianMm,
        normalConsistencyMinAbsDot: Number(minAbsNDot.toFixed(6)),
        intensityApprox: {
          min: Number.isFinite(intensityApproxMin) ? Number(intensityApproxMin.toFixed(4)) : null,
          max: Number.isFinite(intensityApproxMax) ? Number(intensityApproxMax.toFixed(4)) : null,
          samples: intensitySamples.length,
        },
      },
      true,
    );

    if (minAbsNDot < 0.999) {
      console.warn('[svr] Inconsistent slice normals detected within a series (oblique drift?)', {
        seriesUid: series.seriesUid,
        label: series.label,
        minAbsDot: minAbsNDot,
      });
    }
  }

  return { slices, intensitySamples };
}

function computeBoundsMm(slices: LoadedSlice[]): { min: Vec3; max: Vec3 } {
  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let minZ = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  let maxZ = Number.NEGATIVE_INFINITY;

  for (const s of slices) {
    const corners = sliceCornersMm({
      ippMm: s.ippMm,
      rowDir: s.rowDir,
      colDir: s.colDir,
      rowSpacingMm: s.rowSpacingDsMm,
      colSpacingMm: s.colSpacingDsMm,
      rows: s.dsRows,
      cols: s.dsCols,
    });

    for (const p of corners) {
      if (p.x < minX) minX = p.x;
      if (p.y < minY) minY = p.y;
      if (p.z < minZ) minZ = p.z;
      if (p.x > maxX) maxX = p.x;
      if (p.y > maxY) maxY = p.y;
      if (p.z > maxZ) maxZ = p.z;
    }
  }

  if (!Number.isFinite(minX) || !Number.isFinite(maxX)) {
    throw new Error('Failed to compute bounds for SVR');
  }

  // Small padding to avoid clipping due to rounding.
  const pad = 1;
  return {
    min: v3(minX - pad, minY - pad, minZ - pad),
    max: v3(maxX + pad, maxY + pad, maxZ + pad),
  };
}

function chooseOutputGrid(params: { bounds: { min: Vec3; max: Vec3 }; voxelSizeMm: number; maxDim: number }): {
  originMm: Vec3;
  voxelSizeMm: number;
  dims: VolumeDims;
} {
  const { bounds, maxDim } = params;

  let voxelSizeMm = params.voxelSizeMm;
  if (!Number.isFinite(voxelSizeMm) || voxelSizeMm <= 0) voxelSizeMm = 1;

  const extentX = bounds.max.x - bounds.min.x;
  const extentY = bounds.max.y - bounds.min.y;
  const extentZ = bounds.max.z - bounds.min.z;

  const dimFor = (extent: number, vox: number) => Math.max(2, Math.ceil(extent / vox) + 1);

  // Increase voxel size if any dimension is above maxDim.
  for (let attempt = 0; attempt < 10; attempt++) {
    const nx = dimFor(extentX, voxelSizeMm);
    const ny = dimFor(extentY, voxelSizeMm);
    const nz = dimFor(extentZ, voxelSizeMm);

    const maxD = Math.max(nx, ny, nz);
    if (maxD <= maxDim) {
      return {
        originMm: bounds.min,
        voxelSizeMm,
        dims: { nx, ny, nz },
      };
    }

    voxelSizeMm *= maxD / maxDim;
  }

  const nx = dimFor(extentX, voxelSizeMm);
  const ny = dimFor(extentY, voxelSizeMm);
  const nz = dimFor(extentZ, voxelSizeMm);

  return {
    originMm: bounds.min,
    voxelSizeMm,
    dims: { nx, ny, nz },
  };
}

export async function reconstructVolumeMultiPlane(params: {
  selectedSeries: SvrSelectedSeries[];
  svrParams: SvrParams;
  signal?: AbortSignal;
  onProgress?: (p: SvrProgress) => void;
}): Promise<SvrResult> {
  const { selectedSeries, svrParams, signal, onProgress } = params;
  if (selectedSeries.length < 2) {
    throw new Error('Select at least 2 series (multi-plane) for SVR');
  }

  const t0 = performance.now();

  // 1) Decode + downsample slices.
  onProgress?.({ phase: 'loading', current: 0, total: 100, message: 'Loading slices…' });

  const allSlices: LoadedSlice[] = [];

  // Intensity normalization samples (global across all selected series).
  const intensitySamples: number[] = [];
  const intensitySamplesBySeries = new Map<string, number[]>();

  // Allocate progress budget: 0..50 for decoding.
  const decodeTotal = selectedSeries.reduce((acc, s) => acc + Math.max(1, s.instanceCount), 0);
  let decodeBase = 0;

  const debug = isDebugSvrEnabled();

  if (!debug) {
    console.info("[svr] Tip: enable verbose SVR logs with localStorage.setItem('miraviewer:debug-svr', '1')");
  }

  console.info('[svr] Reconstruction started', {
    seriesCount: selectedSeries.length,
    roi: svrParams.roi ? { mode: svrParams.roi.mode, sourcePlane: svrParams.roi.sourcePlane } : null,
    seriesRegistrationMode: svrParams.seriesRegistrationMode,
    voxelSizeMm: svrParams.targetVoxelSizeMm,
    maxVolumeDim: svrParams.maxVolumeDim,
    sliceDownsampleMode: svrParams.sliceDownsampleMode,
    sliceDownsampleMaxSize: svrParams.sliceDownsampleMaxSize,
    iterations: svrParams.iterations,
    stepSize: svrParams.stepSize,
  });

  if (debug) {
    try {
      const cacheInfo = cornerstone.imageCache?.getCacheInfo?.();
      debugSvrLog('cornerstone.imageCache', { when: 'svr-start', cacheInfo }, debug);
    } catch {
      // Ignore.
    }
  }

  const MAX_INTENSITY_SAMPLES_TOTAL = 50_000;
  const maxIntensitySamplesPerSeries = Math.max(
    2048,
    Math.ceil(MAX_INTENSITY_SAMPLES_TOTAL / Math.max(1, selectedSeries.length)),
  );

  for (const series of selectedSeries) {
    assertNotAborted(signal);

    const loaded = await loadSeriesSlices({
      series,
      sliceDownsampleMode: svrParams.sliceDownsampleMode,
      sliceDownsampleMaxSize: svrParams.sliceDownsampleMaxSize,
      targetVoxelSizeMm: svrParams.targetVoxelSizeMm,
      maxIntensitySamples: maxIntensitySamplesPerSeries,
      signal,
      onProgress,
      progressBase: { current: decodeBase, total: decodeTotal },
      debug,
    });

    const slices = loaded.slices;
    const seriesSamples = loaded.intensitySamples;

    if (slices.length > 0) {
      const s0 = slices[0];
      console.info('[svr] Series decoded', {
        label: series.label,
        seriesUid: series.seriesUid,
        loadedSlices: slices.length,
        srcRows: s0.srcRows,
        srcCols: s0.srcCols,
        dsRows: s0.dsRows,
        dsCols: s0.dsCols,
        rowSpacingMm: Number(s0.rowSpacingMm.toFixed(4)),
        colSpacingMm: Number(s0.colSpacingMm.toFixed(4)),
        rowSpacingDsMm: Number(s0.rowSpacingDsMm.toFixed(4)),
        colSpacingDsMm: Number(s0.colSpacingDsMm.toFixed(4)),
      });
    }

    decodeBase += Math.max(1, series.instanceCount);
    allSlices.push(...slices);

    for (const v of seriesSamples) {
      intensitySamples.push(v);
    }

    if (seriesSamples.length > 0) {
      const prev = intensitySamplesBySeries.get(series.seriesUid);
      if (prev) {
        prev.push(...seriesSamples);
      } else {
        intensitySamplesBySeries.set(series.seriesUid, [...seriesSamples]);
      }
    }

    await yieldToMain();
  }

  if (allSlices.length === 0) {
    throw new Error('No slices loaded for SVR');
  }

  if (debug) {
    const sliceBytes = allSlices.reduce((acc, s) => acc + (s.pixels?.byteLength ?? 0), 0);
    debugSvrLog(
      'slices.bytes',
      {
        when: 'after-decode',
        slices: allSlices.length,
        pixelsMiB: Number((sliceBytes / (1024 * 1024)).toFixed(1)),
      },
      debug,
    );

    try {
      const cacheInfo = cornerstone.imageCache?.getCacheInfo?.();
      debugSvrLog('cornerstone.imageCache', { when: 'after-decode', cacheInfo }, debug);
    } catch {
      // Ignore.
    }
  }

  // Normalize all slices to [0,1] using a robust global percentile window.
  //
  // Why:
  // - per-series min/max is unstable (outliers/background dominate)
  // - cross-series fusion and ROI rigid alignment benefit from a shared intensity domain
  const finite = intensitySamples.filter((v) => Number.isFinite(v)).sort((a, b) => a - b);

  const quantileSorted = (sorted: number[], q: number): number => {
    const n = sorted.length;
    if (n === 0) return 0;
    const qq = q < 0 ? 0 : q > 1 ? 1 : q;
    const idx = qq * (n - 1);
    const i0 = Math.floor(idx);
    const i1 = Math.min(n - 1, i0 + 1);
    const t = idx - i0;
    const a = sorted[i0] ?? 0;
    const b = sorted[i1] ?? a;
    return a + (b - a) * t;
  };

  const getHistogramMatchingEnabled = (debug?: boolean): boolean => {
    if (!debug) return false;
    try {
      return localStorage.getItem('miraviewer:svr-histmatch') === '1';
    } catch {
      return false;
    }
  };

  const histMatchEnabled = getHistogramMatchingEnabled(debug);

  // If enabled, we do a simple piecewise-linear quantile mapping per series
  // (approximate histogram matching) before global percentile normalization.
  const HM_Q = [0.01, 0.05, 0.1, 0.25, 0.5, 0.75, 0.9, 0.95, 0.99] as const;

  const refQs = HM_Q.map((q) => quantileSorted(finite, q));

  if (histMatchEnabled && finite.length > 0) {
    const perSeriesMap = new Map<string, { srcQs: number[]; dstQs: number[] }>();

    for (const [uid, samples] of intensitySamplesBySeries) {
      const sSorted = samples.filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
      if (sSorted.length < 16) continue;

      const srcQs = HM_Q.map((q) => quantileSorted(sSorted, q));

      // Skip degenerate distributions.
      const lo = srcQs[0] ?? 0;
      const hi = srcQs[srcQs.length - 1] ?? lo;
      if (!(hi > lo + 1e-12)) continue;

      perSeriesMap.set(uid, { srcQs, dstQs: [...refQs] });
    }

    const mapValue = (v: number, m: { srcQs: number[]; dstQs: number[] }): number => {
      const src = m.srcQs;
      const dst = m.dstQs;
      const n = Math.min(src.length, dst.length);
      if (n < 2) return v;

      if (v <= (src[0] ?? v)) return dst[0] ?? v;
      if (v >= (src[n - 1] ?? v)) return dst[n - 1] ?? v;

      // Small n (9), so linear scan is fine.
      let i = 0;
      while (i < n - 1 && v > (src[i + 1] ?? Number.POSITIVE_INFINITY)) i++;

      const x0 = src[i] ?? v;
      const x1 = src[i + 1] ?? x0;
      const y0 = dst[i] ?? v;
      const y1 = dst[i + 1] ?? y0;

      const den = x1 - x0;
      if (!(den > 1e-12)) return y0;

      const t = (v - x0) / den;
      return y0 + (y1 - y0) * t;
    };

    let matchedSeries = 0;

    for (const s of allSlices) {
      const m = perSeriesMap.get(s.seriesUid);
      if (!m) continue;

      for (let i = 0; i < s.pixels.length; i++) {
        s.pixels[i] = mapValue(s.pixels[i] ?? 0, m);
      }
    }

    matchedSeries = perSeriesMap.size;

    console.info('[svr] Histogram matching', {
      enabled: true,
      seriesMatched: matchedSeries,
      quantiles: HM_Q,
    });
  }

  let winLo = 0;
  let winHi = 1;

  if (finite.length > 0) {
    winLo = refQs[0] ?? quantileSorted(finite, 0.01);
    winHi = refQs[refQs.length - 1] ?? quantileSorted(finite, 0.99);

    // Fallback if the distribution is degenerate.
    if (!(winHi > winLo + 1e-12)) {
      winLo = finite[0] ?? 0;
      winHi = finite[finite.length - 1] ?? winLo;
    }
  }

  const invWinRange = winHi > winLo + 1e-12 ? 1 / (winHi - winLo) : 0;

  console.info('[svr] Intensity normalization', {
    method: histMatchEnabled ? 'histmatch+global-percentile' : 'global-percentile',
    pLow: 1,
    pHigh: 99,
    window: { lo: Number(winLo.toFixed(4)), hi: Number(winHi.toFixed(4)) },
    samples: finite.length,
  });

  for (const s of allSlices) {
    for (let i = 0; i < s.pixels.length; i++) {
      const v = s.pixels[i] ?? 0;
      const n = invWinRange > 0 ? (v - winLo) * invWinRange : 0;
      s.pixels[i] = clamp01(n);
    }
  }

  // 2) Optional coarse inter-series alignment.
  //
  // Note: roi-rigid builds on top of bounds-center as a cheap initial guess.
  const wantsBoundsCenter =
    svrParams.seriesRegistrationMode === 'bounds-center' || svrParams.seriesRegistrationMode === 'roi-rigid';

  if (wantsBoundsCenter) {
    onProgress?.({ phase: 'initializing', current: 52, total: 100, message: 'Coarse series alignment…' });

    const bySeries = new Map<string, LoadedSlice[]>();
    for (const s of allSlices) {
      const arr = bySeries.get(s.seriesUid);
      if (arr) arr.push(s);
      else bySeries.set(s.seriesUid, [s]);
    }

    // Pick reference series:
    // - Prefer the ROI's source series (if provided), so the ROI stays in the same coordinate frame.
    // - Otherwise fallback to "most loaded slices" (stable, data-driven heuristic).
    const roiReferenceUid = svrParams.roi?.sourceSeriesUid ?? null;

    let referenceUid: string | null = null;

    if (roiReferenceUid && bySeries.has(roiReferenceUid)) {
      referenceUid = roiReferenceUid;
    } else {
      let bestCount = -1;
      for (const [uid, arr] of bySeries) {
        if (arr.length > bestCount) {
          referenceUid = uid;
          bestCount = arr.length;
        }
      }
    }

    const refSlices = referenceUid ? bySeries.get(referenceUid) : null;
    if (referenceUid && refSlices && refSlices.length > 0) {
      const refBounds = computeBoundsMm(refSlices);
      const refCenter = v3(
        (refBounds.min.x + refBounds.max.x) * 0.5,
        (refBounds.min.y + refBounds.max.y) * 0.5,
        (refBounds.min.z + refBounds.max.z) * 0.5,
      );

      debugSvrLog(
        'registration.reference',
        {
          referenceUid,
          loadedSlices: refSlices.length,
          centerMm: { x: refCenter.x, y: refCenter.y, z: refCenter.z },
        },
        debug,
      );

      for (const [uid, slices] of bySeries) {
        if (uid === referenceUid) continue;
        if (slices.length === 0) continue;

        const b = computeBoundsMm(slices);
        const center = v3((b.min.x + b.max.x) * 0.5, (b.min.y + b.max.y) * 0.5, (b.min.z + b.max.z) * 0.5);
        const t = v3(refCenter.x - center.x, refCenter.y - center.y, refCenter.z - center.z);
        const tMag = Math.sqrt(dot(t, t));

        // Apply translation by shifting IPP for each slice.
        for (const s of slices) {
          s.ippMm = v3(s.ippMm.x + t.x, s.ippMm.y + t.y, s.ippMm.z + t.z);
        }

        debugSvrLog(
          'registration.bounds-center',
          {
            seriesUid: uid,
            translateMm: { x: Number(t.x.toFixed(3)), y: Number(t.y.toFixed(3)), z: Number(t.z.toFixed(3)) },
            magnitudeMm: Number(tMag.toFixed(3)),
          },
          debug,
        );

        // Warn if we're doing something large; this is often a sign of inconsistent DICOM spatial tags.
        if (tMag > 20) {
          console.warn('[svr] Large coarse alignment translation applied', {
            seriesUid: uid,
            magnitudeMm: tMag,
            translateMm: t,
          });
        }
      }
    }
  }

  // 3) Choose output grid (axis-aligned in patient/world coordinates).
  const allBounds = computeBoundsMm(allSlices);

  const roi = svrParams.roi ?? null;
  const bounds = roi ? intersectBoundsMm(allBounds, boundsFromRoi(roi)) : allBounds;
  if (roi) {
    assertNonEmptyBounds(bounds, `roi=${roi.mode}/${roi.sourcePlane}`);
  }

  onProgress?.({
    phase: 'initializing',
    current: 55,
    total: 100,
    message: roi ? 'Computing output grid (ROI)…' : 'Computing output grid…',
  });

  const iterations = Math.max(0, Math.round(svrParams.iterations));

  const estimatePeakBytes = (nvox: number, iters: number): number => {
    // Persistent arrays:
    // - volume
    // - weight (reused as updateW during refinement)
    // Per-iteration arrays:
    // - update
    const floatBytes = 4;
    const arrays = iters > 0 ? 3 : 2;
    return arrays * nvox * floatBytes;
  };

  const formatMiB = (bytes: number): string => `${Math.round(bytes / (1024 * 1024))}MiB`;

  // Rough safety budget to avoid browser OOM / tab crashes.
  // Note: this is only for the core volume arrays; it does not include slice buffers, JS overhead, or GPU textures.
  const MAX_PEAK_BYTES = 512 * 1024 * 1024;

  let grid = chooseOutputGrid({
    bounds,
    voxelSizeMm: svrParams.targetVoxelSizeMm,
    maxDim: svrParams.maxVolumeDim,
  });

  // Preflight: if the volume would be huge, auto-increase voxel size until it fits a memory budget.
  // This prevents hard crashes/hangs from attempting multi-hundred-MiB allocations.
  for (let attempt = 0; attempt < 6; attempt++) {
    const nvox = grid.dims.nx * grid.dims.ny * grid.dims.nz;
    const peakBytes = estimatePeakBytes(nvox, iterations);

    if (peakBytes <= MAX_PEAK_BYTES) break;

    const factor = Math.cbrt(peakBytes / MAX_PEAK_BYTES) * 1.05;
    const nextVoxelSizeMm = grid.voxelSizeMm * factor;

    console.warn('[svr] Volume would be too large; increasing voxel size to fit memory budget', {
      attempt: attempt + 1,
      dims: grid.dims,
      voxelSizeMm: Number(grid.voxelSizeMm.toFixed(4)),
      nextVoxelSizeMm: Number(nextVoxelSizeMm.toFixed(4)),
      peak: formatMiB(peakBytes),
      budget: formatMiB(MAX_PEAK_BYTES),
      iterations,
      maxVolumeDim: svrParams.maxVolumeDim,
      roi: roi ? { mode: roi.mode, sourcePlane: roi.sourcePlane } : null,
    });

    grid = chooseOutputGrid({
      bounds,
      voxelSizeMm: nextVoxelSizeMm,
      maxDim: svrParams.maxVolumeDim,
    });
  }

  const { dims, originMm, voxelSizeMm } = grid;
  const nvox = dims.nx * dims.ny * dims.nz;
  const peakBytes = estimatePeakBytes(nvox, iterations);

  if (peakBytes > MAX_PEAK_BYTES) {
    throw new Error(
      `SVR volume too large (${dims.nx}×${dims.ny}×${dims.nz}); estimated peak ${formatMiB(peakBytes)} exceeds budget ${formatMiB(
        MAX_PEAK_BYTES,
      )}. Try enabling ROI, increasing voxel size, lowering maxVolumeDim, or reducing iterations.`,
    );
  }

  const voxelSizeIncreased = voxelSizeMm > svrParams.targetVoxelSizeMm + 1e-6;
  console.info('[svr] Output grid chosen', {
    roi: roi ? { mode: roi.mode, sourcePlane: roi.sourcePlane } : null,
    voxelSizeMm: Number(voxelSizeMm.toFixed(4)),
    targetVoxelSizeMm: Number(svrParams.targetVoxelSizeMm.toFixed(4)),
    voxelSizeIncreased,
    maxVolumeDim: svrParams.maxVolumeDim,
    dims,
    estimatedPeak: formatMiB(peakBytes),
    iterations,
    boundsMm: {
      min: {
        x: Number(bounds.min.x.toFixed(3)),
        y: Number(bounds.min.y.toFixed(3)),
        z: Number(bounds.min.z.toFixed(3)),
      },
      max: {
        x: Number(bounds.max.x.toFixed(3)),
        y: Number(bounds.max.y.toFixed(3)),
        z: Number(bounds.max.z.toFixed(3)),
      },
    },
  });

  // 3) Optional ROI-local rigid alignment (translation + small rotation).
  //
  // This is intentionally done *after* selecting the output grid so the similarity metric is
  // computed in the same coordinate frame we will use for the final reconstruction.
  if (svrParams.seriesRegistrationMode === 'roi-rigid') {
    if (!roi) {
      console.info('[svr] roi-rigid requested but no ROI provided; falling back to bounds-center only');
    } else {
      onProgress?.({ phase: 'initializing', current: 56, total: 100, message: 'ROI rigid alignment…' });
      await rigidAlignSeriesInRoi({
        allSlices,
        selectedSeries,
        roiBounds: bounds,
        dims,
        originMm,
        voxelSizeMm,
        roi,
        signal,
        onProgress,
        debug,
      });
    }
  }

  // 4) Crop slices to ROI bounds to speed up high-detail reconstructions.
  if (roi) {
    onProgress?.({ phase: 'initializing', current: 58, total: 100, message: 'Cropping slices to ROI…' });

    const roiCorners = boundsCornersMm(bounds);

    const beforeCount = allSlices.length;
    const cropped: LoadedSlice[] = [];

    for (let i = 0; i < allSlices.length; i++) {
      assertNotAborted(signal);
      const s = allSlices[i];
      if (!s) continue;

      if (cropSliceToRoiInPlace(s, roiCorners)) {
        cropped.push(s);
      }

      if (i % 8 === 0) {
        await yieldToMain();
      }
    }

    // Replace in-place so existing references remain valid.
    allSlices.length = 0;
    allSlices.push(...cropped);

    console.info('[svr] Cropped slices to ROI', {
      beforeCount,
      afterCount: allSlices.length,
    });

    if (debug) {
      const sliceBytes = allSlices.reduce((acc, s) => acc + (s.pixels?.byteLength ?? 0), 0);
      debugSvrLog(
        'slices.bytes',
        {
          when: 'after-roi-crop',
          slices: allSlices.length,
          pixelsMiB: Number((sliceBytes / (1024 * 1024)).toFixed(1)),
        },
        debug,
      );
    }
  }

  // 5) Reconstruction (higher-fidelity forward model + solver).
  onProgress?.({ phase: 'reconstructing', current: 60, total: 100, message: 'Reconstructing volume…' });

  const solverOptions: SvrReconstructionOptions = {
    iterations,
    stepSize: svrParams.stepSize,
    clampOutput: svrParams.clampOutput,
    psfMode: svrParams.psfMode ?? 'gaussian',
    robustLoss: svrParams.robustLoss ?? 'huber',
    robustDelta: typeof svrParams.robustDelta === 'number' ? svrParams.robustDelta : 0.1,
    laplacianWeight: typeof svrParams.laplacianWeight === 'number' ? svrParams.laplacianWeight : 0,
  };

  debugSvrLog(
    'solver.options',
    {
      psfMode: solverOptions.psfMode,
      robustLoss: solverOptions.robustLoss,
      robustDelta: solverOptions.robustDelta,
      laplacianWeight: solverOptions.laplacianWeight,
      multiResolution: svrParams.multiResolution,
      multiResolutionFactor: svrParams.multiResolutionFactor,
      multiResolutionCoarseIterations: svrParams.multiResolutionCoarseIterations,
    },
    debug,
  );

  const fineGrid: SvrReconstructionGrid = { dims, originMm, voxelSizeMm };

  const multiresEnabled =
    !!svrParams.multiResolution &&
    typeof svrParams.multiResolutionFactor === 'number' &&
    svrParams.multiResolutionFactor > 1.01 &&
    typeof svrParams.multiResolutionCoarseIterations === 'number' &&
    svrParams.multiResolutionCoarseIterations > 0 &&
    iterations > 0;

  let volume: Float32Array;

  if (multiresEnabled) {
    const factor = Math.max(1.01, svrParams.multiResolutionFactor ?? 2);
    const coarseVoxelSizeMm = voxelSizeMm * factor;

    const coarseGridSelected = chooseOutputGrid({
      bounds,
      voxelSizeMm: coarseVoxelSizeMm,
      maxDim: svrParams.maxVolumeDim,
    });

    const coarseGrid: SvrReconstructionGrid = {
      dims: coarseGridSelected.dims,
      originMm: coarseGridSelected.originMm,
      voxelSizeMm: coarseGridSelected.voxelSizeMm,
    };

    const coarseIters = Math.max(0, Math.round(svrParams.multiResolutionCoarseIterations ?? 0));

    onProgress?.({ phase: 'reconstructing', current: 62, total: 100, message: 'Coarse reconstruction…' });

    let coarse: Float32Array | null = await reconstructVolumeFromSlices({
      slices: allSlices,
      grid: coarseGrid,
      options: {
        ...solverOptions,
        iterations: coarseIters,
      },
      hooks: {
        signal,
        yieldToMain,
      },
    });

    if (!coarse) {
      throw new Error('SVR coarse reconstruction failed');
    }

    onProgress?.({ phase: 'reconstructing', current: 66, total: 100, message: 'Upsampling coarse volume…' });

    volume = await resampleVolumeToGridTrilinear({
      src: coarse,
      srcGrid: coarseGrid,
      dstGrid: fineGrid,
      hooks: {
        signal,
        yieldToMain,
      },
    });

    // Best-effort: drop the coarse reference as early as possible to reduce peak memory.
    coarse = null;

    onProgress?.({ phase: 'reconstructing', current: 70, total: 100, message: 'Refining volume…' });

    await refineVolumeInPlace({
      volume,
      slices: allSlices,
      grid: fineGrid,
      options: solverOptions,
      hooks: {
        signal,
        yieldToMain,
      },
    });
  } else {
    volume = await reconstructVolumeFromSlices({
      slices: allSlices,
      grid: fineGrid,
      options: solverOptions,
      hooks: {
        signal,
        yieldToMain,
      },
    });
  }

  // 5) Previews.
  onProgress?.({ phase: 'finalizing', current: 95, total: 100, message: 'Generating previews…' });

  const previews = await generateVolumePreviews({
    volume,
    dims,
    maxSize: 256,
  });

  onProgress?.({
    phase: 'finalizing',
    current: 100,
    total: 100,
    message: `Done (${Math.round(performance.now() - t0)}ms)`,
  });

  return {
    volume: {
      data: volume,
      dims: [dims.nx, dims.ny, dims.nz],
      voxelSizeMm: [voxelSizeMm, voxelSizeMm, voxelSizeMm],
      originMm: [originMm.x, originMm.y, originMm.z],
      boundsMm: {
        min: [bounds.min.x, bounds.min.y, bounds.min.z],
        max: [bounds.max.x, bounds.max.y, bounds.max.z],
      },
    },
    previews,
  };
}
