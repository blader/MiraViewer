import { ALIGNMENT_IMAGE_SIZE } from './imageCapture';
import { getImageIdForInstance } from './localApi';
import { nowMs } from './math';
import { decodeImageWithValidity, loadCornerstoneImage, type DecodedFrame } from './decodedFrame';

import { IMAGE_ID_LOOKUP_TIMEOUT_MS, IMAGE_LOAD_TIMEOUT_MS, waitForBoundedOperation } from './imageLoadDeadline';

export type RenderedSlice = Pick<DecodedFrame, 'windowCenter' | 'windowWidth'> & {
  pixels: Float32Array;
  /** Native acquired-footprint support, independent of modality intensity or canvas background. */
  validity?: Float32Array;
  imageId: string;
  timingMs: {
    getImageId: number;
    loadImage: number;
    capture: number;
    total: number;
  };
};

export type RenderSliceToPixelsOptions = {
  signal?: AbortSignal;
};

/**
 * Read a DICOM slice directly from its decoded modality-linear source pixel buffer.
 * Registration never depends on display windowing, asynchronous rendering, or 8-bit canvas readback.
 */
export async function renderSliceToPixels(
  seriesUid: string,
  sliceIndex: number,
  targetSize: number = ALIGNMENT_IMAGE_SIZE,
  options: RenderSliceToPixelsOptions = {},
): Promise<RenderedSlice> {
  const tStart = nowMs();

  const tGetId0 = nowMs();
  const imageId = await waitForBoundedOperation(getImageIdForInstance(seriesUid, sliceIndex), {
    signal: options.signal,
    timeoutMs: IMAGE_ID_LOOKUP_TIMEOUT_MS,
    label: `DICOM image lookup for ${seriesUid} slice ${sliceIndex}`,
  });
  const tGetId1 = nowMs();

  const tLoad0 = nowMs();
  const image = (await waitForBoundedOperation(loadCornerstoneImage(imageId), {
    signal: options.signal,
    timeoutMs: IMAGE_LOAD_TIMEOUT_MS,
    label: `DICOM image load for ${imageId}`,
  })) as Parameters<typeof decodeImageWithValidity>[0];
  const tLoad1 = nowMs();

  const tCapture0 = nowMs();
  const captured = decodeImageWithValidity(image, targetSize, targetSize);
  const tCapture1 = nowMs();

  return {
    ...captured,
    imageId,
    // Use the decoder's effective VOI, including its fallback for missing DICOM tags.
    windowCenter: image.windowCenter,
    windowWidth: image.windowWidth,
    timingMs: {
      getImageId: tGetId1 - tGetId0,
      loadImage: tLoad1 - tLoad0,
      capture: tCapture1 - tCapture0,
      total: tCapture1 - tStart,
    },
  };
}
