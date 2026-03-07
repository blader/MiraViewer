import { useState, useCallback, useRef } from 'react';
import type { JsonCompatible } from 'itk-wasm';
import type { AlignmentReference, AlignmentResult, AlignmentProgress, SeriesRef } from '../types/api';
import { computeAlignedSettings, findBestMatchingSlice } from '../utils/alignment';
import { ALIGNMENT_IMAGE_SIZE, computeHistogramStats } from '../utils/imageCapture';
import {
  createCornerstoneRenderElement,
  disposeCornerstoneRenderElement,
  createPixelCaptureScratch,
  renderSliceToPixels,
} from '../utils/cornerstoneSliceCapture';
import { clamp, nowMs } from '../utils/math';
import { registerAffine2DWithElastix } from '../utils/elastixRegistration';
import { warpGrayscaleAffine } from '../utils/warpAffine';
import {
  computeGradientMagnitudeL1Square,
  buildInclusionMaskFromThresholdSquare,
} from '../utils/imageFeatures';
import {
  affineAboutOriginToStandard,
  composeStandardAffine2D,
  standardToAffineAboutOrigin,
} from '../utils/affine2d';
import {
  affineAboutCenterToPanelGeometry,
  panelGeometryToAffineAboutCenter,
  type PanelGeometry,
} from '../utils/panelTransform';
import { isDebugAlignmentEnabled, debugAlignmentLog } from '../utils/debugAlignment';
import { recordAlignmentSliceScore, resetAlignmentSliceScoreStore } from '../utils/alignmentSliceScoreStore';

// Perf tuning for the MI-based slice search.
//
// Notes:
// - This affects only the *coarse slice search* stage. The final refinement still runs at
//   ALIGNMENT_IMAGE_SIZE, so the recovered transform quality should be unchanged.
// - Reducing the search image size and/or histogram bins can significantly reduce runtime.
//
// Type note: keep this typed as `number` (not a numeric literal) so we can compare it to
// ALIGNMENT_IMAGE_SIZE without TS treating the comparison as always-false.
const SLICE_SEARCH_IMAGE_SIZE: number = 512;

// MI scoring tuning.
const SLICE_SEARCH_MI_BINS: number = 64;

// Stop logic tuning.
const SLICE_SEARCH_STOP_DECREASE_STREAK: number = 3;
// Ensure we search far enough to avoid “off by ~5 slices” misses due to early noisy dips.
const SLICE_SEARCH_MIN_SEARCH_RADIUS: number = 5;

// Keep UI responsive during heavy 512px scoring.
const SLICE_SEARCH_YIELD_EVERY_SLICES: number = 2;

// Background suppression in scoring.
const SLICE_SEARCH_FOREGROUND_THRESHOLD: number = 0.02;

// Gradient scoring (MI/NMI on grad magnitude).
//
// Note: currently disabled because grad magnitude was not correlating well with correct slice
// matches in practice.
const SLICE_SEARCH_GRADIENT_WEIGHT: number = 0;

// Similarity metric used for coarse slice search.
const SLICE_SEARCH_SCORE_METRIC: 'ssim' | 'lncc' | 'zncc' | 'ngf' | 'census' | 'mind' | 'phase' = 'phase';
const SLICE_SEARCH_SSIM_BLOCK_SIZE: number = 16;

// Downsample sizes for more expensive metrics.
const SLICE_SEARCH_MIND_SIZE: number = 64;
const SLICE_SEARCH_PHASE_SIZE: number = 64;

// Optional: constrain the slice search to a window around the best guess.
const SLICE_SEARCH_WINDOW_RADIUS: number = 40;

// Registration perf tuning.
//
// User-requested: run single-pass registrations (no multi-resolution pyramid). This is the
// fastest configuration but can reduce robustness on some inputs.
//
// Important: keep the Elastix seed registration at a smaller size than the 512px slice search.
// We previously attempted seed registration at 512 and observed failures in practice (progress
// flashing + immediate abort). The seed transform is only used to pre-warp candidates; it does
// not need to be computed at full slice-search resolution.
const SEED_REGISTRATION_IMAGE_SIZE: number = ALIGNMENT_IMAGE_SIZE;
const SEED_REGISTRATION_RESOLUTIONS = 1;
const REFINEMENT_REGISTRATION_RESOLUTIONS = 1;

type SeedRegistrationResult = {
  idx: number;
  nmi: number;
  transformA: { m00: number; m01: number; m10: number; m11: number };
  transformT: { x: number; y: number };
  transformParameterObject?: JsonCompatible;
};

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

  /**
   * Abort the current alignment operation.
   */
  const abort = useCallback(() => {
    abortRef.current = true;
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
      currentProgress: number
    ): Promise<AlignmentResult[]> => {
      abortRef.current = false;
      const results: AlignmentResult[] = [];

      setState({
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

      // Single render element used for all captures. We also keep scratch canvases around to
      // avoid allocating a new <canvas> + ImageData buffers on every slice capture.
      //
      // Important: The element size must be >= any target capture size, otherwise larger captures
      // would just upsample a smaller source canvas ("fake 512").
      const renderElementSize = Math.max(ALIGNMENT_IMAGE_SIZE, SLICE_SEARCH_IMAGE_SIZE);
      const renderElement = createCornerstoneRenderElement(renderElementSize);
      const captureScratchFull = createPixelCaptureScratch(ALIGNMENT_IMAGE_SIZE);
      const captureScratchSliceSearch = createPixelCaptureScratch(SLICE_SEARCH_IMAGE_SIZE);

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
          "[alignment] Tip: enable verbose logs with localStorage.setItem('miraviewer:debug-alignment', '1')"
        );
      }

      // Render the reference slice from DICOM directly (identity view space).
      const referenceRender = await renderSliceToPixels(
        renderElement,
        reference.seriesUid,
        reference.sliceIndex,
        ALIGNMENT_IMAGE_SIZE,
        captureScratchFull
      );

      console.info('[alignment] Reference slice rendered', {
        imageId: referenceRender.imageId,
        expectedImageId: referenceRender.expectedImageId,
        renderedImageId: referenceRender.renderedImageId,
        renderTimedOut: referenceRender.renderTimedOut,
      });
      const referencePixels = referenceRender.pixels;

      const referenceRenderForSliceSearch =
        SLICE_SEARCH_IMAGE_SIZE === ALIGNMENT_IMAGE_SIZE
          ? referenceRender
          : await renderSliceToPixels(
              renderElement,
              reference.seriesUid,
              reference.sliceIndex,
              SLICE_SEARCH_IMAGE_SIZE,
              captureScratchSliceSearch
            );

      const referencePixelsForSliceSearch = referenceRenderForSliceSearch.pixels;

      // Slice-search feature prep (shared across all target dates).
      const inclusion = buildInclusionMaskFromThresholdSquare(
        referencePixelsForSliceSearch,
        SLICE_SEARCH_IMAGE_SIZE,
        SLICE_SEARCH_FOREGROUND_THRESHOLD,
        { minIncludedFrac: 0.05 }
      );
      const sliceSearchInclusionMask = inclusion?.mask;

      const referenceGradPixelsForSliceSearch =
        SLICE_SEARCH_GRADIENT_WEIGHT !== 0
          ? computeGradientMagnitudeL1Square(referencePixelsForSliceSearch, SLICE_SEARCH_IMAGE_SIZE)
          : null;

      if (debugAlignment) {
          console.info('[alignment] Slice-search scoring config', {
            sliceSearchImageSize: SLICE_SEARCH_IMAGE_SIZE,
            scoreMetric: SLICE_SEARCH_SCORE_METRIC,
            // SSIM/LNCC are the primary score used for bestIndex selection.
            ssimBlockSize: SLICE_SEARCH_SSIM_BLOCK_SIZE,
            // Downsample config for heavier metrics.
            mindSize: SLICE_SEARCH_MIND_SIZE,
            phaseSize: SLICE_SEARCH_PHASE_SIZE,
            // MI/NMI are still computed in debug mode so we can compare metrics.
            miBins: SLICE_SEARCH_MI_BINS,
            stopDecreaseStreak: SLICE_SEARCH_STOP_DECREASE_STREAK,
            minSearchRadius: SLICE_SEARCH_MIN_SEARCH_RADIUS,
            yieldEverySlices: SLICE_SEARCH_YIELD_EVERY_SLICES,
            foregroundThreshold: SLICE_SEARCH_FOREGROUND_THRESHOLD,
            inclusionMask: inclusion
              ? { includedFrac: Number(inclusion.includedFrac.toFixed(4)), includedCount: inclusion.includedCount }
              : null,
            gradientWeight: SLICE_SEARCH_GRADIENT_WEIGHT,
          });
      }

      const referenceDisplayedPixels = applyBrightnessContrastToPixels(
        referencePixels,
        reference.settings.brightness,
        reference.settings.contrast
      );
      const referenceDisplayedStats = computeHistogramStats(referenceDisplayedPixels);

      // Flip the progress UI to matching now that the reference is ready.
      setState((s) => ({
        ...s,
        progress: s.progress ? { ...s.progress, phase: 'matching' } : null,
      }));

      // Keep a web worker + initial transform around as we iterate.
      let sharedWebWorker: Worker | undefined;

      try {
        for (let dateIdx = 0; dateIdx < targetDates.length; dateIdx++) {
          if (abortRef.current) {
            setState((s) => ({ ...s, isAligning: false, error: 'Alignment cancelled' }));
            return results;
          }

          const date = targetDates[dateIdx];
          const seriesRef = seriesMap[date];

          if (!seriesRef) {
            // No data for this date, skip.
            continue;
          }

          setState((s) => ({
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
            (reference.sliceIndex / Math.max(1, reference.sliceCount - 1)) * (seriesRef.instance_count - 1)
          );
          const startIdx = clamp(startIdxUnclamped, 0, Math.max(0, seriesRef.instance_count - 1));

          // Best initial guess: normalized index mapping from reference -> target.
          const seedIdx = startIdx;

          const sliceSearchMinIndex = clamp(seedIdx - SLICE_SEARCH_WINDOW_RADIUS, 0, Math.max(0, seriesRef.instance_count - 1));
          const sliceSearchMaxIndex = clamp(seedIdx + SLICE_SEARCH_WINDOW_RADIUS, 0, Math.max(0, seriesRef.instance_count - 1));

          debugAlignmentLog(
            'date.plan',
            {
              date,
              startIdx,
              seedIdx,
              strategy: {
                // User-requested: seed the slice search with a coarse 2D affine transform.
                sliceSearchWarp: true,
                seedImageSize: SEED_REGISTRATION_IMAGE_SIZE,
                seedResolutions: SEED_REGISTRATION_RESOLUTIONS,
                sliceSearchImageSize: SLICE_SEARCH_IMAGE_SIZE,
                sliceSearchMiBins: SLICE_SEARCH_MI_BINS,
                sliceSearchStopDecreaseStreak: SLICE_SEARCH_STOP_DECREASE_STREAK,
                sliceSearchMinSearchRadius: SLICE_SEARCH_MIN_SEARCH_RADIUS,
                sliceSearchWindowRadius: SLICE_SEARCH_WINDOW_RADIUS,
                sliceSearchYieldEverySlices: SLICE_SEARCH_YIELD_EVERY_SLICES,
                gradientWeight: SLICE_SEARCH_GRADIENT_WEIGHT,
                refinementImageSize: ALIGNMENT_IMAGE_SIZE,
                refinementResolutions: REFINEMENT_REGISTRATION_RESOLUTIONS,
              },
              meta: {
                seriesUid: seriesRef.series_uid,
                referenceSeriesUid: reference.seriesUid,
              },
            },
            debugAlignment
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

          // 1) Coarse seed transform at SLICE_SEARCH_IMAGE_SIZE.
          //
          // This is used to pre-warp slices during the slice search so the similarity metric is
          // less dominated by in-plane pose differences.

          console.info('[alignment] Seed registration starting', {
            date,
            seedIdx,
            size: SEED_REGISTRATION_IMAGE_SIZE,
            numberOfResolutions: SEED_REGISTRATION_RESOLUTIONS,
          });

          const seedRender = await renderSliceToPixels(
            renderElement,
            seriesRef.series_uid,
            seedIdx,
            SEED_REGISTRATION_IMAGE_SIZE,
            captureScratchFull
          );

          const tSeed0 = nowMs();
          const seedReg = await registerAffine2DWithElastix(referencePixels, seedRender.pixels, SEED_REGISTRATION_IMAGE_SIZE, {
            numberOfResolutions: SEED_REGISTRATION_RESOLUTIONS,
            webWorker: sharedWebWorker,
            exclusionRect: reference.exclusionMask,
          });
          const seedRegistrationMs = nowMs() - tSeed0;

          sharedWebWorker = seedReg.webWorker;

          // Seed transform is computed at SEED_REGISTRATION_IMAGE_SIZE, but applied to the
          // slice-search grid (SLICE_SEARCH_IMAGE_SIZE). Translation is in pixels, so scale it.
          const seedScale = SLICE_SEARCH_IMAGE_SIZE / SEED_REGISTRATION_IMAGE_SIZE;
          const seed: SeedRegistrationResult = {
            idx: seedIdx,
            nmi: seedReg.quality.nmi,
            transformA: seedReg.A,
            transformT: {
              x: seedReg.translatePx.x * seedScale,
              y: seedReg.translatePx.y * seedScale,
            },
            transformParameterObject: seedReg.transformParameterObject,
          };

          console.info('[alignment] Seed registration finished', {
            date,
            seedIdx,
            nmi: Number(seed.nmi.toFixed(4)),
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
            debugAlignment
          );

          debugAlignmentLog(
            'seed.registration',
            {
              date,
              seedIdx,
              nmi: seed.nmi,
              mi: seedReg.quality.mi,
              elastixFinalMetric: seedReg.quality.elastixFinalMetric,
              elastixMetricSamples: seedReg.quality.elastixMetricSamples,
              translatePx: { x: seedReg.translatePx.x, y: seedReg.translatePx.y },
              A: seedReg.A,
              renderTimedOut: seedRender.renderTimedOut,
              render: {
                imageId: seedRender.imageId,
                expectedImageId: seedRender.expectedImageId,
                renderedImageId: seedRender.renderedImageId,
              },
            },
            debugAlignment
          );

          // 2) Use the seed transform to drive a fast similarity-based slice search.
          //
          // We pre-warp each candidate slice by the seed transform before scoring against the
          // reference. This helps slice search focus on the through-plane match instead of
          // being distracted by in-plane pose differences.
          let sliceSearchRenderMs = 0;
          let sliceSearchWarpMs = 0;

          const getSlicePixels = async (index: number): Promise<Float32Array> => {
            const rendered = await renderSliceToPixels(
              renderElement,
              seriesRef.series_uid,
              index,
              SLICE_SEARCH_IMAGE_SIZE,
              captureScratchSliceSearch
            );

            sliceSearchRenderMs += rendered.timingMs.total;

            const tWarp0 = nowMs();
            const warped = warpGrayscaleAffine(rendered.pixels, SLICE_SEARCH_IMAGE_SIZE, {
              A: seed.transformA,
              translateX: seed.transformT.x,
              translateY: seed.transformT.y,
            });
            sliceSearchWarpMs += nowMs() - tWarp0;

            return warped;
          };

          console.info('[alignment] Slice search starting', {
            date,
            strategy: 'seeded',
            referenceSliceIndex: reference.sliceIndex,
            referenceSliceCount: reference.sliceCount,
            targetSliceCount: seriesRef.instance_count,
          });

          const progressUpdateMinIntervalMs = 100;
          let lastProgressUpdateMs = 0;

          const onSliceScored = debugAlignment
            ? (
                index: number,
                metrics: {
                  ssim: number;
                  lncc: number;
                  zncc: number;
                  ngf: number;
                  census: number;
                  mind?: number;
                  phase?: number;
                  mi: number;
                  nmi: number;
                  score: number;
                  miGrad?: number;
                  nmiGrad?: number;
                  pixelsUsed?: number;
                },
                direction: 'start' | 'left' | 'right'
              ) => {
                // Store per-slice metrics for UI debugging overlays.
                recordAlignmentSliceScore(seriesRef.series_uid, index, {
                  ssim: metrics.ssim,
                  lncc: metrics.lncc,
                  zncc: metrics.zncc,
                  ngf: metrics.ngf,
                  census: metrics.census,
                  mind: metrics.mind ?? null,
                  phase: metrics.phase ?? null,
                  mi: metrics.mi,
                  nmi: metrics.nmi,
                  miGrad: metrics.miGrad ?? null,
                  nmiGrad: metrics.nmiGrad ?? null,
                  score: metrics.score,
                });

                // Extremely verbose: log per-slice similarity metrics only when debug alignment is enabled.
                debugAlignmentLog(
                  'slice-search.score',
                  {
                    date,
                    direction,
                    index,
                    score: Number(metrics.score.toFixed(6)),
                    ssim: Number(metrics.ssim.toFixed(6)),
                    lncc: Number(metrics.lncc.toFixed(6)),
                    zncc: Number(metrics.zncc.toFixed(6)),
                    ngf: Number(metrics.ngf.toFixed(6)),
                    census: Number(metrics.census.toFixed(6)),
                    mind: metrics.mind != null ? Number(metrics.mind.toFixed(6)) : null,
                    phase: metrics.phase != null ? Number(metrics.phase.toFixed(6)) : null,
                    mi: Number(metrics.mi.toFixed(6)),
                    nmi: Number(metrics.nmi.toFixed(6)),
                    miGrad: metrics.miGrad != null ? Number(metrics.miGrad.toFixed(6)) : null,
                    nmiGrad: metrics.nmiGrad != null ? Number(metrics.nmiGrad.toFixed(6)) : null,
                    pixelsUsed: metrics.pixelsUsed ?? null,
                  },
                  debugAlignment
                );
              }
            : undefined;

          const searchResult = await findBestMatchingSlice(
            referencePixelsForSliceSearch,
            getSlicePixels,
            reference.sliceIndex,
            reference.sliceCount,
            seriesRef.instance_count,
            (slicesChecked, bestMiSoFar) => {
              // Avoid re-rendering React UI on every slice (which can be surprisingly expensive).
              const t = nowMs();
              if (t - lastProgressUpdateMs < progressUpdateMinIntervalMs && slicesChecked !== 1) {
                return;
              }
              lastProgressUpdateMs = t;

              setState((s) => ({
                ...s,
                progress: s.progress
                  ? {
                      ...s.progress,
                      slicesChecked,
                      bestMiSoFar,
                    }
                  : null,
              }));
            },
            {
              startIndexOverride: seedIdx,
              minIndex: sliceSearchMinIndex,
              maxIndex: sliceSearchMaxIndex,
              scoreMetric: SLICE_SEARCH_SCORE_METRIC,
              ssimBlockSize: SLICE_SEARCH_SSIM_BLOCK_SIZE,
              mindSize: SLICE_SEARCH_MIND_SIZE,
              phaseSize: SLICE_SEARCH_PHASE_SIZE,
              miBins: SLICE_SEARCH_MI_BINS,
              stopDecreaseStreak: SLICE_SEARCH_STOP_DECREASE_STREAK,
              minSearchRadius: SLICE_SEARCH_MIN_SEARCH_RADIUS,
              yieldEverySlices: SLICE_SEARCH_YIELD_EVERY_SLICES,
              yieldFn: yieldToMain,
              onSliceScored,
              inclusionMask: sliceSearchInclusionMask,
              // Pass exclusion mask for tumor avoidance.
              exclusionRect: reference.exclusionMask,
              imageWidth: SLICE_SEARCH_IMAGE_SIZE,
              imageHeight: SLICE_SEARCH_IMAGE_SIZE,
              gradient:
                referenceGradPixelsForSliceSearch && SLICE_SEARCH_GRADIENT_WEIGHT !== 0
                  ? { referenceGradPixels: referenceGradPixelsForSliceSearch, weight: SLICE_SEARCH_GRADIENT_WEIGHT }
                  : undefined,
            }
          );

          // Ensure the UI is up-to-date with the final search outcome even if throttling skipped it.
          setState((s) => ({
            ...s,
            progress: s.progress
              ? {
                  ...s.progress,
                  slicesChecked: searchResult.slicesChecked,
                  bestMiSoFar: searchResult.bestMI,
                }
              : null,
          }));

          console.info('[alignment] Slice search finished', {
            date,
            strategy: 'seeded',
            scoreMetric: SLICE_SEARCH_SCORE_METRIC,
            bestIndex: searchResult.bestIndex,
            bestScore: Number(searchResult.bestMI.toFixed(6)),
            slicesChecked: searchResult.slicesChecked,
          });

          debugAlignmentLog(
            'slice-search.perf',
            {
              date,
              strategy: 'seeded',
              scoreMetric: SLICE_SEARCH_SCORE_METRIC,
              size: SLICE_SEARCH_IMAGE_SIZE,
              ssimBlockSize: SLICE_SEARCH_SSIM_BLOCK_SIZE,
              bins: SLICE_SEARCH_MI_BINS,
              stopDecreaseStreak: SLICE_SEARCH_STOP_DECREASE_STREAK,
              minSearchRadius: SLICE_SEARCH_MIN_SEARCH_RADIUS,
              bounds: {
                minIndex: sliceSearchMinIndex,
                maxIndex: sliceSearchMaxIndex,
              },
              yieldEverySlices: SLICE_SEARCH_YIELD_EVERY_SLICES,
              gradientWeight: SLICE_SEARCH_GRADIENT_WEIGHT,
              slicesChecked: searchResult.slicesChecked,
              scoreMs: searchResult.timingMs?.scoreMs,
              renderMs: sliceSearchRenderMs,
              warpMs: sliceSearchWarpMs,
            },
            debugAlignment
          );

          if (abortRef.current) {
            setState((s) => ({ ...s, isAligning: false, error: 'Alignment cancelled' }));
            return results;
          }

          // 3) Refine the affine transform on the best slice.
          setState((s) => ({
            ...s,
            progress: s.progress
              ? {
                  ...s.progress,
                  phase: 'computing',
                }
              : null,
          }));

          console.info('[alignment] Refinement starting', { date, bestSliceIndex: searchResult.bestIndex });

          const bestRender = await renderSliceToPixels(
            renderElement,
            seriesRef.series_uid,
            searchResult.bestIndex,
            ALIGNMENT_IMAGE_SIZE,
            captureScratchFull
          );

          const tRefine0 = nowMs();
          const refined = await registerAffine2DWithElastix(referencePixels, bestRender.pixels, ALIGNMENT_IMAGE_SIZE, {
            numberOfResolutions: REFINEMENT_REGISTRATION_RESOLUTIONS,
            webWorker: sharedWebWorker,
            exclusionRect: reference.exclusionMask,
          });
          const refinementMs = nowMs() - tRefine0;

          sharedWebWorker = refined.webWorker;

          const refinedNmi = refined.quality.nmi;

          console.info('[alignment] Refinement finished', {
            date,
            nmi: Number(refinedNmi.toFixed(4)),
            refinementMs: Math.round(refinementMs),
            renderMs: Math.round(bestRender.timingMs.total),
          });

          debugAlignmentLog(
            'refine.perf',
            {
              date,
              bestSliceIndex: searchResult.bestIndex,
              numberOfResolutions: REFINEMENT_REGISTRATION_RESOLUTIONS,
              refinementMs,
              renderTimingMs: bestRender.timingMs,
            },
            debugAlignment
          );

          debugAlignmentLog(
            'refine.registration',
            {
              date,
              bestSliceIndex: searchResult.bestIndex,
              coarseBestMi: searchResult.bestMI,
              refinedNmi,
              mi: refined.quality.mi,
              elastixFinalMetric: refined.quality.elastixFinalMetric,
              elastixMetricSamples: refined.quality.elastixMetricSamples,
              translatePx: refined.translatePx,
              A: refined.A,
            },
            debugAlignment
          );

          const targetStats = computeHistogramStats(refined.resampledMovingPixels);

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

          const origin = { x: (ALIGNMENT_IMAGE_SIZE - 1) / 2, y: (ALIGNMENT_IMAGE_SIZE - 1) / 2 };

          const refAffine = panelGeometryToAffineAboutCenter(referenceGeometry, ALIGNMENT_IMAGE_SIZE);
          const deltaAffine = {
            A: refined.A,
            origin,
            t: { x: refined.translatePx.x, y: refined.translatePx.y },
          };

          const refStd = affineAboutOriginToStandard(refAffine);
          const deltaStd = affineAboutOriginToStandard(deltaAffine);

          // Composition order matters:
          // - `deltaStd` maps target -> reference (in the downsampled alignment pixel space)
          // - `refStd` maps reference -> displayed reference
          // To display the *target* in the same view as the reference we want:
          //   displayed = refStd(deltaStd(x_target))
          const composedStd = composeStandardAffine2D(refStd, deltaStd);

          const composedAboutOrigin = standardToAffineAboutOrigin(composedStd.A, composedStd.b, origin);
          const composedGeometry = affineAboutCenterToPanelGeometry(
            { A: composedAboutOrigin.A, translatePx: composedAboutOrigin.t },
            ALIGNMENT_IMAGE_SIZE
          );

          const computedSettings = computeAlignedSettings(
            referenceDisplayedStats,
            targetStats,
            searchResult.bestIndex,
            seriesRef.instance_count,
            currentProgress,
            composedGeometry
          );

          const result: AlignmentResult = {
            date,
            seriesUid: seriesRef.series_uid,
            bestSliceIndex: searchResult.bestIndex,
            nmiScore: refinedNmi,
            computedSettings,
            slicesChecked: searchResult.slicesChecked,
          };

          results.push(result);

          setState((s) => ({
            ...s,
            results: [...results],
          }));

          await yieldToMain();
        }

        setState((s) => ({
          ...s,
          isAligning: false,
          progress: null,
          results,
        }));

        return results;
      } catch (err) {
        const errorMsg = err instanceof Error ? err.message : 'Alignment failed';
        setState((s) => ({
          ...s,
          isAligning: false,
          progress: null,
          error: errorMsg,
        }));
        throw err;
      } finally {
        disposeCornerstoneRenderElement(renderElement);
      }
    },
    []
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
