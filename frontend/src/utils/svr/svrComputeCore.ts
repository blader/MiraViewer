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

import type { SvrParams, SvrProgress, SvrRoi } from '../../types/svr';
import { INDEPENDENT_NORMAL_COSINE, sliceCornersMm } from './dicomGeometry';
import type { VolumeDims } from './trilinear';
import type { SvrReconstructionGrid, SvrReconstructionOptions } from './reconstructionCore';
import {
  buildObservedSupportFromSlices,
  reconstructVolumeFromSlices,
  refineVolumeInPlace,
  resampleVolumeToGridTrilinear,
} from './reconstructionCore';
import type { Vec3 } from './vec3';
import { dot, v3 } from './vec3';
import { boundsCornersMm, cropSliceToRoiInPlace } from './sliceRoiCrop';
import { debugSvrLog } from '../debugSvr';
import { clamp01 } from '../math';
import { estimateSvrPeakMemoryBytes, estimateSvrRegistrationBytes, SVR_MEMORY_BUDGET_BYTES } from './svrMemoryPlan';
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

/** Compute-phase output. The caller (main thread) turns this into an SvrResult. */
export type SvrComputeResult = {
  volume: Float32Array;
  /** Canonical acquired-observation domain, transferred alongside the intensity volume. */
  observedSupport: Uint8Array;
  supportedVoxelCount: number;
  acquiredOrientationCount: number;
  effectiveResolutionMm?: [number, number, number];
  sliceProfileSource: 'declared' | 'mixed' | 'unknown';
  reconstructionFingerprint: string;
  dims: VolumeDims;
  originMm: Vec3;
  voxelSizeMm: number;
  bounds: BoundsMm;
};

/**
 * Worker protocol (defined here, next to the payload types, so both the
 * worker entry and the main-thread dispatcher type-check against the same
 * source of truth without the main bundle importing the worker module).
 *
 * The slim, structured-cloneable source evidence the compute phase actually
 * needs already lives in its slice payload. We deliberately do not ship full
 * SvrSelectedSeries metadata or free-text display labels across the worker
 * boundary, so the payload stays minimal, private, and clone-safe.
 */
export type SvrComputePayload = {
  allSlices: LoadedSlice[];
  intensitySamples: number[];
  intensitySamplesBySeries: Map<string, number[]>;
  svrParams: SvrParams;
  debug: boolean;
  /** Decoded-frame cache retained on the main thread while this worker owns its source copies. */
  residentCacheBytes?: number;
};

export type SvrComputeWorkerRequest =
  | { type: 'run'; payload: SvrComputePayload }
  // Cooperative cancellation: flips the worker-local AbortController so the
  // compute loop's assertNotAborted checks throw at the next yield point.
  | { type: 'abort' };

export type SvrComputeWorkerResponse =
  | { type: 'progress'; progress: SvrProgress }
  | ({ type: 'done' } & SvrComputeResult)
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

function deriveAcquisitionEvidence(
  slices: readonly LoadedSlice[],
  outputVoxelSizeMm: number,
): Pick<SvrComputeResult, 'acquiredOrientationCount' | 'effectiveResolutionMm' | 'sliceProfileSource'> {
  const normals: Vec3[] = [];
  const positionsBySeries = new Map<string, number[]>();
  let declaredProfiles = 0;
  let unknownProfiles = 0;

  for (const slice of slices) {
    if (!normals.some((normal) => Math.abs(dot(normal, slice.normalDir)) >= INDEPENDENT_NORMAL_COSINE)) {
      normals.push(slice.normalDir);
    }

    const thickness = slice.sliceThicknessMm;
    if (typeof thickness === 'number' && Number.isFinite(thickness) && thickness > 0) declaredProfiles++;
    else unknownProfiles++;

    const positions = positionsBySeries.get(slice.seriesUid);
    const position = dot(slice.ippMm, slice.normalDir);
    if (positions) positions.push(position);
    else positionsBySeries.set(slice.seriesUid, [position]);
  }

  const geometricSpacingBySeries = new Map<string, number>();
  for (const [seriesUid, positions] of positionsBySeries) {
    if (positions.length < 2) continue;
    positions.sort((left, right) => left - right);
    const positiveDeltas: number[] = [];
    for (let index = 1; index < positions.length; index++) {
      const delta = positions[index]! - positions[index - 1]!;
      if (delta > 1e-6) positiveDeltas.push(delta);
    }
    if (positiveDeltas.length === 0) continue;
    positiveDeltas.sort((left, right) => left - right);
    geometricSpacingBySeries.set(seriesUid, quantileSorted(positiveDeltas, 0.5));
  }

  const resolution = [Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY];
  for (const slice of slices) {
    const thickness = slice.sliceThicknessMm;
    const declaredThickness =
      typeof thickness === 'number' && Number.isFinite(thickness) && thickness > 0 ? thickness : null;
    const declaredSpacing = slice.spacingBetweenSlicesMm;
    const centerSpacing =
      typeof declaredSpacing === 'number' && Number.isFinite(declaredSpacing) && declaredSpacing > 0
        ? declaredSpacing
        : geometricSpacingBySeries.get(slice.seriesUid);
    // Sampling cadence can make a known profile less informative, but it must
    // never masquerade as a measured excitation width when thickness is absent.
    const throughPlaneResolution = declaredThickness
      ? Math.max(declaredThickness, centerSpacing ?? declaredThickness)
      : null;

    const components = [
      [slice.rowDir.x, slice.colDir.x, slice.normalDir.x],
      [slice.rowDir.y, slice.colDir.y, slice.normalDir.y],
      [slice.rowDir.z, slice.colDir.z, slice.normalDir.z],
    ];

    for (let axis = 0; axis < 3; axis++) {
      const [rowComponent, colComponent, normalComponent] = components[axis]!;
      let directionalInformation =
        (rowComponent! * rowComponent!) / (slice.colSpacingDsMm * slice.colSpacingDsMm) +
        (colComponent! * colComponent!) / (slice.rowSpacingDsMm * slice.rowSpacingDsMm);
      if (throughPlaneResolution) {
        directionalInformation +=
          (normalComponent! * normalComponent!) / (throughPlaneResolution * throughPlaneResolution);
      }
      if (!(directionalInformation > 1e-12)) continue;
      resolution[axis] = Math.min(resolution[axis]!, 1 / Math.sqrt(directionalInformation));
    }
  }

  const effectiveResolutionMm = resolution.every(Number.isFinite)
    ? ([
        Math.max(outputVoxelSizeMm, resolution[0]!),
        Math.max(outputVoxelSizeMm, resolution[1]!),
        Math.max(outputVoxelSizeMm, resolution[2]!),
      ] as [number, number, number])
    : undefined;

  return {
    acquiredOrientationCount: normals.length,
    ...(effectiveResolutionMm ? { effectiveResolutionMm } : {}),
    sliceProfileSource: declaredProfiles === 0 ? 'unknown' : unknownProfiles > 0 ? 'mixed' : 'declared',
  };
}

function fingerprintReconstruction(params: {
  slices: readonly LoadedSlice[];
  svrParams: SvrParams;
  grid: SvrReconstructionGrid;
  supportedVoxelCount: number;
}): string {
  // Two independent FNV-1a lanes keep accepted identities local and opaque
  // while avoiding a full-volume scan or asynchronous WebCrypto dependency.
  let first = 0x811c9dc5;
  let second = 0x9e3779b9;
  const update = (value: string | number | null | undefined): void => {
    const text = typeof value === 'number' && Number.isFinite(value) ? value.toPrecision(12) : String(value);
    for (let index = 0; index <= text.length; index++) {
      const code = index === text.length ? 0xff : text.charCodeAt(index);
      first = Math.imul(first ^ code, 0x01000193) >>> 0;
      second = Math.imul(second ^ code, 0x85ebca6b) >>> 0;
    }
  };
  const updateVector = (vector: Vec3): void => {
    update(vector.x);
    update(vector.y);
    update(vector.z);
  };

  update(params.slices.length);
  for (const slice of params.slices) {
    update(slice.seriesUid);
    update(slice.sopInstanceUid);
    update(slice.frameOfReferenceUid);
    update(slice.dsRows);
    update(slice.dsCols);
    updateVector(slice.ippMm);
    updateVector(slice.rowDir);
    updateVector(slice.colDir);
    updateVector(slice.normalDir);
    update(slice.rowSpacingDsMm);
    update(slice.colSpacingDsMm);
    update(slice.sliceThicknessMm);
    update(slice.spacingBetweenSlicesMm);
    update(slice.validScale);
  }

  update(params.grid.dims.nx);
  update(params.grid.dims.ny);
  update(params.grid.dims.nz);
  updateVector(params.grid.originMm);
  update(params.grid.voxelSizeMm);
  update(params.supportedVoxelCount);
  update(params.svrParams.targetVoxelSizeMm);
  update(params.svrParams.maxVolumeDim);
  update(params.svrParams.sliceDownsampleMode);
  update(params.svrParams.sliceDownsampleMaxSize);
  update(params.svrParams.seriesRegistrationMode);
  update(params.svrParams.iterations);
  update(params.svrParams.stepSize);
  update(String(params.svrParams.clampOutput));
  update(params.svrParams.psfMode);
  update(params.svrParams.robustLoss);
  update(params.svrParams.robustDelta);
  update(params.svrParams.laplacianWeight);
  update(String(params.svrParams.multiResolution));
  update(params.svrParams.multiResolutionFactor);
  update(params.svrParams.multiResolutionCoarseIterations);
  update(params.svrParams.roi?.sourceSeriesUid);
  for (const coordinate of params.svrParams.roi?.boundsMm.min ?? []) update(coordinate);
  for (const coordinate of params.svrParams.roi?.boundsMm.max ?? []) update(coordinate);

  return `${first.toString(16).padStart(8, '0')}${second.toString(16).padStart(8, '0')}`;
}

async function rigidAlignSeriesInRoi(params: {
  allSlices: LoadedSlice[];
  roiBounds: BoundsMm;
  dims: VolumeDims;
  originMm: Vec3;
  voxelSizeMm: number;
  roi: SvrRoi;
  signal?: AbortSignal;
  onProgress?: (p: SvrProgress) => void;
  debug: boolean;
}): Promise<void> {
  const { allSlices, roiBounds, dims, voxelSizeMm, roi, signal, onProgress, debug } = params;

  // This stage exists because multi-plane fusion is extremely sensitive to even small spatial-tag mismatches.
  // If series are misregistered, SVR will smear details rather than sharpen them.

  const bySeries = new Map<string, LoadedSlice[]>();
  for (const s of allSlices) {
    const arr = bySeries.get(s.seriesUid);
    if (arr) arr.push(s);
    else bySeries.set(s.seriesUid, [s]);
  }

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
  const seriesUids = Array.from(bySeries.keys());
  const referenceSource = referenceUid ? seriesUids.indexOf(referenceUid) + 1 : null;

  debugSvrLog(
    'registration.roi-rigid.plan',
    {
      referenceSource,
      sourceCount: seriesUids.length,
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
      message: `ROI rigid alignment… (source ${idx + 1} of ${seriesUids.length})`,
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
        source: idx + 1,
        sourceCount: seriesUids.length,
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
          source: idx + 1,
          sourceCount: seriesUids.length,
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
      source: idx + 1,
      sourceCount: seriesUids.length,
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
        source: idx + 1,
        sourceCount: seriesUids.length,
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
    const thickness = s.sliceThicknessMm;
    // Center spacing is not slice thickness: missing slabs remain unobserved.
    const halfThickness =
      typeof thickness === 'number' && Number.isFinite(thickness) && thickness > 0 ? thickness / 2 : 0;
    const halfRowSpacing = s.rowSpacingDsMm / 2;
    const halfColSpacing = s.colSpacingDsMm / 2;
    const halfExtentX =
      Math.abs(s.colDir.x) * halfRowSpacing +
      Math.abs(s.rowDir.x) * halfColSpacing +
      Math.abs(s.normalDir.x) * halfThickness;
    const halfExtentY =
      Math.abs(s.colDir.y) * halfRowSpacing +
      Math.abs(s.rowDir.y) * halfColSpacing +
      Math.abs(s.normalDir.y) * halfThickness;
    const halfExtentZ =
      Math.abs(s.colDir.z) * halfRowSpacing +
      Math.abs(s.rowDir.z) * halfColSpacing +
      Math.abs(s.normalDir.z) * halfThickness;

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
      if (p.x - halfExtentX < minX) minX = p.x - halfExtentX;
      if (p.y - halfExtentY < minY) minY = p.y - halfExtentY;
      if (p.z - halfExtentZ < minZ) minZ = p.z - halfExtentZ;
      if (p.x + halfExtentX > maxX) maxX = p.x + halfExtentX;
      if (p.y + halfExtentY > maxY) maxY = p.y + halfExtentY;
      if (p.z + halfExtentZ > maxZ) maxZ = p.z + halfExtentZ;
    }
  }

  if (!Number.isFinite(minX) || !Number.isFinite(maxX)) {
    throw new Error('Failed to compute bounds for SVR');
  }

  return {
    min: v3(minX, minY, minZ),
    max: v3(maxX, maxY, maxZ),
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
export async function computeSvrFromLoadedSlices(
  params: SvrComputePayload & { signal?: AbortSignal; onProgress?: (p: SvrProgress) => void },
): Promise<SvrComputeResult> {
  const { allSlices, intensitySamples, intensitySamplesBySeries, svrParams, signal, onProgress, debug } = params;

  assertNotAborted(signal);
  if (allSlices.length === 0) throw new Error('SVR requires at least one physically located source slice');

  let acceptedFrameOfReferenceUid: string | undefined;
  for (const slice of allSlices) {
    if (slice.pixels.length !== slice.dsRows * slice.dsCols) {
      throw new Error('SVR source pixels do not match their image dimensions');
    }
    if (slice.valid && slice.valid.length !== slice.pixels.length) {
      throw new Error('SVR acquired-pixel support does not match its image dimensions');
    }
    if (slice.validScale !== undefined && (!Number.isFinite(slice.validScale) || slice.validScale <= 0)) {
      throw new Error('SVR acquired-pixel support has an invalid quantitative scale');
    }

    const frameOfReferenceUid = slice.frameOfReferenceUid?.trim();
    if (!frameOfReferenceUid) continue;
    if (acceptedFrameOfReferenceUid && acceptedFrameOfReferenceUid !== frameOfReferenceUid) {
      throw new Error('SVR cannot fuse incompatible frame-of-reference coordinate frames');
    }
    acceptedFrameOfReferenceUid = frameOfReferenceUid;
  }

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
        if (!s.valid || s.valid[i]) s.pixels[i] = mapValue(s.pixels[i] ?? 0, m);
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
      if (s.valid && !s.valid[i]) {
        s.pixels[i] = 0;
        continue;
      }
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
    const sourceOrdinals = new Map(Array.from(bySeries.keys(), (uid, index) => [uid, index + 1] as const));

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
          referenceSource: sourceOrdinals.get(referenceUid),
          sourceCount: bySeries.size,
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
            source: sourceOrdinals.get(uid),
            sourceCount: bySeries.size,
            translateMm: { x: Number(t.x.toFixed(3)), y: Number(t.y.toFixed(3)), z: Number(t.z.toFixed(3)) },
            magnitudeMm: Number(tMag.toFixed(3)),
          },
          debug,
        );

        // Warn if we're doing something large; this is often a sign of inconsistent DICOM spatial tags.
        if (tMag > 20) {
          console.warn('[svr] Large coarse alignment translation applied', {
            source: sourceOrdinals.get(uid),
            sourceCount: bySeries.size,
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
  const sourceBytes = allSlices.reduce(
    (total, slice) => total + slice.pixels.byteLength + (slice.valid?.byteLength ?? 0),
    0,
  );

  const grid = chooseOutputGrid({
    bounds,
    voxelSizeMm: svrParams.targetVoxelSizeMm,
    maxDim: svrParams.maxVolumeDim,
  });

  const { dims, originMm, voxelSizeMm } = grid;
  const nvox = dims.nx * dims.ny * dims.nz;
  let registrationScoreMaxDim = 160;
  if (roi && svrParams.seriesRegistrationMode === 'roi-rigid') {
    try {
      const override = Number(localStorage.getItem('miraviewer:svr-roi-rigid-score-max-dim'));
      if (Number.isFinite(override) && override > 0) {
        registrationScoreMaxDim = Math.max(64, Math.min(256, Math.round(override)));
      }
    } catch {
      // Dedicated workers have no localStorage and always use the canonical 160-voxel score grid.
    }
  }
  const registrationBytes =
    roi && svrParams.seriesRegistrationMode === 'roi-rigid'
      ? estimateSvrRegistrationBytes(nvox, registrationScoreMaxDim)
      : 0;
  const memoryPlan = estimateSvrPeakMemoryBytes({
    voxelCount: nvox,
    sourceBytes,
    iterations,
    retainedBytes: params.residentCacheBytes,
    registrationBytes,
  });
  const peakBytes = memoryPlan.totalBytes;

  if (peakBytes > SVR_MEMORY_BUDGET_BYTES) {
    throw new Error(
      `SVR volume too large (${dims.nx}×${dims.ny}×${dims.nz}); estimated peak ${formatMiB(peakBytes)} ` +
        `(source ${formatMiB(memoryPlan.sourceBytes)}, solver ${formatMiB(memoryPlan.solverBytes)}, ` +
        `support ${formatMiB(memoryPlan.supportBytes)}, display ${formatMiB(memoryPlan.displayBytes)}, ` +
        `decoded cache ${formatMiB(memoryPlan.retainedBytes)}, registration ${formatMiB(memoryPlan.registrationBytes)}) ` +
        `exceeds budget ${formatMiB(SVR_MEMORY_BUDGET_BYTES)}. ` +
        'Select a smaller focus region, lower the maximum dimension, or explicitly choose a coarser voxel size.',
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
    estimatedSource: formatMiB(memoryPlan.sourceBytes),
    estimatedSolver: formatMiB(memoryPlan.solverBytes),
    estimatedSupport: formatMiB(memoryPlan.supportBytes),
    estimatedDisplay: formatMiB(memoryPlan.displayBytes),
    estimatedResidentCache: formatMiB(memoryPlan.retainedBytes),
    estimatedRegistration: formatMiB(memoryPlan.registrationBytes),
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

    if (allSlices.length === 0) {
      throw new Error('SVR focus region contains no physically acquired source slices');
    }

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

  const acquisitionEvidence = deriveAcquisitionEvidence(allSlices, voxelSizeMm);

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
  let observedSupport: Uint8Array;
  let supportedVoxelCount = 0;

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

    const coarseSupport = new Uint8Array(coarseGrid.dims.nx * coarseGrid.dims.ny * coarseGrid.dims.nz);
    let coarse: Float32Array | null = await reconstructVolumeFromSlices({
      slices: allSlices,
      grid: coarseGrid,
      occupancy: coarseSupport,
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

    // A coarse-grid footprint is deliberately wider than the fine acquired domain.
    // Rebuild support directly from fine-grid source observations rather than
    // promoting interpolated coarse neighbors to fabricated anatomy.
    observedSupport = await buildObservedSupportFromSlices({
      slices: allSlices,
      grid: fineGrid,
      psfMode: solverOptions.psfMode,
      hooks: { signal, yieldToMain },
      onObservedSupport: (count) => {
        supportedVoxelCount = count;
      },
    });

    onProgress?.({ phase: 'reconstructing', current: 70, total: 100, message: 'Refining volume…' });

    await refineVolumeInPlace({
      volume,
      slices: allSlices,
      grid: fineGrid,
      options: solverOptions,
      occupancy: observedSupport,
      hooks: {
        signal,
        yieldToMain,
      },
    });
  } else {
    observedSupport = new Uint8Array(nvox);
    volume = await reconstructVolumeFromSlices({
      slices: allSlices,
      grid: fineGrid,
      options: solverOptions,
      occupancy: observedSupport,
      onObservedSupport: (count) => {
        supportedVoxelCount = count;
      },
      hooks: {
        signal,
        yieldToMain,
      },
    });
  }

  const reconstructionFingerprint = fingerprintReconstruction({
    slices: allSlices,
    svrParams,
    grid: fineGrid,
    supportedVoxelCount,
  });

  // The solver is the last consumer of the slice stack. Its decoded/downsampled pixel
  // buffers (typically tens of MiB across all series) would otherwise stay reachable until
  // this function returns; dropping them here makes them GC-eligible before preview
  // generation and result assembly allocate. `allSlices` is the only long-lived holder of
  // the LoadedSlice objects at this point (the per-phase series maps are scope-local).
  allSlices.length = 0;

  return {
    volume,
    observedSupport,
    supportedVoxelCount,
    ...acquisitionEvidence,
    reconstructionFingerprint,
    dims,
    originMm,
    voxelSizeMm,
    bounds,
  };
}
