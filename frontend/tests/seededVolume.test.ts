import { describe, expect, it } from 'vitest';
import { segmentSeededVolume, type SeededVolumeInput } from '../src/utils/segmentation/seededVolume';
import { segmentationQuality } from './helpers/segmentationQuality';

function anatomy(polarity = 1, spacing: [number, number, number] = [1, 1, 1], heldOut = false) {
  const dims: [number, number, number] = [41, 37, 33];
  const center = [20, 18, 16];
  const index = (x: number, y: number, z: number) => (z * dims[1] + y) * dims[0] + x;
  const volume = new Float32Array(dims[0] * dims[1] * dims[2]);
  const truth = new Uint8Array(volume.length);
  for (let z = 0; z < dims[2]; z++)
    for (let y = 0; y < dims[1]; y++)
      for (let x = 0; x < dims[0]; x++) {
        const i = index(x, y, z);
        const dx = (x - center[0]!) * spacing[0],
          dy = (y - center[1]!) * spacing[1],
          dz = (z - center[2]!) * spacing[2];
        const radius = (dx / 7) ** 2 + (dy / 6) ** 2 + (dz / 5) ** 2;
        const lobule = heldOut && ((dx - 5) / 4) ** 2 + ((dy - 2) / 3) ** 2 + ((dz + 1) / 3) ** 2 <= 1;
        const lesion = radius <= 1 || lobule;
        const noise = Math.sin(x * 1.23 + y * 0.37 + z * 1.83) * (heldOut ? 0.018 : 0.008);
        truth[i] = lesion ? 1 : 0;
        volume[i] = 0.5 + noise + (lesion ? polarity * (0.11 + 0.03 * Math.sin(dx * 0.4 + dz * 0.3)) : 0);
        // A nearby disconnected structure has the same signal. Brightness alone is insufficient.
        if ((dx + 13) ** 2 + (dy + 7) ** 2 + dz ** 2 < 9) volume[i] = 0.5 + polarity * 0.11 + noise;
      }
  const foreground = Uint32Array.from([index(20, 18, 16), index(22, 18, 16), index(20, 20, 16)]);
  const background = Uint32Array.from([
    index(31, 18, 16),
    index(8, 18, 16),
    index(20, 30, 16),
    index(20, 6, 16),
    index(20, 18, 27),
    index(20, 18, 5),
  ]);
  const input: SeededVolumeInput = {
    volume,
    dims,
    voxelSizeMm: spacing,
    foreground,
    background,
    observedSupport: new Uint8Array(volume.length).fill(1),
  };
  return { input, truth };
}

describe('explicitly seeded physical-volume segmentation', () => {
  it.each([1, -1])(
    'separates heterogeneous tissue with polarity %i without guessing an intensity class',
    async (polarity) => {
      const { input, truth } = anatomy(polarity);
      const original = input.volume.slice();
      const result = await segmentSeededVolume(input);
      const metrics = segmentationQuality(truth, result.indices);
      console.info('[seeded-selection-phantom]', { polarity, ...metrics, domainVoxels: result.domainVoxels });
      expect(metrics.dice).toBeGreaterThan(0.94);
      expect(metrics.precision).toBeGreaterThan(0.97);
      const selected = new Set(result.indices);
      for (const index of input.foreground) expect(selected.has(index)).toBe(true);
      for (const index of input.background) expect(selected.has(index)).toBe(false);
      expect(input.volume).toEqual(original);
    },
  );

  it.each([
    [0.8, 1.1, 2],
    [1.4, 0.7, 1.2],
  ] as [number, number, number][])(
    'retains held-out lobulated anatomy with physical spacing %j',
    async (...spacing) => {
      const { input, truth } = anatomy(1, spacing as [number, number, number], true);
      const result = await segmentSeededVolume(input);
      const metrics = segmentationQuality(truth, result.indices);
      console.info('[seeded-selection-holdout]', { spacing, ...metrics });
      expect(metrics.dice).toBeGreaterThan(0.9);
      expect(metrics.precision).toBeGreaterThan(0.94);
    },
  );

  it('is invariant to an affine change of image intensity', async () => {
    const { input } = anatomy();
    const original = await segmentSeededVolume(input);
    const changed = await segmentSeededVolume({
      ...input,
      volume: Float32Array.from(input.volume, (value) => value * 137 + 20),
    });
    expect(changed.indices).toEqual(original.indices);
  });

  it('preserves a tiny marked structure even when it occupies less than a percentile of a uniform domain', async () => {
    const dims: [number, number, number] = [31, 31, 31];
    const volume = new Float32Array(31 ** 3).fill(0.4);
    const center = (15 * 31 + 15) * 31 + 15;
    volume[center] = 0.8;
    const result = await segmentSeededVolume({
      volume,
      dims,
      voxelSizeMm: [1, 1, 1],
      foreground: Uint32Array.of(center),
      background: Uint32Array.of(center + 4),
    });
    expect([...result.indices]).toEqual([center]);
  });

  it('refuses an oversized search domain before allocating its solver scratch', async () => {
    const dims: [number, number, number] = [128, 128, 128];
    await expect(
      segmentSeededVolume({
        volume: new Float32Array(128 ** 3),
        dims,
        voxelSizeMm: [1, 1, 1],
        foreground: Uint32Array.of(0),
        background: Uint32Array.of(128 ** 3 - 1),
      }),
    ).rejects.toThrow(/span too much tissue/);
  });

  it('is deterministic under seed ordering, duplicate marks, and exact-cost ties', async () => {
    const input: SeededVolumeInput = {
      volume: new Float32Array(15).fill(0.7),
      dims: [15, 1, 1],
      voxelSizeMm: [1, 1, 1],
      foreground: Uint32Array.of(3, 4),
      background: Uint32Array.of(10, 11),
    };
    const first = await segmentSeededVolume(input);
    const reversed = await segmentSeededVolume({
      ...input,
      foreground: Uint32Array.of(4, 3, 4),
      background: Uint32Array.of(11, 10, 11),
    });
    expect(first.indices).toEqual(reversed.indices);
    expect(first.indices).not.toContain(7);
  });

  it('uses an exclusion mark to separate touching tissue with the same intensity', async () => {
    const input: SeededVolumeInput = {
      volume: new Float32Array(15).fill(0.7),
      observedSupport: new Uint8Array(15).fill(1),
      dims: [15, 1, 1],
      voxelSizeMm: [1, 1, 1],
      foreground: new Uint32Array([3]),
      background: new Uint32Array([9]),
    };
    const result = await segmentSeededVolume(input);
    expect(result.indices).toContain(3);
    expect(result.indices).not.toContain(9);
    expect([...result.indices].every((index) => index < 7)).toBe(true);
    const corrected = await segmentSeededVolume({ ...input, background: new Uint32Array([5, 9]) });
    expect(corrected.indices.length).toBeLessThan(result.indices.length);
    expect(corrected.indices).not.toContain(5);
  });

  it('never seeds or connects through missing support and does not mutate marks', async () => {
    const input: SeededVolumeInput = {
      volume: new Float32Array(17).fill(0.7),
      observedSupport: new Uint8Array(17).fill(1),
      dims: [17, 1, 1],
      voxelSizeMm: [1, 1, 1],
      foreground: new Uint32Array([3]),
      background: new Uint32Array([13]),
    };
    input.observedSupport![8] = 0;
    const result = await segmentSeededVolume(input);
    expect([...result.indices].every((index) => index < 8)).toBe(true);
    await expect(segmentSeededVolume({ ...input, foreground: new Uint32Array([8]) })).rejects.toThrow(/acquired/);
    expect(input.foreground).toEqual(new Uint32Array([3]));
  });

  it('requires both kinds of marks and rejects contradictions, invalid geometry, and unbounded work', async () => {
    const { input } = anatomy();
    await expect(segmentSeededVolume({ ...input, background: new Uint32Array() })).rejects.toThrow(/include.*exclude/);
    await expect(segmentSeededVolume({ ...input, background: input.foreground })).rejects.toThrow(/both/);
    await expect(segmentSeededVolume({ ...input, voxelSizeMm: [1, 0, 1] })).rejects.toThrow(/geometry/);
    await expect(segmentSeededVolume({ ...input, foreground: new Uint32Array([0xffffffff]) })).rejects.toThrow(
      /acquired/,
    );
    await expect(
      segmentSeededVolume({ ...input, bounds: { min: { x: 0, y: 0, z: 0 }, max: { x: 1, y: 1, z: 1 } } }),
    ).rejects.toThrow(/every explicit mark/);
  });

  it('cancels before work and at cooperative worker yields without publishing a partial mask', async () => {
    const { input } = anatomy();
    const controller = new AbortController();
    controller.abort();
    await expect(segmentSeededVolume(input, { signal: controller.signal })).rejects.toMatchObject({
      name: 'AbortError',
    });
    const midRun = new AbortController();
    await expect(
      segmentSeededVolume(input, { signal: midRun.signal, yieldFn: async () => midRun.abort() }),
    ).rejects.toMatchObject({ name: 'AbortError' });
  });
});
