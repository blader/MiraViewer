import { decodeImageWithValidity, loadCornerstoneImage } from '../decodedFrame';
import { selectInformativeAlignmentPlane } from '../contextualAlignment';
import type { SeriesFrameManifest } from '../localApi';
import {
  outputGridFingerprint,
  buildOutputPlaneGrid,
  outputGridPixelToWorld,
  validateOutputGridReference,
  validateOutputPlaneGrid,
  type OutputPlaneGrid,
} from '../outputPlaneGrid';
import { downsampledSliceOriginMm, getSliceGeometryFromInstance, sliceCornersMm } from './dicomGeometry';
import {
  attenuateLongitudinalPlaneTilt,
  longitudinalRegistrationFailure,
  type DenseLongitudinalResliceOptions,
  type LongitudinalReferencePlane,
  type LongitudinalRegistrationFailure,
  type LongitudinalRegistrationResult,
  type LongitudinalRegistrationEstimate,
} from './longitudinalRegistration';
import { waitForNativeFrame } from './nativeFrameWait';
import type { SvrReconstructionSlice } from './reconstructionCore';
import { resample2dAreaAverageWithValidity, retainFullySupportedPixels } from './resample2d';
import {
  applyRigidToPoint,
  invertRigidParams,
  mat3FromEulerXYZ,
  mat3MulVec3,
  type RigidParams,
} from './rigidRegistration';
import { runLongitudinalDenseReslice, type LongitudinalResliceRuntime } from './runLongitudinalRegistration';
import { assertNotAborted, yieldToMain } from './svrUtils';
import { dot, v3, type Vec3 } from './vec3';

export type LongitudinalReferenceAnatomy = {
  manifest: SeriesFrameManifest;
  sourceIndex: number;
  rigidTransform: [number, number, number, number, number, number];
  rotationCenterMm: [number, number, number];
};

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
  readonly referenceAnatomy?: LongitudinalReferenceAnatomy;
};

export type PrepareLongitudinalOptions = {
  /** Automatic alignment estimates pose independently of the currently browsed slice. */
  selectInformativeReference?: boolean;
  signal?: AbortSignal;
  maxDimension?: number;
  maxSlices?: number;
  /** Preserve target/source-plane detail for final presentation while scoring stays bounded. */
  outputMaxDimension?: number;
  outputGrid?: OutputPlaneGrid;
  preparedReference?: PreparedLongitudinalReferenceInput;
  referenceAnatomy?: LongitudinalReferenceAnatomy;
};

export type PreparedDenseLongitudinalResliceInput = Omit<DenseLongitudinalResliceOptions, 'signal'> & {
  sourceIndices: number[];
  sliceSpacingMm: number;
  sourceDepthSpanMm: number;
};

type DenseLongitudinalOptions = {
  runtime?: LongitudinalResliceRuntime;
  /** A previously verified series pose can be resliced without optimizing it again. */
  refinePose?: boolean;
  signal?: AbortSignal;
  maxSlices?: number;
  maxDimension?: number;
  minCoverage?: number;
  outputGrid?: OutputPlaneGrid;
  referenceManifest?: SeriesFrameManifest;
  referenceSliceIndex?: number;
  referenceAnatomy?: LongitudinalReferenceAnatomy;
  referenceExclusionMask?: Uint8Array;
  alignmentFocus?: 'anatomy' | 'tumor';
  referenceImage?: {
    pixels: Float32Array;
    valid: Uint8Array;
    rows: number;
    columns: number;
    outputGrid: OutputPlaneGrid;
  };
  nativeCandidatePoses?: readonly RigidParams[];
};

const MAX_NATIVE_REFERENCE_BYTES = 32 * 1024 * 1024;

function outputPlaneCorners(grid: OutputPlaneGrid): Vec3[] {
  return [0, grid.rows - 1].flatMap((row) =>
    [0, grid.columns - 1].map((column) => outputGridPixelToWorld(grid, row, column)),
  );
}

function verifyReferenceAnatomy(
  anchorManifest: SeriesFrameManifest | undefined,
  anchorSourceIndex: number | undefined,
  anatomy: LongitudinalReferenceAnatomy | undefined,
): void {
  if (!anatomy) return;
  if (!anchorManifest || anchorSourceIndex === undefined || !anchorManifest.frames[anchorSourceIndex]) {
    throw new Error('Selected reference anatomy requires its verified acquired physical anchor');
  }
  if (anatomy.manifest.patientKey !== anchorManifest.patientKey) {
    throw new Error('Selected reference anatomy and its acquired anchor must belong to the same patient');
  }
  if (!Number.isSafeInteger(anatomy.sourceIndex) || !anatomy.manifest.frames[anatomy.sourceIndex]) {
    throw new Error('Selected reference anatomy requires a verified acquired source frame');
  }
  if (
    anatomy.rigidTransform.length !== 6 ||
    anatomy.rotationCenterMm.length !== 3 ||
    [...anatomy.rigidTransform, ...anatomy.rotationCenterMm].some((value) => !Number.isFinite(value))
  ) {
    throw new Error('Selected reference anatomy requires a finite verified rigid transform');
  }
}

function transformReferenceAnatomySlices(
  slices: readonly SvrReconstructionSlice[],
  sourceIndices: readonly number[],
  anatomy: LongitudinalReferenceAnatomy,
  anchorManifest: SeriesFrameManifest,
  anchorSourceIndex: number,
): SvrReconstructionSlice[] {
  const [tx, ty, tz, rx, ry, rz] = anatomy.rigidTransform;
  const rotation = mat3FromEulerXYZ(rx, ry, rz);
  const center = v3(...anatomy.rotationCenterMm);
  const translation = v3(tx, ty, tz);
  const anchor = getSliceGeometryFromInstance(anchorManifest.frames[anchorSourceIndex]!);

  return slices.map((slice, index) => {
    const transformed = {
      ...slice,
      ippMm: applyRigidToPoint(slice.ippMm, center, rotation, translation),
      rowDir: mat3MulVec3(rotation, slice.rowDir.x, slice.rowDir.y, slice.rowDir.z),
      colDir: mat3MulVec3(rotation, slice.colDir.x, slice.colDir.y, slice.colDir.z),
      normalDir: mat3MulVec3(rotation, slice.normalDir.x, slice.normalDir.y, slice.normalDir.z),
      frameOfReferenceUid: anchorManifest.frameOfReferenceUid,
    };
    if (sourceIndices[index] !== anatomy.sourceIndex) return transformed;
    return {
      ...transformed,
      ippMm: downsampledSliceOriginMm(anchor, slice.dsRows, slice.dsCols),
      rowDir: anchor.rowDir,
      colDir: anchor.colDir,
      normalDir: anchor.normalDir,
      rowSpacingDsMm: (anchor.rowSpacingMm * anchor.rows) / slice.dsRows,
      colSpacingDsMm: (anchor.colSpacingMm * anchor.cols) / slice.dsCols,
    };
  });
}

function selectNativeReferenceContext(options: DenseLongitudinalOptions): {
  manifest: SeriesFrameManifest;
  sourceIndices: number[];
  selectedIndex: number;
  maxDimension: number;
} {
  verifyReferenceAnatomy(options.referenceManifest, options.referenceSliceIndex, options.referenceAnatomy);
  const manifest = options.referenceAnatomy?.manifest ?? options.referenceManifest;
  const selectedIndex = options.referenceAnatomy?.sourceIndex ?? options.referenceSliceIndex;
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
  const requestedRadius = (options.nativeCandidatePoses?.length ?? 0) > 1 ? 6 : options.referenceExclusionMask ? 2 : 4;
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

function referencePlaneFromFrame(
  frame: SeriesFrameManifest['frames'][number],
  maxDimension: number,
  inferredSpacing: number | null,
  frameOfReferenceUid?: string,
): LongitudinalReferencePlane {
  const geometry = getSliceGeometryFromInstance(frame);
  const scale = Math.min(1, maxDimension / Math.max(geometry.rows, geometry.cols));
  const rows = Math.max(2, Math.round(geometry.rows * scale));
  const cols = Math.max(2, Math.round(geometry.cols * scale));
  return {
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
    frameOfReferenceUid: frame.frameOfReferenceUid ?? frameOfReferenceUid,
  };
}

/** Build the same sample-centered plane as reference decoding, without reading or allocating image pixels. */
export function getLongitudinalReferencePlane(
  manifest: SeriesFrameManifest,
  index: number,
  maxDimension: number,
  signal?: AbortSignal,
): LongitudinalReferencePlane {
  assertNotAborted(signal);
  const frame = manifest.frames[index];
  if (!frame) throw new Error('A selected longitudinal frame is missing from its physical manifest');
  return referencePlaneFromFrame(frame, maxDimension, medianPhysicalSpacing(manifest), manifest.frameOfReferenceUid);
}

async function decodeManifestSlices(
  manifest: SeriesFrameManifest,
  sourceIndices: readonly number[],
  maxDimension: number,
  signal?: AbortSignal,
  highResolutionIndex?: number,
  highResolutionDimension = maxDimension,
  onSourceLoad?: (load: Promise<unknown>) => void,
): Promise<SvrReconstructionSlice[]> {
  const output: SvrReconstructionSlice[] = [];
  const inferredSpacing = medianPhysicalSpacing(manifest);

  for (let cursor = 0; cursor < sourceIndices.length; cursor++) {
    assertNotAborted(signal);
    const sourceIndex = sourceIndices[cursor]!;
    const frame = manifest.frames[sourceIndex];
    if (!frame) throw new Error('A selected longitudinal frame is missing from its physical manifest');

    const sliceDimension = sourceIndex === highResolutionIndex ? highResolutionDimension : maxDimension;
    const plane = referencePlaneFromFrame(frame, sliceDimension, inferredSpacing, manifest.frameOfReferenceUid);
    const load = loadCornerstoneImage(`miradb:${frame.sopInstanceUid}`);
    onSourceLoad?.(load);
    const image = await waitForNativeFrame<Parameters<typeof decodeImageWithValidity>[0]>(load, signal);
    assertNotAborted(signal);
    const decodedImage =
      frame.pixelPaddingValue === undefined
        ? image
        : Object.assign(image, {
            pixelPaddingValue: frame.pixelPaddingValue,
            pixelPaddingRangeLimit: frame.pixelPaddingRangeLimit,
          });
    const { pixels, valid } = retainFullySupportedPixels(
      decodeImageWithValidity(decodedImage, plane.dsRows, plane.dsCols),
    );

    output.push({
      ...plane,
      pixels,
      valid,
    });

    if ((cursor + 1) % 8 === 0) {
      await yieldToMain();
      assertNotAborted(signal);
    }
  }

  return output;
}

export async function decodeLongitudinalReferenceFrame(
  manifest: SeriesFrameManifest,
  index: number,
  maxDimension: number,
  signal?: AbortSignal,
  /** Observe the uncancelable source load separately from this consumer's bounded wait. */
  onSourceLoad?: (load: Promise<unknown>) => void,
): Promise<SvrReconstructionSlice> {
  const [slice] = await decodeManifestSlices(
    manifest,
    [index],
    maxDimension,
    signal,
    undefined,
    maxDimension,
    onSourceLoad,
  );
  if (!slice) throw new Error('The selected physical reference frame is unavailable');
  return slice;
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
  verifyReferenceAnatomy(referenceManifest, referenceSliceIndex, options.referenceAnatomy);
  if (options.referenceAnatomy && options.referenceAnatomy.manifest.frames.length < 2) {
    throw new Error('Selected reference anatomy requires at least two acquired physical slices');
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
  const anatomy = options.referenceAnatomy;
  const sourceManifest = anatomy?.manifest ?? referenceManifest;
  const automatic = options.selectInformativeReference && !anatomy;
  let sourceIndex = anatomy?.sourceIndex ?? referenceSliceIndex;
  const referenceSourceIndices = selectPhysicallySpacedIndices(
    sourceManifest,
    bounds.maxSlices,
    automatic ? undefined : sourceIndex,
  );
  let referenceSlices = await decodeManifestSlices(
    sourceManifest,
    referenceSourceIndices,
    bounds.maxDimension,
    options.signal,
    automatic ? undefined : sourceIndex,
    bounds.outputMaxDimension,
  );
  let outputGrid = options.outputGrid;
  if (automatic) {
    const informativeIndex = selectInformativeAlignmentPlane(
      referenceSlices.map((slice) => ({
        pixels: slice.pixels,
        valid: slice.valid,
        rows: slice.dsRows,
        cols: slice.dsCols,
      })),
    );
    if (informativeIndex === null) {
      throw new Error('No sustained anatomical detail was found across neighboring reference slices');
    }
    sourceIndex = referenceSourceIndices[informativeIndex]!;
    referenceSlices[informativeIndex] = await decodeLongitudinalReferenceFrame(
      sourceManifest,
      sourceIndex,
      bounds.outputMaxDimension,
      options.signal,
    );
    outputGrid = buildOutputPlaneGrid(sourceManifest.frames[sourceIndex]!, {
      mode: options.outputGrid?.mode ?? 'native',
      frameOfReferenceUid: sourceManifest.frameOfReferenceUid,
    });
  }
  if (anatomy) {
    referenceSlices = transformReferenceAnatomySlices(
      referenceSlices,
      referenceSourceIndices,
      anatomy,
      referenceManifest,
      referenceSliceIndex,
    );
  }
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
    referenceSliceIndex: referenceSourceIndices.indexOf(sourceIndex),
    referenceSourceIndex: automatic ? sourceIndex : referenceSliceIndex,
    referenceSourceIndices,
    ...bounds,
    ...(outputGrid ? { outputGrid } : {}),
    ...(anatomy ? { referenceAnatomy: anatomy } : {}),
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
    preparedReference.referenceAnatomy !== options.referenceAnatomy ||
    preparedReference.maxDimension !== bounds.maxDimension ||
    preparedReference.maxSlices !== bounds.maxSlices ||
    preparedReference.outputMaxDimension !== bounds.outputMaxDimension ||
    Boolean(preparedReference.outputGrid) !== Boolean(options.outputGrid) ||
    (preparedReference.outputGrid &&
      options.outputGrid &&
      outputGridFingerprint(preparedReference.outputGrid) !== outputGridFingerprint(options.outputGrid)) ||
    preparedReference.referenceSlices[preparedReference.referenceSliceIndex]?.sopInstanceUid !==
      (options.referenceAnatomy
        ? options.referenceAnatomy.manifest.frames[options.referenceAnatomy.sourceIndex]!.sopInstanceUid
        : referenceManifest.frames[referenceSliceIndex]!.sopInstanceUid)
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

/** Select the complete bounded acquired envelope without decoding or inventing support. */
export function selectDenseLongitudinalSourceEnvelope(
  targetManifest: SeriesFrameManifest,
  referencePlane: LongitudinalReferencePlane,
  targetToReference: RigidParams,
  centerMm: Vec3,
  options: DenseLongitudinalOptions = {},
): { sourceIndices: number[]; sliceSpacingMm: number; sourceDepthSpanMm: number; maxDimension: number } {
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
  if (options.refinePose !== false && options.referenceManifest) {
    const context = selectNativeReferenceContext(options);
    const anatomy = options.referenceAnatomy;
    const rotation = anatomy
      ? mat3FromEulerXYZ(anatomy.rigidTransform[3], anatomy.rigidTransform[4], anatomy.rigidTransform[5])
      : null;
    const center = anatomy ? v3(...anatomy.rotationCenterMm) : null;
    const translation = anatomy
      ? v3(anatomy.rigidTransform[0], anatomy.rigidTransform[1], anatomy.rigidTransform[2])
      : null;
    for (const index of context.sourceIndices) {
      const geometry = getSliceGeometryFromInstance(context.manifest.frames[index]!);
      const contextCorners = sliceCornersMm(geometry);
      sourceCorners.push(
        ...(rotation && center && translation
          ? contextCorners.map((corner) => applyRigidToPoint(corner, center, rotation, translation))
          : contextCorners),
      );
    }
  }
  const candidateDepths = (candidate: RigidParams, candidateCorners: readonly Vec3[] = sourceCorners): number[] => {
    const inverse = invertRigidParams(candidate);
    const rotation = mat3FromEulerXYZ(inverse.rx, inverse.ry, inverse.rz);
    const translation = v3(inverse.tx, inverse.ty, inverse.tz);
    return candidateCorners.map((corner) =>
      dot(applyRigidToPoint(corner, centerMm, rotation, translation), firstGeometry.normalDir),
    );
  };
  const depths = nativeCandidatePoses.flatMap((candidate) => candidateDepths(candidate));
  let minimumDepth = Math.min(...depths) - spacing;
  let maximumDepth = Math.max(...depths) + spacing;
  const maximumSlices = Math.max(2, Math.min(96, Math.round(options.maxSlices ?? 96)));
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
  const frameBytes = (index: number): number => {
    const frame = targetManifest.frames[index]!;
    const scale = Math.min(1, maxDimension / Math.max(frame.rows, frame.columns));
    return (
      Math.max(2, Math.round(frame.rows * scale)) *
      Math.max(2, Math.round(frame.columns * scale)) *
      (Float32Array.BYTES_PER_ELEMENT + Uint8Array.BYTES_PER_ELEMENT)
    );
  };
  const referenceFrame = options.referenceManifest?.frameOfReferenceUid;
  const distinctFrame =
    !referenceFrame || !targetManifest.frameOfReferenceUid || referenceFrame !== targetManifest.frameOfReferenceUid;
  const normal = referencePlane.normalDir;
  const axialPlane = Math.abs(normal.z) >= 0.9;
  const correctAxialAnatomy = Boolean(
    options.referenceExclusionMask && options.referenceManifest && distinctFrame && axialPlane,
  );
  const obliqueDepths = correctAxialAnatomy
    ? candidateDepths(
        attenuateLongitudinalPlaneTilt(targetToReference, centerMm, referencePlane, options.outputGrid, 0.5),
        corners,
      )
    : [];
  const obliqueMinimumDepth = Math.min(minimumDepth, ...obliqueDepths.map((depth) => depth - spacing));
  const obliqueMaximumDepth = Math.max(maximumDepth, ...obliqueDepths.map((depth) => depth + spacing));
  const sourceIndices: number[] = [];
  const obliqueSourceIndices: number[] = [];
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
    if (correctAxialAnatomy && depth >= obliqueMinimumDepth - 1e-5 && depth <= obliqueMaximumDepth + 1e-5) {
      obliqueSourceIndices.push(index);
    }
  }
  if (sourceIndices.length < 2) {
    throw new Error('The registered reference plane does not intersect adjacent native target slices');
  }
  if (sourceIndices.length > maximumSlices) {
    throw new Error(
      `The registered reference plane requires ${sourceIndices.length} native frames, exceeding its ${maximumSlices}-frame native-slice safety budget`,
    );
  }
  let expectedBytes = sourceIndices.reduce((bytes, index) => bytes + frameBytes(index), 0);
  if (expectedBytes > 128 * 1024 * 1024) {
    throw new Error('The registered reference plane exceeds its native-frame memory safety budget');
  }
  const obliqueBytes = obliqueSourceIndices.reduce((bytes, index) => bytes + frameBytes(index), 0);
  if (
    obliqueSourceIndices.length > sourceIndices.length &&
    obliqueSourceIndices.length <= maximumSlices &&
    obliqueBytes <= 128 * 1024 * 1024
  ) {
    sourceIndices.splice(0, sourceIndices.length, ...obliqueSourceIndices);
    minimumDepth = obliqueMinimumDepth;
    maximumDepth = obliqueMaximumDepth;
    expectedBytes = obliqueBytes;
  }
  const localizeTumor = options.alignmentFocus === 'tumor' && Boolean(options.referenceExclusionMask);
  if (
    correctAxialAnatomy ||
    localizeTumor ||
    (options.refinePose !== false && options.referenceManifest && distinctFrame)
  ) {
    const localizationSliceLimit = localizeTumor && !axialPlane ? Math.min(maximumSlices, 32) : maximumSlices;
    let lower = sourceIndices[0]! - 1;
    let upper = sourceIndices[sourceIndices.length - 1]! + 1;
    while (sourceIndices.length < localizationSliceLimit && (lower >= 0 || upper < targetManifest.frames.length)) {
      assertNotAborted(options.signal);
      const leftDepth =
        lower >= 0
          ? dot(getSliceGeometryFromInstance(targetManifest.frames[lower]!).ippMm, firstGeometry.normalDir)
          : Number.NEGATIVE_INFINITY;
      const rightDepth =
        upper < targetManifest.frames.length
          ? dot(getSliceGeometryFromInstance(targetManifest.frames[upper]!).ippMm, firstGeometry.normalDir)
          : Number.POSITIVE_INFINITY;
      const leftDistance = minimumDepth - leftDepth;
      const rightDistance = rightDepth - maximumDepth;
      const useLeft = leftDistance <= rightDistance;
      const index = useLeft ? lower : upper;
      const distance = useLeft ? leftDistance : rightDistance;
      if (!Number.isFinite(distance) || distance > 12 + 1e-5) break;
      const additionalBytes = frameBytes(index);
      if (expectedBytes + additionalBytes > 128 * 1024 * 1024) break;
      if (useLeft) {
        sourceIndices.unshift(index);
        lower--;
      } else {
        sourceIndices.push(index);
        upper++;
      }
      expectedBytes += additionalBytes;
    }
  }
  return {
    sourceIndices,
    sliceSpacingMm: spacing,
    sourceDepthSpanMm: Math.max(...depths) - Math.min(...depths),
    maxDimension,
  };
}

/** Load every native slice physically intersecting the already-registered reference plane. */
export async function prepareDenseLongitudinalResliceInput(
  targetManifest: SeriesFrameManifest,
  selectedReference: LongitudinalReferencePlane & Partial<Pick<SvrReconstructionSlice, 'pixels'>>,
  targetToReference: RigidParams,
  centerMm: Vec3,
  options: DenseLongitudinalOptions = {},
): Promise<PreparedDenseLongitudinalResliceInput> {
  // The coarse worker owns and detaches selectedReference pixels/support. Final
  // resampling needs only the immutable geometry of its native reference plane.
  const { pixels: _detachedPixels, valid: _detachedValidity, ...referencePlane } = selectedReference;
  void _detachedPixels;
  void _detachedValidity;
  const envelope = selectDenseLongitudinalSourceEnvelope(
    targetManifest,
    referencePlane,
    targetToReference,
    centerMm,
    options,
  );
  const targetSlices = await decodeManifestSlices(
    targetManifest,
    envelope.sourceIndices,
    envelope.maxDimension,
    options.signal,
  );
  assertNotAborted(options.signal);

  return {
    targetSlices,
    referencePlane,
    targetToReference,
    centerMm,
    outputGrid: options.outputGrid,
    ...(options.nativeCandidatePoses?.length ? { nativeCandidatePoses: options.nativeCandidatePoses } : {}),
    minCoverage: options.minCoverage,
    sourceIndices: envelope.sourceIndices,
    sliceSpacingMm: envelope.sliceSpacingMm,
    sourceDepthSpanMm: envelope.sourceDepthSpanMm,
  };
}

/** Replace a coarse-stack preview with native through-plane anatomy in a fresh worker. */
export function densifyLongitudinalRegistration(
  targetManifest: SeriesFrameManifest,
  selectedReference: LongitudinalReferencePlane,
  registration: LongitudinalRegistrationEstimate,
  options: DenseLongitudinalOptions & { refinePose: false },
): Promise<LongitudinalRegistrationResult | LongitudinalRegistrationFailure>;
export function densifyLongitudinalRegistration(
  targetManifest: SeriesFrameManifest,
  selectedReference: SvrReconstructionSlice,
  registration: LongitudinalRegistrationEstimate,
  options?: DenseLongitudinalOptions,
): Promise<LongitudinalRegistrationResult | LongitudinalRegistrationFailure>;
export async function densifyLongitudinalRegistration(
  targetManifest: SeriesFrameManifest,
  selectedReference: LongitudinalReferencePlane,
  registration: LongitudinalRegistrationEstimate,
  options: DenseLongitudinalOptions = {},
): Promise<LongitudinalRegistrationResult | LongitudinalRegistrationFailure> {
  try {
    const referenceImage = options.referenceImage;
    if (
      referenceImage &&
      (!options.referenceManifest ||
        !options.outputGrid ||
        outputGridFingerprint(referenceImage.outputGrid) !== outputGridFingerprint(options.outputGrid) ||
        referenceImage.rows !== referenceImage.outputGrid.rows ||
        referenceImage.columns !== referenceImage.outputGrid.columns ||
        referenceImage.pixels.length !== referenceImage.rows * referenceImage.columns ||
        referenceImage.valid.length !== referenceImage.pixels.length)
    ) {
      throw new Error('The displayed reference image does not match its verified physical output grid');
    }
    const nativeCandidatePoses =
      options.refinePose === false ? undefined : (registration.nativeCandidatePoses ?? options.nativeCandidatePoses);
    if ((nativeCandidatePoses?.length ?? 0) > 1 && !options.referenceManifest) {
      return longitudinalRegistrationFailure(
        'ambiguous',
        'Ambiguous coarse poses require independently verified native reference anatomy',
      );
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
    if (options.referenceManifest && options.refinePose !== false) {
      if (options.referenceManifest.patientKey !== targetManifest.patientKey) {
        throw new Error('Native reference refinement requires frames from the same patient');
      }
      const context = selectNativeReferenceContext({
        ...options,
        ...(nativeCandidatePoses ? { nativeCandidatePoses } : {}),
      });
      const anchorReference = options.referenceManifest.frames[options.referenceSliceIndex!]!;
      if (options.outputGrid) {
        validateOutputGridReference(options.outputGrid, anchorReference, options.referenceManifest.frameOfReferenceUid);
      }
      nativeReferenceSlices = await decodeManifestSlices(
        context.manifest,
        context.sourceIndices,
        context.maxDimension,
        options.signal,
      );
      if (options.referenceAnatomy) {
        nativeReferenceSlices = transformReferenceAnatomySlices(
          nativeReferenceSlices,
          context.sourceIndices,
          options.referenceAnatomy,
          options.referenceManifest,
          options.referenceSliceIndex!,
        );
      }
      nativeReferenceSliceIndex = context.sourceIndices.indexOf(context.selectedIndex);
      if (referenceImage) {
        const selectedNative = nativeReferenceSlices[nativeReferenceSliceIndex]!;
        const { pixels, valid } = retainFullySupportedPixels(
          resample2dAreaAverageWithValidity(
            referenceImage.pixels,
            referenceImage.valid,
            referenceImage.rows,
            referenceImage.columns,
            selectedNative.dsRows,
            selectedNative.dsCols,
          ),
        );
        nativeReferenceSlices[nativeReferenceSliceIndex] = { ...selectedNative, pixels, valid };
      }
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
        ...(options.alignmentFocus ? { alignmentFocus: options.alignmentFocus } : {}),
        minCoverage: options.minCoverage,
        signal: options.signal,
      },
      options.signal,
      options.runtime,
    );
    if (!result.ok) return result;
    if ((nativeCandidatePoses?.length ?? 0) > 1 && !result.nativeRefinement) {
      return longitudinalRegistrationFailure(
        'ambiguous',
        'The native worker did not independently adjudicate ambiguous coarse poses',
      );
    }
    if (
      dense.outputGrid &&
      (!result.outputGrid || outputGridFingerprint(result.outputGrid) !== outputGridFingerprint(dense.outputGrid))
    ) {
      return longitudinalRegistrationFailure(
        'invalid-geometry',
        'The native worker returned a different physical output grid',
      );
    }
    const decodedSourceUids = dense.sourceIndices.map((index) => targetManifest.frames[index]!.sopInstanceUid);
    const decodedSourceUidSet = new Set(decodedSourceUids);
    if (result.contributingSourceSopInstanceUids?.some((uid) => !decodedSourceUidSet.has(uid))) {
      return longitudinalRegistrationFailure(
        'invalid-geometry',
        'The native worker returned an unverified contributing source image',
      );
    }
    const contributingSourceUidSet = result.contributingSourceSopInstanceUids
      ? new Set(result.contributingSourceSopInstanceUids)
      : null;
    const contributors = contributingSourceUidSet
      ? decodedSourceUids.filter((uid) => contributingSourceUidSet.has(uid))
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
    return longitudinalRegistrationFailure(
      options.signal?.aborted ? 'cancelled' : 'insufficient-coverage',
      options.signal?.aborted
        ? 'Longitudinal registration cancelled'
        : error instanceof Error
          ? error.message
          : String(error),
    );
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
