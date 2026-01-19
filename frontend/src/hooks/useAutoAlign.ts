import { useState, useCallback, useRef } from 'react';
import cornerstone from 'cornerstone-core';
import type { JsonCompatible } from 'itk-wasm';
import type { AlignmentReference, AlignmentResult, AlignmentProgress, SeriesRef } from '../types/api';
import { computeAlignedSettings, findBestMatchingSlice } from '../utils/alignment';
import { ALIGNMENT_IMAGE_SIZE, computeHistogramStats } from '../utils/imageCapture';
import { clamp } from '../utils/math';
import { getImageIdForInstance } from '../utils/localApi';
import { registerAffine2DWithElastix } from '../utils/elastixRegistration';
import { warpGrayscaleAffine } from '../utils/warpAffine';
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

const DEBUG_ALIGNMENT_STORAGE_KEY = 'miraviewer:debug-alignment';

function isDebugAlignmentEnabled(): boolean {
  return typeof window !== 'undefined' && window.localStorage.getItem(DEBUG_ALIGNMENT_STORAGE_KEY) === '1';
}

type SeedRegistrationResult = {
  idx: number;
  nmi: number;
  transformA: { m00: number; m01: number; m10: number; m11: number };
  transformT: { x: number; y: number };
  transformParameterObject: JsonCompatible;
  webWorker: Worker;
};

/**
 * Yield to the main thread to keep UI responsive during alignment.
 */
function yieldToMain(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function debugAlignmentLog(step: string, details: Record<string, unknown>, enabled: boolean) {
  if (!enabled) return;
  console.log(`[alignment] ${step}`, details);
}

type CornerstoneImageRenderedEvent = CustomEvent<{ image?: { imageId?: string } }>;

/**
 * Cornerstone may render asynchronously (via requestAnimationFrame).
 *
 * If we read the internal canvas immediately after displayImage, we can occasionally capture
 * the previous frame, which makes transform recovery appear "non-deterministic".
 */
function waitForCornerstoneImageRendered(
  element: HTMLElement,
  expectedImageId: string,
  timeoutMs = 200
): Promise<{ timedOut: boolean; renderedImageId: string | null }> {
  return new Promise((resolve) => {
    let settled = false;

    const cleanup = (timer: number, handler: (evt: Event) => void) => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timer);
      element.removeEventListener('cornerstoneimagerendered', handler);
    };

    const handler = (evt: Event) => {
      const ev = evt as CornerstoneImageRenderedEvent;
      const renderedId = ev.detail?.image?.imageId;

      // If we can't read imageId from the event, accept it.
      // Otherwise, only accept the render for the image we just displayed.
      if (!renderedId || renderedId === expectedImageId) {
        cleanup(timer, handler);
        resolve({ timedOut: false, renderedImageId: renderedId ?? null });
      }
    };

    const timer = window.setTimeout(() => {
      cleanup(timer, handler);
      resolve({ timedOut: true, renderedImageId: null });
    }, timeoutMs);

    element.addEventListener('cornerstoneimagerendered', handler);
  });
}

type RenderedSlice = {
  pixels: Float32Array;
  imageId: string;
  expectedImageId: string;
  renderedImageId: string | null;
  renderTimedOut: boolean;
  sourceCanvasWidth: number;
  sourceCanvasHeight: number;
  targetSize: number;
};

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

function createCornerstoneRenderElement(sizePx: number): HTMLDivElement {
  const el = document.createElement('div');
  el.style.position = 'absolute';
  el.style.left = '-10000px';
  el.style.top = '-10000px';
  el.style.width = `${sizePx}px`;
  el.style.height = `${sizePx}px`;
  el.style.overflow = 'hidden';
  el.style.background = 'black';
  el.style.pointerEvents = 'none';

  document.body.appendChild(el);
  cornerstone.enable(el);
  return el;
}

function disposeCornerstoneRenderElement(el: HTMLDivElement) {
  try {
    cornerstone.disable(el);
  } catch {
    // ignore
  }

  try {
    el.remove();
  } catch {
    // ignore
  }
}

/**
 * Render a DICOM slice to a downsampled grayscale Float32Array.
 *
 * Important:
 * - We render the slice via Cornerstone into a hidden enabled element so the output matches
 *   the viewer's default window/level behavior.
 * - We then draw into a fixed-size square buffer so downstream registration has a stable,
 *   deterministic pixel grid.
 */
async function renderSliceToPixels(
  renderElement: HTMLDivElement,
  seriesUid: string,
  sliceIndex: number,
  targetSize: number = ALIGNMENT_IMAGE_SIZE
): Promise<RenderedSlice> {
  const imageId = await getImageIdForInstance(seriesUid, sliceIndex);
  const image = await cornerstone.loadImage(imageId);

  const viewport = cornerstone.getDefaultViewportForImage(renderElement, image);

  // Wait for Cornerstone to actually draw this image before reading from its canvas.
  const expectedImageId = (image as unknown as { imageId?: string }).imageId || imageId;
  const renderPromise = waitForCornerstoneImageRendered(renderElement, expectedImageId);

  cornerstone.displayImage(renderElement, image, viewport);
  const renderInfo = await renderPromise;

  const sourceCanvas = renderElement.querySelector('canvas') as HTMLCanvasElement | null;
  if (!sourceCanvas) {
    throw new Error('Cornerstone did not create a canvas for rendering');
  }

  const canvas = document.createElement('canvas');
  canvas.width = targetSize;
  canvas.height = targetSize;

  const ctx = canvas.getContext('2d');
  if (!ctx) {
    throw new Error('Failed to get 2D context');
  }

  ctx.fillStyle = 'black';
  ctx.fillRect(0, 0, targetSize, targetSize);

  // Draw the Cornerstone output into a stable target resolution.
  ctx.drawImage(sourceCanvas, 0, 0, targetSize, targetSize);

  const imageData = ctx.getImageData(0, 0, targetSize, targetSize);
  const data = imageData.data;
  const pixels = new Float32Array(targetSize * targetSize);

  for (let i = 0; i < pixels.length; i++) {
    const idx = i * 4;
    const r = data[idx];
    const g = data[idx + 1];
    const b = data[idx + 2];
    pixels[i] = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
  }

  return {
    pixels,
    imageId,
    expectedImageId,
    renderedImageId: renderInfo.renderedImageId,
    renderTimedOut: renderInfo.timedOut,
    sourceCanvasWidth: sourceCanvas.width,
    sourceCanvasHeight: sourceCanvas.height,
    targetSize,
  };
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
          bestNmiSoFar: 0,
        },
        results: [],
        error: null,
      });

      // Single render element used for all captures at ALIGNMENT_IMAGE_SIZE.
      const renderElement = createCornerstoneRenderElement(ALIGNMENT_IMAGE_SIZE);

      const debugAlignment = isDebugAlignmentEnabled();

      console.info('[alignment] Align All started', {
        referenceDate: reference.date,
        referenceSeriesUid: reference.seriesUid,
        referenceSliceIndex: reference.sliceIndex,
        referenceSliceCount: reference.sliceCount,
        targetDates: targetDates.length,
        debug: debugAlignment,
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
        ALIGNMENT_IMAGE_SIZE
      );

      console.info('[alignment] Reference slice rendered', {
        imageId: referenceRender.imageId,
        expectedImageId: referenceRender.expectedImageId,
        renderedImageId: referenceRender.renderedImageId,
        renderTimedOut: referenceRender.renderTimedOut,
      });
      const referencePixels = referenceRender.pixels;

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
              bestNmiSoFar: 0,
            },
          }));

          // Yield to keep UI responsive.
          await yieldToMain();

          const startIdxUnclamped = Math.round(
            (reference.sliceIndex / Math.max(1, reference.sliceCount - 1)) * (seriesRef.instance_count - 1)
          );
          const startIdx = clamp(startIdxUnclamped, 0, Math.max(0, seriesRef.instance_count - 1));

          const windowSteps = Math.max(1, Math.round((Math.max(0, seriesRef.instance_count - 1)) * 0.05));
          const seedIndices = Array.from(
            new Set([
              startIdx,
              clamp(startIdx - windowSteps, 0, Math.max(0, seriesRef.instance_count - 1)),
              clamp(startIdx + windowSteps, 0, Math.max(0, seriesRef.instance_count - 1)),
            ])
          );

          debugAlignmentLog(
            'date.seed-plan',
            {
              date,
              startIdx,
              windowSteps,
              seedIndices,
              meta: {
                seriesUid: seriesRef.series_uid,
                referenceSeriesUid: reference.seriesUid,
              },
            },
            debugAlignment
          );

          console.info('[alignment] Seed plan', {
            date,
            seriesUid: seriesRef.series_uid,
            instanceCount: seriesRef.instance_count,
            startIdx,
            seedIndices,
          });

          // 1) Get a coarse affine transform from a small seed set.
          //
          // This seed transform is used for two things:
          // - It gives us a decent initial alignment quickly.
          // - It lets the subsequent slice-search score candidates in approximately the
          //   right space (by pre-warping each candidate slice before NMI).
          let bestSeed: SeedRegistrationResult | null = null;

          for (const idx of seedIndices) {
            console.info('[alignment] Seed registration starting', { date, seedIdx: idx });

            const seedRender = await renderSliceToPixels(renderElement, seriesRef.series_uid, idx, ALIGNMENT_IMAGE_SIZE);

            const reg = await registerAffine2DWithElastix(referencePixels, seedRender.pixels, ALIGNMENT_IMAGE_SIZE, {
              // Fewer resolutions helps keep the seed stage fast.
              numberOfResolutions: 2,
              webWorker: sharedWebWorker,
            });

            sharedWebWorker = reg.webWorker;

            const nmi = reg.quality.nmi;

            console.info('[alignment] Seed registration finished', {
              date,
              seedIdx: idx,
              nmi: Number(nmi.toFixed(4)),
            });

            debugAlignmentLog(
              'seed.registration',
              {
                date,
                seedIdx: idx,
                nmi,
                mi: reg.quality.mi,
                elastixFinalMetric: reg.quality.elastixFinalMetric,
                elastixMetricSamples: reg.quality.elastixMetricSamples,
                translatePx: { x: reg.translatePx.x, y: reg.translatePx.y },
                A: reg.A,
                renderTimedOut: seedRender.renderTimedOut,
                render: {
                  imageId: seedRender.imageId,
                  expectedImageId: seedRender.expectedImageId,
                  renderedImageId: seedRender.renderedImageId,
                },
              },
              debugAlignment
            );

            if (!bestSeed || nmi > bestSeed.nmi) {
              bestSeed = {
                idx,
                nmi,
                transformA: reg.A,
                transformT: reg.translatePx,
                transformParameterObject: reg.transformParameterObject,
                webWorker: reg.webWorker,
              };
            }

            await yieldToMain();
          }

          if (!bestSeed) {
            throw new Error('Failed to find an initial seed transform');
          }

          debugAlignmentLog(
            'seed.chosen',
            {
              date,
              startIdx,
              chosenSeedIdx: bestSeed.idx,
              chosenSeedNmi: bestSeed.nmi,
              translatePx: bestSeed.transformT,
              A: bestSeed.transformA,
            },
            debugAlignment
          );

          console.info('[alignment] Seed chosen', {
            date,
            seedIdx: bestSeed.idx,
            nmi: Number(bestSeed.nmi.toFixed(4)),
          });

          // 2) Use the seed transform to drive a fast NMI-based slice search.
          //
          // Instead of scoring raw slices against the reference, we pre-warp each candidate slice
          // by the seed transform. This reduces the chance that differences in in-plane pose
          // dominate the slice similarity score.
          const getSlicePixels = async (index: number): Promise<Float32Array> => {
            const rendered = await renderSliceToPixels(renderElement, seriesRef.series_uid, index, ALIGNMENT_IMAGE_SIZE);
            return warpGrayscaleAffine(rendered.pixels, ALIGNMENT_IMAGE_SIZE, {
              A: bestSeed.transformA,
              translateX: bestSeed.transformT.x,
              translateY: bestSeed.transformT.y,
            });
          };

          console.info('[alignment] Slice search starting', {
            date,
            referenceSliceIndex: reference.sliceIndex,
            referenceSliceCount: reference.sliceCount,
            targetSliceCount: seriesRef.instance_count,
          });

          const searchResult = await findBestMatchingSlice(
            referencePixels,
            getSlicePixels,
            reference.sliceIndex,
            reference.sliceCount,
            seriesRef.instance_count,
            (slicesChecked, bestNmiSoFar) => {
              setState((s) => ({
                ...s,
                progress: s.progress
                  ? {
                      ...s.progress,
                      slicesChecked,
                      bestNmiSoFar,
                    }
                  : null,
              }));
            },
            // Start from the best coarse-registration seed index rather than a purely depth-normalized guess.
            bestSeed.idx
          );

          console.info('[alignment] Slice search finished', {
            date,
            bestIndex: searchResult.bestIndex,
            bestNmi: Number(searchResult.bestNMI.toFixed(4)),
            slicesChecked: searchResult.slicesChecked,
          });

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
            ALIGNMENT_IMAGE_SIZE
          );

          const refined = await registerAffine2DWithElastix(referencePixels, bestRender.pixels, ALIGNMENT_IMAGE_SIZE, {
            numberOfResolutions: 3,
            initialTransformParameterObject: bestSeed.transformParameterObject,
            webWorker: sharedWebWorker,
          });

          sharedWebWorker = refined.webWorker;

          const refinedNmi = refined.quality.nmi;

          console.info('[alignment] Refinement finished', { date, nmi: Number(refinedNmi.toFixed(4)) });

          debugAlignmentLog(
            'refine.registration',
            {
              date,
              bestSliceIndex: searchResult.bestIndex,
              coarseBestNmi: searchResult.bestNMI,
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
