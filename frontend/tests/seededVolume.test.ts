import { describe, expect, it } from 'vitest';
import {
  markedRegionBounds,
  MAX_SEGMENTATION_DOMAIN_VOXELS,
  segmentSeededVolume,
  voxelIndex,
  voxelPoint,
  type SeededVolumeInput,
} from '../src/utils/segmentation/seededVolume';
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
  it.each([
    { polarity: 1, outsideMarks: true },
    { polarity: -1, outsideMarks: true },
    { polarity: 1, outsideMarks: false },
    { polarity: -1, outsideMarks: false },
  ])(
    'separates heterogeneous tissue with polarity $polarity and explicit outside marks: $outsideMarks',
    async ({ polarity, outsideMarks }) => {
      const { input, truth } = anatomy(polarity);
      if (!outsideMarks) input.background = new Uint32Array();
      const original = input.volume.slice();
      const result = await segmentSeededVolume(input);
      const metrics = segmentationQuality(truth, result.indices);
      console.info('[seeded-selection-phantom]', {
        polarity,
        outsideMarks,
        ...metrics,
        domainVoxels: result.domainVoxels,
      });
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

  it.each([
    { x: 96, y: 80, z: 48 },
    { x: 0, y: 0, z: 0 },
    { x: 191, y: 159, z: 95 },
  ])('maximizes bounded physical context at $x,$y,$z without clipping marks', (point) => {
    const dims: [number, number, number] = [192, 160, 96];
    const voxelSizeMm: [number, number, number] = [0.7, 1.3, 2.8];
    const foreground = (point.z * dims[1] + point.y) * dims[0] + point.x;
    const background = foreground + (point.x > 0 ? -1 : 1);
    const bounds = markedRegionBounds({
      dims,
      voxelSizeMm,
      volume: new Float32Array(dims[0] * dims[1] * dims[2]),
      foreground: Uint32Array.of(foreground),
      background: Uint32Array.of(background),
    });
    const axes = ['x', 'y', 'z'] as const;
    let count = 1,
      expandedCount = 1;
    const physicalPadding = [];
    for (const [position, axis] of axes.entries()) {
      const firstMark = axis === 'x' ? Math.min(point.x, point.x + (point.x > 0 ? -1 : 1)) : point[axis];
      const lastMark = axis === 'x' ? Math.max(point.x, point.x + (point.x > 0 ? -1 : 1)) : point[axis];
      expect(bounds.min[axis]).toBeGreaterThanOrEqual(0);
      expect(bounds.max[axis]).toBeLessThan(dims[position]!);
      expect(bounds.min[axis]).toBeLessThanOrEqual(firstMark);
      expect(bounds.max[axis]).toBeGreaterThanOrEqual(lastMark);
      count *= bounds.max[axis] - bounds.min[axis] + 1;
      expandedCount *= Math.min(dims[position]! - 1, bounds.max[axis] + 1) - Math.max(0, bounds.min[axis] - 1) + 1;
      if (bounds.min[axis] > 0) physicalPadding.push((firstMark - bounds.min[axis]) * voxelSizeMm[position]!);
      if (bounds.max[axis] < dims[position]! - 1)
        physicalPadding.push((bounds.max[axis] - lastMark) * voxelSizeMm[position]!);
    }
    expect(count).toBeLessThanOrEqual(MAX_SEGMENTATION_DOMAIN_VOXELS);
    expect(expandedCount).toBeGreaterThan(MAX_SEGMENTATION_DOMAIN_VOXELS);
    expect(Math.max(...physicalPadding) - Math.min(...physicalPadding)).toBeLessThanOrEqual(Math.max(...voxelSizeMm));
  });

  it('keeps the foreground search context when new outside marks already fit inside it', () => {
    const dims: [number, number, number] = [224, 192, 128];
    const input: SeededVolumeInput = {
      dims,
      voxelSizeMm: [0.6, 0.9, 1.4],
      volume: new Float32Array(dims[0] * dims[1] * dims[2]),
      foreground: Uint32Array.of(
        voxelIndex({ x: 110, y: 80, z: 64 }, dims),
        voxelIndex({ x: 112, y: 98, z: 64 }, dims),
      ),
      background: new Uint32Array(),
    };
    const initial = markedRegionBounds(input);
    const background = Uint32Array.of(
      voxelIndex({ x: initial.min.x + 2, y: 89, z: 64 }, dims),
      voxelIndex({ x: initial.max.x - 2, y: 89, z: 64 }, dims),
      voxelIndex({ x: 111, y: initial.min.y + 2, z: 64 }, dims),
      voxelIndex({ x: 111, y: initial.max.y - 2, z: 64 }, dims),
    );
    expect(markedRegionBounds({ ...input, background })).toEqual(initial);
    expect(markedRegionBounds({ ...input, background: background.slice().reverse() })).toEqual(initial);
    expect(input.background).toHaveLength(0);
  });

  it('still includes an outside mark beyond the foreground search region without exceeding the budget', () => {
    const dims: [number, number, number] = [224, 192, 128];
    const input: SeededVolumeInput = {
      dims,
      voxelSizeMm: [0.6, 0.9, 1.4],
      volume: new Float32Array(dims[0] * dims[1] * dims[2]),
      foreground: Uint32Array.of(voxelIndex({ x: 112, y: 96, z: 64 }, dims)),
      background: new Uint32Array(),
    };
    const initial = markedRegionBounds(input);
    input.background = Uint32Array.of(voxelIndex({ x: initial.min.x - 1, y: 96, z: 64 }, dims));
    const changed = markedRegionBounds(input);
    expect(changed).not.toEqual(initial);
    for (const index of [...input.foreground, ...input.background]) {
      const point = voxelPoint(index, dims);
      for (const axis of ['x', 'y', 'z'] as const) {
        expect(point[axis]).toBeGreaterThanOrEqual(changed.min[axis]);
        expect(point[axis]).toBeLessThanOrEqual(changed.max[axis]);
      }
    }
    expect(
      (changed.max.x - changed.min.x + 1) * (changed.max.y - changed.min.y + 1) * (changed.max.z - changed.min.z + 1),
    ).toBeLessThanOrEqual(MAX_SEGMENTATION_DOMAIN_VOXELS);
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
    const insideOnly = await segmentSeededVolume({ ...input, background: new Uint32Array() });
    expect(insideOnly.indices).toContain(7);
    const result = await segmentSeededVolume(input);
    expect(result.indices.length).toBeLessThan(insideOnly.indices.length);
    expect(result.indices).toContain(3);
    expect(result.indices).not.toContain(9);
    expect([...result.indices].every((index) => index < 7)).toBe(true);
    const corrected = await segmentSeededVolume({ ...input, background: new Uint32Array([5, 9]) });
    expect(corrected.indices.length).toBeLessThan(result.indices.length);
    expect(corrected.indices).not.toContain(5);
  });

  it.each([true, false])(
    'never crosses missing support or mutates marks with explicit outside marks: %s',
    async (outsideMarks) => {
      const input: SeededVolumeInput = {
        volume: new Float32Array(17).fill(0.7),
        observedSupport: new Uint8Array(17).fill(1),
        dims: [17, 1, 1],
        voxelSizeMm: [1, 1, 1],
        foreground: new Uint32Array([3]),
        background: Uint32Array.from(outsideMarks ? [13] : []),
      };
      input.observedSupport![8] = 0;
      const result = await segmentSeededVolume(input);
      expect([...result.indices].every((index) => index < 8)).toBe(true);
      await expect(segmentSeededVolume({ ...input, foreground: new Uint32Array([8]) })).rejects.toThrow(/acquired/);
      expect(input.foreground).toEqual(new Uint32Array([3]));
    },
  );

  it.each([
    { polarity: 1, frontierMark: false },
    { polarity: -1, frontierMark: false },
    { polarity: 1, frontierMark: true },
  ])(
    'localizes an inside-only structure within an acquired island at polarity $polarity with frontier mark: $frontierMark',
    async ({ polarity, frontierMark }) => {
      const dims: [number, number, number] = [9, 9, 9];
      const volume = new Float32Array(9 ** 3).fill(Number.NaN);
      const observedSupport = new Uint8Array(volume.length);
      const truth = new Uint8Array(volume.length);
      const index = (x: number, y: number, z: number) => (z * 9 + y) * 9 + x;
      for (let z = 1; z <= 7; z++)
        for (let y = 1; y <= 7; y++)
          for (let x = 1; x <= 7; x++) {
            const voxel = index(x, y, z);
            const inside = x >= 3 && x <= 5 && y >= 3 && y <= 5 && z >= 3 && z <= 5;
            observedSupport[voxel] = 1;
            truth[voxel] = inside ? 1 : 0;
            volume[voxel] = 0.4 + (inside ? polarity * 0.3 : 0);
          }
      const foreground = Uint32Array.from(frontierMark ? [index(4, 4, 4), index(1, 4, 4)] : [index(4, 4, 4)]);
      const result = await segmentSeededVolume({
        volume,
        observedSupport,
        dims,
        voxelSizeMm: [1, 1, 1],
        foreground,
        background: new Uint32Array(),
      });
      const selected = new Set(result.indices);
      for (const mark of foreground) expect(selected.has(mark)).toBe(true);
      expect([...selected].every((voxel) => observedSupport[voxel] && Number.isFinite(volume[voxel]))).toBe(true);
      // The intensity boundary must matter even when no acquired pixel touches the rectangular search shell.
      expect(selected.size).toBeLessThan(7 ** 3 / 2);
      expect(segmentationQuality(truth, result.indices).recall).toBe(1);
      if (!frontierMark) expect(segmentationQuality(truth, result.indices).dice).toBeGreaterThan(0.95);
    },
  );

  it.each([1, -1])(
    'keeps enclosed missing-data cavities neutral within a marked structure at polarity %i',
    async (polarity) => {
      const dims: [number, number, number] = [9, 9, 9];
      const volume = new Float32Array(9 ** 3).fill(0.4);
      const observedSupport = new Uint8Array(volume.length).fill(1);
      const truth = new Uint8Array(volume.length);
      const index = (x: number, y: number, z: number) => (z * 9 + y) * 9 + x;
      for (let z = 2; z <= 6; z++)
        for (let y = 2; y <= 6; y++)
          for (let x = 2; x <= 6; x++) {
            const voxel = index(x, y, z);
            truth[voxel] = 1;
            volume[voxel] = 0.4 + polarity * 0.3;
          }
      // One absent observation and one nonfinite observation form an enclosed cavity, not an outside mark.
      const missing = index(4, 4, 4);
      const nonfinite = index(4, 5, 4);
      observedSupport[missing] = 0;
      volume[nonfinite] = Number.NaN;
      truth[missing] = truth[nonfinite] = 0;
      const foreground = Uint32Array.of(index(2, 4, 4));
      const result = await segmentSeededVolume({
        volume,
        observedSupport,
        dims,
        voxelSizeMm: [1, 1, 1],
        foreground,
        background: new Uint32Array(),
      });
      const selected = new Set(result.indices);
      expect(selected.has(foreground[0]!)).toBe(true);
      expect(selected.has(missing)).toBe(false);
      expect(selected.has(nonfinite)).toBe(false);
      expect([...selected].every((voxel) => observedSupport[voxel] && Number.isFinite(volume[voxel]))).toBe(true);
      // Exact synthetic truth checks both the cavity rim and the rest of the structure for artificial erosion.
      expect(segmentationQuality(truth, result.indices)).toEqual({ dice: 1, precision: 1, recall: 1 });
    },
  );

  it('keeps an inside-only suggestion bounded and deterministic with duplicated or reordered marks', async () => {
    const input: SeededVolumeInput = {
      volume: new Float32Array(31).fill(0.7),
      observedSupport: new Uint8Array(31).fill(1),
      dims: [31, 1, 1],
      voxelSizeMm: [1, 1, 1],
      foreground: Uint32Array.of(10, 11),
      background: new Uint32Array(),
      bounds: { min: { x: 4, y: 0, z: 0 }, max: { x: 22, y: 0, z: 0 } },
    };
    input.observedSupport![16] = 0;
    input.volume[15] = Number.NaN;
    const result = await segmentSeededVolume(input);
    const repeated = await segmentSeededVolume({ ...input, foreground: Uint32Array.of(11, 10, 11) });
    expect(repeated.indices).toEqual(result.indices);
    expect(result.bounds).toEqual(input.bounds);
    expect(result.domainVoxels).toBe(19);
    expect([...result.indices]).toEqual(expect.arrayContaining([10, 11]));
    expect([...result.indices].every((index) => index >= 4 && index < 15)).toBe(true);
    expect(
      [...result.indices].every((index) => input.observedSupport![index] && Number.isFinite(input.volume[index])),
    ).toBe(true);
  });

  it.each([
    { dims: [17, 13, 11], spacing: [1, 1, 1] },
    { dims: [17, 13, 11], spacing: [0.45, 1.4, 4] },
    { dims: [17, 13, 1], spacing: [0.7, 1.2, 5] },
    { dims: [17, 1, 11], spacing: [0.7, 1.2, 5] },
    { dims: [1, 13, 11], spacing: [0.7, 1.2, 5] },
    { dims: [1, 1, 17], spacing: [0.7, 1.2, 5] },
    { dims: [1, 1, 1], spacing: [0.7, 1.2, 5] },
  ])(
    'never removes long, cross-plane, or boundary inside marks on $dims at spacing $spacing',
    async ({ dims, spacing }) => {
      const [nx, ny, nz] = dims as [number, number, number];
      const volume = new Float32Array(nx * ny * nz);
      const observedSupport = new Uint8Array(volume.length).fill(1);
      const foreground = [],
        background = [];
      for (let z = 0; z < nz; z++)
        for (let y = 0; y < ny; y++)
          for (let x = 0; x < nx; x++) {
            const index = (z * ny + y) * nx + x;
            volume[index] = 0.5 + 0.3 * Math.sin(index * 0.81);
            if (
              (x === Math.floor(nx / 2) && y === Math.floor(ny / 2)) ||
              (y === Math.floor(ny / 2) && z === Math.floor(nz / 2)) ||
              index === 0 ||
              index === volume.length - 1
            )
              foreground.push(index);
            else if (index % 23 === 0) observedSupport[index] = 0;
            else if (index % 17 === 0) background.push(index);
          }
      const input: SeededVolumeInput = {
        volume,
        observedSupport,
        dims: [nx, ny, nz],
        voxelSizeMm: spacing as [number, number, number],
        foreground: Uint32Array.from(foreground),
        background: Uint32Array.from(background),
      };
      for (const backgroundMarks of [input.background, new Uint32Array()]) {
        const request = { ...input, background: backgroundMarks };
        const first = await segmentSeededVolume(request);
        const repeated = await segmentSeededVolume(request);
        const reordered = await segmentSeededVolume({
          ...request,
          foreground: Uint32Array.from([...foreground].reverse().concat(foreground[0]!)),
          background: backgroundMarks.slice().reverse(),
        });
        expect(repeated.indices).toEqual(first.indices);
        expect(reordered.indices).toEqual(first.indices);
        const selected = new Set(first.indices);
        expect(foreground.filter((index) => !selected.has(index))).toEqual([]);
        expect([...backgroundMarks].filter((index) => selected.has(index))).toEqual([]);
        expect([...selected].every((index) => observedSupport[index])).toBe(true);
      }
      expect(input.foreground).toEqual(Uint32Array.from(foreground));
      expect(input.background).toEqual(Uint32Array.from(background));
    },
  );

  it('preserves disconnected inside islands and honors the latest conflict-resolved mark set on rerun', async () => {
    const input: SeededVolumeInput = {
      volume: new Float32Array(31).fill(0.7),
      observedSupport: new Uint8Array(31).fill(1),
      dims: [31, 1, 1],
      voxelSizeMm: [1, 1, 1],
      foreground: Uint32Array.of(4, 24),
      background: Uint32Array.of(8, 20),
    };
    input.observedSupport![15] = 0;
    const first = await segmentSeededVolume(input);
    expect(first.indices).toContain(4);
    expect(first.indices).toContain(24);
    expect(first.indices).not.toContain(15);
    const corrected = await segmentSeededVolume({
      ...input,
      foreground: Uint32Array.of(4, 20),
      background: Uint32Array.of(8, 24),
    });
    expect(corrected.indices).toContain(4);
    expect(corrected.indices).toContain(20);
    expect(corrected.indices).not.toContain(24);
    expect(corrected.indices).not.toContain(8);
    expect(corrected.indices).not.toContain(15);
    expect(first.indices).toContain(24);
    await expect(segmentSeededVolume({ ...input, background: Uint32Array.of(24) })).rejects.toThrow(/both/);
  });

  it('requires inside marks and rejects contradictions, invalid geometry, and unbounded work', async () => {
    const { input } = anatomy();
    await expect(segmentSeededVolume({ ...input, foreground: new Uint32Array() })).rejects.toThrow(/inside|include/i);
    await expect(
      segmentSeededVolume({ ...input, foreground: new Uint32Array(), background: new Uint32Array() }),
    ).rejects.toThrow(/inside|include/i);
    await expect(segmentSeededVolume({ ...input, background: input.foreground })).rejects.toThrow(/both/);
    await expect(segmentSeededVolume({ ...input, voxelSizeMm: [1, 0, 1] })).rejects.toThrow(/geometry/);
    await expect(segmentSeededVolume({ ...input, foreground: new Uint32Array([0xffffffff]) })).rejects.toThrow(
      /acquired/,
    );
    await expect(
      segmentSeededVolume({ ...input, bounds: { min: { x: 0, y: 0, z: 0 }, max: { x: 1, y: 1, z: 1 } } }),
    ).rejects.toThrow(/every explicit mark/);
  });

  it.each(['exterior', 'geodesic'] as const)(
    'cancels before work and during %s traversal without publishing a partial mask',
    async (phase) => {
      const { input } = anatomy();
      if (phase === 'exterior') {
        input.observedSupport!.fill(0);
        for (const index of [...input.foreground, ...input.background]) input.observedSupport![index] = 1;
      }
      const controller = new AbortController();
      controller.abort();
      await expect(segmentSeededVolume(input, { signal: controller.signal })).rejects.toMatchObject({
        name: 'AbortError',
      });
      const midRun = new AbortController();
      let yields = 0;
      let geodesicProgress = 0;
      await expect(
        segmentSeededVolume(input, {
          signal: midRun.signal,
          yieldFn: async () => {
            yields++;
            midRun.abort();
          },
          onProgress: () => geodesicProgress++,
        }),
      ).rejects.toMatchObject({ name: 'AbortError' });
      expect(yields).toBe(1);
      expect(geodesicProgress).toBe(phase === 'exterior' ? 0 : 1);
    },
  );
});
