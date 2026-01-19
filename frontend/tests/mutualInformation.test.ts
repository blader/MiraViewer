import { describe, expect, test } from 'vitest';
import { computeMutualInformation } from '../src/utils/mutualInformation';

function makeBinaryPattern(n: number, period: number): Float32Array {
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    out[i] = (i % period) < period / 2 ? 0 : 1;
  }
  return out;
}

function makeDeterministicRandomBinary(n: number, seed: number): Float32Array {
  let s = seed >>> 0;
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    // LCG (Numerical Recipes)
    s = (1664525 * s + 1013904223) >>> 0;
    // Use the high bits as a pseudo-uniform [0,1)
    const u = (s >>> 8) / 0x01000000;
    out[i] = u < 0.5 ? 0 : 1;
  }
  return out;
}

describe('computeMutualInformation', () => {
  test('identical binary images have high MI and NMI ~ 2', () => {
    const a = makeBinaryPattern(4096, 8);
    const b = a;

    const r = computeMutualInformation(a, b, 32);

    expect(r.mi).toBeGreaterThan(0.1);
    // For identical distributions, Studholme NMI tends toward 2.
    expect(r.nmi).toBeGreaterThan(1.8);
    expect(r.nmi).toBeLessThan(2.2);
  });

  test('independent-ish images have lower MI than identical images', () => {
    const a = makeDeterministicRandomBinary(8192, 123);
    const b = makeDeterministicRandomBinary(8192, 999);

    const same = computeMutualInformation(a, a, 32);
    const indep = computeMutualInformation(a, b, 32);

    expect(indep.mi).toBeLessThan(same.mi);
    // Independent variables should have NMI close to 1 (within sampling noise).
    expect(indep.nmi).toBeGreaterThan(0.8);
    expect(indep.nmi).toBeLessThan(1.3);
  });

  test('symmetry: MI(A,B) ~= MI(B,A)', () => {
    const a = makeDeterministicRandomBinary(4096, 42);
    const b = makeDeterministicRandomBinary(4096, 1337);

    const ab = computeMutualInformation(a, b, 32);
    const ba = computeMutualInformation(b, a, 32);

    expect(Math.abs(ab.mi - ba.mi)).toBeLessThan(1e-6);
    expect(Math.abs(ab.nmi - ba.nmi)).toBeLessThan(1e-6);
  });
});
