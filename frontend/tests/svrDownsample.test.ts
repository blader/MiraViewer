import { describe, expect, it } from 'vitest';
import { computeSvrDownsampleSize } from '../src/utils/svr/downsample';

describe('svr/downsample', () => {
  it('fixed mode obeys maxSize', () => {
    const r = computeSvrDownsampleSize({
      rows: 512,
      cols: 512,
      maxSize: 128,
      mode: 'fixed',
      rowSpacingMm: 0.5,
      colSpacingMm: 0.5,
      targetVoxelSizeMm: 1.0,
    });

    expect(r.dsRows).toBe(128);
    expect(r.dsCols).toBe(128);
  });

  it('voxel-aware mode refuses to downsample beyond the target voxel size', () => {
    // With 0.5mm pixels and a 1.0mm voxel target, we can downsample by at most 2x (512 -> 256).
    const r = computeSvrDownsampleSize({
      rows: 512,
      cols: 512,
      maxSize: 128,
      mode: 'voxel-aware',
      rowSpacingMm: 0.5,
      colSpacingMm: 0.5,
      targetVoxelSizeMm: 1.0,
    });

    expect(r.dsRows).toBe(256);
    expect(r.dsCols).toBe(256);
  });

  it('voxel-aware mode keeps full resolution when target voxels are as small as pixels', () => {
    const r = computeSvrDownsampleSize({
      rows: 512,
      cols: 512,
      maxSize: 128,
      mode: 'voxel-aware',
      rowSpacingMm: 0.5,
      colSpacingMm: 0.5,
      targetVoxelSizeMm: 0.5,
    });

    expect(r.dsRows).toBe(512);
    expect(r.dsCols).toBe(512);
  });
});
