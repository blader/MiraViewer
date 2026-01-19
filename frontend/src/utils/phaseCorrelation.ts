import { clamp } from './math';

/**
 * Minimal FFT + phase correlation implementation.
 *
 * Why we keep this in-repo (vs a dependency):
 * - We want deterministic behavior, full control, and easy debugging.
 * - Alignment runs on downsampled images (typically 128–256 px), so a radix-2 FFT is fast enough.
 *
 * Notes:
 * - All FFT sizes MUST be powers of two.
 * - Images are assumed row-major in [0..1] grayscale.
 */

export type ComplexImage = {
  width: number;
  height: number;
  re: Float64Array;
  im: Float64Array;
};

export type PhaseCorrelationResult = {
  /** Translation (in pixels) that best aligns B to A (see function docs for sign convention). */
  dx: number;
  dy: number;
  /** Correlation peak value (raw). */
  peak: number;
  /** Peak-to-sidelobe ratio (higher is better; roughly measures peak distinctness). */
  psr: number;
};

function isPowerOfTwo(n: number): boolean {
  return n > 0 && (n & (n - 1)) === 0;
}

function assertPowerOfTwo(n: number, label: string) {
  if (!isPowerOfTwo(n)) {
    throw new Error(`${label} must be a power of two (got ${n})`);
  }
}

/**
 * In-place radix-2 Cooley–Tukey FFT.
 *
 * @param inverse - If true, computes inverse FFT and scales by 1/n.
 */
export function fftRadix2(re: Float64Array, im: Float64Array, inverse: boolean) {
  const n = re.length;
  if (n !== im.length) {
    throw new Error('fftRadix2: re/im length mismatch');
  }
  if (n <= 1) return;

  assertPowerOfTwo(n, 'fft size');

  // Bit-reversal permutation.
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) {
      j ^= bit;
    }
    j ^= bit;

    if (i < j) {
      const tr = re[i];
      re[i] = re[j];
      re[j] = tr;

      const ti = im[i];
      im[i] = im[j];
      im[j] = ti;
    }
  }

  // Danielson–Lanczos section.
  for (let len = 2; len <= n; len <<= 1) {
    const half = len >> 1;
    const ang = (inverse ? 2 : -2) * Math.PI / len;
    const wStepRe = Math.cos(ang);
    const wStepIm = Math.sin(ang);

    for (let start = 0; start < n; start += len) {
      let wRe = 1;
      let wIm = 0;

      for (let i = 0; i < half; i++) {
        const even = start + i;
        const odd = even + half;

        const oRe = re[odd];
        const oIm = im[odd];

        // t = w * odd
        const tRe = wRe * oRe - wIm * oIm;
        const tIm = wRe * oIm + wIm * oRe;

        // odd = even - t
        re[odd] = re[even] - tRe;
        im[odd] = im[even] - tIm;

        // even = even + t
        re[even] = re[even] + tRe;
        im[even] = im[even] + tIm;

        // w *= wStep
        const nextWRe = wRe * wStepRe - wIm * wStepIm;
        const nextWIm = wRe * wStepIm + wIm * wStepRe;
        wRe = nextWRe;
        wIm = nextWIm;
      }
    }
  }

  if (inverse) {
    for (let i = 0; i < n; i++) {
      re[i] /= n;
      im[i] /= n;
    }
  }
}

/**
 * In-place 2D FFT of a complex image stored in row-major arrays.
 *
 * Performs 1D FFTs on rows then columns.
 */
export function fft2d(image: ComplexImage, inverse: boolean) {
  const { width, height, re, im } = image;
  if (re.length !== width * height || im.length !== width * height) {
    throw new Error('fft2d: invalid buffer sizes');
  }

  assertPowerOfTwo(width, 'fft2d width');
  assertPowerOfTwo(height, 'fft2d height');

  // Rows are contiguous; we can FFT in-place via subarrays.
  for (let y = 0; y < height; y++) {
    const rowStart = y * width;
    fftRadix2(re.subarray(rowStart, rowStart + width), im.subarray(rowStart, rowStart + width), inverse);
  }

  // Columns are strided; use temporary buffers.
  const tmpRe = new Float64Array(height);
  const tmpIm = new Float64Array(height);

  for (let x = 0; x < width; x++) {
    for (let y = 0; y < height; y++) {
      const idx = y * width + x;
      tmpRe[y] = re[idx];
      tmpIm[y] = im[idx];
    }

    fftRadix2(tmpRe, tmpIm, inverse);

    for (let y = 0; y < height; y++) {
      const idx = y * width + x;
      re[idx] = tmpRe[y];
      im[idx] = tmpIm[y];
    }
  }
}

export function fft2dFromReal(input: Float32Array, width: number, height: number): ComplexImage {
  if (input.length !== width * height) {
    throw new Error('fft2dFromReal: input size mismatch');
  }

  const re = new Float64Array(width * height);
  const im = new Float64Array(width * height);
  for (let i = 0; i < input.length; i++) {
    re[i] = input[i];
    im[i] = 0;
  }

  const img: ComplexImage = { width, height, re, im };
  fft2d(img, false);
  return img;
}

function ifft2dFromComplex(freq: ComplexImage): ComplexImage {
  const out: ComplexImage = {
    width: freq.width,
    height: freq.height,
    re: freq.re.slice(),
    im: freq.im.slice(),
  };

  fft2d(out, true);
  return out;
}

function computePSR(corr: Float64Array, width: number, height: number, peakIndex: number): number {
  // PSR is defined as (peak - mean(sidelobe)) / std(sidelobe)
  // excluding a small neighborhood around the peak.
  const peakX = peakIndex % width;
  const peakY = Math.floor(peakIndex / width);

  const EXCLUDE_RADIUS = 5; // small local window around peak

  let sum = 0;
  let sumSq = 0;
  let count = 0;

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const dx = x - peakX;
      const dy = y - peakY;
      if (Math.abs(dx) <= EXCLUDE_RADIUS && Math.abs(dy) <= EXCLUDE_RADIUS) {
        continue;
      }

      const v = corr[y * width + x];
      sum += v;
      sumSq += v * v;
      count++;
    }
  }

  if (count <= 1) return 0;

  const mean = sum / count;
  const variance = Math.max(0, sumSq / count - mean * mean);
  const std = Math.sqrt(variance);

  if (std < 1e-12) return 0;

  const peak = corr[peakIndex];
  return (peak - mean) / std;
}

/**
 * Phase correlation between two real images.
 *
 * Returns the translation (dx, dy) in pixels that best aligns imageB to imageA.
 * Convention:
 * - If dx is positive, imageB should be shifted RIGHT by dx to better match imageA.
 * - If dy is positive, imageB should be shifted DOWN by dy to better match imageA.
 */
export function phaseCorrelate(a: Float32Array, b: Float32Array, width: number, height: number): PhaseCorrelationResult {
  const eps = 1e-12;

  const fftA = fft2dFromReal(a, width, height);
  const fftB = fft2dFromReal(b, width, height);

  // Cross-power spectrum: R = F(A) * conj(F(B)) / |F(A) * conj(F(B))|
  const crossRe = new Float64Array(width * height);
  const crossIm = new Float64Array(width * height);

  for (let i = 0; i < crossRe.length; i++) {
    const aRe = fftA.re[i];
    const aIm = fftA.im[i];
    const bRe = fftB.re[i];
    const bIm = fftB.im[i];

    // a * conj(b)
    const re = aRe * bRe + aIm * bIm;
    const im = aIm * bRe - aRe * bIm;

    const mag = Math.sqrt(re * re + im * im) + eps;
    crossRe[i] = re / mag;
    crossIm[i] = im / mag;
  }

  const corr = ifft2dFromComplex({ width, height, re: crossRe, im: crossIm });

  // Find peak in real part.
  let peakIndex = 0;
  let peakValue = corr.re[0] ?? 0;
  for (let i = 1; i < corr.re.length; i++) {
    const v = corr.re[i];
    if (v > peakValue) {
      peakValue = v;
      peakIndex = i;
    }
  }

  let peakX = peakIndex % width;
  let peakY = Math.floor(peakIndex / width);

  // Convert wrap-around peak location to signed translation.
  if (peakX > width / 2) peakX -= width;
  if (peakY > height / 2) peakY -= height;

  const psr = computePSR(corr.re, width, height, peakIndex);

  return {
    dx: peakX,
    dy: peakY,
    peak: peakValue,
    psr,
  };
}

/**
 * Phase correlation using a precomputed FFT for the reference.
 *
 * This is a hot path during auto-alignment (called multiple times per date),
 * so we avoid recomputing the reference FFT.
 */
export function phaseCorrelateWithRefFFT(refFft: ComplexImage, target: Float32Array): PhaseCorrelationResult {
  const { width, height } = refFft;
  if (target.length !== width * height) {
    throw new Error('phaseCorrelateWithRefFFT: target size mismatch');
  }

  const eps = 1e-12;
  const fftB = fft2dFromReal(target, width, height);

  const crossRe = new Float64Array(width * height);
  const crossIm = new Float64Array(width * height);

  for (let i = 0; i < crossRe.length; i++) {
    const aRe = refFft.re[i];
    const aIm = refFft.im[i];
    const bRe = fftB.re[i];
    const bIm = fftB.im[i];

    // a * conj(b)
    const re = aRe * bRe + aIm * bIm;
    const im = aIm * bRe - aRe * bIm;

    const mag = Math.sqrt(re * re + im * im) + eps;
    crossRe[i] = re / mag;
    crossIm[i] = im / mag;
  }

  const corr = ifft2dFromComplex({ width, height, re: crossRe, im: crossIm });

  let peakIndex = 0;
  let peakValue = corr.re[0] ?? 0;
  for (let i = 1; i < corr.re.length; i++) {
    const v = corr.re[i];
    if (v > peakValue) {
      peakValue = v;
      peakIndex = i;
    }
  }

  let peakX = peakIndex % width;
  let peakY = Math.floor(peakIndex / width);

  if (peakX > width / 2) peakX -= width;
  if (peakY > height / 2) peakY -= height;

  const psr = computePSR(corr.re, width, height, peakIndex);

  return {
    dx: peakX,
    dy: peakY,
    peak: peakValue,
    psr,
  };
}

/**
 * Helper to clamp a shift to a limited range.
 * Useful when we want to avoid wild outliers in transform recovery.
 */
export function clampShift(value: number, maxAbs: number): number {
  return clamp(value, -Math.abs(maxAbs), Math.abs(maxAbs));
}
