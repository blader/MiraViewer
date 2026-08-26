/**
 * Small image-processing helpers for alignment.
 *
 * Notes:
 * - These operate on normalized grayscale Float32 pixels (typically [0..1]).
 * - Keep them fast and allocation-light; slice search may call them many times.
 */

import type { ExclusionMask } from '../types/api';

function assertSquareSize(pixels: Float32Array, size: number, label: string) {
  const n = size * size;
  if (pixels.length !== n) {
    throw new Error(`${label}: expected ${size}x${size} (${n}) pixels, got ${pixels.length}`);
  }
}

/** Erode fractional support with a square minimum filter in linear time. */
export function erodeFractionalSupportSquare(support: Float32Array, size: number, radius: number): Float32Array {
  if (!Number.isInteger(size) || size <= 0) {
    throw new Error('erodeFractionalSupportSquare: size must be a positive integer');
  }
  if (!Number.isInteger(radius) || radius < 0) {
    throw new Error('erodeFractionalSupportSquare: radius must be a non-negative integer');
  }
  assertSquareSize(support, size, 'erodeFractionalSupportSquare');

  const finiteSupport = (index: number) => {
    const value = support[index] ?? 0;
    return Number.isFinite(value) ? value : 0;
  };
  if (radius === 0) {
    return Float32Array.from(support, (value) => (Number.isFinite(value) ? value : 0));
  }

  const boundedRadius = Math.min(radius, size - 1);
  const horizontal = new Float32Array(support.length);
  const output = new Float32Array(support.length);
  const deque = new Int32Array(size);

  for (let y = 0; y < size; y++) {
    const row = y * size;
    let head = 0;
    let tail = 0;
    let nextX = 0;
    for (let x = 0; x < size; x++) {
      const windowEnd = Math.min(size - 1, x + boundedRadius);
      while (nextX <= windowEnd) {
        const nextValue = finiteSupport(row + nextX);
        while (head < tail && finiteSupport(row + deque[tail - 1]) >= nextValue) tail--;
        deque[tail++] = nextX++;
      }
      const windowStart = Math.max(0, x - boundedRadius);
      while (head < tail && deque[head] < windowStart) head++;
      horizontal[row + x] = finiteSupport(row + deque[head]);
    }
  }

  for (let x = 0; x < size; x++) {
    let head = 0;
    let tail = 0;
    let nextY = 0;
    for (let y = 0; y < size; y++) {
      const windowEnd = Math.min(size - 1, y + boundedRadius);
      while (nextY <= windowEnd) {
        const nextValue = horizontal[nextY * size + x];
        while (head < tail && horizontal[deque[tail - 1] * size + x] >= nextValue) tail--;
        deque[tail++] = nextY++;
      }
      const windowStart = Math.max(0, y - boundedRadius);
      while (head < tail && deque[head] < windowStart) head++;
      output[y * size + x] = horizontal[deque[head] * size + x];
    }
  }

  return output;
}

/**
 * Approximate gradient magnitude using a simple central-difference L1 norm:
 *   |dx| + |dy|
 *
 * This is cheaper than Sobel and avoids a sqrt.
 */
export function computeGradientMagnitudeL1Square(pixels: Float32Array, size: number): Float32Array {
  assertSquareSize(pixels, size, 'computeGradientMagnitudeL1Square');

  const out = new Float32Array(pixels.length);
  if (size <= 2) return out;

  // Leave a 1px border as zeros.
  for (let y = 1; y < size - 1; y++) {
    const row = y * size;
    for (let x = 1; x < size - 1; x++) {
      const idx = row + x;
      const dx = (pixels[idx + 1] ?? 0) - (pixels[idx - 1] ?? 0);
      const dy = (pixels[idx + size] ?? 0) - (pixels[idx - size] ?? 0);
      out[idx] = Math.abs(dx) + Math.abs(dy);
    }
  }

  return out;
}

/** Build a polarity-independent edge-energy image for bounded phase correction. */
export function buildStructuralPhaseImageSquare(pixels: Float32Array, size: number): Float32Array {
  const gradients = computeGradientMagnitudeL1Square(pixels, size);
  let minimumPositive = Number.POSITIVE_INFINITY;
  let maximumPositive = Number.NEGATIVE_INFINITY;
  let positiveCount = 0;
  for (let index = 0; index < gradients.length; index++) {
    const gradient = gradients[index] ?? 0;
    if (!Number.isFinite(gradient) || !(gradient > 0)) continue;
    minimumPositive = Math.min(minimumPositive, gradient);
    maximumPositive = Math.max(maximumPositive, gradient);
    positiveCount++;
  }
  if (positiveCount === 0) return new Float32Array(gradients.length);

  const histogram = new Uint32Array(256);
  const range = maximumPositive - minimumPositive;
  if (range > 1e-12) {
    const scale = (histogram.length - 1) / range;
    for (let index = 0; index < gradients.length; index++) {
      const gradient = gradients[index] ?? 0;
      if (!Number.isFinite(gradient) || !(gradient > 0)) continue;
      const bin = Math.max(0, Math.min(histogram.length - 1, Math.round((gradient - minimumPositive) * scale)));
      histogram[bin]++;
    }
  } else {
    histogram[0] = positiveCount;
  }

  const target = Math.floor((positiveCount - 1) * 0.98);
  let cumulative = 0;
  let percentile98 = maximumPositive;
  for (let bin = 0; bin < histogram.length; bin++) {
    cumulative += histogram[bin] ?? 0;
    if (cumulative <= target) continue;
    const binPosition = histogram.length > 1 ? bin / (histogram.length - 1) : 0;
    percentile98 = minimumPositive + binPosition * range;
    break;
  }

  if (!(percentile98 > 0) || !Number.isFinite(percentile98)) {
    return new Float32Array(gradients.length);
  }
  const output = new Float32Array(gradients.length);
  for (let index = 0; index < gradients.length; index++) {
    const gradient = gradients[index] ?? 0;
    output[index] = Number.isFinite(gradient) && gradient > 0 ? Math.min(1, gradient / percentile98) : 0;
  }
  return output;
}

export function buildSoftForegroundSupportSquare(
  pixels: Float32Array,
  size: number,
  options?: { fullSupportAt?: number },
): Float32Array {
  assertSquareSize(pixels, size, 'buildSoftForegroundSupportSquare');
  const fullSupportAt = Math.max(1e-6, options?.fullSupportAt ?? 0.05);
  const support = new Float32Array(pixels.length);
  for (let i = 0; i < pixels.length; i++) {
    const value = pixels[i] ?? 0;
    const t = Math.max(0, Math.min(1, Number.isFinite(value) ? value / fullSupportAt : 0));
    support[i] = t * t * (3 - 2 * t);
  }
  return support;
}

/** Smoothly replace a reference-space exclusion with surrounding mean intensity. */
export function inpaintExclusionRectSquare(
  pixels: Float32Array,
  size: number,
  exclusionRect: ExclusionMask | undefined,
  featherPx = 4,
): { pixels: Float32Array; excludedFrac: number } {
  assertSquareSize(pixels, size, 'inpaintExclusionRectSquare');
  if (!exclusionRect) return { pixels, excludedFrac: 0 };

  const x0 = Math.max(0, Math.min(size, Math.floor(exclusionRect.x * size)));
  const y0 = Math.max(0, Math.min(size, Math.floor(exclusionRect.y * size)));
  const x1 = Math.max(0, Math.min(size, Math.ceil((exclusionRect.x + exclusionRect.width) * size)));
  const y1 = Math.max(0, Math.min(size, Math.ceil((exclusionRect.y + exclusionRect.height) * size)));
  if (x1 <= x0 || y1 <= y0) return { pixels, excludedFrac: 0 };

  let outsideSum = 0;
  let outsideCount = 0;
  for (let y = 0; y < size; y++) {
    const row = y * size;
    for (let x = 0; x < size; x++) {
      if (x >= x0 && x < x1 && y >= y0 && y < y1) continue;
      const value = pixels[row + x] ?? 0;
      if (!Number.isFinite(value)) continue;
      outsideSum += value;
      outsideCount++;
    }
  }
  const outsideMean = outsideCount > 0 ? outsideSum / outsideCount : 0;
  const output = Float32Array.from(pixels);
  const feather = Math.max(0, Math.round(featherPx));
  const expandedX0 = Math.max(0, x0 - feather);
  const expandedY0 = Math.max(0, y0 - feather);
  const expandedX1 = Math.min(size, x1 + feather);
  const expandedY1 = Math.min(size, y1 + feather);
  for (let y = expandedY0; y < expandedY1; y++) {
    const row = y * size;
    for (let x = expandedX0; x < expandedX1; x++) {
      const inside = x >= x0 && x < x1 && y >= y0 && y < y1;
      const distanceX = x < x0 ? x0 - x : x >= x1 ? x - x1 + 1 : 0;
      const distanceY = y < y0 ? y0 - y : y >= y1 ? y - y1 + 1 : 0;
      const distanceOutside = Math.max(distanceX, distanceY);
      const blend = inside
        ? 1
        : feather > 0
          ? Math.max(0, Math.min(1, (feather - distanceOutside + 1) / (feather + 1)))
          : 0;
      if (blend <= 0) continue;
      const index = row + x;
      const source = pixels[index] ?? outsideMean;
      output[index] = source * (1 - blend) + outsideMean * blend;
    }
  }

  return {
    pixels: output,
    excludedFrac: ((x1 - x0) * (y1 - y0)) / (size * size),
  };
}
