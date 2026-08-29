import { createHash } from 'node:crypto';
import type { OutputPlaneGrid } from '../../src/utils/outputPlaneGrid';
import type { SvrReconstructionSlice } from '../../src/utils/svr/reconstructionCore';

export type NativeCorpusPlane = {
  positionMm: number;
  pixels: Float32Array;
  valid?: Uint8Array;
};
export type CorpusRegion = { left: number; top: number; width: number; height: number };

export function pixelFingerprint(data: ArrayBufferView): string {
  return createHash('sha256')
    .update(new Uint8Array(data.buffer, data.byteOffset, data.byteLength))
    .digest('hex');
}

/** Independent physical-coordinate oracle: no production sampling or learned features. */
export function interpolateCorpusBaseline(
  planes: readonly NativeCorpusPlane[],
  positionMm: number,
  method: 'linear' | 'cubic',
): NativeCorpusPlane {
  if (!Number.isFinite(positionMm) || planes.length < 2) throw new Error('Invalid interpolation fixture');
  for (let index = 1; index < planes.length; index++) {
    if (planes[index]!.positionMm <= planes[index - 1]!.positionMm)
      throw new Error('Baseline planes must have unique ordered physical centers');
  }
  const exact = planes.find((plane) => Math.abs(plane.positionMm - positionMm) < 1e-8);
  if (exact) return { positionMm, pixels: exact.pixels.slice(), valid: exact.valid?.slice() };
  const upper = planes.findIndex((plane) => plane.positionMm > positionMm);
  const first = method === 'linear' ? upper - 1 : upper - 2;
  const count = method === 'linear' ? 2 : 4;
  if (upper <= 0 || first < 0 || first + count > planes.length)
    throw new Error('Held-out plane lacks independent interpolation context');
  const neighbors = planes.slice(first, first + count);
  const size = neighbors[0]!.pixels.length;
  if (neighbors.some((plane) => plane.pixels.length !== size || (plane.valid && plane.valid.length !== size)))
    throw new Error('Baseline pixel and support dimensions disagree');
  const weights = neighbors.map((plane, index) =>
    neighbors.reduce(
      (weight, other, otherIndex) =>
        otherIndex === index
          ? weight
          : (weight * (positionMm - other.positionMm)) / (plane.positionMm - other.positionMm),
      1,
    ),
  );
  const pixels = new Float32Array(size);
  const valid = new Uint8Array(size);
  for (let index = 0; index < size; index++) {
    if (neighbors.some((plane) => (plane.valid && !plane.valid[index]) || !Number.isFinite(plane.pixels[index])))
      continue;
    pixels[index] = neighbors.reduce((value, plane, neighbor) => value + plane.pixels[index]! * weights[neighbor]!, 0);
    valid[index] = 1;
  }
  return { positionMm, pixels, valid };
}

/** One input-only intensity scale for metrics and every visual tile; never normalize predictions independently. */
export function retainedIntensityWindow(planes: readonly NativeCorpusPlane[]) {
  const samples: number[] = [];
  for (const plane of planes) {
    const stride = Math.max(1, Math.ceil(plane.pixels.length / 4096));
    for (let index = 0; index < plane.pixels.length; index += stride) {
      const value = plane.pixels[index]!;
      if (Number.isFinite(value) && (!plane.valid || plane.valid[index])) samples.push(value);
    }
  }
  samples.sort((first, second) => first - second);
  const lower = samples[Math.floor((samples.length - 1) * 0.01)] ?? NaN;
  const upper = samples[Math.floor((samples.length - 1) * 0.998)] ?? NaN;
  if (!Number.isFinite(lower) || !Number.isFinite(upper) || upper <= lower)
    throw new Error('Retained native context must contain finite MRI signal');
  return { lower, upper, range: upper - lower, center: (upper + lower) / 2, width: upper - lower };
}

/** Evaluation masks may inspect truth; neither masks nor truth are supplied to the predictor. */
export function compareHeldOutPixels(options: {
  prediction: Pick<NativeCorpusPlane, 'pixels' | 'valid'>;
  truth: Pick<NativeCorpusPlane, 'pixels' | 'valid'>;
  baselineSupport: Uint8Array;
  rows: number;
  columns: number;
  rowSpacingMm: number;
  columnSpacingMm: number;
  intensityRange: number;
  region?: CorpusRegion;
}) {
  const { prediction, truth, baselineSupport, rows, columns, rowSpacingMm, columnSpacingMm, intensityRange } = options;
  const region = options.region ?? { left: 0, top: 0, width: columns, height: rows };
  if (
    prediction.pixels.length !== rows * columns ||
    truth.pixels.length !== rows * columns ||
    baselineSupport.length !== rows * columns
  )
    throw new Error('Held-out metric dimensions disagree');
  let samples = 0,
    missing = 0,
    squared = 0,
    absolute = 0,
    maximum = 0;
  let gradientSamples = 0,
    gradientSquaredError = 0,
    truthGradientEnergy = 0,
    predictionGradientEnergy = 0;
  let edgeSamples = 0,
    edgeAbsolute = 0;
  const supported = (index: number) => Boolean(baselineSupport[index] && (!truth.valid || truth.valid[index]));
  const predicted = (index: number) =>
    (!prediction.valid || prediction.valid[index]) && Number.isFinite(prediction.pixels[index]);
  const edgeThreshold = (intensityRange * 0.025) / Math.min(rowSpacingMm, columnSpacingMm);
  for (let row = Math.max(1, region.top); row < Math.min(rows - 1, region.top + region.height); row++) {
    for (let column = Math.max(1, region.left); column < Math.min(columns - 1, region.left + region.width); column++) {
      const index = row * columns + column;
      if (!supported(index) || !Number.isFinite(truth.pixels[index])) continue;
      samples++;
      if (!predicted(index)) {
        missing++;
        continue;
      }
      const difference = prediction.pixels[index]! - truth.pixels[index]!;
      squared += difference * difference;
      absolute += Math.abs(difference);
      maximum = Math.max(maximum, Math.abs(difference));
      const neighbors = [index - 1, index + 1, index - columns, index + columns];
      if (
        !neighbors.every(
          (neighbor) => supported(neighbor) && predicted(neighbor) && Number.isFinite(truth.pixels[neighbor]),
        )
      )
        continue;
      const tx = (truth.pixels[index + 1]! - truth.pixels[index - 1]!) / (2 * columnSpacingMm);
      const ty = (truth.pixels[index + columns]! - truth.pixels[index - columns]!) / (2 * rowSpacingMm);
      const px = (prediction.pixels[index + 1]! - prediction.pixels[index - 1]!) / (2 * columnSpacingMm);
      const py = (prediction.pixels[index + columns]! - prediction.pixels[index - columns]!) / (2 * rowSpacingMm);
      gradientSamples++;
      gradientSquaredError += (px - tx) ** 2 + (py - ty) ** 2;
      truthGradientEnergy += tx * tx + ty * ty;
      predictionGradientEnergy += px * px + py * py;
      if (Math.hypot(tx, ty) >= edgeThreshold) {
        edgeSamples++;
        edgeAbsolute += Math.abs(difference);
      }
    }
  }
  if (samples === 0 || gradientSamples === 0 || truthGradientEnergy === 0)
    throw new Error('Held-out region contains too little supported nonconstant anatomy');
  // Missing support is reported, not silently removed to improve an error score.
  const measured = samples - missing;
  return {
    samples,
    missing,
    coverage: measured / samples,
    rmse: Math.sqrt(squared / Math.max(1, measured)),
    normalizedRmse: Math.sqrt(squared / Math.max(1, measured)) / intensityRange,
    meanAbsoluteError: absolute / Math.max(1, measured),
    maximumAbsoluteError: maximum,
    gradientSamples,
    gradientRelativeRmse: Math.sqrt(gradientSquaredError / truthGradientEnergy),
    sharpnessRatio: Math.sqrt(predictionGradientEnergy / truthGradientEnergy),
    edgeSamples,
    edgeMeanAbsoluteError: edgeSamples ? edgeAbsolute / edgeSamples : null,
  };
}

export function cropCorpusPixels(pixels: Float32Array, columns: number, region: CorpusRegion, invert = false) {
  const output = new Float32Array(region.width * region.height);
  for (let row = 0; row < region.height; row++)
    for (let column = 0; column < region.width; column++) {
      const value = pixels[(region.top + row) * columns + region.left + column]!;
      output[row * region.width + column] = invert ? -value : value;
    }
  return output;
}

export function interpolationOvershoot(prediction: NativeCorpusPlane, planes: readonly NativeCorpusPlane[]) {
  const upper = planes.findIndex((plane) => plane.positionMm > prediction.positionMm);
  const neighbors = planes.slice(upper - 2, upper + 2);
  if (neighbors.length !== 4) throw new Error('Overshoot comparison requires four context planes');
  let samples = 0,
    outsideNeighborRange = 0,
    maximumOvershoot = 0;
  for (let index = 0; index < prediction.pixels.length; index++) {
    if ((prediction.valid && !prediction.valid[index]) || neighbors.some((plane) => plane.valid && !plane.valid[index]))
      continue;
    const value = prediction.pixels[index]!;
    if (!Number.isFinite(value)) continue;
    const values = neighbors.map((plane) => plane.pixels[index]!);
    const outside = Math.max(0, Math.min(...values) - value, value - Math.max(...values));
    samples++;
    if (outside > 0.001) outsideNeighborRange++;
    maximumOvershoot = Math.max(maximumOvershoot, outside);
  }
  return { samples, outsideNeighborRange, fraction: outsideNeighborRange / Math.max(1, samples), maximumOvershoot };
}

/** Independent scalar/world-space oracle for an interior translated oblique plane, not acquired fractional truth. */
export function samplePhysicalCorpusPlane(options: {
  slices: readonly SvrReconstructionSlice[];
  grid: OutputPlaneGrid;
  translationMm: readonly [number, number, number];
  method: 'linear' | 'cubic' | 'bounded-cubic';
}) {
  const { slices, grid, translationMm, method } = options;
  const normal = slices[0]!.normalDir;
  const depths = slices.map((slice) => slice.ippMm.x * normal.x + slice.ippMm.y * normal.y + slice.ippMm.z * normal.z);
  const pixels = new Float32Array(grid.rows * grid.columns),
    valid = new Uint8Array(pixels.length);
  const bilinear = (slice: SvrReconstructionSlice, point: number[]) => {
    const dx = point[0]! - slice.ippMm.x,
      dy = point[1]! - slice.ippMm.y,
      dz = point[2]! - slice.ippMm.z;
    const rawX = (dx * slice.rowDir.x + dy * slice.rowDir.y + dz * slice.rowDir.z) / slice.colSpacingDsMm;
    const rawY = (dx * slice.colDir.x + dy * slice.colDir.y + dz * slice.colDir.z) / slice.rowSpacingDsMm;
    // DICOM decimal orientation/position roundoff must not drop a native boundary pixel.
    if (rawX < -1e-6 || rawY < -1e-6 || rawX > slice.dsCols - 1 + 1e-6 || rawY > slice.dsRows - 1 + 1e-6) return null;
    const x = Math.max(0, Math.min(slice.dsCols - 1, rawX));
    const y = Math.max(0, Math.min(slice.dsRows - 1, rawY));
    const left = Math.floor(x),
      top = Math.floor(y),
      fx = x - left,
      fy = y - top;
    let value = 0;
    for (const [column, row, weight] of [
      [left, top, (1 - fx) * (1 - fy)],
      [Math.min(left + 1, slice.dsCols - 1), top, fx * (1 - fy)],
      [left, Math.min(top + 1, slice.dsRows - 1), (1 - fx) * fy],
      [Math.min(left + 1, slice.dsCols - 1), Math.min(top + 1, slice.dsRows - 1), fx * fy],
    ]) {
      if (weight! <= Number.EPSILON) continue;
      const index = row! * slice.dsCols + column!;
      if ((slice.valid && !slice.valid[index]) || !Number.isFinite(slice.pixels[index])) return null;
      value += weight! * slice.pixels[index]!;
    }
    return value;
  };
  for (let row = 0; row < grid.rows; row++)
    for (let column = 0; column < grid.columns; column++) {
      const point = [0, 1, 2].map(
        (axis) =>
          grid.originMm[axis]! +
          grid.columnDirection[axis]! * row * grid.rowSpacingMm +
          grid.rowDirection[axis]! * column * grid.columnSpacingMm -
          translationMm[axis]!,
      );
      const depth = point[0]! * normal.x + point[1]! * normal.y + point[2]! * normal.z;
      const upper = depths.findIndex((value) => value > depth);
      const first = method === 'linear' ? upper - 1 : upper - 2;
      const count = method === 'linear' ? 2 : 4;
      if (first < 0 || first + count > slices.length) continue;
      const indices = Array.from({ length: count }, (_, index) => first + index);
      const values = indices.map((index) => bilinear(slices[index]!, point));
      if (values.some((value) => value === null)) continue;
      let value = 0;
      for (let tap = 0; tap < count; tap++) {
        let weight = 1;
        for (let other = 0; other < count; other++)
          if (other !== tap)
            weight *= (depth - depths[indices[other]!]!) / (depths[indices[tap]!]! - depths[indices[other]!]!);
        value += weight * values[tap]!;
      }
      pixels[row * grid.columns + column] =
        method === 'bounded-cubic'
          ? Math.max(Math.min(...(values as number[])), Math.min(Math.max(...(values as number[])), value))
          : value;
      valid[row * grid.columns + column] = 1;
    }
  return { pixels, valid };
}
