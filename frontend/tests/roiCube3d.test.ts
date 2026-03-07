import { describe, expect, it } from 'vitest';
import { computeRoiCubeBoundsFromSliceDrag } from '../src/utils/segmentation/roiCube3d';

describe('computeRoiCubeBoundsFromSliceDrag', () => {
  it('creates a bounded axial cube depth based on voxel size', () => {
    const res = computeRoiCubeBoundsFromSliceDrag({
      plane: 'axial',
      dims: [100, 100, 100],
      voxelSizeMm: [1, 1, 2],
      sliceIndex: 50,
      a: { x: 10, y: 10, z: 50 },
      b: { x: 19, y: 19, z: 50 },
    });

    // 10x10 in-plane at 1mm => side=10mm; depth voxel size=2mm => depthSlices ~ 5.
    expect(res).not.toBeNull();
    expect(res!.min).toEqual({ x: 10, y: 10, z: 48 });
    expect(res!.max).toEqual({ x: 19, y: 19, z: 52 });
  });

  it('centers the cube on the slice index and clamps at volume bounds', () => {
    const res = computeRoiCubeBoundsFromSliceDrag({
      plane: 'axial',
      dims: [20, 20, 6],
      voxelSizeMm: [1, 1, 1],
      sliceIndex: 0,
      a: { x: 0, y: 0, z: 0 },
      b: { x: 9, y: 9, z: 0 },
    });

    // side=10mm; depthSlices=10 but nz=6 => clamped to 6.
    expect(res).not.toBeNull();
    expect(res!.min.z).toBe(0);
    expect(res!.max.z).toBe(5);
  });

  it('creates a bounded coronal cube along y', () => {
    const res = computeRoiCubeBoundsFromSliceDrag({
      plane: 'coronal',
      dims: [100, 80, 60],
      voxelSizeMm: [1, 2, 1],
      sliceIndex: 40,
      a: { x: 20, y: 40, z: 10 },
      b: { x: 39, y: 40, z: 29 },
    });

    // sideMm = max(20*1mm, 20*1mm)=20mm; vy=2mm => depthSlices ~10.
    expect(res).not.toBeNull();
    expect(res!.min.x).toBe(20);
    expect(res!.max.x).toBe(39);
    expect(res!.min.z).toBe(10);
    expect(res!.max.z).toBe(29);
    expect(res!.max.y - res!.min.y + 1).toBe(10);
  });

  it('creates a bounded sagittal cube along x', () => {
    const res = computeRoiCubeBoundsFromSliceDrag({
      plane: 'sagittal',
      dims: [50, 100, 100],
      voxelSizeMm: [2, 1, 1],
      sliceIndex: 10,
      a: { x: 10, y: 10, z: 10 },
      b: { x: 10, y: 29, z: 29 },
    });

    // sideMm = max(20*1mm, 20*1mm)=20mm; vx=2mm => depthSlices ~10.
    expect(res).not.toBeNull();
    expect(res!.min.y).toBe(10);
    expect(res!.max.y).toBe(29);
    expect(res!.min.z).toBe(10);
    expect(res!.max.z).toBe(29);
    expect(res!.max.x - res!.min.x + 1).toBe(10);
  });
});
