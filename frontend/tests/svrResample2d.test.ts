import { describe, expect, it } from 'vitest';
import { resample2dAreaAverage, resample2dLanczos3 } from '../src/utils/svr/resample2d';

describe('svr/resample2dAreaAverage', () => {
  it('returns an identical copy when dimensions match', () => {
    const src = new Float32Array([1, 2, 3, 4, 5, 6]);
    const out = resample2dAreaAverage(src, 2, 3, 2, 3);

    expect(out).not.toBe(src);
    expect(Array.from(out)).toEqual([1, 2, 3, 4, 5, 6]);
  });

  it('preserves constant images under downsampling', () => {
    const src = new Float32Array(8 * 6).fill(7.25);
    const out = resample2dAreaAverage(src, 8, 6, 4, 3);

    expect(out.length).toBe(4 * 3);
    for (const v of out) {
      expect(v).toBeCloseTo(7.25, 6);
    }
  });

  it('downsamples 2x2 -> 1x1 by averaging all pixels', () => {
    // [[1, 2],
    //  [3, 4]] => avg = 2.5
    const src = new Float32Array([1, 2, 3, 4]);
    const out = resample2dAreaAverage(src, 2, 2, 1, 1);

    expect(out.length).toBe(1);
    expect(out[0]).toBeCloseTo(2.5, 6);
  });

  it('downsamples 4x4 -> 2x2 by averaging 2x2 blocks', () => {
    // src:
    //  0  1  2  3
    //  4  5  6  7
    //  8  9 10 11
    // 12 13 14 15
    // blocks (2x2):
    //  [0,1,4,5] avg=2.5, [2,3,6,7] avg=4.5
    //  [8,9,12,13] avg=10.5, [10,11,14,15] avg=12.5
    const src = new Float32Array([...Array.from({ length: 16 }, (_, i) => i)]);
    const out = resample2dAreaAverage(src, 4, 4, 2, 2);

    expect(out.length).toBe(4);
    expect(out[0]).toBeCloseTo(2.5, 6);
    expect(out[1]).toBeCloseTo(4.5, 6);
    expect(out[2]).toBeCloseTo(10.5, 6);
    expect(out[3]).toBeCloseTo(12.5, 6);
  });

  it('upsamples 2x2 -> 4x4 replicates pixels for integer scales', () => {
    // Each source pixel becomes a 2x2 block.
    const src = new Float32Array([
      1, 2,
      3, 4,
    ]);

    const out = resample2dAreaAverage(src, 2, 2, 4, 4);

    const expected = [
      1, 1, 2, 2,
      1, 1, 2, 2,
      3, 3, 4, 4,
      3, 3, 4, 4,
    ];

    expect(out.length).toBe(16);
    expect(Array.from(out)).toEqual(expected);
  });

  it('Lanczos3 preserves constant images under downsampling', () => {
    const src = new Float32Array(8 * 6).fill(3.125);
    const out = resample2dLanczos3(src, 8, 6, 4, 3);

    expect(out.length).toBe(4 * 3);
    for (const v of out) {
      expect(v).toBeCloseTo(3.125, 5);
    }
  });

  it('Lanczos3 2x2 -> 1x1 equals the mean for this symmetric case', () => {
    const src = new Float32Array([1, 2, 3, 4]);
    const out = resample2dLanczos3(src, 2, 2, 1, 1);

    expect(out.length).toBe(1);
    expect(out[0]).toBeCloseTo(2.5, 5);
  });
});
