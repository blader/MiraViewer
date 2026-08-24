import cornerstone from 'cornerstone-core';
import { getImageIdForInstance } from './localApi';
import { resample2dAreaAverage } from './svr/resample2d';

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
  getPixelData?: () => ArrayLike<number>;
};

export type DecodedFrame = {
  pixels: Float32Array;
  rows: number;
  cols: number;
  imageId: string;
  seriesUid: string;
  sopInstanceUid: string;
  rowSpacingMm?: number;
  colSpacingMm?: number;
};

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

/** Resample native signed/unsigned source pixels, then apply the linear modality transform. */
export function resampleDecodedImage(
  image: DecodedCornerstoneImage,
  targetRows: number,
  targetCols: number,
): Float32Array {
  const { rows, cols } = getImageDimensions(image);
  if (typeof image.getPixelData !== 'function') {
    throw new Error('Decoded DICOM image did not expose source pixel data');
  }

  const source = image.getPixelData.call(image);
  if (source.length < rows * cols) {
    throw new Error('Decoded DICOM image pixel data is smaller than its native dimensions');
  }

  const pixels = resample2dAreaAverage(source, rows, cols, targetRows, targetCols);
  const slope = Number.isFinite(image.slope) ? image.slope! : 1;
  const intercept = Number.isFinite(image.intercept) ? image.intercept! : 0;
  if (slope !== 1 || intercept !== 0) {
    for (let index = 0; index < pixels.length; index++) {
      pixels[index] = pixels[index] * slope + intercept;
    }
  }
  return pixels;
}

/** Return full-precision, modality-linear pixels for the exact physical frame displayed by a viewer. */
export async function getDecodedFrame(seriesUid: string, instanceIndex: number): Promise<DecodedFrame> {
  const imageId = await getImageIdForInstance(seriesUid, instanceIndex);
  const image = (await loadCornerstoneImage(imageId)) as unknown as DecodedCornerstoneImage;
  const { rows, cols } = getImageDimensions(image);

  return {
    pixels: resampleDecodedImage(image, rows, cols),
    rows,
    cols,
    imageId,
    seriesUid,
    sopInstanceUid: imageId.startsWith('miradb:') ? imageId.slice('miradb:'.length) : imageId,
    rowSpacingMm: Number.isFinite(image.rowPixelSpacing) ? image.rowPixelSpacing : undefined,
    colSpacingMm: Number.isFinite(image.columnPixelSpacing) ? image.columnPixelSpacing : undefined,
  };
}
