import { useState, useCallback, useEffect, useRef } from 'react';
import type { AlignmentReference, AlignmentResult, AlignmentProgress, SeriesRef } from '../types/api';
import { collectBoundedSliceCandidates, computeAlignedSettings, selectFineSliceShortlist } from '../utils/alignment';
import { ALIGNMENT_IMAGE_SIZE, computeCorrespondingDisplayStats, windowDisplayPixels } from '../utils/imageCapture';
import {
  applyBrightnessContrastToPixels,
  browseAcceptedAlignment,
  composeReferencePanelGeometry,
  freezeAlignmentFallbackTone,
  supportedHistogramStats,
  type PhysicalAlignmentModel,
} from '../utils/alignmentBrowsing';
import { computeMutualInformation } from '../utils/mutualInformation';
import { renderSliceToPixels, type RenderedSlice } from '../utils/cornerstoneSliceCapture';
import { loadCornerstoneImage } from '../utils/decodedFrame';
import { clamp, nowMs } from '../utils/math';
import { fillInvalidWarpWithValidMean } from '../utils/warpAffine';
import { buildStructuralPhaseImageSquare, inpaintExclusionRectSquare } from '../utils/imageFeatures';
import { standardToAffineAboutOrigin } from '../utils/affine2d';
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
import {
  selectFinalAffineProposal,
  type FinalAffineProposalKind,
  type OptimizerFinalAffineProposal,
} from '../utils/structuralAffineSelection';
import { createAlignmentScoringRunner, type AlignmentScoringRunner } from '../utils/alignmentScoringRunner';
import { assessSliceAlignmentEvidence } from '../utils/alignmentConfidence';
import { rasterizeImageExclusion, selectPhysicalTargetSlice } from '../utils/alignmentGeometry';
import { applyAlignmentSliceOffset } from '../utils/alignmentSliceCorrection';
import {
  getDerivedAlignmentFrame,
  getDerivedAlignmentFrameForReference,
  retainDerivedAlignmentReference,
} from '../utils/derivedAlignmentFrame';
import { getSeriesFrameManifest, type SeriesFrameManifest } from '../utils/localApi';
import {
  buildOutputPlaneGrid,
  outputGridFingerprint,
  validateOutputGridReference,
  type OutputGridMode,
  type OutputPlaneGrid,
} from '../utils/outputPlaneGrid';
import {
  densifyLongitudinalRegistration,
  decodeLongitudinalReferenceFrame,
  measureLongitudinalPlaneDrift,
  prepareLongitudinalReferenceInput,
  prepareLongitudinalRegistrationInput,
  type LongitudinalReferenceAnatomy,
  type PreparedLongitudinalReferenceInput,
} from '../utils/svr/longitudinalFrames';
import { runLongitudinalRegistration } from '../utils/svr/runLongitudinalRegistration';
import { getSliceGeometryFromInstance } from '../utils/svr/dicomGeometry';
import {
  resample2dAreaAverage,
  resample2dAreaAverageWithValidity,
  retainFullySupportedPixels,
} from '../utils/svr/resample2d';
import { yieldToMain } from '../utils/svr/svrUtils';
import { applyAlignmentDisplayTone, createAlignmentDisplayTone } from '../utils/alignmentDisplayTone';

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

function supportedRegistrationPixels(pixels: Float32Array, validity?: Float32Array): Float32Array {
  if (!validity) return pixels;
  const supportedPixels = Float32Array.from(
    pixels,
    (value, index) => value * Math.max(0, Math.min(1, validity[index] ?? 0)),
  );
  return fillInvalidWarpWithValidMean({ pixels: supportedPixels, validity });
}

export interface AutoAlignState {
  requestKey?: string;
  isAligning: boolean;
  progress: AlignmentProgress | null;
  results: AlignmentResult[];
  error: string | null;
}

function physicalRegistrationKey(
  reference: AlignmentReference,
  target: SeriesRef,
  outputMode: OutputGridMode = 'native',
) {
  return JSON.stringify([
    reference.patientKey,
    reference.sequenceId,
    reference.datasetRevision,
    reference.seriesUid,
    target.series_uid,
    reference.sliceCount,
    target.instance_count,
    outputMode,
  ]);
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
  const physicalRegistrationsRef = useRef(new Map<string, PhysicalAlignmentModel>());
  const clearRegistrationCache = useCallback(() => physicalRegistrationsRef.current.clear(), []);
  const canReuseRegistration = useCallback(
    (
      reference: AlignmentReference,
      dates: readonly string[],
      series: Record<string, SeriesRef>,
      outputMode?: OutputGridMode,
    ) =>
      !reference.exclusionMask &&
      !getDerivedAlignmentFrame(reference.seriesUid, reference.sliceIndex) &&
      dates.length > 0 &&
      dates.some((date) => {
        const target = series[date];
        return target && physicalRegistrationsRef.current.has(physicalRegistrationKey(reference, target, outputMode));
      }),
    [],
  );

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
      selectedReference: AlignmentReference,
      targetDates: string[],
      seriesMap: Record<string, SeriesRef>,
      currentProgress: number,
      options: {
        outputMode?: OutputGridMode;
        requestKey?: string;
        reuseRegistration?: boolean;
        targetSliceOffsets?: ReadonlyMap<string, number>;
      } = {},
    ): Promise<AlignmentResult[]> => {
      abortControllerRef.current?.abort();
      const alignmentAbortController = new AbortController();
      abortControllerRef.current = alignmentAbortController;
      const runId =
        globalThis.crypto?.randomUUID?.() ?? `alignment-${Date.now()}-${Math.random().toString(36).slice(2)}`;
      let reference = selectedReference;
      const displayedDerivedReference = getDerivedAlignmentFrame(
        selectedReference.seriesUid,
        selectedReference.sliceIndex,
      );
      const releaseDisplayedReference = displayedDerivedReference
        ? retainDerivedAlignmentReference(displayedDerivedReference)
        : undefined;
      const results: AlignmentResult[] = [];
      const setStateForCurrentRun = (nextState: Parameters<typeof setState>[0]) => {
        if (abortControllerRef.current === alignmentAbortController) setState(nextState);
      };
      const publishResult = (result: AlignmentResult) => {
        results.push(result);
        setStateForCurrentRun((state) => ({ ...state, results: [...results] }));
      };

      setStateForCurrentRun({
        requestKey: options.requestKey,
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
        const reusable =
          options.reuseRegistration && !reference.exclusionMask && !displayedDerivedReference
            ? targetDates.flatMap((date) => {
                const target = seriesMap[date];
                if (!target || target.series_uid === reference.seriesUid) return [];
                const key = physicalRegistrationKey(reference, target, options.outputMode);
                const model = physicalRegistrationsRef.current.get(key);
                // An unsupported anchor may still need display calibration. A
                // retained pre-update hook may also lack manifests; the ordinary
                // path fills them while preserving its already accepted pose.
                if (
                  !model?.referenceManifest ||
                  !model.targetManifest ||
                  (!model.tone &&
                    (!model.fallbackTone ||
                      !Number.isFinite(model.fallbackTone.gain) ||
                      !Number.isFinite(model.fallbackTone.bias)))
                )
                  return [];
                const exact = getDerivedAlignmentFrameForReference(target.series_uid, {
                  ...reference,
                  outputMode: options.outputMode ?? 'native',
                  manualSliceOffset: options.targetSliceOffsets?.get(date) ?? 0,
                });
                return [{ key, date, target, model, exact: exact?.registrationId === model.registrationId }];
              })
            : [];
        // Publish resident planes first, even when a different date needs source
        // I/O or a new registration. Dense source slabs remain bounded/serial.
        reusable.sort((first, second) => Number(second.exact) - Number(first.exact));
        for (const { key, date, target, model } of reusable) {
          ensureNotAborted();
          setStateForCurrentRun((state) => ({
            ...state,
            progress: state.progress ? { ...state.progress, phase: 'computing', currentDate: date } : null,
          }));
          let replay: AlignmentResult;
          try {
            replay = await browseAcceptedAlignment({
              model,
              reference,
              target,
              date,
              progress: currentProgress,
              runId,
              requestKey: options.requestKey,
              outputMode: options.outputMode,
              manualSliceOffset: options.targetSliceOffsets?.get(date) ?? 0,
              signal: alignmentAbortController.signal,
            });
          } catch (error) {
            ensureNotAborted();
            replay = {
              date,
              seriesUid: target.series_uid,
              bestSliceIndex: 0,
              nmiScore: 0,
              computedSettings: reference.settings,
              slicesChecked: 0,
              runId,
              requestKey: options.requestKey,
              patientKey: reference.patientKey,
              sequenceId: reference.sequenceId,
              referenceSeriesUid: reference.seriesUid,
              datasetRevision: reference.datasetRevision,
              manualSliceOffset: options.targetSliceOffsets?.get(date) ?? 0,
              outcome: 'failed',
              message: error instanceof Error ? error.message : 'Aligned slice could not be loaded',
            };
          }
          ensureNotAborted();
          if (physicalRegistrationsRef.current.get(key) !== model) throw new AlignmentCancelledError();
          if (replay.outcome === 'aligned') {
            // A frequently browsed pair remains hot without replacing its model
            // or reviving a registration invalidated during the image load.
            physicalRegistrationsRef.current.delete(key);
            physicalRegistrationsRef.current.set(key, model);
          }
          publishResult(replay);
        }
        const reusedDates = new Set(reusable.map(({ date }) => date));
        const remainingTargetDates = targetDates.filter((date) => !reusedDates.has(date));
        if (!remainingTargetDates.length) {
          setStateForCurrentRun((state) => ({ ...state, isAligning: false, progress: null, results }));
          return results;
        }
        if (reusable.length) {
          // Browsing the known scans does not wait for this quiet interval. An
          // unknown scan's expensive search starts only after navigation settles.
          await new Promise<void>((resolve) => {
            const done = () => {
              window.clearTimeout(timer);
              alignmentAbortController.signal.removeEventListener('abort', done);
              resolve();
            };
            const timer = window.setTimeout(done, 650);
            alignmentAbortController.signal.addEventListener('abort', done, { once: true });
            if (alignmentAbortController.signal.aborted) done();
          });
          ensureNotAborted();
        }
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

        let verifiedReferenceManifest: SeriesFrameManifest | undefined;
        let referenceAnatomy: LongitudinalReferenceAnatomy | undefined;
        if (displayedDerivedReference) {
          const originalSeriesUid = displayedDerivedReference.referenceSeriesUid;
          const originalSliceIndex = displayedDerivedReference.referenceFrameIndex;
          const displayedGrid = displayedDerivedReference.outputGrid;
          if (
            !reference.patientKey ||
            !reference.sequenceId ||
            reference.datasetRevision === undefined ||
            displayedDerivedReference.patientKey !== reference.patientKey ||
            displayedDerivedReference.sequenceId !== reference.sequenceId ||
            displayedDerivedReference.datasetRevision !== reference.datasetRevision ||
            !reference.studyUid ||
            displayedDerivedReference.targetStudyUid !== reference.studyUid ||
            !originalSeriesUid ||
            !displayedDerivedReference.referenceStudyUid ||
            !displayedDerivedReference.referenceSopInstanceUid ||
            !Number.isSafeInteger(originalSliceIndex) ||
            !displayedGrid ||
            displayedDerivedReference.rows !== displayedGrid.rows ||
            displayedDerivedReference.columns !== displayedGrid.columns ||
            displayedDerivedReference.pixels.length !== displayedGrid.rows * displayedGrid.columns ||
            (displayedDerivedReference.valid &&
              displayedDerivedReference.valid.length !== displayedDerivedReference.pixels.length)
          ) {
            throw new Error(
              'The selected aligned reference lacks verified patient, examination, dataset, or acquired-plane provenance',
            );
          }

          const displayedManifest = await getSeriesFrameManifest(selectedReference.seriesUid);
          ensureNotAborted();
          const displayedNativeFrame = displayedManifest.frames[selectedReference.sliceIndex];
          if (displayedManifest.patientKey !== reference.patientKey) {
            throw new Error('The selected aligned reference belongs to a different patient');
          }
          if (
            !displayedManifest.geometryReliable ||
            displayedManifest.studyUid !== reference.studyUid ||
            !displayedNativeFrame ||
            displayedNativeFrame.sopInstanceUid !== displayedDerivedReference.targetSopInstanceUid ||
            displayedDerivedReference.sourceImageId !== `miradb:${displayedNativeFrame.sopInstanceUid}` ||
            (displayedDerivedReference.targetFrameOfReferenceUid &&
              displayedDerivedReference.targetFrameOfReferenceUid !==
                (displayedNativeFrame.frameOfReferenceUid ?? displayedManifest.frameOfReferenceUid))
          ) {
            throw new Error(
              'The selected aligned reference no longer matches its acquired examination or source frame',
            );
          }

          verifiedReferenceManifest = await getSeriesFrameManifest(originalSeriesUid);
          ensureNotAborted();
          if (verifiedReferenceManifest.patientKey !== reference.patientKey) {
            throw new Error('The selected aligned reference and its acquired anchor belong to different patients');
          }
          const originalFrame = verifiedReferenceManifest.frames[originalSliceIndex!];
          if (
            verifiedReferenceManifest.studyUid !== displayedDerivedReference.referenceStudyUid ||
            !verifiedReferenceManifest.geometryReliable ||
            !originalFrame ||
            originalFrame.sopInstanceUid !== displayedDerivedReference.referenceSopInstanceUid ||
            (displayedDerivedReference.referenceFrameOfReferenceUid &&
              displayedDerivedReference.referenceFrameOfReferenceUid !==
                (originalFrame.frameOfReferenceUid ?? verifiedReferenceManifest.frameOfReferenceUid))
          ) {
            throw new Error('The selected aligned reference no longer matches its verified acquired physical anchor');
          }
          validateOutputGridReference(displayedGrid, originalFrame, verifiedReferenceManifest.frameOfReferenceUid);
          const rigidTransform = displayedDerivedReference.rigidTransform;
          const rotationCenterMm = displayedDerivedReference.rotationCenterMm;
          if (
            !rigidTransform ||
            rigidTransform.length !== 6 ||
            rigidTransform.some((value) => !Number.isFinite(value)) ||
            !rotationCenterMm ||
            rotationCenterMm.length !== 3 ||
            rotationCenterMm.some((value) => !Number.isFinite(value))
          ) {
            throw new Error('The selected aligned reference lacks a verified rigid transform into its acquired anchor');
          }
          referenceAnatomy = {
            manifest: displayedManifest,
            sourceIndex: selectedReference.sliceIndex,
            rigidTransform,
            rotationCenterMm,
          };

          // The selected examination supplies the visible tissue and panel settings. Its original
          // acquired anchor remains the sole verified authority for the shared physical plane.
          reference = {
            ...reference,
            seriesUid: verifiedReferenceManifest.seriesUid,
            sliceIndex: originalSliceIndex!,
            sliceCount: verifiedReferenceManifest.frames.length,
            studyUid: verifiedReferenceManifest.studyUid,
            frameOfReferenceUid: verifiedReferenceManifest.frameOfReferenceUid,
            imageSize: { width: displayedDerivedReference.columns, height: displayedDerivedReference.rows },
          };
        }

        const captureReferenceSlice = async (targetSize: number): Promise<RenderedSlice> => {
          if (!displayedDerivedReference) return captureSlice(reference.seriesUid, reference.sliceIndex, targetSize);
          ensureNotAborted();
          const started = nowMs();
          const captured = displayedDerivedReference.valid
            ? resample2dAreaAverageWithValidity(
                displayedDerivedReference.pixels,
                displayedDerivedReference.valid,
                displayedDerivedReference.rows,
                displayedDerivedReference.columns,
                targetSize,
                targetSize,
              )
            : {
                pixels: resample2dAreaAverage(
                  displayedDerivedReference.pixels,
                  displayedDerivedReference.rows,
                  displayedDerivedReference.columns,
                  targetSize,
                  targetSize,
                ),
              };
          ensureNotAborted();
          const elapsed = nowMs() - started;
          return {
            ...captured,
            imageId: displayedDerivedReference.imageId,
            timingMs: { getImageId: 0, loadImage: 0, capture: elapsed, total: elapsed },
          };
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
        resetAlignmentSliceScoreStore();

        // Score the exact visible reference tissue while preserving its acquired physical-plane authority.
        const referenceRender = await captureReferenceSlice(ALIGNMENT_IMAGE_SIZE);

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
        const protectedStructure = (pixels: Float32Array, exclusion: AlignmentReference['exclusionMask']) =>
          buildStructuralPhaseImageSquare(
            inpaintExclusionRectSquare(pixels, ALIGNMENT_IMAGE_SIZE, exclusion, 6).pixels,
            ALIGNMENT_IMAGE_SIZE,
          );
        let cachedReferenceStructure: Float32Array | undefined;
        const getReferenceStructure = () =>
          (cachedReferenceStructure ??= protectedStructure(normalizedReferenceFine, fineNormalizationExclusion));
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

        const referenceManifest: SeriesFrameManifest | null =
          verifiedReferenceManifest ??
          (reference.patientKey && reference.studyUid ? await getSeriesFrameManifest(reference.seriesUid) : null);
        const referenceDisplayFrame =
          referenceRender.windowWidth !== undefined
            ? referenceRender
            : (referenceAnatomy?.manifest.frames[referenceAnatomy.sourceIndex] ??
              referenceManifest?.frames[reference.sliceIndex]);
        const derivedReferenceWindow = displayedDerivedReference?.displayTone?.referenceWindow
          ? await loadCornerstoneImage(`miradb:${displayedDerivedReference.referenceSopInstanceUid}`)
          : undefined;
        ensureNotAborted();
        const referenceWindowedPixels =
          (displayedDerivedReference?.displayTone
            ? Float32Array.from(referencePixels, (value) => {
                const displayed = applyAlignmentDisplayTone(
                  value,
                  displayedDerivedReference.displayTone!,
                  derivedReferenceWindow,
                );
                return derivedReferenceWindow?.invert ? 1 - displayed : displayed;
              })
            : windowDisplayPixels(referencePixels, referenceDisplayFrame)) ??
          (referencePixels.some((value) => value < 0 || value > 1) ? normalizedReferenceFine : referencePixels);
        const referenceDisplayedPixels = applyBrightnessContrastToPixels(
          referenceWindowedPixels,
          reference.settings.brightness,
          reference.settings.contrast,
        );
        const referenceDisplayedStats = supportedHistogramStats(referenceDisplayedPixels, referenceRender.validity);
        const pairedDisplayStats = (pixels: Float32Array | null, validity?: Float32Array) =>
          pixels &&
          computeCorrespondingDisplayStats(referenceDisplayedPixels, pixels, {
            referenceValidity: referenceRender.validity,
            movingValidity: validity,
            exclusionRect: reference.exclusionMask,
            columns: ALIGNMENT_IMAGE_SIZE,
          });
        const targetManifests = new Map<string, SeriesFrameManifest>();
        let preparedPhysicalReference: Promise<PreparedLongitudinalReferenceInput> | undefined;
        const selectedReferenceFrame = referenceManifest?.frames[reference.sliceIndex];
        const operationOutputGrid: OutputPlaneGrid | null =
          displayedDerivedReference?.outputGrid &&
          (!options.outputMode || options.outputMode === displayedDerivedReference.outputGrid.mode)
            ? displayedDerivedReference.outputGrid
            : referenceManifest?.geometryReliable && selectedReferenceFrame
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
          ...(options.requestKey ? { requestKey: options.requestKey } : {}),
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
          manualSliceOffset: options.targetSliceOffsets?.get(date) ?? 0,
          outcome,
          message,
        });

        const alignPhysicalTarget = async (date: string, seriesRef: SeriesRef): Promise<AlignmentResult | null> => {
          if (!referenceManifest || seriesRef.instance_count < 2 || referenceManifest.frames.length < 2) return null;
          const manualSliceOffset = options.targetSliceOffsets?.get(date) ?? 0;
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
            options.reuseRegistration ||
            manualSliceOffset !== 0 ||
            drift.frameRelationship !== 'same' ||
            drift.maximumThroughPlaneDriftMm > Math.max(0.01, centerSpacing / 2);
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
            ...(referenceAnatomy ? { referenceAnatomy } : {}),
          };
          const registrationKey =
            options.reuseRegistration && !reference.exclusionMask && !displayedDerivedReference
              ? physicalRegistrationKey(reference, seriesRef, options.outputMode)
              : null;
          const cached = registrationKey ? physicalRegistrationsRef.current.get(registrationKey) : undefined;
          const prepared = cached
            ? null
            : await (async () => {
                preparedPhysicalReference ??= prepareLongitudinalReferenceInput(
                  referenceManifest,
                  reference.sliceIndex,
                  {
                    ...preparationOptions,
                    selectInformativeReference: Boolean(registrationKey),
                  },
                );
                const preparedReference = await preparedPhysicalReference;
                ensureNotAborted();
                return prepareLongitudinalRegistrationInput(
                  referenceManifest,
                  targetManifest,
                  preparedReference.referenceSourceIndex ?? reference.sliceIndex,
                  {
                    ...preparationOptions,
                    outputGrid: preparedReference.outputGrid ?? operationOutputGrid,
                    preparedReference,
                  },
                );
              })();
          const estimationSliceIndex =
            prepared && registrationKey
              ? prepared.referenceSourceIndices[prepared.referenceSliceIndex]!
              : reference.sliceIndex;
          const estimationGrid = prepared?.outputGrid ?? operationOutputGrid;
          let selectedReference = cached
            ? await decodeLongitudinalReferenceFrame(
                referenceManifest,
                reference.sliceIndex,
                Math.max(operationOutputGrid.rows, operationOutputGrid.columns),
                alignmentAbortController.signal,
              )
            : prepared?.referenceSlices[prepared.referenceSliceIndex];
          if (!selectedReference) {
            return physicalFailure('incompatible-geometry', 'Selected physical reference frame is unavailable');
          }
          let referenceSlices = prepared?.referenceSlices ?? [selectedReference];
          let referenceImage:
            | {
                pixels: Float32Array;
                valid: Uint8Array;
                rows: number;
                columns: number;
                outputGrid: OutputPlaneGrid;
              }
            | undefined;
          if (displayedDerivedReference) {
            const sourceValidity =
              displayedDerivedReference.valid ?? new Uint8Array(displayedDerivedReference.pixels.length).fill(1);
            const copyDisplayedReference = (rows: number, columns: number) => {
              if (rows === displayedDerivedReference.rows && columns === displayedDerivedReference.columns) {
                const pixels = Float32Array.from(displayedDerivedReference.pixels);
                const valid = Uint8Array.from(sourceValidity);
                for (let index = 0; index < valid.length; index++) {
                  if (!valid[index]) pixels[index] = 0;
                }
                return {
                  pixels,
                  valid,
                };
              }
              return retainFullySupportedPixels(
                resample2dAreaAverageWithValidity(
                  displayedDerivedReference.pixels,
                  sourceValidity,
                  displayedDerivedReference.rows,
                  displayedDerivedReference.columns,
                  rows,
                  columns,
                ),
              );
            };
            selectedReference = {
              ...selectedReference,
              ...copyDisplayedReference(selectedReference.dsRows, selectedReference.dsCols),
            };
            referenceSlices = [...referenceSlices];
            referenceSlices[prepared!.referenceSliceIndex] = selectedReference;
            referenceImage = {
              ...copyDisplayedReference(operationOutputGrid.rows, operationOutputGrid.columns),
              rows: operationOutputGrid.rows,
              columns: operationOutputGrid.columns,
              outputGrid: operationOutputGrid,
            };
          }
          const exclusion = rasterizeImageExclusion(
            reference.exclusionMask,
            selectedReference.dsRows,
            selectedReference.dsCols,
          );
          // The coarse worker takes ownership of its mask; native refinement needs its own live copy.
          const nativeRefinementExclusion = exclusion ? Uint8Array.from(exclusion) : undefined;
          // Workers transfer their inputs. Keep a small independent calibration image
          // from the informative plane, never from a blank browsing position.
          const calibrationReference =
            (registrationKey || manualSliceOffset !== 0) && !cached
              ? resample2dAreaAverageWithValidity(
                  selectedReference.pixels,
                  selectedReference.valid ?? new Uint8Array(selectedReference.pixels.length).fill(1),
                  selectedReference.dsRows,
                  selectedReference.dsCols,
                  ALIGNMENT_IMAGE_SIZE,
                  ALIGNMENT_IMAGE_SIZE,
                )
              : null;
          const coarseRegistration =
            cached?.estimate ??
            (await runLongitudinalRegistration(
              {
                referenceSlices,
                targetSlices: prepared!.targetSlices,
                referenceSliceIndex: prepared!.referenceSliceIndex,
                referenceExclusionMask: exclusion,
                maxDimension: 96,
                maxSamples: 12_000,
                minCoverage: 0.55,
                deferPresentationValidation: true,
                outputGrid: estimationGrid,
                signal: alignmentAbortController.signal,
              },
              alignmentAbortController.signal,
            ));
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
          // A warm model needs only the corrected presentation. A cold model must
          // first refine and calibrate unadjusted anatomy before applying user intent.
          const presentationEstimate =
            cached && manualSliceOffset !== 0
              ? {
                  ...coarseRegistration,
                  targetToReference: applyAlignmentSliceOffset(
                    targetManifest,
                    coarseRegistration.targetToReference,
                    manualSliceOffset,
                  ),
                }
              : coarseRegistration;
          const estimatedRegistration = await densifyLongitudinalRegistration(
            targetManifest,
            selectedReference,
            presentationEstimate,
            {
              signal: alignmentAbortController.signal,
              maxSlices: 96,
              maxDimension: Math.max(operationOutputGrid.rows, operationOutputGrid.columns),
              minCoverage: 0.55,
              outputGrid: estimationGrid,
              referenceManifest,
              referenceSliceIndex: estimationSliceIndex,
              referenceExclusionMask: nativeRefinementExclusion,
              refinePose: !cached,
              ...(reference.alignmentFocus === 'tumor' && !displayedDerivedReference
                ? { alignmentFocus: 'tumor' as const }
                : {}),
              ...(referenceImage ? { referenceImage } : {}),
              ...(referenceAnatomy ? { referenceAnatomy } : {}),
            },
          );
          ensureNotAborted();
          if (!estimatedRegistration.ok) return rejectRegistration(estimatedRegistration);
          const presentation =
            estimationSliceIndex === reference.sliceIndex && (cached || manualSliceOffset === 0)
              ? estimatedRegistration
              : await densifyLongitudinalRegistration(
                  targetManifest,
                  estimationSliceIndex === reference.sliceIndex
                    ? selectedReference
                    : await decodeLongitudinalReferenceFrame(
                        referenceManifest,
                        reference.sliceIndex,
                        Math.max(operationOutputGrid.rows, operationOutputGrid.columns),
                        alignmentAbortController.signal,
                      ),
                  manualSliceOffset !== 0
                    ? {
                        ...estimatedRegistration,
                        targetToReference: applyAlignmentSliceOffset(
                          targetManifest,
                          estimatedRegistration.targetToReference,
                          manualSliceOffset,
                        ),
                      }
                    : estimatedRegistration,
                  {
                    signal: alignmentAbortController.signal,
                    outputGrid: operationOutputGrid,
                    maxSlices: 96,
                    maxDimension: Math.max(operationOutputGrid.rows, operationOutputGrid.columns),
                    minCoverage: 0.55,
                    refinePose: false,
                  },
                );
          ensureNotAborted();
          if (
            !presentation.ok &&
            (!registrationKey ||
              cached ||
              (presentation.reason !== 'insufficient-coverage' && presentation.reason !== 'insufficient-samples'))
          ) {
            return rejectRegistration(presentation);
          }
          // An unsupported browsing plane does not invalidate the verified informative-slab pose.
          // Finish its shared calibration before reporting the presentation failure; these
          // informative pixels are never returned as a substitute for the requested plane.
          const registration = presentation.ok ? presentation : estimatedRegistration;
          const registrationGrid = presentation.ok ? operationOutputGrid : estimationGrid;
          const registrationSliceIndex = presentation.ok ? reference.sliceIndex : estimationSliceIndex;
          if (
            registration.rows !== registrationGrid.rows ||
            registration.cols !== registrationGrid.columns ||
            registration.pixels.length !== registrationGrid.rows * registrationGrid.columns
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

          const bestSliceIndex = selectPhysicalTargetSlice(referenceManifest, targetManifest, registrationSliceIndex, {
            rigid: targetToReference,
            centerMm,
            outputGrid: registrationGrid,
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
          const calibrationMoving = calibrationReference
            ? resample2dAreaAverageWithValidity(
                estimatedRegistration.pixels,
                estimatedRegistration.valid ?? new Uint8Array(estimatedRegistration.pixels.length).fill(1),
                estimatedRegistration.rows,
                estimatedRegistration.cols,
                ALIGNMENT_IMAGE_SIZE,
                ALIGNMENT_IMAGE_SIZE,
              )
            : resampled;
          const calibrationNormalizedReference = calibrationReference
            ? normalizePerceptualSource(calibrationReference.pixels, ALIGNMENT_IMAGE_SIZE, {
                validity: calibrationReference.validity,
              })
            : normalizedReferenceFine;
          const calibrationNormalizedMoving = calibrationReference
            ? normalizePerceptualSource(calibrationMoving.pixels, ALIGNMENT_IMAGE_SIZE, {
                validity: calibrationMoving.validity,
              })
            : normalized;
          let displayGeometry: Parameters<typeof computeAlignedSettings>[5] = reference.settings;
          let displayAffine = cached?.affine;
          if (displayAffine) {
            displayGeometry = composeReferencePanelGeometry(
              reference,
              { width: cols, height: rows },
              displayAffine,
            ).geometry;
          } else if (!cached && Math.min(nativeFrame.rows, nativeFrame.columns, rows, cols) >= 64) {
            try {
              const { registerAffine2DWithElastix } = await import('../utils/elastixRegistration');
              ensureNotAborted();
              const movingStructure = protectedStructure(calibrationNormalizedMoving, fineNormalizationExclusion);
              const residual = await registerAffine2DWithElastix(
                calibrationReference
                  ? protectedStructure(calibrationNormalizedReference, undefined)
                  : getReferenceStructure(),
                movingStructure,
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
              sharedWebWorker = residual.webWorker;
              const selection = selectFinalAffineProposal({
                normalizedReference: calibrationNormalizedReference,
                referenceValidity: calibrationReference?.validity ?? referenceRender.validity,
                movingPixels: calibrationMoving.pixels,
                movingValidity: calibrationMoving.validity,
                size: ALIGNMENT_IMAGE_SIZE,
                scales: FINE_PERCEPTUAL_SCALES,
                winningWarp: {
                  A: { m00: 1, m01: 0, m10: 0, m11: 1 },
                  translateX: 0,
                  translateY: 0,
                },
                fixedExclusionRect: reference.exclusionMask,
                optimizerProposals: [{ kind: 'structure-elastix', residualMovingToFixed: residual.movingToFixed }],
              });
              if (selection.selected.kind !== 'seed-only') {
                displayAffine = selection.selected.totalMovingToFixed;
                displayGeometry = composeReferencePanelGeometry(
                  reference,
                  { width: cols, height: rows },
                  selection.selected.totalMovingToFixed,
                ).geometry;
              }
              debugAlignmentLog(
                'physical.final-affine',
                {
                  date,
                  selected: selection.selected.kind,
                  structuralScore: selection.selected.structuralScore,
                  baselineStructuralScore: selection.proposals[0]?.structuralScore,
                  computedGeometry: displayGeometry,
                },
                debugAlignment,
              );
            } catch (error) {
              ensureNotAborted();
              sharedWebWorker = undefined;
              debugAlignmentLog(
                'physical.final-affine-unavailable',
                { date, message: error instanceof Error ? error.message : String(error) },
                debugAlignment,
              );
            }
          }
          let displayTone = cached?.tone;
          if (calibrationReference) {
            const calibrationTargetIndex = selectPhysicalTargetSlice(
              referenceManifest,
              targetManifest,
              estimationSliceIndex,
              {
                rigid: estimatedRegistration.targetToReference,
                centerMm: estimatedRegistration.centerMm,
                outputGrid: estimationGrid,
              },
            );
            const [calibrationWindow, calibrationReferenceWindow] = await Promise.all([
              loadCornerstoneImage(`miradb:${targetManifest.frames[calibrationTargetIndex]!.sopInstanceUid}`),
              loadCornerstoneImage(`miradb:${referenceManifest.frames[estimationSliceIndex]!.sopInstanceUid}`),
            ]);
            ensureNotAborted();
            const fixedDisplay = windowDisplayPixels(calibrationReference.pixels, calibrationReferenceWindow);
            let movingDisplay = windowDisplayPixels(calibrationMoving.pixels, calibrationWindow);
            let validity = calibrationMoving.validity;
            if (movingDisplay && displayAffine) {
              const center = { x: (ALIGNMENT_IMAGE_SIZE - 1) / 2, y: (ALIGNMENT_IMAGE_SIZE - 1) / 2 };
              const centered = standardToAffineAboutOrigin(displayAffine.A, displayAffine.b, center);
              const warped = warpPerceptualCandidateWithValidity(
                movingDisplay,
                ALIGNMENT_IMAGE_SIZE,
                {
                  A: centered.A,
                  translateX: centered.t.x,
                  translateY: centered.t.y,
                },
                validity,
              );
              // Exclude partially supported interpolation samples from calibration.
              movingDisplay = warped.pixels;
              validity = Float32Array.from(warped.validity, (value) => (value >= 0.999 ? 1 : 0));
            }
            const stats =
              fixedDisplay && movingDisplay
                ? computeCorrespondingDisplayStats(fixedDisplay, movingDisplay, {
                    referenceValidity: calibrationReference.validity,
                    movingValidity: validity,
                    columns: ALIGNMENT_IMAGE_SIZE,
                  })
                : null;
            if (stats) {
              displayTone = createAlignmentDisplayTone(
                stats.reference,
                stats.moving,
                calibrationWindow,
                calibrationReferenceWindow,
              );
            }
          }
          const movingDisplayPixels =
            presentation.ok && !displayTone
              ? windowDisplayPixels(
                  resampled.pixels,
                  await loadCornerstoneImage(`miradb:${nativeFrame.sopInstanceUid}`),
                )
              : null;
          ensureNotAborted();
          const displayStats = pairedDisplayStats(movingDisplayPixels, resampled.validity);
          const computedSettings = computeAlignedSettings(
            displayStats?.reference ?? referenceDisplayedStats,
            displayTone
              ? referenceDisplayedStats
              : (displayStats?.moving ??
                  supportedHistogramStats(movingDisplayPixels ?? normalized, resampled.validity)),
            bestSliceIndex,
            seriesRef.instance_count,
            currentProgress,
            displayGeometry,
          );
          if ((registrationKey || manualSliceOffset !== 0) && displayTone) {
            // The cached calibration matches tissue before the user's display controls.
            // Share those controls without recalibrating on each newly browsed slice.
            computedSettings.brightness = reference.settings.brightness;
            computedSettings.contrast = reference.settings.contrast;
          }
          if (registrationKey) {
            // Never promote a user-corrected presentation into the automatic model:
            // doing so would compound the same correction on subsequent browsing.
            const { ok, targetToReference, centerMm, score, diagnostics, provenance, nativeRefinement } =
              cached?.estimate ?? estimatedRegistration;
            physicalRegistrationsRef.current.delete(registrationKey);
            physicalRegistrationsRef.current.set(registrationKey, {
              registrationId: cached?.registrationId ?? runId,
              estimate: { ok, targetToReference, centerMm, score, diagnostics, provenance, nativeRefinement },
              referenceManifest,
              targetManifest,
              affine: displayAffine,
              tone: displayTone,
              fallbackTone:
                !displayTone && presentation.ok
                  ? freezeAlignmentFallbackTone(
                      reference.settings,
                      computedSettings,
                      reference.settings.brightness * reference.settings.contrast > 1e-6
                        ? undefined
                        : (computeCorrespondingDisplayStats(
                            referenceWindowedPixels,
                            movingDisplayPixels ?? normalized,
                            {
                              referenceValidity: referenceRender.validity,
                              movingValidity: resampled.validity,
                              columns: ALIGNMENT_IMAGE_SIZE,
                            },
                          ) ?? {
                            reference: supportedHistogramStats(referenceWindowedPixels, referenceRender.validity),
                            moving: supportedHistogramStats(movingDisplayPixels ?? normalized, resampled.validity),
                          }),
                    )
                  : cached?.fallbackTone,
            });
            if (physicalRegistrationsRef.current.size > 16) {
              physicalRegistrationsRef.current.delete(physicalRegistrationsRef.current.keys().next().value!);
            }
          }
          if (!presentation.ok) return rejectRegistration(presentation);
          const nativeRivalEvidence = nativeRefinement?.optimizedAlternativeCount ? nativeRefinement : undefined;

          return {
            date,
            seriesUid: seriesRef.series_uid,
            bestSliceIndex,
            nmiScore: quality.nmi,
            computedSettings,
            slicesChecked: diagnostics.presentationSourceFrameCount ?? prepared?.targetSourceIndices.length ?? 0,
            ...resultIdentity,
            manualSliceOffset,
            ...(registrationKey ? { registrationId: cached?.registrationId ?? runId } : {}),
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
              ...(displayTone ? { displayTone } : {}),
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

        for (let dateIdx = 0; dateIdx < remainingTargetDates.length; dateIdx++) {
          ensureNotAborted();

          const date = remainingTargetDates[dateIdx];
          const seriesRef = seriesMap[date];

          if (!seriesRef) {
            // No data for this date, skip.
            continue;
          }

          // A re-referenced derived panel already occupies this acquired anchor's physical plane.
          // Preserve the anchor as an acquired image instead of registering its stack to itself.
          if (seriesRef.series_uid === reference.seriesUid) continue;

          const manualSliceOffset = options.targetSliceOffsets?.get(date) ?? 0;
          if (
            !Number.isFinite(manualSliceOffset) ||
            (manualSliceOffset !== 0 &&
              (!referenceManifest || referenceManifest.frames.length < 2 || seriesRef.instance_count < 2))
          ) {
            publishResult(
              terminalResult(
                date,
                seriesRef,
                'incompatible-geometry',
                !Number.isFinite(manualSliceOffset)
                  ? 'Manual slice correction must be finite'
                  : 'Manual slice correction requires reliably ordered multi-frame physical acquisitions',
              ),
            );
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
            if (!scoringRunner) {
              const referenceCoarseRender = await captureReferenceSlice(COARSE_IMAGE_SIZE);
              scoringRunner = await createAlignmentScoringRunner(
                {
                  referenceFinePixels: referencePixels,
                  referenceCoarsePixels: referenceCoarseRender.pixels,
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
              ensureNotAborted();
            }
            const activeScoringRunner = scoringRunner;

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
              const { phase, components } = await activeScoringRunner.scoreCoarse(
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
              const { components } = await activeScoringRunner.scoreFine(
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
            const movingStructureSource = protectedStructure(normalizedBestForStructure, sourceStructureExclusion);
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
            await runOptimizerAttempt('structure-elastix', getReferenceStructure(), prewarpedMovingStructure);
            ensureNotAborted();

            const finalAffineSelection = await activeScoringRunner.scoreFinal({
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
            const nativeDisplayPixels = windowDisplayPixels(
              selectedRawResample,
              targetManifest?.frames[winningCandidate.index],
            );
            const displayStats = pairedDisplayStats(nativeDisplayPixels, selectedWarpedPresentation.validity);
            const targetStats =
              displayStats?.moving ??
              supportedHistogramStats(
                nativeDisplayPixels ?? targetDisplayPixels,
                bestRender.validity ? selectedWarpedPresentation.validity : undefined,
              );

            // Compose recovered delta onto the reference geometry so the displayed target matches the
            // displayed reference (including reference zoom/rotation/pan and any stored shear).
            // Composition order matters:
            // - `deltaStd` maps target -> reference (in the downsampled alignment pixel space)
            // - `refStd` maps reference -> displayed reference
            // To display the *target* in the same view as the reference we want:
            //   displayed = refStd(deltaStd(x_target))
            const composed = composeReferencePanelGeometry(
              reference,
              {
                width: seriesRef.columns ?? reference.imageSize?.width ?? ALIGNMENT_IMAGE_SIZE,
                height: seriesRef.rows ?? reference.imageSize?.height ?? ALIGNMENT_IMAGE_SIZE,
              },
              deltaStd,
            );
            const composedGeometry = composed.geometry;

            const computedSettings = computeAlignedSettings(
              displayStats?.reference ?? referenceDisplayedStats,
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
                referenceToDisplayed: composed.referenceToDisplayed,
                totalTargetToDisplayed: composed.movingToDisplayed,
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
        const errorMsg = err instanceof Error ? err.message : 'Alignment failed';
        setStateForCurrentRun((s) => ({
          ...s,
          isAligning: false,
          progress: null,
          // A requested cancellation keeps completed results; it is not an alignment failure.
          error: cancelled ? null : errorMsg,
        }));
        if (cancelled) return results;
        throw err;
      } finally {
        releaseDisplayedReference?.();
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
    clearRegistrationCache,
    canReuseRegistration,
  };
}
