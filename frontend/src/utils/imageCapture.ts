import type { ExclusionMask, HistogramStats } from '../types/api';

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
export function computeHistogramStats(pixels: Float32Array, weights?: Float32Array): HistogramStats {
  const n = pixels.length;
  if (n === 0) {
    return { mean: 0, stddev: 0, min: 0, max: 0, p10: 0, p50: 0, p90: 0 };
  }
  if (weights && weights.length !== n) throw new Error('Histogram weights must match their source pixels');

  // Compute mean, min, max in one pass.
  let sum = 0;
  let totalWeight = 0;
  let min = pixels[0];
  let max = pixels[0];
  for (let i = 0; i < n; i++) {
    const v = pixels[i];
    const weight = weights?.[i] ?? 1;
    sum += v * weight;
    totalWeight += weight;
    if (v < min) min = v;
    if (v > max) max = v;
  }
  if (!(totalWeight > 0)) {
    return { mean: 0, stddev: 0, min: 0, max: 0, p10: 0, p50: 0, p90: 0 };
  }
  const mean = sum / totalWeight;

  // Compute stddev in second pass.
  let sumSqDiff = 0;
  for (let i = 0; i < n; i++) {
    const diff = pixels[i] - mean;
    sumSqDiff += diff * diff * (weights?.[i] ?? 1);
  }
  const stddev = Math.sqrt(sumSqDiff / totalWeight);

  // Compute percentiles via sorting a copy.
  // For 256×256 (~65K) pixels, this is fast enough and keeps the implementation simple.
  let p10: number;
  let p50: number;
  let p90: number;
  if (weights) {
    const order = Uint32Array.from({ length: n }, (_value, index) => index).sort(
      (left, right) => pixels[left]! - pixels[right]!,
    );
    const percentile = (fraction: number): number => {
      const threshold = totalWeight * fraction;
      let cumulative = 0;
      for (const index of order) {
        cumulative += weights[index]!;
        if (cumulative > threshold) return pixels[index]!;
      }
      return pixels[order[n - 1]!]!;
    };
    p10 = percentile(0.1);
    p50 = percentile(0.5);
    p90 = percentile(0.9);
  } else {
    const sorted = Float32Array.from(pixels).sort();
    p10 = sorted[Math.floor(n * 0.1)]!;
    p50 = sorted[Math.floor(n * 0.5)]!;
    p90 = sorted[Math.floor(n * 0.9)]!;
  }

  return { mean, stddev, min, max, p10, p50, p90 };
}

/** Mirror Cornerstone's linear VOI transform without quantizing diagnostic source pixels. */
export function windowDisplayPixels(
  pixels: Float32Array,
  window: { windowCenter?: number; windowWidth?: number } | undefined,
): Float32Array | null {
  const center = window?.windowCenter;
  const width = window?.windowWidth;
  if (!Number.isFinite(center) || !Number.isFinite(width) || !(width! > 0)) return null;

  return Float32Array.from(pixels, (pixel) => Math.max(0, Math.min(1, (pixel - center!) / width! + 0.5)));
}

/** Compare corresponding visible tissue instead of image padding, black canvas, or selected pathology. */
export function computeCorrespondingDisplayStats(
  reference: Float32Array,
  moving: Float32Array,
  options: {
    referenceValidity?: ArrayLike<number>;
    movingValidity?: ArrayLike<number>;
    exclusionRect?: ExclusionMask;
    columns: number;
  },
): { reference: HistogramStats; moving: HistogramStats } | null {
  if (reference.length !== moving.length || !Number.isSafeInteger(options.columns) || options.columns <= 0) {
    return null;
  }
  const rows = reference.length / options.columns;
  if (!Number.isSafeInteger(rows)) return null;

  const fixed = new Float32Array(reference.length);
  const target = new Float32Array(moving.length);
  const exclusion = options.exclusionRect;
  const localize = Boolean(exclusion && exclusion.width * exclusion.height <= 0.04);
  const weights = localize ? new Float32Array(reference.length) : undefined;
  const focusRadius = exclusion ? Math.max(0.1, exclusion.width, exclusion.height) : 1;
  let count = 0;
  for (let index = 0; index < reference.length; index++) {
    if ((options.referenceValidity?.[index] ?? 1) <= 1e-6 || (options.movingValidity?.[index] ?? 1) <= 1e-6) {
      continue;
    }
    const row = Math.floor(index / options.columns);
    const column = index - row * options.columns;
    if (
      exclusion &&
      column + 0.5 >= exclusion.x * options.columns &&
      column + 0.5 < (exclusion.x + exclusion.width) * options.columns &&
      row + 0.5 >= exclusion.y * rows &&
      row + 0.5 < (exclusion.y + exclusion.height) * rows
    ) {
      continue;
    }
    const referenceValue = reference[index]!;
    const movingValue = moving[index]!;
    if (
      !Number.isFinite(referenceValue) ||
      !Number.isFinite(movingValue) ||
      referenceValue <= 0.02 ||
      movingValue <= 0.02 ||
      referenceValue >= 0.995 ||
      movingValue >= 0.995
    ) {
      continue;
    }
    fixed[count] = referenceValue;
    target[count] = movingValue;
    if (weights && exclusion) {
      const normalizedRow = (row + 0.5) / rows;
      const normalizedColumn = (column + 0.5) / options.columns;
      const rowDistance = Math.max(exclusion.y - normalizedRow, normalizedRow - exclusion.y - exclusion.height, 0);
      const columnDistance = Math.max(
        exclusion.x - normalizedColumn,
        normalizedColumn - exclusion.x - exclusion.width,
        0,
      );
      const distanceSquared = rowDistance * rowDistance + columnDistance * columnDistance;
      weights[count] = 0.15 + 0.85 * Math.exp(-distanceSquared / (2 * focusRadius * focusRadius));
    }
    count++;
  }

  if (count < Math.min(64, Math.max(4, Math.floor(reference.length / 16)))) return null;
  const focusedWeights = weights?.subarray(0, count);
  return {
    reference: computeHistogramStats(fixed.subarray(0, count), focusedWeights),
    moving: computeHistogramStats(target.subarray(0, count), focusedWeights),
  };
}
