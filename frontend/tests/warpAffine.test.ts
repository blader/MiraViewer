import { describe, expect, test } from 'vitest';
import {
  fillInvalidWarpWithValidMean,
  warpGrayscaleAffine,
  warpGrayscaleAffineWithValidity,
} from '../src/utils/warpAffine';

const IDENTITY = { m00: 1, m01: 0, m10: 0, m11: 1 } as const;

describe('warpGrayscaleAffineWithValidity', () => {
  test('preserves pixels and reports full validity for an identity warp', () => {
    const input = Float32Array.from([
      0, 0.25, 0.5,
      0.75, 1, 0.75,
      0.5, 0.25, 0,
    ]);

    const result = warpGrayscaleAffineWithValidity(input, 3, {
      A: IDENTITY,
      translateX: 0,
      translateY: 0,
    });

    expect(Array.from(result.pixels)).toEqual(Array.from(input));
    expect(Array.from(result.validity)).toEqual(new Array(9).fill(1));
  });

  test('reports fractional support where a translated sample crosses the source boundary', () => {
    const input = new Float32Array(16).fill(1);

    const result = warpGrayscaleAffineWithValidity(input, 4, {
      A: IDENTITY,
      translateX: 0.5,
      translateY: 0,
    });

    expect(result.validity[0]).toBeCloseTo(0.5, 6);
    expect(result.pixels[0]).toBeCloseTo(0.5, 6);
    expect(result.validity[1]).toBeCloseTo(1, 6);
    expect(result.pixels[1]).toBeCloseTo(1, 6);
  });

  test('uses identical zero-padded interpolation for pixel-only and validity-returning warps', () => {
    const input = new Float32Array(16).fill(1);
    const transform = {
      A: IDENTITY,
      translateX: 0.5,
      translateY: 0,
    };

    const pixels = warpGrayscaleAffine(input, 4, transform);
    const withValidity = warpGrayscaleAffineWithValidity(input, 4, transform);

    expect(Array.from(pixels)).toEqual(Array.from(withValidity.pixels));
  });

  test('mean-fills missing interpolation support before residual registration', () => {
    const warped = warpGrayscaleAffineWithValidity(new Float32Array(16).fill(0.8), 4, {
      A: IDENTITY,
      translateX: 0.5,
      translateY: 0,
    });

    const filled = fillInvalidWarpWithValidMean(warped);

    expect(filled[0]).toBeCloseTo(0.8, 6);
    expect(filled[1]).toBeCloseTo(0.8, 6);
    expect(filled.every((value) => Math.abs(value - 0.8) < 1e-6)).toBe(true);
  });
});
