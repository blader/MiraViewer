import { describe, expect, test } from 'vitest';
import {
  buildSoftForegroundSupportSquare,
  buildStructuralPhaseImageSquare,
  erodeFractionalSupportSquare,
  inpaintExclusionRectSquare,
} from '../src/utils/imageFeatures';

describe('buildSoftForegroundSupportSquare', () => {
  test('maps normalized source intensity to an independent soft support field', () => {
    const pixels = Float32Array.from([0, 0.025, 0.05, 1]);

    const support = buildSoftForegroundSupportSquare(pixels, 2, { fullSupportAt: 0.05 });

    expect(support[0]).toBe(0);
    expect(support[1]).toBeCloseTo(0.5, 6);
    expect(support[2]).toBe(1);
    expect(support[3]).toBe(1);
  });
});

describe('inpaintExclusionRectSquare', () => {
  test('smoothly neutralizes a high-contrast excluded region without mutating the source', () => {
    const size = 16;
    const pixels = new Float32Array(size * size).fill(0.2);
    for (let y = 5; y < 11; y++) {
      for (let x = 5; x < 11; x++) pixels[y * size + x] = 1;
    }

    const result = inpaintExclusionRectSquare(
      pixels,
      size,
      { x: 5 / size, y: 5 / size, width: 6 / size, height: 6 / size },
      2,
    );

    expect(pixels[8 * size + 8]).toBe(1);
    expect(result.pixels[8 * size + 8]).toBeCloseTo(0.2, 6);
    expect(result.pixels[5 * size + 5]).toBeCloseTo(0.2, 6);
    expect(result.excludedFrac).toBeCloseTo(36 / (size * size), 6);
  });
});

describe('erodeFractionalSupportSquare', () => {
  test('radius zero returns a sanitized copy', () => {
    const support = Float32Array.from([1, Number.NaN, Number.POSITIVE_INFINITY, 0.5]);

    const eroded = erodeFractionalSupportSquare(support, 2, 0);

    expect(eroded).not.toBe(support);
    expect(Array.from(eroded)).toEqual([1, 0, 0, 0.5]);
  });

  test('radius one takes the square-window minimum for fractional support', () => {
    const support = Float32Array.from([0.25, 1, 1, 1, 1, 1, 1, 1, 1]);

    expect(Array.from(erodeFractionalSupportSquare(support, 3, 1))).toEqual([0.25, 0.25, 1, 0.25, 0.25, 1, 1, 1, 1]);
  });

  test('flat support stays flat for a radius larger than the image', () => {
    const support = new Float32Array(16).fill(0.625);

    expect(erodeFractionalSupportSquare(support, 4, 10)).toEqual(support);
  });

  test('rejects support whose length does not match the square size', () => {
    expect(() => erodeFractionalSupportSquare(new Float32Array(8), 3, 1)).toThrow(/expected 3x3.*got 8/i);
  });
});

describe('buildStructuralPhaseImageSquare', () => {
  test('preserves a boundary under exact polarity reversal', () => {
    const size = 64;
    const bright = new Float32Array(size * size);
    const dark = new Float32Array(size * size);
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        bright[y * size + x] = x < size / 2 ? 0.2 : 0.8;
        dark[y * size + x] = x < size / 2 ? 0.8 : 0.2;
      }
    }

    const brightEdges = buildStructuralPhaseImageSquare(bright, size);
    const darkEdges = buildStructuralPhaseImageSquare(dark, size);

    expect(Array.from(darkEdges)).toEqual(Array.from(brightEdges));
    expect(brightEdges.some((value) => value > 0)).toBe(true);
  });

  test.each([0, 0.5])('flat input %f produces a neutral structural phase image', (value) => {
    expect(Array.from(buildStructuralPhaseImageSquare(new Float32Array(64 * 64).fill(value), 64))).toEqual(
      Array(64 * 64).fill(0),
    );
  });

  test('sanitizes non-finite gradient samples', () => {
    const size = 5;
    const pixels = Float32Array.from({ length: size * size }, (_, index) => index / (size * size));
    pixels[6] = Number.NaN;
    pixels[12] = Number.POSITIVE_INFINITY;
    pixels[18] = Number.NEGATIVE_INFINITY;

    const structural = buildStructuralPhaseImageSquare(pixels, size);

    expect(structural.every(Number.isFinite)).toBe(true);
    expect(structural.every((value) => value >= 0 && value <= 1)).toBe(true);
  });
});
