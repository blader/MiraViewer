import type { HistogramStats } from '../types/api';

/**
 * Default size for downsampled images used in alignment.
 * 256x256 provides good accuracy while keeping NCC computation fast.
 */
export const ALIGNMENT_IMAGE_SIZE = 256;

/**
 * Convert an image blob (PNG) to a grayscale Float32Array, downsampled to target size.
 * Returns normalized pixel values in range [0, 1].
 */
export async function blobToGrayscalePixels(
  blob: Blob,
  targetWidth: number = ALIGNMENT_IMAGE_SIZE,
  targetHeight: number = ALIGNMENT_IMAGE_SIZE
): Promise<{ pixels: Float32Array; width: number; height: number }> {
  // Create an image from the blob
  const imageBitmap = await createImageBitmap(blob);

  // Create a canvas at target size
  const canvas = new OffscreenCanvas(targetWidth, targetHeight);
  const ctx = canvas.getContext('2d');
  if (!ctx) {
    throw new Error('Failed to get 2D context');
  }

  // Draw scaled image
  ctx.drawImage(imageBitmap, 0, 0, targetWidth, targetHeight);
  imageBitmap.close();

  // Get pixel data
  const imageData = ctx.getImageData(0, 0, targetWidth, targetHeight);
  const data = imageData.data;

  // Convert to grayscale Float32Array (normalized 0-1)
  const pixels = new Float32Array(targetWidth * targetHeight);
  for (let i = 0; i < pixels.length; i++) {
    const idx = i * 4;
    // Standard luminance formula: 0.299*R + 0.587*G + 0.114*B
    const r = data[idx];
    const g = data[idx + 1];
    const b = data[idx + 2];
    pixels[i] = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
  }

  return { pixels, width: targetWidth, height: targetHeight };
}

/**
 * Downsample a grayscale pixel array by simple box averaging.
 *
 * This is used for alignment/transform recovery where we want a cheaper coarse-resolution
 * representation (e.g. 256 -> 128).
 */
export function downsampleGrayscalePixels(
  pixels: Float32Array,
  srcWidth: number,
  srcHeight: number,
  targetWidth: number,
  targetHeight: number
): { pixels: Float32Array; width: number; height: number } {
  if (srcWidth <= 0 || srcHeight <= 0) {
    throw new Error('downsampleGrayscalePixels: invalid source size');
  }
  if (pixels.length !== srcWidth * srcHeight) {
    throw new Error('downsampleGrayscalePixels: pixel buffer size mismatch');
  }

  if (targetWidth <= 0 || targetHeight <= 0) {
    throw new Error('downsampleGrayscalePixels: invalid target size');
  }
  if (srcWidth % targetWidth !== 0 || srcHeight % targetHeight !== 0) {
    throw new Error(
      `downsampleGrayscalePixels: target size must evenly divide source size (src=${srcWidth}x${srcHeight}, dst=${targetWidth}x${targetHeight})`
    );
  }

  const scaleX = srcWidth / targetWidth;
  const scaleY = srcHeight / targetHeight;

  const out = new Float32Array(targetWidth * targetHeight);

  for (let y = 0; y < targetHeight; y++) {
    const srcY0 = y * scaleY;
    for (let x = 0; x < targetWidth; x++) {
      const srcX0 = x * scaleX;

      let sum = 0;
      for (let dy = 0; dy < scaleY; dy++) {
        const sy = srcY0 + dy;
        const rowStart = sy * srcWidth;
        for (let dx = 0; dx < scaleX; dx++) {
          const sx = srcX0 + dx;
          sum += pixels[rowStart + sx];
        }
      }

      out[y * targetWidth + x] = sum / (scaleX * scaleY);
    }
  }

  return { pixels: out, width: targetWidth, height: targetHeight };
}

/**
 * Compute histogram statistics from a grayscale pixel array.
 */
export function computeHistogramStats(pixels: Float32Array): HistogramStats {
  const n = pixels.length;
  if (n === 0) {
    return { mean: 0, stddev: 0, min: 0, max: 0, p10: 0, p50: 0, p90: 0 };
  }

  // Compute mean, min, max in one pass
  let sum = 0;
  let min = pixels[0];
  let max = pixels[0];
  for (let i = 0; i < n; i++) {
    const v = pixels[i];
    sum += v;
    if (v < min) min = v;
    if (v > max) max = v;
  }
  const mean = sum / n;

  // Compute stddev in second pass
  let sumSqDiff = 0;
  for (let i = 0; i < n; i++) {
    const diff = pixels[i] - mean;
    sumSqDiff += diff * diff;
  }
  const stddev = Math.sqrt(sumSqDiff / n);

  // Compute percentiles via sorting a copy
  // For 256x256 (65K pixels), this is fast enough
  const sorted = Float32Array.from(pixels).sort();
  const p10 = sorted[Math.floor(n * 0.1)];
  const p50 = sorted[Math.floor(n * 0.5)];
  const p90 = sorted[Math.floor(n * 0.9)];

  return { mean, stddev, min, max, p10, p50, p90 };
}

/**
 * Capture the displayed viewer content and convert to grayscale pixels.
 * This is a convenience wrapper that calls captureVisiblePng on the viewer
 * and converts the result.
 */
export async function captureViewerAsGrayscale(
  captureVisiblePng: () => Promise<Blob>,
  targetSize: number = ALIGNMENT_IMAGE_SIZE
): Promise<{ pixels: Float32Array; width: number; height: number; stats: HistogramStats }> {
  const blob = await captureVisiblePng();
  const { pixels, width, height } = await blobToGrayscalePixels(blob, targetSize, targetSize);
  const stats = computeHistogramStats(pixels);
  return { pixels, width, height, stats };
}
