import { describe, expect, test } from 'vitest';
import { findBestMatchingSlice } from '../src/utils/alignment';

function makeDeterministicRandomBinary(n: number, seed: number): Float32Array {
  let s = seed >>> 0;
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    // LCG (Numerical Recipes)
    s = (1664525 * s + 1013904223) >>> 0;
    const u = (s >>> 8) / 0x01000000;
    out[i] = u < 0.5 ? 0 : 1;
  }
  return out;
}

function makeDeterministicRandomFloat(n: number, seed: number): Float32Array {
  let s = seed >>> 0;
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    s = (1664525 * s + 1013904223) >>> 0;
    const u = (s >>> 8) / 0x01000000;
    out[i] = u;
  }
  return out;
}

function affineIntensity(a: Float32Array, scale: number, offset: number): Float32Array {
  const out = new Float32Array(a.length);
  for (let i = 0; i < a.length; i++) {
    const v = (a[i] ?? 0) * scale + offset;
    out[i] = Math.max(0, Math.min(1, v));
  }
  return out;
}

function addNoise(a: Float32Array, sigma: number, seed: number): Float32Array {
  let s = seed >>> 0;
  const out = new Float32Array(a.length);
  for (let i = 0; i < a.length; i++) {
    s = (1664525 * s + 1013904223) >>> 0;
    // Roughly uniform noise in [-sigma, sigma]
    const u = (s >>> 8) / 0x01000000;
    const n = (u * 2 - 1) * sigma;
    const v = (a[i] ?? 0) + n;
    out[i] = Math.max(0, Math.min(1, v));
  }
  return out;
}

function flipBinaryWithProb(a: Float32Array, flipProb: number, seed: number): Float32Array {
  let s = seed >>> 0;
  const out = new Float32Array(a.length);
  for (let i = 0; i < a.length; i++) {
    s = (1664525 * s + 1013904223) >>> 0;
    const u = (s >>> 8) / 0x01000000;
    const v = a[i] ?? 0;
    out[i] = u < flipProb ? 1 - v : v;
  }
  return out;
}

describe('findBestMatchingSlice', () => {
  test('minSearchRadius prevents early-stop misses when the true peak is a few slices away', async () => {
    // Use a square length so alignment.ts can infer imageWidth/imageHeight.
    const size = 64;
    const n = size * size;

    const reference = makeDeterministicRandomBinary(n, 123);

    // Construct a score landscape where slices 1..2 look progressively worse,
    // but slice 3 is much better (true peak).
    const slices: Float32Array[] = [];
    slices[0] = flipBinaryWithProb(reference, 0.2, 1);
    slices[1] = flipBinaryWithProb(reference, 0.3, 2);
    slices[2] = flipBinaryWithProb(reference, 0.4, 3);
    slices[3] = flipBinaryWithProb(reference, 0.05, 4);
    slices[4] = flipBinaryWithProb(reference, 0.45, 5);
    slices[5] = flipBinaryWithProb(reference, 0.5, 6);

    const getSlice = async (idx: number) => {
      const s = slices[idx];
      if (!s) throw new Error('missing slice');
      return s;
    };

    const noMin = await findBestMatchingSlice(reference, getSlice, 0, 1, slices.length, undefined, {
      miBins: 32,
      stopDecreaseStreak: 2,
      minSearchRadius: 0,
    });

    const withMin = await findBestMatchingSlice(reference, getSlice, 0, 1, slices.length, undefined, {
      miBins: 32,
      stopDecreaseStreak: 2,
      minSearchRadius: 3,
    });

    expect(noMin.bestIndex).not.toBe(3);
    expect(withMin.bestIndex).toBe(3);
  });

  test('scoreMetric=mind prefers same-structure slices despite intensity remapping', async () => {
    const size = 64;
    const n = size * size;

    const reference = makeDeterministicRandomFloat(n, 42);

    // Best match: intensity remapped reference (scale + offset).
    const best = affineIntensity(reference, 0.6, 0.2);

    const slices: Float32Array[] = [];
    slices[0] = makeDeterministicRandomFloat(n, 1);
    slices[1] = addNoise(reference, 0.15, 2);
    slices[2] = best;
    slices[3] = addNoise(reference, 0.25, 3);

    const getSlice = async (idx: number) => {
      const s = slices[idx];
      if (!s) throw new Error('missing slice');
      return s;
    };

    const r = await findBestMatchingSlice(reference, getSlice, 0, 1, slices.length, undefined, {
      scoreMetric: 'mind',
      mindSize: 64,
      stopDecreaseStreak: 2,
      minSearchRadius: 0,
    });

    expect(r.bestIndex).toBe(2);
  });

  test('scoreMetric=phase prefers slices with the same frequency content despite intensity remapping', async () => {
    const size = 64;
    const n = size * size;

    const reference = makeDeterministicRandomFloat(n, 7);

    const slices: Float32Array[] = [];
    slices[0] = makeDeterministicRandomFloat(n, 123);
    slices[1] = affineIntensity(reference, 1.2, -0.1);
    slices[2] = makeDeterministicRandomFloat(n, 456);

    const getSlice = async (idx: number) => {
      const s = slices[idx];
      if (!s) throw new Error('missing slice');
      return s;
    };

    const r = await findBestMatchingSlice(reference, getSlice, 0, 1, slices.length, undefined, {
      scoreMetric: 'phase',
      phaseSize: 64,
      stopDecreaseStreak: 2,
      minSearchRadius: 0,
    });

    expect(r.bestIndex).toBe(1);
  });
});
