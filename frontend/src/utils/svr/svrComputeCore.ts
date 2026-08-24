/**
 * SVR compute core — the pure compute phase of multi-plane reconstruction.
 *
 * This module contains everything that happens between "slices are decoded"
 * and "the fused volume exists": intensity normalization, optional debug
 * histogram matching, output-grid selection (+ memory preflight), coarse and
 * ROI-rigid inter-series alignment, ROI slice cropping, and the actual
 * reconstruction solve.
 *
 * Worker-safety contract: this file (and everything it imports, transitively)
 * must be loadable inside a dedicated Web Worker. That means:
 * - no cornerstone / IndexedDB / canvas / DOM imports (those stay in
 *   reconstructVolume.ts, which owns the load phase and preview generation);
 * - every `localStorage` access is wrapped in try/catch — in a worker the
 *   identifier doesn't exist at all, so touching it throws a ReferenceError,
 *   which the catch turns into the documented default.
 *
 * The code here was moved verbatim from reconstructVolume.ts (T12); identical
 * numeric behavior is a hard invariant of that move.
 */

import type { SvrParams, SvrProgress, SvrRoi, SvrSelectedSeries } from '../../types/svr';
import { sliceCornersMm } from './dicomGeometry';
import type { VolumeDims } from './trilinear';
import type { SvrReconstructionGrid, SvrReconstructionOptions } from './reconstructionCore';
import { reconstructVolumeFromSlices, refineVolumeInPlace, resampleVolumeToGridTrilinear } from './reconstructionCore';
import type { Vec3 } from './vec3';
import { dot, v3 } from './vec3';
import { boundsCornersMm, cropSliceToRoiInPlace } from './sliceRoiCrop';
import { debugSvrLog } from '../debugSvr';
import { clamp01 } from '../math';
import {
  applyRigidToSeriesSlices,
  boundsCenterMm,
  buildSeriesSamples,
  mat3FromEulerXYZ,
  optimizeRigidNcc,
  scoreBidirectionalNcc,
  type BoundsMm,
  type LoadedSlice,
} from './rigidRegistration';
import { assertNotAborted, formatMiB, quantileSorted, yieldToMain } from './svrUtils';

/**
 * The slim, structured-cloneable subset of series metadata the compute phase
 * actually needs (labels for log/progress messages, instance counts for
 * sanity). We deliberately do not ship the whole SvrSelectedSeries across the
 * worker boundary so the payload stays minimal and clone-safe by construction.
 */
export type SvrSeriesMeta = Pick<SvrSelectedSeries, 'seriesUid' | 'label' | 'instanceCount'>;

/** Compute-phase output. The caller (main thread) turns this into an SvrResult. */
export type SvrComputeResult = {
  volume: Float32Array;
  dims: VolumeDims;
  originMm: Vec3;
  voxelSizeMm: number;
  bounds: BoundsMm;
};

/**
 * Worker protocol (defined here, next to the payload types, so both the
 * worker entry and the main-thread dispatcher type-check against the same
 * source of truth without the main bundle importing the worker module).
 */
export type SvrComputePayload = {
  allSlices: LoadedSlice[];
  intensitySamples: number[];
  intensitySamplesBySeries: Map<string, number[]>;
  seriesMeta: SvrSeriesMeta[];
  svrParams: SvrParams;
  debug: boolean;
};

export type SvrComputeWorkerRequest =
  | { type: 'run'; payload: SvrComputePayload }
  // Cooperative cancellation: flips the worker-local AbortController so the
  // compute loop's assertNotAborted checks throw at the next yield point.
  | { type: 'abort' };

export type SvrComputeWorkerResponse =
  | { type: 'progress'; progress: SvrProgress }
  | {
      type: 'done';
      volume: Float32Array;
      dims: VolumeDims;
      originMm: Vec3;
      voxelSizeMm: number;
      bounds: BoundsMm;
    }
  | { type: 'error'; message: string };

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
  selectedSeries: SvrSeriesMeta[];
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
    // In a worker `localStorage` does not exist (ReferenceError) — the catch keeps the default.
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

    const refOccupancy = new Uint8Array(scoreGrid.dims.nx * scoreGrid.dims.ny * scoreGrid.dims.nz);
    const refVol = await reconstructVolumeFromSlices({
      slices: otherSlices,
      grid: refGrid,
      options: refOptions,
      occupancy: refOccupancy,
      hooks: {
        signal,
        yieldToMain,
      },
    });

    // Extract samples from the moving series within the ROI bounds.
    const samples = buildSeriesSamples({ slices: movingSlices, roiBounds: roiBounds, maxSamples: 40_000, signal });

    const referenceSamples = buildSeriesSamples({ slices: otherSlices, roiBounds, maxSamples: 40_000, signal });

    if (samples.count < 1024 || referenceSamples.count < 1024) {
      console.warn('[svr] ROI rigid alignment: too few samples inside ROI; skipping series', {
        seriesUid: uid,
        label: labelByUid.get(uid) ?? uid,
        samples: samples.count,
        referenceSamples: referenceSamples.count,
      });
      continue;
    }

    const movingOccupancy = new Uint8Array(refOccupancy.length);
    const movingVolume = await reconstructVolumeFromSlices({
      slices: movingSlices,
      grid: refGrid,
      options: refOptions,
      occupancy: movingOccupancy,
      hooks: { signal, yieldToMain },
    });
    const reverse = {
      samples: referenceSamples,
      refVolume: movingVolume,
      dims: scoreGrid.dims,
      originMm: scoreGrid.originMm,
      voxelSizeMm: scoreGrid.voxelSizeMm,
      occupancy: movingOccupancy,
    };

    const registration = {
      samples,
      refVolume: refVol,
      dims: scoreGrid.dims,
      originMm: scoreGrid.originMm,
      voxelSizeMm: scoreGrid.voxelSizeMm,
      centerMm,
      occupancy: refOccupancy,
      reverse,
    };
    const before = scoreBidirectionalNcc({
      ...registration,
      rigid: { tx: 0, ty: 0, tz: 0, rx: 0, ry: 0, rz: 0 },
    });
    const opt = await optimizeRigidNcc({ ...registration, signal });
    const after = scoreBidirectionalNcc({ ...registration, rigid: opt.best });

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

/**
 * Runs the full SVR compute phase on already-decoded slices.
 *
 * Called either directly on the main thread (test / no-Worker fallback) or
 * inside svrCompute.worker.ts. Both paths run this exact function, so worker
 * and inline execution produce identical results by construction.
 *
 * Mutates `allSlices` (normalization, alignment, ROI crop) and empties the
 * array once the solver no longer needs it, releasing the decoded pixel
 * buffers for GC before the caller allocates previews/result structures.
 */
export async function computeSvrFromLoadedSlices(params: {
  allSlices: LoadedSlice[];
  intensitySamples: number[];
  intensitySamplesBySeries: Map<string, number[]>;
  seriesMeta: SvrSeriesMeta[];
  svrParams: SvrParams;
  signal?: AbortSignal;
  onProgress?: (p: SvrProgress) => void;
  debug: boolean;
}): Promise<SvrComputeResult> {
  const { allSlices, intensitySamples, intensitySamplesBySeries, seriesMeta, svrParams, signal, onProgress, debug } =
    params;

  // Normalize all slices to [0,1] using a robust global percentile window.
  //
  // Why:
  // - per-series min/max is unstable (outliers/background dominate)
  // - cross-series fusion and ROI rigid alignment benefit from a shared intensity domain
  const finite = intensitySamples.filter((v) => Number.isFinite(v)).sort((a, b) => a - b);

  const getHistogramMatchingEnabled = (debug?: boolean): boolean => {
    if (!debug) return false;
    try {
      // Worker contexts have no `localStorage` (ReferenceError) — catch keeps the default (off).
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
  // Bounding-box centers are not anatomical landmarks: a valid partial-FOV
  // acquisition must keep its DICOM position unless the user explicitly opts in.
  const wantsBoundsCenter = svrParams.seriesRegistrationMode === 'bounds-center';

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
      console.info('[svr] roi-rigid requested without an ROI; preserving source DICOM geometry');
    } else {
      onProgress?.({ phase: 'initializing', current: 56, total: 100, message: 'ROI rigid alignment…' });
      await rigidAlignSeriesInRoi({
        allSlices,
        selectedSeries: seriesMeta,
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

  // The solver is the last consumer of the slice stack. Its decoded/downsampled pixel
  // buffers (typically tens of MiB across all series) would otherwise stay reachable until
  // this function returns; dropping them here makes them GC-eligible before preview
  // generation and result assembly allocate. `allSlices` is the only long-lived holder of
  // the LoadedSlice objects at this point (the per-phase series maps are scope-local).
  allSlices.length = 0;

  return { volume, dims, originMm, voxelSizeMm, bounds };
}
