import cornerstone from 'cornerstone-core';

type CornerstoneImageLike = {
  rows: number;
  columns: number;
  getPixelData: () => ArrayLike<number>;
  minPixelValue?: number;
  maxPixelValue?: number;
};

function toByte(v: number) {
  return Math.max(0, Math.min(255, Math.round(v)));
}

/**
 * Load a DICOM slice via Cornerstone (miradb:<sop>) and normalize pixel data to a 0..255 grayscale byte array.
 *
 * If maxEvalDim is smaller than the source image, the output is downsampled (nearest-neighbor) preserving
 * aspect ratio. This is a speed/size tradeoff for offline harness runs.
 */
export async function loadCornerstoneSliceToGrayscale(args: {
  sopInstanceUid: string;
  maxEvalDim: number;
}): Promise<{ imageId: string; gray: Uint8Array; w: number; h: number; sourceW: number; sourceH: number }> {
  const { sopInstanceUid, maxEvalDim } = args;

  const imageId = `miradb:${sopInstanceUid}`;
  const image = (await cornerstone.loadImage(imageId)) as unknown as CornerstoneImageLike;

  const rows = image.rows;
  const cols = image.columns;
  const getPixelData = image.getPixelData;
  if (!rows || !cols || typeof getPixelData !== 'function') {
    throw new Error('Cornerstone image missing pixel data');
  }

  const pd = getPixelData();

  let min = image.minPixelValue;
  let max = image.maxPixelValue;

  if (!Number.isFinite(min) || !Number.isFinite(max)) {
    min = Number.POSITIVE_INFINITY;
    max = Number.NEGATIVE_INFINITY;
    for (let i = 0; i < pd.length; i++) {
      const v = pd[i];
      if (v < (min as number)) min = v;
      if (v > (max as number)) max = v;
    }
  }

  const denom = (max as number) - (min as number);

  // Downsample for speed, preserving aspect ratio.
  const scale = Math.max(cols, rows) / Math.max(16, maxEvalDim);
  const w = scale > 1 ? Math.max(16, Math.round(cols / scale)) : cols;
  const h = scale > 1 ? Math.max(16, Math.round(rows / scale)) : rows;

  const gray = new Uint8Array(w * h);

  if (!Number.isFinite(denom) || Math.abs(denom) < 1e-8) {
    gray.fill(0);
    return { imageId, gray, w, h, sourceW: cols, sourceH: rows };
  }

  for (let y = 0; y < h; y++) {
    const sy = h <= 1 ? 0 : Math.round((y * (rows - 1)) / (h - 1));
    for (let x = 0; x < w; x++) {
      const sx = w <= 1 ? 0 : Math.round((x * (cols - 1)) / (w - 1));
      const v = pd[sy * cols + sx];
      const t = ((v - (min as number)) / denom) * 255;
      gray[y * w + x] = toByte(t);
    }
  }

  return { imageId, gray, w, h, sourceW: cols, sourceH: rows };
}
