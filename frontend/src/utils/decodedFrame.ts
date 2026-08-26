import cornerstone from 'cornerstone-core';
import { getImageIdForInstance } from './localApi';
import { resample2dAreaAverage, resample2dAreaAverageWithValidity, resample2dLanczos3 } from './svr/resample2d';

type DecodedCornerstoneImage = {
  imageId?: string;
  rows?: number;
  columns?: number;
  height?: number;
  width?: number;
  slope?: number;
  intercept?: number;
  rowPixelSpacing?: number;
  columnPixelSpacing?: number;
  pixelPaddingValue?: number;
  pixelPaddingRangeLimit?: number;
  getPixelData?: () => ArrayLike<number>;
};

export type DecodedFrame = {
  pixels: Float32Array;
  /** Fraction of the native acquired footprint retained in every decoded sample. */
  validity: Float32Array;
  rows: number;
  cols: number;
  imageId: string;
  seriesUid: string;
  sopInstanceUid: string;
  rowSpacingMm?: number;
  colSpacingMm?: number;
};

export type DecodedFrameResampleKernel = 'area' | 'lanczos3';

/** The bounded Cornerstone cache is the sole owner of decoded DICOM image objects. */
export function loadCornerstoneImage(imageId: string): ReturnType<typeof cornerstone.loadImage> {
  const loaders = cornerstone as unknown as {
    loadImage: typeof cornerstone.loadImage;
    loadAndCacheImage?: typeof cornerstone.loadImage;
  };

  const load = loaders.loadAndCacheImage ?? loaders.loadImage;
  return load.call(cornerstone, imageId);
}

function getImageDimensions(image: DecodedCornerstoneImage): { rows: number; cols: number } {
  const rows = image.rows ?? image.height;
  const cols = image.columns ?? image.width;
  if (!Number.isSafeInteger(rows) || !Number.isSafeInteger(cols) || !rows || !cols || rows < 1 || cols < 1) {
    throw new Error('Decoded DICOM image is missing valid native dimensions');
  }
  return { rows, cols };
}

/** Evaluate stored-domain padding before any interpolation or linear modality transform. */
export function decodeImageWithValidity(
  image: DecodedCornerstoneImage,
  targetRows: number,
  targetCols: number,
  kernel: DecodedFrameResampleKernel = 'area',
): { pixels: Float32Array; validity: Float32Array } {
  const { rows, cols } = getImageDimensions(image);
  if (typeof image.getPixelData !== 'function') {
    throw new Error('Decoded DICOM image did not expose source pixel data');
  }

  const source = image.getPixelData.call(image);
  if (source.length < rows * cols) {
    throw new Error('Decoded DICOM image pixel data is smaller than its native dimensions');
  }

  const paddingValue = image.pixelPaddingValue;
  const paddingLimit = Number.isFinite(image.pixelPaddingRangeLimit) ? image.pixelPaddingRangeLimit! : paddingValue;
  const hasPadding = Number.isFinite(paddingValue);
  let pixels: Float32Array;
  let validity: Float32Array;
  if (hasPadding) {
    const low = Math.min(paddingValue!, paddingLimit!);
    const high = Math.max(paddingValue!, paddingLimit!);
    const sourceValidity = new Uint8Array(rows * cols);
    for (let index = 0; index < sourceValidity.length; index++) {
      const value = source[index]!;
      sourceValidity[index] = Number.isFinite(value) && (value < low || value > high) ? 1 : 0;
    }
    ({ pixels, validity } = resample2dAreaAverageWithValidity(
      source,
      sourceValidity,
      rows,
      cols,
      targetRows,
      targetCols,
    ));
  } else {
    const resample = kernel === 'lanczos3' ? resample2dLanczos3 : resample2dAreaAverage;
    pixels = resample(source, rows, cols, targetRows, targetCols);
    validity = new Float32Array(pixels.length).fill(1);
  }
  const slope = Number.isFinite(image.slope) ? image.slope! : 1;
  const intercept = Number.isFinite(image.intercept) ? image.intercept! : 0;
  if (slope !== 1 || intercept !== 0) {
    for (let index = 0; index < pixels.length; index++) {
      if (validity[index]! > 0) pixels[index] = pixels[index]! * slope + intercept;
    }
  }
  return { pixels, validity };
}

/** Resample native signed/unsigned source pixels, then apply the linear modality transform. */
export function resampleDecodedImage(
  image: DecodedCornerstoneImage,
  targetRows: number,
  targetCols: number,
  kernel: DecodedFrameResampleKernel = 'area',
): Float32Array {
  return decodeImageWithValidity(image, targetRows, targetCols, kernel).pixels;
}

/** Return full-precision, modality-linear pixels for the exact physical frame displayed by a viewer. */
export async function getDecodedFrame(seriesUid: string, instanceIndex: number): Promise<DecodedFrame> {
  const imageId = await getImageIdForInstance(seriesUid, instanceIndex);
  const image = (await loadCornerstoneImage(imageId)) as unknown as DecodedCornerstoneImage;
  const { rows, cols } = getImageDimensions(image);
  const decoded = decodeImageWithValidity(image, rows, cols);

  return {
    ...decoded,
    rows,
    cols,
    imageId,
    seriesUid,
    sopInstanceUid: imageId.startsWith('miradb:') ? imageId.slice('miradb:'.length) : imageId,
    rowSpacingMm: Number.isFinite(image.rowPixelSpacing) ? image.rowPixelSpacing : undefined,
    colSpacingMm: Number.isFinite(image.columnPixelSpacing) ? image.columnPixelSpacing : undefined,
  };
}
