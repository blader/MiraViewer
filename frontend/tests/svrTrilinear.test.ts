import { describe, expect, it } from 'vitest';
import {
  sampleTrilinear,
  sampleTrilinearWithSupport,
  splatTrilinear,
  splatTrilinearScaled,
} from '../src/utils/svr/trilinear';
import { resampleVolumeToGridTrilinear } from '../src/utils/svr/reconstructionCore';
import { withinTrilinearSupport } from '../src/utils/svr/svrUtils';

describe('svr/trilinear', () => {
  it('sampleTrilinear samples the center of a 2x2x2 volume', () => {
    const dims = { nx: 2, ny: 2, nz: 2 };
    const volume = new Float32Array([0, 1, 2, 3, 4, 5, 6, 7]);

    const v = sampleTrilinear(volume, dims, 0.5, 0.5, 0.5);
    expect(v).toBeCloseTo(3.5);
  });

  it('matches separate signal and acquired-support interpolation across every edge and fractional neighborhood', () => {
    const dims = { nx: 3, ny: 3, nz: 3 };
    const volume = Float32Array.from({ length: 27 }, (_, index) => Math.sin(index * 0.37) - 0.3);
    const masks = [
      new Uint8Array(27).fill(1),
      new Uint8Array(27),
      Uint8Array.from({ length: 27 }, (_, index) => Number(index % 3 !== 0)),
      Uint8Array.from({ length: 27 }, (_, index) => Number(index % 2 === 0)),
    ];
    const coordinates = [
      [0, 0, 0],
      [2, 2, 2],
      [0, 1.25, 2],
      [2, 0, 0.875],
      [0.125, 0.5, 0.875],
      [1.999999, 1.000001, 0.333333],
      [-0.1, 1, 1],
      [1, 2.01, 1],
      [Number.NaN, 1, 1],
    ] as const;
    const result = new Float64Array(2);

    for (const support of masks) {
      for (const [x, y, z] of coordinates) {
        sampleTrilinearWithSupport(volume, support, dims, x, y, z, result);
        expect(result[0]).toBe(sampleTrilinear(volume, dims, x, y, z));
        expect(result[1]).toBe(sampleTrilinear(support, dims, x, y, z));
      }
    }
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

  it('does not dilute acquired coarse anatomy with unsupported zero-filled neighbors', async () => {
    const sourceGrid = { dims: { nx: 2, ny: 1, nz: 1 }, originMm: { x: 0, y: 0, z: 0 }, voxelSizeMm: 2 };
    const destinationGrid = { dims: { nx: 3, ny: 1, nz: 1 }, originMm: { x: 0, y: 0, z: 0 }, voxelSizeMm: 1 };

    const result = await resampleVolumeToGridTrilinear({
      src: new Float32Array([0, 100]),
      srcOccupancy: new Uint8Array([0, 1]),
      srcGrid: sourceGrid,
      dstGrid: destinationGrid,
    });

    expect(Array.from(result)).toEqual([0, 100, 100]);
  });

  it('rejects coarse acquired-support masks that do not match their source volume', async () => {
    const grid = { dims: { nx: 2, ny: 1, nz: 1 }, originMm: { x: 0, y: 0, z: 0 }, voxelSizeMm: 1 };

    await expect(
      resampleVolumeToGridTrilinear({
        src: new Float32Array([0, 1]),
        srcOccupancy: new Uint8Array([1]),
        srcGrid: grid,
        dstGrid: grid,
      }),
    ).rejects.toThrow(/support.*source|source.*support/i);
  });
});
