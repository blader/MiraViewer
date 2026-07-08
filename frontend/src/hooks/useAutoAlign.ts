import { useState, useCallback, useRef } from 'react';
import type { AlignmentReference, AlignmentResult, AlignmentProgress, SeriesRef } from '../types/api';
import { collectBoundedSliceCandidates, computeAlignedSettings, selectFineSliceShortlist } from '../utils/alignment';
import { ALIGNMENT_IMAGE_SIZE, computeHistogramStats } from '../utils/imageCapture';
import { computeMutualInformation } from '../utils/mutualInformation';
import {
  createCornerstoneRenderElement,
  disposeCornerstoneRenderElement,
  createPixelCaptureScratch,
  renderSliceToPixels,
  type PixelCaptureScratch,
  type RenderedSlice,
} from '../utils/cornerstoneSliceCapture';
import { clamp, nowMs } from '../utils/math';
import { registerAffine2DWithElastix, registerRigid2DWithElastix } from '../utils/elastixRegistration';
import { fillInvalidWarpWithValidMean, warpGrayscaleAffineWithValidity } from '../utils/warpAffine';
import {
  buildSoftForegroundSupportSquare,
  buildStructuralPhaseImageSquare,
  erodeFractionalSupportSquare,
  inpaintExclusionRectSquare,
} from '../utils/imageFeatures';
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
import {
  estimatePreparedPhaseCorrection,
  preparePhaseCorrectionReference,
  type PhaseCorrection,
} from '../utils/phaseCorrelation';
import {
  choosePerceptualWinner,
  normalizePerceptualSource,
  preparePerceptualReference,
  rankFixedCandidateSet,
  scoreAlignedCandidate,
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

/**
 * Yield to the main thread to keep UI responsive during alignment.
 */
function yieldToMain(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
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

  const abortRef = useRef(false);
  const abortControllerRef = useRef<AbortController | null>(null);

  /**
   * Abort the current alignment operation.
   */
  const abort = useCallback(() => {
    abortRef.current = true;
    abortControllerRef.current?.abort();
  }, []);

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
    ): Promise<AlignmentResult[]> => {
      abortControllerRef.current?.abort();
      const alignmentAbortController = new AbortController();
      abortControllerRef.current = alignmentAbortController;
      abortRef.current = false;
      const results: AlignmentResult[] = [];
      const setStateForCurrentRun = (nextState: Parameters<typeof setState>[0]) => {
        if (abortControllerRef.current === alignmentAbortController) setState(nextState);
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

      let renderElement: HTMLDivElement | null = null;
      try {
        // One element and two reusable capture grids keep the exhaustive search allocation-bounded.
        const activeRenderElement = createCornerstoneRenderElement(ALIGNMENT_IMAGE_SIZE);
        renderElement = activeRenderElement;
        const captureScratchFull = createPixelCaptureScratch(ALIGNMENT_IMAGE_SIZE);
        const captureScratchCoarse = createPixelCaptureScratch(COARSE_IMAGE_SIZE);
        const ensureNotAborted = () => {
          if (abortRef.current || alignmentAbortController.signal.aborted) {
            throw new AlignmentCancelledError();
          }
        };
        const renderVerifiedSlice = async (
          seriesUid: string,
          sliceIndex: number,
          targetSize: number,
          scratch: PixelCaptureScratch,
        ): Promise<RenderedSlice> => {
          let lastFailure = 'unknown render failure';
          for (let attempt = 1; attempt <= 2; attempt++) {
            ensureNotAborted();
            const rendered = await renderSliceToPixels(
              activeRenderElement,
              seriesUid,
              sliceIndex,
              targetSize,
              scratch,
              { signal: alignmentAbortController.signal },
            );
            ensureNotAborted();
            const idMismatch =
              rendered.renderedImageId != null && rendered.renderedImageId !== rendered.expectedImageId;
            if (!rendered.renderTimedOut && !idMismatch) return rendered;
            lastFailure = rendered.renderTimedOut
              ? `render timed out for ${seriesUid} slice ${sliceIndex}`
              : `rendered ${rendered.renderedImageId} while waiting for ${rendered.expectedImageId}`;
            debugAlignmentLog(
              'capture.retry',
              { seriesUid, sliceIndex, targetSize, attempt, reason: lastFailure },
              isDebugAlignmentEnabled(),
            );
          }
          throw new Error(`Alignment capture failed after retry: ${lastFailure}`);
        };

        const debugAlignment = isDebugAlignmentEnabled();

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

        if (!debugAlignment) {
          console.info(
            "[alignment] Tip: enable verbose logs with localStorage.setItem('miraviewer:debug-alignment', '1')",
          );
        }

        // Render the reference slice from DICOM directly (identity view space).
        const referenceRender = await renderVerifiedSlice(
          reference.seriesUid,
          reference.sliceIndex,
          ALIGNMENT_IMAGE_SIZE,
          captureScratchFull,
        );

        console.info('[alignment] Reference slice rendered', {
          imageId: referenceRender.imageId,
          expectedImageId: referenceRender.expectedImageId,
          renderedImageId: referenceRender.renderedImageId,
          renderTimedOut: referenceRender.renderTimedOut,
        });
        const referencePixels = referenceRender.pixels;

        // Normalize once in reference source space. Candidate normalization is likewise performed
        // before any seed/phase warp, so overlap cannot change a slice's intensity basis.
        const fineNormalizationExclusion = reference.exclusionMask
          ? expandExclusionRect(reference.exclusionMask, 3 / ALIGNMENT_IMAGE_SIZE)
          : undefined;
        const normalizedReferenceFine = normalizePerceptualSource(referencePixels, ALIGNMENT_IMAGE_SIZE, {
          exclusionRect: fineNormalizationExclusion,
        });
        const referenceCoarseRender = await renderVerifiedSlice(
          reference.seriesUid,
          reference.sliceIndex,
          COARSE_IMAGE_SIZE,
          captureScratchCoarse,
        );
        const referencePixelsCoarse = referenceCoarseRender.pixels;
        const coarseExclusionRect = reference.exclusionMask
          ? expandExclusionRect(reference.exclusionMask, PHASE_MAX_CORRECTION_PX / PHASE_SAMPLE_SIZE)
          : undefined;
        const normalizedReferenceCoarse = normalizePerceptualSource(referencePixelsCoarse, COARSE_IMAGE_SIZE, {
          exclusionRect: coarseExclusionRect,
        });
        const coarsePerceptualReference = preparePerceptualReference(normalizedReferenceCoarse, COARSE_IMAGE_SIZE, {
          scales: [...COARSE_PERCEPTUAL_SCALES],
          exclusionRect: reference.exclusionMask,
        });
        const finePerceptualReference = preparePerceptualReference(normalizedReferenceFine, ALIGNMENT_IMAGE_SIZE, {
          scales: [...FINE_PERCEPTUAL_SCALES],
          exclusionRect: reference.exclusionMask,
        });
        const phaseReferenceSupport = buildSoftForegroundSupportSquare(normalizedReferenceCoarse, PHASE_SAMPLE_SIZE);
        const phaseReferencePixels = buildStructuralPhaseImageSquare(
          inpaintExclusionRectSquare(normalizedReferenceCoarse, PHASE_SAMPLE_SIZE, coarseExclusionRect, 6).pixels,
          PHASE_SAMPLE_SIZE,
        );
        const preparedPhaseReference = preparePhaseCorrectionReference(phaseReferencePixels, PHASE_SAMPLE_SIZE, {
          fftSize: PHASE_FFT_SIZE,
          maxCorrectionPx: PHASE_MAX_CORRECTION_PX,
          support: phaseReferenceSupport,
        });

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
          referencePixels,
          reference.settings.brightness,
          reference.settings.contrast,
        );
        const referenceDisplayedStats = computeHistogramStats(referenceDisplayedPixels);

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

          const startIdxUnclamped = Math.round(
            (reference.sliceIndex / Math.max(1, reference.sliceCount - 1)) * (seriesRef.instance_count - 1),
          );
          const startIdx = clamp(startIdxUnclamped, 0, Math.max(0, seriesRef.instance_count - 1));

          // Best initial guess: normalized index mapping from reference -> target.
          const seedIdx = startIdx;

          const sliceSearchMinIndex = clamp(
            seedIdx - SLICE_SEARCH_WINDOW_RADIUS,
            0,
            Math.max(0, seriesRef.instance_count - 1),
          );
          const sliceSearchMaxIndex = clamp(
            seedIdx + SLICE_SEARCH_WINDOW_RADIUS,
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
                sliceSearchWindowRadius: SLICE_SEARCH_WINDOW_RADIUS,
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

          console.info('[alignment] Seed registration starting', {
            date,
            seedIdx,
            size: SEED_REGISTRATION_IMAGE_SIZE,
            numberOfResolutions: SEED_REGISTRATION_RESOLUTIONS,
          });

          const seedRender = await renderVerifiedSlice(
            seriesRef.series_uid,
            seedIdx,
            SEED_REGISTRATION_IMAGE_SIZE,
            captureScratchFull,
          );

          const tSeed0 = nowMs();
          const initialSeedReg = await registerRigid2DWithElastix(
            referencePixels,
            seedRender.pixels,
            SEED_REGISTRATION_IMAGE_SIZE,
            {
              numberOfResolutions: SEED_REGISTRATION_RESOLUTIONS,
              webWorker: sharedWebWorker,
              signal: alignmentAbortController.signal,
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
            const prewarpedSeed = warpGrayscaleAffineWithValidity(
              seedRender.pixels,
              SEED_REGISTRATION_IMAGE_SIZE,
              initialWarp,
            );
            const residualSeedReg = await registerRigid2DWithElastix(
              referencePixels,
              fillInvalidWarpWithValidMean(prewarpedSeed),
              SEED_REGISTRATION_IMAGE_SIZE,
              {
                numberOfResolutions: SEED_REGISTRATION_RESOLUTIONS,
                webWorker: sharedWebWorker,
                exclusionRect: reference.exclusionMask,
                signal: alignmentAbortController.signal,
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
              renderTimedOut: seedRender.renderTimedOut,
              render: {
                imageId: seedRender.imageId,
                expectedImageId: seedRender.expectedImageId,
                renderedImageId: seedRender.renderedImageId,
              },
            },
            debugAlignment,
          );

          // 2) Exhaustively score the bounded window. Phase correlation estimates only the
          // residual translation; aligned local structure decides which slice wins.
          let sliceSearchRenderMs = 0;
          let sliceSearchWarpMs = 0;
          let sliceSearchScoreMs = 0;
          let slicesChecked = 0;
          let provisionalBestScore = 0;
          const progressUpdateMinIntervalMs = 100;
          let lastProgressUpdateMs = 0;
          const seedWarpAtCoarse = correctedWarpAtSize(
            seedTransform,
            {
              correctionX: 0,
              correctionY: 0,
              sampleGridSize: PHASE_SAMPLE_SIZE,
              fftSize: PHASE_FFT_SIZE,
            },
            COARSE_IMAGE_SIZE,
          );

          const scoreCoarseSlice = async (index: number): Promise<SlicePerceptualCandidate> => {
            const rendered = await renderVerifiedSlice(
              seriesRef.series_uid,
              index,
              COARSE_IMAGE_SIZE,
              captureScratchCoarse,
            );
            sliceSearchRenderMs += rendered.timingMs.total;

            const tWarp0 = nowMs();
            const sourceNormalizationExclusion = reference.exclusionMask
              ? mapFixedExclusionToMovingBounds(
                  reference.exclusionMask,
                  seedWarpAtCoarse,
                  COARSE_IMAGE_SIZE,
                  PHASE_MAX_CORRECTION_PX,
                )
              : undefined;
            const normalizedSource = normalizePerceptualSource(rendered.pixels, COARSE_IMAGE_SIZE, {
              exclusionRect: sourceNormalizationExclusion,
            });
            const inpaintedPhaseSource = inpaintExclusionRectSquare(
              normalizedSource,
              PHASE_SAMPLE_SIZE,
              sourceNormalizationExclusion,
              6,
            ).pixels;
            const structuralPhaseSource = buildStructuralPhaseImageSquare(inpaintedPhaseSource, PHASE_SAMPLE_SIZE);
            const warpedStructuralPhase = warpGrayscaleAffineWithValidity(
              structuralPhaseSource,
              PHASE_SAMPLE_SIZE,
              seedWarpAtCoarse,
            );
            const sourceSupport = buildSoftForegroundSupportSquare(normalizedSource, COARSE_IMAGE_SIZE);
            const warpedSupport = warpGrayscaleAffineWithValidity(sourceSupport, COARSE_IMAGE_SIZE, seedWarpAtCoarse);
            const erodedGeometricValidity = erodeFractionalSupportSquare(
              warpedStructuralPhase.validity,
              PHASE_SAMPLE_SIZE,
              1,
            );
            const phaseMovingPixels = new Float32Array(warpedStructuralPhase.pixels.length);
            const phaseSupport = new Float32Array(warpedStructuralPhase.pixels.length);
            for (let pixelIndex = 0; pixelIndex < phaseMovingPixels.length; pixelIndex++) {
              const structuralValidity = warpedStructuralPhase.validity[pixelIndex] ?? 0;
              const supportValidity = warpedSupport.validity[pixelIndex] ?? 0;
              phaseMovingPixels[pixelIndex] =
                structuralValidity > 1e-6 ? (warpedStructuralPhase.pixels[pixelIndex] ?? 0) / structuralValidity : 0;
              const conditionalSupport =
                supportValidity > 1e-6 ? (warpedSupport.pixels[pixelIndex] ?? 0) / supportValidity : 0;
              phaseSupport[pixelIndex] = conditionalSupport * (erodedGeometricValidity[pixelIndex] ?? 0);
            }
            const phase = estimatePreparedPhaseCorrection(preparedPhaseReference, phaseMovingPixels, {
              support: phaseSupport,
            });
            const correctedWarp = correctedWarpAtSize(seedTransform, phase, COARSE_IMAGE_SIZE);
            const aligned = warpGrayscaleAffineWithValidity(normalizedSource, COARSE_IMAGE_SIZE, correctedWarp);
            sliceSearchWarpMs += nowMs() - tWarp0;

            const tScore0 = nowMs();
            const components = scoreAlignedCandidate(
              coarsePerceptualReference,
              aligned.pixels,
              aligned.validity,
              COARSE_IMAGE_SIZE,
            );
            sliceSearchScoreMs += nowMs() - tScore0;
            return { index, phase, components };
          };

          console.info('[alignment] Slice search starting', {
            date,
            strategy: 'rigid-phase-perceptual',
            referenceSliceIndex: reference.sliceIndex,
            referenceSliceCount: reference.sliceCount,
            targetSliceCount: seriesRef.instance_count,
          });

          const onCoarseScored = (candidate: { index: number; value: SlicePerceptualCandidate }) => {
            slicesChecked++;
            provisionalBestScore = Math.max(provisionalBestScore, meanPerceptualComponents(candidate.value.components));
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
            finalSearchMinIndex = Math.max(0, sliceSearchMinIndex - SLICE_SEARCH_WINDOW_RADIUS);
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
              sliceSearchMaxIndex + SLICE_SEARCH_WINDOW_RADIUS,
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
            const rendered = await renderVerifiedSlice(
              seriesRef.series_uid,
              index,
              ALIGNMENT_IMAGE_SIZE,
              captureScratchFull,
            );
            sliceSearchRenderMs += rendered.timingMs.total;
            const correctedWarp = correctedWarpAtSize(seedTransform, coarseCandidate.phase, ALIGNMENT_IMAGE_SIZE);
            const sourceNormalizationExclusion = reference.exclusionMask
              ? mapFixedExclusionToMovingBounds(reference.exclusionMask, correctedWarp, ALIGNMENT_IMAGE_SIZE, 3)
              : undefined;
            const normalizedSource = normalizePerceptualSource(rendered.pixels, ALIGNMENT_IMAGE_SIZE, {
              exclusionRect: sourceNormalizationExclusion,
            });
            const tWarp0 = nowMs();
            const aligned = warpGrayscaleAffineWithValidity(normalizedSource, ALIGNMENT_IMAGE_SIZE, correctedWarp);
            sliceSearchWarpMs += nowMs() - tWarp0;
            const tScore0 = nowMs();
            const components = scoreAlignedCandidate(
              finePerceptualReference,
              aligned.pixels,
              aligned.validity,
              ALIGNMENT_IMAGE_SIZE,
            );
            sliceSearchScoreMs += nowMs() - tScore0;
            fineCandidates.push({ index, phase: coarseCandidate.phase, components });
            await yieldToMain();
            ensureNotAborted();
          }

          const rankedFine = rankFixedCandidateSet(fineCandidates, seedIdx);
          const winningCandidate = choosePerceptualWinner(rankedFine, seedIdx);

          // Preserve both stage-local universes. Fine values become the overlay headline for
          // shortlisted candidates, while the coarse snapshot still explains why they advanced.
          type RankedCandidate = (typeof rankedCoarse)[number];
          const coarseUniverseId = `${date}:coarse:${finalSearchMinIndex}-${finalSearchMaxIndex}`;
          const fineUniverseId = `${date}:fine:${shortlist.fineIndices.join(',')}`;
          const peakReasonByIndex = new Map(
            shortlist.peakSelections.map((selection) => [selection.index, selection.reason]),
          );
          const retentionReason = (index: number): 'local-peak' | 'fallback-fill' | 'peak-neighbor' | 'not-retained' =>
            peakReasonByIndex.get(index) ?? (shortlist.fineIndices.includes(index) ? 'peak-neighbor' : 'not-retained');
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
            const stageHistory = stage === 'coarse' ? { coarseStage: stageSnapshot } : { fineStage: stageSnapshot };
            recordAlignmentSliceScore(seriesRef.series_uid, candidate.index, {
              ssim: averageMetric(candidate.components, 'contrastStructure'),
              lncc: averageMetric(candidate.components, 'lncc'),
              zncc: candidate.appearanceRank,
              ngf: averageMetric(candidate.components, 'ngf'),
              mind: averageMetric(candidate.components, 'mind'),
              rawMindDistance: averageRawMindDistance(candidate.components),
              census: candidate.boundaryRank,
              phase: candidate.phase.peak,
              mi: candidate.components.coverage,
              nmi: candidate.phase.peakToSidelobeRatio,
              score: candidate.perceptualRank,
              stage,
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
              phasePeakToSidelobeRatio: candidate.phase.peakToSidelobeRatio,
              retainedForFine: shortlist.fineIndices.includes(candidate.index),
              selected,
              perScale: candidate.components.perScale,
              ...stageHistory,
            });
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
                universeId: stageSnapshot.universeId,
                retentionReason: stageSnapshot.retentionReason,
                selected,
              },
              debugAlignment,
            );
          };
          for (const candidate of rankedCoarse) recordCandidateDebug(candidate, 'coarse', false);
          for (const candidate of rankedFine) {
            recordCandidateDebug(candidate, 'fine', candidate.index === winningCandidate.index);
          }

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
              warpMs: sliceSearchWarpMs,
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

          console.info('[alignment] Refinement starting', { date, bestSliceIndex: winningCandidate.index });

          const bestRender = await renderVerifiedSlice(
            seriesRef.series_uid,
            winningCandidate.index,
            ALIGNMENT_IMAGE_SIZE,
            captureScratchFull,
          );
          const winningWarp = correctedWarpAtSize(seedTransform, winningCandidate.phase, ALIGNMENT_IMAGE_SIZE);
          const prewarpedBest = warpGrayscaleAffineWithValidity(bestRender.pixels, ALIGNMENT_IMAGE_SIZE, winningWarp);
          const prewarpedBestPixels = fillInvalidWarpWithValidMean(prewarpedBest);

          const tRefine0 = nowMs();
          const sourceStructureExclusion = reference.exclusionMask
            ? mapFixedExclusionToMovingBounds(reference.exclusionMask, winningWarp, ALIGNMENT_IMAGE_SIZE, 3)
            : undefined;
          const normalizedBestForStructure = normalizePerceptualSource(bestRender.pixels, ALIGNMENT_IMAGE_SIZE, {
            exclusionRect: sourceStructureExclusion,
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
            warpGrayscaleAffineWithValidity(movingStructureSource, ALIGNMENT_IMAGE_SIZE, winningWarp),
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
              const registration = await registerAffine2DWithElastix(fixedPixels, movingPixels, ALIGNMENT_IMAGE_SIZE, {
                numberOfResolutions: REFINEMENT_REGISTRATION_RESOLUTIONS,
                webWorker: sharedWebWorker,
                exclusionRect: reference.exclusionMask,
                signal: alignmentAbortController.signal,
              });
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

          await runOptimizerAttempt('intensity-elastix', referencePixels, prewarpedBestPixels);
          await runOptimizerAttempt('structure-elastix', referenceStructure, prewarpedMovingStructure);
          ensureNotAborted();

          const finalAffineSelection = selectFinalAffineProposal({
            normalizedReference: normalizedReferenceFine,
            movingPixels: bestRender.pixels,
            size: ALIGNMENT_IMAGE_SIZE,
            scales: finePerceptualReference.scales.map((scale) => scale.size),
            winningWarp,
            fixedExclusionRect: reference.exclusionMask,
            optimizerProposals,
          });
          const selectedProposal = finalAffineSelection.selected;
          const deltaStd = selectedProposal.totalMovingToFixed;
          const origin = { x: (ALIGNMENT_IMAGE_SIZE - 1) / 2, y: (ALIGNMENT_IMAGE_SIZE - 1) / 2 };
          const selectedAboutCenter = standardToAffineAboutOrigin(deltaStd.A, deltaStd.b, origin);
          const selectedRawResample = fillInvalidWarpWithValidMean(
            warpGrayscaleAffineWithValidity(bestRender.pixels, ALIGNMENT_IMAGE_SIZE, {
              A: selectedAboutCenter.A,
              translateX: selectedAboutCenter.t.x,
              translateY: selectedAboutCenter.t.y,
            }),
          );
          const selectedQuality = computeMutualInformation(referencePixels, selectedRawResample, {
            bins: 64,
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
            if (!proposal.eligible) {
              finalAffineProposals.push({
                kind,
                status: 'rejected',
                rejectionReason: proposal.rejectionReason,
                mindScore: proposal.mindScore,
                ngfScore: proposal.ngfScore,
                structuralScore: proposal.structuralScore,
                deformationMagnitude: proposal.deformationMagnitude,
                bidirectionalCoverage: proposal.bidirectionalCoverage,
              });
              continue;
            }
            finalAffineProposals.push({
              kind,
              status: kind === selectedProposal.kind ? 'selected' : 'eligible',
              mindScore: proposal.mindScore,
              ngfScore: proposal.ngfScore,
              structuralScore: proposal.structuralScore,
              deformationMagnitude: proposal.deformationMagnitude,
              bidirectionalCoverage: proposal.bidirectionalCoverage,
            });
          }
          const seedProposal = finalAffineSelection.proposals.find((proposal) => proposal.kind === 'seed-only');
          if (!seedProposal?.eligible) {
            throw new Error('Final affine invariant: seed-only proposal is not eligible');
          }

          const winningFineSnapshot = buildStageSnapshot(winningCandidate, 'fine');
          recordAlignmentSliceScore(seriesRef.series_uid, winningCandidate.index, {
            ssim: averageMetric(winningCandidate.components, 'contrastStructure'),
            lncc: averageMetric(winningCandidate.components, 'lncc'),
            zncc: winningCandidate.appearanceRank,
            ngf: averageMetric(winningCandidate.components, 'ngf'),
            mind: averageMetric(winningCandidate.components, 'mind'),
            rawMindDistance: averageRawMindDistance(winningCandidate.components),
            census: winningCandidate.boundaryRank,
            phase: winningCandidate.phase.peak,
            mi: winningCandidate.components.coverage,
            nmi: winningCandidate.phase.peakToSidelobeRatio,
            score: winningCandidate.perceptualRank,
            stage: 'fine',
            distanceFromSeed: winningCandidate.index - seedIdx,
            rigidSeed: seedTransform,
            coverage: winningCandidate.components.coverage,
            mindRank: winningCandidate.mindRank,
            appearanceRank: winningCandidate.appearanceRank,
            boundaryRank: winningCandidate.boundaryRank,
            structuralRank: winningCandidate.structuralRank,
            perceptualRank: winningCandidate.perceptualRank,
            mindActive: winningCandidate.mindActive,
            appearanceActive: winningCandidate.appearanceActive,
            boundaryActive: winningCandidate.boundaryActive,
            structuralActive: winningCandidate.structuralActive,
            phaseInput: 'structural-edge-energy',
            correctionX: winningCandidate.phase.correctionX,
            correctionY: winningCandidate.phase.correctionY,
            phasePeakToSidelobeRatio: winningCandidate.phase.peakToSidelobeRatio,
            retainedForFine: true,
            selected: true,
            perScale: winningCandidate.components.perScale,
            fineStage: winningFineSnapshot,
            finalAffineSelected: selectedProposal.kind,
            finalAffineStructuralScore: selectedProposal.structuralScore,
            finalAffineSeedStructuralScore: seedProposal.structuralScore,
            finalAffineProposals,
          });

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

          const targetStats = computeHistogramStats(selectedRawResample);

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

          const refAffine = panelGeometryToAffineAboutCenter(referenceGeometry, ALIGNMENT_IMAGE_SIZE);
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
          };

          ensureNotAborted();
          results.push(result);

          setStateForCurrentRun((s) => ({
            ...s,
            results: [...results],
          }));

          await yieldToMain();
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
        if (abortControllerRef.current === alignmentAbortController) abortControllerRef.current = null;
        if (renderElement) disposeCornerstoneRenderElement(renderElement);
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
