import { describe, expect, it } from 'vitest';
import { segmentSeededVolume } from '../src/utils/segmentation/seededVolume';

describe('SVR segmentation acquired-pixel support', () => {
  it('rejects an unsupported segmentation seed', async () => {
    await expect(
      segmentSeededVolume({
        volume: new Float32Array([0.7, 0.7, 0.7]),
        observedSupport: new Uint8Array([1, 0, 1]),
        dims: [3, 1, 1],
        foreground: Uint32Array.of(1),
        background: Uint32Array.of(0),
        voxelSizeMm: [1, 1, 1],
      }),
    ).rejects.toThrow(/acquired/i);
  });

  it('treats an unsupported voxel as a hard traversal barrier', async () => {
    const result = await segmentSeededVolume({
      volume: new Float32Array(7).fill(0.7),
      observedSupport: new Uint8Array([1, 1, 1, 0, 1, 1, 1]),
      dims: [7, 1, 1],
      foreground: Uint32Array.of(1),
      background: Uint32Array.of(6),
      voxelSizeMm: [1, 1, 1],
    });

    expect(Array.from(result.indices).sort((a, b) => a - b)).toEqual([1, 2]);
    expect([...result.indices].every((index) => index < 3)).toBe(true);
  });

  it('rejects acquired-support masks that do not match the reconstructed grid', async () => {
    await expect(
      segmentSeededVolume({
        volume: new Float32Array(4),
        observedSupport: new Uint8Array(3),
        dims: [4, 1, 1],
        foreground: Uint32Array.of(0),
        background: Uint32Array.of(0),
        voxelSizeMm: [1, 1, 1],
      }),
    ).rejects.toThrow(/support.*geometry/i);
  });

  it('preserves legacy reconstruction compatibility when support evidence is absent', async () => {
    const result = await segmentSeededVolume({
      volume: new Float32Array(4).fill(0.7),
      dims: [4, 1, 1],
      foreground: Uint32Array.of(1),
      background: Uint32Array.of(3),
      voxelSizeMm: [1, 1, 1],
    });

    expect(result.indices).toContain(1);
    expect(result.indices).not.toContain(3);
  });
});
