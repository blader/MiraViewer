/**
 * Small image-processing helpers for alignment.
 *
 * Notes:
 * - These operate on normalized grayscale Float32 pixels (typically [0..1]).
 * - Keep them fast and allocation-light; slice search may call them many times.
 */

function assertSquareSize(pixels: Float32Array, size: number, label: string) {
  const n = size * size;
  if (pixels.length !== n) {
    throw new Error(`${label}: expected ${size}x${size} (${n}) pixels, got ${pixels.length}`);
  }
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

export type InclusionMaskBuildResult = {
  mask: Uint8Array;
  includedCount: number;
  includedFrac: number;
};

/**
 * Build a simple inclusion mask that keeps pixels above a fixed threshold.
 *
 * Returns null if the mask would be too sparse (so callers can fall back to "no mask").
 */
export function buildInclusionMaskFromThresholdSquare(
  pixels: Float32Array,
  size: number,
  threshold: number,
  opts?: {
    /** If includedFrac falls below this, return null. Default: 0.05 (5%). */
    minIncludedFrac?: number;
  }
): InclusionMaskBuildResult | null {
  assertSquareSize(pixels, size, 'buildInclusionMaskFromThresholdSquare');

  const minIncludedFrac = opts?.minIncludedFrac ?? 0.05;

  const mask = new Uint8Array(pixels.length);
  let includedCount = 0;

  for (let i = 0; i < pixels.length; i++) {
    if ((pixels[i] ?? 0) > threshold) {
      mask[i] = 1;
      includedCount++;
    }
  }

  const includedFrac = includedCount / Math.max(1, pixels.length);

  if (!Number.isFinite(includedFrac) || includedFrac < minIncludedFrac) {
    return null;
  }

  return { mask, includedCount, includedFrac };
}
