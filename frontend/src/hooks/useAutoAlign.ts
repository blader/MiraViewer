import { useState, useCallback, useRef } from 'react';
import cornerstone from 'cornerstone-core';
import type { AlignmentReference, AlignmentResult, AlignmentProgress, SeriesRef } from '../types/api';
import { computeAlignedSettings, computeNCC, findBestMatchingSlice } from '../utils/alignment';
import { CONTROL_LIMITS } from '../utils/constants';
import { ALIGNMENT_IMAGE_SIZE, computeHistogramStats, downsampleGrayscalePixels } from '../utils/imageCapture';
import { clamp, normalizeRotation } from '../utils/math';
import { getImageIdForInstance } from '../utils/localApi';
import { prepareTransformReference, recoverSimilarityTransform, warpGrayscale } from '../utils/transformRecovery';

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

type RenderTransform = {
  zoom: number;
  rotation: number; // degrees
  panX: number; // normalized (-1..1)
  panY: number; // normalized (-1..1)
};

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

function warpPixels(pixels: Float32Array, size: number, transform: RenderTransform): Float32Array {
  return warpGrayscale(pixels, size, {
    zoom: transform.zoom,
    rotationDeg: transform.rotation,
    translateX: transform.panX * size,
    translateY: transform.panY * size,
  });
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
    out[i] = clamp(y, 0, 1);
  }
  return out;
}

function composeTransforms(reference: RenderTransform, delta: RenderTransform): RenderTransform {
  // Both transforms are similarity transforms applied around the image center, with translation in
  // display-space (i.e. translation is applied after rotation+scale).
  //
  // We want: final = reference ∘ delta
  //
  // q'  = zD * R(D) * q + tD
  // q'' = zR * R(R) * q' + tR
  //     = (zR*zD) * R(R)*R(D) * q + zR*R(R)*tD + tR
  const zR = reference.zoom;
  const zD = delta.zoom;

  const rotR = (reference.rotation * Math.PI) / 180;
  const cosR = Math.cos(rotR);
  const sinR = Math.sin(rotR);

  const tDx = delta.panX;
  const tDy = delta.panY;

  const tRotX = cosR * tDx - sinR * tDy;
  const tRotY = sinR * tDx + cosR * tDy;

  const panX = reference.panX + zR * tRotX;
  const panY = reference.panY + zR * tRotY;

  const zoom = clamp(zR * zD, CONTROL_LIMITS.ZOOM.MIN, CONTROL_LIMITS.ZOOM.MAX);

  return {
    zoom,
    rotation: normalizeRotation(reference.rotation + delta.rotation),
    panX: clamp(panX, -1, 1),
    panY: clamp(panY, -1, 1),
  };
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
 * - We then apply an additional pan/zoom/rotation transform in a separate canvas step.
 *   This lets us score slices in a consistent "view space" (e.g. after recovering a
 *   similarity transform via phase correlation).
 */
async function renderSliceToPixels(
  renderElement: HTMLDivElement,
  seriesUid: string,
  sliceIndex: number,
  transform: RenderTransform,
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

  // Apply the reference transform in a separate capture canvas.
  const canvas = document.createElement('canvas');
  canvas.width = targetSize;
  canvas.height = targetSize;

  const ctx = canvas.getContext('2d');
  if (!ctx) {
    throw new Error('Failed to get 2D context');
  }

  ctx.fillStyle = 'black';
  ctx.fillRect(0, 0, targetSize, targetSize);

  const panXPx = transform.panX * targetSize;
  const panYPx = transform.panY * targetSize;

  ctx.save();
  ctx.translate(targetSize / 2, targetSize / 2);
  ctx.translate(panXPx, panYPx);
  ctx.scale(transform.zoom, transform.zoom);
  ctx.rotate((transform.rotation * Math.PI) / 180);
  ctx.translate(-targetSize / 2, -targetSize / 2);

  ctx.drawImage(sourceCanvas, 0, 0, targetSize, targetSize);
  ctx.restore();

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
          bestNccSoFar: 0,
        },
        results: [],
        error: null,
      });

      // Render elements:
      // - Coarse: small for speed (used for seed transforms + slice search)
      // - Refine: larger for final transform refinement stability/precision
      const FINAL_REFINE_IMAGE_SIZE = 512;
      const renderElementCoarse = createCornerstoneRenderElement(ALIGNMENT_IMAGE_SIZE);
      const renderElementFine = createCornerstoneRenderElement(FINAL_REFINE_IMAGE_SIZE);

      // We recover rotation/scale/translation at a lower resolution for speed,
      // then refine the transform on the final best slice at higher resolution.
      const TRANSFORM_COARSE_SIZE = 128;

      const identityTransform: RenderTransform = {
        zoom: 1,
        rotation: 0,
        panX: 0,
        panY: 0,
      };

      const debugAlignment =
        typeof window !== 'undefined' &&
        window.localStorage.getItem('miraviewer:debug-alignment') === '1';

      // Precompute reference data used for transform recovery (once per alignment run).
      //
      // We intentionally render the reference slice from DICOM directly (identity view space)
      // instead of relying on a viewer capture/screenshot.
      const referenceRenderCoarse = await renderSliceToPixels(
        renderElementCoarse,
        reference.seriesUid,
        reference.sliceIndex,
        identityTransform,
        ALIGNMENT_IMAGE_SIZE
      );
      const referencePixelsForCoarse = referenceRenderCoarse.pixels;

      const refCoarse = downsampleGrayscalePixels(
        referencePixelsForCoarse,
        ALIGNMENT_IMAGE_SIZE,
        ALIGNMENT_IMAGE_SIZE,
        TRANSFORM_COARSE_SIZE,
        TRANSFORM_COARSE_SIZE
      );

      const referenceCoarseStats = computeHistogramStats(refCoarse.pixels);
      const transformRefCoarse = prepareTransformReference(refCoarse.pixels, TRANSFORM_COARSE_SIZE);

      // Final refinement runs at a higher resolution (512x512) for more stable/precise
      // transform recovery.
      const referenceRenderRefine = await renderSliceToPixels(
        renderElementFine,
        reference.seriesUid,
        reference.sliceIndex,
        identityTransform,
        FINAL_REFINE_IMAGE_SIZE
      );
      const referencePixelsRefineRaw = referenceRenderRefine.pixels;

      // For NCC scoring we need mean/stddev; for intensity matching we want the
      // reference *as displayed* (after brightness/contrast).
      const referenceRefineRawStats = computeHistogramStats(referencePixelsRefineRaw);
      const referenceRefineDisplayedPixels = applyBrightnessContrastToPixels(
        referencePixelsRefineRaw,
        reference.settings.brightness,
        reference.settings.contrast
      );
      const referenceRefineDisplayedStats = computeHistogramStats(referenceRefineDisplayedPixels);

      const transformRefRefine = prepareTransformReference(referencePixelsRefineRaw, FINAL_REFINE_IMAGE_SIZE);

      // Flip the progress UI to matching now that the reference is ready.
      setState((s) => ({
        ...s,
        progress: s.progress ? { ...s.progress, phase: 'matching' } : null,
      }));

      try {
        for (let dateIdx = 0; dateIdx < targetDates.length; dateIdx++) {
          if (abortRef.current) {
            setState((s) => ({ ...s, isAligning: false, error: 'Alignment cancelled' }));
            return results;
          }

          const date = targetDates[dateIdx];
          const seriesRef = seriesMap[date];

          if (!seriesRef) {
            // No data for this date, skip
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
              bestNccSoFar: 0,
            },
          }));

          // Yield to keep UI responsive
          await yieldToMain();

          // 1) Recover a per-date similarity transform (rotation/scale/translation) first.
          //
          // Important: if we try to recover transform on the wrong slice, correlation can fail.
          // We therefore try a few seed slices around the normalized-depth start index and
          // choose the transform that yields the best NCC against the reference.
          const startIdxUnclamped = Math.round(
            (reference.sliceIndex / Math.max(1, reference.sliceCount - 1)) * (seriesRef.instance_count - 1)
          );
          const startIdx = clamp(startIdxUnclamped, 0, Math.max(0, seriesRef.instance_count - 1));

          const REQUIRED_WINDOW_FRACTION = 0.1;
          const windowSteps = Math.max(
            1,
            Math.round((Math.max(0, seriesRef.instance_count - 1)) * REQUIRED_WINDOW_FRACTION)
          );

          // Seed offsets are expressed as fractions of the required window so we try a few
          // anatomically-nearby candidates without jumping all the way to the edge of the window.
          // We apply each non-zero magnitude in both directions around the start index.
          const seedOffsets = [0, 0.1, 0.2, 0.4, 0.8].flatMap((fraction) => {
            const mag = Math.round(windowSteps * fraction);
            return mag === 0 ? [0] : [-mag, mag];
          });

          const seedIndices = Array.from(
            new Set(
              seedOffsets
                .map((o) => clamp(startIdx + o, 0, Math.max(0, seriesRef.instance_count - 1)))
                .filter((v) => Number.isFinite(v))
            )
          );

          debugAlignmentLog(
            'date.seed-plan',
            {
              date,
              refSliceIndex: reference.sliceIndex,
              refSliceCount: reference.sliceCount,
              targetSliceCount: seriesRef.instance_count,
              startIdx,
              windowSteps,
              seedIndicesCount: seedIndices.length,
              seedIndices,
              seedOffsets,
              meta: {
                seriesUid: seriesRef.series_uid,
                referenceSeriesUid: reference.seriesUid,
              },
            },
            debugAlignment
          );

          const MAX_PLAUSIBLE_ROTATION_DELTA_DEG = 10;
          const MAX_PLAUSIBLE_ZOOM_RATIO = 1.5;
          const MIN_PLAUSIBLE_CONFIDENCE = 0.2;

          // We keep two candidates:
          // - bestOverall: purely best NCC (fallback)
          // - bestPlausible: best NCC among transforms that are "reasonable" deltas
          //                 in identity view space (near 0° rotation, ~1x zoom).
          let bestOverall: {
            idx: number;
            ncc: number;
            confidence: number;
            debug: unknown;
            transform: RenderTransform;
          } = {
            idx: startIdx,
            ncc: -1,
            confidence: 0,
            debug: null,
            transform: {
              zoom: 1,
              rotation: 0,
              panX: 0,
              panY: 0,
            },
          };

          let bestPlausible: {
            idx: number;
            ncc: number;
            confidence: number;
            debug: unknown;
            transform: RenderTransform;
          } | null = null;

          for (const idx of seedIndices) {
            const seedRender = await renderSliceToPixels(
              renderElementCoarse,
              seriesRef.series_uid,
              idx,
              identityTransform,
              TRANSFORM_COARSE_SIZE
            );
            const raw = seedRender.pixels;

            const recovered = recoverSimilarityTransform(transformRefCoarse, raw, {
              includeDebug: debugAlignment,
            });

            const t: RenderTransform = {
              zoom: recovered.zoom,
              rotation: recovered.rotation,
              panX: recovered.panX,
              panY: recovered.panY,
            };

            const aligned = warpPixels(raw, TRANSFORM_COARSE_SIZE, t);
            const ncc = computeNCC(
              refCoarse.pixels,
              aligned,
              { mean: referenceCoarseStats.mean, stddev: referenceCoarseStats.stddev }
            );

            const rotationDeltaDeg = Math.abs(normalizeRotation(t.rotation));
            const zoomRatio = t.zoom;
            const plausible =
              recovered.confidence >= MIN_PLAUSIBLE_CONFIDENCE &&
              rotationDeltaDeg <= MAX_PLAUSIBLE_ROTATION_DELTA_DEG &&
              zoomRatio >= 1 / MAX_PLAUSIBLE_ZOOM_RATIO &&
              zoomRatio <= MAX_PLAUSIBLE_ZOOM_RATIO;

            debugAlignmentLog(
              'seed.transform',
              {
                date,
                seedIdx: idx,
                ncc,
                rotation: t.rotation,
                zoom: t.zoom,
                panX: t.panX,
                panY: t.panY,
                confidence: recovered.confidence,
                plausible,
                rotationDeltaDeg,
                zoomRatio,
                renderTimedOut: seedRender.renderTimedOut,
                render: {
                  imageId: seedRender.imageId,
                  expectedImageId: seedRender.expectedImageId,
                  renderedImageId: seedRender.renderedImageId,
                  sourceCanvasWidth: seedRender.sourceCanvasWidth,
                  sourceCanvasHeight: seedRender.sourceCanvasHeight,
                  targetSize: seedRender.targetSize,
                },
                // The transform recovery debug includes A/B candidate PSRs for the 180° ambiguity.
                debug: recovered.debug,
                meta: {
                  seriesUid: seriesRef.series_uid,
                },
              },
              debugAlignment
            );

            if (ncc > bestOverall.ncc) {
              bestOverall = {
                idx,
                ncc,
                confidence: recovered.confidence,
                debug: recovered.debug ?? null,
                transform: t,
              };
            }

            if (plausible) {
              if (!bestPlausible || ncc > bestPlausible.ncc) {
                bestPlausible = {
                  idx,
                  ncc,
                  confidence: recovered.confidence,
                  debug: recovered.debug ?? null,
                  transform: t,
                };
              }
            }

            // Yield between seed attempts.
            await yieldToMain();
          }

          const chosen = bestPlausible ?? bestOverall;
          const chosenCoarseTransform = chosen.transform;
          const chosenSeedIdx = chosen.idx;
          const chosenSeedNcc = chosen.ncc;
          const chosenSeedConfidence = chosen.confidence;
          const chosenSeedDebug = chosen.debug;

          debugAlignmentLog(
            'seed.chosen',
            {
              date,
              startIdx,
              chosenSeedIdx,
              chosenSeedNcc,
              chosenRotation: chosenCoarseTransform.rotation,
              chosenZoom: chosenCoarseTransform.zoom,
              chosenPanX: chosenCoarseTransform.panX,
              chosenPanY: chosenCoarseTransform.panY,
              confidence: chosenSeedConfidence,
              source: bestPlausible ? 'plausible' : 'overall',
              debug: chosenSeedDebug,
              meta: {
                seriesUid: seriesRef.series_uid,
              },
            },
            debugAlignment
          );

          // Create a function to get slice pixels for this series (coarse, transform-aware).
          // We render the slice in identity view space, then warp pixels using the recovered transform.
          const getSlicePixels = async (index: number): Promise<Float32Array> => {
            const rendered = await renderSliceToPixels(
              renderElementCoarse,
              seriesRef.series_uid,
              index,
              identityTransform,
              TRANSFORM_COARSE_SIZE
            );
            return warpPixels(rendered.pixels, TRANSFORM_COARSE_SIZE, chosenCoarseTransform);
          };

          // 2) Find the best matching slice using NCC across candidate slices.
          const searchResult = await findBestMatchingSlice(
            refCoarse.pixels,
            { mean: referenceCoarseStats.mean, stddev: referenceCoarseStats.stddev },
            getSlicePixels,
            reference.sliceIndex,
            reference.sliceCount,
            seriesRef.instance_count,
            (slicesChecked, bestNccSoFar) => {
              setState((s) => ({
                ...s,
                progress: s.progress
                  ? {
                      ...s.progress,
                      slicesChecked,
                      bestNccSoFar,
                    }
                  : null,
              }));
            }
          );

          if (abortRef.current) {
            setState((s) => ({ ...s, isAligning: false, error: 'Alignment cancelled' }));
            return results;
          }

          // Compute intensity matching for the best slice
          setState((s) => ({
            ...s,
            progress: s.progress
              ? {
                  ...s.progress,
                  phase: 'computing',
                }
              : null,
          }));

          // 3) Refine the transform on the best slice at full resolution, then compute
          // intensity matching and final panel settings.
          //
          // Coarse slice search runs at TRANSFORM_COARSE_SIZE and can sometimes select a different
          // slice than we'd choose at FINAL_REFINE_IMAGE_SIZE. To avoid refining the wrong slice,
          // we do a small fine-resolution preselect between:
          // - the coarse search best index
          // - the chosen seed index
          const finePreselectIndices = Array.from(new Set([searchResult.bestIndex, chosenSeedIdx]));

          const finePreselectSummaries: Array<{
            sliceIndex: number;
            ncc: number;
            renderTimedOut: boolean;
            renderedImageId: string | null;
            expectedImageId: string;
          }> = [];

          let initialRefineSliceIndex = finePreselectIndices[0];
          let initialRefineRender: RenderedSlice | null = null;
          let initialRefinePixelsRefineRaw: Float32Array | null = null;
          let bestFinePreselectNcc = -1;

          for (const idx of finePreselectIndices) {
            const render = await renderSliceToPixels(
              renderElementFine,
              seriesRef.series_uid,
              idx,
              identityTransform,
              FINAL_REFINE_IMAGE_SIZE
            );
            const raw = render.pixels;

            const aligned = warpPixels(raw, FINAL_REFINE_IMAGE_SIZE, chosenCoarseTransform);
            const ncc = computeNCC(
              referencePixelsRefineRaw,
              aligned,
              { mean: referenceRefineRawStats.mean, stddev: referenceRefineRawStats.stddev }
            );

            finePreselectSummaries.push({
              sliceIndex: idx,
              ncc,
              renderTimedOut: render.renderTimedOut,
              renderedImageId: render.renderedImageId,
              expectedImageId: render.expectedImageId,
            });

            if (ncc > bestFinePreselectNcc) {
              bestFinePreselectNcc = ncc;
              initialRefineSliceIndex = idx;
              initialRefineRender = render;
              initialRefinePixelsRefineRaw = raw;
            }

            await yieldToMain();
          }

          debugAlignmentLog(
            'refine.slice-preselect',
            {
              date,
              coarseBestIdx: searchResult.bestIndex,
              coarseBestNcc: searchResult.bestNCC,
              coarseSlicesChecked: searchResult.slicesChecked,
              seedChosenIdx: chosenSeedIdx,
              seedChosenNcc: chosenSeedNcc,
              coarseTransformRotation: chosenCoarseTransform.rotation,
              coarseTransformZoom: chosenCoarseTransform.zoom,
              candidates: finePreselectSummaries.map((c) => ({
                idx: c.sliceIndex,
                ncc: c.ncc,
                renderTimedOut: c.renderTimedOut,
              })),
              chosenIdx: initialRefineSliceIndex,
              chosenNcc: bestFinePreselectNcc,
              // Keep the full candidate metadata available (but nested) for deeper debugging.
              candidateMeta: finePreselectSummaries,
              meta: {
                seriesUid: seriesRef.series_uid,
              },
            },
            debugAlignment
          );

          if (!initialRefinePixelsRefineRaw || !initialRefineRender) {
            throw new Error('Failed to preselect a slice for refine');
          }

          const bestPixelsRefineRaw = initialRefinePixelsRefineRaw;

          const refinedTransformRaw = recoverSimilarityTransform(transformRefRefine, bestPixelsRefineRaw, {
            includeDebug: debugAlignment,
          });

          const baseFine: RenderTransform = {
            zoom: refinedTransformRaw.zoom,
            rotation: refinedTransformRaw.rotation,
            panX: refinedTransformRaw.panX,
            panY: refinedTransformRaw.panY,
          };

          // We treat this as an estimate: for real scans we sometimes see a 180° ambiguity.
          //
          // Variant disambiguation: pick the rotation (θ or θ+180) that's closest to 0° (modulo 360).
          // Tie-break: choose the lowest (most-negative) rotation among equally-close candidates.
          const r0 = normalizeRotation(baseFine.rotation);
          const r180 = normalizeRotation(r0 + 180);
          const d0 = Math.abs(r0);
          const d180 = Math.abs(r180);

          let refinedTransform: RenderTransform = { ...baseFine, rotation: r0 };
          if (d180 < d0 || (d180 === d0 && r180 < r0)) {
            refinedTransform = { ...baseFine, rotation: r180 };
          }

          const bestAlignedFine = warpPixels(bestPixelsRefineRaw, FINAL_REFINE_IMAGE_SIZE, refinedTransform);
          const bestVariantNcc = computeNCC(
            referencePixelsRefineRaw,
            bestAlignedFine,
            { mean: referenceRefineRawStats.mean, stddev: referenceRefineRawStats.stddev }
          );

          debugAlignmentLog(
            'refine.transform',
            {
              date,
              refineIdx: initialRefineSliceIndex,
              ncc: bestVariantNcc,
              rotation: refinedTransform.rotation,
              zoom: refinedTransform.zoom,
              panX: refinedTransform.panX,
              panY: refinedTransform.panY,
              confidence: refinedTransformRaw.confidence,
              coarseBestIdx: searchResult.bestIndex,
              coarseBestNcc: searchResult.bestNCC,
              renderTimedOut: initialRefineRender.renderTimedOut,
              render: {
                imageId: initialRefineRender.imageId,
                expectedImageId: initialRefineRender.expectedImageId,
                renderedImageId: initialRefineRender.renderedImageId,
                sourceCanvasWidth: initialRefineRender.sourceCanvasWidth,
                sourceCanvasHeight: initialRefineRender.sourceCanvasHeight,
                targetSize: initialRefineRender.targetSize,
              },
              debug: refinedTransformRaw.debug,
              meta: {
                seriesUid: seriesRef.series_uid,
              },
            },
            debugAlignment
          );

          // Optional local slice refinement around the refined slice and the coarse best slice.
          // This helps when the coarse slice search picks a near-miss, or when the seed-derived
          // transform makes a nearby slice look better at full resolution.
          const REFINE_SLICE_WINDOW = 2;
          const maxSliceIndex = Math.max(0, seriesRef.instance_count - 1);
          const refineNeighborhoodCenters = Array.from(new Set([initialRefineSliceIndex, searchResult.bestIndex]));
          const refineCandidateIndices = Array.from(
            new Set(
              refineNeighborhoodCenters.flatMap((center) => {
                const out: number[] = [];
                for (let di = -REFINE_SLICE_WINDOW; di <= REFINE_SLICE_WINDOW; di++) {
                  out.push(clamp(center + di, 0, maxSliceIndex));
                }
                return out;
              })
            )
          );

          let bestSliceIndex = initialRefineSliceIndex;
          let bestSliceNcc = bestVariantNcc;
          let bestSliceRaw = bestPixelsRefineRaw;
          let bestSliceAligned = bestAlignedFine;

          for (const idx of refineCandidateIndices) {
            if (idx === initialRefineSliceIndex) continue;

            const neighborRender = await renderSliceToPixels(
              renderElementFine,
              seriesRef.series_uid,
              idx,
              identityTransform,
              FINAL_REFINE_IMAGE_SIZE
            );
            const raw = neighborRender.pixels;

            const aligned = warpPixels(raw, FINAL_REFINE_IMAGE_SIZE, refinedTransform);
            const ncc = computeNCC(
              referencePixelsRefineRaw,
              aligned,
              { mean: referenceRefineRawStats.mean, stddev: referenceRefineRawStats.stddev }
            );

            if (ncc > bestSliceNcc) {
              bestSliceNcc = ncc;
              bestSliceIndex = idx;
              bestSliceRaw = raw;
              bestSliceAligned = aligned;
            }

            await yieldToMain();
          }

          // If the best slice changed, re-run transform recovery on that final best slice
          // so we persist settings that correspond to the chosen slice.
          if (bestSliceIndex !== initialRefineSliceIndex) {
            const prevTransform = refinedTransform;
            const prevAligned = bestSliceAligned;
            const prevNcc = bestSliceNcc;

            const refined2 = recoverSimilarityTransform(transformRefRefine, bestSliceRaw, {
              includeDebug: debugAlignment,
            });

            const base2: RenderTransform = {
              zoom: refined2.zoom,
              rotation: refined2.rotation,
              panX: refined2.panX,
              panY: refined2.panY,
            };

            const r0_2 = normalizeRotation(base2.rotation);
            const r180_2 = normalizeRotation(r0_2 + 180);
            const d0_2 = Math.abs(r0_2);
            const d180_2 = Math.abs(r180_2);

            let bestT: RenderTransform = { ...base2, rotation: r0_2 };
            if (d180_2 < d0_2 || (d180_2 === d0_2 && r180_2 < r0_2)) {
              bestT = { ...base2, rotation: r180_2 };
            }

            const bestA = warpPixels(bestSliceRaw, FINAL_REFINE_IMAGE_SIZE, bestT);
            const bestN = computeNCC(
              referencePixelsRefineRaw,
              bestA,
              { mean: referenceRefineRawStats.mean, stddev: referenceRefineRawStats.stddev }
            );

            const candidate = { ncc: bestN, transform: bestT, aligned: bestA };

            // Only accept the re-refined transform if it actually improves the NCC.
            // NCC is deterministic given our inputs, but we keep a tiny epsilon to avoid
            // flip-flopping on microscopic float deltas.
            const RE_REFINE_IMPROVEMENT_EPS = 1e-6;
            if (candidate.ncc > prevNcc + RE_REFINE_IMPROVEMENT_EPS) {
              refinedTransform = candidate.transform;
              bestSliceAligned = candidate.aligned;
              bestSliceNcc = candidate.ncc;

              debugAlignmentLog(
                'refine.re-refine.accepted',
                {
                  date,
                  bestSliceIndex,
                  prevNcc,
                  ncc: bestSliceNcc,
                  rotation: refinedTransform.rotation,
                  zoom: refinedTransform.zoom,
                  panX: refinedTransform.panX,
                  panY: refinedTransform.panY,
                  confidence: refined2.confidence,
                  meta: {
                    seriesUid: seriesRef.series_uid,
                  },
                },
                debugAlignment
              );
            } else {
              refinedTransform = prevTransform;
              bestSliceAligned = prevAligned;
              bestSliceNcc = prevNcc;

              debugAlignmentLog(
                'refine.re-refine.rejected',
                {
                  date,
                  bestSliceIndex,
                  prevNcc,
                  candidateNcc: candidate.ncc,
                  candidateRotation: candidate.transform.rotation,
                  candidateZoom: candidate.transform.zoom,
                  candidatePanX: candidate.transform.panX,
                  candidatePanY: candidate.transform.panY,
                  confidence: refined2.confidence,
                  meta: {
                    seriesUid: seriesRef.series_uid,
                  },
                },
                debugAlignment
              );
            }
          }

          const targetStats = computeHistogramStats(bestSliceAligned);

          // The recovered transform is a delta that aligns the target slice to the reference slice
          // in identity view space. To align the *displayed* target to the *displayed* reference,
          // we compose this delta onto the reference viewer settings.
          const referenceBaseTransform: RenderTransform = {
            zoom: reference.settings.zoom,
            rotation: reference.settings.rotation,
            panX: reference.settings.panX,
            panY: reference.settings.panY,
          };

          const composedTransform = composeTransforms(referenceBaseTransform, refinedTransform);

          const computedSettings = computeAlignedSettings(
            referenceRefineDisplayedStats,
            targetStats,
            bestSliceIndex,
            seriesRef.instance_count,
            currentProgress,
            composedTransform
          );

          const finalNcc = computeNCC(
            referencePixelsRefineRaw,
            bestSliceAligned,
            { mean: referenceRefineRawStats.mean, stddev: referenceRefineRawStats.stddev },
            { mean: targetStats.mean, stddev: targetStats.stddev }
          );

          const result: AlignmentResult = {
            date,
            seriesUid: seriesRef.series_uid,
            bestSliceIndex,
            nccScore: finalNcc,
            computedSettings,
            slicesChecked: searchResult.slicesChecked,
          };

          results.push(result);

          // Update state with intermediate results
          setState((s) => ({
            ...s,
            results: [...results],
          }));

          // Yield between dates
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
        disposeCornerstoneRenderElement(renderElementCoarse);
        disposeCornerstoneRenderElement(renderElementFine);
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
