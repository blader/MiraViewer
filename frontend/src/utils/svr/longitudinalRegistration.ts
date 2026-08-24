import { sliceCornersMm } from './dicomGeometry';
import { resample2dAreaAverage } from './resample2d';
import {
  applyRigidToPoint,
  boundsCenterMm,
  buildSeriesSamples,
  mat3FromEulerXYZ,
  mat3MulVec3,
  optimizeRigidNcc,
  scoreBidirectionalNcc,
  type BoundsMm,
  type Mat3,
  type RigidParams,
} from './rigidRegistration';
import {
  reconstructVolumeFromSlices,
  type SvrReconstructionGrid,
  type SvrReconstructionSlice,
} from './reconstructionCore';
import { assertNotAborted, yieldToMain } from './svrUtils';
import { cross, dot, norm, v3, type Vec3 } from './vec3';

const IDENTITY_RIGID: RigidParams = { tx: 0, ty: 0, tz: 0, rx: 0, ry: 0, rz: 0 };
const COORDINATE_EPSILON_MM = 1e-5;

export type LongitudinalRegistrationFailure = {
  ok: false;
  reason:
    | 'invalid-geometry'
    | 'insufficient-samples'
    | 'insufficient-coverage'
    | 'insufficient-evidence'
    | 'ambiguous'
    | 'cancelled'
    | 'registration-failed';
  message: string;
};

export type LongitudinalRegistrationResult = {
  ok: true;
  pixels: Float32Array;
  rows: number;
  cols: number;
  targetToReference: RigidParams;
  /** All rigid parameters rotate around this reference-frame patient-space center. */
  centerMm: Vec3;
  coverage: number;
  score: number;
  diagnostics: {
    rawScore: number;
    retainedSampleFraction: number;
    reverseRetainedSampleFraction: number;
    sampledTargetCount: number;
    evaluatedCandidates: number;
    referenceVoxelSizeMm: number;
    angleDifferenceDeg: number;
    /** Fixed-domain NCC advantage over the best materially distinct supported seed. */
    scoreMargin: number;
    /** Optimistic independent-sample Pearson standard error, not a clinical probability. */
    minimumDistinguishableScoreMargin: number;
    /** Absolute forward/reverse Pearson disagreement over occupied anatomical support. */
    inverseScoreGap: number;
    referenceIntensityVariance: number;
    targetIntensityVariance: number;
    presentationSourceFrameCount?: number;
    presentationSliceSpacingMm?: number;
    presentationSourceDepthSpanMm?: number;
  };
  provenance: {
    referenceFrameOfReferenceUid?: string;
    targetFrameOfReferenceUid?: string;
    frameRelationship: 'same' | 'different' | 'unverified';
    referenceSliceIndex: number;
  };
};

export type RegisterLongitudinalOptions = {
  referenceSlices: readonly SvrReconstructionSlice[];
  targetSlices: readonly SvrReconstructionSlice[];
  referenceSliceIndex: number;
  /** Reference-plane row-major mask. Nonzero pixels are excluded through the stack. */
  referenceExclusionMask?: Uint8Array;
  initialTargetToReference?: RigidParams;
  signal?: AbortSignal;
  maxSamples?: number;
  maxDimension?: number;
  minCoverage?: number;
};

/** Plane geometry remains usable after the coarse worker transfers its source pixels. */
export type LongitudinalReferencePlane = Omit<SvrReconstructionSlice, 'pixels'>;

export type DenseLongitudinalResliceOptions = {
  targetSlices: readonly SvrReconstructionSlice[];
  referencePlane: LongitudinalReferencePlane;
  targetToReference: RigidParams;
  centerMm: Vec3;
  minCoverage?: number;
  signal?: AbortSignal;
};

export type DenseLongitudinalResliceResult = {
  ok: true;
  pixels: Float32Array;
  rows: number;
  cols: number;
  coverage: number;
};

function finitePoint(point: Vec3): boolean {
  return Number.isFinite(point.x) && Number.isFinite(point.y) && Number.isFinite(point.z);
}

function validateStack(slices: readonly SvrReconstructionSlice[], label: string): string | null {
  if (slices.length < 2) return `${label} requires at least two physically located slices`;
  const first = slices[0];
  if (!first) return `${label} contains no slices`;

  for (const slice of slices) {
    if (
      !Number.isInteger(slice.dsRows) ||
      !Number.isInteger(slice.dsCols) ||
      slice.dsRows < 2 ||
      slice.dsCols < 2 ||
      slice.pixels.length !== slice.dsRows * slice.dsCols ||
      !Number.isFinite(slice.rowSpacingDsMm) ||
      !Number.isFinite(slice.colSpacingDsMm) ||
      slice.rowSpacingDsMm <= 0 ||
      slice.colSpacingDsMm <= 0 ||
      !finitePoint(slice.ippMm) ||
      !finitePoint(slice.rowDir) ||
      !finitePoint(slice.colDir) ||
      !finitePoint(slice.normalDir)
    ) {
      return `${label} has missing or invalid physical slice geometry`;
    }

    if (
      Math.abs(norm(slice.rowDir) - 1) > 1e-3 ||
      Math.abs(norm(slice.colDir) - 1) > 1e-3 ||
      Math.abs(norm(slice.normalDir) - 1) > 1e-3 ||
      Math.abs(dot(slice.rowDir, slice.colDir)) > 1e-3 ||
      dot(cross(slice.rowDir, slice.colDir), slice.normalDir) < 0.999 ||
      dot(slice.rowDir, first.rowDir) < 0.995 ||
      dot(slice.colDir, first.colDir) < 0.995 ||
      dot(slice.normalDir, first.normalDir) < 0.995
    ) {
      return `${label} has inconsistent or degenerate orientation vectors`;
    }

    if (
      first.frameOfReferenceUid &&
      slice.frameOfReferenceUid &&
      first.frameOfReferenceUid !== slice.frameOfReferenceUid
    ) {
      return `${label} combines incompatible DICOM frames of reference`;
    }
  }
  return null;
}

function stackBounds(slices: readonly SvrReconstructionSlice[]): BoundsMm {
  const min = v3(Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY);
  const max = v3(Number.NEGATIVE_INFINITY, Number.NEGATIVE_INFINITY, Number.NEGATIVE_INFINITY);

  for (const slice of slices) {
    for (const point of sliceCornersMm({
      ippMm: slice.ippMm,
      rowDir: slice.rowDir,
      colDir: slice.colDir,
      rowSpacingMm: slice.rowSpacingDsMm,
      colSpacingMm: slice.colSpacingDsMm,
      rows: slice.dsRows,
      cols: slice.dsCols,
    })) {
      min.x = Math.min(min.x, point.x);
      min.y = Math.min(min.y, point.y);
      min.z = Math.min(min.z, point.z);
      max.x = Math.max(max.x, point.x);
      max.y = Math.max(max.y, point.y);
      max.z = Math.max(max.z, point.z);
    }
  }

  return { min, max };
}

function sampledIntensityVariance(slices: readonly SvrReconstructionSlice[]): number {
  const pixelCount = slices.reduce((count, slice) => count + slice.pixels.length, 0);
  const stride = Math.max(1, Math.floor(pixelCount / 20_000));
  let seen = 0;
  let count = 0;
  let mean = 0;
  let squaredDeviation = 0;

  for (const slice of slices) {
    for (const value of slice.pixels) {
      if (seen++ % stride !== 0 || !Number.isFinite(value)) continue;
      count++;
      const delta = value - mean;
      mean += delta / count;
      squaredDeviation += delta * (value - mean);
    }
  }

  return count > 1 ? squaredDeviation / count : 0;
}

function maximumPoseDisplacementMm(first: RigidParams, second: RigidParams, bounds: BoundsMm, centerMm: Vec3): number {
  const firstRotation = mat3FromEulerXYZ(first.rx, first.ry, first.rz);
  const secondRotation = mat3FromEulerXYZ(second.rx, second.ry, second.rz);
  let maximum = 0;

  for (const x of [bounds.min.x, bounds.max.x]) {
    for (const y of [bounds.min.y, bounds.max.y]) {
      for (const z of [bounds.min.z, bounds.max.z]) {
        const point = v3(x, y, z);
        const firstPoint = applyRigidToPoint(point, centerMm, firstRotation, v3(first.tx, first.ty, first.tz));
        const secondPoint = applyRigidToPoint(point, centerMm, secondRotation, v3(second.tx, second.ty, second.tz));
        maximum = Math.max(
          maximum,
          Math.hypot(firstPoint.x - secondPoint.x, firstPoint.y - secondPoint.y, firstPoint.z - secondPoint.z),
        );
      }
    }
  }

  return maximum;
}

function prepareScoringSlices(
  slices: readonly SvrReconstructionSlice[],
  maxDimension: number,
): SvrReconstructionSlice[] {
  const prepared = slices.map((slice) => {
    const scale = Math.min(1, maxDimension / Math.max(slice.dsRows, slice.dsCols));
    const rows = Math.max(2, Math.round(slice.dsRows * scale));
    const cols = Math.max(2, Math.round(slice.dsCols * scale));
    const rowScale = slice.dsRows / rows;
    const colScale = slice.dsCols / cols;
    const rowOffsetMm = ((rowScale - 1) * slice.rowSpacingDsMm) / 2;
    const colOffsetMm = ((colScale - 1) * slice.colSpacingDsMm) / 2;

    return {
      ...slice,
      pixels: resample2dAreaAverage(slice.pixels, slice.dsRows, slice.dsCols, rows, cols),
      dsRows: rows,
      dsCols: cols,
      rowSpacingDsMm: slice.rowSpacingDsMm * rowScale,
      colSpacingDsMm: slice.colSpacingDsMm * colScale,
      ippMm: v3(
        slice.ippMm.x + slice.colDir.x * rowOffsetMm + slice.rowDir.x * colOffsetMm,
        slice.ippMm.y + slice.colDir.y * rowOffsetMm + slice.rowDir.y * colOffsetMm,
        slice.ippMm.z + slice.colDir.z * rowOffsetMm + slice.rowDir.z * colOffsetMm,
      ),
    };
  });

  const sample: number[] = [];
  const totalPixels = prepared.reduce((sum, slice) => sum + slice.pixels.length, 0);
  const stride = Math.max(1, Math.floor(totalPixels / 20_000));
  let index = 0;
  for (const slice of prepared) {
    for (const value of slice.pixels) {
      if (index++ % stride === 0 && Number.isFinite(value)) sample.push(value);
    }
  }
  sample.sort((a, b) => a - b);
  const lo = sample[Math.floor((sample.length - 1) * 0.01)] ?? 0;
  const hi = sample[Math.floor((sample.length - 1) * 0.99)] ?? lo;
  const inverseRange = hi > lo + 1e-9 ? 1 / (hi - lo) : 0;
  for (const slice of prepared) {
    for (let pixel = 0; pixel < slice.pixels.length; pixel++) {
      const normalized = ((slice.pixels[pixel] ?? lo) - lo) * inverseRange;
      slice.pixels[pixel] = Math.max(0, Math.min(1, normalized));
    }
  }
  return prepared;
}

function maskReferenceAnatomy(
  slices: SvrReconstructionSlice[],
  selectedReference: SvrReconstructionSlice,
  mask: Uint8Array,
): void {
  for (const slice of slices) {
    for (let r = 0; r < slice.dsRows; r++) {
      for (let c = 0; c < slice.dsCols; c++) {
        const point = pixelToWorld(slice, r, c);
        const delta = v3(
          point.x - selectedReference.ippMm.x,
          point.y - selectedReference.ippMm.y,
          point.z - selectedReference.ippMm.z,
        );
        const sourceRow = dot(delta, selectedReference.colDir) / selectedReference.rowSpacingDsMm;
        const sourceCol = dot(delta, selectedReference.rowDir) / selectedReference.colSpacingDsMm;
        // One coarse voxel can average several native pixels. Exclude its whole
        // source footprint plus the neighboring interpolation support, rather
        // than testing only its center against the high-resolution lesion mask.
        const rowRadius = Math.max(1, slice.rowSpacingDsMm / selectedReference.rowSpacingDsMm);
        const colRadius = Math.max(1, slice.colSpacingDsMm / selectedReference.colSpacingDsMm);
        const rowStart = Math.max(0, Math.floor(sourceRow - rowRadius));
        const rowEnd = Math.min(selectedReference.dsRows - 1, Math.ceil(sourceRow + rowRadius));
        const colStart = Math.max(0, Math.floor(sourceCol - colRadius));
        const colEnd = Math.min(selectedReference.dsCols - 1, Math.ceil(sourceCol + colRadius));
        let excluded = false;
        for (let sourceR = rowStart; sourceR <= rowEnd && !excluded; sourceR++) {
          for (let sourceC = colStart; sourceC <= colEnd; sourceC++) {
            if (mask[sourceR * selectedReference.dsCols + sourceC]) {
              excluded = true;
              break;
            }
          }
        }
        if (excluded) {
          slice.pixels[r * slice.dsCols + c] = 0;
        }
      }
    }
  }
}

function boundedGrid(bounds: BoundsMm, spacingMm: number, maxDimension: number): SvrReconstructionGrid {
  const extent = v3(bounds.max.x - bounds.min.x, bounds.max.y - bounds.min.y, bounds.max.z - bounds.min.z);
  const voxelSizeMm = Math.max(spacingMm, Math.max(extent.x, extent.y, extent.z) / Math.max(1, maxDimension - 3));
  const originMm = v3(bounds.min.x - voxelSizeMm, bounds.min.y - voxelSizeMm, bounds.min.z - voxelSizeMm);
  return {
    voxelSizeMm,
    originMm,
    dims: {
      nx: Math.min(maxDimension, Math.max(2, Math.ceil(extent.x / voxelSizeMm) + 3)),
      ny: Math.min(maxDimension, Math.max(2, Math.ceil(extent.y / voxelSizeMm) + 3)),
      nz: Math.min(maxDimension, Math.max(2, Math.ceil(extent.z / voxelSizeMm) + 3)),
    },
  };
}

function axesRotation(target: SvrReconstructionSlice, reference: SvrReconstructionSlice): Mat3 {
  const targetAxes = [target.rowDir, target.colDir, target.normalDir];
  const referenceAxes = [reference.rowDir, reference.colDir, reference.normalDir];
  const values = new Array<number>(9).fill(0);
  for (let r = 0; r < 3; r++) {
    for (let c = 0; c < 3; c++) {
      for (let axis = 0; axis < 3; axis++) {
        const a = referenceAxes[axis]!;
        const b = targetAxes[axis]!;
        const av = r === 0 ? a.x : r === 1 ? a.y : a.z;
        const bv = c === 0 ? b.x : c === 1 ? b.y : b.z;
        values[r * 3 + c]! += av * bv;
      }
    }
  }
  return values as Mat3;
}

function eulerFromRotation(matrix: Mat3): Pick<RigidParams, 'rx' | 'ry' | 'rz'> {
  const ry = Math.asin(Math.max(-1, Math.min(1, -matrix[6])));
  if (Math.abs(Math.cos(ry)) < 1e-8) {
    return { rx: 0, ry, rz: Math.atan2(-matrix[1], matrix[4]) };
  }
  return { rx: Math.atan2(matrix[7], matrix[8]), ry, rz: Math.atan2(matrix[3], matrix[0]) };
}

function alignCenters(targetCenter: Vec3, referenceCenter: Vec3, rotation: Mat3): Vec3 {
  const delta = v3(
    targetCenter.x - referenceCenter.x,
    targetCenter.y - referenceCenter.y,
    targetCenter.z - referenceCenter.z,
  );
  const rotated = mat3MulVec3(rotation, delta.x, delta.y, delta.z);
  return v3(-rotated.x, -rotated.y, -rotated.z);
}

function pixelToWorld(slice: LongitudinalReferencePlane, row: number, col: number): Vec3 {
  return v3(
    slice.ippMm.x + slice.colDir.x * row * slice.rowSpacingDsMm + slice.rowDir.x * col * slice.colSpacingDsMm,
    slice.ippMm.y + slice.colDir.y * row * slice.rowSpacingDsMm + slice.rowDir.y * col * slice.colSpacingDsMm,
    slice.ippMm.z + slice.colDir.z * row * slice.rowSpacingDsMm + slice.rowDir.z * col * slice.colSpacingDsMm,
  );
}

function sampleSliceBilinear(slice: SvrReconstructionSlice, point: Vec3): number | null {
  const delta = v3(point.x - slice.ippMm.x, point.y - slice.ippMm.y, point.z - slice.ippMm.z);
  const rawRow = dot(delta, slice.colDir) / slice.rowSpacingDsMm;
  const rawCol = dot(delta, slice.rowDir) / slice.colSpacingDsMm;
  if (
    rawRow < -COORDINATE_EPSILON_MM ||
    rawCol < -COORDINATE_EPSILON_MM ||
    rawRow > slice.dsRows - 1 + COORDINATE_EPSILON_MM ||
    rawCol > slice.dsCols - 1 + COORDINATE_EPSILON_MM
  ) {
    return null;
  }
  const row = Math.max(0, Math.min(slice.dsRows - 1, rawRow));
  const col = Math.max(0, Math.min(slice.dsCols - 1, rawCol));
  const r0 = Math.floor(row);
  const c0 = Math.floor(col);
  const r1 = Math.min(r0 + 1, slice.dsRows - 1);
  const c1 = Math.min(c0 + 1, slice.dsCols - 1);
  const fr = row - r0;
  const fc = col - c0;
  const a = (slice.pixels[r0 * slice.dsCols + c0] ?? 0) * (1 - fc) + (slice.pixels[r0 * slice.dsCols + c1] ?? 0) * fc;
  const b = (slice.pixels[r1 * slice.dsCols + c0] ?? 0) * (1 - fc) + (slice.pixels[r1 * slice.dsCols + c1] ?? 0) * fc;
  return a * (1 - fr) + b * fr;
}

function inverseRigidPoint(point: Vec3, rigid: RigidParams, center: Vec3, rotation: Mat3): Vec3 {
  const x = point.x - center.x - rigid.tx;
  const y = point.y - center.y - rigid.ty;
  const z = point.z - center.z - rigid.tz;
  return v3(
    center.x + rotation[0] * x + rotation[3] * y + rotation[6] * z,
    center.y + rotation[1] * x + rotation[4] * y + rotation[7] * z,
    center.z + rotation[2] * x + rotation[5] * y + rotation[8] * z,
  );
}

export function resliceStackToReferencePlane(params: {
  targetSlices: readonly SvrReconstructionSlice[];
  referenceSlice: LongitudinalReferencePlane;
  targetToReference?: RigidParams;
  centerMm?: Vec3;
  signal?: AbortSignal;
}): { pixels: Float32Array; rows: number; cols: number; coverage: number } {
  const { targetSlices, referenceSlice, signal } = params;
  const first = targetSlices[0];
  if (!first) throw new Error('Cannot reslice an empty target stack');
  const normal = first.normalDir;
  const ordered = targetSlices
    .map((slice) => ({ slice, depth: dot(slice.ippMm, normal) }))
    .sort((a, b) => a.depth - b.depth);
  const rigid = params.targetToReference ?? IDENTITY_RIGID;
  const center = params.centerMm ?? referenceSlice.ippMm;
  const rotation = mat3FromEulerXYZ(rigid.rx, rigid.ry, rigid.rz);
  const firstDepth = ordered[0]!.depth;
  const lastDepth = ordered[ordered.length - 1]!.depth;
  const pixels = new Float32Array(referenceSlice.dsRows * referenceSlice.dsCols);
  let valid = 0;

  for (let row = 0; row < referenceSlice.dsRows; row++) {
    assertNotAborted(signal);
    for (let col = 0; col < referenceSlice.dsCols; col++) {
      const referencePoint = pixelToWorld(referenceSlice, row, col);
      const targetPoint = inverseRigidPoint(referencePoint, rigid, center, rotation);
      const depth = dot(targetPoint, normal);
      if (depth < firstDepth - COORDINATE_EPSILON_MM || depth > lastDepth + COORDINATE_EPSILON_MM) continue;

      let lo = 0;
      let hi = ordered.length - 1;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (ordered[mid]!.depth < depth) lo = mid + 1;
        else hi = mid;
      }
      const upper = ordered[lo]!;
      const lower = ordered[Math.max(0, lo - 1)]!;
      const upperValue = sampleSliceBilinear(upper.slice, targetPoint);
      const lowerValue = sampleSliceBilinear(lower.slice, targetPoint);
      const separation = upper.depth - lower.depth;
      const fraction = separation > COORDINATE_EPSILON_MM ? (depth - lower.depth) / separation : 0;

      if (upperValue == null && lowerValue == null) continue;
      if (upperValue == null && fraction > COORDINATE_EPSILON_MM) continue;
      if (lowerValue == null && fraction < 1 - COORDINATE_EPSILON_MM) continue;
      const a = lowerValue ?? upperValue ?? 0;
      const b = upperValue ?? lowerValue ?? 0;
      pixels[row * referenceSlice.dsCols + col] = a * (1 - fraction) + b * fraction;
      valid++;
    }
  }

  return {
    pixels,
    rows: referenceSlice.dsRows,
    cols: referenceSlice.dsCols,
    coverage: valid / Math.max(1, pixels.length),
  };
}

function failure(reason: LongitudinalRegistrationFailure['reason'], message: string): LongitudinalRegistrationFailure {
  return { ok: false, reason, message };
}

export function resliceDenseLongitudinalPlane(
  options: DenseLongitudinalResliceOptions,
): DenseLongitudinalResliceResult | LongitudinalRegistrationFailure {
  try {
    assertNotAborted(options.signal);
    if (options.targetSlices.length < 2) {
      return failure(
        'insufficient-samples',
        'A native-fidelity reference plane requires adjacent acquired target slices',
      );
    }
    const result = resliceStackToReferencePlane({
      targetSlices: options.targetSlices,
      referenceSlice: options.referencePlane,
      targetToReference: options.targetToReference,
      centerMm: options.centerMm,
      signal: options.signal,
    });
    if (result.coverage < Math.max(0.1, Math.min(1, options.minCoverage ?? 0.55))) {
      return failure('insufficient-coverage', 'The native target slices do not cover the registered reference plane');
    }
    return { ok: true, ...result };
  } catch (error) {
    if (options.signal?.aborted) return failure('cancelled', 'Longitudinal registration cancelled');
    return failure('registration-failed', error instanceof Error ? error.message : String(error));
  }
}

export async function registerAndResliceLongitudinal(
  options: RegisterLongitudinalOptions,
): Promise<LongitudinalRegistrationResult | LongitudinalRegistrationFailure> {
  try {
    assertNotAborted(options.signal);
    const referenceError = validateStack(options.referenceSlices, 'Reference stack');
    const targetError = validateStack(options.targetSlices, 'Target stack');
    if (referenceError || targetError) return failure('invalid-geometry', referenceError ?? targetError!);
    const referenceSlice = options.referenceSlices[options.referenceSliceIndex];
    const targetFirst = options.targetSlices[0];
    if (!referenceSlice || !targetFirst || !Number.isInteger(options.referenceSliceIndex)) {
      return failure('invalid-geometry', 'Reference slice index is outside the available stack');
    }
    if (
      options.referenceExclusionMask &&
      options.referenceExclusionMask.length !== referenceSlice.dsRows * referenceSlice.dsCols
    ) {
      return failure('invalid-geometry', 'Reference exclusion mask dimensions do not match the selected frame');
    }

    const maxDimension = Math.max(16, Math.min(160, Math.round(options.maxDimension ?? 96)));
    const maxSamples = Math.max(256, Math.min(50_000, Math.round(options.maxSamples ?? 15_000)));
    const minimumCoverage = Math.max(0.1, Math.min(1, options.minCoverage ?? 0.55));
    const referencePrepared = prepareScoringSlices(options.referenceSlices, maxDimension);
    const targetPrepared = prepareScoringSlices(options.targetSlices, maxDimension);
    if (options.referenceExclusionMask) {
      maskReferenceAnatomy(referencePrepared, referenceSlice, options.referenceExclusionMask);
    }
    const referenceIntensityVariance = sampledIntensityVariance(referencePrepared);
    const targetIntensityVariance = sampledIntensityVariance(targetPrepared);
    if (referenceIntensityVariance <= Number.EPSILON || targetIntensityVariance <= Number.EPSILON) {
      return failure(
        'insufficient-evidence',
        'Reference and target must each contain measurable anatomical intensity variation',
      );
    }
    assertNotAborted(options.signal);

    const referenceBounds = stackBounds(referencePrepared);
    const targetBounds = stackBounds(targetPrepared);
    const centerMm = boundsCenterMm(referenceBounds);
    const targetCenter = boundsCenterMm(targetBounds);
    const referenceSpacing = Math.min(referenceSlice.rowSpacingDsMm, referenceSlice.colSpacingDsMm);
    const grid = boundedGrid(referenceBounds, referenceSpacing, maxDimension);
    const occupancy = new Uint8Array(grid.dims.nx * grid.dims.ny * grid.dims.nz);
    const reconstructionOptions = {
      iterations: 0,
      stepSize: 0,
      clampOutput: true,
      psfMode: 'box' as const,
      robustLoss: 'none' as const,
      robustDelta: 0.1,
      laplacianWeight: 0,
    };
    const volume = await reconstructVolumeFromSlices({
      slices: referencePrepared,
      grid,
      occupancy,
      options: reconstructionOptions,
      hooks: { signal: options.signal, yieldToMain },
    });
    const samples = buildSeriesSamples({
      slices: targetPrepared,
      roiBounds: targetBounds,
      maxSamples,
      signal: options.signal,
    });
    const referenceSamples = buildSeriesSamples({
      slices: referencePrepared,
      roiBounds: referenceBounds,
      maxSamples,
      signal: options.signal,
    });
    if (samples.count < 64 || referenceSamples.count < 64) {
      return failure(
        'insufficient-samples',
        'Too little stable anatomy is available for bidirectional 3D registration',
      );
    }
    const targetGrid = boundedGrid(targetBounds, referenceSpacing, maxDimension);
    const targetOccupancy = new Uint8Array(targetGrid.dims.nx * targetGrid.dims.ny * targetGrid.dims.nz);
    const targetVolume = await reconstructVolumeFromSlices({
      slices: targetPrepared,
      grid: targetGrid,
      occupancy: targetOccupancy,
      options: reconstructionOptions,
      hooks: { signal: options.signal, yieldToMain },
    });
    const minimumSamples = Math.min(
      512,
      Math.max(32, Math.floor(Math.min(samples.count, referenceSamples.count) * 0.1)),
    );

    const referenceFrame = referenceSlice.frameOfReferenceUid;
    const targetFrame = targetFirst.frameOfReferenceUid;
    const frameRelationship =
      referenceFrame && targetFrame ? (referenceFrame === targetFrame ? 'same' : 'different') : 'unverified';
    const angleDifferenceDeg =
      (Math.acos(Math.max(-1, Math.min(1, Math.abs(dot(referenceSlice.normalDir, targetFirst.normalDir))))) * 180) /
      Math.PI;

    const candidates: RigidParams[] = [];
    if (options.initialTargetToReference) candidates.push({ ...options.initialTargetToReference });
    candidates.push({ ...IDENTITY_RIGID });
    if (frameRelationship !== 'same') {
      const centered = alignCenters(targetCenter, centerMm, mat3FromEulerXYZ(0, 0, 0));
      candidates.push({ ...IDENTITY_RIGID, tx: centered.x, ty: centered.y, tz: centered.z });
      const rotation = axesRotation(targetFirst, referenceSlice);
      const angles = eulerFromRotation(rotation);
      const rotatedCenter = alignCenters(targetCenter, centerMm, rotation);
      candidates.push({ ...angles, tx: rotatedCenter.x, ty: rotatedCenter.y, tz: rotatedCenter.z });
    }

    const common = {
      samples,
      refVolume: volume,
      dims: grid.dims,
      originMm: grid.originMm,
      voxelSizeMm: grid.voxelSizeMm,
      centerMm,
      occupancy,
      minimumCoverage,
      minimumSamples,
    };
    const reverse = {
      samples: referenceSamples,
      refVolume: targetVolume,
      dims: targetGrid.dims,
      originMm: targetGrid.originMm,
      voxelSizeMm: targetGrid.voxelSizeMm,
      occupancy: targetOccupancy,
    };
    const scoredSeeds = candidates.map((rigid) => ({
      rigid,
      evidence: scoreBidirectionalNcc({ ...common, rigid, reverse }),
    }));
    let initialCandidate = scoredSeeds[0]!;
    for (const candidate of scoredSeeds.slice(1)) {
      if (candidate.evidence.ncc > initialCandidate.evidence.ncc) initialCandidate = candidate;
    }
    const initial = initialCandidate.rigid;
    const initialScore = initialCandidate.evidence;
    if (!Number.isFinite(initialScore.ncc)) {
      return failure('insufficient-coverage', 'No physically justified initial pose retains enough supported anatomy');
    }

    const maxTranslationMm = Math.max(20, Math.abs(initial.tx), Math.abs(initial.ty), Math.abs(initial.tz)) + 20;
    const maxRotationRad =
      Math.max((10 * Math.PI) / 180, Math.abs(initial.rx), Math.abs(initial.ry), Math.abs(initial.rz)) +
      (10 * Math.PI) / 180;
    const optimized = await optimizeRigidNcc({
      ...common,
      signal: options.signal,
      initial,
      maxTranslationMm,
      maxRotationRad,
      reverse,
    });
    const finalScore = scoreBidirectionalNcc({ ...common, rigid: optimized.best, reverse });
    if (!Number.isFinite(finalScore.ncc)) {
      return failure('insufficient-coverage', 'Rigid optimization lost supported anatomical overlap');
    }
    const rawScore = Math.min(finalScore.forward.rawNcc, finalScore.reverse.rawNcc);
    if (rawScore <= 0 || finalScore.ncc <= 0) {
      return failure(
        'insufficient-evidence',
        'The registered anatomy does not have positive structural agreement in both directions',
      );
    }

    const distinctSeedScores = scoredSeeds
      .filter(
        ({ rigid, evidence }) =>
          Number.isFinite(evidence.ncc) &&
          maximumPoseDisplacementMm(rigid, optimized.best, targetBounds, centerMm) >= grid.voxelSizeMm,
      )
      .map(({ evidence }) => evidence.ncc);
    const bestAlternativeScore = Math.max(0, ...distinctSeedScores);
    const scoreMargin = finalScore.ncc - bestAlternativeScore;
    // This is only a numerical distinguishability floor under an optimistic
    // independent-sample assumption; it is not calibrated clinical confidence.
    const minimumDistinguishableScoreMargin = Math.max(
      1e-4,
      (1 - Math.min(1, rawScore) ** 2) / Math.sqrt(Math.max(1, finalScore.used - 3)),
    );
    if (bestAlternativeScore > 0 && scoreMargin <= minimumDistinguishableScoreMargin) {
      return failure(
        'ambiguous',
        'Materially different rigid poses have statistically indistinguishable supported anatomical evidence',
      );
    }

    const resliced = resliceStackToReferencePlane({
      targetSlices: options.targetSlices,
      referenceSlice,
      targetToReference: optimized.best,
      centerMm,
      signal: options.signal,
    });
    if (resliced.coverage < minimumCoverage) {
      return failure('insufficient-coverage', 'The requested reference plane is outside the supported target volume');
    }

    return {
      ok: true,
      ...resliced,
      targetToReference: optimized.best,
      centerMm,
      score: finalScore.ncc,
      diagnostics: {
        rawScore,
        retainedSampleFraction: finalScore.forward.coverage,
        reverseRetainedSampleFraction: finalScore.reverse.coverage,
        sampledTargetCount: samples.count,
        evaluatedCandidates: candidates.length + optimized.evals,
        referenceVoxelSizeMm: grid.voxelSizeMm,
        angleDifferenceDeg,
        scoreMargin,
        minimumDistinguishableScoreMargin,
        inverseScoreGap: Math.abs(finalScore.forward.rawNcc - finalScore.reverse.rawNcc),
        referenceIntensityVariance,
        targetIntensityVariance,
      },
      provenance: {
        referenceFrameOfReferenceUid: referenceFrame,
        targetFrameOfReferenceUid: targetFrame,
        frameRelationship,
        referenceSliceIndex: options.referenceSliceIndex,
      },
    };
  } catch (error) {
    if (options.signal?.aborted) return failure('cancelled', 'Longitudinal registration cancelled');
    return failure('registration-failed', error instanceof Error ? error.message : String(error));
  }
}

export { applyRigidToPoint };
