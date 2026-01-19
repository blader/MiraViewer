import type { HistogramStats } from '../types/api';

/**
 * Default size for downsampled images used in alignment.
 *
 * Notes:
 * - This is intentionally square so registration code can assume a stable pixel grid.
 * - 256×256 keeps our alignment scoring + warp operations fast while being large enough to be useful.
 */
export const ALIGNMENT_IMAGE_SIZE = 256;

/**
 * Compute simple histogram statistics from a grayscale pixel array.
 *
 * All pixels are assumed to be normalized to [0..1].
 */
export function computeHistogramStats(pixels: Float32Array): HistogramStats {
  const n = pixels.length;
  if (n === 0) {
    return { mean: 0, stddev: 0, min: 0, max: 0, p10: 0, p50: 0, p90: 0 };
  }

  // Compute mean, min, max in one pass.
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

  // Compute stddev in second pass.
  let sumSqDiff = 0;
  for (let i = 0; i < n; i++) {
    const diff = pixels[i] - mean;
    sumSqDiff += diff * diff;
  }
  const stddev = Math.sqrt(sumSqDiff / n);

  // Compute percentiles via sorting a copy.
  // For 256×256 (~65K) pixels, this is fast enough and keeps the implementation simple.
  const sorted = Float32Array.from(pixels).sort();
  const p10 = sorted[Math.floor(n * 0.1)];
  const p50 = sorted[Math.floor(n * 0.5)];
  const p90 = sorted[Math.floor(n * 0.9)];

  return { mean, stddev, min, max, p10, p50, p90 };
}
