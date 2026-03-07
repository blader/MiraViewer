import { describe, expect, it } from 'vitest';
import { logitsToLabels } from '../src/utils/segmentation/onnx/logitsToLabels';

describe('logitsToLabels', () => {
  it('converts [1,C,Z,Y,X] logits to uint8 labels using a label map', () => {
    // C=3, Z=1, Y=1, X=4
    const dims = [1, 3, 1, 1, 4] as const;
    const spatial = 4;

    // Layout: [C, spatial]
    // voxel 0: class0
    // voxel 1: class1
    // voxel 2: class2
    // voxel 3: class1
    const data = new Float32Array([
      // c0
      10, 0, 0, 0,
      // c1
      0, 9, 0, 8,
      // c2
      0, 0, 7, 0,
    ]);

    const out = logitsToLabels({ logits: { data, dims }, labelMap: [0, 1, 4] });
    expect(out.spatialDims).toEqual([4, 1, 1]);
    expect(Array.from(out.labels)).toEqual([0, 1, 4, 1]);
    expect(out.labels.length).toBe(spatial);
  });

  it('supports [C,Z,Y,X] logits', () => {
    const dims = [2, 1, 1, 3] as const; // C=2, Z=1, Y=1, X=3
    const data = new Float32Array([
      // c0
      0, 5, 0,
      // c1
      1, 0, 2,
    ]);

    const out = logitsToLabels({ logits: { data, dims }, labelMap: [0, 2] });
    expect(Array.from(out.labels)).toEqual([2, 0, 2]);
  });

  it('throws on shape/data mismatch', () => {
    expect(() =>
      logitsToLabels({
        logits: { data: new Float32Array([1, 2, 3]), dims: [1, 2, 1, 1, 2] },
        labelMap: [0, 1],
      })
    ).toThrow(/data length mismatch/i);
  });
});
