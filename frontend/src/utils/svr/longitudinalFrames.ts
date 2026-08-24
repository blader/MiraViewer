import { loadCornerstoneImage, resampleDecodedImage } from '../decodedFrame';
import type { getSeriesFrameManifest } from '../localApi';
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
};

export type PrepareLongitudinalOptions = {
  signal?: AbortSignal;
  maxDimension?: number;
  maxSlices?: number;
  /** Preserve target/source-plane detail for final presentation while scoring stays bounded. */
  outputMaxDimension?: number;
};

export type PreparedDenseLongitudinalResliceInput = Omit<DenseLongitudinalResliceOptions, 'signal'> & {
  sourceIndices: number[];
  sliceSpacingMm: number;
  sourceDepthSpanMm: number;
};

function selectEvenlySpacedIndices(count: number, maximum: number, requiredIndex?: number): number[] {
  if (count <= maximum) return Array.from({ length: count }, (_, index) => index);
  const selected = Array.from({ length: maximum }, (_, index) => Math.round((index * (count - 1)) / (maximum - 1)));
  if (requiredIndex != null && !selected.includes(requiredIndex)) {
    let replace = 1;
    for (let index = 2; index < selected.length - 1; index++) {
      if (Math.abs(selected[index]! - requiredIndex) < Math.abs(selected[replace]! - requiredIndex)) replace = index;
    }
    selected[replace] = requiredIndex;
    selected.sort((a, b) => a - b);
  }
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
    const pixels = resampleDecodedImage(image as Parameters<typeof resampleDecodedImage>[0], rows, cols);

    output.push({
      pixels,
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

  const maxDimension = Math.max(8, Math.min(128, Math.round(options.maxDimension ?? 128)));
  const maxSlices = Math.max(3, Math.min(96, Math.round(options.maxSlices ?? 96)));
  const outputMaxDimension = Math.max(
    maxDimension,
    Math.min(512, Math.round(options.outputMaxDimension ?? maxDimension)),
  );
  const referenceSourceIndices = selectEvenlySpacedIndices(
    referenceManifest.frames.length,
    maxSlices,
    referenceSliceIndex,
  );
  const targetSourceIndices = selectEvenlySpacedIndices(targetManifest.frames.length, maxSlices);

  return {
    referenceSlices: await decodeManifestSlices(
      referenceManifest,
      referenceSourceIndices,
      maxDimension,
      options.signal,
      referenceSliceIndex,
      outputMaxDimension,
    ),
    // Native presentation is decoded only after its accepted rigid pose bounds
    // the intersecting slab; the global scoring stack never needs native pixels.
    targetSlices: await decodeManifestSlices(targetManifest, targetSourceIndices, maxDimension, options.signal),
    referenceSliceIndex: referenceSourceIndices.indexOf(referenceSliceIndex),
    referenceSourceIndices,
    targetSourceIndices,
  };
}

/** Load every native slice physically intersecting the already-registered reference plane. */
export async function prepareDenseLongitudinalResliceInput(
  targetManifest: SeriesFrameManifest,
  selectedReference: SvrReconstructionSlice,
  targetToReference: RigidParams,
  centerMm: Vec3,
  options: { signal?: AbortSignal; maxSlices?: number; maxDimension?: number; minCoverage?: number } = {},
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

  // The coarse worker owns and detaches selectedReference.pixels. Final
  // resampling needs only the immutable geometry of its native reference plane.
  const { pixels: _detachedPixels, ...referencePlane } = selectedReference;
  void _detachedPixels;
  const corners = sliceCornersMm({
    ippMm: referencePlane.ippMm,
    rowDir: referencePlane.rowDir,
    colDir: referencePlane.colDir,
    rowSpacingMm: referencePlane.rowSpacingDsMm,
    colSpacingMm: referencePlane.colSpacingDsMm,
    rows: referencePlane.dsRows,
    cols: referencePlane.dsCols,
  });
  const inverse = invertRigidParams(targetToReference);
  const rotation = mat3FromEulerXYZ(inverse.rx, inverse.ry, inverse.rz);
  const translation = v3(inverse.tx, inverse.ty, inverse.tz);
  const depths = corners.map((corner) =>
    dot(applyRigidToPoint(corner, centerMm, rotation, translation), firstGeometry.normalDir),
  );
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
  const maxDimension = Math.max(8, Math.min(512, Math.round(options.maxDimension ?? 512)));
  const targetSlices = await decodeManifestSlices(targetManifest, sourceIndices, maxDimension, options.signal);
  assertNotAborted(options.signal);

  return {
    targetSlices,
    referencePlane: referencePlane as LongitudinalReferencePlane,
    targetToReference,
    centerMm,
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
  options: { signal?: AbortSignal; maxSlices?: number; maxDimension?: number; minCoverage?: number } = {},
): Promise<LongitudinalRegistrationResult | LongitudinalRegistrationFailure> {
  try {
    const dense = await prepareDenseLongitudinalResliceInput(
      targetManifest,
      selectedReference,
      registration.targetToReference,
      registration.centerMm,
      options,
    );
    const result = await runLongitudinalDenseReslice(
      {
        targetSlices: dense.targetSlices,
        referencePlane: dense.referencePlane,
        targetToReference: dense.targetToReference,
        centerMm: dense.centerMm,
        minCoverage: options.minCoverage,
        signal: options.signal,
      },
      options.signal,
    );
    if (!result.ok) return result;
    return {
      ...registration,
      ...result,
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
): {
  angleDegrees: number;
  maximumThroughPlaneDriftMm: number;
  frameRelationship: 'same' | 'different' | 'unverified';
} {
  const referenceFrame = referenceManifest.frames[0];
  const targetFrame = targetManifest.frames[0];
  if (!referenceFrame || !targetFrame) throw new Error('Plane drift requires a frame from each acquisition');
  const reference = getSliceGeometryFromInstance(referenceFrame);
  const target = getSliceGeometryFromInstance(targetFrame);
  const angle = Math.acos(Math.max(-1, Math.min(1, Math.abs(dot(reference.normalDir, target.normalDir)))));
  const halfFieldMm =
    Math.max((reference.rows - 1) * reference.rowSpacingMm, (reference.cols - 1) * reference.colSpacingMm) / 2;
  const referenceUid = referenceFrame.frameOfReferenceUid ?? referenceManifest.frameOfReferenceUid;
  const targetUid = targetFrame.frameOfReferenceUid ?? targetManifest.frameOfReferenceUid;

  return {
    angleDegrees: (angle * 180) / Math.PI,
    maximumThroughPlaneDriftMm: Math.sin(angle) * halfFieldMm,
    frameRelationship: referenceUid && targetUid ? (referenceUid === targetUid ? 'same' : 'different') : 'unverified',
  };
}
