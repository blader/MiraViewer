import { useState } from 'react';
import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SvrLabelVolume, SvrVolume } from '../src/types/svr';
import { useSvrEnhancement } from '../src/hooks/useSvrEnhancement';
import { useSvrSelection } from '../src/hooks/useSvrSelection';
import { SeededVolumeWorker } from '../src/utils/segmentation/seededVolumeWorker';
import { SELECTION_LABEL_META } from '../src/utils/segmentation/selectionEditing';
import type { EnhancementSourceLoader } from '../src/utils/svr/superResolutionRegion';
import type { SvrEnhancedVolume } from '../src/utils/svr/superResolutionTypes';
import { runSuperResolution } from '../src/utils/svr/superResolutionWorker';
import {
  ENHANCED_TEXTURE_BYTES_PER_VOXEL,
  ORIGINAL_ROI_TEXTURE_BYTES_PER_VOXEL,
} from '../src/utils/svr/enhancedVolumeBinding';

vi.mock('../src/utils/svr/superResolutionWorker', () => ({ runSuperResolution: vi.fn() }));
const worker = vi.mocked(runSuperResolution);

function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
function volume(): SvrVolume {
  return {
    data: Float32Array.from({ length: 64 }, (_, index) => index - 10),
    observedSupport: new Uint8Array(64).fill(1),
    dims: [4, 4, 4],
    voxelSizeMm: [2, 3, 4],
    originMm: [10, -20, 30],
    boundsMm: { min: [9, -21.5, 28], max: [17, -9.5, 44] },
    displayWindow: [-10, 50],
    intensityRange: [-10, 53],
  };
}
function selection(source: SvrVolume): SvrLabelVolume {
  const data = new Uint8Array(source.data.length);
  data[5] = data[6] = 1;
  return {
    data,
    dims: [...source.dims],
    meta: SELECTION_LABEL_META,
    reviewState: 'reviewed',
    seeds: { foreground: Uint32Array.of(5, 6), background: Uint32Array.of(7) },
  };
}
function enhanced(source: SvrVolume, value = 1): SvrEnhancedVolume {
  return {
    data: new Float32Array(source.data.length * 8).fill(value),
    observedSupport: new Uint8Array(source.data.length * 8).fill(1),
    dims: source.dims.map((size) => size * 2) as [number, number, number],
    voxelSizeMm: source.voxelSizeMm.map((pitch) => pitch / 2) as [number, number, number],
    originMm: source.originMm.map((origin, axis) => origin - source.voxelSizeMm[axis]! / 4) as [number, number, number],
    boundsMm: source.boundsMm,
    intensityRange: source.intensityRange,
    displayWindow: source.displayWindow,
    stats: {
      method: 'test learned result',
      trainingSamples: 128,
      calibrationSamples: 32,
      heldOutSamples: 32,
      trainingBlocks: 8,
      calibrationBlocks: 3,
      heldOutBlocks: 3,
      baselineMse: 4,
      enhancedMse: 3,
      consistencyMaxError: 0,
      durationMs: 100,
      modelStrength: 0.5,
    },
  };
}
type Props = Parameters<typeof useSvrEnhancement>[0];
function setup(overrides: Partial<Props> = {}) {
  const base = overrides.volume ?? volume();
  const props: Props = { volume: base, labels: selection(base), ...overrides };
  return { ...renderHook((input: Props) => useSvrEnhancement(input), { initialProps: props }), props };
}
const measurement = (source: SvrVolume, labels: SvrLabelVolume) =>
  labels.data.reduce((count, label) => count + Number(label !== 0), 0) *
  source.voxelSizeMm.reduce((product, pitch) => product * pitch, 1);

beforeEach(() => {
  worker.mockReset();
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('display-only learned MRI enhancement lifecycle', () => {
  it('retains completed detail through confirming strokes and mark-only history, but not a changed selection', async () => {
    vi.useFakeTimers();
    const source = volume();
    const output = enhanced(source);
    const loadSource = vi.fn<EnhancementSourceLoader>().mockResolvedValue(source);
    const grow = vi.spyOn(SeededVolumeWorker.prototype, 'run').mockResolvedValue({
      indices: Uint32Array.of(5, 6),
      bounds: { min: { x: 0, y: 0, z: 0 }, max: { x: 3, y: 3, z: 3 } },
      boundaryCount: 0,
      domainVoxels: source.data.length,
    });
    worker.mockResolvedValue(output);
    const { result } = renderHook(() => {
      const [labels, setLabels] = useState<SvrLabelVolume | null>(null);
      const selection = useSvrSelection(source, labels, setLabels, true);
      const enhancement = useSvrEnhancement({ volume: source, labels, loadSource, blocked: selection.status.running });
      return { labels, selection, enhancement };
    });
    act(() => result.current.selection.stroke(Uint32Array.of(5), 'include'));
    await act(async () => vi.advanceTimersByTimeAsync(350));
    await act(async () =>
      expect(await result.current.enhancement.run(result.current.selection.prepareEnhancement)).toBe(true),
    );
    act(() => result.current.enhancement.setStrength(0.35));
    const displayedMask = result.current.labels!.data;
    const retainedBytes = result.current.enhancement.retainedBytes;

    for (const [index, kind] of [
      [6, 'include'],
      [7, 'exclude'],
    ] as const) {
      act(() => {
        result.current.selection.cancel(); // The real editor cancels at pointer-down.
        result.current.selection.stroke(Uint32Array.of(index), kind);
      });
      await act(async () => vi.advanceTimersByTimeAsync(1000));
      expect(result.current.labels!.data).toBe(displayedMask);
      expect(result.current.labels!.reviewState).toBe('draft');
      expect(result.current.enhancement).toMatchObject({
        result: output,
        source,
        enabled: true,
        strength: 0.35,
        retainedBytes,
        running: false,
      });
      expect(result.current.enhancement.result).toBe(output);
    }
    expect(result.current.labels!.seeds).toEqual({ foreground: Uint32Array.of(5, 6), background: Uint32Array.of(7) });
    for (const direction of ['undo', 'redo'] as const) {
      act(() => result.current.selection.travel(direction));
      expect(result.current.labels!.data).toBe(displayedMask);
      expect(result.current.enhancement.result).toBe(output);
      expect(result.current.enhancement.strength).toBe(0.35);
      expect(result.current.labels!.seeds!.background).toHaveLength(direction === 'undo' ? 0 : 1);
    }
    expect(grow).toHaveBeenCalledOnce();
    expect(worker).toHaveBeenCalledOnce();
    expect(loadSource).toHaveBeenCalledOnce();

    act(() => result.current.selection.stroke(Uint32Array.of(6), 'exclude'));
    expect(result.current.labels!.data).not.toBe(displayedMask);
    expect(displayedMask[6]).toBe(1);
    expect(result.current.labels!.data[6]).toBe(0);
    expect(result.current.enhancement.result).toBeNull();
    act(() => result.current.selection.cancel());
  });

  it('prepares disposable memory before loading and counts only the resources that remain', async () => {
    const native = volume();
    const prepareMemory = vi.fn(() => 1234);
    const loadSource = vi.fn<EnhancementSourceLoader>().mockImplementation(async (_labels, options) => {
      expect(prepareMemory).toHaveBeenCalledOnce();
      expect(options.retainedBytes).toBe(1234);
      return native;
    });
    worker.mockResolvedValue(enhanced(native));
    const { result } = setup({ loadSource });
    await act(async () => expect(await result.current.run(prepareMemory)).toBe(true));
    expect(loadSource).toHaveBeenCalledOnce();
    expect(worker).toHaveBeenCalledOnce();
  });

  it('surfaces an active selection operation instead of loading or clearing its work', async () => {
    const loadSource = vi.fn<EnhancementSourceLoader>();
    const { result, props } = setup({ loadSource });
    const labels = props.labels;
    const prepareMemory = vi.fn(() => {
      throw new Error('Wait for boundary suggestions to finish.');
    });
    await act(async () => expect(await result.current.run(prepareMemory)).toBe(false));
    expect(result.current).toMatchObject({ running: false, error: 'Wait for boundary suggestions to finish.' });
    expect(props.labels).toBe(labels);
    expect(loadSource).not.toHaveBeenCalled();
    expect(worker).not.toHaveBeenCalled();
  });

  it('includes live annotation history and a retained grower source in every admission, including reruns', async () => {
    const native = volume(),
      output = enhanced(native);
    const loadSource = vi.fn<EnhancementSourceLoader>().mockResolvedValue(native);
    worker.mockResolvedValue(output);
    const { result } = setup({ loadSource });
    await act(async () => {
      await result.current.run(12345);
    });
    expect(loadSource.mock.calls[0]![1].retainedBytes).toBe(12345);
    await act(async () => {
      await result.current.run(6789);
    });
    expect(loadSource.mock.calls[1]![1].retainedBytes).toBe(
      6789 +
        native.data.byteLength +
        native.observedSupport!.byteLength +
        output.data.byteLength +
        output.observedSupport.byteLength +
        output.data.length * ENHANCED_TEXTURE_BYTES_PER_VOXEL +
        native.data.length * ORIGINAL_ROI_TEXTURE_BYTES_PER_VOXEL,
    );
  });

  it.each(['independent', 'accepted-source', 'mask-support', 'shared-result-buffer'] as const)(
    'counts completed CPU/GPU owners without charging shared MRI or annotations twice (%s)',
    async (ownership) => {
      const base = volume(),
        labels = selection(base);
      const native = ownership === 'accepted-source' ? base : volume();
      if (ownership === 'mask-support') native.observedSupport = labels.data;
      const output = enhanced(native);
      if (ownership === 'shared-result-buffer')
        output.observedSupport = new Uint8Array(output.data.buffer, 0, output.data.length);
      const loadSource = vi.fn<EnhancementSourceLoader>().mockResolvedValue(native);
      worker.mockResolvedValue(output);
      const { result, rerender } = setup({ volume: base, labels, loadSource });
      await act(async () => {
        await result.current.run();
      });
      const cpuSource =
        ownership === 'accepted-source'
          ? 0
          : native.data.byteLength + (ownership === 'mask-support' ? 0 : native.observedSupport!.byteLength);
      const cpuOutput =
        output.data.byteLength + (ownership === 'shared-result-buffer' ? 0 : output.observedSupport.byteLength);
      const bytes =
        cpuSource +
        cpuOutput +
        output.data.length * ENHANCED_TEXTURE_BYTES_PER_VOXEL +
        native.data.length * ORIGINAL_ROI_TEXTURE_BYTES_PER_VOXEL;
      expect(result.current.retainedBytes).toBe(bytes);
      act(() => {
        result.current.setEnabled(false);
        result.current.setStrength(0.35);
      });
      expect(result.current.retainedBytes).toBe(bytes);
      rerender({ volume: base, labels, loadSource, blocked: true });
      expect(result.current).toMatchObject({
        result: output,
        source: native,
        enabled: false,
        strength: 0.35,
        retainedBytes: bytes,
        running: false,
      });
      await act(async () => {
        expect(await result.current.run()).toBe(false);
      });
      rerender({ volume: base, labels, loadSource, blocked: false });
      expect(result.current.result).toBe(output);
      expect(result.current.source).toBe(native);
      expect(result.current.retainedBytes).toBe(bytes);
      expect(worker).toHaveBeenCalledOnce();
      expect(loadSource).toHaveBeenCalledOnce();
      act(() => result.current.clear());
      expect(result.current.retainedBytes).toBe(0);
    },
  );

  it.each([-1, NaN, Infinity, 0.5])(
    'rejects an invalid additional retained budget %s before loading',
    async (bytes) => {
      const loadSource = vi.fn<EnhancementSourceLoader>();
      const { result } = setup({ loadSource });
      await act(async () => {
        expect(await result.current.run(bytes)).toBe(false);
      });
      expect(result.current.error).toMatch(/retained-memory/);
      expect(loadSource).not.toHaveBeenCalled();
      expect(worker).not.toHaveBeenCalled();
    },
  );

  it.each(['volume', 'labels', 'blocked'] as const)('does not load or run when %s is unavailable', async (missing) => {
    const loadSource = vi.fn<EnhancementSourceLoader>();
    const { result } = setup({ loadSource, ...(missing === 'blocked' ? { blocked: true } : { [missing]: null }) });
    await act(async () => {
      expect(await result.current.run()).toBe(false);
    });
    expect(result.current).toMatchObject({ result: null, source: null, running: false, enabled: false });
    expect(loadSource).not.toHaveBeenCalled();
    expect(worker).not.toHaveBeenCalled();
  });

  it('publishes the privately loaded native source with its result, without changing MRI, marks, or measurements', async () => {
    const base = volume(),
      labels = selection(base),
      native = volume();
    native.voxelSizeMm = [1, 1.5, 2];
    const loaded = deferred<SvrVolume>(),
      learned = deferred<SvrEnhancedVolume>();
    const loadSource = vi.fn<EnhancementSourceLoader>().mockReturnValue(loaded.promise);
    worker.mockReturnValue(learned.promise);
    const originalData = base.data.slice(),
      originalLabels = labels.data.slice(),
      originalMeasurement = measurement(base, labels);
    const output = enhanced(native);
    const { result } = setup({ volume: base, labels, loadSource });
    let pending!: Promise<unknown>;
    act(() => {
      pending = result.current.run();
    });
    expect(result.current.running).toBe(true);
    expect(result.current.source).toBeNull();
    expect(worker).not.toHaveBeenCalled();
    await act(async () => {
      loaded.resolve(native);
    });
    expect(worker).toHaveBeenCalledWith(
      native,
      expect.objectContaining({ signal: loadSource.mock.calls[0]![1].signal }),
    );
    act(() =>
      worker.mock.calls[0]![1]!.onProgress!({
        phase: 'enhancing',
        current: 1,
        total: 1,
        message: 'Finishing inference',
      }),
    );
    expect(result.current.progress).toBe(1);
    await act(async () => {
      learned.resolve(output);
      expect(await pending).toBe(true);
    });
    expect(result.current).toMatchObject({ running: false, error: null, enabled: true, progress: 1 });
    expect(result.current.result).toBe(output);
    expect(result.current.source).toBe(native);
    expect(result.current.source).not.toBe(base);
    expect(base.data).toEqual(originalData);
    expect(labels.data).toEqual(originalLabels);
    expect([...labels.seeds!.foreground]).toEqual([5, 6]);
    expect([...labels.seeds!.background]).toEqual([7]);
    expect(labels.reviewState).toBe('reviewed');
    expect(measurement(base, labels)).toBe(originalMeasurement);
  });

  it('uses real unmasked MRI context when no separate native loader is needed', async () => {
    const base = volume(),
      labels = selection(base),
      original = base.data.slice();
    worker.mockImplementation(async (input) => enhanced(input));
    const { result } = setup({ volume: base, labels });
    await act(async () => {
      await result.current.run();
    });
    const input = worker.mock.calls[0]![0];
    expect(input.data).toEqual(original);
    expect(input.data).not.toBe(base.data);
    expect(input.data[7]).toBe(-3);
    expect(labels.data[7]).toBe(0);
    expect(result.current.source).toBe(input);
    expect(base.data).toEqual(original);
  });

  it('switches original/enhanced and presentation strength instantly without loading or learning again', async () => {
    const native = volume(),
      output = enhanced(native);
    const loadSource = vi.fn<EnhancementSourceLoader>().mockResolvedValue(native);
    worker.mockResolvedValue(output);
    const { result, props } = setup({ loadSource });
    await act(async () => {
      await result.current.run();
    });
    const before = measurement(props.volume!, props.labels!);
    act(() => {
      result.current.setEnabled(false);
      result.current.setStrength(0.25);
    });
    expect(result.current).toMatchObject({ enabled: false, strength: 0.25 });
    expect(result.current.source).toBe(native);
    expect(result.current.result).toBe(output);
    act(() => {
      result.current.setEnabled(true);
      result.current.setStrength(2);
    });
    expect(result.current).toMatchObject({ enabled: true, strength: 1 });
    act(() => result.current.setStrength(-1));
    expect(result.current.strength).toBe(0);
    act(() => result.current.setStrength(NaN));
    expect(result.current.strength).toBe(0);
    expect(loadSource).toHaveBeenCalledOnce();
    expect(worker).toHaveBeenCalledOnce();
    expect(measurement(props.volume!, props.labels!)).toBe(before);
    expect(props.labels!.reviewState).toBe('reviewed');
  });

  it('cancels source loading and ignores its late completion before submitting any worker request', async () => {
    const loaded = deferred<SvrVolume>();
    const loadSource = vi.fn<EnhancementSourceLoader>().mockReturnValue(loaded.promise);
    const { result } = setup({ loadSource });
    let pending!: Promise<unknown>;
    act(() => {
      pending = result.current.run();
    });
    const signal = loadSource.mock.calls[0]![1].signal!;
    act(() => result.current.cancel());
    expect(signal.aborted).toBe(true);
    expect(result.current).toMatchObject({ running: false, result: null, source: null });
    const message = result.current.message;
    await act(async () => {
      loaded.resolve(volume());
      await pending;
    });
    expect(worker).not.toHaveBeenCalled();
    expect(result.current.message).toBe(message);
    expect(result.current.result).toBeNull();
  });

  it('cancels fitting and ignores late progress and success while retaining original work', async () => {
    const native = volume(),
      learned = deferred<SvrEnhancedVolume>();
    worker.mockReturnValue(learned.promise);
    const loadSource = vi.fn<EnhancementSourceLoader>().mockResolvedValue(native);
    const { result, props } = setup({ loadSource });
    const before = props.labels!.data.slice();
    let pending!: Promise<unknown>;
    await act(async () => {
      pending = result.current.run();
    });
    const options = worker.mock.calls[0]![1]!;
    act(() => result.current.cancel());
    expect(options.signal!.aborted).toBe(true);
    const message = result.current.message;
    act(() => options.onProgress!({ phase: 'enhancing', current: 1, total: 1, message: 'Late worker progress' }));
    await act(async () => {
      learned.resolve(enhanced(native));
      await pending;
    });
    expect(result.current).toMatchObject({ result: null, source: null, error: null, running: false, message });
    expect(props.labels!.data).toEqual(before);
  });

  it.each(['volume', 'selection', 'blocked'] as const)(
    'invalidates an active result on %s replacement and cannot publish it over the next run',
    async (change) => {
      const firstNative = volume(),
        nextNative = volume();
      nextNative.originMm = [100, 200, 300];
      const first = deferred<SvrEnhancedVolume>(),
        next = deferred<SvrEnhancedVolume>();
      const loadSource = vi
        .fn<EnhancementSourceLoader>()
        .mockResolvedValueOnce(firstNative)
        .mockResolvedValueOnce(nextNative);
      worker.mockReturnValueOnce(first.promise).mockReturnValueOnce(next.promise);
      const { result, rerender, props } = setup({ loadSource });
      let oldRun!: Promise<unknown>, newRun!: Promise<unknown>;
      await act(async () => {
        oldRun = result.current.run();
      });
      const oldSignal = worker.mock.calls[0]![1]!.signal!;
      const nextProps: Props = { ...props };
      if (change === 'volume') nextProps.volume = volume();
      if (change === 'selection') nextProps.labels = { ...props.labels!, data: props.labels!.data.slice() };
      if (change === 'blocked') nextProps.blocked = true;
      rerender(nextProps);
      expect(oldSignal.aborted).toBe(true);
      expect(result.current).toMatchObject({ result: null, source: null, running: false, error: null });
      if (change === 'blocked') rerender({ ...nextProps, blocked: false });
      await act(async () => {
        newRun = result.current.run();
      });
      const expected = enhanced(nextNative, 2);
      await act(async () => {
        next.resolve(expected);
        await newRun;
      });
      await act(async () => {
        first.resolve(enhanced(firstNative));
        await oldRun;
      });
      expect(result.current.result).toBe(expected);
      expect(result.current.source).toBe(nextNative);
      expect(result.current.error).toBeNull();
      expect(props.labels!.reviewState).toBe('reviewed');
    },
  );

  it('clears completed display buffers immediately when the selection changes without launching another run', async () => {
    const native = volume();
    const loadSource = vi.fn<EnhancementSourceLoader>().mockResolvedValue(native);
    worker.mockResolvedValue(enhanced(native));
    const { result, props, rerender } = setup({ loadSource });
    await act(async () => {
      await result.current.run();
    });
    expect(result.current.source).toBe(native);
    rerender({ ...props, labels: { ...props.labels!, data: props.labels!.data.slice() } });
    expect(result.current).toMatchObject({ result: null, source: null, enabled: false, running: false });
    expect(worker).toHaveBeenCalledOnce();
    expect(loadSource).toHaveBeenCalledOnce();
  });

  it('keeps the new operation running when an aborted earlier request later fails', async () => {
    const native = volume(),
      first = deferred<SvrEnhancedVolume>(),
      second = deferred<SvrEnhancedVolume>();
    const loadSource = vi.fn<EnhancementSourceLoader>().mockResolvedValue(native);
    worker.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    const { result } = setup({ loadSource });
    let firstRun!: Promise<unknown>, secondRun!: Promise<unknown>;
    await act(async () => {
      firstRun = result.current.run();
    });
    const previousSignal = worker.mock.calls[0]![1]!.signal!;
    await act(async () => {
      secondRun = result.current.run();
    });
    const nextSignal = worker.mock.calls[1]![1]!.signal!;
    expect(previousSignal.aborted).toBe(true);
    await act(async () => {
      first.reject(new Error('Old worker failure'));
      await firstRun;
    });
    expect(result.current.running).toBe(true);
    expect(result.current.error).toBeNull();
    expect(nextSignal.aborted).toBe(false);
    const expected = enhanced(native);
    await act(async () => {
      second.resolve(expected);
      await secondRun;
    });
    expect(result.current.result).toBe(expected);
  });

  it.each(['loading', 'learning'] as const)('aborts %s on unmount and consumes late completion', async (phase) => {
    const native = volume(),
      loaded = deferred<SvrVolume>(),
      learned = deferred<SvrEnhancedVolume>();
    const loadSource = vi
      .fn<EnhancementSourceLoader>()
      .mockReturnValue(phase === 'loading' ? loaded.promise : Promise.resolve(native));
    worker.mockReturnValue(learned.promise);
    const { result, unmount } = setup({ loadSource });
    let pending!: Promise<unknown>;
    await act(async () => {
      pending = result.current.run();
    });
    const signal = loadSource.mock.calls[0]![1].signal!;
    unmount();
    expect(signal.aborted).toBe(true);
    await act(async () => {
      if (phase === 'loading') loaded.resolve(native);
      else learned.resolve(enhanced(native));
      await pending;
    });
    expect(worker).toHaveBeenCalledTimes(phase === 'loading' ? 0 : 1);
  });

  it.each(['loading', 'learning'] as const)(
    'reports a current %s error without mutating original MRI or selection',
    async (phase) => {
      const base = volume(),
        labels = selection(base),
        before = base.data.slice(),
        mask = labels.data.slice();
      const loadSource = vi.fn<EnhancementSourceLoader>();
      if (phase === 'loading') loadSource.mockRejectedValue(new Error('Native detail unavailable'));
      else {
        loadSource.mockResolvedValue(volume());
        worker.mockRejectedValue(new Error('Worker unavailable'));
      }
      const { result } = setup({ volume: base, labels, loadSource });
      await act(async () => {
        expect(await result.current.run()).toBe(false);
      });
      expect(result.current).toMatchObject({ running: false, result: null, source: null, enabled: false });
      expect(result.current.error).toMatch(/unavailable/);
      expect(base.data).toEqual(before);
      expect(labels.data).toEqual(mask);
      expect([...labels.seeds!.foreground]).toEqual([5, 6]);
      expect([...labels.seeds!.background]).toEqual([7]);
      expect(labels.reviewState).toBe('reviewed');
    },
  );

  it('ignores a stale display failure but releases the current result and private source on its own failure', async () => {
    const native = volume(),
      old = enhanced(native, 1),
      current = enhanced(native, 2);
    const loadSource = vi.fn<EnhancementSourceLoader>().mockResolvedValue(native);
    worker.mockResolvedValueOnce(old).mockResolvedValueOnce(current);
    const { result } = setup({ loadSource });
    await act(async () => {
      await result.current.run();
    });
    await act(async () => {
      await result.current.run();
    });
    expect(loadSource.mock.calls[1]![1].retainedBytes).toBeGreaterThanOrEqual(old.data.byteLength);
    act(() => result.current.failDisplay(old, new Error('Stale texture failure')));
    expect(result.current.result).toBe(current);
    expect(result.current.error).toBeNull();
    act(() => result.current.failDisplay(current, new Error('Current texture failure')));
    expect(result.current).toMatchObject({
      result: null,
      source: null,
      enabled: false,
      error: 'Current texture failure',
    });
  });

  it('clears a finished result without rerunning or altering its authoritative selection', async () => {
    const native = volume();
    worker.mockResolvedValue(enhanced(native));
    const { result, props } = setup({ loadSource: vi.fn<EnhancementSourceLoader>().mockResolvedValue(native) });
    const before = props.labels!.data.slice();
    await act(async () => {
      await result.current.run();
    });
    act(() => result.current.clear());
    expect(result.current).toMatchObject({ result: null, source: null, enabled: false, error: null, progress: 0 });
    expect(props.labels!.data).toEqual(before);
    expect(worker).toHaveBeenCalledOnce();
  });
});
