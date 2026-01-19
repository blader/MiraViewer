import { CONTROL_LIMITS } from './constants';
import { clamp, normalizeRotation } from './math';
import type { PanelSettings } from '../types/api';
import { clampShift, fft2dFromReal, phaseCorrelateWithRefFFT } from './phaseCorrelation';

export type GeometrySettings = Pick<PanelSettings, 'zoom' | 'rotation' | 'panX' | 'panY'>;

export type TransformRecoveryDebug = {
  rotationScale: {
    dxAngle: number;
    dyLogR: number;
    psr: number;
  };
  translation: {
    dx: number;
    dy: number;
    psr: number;
  };
  // Extra context for debugging ambiguous rotation (|F| log-polar is 180° ambiguous for real images)
  // and for understanding how priors/clamps affected the final output.
  candidates?: {
    baseRotationDeg: number;
    zoomFromRotScale: number;
    candidateA: { rotationDeg: number; translationPsr: number };
    candidateB: { rotationDeg: number; translationPsr: number };
    chosen: 'A' | 'B';
    priorRotation: number | null;
    priorZoom: number | null;
    clampedRotationToPrior: boolean;
    clampedZoomToPrior: boolean;
  };
};

export type RecoveredTransform = GeometrySettings & {
  /** Higher is better. Derived from phase correlation PSRs. */
  confidence: number;
  debug?: TransformRecoveryDebug;
};

export type TransformRecoveryOptions = {
  /** Use gradient magnitude preprocessing to reduce sensitivity to intensity changes. */
  useGradientMagnitude?: boolean;
  /** Apply a 2D Hann window to reduce edge artifacts for FFT-based methods. */
  useHannWindow?: boolean;
  /** Apply a circular (radial) mask to downweight corners/letterboxing. */
  useCircularMask?: boolean;

  /**
   * Frequency-domain bandpass used for log-polar magnitude matching.
   * Values are fractions of the maximum radius (0..0.5 roughly).
   */
  bandpass?: {
    minRadiusFraction: number;
    maxRadiusFraction: number;
  };

  /**
   * Clamp recovered translation to this fraction of image size.
   * Prevents wild outliers when correlation is ambiguous.
   */
  maxTranslationFraction?: number;
};

export type TransformReference = {
  size: number;
  options: Required<TransformRecoveryOptions>;

  // Reference preprocessing for translation correlation.
  refPreprocessed: Float32Array;
  refPreprocessedFFT: ReturnType<typeof fft2dFromReal>;

  // Reference log-polar (magnitude spectrum) preprocessing for rotation+scale.
  logPolarWidth: number;
  logPolarHeight: number;
  logRMin: number;
  logRMax: number;
  refLogPolar: Float32Array;
  refLogPolarFFT: ReturnType<typeof fft2dFromReal>;
};

const DEFAULT_OPTIONS: Required<TransformRecoveryOptions> = {
  useGradientMagnitude: true,
  useHannWindow: true,
  useCircularMask: true,
  bandpass: {
    minRadiusFraction: 0.08,
    maxRadiusFraction: 0.45,
  },
  maxTranslationFraction: 0.35,
};

function toRequiredOptions(opts?: TransformRecoveryOptions): Required<TransformRecoveryOptions> {
  return {
    useGradientMagnitude: opts?.useGradientMagnitude ?? DEFAULT_OPTIONS.useGradientMagnitude,
    useHannWindow: opts?.useHannWindow ?? DEFAULT_OPTIONS.useHannWindow,
    useCircularMask: opts?.useCircularMask ?? DEFAULT_OPTIONS.useCircularMask,
    bandpass: {
      minRadiusFraction: opts?.bandpass?.minRadiusFraction ?? DEFAULT_OPTIONS.bandpass.minRadiusFraction,
      maxRadiusFraction: opts?.bandpass?.maxRadiusFraction ?? DEFAULT_OPTIONS.bandpass.maxRadiusFraction,
    },
    maxTranslationFraction: opts?.maxTranslationFraction ?? DEFAULT_OPTIONS.maxTranslationFraction,
  };
}

function assertSquareImage(pixels: Float32Array, size: number) {
  if (pixels.length !== size * size) {
    throw new Error(`Expected ${size}x${size} image (got ${pixels.length} pixels)`);
  }
}

function applyHannWindow(image: Float32Array, size: number) {
  // 2D separable Hann: w(x,y) = wX(x) * wY(y)
  const w = new Float32Array(size);
  const denom = Math.max(1, size - 1);
  for (let i = 0; i < size; i++) {
    w[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / denom);
  }

  for (let y = 0; y < size; y++) {
    const wy = w[y];
    for (let x = 0; x < size; x++) {
      image[y * size + x] *= wy * w[x];
    }
  }
}

function applyCircularMask(image: Float32Array, size: number) {
  // Tukey-style soft radial mask to downweight edges/corners.
  //
  // Why: alignment runs on square buffers where the underlying DICOM image may be
  // letterboxed (black bars) and where FFT-based methods can be dominated by hard edges.
  // A soft circular mask reduces those boundary artifacts without throwing away most
  // of the useful central anatomy.
  const cx = (size - 1) / 2;
  const cy = (size - 1) / 2;
  const maxR = Math.min(cx, cy);

  // Keep full weight over most of the radius, then taper near the edge.
  const INNER_FRACTION = 0.8;
  const innerR = INNER_FRACTION * maxR;

  for (let y = 0; y < size; y++) {
    const dy = y - cy;
    for (let x = 0; x < size; x++) {
      const dx = x - cx;
      const r = Math.sqrt(dx * dx + dy * dy);

      let w = 0;
      if (r <= innerR) {
        w = 1;
      } else if (r < maxR) {
        const t = clamp((r - innerR) / Math.max(1e-6, maxR - innerR), 0, 1);
        // Raised cosine taper that goes to 0 at the edge.
        w = 0.5 * (1 + Math.cos(Math.PI * t));
      } else {
        w = 0;
      }

      image[y * size + x] *= w;
    }
  }
}

function sobelGradientMagnitude(input: Float32Array, size: number): Float32Array {
  // Simple Sobel magnitude. Edges only; reduces sensitivity to brightness/contrast differences.
  const out = new Float32Array(size * size);

  const idx = (x: number, y: number) => y * size + x;

  for (let y = 1; y < size - 1; y++) {
    for (let x = 1; x < size - 1; x++) {
      const tl = input[idx(x - 1, y - 1)];
      const tc = input[idx(x, y - 1)];
      const tr = input[idx(x + 1, y - 1)];
      const ml = input[idx(x - 1, y)];
      const mr = input[idx(x + 1, y)];
      const bl = input[idx(x - 1, y + 1)];
      const bc = input[idx(x, y + 1)];
      const br = input[idx(x + 1, y + 1)];

      const gx = -tl + tr - 2 * ml + 2 * mr - bl + br;
      const gy = -tl - 2 * tc - tr + bl + 2 * bc + br;

      out[idx(x, y)] = Math.sqrt(gx * gx + gy * gy);
    }
  }

  return out;
}

function zeroMeanInPlace(image: Float32Array) {
  let sum = 0;
  for (let i = 0; i < image.length; i++) sum += image[i];
  const mean = sum / Math.max(1, image.length);
  for (let i = 0; i < image.length; i++) image[i] -= mean;
}

function preprocessForCorrelation(pixels: Float32Array, size: number, options: Required<TransformRecoveryOptions>): Float32Array {
  assertSquareImage(pixels, size);

  let work = pixels;
  if (options.useGradientMagnitude) {
    work = sobelGradientMagnitude(work, size);
  } else {
    // Copy, since we will mutate below.
    work = new Float32Array(work);
  }

  if (options.useHannWindow) {
    applyHannWindow(work, size);
  }

  if (options.useCircularMask) {
    applyCircularMask(work, size);
  }

  // Remove DC component (important for FFT-based correlation).
  zeroMeanInPlace(work);

  return work;
}

function bilinearSample(image: Float32Array, width: number, height: number, x: number, y: number): number {
  if (x < 0 || y < 0 || x > width - 1 || y > height - 1) return 0;

  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const x1 = Math.min(width - 1, x0 + 1);
  const y1 = Math.min(height - 1, y0 + 1);

  const tx = x - x0;
  const ty = y - y0;

  const i00 = image[y0 * width + x0];
  const i10 = image[y0 * width + x1];
  const i01 = image[y1 * width + x0];
  const i11 = image[y1 * width + x1];

  const a = i00 * (1 - tx) + i10 * tx;
  const b = i01 * (1 - tx) + i11 * tx;
  return a * (1 - ty) + b * ty;
}

export function warpGrayscale(
  input: Float32Array,
  size: number,
  transform: { zoom: number; rotationDeg: number; translateX: number; translateY: number }
): Float32Array {
  assertSquareImage(input, size);

  const out = new Float32Array(size * size);

  const cx = (size - 1) / 2;
  const cy = (size - 1) / 2;

  const theta = (transform.rotationDeg * Math.PI) / 180;
  const cosT = Math.cos(theta);
  const sinT = Math.sin(theta);

  // Inverse mapping: output -> input.
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      // Coordinates relative to center.
      let dx = x - cx;
      let dy = y - cy;

      // Undo translation (translation is applied last in display space).
      dx -= transform.translateX;
      dy -= transform.translateY;

      // Undo rotation.
      const rx = cosT * dx + sinT * dy;
      const ry = -sinT * dx + cosT * dy;

      // Undo scale.
      const sx = rx / transform.zoom;
      const sy = ry / transform.zoom;

      const u = sx + cx;
      const v = sy + cy;

      out[y * size + x] = bilinearSample(input, size, size, u, v);
    }
  }

  return out;
}

function fftShiftMagnitudeToCenter(logMag: Float32Array, size: number): Float32Array {
  const out = new Float32Array(size * size);
  const half = size >> 1;

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const sx = (x + half) & (size - 1);
      const sy = (y + half) & (size - 1);
      out[sy * size + sx] = logMag[y * size + x];
    }
  }

  return out;
}

function computeLogMagnitudeSpectrum(preprocessed: Float32Array, size: number): Float32Array {
  const fft = fft2dFromReal(preprocessed, size, size);

  const mag = new Float32Array(size * size);
  for (let i = 0; i < mag.length; i++) {
    const re = fft.re[i];
    const im = fft.im[i];
    const m = Math.sqrt(re * re + im * im);
    mag[i] = Math.log1p(m);
  }

  return fftShiftMagnitudeToCenter(mag, size);
}

function applyRadialBandpassInPlace(spectrum: Float32Array, size: number, minR: number, maxR: number) {
  const cx = size / 2;
  const cy = size / 2;

  for (let y = 0; y < size; y++) {
    const dy = y - cy;
    for (let x = 0; x < size; x++) {
      const dx = x - cx;
      const r = Math.sqrt(dx * dx + dy * dy);
      if (r < minR || r > maxR) {
        spectrum[y * size + x] = 0;
      }
    }
  }
}

function toLogPolar(
  spectrumCentered: Float32Array,
  size: number,
  logPolarWidth: number,
  logPolarHeight: number,
  rMin: number,
  rMax: number
): { logPolar: Float32Array; logRMin: number; logRMax: number } {
  const out = new Float32Array(logPolarWidth * logPolarHeight);

  const cx = size / 2;
  const cy = size / 2;

  const safeRMin = Math.max(1, rMin);
  const safeRMax = Math.max(safeRMin + 1e-6, rMax);

  const logRMin = Math.log(safeRMin);
  const logRMax = Math.log(safeRMax);

  for (let ri = 0; ri < logPolarHeight; ri++) {
    const tR = logPolarHeight === 1 ? 0 : ri / (logPolarHeight - 1);
    const logR = logRMin + tR * (logRMax - logRMin);
    const r = Math.exp(logR);

    for (let ai = 0; ai < logPolarWidth; ai++) {
      const theta = (ai / logPolarWidth) * 2 * Math.PI;

      // Note: image y-axis is down, so sin(theta) maps to +down.
      const x = cx + r * Math.cos(theta);
      const y = cy + r * Math.sin(theta);

      out[ri * logPolarWidth + ai] = bilinearSample(spectrumCentered, size, size, x, y);
    }
  }

  return { logPolar: out, logRMin, logRMax };
}

function preprocessLogPolarInPlace(logPolar: Float32Array, width: number, height: number) {
  // Log-polar arrays are just images; apply mean removal + Hann window.
  zeroMeanInPlace(logPolar);

  // 2D Hann.
  const wX = new Float32Array(width);
  const wY = new Float32Array(height);

  const denomX = Math.max(1, width - 1);
  const denomY = Math.max(1, height - 1);

  for (let x = 0; x < width; x++) {
    wX[x] = 0.5 - 0.5 * Math.cos((2 * Math.PI * x) / denomX);
  }
  for (let y = 0; y < height; y++) {
    wY[y] = 0.5 - 0.5 * Math.cos((2 * Math.PI * y) / denomY);
  }

  for (let y = 0; y < height; y++) {
    const wy = wY[y];
    for (let x = 0; x < width; x++) {
      logPolar[y * width + x] *= wy * wX[x];
    }
  }
}

export function prepareTransformReference(
  referencePixels: Float32Array,
  size: number,
  opts?: TransformRecoveryOptions
): TransformReference {
  const options = toRequiredOptions(opts);
  assertSquareImage(referencePixels, size);

  const refPreprocessed = preprocessForCorrelation(referencePixels, size, options);
  const refPreprocessedFFT = fft2dFromReal(refPreprocessed, size, size);

  const spectrum = computeLogMagnitudeSpectrum(refPreprocessed, size);

  const maxR = size / 2;
  const minR = clamp(options.bandpass.minRadiusFraction, 0, 0.49) * maxR;
  const maxRb = clamp(options.bandpass.maxRadiusFraction, 0, 0.49) * maxR;
  applyRadialBandpassInPlace(spectrum, size, minR, maxRb);

  // Use power-of-two dimensions for log-polar so FFTs stay fast.
  const logPolarWidth = size;
  const logPolarHeight = size;

  const { logPolar: refLogPolar, logRMin, logRMax } = toLogPolar(spectrum, size, logPolarWidth, logPolarHeight, minR, maxRb);
  preprocessLogPolarInPlace(refLogPolar, logPolarWidth, logPolarHeight);

  const refLogPolarFFT = fft2dFromReal(refLogPolar, logPolarWidth, logPolarHeight);

  return {
    size,
    options,
    refPreprocessed,
    refPreprocessedFFT,
    logPolarWidth,
    logPolarHeight,
    logRMin,
    logRMax,
    refLogPolar,
    refLogPolarFFT,
  };
}

function recoverRotationScale(
  ref: TransformReference,
  targetPreprocessed: Float32Array
): { rotationDeg: number; zoom: number; debug: TransformRecoveryDebug['rotationScale'] } {
  const { size, logPolarWidth, logPolarHeight, logRMin, logRMax } = ref;

  const spectrum = computeLogMagnitudeSpectrum(targetPreprocessed, size);

  const maxR = size / 2;
  const minR = clamp(ref.options.bandpass.minRadiusFraction, 0, 0.49) * maxR;
  const maxRb = clamp(ref.options.bandpass.maxRadiusFraction, 0, 0.49) * maxR;
  applyRadialBandpassInPlace(spectrum, size, minR, maxRb);

  const { logPolar } = toLogPolar(spectrum, size, logPolarWidth, logPolarHeight, minR, maxRb);
  preprocessLogPolarInPlace(logPolar, logPolarWidth, logPolarHeight);

  const rotScaleCorr = phaseCorrelateWithRefFFT(ref.refLogPolarFFT, logPolar);

  // Phase correlation returns shift that aligns target -> ref in log-polar.
  // Angle shift maps to rotation.
  //
  // Note: our log-polar uses image coordinates (y down), so the sign convention ends up
  // matching the returned shift direction (no additional negation).
  const rotationDeg = rotScaleCorr.dx * (360 / logPolarWidth);

  // Radial shift maps to scaling in frequency; spatial scaling is inverse.
  const dLogR = (logRMax - logRMin) * (rotScaleCorr.dy / Math.max(1, logPolarHeight - 1));
  const scaleFreq = Math.exp(dLogR);
  const zoom = 1 / scaleFreq;

  return {
    rotationDeg: normalizeRotation(rotationDeg),
    zoom,
    debug: {
      dxAngle: rotScaleCorr.dx,
      dyLogR: rotScaleCorr.dy,
      psr: rotScaleCorr.psr,
    },
  };
}

function recoverTranslation(
  ref: TransformReference,
  targetPreprocessed: Float32Array,
  rotationDeg: number,
  zoom: number
): { dx: number; dy: number; debug: TransformRecoveryDebug['translation'] } {
  const { size } = ref;

  // Apply rotation+scale first, then translation is estimated in display-space pixels.
  const rotatedScaled = warpGrayscale(targetPreprocessed, size, {
    zoom,
    rotationDeg,
    translateX: 0,
    translateY: 0,
  });

  const translationCorr = phaseCorrelateWithRefFFT(ref.refPreprocessedFFT, rotatedScaled);

  // Clamp wild outliers. For our UI, pan is meant to be a "small adjustment".
  const maxShiftPx = ref.options.maxTranslationFraction * size;
  const dx = clampShift(translationCorr.dx, maxShiftPx);
  const dy = clampShift(translationCorr.dy, maxShiftPx);

  return {
    dx,
    dy,
    debug: {
      dx,
      dy,
      psr: translationCorr.psr,
    },
  };
}

function angularDistanceDeg(a: number, b: number): number {
  return Math.abs(normalizeRotation(a - b));
}

export function recoverSimilarityTransform(
  ref: TransformReference,
  targetPixels: Float32Array,
  opts?: { includeDebug?: boolean; prior?: Partial<GeometrySettings> }
): RecoveredTransform {
  const { size, options } = ref;
  assertSquareImage(targetPixels, size);

  const targetPre = preprocessForCorrelation(targetPixels, size, options);

  // Rotation/scale from log-polar phase correlation uses magnitude spectra, which is inherently
  // ambiguous up to 180° for real-valued images (|F(u,v)| is centro-symmetric).
  //
  // Disambiguation strategy:
  // - Compute candidate rotations separated by 180°.
  // - Choose the candidate that yields the best translation phase-correlation PSR after warping.
  // - If still ambiguous, prefer the candidate closer to the provided prior rotation.
  const { rotationDeg: baseRotationDeg, zoom, debug: rotScaleDebug } = recoverRotationScale(ref, targetPre);

  const candidateA = normalizeRotation(baseRotationDeg);
  const candidateB = normalizeRotation(baseRotationDeg + 180);

  const trA = recoverTranslation(ref, targetPre, candidateA, zoom);
  const trB = recoverTranslation(ref, targetPre, candidateB, zoom);

  // Choose between the 180°-ambiguous candidates.
  // If we have a prior (typical in our app: reference settings are already a good guess),
  // we heavily prefer the candidate closer to the prior and only override if correlation
  // evidence is dramatically better.

  const priorRot = typeof opts?.prior?.rotation === 'number' ? opts.prior.rotation : null;

  let chosenRotation = candidateA;
  let chosenTranslation = trA;
  let chosenCandidate: 'A' | 'B' = 'A';

  let clampedRotationToPrior = false;
  let clampedZoomToPrior = false;

  if (priorRot !== null) {
    const dA = angularDistanceDeg(candidateA, priorRot);
    const dB = angularDistanceDeg(candidateB, priorRot);

    // Prefer whichever is closer to the prior.
    const preferred = dA <= dB ? { rot: candidateA, tr: trA, dist: dA } : { rot: candidateB, tr: trB, dist: dB };
    const other = dA <= dB ? { rot: candidateB, tr: trB, dist: dB } : { rot: candidateA, tr: trA, dist: dA };

    // Only override if the other candidate is *much* better.
    const PSR_OVERRIDE_DELTA = 5;

    if (other.tr.debug.psr - preferred.tr.debug.psr > PSR_OVERRIDE_DELTA) {
      chosenRotation = other.rot;
      chosenTranslation = other.tr;
      chosenCandidate = other.rot === candidateA ? 'A' : 'B';
    } else {
      chosenRotation = preferred.rot;
      chosenTranslation = preferred.tr;
      chosenCandidate = preferred.rot === candidateA ? 'A' : 'B';
    }

    // Final guardrail: if we're still far from the prior, clamp to the prior.
    // This protects against low-confidence rotation estimates producing wild UI results.
    const MAX_ROTATION_FROM_PRIOR_DEG = 45;
    if (angularDistanceDeg(chosenRotation, priorRot) > MAX_ROTATION_FROM_PRIOR_DEG) {
      clampedRotationToPrior = true;
      chosenRotation = normalizeRotation(priorRot);

      // Recompute translation at the clamped rotation.
      chosenTranslation = recoverTranslation(ref, targetPre, chosenRotation, zoom);
    }
  } else {
    // No prior: fall back to translation PSR.
    const psrDelta = trB.debug.psr - trA.debug.psr;
    if (psrDelta > 0.5) {
      chosenRotation = candidateB;
      chosenTranslation = trB;
      chosenCandidate = 'B';
    } else {
      chosenRotation = candidateA;
      chosenTranslation = trA;
      chosenCandidate = 'A';
    }
  }

  // If we have a zoom prior, clamp extreme scale outliers.
  const priorZoom = typeof opts?.prior?.zoom === 'number' ? opts.prior.zoom : null;
  let chosenZoom = zoom;
  if (priorZoom !== null) {
    const ratio = priorZoom > 1e-12 ? chosenZoom / priorZoom : 1;
    const MAX_ZOOM_RATIO = 2;
    if (!Number.isFinite(ratio) || ratio > MAX_ZOOM_RATIO || ratio < 1 / MAX_ZOOM_RATIO) {
      clampedZoomToPrior = true;
      chosenZoom = priorZoom;
      // Translation depends on zoom; recompute.
      chosenTranslation = recoverTranslation(ref, targetPre, chosenRotation, chosenZoom);
    }
  }

  const dx = chosenTranslation.dx;
  const dy = chosenTranslation.dy;

  // Convert pixel translation to normalized pan.
  const panX = dx / size;
  const panY = dy / size;

  // Clamp to our viewer UI limits.
  const clampedZoom = clamp(chosenZoom, CONTROL_LIMITS.ZOOM.MIN, CONTROL_LIMITS.ZOOM.MAX);

  // Confidence heuristic: PSR values are unbounded; squash into [0,1].
  const rsScore = clamp(rotScaleDebug.psr / 20, 0, 1);
  const tScore = clamp(chosenTranslation.debug.psr / 20, 0, 1);
  const confidence = 0.5 * rsScore + 0.5 * tScore;

  return {
    zoom: clampedZoom,
    rotation: chosenRotation,
    panX,
    panY,
    confidence,
    debug: opts?.includeDebug
      ? {
          rotationScale: rotScaleDebug,
          translation: {
            dx,
            dy,
            psr: chosenTranslation.debug.psr,
          },
          candidates: {
            baseRotationDeg: baseRotationDeg,
            zoomFromRotScale: zoom,
            candidateA: { rotationDeg: candidateA, translationPsr: trA.debug.psr },
            candidateB: { rotationDeg: candidateB, translationPsr: trB.debug.psr },
            chosen: chosenCandidate,
            priorRotation: priorRot,
            priorZoom: priorZoom,
            clampedRotationToPrior,
            clampedZoomToPrior,
          },
        }
      : undefined,
  };
}
