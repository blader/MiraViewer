/**
 * Rigid Registration for SVR (Slice-to-Volume Reconstruction)
 *
 * This module implements ROI-constrained rigid registration for aligning
 * multiple MRI series before fusion. The registration uses normalized
 * cross-correlation (NCC) as the similarity metric and performs coordinate
 * descent optimization with multi-scale step sizes.
 *
 * Key concepts:
 * - Each series is aligned to a reference volume built from other series
 * - Transforms are applied about the ROI center to keep the region of interest stable
 * - Small rotation and translation limits prevent unreasonable transforms
 */

import type { SvrProgress, SvrRoi, SvrSelectedSeries } from '../../types/svr';
import type { VolumeDims } from './trilinear';
import { sampleTrilinear } from './trilinear';
import type { Vec3 } from './vec3';
import { cross, normalize, v3 } from './vec3';
import { assertNotAborted, clampAbs, withinTrilinearSupport, yieldToMain } from './svrUtils';
import type { SvrReconstructionGrid, SvrReconstructionOptions, SvrReconstructionSlice } from './reconstructionCore';
import { reconstructVolumeFromSlices } from './reconstructionCore';
import { debugSvrLog } from '../debugSvr';

// ============================================================================
// Types
// ============================================================================

/** 3×3 rotation matrix stored as a flat 9-element tuple (row-major order) */
export type Mat3 = [number, number, number, number, number, number, number, number, number];

/**
 * Parameters for a rigid transform (rotation + translation).
 * Rotation is specified as Euler angles in radians (XYZ convention).
 */
export type RigidParams = {
  /** Translation in world/patient mm along X axis */
  tx: number;
  /** Translation in world/patient mm along Y axis */
  ty: number;
  /** Translation in world/patient mm along Z axis */
  tz: number;
  /** Rotation in radians about X axis */
  rx: number;
  /** Rotation in radians about Y axis */
  ry: number;
  /** Rotation in radians about Z axis */
  rz: number;
};

/**
 * Samples extracted from a series for registration scoring.
 * Stores both intensity values and their world positions.
 */
export type SeriesSamples = {
  /** Observed intensities (normalized [0,1]) */
  obs: Float32Array;
  /** Original world positions (x,y,z interleaved, 3 values per sample) */
  pos: Float32Array;
  /** Number of samples */
  count: number;
};

/** Axis-aligned bounding box in world/patient mm coordinates */
export type BoundsMm = { min: Vec3; max: Vec3 };

/**
 * LoadedSlice extends SvrReconstructionSlice with additional metadata
 * needed for the full reconstruction pipeline.
 */
export type LoadedSlice = SvrReconstructionSlice & {
  /** Series UID this slice belongs to */
  seriesUid: string;
  /** SOP Instance UID for this specific slice */
  sopInstanceUid: string;

  /** Original (pre-downsample) row count */
  srcRows: number;
  /** Original (pre-downsample) column count */
  srcCols: number;
  /** Original row spacing in mm (pre-downsample) */
  rowSpacingMm: number;
  /** Original column spacing in mm (pre-downsample) */
  colSpacingMm: number;
};

// ============================================================================
// Matrix and transform utilities
// ============================================================================

/**
 * Constructs a 3×3 rotation matrix from Euler angles using XYZ convention.
 * The rotation order is: R = Rz(rz) * Ry(ry) * Rx(rx)
 *
 * @param rx - Rotation about X axis in radians
 * @param ry - Rotation about Y axis in radians
 * @param rz - Rotation about Z axis in radians
 * @returns 3×3 rotation matrix as a flat array
 */
export function mat3FromEulerXYZ(rx: number, ry: number, rz: number): Mat3 {
  const cx = Math.cos(rx);
  const sx = Math.sin(rx);
  const cy = Math.cos(ry);
  const sy = Math.sin(ry);
  const cz = Math.cos(rz);
  const sz = Math.sin(rz);

  const m00 = cz * cy;
  const m01 = cz * sy * sx - sz * cx;
  const m02 = cz * sy * cx + sz * sx;

  const m10 = sz * cy;
  const m11 = sz * sy * sx + cz * cx;
  const m12 = sz * sy * cx - cz * sx;

  const m20 = -sy;
  const m21 = cy * sx;
  const m22 = cy * cx;

  return [m00, m01, m02, m10, m11, m12, m20, m21, m22];
}

/**
 * Multiplies a 3×3 matrix by a 3D vector.
 *
 * @param m - 3×3 matrix (row-major)
 * @param x - X component of vector
 * @param y - Y component of vector
 * @param z - Z component of vector
 * @returns Transformed vector
 */
export function mat3MulVec3(m: Mat3, x: number, y: number, z: number): Vec3 {
  return v3(m[0] * x + m[1] * y + m[2] * z, m[3] * x + m[4] * y + m[5] * z, m[6] * x + m[7] * y + m[8] * z);
}

/**
 * Applies a rigid transform to a point.
 * The transform rotates about a center point, then translates.
 *
 * @param p - Point to transform
 * @param centerMm - Center of rotation in mm
 * @param rot - Rotation matrix
 * @param tMm - Translation vector in mm
 * @returns Transformed point
 */
export function applyRigidToPoint(p: Vec3, centerMm: Vec3, rot: Mat3, tMm: Vec3): Vec3 {
  const dx = p.x - centerMm.x;
  const dy = p.y - centerMm.y;
  const dz = p.z - centerMm.z;

  const r = mat3MulVec3(rot, dx, dy, dz);
  return v3(centerMm.x + r.x + tMm.x, centerMm.y + r.y + tMm.y, centerMm.z + r.z + tMm.z);
}

/**
 * Applies a rotation to a direction vector.
 *
 * @param d - Direction vector to rotate
 * @param rot - Rotation matrix
 * @returns Rotated and normalized direction vector
 */
function applyRotToDir(d: Vec3, rot: Mat3): Vec3 {
  const r = mat3MulVec3(rot, d.x, d.y, d.z);
  return normalize(r);
}

/**
 * Re-orthonormalizes row and column direction vectors.
 * This prevents numerical drift after repeated rotations.
 *
 * @param rowDir - Row direction vector
 * @param colDir - Column direction vector
 * @returns Orthonormalized row and column vectors
 */
function orthonormalizeRowCol(rowDir: Vec3, colDir: Vec3): { rowDir: Vec3; colDir: Vec3 } {
  const r = normalize(rowDir);
  const c0 = normalize(colDir);
  const n = normalize(cross(r, c0));
  const c = normalize(cross(n, r));
  return { rowDir: r, colDir: c };
}

// ============================================================================
// Bounds utilities
// ============================================================================

/**
 * Computes the center point of a bounding box.
 */
export function boundsCenterMm(b: BoundsMm): Vec3 {
  return v3((b.min.x + b.max.x) * 0.5, (b.min.y + b.max.y) * 0.5, (b.min.z + b.max.z) * 0.5);
}

/**
 * Checks if a point is within a bounding box (inclusive).
 */
function isWithinBoundsMm(p: Vec3, b: BoundsMm): boolean {
  return p.x >= b.min.x && p.x <= b.max.x && p.y >= b.min.y && p.y <= b.max.y && p.z >= b.min.z && p.z <= b.max.z;
}

// ============================================================================
// Slice transform application
// ============================================================================

/**
 * Applies a rigid transform to all slices in a series.
 * Modifies slices in-place.
 *
 * @param params.slices - Slices to transform
 * @param params.centerMm - Center of rotation
 * @param params.rot - Rotation matrix
 * @param params.tMm - Translation vector
 */
export function applyRigidToSeriesSlices(params: {
  slices: LoadedSlice[];
  centerMm: Vec3;
  rot: Mat3;
  tMm: Vec3;
}): void {
  const { slices, centerMm, rot, tMm } = params;

  for (const s of slices) {
    s.ippMm = applyRigidToPoint(s.ippMm, centerMm, rot, tMm);

    const row = applyRotToDir(s.rowDir, rot);
    const col = applyRotToDir(s.colDir, rot);
    const ortho = orthonormalizeRowCol(row, col);
    s.rowDir = ortho.rowDir;
    s.colDir = ortho.colDir;
    s.normalDir = normalize(cross(s.rowDir, s.colDir));
  }
}

// ============================================================================
// Sample extraction for registration
// ============================================================================

/**
 * Extracts intensity samples from slices within an ROI for registration scoring.
 * Uses strided sampling to limit computation while maintaining spatial coverage.
 *
 * @param params.slices - Source slices
 * @param params.roiBounds - ROI to sample within
 * @param params.maxSamples - Maximum number of samples to extract
 * @param params.signal - Optional abort signal
 * @returns Extracted samples with positions
 */
export function buildSeriesSamples(params: {
  slices: LoadedSlice[];
  roiBounds: BoundsMm;
  maxSamples: number;
  signal?: AbortSignal;
}): SeriesSamples {
  const { slices, roiBounds, maxSamples, signal } = params;

  const maxN = Math.max(1, Math.round(maxSamples));
  const perSliceTarget = Math.max(64, Math.ceil(maxN / Math.max(1, slices.length)));

  let totalPixels = 0;
  for (const s of slices) totalPixels += s.dsRows * s.dsCols;

  // Choose a roughly-uniform stride so we don't spend time scoring every pixel.
  const stride = Math.max(1, Math.floor(Math.sqrt(totalPixels / maxN)));

  const obs: number[] = [];
  const pos: number[] = [];

  for (let sIdx = 0; sIdx < slices.length; sIdx++) {
    assertNotAborted(signal);
    const s = slices[sIdx];
    if (!s) continue;

    let usedThisSlice = 0;

    for (let r = 0; r < s.dsRows; r += stride) {
      const baseX = s.ippMm.x + s.colDir.x * (r * s.rowSpacingDsMm);
      const baseY = s.ippMm.y + s.colDir.y * (r * s.rowSpacingDsMm);
      const baseZ = s.ippMm.z + s.colDir.z * (r * s.rowSpacingDsMm);

      const rowBase = r * s.dsCols;

      for (let c = 0; c < s.dsCols; c += stride) {
        const v = s.pixels[rowBase + c] ?? 0;
        if (v <= 0) continue;

        const wx = baseX + s.rowDir.x * (c * s.colSpacingDsMm);
        const wy = baseY + s.rowDir.y * (c * s.colSpacingDsMm);
        const wz = baseZ + s.rowDir.z * (c * s.colSpacingDsMm);

        const p = v3(wx, wy, wz);
        if (!isWithinBoundsMm(p, roiBounds)) continue;

        obs.push(v);
        pos.push(wx, wy, wz);
        usedThisSlice++;

        if (usedThisSlice >= perSliceTarget) break;
        if (obs.length >= maxN) break;
      }

      if (usedThisSlice >= perSliceTarget) break;
      if (obs.length >= maxN) break;
    }

    if (obs.length >= maxN) break;
  }

  return {
    obs: Float32Array.from(obs),
    pos: Float32Array.from(pos),
    count: obs.length,
  };
}

// ============================================================================
// Registration scoring
// ============================================================================

/**
 * Computes Normalized Cross-Correlation (NCC) between series samples
 * and a reference volume, given a candidate rigid transform.
 *
 * NCC is defined as: cov(A,B) / sqrt(var(A) * var(B))
 * where A = observed intensities, B = sampled volume intensities.
 *
 * @returns NCC score (higher is better, max 1.0) and count of valid samples
 */
export function scoreNcc(params: {
  samples: SeriesSamples;
  refVolume: Float32Array;
  dims: VolumeDims;
  originMm: Vec3;
  voxelSizeMm: number;
  centerMm: Vec3;
  rigid: RigidParams;
}): { ncc: number; used: number } {
  const { samples, refVolume, dims, originMm, voxelSizeMm, centerMm, rigid } = params;

  if (samples.count <= 0) return { ncc: Number.NEGATIVE_INFINITY, used: 0 };

  const rot = mat3FromEulerXYZ(rigid.rx, rigid.ry, rigid.rz);
  const tMm = v3(rigid.tx, rigid.ty, rigid.tz);

  const invVox = 1 / voxelSizeMm;

  let sumA = 0;
  let sumB = 0;
  let sumAA = 0;
  let sumBB = 0;
  let sumAB = 0;
  let used = 0;

  const obs = samples.obs;
  const pos = samples.pos;

  for (let i = 0; i < samples.count; i++) {
    const a = obs[i] ?? 0;
    const x = pos[i * 3] ?? 0;
    const y = pos[i * 3 + 1] ?? 0;
    const z = pos[i * 3 + 2] ?? 0;

    // Apply candidate rigid transform about ROI center.
    const p = applyRigidToPoint(v3(x, y, z), centerMm, rot, tMm);

    const vx = (p.x - originMm.x) * invVox;
    const vy = (p.y - originMm.y) * invVox;
    const vz = (p.z - originMm.z) * invVox;

    if (!withinTrilinearSupport(dims, vx, vy, vz)) continue;

    const b = sampleTrilinear(refVolume, dims, vx, vy, vz);

    sumA += a;
    sumB += b;
    sumAA += a * a;
    sumBB += b * b;
    sumAB += a * b;
    used++;
  }

  // Require minimum samples for reliable optimization
  const MIN_SAMPLES_FOR_OPTIMIZATION = 512;
  if (used < MIN_SAMPLES_FOR_OPTIMIZATION) {
    return { ncc: Number.NEGATIVE_INFINITY, used };
  }

  const invN = 1 / used;
  const cov = sumAB - sumA * sumB * invN;
  const varA = sumAA - sumA * sumA * invN;
  const varB = sumBB - sumB * sumB * invN;

  const denom = Math.sqrt(Math.max(1e-12, varA * varB));
  const ncc = denom > 0 ? cov / denom : Number.NEGATIVE_INFINITY;

  return { ncc, used };
}

// ============================================================================
// Optimization
// ============================================================================

/**
 * Optimizes rigid transform parameters to maximize NCC with reference volume.
 *
 * Uses coordinate descent with multi-scale step sizes:
 * 1. Coarse: 2mm translation, 2° rotation
 * 2. Medium: 1mm translation, 1° rotation
 * 3. Fine: 0.5mm translation, 0.5° rotation
 *
 * The search is bounded to prevent unreasonable transforms:
 * - Max translation: ±20mm per axis
 * - Max rotation: ±10° per axis
 *
 * @returns Best transform found, its score, and optimization statistics
 */
export async function optimizeRigidNcc(params: {
  samples: SeriesSamples;
  refVolume: Float32Array;
  dims: VolumeDims;
  originMm: Vec3;
  voxelSizeMm: number;
  centerMm: Vec3;
  signal?: AbortSignal;
}): Promise<{ best: RigidParams; bestScore: number; used: number; evals: number }> {
  const { samples, refVolume, dims, originMm, voxelSizeMm, centerMm, signal } = params;

  // Search bounds - assumes coarse alignment got us "close"
  const MAX_TRANS_MM = 20;
  const MAX_ROT_RAD = (10 * Math.PI) / 180;

  // Multi-scale optimization stages (coarse to fine)
  const stages = [
    { transStepMm: 2.0, rotStepRad: (2 * Math.PI) / 180 },
    { transStepMm: 1.0, rotStepRad: (1 * Math.PI) / 180 },
    { transStepMm: 0.5, rotStepRad: (0.5 * Math.PI) / 180 },
  ];

  let cur: RigidParams = { tx: 0, ty: 0, tz: 0, rx: 0, ry: 0, rz: 0 };
  const bestEval = scoreNcc({ samples, refVolume, dims, originMm, voxelSizeMm, centerMm, rigid: cur });
  let bestScore = bestEval.ncc;
  let bestUsed = bestEval.used;
  let evals = 1;

  const tryUpdate = (next: RigidParams): boolean => {
    const e = scoreNcc({ samples, refVolume, dims, originMm, voxelSizeMm, centerMm, rigid: next });
    evals++;
    if (e.ncc > bestScore + 1e-4) {
      cur = next;
      bestScore = e.ncc;
      bestUsed = e.used;
      return true;
    }
    return false;
  };

  for (const stage of stages) {
    let improved = true;
    let iter = 0;
    const MAX_ITERATIONS_PER_STAGE = 20;

    while (improved && iter < MAX_ITERATIONS_PER_STAGE) {
      assertNotAborted(signal);
      improved = false;
      iter++;

      const t = stage.transStepMm;
      const r = stage.rotStepRad;

      const candidates: Array<keyof RigidParams> = ['tx', 'ty', 'tz', 'rx', 'ry', 'rz'];

      for (const key of candidates) {
        const step = key.startsWith('t') ? t : r;
        const maxVal = key.startsWith('t') ? MAX_TRANS_MM : MAX_ROT_RAD;

        const plus: RigidParams = { ...cur };
        const minus: RigidParams = { ...cur };
        (plus as Record<string, number>)[key] = clampAbs(cur[key] + step, maxVal);
        (minus as Record<string, number>)[key] = clampAbs(cur[key] - step, maxVal);

        if (tryUpdate(plus)) improved = true;
        if (tryUpdate(minus)) improved = true;

        // Yield periodically to avoid blocking the main thread
        if (evals % 25 === 0) {
          await yieldToMain();
        }
      }
    }
  }

  return { best: cur, bestScore, used: bestUsed, evals };
}

// ============================================================================
// Main registration function
// ============================================================================

/**
 * Performs ROI-constrained rigid registration for all non-reference series.
 *
 * Algorithm:
 * 1. Group slices by series
 * 2. Pick a reference series (preferably the ROI source series, or largest)
 * 3. For each non-reference series:
 *    a. Build a reference volume from all OTHER series
 *    b. Extract samples from the moving series within ROI
 *    c. Optimize rigid transform to maximize NCC
 *    d. If improved, apply transform to moving series slices
 *
 * This approach handles the "leave-one-out" registration problem where
 * we can't include the moving series in its own reference volume.
 */
export async function rigidAlignSeriesInRoi(params: {
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
  const { allSlices, selectedSeries, roiBounds, dims, originMm, voxelSizeMm, roi, signal, onProgress, debug } = params;

  // Group slices by series for independent processing
  const bySeries = new Map<string, LoadedSlice[]>();
  for (const s of allSlices) {
    const arr = bySeries.get(s.seriesUid);
    if (arr) arr.push(s);
    else bySeries.set(s.seriesUid, [s]);
  }

  // Build label lookup for logging
  const labelByUid = new Map<string, string>();
  for (const s of selectedSeries) labelByUid.set(s.seriesUid, s.label);

  // Select reference series:
  // - Prefer the ROI source series (keeps ROI coordinates stable)
  // - Fallback to series with most slices (most data = most stable reference)
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

  debugSvrLog(
    'registration.roi-rigid.plan',
    {
      referenceUid,
      centerMm: { x: Number(centerMm.x.toFixed(3)), y: Number(centerMm.y.toFixed(3)), z: Number(centerMm.z.toFixed(3)) },
      dims,
      voxelSizeMm: Number(voxelSizeMm.toFixed(4)),
    },
    debug
  );

  // Align each non-reference series
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

    // Build reference volume from all OTHER series (leave-one-out)
    const otherSlices: LoadedSlice[] = [];
    for (const [otherUid, slices] of bySeries) {
      if (otherUid === uid) continue;
      otherSlices.push(...slices);
    }

    if (otherSlices.length === 0) continue;

    // Quick reconstruction for scoring (no iterations, basic settings)
    const refGrid: SvrReconstructionGrid = { dims, originMm, voxelSizeMm };
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
      hooks: { signal, yieldToMain },
    });

    // Extract samples from moving series within ROI
    const MAX_SAMPLES_FOR_REGISTRATION = 40_000;
    const samples = buildSeriesSamples({
      slices: movingSlices,
      roiBounds: roiBounds,
      maxSamples: MAX_SAMPLES_FOR_REGISTRATION,
      signal,
    });

    const MIN_SAMPLES_TO_REGISTER = 1024;
    if (samples.count < MIN_SAMPLES_TO_REGISTER) {
      console.warn('[svr] ROI rigid alignment: too few samples inside ROI; skipping series', {
        seriesUid: uid,
        label: labelByUid.get(uid) ?? uid,
        samples: samples.count,
      });
      continue;
    }

    // Score before optimization
    const before = scoreNcc({
      samples,
      refVolume: refVol,
      dims,
      originMm,
      voxelSizeMm,
      centerMm,
      rigid: { tx: 0, ty: 0, tz: 0, rx: 0, ry: 0, rz: 0 },
    });

    // Optimize
    const opt = await optimizeRigidNcc({ samples, refVolume: refVol, dims, originMm, voxelSizeMm, centerMm, signal });

    // Score after optimization
    const after = scoreNcc({
      samples,
      refVolume: refVol,
      dims,
      originMm,
      voxelSizeMm,
      centerMm,
      rigid: opt.best,
    });

    // Only apply if score actually improved
    const MIN_NCC_IMPROVEMENT = 1e-3;
    if (!(after.ncc > before.ncc + MIN_NCC_IMPROVEMENT)) {
      debugSvrLog(
        'registration.roi-rigid.skip',
        {
          seriesUid: uid,
          label: labelByUid.get(uid) ?? uid,
          nccBefore: before.ncc,
          nccAfter: after.ncc,
          used: after.used,
        },
        debug
      );
      continue;
    }

    // Apply the optimized transform
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
      debug
    );

    await yieldToMain();
  }
}
