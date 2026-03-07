export type MutualInformationResult = {
  /** Mutual information (natural log). Higher indicates stronger dependency. */
  mi: number;
  /** Normalized mutual information (Studholme). Typically ~[1..2] for related images. */
  nmi: number;
  /** Entropy of A (natural log). */
  hA: number;
  /** Entropy of B (natural log). */
  hB: number;
  /** Joint entropy H(A,B) (natural log). */
  hAB: number;
  /** Number of histogram bins used per image. */
  bins: number;
  /** Number of pixels used (after masking). */
  pixelsUsed: number;
};

/**
 * Options for masked mutual information computation.
 */
import { clamp01 } from './math';

export type MutualInformationOptions = {
  /** Number of histogram bins (default: 64). */
  bins?: number;

  /**
   * Optional inclusion mask.
   *
   * If provided, only pixels where inclusionMask[idx] != 0 are used.
   * This is useful for ignoring background / low-information regions during slice search.
   */
  inclusionMask?: Uint8Array;

  /**
   * Optional exclusion rectangle in normalized [0,1] image coordinates.
   * Pixels inside this rect are excluded from the histogram computation.
   */
  exclusionRect?: { x: number; y: number; width: number; height: number };

  /** Image width in pixels (required if exclusionRect is provided). */
  imageWidth?: number;
  /** Image height in pixels (required if exclusionRect is provided). */
  imageHeight?: number;
};

function entropyFromCounts(counts: Uint32Array, total: number): number {
  if (total <= 0) return 0;
  let h = 0;
  for (let i = 0; i < counts.length; i++) {
    const c = counts[i];
    if (c === 0) continue;
    const p = c / total;
    h -= p * Math.log(p);
  }
  return h;
}

/**
 * Compute mutual information (MI) and normalized mutual information (NMI) between two images.
 *
 * Why MI is useful here:
 * - MI/NMI are often more robust than correlation-based metrics when intensity mappings differ
 *   (different scanners, windowing, or non-linear preprocessing).
 *
 * Implementation notes:
 * - We compute a joint histogram after linearly rescaling each image into [0,1] based on its
 *   own min/max. This makes binning stable even if some values drift outside [0,1].
 * - Entropies are computed with natural log.
 * - NMI uses the Studholme definition: (H(A) + H(B)) / H(A,B).
 * - An optional exclusion rectangle can be provided to skip pixels in that region (useful for
 *   ignoring pathology like tumors during alignment).
 */
export function computeMutualInformation(
  imageA: Float32Array,
  imageB: Float32Array,
  optionsOrBins: number | MutualInformationOptions = 64
): MutualInformationResult {
  const opts: MutualInformationOptions =
    typeof optionsOrBins === 'number' ? { bins: optionsOrBins } : optionsOrBins;

  const bins = opts.bins ?? 64;
  const inclusionMask = opts.inclusionMask;
  const exclusionRect = opts.exclusionRect;
  const imageWidth = opts.imageWidth;
  const imageHeight = opts.imageHeight;

  const n = imageA.length;
  if (n === 0 || imageB.length !== n) {
    return { mi: 0, nmi: 0, hA: 0, hB: 0, hAB: 0, bins, pixelsUsed: 0 };
  }

  if (!Number.isFinite(bins) || bins < 4) {
    throw new Error(`computeMutualInformation: bins must be >= 4 (got ${bins})`);
  }

  // Precompute exclusion bounds in pixel coordinates if provided.
  let exclX0 = 0, exclY0 = 0, exclX1 = 0, exclY1 = 0;
  let hasExclusion = false;
  let imgW = 0, imgH = 0;

  if (exclusionRect && imageWidth && imageHeight && imageWidth > 0 && imageHeight > 0) {
    imgW = imageWidth;
    imgH = imageHeight;
    exclX0 = Math.floor(exclusionRect.x * imgW);
    exclY0 = Math.floor(exclusionRect.y * imgH);
    exclX1 = Math.ceil((exclusionRect.x + exclusionRect.width) * imgW);
    exclY1 = Math.ceil((exclusionRect.y + exclusionRect.height) * imgH);
    hasExclusion = exclX1 > exclX0 && exclY1 > exclY0;
  }

  if (inclusionMask && inclusionMask.length !== n) {
    throw new Error(
      `computeMutualInformation: inclusionMask length mismatch (mask=${inclusionMask.length}, image=${n})`
    );
  }

  // Helper to check if pixel index is included by masks.
  const isIncluded = (idx: number): boolean => {
    if (inclusionMask && inclusionMask[idx] === 0) return false;

    if (!hasExclusion) return true;
    const px = idx % imgW;
    const py = Math.floor(idx / imgW);
    return !(px >= exclX0 && px < exclX1 && py >= exclY0 && py < exclY1);
  };

  let minA = Number.POSITIVE_INFINITY;
  let maxA = Number.NEGATIVE_INFINITY;
  let minB = Number.POSITIVE_INFINITY;
  let maxB = Number.NEGATIVE_INFINITY;

  for (let i = 0; i < n; i++) {
    if (!isIncluded(i)) continue;

    const a = imageA[i];
    const b = imageB[i];

    if (Number.isFinite(a)) {
      if (a < minA) minA = a;
      if (a > maxA) maxA = a;
    }
    if (Number.isFinite(b)) {
      if (b < minB) minB = b;
      if (b > maxB) maxB = b;
    }
  }

  if (!Number.isFinite(minA) || !Number.isFinite(maxA) || !Number.isFinite(minB) || !Number.isFinite(maxB)) {
    return { mi: 0, nmi: 0, hA: 0, hB: 0, hAB: 0, bins, pixelsUsed: 0 };
  }

  const rangeA = maxA - minA;
  const rangeB = maxB - minB;
  const eps = 1e-12;

  if (rangeA < eps || rangeB < eps) {
    return { mi: 0, nmi: 0, hA: 0, hB: 0, hAB: 0, bins, pixelsUsed: 0 };
  }

  const histA = new Uint32Array(bins);
  const histB = new Uint32Array(bins);
  const joint = new Uint32Array(bins * bins);
  let pixelsUsed = 0;

  for (let i = 0; i < n; i++) {
    if (!isIncluded(i)) continue;

    const a = imageA[i];
    const b = imageB[i];

    const aNorm = clamp01((a - minA) / rangeA);
    const bNorm = clamp01((b - minB) / rangeB);

    const aBin = Math.min(bins - 1, Math.max(0, Math.floor(aNorm * bins)));
    const bBin = Math.min(bins - 1, Math.max(0, Math.floor(bNorm * bins)));

    histA[aBin]++;
    histB[bBin]++;
    joint[aBin * bins + bBin]++;
    pixelsUsed++;
  }

  if (pixelsUsed === 0) {
    return { mi: 0, nmi: 0, hA: 0, hB: 0, hAB: 0, bins, pixelsUsed: 0 };
  }

  const hA = entropyFromCounts(histA, pixelsUsed);
  const hB = entropyFromCounts(histB, pixelsUsed);
  const hAB = entropyFromCounts(joint, pixelsUsed);

  const mi = hA + hB - hAB;
  const nmi = hAB > eps ? (hA + hB) / hAB : 0;

  return { mi, nmi, hA, hB, hAB, bins, pixelsUsed };
}
