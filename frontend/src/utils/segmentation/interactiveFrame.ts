// Deterministic model-only preprocessing, independent of display settings and DOM/canvas.
// EfficientTAM uses Pillow 11.3.0 RGB BICUBIC, then Float32 ImageNet normalization.
// Resampling contract: https://github.com/python-pillow/Pillow/blob/11.3.0/src/libImaging/Resample.c
const COEFFICIENT_UNIT = 2 ** 22;
const MODEL_SIZE = 512;
const MEAN = [0.485, 0.456, 0.406].map(Math.fround);
const STD = [0.229, 0.224, 0.225].map(Math.fround);

export type TrackingSourceRange = readonly [number, number];

function cubic(distance: number): number {
  const x = Math.abs(distance);
  if (x < 1) return (1.5 * x - 2.5) * x * x + 1;
  return x < 2 ? (((x - 5) * x + 8) * x - 4) * -0.5 : 0;
}

function coefficients(inputLength: number, outputLength: number) {
  const step = inputLength / outputLength;
  const filterScale = Math.max(1, step);
  const support = filterScale * 2;
  const taps = Math.ceil(support) * 2 + 1;
  const starts = new Uint32Array(outputLength);
  const counts = new Uint32Array(outputLength);
  const weights = new Int32Array(outputLength * taps);
  const scratch = new Float64Array(taps);
  for (let output = 0; output < outputLength; output++) {
    const center = (output + 0.5) * step;
    const start = Math.max(0, Math.trunc(center - support + 0.5));
    const stop = Math.min(inputLength, Math.trunc(center + support + 0.5));
    let total = 0;
    for (let i = start; i < stop; i++) {
      const weight = cubic((i - center + 0.5) * (1 / filterScale));
      scratch[i - start] = weight;
      total += weight;
    }
    starts[output] = start;
    counts[output] = stop - start;
    for (let tap = 0; tap < stop - start; tap++) {
      const weight = scratch[tap] / total;
      weights[output * taps + tap] = Math.trunc(weight * COEFFICIENT_UNIT + (weight < 0 ? -0.5 : 0.5));
    }
  }
  return { starts, counts, weights, taps };
}

function validateGrid(data: Uint8Array | Float32Array, width: number, height: number): void {
  if (
    !Number.isSafeInteger(width) ||
    !Number.isSafeInteger(height) ||
    width < 1 ||
    height < 1 ||
    !Number.isSafeInteger(width * height) ||
    data.length !== width * height
  ) {
    throw new Error('A model frame must match its complete source grid.');
  }
}

/** RGB replication commutes with this independent per-channel separable filter. */
export function resizeTrackingGray(
  gray: Uint8Array,
  width: number,
  height: number,
  outputWidth = MODEL_SIZE,
  outputHeight = MODEL_SIZE,
): Uint8Array {
  validateGrid(gray, width, height);
  if (
    !Number.isSafeInteger(outputWidth) ||
    !Number.isSafeInteger(outputHeight) ||
    outputWidth < 1 ||
    outputHeight < 1 ||
    !Number.isSafeInteger(outputWidth * outputHeight)
  ) {
    throw new Error('The model image size must be a positive integer grid.');
  }
  let horizontal = gray;
  if (width !== outputWidth) {
    const filter = coefficients(width, outputWidth);
    horizontal = new Uint8Array(outputWidth * height);
    for (let y = 0; y < height; y++)
      for (let x = 0; x < outputWidth; x++) {
        let sum = COEFFICIENT_UNIT / 2;
        for (let tap = 0; tap < filter.counts[x]; tap++) {
          sum += gray[y * width + filter.starts[x] + tap] * filter.weights[x * filter.taps + tap];
        }
        horizontal[y * outputWidth + x] = Math.min(255, Math.max(0, Math.floor(sum / COEFFICIENT_UNIT)));
      }
  }
  if (height === outputHeight) return horizontal;
  const filter = coefficients(height, outputHeight);
  const result = new Uint8Array(outputWidth * outputHeight);
  for (let y = 0; y < outputHeight; y++)
    for (let x = 0; x < outputWidth; x++) {
      let sum = COEFFICIENT_UNIT / 2;
      for (let tap = 0; tap < filter.counts[y]; tap++) {
        sum += horizontal[(filter.starts[y] + tap) * outputWidth + x] * filter.weights[y * filter.taps + tap];
      }
      result[y * outputWidth + x] = Math.min(255, Math.max(0, Math.floor(sum / COEFFICIENT_UNIT)));
    }
  return result;
}

/** The caller supplies one immutable, source-bound range, never a per-frame ROI/display window. */
export function prepareTrackingFrame(
  pixels: Float32Array,
  width: number,
  height: number,
  sourceRange: TrackingSourceRange,
): Float32Array {
  validateGrid(pixels, width, height);
  const [minimum, maximum] = sourceRange;
  if (
    !Number.isFinite(minimum) ||
    !Number.isFinite(maximum) ||
    maximum <= minimum ||
    !Number.isFinite(maximum - minimum)
  ) {
    throw new Error('Model normalization requires a finite, nonempty source range.');
  }
  const quantized = new Uint8Array(pixels.length);
  for (let i = 0; i < pixels.length; i++) {
    if (!Number.isFinite(pixels[i])) throw new Error('Model input contains unavailable or nonfinite source values.');
    quantized[i] = Math.floor(Math.max(0, Math.min(1, (pixels[i] - minimum) / (maximum - minimum))) * 255);
  }
  const gray = resizeTrackingGray(quantized, width, height);
  const result = new Float32Array(3 * MODEL_SIZE * MODEL_SIZE);
  for (let channel = 0; channel < 3; channel++) {
    const table = new Float32Array(256);
    for (let i = 0; i < table.length; i++) {
      table[i] = Math.fround(Math.fround(Math.fround(i / 255) - MEAN[channel]) / STD[channel]);
    }
    for (let i = 0; i < gray.length; i++) result[channel * gray.length + i] = table[gray[i]];
  }
  return result;
}
