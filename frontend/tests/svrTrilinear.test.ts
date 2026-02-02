import { describe, expect, it } from 'vitest';
import { sampleTrilinear, splatTrilinear, splatTrilinearScaled } from '../src/utils/svr/trilinear';

describe('svr/trilinear', () => {
  it('sampleTrilinear samples the center of a 2x2x2 volume', () => {
    const dims = { nx: 2, ny: 2, nz: 2 };
    const volume = new Float32Array([0, 1, 2, 3, 4, 5, 6, 7]);

    const v = sampleTrilinear(volume, dims, 0.5, 0.5, 0.5);
    expect(v).toBeCloseTo(3.5);
  });

  it('splatTrilinear distributes weights to 8 neighbors', () => {
    const dims = { nx: 2, ny: 2, nz: 2 };
    const accum = new Float32Array(8);
    const weight = new Float32Array(8);

    splatTrilinear(accum, weight, dims, 0.5, 0.5, 0.5, 1);

    const sumAccum = accum.reduce((a, b) => a + b, 0);
    const sumWeight = weight.reduce((a, b) => a + b, 0);

    expect(sumAccum).toBeCloseTo(1);
    expect(sumWeight).toBeCloseTo(1);

    for (let i = 0; i < 8; i++) {
      expect(weight[i]).toBeCloseTo(1 / 8);
      expect(accum[i]).toBeCloseTo(1 / 8);
    }
  });

  it('splatTrilinearScaled scales both accum and weight', () => {
    const dims = { nx: 2, ny: 2, nz: 2 };
    const accum = new Float32Array(8);
    const weight = new Float32Array(8);

    splatTrilinearScaled(accum, weight, dims, 0.5, 0.5, 0.5, 2, 0.25);

    const sumAccum = accum.reduce((a, b) => a + b, 0);
    const sumWeight = weight.reduce((a, b) => a + b, 0);

    // splatTrilinearScaled should be equivalent to splatTrilinear(val * scale) AND weight scaled.
    expect(sumAccum).toBeCloseTo(2 * 0.25);
    expect(sumWeight).toBeCloseTo(0.25);
  });
});
