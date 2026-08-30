import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  boundedCubicValue,
  cubicInterpolationWeights,
  synthesizeSharpSlice,
  type SharpSliceStack,
} from '../src/utils/sharpSliceSynthesis';

function stack(
  value: (x: number, y: number, z: number) => number,
  positions = Array.from({ length: 12 }, (_, index) => index),
  rows = 20,
  columns = 20,
): SharpSliceStack {
  return {
    rows,
    columns,
    slices: positions.map((positionMm) => ({
      positionMm,
      pixels: Float32Array.from({ length: rows * columns }, (_, i) =>
        value(i % columns, Math.floor(i / columns), positionMm),
      ),
      valid: new Uint8Array(rows * columns).fill(1),
    })),
  };
}

const texture = (x: number, y: number, z: number) =>
  80 + 15 * Math.sin(0.31 * x + 0.17 * y + 0.6 * z) + 18 * Math.tanh((x - 8 - 0.7 * z + 3 * Math.sin(0.2 * y)) / 1.4);
const polynomial = (z: number) => 100 + 2 * z + 3 * z * z + z * z * z;

afterEach(() => vi.unstubAllGlobals());

describe('bounded four-plane sharp between-slice reconstruction', () => {
  it('shares the same bounded kernel without rounding intermediate world samples to Float32', () => {
    const weights = cubicInterpolationWeights([0, 1, 2, 3], 1.1);
    const value = boundedCubicValue([0, 1, 8, 27], weights);
    expect(value).toBeCloseTo(1.331, 13);
    expect(value).not.toBe(Math.fround(value));
    expect(boundedCubicValue([0, 0, 0, 255], cubicInterpolationWeights([0, 1, 2, 3], 1.5))).toBe(0);
    expect(() => cubicInterpolationWeights([0, 1, 1, 3], 1.5)).toThrow(/distinct/);
    expect(() => cubicInterpolationWeights([0, 1, NaN, 3], 1.5)).toThrow(/finite/);
    expect(() => boundedCubicValue([0, 1, Infinity, 3], weights)).toThrow(/finite/);
  });

  it.each([2.25, 3.5, 4.75])('matches an independent cubic-polynomial oracle at physical depth %s', async (depth) => {
    const source = stack((x, y, z) => polynomial(z) + 2 * x + 3 * y);
    const result = await synthesizeSharpSlice(source, depth);
    for (let index = 0; index < result.pixels.length; index++)
      expect(result.pixels[index]).toBe(
        Math.fround(polynomial(depth) + 2 * (index % source.columns) + 3 * Math.floor(index / source.columns)),
      );
    expect(result.stats.cubicPixels).toBe(source.rows * source.columns);
    expect(result.valid.every((value) => value === 1)).toBe(true);
  });

  it('uses physical positions for arbitrary depth on a nonuniform source grid', async () => {
    const source = stack((_x, _y, z) => polynomial(z), [0, 0.75, 1.75, 2.5, 3.75, 4.5, 5.5]);
    for (const depth of [2.875, 3.37]) {
      const result = await synthesizeSharpSlice(source, depth);
      expect(result.pixels[0]).toBeCloseTo(polynomial(depth), 4);
      expect(result.valid.every((value) => value === 1)).toBe(true);
    }
  });

  it('reconstructs texture beyond linear blending deterministically without changing source owners', async () => {
    const source = stack(texture);
    const before = source.slices.map((plane) => ({ pixels: plane.pixels.slice(), valid: plane.valid!.slice() }));
    const cubic = await synthesizeSharpSlice(source, 5.37);
    const repeated = await synthesizeSharpSlice(source, 5.37);
    const linear = await synthesizeSharpSlice({ ...source, slices: source.slices.slice(5, 7) }, 5.37);
    expect(repeated).toEqual(cubic);
    expect(cubic.pixels.some((value, index) => Math.abs(value - linear.pixels[index]!) > 0.0001)).toBe(true);
    expect(cubic.stats).toEqual({ exactSource: false, linearPixels: 0, cubicPixels: 400 });
    expect(linear.stats).toEqual({ exactSource: false, linearPixels: 400, cubicPixels: 0 });
    expect(cubic.pixels.every(Number.isFinite)).toBe(true);
    source.slices.forEach((plane, index) => {
      expect(plane.pixels).toEqual(before[index]!.pixels);
      expect(plane.valid).toEqual(before[index]!.valid);
    });
    expect(cubic.pixels.buffer).not.toBe(source.slices[5]!.pixels.buffer);
  });

  it.each([0, 5, 11])('preserves exact acquired source %s without aliasing its buffers', async (z) => {
    const source = stack(texture);
    const result = await synthesizeSharpSlice(source, z);
    expect(result.stats).toEqual({ exactSource: true, linearPixels: 0, cubicPixels: 0 });
    expect(result.pixels).toEqual(source.slices[z]!.pixels);
    expect(result.pixels.buffer).not.toBe(source.slices[z]!.pixels.buffer);
    expect(result.valid).toEqual(source.slices[z]!.valid);
    expect(result.valid.buffer).not.toBe(source.slices[z]!.valid!.buffer);
  });

  it.each([0, 103])('keeps a constant %s volume constant', async (constant) => {
    const result = await synthesizeSharpSlice(
      stack(() => constant),
      4.37,
    );
    expect(result.pixels.every((value) => value === constant)).toBe(true);
    expect(result.valid.every((value) => value === 1)).toBe(true);
  });

  it('preserves affine ramps without inventing contrast or changing their gradient', async () => {
    const source = stack((x, y, z) => 10 + 2 * x + 3 * y + 4 * z);
    const result = await synthesizeSharpSlice(source, 5.25);
    for (let index = 0; index < result.pixels.length; index++)
      expect(result.pixels[index]).toBe(
        10 + 2 * (index % source.columns) + 3 * Math.floor(index / source.columns) + 21,
      );
  });

  it('bounds discontinuities to the four observed values without ringing', async () => {
    const source = stack((_x, _y, z) => (z >= 6 ? 255 : 0));
    for (const position of [4.25, 4.75, 5.25, 5.75, 6.25, 6.75]) {
      const result = await synthesizeSharpSlice(source, position);
      expect(result.pixels.every((value) => Number.isFinite(value) && value >= 0 && value <= 255)).toBe(true);
    }
  });

  it('rejects a missing acquired interval and never uses invalid/nonfinite bracketing pixels', async () => {
    const source = stack(texture);
    const gap = await synthesizeSharpSlice({ ...source, slices: source.slices.filter((_, i) => i < 5 || i > 7) }, 6);
    expect(gap.valid.every((value) => value === 0)).toBe(true);
    expect(gap.pixels.every((value) => value === 0)).toBe(true);
    source.slices[5]!.valid![101] = 0;
    source.slices[6]!.pixels[102] = NaN;
    const result = await synthesizeSharpSlice(source, 5.5);
    expect(result.valid[101]).toBe(0);
    expect(result.valid[102]).toBe(0);
    expect(result.pixels.every(Number.isFinite)).toBe(true);
    source.slices[4]!.valid![103] = 0;
    const fallback = await synthesizeSharpSlice(source, 5.5);
    expect(fallback.valid[103]).toBe(1);
    expect(fallback.pixels[103]).toBeCloseTo((source.slices[5]!.pixels[103]! + source.slices[6]!.pixels[103]!) / 2, 4);
  });

  it('falls back to linear at acquisition boundaries and returns unsupported outside the source', async () => {
    const source = stack(texture);
    const result = await synthesizeSharpSlice(source, 0.37);
    expect(result.stats.linearPixels).toBe(400);
    expect(result.pixels[0]).toBeCloseTo(source.slices[0]!.pixels[0]! * 0.63 + source.slices[1]!.pixels[0]! * 0.37, 4);
    const outside = await synthesizeSharpSlice(source, -1);
    expect(outside.valid.every((value) => value === 0)).toBe(true);
    const single = { ...source, slices: [source.slices[3]!] };
    expect((await synthesizeSharpSlice(single, 3)).pixels).toEqual(source.slices[3]!.pixels);
    expect((await synthesizeSharpSlice(single, 3.1)).valid.every((value) => value === 0)).toBe(true);
  });

  it('sorts physical positions without changing the caller order', async () => {
    const source = stack(texture);
    const reverse = { ...source, slices: [...source.slices].reverse() };
    expect(await synthesizeSharpSlice(reverse, 4.3)).toEqual(await synthesizeSharpSlice(source, 4.3));
    expect(reverse.slices[0]).toBe(source.slices.at(-1));
  });

  it('rejects malformed dimensions/support/positions and nonfinite requested depths', async () => {
    const source = stack(texture);
    await expect(synthesizeSharpSlice({ ...source, columns: 0 }, 4)).rejects.toThrow(/nonempty/);
    await expect(synthesizeSharpSlice({ ...source, slices: [] }, 4)).rejects.toThrow(/nonempty/);
    await expect(
      synthesizeSharpSlice({ ...source, slices: [{ ...source.slices[0]!, positionMm: NaN }] }, 4),
    ).rejects.toThrow(/positions/);
    await expect(
      synthesizeSharpSlice({ ...source, slices: [source.slices[0]!, source.slices[0]!] }, 4),
    ).rejects.toThrow(/distinct/);
    await expect(
      synthesizeSharpSlice({ ...source, slices: [{ ...source.slices[0]!, valid: new Uint8Array(2) }] }, 4),
    ).rejects.toThrow(/support/);
    await expect(synthesizeSharpSlice(source, NaN)).rejects.toThrow(/finite physical depth/);
  });

  it('honors cancellation before allocation, at progress callbacks and before publication', async () => {
    const source = stack(texture);
    const before = new AbortController();
    before.abort();
    await expect(synthesizeSharpSlice(source, 5.5, { signal: before.signal })).rejects.toMatchObject({
      name: 'AbortError',
    });
    const progress = new AbortController();
    await expect(
      synthesizeSharpSlice(source, 5.5, {
        signal: progress.signal,
        onProgress: () => progress.abort(),
      }),
    ).rejects.toMatchObject({ name: 'AbortError' });
    const after = new AbortController();
    vi.stubGlobal('scheduler', { yield: async () => after.abort() });
    await expect(synthesizeSharpSlice(source, 5.5, { signal: after.signal })).rejects.toMatchObject({
      name: 'AbortError',
    });
  });
});
