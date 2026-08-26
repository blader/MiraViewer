import { describe, expect, it } from 'vitest';
import { regionGrow3D_v2 } from '../src/utils/segmentation/regionGrow3D_v2';

describe('SVR segmentation acquired-pixel support', () => {
  it('rejects an unsupported segmentation seed', async () => {
    await expect(
      regionGrow3D_v2({
        volume: new Float32Array([0.7, 0.7, 0.7]),
        observedSupport: new Uint8Array([1, 0, 1]),
        dims: [3, 1, 1],
        seed: { x: 1, y: 0, z: 0 },
        min: 0,
        max: 1,
        opts: { yieldEvery: 0 },
      }),
    ).rejects.toThrow(/seed.*observed|seed.*unsupported/i);
  });

  it('treats an unsupported voxel as a hard traversal barrier', async () => {
    const result = await regionGrow3D_v2({
      volume: new Float32Array(7).fill(0.7),
      observedSupport: new Uint8Array([1, 1, 1, 0, 1, 1, 1]),
      dims: [7, 1, 1],
      seed: { x: 1, y: 0, z: 0 },
      min: 0,
      max: 1,
      opts: { yieldEvery: 0 },
    });

    expect(Array.from(result.indices).sort((a, b) => a - b)).toEqual([0, 1, 2]);
    expect(result.count).toBe(3);
  });

  it('rejects acquired-support masks that do not match the reconstructed grid', async () => {
    await expect(
      regionGrow3D_v2({
        volume: new Float32Array(4),
        observedSupport: new Uint8Array(3),
        dims: [4, 1, 1],
        seed: { x: 0, y: 0, z: 0 },
        min: 0,
        max: 1,
      }),
    ).rejects.toThrow(/support.*length/i);
  });

  it('preserves legacy reconstruction compatibility when support evidence is absent', async () => {
    const result = await regionGrow3D_v2({
      volume: new Float32Array(4).fill(0.7),
      dims: [4, 1, 1],
      seed: { x: 1, y: 0, z: 0 },
      min: 0,
      max: 1,
      opts: { yieldEvery: 0 },
    });

    expect(result.count).toBe(4);
  });
});
