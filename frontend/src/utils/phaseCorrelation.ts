import type { ExclusionMask } from '../types/api';

export type PhaseCorrelationOptions = {
  /** Optional inclusion mask (same shape as images). Keep pixels where mask[idx] != 0. */
  inclusionMask?: Uint8Array;

  /** Optional exclusion rectangle in normalized [0,1] image coordinates. */
  exclusionRect?: ExclusionMask;

  /** Image width in pixels (required if exclusionRect is provided). */
  imageWidth?: number;
  /** Image height in pixels (required if exclusionRect is provided). */
  imageHeight?: number;

  /** Apply a Hann window before FFT to reduce edge artifacts (default: true). */
  window?: boolean;
};

export type PreparedPhaseCorrelationReference = {
  size: number;
  window1d: Float32Array;
  effectiveMask: Uint8Array;
  pixelsUsed: number;
  refFRe: Float32Array;
  refFIm: Float32Array;
};

export type PhaseCorrelationScratch = {
  size: number;
  // Target FFT buffers
  targetRe: Float32Array;
  targetIm: Float32Array;

  // Cross-power spectrum buffers (reused for IFFT result)
  crossRe: Float32Array;
  crossIm: Float32Array;

  // Temp buffers for 1D FFTs
  tmpRe: Float32Array;
  tmpIm: Float32Array;
  tmp2Re: Float32Array;
  tmp2Im: Float32Array;
};

function inferSquareSize(n: number): number {
  const s = Math.round(Math.sqrt(n));
  if (s <= 0 || s * s !== n) {
    throw new Error('phaseCorrelation: expected square image (provide imageWidth/imageHeight)');
  }
  return s;
}

function isPowerOfTwo(n: number): boolean {
  return n > 0 && (n & (n - 1)) === 0;
}

function buildEffectiveMask(n: number, size: number, opts: PhaseCorrelationOptions): { mask: Uint8Array; pixelsUsed: number } {
  const inclusionMask = opts.inclusionMask;
  if (inclusionMask && inclusionMask.length !== n) {
    throw new Error(`phaseCorrelation: inclusionMask length mismatch (mask=${inclusionMask.length}, image=${n})`);
  }

  const out = new Uint8Array(n);
  if (inclusionMask) {
    for (let i = 0; i < n; i++) out[i] = inclusionMask[i] ? 1 : 0;
  } else {
    out.fill(1);
  }

  const exclusionRect = opts.exclusionRect;
  if (exclusionRect && size > 0) {
    const x0 = Math.floor(exclusionRect.x * size);
    const y0 = Math.floor(exclusionRect.y * size);
    const x1 = Math.ceil((exclusionRect.x + exclusionRect.width) * size);
    const y1 = Math.ceil((exclusionRect.y + exclusionRect.height) * size);

    if (x1 > x0 && y1 > y0) {
      for (let y = Math.max(0, y0); y < Math.min(size, y1); y++) {
        const row = y * size;
        for (let x = Math.max(0, x0); x < Math.min(size, x1); x++) {
          out[row + x] = 0;
        }
      }
    }
  }

  let pixelsUsed = 0;
  for (let i = 0; i < n; i++) {
    if (out[i]) pixelsUsed++;
  }

  return { mask: out, pixelsUsed };
}

function buildHannWindow1d(n: number, enabled: boolean): Float32Array {
  const w = new Float32Array(n);
  if (!enabled) {
    w.fill(1);
    return w;
  }

  if (n <= 1) {
    w.fill(1);
    return w;
  }

  const denom = n - 1;
  for (let i = 0; i < n; i++) {
    w[i] = 0.5 * (1 - Math.cos((2 * Math.PI * i) / denom));
  }
  return w;
}

function fftRadix2InPlace(re: Float32Array, im: Float32Array, inverse: boolean): void {
  const n = re.length;
  if (im.length !== n) throw new Error('phaseCorrelation: fft buffer size mismatch');
  if (!isPowerOfTwo(n)) throw new Error(`phaseCorrelation: fft length must be power of two (got ${n})`);

  // Bit reversal permutation.
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    while (j & bit) {
      j ^= bit;
      bit >>= 1;
    }
    j ^= bit;

    if (i < j) {
      const tr = re[i]!;
      re[i] = re[j]!;
      re[j] = tr;

      const ti = im[i]!;
      im[i] = im[j]!;
      im[j] = ti;
    }
  }

  for (let len = 2; len <= n; len <<= 1) {
    const ang = (2 * Math.PI) / len * (inverse ? 1 : -1);
    const wlenRe = Math.cos(ang);
    const wlenIm = Math.sin(ang);

    for (let i = 0; i < n; i += len) {
      let wRe = 1;
      let wIm = 0;

      const half = len >> 1;
      for (let j = 0; j < half; j++) {
        const uRe = re[i + j]!;
        const uIm = im[i + j]!;

        const vRe0 = re[i + j + half]!;
        const vIm0 = im[i + j + half]!;

        // v = v0 * w
        const vRe = vRe0 * wRe - vIm0 * wIm;
        const vIm = vRe0 * wIm + vIm0 * wRe;

        re[i + j] = uRe + vRe;
        im[i + j] = uIm + vIm;
        re[i + j + half] = uRe - vRe;
        im[i + j + half] = uIm - vIm;

        // w *= wlen
        const nextWRe = wRe * wlenRe - wIm * wlenIm;
        const nextWIm = wRe * wlenIm + wIm * wlenRe;
        wRe = nextWRe;
        wIm = nextWIm;
      }
    }
  }

  if (inverse) {
    const invN = 1 / n;
    for (let i = 0; i < n; i++) {
      re[i] = (re[i] ?? 0) * invN;
      im[i] = (im[i] ?? 0) * invN;
    }
  }
}

function fft2dInPlace(
  re: Float32Array,
  im: Float32Array,
  size: number,
  inverse: boolean,
  scratch: { tmpRe: Float32Array; tmpIm: Float32Array; tmp2Re: Float32Array; tmp2Im: Float32Array }
): void {
  const n = size * size;
  if (re.length !== n || im.length !== n) {
    throw new Error('phaseCorrelation: fft2d buffers size mismatch');
  }

  const rowRe = scratch.tmpRe;
  const rowIm = scratch.tmpIm;
  const colRe = scratch.tmp2Re;
  const colIm = scratch.tmp2Im;

  if (rowRe.length !== size || rowIm.length !== size || colRe.length !== size || colIm.length !== size) {
    throw new Error('phaseCorrelation: fft2d scratch size mismatch');
  }

  // Rows
  for (let y = 0; y < size; y++) {
    const row = y * size;
    for (let x = 0; x < size; x++) {
      rowRe[x] = re[row + x]!;
      rowIm[x] = im[row + x]!;
    }

    fftRadix2InPlace(rowRe, rowIm, inverse);

    for (let x = 0; x < size; x++) {
      re[row + x] = rowRe[x]!;
      im[row + x] = rowIm[x]!;
    }
  }

  // Columns
  for (let x = 0; x < size; x++) {
    for (let y = 0; y < size; y++) {
      const idx = y * size + x;
      colRe[y] = re[idx]!;
      colIm[y] = im[idx]!;
    }

    fftRadix2InPlace(colRe, colIm, inverse);

    for (let y = 0; y < size; y++) {
      const idx = y * size + x;
      re[idx] = colRe[y]!;
      im[idx] = colIm[y]!;
    }
  }
}

function fillPreprocessedReal(
  outRe: Float32Array,
  outIm: Float32Array,
  pixels: Float32Array,
  size: number,
  mask: Uint8Array,
  window1d: Float32Array
): void {
  const n = size * size;
  if (pixels.length !== n || outRe.length !== n || outIm.length !== n || mask.length !== n) {
    throw new Error('phaseCorrelation: preprocess size mismatch');
  }

  // Mean over included pixels.
  let sum = 0;
  let count = 0;
  for (let i = 0; i < n; i++) {
    if (!mask[i]) continue;
    const v = pixels[i]!;
    if (!Number.isFinite(v)) continue;
    sum += v;
    count++;
  }
  const mean = count > 0 ? sum / count : 0;

  for (let y = 0; y < size; y++) {
    const wy = window1d[y]!;
    const row = y * size;
    for (let x = 0; x < size; x++) {
      const idx = row + x;
      if (!mask[idx]) {
        outRe[idx] = 0;
        outIm[idx] = 0;
        continue;
      }
      const wx = window1d[x]!;
      const w = wx * wy;
      const v = pixels[idx]!;
      outRe[idx] = (Number.isFinite(v) ? v - mean : -mean) * w;
      outIm[idx] = 0;
    }
  }
}

export function createPhaseCorrelationScratch(size: number): PhaseCorrelationScratch {
  const n = size * size;
  return {
    size,
    targetRe: new Float32Array(n),
    targetIm: new Float32Array(n),
    crossRe: new Float32Array(n),
    crossIm: new Float32Array(n),
    tmpRe: new Float32Array(size),
    tmpIm: new Float32Array(size),
    tmp2Re: new Float32Array(size),
    tmp2Im: new Float32Array(size),
  };
}

export function preparePhaseCorrelationReference(
  referencePixels: Float32Array,
  opts: PhaseCorrelationOptions = {}
): PreparedPhaseCorrelationReference {
  const n = referencePixels.length;
  if (n === 0) {
    return {
      size: 0,
      window1d: new Float32Array(0),
      effectiveMask: new Uint8Array(0),
      pixelsUsed: 0,
      refFRe: new Float32Array(0),
      refFIm: new Float32Array(0),
    };
  }

  const size =
    typeof opts.imageWidth === 'number' && typeof opts.imageHeight === 'number' && opts.imageWidth === opts.imageHeight
      ? opts.imageWidth
      : inferSquareSize(n);

  if (!isPowerOfTwo(size)) {
    throw new Error(`phaseCorrelation: size must be power of two (got ${size})`);
  }

  const { mask: effectiveMask, pixelsUsed } = buildEffectiveMask(n, size, { ...opts, imageWidth: size, imageHeight: size });

  const window1d = buildHannWindow1d(size, opts.window ?? true);

  const refFRe = new Float32Array(n);
  const refFIm = new Float32Array(n);

  // Preprocess: mean-subtract, mask, and window.
  fillPreprocessedReal(refFRe, refFIm, referencePixels, size, effectiveMask, window1d);

  // FFT reference.
  const scratch = createPhaseCorrelationScratch(size);
  fft2dInPlace(refFRe, refFIm, size, false, scratch);

  return { size, window1d, effectiveMask, pixelsUsed, refFRe, refFIm };
}

/**
 * Compute phase correlation similarity between a prepared reference and a target.
 *
 * Returns `phase` as the peak value of the phase-only correlation surface (higher is better).
 *
 * Notes:
 * - This is primarily a translation-focused similarity. In our slice-search pipeline, the candidate
 *   slice is already pre-warped by a seed affine transform.
 */
export function computePhaseCorrelationSimilarity(
  prepared: PreparedPhaseCorrelationReference,
  targetPixels: Float32Array,
  scratch: PhaseCorrelationScratch
): { phase: number; pixelsUsed: number } {
  const size = prepared.size;
  if (size <= 0) return { phase: 0, pixelsUsed: 0 };

  if (scratch.size !== size) {
    throw new Error('phaseCorrelation: scratch size mismatch');
  }

  const n = size * size;
  if (targetPixels.length !== n) {
    throw new Error(`phaseCorrelation: target size mismatch (expected ${n}, got ${targetPixels.length})`);
  }

  // Target FFT buffers.
  fillPreprocessedReal(
    scratch.targetRe,
    scratch.targetIm,
    targetPixels,
    size,
    prepared.effectiveMask,
    prepared.window1d
  );

  fft2dInPlace(scratch.targetRe, scratch.targetIm, size, false, scratch);

  // Cross-power spectrum: R = F_ref * conj(F_tgt) / |F_ref * conj(F_tgt)|
  const eps = 1e-12;
  for (let i = 0; i < n; i++) {
    const aRe = prepared.refFRe[i]!;
    const aIm = prepared.refFIm[i]!;
    const bRe = scratch.targetRe[i]!;
    const bIm = scratch.targetIm[i]!;

    // a * conj(b)
    const cRe = aRe * bRe + aIm * bIm;
    const cIm = aIm * bRe - aRe * bIm;

    const mag = Math.sqrt(cRe * cRe + cIm * cIm);
    if (mag > eps) {
      const inv = 1 / mag;
      scratch.crossRe[i] = cRe * inv;
      scratch.crossIm[i] = cIm * inv;
    } else {
      scratch.crossRe[i] = 0;
      scratch.crossIm[i] = 0;
    }
  }

  // Inverse FFT to get correlation surface.
  fft2dInPlace(scratch.crossRe, scratch.crossIm, size, true, scratch);

  // Find peak (real part).
  let peak = Number.NEGATIVE_INFINITY;
  for (let i = 0; i < n; i++) {
    const v = scratch.crossRe[i]!;
    if (v > peak) peak = v;
  }

  if (!Number.isFinite(peak)) peak = 0;

  // Phase correlation peak should be in ~[0..1]. Clamp for sanity.
  const phase = Math.max(0, Math.min(1, peak));

  return { phase, pixelsUsed: prepared.pixelsUsed };
}
