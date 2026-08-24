import { decodeImageWithValidity, loadCornerstoneImage } from '../decodedFrame';
import type { getSeriesFrameManifest } from '../localApi';
import {
  outputGridFingerprint,
  outputGridPixelToWorld,
  validateOutputGridReference,
  validateOutputPlaneGrid,
  type OutputPlaneGrid,
} from '../outputPlaneGrid';
import { downsampledSliceOriginMm, getSliceGeometryFromInstance, sliceCornersMm } from './dicomGeometry';
import type {
  DenseLongitudinalResliceOptions,
  LongitudinalReferencePlane,
  LongitudinalRegistrationFailure,
  LongitudinalRegistrationResult,
} from './longitudinalRegistration';
import type { SvrReconstructionSlice } from './reconstructionCore';
import { applyRigidToPoint, invertRigidParams, mat3FromEulerXYZ, type RigidParams } from './rigidRegistration';
import { runLongitudinalDenseReslice } from './runLongitudinalRegistration';
import { assertNotAborted, yieldToMain } from './svrUtils';
import { dot, v3, type Vec3 } from './vec3';

type SeriesFrameManifest = Awaited<ReturnType<typeof getSeriesFrameManifest>>;

export type PreparedLongitudinalRegistrationInput = {
  referenceSlices: SvrReconstructionSlice[];
  targetSlices: SvrReconstructionSlice[];
  referenceSliceIndex: number;
  referenceSourceIndices: number[];
  targetSourceIndices: number[];
  outputGrid?: OutputPlaneGrid;
};

export type PreparedLongitudinalReferenceInput = {
  readonly referenceManifest: SeriesFrameManifest;
  readonly referenceSlices: readonly SvrReconstructionSlice[];
  readonly referenceSliceIndex: number;
  readonly referenceSourceIndex: number;
  readonly referenceSourceIndices: readonly number[];
  readonly maxDimension: number;
  readonly maxSlices: number;
  readonly outputMaxDimension: number;
  readonly outputGrid?: OutputPlaneGrid;
};

export type PrepareLongitudinalOptions = {
  signal?: AbortSignal;
  maxDimension?: number;
  maxSlices?: number;
  /** Preserve target/source-plane detail for final presentation while scoring stays bounded. */
  outputMaxDimension?: number;
  outputGrid?: OutputPlaneGrid;
  preparedReference?: PreparedLongitudinalReferenceInput;
};

export type PreparedDenseLongitudinalResliceInput = Omit<DenseLongitudinalResliceOptions, 'signal'> & {
  sourceIndices: number[];
  sliceSpacingMm: number;
  sourceDepthSpanMm: number;
};

type DenseLongitudinalOptions = {
  signal?: AbortSignal;
  maxSlices?: number;
  maxDimension?: number;
  minCoverage?: number;
  outputGrid?: OutputPlaneGrid;
  referenceManifest?: SeriesFrameManifest;
  referenceSliceIndex?: number;
  referenceExclusionMask?: Uint8Array;
  nativeCandidatePoses?: readonly RigidParams[];
};

const MAX_NATIVE_REFERENCE_BYTES = 32 * 1024 * 1024;

function outputPlaneCorners(grid: OutputPlaneGrid): Vec3[] {
  return [0, grid.rows - 1].flatMap((row) =>
    [0, grid.columns - 1].map((column) => outputGridPixelToWorld(grid, row, column)),
  );
}

function selectNativeReferenceContext(options: DenseLongitudinalOptions): {
  manifest: SeriesFrameManifest;
  sourceIndices: number[];
  selectedIndex: number;
  maxDimension: number;
} {
  const manifest = options.referenceManifest;
  const selectedIndex = options.referenceSliceIndex;
  const selected = selectedIndex === undefined ? undefined : manifest?.frames[selectedIndex];
  if (!manifest || !selected || selectedIndex === undefined) {
    throw new Error('Native refinement requires the selected physical reference frame');
  }
  const maxDimension = Math.min(1024, Math.max(selected.rows, selected.columns));
  const scale = Math.min(1, maxDimension / Math.max(selected.rows, selected.columns));
  const bytesPerSlice =
    Math.max(2, Math.round(selected.rows * scale)) *
    Math.max(2, Math.round(selected.columns * scale)) *
    (Float32Array.BYTES_PER_ELEMENT + Uint8Array.BYTES_PER_ELEMENT);
  const maximumRadius = Math.floor((Math.floor(MAX_NATIVE_REFERENCE_BYTES / bytesPerSlice) - 1) / 2);
  if (maximumRadius < 1) {
    throw new Error('Native reference refinement exceeds its bounded physical-slab memory budget');
  }
  const requestedRadius = (options.nativeCandidatePoses?.length ?? 0) > 1 ? 6 : 2;
  const radius = Math.min(requestedRadius, maximumRadius);
  const firstIndex = Math.max(0, selectedIndex - radius);
  const lastIndex = Math.min(manifest.frames.length - 1, selectedIndex + radius);
  return {
    manifest,
    selectedIndex,
    sourceIndices: Array.from({ length: lastIndex - firstIndex + 1 }, (_, index) => firstIndex + index),
    maxDimension,
  };
}

function resizeExcludedSupport(
  mask: Uint8Array,
  sourceRows: number,
  sourceColumns: number,
  destinationRows: number,
  destinationColumns: number,
): Uint8Array {
  if (mask.length !== sourceRows * sourceColumns) {
    throw new Error('The native reference exclusion mask does not match its selected image');
  }
  if (sourceRows === destinationRows && sourceColumns === destinationColumns) return mask;
  const result = new Uint8Array(destinationRows * destinationColumns);
  for (let row = 0; row < destinationRows; row++) {
    const firstRow = Math.floor((row * sourceRows) / destinationRows);
    const lastRow = Math.min(sourceRows - 1, Math.ceil(((row + 1) * sourceRows) / destinationRows) - 1);
    for (let column = 0; column < destinationColumns; column++) {
      const firstColumn = Math.floor((column * sourceColumns) / destinationColumns);
      const lastColumn = Math.min(
        sourceColumns - 1,
        Math.ceil(((column + 1) * sourceColumns) / destinationColumns) - 1,
      );
      for (let sourceRow = firstRow; sourceRow <= lastRow; sourceRow++) {
        for (let sourceColumn = firstColumn; sourceColumn <= lastColumn; sourceColumn++) {
          if (mask[sourceRow * sourceColumns + sourceColumn]) {
            result[row * destinationColumns + column] = 1;
            sourceRow = lastRow;
            break;
          }
        }
      }
    }
  }
  return result;
}

function selectPhysicallySpacedIndices(
  manifest: SeriesFrameManifest,
  maximum: number,
  requiredIndex?: number,
): number[] {
  const count = manifest.frames.length;
  if (count <= maximum) return Array.from({ length: count }, (_, index) => index);
  const first = getSliceGeometryFromInstance(manifest.frames[0]!);
  const depths = manifest.frames.map((frame) => dot(getSliceGeometryFromInstance(frame).ippMm, first.normalDir));
  const minimum = depths[0]!;
  const maximumDepth = depths[count - 1]!;
  const selected = [0];
  for (let step = 1; step < maximum - 1; step++) {
    const requestedDepth = minimum + ((maximumDepth - minimum) * step) / (maximum - 1);
    let closest = 1;
    let closestDistance = Number.POSITIVE_INFINITY;
    for (let index = 1; index < count - 1; index++) {
      if (selected.includes(index)) continue;
      const distance = Math.abs(depths[index]! - requestedDepth);
      if (distance < closestDistance) {
        closest = index;
        closestDistance = distance;
      }
    }
    selected.push(closest);
  }
  selected.push(count - 1);
  if (requiredIndex != null && !selected.includes(requiredIndex)) {
    let replace = 1;
    for (let index = 2; index < selected.length - 1; index++) {
      if (
        Math.abs(depths[selected[index]!]! - depths[requiredIndex]!) <
        Math.abs(depths[selected[replace]!]! - depths[requiredIndex]!)
      ) {
        replace = index;
      }
    }
    selected[replace] = requiredIndex;
  }
  selected.sort((a, b) => a - b);
  return selected;
}

function medianPhysicalSpacing(manifest: SeriesFrameManifest): number | null {
  const positions = manifest.frames
    .map((frame) => frame.physicalSlicePosition)
    .filter((position): position is number => typeof position === 'number' && Number.isFinite(position));
  if (positions.length < 2) return null;
  const gaps: number[] = [];
  for (let index = 1; index < positions.length; index++) {
    const gap = Math.abs(positions[index]! - positions[index - 1]!);
    if (gap > 1e-6) gaps.push(gap);
  }
  gaps.sort((a, b) => a - b);
  return gaps.length > 0 ? gaps[Math.floor(gaps.length / 2)]! : null;
}

async function decodeManifestSlices(
  manifest: SeriesFrameManifest,
  sourceIndices: readonly number[],
  maxDimension: number,
  signal?: AbortSignal,
  highResolutionIndex?: number,
  highResolutionDimension = maxDimension,
): Promise<SvrReconstructionSlice[]> {
  const output: SvrReconstructionSlice[] = [];
  const inferredSpacing = medianPhysicalSpacing(manifest);

  for (let cursor = 0; cursor < sourceIndices.length; cursor++) {
    assertNotAborted(signal);
    const sourceIndex = sourceIndices[cursor]!;
    const frame = manifest.frames[sourceIndex];
    if (!frame) throw new Error('A selected longitudinal frame is missing from its physical manifest');

    const geometry = getSliceGeometryFromInstance(frame);
    const sliceDimension = sourceIndex === highResolutionIndex ? highResolutionDimension : maxDimension;
    const scale = Math.min(1, sliceDimension / Math.max(geometry.rows, geometry.cols));
    const rows = Math.max(2, Math.round(geometry.rows * scale));
    const cols = Math.max(2, Math.round(geometry.cols * scale));
    const image = await loadCornerstoneImage(`miradb:${frame.sopInstanceUid}`);
    assertNotAborted(signal);
    const decodedImage =
      frame.pixelPaddingValue === undefined
        ? image
        : Object.assign(image, {
            pixelPaddingValue: frame.pixelPaddingValue,
            pixelPaddingRangeLimit: frame.pixelPaddingRangeLimit,
          });
    const { pixels, validity } = decodeImageWithValidity(
      decodedImage as Parameters<typeof decodeImageWithValidity>[0],
      rows,
      cols,
    );

    output.push({
      pixels,
      valid: Uint8Array.from(validity, (support) => (support > 0 ? 1 : 0)),
      sopInstanceUid: frame.sopInstanceUid,
      dsRows: rows,
      dsCols: cols,
      ippMm: downsampledSliceOriginMm(geometry, rows, cols),
      rowDir: geometry.rowDir,
      colDir: geometry.colDir,
      normalDir: geometry.normalDir,
      rowSpacingDsMm: geometry.rowSpacingMm * (geometry.rows / rows),
      colSpacingDsMm: geometry.colSpacingMm * (geometry.cols / cols),
      sliceThicknessMm: frame.sliceThickness ?? null,
      spacingBetweenSlicesMm: frame.spacingBetweenSlices ?? inferredSpacing,
      frameOfReferenceUid: frame.frameOfReferenceUid ?? manifest.frameOfReferenceUid,
    });

    if ((cursor + 1) % 8 === 0) {
      await yieldToMain();
      assertNotAborted(signal);
    }
  }

  return output;
}

function normalizeLongitudinalPreparation(
  referenceManifest: SeriesFrameManifest,
  referenceSliceIndex: number,
  options: PrepareLongitudinalOptions,
  targetManifest: SeriesFrameManifest = referenceManifest,
): {
  maxDimension: number;
  maxSlices: number;
  outputMaxDimension: number;
} {
  if (
    !Number.isInteger(referenceSliceIndex) ||
    referenceSliceIndex < 0 ||
    referenceSliceIndex >= referenceManifest.frames.length
  ) {
    throw new Error('The selected reference frame is outside its physically ordered manifest');
  }
  if (referenceManifest.frames.length < 2 || targetManifest.frames.length < 2) {
    throw new Error('Longitudinal registration requires at least two frames in each physical stack');
  }
  if (options.outputGrid) {
    validateOutputGridReference(
      options.outputGrid,
      referenceManifest.frames[referenceSliceIndex]!,
      referenceManifest.frameOfReferenceUid,
    );
  }

  const maxDimension = Math.max(8, Math.min(128, Math.round(options.maxDimension ?? 128)));
  return {
    maxDimension,
    maxSlices: Math.max(3, Math.min(96, Math.round(options.maxSlices ?? 96))),
    outputMaxDimension: Math.max(
      maxDimension,
      Math.min(
        1024,
        Math.max(
          Math.round(options.outputMaxDimension ?? maxDimension),
          options.outputGrid ? Math.max(options.outputGrid.rows, options.outputGrid.columns) : 0,
        ),
      ),
    ),
  };
}

/** Retain one bounded reference stack for an alignment run without transferring its buffers. */
export async function prepareLongitudinalReferenceInput(
  referenceManifest: SeriesFrameManifest,
  referenceSliceIndex: number,
  options: PrepareLongitudinalOptions = {},
): Promise<PreparedLongitudinalReferenceInput> {
  assertNotAborted(options.signal);
  const bounds = normalizeLongitudinalPreparation(referenceManifest, referenceSliceIndex, options);
  const referenceSourceIndices = selectPhysicallySpacedIndices(
    referenceManifest,
    bounds.maxSlices,
    referenceSliceIndex,
  );
  const referenceSlices = await decodeManifestSlices(
    referenceManifest,
    referenceSourceIndices,
    bounds.maxDimension,
    options.signal,
    referenceSliceIndex,
    bounds.outputMaxDimension,
  );
  assertNotAborted(options.signal);
  const retainedBytes = referenceSlices.reduce(
    (total, slice) => total + slice.pixels.byteLength + (slice.valid?.byteLength ?? 0),
    0,
  );
  if (retainedBytes > MAX_NATIVE_REFERENCE_BYTES) {
    throw new Error('The prepared reference stack exceeds its bounded alignment-run memory budget');
  }
  return {
    referenceManifest,
    referenceSlices,
    referenceSliceIndex: referenceSourceIndices.indexOf(referenceSliceIndex),
    referenceSourceIndex: referenceSliceIndex,
    referenceSourceIndices,
    ...bounds,
    ...(options.outputGrid ? { outputGrid: options.outputGrid } : {}),
  };
}

/** Decode bounded, physically ordered source stacks while retaining exact source-index provenance. */
export async function prepareLongitudinalRegistrationInput(
  referenceManifest: SeriesFrameManifest,
  targetManifest: SeriesFrameManifest,
  referenceSliceIndex: number,
  options: PrepareLongitudinalOptions = {},
): Promise<PreparedLongitudinalRegistrationInput> {
  assertNotAborted(options.signal);
  if (referenceManifest.patientKey !== targetManifest.patientKey) {
    throw new Error('Longitudinal registration requires reference and target frames from the same patient');
  }
  const bounds = normalizeLongitudinalPreparation(referenceManifest, referenceSliceIndex, options, targetManifest);
  const preparedReference =
    options.preparedReference ??
    (await prepareLongitudinalReferenceInput(referenceManifest, referenceSliceIndex, options));
  if (
    preparedReference.referenceManifest !== referenceManifest ||
    preparedReference.referenceSourceIndex !== referenceSliceIndex ||
    preparedReference.maxDimension !== bounds.maxDimension ||
    preparedReference.maxSlices !== bounds.maxSlices ||
    preparedReference.outputMaxDimension !== bounds.outputMaxDimension ||
    Boolean(preparedReference.outputGrid) !== Boolean(options.outputGrid) ||
    (preparedReference.outputGrid &&
      options.outputGrid &&
      outputGridFingerprint(preparedReference.outputGrid) !== outputGridFingerprint(options.outputGrid)) ||
    preparedReference.referenceSlices[preparedReference.referenceSliceIndex]?.sopInstanceUid !==
      referenceManifest.frames[referenceSliceIndex]!.sopInstanceUid
  ) {
    throw new Error('The prepared reference does not match this alignment run, source frame, or output grid');
  }
  const targetSourceIndices = selectPhysicallySpacedIndices(targetManifest, bounds.maxSlices);
  const targetSlices = await decodeManifestSlices(
    targetManifest,
    targetSourceIndices,
    bounds.maxDimension,
    options.signal,
  );
  assertNotAborted(options.signal);
  const referenceSlices = options.preparedReference
    ? preparedReference.referenceSlices.map((slice) => ({
        ...slice,
        pixels: Float32Array.from(slice.pixels),
        ...(slice.valid ? { valid: Uint8Array.from(slice.valid) } : {}),
      }))
    : Array.from(preparedReference.referenceSlices);
  assertNotAborted(options.signal);

  return {
    referenceSlices,
    // Native presentation is decoded only after its accepted rigid pose bounds
    // the intersecting slab; the global scoring stack never needs native pixels.
    targetSlices,
    referenceSliceIndex: preparedReference.referenceSliceIndex,
    referenceSourceIndices: Array.from(preparedReference.referenceSourceIndices),
    targetSourceIndices,
    outputGrid: options.outputGrid,
  };
}

/** Load every native slice physically intersecting the already-registered reference plane. */
export async function prepareDenseLongitudinalResliceInput(
  targetManifest: SeriesFrameManifest,
  selectedReference: SvrReconstructionSlice,
  targetToReference: RigidParams,
  centerMm: Vec3,
  options: DenseLongitudinalOptions = {},
): Promise<PreparedDenseLongitudinalResliceInput> {
  assertNotAborted(options.signal);
  const firstFrame = targetManifest.frames[0];
  if (!firstFrame) throw new Error('A native-fidelity reference plane requires a target frame manifest');
  const firstGeometry = getSliceGeometryFromInstance(firstFrame);
  const spacing =
    targetManifest.sliceSpacingMm ??
    medianPhysicalSpacing(targetManifest) ??
    firstFrame.spacingBetweenSlices ??
    firstFrame.sliceThickness;
  if (!spacing || !Number.isFinite(spacing) || spacing <= 0) {
    throw new Error('Native-fidelity reference reslicing requires positive target slice spacing');
  }

  // The coarse worker owns and detaches selectedReference pixels/support. Final
  // resampling needs only the immutable geometry of its native reference plane.
  const { pixels: _detachedPixels, valid: _detachedValidity, ...referencePlane } = selectedReference;
  void _detachedPixels;
  void _detachedValidity;
  if (options.outputGrid) validateOutputPlaneGrid(options.outputGrid);
  const corners = options.outputGrid
    ? outputPlaneCorners(options.outputGrid)
    : sliceCornersMm({
        ippMm: referencePlane.ippMm,
        rowDir: referencePlane.rowDir,
        colDir: referencePlane.colDir,
        rowSpacingMm: referencePlane.rowSpacingDsMm,
        colSpacingMm: referencePlane.colSpacingDsMm,
        rows: referencePlane.dsRows,
        cols: referencePlane.dsCols,
      });
  const nativeCandidatePoses = options.nativeCandidatePoses?.length
    ? options.nativeCandidatePoses
    : [targetToReference];
  if (
    nativeCandidatePoses.length > 3 ||
    nativeCandidatePoses.some((pose) =>
      [pose.tx, pose.ty, pose.tz, pose.rx, pose.ry, pose.rz].some((value) => !Number.isFinite(value)),
    ) ||
    (['tx', 'ty', 'tz', 'rx', 'ry', 'rz'] as const).some(
      (parameter) => nativeCandidatePoses[0]![parameter] !== targetToReference[parameter],
    )
  ) {
    throw new Error('Native refinement requires at most three verified, winner-first rigid hypotheses');
  }
  const sourceCorners = [...corners];
  if (nativeCandidatePoses.length > 1 && options.referenceManifest) {
    const context = selectNativeReferenceContext(options);
    for (const index of context.sourceIndices) {
      const geometry = getSliceGeometryFromInstance(context.manifest.frames[index]!);
      sourceCorners.push(...sliceCornersMm(geometry));
    }
  }
  const depths = nativeCandidatePoses.flatMap((candidate) => {
    const inverse = invertRigidParams(candidate);
    const rotation = mat3FromEulerXYZ(inverse.rx, inverse.ry, inverse.rz);
    const translation = v3(inverse.tx, inverse.ty, inverse.tz);
    return sourceCorners.map((corner) =>
      dot(applyRigidToPoint(corner, centerMm, rotation, translation), firstGeometry.normalDir),
    );
  });
  const minimumDepth = Math.min(...depths) - spacing;
  const maximumDepth = Math.max(...depths) + spacing;
  const sourceIndices: number[] = [];
  for (let index = 0; index < targetManifest.frames.length; index++) {
    const frame = targetManifest.frames[index]!;
    const geometry = getSliceGeometryFromInstance(frame);
    if (
      dot(geometry.rowDir, firstGeometry.rowDir) < 0.995 ||
      dot(geometry.colDir, firstGeometry.colDir) < 0.995 ||
      dot(geometry.normalDir, firstGeometry.normalDir) < 0.995
    ) {
      throw new Error('Native target frames have inconsistent acquisition orientation');
    }
    if (
      targetManifest.frameOfReferenceUid &&
      frame.frameOfReferenceUid &&
      targetManifest.frameOfReferenceUid !== frame.frameOfReferenceUid
    ) {
      throw new Error('Native target frames belong to incompatible DICOM frames of reference');
    }
    const depth = dot(geometry.ippMm, firstGeometry.normalDir);
    if (depth >= minimumDepth - 1e-5 && depth <= maximumDepth + 1e-5) sourceIndices.push(index);
  }
  if (sourceIndices.length < 2) {
    throw new Error('The registered reference plane does not intersect adjacent native target slices');
  }
  const maximumSlices = Math.max(2, Math.min(96, Math.round(options.maxSlices ?? 96)));
  if (sourceIndices.length > maximumSlices) {
    throw new Error(
      `The registered reference plane requires ${sourceIndices.length} native frames, exceeding its ${maximumSlices}-frame native-slice safety budget`,
    );
  }
  const maxDimension = Math.max(
    8,
    Math.min(
      1024,
      Math.max(
        Math.round(options.maxDimension ?? 512),
        options.outputGrid ? Math.max(options.outputGrid.rows, options.outputGrid.columns) : 0,
      ),
    ),
  );
  const expectedBytes = sourceIndices.reduce((bytes, index) => {
    const frame = targetManifest.frames[index]!;
    const scale = Math.min(1, maxDimension / Math.max(frame.rows, frame.columns));
    return (
      bytes +
      Math.max(2, Math.round(frame.rows * scale)) *
        Math.max(2, Math.round(frame.columns * scale)) *
        (Float32Array.BYTES_PER_ELEMENT + Uint8Array.BYTES_PER_ELEMENT)
    );
  }, 0);
  if (expectedBytes > 128 * 1024 * 1024) {
    throw new Error('The registered reference plane exceeds its native-frame memory safety budget');
  }
  const targetSlices = await decodeManifestSlices(targetManifest, sourceIndices, maxDimension, options.signal);
  assertNotAborted(options.signal);

  return {
    targetSlices,
    referencePlane: referencePlane as LongitudinalReferencePlane,
    targetToReference,
    centerMm,
    outputGrid: options.outputGrid,
    ...(options.nativeCandidatePoses?.length ? { nativeCandidatePoses } : {}),
    minCoverage: options.minCoverage,
    sourceIndices,
    sliceSpacingMm: spacing,
    sourceDepthSpanMm: Math.max(...depths) - Math.min(...depths),
  };
}

/** Replace a coarse-stack preview with native through-plane anatomy in a fresh worker. */
export async function densifyLongitudinalRegistration(
  targetManifest: SeriesFrameManifest,
  selectedReference: SvrReconstructionSlice,
  registration: LongitudinalRegistrationResult,
  options: DenseLongitudinalOptions = {},
): Promise<LongitudinalRegistrationResult | LongitudinalRegistrationFailure> {
  try {
    const nativeCandidatePoses = registration.nativeCandidatePoses ?? options.nativeCandidatePoses;
    if ((nativeCandidatePoses?.length ?? 0) > 1 && !options.referenceManifest) {
      return {
        ok: false,
        reason: 'ambiguous',
        message: 'Ambiguous coarse poses require independently verified native reference anatomy',
      };
    }
    const dense = await prepareDenseLongitudinalResliceInput(
      targetManifest,
      selectedReference,
      registration.targetToReference,
      registration.centerMm,
      { ...options, ...(nativeCandidatePoses ? { nativeCandidatePoses } : {}) },
    );
    let nativeReferenceSlices: SvrReconstructionSlice[] | undefined;
    let nativeReferenceSliceIndex: number | undefined;
    let referenceExclusionMask: Uint8Array | undefined;
    if (options.referenceManifest) {
      if (options.referenceManifest.patientKey !== targetManifest.patientKey) {
        throw new Error('Native reference refinement requires frames from the same patient');
      }
      const context = selectNativeReferenceContext({
        ...options,
        ...(nativeCandidatePoses ? { nativeCandidatePoses } : {}),
      });
      const nativeReference = context.manifest.frames[context.selectedIndex]!;
      if (options.outputGrid) {
        validateOutputGridReference(options.outputGrid, nativeReference, options.referenceManifest.frameOfReferenceUid);
      }
      nativeReferenceSlices = await decodeManifestSlices(
        context.manifest,
        context.sourceIndices,
        context.maxDimension,
        options.signal,
      );
      nativeReferenceSliceIndex = context.sourceIndices.indexOf(context.selectedIndex);
      if (options.referenceExclusionMask) {
        const selectedNative = nativeReferenceSlices[nativeReferenceSliceIndex]!;
        referenceExclusionMask = resizeExcludedSupport(
          options.referenceExclusionMask,
          selectedReference.dsRows,
          selectedReference.dsCols,
          selectedNative.dsRows,
          selectedNative.dsCols,
        );
      }
    }
    const result = await runLongitudinalDenseReslice(
      {
        targetSlices: dense.targetSlices,
        referencePlane: dense.referencePlane,
        targetToReference: dense.targetToReference,
        centerMm: dense.centerMm,
        outputGrid: dense.outputGrid,
        nativeCandidatePoses: dense.nativeCandidatePoses,
        nativeReferenceSlices,
        nativeReferenceSliceIndex,
        referenceExclusionMask,
        minCoverage: options.minCoverage,
        signal: options.signal,
      },
      options.signal,
    );
    if (!result.ok) return result;
    if ((nativeCandidatePoses?.length ?? 0) > 1 && !result.nativeRefinement) {
      return {
        ok: false,
        reason: 'ambiguous',
        message: 'The native worker did not independently adjudicate ambiguous coarse poses',
      };
    }
    if (
      dense.outputGrid &&
      (!result.outputGrid || outputGridFingerprint(result.outputGrid) !== outputGridFingerprint(dense.outputGrid))
    ) {
      return {
        ok: false,
        reason: 'invalid-geometry',
        message: 'The native worker returned a different physical output grid',
      };
    }
    const decodedSourceUids = dense.sourceIndices.map((index) => targetManifest.frames[index]!.sopInstanceUid);
    if (result.contributingSourceSopInstanceUids?.some((uid) => !decodedSourceUids.includes(uid))) {
      return {
        ok: false,
        reason: 'invalid-geometry',
        message: 'The native worker returned an unverified contributing source image',
      };
    }
    const contributors = result.contributingSourceSopInstanceUids
      ? decodedSourceUids.filter((uid) => result.contributingSourceSopInstanceUids!.includes(uid))
      : decodedSourceUids;
    return {
      ...registration,
      ...result,
      outputGrid: result.outputGrid ?? dense.outputGrid,
      contributingSourceSopInstanceUids: contributors,
      diagnostics: {
        ...registration.diagnostics,
        presentationSourceFrameCount: dense.sourceIndices.length,
        presentationSliceSpacingMm: dense.sliceSpacingMm,
        presentationSourceDepthSpanMm: dense.sourceDepthSpanMm,
      },
    };
  } catch (error) {
    return {
      ok: false,
      reason: options.signal?.aborted ? 'cancelled' : 'insufficient-coverage',
      message: options.signal?.aborted
        ? 'Longitudinal registration cancelled'
        : error instanceof Error
          ? error.message
          : String(error),
    };
  }
}

/** Quantify the irreducible native-plane mismatch without trusting distinct frame origins. */
export function measureLongitudinalPlaneDrift(
  referenceManifest: SeriesFrameManifest,
  targetManifest: SeriesFrameManifest,
  options: { referenceSliceIndex?: number; outputGrid?: OutputPlaneGrid } = {},
): {
  angleDegrees: number;
  maximumThroughPlaneDriftMm: number;
  frameRelationship: 'same' | 'different' | 'unverified';
} {
  const referenceFrame = referenceManifest.frames[options.referenceSliceIndex ?? 0];
  const targetFrame = targetManifest.frames[0];
  if (!referenceFrame || !targetFrame) throw new Error('Plane drift requires a frame from each acquisition');
  if (options.outputGrid) {
    validateOutputGridReference(options.outputGrid, referenceFrame, referenceManifest.frameOfReferenceUid);
  }
  const reference = getSliceGeometryFromInstance(referenceFrame);
  const target = getSliceGeometryFromInstance(targetFrame);
  const angle = Math.acos(Math.max(-1, Math.min(1, Math.abs(dot(reference.normalDir, target.normalDir)))));
  const corners = options.outputGrid ? outputPlaneCorners(options.outputGrid) : sliceCornersMm(reference);
  const center = v3(
    (corners[0]!.x + corners[3]!.x) / 2,
    (corners[0]!.y + corners[3]!.y) / 2,
    (corners[0]!.z + corners[3]!.z) / 2,
  );
  const maximumThroughPlaneDriftMm = Math.max(
    ...corners.map((corner) =>
      Math.abs(dot(v3(corner.x - center.x, corner.y - center.y, corner.z - center.z), target.normalDir)),
    ),
  );
  const referenceUid = referenceFrame.frameOfReferenceUid ?? referenceManifest.frameOfReferenceUid;
  const targetUid = targetFrame.frameOfReferenceUid ?? targetManifest.frameOfReferenceUid;

  return {
    angleDegrees: (angle * 180) / Math.PI,
    maximumThroughPlaneDriftMm,
    frameRelationship: referenceUid && targetUid ? (referenceUid === targetUid ? 'same' : 'different') : 'unverified',
  };
}
