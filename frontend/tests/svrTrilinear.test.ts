import { describe, expect, it } from 'vitest';
import { sampleTrilinear, splatTrilinear, splatTrilinearScaled } from '../src/utils/svr/trilinear';
import { resampleVolumeToGridTrilinear } from '../src/utils/svr/reconstructionCore';
import { withinTrilinearSupport } from '../src/utils/svr/svrUtils';

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

  it('samples and splats exact final voxel centers without losing boundary mass', () => {
    const dims = { nx: 3, ny: 3, nz: 3 };
    const volume = Float32Array.from({ length: 27 }, (_, index) => index + 1);
    const accum = new Float32Array(27);
    const weight = new Float32Array(27);

    expect(withinTrilinearSupport(dims, 2, 2, 2)).toBe(true);
    expect(sampleTrilinear(volume, dims, 2, 2, 2)).toBe(27);
    expect(sampleTrilinear(volume, dims, 2, 1.5, 0)).toBeCloseTo(7.5);

    splatTrilinear(accum, weight, dims, 2, 2, 2, 9);
    expect(accum[26]).toBe(9);
    expect(weight[26]).toBe(1);
    expect(accum.reduce((sum, value) => sum + value, 0)).toBe(9);
  });

  it('preserves every voxel under identity grid resampling', async () => {
    const dims = { nx: 3, ny: 3, nz: 3 };
    const grid = { dims, originMm: { x: 0, y: 0, z: 0 }, voxelSizeMm: 1 };
    const source = Float32Array.from({ length: 27 }, (_, index) => index + 1);

    const result = await resampleVolumeToGridTrilinear({ src: source, srcGrid: grid, dstGrid: grid });

    expect(result).toEqual(source);
  });
});
