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

import type { VolumeDims } from './trilinear';
import { sampleTrilinear, sampleTrilinearWithSupport } from './trilinear';
import type { Vec3 } from './vec3';
import { cross, normalize, v3 } from './vec3';
import { assertNotAborted, clampAbs, withinTrilinearSupport, yieldToMain } from './svrUtils';
import { acquiredObservationWeight, type SvrReconstructionSlice } from './reconstructionCore';

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
  /** Fractional acquired-footprint evidence for each observation, when available. */
  weights?: Float32Array;
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
  slices: readonly SvrReconstructionSlice[];
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

  // Preallocate at the sample cap and write with a cursor: dynamic number[] arrays here
  // meant repeated growth reallocations plus a full Float32Array.from copy at the end,
  // for buffers whose maximum size (maxN) is known up front.
  const obs = new Float32Array(maxN);
  const pos = new Float32Array(maxN * 3);
  const weights = slices.some((slice) => slice.valid && typeof slice.validScale === 'number' && slice.validScale !== 1)
    ? new Float32Array(maxN)
    : undefined;
  let count = 0;

  for (let sIdx = 0; sIdx < slices.length; sIdx++) {
    assertNotAborted(signal);
    const s = slices[sIdx];
    if (!s) continue;

    let usedThisSlice = 0;
    // Stopping a row-major scan after its quota samples only the top of every
    // slice. Choose a per-slice lattice that spans the complete field instead.
    const sliceStride = Math.max(stride, Math.ceil(Math.sqrt((s.dsRows * s.dsCols) / perSliceTarget)));

    for (let r = 0; r < s.dsRows; r += sliceStride) {
      const baseX = s.ippMm.x + s.colDir.x * (r * s.rowSpacingDsMm);
      const baseY = s.ippMm.y + s.colDir.y * (r * s.rowSpacingDsMm);
      const baseZ = s.ippMm.z + s.colDir.z * (r * s.rowSpacingDsMm);

      const rowBase = r * s.dsCols;

      for (let c = 0; c < s.dsCols; c += sliceStride) {
        const index = rowBase + c;
        const v = s.pixels[index];
        const acquiredWeight = acquiredObservationWeight(s, index);
        if (!(acquiredWeight > 0) || v === undefined || !Number.isFinite(v)) continue;

        const wx = baseX + s.rowDir.x * (c * s.colSpacingDsMm);
        const wy = baseY + s.rowDir.y * (c * s.colSpacingDsMm);
        const wz = baseZ + s.rowDir.z * (c * s.colSpacingDsMm);

        if (
          wx < roiBounds.min.x ||
          wx > roiBounds.max.x ||
          wy < roiBounds.min.y ||
          wy > roiBounds.max.y ||
          wz < roiBounds.min.z ||
          wz > roiBounds.max.z
        ) {
          continue;
        }

        obs[count] = v;
        pos[count * 3] = wx;
        pos[count * 3 + 1] = wy;
        pos[count * 3 + 2] = wz;
        if (weights) weights[count] = acquiredWeight;
        count++;
        usedThisSlice++;

        if (usedThisSlice >= perSliceTarget) break;
        if (count >= maxN) break;
      }

      if (usedThisSlice >= perSliceTarget) break;
      if (count >= maxN) break;
    }

    if (count >= maxN) break;
  }

  return {
    // Trim views to the filled prefix; subarray shares the backing buffer (no copy).
    obs: obs.subarray(0, count),
    pos: pos.subarray(0, count * 3),
    count,
    ...(weights ? { weights: weights.subarray(0, count) } : {}),
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
  /** Reconstructed voxel occupancy; unsupported zero-filled voxels are never anatomy. */
  occupancy?: Uint8Array;
  /** Minimum fraction of the fixed moving-sample domain retained by this transform. */
  minimumCoverage?: number;
  minimumSamples?: number;
}): { ncc: number; rawNcc: number; used: number; coverage: number } {
  const { samples, refVolume, dims, originMm, voxelSizeMm, centerMm, rigid, occupancy } = params;

  if (samples.count <= 0)
    return { ncc: Number.NEGATIVE_INFINITY, rawNcc: Number.NEGATIVE_INFINITY, used: 0, coverage: 0 };
  if (occupancy && occupancy.length !== refVolume.length)
    throw new Error('Registration occupancy does not match reference volume');
  if (samples.weights && samples.weights.length < samples.count) {
    throw new Error('Registration acquired weights do not match its sample domain');
  }

  const rot = mat3FromEulerXYZ(rigid.rx, rigid.ry, rigid.rz);
  const invVox = 1 / voxelSizeMm;
  const originX = originMm.x;
  const originY = originMm.y;
  const originZ = originMm.z;
  const centerX = centerMm.x;
  const centerY = centerMm.y;
  const centerZ = centerMm.z;

  let sumA = 0;
  let sumB = 0;
  let sumAA = 0;
  let sumBB = 0;
  let sumAB = 0;
  let used = 0;
  let usedWeight = 0;
  let totalWeight = 0;

  const obs = samples.obs;
  const pos = samples.pos;
  const interpolatedObservation = occupancy ? new Float64Array(2) : undefined;

  for (let i = 0; i < samples.count; i++) {
    const acquiredWeight = samples.weights?.[i] ?? 1;
    if (!(acquiredWeight > 0) || !Number.isFinite(acquiredWeight)) continue;
    totalWeight += acquiredWeight;
    const a = obs[i] ?? 0;
    const x = pos[i * 3] ?? 0;
    const y = pos[i * 3 + 1] ?? 0;
    const z = pos[i * 3 + 2] ?? 0;

    // Keep the candidate transform scalar: a representative optimizer scores
    // millions of points, and allocating three Vec3 objects per point creates
    // garbage-collection stalls without changing the physical transform.
    const dx = x - centerX;
    const dy = y - centerY;
    const dz = z - centerZ;
    const vx = (centerX + rot[0] * dx + rot[1] * dy + rot[2] * dz + rigid.tx - originX) * invVox;
    const vy = (centerY + rot[3] * dx + rot[4] * dy + rot[5] * dz + rigid.ty - originY) * invVox;
    const vz = (centerZ + rot[6] * dx + rot[7] * dy + rot[8] * dz + rigid.tz - originZ) * invVox;

    if (!withinTrilinearSupport(dims, vx, vy, vz)) continue;
    let b: number;
    if (occupancy && interpolatedObservation) {
      sampleTrilinearWithSupport(refVolume, occupancy, dims, vx, vy, vz, interpolatedObservation);
      if (interpolatedObservation[1]! < 0.5) continue;
      b = interpolatedObservation[0]! / interpolatedObservation[1]!;
    } else {
      b = sampleTrilinear(refVolume, dims, vx, vy, vz);
    }

    sumA += acquiredWeight * a;
    sumB += acquiredWeight * b;
    sumAA += acquiredWeight * a * a;
    sumBB += acquiredWeight * b * b;
    sumAB += acquiredWeight * a * b;
    usedWeight += acquiredWeight;
    used++;
  }

  // Require minimum samples for reliable optimization
  const coverage = totalWeight > 0 ? usedWeight / totalWeight : 0;
  const minimumSamples = Math.max(1, Math.round(params.minimumSamples ?? 512));
  const minimumCoverage = Math.max(0, Math.min(1, params.minimumCoverage ?? 0.6));
  if (used < minimumSamples || coverage < minimumCoverage) {
    return { ncc: Number.NEGATIVE_INFINITY, rawNcc: Number.NEGATIVE_INFINITY, used, coverage };
  }

  const invN = 1 / usedWeight;
  const cov = sumAB - sumA * sumB * invN;
  const varA = sumAA - sumA * sumA * invN;
  const varB = sumBB - sumB * sumB * invN;

  // Pearson correlation is undefined when either supported signal is constant.
  // Flooring its denominator manufactures a finite zero score, which allows a
  // completely flat MRI volume to masquerade as a valid registration candidate.
  if (varA <= Number.EPSILON * Math.max(1, sumAA) || varB <= Number.EPSILON * Math.max(1, sumBB)) {
    return { ncc: Number.NEGATIVE_INFINITY, rawNcc: Number.NEGATIVE_INFINITY, used, coverage };
  }

  const rawNcc = cov / Math.sqrt(varA * varB);
  // Compare every proposal against the same complete moving-sample domain.
  // Missing anatomy contributes zero evidence instead of disappearing from the denominator.
  const ncc = rawNcc * coverage;

  return { ncc, rawNcc, used, coverage };
}

export type ReverseRegistrationDomain = {
  samples: SeriesSamples;
  refVolume: Float32Array;
  dims: VolumeDims;
  originMm: Vec3;
  voxelSizeMm: number;
  occupancy?: Uint8Array;
};

/** Invert a center-relative rigid transform without treating Euler angles as commutative. */
export function invertRigidParams(rigid: RigidParams): RigidParams {
  const rotation = mat3FromEulerXYZ(rigid.rx, rigid.ry, rigid.rz);
  const inverse: Mat3 = [
    rotation[0],
    rotation[3],
    rotation[6],
    rotation[1],
    rotation[4],
    rotation[7],
    rotation[2],
    rotation[5],
    rotation[8],
  ];
  const ry = Math.asin(Math.max(-1, Math.min(1, -inverse[6])));
  const singular = Math.abs(Math.cos(ry)) < 1e-8;
  const rx = singular ? 0 : Math.atan2(inverse[7], inverse[8]);
  const rz = singular ? Math.atan2(-inverse[1], inverse[4]) : Math.atan2(inverse[3], inverse[0]);
  const translation = mat3MulVec3(inverse, -rigid.tx, -rigid.ty, -rigid.tz);
  return { tx: translation.x, ty: translation.y, tz: translation.z, rx, ry, rz };
}

export function scoreBidirectionalNcc(
  params: Parameters<typeof scoreNcc>[0] & { reverse: ReverseRegistrationDomain },
): {
  ncc: number;
  used: number;
  coverage: number;
  forward: ReturnType<typeof scoreNcc>;
  reverse: ReturnType<typeof scoreNcc>;
} {
  const { reverse, ...forwardParams } = params;
  const forward = scoreNcc(forwardParams);
  const backward = scoreNcc({
    ...reverse,
    centerMm: params.centerMm,
    rigid: invertRigidParams(params.rigid),
    minimumCoverage: params.minimumCoverage,
    minimumSamples: params.minimumSamples,
  });
  return {
    ncc: Math.min(forward.ncc, backward.ncc),
    used: Math.min(forward.used, backward.used),
    coverage: Math.min(forward.coverage, backward.coverage),
    forward,
    reverse: backward,
  };
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
  occupancy?: Uint8Array;
  minimumCoverage?: number;
  minimumSamples?: number;
  initial?: RigidParams;
  maxTranslationMm?: number;
  maxRotationRad?: number;
  /** Smallest physically justified translation probe; defaults to one tenth of a voxel. */
  finestTranslationStepMm?: number;
  /** Smallest physically justified rotation probe; defaults to the translation step at the sample radius. */
  finestRotationStepRad?: number;
  reverse?: ReverseRegistrationDomain;
}): Promise<{ best: RigidParams; bestScore: number; used: number; evals: number }> {
  const {
    samples,
    refVolume,
    dims,
    originMm,
    voxelSizeMm,
    centerMm,
    signal,
    occupancy,
    minimumCoverage,
    minimumSamples,
    reverse,
  } = params;

  // Search bounds - assumes coarse alignment got us "close"
  const MAX_TRANS_MM = params.maxTranslationMm ?? 20;
  const MAX_ROT_RAD = params.maxRotationRad ?? (10 * Math.PI) / 180;

  let sampleRadiusMm = voxelSizeMm;
  for (let index = 0; index < samples.count; index++) {
    sampleRadiusMm = Math.max(
      sampleRadiusMm,
      Math.hypot(
        samples.pos[index * 3]! - centerMm.x,
        samples.pos[index * 3 + 1]! - centerMm.y,
        samples.pos[index * 3 + 2]! - centerMm.z,
      ),
    );
  }
  const finestTranslationStepMm = Math.max(0.025, Math.min(0.5, params.finestTranslationStepMm ?? voxelSizeMm / 10));
  const finestRotationStepRad = Math.max(
    (0.025 * Math.PI) / 180,
    Math.min((0.5 * Math.PI) / 180, params.finestRotationStepRad ?? finestTranslationStepMm / sampleRadiusMm),
  );
  const stages = [
    { transStepMm: 2.0, rotStepRad: (2 * Math.PI) / 180 },
    { transStepMm: 1.0, rotStepRad: (1 * Math.PI) / 180 },
    { transStepMm: 0.5, rotStepRad: (0.5 * Math.PI) / 180 },
  ];
  let translationStepMm = 0.5;
  let rotationStepRad = (0.5 * Math.PI) / 180;
  while (translationStepMm > finestTranslationStepMm || rotationStepRad > finestRotationStepRad) {
    translationStepMm = Math.max(finestTranslationStepMm, translationStepMm / 2);
    rotationStepRad = Math.max(finestRotationStepRad, rotationStepRad / 2);
    stages.push({ transStepMm: translationStepMm, rotStepRad: rotationStepRad });
  }

  const evaluate = (rigid: RigidParams) => {
    const forward = {
      samples,
      refVolume,
      dims,
      originMm,
      voxelSizeMm,
      centerMm,
      rigid,
      occupancy,
      minimumCoverage,
      minimumSamples,
    };
    return reverse ? scoreBidirectionalNcc({ ...forward, reverse }) : scoreNcc(forward);
  };

  const cur: RigidParams = params.initial ? { ...params.initial } : { tx: 0, ty: 0, tz: 0, rx: 0, ry: 0, rz: 0 };
  const bestEval = evaluate(cur);
  let bestScore = bestEval.ncc;
  let bestUsed = bestEval.used;
  let evals = 1;

  // One reusable probe object instead of two fresh spreads per parameter per iteration
  // (the old version allocated ~hundreds of short-lived objects per series, all inside the
  // optimizer's hot loop). The probe always equals `cur` except in the single parameter
  // under test, so accepting an improvement is just writing that one value back into
  // `cur` — equivalent to the old `cur = next` aliasing, without the escape.
  const probe: RigidParams = { ...cur };

  const tryProbe = (key: keyof RigidParams, value: number): boolean => {
    probe.tx = cur.tx;
    probe.ty = cur.ty;
    probe.tz = cur.tz;
    probe.rx = cur.rx;
    probe.ry = cur.ry;
    probe.rz = cur.rz;
    probe[key] = value;

    const e = evaluate(probe);
    evals++;
    if (e.ncc > bestScore + 1e-7) {
      cur[key] = value;
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

        // Both candidate values derive from the parameter's value at key-loop entry, as in
        // the original (the minus candidate was computed before the plus one was tried).
        const base = cur[key];

        if (tryProbe(key, clampAbs(base + step, maxVal))) improved = true;
        if (tryProbe(key, clampAbs(base - step, maxVal))) improved = true;

        // Yield periodically to avoid blocking the main thread. Each eval scans up to 40k
        // samples, so the old every-25-evals cadence could block for hundreds of ms.
        if (evals % 5 === 0) {
          await yieldToMain();
        }
      }
    }
  }

  return { best: cur, bestScore, used: bestUsed, evals };
}
