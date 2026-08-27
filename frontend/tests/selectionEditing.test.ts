import { describe, expect, it } from 'vitest';
import type { SvrVolume } from '../src/types/svr';
import {
  physicalBrushIndices,
  selectionPatch,
  applySelectionPatch,
  SLICE_AXES,
} from '../src/utils/segmentation/selectionEditing';
import { voxelIndex, voxelPoint } from '../src/utils/segmentation/seededVolume';

function volume(): SvrVolume {
  return {
    data: new Float32Array(11 ** 3),
    observedSupport: new Uint8Array(11 ** 3).fill(1),
    dims: [11, 11, 11],
    voxelSizeMm: [0.5, 1, 2],
    originMm: [10, -20, 30],
    boundsMm: { min: [10, -20, 30], max: [15, -10, 50] },
  };
}

describe('physical selection editing', () => {
  it.each([
    ['axial', 7],
    ['coronal', 5],
    ['sagittal', 3],
  ] as const)(
    'draws a one-millimeter disk in %s without confusing voxel counts and physical distances',
    (plane, count) => {
      const source = volume(),
        center = { x: 5, y: 5, z: 5 };
      const indices = physicalBrushIndices(source, plane, center, center, 1);
      expect(indices).toHaveLength(count);
      const axes = SLICE_AXES[plane];
      for (const index of indices) {
        const point = voxelPoint(index, source.dims);
        expect(point[axes.slice]).toBe(5);
        expect((point.x - 5) ** 2 * 0.5 ** 2 + (point.y - 5) ** 2 + (point.z - 5) ** 2 * 2 ** 2).toBeLessThanOrEqual(1);
      }
    },
  );

  it('interpolates fast pointer motion into a continuous stroke with no duplicate writes', () => {
    const source = volume();
    const indices = physicalBrushIndices(source, 'axial', { x: 1, y: 5, z: 5 }, { x: 9, y: 5, z: 5 }, 0.5);
    expect(new Set(indices).size).toBe(indices.length);
    for (let x = 1; x <= 9; x++) expect(indices).toContain(voxelIndex({ x, y: 5, z: 5 }, source.dims));
  });

  it('clips to physical bounds and excludes missing/nonfinite data while preserving observed zero intensity', () => {
    const source = volume();
    source.observedSupport![0] = 0;
    source.data[1] = NaN;
    const indices = physicalBrushIndices(source, 'axial', { x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 0 }, 2);
    expect(indices).not.toContain(0);
    expect(indices).not.toContain(1);
    expect(indices).toContain(2);
    for (const index of indices) {
      const point = voxelPoint(index, source.dims);
      expect(point.z).toBe(0);
      expect(point.x).toBeLessThanOrEqual(4);
      expect(point.y).toBeLessThanOrEqual(2);
    }
  });

  it('records only changed voxels and exactly reverses sparse edits without mutating source arrays', () => {
    const before = Uint8Array.of(0, 1, 2, 0, 1),
      after = Uint8Array.of(0, 0, 2, 1, 1);
    const patch = selectionPatch(before, after, Uint32Array.of(1, 1, 3, 4));
    expect([...patch.indices]).toEqual([1, 3]);
    expect(applySelectionPatch(after, patch, 'undo')).toEqual(before);
    expect(applySelectionPatch(before, patch, 'redo')).toEqual(after);
    expect([...before]).toEqual([0, 1, 2, 0, 1]);
    expect(() => selectionPatch(before, Uint8Array.of(1))).toThrow(/geometry/);
  });
});
