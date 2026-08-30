import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SvrRoiPlane, SvrSelectionSeeds, SvrVolume } from '../src/types/svr';
import { proposeInteractiveSelection } from '../src/utils/segmentation/interactiveSelection';
import type { InteractiveTrackingWorkerOptions } from '../src/utils/segmentation/interactiveTrackingWorker';
import { SLICE_AXES } from '../src/utils/segmentation/selectionEditing';
import { physicalVolumeBounds, volumeVoxelToPatient } from '../src/utils/svr/volumeGeometry';
import { deferred } from './helpers/deferred';
import { retainMarkedComponents } from '../src/utils/segmentation/seedConnectedSelection';
import { prepareEmptyEditingPlanePruning } from '../src/utils/segmentation/emptyEditingPlane';
import * as scheduling from '../src/utils/svr/svrUtils';

const worker = vi.hoisted(() => ({ run: vi.fn(), dispose: vi.fn(), created: vi.fn() }));
vi.mock('../src/utils/segmentation/interactiveTrackingWorker', () => ({
  InteractiveTrackingWorker: class {
    constructor() {
      worker.created();
    }
    run = worker.run;
    dispose = worker.dispose;
  },
}));

function volume(dims: SvrVolume['dims'] = [4, 5, 3], geometry: Partial<SvrVolume> = {}): SvrVolume {
  const count = dims.reduce((product, size) => product * size, 1);
  const result: SvrVolume = {
    dims,
    voxelSizeMm: [0.5, 0.75, 2],
    originMm: [10, 20, 30],
    boundsMm: { min: [0, 0, 0], max: dims },
    data: Float32Array.from({ length: count }, (_, index) => index - 25),
    observedSupport: new Uint8Array(count).fill(1),
    ...geometry,
  };
  result.boundsMm = physicalVolumeBounds(result);
  return result;
}

function index(source: SvrVolume, x: number, y: number, z: number): number {
  return (z * source.dims[1] + y) * source.dims[0] + x;
}

function seeds(source: SvrVolume, plane: SvrRoiPlane = 'axial'): SvrSelectionSeeds {
  return {
    foreground: Uint32Array.of(index(source, 1, 1, 1)),
    background: Uint32Array.of(index(source, 2, 1, 1)),
    lastStroke: { plane, slice: 1 },
  };
}

function propose(
  nativeContext: SvrVolume,
  editingVolume = nativeContext,
  marks = seeds(editingVolume),
  options: {
    signal?: AbortSignal;
    onProgress?: (value: number) => void;
    provider?: InteractiveTrackingWorkerOptions['provider'];
    retainMarkedComponents?: true;
  } = {},
) {
  return proposeInteractiveSelection(
    {
      nativeContext,
      sourceRange: [-25, 100],
      provider: options.provider ?? 'wasm',
      retainMarkedComponents: options.retainMarkedComponents,
    },
    {
      volume: editingVolume,
      seeds: marks,
      retainedBytes: 1234,
      signal: options.signal ?? new AbortController().signal,
      onProgress: options.onProgress ?? (() => {}),
    },
  );
}

async function emitAll(
  options: InteractiveTrackingWorkerOptions,
  logits?: (frame: number, direction: 1 | -1) => Float32Array,
) {
  let completedFrames = 0;
  const directionEndpoints = { forward: options.anchorIndex, reverse: options.anchorIndex };
  for (const direction of [1, -1] as const)
    for (let frame = options.anchorIndex; frame >= 0 && frame < options.frameCount; frame += direction) {
      const pixels = await options.readFrame(frame, options.signal);
      const decision = await options.onFrame({
        index: frame,
        direction,
        initial: frame === options.anchorIndex,
        nativeLogits: logits?.(frame, direction) ?? new Float32Array(pixels),
      });
      completedFrames++;
      directionEndpoints[direction === 1 ? 'forward' : 'reverse'] = frame;
      if (decision === 'stop-direction') {
        expect(options.allowDirectionStop).toBe(true);
        break;
      }
    }
  return { completedFrames, ...(options.allowDirectionStop ? { directionEndpoints } : {}) };
}

beforeEach(() => {
  worker.run.mockReset();
  worker.run.mockImplementation(emitAll);
  worker.dispose.mockReset();
  worker.created.mockReset();
});
afterEach(() => vi.restoreAllMocks());

describe('native interactive proposals on the existing editing grid', () => {
  it.each(['hybrid', 'gpu-memory'] as const)(
    'passes the explicit %s placement to its owned worker without choosing another runtime',
    async (provider) => {
      const source = volume();
      await propose(source, source, seeds(source), { provider });
      expect(worker.run).toHaveBeenCalledOnce();
      expect(worker.run.mock.calls[0]![0].provider).toBe(provider);
    },
  );

  it.each(['axial', 'coronal', 'sagittal'] as const)(
    'stacks %s predictions on actual native axes without UI flips, MRI tone or mark enforcement',
    async (plane) => {
      const source = volume(undefined, { displayWindow: [-1000, -900], displayInvert: true });
      const before = source.data.slice();
      const marks = seeds(source, plane);
      const result = await propose(source, source, marks);
      expect(result.data).toEqual(Uint8Array.from(source.data, (value) => (value > 0 ? 1 : 0)));
      // A proposal deliberately may disagree with a literal mark: only the hook enforces user edits.
      expect(result.data[marks.foreground[0]!]).toBe(0);
      expect(result.data[marks.background[0]!]).toBe(1);
      expect(source.data).toEqual(before);
      const options = worker.run.mock.calls[0]![0] as InteractiveTrackingWorkerOptions;
      const axes = SLICE_AXES[plane];
      const dimensions = { x: 4, y: 5, z: 3 };
      expect([options.width, options.height, options.frameCount]).toEqual([
        dimensions[axes.column],
        dimensions[axes.row],
        dimensions[axes.slice],
      ]);
      expect(options.sourceRange).toEqual([-25, 100]);
      expect(result.contextLimited).toBe(false);
      expect(worker.created).toHaveBeenCalledTimes(1);
      expect(worker.dispose).toHaveBeenCalledTimes(1);
    },
  );

  it('maps an oblique cropped overview through patient coordinates while keeping its accepted grid', async () => {
    const angle = 0.31;
    const native = volume([10, 9, 7], {
      direction: [Math.cos(angle), -Math.sin(angle), 0, Math.sin(angle), Math.cos(angle), 0, 0, 0, 1],
    });
    const editing = volume([3, 3, 3], {
      direction: native.direction,
      voxelSizeMm: [1, 1.5, 4],
      originMm: volumeVoxelToPatient(native, [2, 1, 0]),
    });
    const original = { data: editing.data.slice(), dims: editing.dims, origin: [...editing.originMm] };
    const marks = seeds(editing);
    const result = await propose(native, editing, marks);
    expect(result.data.length).toBe(editing.data.length);
    for (let z = 0; z < 3; z++)
      for (let y = 0; y < 3; y++)
        for (let x = 0; x < 3; x++)
          expect(result.data[index(editing, x, y, z)]).toBe(
            native.data[index(native, 2 + x * 2, 1 + y * 2, z * 2)]! > 0 ? 1 : 0,
          );
    expect(worker.run.mock.calls[0]![0]).toMatchObject({
      anchorIndex: 2,
      points: [
        [4, 3],
        [6, 3],
      ],
      labels: [1, 0],
    });
    expect(result.contextLimited).toBe(false);
    expect(editing.data).toEqual(original.data);
    expect(editing.dims).toBe(original.dims);
    expect(editing.originMm).toEqual(original.origin);
  });

  it('maps the actual stroke orientation when source and editing axes differ', async () => {
    const native = volume([5, 6, 7]);
    const editing = volume([6, 7, 5], {
      direction: [0, 0, 1, 1, 0, 0, 0, 1, 0],
      voxelSizeMm: [0.75, 2, 0.5],
    });
    await propose(native, editing);
    expect(worker.run.mock.calls[0]![0]).toMatchObject({ width: 6, height: 7, frameCount: 5, anchorIndex: 1 });
  });

  it('uses foreground on the actual last plane even when other foreground planes exist', async () => {
    const source = volume([5, 5, 5]);
    await propose(source, source, {
      foreground: Uint32Array.of(index(source, 1, 1, 0), index(source, 3, 3, 4)),
      background: Uint32Array.of(index(source, 2, 2, 2)),
      lastStroke: { plane: 'axial', slice: 4 },
    });
    expect(worker.run.mock.calls[0]![0]).toMatchObject({
      anchorIndex: 4,
      points: [[3, 3]],
      labels: [1],
      markedFrames: [
        { index: 0, points: [[1, 1]], labels: [1] },
        { index: 2, points: [[2, 2]], labels: [0] },
      ],
    });
  });

  it('uses the nearest real foreground plane for a Remove-only last plane, with stable lower-index ties', async () => {
    const source = volume([5, 5, 5]);
    await propose(source, source, {
      foreground: Uint32Array.of(index(source, 1, 1, 3), index(source, 1, 1, 1)),
      background: Uint32Array.of(index(source, 2, 3, 2)),
      lastStroke: { plane: 'axial', slice: 2 },
    });
    expect(worker.run.mock.calls[0]![0]).toMatchObject({
      anchorIndex: 1,
      markedFrames: [
        { index: 2, points: [[2, 3]], labels: [0] },
        { index: 3, points: [[1, 1]], labels: [1] },
      ],
    });
  });

  it('keeps the first duplicate anchor deterministically without blending predictions', async () => {
    const source = volume([4, 4, 3]);
    worker.run.mockImplementation((options) =>
      emitAll(options, (_frame, direction) => new Float32Array(16).fill(direction)),
    );
    const result = await propose(source);
    expect(result.data.slice(0, 16)).toEqual(new Uint8Array(16));
    expect(result.data.slice(16)).toEqual(new Uint8Array(32).fill(1));
  });

  it('counts each selected face cell once, including corners and edges, without inventing a thick boundary band', async () => {
    const source = volume([4, 5, 3]);
    worker.run.mockImplementation((options) => emitAll(options, () => new Float32Array(20).fill(1)));
    const result = await propose(source);
    expect(result.boundaryCount).toBe(4 * 5 * 3 - 2 * 3 * 1);
  });

  it('reports a limited native context and leaves noncovered editing cells unselected', async () => {
    const editing = volume([7, 7, 5]);
    const native = volume([3, 3, 5], { originMm: volumeVoxelToPatient(editing, [2, 2, 0]) });
    const marks: SvrSelectionSeeds = {
      foreground: Uint32Array.of(index(editing, 3, 3, 2)),
      background: new Uint32Array(),
      lastStroke: { plane: 'axial', slice: 2 },
    };
    worker.run.mockImplementation((options) => emitAll(options, () => new Float32Array(9).fill(1)));
    const result = await propose(native, editing, marks);
    expect(result.contextLimited).toBe(true);
    expect(result.data.reduce((sum, value) => sum + value, 0)).toBe(45);
    expect(result.data[index(editing, 1, 3, 2)]).toBe(0);
  });

  it.each([2, 3])(
    'reports only positive native cells clipped by a smaller accepted region (cube starts at %s)',
    async (start) => {
      const native = volume([10, 10, 10], { voxelSizeMm: [1, 1, 1] });
      const editing = volume([4, 4, 4], {
        voxelSizeMm: native.voxelSizeMm,
        originMm: volumeVoxelToPatient(native, [3, 3, 3]),
      });
      const before = editing.data.slice();
      worker.run.mockImplementation((options) =>
        emitAll(options, (z) =>
          Float32Array.from({ length: 100 }, (_, i) => {
            const x = i % 10,
              y = Math.floor(i / 10);
            return [x, y, z].every((value) => value >= start && value <= 9 - start) ? 1 : -1;
          }),
        ),
      );
      const result = await propose(native, editing);
      expect(result.data.reduce((sum, value) => sum + value, 0)).toBe(64);
      expect(result.clippedNativeVoxels).toBe(start === 2 ? 152 : 0);
      // Neither the inference boundary nor context coverage diagnoses projection clipping.
      expect(result.boundaryCount).toBe(0);
      expect(result.contextLimited).toBe(false);
      expect(editing.dims).toEqual([4, 4, 4]);
      expect(editing.data).toEqual(before);
    },
  );

  it('filters unsupported and nonfinite editing cells without modifying MRI or marks', async () => {
    const native = volume();
    const editing = volume();
    editing.observedSupport![40] = 0;
    editing.data[41] = NaN;
    const marks = seeds(editing);
    const before = marks.foreground.slice();
    const result = await propose(native, editing, marks);
    expect(result.data[40]).toBe(0);
    expect(result.data[41]).toBe(0);
    expect(result.data[42]).toBe(1);
    expect(result.clippedNativeVoxels).toBe(2);
    expect(editing.observedSupport![40]).toBe(0);
    expect(editing.data[41]).toBeNaN();
    expect(marks.foreground).toEqual(before);
  });

  it.each(['missing plane', 'fractional plane', 'noncoplanar plane', 'missing foreground', 'outside mark'])(
    'rejects %s before creating a model',
    async (kind) => {
      const native = volume();
      const editing = volume();
      const marks = seeds(editing);
      if (kind === 'missing plane') delete marks.lastStroke;
      if (kind === 'fractional plane') editing.originMm[2] += 0.1;
      if (kind === 'noncoplanar plane') {
        const angle = 0.2;
        editing.direction = [1, 0, 0, 0, Math.cos(angle), -Math.sin(angle), 0, Math.sin(angle), Math.cos(angle)];
      }
      if (kind === 'missing foreground') marks.foreground = new Uint32Array();
      if (kind === 'outside mark') marks.foreground = Uint32Array.of(0xffffffff);
      await expect(propose(native, editing, marks)).rejects.toThrow(/plane|native-cell|inside|sample/);
      expect(worker.created).not.toHaveBeenCalled();
    },
  );

  it('rejects unavailable real context instead of fabricating padding for the model', async () => {
    const source = volume();
    source.observedSupport![0] = 0;
    await expect(propose(source)).rejects.toThrow(/unavailable/);
    expect(worker.dispose).toHaveBeenCalledTimes(1);
  });

  it.each(['failure', 'missing plane', 'duplicate nonanchor', 'nonfinite logits'])(
    'disposes incomplete %s without returning partial labels',
    async (kind) => {
      const source = volume();
      const before = source.data.slice();
      worker.run.mockImplementation(async (options: InteractiveTrackingWorkerOptions) => {
        if (kind === 'failure') throw new Error('model failed');
        if (kind === 'missing plane') return { completedFrames: options.frameCount + 1 };
        const frame = {
          index: 0,
          direction: 1 as const,
          initial: false,
          nativeLogits: new Float32Array(20).fill(kind === 'nonfinite logits' ? NaN : 1),
        };
        await options.onFrame(frame);
        await options.onFrame(frame);
        return { completedFrames: options.frameCount + 1 };
      });
      await expect(propose(source)).rejects.toThrow(/failed|plane/);
      expect(source.data).toEqual(before);
      expect(worker.dispose).toHaveBeenCalledTimes(1);
    },
  );

  it('cancels before model creation', async () => {
    const source = volume();
    const abort = new AbortController();
    abort.abort();
    await expect(propose(source, source, seeds(source), { signal: abort.signal })).rejects.toMatchObject({
      name: 'AbortError',
    });
    expect(worker.created).not.toHaveBeenCalled();
  });

  it('rejects a cancellation after provisional frames even if a runner returns success', async () => {
    const source = volume();
    const abort = new AbortController();
    worker.run.mockImplementation(async (options: InteractiveTrackingWorkerOptions) => {
      const result = await emitAll(options);
      abort.abort();
      return result;
    });
    const progress = vi.fn();
    await expect(
      propose(source, source, seeds(source), { signal: abort.signal, onProgress: progress }),
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(progress).not.toHaveBeenCalledWith(1);
    expect(worker.dispose).toHaveBeenCalledTimes(1);
  });

  it('waits for successful worker cleanup before resolving a proposal and reports completion only after transfer', async () => {
    const source = volume();
    const release = deferred<void>();
    const emitted = deferred<void>();
    worker.run.mockImplementation(async (options: InteractiveTrackingWorkerOptions) => {
      const result = await emitAll(options);
      emitted.resolve();
      await release.promise;
      return result;
    });
    const progress = vi.fn();
    let resolved = false;
    const result = propose(source, source, seeds(source), { onProgress: progress, provider: 'webgpu' }).then(
      (value) => {
        resolved = true;
        return value;
      },
    );
    await emitted.promise;
    expect(resolved).toBe(false);
    expect(worker.dispose).not.toHaveBeenCalled();
    expect(progress).not.toHaveBeenCalledWith(1);
    expect(worker.run.mock.calls[0]![0].provider).toBe('webgpu');
    release.resolve();
    await result;
    expect(worker.dispose).toHaveBeenCalledTimes(1);
    expect(progress).toHaveBeenLastCalledWith(1);
    const values = progress.mock.calls.map(([value]) => value as number);
    expect(values.every((value, i) => value >= 0 && value <= 1 && (!i || value >= values[i - 1]!))).toBe(true);
  });
});

describe('certified empty editing-plane pruning', () => {
  const axisIndex = { x: 0, y: 1, z: 2 } as const;
  function centralMarks(source: SvrVolume, plane: SvrRoiPlane = 'axial'): SvrSelectionSeeds {
    const point = source.dims.map((size) => Math.floor(size / 2)) as [number, number, number];
    const outside = [...point] as [number, number, number];
    outside[axisIndex[SLICE_AXES[plane].column]]!--;
    return {
      foreground: Uint32Array.of(index(source, ...point)),
      background: Uint32Array.of(index(source, ...outside)),
      lastStroke: { plane, slice: point[axisIndex[SLICE_AXES[plane].slice]] },
    };
  }
  async function connected(data: Uint8Array, source: SvrVolume, marks: SvrSelectionSeeds) {
    const copy = data.slice();
    for (const i of marks.foreground) copy[i] = 1;
    for (const i of marks.background) copy[i] = 0;
    await retainMarkedComponents(copy, source.dims, marks.foreground);
    return copy;
  }
  function emptySeparators(options: InteractiveTrackingWorkerOptions) {
    return emitAll(options, (frame) =>
      new Float32Array(options.width * options.height).fill(frame === 1 || frame === 5 ? -1 : 1),
    );
  }

  it('requires literal true opt-in and accounts for certified work without reporting skipped observations', async () => {
    const source = volume([7, 7, 7]);
    worker.run.mockImplementation(emptySeparators);
    const marks = centralMarks(source);
    await propose(source, source, marks, { retainMarkedComponents: 'false' as unknown as true });
    expect(worker.run.mock.lastCall![0].allowDirectionStop).toBeUndefined();
    const progress = vi.fn();
    await propose(source, source, marks, { retainMarkedComponents: true, onProgress: progress });
    expect(progress.mock.calls.map(([value]) => value)).toEqual(
      [1, 2, 4, 5, 6, 8].map((count) => (0.95 * count) / 8).concat(1),
    );
  });

  it.each(['axial', 'coronal', 'sagittal'] as const)(
    'matches the full connected mask in %s, including reversed grids',
    async (plane) => {
      const native = volume([7, 7, 7], { voxelSizeMm: [1, 1, 1] });
      worker.run.mockImplementation(emptySeparators);
      for (const reversed of [false, true]) {
        const axis = axisIndex[SLICE_AXES[plane].slice];
        const origin: [number, number, number] = [0, 0, 0];
        origin[axis] = reversed ? 6 : 0;
        const direction = [1, 0, 0, 0, 1, 0, 0, 0, 1] satisfies NonNullable<SvrVolume['direction']>;
        if (reversed) direction[axis * 3 + axis] = -1;
        const editing = volume([7, 7, 7], {
          voxelSizeMm: [1, 1, 1],
          direction,
          originMm: volumeVoxelToPatient(native, origin),
        });
        const marks = centralMarks(editing, plane);
        const original = editing.data.slice();
        const full = await propose(native, editing, marks);
        expect(worker.run.mock.lastCall![0].allowDirectionStop).toBeUndefined();
        const pruned = await propose(native, editing, marks, { retainMarkedComponents: true });
        expect(worker.run.mock.lastCall![0].allowDirectionStop).toBe(true);
        expect(await connected(pruned.data, editing, marks)).toEqual(await connected(full.data, editing, marks));
        expect(pruned.data.reduce((a, b) => a + b, 0)).toBe(3 * 49);
        expect(pruned.contextLimited).toBe(true);
        expect(pruned).not.toHaveProperty('boundaryCount');
        expect(pruned).not.toHaveProperty('clippedNativeVoxels');
        expect(editing.data).toEqual(original);
      }
    },
  );

  it('uses the exact inverse editing sampler for coarse in-plane grids, not raw native emptiness', async () => {
    const native = volume([9, 9, 7], { voxelSizeMm: [1, 1, 1] });
    const editing = volume([5, 5, 7], { voxelSizeMm: [2, 2, 1] });
    const marks = centralMarks(editing);
    worker.run.mockImplementation((options) =>
      emitAll(options, (frame) =>
        Float32Array.from({ length: 81 }, (_, i) => (frame === 1 || frame === 5 ? (i === 10 ? 1 : -1) : 1)),
      ),
    );
    const full = await propose(native, editing, marks);
    const pruned = await propose(native, editing, marks, { retainMarkedComponents: true });
    expect(worker.run.mock.lastCall![0].allowDirectionStop).toBe(true);
    expect(await connected(pruned.data, editing, marks)).toEqual(await connected(full.data, editing, marks));
    expect(pruned.data.reduce((a, b) => a + b, 0)).toBe(75);
    expect(pruned).not.toHaveProperty('boundaryCount');
  });

  it('supports signed axis permutations while preserving exact categorical transfer', async () => {
    const native = volume([7, 7, 7], { voxelSizeMm: [1, 1, 1] });
    const editing = volume([7, 7, 7], { voxelSizeMm: [1, 1, 1], direction: [0, 0, 1, 1, 0, 0, 0, 1, 0] });
    worker.run.mockImplementation(emptySeparators);
    const marks = centralMarks(editing);
    const full = await propose(native, editing, marks);
    const pruned = await propose(native, editing, marks, { retainMarkedComponents: true });
    expect(worker.run.mock.lastCall![0].allowDirectionStop).toBe(true);
    expect(await connected(pruned.data, editing, marks)).toEqual(await connected(full.data, editing, marks));
  });

  it('never treats a skipped native zero as an editing separator for [1,0,1] coarse tracking', async () => {
    const native = volume([5, 5, 7], { voxelSizeMm: [1, 1, 1] });
    const editing = volume([5, 5, 4], { voxelSizeMm: [1, 1, 2] });
    worker.run.mockImplementation((options) =>
      emitAll(options, (frame) => new Float32Array(25).fill(frame % 2 ? -1 : 1)),
    );
    const result = await propose(native, editing, centralMarks(editing), { retainMarkedComponents: true });
    expect(worker.run.mock.lastCall![0].allowDirectionStop).toBeUndefined();
    expect(result.data.every((value) => value === 1)).toBe(true);
    expect(result).toHaveProperty('boundaryCount');
    expect(result.contextLimited).toBe(false);
  });

  it.each(['foreground', 'background'] as const)(
    'disables pruning for any off-anchor literal %s mark',
    async (kind) => {
      const source = volume([7, 7, 7]);
      const marks = centralMarks(source);
      marks[kind] = Uint32Array.from([...marks[kind], index(source, 1, 1, 6)]);
      worker.run.mockImplementation(emptySeparators);
      const result = await propose(source, source, marks, { retainMarkedComponents: true });
      expect(worker.run.mock.lastCall![0].allowDirectionStop).toBeUndefined();
      expect(result).toHaveProperty('boundaryCount');
    },
  );

  it('certifies only after target support and never stops on either duplicate anchor', async () => {
    const native = volume([7, 7, 7]);
    const editing = volume([7, 7, 7]);
    editing.observedSupport!.fill(0, 49, 98);
    editing.observedSupport!.fill(0, 245, 294);
    const decisions: Array<[number, 1 | -1, unknown]> = [];
    worker.run.mockImplementation(async (options) => {
      const consume = options.onFrame;
      return emitAll(
        {
          ...options,
          onFrame: async (frame) => {
            const decision = await consume(frame);
            decisions.push([frame.index, frame.direction, decision]);
            return decision;
          },
        },
        (frame) => new Float32Array(49).fill(frame === 3 ? -1 : 1),
      );
    });
    const marks = centralMarks(editing);
    const result = await propose(native, editing, marks, { retainMarkedComponents: true });
    expect(decisions).toEqual([
      [3, 1, undefined],
      [4, 1, undefined],
      [5, 1, 'stop-direction'],
      [3, -1, undefined],
      [2, -1, undefined],
      [1, -1, 'stop-direction'],
    ]);
    // The adapter still does not apply marks. Its consumer supplies both hard classes.
    expect(result.data[marks.foreground[0]!]).toBe(0);
    const kept = await connected(result.data, editing, marks);
    expect(kept[marks.foreground[0]!]).toBe(1);
    expect(kept[marks.background[0]!]).toBe(0);
  });

  it('preserves full metadata when eligible traversal never prunes a tail', async () => {
    const source = volume([7, 7, 7]);
    worker.run.mockImplementation((options) => emitAll(options, () => new Float32Array(49).fill(1)));
    const full = await propose(source, source, centralMarks(source));
    expect(await propose(source, source, centralMarks(source), { retainMarkedComponents: true })).toEqual(full);
  });

  it.each(['unsupported', 'nonfinite'] as const)(
    'rejects a future %s native sample before creating an opted model',
    async (kind) => {
      const source = volume([7, 7, 7]);
      if (kind === 'unsupported') source.observedSupport![0] = 0;
      else source.data[0] = NaN;
      worker.run.mockImplementation(emptySeparators);
      await expect(propose(source, source, centralMarks(source), { retainMarkedComponents: true })).rejects.toThrow(
        /unavailable|nonfinite/,
      );
      expect(worker.created).not.toHaveBeenCalled();
    },
  );

  it.each(['missing endpoints', 'spoofed endpoints', 'early completion', 'ignored barrier'] as const)(
    'rejects %s rather than publishing unknown coverage',
    async (kind) => {
      const source = volume([7, 7, 7]);
      worker.run.mockImplementation(async (options) => {
        if (kind === 'early completion') return { completedFrames: 6, directionEndpoints: { forward: 5, reverse: 1 } };
        if (kind === 'ignored barrier') {
          for (let i = options.anchorIndex; i < options.frameCount; i++)
            await options.onFrame({
              index: i,
              direction: 1,
              initial: i === options.anchorIndex,
              nativeLogits: new Float32Array(49).fill(-1),
            });
        }
        const result = await emptySeparators(options);
        return kind === 'missing endpoints'
          ? { completedFrames: result.completedFrames }
          : { ...result, directionEndpoints: { forward: 6, reverse: 0 } };
      });
      await expect(propose(source, source, centralMarks(source), { retainMarkedComponents: true })).rejects.toThrow(
        /native.*plane/,
      );
      expect(worker.dispose).toHaveBeenCalledOnce();
    },
  );

  it('cancels the cooperative complete-source validation before a worker exists', async () => {
    const source = volume([7, 7, 7]);
    const abort = new AbortController();
    vi.spyOn(scheduling, 'yieldToMain').mockImplementationOnce(async () => abort.abort());
    await expect(
      propose(source, source, centralMarks(source), { retainMarkedComponents: true, signal: abort.signal }),
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(worker.created).not.toHaveBeenCalled();
  });

  it('rejects cancellation after a certified traversal without reporting completion', async () => {
    const source = volume([7, 7, 7]);
    const abort = new AbortController(),
      progress = vi.fn();
    worker.run.mockImplementation(async (options) => {
      const result = await emptySeparators(options);
      abort.abort();
      return result;
    });
    await expect(
      propose(source, source, centralMarks(source), {
        retainMarkedComponents: true,
        signal: abort.signal,
        onProgress: progress,
      }),
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(progress).not.toHaveBeenCalledWith(1);
    expect(worker.dispose).toHaveBeenCalledOnce();
  });

  it('rejects small coefficient errors that accumulate beyond an exact editing-grid lattice', async () => {
    const native = volume([201, 3, 3], { originMm: [10_000_000, 20, 30], voxelSizeMm: [1, 1, 1] });
    const editing = volume([201, 3, 3], {
      originMm: native.originMm,
      voxelSizeMm: native.voxelSizeMm,
      direction: [1, -1e-8, 0, 1e-8, 1, 0, 0, 0, 1],
    });
    expect(
      await prepareEmptyEditingPlanePruning(
        native,
        editing,
        centralMarks(editing),
        'axial',
        1,
        new AbortController().signal,
      ),
    ).toBeNull();
  });

  it.each([{ voxelSizeMm: [1, 1, 0.5] }, { originMm: [10.25, 20, 30] }])(
    'does not certify fractional lattice geometry %j',
    async (geometry) => {
      const native = volume([7, 7, 7], { voxelSizeMm: [1, 1, 1] });
      const editing = volume([7, 7, 7], geometry as Partial<SvrVolume>);
      expect(
        await prepareEmptyEditingPlanePruning(
          native,
          editing,
          centralMarks(editing),
          'axial',
          3,
          new AbortController().signal,
        ),
      ).toBeNull();
    },
  );
});
