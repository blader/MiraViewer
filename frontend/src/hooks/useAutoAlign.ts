import { useState, useCallback, useEffect, useRef } from 'react';
import type { AlignmentReference, AlignmentResult, AlignmentProgress, SeriesRef } from '../types/api';
import { collectBoundedSliceCandidates, computeAlignedSettings, selectFineSliceShortlist } from '../utils/alignment';
import { ALIGNMENT_IMAGE_SIZE, computeHistogramStats } from '../utils/imageCapture';
import { computeMutualInformation } from '../utils/mutualInformation';
import { renderSliceToPixels, type RenderedSlice } from '../utils/cornerstoneSliceCapture';
import { clamp, nowMs } from '../utils/math';
import { fillInvalidWarpWithValidMean } from '../utils/warpAffine';
import { buildStructuralPhaseImageSquare, inpaintExclusionRectSquare } from '../utils/imageFeatures';
import { affineAboutOriginToStandard, composeStandardAffine2D, standardToAffineAboutOrigin } from '../utils/affine2d';
import {
  affineAboutCenterToPanelGeometry,
  panelGeometryToAffineAboutCenter,
  type PanelGeometry,
} from '../utils/panelTransform';
import { isDebugAlignmentEnabled, debugAlignmentLog } from '../utils/debugAlignment';
import {
  recordAlignmentSliceScore,
  resetAlignmentSliceScoreStore,
  type AlignmentFinalAffineProposalMetrics,
  type AlignmentPerceptualStageMetrics,
} from '../utils/alignmentSliceScoreStore';
import type { PhaseCorrection } from '../utils/phaseCorrelation';
import {
  choosePerceptualWinner,
  normalizePerceptualSource,
  rankFixedCandidateSet,
  warpPerceptualCandidateWithValidity,
  type PerceptualComponents,
} from '../utils/perceptualSliceSimilarity';
import {
  composeResidualWithWarpAtSize,
  correctedWarpAtSize,
  expandExclusionRect,
  mapFixedExclusionToMovingBounds,
  type GridSeedTransform,
} from '../utils/alignmentTransform';
import { type FinalAffineProposalKind, type OptimizerFinalAffineProposal } from '../utils/structuralAffineSelection';
import { createAlignmentScoringRunner, type AlignmentScoringRunner } from '../utils/alignmentScoringRunner';
import { assessSliceAlignmentEvidence } from '../utils/alignmentConfidence';
import { rasterizeImageExclusion, selectPhysicalTargetSlice } from '../utils/alignmentGeometry';
import { clearDerivedAlignmentFrames } from '../utils/derivedAlignmentFrame';
import { getSeriesFrameManifest, type SeriesFrameManifest } from '../utils/localApi';
import {
  buildOutputPlaneGrid,
  outputGridFingerprint,
  type OutputGridMode,
  type OutputPlaneGrid,
} from '../utils/outputPlaneGrid';
import {
  densifyLongitudinalRegistration,
  measureLongitudinalPlaneDrift,
  prepareLongitudinalReferenceInput,
  prepareLongitudinalRegistrationInput,
  type PreparedLongitudinalReferenceInput,
} from '../utils/svr/longitudinalFrames';
import { runLongitudinalRegistration } from '../utils/svr/runLongitudinalRegistration';
import { getSliceGeometryFromInstance } from '../utils/svr/dicomGeometry';
import { resample2dAreaAverage, resample2dAreaAverageWithValidity } from '../utils/svr/resample2d';
import { yieldToMain } from '../utils/svr/svrUtils';

const COARSE_IMAGE_SIZE = 128;
const PHASE_SAMPLE_SIZE = 128;
const PHASE_FFT_SIZE = 256;
const PHASE_MAX_CORRECTION_PX = 16;
const COARSE_PERCEPTUAL_SCALES = [128, 64] as const;
const FINE_PERCEPTUAL_SCALES = [256, 128, 64] as const;
const SLICE_SEARCH_YIELD_EVERY_SLICES = 2;

// Optional: constrain the slice search to a window around the best guess.
const SLICE_SEARCH_WINDOW_RADIUS: number = 40;
const FINE_PEAK_COUNT = 5;
const FINE_PEAK_SUPPRESSION_RADIUS = 2;

// Registration perf tuning.
//
const SEED_REGISTRATION_IMAGE_SIZE: number = ALIGNMENT_IMAGE_SIZE;
const SEED_REGISTRATION_RESOLUTIONS = 3;
const REFINEMENT_REGISTRATION_RESOLUTIONS = 3;

type SlicePerceptualCandidate = {
  index: number;
  phase: PhaseCorrection;
  components: PerceptualComponents;
};

class AlignmentCancelledError extends Error {
  constructor() {
    super('Alignment cancelled');
    this.name = 'AlignmentCancelledError';
  }
}

function meanPerceptualComponents(components: PerceptualComponents): number {
  if (components.perScale.length === 0) return 0;
  let sum = 0;
  for (const scale of components.perScale) {
    const structural = (scale.mind + scale.ngf) / 2;
    const appearance = (scale.contrastStructure + scale.lncc) / 2;
    sum += 0.8 * structural + 0.2 * appearance;
  }
  return sum / components.perScale.length;
}

function averageMetric(
  components: PerceptualComponents,
  metric: 'mind' | 'contrastStructure' | 'lncc' | 'ngf',
): number {
  if (components.perScale.length === 0) return 0;
  return components.perScale.reduce((sum, scale) => sum + scale[metric], 0) / components.perScale.length;
}

function averageRawMindDistance(components: PerceptualComponents): number | undefined {
  const distances = components.perScale.flatMap((scale) =>
    scale.rawMindDistance == null ? [] : [scale.rawMindDistance],
  );
  if (distances.length === 0) return undefined;
  return distances.reduce((sum, distance) => sum + distance, 0) / distances.length;
}

function applyBrightnessContrastToPixels(pixels: Float32Array, brightness: number, contrast: number): Float32Array {
  // Mirror the viewer's CSS filter order:
  //   filter: brightness(b) contrast(c)
  // Where b/c are in [0..2] for [0..200] UI.
  const b = brightness / 100;
  const c = contrast / 100;

  const out = new Float32Array(pixels.length);
  for (let i = 0; i < pixels.length; i++) {
    const x = pixels[i] * b;
    const y = (x - 0.5) * c + 0.5;
    out[i] = Math.max(0, Math.min(1, y));
  }
  return out;
}

function supportedRegistrationPixels(pixels: Float32Array, validity?: Float32Array): Float32Array {
  if (!validity) return pixels;
  const supportedPixels = Float32Array.from(
    pixels,
    (value, index) => value * Math.max(0, Math.min(1, validity[index] ?? 0)),
  );
  return fillInvalidWarpWithValidMean({ pixels: supportedPixels, validity });
}

function supportedHistogramStats(pixels: Float32Array, validity?: Float32Array) {
  if (!validity) return computeHistogramStats(pixels);
  return computeHistogramStats(pixels.filter((_value, index) => (validity[index] ?? 0) > 1e-6));
}

export interface AutoAlignState {
  isAligning: boolean;
  progress: AlignmentProgress | null;
  results: AlignmentResult[];
  error: string | null;
}

/**
 * Hook to orchestrate auto-alignment of all dates to a reference.
 */
export function useAutoAlign() {
  const [state, setState] = useState<AutoAlignState>({
    isAligning: false,
    progress: null,
    results: [],
    error: null,
  });

  const abortControllerRef = useRef<AbortController | null>(null);

  useEffect(() => () => abortControllerRef.current?.abort(), []);

  /**
   * Abort the current alignment operation.
   */
  const abort = useCallback(() => abortControllerRef.current?.abort(), []);

  /**
   * Auto-align all target dates to the reference.
   *
   * @param reference - Reference slice metadata + viewer settings (reference pixels are rendered from DICOM)
   * @param targetDates - Array of dates to align (excluding reference date)
   * @param seriesMap - Map of date -> SeriesRef for the current sequence
   * @param currentProgress - Current slice progress (0-1)
   * @returns Array of alignment results
   */
  const alignAllDates = useCallback(
    async (
      reference: AlignmentReference,
      targetDates: string[],
      seriesMap: Record<string, SeriesRef>,
      currentProgress: number,
      options: { outputMode?: OutputGridMode } = {},
    ): Promise<AlignmentResult[]> => {
      abortControllerRef.current?.abort();
      const alignmentAbortController = new AbortController();
      abortControllerRef.current = alignmentAbortController;
      const runId =
        globalThis.crypto?.randomUUID?.() ?? `alignment-${Date.now()}-${Math.random().toString(36).slice(2)}`;
      clearDerivedAlignmentFrames();
      const results: AlignmentResult[] = [];
      const setStateForCurrentRun = (nextState: Parameters<typeof setState>[0]) => {
        if (abortControllerRef.current === alignmentAbortController) setState(nextState);
      };
      const publishResult = (result: AlignmentResult) => {
        results.push(result);
        setStateForCurrentRun((state) => ({ ...state, results: [...results] }));
      };

      setStateForCurrentRun({
        isAligning: true,
        progress: {
          phase: 'capturing',
          currentDate: null,
          dateIndex: 0,
          totalDates: targetDates.length,
          slicesChecked: 0,
          bestMiSoFar: 0,
        },
        results: [],
        error: null,
      });

      let scoringRunner: AlignmentScoringRunner | null = null;
      try {
        // Direct source-pixel capture keeps exhaustive search independent of offscreen display rendering.
        const ensureNotAborted = () => {
          if (alignmentAbortController.signal.aborted) {
            throw new AlignmentCancelledError();
          }
        };
        const captureSlice = async (
          seriesUid: string,
          sliceIndex: number,
          targetSize: number,
        ): Promise<RenderedSlice> => {
          ensureNotAborted();
          const captured = await renderSliceToPixels(seriesUid, sliceIndex, targetSize, {
            signal: alignmentAbortController.signal,
          });
          ensureNotAborted();
          return captured;
        };

        const debugAlignment = isDebugAlignmentEnabled();

        if (debugAlignment)
          console.info('[alignment] Align All started', {
            referenceDate: reference.date,
            referenceSeriesUid: reference.seriesUid,
            referenceSliceIndex: reference.sliceIndex,
            referenceSliceCount: reference.sliceCount,
            targetDates: targetDates.length,
            exclusionMask: reference.exclusionMask ?? null,
            debug: debugAlignment,
          });

        // In-memory store used by the per-cell debug overlay (SSIM/LNCC + MI/NMI breakdown).
        resetAlignmentSliceScoreStore({
          referenceSeriesUid: reference.seriesUid,
          referenceSliceIndex: reference.sliceIndex,
        });

        // Render the reference slice from DICOM directly (identity view space).
        const referenceRender = await captureSlice(reference.seriesUid, reference.sliceIndex, ALIGNMENT_IMAGE_SIZE);

        if (debugAlignment)
          console.info('[alignment] Reference slice rendered', {
            imageId: referenceRender.imageId,
          });
        const referencePixels = referenceRender.pixels;
        const referenceRegistrationPixels = supportedRegistrationPixels(referencePixels, referenceRender.validity);

        // Normalize once in reference source space. Candidate normalization is likewise performed
        // before any seed/phase warp, so overlap cannot change a slice's intensity basis.
        const fineNormalizationExclusion = reference.exclusionMask
          ? expandExclusionRect(reference.exclusionMask, 3 / ALIGNMENT_IMAGE_SIZE)
          : undefined;
        const normalizedReferenceFine = normalizePerceptualSource(referencePixels, ALIGNMENT_IMAGE_SIZE, {
          exclusionRect: fineNormalizationExclusion,
          validity: referenceRender.validity,
        });
        const referenceCoarseRender = await captureSlice(reference.seriesUid, reference.sliceIndex, COARSE_IMAGE_SIZE);
        const referencePixelsCoarse = referenceCoarseRender.pixels;
        scoringRunner = await createAlignmentScoringRunner(
          {
            referenceFinePixels: referencePixels,
            referenceCoarsePixels: referencePixelsCoarse,
            referenceFineValidity: referenceRender.validity,
            referenceCoarseValidity: referenceCoarseRender.validity,
            fineSize: ALIGNMENT_IMAGE_SIZE,
            coarseSize: COARSE_IMAGE_SIZE,
            fineScales: [...FINE_PERCEPTUAL_SCALES],
            coarseScales: [...COARSE_PERCEPTUAL_SCALES],
            phaseFftSize: PHASE_FFT_SIZE,
            phaseMaxCorrectionPx: PHASE_MAX_CORRECTION_PX,
            exclusionMask: reference.exclusionMask,
          },
          alignmentAbortController.signal,
        );

        if (debugAlignment) {
          console.info('[alignment] Perceptual slice-search config', {
            coarseImageSize: COARSE_IMAGE_SIZE,
            coarseScales: COARSE_PERCEPTUAL_SCALES,
            fineScales: FINE_PERCEPTUAL_SCALES,
            phaseInput: 'structural-edge-energy',
            rankFusion: { structural: 0.8, appearance: 0.2 },
            structuralFamilies: ['mind', 'ngf'],
            appearanceFamily: ['contrastStructure', 'lncc'],
            phaseSampleSize: PHASE_SAMPLE_SIZE,
            phaseFftSize: PHASE_FFT_SIZE,
            phaseMaxCorrectionPx: PHASE_MAX_CORRECTION_PX,
            searchWindowRadius: SLICE_SEARCH_WINDOW_RADIUS,
            shortlistPeakCount: FINE_PEAK_COUNT,
            shortlistSuppressionRadius: FINE_PEAK_SUPPRESSION_RADIUS,
          });
        }

        const referenceDisplayedPixels = applyBrightnessContrastToPixels(
          referencePixels.some((value) => value < 0 || value > 1) ? normalizedReferenceFine : referencePixels,
          reference.settings.brightness,
          reference.settings.contrast,
        );
        const referenceDisplayedStats = supportedHistogramStats(referenceDisplayedPixels, referenceRender.validity);
        const referenceManifest: SeriesFrameManifest | null =
          reference.patientKey && reference.studyUid ? await getSeriesFrameManifest(reference.seriesUid) : null;
        const targetManifests = new Map<string, SeriesFrameManifest>();
        let preparedPhysicalReference: Promise<PreparedLongitudinalReferenceInput> | undefined;
        const selectedReferenceFrame = referenceManifest?.frames[reference.sliceIndex];
        const operationOutputGrid: OutputPlaneGrid | null =
          referenceManifest?.geometryReliable && selectedReferenceFrame
            ? buildOutputPlaneGrid(selectedReferenceFrame, {
                mode: options.outputMode ?? 'native',
                frameOfReferenceUid: referenceManifest.frameOfReferenceUid,
              })
            : null;
        const referenceAnalysisPixelSpacing: [number, number] | undefined = operationOutputGrid
          ? [
              operationOutputGrid.fieldOfViewMm[0] / ALIGNMENT_IMAGE_SIZE,
              operationOutputGrid.fieldOfViewMm[1] / ALIGNMENT_IMAGE_SIZE,
            ]
          : undefined;
        const resultIdentity = {
          runId,
          patientKey: reference.patientKey,
          sequenceId: reference.sequenceId,
          referenceSeriesUid: reference.seriesUid,
          datasetRevision: reference.datasetRevision,
        };

        const terminalResult = (
          date: string,
          seriesRef: SeriesRef,
          outcome: NonNullable<AlignmentResult['outcome']>,
          message: string,
        ): AlignmentResult => ({
          date,
          seriesUid: seriesRef.series_uid,
          bestSliceIndex: 0,
          nmiScore: 0,
          computedSettings: reference.settings,
          slicesChecked: 0,
          ...resultIdentity,
          outcome,
          message,
        });

        const alignPhysicalTarget = async (date: string, seriesRef: SeriesRef): Promise<AlignmentResult | null> => {
          if (!referenceManifest || seriesRef.instance_count < 2 || referenceManifest.frames.length < 2) return null;
          const physicalFailure = (outcome: NonNullable<AlignmentResult['outcome']>, message: string) =>
            terminalResult(date, seriesRef, outcome, message);
          const targetManifest = await getSeriesFrameManifest(seriesRef.series_uid);
          targetManifests.set(seriesRef.series_uid, targetManifest);
          if (targetManifest.patientKey !== referenceManifest.patientKey) {
            return physicalFailure('incompatible-geometry', 'Reference and target belong to different patients');
          }
          if (!referenceManifest.geometryReliable || !targetManifest.geometryReliable) {
            return physicalFailure(
              'incompatible-geometry',
              'Reliable patient-space position and orientation are required for safe longitudinal registration',
            );
          }

          const drift = measureLongitudinalPlaneDrift(referenceManifest, targetManifest, {
            referenceSliceIndex: reference.sliceIndex,
            ...(operationOutputGrid ? { outputGrid: operationOutputGrid } : {}),
          });
          const referenceFrame = referenceManifest.frames[reference.sliceIndex];
          const targetAnchor = Math.min(
            targetManifest.frames.length - 1,
            Math.round(
              (reference.sliceIndex / Math.max(1, referenceManifest.frames.length - 1)) *
                Math.max(0, targetManifest.frames.length - 1),
            ),
          );
          const targetFrame = targetManifest.frames[targetAnchor];
          const centerSpacing =
            targetManifest.sliceSpacingMm ??
            targetFrame?.spacingBetweenSlices ??
            targetFrame?.sliceThickness ??
            referenceFrame?.spacingBetweenSlices ??
            referenceFrame?.sliceThickness ??
            1;
          const requiresReslice =
            drift.frameRelationship !== 'same' || drift.maximumThroughPlaneDriftMm > Math.max(0.01, centerSpacing / 2);
          if (!requiresReslice) return null;
          if (!operationOutputGrid) {
            return physicalFailure(
              'incompatible-geometry',
              'The selected reference frame cannot define a reliable physical output grid',
            );
          }

          setStateForCurrentRun((state) => ({
            ...state,
            progress: state.progress
              ? { ...state.progress, currentDate: date, phase: 'computing', slicesChecked: 0 }
              : null,
          }));

          const preparationOptions = {
            signal: alignmentAbortController.signal,
            maxDimension: 96,
            outputMaxDimension: Math.max(operationOutputGrid.rows, operationOutputGrid.columns),
            maxSlices: 48,
            outputGrid: operationOutputGrid,
          };
          preparedPhysicalReference ??= prepareLongitudinalReferenceInput(
            referenceManifest,
            reference.sliceIndex,
            preparationOptions,
          );
          const preparedReference = await preparedPhysicalReference;
          ensureNotAborted();
          const prepared = await prepareLongitudinalRegistrationInput(
            referenceManifest,
            targetManifest,
            reference.sliceIndex,
            {
              ...preparationOptions,
              preparedReference,
            },
          );
          const selectedReference = prepared.referenceSlices[prepared.referenceSliceIndex];
          if (!selectedReference) {
            return physicalFailure('incompatible-geometry', 'Selected physical reference frame is unavailable');
          }
          const exclusion = rasterizeImageExclusion(
            reference.exclusionMask,
            selectedReference.dsRows,
            selectedReference.dsCols,
          );
          // The coarse worker takes ownership of its mask; native refinement needs its own live copy.
          const nativeRefinementExclusion = exclusion ? Uint8Array.from(exclusion) : undefined;
          const coarseRegistration = await runLongitudinalRegistration(
            {
              referenceSlices: prepared.referenceSlices,
              targetSlices: prepared.targetSlices,
              referenceSliceIndex: prepared.referenceSliceIndex,
              referenceExclusionMask: exclusion,
              maxDimension: 96,
              maxSamples: 12_000,
              minCoverage: 0.55,
              deferPresentationValidation: true,
              outputGrid: operationOutputGrid,
              signal: alignmentAbortController.signal,
            },
            alignmentAbortController.signal,
          );
          ensureNotAborted();

          const rejectRegistration = (failed: { reason: string; message: string }): AlignmentResult => {
            const outcome =
              failed.reason === 'insufficient-coverage' || failed.reason === 'insufficient-samples'
                ? 'insufficient-overlap'
                : failed.reason === 'ambiguous' || failed.reason === 'insufficient-evidence'
                  ? 'ambiguous'
                  : failed.reason === 'invalid-geometry'
                    ? 'incompatible-geometry'
                    : failed.reason === 'cancelled'
                      ? 'cancelled'
                      : 'failed';
            return physicalFailure(outcome, failed.message);
          };
          if (!coarseRegistration.ok) return rejectRegistration(coarseRegistration);

          // The registration stack is intentionally sparse and bounded. Once pose is verified,
          // reconstruct the presentation from every acquired native slice intersecting the
          // oblique reference plane so small lesions are not blurred between 4-5 mm samples.
          const registration = await densifyLongitudinalRegistration(
            targetManifest,
            selectedReference,
            coarseRegistration,
            {
              signal: alignmentAbortController.signal,
              maxSlices: 96,
              maxDimension: Math.max(operationOutputGrid.rows, operationOutputGrid.columns),
              minCoverage: 0.55,
              outputGrid: operationOutputGrid,
              referenceManifest,
              referenceSliceIndex: reference.sliceIndex,
              referenceExclusionMask: nativeRefinementExclusion,
            },
          );
          ensureNotAborted();
          if (!registration.ok) {
            return rejectRegistration(registration);
          }
          if (
            registration.rows !== operationOutputGrid.rows ||
            registration.cols !== operationOutputGrid.columns ||
            registration.pixels.length !== operationOutputGrid.rows * operationOutputGrid.columns
          ) {
            return physicalFailure(
              'incompatible-geometry',
              'The derived presentation does not match its verified physical output grid',
            );
          }
          const { pixels, valid, rows, cols, targetToReference, centerMm, diagnostics, nativeRefinement, provenance } =
            registration;
          const { tx, ty, tz, rx, ry, rz } = targetToReference;
          let requiredRegionSupport: number | undefined;
          if (valid && reference.exclusionMask) {
            const protectedRegion = rasterizeImageExclusion(
              reference.exclusionMask,
              operationOutputGrid.rows,
              operationOutputGrid.columns,
            );
            let required = 0;
            let supported = 0;
            for (let index = 0; index < (protectedRegion?.length ?? 0); index++) {
              if (!protectedRegion?.[index]) continue;
              required++;
              if (valid[index]) supported++;
            }
            if (required > 0) {
              requiredRegionSupport = supported / required;
              if (supported < required) {
                return physicalFailure(
                  'insufficient-overlap',
                  'Acquired target anatomy does not fully support the selected lesion region',
                );
              }
            }
          }

          const bestSliceIndex = selectPhysicalTargetSlice(referenceManifest, targetManifest, reference.sliceIndex, {
            rigid: targetToReference,
            centerMm,
            outputGrid: operationOutputGrid,
          });
          const nativeFrame = targetManifest.frames[bestSliceIndex];
          if (!nativeFrame) {
            return physicalFailure('incompatible-geometry', 'Registered frame has no native source identity');
          }
          const resampled = valid
            ? resample2dAreaAverageWithValidity(pixels, valid, rows, cols, ALIGNMENT_IMAGE_SIZE, ALIGNMENT_IMAGE_SIZE)
            : {
                pixels: resample2dAreaAverage(pixels, rows, cols, ALIGNMENT_IMAGE_SIZE, ALIGNMENT_IMAGE_SIZE),
                validity: undefined,
              };
          const normalized = normalizePerceptualSource(resampled.pixels, ALIGNMENT_IMAGE_SIZE, {
            exclusionRect: fineNormalizationExclusion,
            validity: resampled.validity,
          });
          const comparisonSupport =
            resampled.validity || referenceRender.validity
              ? Uint8Array.from(normalized, (_value, index) =>
                  (resampled.validity?.[index] ?? 1) > 1e-6 && (referenceRender.validity?.[index] ?? 1) > 1e-6 ? 1 : 0,
                )
              : undefined;
          const quality = computeMutualInformation(normalizedReferenceFine, normalized, {
            bins: 64,
            inclusionMask: comparisonSupport,
            exclusionRect: reference.exclusionMask,
            imageWidth: ALIGNMENT_IMAGE_SIZE,
            imageHeight: ALIGNMENT_IMAGE_SIZE,
          });
          const computedSettings = computeAlignedSettings(
            referenceDisplayedStats,
            supportedHistogramStats(normalized, resampled.validity),
            bestSliceIndex,
            seriesRef.instance_count,
            currentProgress,
            reference.settings,
          );
          const nativeRivalEvidence = nativeRefinement?.optimizedAlternativeCount ? nativeRefinement : undefined;

          return {
            date,
            seriesUid: seriesRef.series_uid,
            bestSliceIndex,
            nmiScore: quality.nmi,
            computedSettings,
            slicesChecked: diagnostics.presentationSourceFrameCount ?? prepared.targetSourceIndices.length,
            ...resultIdentity,
            patientKey: referenceManifest.patientKey,
            outcome: 'aligned',
            outputGrid: operationOutputGrid,
            evidence: {
              structuralScore: nativeRefinement?.score ?? registration.score,
              runnerUpGap: nativeRivalEvidence?.scoreMargin ?? diagnostics.scoreMargin,
              coverage: registration.coverage,
              geometryMode: 'registered-3d',
              planeAngleDegrees: drift.angleDegrees,
              maximumNativePlaneDriftMm: drift.maximumThroughPlaneDriftMm,
              presentationSliceSpacingMm: diagnostics.presentationSliceSpacingMm,
              presentationSourceFrameCount: diagnostics.presentationSourceFrameCount,
              forwardAnatomicalSupport: nativeRefinement?.forwardCoverage ?? diagnostics.retainedSampleFraction,
              reverseAnatomicalSupport: nativeRefinement?.reverseCoverage ?? diagnostics.reverseRetainedSampleFraction,
              outputPlaneSupport: registration.coverage,
              requiredRegionSupport,
              effectiveSampleCount: nativeRefinement?.sampleCount ?? diagnostics.effectiveSampleCount,
              heldOutSampleCount: nativeRefinement?.heldOutSampleCount,
              effectiveIndependentSamples: nativeRefinement?.effectiveIndependentSamples,
              heldOutEffectiveIndependentSamples: nativeRefinement?.heldOutEffectiveIndependentSamples,
              minimumDistinguishableScoreMargin:
                nativeRivalEvidence?.minimumDistinguishableScoreMargin ?? diagnostics.minimumDistinguishableScoreMargin,
              inverseConsistencyError: diagnostics.inverseConsistencyErrorMm,
              outputGridFingerprint: outputGridFingerprint(operationOutputGrid),
              translationMm: [tx, ty, tz],
              rotationDegrees: [(rx * 180) / Math.PI, (ry * 180) / Math.PI, (rz * 180) / Math.PI],
            },
            derivedFrame: {
              pixels,
              ...(valid ? { valid } : {}),
              rows,
              columns: cols,
              outputGrid: operationOutputGrid,
              ...(registration.contributingSourceSopInstanceUids
                ? { contributingSourceSopInstanceUids: registration.contributingSourceSopInstanceUids }
                : {}),
              sourceImageId: `miradb:${nativeFrame.sopInstanceUid}`,
              referenceStudyUid: referenceManifest.studyUid,
              referenceSeriesUid: referenceManifest.seriesUid,
              referenceSopInstanceUid: referenceFrame?.sopInstanceUid,
              referenceFrameIndex: reference.sliceIndex,
              referenceImagePositionPatient: referenceFrame?.imagePositionPatient,
              referenceImageOrientationPatient: referenceFrame?.imageOrientationPatient,
              referencePixelSpacing: referenceFrame?.pixelSpacing,
              referenceRows: referenceFrame?.rows,
              referenceColumns: referenceFrame?.columns,
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
        };

        // Flip the progress UI to matching now that the reference is ready.
        setStateForCurrentRun((s) => ({
          ...s,
          progress: s.progress ? { ...s.progress, phase: 'matching' } : null,
        }));

        // Keep a web worker + initial transform around as we iterate.
        let sharedWebWorker: Worker | undefined;

        for (let dateIdx = 0; dateIdx < targetDates.length; dateIdx++) {
          ensureNotAborted();

          const date = targetDates[dateIdx];
          const seriesRef = seriesMap[date];

          if (!seriesRef) {
            // No data for this date, skip.
            continue;
          }

          if (referenceManifest) {
            let physicalResult: AlignmentResult | null;
            try {
              physicalResult = await alignPhysicalTarget(date, seriesRef);
            } catch (error) {
              ensureNotAborted();
              physicalResult = terminalResult(
                date,
                seriesRef,
                'failed',
                error instanceof Error ? error.message : 'Physical alignment failed',
              );
            }
            if (physicalResult) {
              ensureNotAborted();
              publishResult(physicalResult);
              /**
               * Yield to the main thread to keep UI responsive during alignment.
               */
              await yieldToMain();
              continue;
            }
          }

          try {
            setStateForCurrentRun((s) => ({
              ...s,
              progress: {
                phase: 'matching',
                currentDate: date,
                dateIndex: dateIdx,
                totalDates: targetDates.length,
                slicesChecked: 0,
                bestMiSoFar: 0,
              },
            }));

            // Yield to keep UI responsive.
            await yieldToMain();

            const targetManifest = targetManifests.get(seriesRef.series_uid);
            const startIdxUnclamped =
              referenceManifest && targetManifest
                ? selectPhysicalTargetSlice(referenceManifest, targetManifest, reference.sliceIndex)
                : Math.round(
                    (reference.sliceIndex / Math.max(1, reference.sliceCount - 1)) * (seriesRef.instance_count - 1),
                  );
            const startIdx = clamp(startIdxUnclamped, 0, Math.max(0, seriesRef.instance_count - 1));

            // Best initial guess: normalized index mapping from reference -> target.
            const seedIdx = startIdx;

            // Reliable shared patient geometry bounds the uncertainty in millimeters. Without
            // physical geometry, a normalized-index prior cannot safely exclude any stack depth.
            const physicalSpacingMm =
              targetManifest?.sliceSpacingMm ??
              targetManifest?.frames[seedIdx]?.spacingBetweenSlices ??
              targetManifest?.frames[seedIdx]?.sliceThickness;
            const coverageDifferenceMm = Math.abs(
              (referenceManifest?.coverageMm ?? 0) - (targetManifest?.coverageMm ?? 0),
            );
            const sliceSearchWindowRadius =
              referenceManifest && targetManifest && physicalSpacingMm && physicalSpacingMm > 0
                ? Math.max(8, Math.ceil((12 + coverageDifferenceMm / 2) / physicalSpacingMm))
                : seriesRef.instance_count > 2 * SLICE_SEARCH_WINDOW_RADIUS
                  ? seriesRef.instance_count - 1
                  : SLICE_SEARCH_WINDOW_RADIUS;
            const sliceSearchMinIndex = clamp(
              seedIdx - sliceSearchWindowRadius,
              0,
              Math.max(0, seriesRef.instance_count - 1),
            );
            const sliceSearchMaxIndex = clamp(
              seedIdx + sliceSearchWindowRadius,
              0,
              Math.max(0, seriesRef.instance_count - 1),
            );

            debugAlignmentLog(
              'date.plan',
              {
                date,
                startIdx,
                seedIdx,
                strategy: {
                  // Slice choice gets only shared rigid freedom plus candidate-specific translation.
                  sliceSearchWarp: true,
                  seedImageSize: SEED_REGISTRATION_IMAGE_SIZE,
                  seedResolutions: SEED_REGISTRATION_RESOLUTIONS,
                  sliceSearchImageSize: COARSE_IMAGE_SIZE,
                  phaseSampleSize: PHASE_SAMPLE_SIZE,
                  phaseMaxCorrectionPx: PHASE_MAX_CORRECTION_PX,
                  sliceSearchWindowRadius,
                  sliceSearchYieldEverySlices: SLICE_SEARCH_YIELD_EVERY_SLICES,
                  refinementImageSize: ALIGNMENT_IMAGE_SIZE,
                  refinementResolutions: REFINEMENT_REGISTRATION_RESOLUTIONS,
                },
                meta: {
                  seriesUid: seriesRef.series_uid,
                  referenceSeriesUid: reference.seriesUid,
                },
              },
              debugAlignment,
            );

            if (debugAlignment)
              console.info('[alignment] Date plan', {
                date,
                seriesUid: seriesRef.series_uid,
                instanceCount: seriesRef.instance_count,
                startIdx,
                seedIdx,
                sliceSearchBounds: {
                  minIndex: sliceSearchMinIndex,
                  maxIndex: sliceSearchMaxIndex,
                },
                seedImageSize: SEED_REGISTRATION_IMAGE_SIZE,
                refinementImageSize: ALIGNMENT_IMAGE_SIZE,
                resolutions: {
                  seed: SEED_REGISTRATION_RESOLUTIONS,
                  refinement: REFINEMENT_REGISTRATION_RESOLUTIONS,
                },
              });

            // 1) Estimate a shared rigid seed. Affine freedom is intentionally deferred until after
            // the slice is selected, so a wrong depth cannot win through shear or anisotropic scale.

            if (debugAlignment)
              console.info('[alignment] Seed registration starting', {
                date,
                seedIdx,
                size: SEED_REGISTRATION_IMAGE_SIZE,
                numberOfResolutions: SEED_REGISTRATION_RESOLUTIONS,
              });

            const seedRender = await captureSlice(seriesRef.series_uid, seedIdx, SEED_REGISTRATION_IMAGE_SIZE);
            const seedFrame = targetManifest?.frames[seedIdx];
            const seedGeometry = seedFrame ? getSliceGeometryFromInstance(seedFrame) : null;
            const movingAnalysisPixelSpacing: [number, number] | undefined = seedGeometry
              ? [
                  (seedGeometry.rows * seedGeometry.rowSpacingMm) / SEED_REGISTRATION_IMAGE_SIZE,
                  (seedGeometry.cols * seedGeometry.colSpacingMm) / SEED_REGISTRATION_IMAGE_SIZE,
                ]
              : undefined;

            // Keep the ITK/Elastix runtime out of first paint and physical 3D-only comparisons.
            // Native import caching gives the whole alignment run one shared registration module.
            const { registerRigid2DWithElastix, registerAffine2DWithElastix } =
              await import('../utils/elastixRegistration');
            ensureNotAborted();
            const tSeed0 = nowMs();
            // The exclusion lives in reference coordinates before a pose exists. Remove its
            // influence from the fixed image immediately; only project it onto the moving
            // image after the first rigid estimate establishes that coordinate relationship.
            const initialFixedPixels = reference.exclusionMask
              ? inpaintExclusionRectSquare(
                  referenceRegistrationPixels,
                  SEED_REGISTRATION_IMAGE_SIZE,
                  expandExclusionRect(reference.exclusionMask, 3 / SEED_REGISTRATION_IMAGE_SIZE),
                  6,
                ).pixels
              : referenceRegistrationPixels;
            const initialSeedReg = await registerRigid2DWithElastix(
              initialFixedPixels,
              supportedRegistrationPixels(seedRender.pixels, seedRender.validity),
              SEED_REGISTRATION_IMAGE_SIZE,
              {
                numberOfResolutions: SEED_REGISTRATION_RESOLUTIONS,
                webWorker: sharedWebWorker,
                signal: alignmentAbortController.signal,
                ...(referenceAnalysisPixelSpacing && movingAnalysisPixelSpacing
                  ? {
                      fixedPixelSpacing: referenceAnalysisPixelSpacing,
                      movingPixelSpacing: movingAnalysisPixelSpacing,
                    }
                  : {}),
              },
            );
            ensureNotAborted();
            sharedWebWorker = initialSeedReg.webWorker;

            let seedTransform: GridSeedTransform = {
              A: initialSeedReg.A,
              translatePx: initialSeedReg.translatePx,
              gridSize: SEED_REGISTRATION_IMAGE_SIZE,
            };
            let seedQualityReg = initialSeedReg;

            // A reference-space exclusion cannot be applied to the unwarped moving seed. When an
            // exclusion exists, first establish pose without it, then estimate a residual rigid on a
            // prewarped image where the same smoothly-inpainted rectangle is geometrically valid.
            if (reference.exclusionMask) {
              const initialWarp = correctedWarpAtSize(
                seedTransform,
                {
                  correctionX: 0,
                  correctionY: 0,
                  sampleGridSize: PHASE_SAMPLE_SIZE,
                  fftSize: PHASE_FFT_SIZE,
                },
                SEED_REGISTRATION_IMAGE_SIZE,
              );
              const prewarpedSeed = warpPerceptualCandidateWithValidity(
                seedRender.pixels,
                SEED_REGISTRATION_IMAGE_SIZE,
                initialWarp,
                seedRender.validity,
              );
              const residualSeedReg = await registerRigid2DWithElastix(
                referenceRegistrationPixels,
                fillInvalidWarpWithValidMean(prewarpedSeed),
                SEED_REGISTRATION_IMAGE_SIZE,
                {
                  numberOfResolutions: SEED_REGISTRATION_RESOLUTIONS,
                  webWorker: sharedWebWorker,
                  exclusionRect: reference.exclusionMask,
                  signal: alignmentAbortController.signal,
                  ...(referenceAnalysisPixelSpacing
                    ? {
                        fixedPixelSpacing: referenceAnalysisPixelSpacing,
                        movingPixelSpacing: referenceAnalysisPixelSpacing,
                      }
                    : {}),
                },
              );
              ensureNotAborted();
              sharedWebWorker = residualSeedReg.webWorker;
              const totalSeedStandard = composeResidualWithWarpAtSize(
                residualSeedReg.movingToFixed,
                initialWarp,
                SEED_REGISTRATION_IMAGE_SIZE,
              );
              const center = (SEED_REGISTRATION_IMAGE_SIZE - 1) / 2;
              const totalSeedAboutCenter = standardToAffineAboutOrigin(totalSeedStandard.A, totalSeedStandard.b, {
                x: center,
                y: center,
              });
              seedTransform = {
                A: totalSeedAboutCenter.A,
                translatePx: totalSeedAboutCenter.t,
                gridSize: SEED_REGISTRATION_IMAGE_SIZE,
              };
              seedQualityReg = residualSeedReg;
            }

            const seedRegistrationMs = nowMs() - tSeed0;

            if (debugAlignment)
              console.info('[alignment] Seed registration finished', {
                date,
                seedIdx,
                nmi: Number(seedQualityReg.quality.nmi.toFixed(4)),
                exclusionAwareResidual: Boolean(reference.exclusionMask),
                registrationMs: Math.round(seedRegistrationMs),
                renderMs: Math.round(seedRender.timingMs.total),
              });

            debugAlignmentLog(
              'seed.perf',
              {
                date,
                seedIdx,
                registrationMs: seedRegistrationMs,
                renderTimingMs: seedRender.timingMs,
              },
              debugAlignment,
            );

            debugAlignmentLog(
              'seed.registration',
              {
                date,
                seedIdx,
                nmi: seedQualityReg.quality.nmi,
                mi: seedQualityReg.quality.mi,
                elastixFinalMetric: seedQualityReg.quality.elastixFinalMetric,
                elastixMetricSamples: seedQualityReg.quality.elastixMetricSamples,
                translatePx: seedTransform.translatePx,
                A: seedTransform.A,
                initial: { A: initialSeedReg.A, translatePx: initialSeedReg.translatePx },
                exclusionAwareResidual: Boolean(reference.exclusionMask),
                render: { imageId: seedRender.imageId },
              },
              debugAlignment,
            );

            // 2) Exhaustively score the bounded window. Phase correlation estimates only the
            // residual translation; aligned local structure decides which slice wins.
            let sliceSearchRenderMs = 0;
            let sliceSearchScoreMs = 0;
            let slicesChecked = 0;
            let provisionalBestScore = 0;
            const progressUpdateMinIntervalMs = 100;
            let lastProgressUpdateMs = 0;
            const scoreCoarseSlice = async (index: number): Promise<SlicePerceptualCandidate> => {
              const rendered = await captureSlice(seriesRef.series_uid, index, COARSE_IMAGE_SIZE);
              sliceSearchRenderMs += rendered.timingMs.total;

              const tScore0 = nowMs();
              const { phase, components } = await scoringRunner!.scoreCoarse(
                rendered.pixels,
                seedTransform,
                rendered.validity,
              );
              sliceSearchScoreMs += nowMs() - tScore0;
              return { index, phase, components };
            };

            if (debugAlignment)
              console.info('[alignment] Slice search starting', {
                date,
                strategy: 'rigid-phase-perceptual',
                referenceSliceIndex: reference.sliceIndex,
                referenceSliceCount: reference.sliceCount,
                targetSliceCount: seriesRef.instance_count,
              });

            const onCoarseScored = (candidate: { index: number; value: SlicePerceptualCandidate }) => {
              slicesChecked++;
              provisionalBestScore = Math.max(
                provisionalBestScore,
                meanPerceptualComponents(candidate.value.components),
              );
              const now = nowMs();
              if (now - lastProgressUpdateMs < progressUpdateMinIntervalMs && slicesChecked !== 1) return;
              lastProgressUpdateMs = now;
              setStateForCurrentRun((s) => ({
                ...s,
                progress: s.progress ? { ...s.progress, slicesChecked, bestMiSoFar: provisionalBestScore } : null,
              }));
            };

            const collectCoarseRange = async (minIndex: number, maxIndex: number, startIndex: number) =>
              await collectBoundedSliceCandidates({
                minIndex,
                maxIndex,
                startIndex,
                scoreSlice: scoreCoarseSlice,
                onScored: onCoarseScored,
                yieldEvery: SLICE_SEARCH_YIELD_EVERY_SLICES,
                yieldFn: yieldToMain,
              });

            const initialCollected = await collectCoarseRange(sliceSearchMinIndex, sliceSearchMaxIndex, seedIdx);
            let coarseCandidates = initialCollected.map((candidate) => candidate.value);
            let rankedCoarse = rankFixedCandidateSet(coarseCandidates, seedIdx);
            const provisionalShortlist = selectFineSliceShortlist(
              rankedCoarse.map((candidate) => ({ index: candidate.index, score: candidate.perceptualRank })),
              seedIdx,
              { peakCount: FINE_PEAK_COUNT, suppressionRadius: FINE_PEAK_SUPPRESSION_RADIUS },
            );

            // A boundary peak is evidence that the prior-centered window may have clipped the mode.
            // Extend each implicated side once, then recompute all ranks over one unified universe.
            const extendLeft =
              provisionalShortlist.peakSelections.some(
                (selection) => selection.index === sliceSearchMinIndex && selection.reason === 'local-peak',
              ) && sliceSearchMinIndex > 0;
            const extendRight =
              provisionalShortlist.peakSelections.some(
                (selection) => selection.index === sliceSearchMaxIndex && selection.reason === 'local-peak',
              ) && sliceSearchMaxIndex < seriesRef.instance_count - 1;
            let finalSearchMinIndex = sliceSearchMinIndex;
            let finalSearchMaxIndex = sliceSearchMaxIndex;
            if (extendLeft) {
              finalSearchMinIndex = Math.max(0, sliceSearchMinIndex - sliceSearchWindowRadius);
              const added = await collectCoarseRange(
                finalSearchMinIndex,
                sliceSearchMinIndex - 1,
                sliceSearchMinIndex - 1,
              );
              coarseCandidates = [...coarseCandidates, ...added.map((candidate) => candidate.value)];
            }
            if (extendRight) {
              finalSearchMaxIndex = Math.min(
                seriesRef.instance_count - 1,
                sliceSearchMaxIndex + sliceSearchWindowRadius,
              );
              const added = await collectCoarseRange(
                sliceSearchMaxIndex + 1,
                finalSearchMaxIndex,
                sliceSearchMaxIndex + 1,
              );
              coarseCandidates = [...coarseCandidates, ...added.map((candidate) => candidate.value)];
            }

            coarseCandidates.sort((a, b) => a.index - b.index);
            rankedCoarse = rankFixedCandidateSet(coarseCandidates, seedIdx);
            const shortlist = selectFineSliceShortlist(
              rankedCoarse.map((candidate) => ({ index: candidate.index, score: candidate.perceptualRank })),
              seedIdx,
              { peakCount: FINE_PEAK_COUNT, suppressionRadius: FINE_PEAK_SUPPRESSION_RADIUS },
            );
            const coarseByIndex = new Map(coarseCandidates.map((candidate) => [candidate.index, candidate]));

            const fineCandidates: SlicePerceptualCandidate[] = [];
            for (const index of shortlist.fineIndices) {
              const coarseCandidate = coarseByIndex.get(index);
              if (!coarseCandidate) continue;
              const rendered = await captureSlice(seriesRef.series_uid, index, ALIGNMENT_IMAGE_SIZE);
              sliceSearchRenderMs += rendered.timingMs.total;
              const tScore0 = nowMs();
              const { components } = await scoringRunner.scoreFine(
                rendered.pixels,
                seedTransform,
                coarseCandidate.phase,
                rendered.validity,
              );
              sliceSearchScoreMs += nowMs() - tScore0;
              fineCandidates.push({ index, phase: coarseCandidate.phase, components });
              await yieldToMain();
              ensureNotAborted();
            }

            const rankedFine = rankFixedCandidateSet(fineCandidates, seedIdx);
            const winningCandidate = choosePerceptualWinner(rankedFine, seedIdx);
            const sliceEvidence = assessSliceAlignmentEvidence({
              winner: winningCandidate,
              candidates: rankedFine,
              normalizedReference: normalizedReferenceFine,
              referenceValidity: referenceRender.validity,
              imageSize: ALIGNMENT_IMAGE_SIZE,
              sliceSpacingMm: physicalSpacingMm,
              exclusionMask: reference.exclusionMask,
            });
            const runnerUpGap = sliceEvidence.runnerUpGap;
            if (sliceEvidence.outcome === 'ambiguous') {
              const ambiguous = terminalResult(
                date,
                seriesRef,
                'ambiguous',
                'Several slices have indistinguishable anatomical evidence; existing image settings were preserved',
              );
              ambiguous.bestSliceIndex = winningCandidate.index;
              ambiguous.slicesChecked = slicesChecked;
              ambiguous.evidence = {
                structuralScore: sliceEvidence.structuralScore,
                runnerUpGap,
                coverage: winningCandidate.components.coverage,
                geometryMode: referenceManifest ? 'physical-2d' : 'fallback-2d',
              };
              publishResult(ambiguous);
              continue;
            }
            if (sliceEvidence.outcome === 'insufficient-overlap') {
              const insufficient = terminalResult(
                date,
                seriesRef,
                'insufficient-overlap',
                'The candidate does not retain enough supported reference anatomy for a safe alignment',
              );
              publishResult(insufficient);
              continue;
            }

            // Preserve both stage-local universes. Fine values become the overlay headline for
            // shortlisted candidates, while the coarse snapshot still explains why they advanced.
            type RankedCandidate = (typeof rankedCoarse)[number];
            const coarseUniverseId = `${date}:coarse:${finalSearchMinIndex}-${finalSearchMaxIndex}`;
            const fineUniverseId = `${date}:fine:${shortlist.fineIndices.join(',')}`;
            const peakReasonByIndex = new Map(
              shortlist.peakSelections.map((selection) => [selection.index, selection.reason]),
            );
            const retentionReason = (
              index: number,
            ): 'local-peak' | 'fallback-fill' | 'peak-neighbor' | 'not-retained' =>
              peakReasonByIndex.get(index) ??
              (shortlist.fineIndices.includes(index) ? 'peak-neighbor' : 'not-retained');
            const buildStageSnapshot = (
              candidate: RankedCandidate,
              stage: 'coarse' | 'fine',
            ): AlignmentPerceptualStageMetrics => ({
              universeId: stage === 'coarse' ? coarseUniverseId : fineUniverseId,
              distanceFromSeed: candidate.index - seedIdx,
              rigidSeed: seedTransform,
              coverage: candidate.components.coverage,
              mindRank: candidate.mindRank,
              appearanceRank: candidate.appearanceRank,
              boundaryRank: candidate.boundaryRank,
              structuralRank: candidate.structuralRank,
              perceptualRank: candidate.perceptualRank,
              mindActive: candidate.mindActive,
              appearanceActive: candidate.appearanceActive,
              boundaryActive: candidate.boundaryActive,
              structuralActive: candidate.structuralActive,
              phaseInput: 'structural-edge-energy',
              correctionX: candidate.phase.correctionX,
              correctionY: candidate.phase.correctionY,
              phasePeak: candidate.phase.peak,
              phasePeakToSidelobeRatio: candidate.phase.peakToSidelobeRatio,
              retentionReason: retentionReason(candidate.index),
              perScale: candidate.components.perScale,
            });
            const recordCandidateDebug = (candidate: RankedCandidate, stage: 'coarse' | 'fine', selected: boolean) => {
              const stageSnapshot = buildStageSnapshot(candidate, stage);
              const { universeId, phasePeak, retentionReason: stageRetentionReason, ...stageMetrics } = stageSnapshot;
              const stageHistory = stage === 'coarse' ? { coarseStage: stageSnapshot } : { fineStage: stageSnapshot };
              const metrics: Parameters<typeof recordAlignmentSliceScore>[2] = {
                ssim: averageMetric(candidate.components, 'contrastStructure'),
                lncc: averageMetric(candidate.components, 'lncc'),
                zncc: candidate.appearanceRank,
                ngf: averageMetric(candidate.components, 'ngf'),
                mind: averageMetric(candidate.components, 'mind'),
                rawMindDistance: averageRawMindDistance(candidate.components),
                census: candidate.boundaryRank,
                phase: phasePeak,
                mi: candidate.components.coverage,
                nmi: candidate.phase.peakToSidelobeRatio,
                score: candidate.perceptualRank,
                stage,
                ...stageMetrics,
                retainedForFine: shortlist.fineIndices.includes(candidate.index),
                selected,
                ...stageHistory,
              };
              recordAlignmentSliceScore(seriesRef.series_uid, candidate.index, metrics);
              debugAlignmentLog(
                'slice-search.score',
                {
                  date,
                  stage,
                  index: candidate.index,
                  distanceFromSeed: candidate.index - seedIdx,
                  rigidSeed: seedTransform,
                  coverage: candidate.components.coverage,
                  perScale: candidate.components.perScale,
                  mindRank: candidate.mindRank,
                  appearanceRank: candidate.appearanceRank,
                  boundaryRank: candidate.boundaryRank,
                  structuralRank: candidate.structuralRank,
                  perceptualRank: candidate.perceptualRank,
                  phaseInput: 'structural-edge-energy',
                  activeFamilies: {
                    mind: candidate.mindActive,
                    appearance: candidate.appearanceActive,
                    boundary: candidate.boundaryActive,
                    structural: candidate.structuralActive,
                  },
                  phase: candidate.phase,
                  phaseCorrectionAtScoringSize: {
                    x:
                      (candidate.phase.correctionX * (stage === 'coarse' ? COARSE_IMAGE_SIZE : ALIGNMENT_IMAGE_SIZE)) /
                      candidate.phase.sampleGridSize,
                    y:
                      (candidate.phase.correctionY * (stage === 'coarse' ? COARSE_IMAGE_SIZE : ALIGNMENT_IMAGE_SIZE)) /
                      candidate.phase.sampleGridSize,
                  },
                  universeId,
                  retentionReason: stageRetentionReason,
                  selected,
                },
                debugAlignment,
              );
              return metrics;
            };
            for (const candidate of rankedCoarse) recordCandidateDebug(candidate, 'coarse', false);
            let winningFineMetrics: Parameters<typeof recordAlignmentSliceScore>[2] | undefined;
            for (const candidate of rankedFine) {
              const selected = candidate.index === winningCandidate.index;
              const metrics = recordCandidateDebug(candidate, 'fine', selected);
              if (selected) winningFineMetrics = metrics;
            }
            if (!winningFineMetrics) throw new Error('Final affine invariant: selected slice diagnostics are missing');

            setStateForCurrentRun((s) => ({
              ...s,
              progress: s.progress
                ? {
                    ...s.progress,
                    slicesChecked,
                    bestMiSoFar: winningCandidate.perceptualRank,
                  }
                : null,
            }));

            if (debugAlignment)
              console.info('[alignment] Slice search finished', {
                date,
                strategy: 'rigid-phase-perceptual',
                bestIndex: winningCandidate.index,
                bestScore: Number(winningCandidate.perceptualRank.toFixed(6)),
                coverage: Number(winningCandidate.components.coverage.toFixed(4)),
                slicesChecked,
                coarseCandidates: coarseCandidates.length,
                fineCandidates: fineCandidates.length,
                windowExtended: { left: extendLeft, right: extendRight },
              });

            debugAlignmentLog(
              'slice-search.perf',
              {
                date,
                strategy: 'rigid-phase-perceptual',
                coarseSize: COARSE_IMAGE_SIZE,
                fineSize: ALIGNMENT_IMAGE_SIZE,
                bounds: {
                  minIndex: finalSearchMinIndex,
                  maxIndex: finalSearchMaxIndex,
                },
                yieldEverySlices: SLICE_SEARCH_YIELD_EVERY_SLICES,
                slicesChecked,
                scoreMs: sliceSearchScoreMs,
                renderMs: sliceSearchRenderMs,
                peakIndices: shortlist.peakIndices,
                peakSelections: shortlist.peakSelections,
                fineIndices: shortlist.fineIndices,
              },
              debugAlignment,
            );

            ensureNotAborted();

            // 3) Refine only the selected slice. The moving image is first prewarped by the winning
            // rigid + phase transform, so Elastix estimates a residual affine instead of restarting.
            setStateForCurrentRun((s) => ({
              ...s,
              progress: s.progress
                ? {
                    ...s.progress,
                    phase: 'computing',
                  }
                : null,
            }));

            if (debugAlignment)
              console.info('[alignment] Refinement starting', { date, bestSliceIndex: winningCandidate.index });

            const bestRender = await captureSlice(seriesRef.series_uid, winningCandidate.index, ALIGNMENT_IMAGE_SIZE);
            const winningWarp = correctedWarpAtSize(seedTransform, winningCandidate.phase, ALIGNMENT_IMAGE_SIZE);
            const prewarpedBest = warpPerceptualCandidateWithValidity(
              bestRender.pixels,
              ALIGNMENT_IMAGE_SIZE,
              winningWarp,
              bestRender.validity,
            );
            const prewarpedBestPixels = fillInvalidWarpWithValidMean(prewarpedBest);

            const tRefine0 = nowMs();
            const sourceStructureExclusion = reference.exclusionMask
              ? mapFixedExclusionToMovingBounds(reference.exclusionMask, winningWarp, ALIGNMENT_IMAGE_SIZE, 3)
              : undefined;
            const normalizedBestForStructure = normalizePerceptualSource(bestRender.pixels, ALIGNMENT_IMAGE_SIZE, {
              exclusionRect: sourceStructureExclusion,
              validity: bestRender.validity,
            });
            const referenceStructure = buildStructuralPhaseImageSquare(
              inpaintExclusionRectSquare(normalizedReferenceFine, ALIGNMENT_IMAGE_SIZE, fineNormalizationExclusion, 6)
                .pixels,
              ALIGNMENT_IMAGE_SIZE,
            );
            const movingStructureSource = buildStructuralPhaseImageSquare(
              inpaintExclusionRectSquare(normalizedBestForStructure, ALIGNMENT_IMAGE_SIZE, sourceStructureExclusion, 6)
                .pixels,
              ALIGNMENT_IMAGE_SIZE,
            );
            const prewarpedMovingStructure = fillInvalidWarpWithValidMean(
              warpPerceptualCandidateWithValidity(
                movingStructureSource,
                ALIGNMENT_IMAGE_SIZE,
                winningWarp,
                bestRender.validity,
              ),
            );

            type OptimizerKind = Exclude<FinalAffineProposalKind, 'seed-only'>;
            const optimizerProposals: OptimizerFinalAffineProposal[] = [];
            const failedOptimizerAttempts: Array<{
              kind: OptimizerKind;
              message: string;
            }> = [];
            const successfulOptimizerQuality: Array<{
              kind: OptimizerKind;
              mi: number;
              nmi: number;
              elastixFinalMetric?: number;
              elastixMetricSamples?: number;
            }> = [];
            const runOptimizerAttempt = async (
              kind: OptimizerKind,
              fixedPixels: Float32Array,
              movingPixels: Float32Array,
            ) => {
              try {
                const registration = await registerAffine2DWithElastix(
                  fixedPixels,
                  movingPixels,
                  ALIGNMENT_IMAGE_SIZE,
                  {
                    numberOfResolutions: REFINEMENT_REGISTRATION_RESOLUTIONS,
                    webWorker: sharedWebWorker,
                    exclusionRect: reference.exclusionMask,
                    signal: alignmentAbortController.signal,
                    ...(referenceAnalysisPixelSpacing
                      ? {
                          fixedPixelSpacing: referenceAnalysisPixelSpacing,
                          movingPixelSpacing: referenceAnalysisPixelSpacing,
                        }
                      : {}),
                  },
                );
                ensureNotAborted();
                sharedWebWorker = registration.webWorker;
                successfulOptimizerQuality.push({
                  kind,
                  mi: registration.quality.mi,
                  nmi: registration.quality.nmi,
                  elastixFinalMetric: registration.quality.elastixFinalMetric,
                  elastixMetricSamples: registration.quality.elastixMetricSamples,
                });
                optimizerProposals.push({
                  kind,
                  residualMovingToFixed: registration.movingToFixed,
                });
              } catch (error) {
                ensureNotAborted();
                sharedWebWorker = undefined;
                failedOptimizerAttempts.push({
                  kind,
                  message: error instanceof Error ? error.message : String(error),
                });
              }
            };

            await runOptimizerAttempt('intensity-elastix', referenceRegistrationPixels, prewarpedBestPixels);
            await runOptimizerAttempt('structure-elastix', referenceStructure, prewarpedMovingStructure);
            ensureNotAborted();

            const finalAffineSelection = await scoringRunner.scoreFinal({
              movingPixels: bestRender.pixels,
              movingValidity: bestRender.validity,
              winningWarp,
              fixedExclusionRect: reference.exclusionMask,
              optimizerProposals,
            });
            ensureNotAborted();
            const selectedProposal = finalAffineSelection.selected;
            const deltaStd = selectedProposal.totalMovingToFixed;
            const origin = { x: (ALIGNMENT_IMAGE_SIZE - 1) / 2, y: (ALIGNMENT_IMAGE_SIZE - 1) / 2 };
            const selectedAboutCenter = standardToAffineAboutOrigin(deltaStd.A, deltaStd.b, origin);
            const selectedWarpedPresentation = warpPerceptualCandidateWithValidity(
              bestRender.pixels,
              ALIGNMENT_IMAGE_SIZE,
              {
                A: selectedAboutCenter.A,
                translateX: selectedAboutCenter.t.x,
                translateY: selectedAboutCenter.t.y,
              },
              bestRender.validity,
            );
            const selectedRawResample = fillInvalidWarpWithValidMean(selectedWarpedPresentation);
            const finalComparisonSupport =
              bestRender.validity || referenceRender.validity
                ? Uint8Array.from(selectedRawResample, (_value, index) =>
                    (selectedWarpedPresentation.validity[index] ?? 0) > 1e-6 &&
                    (referenceRender.validity?.[index] ?? 1) > 1e-6
                      ? 1
                      : 0,
                  )
                : undefined;
            const selectedQuality = computeMutualInformation(referencePixels, selectedRawResample, {
              bins: 64,
              inclusionMask: finalComparisonSupport,
              exclusionRect: reference.exclusionMask,
              imageWidth: ALIGNMENT_IMAGE_SIZE,
              imageHeight: ALIGNMENT_IMAGE_SIZE,
            });
            const refinementMs = nowMs() - tRefine0;

            const failedByKind = new Map(
              failedOptimizerAttempts.map((attempt) => [attempt.kind, attempt.message] as const),
            );
            const selectedByKind = new Map(
              finalAffineSelection.proposals.map((proposal) => [proposal.kind, proposal] as const),
            );
            const finalAffineProposals: AlignmentFinalAffineProposalMetrics[] = [];
            for (const kind of ['seed-only', 'intensity-elastix', 'structure-elastix'] as const) {
              const failureMessage = failedByKind.get(kind as OptimizerKind);
              if (failureMessage) {
                finalAffineProposals.push({ kind, status: 'failed', failureMessage });
                continue;
              }
              const proposal = selectedByKind.get(kind);
              if (!proposal) continue;
              const proposalMetrics = {
                mindScore: proposal.mindScore,
                ngfScore: proposal.ngfScore,
                structuralScore: proposal.structuralScore,
                deformationMagnitude: proposal.deformationMagnitude,
                bidirectionalCoverage: proposal.bidirectionalCoverage,
              };
              if (!proposal.eligible) {
                finalAffineProposals.push({
                  kind,
                  status: 'rejected',
                  rejectionReason: proposal.rejectionReason,
                  ...proposalMetrics,
                });
                continue;
              }
              finalAffineProposals.push({
                kind,
                status: kind === selectedProposal.kind ? 'selected' : 'eligible',
                ...proposalMetrics,
              });
            }
            const seedProposal = finalAffineSelection.proposals.find((proposal) => proposal.kind === 'seed-only');
            if (!seedProposal?.eligible) {
              throw new Error('Final affine invariant: seed-only proposal is not eligible');
            }

            recordAlignmentSliceScore(seriesRef.series_uid, winningCandidate.index, {
              ...winningFineMetrics,
              finalAffineSelected: selectedProposal.kind,
              finalAffineStructuralScore: selectedProposal.structuralScore,
              finalAffineSeedStructuralScore: seedProposal.structuralScore,
              finalAffineProposals,
            });

            if (debugAlignment)
              console.info('[alignment] Refinement finished', {
                date,
                selectedProposal: selectedProposal.kind,
                nmi: Number(selectedQuality.nmi.toFixed(4)),
                refinementMs: Math.round(refinementMs),
                renderMs: Math.round(bestRender.timingMs.total),
              });

            debugAlignmentLog(
              'refine.perf',
              {
                date,
                bestSliceIndex: winningCandidate.index,
                numberOfResolutions: REFINEMENT_REGISTRATION_RESOLUTIONS,
                refinementMs,
                renderTimingMs: bestRender.timingMs,
              },
              debugAlignment,
            );

            debugAlignmentLog(
              'refine.proposals',
              {
                date,
                bestSliceIndex: winningCandidate.index,
                finePerceptualRank: winningCandidate.perceptualRank,
                proposals: finalAffineProposals,
                optimizerQuality: successfulOptimizerQuality,
                selectedQuality: { mi: selectedQuality.mi, nmi: selectedQuality.nmi },
                compositionOrder: 'selectedResidual(winningRigidPlusPhase(originalCandidate))',
              },
              debugAlignment,
            );

            const targetDisplayPixels = selectedRawResample.some((value) => value < 0 || value > 1)
              ? normalizePerceptualSource(selectedRawResample, ALIGNMENT_IMAGE_SIZE, {
                  validity: selectedWarpedPresentation.validity,
                })
              : selectedRawResample;
            const targetStats = supportedHistogramStats(
              targetDisplayPixels,
              bestRender.validity ? selectedWarpedPresentation.validity : undefined,
            );

            // Compose recovered delta onto the reference geometry so the displayed target matches the
            // displayed reference (including reference zoom/rotation/pan and any stored shear).
            const referenceGeometry: PanelGeometry = {
              zoom: reference.settings.zoom,
              rotation: reference.settings.rotation,
              panX: reference.settings.panX,
              panY: reference.settings.panY,
              affine00: reference.settings.affine00,
              affine01: reference.settings.affine01,
              affine10: reference.settings.affine10,
              affine11: reference.settings.affine11,
            };

            const referenceMapping =
              reference.viewportSize && reference.imageSize
                ? { viewportSize: reference.viewportSize, imageSize: reference.imageSize }
                : undefined;
            const targetMapping = referenceMapping
              ? {
                  viewportSize: referenceMapping.viewportSize,
                  imageSize: {
                    width: seriesRef.columns ?? referenceMapping.imageSize.width,
                    height: seriesRef.rows ?? referenceMapping.imageSize.height,
                  },
                }
              : undefined;
            const refAffine = panelGeometryToAffineAboutCenter(
              referenceGeometry,
              ALIGNMENT_IMAGE_SIZE,
              referenceMapping,
            );
            const refStd = affineAboutOriginToStandard(refAffine);

            // Composition order matters:
            // - `deltaStd` maps target -> reference (in the downsampled alignment pixel space)
            // - `refStd` maps reference -> displayed reference
            // To display the *target* in the same view as the reference we want:
            //   displayed = refStd(deltaStd(x_target))
            const composedStd = composeStandardAffine2D(refStd, deltaStd);

            const composedAboutOrigin = standardToAffineAboutOrigin(composedStd.A, composedStd.b, origin);
            const composedGeometry = affineAboutCenterToPanelGeometry(
              { A: composedAboutOrigin.A, translatePx: composedAboutOrigin.t },
              ALIGNMENT_IMAGE_SIZE,
              targetMapping,
            );

            const computedSettings = computeAlignedSettings(
              referenceDisplayedStats,
              targetStats,
              winningCandidate.index,
              seriesRef.instance_count,
              currentProgress,
              composedGeometry,
            );

            debugAlignmentLog(
              'refine.composed-transform',
              {
                date,
                bestSliceIndex: winningCandidate.index,
                winningRigidPlusPhase: winningWarp,
                selectedProposal: selectedProposal.kind,
                residualMovingToFixed: selectedProposal.residualMovingToFixed,
                totalTargetToReference: deltaStd,
                referenceToDisplayed: refStd,
                totalTargetToDisplayed: composedStd,
                computedGeometry: composedGeometry,
                computedSettings,
              },
              debugAlignment,
            );

            const result: AlignmentResult = {
              date,
              seriesUid: seriesRef.series_uid,
              bestSliceIndex: winningCandidate.index,
              nmiScore: selectedQuality.nmi,
              computedSettings,
              slicesChecked,
              ...resultIdentity,
              patientKey: reference.patientKey ?? seriesRef.patient_key,
              outcome: 'aligned',
              evidence: {
                structuralScore: sliceEvidence.structuralScore,
                runnerUpGap,
                coverage: winningCandidate.components.coverage,
                geometryMode: reference.frameOfReferenceUid ? 'physical-2d' : 'fallback-2d',
              },
            };

            ensureNotAborted();
            publishResult(result);

            await yieldToMain();
          } catch (error) {
            ensureNotAborted();
            sharedWebWorker = undefined;
            publishResult(
              terminalResult(
                date,
                seriesRef,
                'failed',
                error instanceof Error ? error.message : 'Alignment failed for this examination',
              ),
            );
          }
        }

        setStateForCurrentRun((s) => ({
          ...s,
          isAligning: false,
          progress: null,
          results,
        }));

        return results;
      } catch (err) {
        const cancelled = err instanceof AlignmentCancelledError || alignmentAbortController.signal.aborted;
        const errorMsg = cancelled ? 'Alignment cancelled' : err instanceof Error ? err.message : 'Alignment failed';
        setStateForCurrentRun((s) => ({
          ...s,
          isAligning: false,
          progress: null,
          error: errorMsg,
        }));
        if (cancelled) return results;
        throw err;
      } finally {
        scoringRunner?.close();
        if (abortControllerRef.current === alignmentAbortController) abortControllerRef.current = null;
      }
    },
    [],
  );

  /**
   * Clear the alignment state.
   */
  const clearState = useCallback(() => {
    setState({
      isAligning: false,
      progress: null,
      results: [],
      error: null,
    });
  }, []);

  return {
    ...state,
    alignAllDates,
    abort,
    clearState,
  };
}
