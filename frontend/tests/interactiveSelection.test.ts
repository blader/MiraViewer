import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SvrRoiPlane, SvrSelectionSeeds, SvrVolume } from '../src/types/svr';
import { proposeInteractiveSelection } from '../src/utils/segmentation/interactiveSelection';
import type {
  InteractiveTrackingProgress,
  InteractiveTrackingWorkerOptions,
} from '../src/utils/segmentation/interactiveTrackingWorker';
import { SLICE_AXES } from '../src/utils/segmentation/selectionEditing';
import { physicalVolumeBounds, volumeVoxelToPatient } from '../src/utils/svr/volumeGeometry';
import { deferred } from './helpers/deferred';
import { retainMarkedComponents } from '../src/utils/segmentation/seedConnectedSelection';
import { prepareEmptyEditingPlanePruning } from '../src/utils/segmentation/emptyEditingPlane';
import * as scheduling from '../src/utils/svr/svrUtils';
import { planInteractiveSelectionContext } from '../src/utils/svr/interactiveSelectionContext';

const worker = { run: vi.fn(), dispose: vi.fn() };

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
    worker?: { run: typeof worker.run; releaseIdle: typeof worker.dispose };
    retainRuntimeAfterRun?: boolean;
  } = {},
) {
  return proposeInteractiveSelection(
    {
      nativeContext,
      sourceRange: [-25, 100],
      provider: options.provider ?? 'wasm',
      admittedRuntimeBytes: 1234567890,
      retainMarkedComponents: options.retainMarkedComponents,
      worker: options.worker ?? { run: worker.run, releaseIdle: worker.dispose },
      retainRuntimeAfterRun: options.retainRuntimeAfterRun,
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
  delivered?: Array<[number, 1 | -1]>,
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
      delivered?.push([frame, direction]);
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
});
afterEach(() => vi.restoreAllMocks());

describe('native interactive proposals on the existing editing grid', () => {
  it('borrows a source-owned runtime for successive corrections without disposing it before publication', async () => {
    const source = volume();
    const borrowed = { run: vi.fn(emitAll), releaseIdle: vi.fn() };
    const first = await propose(source, source, seeds(source), { worker: borrowed, retainRuntimeAfterRun: true });
    const second = await propose(source, source, seeds(source), { worker: borrowed, retainRuntimeAfterRun: true });
    expect(first.data).toEqual(second.data);
    expect(borrowed.run).toHaveBeenCalledTimes(2);
    expect(borrowed.releaseIdle).not.toHaveBeenCalled();
    expect(worker.run).not.toHaveBeenCalled();
  });

  it('decodes the same compressed overview prompts counted by preflight, preserving every mark', async () => {
    const native = volume([16, 16, 5], { voxelSizeMm: [1, 1, 1] });
    const editing = volume([8, 8, 5], { voxelSizeMm: [2, 2, 1] });
    const marks = {
      foreground: Uint32Array.from([1, 2, 3].flatMap((y) => [1, 2, 3].map((x) => index(editing, x, y, 2)))),
      background: Uint32Array.of(index(editing, 6, 6, 2), index(editing, 6, 6, 3)),
      lastStroke: { plane: 'axial' as const, slice: 2 },
    };
    const original = { foreground: marks.foreground.slice(), background: marks.background.slice() };
    const plan = planInteractiveSelectionContext(editing, native, marks);
    await propose(native, editing, marks);
    const options = worker.run.mock.calls[0]![0] as InteractiveTrackingWorkerOptions;
    const frames = [{ points: options.points }, ...options.markedFrames!];
    expect(plan.literalMarkCount).toBe(11);
    expect(plan.conditioningFrames).toBe(frames.length);
    expect(plan.maximumFramePrompts).toBe(Math.max(...frames.map((frame) => frame.points.length)));
    expect(options).toMatchObject({
      anchorIndex: 2,
      points: [
        [4, 4],
        [12, 12],
      ],
      labels: [1, 0],
    });
    expect(options.markedFrames).toEqual([{ index: 3, points: [[12, 12]], labels: [0] }]);
    expect(marks.foreground).toEqual(original.foreground);
    expect(marks.background).toEqual(original.background);
  });

  it('rejects an unsupported nonrepresentative native mark before creating the model', async () => {
    const native = volume([8, 8, 3], { voxelSizeMm: [1, 1, 1] });
    const editing = volume([4, 4, 3], { voxelSizeMm: [2, 2, 1] });
    const marks = {
      foreground: Uint32Array.of(index(editing, 1, 1, 1), index(editing, 2, 1, 1)),
      background: new Uint32Array(),
      lastStroke: { plane: 'axial' as const, slice: 1 },
    };
    native.observedSupport![index(native, 4, 2, 1)] = 0;
    await expect(propose(native, editing, marks)).rejects.toThrow(/native-context sample/);
    expect(worker.run).not.toHaveBeenCalled();
  });

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
      expect(worker.run).toHaveBeenCalledTimes(1);
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
      expect(worker.run).not.toHaveBeenCalled();
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
    expect(worker.run).not.toHaveBeenCalled();
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

describe('phase-aware multi-plane proposal progress', () => {
  const preparation = [
    [4, 1],
    [5, 1],
    [6, 1],
    [3, -1],
    [2, -1],
  ] as const;
  function fixture() {
    const source = volume([5, 5, 9]);
    const marks: SvrSelectionSeeds = {
      foreground: Uint32Array.of(index(source, 2, 2, 4), index(source, 2, 2, 2)),
      background: Uint32Array.of(index(source, 1, 1, 4), index(source, 1, 1, 6)),
      lastStroke: { plane: 'axial', slice: 4 },
    };
    return { source, marks };
  }
  function preparing(index: number, direction: 1 | -1, stage = 'frame-complete'): InteractiveTrackingProgress {
    return {
      phase: 'preparing',
      stage,
      index,
      direction,
      completedFrames: 0,
      totalFrames: 10,
      conditioningFrames: 3,
      spatialMemories: 3,
      pointers: 3,
      retainedStateBytes: 395312,
      liveTensorBackingBytes: 0,
    };
  }

  it.each([false, true])(
    'advances only on complete preparation planes and remains monotonic through final coverage and release (pruning: %s)',
    async (pruning) => {
      const { source, marks } = fixture();
      const original = {
        source: source.data.slice(),
        foreground: marks.foreground.slice(),
        background: marks.background.slice(),
      };
      const progress = vi.fn<(value: number) => void>();
      const prepared = deferred<void>(),
        startFinal = deferred<void>(),
        emitted = deferred<void>(),
        release = deferred<void>();
      const delivered: Array<[number, 1 | -1]> = [];
      let resolved = false;
      worker.run.mockImplementation(async (options: InteractiveTrackingWorkerOptions) => {
        const readFrame = vi.spyOn(options, 'readFrame');
        const onFrame = vi.spyOn(options, 'onFrame');
        options.onProgress?.({ phase: 'loading', asset: 'encoder' });
        for (const [index, direction] of preparation) {
          const before = progress.mock.lastCall?.[0] ?? 0;
          await options.readFrame(index, options.signal);
          options.onProgress?.(preparing(index, direction, 'after-encoder'));
          expect(progress.mock.lastCall?.[0] ?? 0).toBe(before);
          options.onProgress?.(preparing(index, direction));
          expect(progress.mock.lastCall?.[0] ?? 0).toBeGreaterThan(before);
          expect(progress.mock.lastCall![0]).toBeLessThan(1);
          expect(onFrame).not.toHaveBeenCalled();
        }
        expect(readFrame.mock.calls.map(([index]) => index)).toEqual([4, 5, 6, 3, 2]);
        const afterPreparation = progress.mock.lastCall![0];
        prepared.resolve();
        await startFinal.promise;
        const result = await emitAll(options, () => new Float32Array(25).fill(-1), delivered);
        expect(progress.mock.calls[preparation.length]?.[0]).toBeGreaterThanOrEqual(afterPreparation);
        expect(readFrame.mock.calls.map(([index]) => index)).toEqual([
          4,
          5,
          6,
          3,
          2,
          ...delivered.map(([index]) => index),
        ]);
        expect(onFrame.mock.calls.map(([frame]) => [frame.index, frame.direction])).toEqual(delivered);
        emitted.resolve();
        await release.promise;
        return result;
      });
      const result = propose(source, source, marks, {
        onProgress: progress,
        ...(pruning ? { retainMarkedComponents: true } : {}),
      }).then((value) => {
        resolved = true;
        return value;
      });
      await Promise.race([prepared.promise, result]);
      expect(resolved).toBe(false);
      expect(delivered).toEqual([]);
      expect(progress).not.toHaveBeenCalledWith(1);
      startFinal.resolve();
      await Promise.race([emitted.promise, result]);
      expect(resolved).toBe(false);
      expect(worker.dispose).not.toHaveBeenCalled();
      expect(progress).not.toHaveBeenCalledWith(1);
      expect(delivered).toEqual([
        ...Array.from({ length: pruning ? 4 : 5 }, (_, i) => [4 + i, 1]),
        ...Array.from({ length: pruning ? 4 : 5 }, (_, i) => [4 - i, -1]),
      ]);
      release.resolve();
      expect((await result).data.every((value) => value === 0)).toBe(true);
      expect(progress).toHaveBeenLastCalledWith(1);
      const values = progress.mock.calls.map(([value]) => value);
      expect(
        values.every(
          (value, i) => Number.isFinite(value) && value >= 0 && value <= 1 && (!i || value >= values[i - 1]!),
        ),
      ).toBe(true);
      expect(source.data).toEqual(original.source);
      expect(marks.foreground).toEqual(original.foreground);
      expect(marks.background).toEqual(original.background);
      expect(worker.dispose).toHaveBeenCalledOnce();
    },
  );

  it('never treats preparation or a progress-only completion report as acknowledged final coverage', async () => {
    const { source, marks } = fixture();
    const progress = vi.fn<(value: number) => void>();
    worker.run.mockImplementation(async (options: InteractiveTrackingWorkerOptions) => {
      for (const [index, direction] of preparation) options.onProgress?.(preparing(index, direction));
      options.onProgress?.({ ...preparing(0, -1), phase: 'frames', stage: 'snapshot-released', completedFrames: 10 });
      return { completedFrames: 10, directionEndpoints: { forward: 8, reverse: 0 } };
    });
    await expect(
      propose(source, source, marks, { onProgress: progress, retainMarkedComponents: true }),
    ).rejects.toThrow(/before every native source plane/);
    expect(progress.mock.calls.some(([value]) => value > 0)).toBe(true);
    expect(progress).not.toHaveBeenCalledWith(1);
    expect(progress.mock.calls.every(([value]) => value < 1)).toBe(true);
    expect(worker.dispose).toHaveBeenCalledOnce();
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
  function emptySeparators(options: InteractiveTrackingWorkerOptions, barriers = [1, 5]) {
    return emitAll(options, (frame) =>
      new Float32Array(options.width * options.height).fill(barriers.includes(frame) ? -1 : 1),
    );
  }
  function sampledTrackingGrid(plane: SvrRoiPlane, stride: number, permuted = false, phase = 0) {
    const nativeAxis = axisIndex[SLICE_AXES[plane].slice];
    const direction: NonNullable<SvrVolume['direction']> = permuted
      ? [0, 0, 1, 1, 0, 0, 0, 1, 0]
      : [1, 0, 0, 0, 1, 0, 0, 0, 1];
    const editingAxis = [0, 1, 2].find((axis) => direction[nativeAxis * 3 + axis] !== 0)!;
    const step = Math.abs(stride);
    const dims: SvrVolume['dims'] = [7, 7, 7];
    dims[nativeAxis] = 6 * step + 2 * phase + 1;
    const native = volume(dims, { voxelSizeMm: [1, 1, 1] });
    const voxelSizeMm: SvrVolume['voxelSizeMm'] = [1, 1, 1];
    voxelSizeMm[editingAxis] = step;
    const origin: [number, number, number] = [0, 0, 0];
    origin[nativeAxis] = phase + (stride < 0 ? 6 * step : 0);
    direction[nativeAxis * 3 + editingAxis] = Math.sign(stride);
    const editing = volume([7, 7, 7], {
      voxelSizeMm,
      direction,
      originMm: volumeVoxelToPatient(native, origin),
    });
    const editingPlane = (['axial', 'coronal', 'sagittal'] as const).find(
      (candidate) => axisIndex[SLICE_AXES[candidate].slice] === editingAxis,
    )!;
    return {
      native,
      editing,
      marks: centralMarks(editing, editingPlane),
      anchor: phase + 3 * step,
      barriers: [phase + step, phase + 5 * step],
    };
  }

  it.each(
    (['axial', 'coronal', 'sagittal'] as const).flatMap((plane) =>
      [-2, 1, 2].flatMap((stride) => [false, true].map((outerMarks) => ({ plane, stride, outerMarks }))),
    ),
  )(
    'completes the whole editing footprint with an identical raw mask in $plane, stride $stride, outer marks $outerMarks',
    async ({ plane, stride, outerMarks }) => {
      const phase = 3,
        step = Math.abs(stride);
      const { native, editing, marks, anchor } = sampledTrackingGrid(plane, stride, true, phase);
      if (outerMarks) {
        const axis = axisIndex[SLICE_AXES[marks.lastStroke!.plane].slice];
        for (const [kind, section] of [
          ['foreground', 0],
          ['background', 6],
        ] as const) {
          const point: [number, number, number] = [3, 3, 3];
          point[axis] = section;
          marks[kind] = Uint32Array.from([...marks[kind], index(editing, ...point)]);
        }
      }
      const upper = phase + 6 * step;
      const traversals: Array<Array<[number, 1 | -1]>> = [];
      worker.run.mockImplementation((options: InteractiveTrackingWorkerOptions) => {
        const delivered: Array<[number, 1 | -1]> = [];
        traversals.push(delivered);
        return emitAll(
          options,
          (frame) =>
            new Float32Array(options.width * options.height).fill(
              frame < phase || frame > upper || (frame - phase) % step === 0 ? 1 : -1,
            ),
          delivered,
        );
      });
      const full = await propose(native, editing, marks);
      const pruned = await propose(native, editing, marks, { retainMarkedComponents: true });
      expect(pruned.data).toEqual(full.data);
      expect(pruned.data.every((value) => value === 1)).toBe(true);
      const first = worker.run.mock.calls[0]![0] as InteractiveTrackingWorkerOptions;
      const { anchorIndex, points, labels, markedFrames, frameCount } = first;
      expect(first.allowDirectionStop).toBeUndefined();
      expect(worker.run.mock.lastCall![0]).toMatchObject({ anchorIndex, points, labels, markedFrames, frameCount });
      expect(traversals[0]).toEqual([
        ...Array.from({ length: frameCount - anchor }, (_, i) => [anchor + i, 1]),
        ...Array.from({ length: anchor + 1 }, (_, i) => [anchor - i, -1]),
      ]);
      expect(traversals[1]).toEqual([
        ...Array.from({ length: upper + 2 - anchor }, (_, i) => [anchor + i, 1]),
        ...Array.from({ length: anchor - phase + 2 }, (_, i) => [anchor - i, -1]),
      ]);
      expect(full.contextLimited).toBe(false);
      expect(full.boundaryCount).toBeGreaterThan(0);
      expect(full.clippedNativeVoxels).toBeGreaterThan(0);
      expect(pruned.contextLimited).toBe(true);
      expect(pruned).not.toHaveProperty('boundaryCount');
      expect(pruned).not.toHaveProperty('clippedNativeVoxels');
      expect(worker.dispose).toHaveBeenCalledTimes(2);
    },
  );

  it('does not mistake a support-trimmed footprint or an interior sampling hole for completed editing coverage', async () => {
    const { native, editing, marks, anchor } = sampledTrackingGrid('axial', 2, false, 3);
    editing.observedSupport!.fill(0, 0, 49);
    editing.observedSupport!.fill(0, 6 * 49);
    const certify = await prepareEmptyEditingPlanePruning(
      native,
      editing,
      marks,
      'axial',
      anchor,
      new AbortController().signal,
    );
    expect(certify).not.toBeNull();
    const positive = new Uint8Array(native.data.length).fill(1);
    expect(await certify!(4, -1, positive)).toBe(false);
    expect(await certify!(14, 1, positive)).toBe(false);
    expect(await certify!(2, -1, positive)).toBe(true);
    expect(await certify!(16, 1, positive)).toBe(true);
  });

  it.each([-2, 2])(
    'uses natural in-range endpoints when a stride %s editing footprint extends beyond the context',
    async (stride) => {
      const native = volume([7, 7, 9], { voxelSizeMm: [1, 1, 1] });
      const editing = volume([7, 7, 7], {
        voxelSizeMm: [1, 1, 2],
        originMm: volumeVoxelToPatient(native, [0, 0, stride > 0 ? -2 : 10]),
        direction: [1, 0, 0, 0, 1, 0, 0, 0, Math.sign(stride)],
      });
      const marks = centralMarks(editing);
      const delivered: Array<[number, 1 | -1]> = [];
      worker.run.mockImplementation((options) => emitAll(options, () => new Float32Array(49).fill(1), delivered));
      const full = await propose(native, editing, marks);
      delivered.length = 0;
      const opted = await propose(native, editing, marks, { retainMarkedComponents: true });
      expect(opted).toEqual(full);
      expect(opted.data.reduce((sum, value) => sum + value, 0)).toBe(5 * 49);
      expect(delivered).toEqual([
        ...Array.from({ length: 5 }, (_, i) => [4 + i, 1]),
        ...Array.from({ length: 5 }, (_, i) => [4 - i, -1]),
      ]);
      expect(opted).toHaveProperty('boundaryCount');
      expect(opted).toHaveProperty('clippedNativeVoxels');
    },
  );

  it.each(['unobserved footprint endpoints', 'outside-context endpoints'] as const)(
    'rejects %s without publishing a fabricated footprint completion',
    async (invalid) => {
      const { native, editing, marks } = sampledTrackingGrid('axial', 2, false, 3);
      worker.run.mockImplementation(async (options: InteractiveTrackingWorkerOptions) => {
        if (invalid === 'unobserved footprint endpoints')
          return { completedFrames: 16, directionEndpoints: { forward: 16, reverse: 2 } };
        const result = await emitAll(options, () => new Float32Array(49).fill(1));
        return { ...result, directionEndpoints: { forward: options.frameCount, reverse: -1 } };
      });
      await expect(propose(native, editing, marks, { retainMarkedComponents: true })).rejects.toThrow(
        /before every native source plane/,
      );
      expect(worker.dispose).toHaveBeenCalledOnce();
    },
  );

  it.each(
    (['axial', 'coronal', 'sagittal'] as const).flatMap((plane) =>
      [-3, -2, 2, 3].flatMap((stride) => [
        { plane, stride, permuted: false, phase: 0 },
        { plane, stride, permuted: true, phase: 1 },
      ]),
    ),
  )(
    'preserves the hard-mark connected mask in native $plane at stride $stride, permutation $permuted, phase $phase',
    async ({ plane, stride, permuted, phase }) => {
      const { native, editing, marks, anchor, barriers } = sampledTrackingGrid(plane, stride, permuted, phase);
      const traversals: Array<Array<[number, 1 | -1]>> = [];
      const original = {
        native: native.data.slice(),
        editing: editing.data.slice(),
        marks: {
          foreground: marks.foreground.slice(),
          background: marks.background.slice(),
          lastStroke: marks.lastStroke && { ...marks.lastStroke },
        },
      };
      worker.run.mockImplementation((options) => {
        const delivered: Array<[number, 1 | -1]> = [];
        traversals.push(delivered);
        return emitAll(
          options,
          (frame) => {
            const logits = new Float32Array(options.width * options.height).fill(barriers.includes(frame) ? -1 : 1);
            if (frame === anchor) logits[3 * options.width + 3] = -1;
            return logits;
          },
          delivered,
        );
      });
      const full = await propose(native, editing, marks);
      const pruned = await propose(native, editing, marks, { retainMarkedComponents: true });
      expect(worker.run.mock.lastCall![0]).toMatchObject({ anchorIndex: anchor, allowDirectionStop: true });
      const end = native.dims[axisIndex[SLICE_AXES[plane].slice]] - 1;
      expect(traversals[0]).toEqual([
        ...Array.from({ length: end - anchor + 1 }, (_, i) => [anchor + i, 1]),
        ...Array.from({ length: anchor + 1 }, (_, i) => [anchor - i, -1]),
      ]);
      expect(traversals[1]).toEqual([
        ...Array.from({ length: barriers[1]! - anchor + 1 }, (_, i) => [anchor + i, 1]),
        ...Array.from({ length: anchor - barriers[0]! + 1 }, (_, i) => [anchor - i, -1]),
      ]);
      const kept = await connected(pruned.data, editing, marks);
      expect(kept).toEqual(await connected(full.data, editing, marks));
      expect(kept.reduce((sum, value) => sum + value, 0)).toBe(3 * 49 - 1);
      expect(pruned.data[marks.foreground[0]!]).toBe(0);
      expect(kept[marks.foreground[0]!]).toBe(1);
      expect(kept[marks.background[0]!]).toBe(0);
      expect(pruned.contextLimited).toBe(true);
      expect(pruned).not.toHaveProperty('boundaryCount');
      expect(pruned).not.toHaveProperty('clippedNativeVoxels');
      expect(native.data).toEqual(original.native);
      expect(editing.data).toEqual(original.editing);
      expect(marks).toEqual(original.marks);
    },
  );

  it('retains diagonal 26-connected editing cells across sampled native frames at stride 2', async () => {
    const native = volume([5, 5, 13], { voxelSizeMm: [1, 1, 1] });
    const editing = volume([5, 5, 7], { voxelSizeMm: [1, 1, 2] });
    const marks = centralMarks(editing);
    worker.run.mockImplementation((options) =>
      emitAll(options, (frame) => {
        const logits = new Float32Array(25).fill(-1);
        if (frame !== 2 && frame !== 10) {
          const coordinate = Math.max(0, Math.min(4, Math.floor(frame / 2) - 1));
          logits[coordinate * 5 + coordinate] = 1;
        }
        return logits;
      }),
    );
    const full = await propose(native, editing, marks);
    const pruned = await propose(native, editing, marks, { retainMarkedComponents: true });
    expect(worker.run.mock.lastCall![0].allowDirectionStop).toBe(true);
    const kept = await connected(pruned.data, editing, marks);
    expect(kept).toEqual(await connected(full.data, editing, marks));
    expect([...kept.keys()].filter((i) => kept[i])).toEqual([
      index(editing, 1, 1, 2),
      index(editing, 2, 2, 3),
      index(editing, 3, 3, 4),
    ]);
  });

  it.each([false, true])(
    'tests sampled editing cells rather than in-plane native positives at stride 2 (sampled positive: %s)',
    async (sampledPositive) => {
      const native = volume([9, 9, 13], { voxelSizeMm: [1, 1, 1] });
      const editing = volume([5, 5, 7], { voxelSizeMm: [2, 2, 2] });
      const marks = centralMarks(editing);
      const traversals: Array<Array<[number, 1 | -1]>> = [];
      worker.run.mockImplementation((options) => {
        const delivered: Array<[number, 1 | -1]> = [];
        traversals.push(delivered);
        return emitAll(
          options,
          (frame) =>
            Float32Array.from({ length: 81 }, (_, i) =>
              frame === 2 || frame === 10 ? (i === (sampledPositive ? 20 : 10) ? 1 : -1) : 1,
            ),
          delivered,
        );
      });
      const full = await propose(native, editing, marks);
      const pruned = await propose(native, editing, marks, { retainMarkedComponents: true });
      expect(worker.run.mock.lastCall![0].allowDirectionStop).toBe(true);
      expect(await connected(pruned.data, editing, marks)).toEqual(await connected(full.data, editing, marks));
      if (sampledPositive) {
        expect(traversals[1]).toEqual(traversals[0]);
        expect(pruned).toEqual(full);
        expect(pruned.data[index(editing, 1, 1, 1)]).toBe(1);
        expect(pruned.data[index(editing, 1, 1, 5)]).toBe(1);
      } else {
        expect(traversals[1]).toEqual([
          [6, 1],
          [7, 1],
          [8, 1],
          [9, 1],
          [10, 1],
          [6, -1],
          [5, -1],
          [4, -1],
          [3, -1],
          [2, -1],
        ]);
        expect(pruned.data.reduce((sum, value) => sum + value, 0)).toBe(75);
        expect(pruned.contextLimited).toBe(true);
        expect(pruned).not.toHaveProperty('boundaryCount');
        expect(pruned).not.toHaveProperty('clippedNativeVoxels');
      }
    },
  );

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
    const marks = centralMarks(editing);
    const traversals: Array<Array<[number, 1 | -1]>> = [];
    worker.run.mockImplementation((options) => {
      const delivered: Array<[number, 1 | -1]> = [];
      traversals.push(delivered);
      return emitAll(options, (frame) => new Float32Array(25).fill(frame % 2 ? -1 : 1), delivered);
    });
    const full = await propose(native, editing, marks);
    const result = await propose(native, editing, marks, { retainMarkedComponents: true });
    expect(worker.run.mock.lastCall![0].allowDirectionStop).toBe(true);
    expect(traversals[1]).toEqual([
      [4, 1],
      [5, 1],
      [6, 1],
      [4, -1],
      [3, -1],
      [2, -1],
      [1, -1],
      [0, -1],
    ]);
    expect(traversals[1]).toEqual(traversals[0]);
    expect(result).toEqual(full);
    expect(await connected(result.data, editing, marks)).toEqual(await connected(full.data, editing, marks));
    expect(result.data.every((value) => value === 1)).toBe(true);
    expect(result).toHaveProperty('boundaryCount');
    expect(result.contextLimited).toBe(false);
  });

  it.each([1, 2].flatMap((stride) => (['foreground', 'background'] as const).map((kind) => ({ stride, kind }))))(
    'retains every frame through an off-anchor literal $kind mark while pruning only the opposite tail at stride $stride',
    async ({ stride, kind }) => {
      const { native, editing, marks, barriers } = sampledTrackingGrid('axial', stride);
      const offAnchor = index(editing, 1, 1, 6);
      marks[kind] = Uint32Array.from([...marks[kind], offAnchor]);
      const delivered: Array<[number, 1 | -1]> = [];
      worker.run.mockImplementation((options) =>
        emitAll(options, (frame) => new Float32Array(49).fill(barriers.includes(frame) ? -1 : 1), delivered),
      );
      const full = await propose(native, editing, marks);
      delivered.length = 0;
      const result = await propose(native, editing, marks, { retainMarkedComponents: true });
      const kept = await connected(result.data, editing, marks);
      expect(kept).toEqual(await connected(full.data, editing, marks));
      expect(kept[offAnchor]).toBe(kind === 'foreground' ? 1 : 0);
      expect(delivered).toEqual([
        ...Array.from({ length: 3 * stride + 1 }, (_, i) => [3 * stride + i, 1]),
        ...Array.from({ length: 2 * stride + 1 }, (_, i) => [3 * stride - i, -1]),
      ]);
      expect(result.contextLimited).toBe(true);
      expect(result).not.toHaveProperty('boundaryCount');
      expect(result).not.toHaveProperty('clippedNativeVoxels');
    },
  );

  it.each(
    [
      { stride: 1, reverse: false },
      { stride: 1, reverse: true },
      { stride: 2, reverse: false },
      { stride: -2, reverse: false },
    ].flatMap((grid) => (['foreground', 'background'] as const).map((kind) => ({ ...grid, kind }))),
  )(
    'crosses early empty sections and the literal $kind fence before pruning: stride $stride, reverse $reverse',
    async ({ stride, reverse, kind }) => {
      const step = Math.abs(stride),
        phase = step === 1 ? 0 : 1;
      const native = volume([5, 5, 12 * step + 2 * phase + 1], { voxelSizeMm: [1, 1, 1] });
      const origin = phase + (stride < 0 ? 12 * step : 0);
      const editing = volume([5, 5, 13], {
        voxelSizeMm: [1, 1, step],
        direction: [1, 0, 0, 0, 1, 0, 0, 0, Math.sign(stride)],
        originMm: volumeVoxelToPatient(native, [0, 0, origin]),
      });
      const editingZ = (logical: number) => (reverse ? 12 - logical : logical);
      const nativeZ = (logical: number) => origin + editingZ(logical) * stride;
      const marks: SvrSelectionSeeds = {
        foreground: Uint32Array.of(index(editing, 2, 2, editingZ(2))),
        background: Uint32Array.of(index(editing, 1, 1, editingZ(2))),
        lastStroke: { plane: 'axial', slice: editingZ(2) },
      };
      const distant = index(editing, 2, 2, editingZ(8));
      marks[kind] = Uint32Array.from([...marks[kind], distant]);
      const original = {
        native: native.data.slice(),
        editing: editing.data.slice(),
        foreground: marks.foreground.slice(),
        background: marks.background.slice(),
        lastStroke: { ...marks.lastStroke },
      };
      const traversals: Array<Array<[number, 1 | -1]>> = [];
      worker.run.mockImplementation((options) => {
        const delivered: Array<[number, 1 | -1]> = [];
        traversals.push(delivered);
        return emitAll(
          options,
          (frame) => {
            const z = (frame - origin) / stride;
            const logical = reverse ? 12 - z : z;
            const body =
              (logical >= 1 && logical <= 2) || (logical >= 7 && logical <= 9 && logical !== 8) || logical === 12;
            return new Float32Array(25).fill(body ? 1 : -1);
          },
          delivered,
        );
      });
      const full = await propose(native, editing, marks);
      const keptFull = await connected(full.data, editing, marks);
      expect(full.data[distant]).toBe(0);
      expect(keptFull.reduce((sum, value) => sum + value, 0)).toBe(kind === 'foreground' ? 100 : 49);
      if (kind === 'foreground') {
        const prematurelyStopped = full.data.slice();
        for (let logical = 4; logical <= 12; logical++) {
          const z = editingZ(logical);
          prematurelyStopped.fill(0, z * 25, (z + 1) * 25);
        }
        const repaired = await connected(prematurelyStopped, editing, marks);
        expect(repaired[distant]).toBe(1);
        expect(repaired.reduce((sum, value) => sum + value, 0)).toBe(50);
        expect(repaired).not.toEqual(keptFull);
        expect(keptFull[index(editing, 2, 2, editingZ(7))]).toBe(1);
        expect(keptFull[index(editing, 2, 2, editingZ(9))]).toBe(1);
      }
      const pruned = await propose(native, editing, marks, { retainMarkedComponents: true });
      expect(await connected(pruned.data, editing, marks)).toEqual(keptFull);
      const lower = Math.min(nativeZ(0), nativeZ(10)),
        upper = Math.max(nativeZ(0), nativeZ(10));
      const anchor = nativeZ(2);
      expect(traversals[0]).toEqual([
        ...Array.from({ length: native.dims[2] - anchor }, (_, i) => [anchor + i, 1]),
        ...Array.from({ length: anchor + 1 }, (_, i) => [anchor - i, -1]),
      ]);
      expect(traversals[1]).toEqual([
        ...Array.from({ length: upper - anchor + 1 }, (_, i) => [anchor + i, 1]),
        ...Array.from({ length: anchor - lower + 1 }, (_, i) => [anchor - i, -1]),
      ]);
      expect(pruned.contextLimited).toBe(true);
      expect(pruned).not.toHaveProperty('boundaryCount');
      expect(pruned).not.toHaveProperty('clippedNativeVoxels');
      expect(native.data).toEqual(original.native);
      expect(editing.data).toEqual(original.editing);
      expect(marks.foreground).toEqual(original.foreground);
      expect(marks.background).toEqual(original.background);
      expect(marks.lastStroke).toEqual(original.lastStroke);
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

  it.each([1, 2].flatMap((stride) => (['unsupported', 'nonfinite'] as const).map((kind) => ({ stride, kind }))))(
    'rejects a future $kind native sample before creating an opted model at stride $stride',
    async ({ stride, kind }) => {
      const { native, editing, marks, barriers } = sampledTrackingGrid('axial', stride);
      if (kind === 'unsupported') native.observedSupport![0] = 0;
      else native.data[0] = NaN;
      worker.run.mockImplementation((options) => emptySeparators(options, barriers));
      await expect(propose(native, editing, marks, { retainMarkedComponents: true })).rejects.toThrow(
        /unavailable|nonfinite/,
      );
      expect(worker.run).not.toHaveBeenCalled();
    },
  );

  it.each(
    [1, 2].flatMap((stride) =>
      ['missing endpoints', 'spoofed endpoints', 'early completion', 'ignored barrier'].map((kind) => ({
        stride,
        kind,
      })),
    ),
  )('rejects $kind rather than publishing unknown coverage at stride $stride', async ({ stride, kind }) => {
    const { native, editing, marks, barriers } = sampledTrackingGrid('axial', stride);
    worker.run.mockImplementation(async (options) => {
      if (kind === 'early completion')
        return {
          completedFrames: barriers[1]! - barriers[0]! + 2,
          directionEndpoints: { forward: barriers[1], reverse: barriers[0] },
        };
      if (kind === 'ignored barrier') {
        for (let i = options.anchorIndex; i < options.frameCount; i++)
          await options.onFrame({
            index: i,
            direction: 1,
            initial: i === options.anchorIndex,
            nativeLogits: new Float32Array(options.width * options.height).fill(-1),
          });
      }
      const result = await emptySeparators(options, barriers);
      return kind === 'missing endpoints'
        ? { completedFrames: result.completedFrames }
        : { ...result, directionEndpoints: { forward: options.frameCount - 1, reverse: 0 } };
    });
    await expect(propose(native, editing, marks, { retainMarkedComponents: true })).rejects.toThrow(/native.*plane/);
    expect(worker.dispose).toHaveBeenCalledOnce();
  });

  it.each([1, 2])(
    'cancels the cooperative complete-source validation before a worker exists at stride %s',
    async (stride) => {
      const { native, editing, marks } = sampledTrackingGrid('axial', stride);
      const abort = new AbortController();
      vi.spyOn(scheduling, 'yieldToMain').mockImplementationOnce(async () => abort.abort());
      await expect(
        propose(native, editing, marks, { retainMarkedComponents: true, signal: abort.signal }),
      ).rejects.toMatchObject({ name: 'AbortError' });
      expect(worker.run).not.toHaveBeenCalled();
    },
  );

  it.each([1, 2])(
    'rejects cancellation after a certified traversal without reporting completion at stride %s',
    async (stride) => {
      const { native, editing, marks, barriers } = sampledTrackingGrid('axial', stride);
      const abort = new AbortController(),
        progress = vi.fn();
      worker.run.mockImplementation(async (options) => {
        const result = await emptySeparators(options, barriers);
        abort.abort();
        return result;
      });
      await expect(
        propose(native, editing, marks, {
          retainMarkedComponents: true,
          signal: abort.signal,
          onProgress: progress,
        }),
      ).rejects.toMatchObject({ name: 'AbortError' });
      expect(progress).not.toHaveBeenCalledWith(1);
      expect(worker.dispose).toHaveBeenCalledOnce();
    },
  );

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
