import { ALIGNMENT_IMAGE_SIZE } from './imageCapture';
import { getImageIdForInstance } from './localApi';
import { nowMs } from './math';
import { decodeImageWithValidity, loadCornerstoneImage } from './decodedFrame';

const IMAGE_ID_LOOKUP_TIMEOUT_MS = 10_000;
const IMAGE_LOAD_TIMEOUT_MS = 30_000;

function waitForBoundedOperation<T>(
  promise: Promise<T>,
  options: { signal?: AbortSignal; timeoutMs: number; label: string },
): Promise<T> {
  const { signal, timeoutMs, label } = options;
  if (signal?.aborted) return Promise.reject(new Error(`${label} cancelled`));

  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const cleanup = () => {
      window.clearTimeout(timer);
      signal?.removeEventListener('abort', handleAbort);
    };
    const rejectOnce = (error: Error) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    };
    const handleAbort = () => rejectOnce(new Error(`${label} cancelled`));
    const timer = window.setTimeout(
      () => rejectOnce(new Error(`${label} timed out after ${Math.round(timeoutMs / 1000)}s`)),
      timeoutMs,
    );

    signal?.addEventListener('abort', handleAbort, { once: true });
    promise.then(
      (value) => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve(value);
      },
      (error) => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(error);
      },
    );
  });
}

export type PixelCaptureScratch = { targetSize: number };

export function createPixelCaptureScratch(targetSize: number): PixelCaptureScratch {
  return { targetSize };
}

export type RenderedSlice = {
  pixels: Float32Array;
  /** Native acquired-footprint support, independent of modality intensity or canvas background. */
  validity?: Float32Array;
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

export type RenderSliceToPixelsOptions = {
  signal?: AbortSignal;
};

export function createCornerstoneRenderElement(sizePx: number): HTMLDivElement {
  const el = document.createElement('div');
  el.style.width = `${sizePx}px`;
  el.style.height = `${sizePx}px`;
  return el;
}

export function disposeCornerstoneRenderElement(el: HTMLDivElement) {
  el.remove();
}

/**
 * Read a DICOM slice directly from its decoded modality-linear source pixel buffer.
 * Registration never depends on display windowing, asynchronous rendering, or 8-bit canvas readback.
 */
export async function renderSliceToPixels(
  renderElement: HTMLDivElement,
  seriesUid: string,
  sliceIndex: number,
  targetSize: number = ALIGNMENT_IMAGE_SIZE,
  scratch?: PixelCaptureScratch,
  options: RenderSliceToPixelsOptions = {},
): Promise<RenderedSlice> {
  void renderElement;
  void scratch;
  const tStart = nowMs();

  const tGetId0 = nowMs();
  const imageId = await waitForBoundedOperation(getImageIdForInstance(seriesUid, sliceIndex), {
    signal: options.signal,
    timeoutMs: IMAGE_ID_LOOKUP_TIMEOUT_MS,
    label: `DICOM image lookup for ${seriesUid} slice ${sliceIndex}`,
  });
  const tGetId1 = nowMs();

  const tLoad0 = nowMs();
  const image = await waitForBoundedOperation(loadCornerstoneImage(imageId), {
    signal: options.signal,
    timeoutMs: IMAGE_LOAD_TIMEOUT_MS,
    label: `DICOM image load for ${imageId}`,
  });
  const tLoad1 = nowMs();

  const expectedImageId = (image as unknown as { imageId?: string }).imageId || imageId;
  const tCapture0 = nowMs();
  const decoded = image as unknown as { rows?: number; columns?: number; height?: number; width?: number };
  const captured = decodeImageWithValidity(
    image as unknown as Parameters<typeof decodeImageWithValidity>[0],
    targetSize,
    targetSize,
  );
  const tCapture1 = nowMs();

  return {
    ...captured,
    imageId,
    expectedImageId,
    renderedImageId: expectedImageId,
    renderTimedOut: false,
    sourceCanvasWidth: decoded.columns ?? decoded.width ?? targetSize,
    sourceCanvasHeight: decoded.rows ?? decoded.height ?? targetSize,
    targetSize,
    timingMs: {
      getImageId: tGetId1 - tGetId0,
      loadImage: tLoad1 - tLoad0,
      waitForRender: 0,
      capture: tCapture1 - tCapture0,
      total: tCapture1 - tStart,
    },
  };
}
