import { yieldToMain } from './svr/svrUtils';

export type SharpSlicePlane = { positionMm: number; pixels: Float32Array; valid?: Uint8Array };
export type SharpSliceStack = { rows: number; columns: number; slices: readonly SharpSlicePlane[] };
export type SharpSliceProgress = { current: number; total: number };
type Options = { signal?: AbortSignal; onProgress?: (progress: SharpSliceProgress) => void };
type FourPlanes = readonly [SharpSlicePlane, SharpSlicePlane, SharpSlicePlane, SharpSlicePlane];
const EPSILON = 1e-6;

function check(signal?: AbortSignal): void {
  if (signal?.aborted) throw new DOMException('Sharp slice synthesis cancelled.', 'AbortError');
}

function prepare(stack: SharpSliceStack) {
  const count = stack.rows * stack.columns;
  if (
    !Number.isSafeInteger(stack.rows) ||
    !Number.isSafeInteger(stack.columns) ||
    stack.rows < 1 ||
    stack.columns < 1 ||
    !Number.isSafeInteger(count) ||
    !stack.slices.length
  )
    throw new Error('Sharp synthesis requires a nonempty native image stack.');
  const slices = [...stack.slices].sort((a, b) => a.positionMm - b.positionMm);
  const gaps: number[] = [];
  for (let index = 0; index < slices.length; index++) {
    const slice = slices[index]!;
    if (
      !Number.isFinite(slice.positionMm) ||
      slice.pixels.length !== count ||
      (slice.valid && slice.valid.length !== count)
    )
      throw new Error('Sharp synthesis source dimensions, support or physical positions do not match.');
    if (index) {
      const gap = slice.positionMm - slices[index - 1]!.positionMm;
      if (gap <= EPSILON) throw new Error('Sharp synthesis requires distinct ordered native planes.');
      gaps.push(gap);
    }
  }
  gaps.sort((a, b) => a - b);
  return { ...stack, slices, spacingMm: gaps.length ? gaps[Math.floor(gaps.length / 2)]! : 1 };
}

function sample(plane: SharpSlicePlane, index: number): number | null {
  const value = plane.pixels[index];
  return (plane.valid && !plane.valid[index]) || value === undefined || !Number.isFinite(value) ? null : value;
}

/** Four distinct physical source positions; shared by native-world and standalone plane sampling. */
export function cubicInterpolationWeights(positions: readonly number[], positionMm: number): number[] {
  if (positions.length !== 4 || !Number.isFinite(positionMm) || positions.some((value) => !Number.isFinite(value)))
    throw new Error('Cubic reconstruction requires four finite physical source positions.');
  return positions.map((position, index) => {
    let weight = 1;
    for (let other = 0; other < 4; other++) {
      if (other === index) continue;
      const separation = position - positions[other]!;
      if (separation === 0) throw new Error('Cubic reconstruction requires distinct source positions.');
      weight *= (positionMm - positions[other]!) / separation;
    }
    return weight;
  });
}

/** Clamp only to acquired neighborhood intensities; keep Float64 precision until the final image-buffer write. */
export function boundedCubicValue(values: readonly number[], weights: readonly number[]): number {
  if (values.length !== 4 || weights.length !== 4)
    throw new Error('Cubic reconstruction requires four source values and weights.');
  let result = 0,
    min = Infinity,
    max = -Infinity;
  for (let plane = 0; plane < 4; plane++) {
    const value = values[plane]!;
    if (!Number.isFinite(value) || !Number.isFinite(weights[plane]))
      throw new Error('Cubic reconstruction requires finite source values and weights.');
    result += weights[plane]! * value;
    min = Math.min(min, value);
    max = Math.max(max, value);
  }
  // Four-plane physical cubic with a source-range limiter: do not create ringing outside the observed neighborhood.
  return Math.max(min, Math.min(max, result));
}

function cubicSample(planes: FourPlanes, index: number, weights: readonly number[], values: number[]): number | null {
  for (let plane = 0; plane < 4; plane++) {
    const value = sample(planes[plane]!, index);
    if (value === null) return null;
    values[plane] = value;
  }
  return boundedCubicValue(values, weights);
}

/** Render-only reconstruction from adjacent native planes; original samples and acquired support stay authoritative. */
export async function synthesizeSharpSlice(
  stack: SharpSliceStack,
  positionMm: number,
  options: Options = {},
): Promise<{
  pixels: Float32Array;
  valid: Uint8Array;
  stats: { exactSource: boolean; linearPixels: number; cubicPixels: number };
}> {
  check(options.signal);
  const source = prepare(stack);
  if (!Number.isFinite(positionMm)) throw new Error('Sharp synthesis requires a finite physical depth.');
  const count = source.rows * source.columns;
  const pixels = new Float32Array(count),
    valid = new Uint8Array(count);
  const exact = source.slices.find((plane) => Math.abs(plane.positionMm - positionMm) <= EPSILON);
  const stats = { exactSource: Boolean(exact), linearPixels: 0, cubicPixels: 0 };
  const upper = source.slices.findIndex((plane) => plane.positionMm > positionMm);
  const low = source.slices[upper - 1],
    high = source.slices[upper];
  if (!exact && (!low || !high || high.positionMm - low.positionMm > source.spacingMm * 1.5 + EPSILON))
    return { pixels, valid, stats };
  const fraction = exact ? 0 : (positionMm - low!.positionMm) / (high!.positionMm - low!.positionMm);
  const surrounding =
    upper > 1 && upper + 1 < source.slices.length
      ? (source.slices.slice(upper - 2, upper + 2) as unknown as FourPlanes)
      : null;
  const planes =
    surrounding &&
    surrounding
      .slice(1)
      .every((plane, index) => plane.positionMm - surrounding[index]!.positionMm <= source.spacingMm * 1.5 + EPSILON)
      ? surrounding
      : null;
  const weights = planes
    ? cubicInterpolationWeights(
        planes.map((plane) => plane.positionMm),
        positionMm,
      )
    : null;
  const values = [0, 0, 0, 0];
  let lastYield = performance.now();
  const checkpoint = async (current: number, force = false) => {
    check(options.signal);
    if (!force && performance.now() - lastYield < 8) return;
    options.onProgress?.({ current, total: source.rows });
    await yieldToMain();
    check(options.signal);
    lastYield = performance.now();
  };
  for (let y = 0; y < source.rows; y++) {
    for (let x = 0; x < source.columns; x++) {
      const index = y * source.columns + x;
      if (exact) {
        const value = sample(exact, index);
        if (value !== null) {
          pixels[index] = value;
          valid[index] = 1;
        }
        continue;
      }
      const a = sample(low!, index),
        b = sample(high!, index);
      if (a === null || b === null) continue;
      let value = a * (1 - fraction) + b * fraction;
      const cubic = planes && weights ? cubicSample(planes, index, weights, values) : null;
      if (cubic !== null) value = cubic;
      if (!Number.isFinite(value) || Math.abs(value) > 3.4028234663852886e38) continue;
      pixels[index] = value;
      valid[index] = 1;
      if (cubic !== null) stats.cubicPixels++;
      else stats.linearPixels++;
    }
    if (y % 8 === 0) await checkpoint(y);
  }
  await checkpoint(source.rows, true);
  return { pixels, valid, stats };
}
