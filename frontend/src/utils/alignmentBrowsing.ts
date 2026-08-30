import type { AlignmentReference, AlignmentResult, HistogramStats, PanelSettings, SeriesRef } from '../types/api';
import { computeSliceOffset } from './alignment';
import { alignmentDisplayBaseline } from './alignmentAdjustment';
import type { AlignmentDisplayTone } from './alignmentDisplayTone';
import { applyAlignmentSliceOffset } from './alignmentSliceCorrection';
import { selectPhysicalTargetSlice } from './alignmentGeometry';
import {
  affineAboutOriginToStandard,
  composeStandardAffine2D,
  standardToAffineAboutOrigin,
  type StandardAffine2D,
} from './affine2d';
import { getDerivedAlignmentFrameForReference } from './derivedAlignmentFrame';
import { CONTROL_LIMITS, DEFAULT_PANEL_SETTINGS } from './constants';
import { ALIGNMENT_IMAGE_SIZE, computeHistogramStats } from './imageCapture';
import type { SeriesFrameManifest } from './localApi';
import { clamp } from './math';
import { buildOutputPlaneGrid, outputGridFingerprint, type OutputGridMode } from './outputPlaneGrid';
import { affineAboutCenterToPanelGeometry, panelGeometryToAffineAboutCenter } from './panelTransform';
import { densifyLongitudinalRegistration, getLongitudinalReferencePlane } from './svr/longitudinalFrames';
import type { LongitudinalRegistrationEstimate } from './svr/longitudinalRegistration';

/** One accepted scan-pair model; browsing changes its output plane, never its fitted pose or calibration. */
export type PhysicalAlignmentModel = {
  registrationId: string;
  estimate: LongitudinalRegistrationEstimate;
  referenceManifest: SeriesFrameManifest;
  targetManifest: SeriesFrameManifest;
  affine?: StandardAffine2D;
  tone?: AlignmentDisplayTone;
  /** Frozen linear display calibration; no extra retained MRI pixel buffers. */
  fallbackTone?: {
    gain: number;
    bias: number;
    referenceBrightness: number;
    referenceContrast: number;
    brightness: number;
    contrast: number;
  };
};

/** Preserve the accepted CSS match, then compose later reference controls analytically rather than fitting new tissue. */
export function freezeAlignmentFallbackTone(
  reference: Pick<PanelSettings, 'brightness' | 'contrast'>,
  matched: Pick<PanelSettings, 'brightness' | 'contrast'>,
  unadjusted?: { reference: HistogramStats; moving: HistogramStats },
): NonNullable<PhysicalAlignmentModel['fallbackTone']> {
  const referenceGain = (reference.brightness * reference.contrast) / 10_000;
  const referenceBias = (1 - reference.contrast / 100) / 2;
  const matchedGain = (matched.brightness * matched.contrast) / 10_000;
  const matchedBias = (1 - matched.contrast / 100) / 2;
  const gain =
    referenceGain > 1e-10
      ? matchedGain / referenceGain
      : unadjusted && unadjusted.moving.stddev > 1e-10
        ? unadjusted.reference.stddev / unadjusted.moving.stddev
        : 1;
  const bias =
    referenceGain > 1e-10
      ? (matchedBias - referenceBias) / referenceGain
      : unadjusted
        ? unadjusted.reference.mean - gain * unadjusted.moving.mean
        : 0;
  return {
    gain,
    bias,
    referenceBrightness: reference.brightness,
    referenceContrast: reference.contrast,
    brightness: matched.brightness,
    contrast: matched.contrast,
  };
}

export function replayAlignmentFallbackTone(
  tone: NonNullable<PhysicalAlignmentModel['fallbackTone']>,
  reference: Pick<PanelSettings, 'brightness' | 'contrast'>,
) {
  if (reference.brightness === tone.referenceBrightness && reference.contrast === tone.referenceContrast)
    return { brightness: tone.brightness, contrast: tone.contrast };
  const gain = (reference.brightness * reference.contrast) / 10_000;
  const contrast = 1 - 2 * (gain * tone.bias + (1 - reference.contrast / 100) / 2);
  const outputGain = gain * tone.gain;
  // A zero-contrast reference is the constant 0.5 image, not an instruction
  // to restore unmatched anatomy when the equivalent brightness is 0/0.
  if (Math.abs(outputGain) < 1e-10 && Math.abs(contrast) < 1e-10) return { brightness: 100, contrast: 0 };
  const brightness = outputGain / contrast;
  if (!Number.isFinite(brightness) || Math.abs(contrast) < 1e-10) return { brightness: 100, contrast: 100 };
  return {
    brightness: Math.round(clamp(brightness * 100, CONTROL_LIMITS.BRIGHTNESS.MIN, CONTROL_LIMITS.BRIGHTNESS.MAX)),
    contrast: Math.round(clamp(contrast * 100, CONTROL_LIMITS.CONTRAST.MIN, CONTROL_LIMITS.CONTRAST.MAX)),
  };
}

export function applyBrightnessContrastToPixels(pixels: Float32Array, brightness: number, contrast: number) {
  const b = brightness / 100;
  const c = contrast / 100;
  return Float32Array.from(pixels, (value) => Math.max(0, Math.min(1, (value * b - 0.5) * c + 0.5)));
}

export function supportedHistogramStats(pixels: Float32Array, validity?: Float32Array) {
  return computeHistogramStats(validity ? pixels.filter((_value, index) => (validity[index] ?? 0) > 1e-6) : pixels);
}

export function composeReferencePanelGeometry(
  reference: Pick<AlignmentReference, 'settings' | 'viewportSize' | 'imageSize'>,
  movingImageSize: { width: number; height: number },
  movingToReference: StandardAffine2D,
) {
  const referenceMapping =
    reference.viewportSize && reference.imageSize
      ? { viewportSize: reference.viewportSize, imageSize: reference.imageSize }
      : undefined;
  const movingMapping = referenceMapping
    ? { viewportSize: referenceMapping.viewportSize, imageSize: movingImageSize }
    : undefined;
  const referenceToDisplayed = affineAboutOriginToStandard(
    panelGeometryToAffineAboutCenter(reference.settings, ALIGNMENT_IMAGE_SIZE, referenceMapping),
  );
  const movingToDisplayed = composeStandardAffine2D(referenceToDisplayed, movingToReference);
  const origin = { x: (ALIGNMENT_IMAGE_SIZE - 1) / 2, y: (ALIGNMENT_IMAGE_SIZE - 1) / 2 };
  const centered = standardToAffineAboutOrigin(movingToDisplayed.A, movingToDisplayed.b, origin);
  return {
    geometry: affineAboutCenterToPanelGeometry(
      { A: centered.A, translatePx: centered.t },
      ALIGNMENT_IMAGE_SIZE,
      movingMapping,
    ),
    referenceToDisplayed,
    movingToDisplayed,
  };
}

/** Exact accepted-pose rendering: no reference pixel capture, registration search, or new similarity score. */
export async function browseAcceptedAlignment({
  model,
  reference,
  target,
  date,
  progress,
  runId,
  requestKey,
  outputMode = 'native',
  manualSliceOffset = 0,
  signal,
}: {
  model: PhysicalAlignmentModel;
  reference: AlignmentReference;
  target: SeriesRef;
  date: string;
  progress: number;
  runId: string;
  requestKey?: string;
  outputMode?: OutputGridMode;
  manualSliceOffset?: number;
  signal: AbortSignal;
}): Promise<AlignmentResult> {
  signal.throwIfAborted();
  const { referenceManifest, targetManifest } = model;
  const referenceFrame = referenceManifest.frames[reference.sliceIndex];
  if (!referenceFrame || !Number.isFinite(manualSliceOffset)) throw new Error('Invalid aligned browsing plane');
  const identity = {
    date,
    seriesUid: target.series_uid,
    runId,
    requestKey,
    patientKey: reference.patientKey,
    sequenceId: reference.sequenceId,
    datasetRevision: reference.datasetRevision,
    referenceSeriesUid: reference.seriesUid,
    registrationId: model.registrationId,
    manualSliceOffset,
  };
  const failure = (outcome: NonNullable<AlignmentResult['outcome']>, message: string): AlignmentResult => ({
    ...identity,
    bestSliceIndex: 0,
    nmiScore: 0,
    computedSettings: reference.settings,
    slicesChecked: 0,
    outcome,
    message,
  });
  if (
    referenceManifest.seriesUid !== reference.seriesUid ||
    targetManifest.seriesUid !== target.series_uid ||
    referenceManifest.patientKey !== reference.patientKey ||
    targetManifest.patientKey !== reference.patientKey
  )
    return failure('incompatible-geometry', 'The accepted alignment belongs to a different source acquisition');
  const outputGrid = buildOutputPlaneGrid(referenceFrame, {
    mode: outputMode,
    frameOfReferenceUid: referenceManifest.frameOfReferenceUid,
  });
  const cached = getDerivedAlignmentFrameForReference(target.series_uid, {
    ...reference,
    outputMode,
    manualSliceOffset,
  });
  const exact = cached?.registrationId === model.registrationId ? cached.acceptedResult : undefined;
  const settingsFor = (index: number) => {
    const geometry = model.affine
      ? composeReferencePanelGeometry(reference, { width: outputGrid.columns, height: outputGrid.rows }, model.affine)
          .geometry
      : reference.settings;
    if (!model.tone && !model.fallbackTone) throw new Error('The accepted pose has no retained display calibration');
    return {
      ...DEFAULT_PANEL_SETTINGS,
      ...alignmentDisplayBaseline({ ...reference.settings, ...geometry }),
      ...(!model.tone && model.fallbackTone ? replayAlignmentFallbackTone(model.fallbackTone, reference.settings) : {}),
      offset: computeSliceOffset(index, target.instance_count, progress),
      progress,
    };
  };
  if (exact) return { ...exact, ...identity, computedSettings: settingsFor(exact.bestSliceIndex) };

  const estimate = manualSliceOffset
    ? {
        ...model.estimate,
        targetToReference: applyAlignmentSliceOffset(
          targetManifest,
          model.estimate.targetToReference,
          manualSliceOffset,
        ),
      }
    : model.estimate;
  const presentation = await densifyLongitudinalRegistration(
    targetManifest,
    getLongitudinalReferencePlane(
      referenceManifest,
      reference.sliceIndex,
      Math.max(outputGrid.rows, outputGrid.columns),
      signal,
    ),
    estimate,
    {
      outputGrid,
      maxSlices: 96,
      maxDimension: Math.max(outputGrid.rows, outputGrid.columns),
      minCoverage: 0.55,
      refinePose: false,
      signal,
    },
  );
  signal.throwIfAborted();
  if (!presentation.ok) {
    return failure(
      presentation.reason === 'insufficient-coverage' || presentation.reason === 'insufficient-samples'
        ? 'insufficient-overlap'
        : presentation.reason === 'invalid-geometry'
          ? 'incompatible-geometry'
          : presentation.reason === 'cancelled'
            ? 'cancelled'
            : 'failed',
      presentation.message,
    );
  }
  let sameGrid = false;
  try {
    sameGrid = Boolean(
      presentation.outputGrid && outputGridFingerprint(presentation.outputGrid) === outputGridFingerprint(outputGrid),
    );
  } catch {
    // A worker response is not allowed to replace the requested physical grid.
  }
  if (
    !sameGrid ||
    presentation.rows !== outputGrid.rows ||
    presentation.cols !== outputGrid.columns ||
    presentation.pixels.length !== outputGrid.rows * outputGrid.columns ||
    (presentation.valid && presentation.valid.length !== presentation.pixels.length) ||
    (['tx', 'ty', 'tz', 'rx', 'ry', 'rz'] as const).some(
      (key) => presentation.targetToReference?.[key] !== estimate.targetToReference[key],
    ) ||
    (['x', 'y', 'z'] as const).some((key) => presentation.centerMm?.[key] !== estimate.centerMm[key])
  )
    return failure(
      'incompatible-geometry',
      'The browsing pixels do not match the accepted pose and requested output grid',
    );
  const bestSliceIndex = selectPhysicalTargetSlice(referenceManifest, targetManifest, reference.sliceIndex, {
    rigid: estimate.targetToReference,
    centerMm: estimate.centerMm,
    outputGrid,
  });
  const nativeFrame = targetManifest.frames[bestSliceIndex];
  if (!nativeFrame) throw new Error('The aligned browsing plane has no native source identity');
  const { tx, ty, tz, rx, ry, rz } = estimate.targetToReference;
  const { centerMm, provenance } = estimate;
  const { diagnostics } = presentation;
  return {
    ...identity,
    bestSliceIndex,
    // Zero denotes an unscored presentation, never a new similarity assessment.
    nmiScore: 0,
    computedSettings: settingsFor(bestSliceIndex),
    slicesChecked: 0,
    outcome: 'aligned',
    outputGrid,
    evidence: {
      structuralScore: model.estimate.nativeRefinement?.score ?? model.estimate.score,
      runnerUpGap: model.estimate.nativeRefinement?.scoreMargin ?? model.estimate.diagnostics.scoreMargin,
      coverage: presentation.coverage,
      geometryMode: 'registered-3d',
      presentationSliceSpacingMm: diagnostics.presentationSliceSpacingMm,
      presentationSourceFrameCount: diagnostics.presentationSourceFrameCount,
      outputPlaneSupport: presentation.coverage,
      outputGridFingerprint: outputGridFingerprint(outputGrid),
      translationMm: [tx, ty, tz],
      rotationDegrees: [(rx * 180) / Math.PI, (ry * 180) / Math.PI, (rz * 180) / Math.PI],
    },
    derivedFrame: {
      pixels: presentation.pixels,
      valid: presentation.valid,
      rows: presentation.rows,
      columns: presentation.cols,
      displayTone: model.tone,
      outputGrid,
      contributingSourceSopInstanceUids: presentation.contributingSourceSopInstanceUids,
      sourceImageId: `miradb:${nativeFrame.sopInstanceUid}`,
      referenceStudyUid: referenceManifest.studyUid,
      referenceSeriesUid: referenceManifest.seriesUid,
      referenceSopInstanceUid: referenceFrame.sopInstanceUid,
      referenceFrameIndex: reference.sliceIndex,
      referenceImagePositionPatient: referenceFrame.imagePositionPatient,
      referenceImageOrientationPatient: referenceFrame.imageOrientationPatient,
      referencePixelSpacing: referenceFrame.pixelSpacing,
      referenceRows: referenceFrame.rows,
      referenceColumns: referenceFrame.columns,
      targetStudyUid: targetManifest.studyUid,
      targetSopInstanceUid: nativeFrame.sopInstanceUid,
      referenceFrameOfReferenceUid: provenance.referenceFrameOfReferenceUid,
      targetFrameOfReferenceUid: provenance.targetFrameOfReferenceUid,
      rigidTransform: [tx, ty, tz, rx, ry, rz],
      rotationCenterMm: [centerMm.x, centerMm.y, centerMm.z],
      nativeSliceSpacingMm: diagnostics.presentationSliceSpacingMm,
      sourceFrameCount: diagnostics.presentationSourceFrameCount,
    },
  };
}
