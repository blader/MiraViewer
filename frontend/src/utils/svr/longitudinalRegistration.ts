import { outputGridPixelToWorld, validateOutputPlaneGrid, type OutputPlaneGrid } from '../outputPlaneGrid';
import { sliceCornersMm } from './dicomGeometry';
import { resample2dAreaAverageWithValidity } from './resample2d';
import {
  applyRigidToPoint,
  boundsCenterMm,
  buildSeriesSamples,
  invertRigidParams,
  mat3FromEulerXYZ,
  mat3MulVec3,
  optimizeRigidNcc,
  scoreBidirectionalNcc,
  type BoundsMm,
  type Mat3,
  type RigidParams,
  type SeriesSamples,
} from './rigidRegistration';
import {
  reconstructVolumeFromSlices,
  type SvrReconstructionGrid,
  type SvrReconstructionSlice,
} from './reconstructionCore';
import { boundsCornersMm } from './sliceRoiCrop';
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

type LongitudinalReslicedPlane = {
  pixels: Float32Array;
  /** Actual valid acquired support on the selected output lattice. */
  valid: Uint8Array;
  rows: number;
  cols: number;
  coverage: number;
  outputGrid?: OutputPlaneGrid;
  contributingSourceSopInstanceUids?: string[];
};

export type LongitudinalRegistrationResult = LongitudinalReslicedPlane & {
  ok: true;
  nativeRefinement?: NativeRefinementDiagnostics;
  /** Bounded physically distinct coarse hypotheses; only native anatomy may adjudicate them. */
  nativeCandidatePoses?: RigidParams[];
  targetToReference: RigidParams;
  /** All rigid parameters rotate around this reference-frame patient-space center. */
  centerMm: Vec3;
  score: number;
  diagnostics: {
    rawScore: number;
    retainedSampleFraction: number;
    reverseRetainedSampleFraction: number;
    sampledTargetCount: number;
    effectiveSampleCount: number;
    evaluatedCandidates: number;
    optimizedHypothesisCount: number;
    optimizedAlternativeCount: number;
    referenceVoxelSizeMm: number;
    angleDifferenceDeg: number;
    /** Fixed-domain NCC advantage over the best materially distinct supported seed. */
    scoreMargin: number;
    /** Optimistic independent-sample Pearson standard error, not a clinical probability. */
    minimumDistinguishableScoreMargin: number;
    /** Absolute forward/reverse Pearson disagreement over occupied anatomical support. */
    inverseScoreGap: number;
    /** Landmark-scale displacement after an independently optimized reverse transform. */
    inverseConsistencyErrorMm?: number;
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
  outputGrid?: OutputPlaneGrid;
  /** Internal coarse result only: a mandatory native dense pass must validate presentation. */
  deferPresentationValidation?: boolean;
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
  outputGrid?: OutputPlaneGrid;
  /** Freshly decoded, bounded native reference slab; never a transferred coarse stack. */
  nativeReferenceSlices?: readonly SvrReconstructionSlice[];
  nativeReferenceSliceIndex?: number;
  referenceExclusionMask?: Uint8Array;
  nativeCandidatePoses?: readonly RigidParams[];
  minCoverage?: number;
  signal?: AbortSignal;
};

export type DenseLongitudinalResliceResult = LongitudinalReslicedPlane & {
  ok: true;
  targetToReference?: RigidParams;
  nativeRefinement?: NativeRefinementDiagnostics;
};

export type NativeRefinementDiagnostics = {
  score: number;
  heldOutScore: number;
  heldOutForwardScore: number;
  heldOutReverseScore: number;
  rawScore: number;
  forwardRawScore: number;
  reverseRawScore: number;
  forwardCoverage: number;
  reverseCoverage: number;
  sampleCount: number;
  heldOutSampleCount: number;
  effectiveIndependentSamples: number;
  heldOutEffectiveIndependentSamples: number;
  translationStepMm: number;
  rotationStepRadians: number;
  evaluations: number;
  optimizedHypothesisCount?: number;
  optimizedAlternativeCount?: number;
  scoreMargin?: number;
  minimumDistinguishableScoreMargin?: number;
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
      (slice.valid !== undefined && slice.valid.length !== slice.pixels.length) ||
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

function maximumPoseDisplacementMm(first: RigidParams, second: RigidParams, bounds: BoundsMm, centerMm: Vec3): number {
  const firstRotation = mat3FromEulerXYZ(first.rx, first.ry, first.rz);
  const secondRotation = mat3FromEulerXYZ(second.rx, second.ry, second.rz);
  let maximum = 0;

  for (const point of boundsCornersMm(bounds)) {
    const firstPoint = applyRigidToPoint(point, centerMm, firstRotation, v3(first.tx, first.ty, first.tz));
    const secondPoint = applyRigidToPoint(point, centerMm, secondRotation, v3(second.tx, second.ty, second.tz));
    maximum = Math.max(
      maximum,
      Math.hypot(firstPoint.x - secondPoint.x, firstPoint.y - secondPoint.y, firstPoint.z - secondPoint.z),
    );
  }

  return maximum;
}

function prepareScoringSlices(
  slices: readonly SvrReconstructionSlice[],
  maxDimension: number,
): SvrReconstructionSlice[] {
  return slices.map((slice) => {
    const scale = Math.min(1, maxDimension / Math.max(slice.dsRows, slice.dsCols));
    const rows = Math.max(2, Math.round(slice.dsRows * scale));
    const cols = Math.max(2, Math.round(slice.dsCols * scale));
    const rowScale = slice.dsRows / rows;
    const colScale = slice.dsCols / cols;
    const rowOffsetMm = ((rowScale - 1) * slice.rowSpacingDsMm) / 2;
    const colOffsetMm = ((colScale - 1) * slice.colSpacingDsMm) / 2;
    const { pixels, validity } = resample2dAreaAverageWithValidity(
      slice.pixels,
      slice.valid ?? new Uint8Array(slice.pixels.length).fill(1),
      slice.dsRows,
      slice.dsCols,
      rows,
      cols,
    );
    const valid = new Uint8Array(pixels.length);
    for (let index = 0; index < pixels.length; index++) {
      if (validity[index]! >= 1 - 1e-6) valid[index] = 1;
      else pixels[index] = 0;
    }

    return {
      ...slice,
      pixels,
      valid,
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
}

function normalizeScoringSlices(slices: readonly SvrReconstructionSlice[]): number {
  const sample: number[] = [];
  const totalPixels = slices.reduce((sum, slice) => sum + slice.pixels.length, 0);
  const stride = Math.max(1, Math.floor(totalPixels / 20_000));
  let index = 0;
  for (const slice of slices) {
    for (let pixel = 0; pixel < slice.pixels.length; pixel++) {
      const value = slice.pixels[pixel]!;
      if (index++ % stride === 0 && (!slice.valid || slice.valid[pixel]) && Number.isFinite(value)) {
        sample.push(value);
      }
    }
  }
  sample.sort((a, b) => a - b);
  const lo = sample[Math.floor((sample.length - 1) * 0.01)] ?? 0;
  const hi = sample[Math.floor((sample.length - 1) * 0.99)] ?? lo;
  const inverseRange = hi > lo + 1e-9 ? 1 / (hi - lo) : 0;
  index = 0;
  let count = 0;
  let mean = 0;
  let squaredDeviation = 0;
  for (const slice of slices) {
    for (let pixel = 0; pixel < slice.pixels.length; pixel++) {
      if (slice.valid && !slice.valid[pixel]) {
        index++;
        continue;
      }
      const normalized = ((slice.pixels[pixel] ?? lo) - lo) * inverseRange;
      slice.pixels[pixel] = Math.max(0, Math.min(1, normalized));
      const value = slice.pixels[pixel]!;
      if (index++ % stride !== 0 || !Number.isFinite(value)) continue;
      count++;
      const delta = value - mean;
      mean += delta / count;
      squaredDeviation += delta * (value - mean);
    }
  }
  return count > 1 ? squaredDeviation / count : 0;
}

function maskReferenceAnatomy(
  slices: SvrReconstructionSlice[],
  selectedReference: SvrReconstructionSlice,
  mask: Uint8Array,
  targetToReference: RigidParams = IDENTITY_RIGID,
  centerMm: Vec3 = selectedReference.ippMm,
): void {
  const rotation = mat3FromEulerXYZ(targetToReference.rx, targetToReference.ry, targetToReference.rz);
  const translation = v3(targetToReference.tx, targetToReference.ty, targetToReference.tz);
  for (const slice of slices) {
    slice.valid ??= new Uint8Array(slice.pixels.length).fill(1);
    for (let r = 0; r < slice.dsRows; r++) {
      for (let c = 0; c < slice.dsCols; c++) {
        const point = applyRigidToPoint(pixelToWorld(slice, r, c), centerMm, rotation, translation);
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
          slice.valid[r * slice.dsCols + c] = 0;
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
    rawRow < -0.5 - COORDINATE_EPSILON_MM ||
    rawCol < -0.5 - COORDINATE_EPSILON_MM ||
    rawRow > slice.dsRows - 0.5 + COORDINATE_EPSILON_MM ||
    rawCol > slice.dsCols - 0.5 + COORDINATE_EPSILON_MM
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
  let value = 0;
  for (let rowOffset = 0; rowOffset < 2; rowOffset++) {
    const sourceRow = rowOffset ? r1 : r0;
    const rowWeight = rowOffset ? fr : 1 - fr;
    for (let colOffset = 0; colOffset < 2; colOffset++) {
      const weight = rowWeight * (colOffset ? fc : 1 - fc);
      if (weight <= Number.EPSILON) continue;
      const index = sourceRow * slice.dsCols + (colOffset ? c1 : c0);
      const pixel = slice.pixels[index];
      if ((slice.valid && !slice.valid[index]) || pixel === undefined || !Number.isFinite(pixel)) return null;
      value += pixel * weight;
    }
  }
  return value;
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

type NativeSliceStack = {
  normal: Vec3;
  ordered: Array<{ slice: SvrReconstructionSlice; depth: number }>;
  expectedSpacing: number;
};

type NativeSliceSample = {
  value: number;
  lower?: SvrReconstructionSlice;
  upper?: SvrReconstructionSlice;
};

function prepareNativeSliceStack(slices: readonly SvrReconstructionSlice[]): NativeSliceStack {
  const first = slices[0];
  if (!first) throw new Error('Cannot sample an empty acquired slice stack');
  const normal = first.normalDir;
  const ordered = slices.map((slice) => ({ slice, depth: dot(slice.ippMm, normal) })).sort((a, b) => a.depth - b.depth);
  const separations: number[] = [];
  for (let index = 1; index < ordered.length; index++) {
    const separation = ordered[index]!.depth - ordered[index - 1]!.depth;
    if (separation > COORDINATE_EPSILON_MM) separations.push(separation);
  }
  separations.sort((a, b) => a - b);
  return {
    normal,
    ordered,
    expectedSpacing: separations.length > 0 ? separations[Math.floor(separations.length / 2)]! : 0,
  };
}

function sampleNativeSliceStack(stack: NativeSliceStack, point: Vec3): NativeSliceSample | null {
  const { ordered, expectedSpacing } = stack;
  const depth = dot(point, stack.normal);
  const first = ordered[0]!;
  const last = ordered[ordered.length - 1]!;
  const terminal =
    depth < first.depth - COORDINATE_EPSILON_MM ? first : depth > last.depth + COORDINATE_EPSILON_MM ? last : undefined;
  if (terminal) {
    const halfThickness = Math.max(
      0,
      (terminal.slice.sliceThicknessMm ?? terminal.slice.spacingBetweenSlicesMm ?? expectedSpacing) / 2,
    );
    if (Math.abs(depth - terminal.depth) > halfThickness + COORDINATE_EPSILON_MM) return null;
    const value = sampleSliceBilinear(terminal.slice, point);
    if (value === null) return null;
    return terminal === first ? { value, lower: terminal.slice } : { value, upper: terminal.slice };
  }

  let lo = 0;
  let hi = ordered.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (ordered[mid]!.depth < depth) lo = mid + 1;
    else hi = mid;
  }
  const upper = ordered[lo]!;
  const lower = ordered[Math.max(0, lo - 1)]!;
  const upperValue = sampleSliceBilinear(upper.slice, point);
  const lowerValue = sampleSliceBilinear(lower.slice, point);
  const separation = upper.depth - lower.depth;
  const fraction = separation > COORDINATE_EPSILON_MM ? (depth - lower.depth) / separation : 0;
  const lowerHalfThickness = Math.max(
    0,
    (lower.slice.sliceThicknessMm ?? lower.slice.spacingBetweenSlicesMm ?? expectedSpacing) / 2,
  );
  const upperHalfThickness = Math.max(
    0,
    (upper.slice.sliceThicknessMm ?? upper.slice.spacingBetweenSlicesMm ?? expectedSpacing) / 2,
  );
  const continuousSupport =
    separation <= COORDINATE_EPSILON_MM ||
    lowerHalfThickness + upperHalfThickness + COORDINATE_EPSILON_MM >= separation;
  const lowerSupported = depth <= lower.depth + lowerHalfThickness + COORDINATE_EPSILON_MM;
  const upperSupported = depth >= upper.depth - upperHalfThickness - COORDINATE_EPSILON_MM;
  if (!continuousSupport && !lowerSupported && !upperSupported) return null;

  if (!continuousSupport) {
    if (lowerSupported && lowerValue !== null && (!upperSupported || upperValue === null)) {
      return { value: lowerValue, lower: lower.slice };
    }
    if (upperSupported && upperValue !== null) return { value: upperValue, upper: upper.slice };
    return null;
  }

  const useLower = fraction < 1 - COORDINATE_EPSILON_MM;
  const useUpper = fraction > COORDINATE_EPSILON_MM;
  if ((useLower && lowerValue === null) || (useUpper && upperValue === null)) return null;
  if (!useLower && upperValue === null && lowerValue === null) return null;
  return {
    value: (lowerValue ?? upperValue ?? 0) * (1 - fraction) + (upperValue ?? lowerValue ?? 0) * fraction,
    ...(useLower || !useUpper ? { lower: lower.slice } : {}),
    ...(useUpper ? { upper: upper.slice } : {}),
  };
}

export function resliceStackToReferencePlane(params: {
  targetSlices: readonly SvrReconstructionSlice[];
  referenceSlice: LongitudinalReferencePlane;
  outputGrid?: OutputPlaneGrid;
  targetToReference?: RigidParams;
  centerMm?: Vec3;
  signal?: AbortSignal;
}): LongitudinalReslicedPlane {
  const { targetSlices, referenceSlice, outputGrid, signal } = params;
  if (outputGrid) validateOutputPlaneGrid(outputGrid);
  const targetStack = prepareNativeSliceStack(targetSlices);
  const rigid = params.targetToReference ?? IDENTITY_RIGID;
  const center = params.centerMm ?? referenceSlice.ippMm;
  const rotation = mat3FromEulerXYZ(rigid.rx, rigid.ry, rigid.rz);
  const source = targetSlices[0]!;
  const outputRowSpacing = outputGrid?.rowSpacingMm ?? referenceSlice.rowSpacingDsMm;
  const outputColSpacing = outputGrid?.columnSpacingMm ?? referenceSlice.colSpacingDsMm;
  const outputRowDirection = outputGrid ? v3(...outputGrid.columnDirection) : referenceSlice.colDir;
  const outputColDirection = outputGrid ? v3(...outputGrid.rowDirection) : referenceSlice.rowDir;
  const acquiredSpacingAlong = (direction: Vec3): number =>
    Math.min(
      source.rowSpacingDsMm / Math.max(1e-6, Math.abs(dot(source.colDir, direction))),
      source.colSpacingDsMm / Math.max(1e-6, Math.abs(dot(source.rowDir, direction))),
    );
  const rowSampleCount = Math.min(
    4,
    Math.max(1, Math.ceil(outputRowSpacing / acquiredSpacingAlong(outputRowDirection) - 1e-6)),
  );
  const colSampleCount = Math.min(
    4,
    Math.max(1, Math.ceil(outputColSpacing / acquiredSpacingAlong(outputColDirection) - 1e-6)),
  );
  const rows = outputGrid?.rows ?? referenceSlice.dsRows;
  const cols = outputGrid?.columns ?? referenceSlice.dsCols;
  const pixels = new Float32Array(rows * cols);
  const valid = new Uint8Array(pixels.length);
  const contributingSourceSopInstanceUids = new Set<string>();
  const contributingSamples: NativeSliceSample[] = [];
  let supported = 0;

  for (let row = 0; row < rows; row++) {
    assertNotAborted(signal);
    for (let col = 0; col < cols; col++) {
      const referencePoint = outputGrid
        ? outputGridPixelToWorld(outputGrid, row, col)
        : pixelToWorld(referenceSlice, row, col);
      let value = 0;
      let sampleCount = 0;
      contributingSamples.length = 0;
      for (let sourceRow = 0; sourceRow < rowSampleCount; sourceRow++) {
        const rowOffset = ((sourceRow + 0.5) / rowSampleCount - 0.5) * outputRowSpacing;
        for (let sourceCol = 0; sourceCol < colSampleCount; sourceCol++) {
          const colOffset = ((sourceCol + 0.5) / colSampleCount - 0.5) * outputColSpacing;
          const footprintPoint = v3(
            referencePoint.x + outputRowDirection.x * rowOffset + outputColDirection.x * colOffset,
            referencePoint.y + outputRowDirection.y * rowOffset + outputColDirection.y * colOffset,
            referencePoint.z + outputRowDirection.z * rowOffset + outputColDirection.z * colOffset,
          );
          const targetPoint = inverseRigidPoint(footprintPoint, rigid, center, rotation);
          const sample = sampleNativeSliceStack(targetStack, targetPoint);
          if (!sample) {
            sampleCount = -1;
            break;
          }
          value += sample.value;
          sampleCount++;
          contributingSamples.push(sample);
        }
        if (sampleCount < 0) break;
      }
      if (sampleCount <= 0) continue;
      const index = row * cols + col;
      pixels[index] = value / sampleCount;
      valid[index] = 1;
      supported++;
      for (const sample of contributingSamples) {
        if (sample.lower?.sopInstanceUid) contributingSourceSopInstanceUids.add(sample.lower.sopInstanceUid);
        if (sample.upper?.sopInstanceUid) contributingSourceSopInstanceUids.add(sample.upper.sopInstanceUid);
      }
    }
  }

  return {
    pixels,
    valid,
    rows,
    cols,
    coverage: supported / Math.max(1, pixels.length),
    ...(outputGrid ? { outputGrid } : {}),
    ...(contributingSourceSopInstanceUids.size > 0
      ? { contributingSourceSopInstanceUids: [...contributingSourceSopInstanceUids] }
      : {}),
  };
}

function failure(reason: LongitudinalRegistrationFailure['reason'], message: string): LongitudinalRegistrationFailure {
  return { ok: false, reason, message };
}

function nativePointIsExcluded(point: Vec3, reference: SvrReconstructionSlice, mask?: Uint8Array): boolean {
  if (!mask) return false;
  const delta = v3(point.x - reference.ippMm.x, point.y - reference.ippMm.y, point.z - reference.ippMm.z);
  const row = dot(delta, reference.colDir) / reference.rowSpacingDsMm;
  const col = dot(delta, reference.rowDir) / reference.colSpacingDsMm;
  const firstRow = Math.max(0, Math.floor(row - 1));
  const lastRow = Math.min(reference.dsRows - 1, Math.ceil(row + 1));
  const firstCol = Math.max(0, Math.floor(col - 1));
  const lastCol = Math.min(reference.dsCols - 1, Math.ceil(col + 1));
  for (let sourceRow = firstRow; sourceRow <= lastRow; sourceRow++) {
    for (let sourceCol = firstCol; sourceCol <= lastCol; sourceCol++) {
      if (mask[sourceRow * reference.dsCols + sourceCol]) return true;
    }
  }
  return false;
}

type NativeRefinementSamples = SeriesSamples & {
  spatialFolds: Uint8Array;
  spatialBlockIds: Uint32Array;
};

function buildNativeRefinementSamples(params: {
  slices: readonly SvrReconstructionSlice[];
  selectedReference: SvrReconstructionSlice;
  referenceStack?: NativeSliceStack;
  initialTargetToReference?: RigidParams;
  centerMm: Vec3;
  exclusionMask?: Uint8Array;
  signal?: AbortSignal;
  maxSamples?: number;
}): NativeRefinementSamples {
  const maxSamples = Math.max(256, Math.min(32_768, params.maxSamples ?? 4096));
  const totalPixels = params.slices.reduce((total, slice) => total + slice.pixels.length, 0);
  const stride = Math.max(1, Math.ceil(Math.sqrt(totalPixels / maxSamples)));
  const obs = new Float32Array(maxSamples);
  const pos = new Float32Array(maxSamples * 3);
  const spatialFolds = new Uint8Array(maxSamples);
  const spatialBlockIds = new Uint32Array(maxSamples);
  const spatialBlocks = new Map<string, number>();
  const rigid = params.initialTargetToReference ?? IDENTITY_RIGID;
  const rotation = mat3FromEulerXYZ(rigid.rx, rigid.ry, rigid.rz);
  const translation = v3(rigid.tx, rigid.ty, rigid.tz);
  let count = 0;

  sampling: for (const slice of params.slices) {
    assertNotAborted(params.signal);
    for (let row = 0; row < slice.dsRows; row += stride) {
      for (let col = 0; col < slice.dsCols; col += stride) {
        const index = row * slice.dsCols + col;
        const value = slice.pixels[index];
        if ((slice.valid && !slice.valid[index]) || value === undefined || !Number.isFinite(value)) continue;
        const sourcePoint = pixelToWorld(slice, row, col);
        const referencePoint = params.initialTargetToReference
          ? applyRigidToPoint(sourcePoint, params.centerMm, rotation, translation)
          : sourcePoint;
        const referenceDelta = v3(
          referencePoint.x - params.selectedReference.ippMm.x,
          referencePoint.y - params.selectedReference.ippMm.y,
          referencePoint.z - params.selectedReference.ippMm.z,
        );
        const referenceRow =
          dot(referenceDelta, params.selectedReference.colDir) / params.selectedReference.rowSpacingDsMm;
        const referenceCol =
          dot(referenceDelta, params.selectedReference.rowDir) / params.selectedReference.colSpacingDsMm;
        if (
          referenceRow < 1 ||
          referenceCol < 1 ||
          referenceRow > params.selectedReference.dsRows - 2 ||
          referenceCol > params.selectedReference.dsCols - 2
        ) {
          continue;
        }
        if (params.referenceStack && params.referenceStack.ordered.length > 2) {
          const depth = dot(referencePoint, params.referenceStack.normal);
          const firstDepth = params.referenceStack.ordered[0]!.depth;
          const lastDepth = params.referenceStack.ordered[params.referenceStack.ordered.length - 1]!.depth;
          const margin = Math.min(params.referenceStack.expectedSpacing / 2, (lastDepth - firstDepth) / 4);
          if (depth < firstDepth + margin || depth > lastDepth - margin) continue;
        }
        if (nativePointIsExcluded(referencePoint, params.selectedReference, params.exclusionMask)) continue;
        if (params.referenceStack && !sampleNativeSliceStack(params.referenceStack, referencePoint)) continue;
        const rowBlock = Math.floor(referenceRow / Math.max(2, Math.ceil(1 / params.selectedReference.rowSpacingDsMm)));
        const colBlock = Math.floor(referenceCol / Math.max(2, Math.ceil(1 / params.selectedReference.colSpacingDsMm)));
        const depthSpacing = Math.max(
          1e-6,
          params.selectedReference.sliceThicknessMm ??
            params.selectedReference.spacingBetweenSlicesMm ??
            params.referenceStack?.expectedSpacing ??
            1,
        );
        const depthBlock = Math.floor(dot(referenceDelta, params.selectedReference.normalDir) / depthSpacing);
        const fold = (((rowBlock + colBlock + depthBlock) % 2) + 2) % 2;
        const block = `${rowBlock}:${colBlock}:${depthBlock}`;
        let blockId = spatialBlocks.get(block);
        if (blockId === undefined) {
          blockId = spatialBlocks.size;
          spatialBlocks.set(block, blockId);
        }
        spatialFolds[count] = fold;
        spatialBlockIds[count] = blockId;
        obs[count] = value;
        pos[count * 3] = sourcePoint.x;
        pos[count * 3 + 1] = sourcePoint.y;
        pos[count * 3 + 2] = sourcePoint.z;
        if (++count >= maxSamples) break sampling;
      }
    }
  }
  return {
    obs: obs.subarray(0, count),
    pos: pos.subarray(0, count * 3),
    count,
    spatialFolds: spatialFolds.subarray(0, count),
    spatialBlockIds: spatialBlockIds.subarray(0, count),
  };
}

type NativeDirectionEvidence = {
  score: number;
  rawScore: number;
  coverage: number;
  used: number;
  supportedIndependentBlocks?: number;
};

function scoreNativeRefinementDirection(params: {
  samples: NativeRefinementSamples;
  destination: NativeSliceStack;
  rigid: RigidParams;
  centerMm: Vec3;
  selectedReference: SvrReconstructionSlice;
  exclusionMask?: Uint8Array;
  reverse: boolean;
  minimumCoverage: number;
  parity?: 0 | 1;
  trackSupportedBlocks?: boolean;
}): NativeDirectionEvidence {
  const rotation = mat3FromEulerXYZ(params.rigid.rx, params.rigid.ry, params.rigid.rz);
  const translation = v3(params.rigid.tx, params.rigid.ty, params.rigid.tz);
  let sumA = 0;
  let sumB = 0;
  let sumAA = 0;
  let sumBB = 0;
  let sumAB = 0;
  let eligible = 0;
  let used = 0;
  const supportedBlocks = params.trackSupportedBlocks ? new Set<number>() : undefined;
  for (let index = 0; index < params.samples.count; index++) {
    if (params.parity !== undefined && params.samples.spatialFolds[index] !== params.parity) continue;
    const source = v3(
      params.samples.pos[index * 3]!,
      params.samples.pos[index * 3 + 1]!,
      params.samples.pos[index * 3 + 2]!,
    );
    const mapped = params.reverse
      ? applyRigidToPoint(source, params.centerMm, rotation, translation)
      : inverseRigidPoint(source, params.rigid, params.centerMm, rotation);
    const referencePoint = params.reverse ? mapped : source;
    if (nativePointIsExcluded(referencePoint, params.selectedReference, params.exclusionMask)) continue;
    eligible++;
    const counterpart = sampleNativeSliceStack(params.destination, mapped);
    if (!counterpart) continue;
    const a = params.samples.obs[index]!;
    const b = counterpart.value;
    sumA += a;
    sumB += b;
    sumAA += a * a;
    sumBB += b * b;
    sumAB += a * b;
    supportedBlocks?.add(params.samples.spatialBlockIds[index]!);
    used++;
  }
  const coverage = used / Math.max(1, eligible);
  const minimumSamples = Math.min(64, Math.max(16, Math.floor(eligible / 4)));
  if (used < minimumSamples || coverage < params.minimumCoverage) {
    return { score: Number.NEGATIVE_INFINITY, rawScore: Number.NEGATIVE_INFINITY, coverage, used };
  }
  const inverseCount = 1 / used;
  const varianceA = sumAA - sumA * sumA * inverseCount;
  const varianceB = sumBB - sumB * sumB * inverseCount;
  if (varianceA <= Number.EPSILON * Math.max(1, sumAA) || varianceB <= Number.EPSILON * Math.max(1, sumBB)) {
    return { score: Number.NEGATIVE_INFINITY, rawScore: Number.NEGATIVE_INFINITY, coverage, used };
  }
  const rawScore = (sumAB - sumA * sumB * inverseCount) / Math.sqrt(varianceA * varianceB);
  return {
    score: rawScore * coverage,
    rawScore,
    coverage,
    used,
    ...(supportedBlocks ? { supportedIndependentBlocks: supportedBlocks.size } : {}),
  };
}

function refineNativeLongitudinalPose(
  options: DenseLongitudinalResliceOptions,
): { rigid: RigidParams; diagnostics: NativeRefinementDiagnostics } | LongitudinalRegistrationFailure {
  const referenceSlices = options.nativeReferenceSlices;
  const selectedReference = referenceSlices?.[options.nativeReferenceSliceIndex ?? -1];
  if (!referenceSlices || !selectedReference || referenceSlices.length < 2) {
    return failure('insufficient-samples', 'Native rigid refinement requires a bounded acquired reference slab');
  }
  if (
    options.referenceExclusionMask &&
    options.referenceExclusionMask.length !== selectedReference.dsRows * selectedReference.dsCols
  ) {
    return failure('invalid-geometry', 'Native exclusion support does not match the selected reference frame');
  }
  const targetStack = prepareNativeSliceStack(options.targetSlices);
  const referenceStack = prepareNativeSliceStack(referenceSlices);
  const nativeSampleBudget = (options.nativeCandidatePoses?.length ?? 0) > 1 ? 32_768 : 4096;
  const referenceSamples = buildNativeRefinementSamples({
    slices: referenceSlices,
    selectedReference,
    referenceStack,
    centerMm: options.centerMm,
    exclusionMask: options.referenceExclusionMask,
    signal: options.signal,
    maxSamples: nativeSampleBudget,
  });
  const targetSamples = buildNativeRefinementSamples({
    slices: options.targetSlices,
    selectedReference,
    referenceStack,
    initialTargetToReference: options.targetToReference,
    centerMm: options.centerMm,
    exclusionMask: options.referenceExclusionMask,
    signal: options.signal,
    maxSamples: nativeSampleBudget,
  });
  if (Math.min(referenceSamples.count, targetSamples.count) < 32) {
    return failure('insufficient-samples', 'Too little stable native anatomy remains for independent rigid refinement');
  }
  const minimumCoverage = Math.max(0.1, Math.min(1, options.minCoverage ?? 0.55));
  const evaluate = (rigid: RigidParams, parity?: 0 | 1, trackSupportedBlocks = false) => {
    const shared = {
      rigid,
      centerMm: options.centerMm,
      selectedReference,
      exclusionMask: options.referenceExclusionMask,
      minimumCoverage,
      parity,
      trackSupportedBlocks,
    };
    const forward = scoreNativeRefinementDirection({
      ...shared,
      samples: referenceSamples,
      destination: targetStack,
      reverse: false,
    });
    const reverse = scoreNativeRefinementDirection({
      ...shared,
      samples: targetSamples,
      destination: referenceStack,
      reverse: true,
    });
    return { score: Math.min(forward.score, reverse.score), forward, reverse };
  };

  const initial = options.targetToReference;
  const initialEvidence = evaluate(initial, 0);
  if (!Number.isFinite(initialEvidence.score)) {
    return failure('insufficient-coverage', 'Native stable-anatomy support is insufficient in both directions');
  }
  const initialValidation = evaluate(initial, 1);
  const firstTarget = options.targetSlices[0]!;
  const minimumSpacing = Math.min(
    selectedReference.rowSpacingDsMm,
    selectedReference.colSpacingDsMm,
    firstTarget.rowSpacingDsMm,
    firstTarget.colSpacingDsMm,
  );
  const translationStepMm = Math.max(0.025, Math.min(0.05, minimumSpacing / 4));
  const radiusMm = Math.max(
    minimumSpacing,
    Math.hypot(
      selectedReference.dsRows * selectedReference.rowSpacingDsMm,
      selectedReference.dsCols * selectedReference.colSpacingDsMm,
    ) / 2,
  );
  const rotationStepRadians = Math.max(
    (0.02 * Math.PI) / 180,
    Math.min((0.05 * Math.PI) / 180, translationStepMm / radiusMm),
  );
  const maximumTranslation = Math.min(1, Math.max(0.5, minimumSpacing));
  const maximumRotation = Math.min(Math.PI / 180, Math.max((0.25 * Math.PI) / 180, maximumTranslation / radiusMm));
  const stages = [
    {
      translation: Math.max(translationStepMm, Math.min(0.25, minimumSpacing / 2)),
      rotation: Math.max(rotationStepRadians, maximumRotation / 2),
    },
    {
      translation: Math.max(translationStepMm, Math.min(0.125, minimumSpacing / 4)),
      rotation: Math.max(rotationStepRadians, maximumRotation / 4),
    },
    { translation: translationStepMm, rotation: rotationStepRadians },
  ];
  const current = { ...initial };
  let best = initialEvidence;
  let evaluations = 2;
  const keys: Array<keyof RigidParams> = ['tx', 'ty', 'tz', 'rx', 'ry', 'rz'];
  for (const stage of stages) {
    for (let iteration = 0; iteration < 6; iteration++) {
      assertNotAborted(options.signal);
      let improved = false;
      for (const key of keys) {
        const translational = key[0] === 't';
        const step = translational ? stage.translation : stage.rotation;
        const bound = translational ? maximumTranslation : maximumRotation;
        for (const direction of [-1, 1]) {
          const value = Math.max(initial[key] - bound, Math.min(initial[key] + bound, current[key] + direction * step));
          if (value === current[key]) continue;
          const previous = current[key];
          current[key] = value;
          const evidence = evaluate(current, 0);
          evaluations++;
          if (evidence.score > best.score + 1e-7) {
            best = evidence;
            improved = true;
          } else current[key] = previous;
        }
      }
      if (!improved) break;
    }
  }
  const validation = evaluate(current, 1);
  evaluations++;
  const accepted =
    Number.isFinite(validation.score) && validation.score >= initialValidation.score - 1e-6 ? current : initial;
  const final = evaluate(accepted, undefined, true);
  const heldOut = evaluate(accepted, 1, true);
  evaluations++;
  if (!Number.isFinite(final.score) || Math.min(final.forward.rawScore, final.reverse.rawScore) < 0.2) {
    return failure('insufficient-evidence', 'Native rigid refinement found no reliable stable-anatomy agreement');
  }
  return {
    rigid: { ...accepted },
    diagnostics: {
      score: final.score,
      heldOutScore: heldOut.score,
      heldOutForwardScore: heldOut.forward.score,
      heldOutReverseScore: heldOut.reverse.score,
      rawScore: Math.min(final.forward.rawScore, final.reverse.rawScore),
      forwardRawScore: final.forward.rawScore,
      reverseRawScore: final.reverse.rawScore,
      forwardCoverage: final.forward.coverage,
      reverseCoverage: final.reverse.coverage,
      sampleCount: Math.min(final.forward.used, final.reverse.used),
      heldOutSampleCount: Math.min(heldOut.forward.used, heldOut.reverse.used),
      effectiveIndependentSamples: Math.min(
        final.forward.supportedIndependentBlocks ?? 0,
        final.reverse.supportedIndependentBlocks ?? 0,
        final.forward.used,
        final.reverse.used,
      ),
      heldOutEffectiveIndependentSamples: Math.min(
        heldOut.forward.supportedIndependentBlocks ?? 0,
        heldOut.reverse.supportedIndependentBlocks ?? 0,
        heldOut.forward.used,
        heldOut.reverse.used,
      ),
      translationStepMm,
      rotationStepRadians,
      evaluations,
    },
  };
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
    let targetToReference = options.targetToReference;
    let nativeRefinement: NativeRefinementDiagnostics | undefined;
    if (options.nativeReferenceSlices) {
      const referenceError = validateStack(options.nativeReferenceSlices, 'Native reference slab');
      const targetError = validateStack(options.targetSlices, 'Native target slab');
      if (referenceError || targetError) return failure('invalid-geometry', referenceError ?? targetError!);
      const candidates = options.nativeCandidatePoses?.length
        ? options.nativeCandidatePoses
        : [options.targetToReference];
      if (
        candidates.length > 3 ||
        candidates.some((candidate) =>
          [candidate.tx, candidate.ty, candidate.tz, candidate.rx, candidate.ry, candidate.rz].some(
            (value) => !Number.isFinite(value),
          ),
        )
      ) {
        return failure('invalid-geometry', 'Native rigid refinement received invalid or excessive coarse hypotheses');
      }
      const refinements: Array<{ rigid: RigidParams; diagnostics: NativeRefinementDiagnostics }> = [];
      let firstFailure: LongitudinalRegistrationFailure | undefined;
      for (const candidate of candidates) {
        const refinement = refineNativeLongitudinalPose({ ...options, targetToReference: candidate });
        if ('ok' in refinement) {
          firstFailure ??= refinement;
        } else {
          refinements.push(refinement);
        }
      }
      if (refinements.length === 0) {
        return firstFailure ?? failure('insufficient-evidence', 'No native rigid hypothesis retains stable anatomy');
      }
      refinements.sort((first, second) => second.diagnostics.heldOutScore - first.diagnostics.heldOutScore);
      const winner = refinements[0]!;
      const nativeSpacing = Math.min(
        options.referencePlane.rowSpacingDsMm,
        options.referencePlane.colSpacingDsMm,
        options.targetSlices[0]!.rowSpacingDsMm,
        options.targetSlices[0]!.colSpacingDsMm,
      );
      const targetBounds = stackBounds(options.targetSlices);
      const rivals = refinements.filter(
        (candidate) =>
          candidate !== winner &&
          maximumPoseDisplacementMm(candidate.rigid, winner.rigid, targetBounds, options.centerMm) >= nativeSpacing,
      );
      const scoreMargin = rivals.length > 0 ? winner.diagnostics.heldOutScore - rivals[0]!.diagnostics.heldOutScore : 0;
      const minimumDistinguishableScoreMargin = Math.max(
        1e-4,
        (1 - Math.min(1, winner.diagnostics.rawScore) ** 2) /
          Math.sqrt(Math.max(1, winner.diagnostics.heldOutEffectiveIndependentSamples - 3)),
      );
      targetToReference = winner.rigid;
      nativeRefinement = {
        ...winner.diagnostics,
        optimizedHypothesisCount: refinements.length,
        optimizedAlternativeCount: rivals.length,
        scoreMargin,
        minimumDistinguishableScoreMargin,
      };
    }
    const result = resliceStackToReferencePlane({
      targetSlices: options.targetSlices,
      referenceSlice: options.referencePlane,
      targetToReference,
      centerMm: options.centerMm,
      outputGrid: options.outputGrid,
      signal: options.signal,
    });
    if (result.coverage < Math.max(0.1, Math.min(1, options.minCoverage ?? 0.55))) {
      return failure('insufficient-coverage', 'The native target slices do not cover the registered reference plane');
    }
    return {
      ok: true,
      ...result,
      ...(nativeRefinement ? { targetToReference, nativeRefinement } : {}),
    };
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
    if (options.outputGrid) validateOutputPlaneGrid(options.outputGrid);
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

    const referenceFrame = referenceSlice.frameOfReferenceUid;
    const targetFrame = targetFirst.frameOfReferenceUid;
    const frameRelationship =
      referenceFrame && targetFrame ? (referenceFrame === targetFrame ? 'same' : 'different') : 'unverified';
    if (
      options.outputGrid?.frameOfReferenceUid &&
      referenceFrame &&
      options.outputGrid.frameOfReferenceUid !== referenceFrame
    ) {
      return failure('invalid-geometry', 'The selected output grid does not belong to the reference acquisition');
    }
    const initialReferenceBounds = stackBounds(options.referenceSlices);
    const initialTargetBounds = stackBounds(options.targetSlices);
    const initialCenter = boundsCenterMm(initialReferenceBounds);
    let initialMaskTransform = options.initialTargetToReference ?? IDENTITY_RIGID;
    if (!options.initialTargetToReference && frameRelationship !== 'same') {
      const rotation = axesRotation(targetFirst, referenceSlice);
      const translation = alignCenters(boundsCenterMm(initialTargetBounds), initialCenter, rotation);
      initialMaskTransform = {
        ...eulerFromRotation(rotation),
        tx: translation.x,
        ty: translation.y,
        tz: translation.z,
      };
    }

    const maxDimension = Math.max(16, Math.min(160, Math.round(options.maxDimension ?? 96)));
    const maxSamples = Math.max(256, Math.min(50_000, Math.round(options.maxSamples ?? 15_000)));
    const minimumCoverage = Math.max(0.1, Math.min(1, options.minCoverage ?? 0.55));
    const referencePrepared = prepareScoringSlices(options.referenceSlices, maxDimension);
    const targetPrepared = prepareScoringSlices(options.targetSlices, maxDimension);
    if (options.referenceExclusionMask) {
      maskReferenceAnatomy(referencePrepared, referenceSlice, options.referenceExclusionMask);
      maskReferenceAnatomy(
        targetPrepared,
        referenceSlice,
        options.referenceExclusionMask,
        initialMaskTransform,
        initialCenter,
      );
    }
    const referenceIntensityVariance = normalizeScoringSlices(referencePrepared);
    const targetIntensityVariance = normalizeScoringSlices(targetPrepared);
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
    const reconstructionOptions = {
      iterations: 0,
      stepSize: 0,
      clampOutput: true,
      psfMode: 'box' as const,
      robustLoss: 'none' as const,
      robustDelta: 0.1,
      laplacianWeight: 0,
    };
    const reconstructScoringDomain = async (slices: SvrReconstructionSlice[], bounds: BoundsMm, spacing: number) => {
      const grid = boundedGrid(bounds, spacing, maxDimension);
      const occupancy = new Uint8Array(grid.dims.nx * grid.dims.ny * grid.dims.nz);
      const refVolume = await reconstructVolumeFromSlices({
        slices,
        grid,
        occupancy,
        options: reconstructionOptions,
        hooks: { signal: options.signal, yieldToMain },
      });
      return { ...grid, occupancy, refVolume };
    };
    const referenceDomain = await reconstructScoringDomain(
      referencePrepared,
      referenceBounds,
      Math.min(referenceSlice.rowSpacingDsMm, referenceSlice.colSpacingDsMm),
    );
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
    const targetDomain = await reconstructScoringDomain(
      targetPrepared,
      targetBounds,
      Math.min(targetFirst.rowSpacingDsMm, targetFirst.colSpacingDsMm),
    );
    const minimumSamples = Math.min(
      512,
      Math.max(32, Math.floor(Math.min(samples.count, referenceSamples.count) * 0.1)),
    );

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
    } else {
      candidates.push({ ...IDENTITY_RIGID, tx: referenceDomain.voxelSizeMm });
    }

    const common = {
      samples,
      ...referenceDomain,
      centerMm,
      minimumCoverage,
      minimumSamples,
    };
    const reverse = { samples: referenceSamples, ...targetDomain };
    const scoredSeeds: Array<{ rigid: RigidParams; evidence: ReturnType<typeof scoreBidirectionalNcc> }> = [];
    for (const rigid of candidates) {
      const evidence = scoreBidirectionalNcc({ ...common, rigid, reverse });
      if (Number.isFinite(evidence.ncc)) scoredSeeds.push({ rigid, evidence });
    }
    scoredSeeds.sort((first, second) => second.evidence.ncc - first.evidence.ncc);
    scoredSeeds.length = Math.min(scoredSeeds.length, 3);
    if (scoredSeeds.length === 0) {
      return failure('insufficient-coverage', 'No physically justified initial pose retains enough supported anatomy');
    }

    const maxTranslationMm =
      Math.max(
        20,
        ...scoredSeeds.flatMap(({ rigid }) => [Math.abs(rigid.tx), Math.abs(rigid.ty), Math.abs(rigid.tz)]),
      ) + 20;
    const maxRotationRad =
      Math.max(
        (10 * Math.PI) / 180,
        ...scoredSeeds.flatMap(({ rigid }) => [Math.abs(rigid.rx), Math.abs(rigid.ry), Math.abs(rigid.rz)]),
      ) +
      (10 * Math.PI) / 180;
    const nativeSpacing = Math.min(
      referenceSlice.rowSpacingDsMm,
      referenceSlice.colSpacingDsMm,
      targetFirst.rowSpacingDsMm,
      targetFirst.colSpacingDsMm,
    );
    const hypotheses: Array<{
      rigid: RigidParams;
      evidence: ReturnType<typeof scoreBidirectionalNcc>;
      evaluations: number;
    }> = [];
    for (const seed of scoredSeeds) {
      assertNotAborted(options.signal);
      const optimized = await optimizeRigidNcc({
        ...common,
        signal: options.signal,
        initial: seed.rigid,
        maxTranslationMm,
        maxRotationRad,
        finestTranslationStepMm: Math.max(0.05, nativeSpacing / 4),
        reverse,
      });
      hypotheses.push({
        rigid: optimized.best,
        evidence: scoreBidirectionalNcc({ ...common, rigid: optimized.best, reverse }),
        evaluations: optimized.evals,
      });
    }
    hypotheses.sort((first, second) => second.evidence.ncc - first.evidence.ncc);
    let optimized = hypotheses[0]!;
    const identitySeed = scoredSeeds.find(
      ({ rigid }) =>
        rigid.tx === 0 && rigid.ty === 0 && rigid.tz === 0 && rigid.rx === 0 && rigid.ry === 0 && rigid.rz === 0,
    );
    if (frameRelationship === 'same' && identitySeed) {
      const identityAgreement = Math.min(identitySeed.evidence.forward.rawNcc, identitySeed.evidence.reverse.rawNcc);
      const distinguishableImprovement = Math.max(
        1e-4,
        (1 - Math.min(1, identityAgreement) ** 2) / Math.sqrt(Math.max(1, identitySeed.evidence.used - 3)),
      );
      if (optimized.evidence.ncc <= identitySeed.evidence.ncc + distinguishableImprovement) {
        optimized = { rigid: { ...IDENTITY_RIGID }, evidence: identitySeed.evidence, evaluations: 0 };
      }
    }
    const finalScore = optimized.evidence;
    if (!Number.isFinite(finalScore.ncc)) {
      return failure('insufficient-coverage', 'Rigid optimization lost supported anatomical overlap');
    }
    const rawScore = Math.min(finalScore.forward.rawNcc, finalScore.reverse.rawNcc);
    if (rawScore < 0.2 || finalScore.ncc <= 0) {
      return failure(
        'insufficient-evidence',
        'The registered anatomy does not have sufficient absolute structural agreement in both directions',
      );
    }

    const alternatives = hypotheses.filter(
      (hypothesis) =>
        hypothesis !== optimized &&
        Number.isFinite(hypothesis.evidence.ncc) &&
        maximumPoseDisplacementMm(hypothesis.rigid, optimized.rigid, targetBounds, centerMm) >= nativeSpacing,
    );
    const bestAlternativeScore = alternatives[0]?.evidence.ncc;
    const scoreMargin = bestAlternativeScore === undefined ? 0 : finalScore.ncc - bestAlternativeScore;
    // This is only a numerical distinguishability floor under an optimistic
    // independent-sample assumption; it is not calibrated clinical confidence.
    const minimumDistinguishableScoreMargin = Math.max(
      1e-4,
      (1 - Math.min(1, rawScore) ** 2) / Math.sqrt(Math.max(1, finalScore.used - 3)),
    );
    const deferredAmbiguity = bestAlternativeScore !== undefined && scoreMargin <= minimumDistinguishableScoreMargin;

    const inverse = await optimizeRigidNcc({
      ...reverse,
      centerMm,
      minimumCoverage,
      minimumSamples,
      signal: options.signal,
      initial: invertRigidParams(optimized.rigid),
      maxTranslationMm,
      maxRotationRad,
      finestTranslationStepMm: Math.max(0.05, nativeSpacing / 4),
      reverse: { samples, ...referenceDomain },
    });
    const inverseConsistencyErrorMm = maximumPoseDisplacementMm(
      invertRigidParams(inverse.best),
      optimized.rigid,
      targetBounds,
      centerMm,
    );
    if (
      !Number.isFinite(inverse.bestScore) ||
      inverseConsistencyErrorMm > Math.max(referenceDomain.voxelSizeMm, nativeSpacing * 2)
    ) {
      return failure('ambiguous', 'Independent forward and reverse rigid registrations are physically inconsistent');
    }

    const resliced = resliceStackToReferencePlane({
      targetSlices: options.targetSlices,
      referenceSlice,
      outputGrid: options.outputGrid,
      targetToReference: optimized.rigid,
      centerMm,
      signal: options.signal,
    });
    if (resliced.coverage < minimumCoverage && !options.deferPresentationValidation) {
      return failure('insufficient-coverage', 'The requested reference plane is outside the supported target volume');
    }

    return {
      ok: true,
      ...resliced,
      targetToReference: optimized.rigid,
      centerMm,
      score: finalScore.ncc,
      ...(deferredAmbiguity
        ? {
            nativeCandidatePoses: [optimized.rigid, ...alternatives.map((alternative) => alternative.rigid)].slice(
              0,
              3,
            ),
          }
        : {}),
      diagnostics: {
        rawScore,
        retainedSampleFraction: finalScore.forward.coverage,
        reverseRetainedSampleFraction: finalScore.reverse.coverage,
        sampledTargetCount: samples.count,
        effectiveSampleCount: finalScore.used,
        evaluatedCandidates:
          candidates.length + inverse.evals + hypotheses.reduce((sum, hypothesis) => sum + hypothesis.evaluations, 0),
        optimizedHypothesisCount: hypotheses.length,
        optimizedAlternativeCount: alternatives.length,
        referenceVoxelSizeMm: referenceDomain.voxelSizeMm,
        angleDifferenceDeg,
        scoreMargin,
        minimumDistinguishableScoreMargin,
        inverseScoreGap: Math.abs(finalScore.forward.rawNcc - finalScore.reverse.rawNcc),
        inverseConsistencyErrorMm,
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

export { applyRigidToPoint, failure as longitudinalRegistrationFailure };
