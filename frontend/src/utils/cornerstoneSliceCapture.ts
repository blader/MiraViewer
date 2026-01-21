import cornerstone from 'cornerstone-core';
import { ALIGNMENT_IMAGE_SIZE } from './imageCapture';
import { getImageIdForInstance } from './localApi';
import { nowMs } from './math';

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

export type PixelCaptureScratch = {
  canvas: HTMLCanvasElement;
  ctx: CanvasRenderingContext2D;
};

export function createPixelCaptureScratch(targetSize: number): PixelCaptureScratch {
  const canvas = document.createElement('canvas');
  canvas.width = targetSize;
  canvas.height = targetSize;

  // Hint to the browser that we intend to read pixels frequently.
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) {
    throw new Error('Failed to get 2D context');
  }

  return { canvas, ctx };
}

export type RenderedSlice = {
  pixels: Float32Array;
  imageId: string;
  expectedImageId: string;
  renderedImageId: string | null;
  renderTimedOut: boolean;
  sourceCanvasWidth: number;
  sourceCanvasHeight: number;
  targetSize: number;
  timingMs: {
    getImageId: number;
    loadImage: number;
    waitForRender: number;
    capture: number;
    total: number;
  };
};

export function createCornerstoneRenderElement(sizePx: number): HTMLDivElement {
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

export function disposeCornerstoneRenderElement(el: HTMLDivElement) {
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
export async function renderSliceToPixels(
  renderElement: HTMLDivElement,
  seriesUid: string,
  sliceIndex: number,
  targetSize: number = ALIGNMENT_IMAGE_SIZE,
  scratch?: PixelCaptureScratch
): Promise<RenderedSlice> {
  const tStart = nowMs();

  const tGetId0 = nowMs();
  const imageId = await getImageIdForInstance(seriesUid, sliceIndex);
  const tGetId1 = nowMs();

  const tLoad0 = nowMs();
  const image = await cornerstone.loadImage(imageId);
  const tLoad1 = nowMs();

  const viewport = cornerstone.getDefaultViewportForImage(renderElement, image);

  // Wait for Cornerstone to actually draw this image before reading from its canvas.
  const expectedImageId = (image as unknown as { imageId?: string }).imageId || imageId;
  const renderPromise = waitForCornerstoneImageRendered(renderElement, expectedImageId);

  const tRender0 = nowMs();
  cornerstone.displayImage(renderElement, image, viewport);
  const renderInfo = await renderPromise;
  const tRender1 = nowMs();

  const tCapture0 = nowMs();

  const sourceCanvas = renderElement.querySelector('canvas') as HTMLCanvasElement | null;
  if (!sourceCanvas) {
    throw new Error('Cornerstone did not create a canvas for rendering');
  }

  const canvas = scratch?.canvas ?? document.createElement('canvas');
  if (canvas.width !== targetSize || canvas.height !== targetSize) {
    canvas.width = targetSize;
    canvas.height = targetSize;
  }

  const ctx =
    scratch?.ctx ??
    canvas.getContext('2d', {
      // Hint to the browser that we intend to read pixels frequently.
      willReadFrequently: true,
    });

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

  // Cornerstone renders grayscale DICOM as RGB where R=G=B. Detect that once and take
  // the fast path by reading a single channel.
  let isGrayscaleRgb = true;
  {
    const samplePixelIndices = [0, Math.floor(pixels.length / 2), pixels.length - 1];
    for (const i of samplePixelIndices) {
      const idx = i * 4;
      const r = data[idx];
      const g = data[idx + 1];
      const b = data[idx + 2];
      if (r !== g || r !== b) {
        isGrayscaleRgb = false;
        break;
      }
    }
  }

  const inv255 = 1 / 255;

  if (isGrayscaleRgb) {
    for (let i = 0; i < pixels.length; i++) {
      pixels[i] = data[i * 4] * inv255;
    }
  } else {
    for (let i = 0; i < pixels.length; i++) {
      const idx = i * 4;
      const r = data[idx];
      const g = data[idx + 1];
      const b = data[idx + 2];
      pixels[i] = (0.299 * r + 0.587 * g + 0.114 * b) * inv255;
    }
  }

  const tCapture1 = nowMs();

  return {
    pixels,
    imageId,
    expectedImageId,
    renderedImageId: renderInfo.renderedImageId,
    renderTimedOut: renderInfo.timedOut,
    sourceCanvasWidth: sourceCanvas.width,
    sourceCanvasHeight: sourceCanvas.height,
    targetSize,
    timingMs: {
      getImageId: tGetId1 - tGetId0,
      loadImage: tLoad1 - tLoad0,
      waitForRender: tRender1 - tRender0,
      capture: tCapture1 - tCapture0,
      total: tCapture1 - tStart,
    },
  };
}
