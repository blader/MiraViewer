/** Normalize modality-linear pixels directly, without screenshot or display-state dependence. */
export function normalizeModalityPixelsToGrayscale(pixels: Float32Array): Uint8Array {
  const output = new Uint8Array(pixels.length);
  let min = Infinity;
  let max = -Infinity;
  let finiteCount = 0;

  for (let index = 0; index < pixels.length; index++) {
    const value = pixels[index]!;
    if (!Number.isFinite(value)) continue;
    min = Math.min(min, value);
    max = Math.max(max, value);
    finiteCount++;
  }

  if (finiteCount === 0 || !(max > min)) return output;

  const bins = 4096;
  const histogram = new Uint32Array(bins);
  const scale = (bins - 1) / (max - min);
  for (let index = 0; index < pixels.length; index++) {
    const value = pixels[index]!;
    if (!Number.isFinite(value)) continue;
    const bin = Math.round((value - min) * scale);
    histogram[bin] = histogram[bin]! + 1;
  }

  const lowRank = Math.floor(finiteCount * 0.01);
  const highRank = Math.ceil(finiteCount * 0.99);
  let seen = 0;
  let lowBin = 0;
  let highBin = bins - 1;
  let foundLow = false;
  for (let bin = 0; bin < bins; bin++) {
    seen += histogram[bin]!;
    if (!foundLow && seen > lowRank) {
      lowBin = bin;
      foundLow = true;
    }
    if (seen >= highRank) {
      highBin = bin;
      break;
    }
  }

  const low = min + lowBin / scale;
  const high = min + highBin / scale;
  const range = high > low ? high - low : max - min;
  for (let index = 0; index < pixels.length; index++) {
    const value = pixels[index]!;
    if (!Number.isFinite(value)) continue;
    output[index] = Math.max(0, Math.min(255, Math.round(((value - low) / range) * 255)));
  }

  return output;
}
