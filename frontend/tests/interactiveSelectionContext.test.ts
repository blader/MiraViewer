import { describe, expect, it, vi } from 'vitest';
import type { SvrDirection, SvrRoiPlane, SvrSelectionSeeds, SvrVolume } from '../src/types/svr';
import { mapInteractiveMarks } from '../src/utils/segmentation/interactiveGeometry';
import { planTrackingPrompts } from '../src/utils/segmentation/interactivePrompts';
import { voxelIndex } from '../src/utils/segmentation/voxelGeometry';
import {
  cropInteractiveSelectionContext,
  planInteractiveSelectionContext,
} from '../src/utils/svr/interactiveSelectionContext';
import type { NativeSourceGrid } from '../src/utils/svr/nativeSourceContext';
import { physicalVolumeBounds, volumeVoxelToPatient } from '../src/utils/svr/volumeGeometry';

type Triple = [number, number, number];
function grid(dims: Triple = [512, 512, 221], voxelSizeMm: Triple = [0.5, 0.5, 1]): NativeSourceGrid {
  return { dims, voxelSizeMm, originMm: [0, 0, 0] };
}
function volume(geometry: NativeSourceGrid): SvrVolume {
  const count = geometry.dims.reduce((product, size) => product * size, 1);
  return {
    ...geometry,
    data: Float32Array.from({ length: count }, (_, index) => index - 32.5),
    observedSupport: new Uint8Array(count).fill(1),
    boundsMm: physicalVolumeBounds(geometry),
  };
}
const at = (source: NativeSourceGrid, point: Triple) =>
  voxelIndex({ x: point[0], y: point[1], z: point[2] }, source.dims);
function cropped(source: NativeSourceGrid, dims: Triple = [10, 10, 10], offset: Triple = [100, 100, 70]) {
  return volume({ ...source, dims, originMm: volumeVoxelToPatient(source, offset) });
}
function seeds(editing: SvrVolume, plane: SvrRoiPlane = 'axial'): SvrSelectionSeeds {
  return {
    foreground: Uint32Array.of(at(editing, [4, 5, 6])),
    background: new Uint32Array(),
    lastStroke: { plane, slice: plane === 'axial' ? 6 : plane === 'coronal' ? 5 : 4 },
  };
}

describe('source-only interactive context planning', () => {
  it.each([
    ['axial', [160, 160, 221], 76],
    ['coronal', [160, 512, 80], 105],
    ['sagittal', [512, 160, 80], 104],
  ] as const)('keeps full acquired tracking depth in the actual %s plane', (plane, dims, slice) => {
    const source = grid(),
      editing = cropped(source);
    const result = planInteractiveSelectionContext(editing, source, seeds(editing, plane));
    expect(result.grid.dims).toEqual(dims);
    expect([result.width, result.height]).toEqual(plane === 'axial' ? [160, 160] : [160, 80]);
    expect(result.conditioningFrames).toBe(1);
    expect(result.lastStroke).toEqual({ plane, slice });
    expect(result.physicalSizeMm).toEqual([80, 80]);
    expect(result.contextBytes).toBe(dims[0] * dims[1] * dims[2] * 5);
    expect(result.contextVoxels).toBeGreaterThan(2_000_000);
    expect(result.loaderRoi.boundsMm).toEqual(physicalVolumeBounds(result.grid));
  });

  it('counts literal marked sections once even with multiple inside and remove marks on the same frame', () => {
    const source = grid(),
      editing = cropped(source),
      marks = seeds(editing);
    marks.foreground = Uint32Array.of(at(editing, [4, 5, 6]), at(editing, [5, 5, 6]));
    marks.background = Uint32Array.of(at(editing, [6, 6, 6]), at(editing, [7, 6, 6]));
    expect(planInteractiveSelectionContext(editing, source, marks).conditioningFrames).toBe(1);
    marks.background = Uint32Array.of(at(editing, [6, 6, 5]), at(editing, [7, 6, 7]));
    expect(planInteractiveSelectionContext(editing, source, marks).conditioningFrames).toBe(3);
  });

  it('plans one mapped prompt for a connected coarse 3-by-3 brush while retaining all nine literal marks', () => {
    const source = grid([100, 100, 24], [1, 1, 1]);
    const editing = volume({ dims: [10, 10, 5], voxelSizeMm: [3, 3, 1], originMm: [20, 20, 5] });
    const marks: SvrSelectionSeeds = {
      foreground: Uint32Array.from([2, 3, 4].flatMap((y) => [2, 3, 4].map((x) => at(editing, [x, y, 2])))),
      background: new Uint32Array(),
      lastStroke: { plane: 'axial', slice: 2 },
    };
    const originalMarks = marks.foreground.slice();
    const result = planInteractiveSelectionContext(editing, source, marks);
    expect(result).toMatchObject({ conditioningFrames: 1, maximumFramePrompts: 1, literalMarkCount: 9 });
    expect(planTrackingPrompts(editing, result.grid, marks).frames).toEqual([
      { index: 7, points: [[29, 29]], labels: [1] },
    ]);
    expect(marks.foreground).toEqual(originalMarks);
  });

  it('reports the largest mapped frame prompt count, including Remove-only frames, rather than the global total', () => {
    const source = grid([100, 100, 24], [1, 1, 1]);
    const editing = volume({ dims: [10, 10, 6], voxelSizeMm: [3, 3, 2], originMm: [20, 20, 5] });
    const marks: SvrSelectionSeeds = {
      foreground: Uint32Array.from([
        at(editing, [1, 1, 1]),
        at(editing, [2, 1, 1]),
        at(editing, [1, 2, 1]),
        at(editing, [2, 2, 1]),
        at(editing, [7, 1, 1]),
        at(editing, [8, 1, 1]),
        at(editing, [4, 4, 3]),
        at(editing, [5, 4, 3]),
        at(editing, [4, 5, 3]),
        at(editing, [5, 5, 3]),
      ]),
      background: Uint32Array.from([
        at(editing, [6, 7, 1]),
        at(editing, [7, 7, 1]),
        at(editing, [1, 1, 4]),
        at(editing, [1, 2, 4]),
        at(editing, [7, 7, 4]),
        at(editing, [8, 7, 4]),
      ]),
      lastStroke: { plane: 'axial', slice: 4 },
    };
    const result = planInteractiveSelectionContext(editing, source, marks);
    const prompts = planTrackingPrompts(editing, result.grid, marks);
    expect(prompts.frames.map(({ index, labels }) => ({ index, labels }))).toEqual([
      { index: 7, labels: [1, 1, 0] },
      { index: 11, labels: [1] },
      { index: 13, labels: [0, 0] },
    ]);
    expect(prompts.frames.reduce((total, frame) => total + frame.points.length, 0)).toBe(6);
    expect(result).toMatchObject({ conditioningFrames: 3, maximumFramePrompts: 3, literalMarkCount: 16 });
  });

  it('uses all literal inside and remove marks across sections, not a selected-label extent', () => {
    const source = grid([400, 400, 200], [1, 1, 1]);
    const editing = cropped(source, [160, 140, 3], [100, 100, 70]);
    const marks: SvrSelectionSeeds = {
      foreground: Uint32Array.of(at(editing, [5, 5, 1])),
      background: Uint32Array.of(at(editing, [145, 135, 2])),
      lastStroke: { plane: 'axial', slice: 2 },
    };
    const originalForeground = marks.foreground.slice(),
      originalBackground = marks.background.slice();
    const result = planInteractiveSelectionContext(editing, source, marks);
    expect(result.grid.dims).toEqual([205, 205, 200]);
    expect(result.bounds.min.x).toBeLessThanOrEqual(105 - 32);
    expect(result.bounds.max.x).toBeGreaterThanOrEqual(245 + 32);
    expect(result.bounds.min.y).toBeLessThanOrEqual(105 - 32);
    expect(result.bounds.max.y).toBeGreaterThanOrEqual(235 + 32);
    expect(marks.foreground).toEqual(originalForeground);
    expect(marks.background).toEqual(originalBackground);
  });

  it.each([0, 502])('shifts a full field inward at source boundary %s without dropping marks or padding', (offset) => {
    const source = grid(),
      editing = cropped(source, [10, 10, 10], [offset, offset, 0]);
    const result = planInteractiveSelectionContext(editing, source, seeds(editing));
    expect(result.grid.dims).toEqual([160, 160, 221]);
    expect(result.bounds.min.x).toBe(offset ? 352 : 0);
    expect(result.bounds.max.x).toBe(offset ? 511 : 159);
    expect(result.bounds.min.y).toBe(offset ? 352 : 0);
    expect(result.bounds.max.y).toBe(offset ? 511 : 159);
  });

  it('keeps physical aspect within one cell for unequal native in-plane pitches', () => {
    const source = grid([400, 400, 200], [0.6, 0.9, 2.3]);
    const editing = cropped(source);
    const result = planInteractiveSelectionContext(editing, source, seeds(editing));
    expect(result.grid.dims).toEqual([134, 89, 200]);
    expect(result.physicalSizeMm[0]).toBeCloseTo(80.4);
    expect(result.physicalSizeMm[1]).toBeCloseTo(80.1);
  });

  it('shrinks the common physical square only when an acquisition cannot supply the nominal field', () => {
    const source = grid([50, 200, 20], [1, 1, 1]);
    const editing = cropped(source, [10, 10, 10], [0, 0, 0]);
    const result = planInteractiveSelectionContext(editing, source, seeds(editing));
    expect(result.grid.dims).toEqual([50, 50, 20]);
    expect(result.physicalSizeMm).toEqual([50, 50]);
    expect(result.bounds.min.x).toBe(0);
    expect(result.bounds.max.x).toBe(49);
  });

  it('rejects marks that cannot fit a real square field instead of dropping them or stretching a rectangle', () => {
    const source = grid([50, 200, 20], [1, 1, 1]);
    const editing = cropped(source, [10, 110, 10], [0, 0, 0]),
      marks = seeds(editing);
    marks.background = Uint32Array.of(at(editing, [4, 109, 6]));
    expect(() => planInteractiveSelectionContext(editing, source, marks)).toThrow(
      /real source field cannot fit all marks/,
    );
    expect(marks.background[0]).toBe(at(editing, [4, 109, 6]));
  });

  it('allows at most one coarser source cell of physical-size quantization at a limiting edge', () => {
    const source = grid([83, 200, 20], [0.6, 0.9, 2.3]);
    const editing = cropped(source, [10, 10, 10], [0, 0, 0]);
    const result = planInteractiveSelectionContext(editing, source, seeds(editing));
    expect(result.grid.dims).toEqual([83, 56, 20]);
    expect(result.physicalSizeMm[0]).toBeCloseTo(49.8);
    expect(result.physicalSizeMm[1]).toBeCloseTo(50.4);
    expect(Math.abs(result.physicalSizeMm[0] - result.physicalSizeMm[1])).toBeLessThanOrEqual(0.9);
  });

  it('maps an anisotropic oblique overview before choosing bounds and separates its loader AABB', () => {
    const c = Math.cos(0.3),
      s = Math.sin(0.3);
    const direction: SvrDirection = [c, -s, 0, s, c, 0, 0, 0, 1];
    const source = { ...grid(), direction, originMm: [20, -30, 40] as Triple };
    const editing = cropped(source);
    editing.voxelSizeMm = [1, 1, 2];
    const result = planInteractiveSelectionContext(editing, source, seeds(editing));
    expect(result.lastStroke).toEqual({ plane: 'axial', slice: 82 });
    expect(result.grid.dims).toEqual([160, 160, 221]);
    expect(result.bounds.min).toEqual({ x: 28, y: 30, z: 0 });
    expect(result.grid.originMm).toEqual(volumeVoxelToPatient(source, [28, 30, 0]));
    expect(result.loaderRoi.boundsMm.max[0] - result.loaderRoi.boundsMm.min[0]).toBeGreaterThan(80);
    expect(result.physicalSizeMm).toEqual([80, 80]);
  });

  it('maps permuted and flipped editing axes without using the displayed plane name as the tracking axis', () => {
    const source = grid([100, 100, 100], [1, 1, 1]);
    const editing = volume({
      dims: [10, 10, 10],
      voxelSizeMm: [1, 1, 1],
      originMm: [30, 59, 59],
      direction: [0, 0, 1, -1, 0, 0, 0, -1, 0],
    });
    const result = planInteractiveSelectionContext(editing, source, seeds(editing));
    expect(result.lastStroke).toEqual({ plane: 'sagittal', slice: 36 });
    expect(result.grid.dims).toEqual([100, 80, 80]);
    expect(result.bounds.min).toEqual({ x: 0, y: 15, z: 14 });
    const marks = seeds(editing);
    marks.background = Uint32Array.of(at(editing, [7, 7, 6]), at(editing, [4, 5, 7]));
    const multipleSections = planInteractiveSelectionContext(editing, source, marks);
    expect(multipleSections.conditioningFrames).toBe(2);
    expect([multipleSections.width, multipleSections.height]).toEqual([80, 80]);
    expect(multipleSections).toMatchObject({ maximumFramePrompts: 2, literalMarkCount: 3 });
    expect(
      planTrackingPrompts(editing, multipleSections.grid, marks).frames.map(({ index, labels }) => ({ index, labels })),
    ).toEqual([
      { index: 36, labels: [1, 0] },
      { index: 37, labels: [0] },
    ]);
  });

  it.each([
    'missing plane',
    'no inside',
    'unsupported',
    'nonfinite',
    'out of grid',
    'wrong length',
    'fractional phase',
  ])('rejects %s instead of dropping or projecting marks', (failure) => {
    const source = grid(),
      editing = cropped(source),
      marks = seeds(editing);
    if (failure === 'missing plane') delete marks.lastStroke;
    if (failure === 'no inside') marks.foreground = new Uint32Array();
    if (failure === 'unsupported') editing.observedSupport![marks.foreground[0]!] = 0;
    if (failure === 'nonfinite') editing.data[marks.foreground[0]!] = NaN;
    if (failure === 'out of grid') marks.background = Uint32Array.of(editing.data.length);
    if (failure === 'wrong length') editing.observedSupport = new Uint8Array(1);
    if (failure === 'fractional phase') editing.originMm[0] += 1e-8;
    expect(() => planInteractiveSelectionContext(editing, source, marks)).toThrow();
  });
});

describe('exact interactive context extraction', () => {
  it('copies original intensities and validity into exclusive buffers with exact patient geometry', async () => {
    const c = Math.cos(0.3),
      s = Math.sin(0.3);
    const loaded = volume({ ...grid([12, 10, 9], [0.6, 0.9, 2.3]), direction: [c, -s, 0, s, c, 0, 0, 0, 1] });
    const desired = { ...loaded, dims: [5, 4, 9] as Triple, originMm: volumeVoxelToPatient(loaded, [3, 2, 0]) };
    loaded.observedSupport![at(loaded, [4, 3, 2])] = 0;
    loaded.observedSupport![at(loaded, [4, 3, 3])] = 7;
    const original = loaded.data.slice();
    const result = await cropInteractiveSelectionContext(loaded, desired);
    expect(result.data.buffer).not.toBe(loaded.data.buffer);
    expect(result.observedSupport!.buffer).not.toBe(loaded.observedSupport!.buffer);
    expect(result.data.byteLength + result.observedSupport!.byteLength).toBe(5 * 4 * 9 * 5);
    expect(result.originMm).toEqual(desired.originMm);
    expect(result.boundsMm).toEqual(physicalVolumeBounds(desired));
    for (let z = 0; z < 9; z++)
      for (let y = 0; y < 4; y++)
        for (let x = 0; x < 5; x++) {
          expect(result.data[at(result, [x, y, z])]).toBe(loaded.data[at(loaded, [x + 3, y + 2, z])]);
          expect(result.observedSupport![at(result, [x, y, z])]).toBe(
            loaded.observedSupport![at(loaded, [x + 3, y + 2, z])],
          );
        }
    expect(result.supportedVoxelCount).toBe(5 * 4 * 9 - 1);
    expect(loaded.data).toEqual(original);
    expect(mapInteractiveMarks(loaded, result, Uint32Array.of(at(loaded, [4, 3, 3])))).toEqual(
      Uint32Array.of(at(result, [1, 1, 3])),
    );
  });

  it('does not turn unavailable or nonfinite original samples into padded anatomy', async () => {
    const loaded = volume(grid([3, 3, 3], [1, 1, 1]));
    loaded.data[0] = NaN;
    delete loaded.observedSupport;
    const result = await cropInteractiveSelectionContext(loaded, loaded);
    expect(result.data[0]).toBeNaN();
    expect(result.supportedVoxelCount).toBe(26);
    expect(loaded.observedSupport).toBeUndefined();
  });

  it.each(['fractional phase', 'resampled pitch', 'outside', 'flipped', 'samples'])(
    'rejects %s instead of resizing, padding or reordering the planned context',
    async (failure) => {
      const loaded = volume(grid([12, 10, 9], [1, 1, 1]));
      const desired: NativeSourceGrid = { ...grid([5, 4, 9], [1, 1, 1]), originMm: [3, 2, 0] };
      if (failure === 'fractional phase') desired.originMm[0] += 1e-8;
      if (failure === 'resampled pitch') desired.voxelSizeMm[0] = 2;
      if (failure === 'outside') desired.originMm[0] = 11;
      if (failure === 'flipped') desired.direction = [-1, 0, 0, 0, 1, 0, 0, 0, 1];
      if (failure === 'samples') loaded.data = new Float32Array(1);
      await expect(cropInteractiveSelectionContext(loaded, desired)).rejects.toThrow();
    },
  );

  it('rejects pre-cancellation and cancellation during cooperative copying without mutating source buffers', async () => {
    const loaded = volume(grid([12, 10, 9], [1, 1, 1]));
    const controller = new AbortController();
    controller.abort();
    await expect(cropInteractiveSelectionContext(loaded, loaded, { signal: controller.signal })).rejects.toThrow(
      /cancel/,
    );
    const original = loaded.data.slice(),
      during = new AbortController();
    vi.stubGlobal('scheduler', {
      yield: async () => {
        during.abort();
      },
    });
    try {
      await expect(cropInteractiveSelectionContext(loaded, loaded, { signal: during.signal })).rejects.toThrow(
        /cancel/,
      );
      expect(loaded.data).toEqual(original);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
