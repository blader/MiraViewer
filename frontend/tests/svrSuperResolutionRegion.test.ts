import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SvrLabelVolume, SvrVolume } from '../src/types/svr';
import { SELECTION_LABEL_META } from '../src/utils/segmentation/selectionEditing';
import {
  assertEnhancementFits,
  cropEnhancementSource,
  enhancementContextFits,
  enhancementSelectionRoi,
  enhancementWorkingBytes,
} from '../src/utils/svr/superResolutionRegion';
import { MAX_SR_OUTPUT_VOXELS } from '../src/utils/svr/superResolutionTypes';
import { SVR_MEMORY_BUDGET_BYTES } from '../src/utils/svr/svrMemoryPlan';

type Triple = [number, number, number];
function volume(dims: Triple = [48, 48, 48]): SvrVolume {
  const count = dims[0] * dims[1] * dims[2];
  return {
    data: Float32Array.from({ length: count }, (_, index) => index - 1234),
    observedSupport: new Uint8Array(count).fill(1),
    dims,
    voxelSizeMm: [0.7, 1.2, 2.5],
    nativeVoxelSizeMm: [0.7, 1.2, 2.5],
    originMm: [10, -20, 30],
    boundsMm: { min: [0, 0, 0], max: [100, 100, 100] },
    intensityRange: [-1234, count - 1235],
    displayWindow: [-100, 900],
    displayInvert: true,
  };
}
const at = (source: SvrVolume, [x, y, z]: Triple) => (z * source.dims[1] + y) * source.dims[0] + x;
function selection(source: SvrVolume, points: Triple[]): SvrLabelVolume {
  const data = new Uint8Array(source.data.length);
  for (const point of points) data[at(source, point)] = 1;
  return {
    data,
    dims: [...source.dims],
    meta: SELECTION_LABEL_META,
    reviewState: 'reviewed',
    seeds: { foreground: Uint32Array.from(points.map((point) => at(source, point))), background: Uint32Array.of(0) },
  };
}
function patient(source: SvrVolume, point: Triple): Triple {
  const direction = source.direction ?? [1, 0, 0, 0, 1, 0, 0, 0, 1];
  return [0, 1, 2].map(
    (axis) =>
      source.originMm[axis]! +
      point.reduce((sum, value, i) => sum + direction[axis * 3 + i]! * value * source.voxelSizeMm[i]!, 0),
  ) as Triple;
}
function cornerBounds(source: SvrVolume, min: Triple, max: Triple) {
  const corners: Triple[] = [];
  for (const x of [min[0], max[0]])
    for (const y of [min[1], max[1]]) for (const z of [min[2], max[2]]) corners.push(patient(source, [x, y, z]));
  return {
    min: [0, 1, 2].map((axis) => Math.min(...corners.map((corner) => corner[axis]!))),
    max: [0, 1, 2].map((axis) => Math.max(...corners.map((corner) => corner[axis]!))),
  };
}
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('native MRI context for learned enhancement', () => {
  it('copies real context around the selection without zeroing unselected tissue or changing annotations', async () => {
    const source = volume();
    const labels = selection(source, [[24, 24, 24]]);
    const beforeData = source.data.slice(),
      beforeMask = labels.data.slice();
    const cropped = await cropEnhancementSource(source, labels);
    expect(cropped.dims).toEqual([33, 33, 33]);
    expect(cropped.originMm).toEqual(patient(source, [8, 8, 8]));
    expect(cropped.voxelSizeMm).toEqual(source.voxelSizeMm);
    expect(cropped.nativeVoxelSizeMm).toEqual(source.nativeVoxelSizeMm);
    expect(cropped.data[0]).toBe(source.data[at(source, [8, 8, 8])]);
    expect(cropped.data[at(cropped, [16, 16, 16])]).toBe(source.data[at(source, [24, 24, 24])]);
    expect(cropped.data.at(-1)).toBe(source.data[at(source, [40, 40, 40])]);
    expect(cropped.data.every((value) => value !== 0)).toBe(true);
    expect(cropped.supportedVoxelCount).toBe(33 ** 3);
    expect(cropped.data.buffer).not.toBe(source.data.buffer);
    expect(cropped.observedSupport!.buffer).not.toBe(source.observedSupport!.buffer);
    expect(cropped.displayWindow).toEqual(source.displayWindow);
    expect(cropped.intensityRange).toEqual(source.intensityRange);
    expect(cropped.displayInvert).toBe(true);
    expect(source.data).toEqual(beforeData);
    expect(labels.data).toEqual(beforeMask);
    expect(labels.reviewState).toBe('reviewed');
    expect([...labels.seeds!.foreground]).toEqual([at(source, [24, 24, 24])]);
    expect([...labels.seeds!.background]).toEqual([0]);
  });

  it('preserves oblique patient coordinates and complete half-voxel crop footprints', async () => {
    const source = volume([64, 50, 40]);
    const c = Math.cos(0.4),
      s = Math.sin(0.4);
    source.direction = [c, -s, 0, s, c, 0, 0, 0, 1];
    const cropped = await cropEnhancementSource(source, selection(source, [[33, 24, 18]]));
    expect(cropped.dims).toEqual([33, 33, 33]);
    expect(cropped.direction).toEqual(source.direction);
    const oracle = cornerBounds(source, [16.5, 7.5, 1.5], [49.5, 40.5, 34.5]);
    for (let axis = 0; axis < 3; axis++) {
      expect(cropped.originMm[axis]).toBeCloseTo(patient(source, [17, 8, 2])[axis]!, 10);
      expect(cropped.boundsMm.min[axis]).toBeCloseTo(oracle.min[axis]!, 10);
      expect(cropped.boundsMm.max[axis]).toBeCloseTo(oracle.max[axis]!, 10);
      expect(patient(cropped, [32, 32, 32])[axis]).toBeCloseTo(patient(source, [49, 40, 34])[axis]!, 10);
    }
  });

  it('requests physical native context around an oblique overview selection without changing the overview', async () => {
    const source = volume([64, 50, 40]);
    source.voxelSizeMm = [1.2, 0.8594, 0.8594];
    source.nativeVoxelSizeMm = [0.6, 0.4297, 0.4297];
    const c = Math.SQRT1_2;
    source.direction = [c, -c, 0, c, c, 0, 0, 0, 1];
    const labels = selection(source, [
      [20, 10, 10],
      [35, 35, 25],
    ]);
    const roi = await enhancementSelectionRoi(source, labels);
    const oracle = cornerBounds(source, [16.5, 6.5, 6.5], [38.5, 38.5, 28.5]);
    expect(roi.mode).toBe('box');
    for (let axis = 0; axis < 3; axis++) {
      expect(roi.boundsMm.min[axis]).toBeCloseTo(oracle.min[axis]!, 10);
      expect(roi.boundsMm.max[axis]).toBeCloseTo(oracle.max[axis]!, 10);
    }
    expect(source.voxelSizeMm).toEqual([1.2, 0.8594, 0.8594]);
    expect(labels.data.reduce((sum, value) => sum + Number(Boolean(value)), 0)).toBe(2);
  });

  it('shifts context inward at source boundaries without allocating invented exterior tissue', async () => {
    const source = volume([40, 48, 56]);
    const cropped = await cropEnhancementSource(source, selection(source, [[1, 2, 3]]));
    expect(cropped.dims).toEqual([33, 33, 33]);
    expect(cropped.originMm).toEqual(source.originMm);
    expect(cropped.data[0]).toBe(source.data[0]);
    expect(cropped.data.at(-1)).toBe(source.data[at(source, [32, 32, 32])]);
    expect(cropped.supportedVoxelCount).toBe(cropped.data.length);
  });

  it('uses real one-sided native context at both acquisition edges without shrinking the minimum extent', async () => {
    const source = volume([64, 64, 64]);
    for (const x of [0, 63]) {
      const roi = await enhancementSelectionRoi(source, selection(source, [[x, 32, 32]]), undefined, source);
      const oracle = cornerBounds(source, [x === 0 ? -0.5 : 31.5, 16, 16], [x === 0 ? 31.5 : 63.5, 48, 48]);
      for (let axis = 0; axis < 3; axis++) {
        expect(roi.boundsMm.min[axis]).toBeCloseTo(oracle.min[axis]!, 10);
        expect(roi.boundsMm.max[axis]).toBeCloseTo(oracle.max[axis]!, 10);
      }
    }
  });

  it('compares complete oblique cell footprints rather than accepting overlapping world-axis boxes', () => {
    const source = volume([64, 64, 64]);
    const c = Math.cos(0.31),
      s = Math.sin(0.31);
    source.direction = [c, -s, 0, s, c, 0, 0, 0, 1];
    const inside = { ...source, dims: [24, 24, 24] as Triple, originMm: patient(source, [20, 20, 20]) };
    expect(enhancementContextFits(source, inside)).toBe(true);
    expect(enhancementContextFits(inside, source)).toBe(false);
    expect(enhancementContextFits(source, { ...inside, originMm: patient(source, [-0.01, 20, 20]) })).toBe(false);
    expect(enhancementContextFits(source, { ...inside, originMm: patient(source, [40, 40, 40]) })).toBe(true);
  });

  it('distinguishes supported zero from padding and nonfinite MRI values', async () => {
    const source = volume([16, 16, 16]);
    source.data[100] = 0;
    source.data[101] = 123;
    source.observedSupport![101] = 0;
    source.data[102] = NaN;
    source.data[103] = Infinity;
    const labels = selection(source, [[8, 8, 8]]);
    labels.data[101] = labels.data[102] = 1;
    const cropped = await cropEnhancementSource(source, labels);
    expect(cropped.dims).toEqual(source.dims);
    expect([...cropped.observedSupport!.slice(100, 104)]).toEqual([1, 0, 0, 0]);
    expect(cropped.data[100]).toBe(0);
    expect(cropped.data[101]).toBe(123);
    expect(cropped.data[102]).toBeNaN();
    expect(cropped.data[103]).toBe(Infinity);
    expect(cropped.supportedVoxelCount).toBe(source.data.length - 3);
    expect(source.observedSupport![102]).toBe(1);
    expect(labels.data[101]).toBe(1);
  });

  it('rejects an empty or entirely unsupported selection and mismatched annotation geometry', async () => {
    const source = volume([8, 8, 8]);
    const labels = selection(source, [[4, 4, 4]]);
    await expect(
      cropEnhancementSource(source, { ...labels, data: new Uint8Array(source.data.length) }),
    ).rejects.toThrow(/mark a region/i);
    source.observedSupport![at(source, [4, 4, 4])] = 0;
    await expect(cropEnhancementSource(source, labels)).rejects.toThrow(/mark a region/i);
    await expect(cropEnhancementSource(source, { ...labels, dims: [8, 4, 16] })).rejects.toThrow(/no longer matches/i);
    await expect(cropEnhancementSource({ ...source, observedSupport: new Uint8Array(2) }, labels)).rejects.toThrow(
      /no longer matches/i,
    );
  });

  it('rejects oversized regions before allocating output samples', async () => {
    const source = volume([130, 130, 130]);
    const labels = selection(source, [
      [0, 0, 0],
      [129, 129, 129],
    ]);
    const allocations: unknown[] = [];
    vi.stubGlobal(
      'Float32Array',
      new Proxy(Float32Array, {
        construct(target, args, newTarget) {
          allocations.push(args[0]);
          return Reflect.construct(target, args, newTarget);
        },
      }),
    );
    await expect(cropEnhancementSource(source, labels)).rejects.toThrow(
      /too large.*original detail will not be reduced/i,
    );
    expect(allocations).toEqual([]);
    expect(source.data.length).toBe(130 ** 3);
    expect(labels.data[0]).toBe(1);
  });

  it.each([NaN, Infinity, -1, 0, 1.5])('rejects unsafe source count %s in admission', (count) => {
    expect(enhancementWorkingBytes(count)).toBe(Infinity);
    expect(() => assertEnhancementFits(count)).toThrow(/too large/i);
  });

  it('accounts for retained owners and never enlarges the output cap', () => {
    expect(() => assertEnhancementFits(MAX_SR_OUTPUT_VOXELS / 8)).not.toThrow();
    expect(() => assertEnhancementFits(MAX_SR_OUTPUT_VOXELS / 8 + 1)).toThrow(/too large/i);
    expect(() => assertEnhancementFits(1, SVR_MEMORY_BUDGET_BYTES)).toThrow(/too large/i);
    expect(() => assertEnhancementFits(1, NaN)).toThrow(/too large/i);
    expect(() => assertEnhancementFits(1, -1)).toThrow(/too large/i);
  });

  it('honors pre-cancellation without changing source samples', async () => {
    const source = volume([8, 8, 8]),
      labels = selection(source, [[4, 4, 4]]);
    const controller = new AbortController();
    controller.abort();
    await expect(cropEnhancementSource(source, labels, { signal: controller.signal })).rejects.toThrow(/cancel/i);
    await expect(enhancementSelectionRoi(source, labels, controller.signal)).rejects.toThrow(/cancel/i);
    expect(source.data[0]).toBe(-1234);
  });

  it('honors cancellation at the final cooperative copy boundary', async () => {
    const source = volume([1, 1, 1]),
      labels = selection(source, [[0, 0, 0]]);
    const controller = new AbortController();
    let yields = 0;
    vi.stubGlobal('scheduler', {
      yield: async () => {
        // The first yield scans labels; the second follows the final copy.
        if (++yields === 2) controller.abort();
      },
    });
    await expect(cropEnhancementSource(source, labels, { signal: controller.signal })).rejects.toThrow(/cancel/i);
    expect(yields).toBe(2);
    expect(source.data[0]).toBe(-1234);
  });

  it.each(['spacing', 'origin', 'direction'] as const)(
    'rejects invalid %s before returning an unusable MRI grid',
    async (field) => {
      const source = volume([8, 8, 8]),
        labels = selection(source, [[4, 4, 4]]);
      if (field === 'spacing') source.voxelSizeMm = [0, 1, 1];
      else if (field === 'origin') source.originMm = [NaN, 0, 0];
      else source.direction = [1, 1, 0, 0, 1, 0, 0, 0, 1];
      await expect(cropEnhancementSource(source, labels)).rejects.toThrow(
        /geometry|spacing|sampling|finite|orthonormal/i,
      );
    },
  );
});
