import { describe, expect, it } from 'vitest';
import { segmentSeededVolume, type SeededVolumeInput } from './helpers/legacySeededVolume';

function input(size: number): SeededVolumeInput {
  return {
    volume: new Float32Array(size ** 3).fill(0.5),
    dims: [size, size, size],
    voxelSizeMm: [0.7, 1.2, 2],
    foreground: Uint32Array.of(Math.floor(size ** 3 / 2)),
    background: new Uint32Array(),
  };
}

describe('selection computation completion and cancellation', () => {
  it('reports completion even when the whole region fits below a progress chunk', async () => {
    const source = input(6);
    const progress: [number, number][] = [];
    const result = await segmentSeededVolume(source, {
      onProgress: (processed, total) => progress.push([processed, total]),
    });
    expect(progress).toEqual([[source.volume.length, source.volume.length]]);
    expect(result.indices).toContain(source.foreground[0]);
  });

  it('does not publish when cancellation arrives in the final progress callback', async () => {
    const controller = new AbortController();
    await expect(
      segmentSeededVolume(input(6), {
        signal: controller.signal,
        onProgress: () => controller.abort(),
      }),
    ).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('stops reading source voxels immediately when a cooperative yield is cancelled', async () => {
    const controller = new AbortController();
    const source = input(25);
    let readsAfterAbort = 0;
    source.volume = new Proxy(source.volume, {
      get(target, key) {
        if (controller.signal.aborted && typeof key === 'string' && /^\d+$/.test(key)) readsAfterAbort++;
        return Reflect.get(target, key, target);
      },
    });
    let yields = 0;
    await expect(
      segmentSeededVolume(source, {
        signal: controller.signal,
        yieldFn: async () => {
          yields++;
          controller.abort();
        },
      }),
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(yields).toBe(1);
    expect(readsAfterAbort).toBe(0);
  });
});
