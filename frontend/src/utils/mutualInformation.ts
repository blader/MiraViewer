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
};

function clamp01(x: number): number {
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  return x;
}

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
 */
export function computeMutualInformation(
  imageA: Float32Array,
  imageB: Float32Array,
  bins: number = 64
): MutualInformationResult {
  const n = imageA.length;
  if (n === 0 || imageB.length !== n) {
    return { mi: 0, nmi: 0, hA: 0, hB: 0, hAB: 0, bins };
  }

  if (!Number.isFinite(bins) || bins < 4) {
    throw new Error(`computeMutualInformation: bins must be >= 4 (got ${bins})`);
  }

  let minA = Number.POSITIVE_INFINITY;
  let maxA = Number.NEGATIVE_INFINITY;
  let minB = Number.POSITIVE_INFINITY;
  let maxB = Number.NEGATIVE_INFINITY;

  for (let i = 0; i < n; i++) {
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
    return { mi: 0, nmi: 0, hA: 0, hB: 0, hAB: 0, bins };
  }

  const rangeA = maxA - minA;
  const rangeB = maxB - minB;
  const eps = 1e-12;

  if (rangeA < eps || rangeB < eps) {
    return { mi: 0, nmi: 0, hA: 0, hB: 0, hAB: 0, bins };
  }

  const histA = new Uint32Array(bins);
  const histB = new Uint32Array(bins);
  const joint = new Uint32Array(bins * bins);

  for (let i = 0; i < n; i++) {
    const a = imageA[i];
    const b = imageB[i];

    const aNorm = clamp01((a - minA) / rangeA);
    const bNorm = clamp01((b - minB) / rangeB);

    const aBin = Math.min(bins - 1, Math.max(0, Math.floor(aNorm * bins)));
    const bBin = Math.min(bins - 1, Math.max(0, Math.floor(bNorm * bins)));

    histA[aBin]++;
    histB[bBin]++;
    joint[aBin * bins + bBin]++;
  }

  const hA = entropyFromCounts(histA, n);
  const hB = entropyFromCounts(histB, n);
  const hAB = entropyFromCounts(joint, n);

  const mi = hA + hB - hAB;
  const nmi = hAB > eps ? (hA + hB) / hAB : 0;

  return { mi, nmi, hA, hB, hAB, bins };
}
