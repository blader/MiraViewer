import type { ExclusionMask } from '../types/api';

export type BlockSimilarityResult = {
  /** Block-averaged SSIM (higher is better; typically ~[-1..1], often [0..1] in practice). */
  ssim: number;
  /** Block-averaged local normalized cross correlation (LNCC). Range: ~[-1..1]. */
  lncc: number;
  /** Global zero-mean normalized cross correlation (ZNCC). Range: ~[-1..1]. */
  zncc: number;
  /** Number of blocks that contributed (had >= 1 included pixel). */
  blocksUsed: number;
  /** Number of pixels used after masking. */
  pixelsUsed: number;
};

export type SsimResult = {
  /** Block-averaged SSIM (higher is better; typically ~[-1..1], often [0..1] in practice). */
  ssim: number;
  /** Number of blocks that contributed (had >= 1 included pixel). */
  blocksUsed: number;
  /** Number of pixels used after masking. */
  pixelsUsed: number;
};

export type SsimOptions = {
  /** Block size in pixels. Default: 16. Larger is faster but less local. */
  blockSize?: number;

  /** Optional inclusion mask (same shape as images). Keep pixels where mask[idx] != 0. */
  inclusionMask?: Uint8Array;

  /** Optional exclusion rectangle in normalized [0,1] image coordinates. */
  exclusionRect?: ExclusionMask;

  /** Image width in pixels (required if exclusionRect is provided). */
  imageWidth?: number;
  /** Image height in pixels (required if exclusionRect is provided). */
  imageHeight?: number;

  /** SSIM constants (defaults match common SSIM settings). */
  k1?: number; // default 0.01
  k2?: number; // default 0.03
  dynamicRange?: number; // L, default 1.0 for normalized pixels
};

function inferSquareSize(n: number): number {
  const s = Math.round(Math.sqrt(n));
  if (s <= 0 || s * s !== n) {
    throw new Error('computeBlockSSIM: expected square image (provide imageWidth/imageHeight)');
  }
  return s;
}

/**
 * Compute a fast approximation of SSIM by averaging SSIM over non-overlapping blocks.
 *
 * Notes:
 * - This is not the classic Gaussian-window SSIM; it's a block-based approximation that is much
 *   faster in JS/TS while still capturing local structure.
 * - Pixels are assumed to be normalized grayscale (typically [0..1]).
 */
export function computeBlockSimilarity(imageA: Float32Array, imageB: Float32Array, opts: SsimOptions = {}): BlockSimilarityResult {
  const n = imageA.length;
  if (n === 0 || imageB.length !== n) {
    return { ssim: 0, lncc: 0, zncc: 0, blocksUsed: 0, pixelsUsed: 0 };
  }

  const inclusionMask = opts.inclusionMask;
  if (inclusionMask && inclusionMask.length !== n) {
    throw new Error(`computeBlockSSIM: inclusionMask length mismatch (mask=${inclusionMask.length}, image=${n})`);
  }

  const width =
    typeof opts.imageWidth === 'number' && typeof opts.imageHeight === 'number' && opts.imageWidth === opts.imageHeight
      ? opts.imageWidth
      : inferSquareSize(n);
  const height =
    typeof opts.imageHeight === 'number' && typeof opts.imageWidth === 'number' && opts.imageWidth === opts.imageHeight
      ? opts.imageHeight
      : width;

  const blockSizeRaw = opts.blockSize ?? 16;
  const blockSize = Math.max(4, Math.round(blockSizeRaw));

  const blockCols = Math.ceil(width / blockSize);
  const blockRows = Math.ceil(height / blockSize);
  const numBlocks = blockCols * blockRows;

  // Per-block accumulators.
  const sumA = new Float64Array(numBlocks);
  const sumB = new Float64Array(numBlocks);
  const sumA2 = new Float64Array(numBlocks);
  const sumB2 = new Float64Array(numBlocks);
  const sumAB = new Float64Array(numBlocks);
  const count = new Uint32Array(numBlocks);

  // Precompute exclusion bounds.
  const exclusionRect = opts.exclusionRect;
  let hasExclusion = false;
  let exclX0 = 0;
  let exclY0 = 0;
  let exclX1 = 0;
  let exclY1 = 0;
  if (exclusionRect && width > 0 && height > 0) {
    exclX0 = Math.floor(exclusionRect.x * width);
    exclY0 = Math.floor(exclusionRect.y * height);
    exclX1 = Math.ceil((exclusionRect.x + exclusionRect.width) * width);
    exclY1 = Math.ceil((exclusionRect.y + exclusionRect.height) * height);
    hasExclusion = exclX1 > exclX0 && exclY1 > exclY0;
  }

  // Fast path for power-of-two blocks (default 16): use bitshift instead of division.
  const isPowerOfTwo = (v: number) => (v & (v - 1)) === 0;
  const useShift = isPowerOfTwo(blockSize);
  const blockShift = useShift ? Math.round(Math.log2(blockSize)) : 0;

  let pixelsUsed = 0;

  // Global accumulators (for ZNCC).
  let sumATotal = 0;
  let sumBTotal = 0;
  let sumA2Total = 0;
  let sumB2Total = 0;
  let sumABTotal = 0;

  for (let y = 0; y < height; y++) {
    const row = y * width;
    const blockRow = useShift ? (y >> blockShift) : Math.floor(y / blockSize);

    for (let x = 0; x < width; x++) {
      const idx = row + x;

      if (inclusionMask && inclusionMask[idx] === 0) continue;

      if (hasExclusion && x >= exclX0 && x < exclX1 && y >= exclY0 && y < exclY1) {
        continue;
      }

      const a = imageA[idx] ?? 0;
      const b = imageB[idx] ?? 0;

      const blockCol = useShift ? (x >> blockShift) : Math.floor(x / blockSize);
      const bi = blockRow * blockCols + blockCol;

      sumA[bi] += a;
      sumB[bi] += b;
      sumA2[bi] += a * a;
      sumB2[bi] += b * b;
      sumAB[bi] += a * b;
      count[bi]++;
      pixelsUsed++;

      sumATotal += a;
      sumBTotal += b;
      sumA2Total += a * a;
      sumB2Total += b * b;
      sumABTotal += a * b;
    }
  }

  if (pixelsUsed === 0) {
    return { ssim: 0, lncc: 0, zncc: 0, blocksUsed: 0, pixelsUsed: 0 };
  }

  const L = opts.dynamicRange ?? 1;
  const k1 = opts.k1 ?? 0.01;
  const k2 = opts.k2 ?? 0.03;
  const c1 = (k1 * L) * (k1 * L);
  const c2 = (k2 * L) * (k2 * L);

  // ZNCC (global, zero-mean normalized cross correlation).
  //
  // We use population stats (divide by N) for stability.
  const invN = 1 / pixelsUsed;
  const meanA = sumATotal * invN;
  const meanB = sumBTotal * invN;
  let varA = sumA2Total * invN - meanA * meanA;
  let varB = sumB2Total * invN - meanB * meanB;
  let covAB = sumABTotal * invN - meanA * meanB;

  if (varA < 0) varA = 0;
  if (varB < 0) varB = 0;
  if (!Number.isFinite(covAB)) covAB = 0;

  const eps = 1e-12;
  const denomZncc = Math.sqrt(varA * varB);
  const zncc = denomZncc > eps ? covAB / denomZncc : 0;

  let weightedSsimSum = 0;
  let weightedLnccSum = 0;
  let weightTotal = 0;
  let blocksUsed = 0;


  for (let bi = 0; bi < numBlocks; bi++) {
    const m = count[bi];
    if (m === 0) continue;

    const invM = 1 / m;
    const meanA = sumA[bi] * invM;
    const meanB = sumB[bi] * invM;

    let varA = sumA2[bi] * invM - meanA * meanA;
    let varB = sumB2[bi] * invM - meanB * meanB;
    let covAB = sumAB[bi] * invM - meanA * meanB;

    // Numerical safety.
    if (varA < 0) varA = 0;
    if (varB < 0) varB = 0;

    // Clamp extreme cov due to numeric issues.
    if (!Number.isFinite(covAB)) covAB = 0;

    const num1 = 2 * meanA * meanB + c1;
    const den1 = meanA * meanA + meanB * meanB + c1;

    const num2 = 2 * covAB + c2;
    const den2 = varA + varB + c2;

    const denom = den1 * den2;
    const ssimBlock = denom !== 0 ? (num1 * num2) / denom : 0;

    // LNCC for this block.
    const denomLncc = Math.sqrt(varA * varB);
    const lnccBlock = denomLncc > eps ? covAB / denomLncc : 0;

    // Weight by included pixels so partially-masked blocks don't dominate.
    weightedSsimSum += ssimBlock * m;
    weightedLnccSum += lnccBlock * m;
    weightTotal += m;
    blocksUsed++;
  }

  const ssim = weightTotal > 0 ? weightedSsimSum / weightTotal : 0;
  const lncc = weightTotal > 0 ? weightedLnccSum / weightTotal : 0;

  return { ssim, lncc, zncc, blocksUsed, pixelsUsed };
}

export function computeBlockSSIM(imageA: Float32Array, imageB: Float32Array, opts: SsimOptions = {}): SsimResult {
  const r = computeBlockSimilarity(imageA, imageB, opts);
  return { ssim: r.ssim, blocksUsed: r.blocksUsed, pixelsUsed: r.pixelsUsed };
}
