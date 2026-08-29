import { useLayoutEffect, useState } from 'react';
import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SvrLabelVolume, SvrVolume } from '../src/types/svr';
import { useSvrSelection } from '../src/hooks/useSvrSelection';
import {
  SeededVolumeWorker,
  type SeededWorkerRequest,
  type SeededWorkerResponse,
} from '../src/utils/segmentation/seededVolumeWorker';
import { SELECTION_LABEL_META } from '../src/utils/segmentation/selectionEditing';
import { deferred } from './helpers/deferred';
import { proposedRegion } from './helpers/selectionInteraction';

function volume(size = 12): SvrVolume {
  return {
    data: new Float32Array(size ** 3).fill(0.5),
    observedSupport: new Uint8Array(size ** 3).fill(1),
    dims: [size, size, size],
    voxelSizeMm: [1, 1, 1],
    originMm: [0, 0, 0],
    boundsMm: { min: [0, 0, 0], max: [size, size, size] },
  };
}
function setup(source = volume(), saved: SvrLabelVolume | null = null, automatic = false) {
  return renderHook(
    ({ source, automatic }) => {
      const [labels, setLabels] = useState(saved);
      return { labels, setLabels, selection: useSvrSelection(source, labels, setLabels, automatic) };
    },
    { initialProps: { source, automatic } },
  );
}
function selectionWorkers() {
  const workers: MockWorker[] = [];
  class MockWorker {
    onmessage: ((event: MessageEvent<SeededWorkerResponse>) => void) | null = null;
    postMessage = vi.fn<(message: SeededWorkerRequest) => void>();
    terminate = vi.fn();
    constructor() {
      workers.push(this);
    }
    complete(indices: number[]) {
      const run = this.postMessage.mock.calls.at(-1)?.[0];
      if (run?.type !== 'run') throw new Error('No pending suggestion.');
      this.onmessage?.({
        data: {
          type: 'done',
          id: run.id,
          result: {
            indices: Uint32Array.from(indices),
            bounds: { min: { x: 0, y: 0, z: 0 }, max: { x: 11, y: 11, z: 11 } },
            boundaryCount: 0,
            domainVoxels: 1728,
          },
        },
      } as MessageEvent<SeededWorkerResponse>);
    }
  }
  vi.stubGlobal('Worker', MockWorker);
  return workers;
}
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('SVR selection publication and editing history', () => {
  it('applies the acquired finite-tissue contract to proposals as well as explicit marks', async () => {
    const source = volume();
    source.data[31] = NaN;
    source.data[32] = Infinity;
    source.observedSupport![33] = 0;
    vi.spyOn(SeededVolumeWorker.prototype, 'run').mockResolvedValue(
      proposedRegion([31, 32, 33, 34, 35, source.data.length]),
    );
    const { result } = setup(source);
    act(() => result.current.selection.stroke(Uint32Array.of(30, 31, 32, 33), 'include'));
    act(() => result.current.selection.stroke(Uint32Array.of(35), 'exclude'));
    await act(async () => result.current.selection.grow());
    expect([30, 31, 32, 33, 34, 35].map((index) => result.current.labels!.data[index])).toEqual([1, 0, 0, 0, 1, 0]);
    expect(result.current.labels!.data).toHaveLength(source.data.length);
    expect(result.current.labels!.seeds!.foreground).toEqual(Uint32Array.of(30));
    expect(result.current.labels!.seeds!.background).toEqual(Uint32Array.of(35));
  });

  it('auto-fills only after a new stroke settles and undoes the stroke and proposal together', async () => {
    vi.useFakeTimers();
    const run = vi.spyOn(SeededVolumeWorker.prototype, 'run').mockResolvedValue(proposedRegion([31, 32]));
    const { result } = setup(volume(), null, true);
    act(() => result.current.selection.stroke(Uint32Array.of(30), 'include'));
    expect(result.current.labels?.data[30]).toBe(1);
    expect(result.current.selection.status.running).toBe(true);
    expect(run).not.toHaveBeenCalled();
    act(() => result.current.selection.accept());
    expect(result.current.labels?.reviewState).toBe('draft');
    expect(() => result.current.selection.prepareEnhancement()).toThrow(/wait/i);
    await act(async () => vi.advanceTimersByTimeAsync(350));
    expect(run).toHaveBeenCalledOnce();
    expect(result.current.selection.status.running).toBe(false);
    expect([30, 31, 32].map((index) => result.current.labels!.data[index])).toEqual([1, 1, 1]);
    act(() => result.current.selection.travel('undo'));
    expect(result.current.labels?.data.some(Boolean)).toBe(false);
    expect(result.current.selection.marks.size).toBe(0);
    expect(result.current.selection.canUndo).toBe(false);
    act(() => result.current.selection.travel('redo'));
    expect([30, 31, 32].map((index) => result.current.labels!.data[index])).toEqual([1, 1, 1]);
    expect(result.current.selection.included).toBe(1);
    await act(async () => vi.advanceTimersByTimeAsync(1000));
    expect(run).toHaveBeenCalledOnce();
  });

  it('undoes the just-published automatic result before React commits its new history', async () => {
    vi.useFakeTimers();
    const completion = deferred<Awaited<ReturnType<SeededVolumeWorker['run']>>>();
    const run = vi.spyOn(SeededVolumeWorker.prototype, 'run').mockReturnValue(completion.promise);
    const { result } = setup(volume(), null, true);
    act(() => result.current.selection.stroke(Uint32Array.of(30), 'include'));
    await act(async () => vi.advanceTimersByTimeAsync(350));
    expect(run).toHaveBeenCalledOnce();
    await act(async () => {
      completion.resolve(proposedRegion([31, 32]));
      await completion.promise;
      expect(result.current.labels?.data[31]).toBe(0);
      result.current.selection.travel('undo');
    });
    expect(result.current.labels?.data.some(Boolean)).toBe(false);
    expect(result.current.selection.marks.size).toBe(0);
    expect(result.current.selection.canUndo).toBe(false);
    expect(result.current.selection.canRedo).toBe(true);
    act(() => result.current.selection.travel('redo'));
    expect([30, 31, 32].map((index) => result.current.labels!.data[index])).toEqual([1, 1, 1]);
    expect(result.current.selection.included).toBe(1);
    expect(run).toHaveBeenCalledOnce();
  });

  it.each(['include', 'exclude'] as const)(
    'keeps a completed proposal stable for agreeing %s marks with one reversible draft edit',
    async (kind) => {
      vi.useFakeTimers();
      const proposal = proposedRegion();
      proposal.boundaryCount = 3;
      proposal.bounds.min.x = 1;
      const run = vi.spyOn(SeededVolumeWorker.prototype, 'run').mockResolvedValue(proposal);
      const { result } = setup(volume(), null, true);
      act(() => result.current.selection.stroke(Uint32Array.of(30), 'include'));
      await act(async () => vi.advanceTimersByTimeAsync(350));
      act(() => result.current.selection.accept());
      expect(result.current.selection.status).toEqual({ running: false, boundaryCount: 3, contextLimited: true });
      const before = result.current.labels!;
      const indices = kind === 'include' ? Uint32Array.of(31, 32) : Uint32Array.of(33, 34);
      act(() => {
        result.current.selection.cancel(); // The editor stops old work at brush-down.
        result.current.selection.stroke(indices, kind);
      });
      const marked = result.current.labels!;
      expect(result.current.selection.status).toEqual({ running: false, boundaryCount: 3, contextLimited: true });
      expect(marked.data).toBe(before.data);
      expect(marked.data).toEqual(before.data);
      expect(marked.reviewState).toBe('draft');
      const markKind = kind === 'include' ? 'foreground' : 'background';
      expect([...marked.seeds![markKind]]).toEqual(kind === 'include' ? [30, 31, 32] : [33, 34]);
      await act(async () => vi.advanceTimersByTimeAsync(1000));
      expect(run).toHaveBeenCalledOnce();
      act(() => result.current.selection.travel('undo'));
      expect(result.current.labels!.data).toBe(before.data);
      expect(result.current.labels!.data).toEqual(before.data);
      expect(result.current.labels!.seeds).toEqual(before.seeds);
      expect(result.current.labels!.reviewState).toBe('reviewed');
      act(() => result.current.selection.travel('redo'));
      expect(result.current.labels!.data).toBe(marked.data);
      expect(result.current.labels!.data).toEqual(marked.data);
      expect(result.current.labels!.seeds).toEqual(marked.seeds);
      expect(result.current.labels!.reviewState).toBe('draft');
      await act(async () => vi.advanceTimersByTimeAsync(1000));
      expect(run).toHaveBeenCalledOnce();
    },
  );

  it('recognizes completion and successive agreeing strokes before React commits their history', async () => {
    vi.useFakeTimers();
    const completion = deferred<Awaited<ReturnType<SeededVolumeWorker['run']>>>();
    const run = vi.spyOn(SeededVolumeWorker.prototype, 'run').mockReturnValue(completion.promise);
    const { result } = setup(volume(), null, true);
    act(() => result.current.selection.stroke(Uint32Array.of(30), 'include'));
    await act(async () => vi.advanceTimersByTimeAsync(350));
    await act(async () => {
      const proposal = proposedRegion();
      proposal.boundaryCount = 4;
      proposal.bounds.max.z = 10;
      completion.resolve(proposal);
      await completion.promise;
      expect(result.current.labels!.data[31]).toBe(0);
      result.current.selection.cancel();
      result.current.selection.stroke(Uint32Array.of(31), 'include');
      result.current.selection.stroke(Uint32Array.of(33), 'exclude');
      result.current.selection.accept();
    });
    expect(result.current.selection.status).toEqual({ running: false, boundaryCount: 4, contextLimited: true });
    expect(result.current.labels!.reviewState).toBe('reviewed');
    expect([30, 31, 32, 33].map((index) => result.current.labels!.data[index])).toEqual([1, 1, 1, 0]);
    expect(result.current.labels!.seeds).toEqual({
      foreground: Uint32Array.of(30, 31),
      background: Uint32Array.of(33),
    });
    await act(async () => vi.advanceTimersByTimeAsync(1000));
    expect(run).toHaveBeenCalledOnce();
  });

  it.each(['include', 'exclude'] as const)('reruns when any voxel in an %s stroke changes membership', async (kind) => {
    vi.useFakeTimers();
    const run = vi.spyOn(SeededVolumeWorker.prototype, 'run').mockResolvedValue(proposedRegion());
    const { result } = setup(volume(), null, true);
    act(() => result.current.selection.stroke(Uint32Array.of(30), 'include'));
    await act(async () => vi.advanceTimersByTimeAsync(350));
    const previousData = result.current.labels!.data;
    const previousValues = previousData.slice();
    const indices = kind === 'include' ? Uint32Array.of(31, 33) : Uint32Array.of(33, 31);
    act(() => result.current.selection.stroke(indices, kind));
    expect(result.current.labels!.data).not.toBe(previousData);
    expect(previousData).toEqual(previousValues);
    expect(result.current.selection.status.running).toBe(true);
    await act(async () => vi.advanceTimersByTimeAsync(350));
    expect(run).toHaveBeenCalledTimes(2);
    expect([...indices].map((index) => result.current.labels!.data[index])).toEqual(
      kind === 'include' ? [1, 1] : [0, 0],
    );
  });

  it.each(['queued', 'running'] as const)(
    'does not drop an unfinished %s first fill after an agreeing stroke',
    async (phase) => {
      vi.useFakeTimers();
      const oldCompletion = deferred<Awaited<ReturnType<SeededVolumeWorker['run']>>>();
      const run = vi.spyOn(SeededVolumeWorker.prototype, 'run').mockResolvedValue(proposedRegion());
      if (phase === 'running') run.mockReturnValueOnce(oldCompletion.promise);
      const { result } = setup(volume(), null, true);
      act(() => result.current.selection.stroke(Uint32Array.of(30), 'include'));
      await act(async () => vi.advanceTimersByTimeAsync(phase === 'running' ? 350 : 200));
      act(() => {
        result.current.selection.cancel();
        result.current.selection.stroke(Uint32Array.of(30), 'include');
      });
      expect(result.current.selection.status.running).toBe(true);
      await act(async () => vi.advanceTimersByTimeAsync(350));
      expect(run).toHaveBeenCalledTimes(phase === 'running' ? 2 : 1);
      await act(async () => oldCompletion.resolve(proposedRegion([30, 99])));
      expect(result.current.labels!.data[31]).toBe(1);
      expect(result.current.labels!.data[99]).toBe(0);
    },
  );

  it('copies legacy label IDs before normalizing them even when the brush membership already agrees', () => {
    const source = volume();
    const saved: SvrLabelVolume = {
      data: new Uint8Array(source.data.length),
      dims: source.dims,
      meta: [{ id: 2, name: 'Imported tissue', color: [80, 100, 120] }],
      seeds: { foreground: Uint32Array.of(30), background: new Uint32Array() },
      reviewState: 'reviewed',
    };
    saved.data[30] = 2;
    const { result } = setup(source, saved);
    act(() => result.current.selection.stroke(Uint32Array.of(33), 'exclude'));
    expect(result.current.labels!.data).not.toBe(saved.data);
    expect(result.current.labels!.data[30]).toBe(1);
    expect(saved.data[30]).toBe(2);
    expect(result.current.labels!.seeds!.background).toEqual(Uint32Array.of(33));
    act(() => result.current.selection.travel('undo'));
    expect(result.current.labels!.data[30]).toBe(2);
    expect(result.current.labels!.meta).toEqual(saved.meta);
  });

  it.each(['failed', 'running', 'cancelled'] as const)(
    'does not reuse earlier completion after an explicit %s fill, and keeps explicit retry available',
    async (phase) => {
      vi.useFakeTimers();
      const completion = deferred<Awaited<ReturnType<SeededVolumeWorker['run']>>>();
      const run = vi.spyOn(SeededVolumeWorker.prototype, 'run').mockResolvedValue(proposedRegion());
      const { result } = setup(volume(), null, true);
      act(() => result.current.selection.stroke(Uint32Array.of(30), 'include'));
      await act(async () => vi.advanceTimersByTimeAsync(350));
      if (phase === 'failed') run.mockRejectedValueOnce(new Error('Incomplete suggestion'));
      else run.mockReturnValueOnce(completion.promise);
      let pending!: Promise<void>;
      act(() => {
        pending = result.current.selection.grow();
      });
      if (phase === 'failed') {
        await act(async () => pending);
        expect(result.current.selection.status.error).toBe('Incomplete suggestion');
      } else if (phase === 'cancelled') act(() => result.current.selection.cancel());
      act(() => {
        result.current.selection.cancel();
        result.current.selection.stroke(Uint32Array.of(31), 'include');
      });
      expect(result.current.selection.status.running).toBe(true);
      await act(async () => vi.advanceTimersByTimeAsync(350));
      expect(run).toHaveBeenCalledTimes(3);
      if (phase !== 'failed')
        await act(async () => {
          completion.resolve(proposedRegion([30, 99]));
          await pending;
        });
      expect(result.current.labels!.data[99]).toBe(0);
      await act(async () => result.current.selection.grow());
      expect(run).toHaveBeenCalledTimes(4);
    },
  );

  it.each(['hydrate', 'source', 'undo', 'redo', 'clear-undo'] as const)(
    'invalidates known completion on %s without running from restoration alone',
    async (action) => {
      vi.useFakeTimers();
      const run = vi.spyOn(SeededVolumeWorker.prototype, 'run').mockResolvedValue(proposedRegion());
      const source = volume();
      const { result, rerender } = setup(source);
      act(() => result.current.selection.stroke(Uint32Array.of(30), 'include'));
      await act(async () => result.current.selection.grow());
      rerender({ source, automatic: true });
      act(() => {
        if (action === 'hydrate')
          result.current.setLabels({ ...result.current.labels!, data: result.current.labels!.data.slice() });
        else if (action === 'source') rerender({ source: volume(), automatic: true });
        else {
          if (action === 'clear-undo') result.current.selection.clear();
          result.current.selection.travel('undo');
          if (action === 'redo') result.current.selection.travel('redo');
        }
      });
      await act(async () => vi.advanceTimersByTimeAsync(1000));
      expect(run).toHaveBeenCalledOnce();
      expect(result.current.labels!.data[30]).toBe(1);
      act(() => result.current.selection.stroke(Uint32Array.of(30), 'include'));
      expect(result.current.selection.status.running).toBe(true);
      await act(async () => vi.advanceTimersByTimeAsync(350));
      expect(run).toHaveBeenCalledTimes(2);
    },
  );

  it('keeps an automatic stroke started in the replacement source commit alive', async () => {
    vi.useFakeTimers();
    const run = vi.spyOn(SeededVolumeWorker.prototype, 'run').mockResolvedValue(proposedRegion([31]));
    const first = volume(),
      second = volume();
    const { result, rerender } = renderHook(
      ({ source, markAtCommit }) => {
        const [labels, setLabels] = useState<SvrLabelVolume | null>(null);
        const selection = useSvrSelection(source, labels, setLabels, true);
        const { stroke } = selection;
        useLayoutEffect(() => {
          if (markAtCommit) stroke(Uint32Array.of(30), 'include');
        }, [source, markAtCommit, stroke]);
        return { labels, selection };
      },
      { initialProps: { source: first, markAtCommit: false } },
    );
    rerender({ source: second, markAtCommit: true });
    expect(result.current.labels?.data[30]).toBe(1);
    expect(result.current.selection.status.running).toBe(true);
    await act(async () => vi.advanceTimersByTimeAsync(350));
    expect(run).toHaveBeenCalledOnce();
    expect(run.mock.calls[0]![0].volume).toBe(second.data);
    expect(result.current.selection.status.running).toBe(false);
    expect([30, 31].map((index) => result.current.labels!.data[index])).toEqual([1, 1]);
    expect(first.data.every((value) => value === 0.5)).toBe(true);
    expect(second.data.every((value) => value === 0.5)).toBe(true);
  });

  it('uses the current history for multiple edits and undo or redo within one batch', () => {
    const { result } = setup();
    act(() => {
      result.current.selection.stroke(Uint32Array.of(30), 'include');
      result.current.selection.stroke(Uint32Array.of(31), 'include');
      result.current.selection.travel('undo');
    });
    expect([30, 31].map((index) => result.current.labels!.data[index])).toEqual([1, 0]);
    act(() => {
      result.current.selection.travel('undo');
      result.current.selection.travel('redo');
      result.current.selection.travel('redo');
    });
    expect([30, 31].map((index) => result.current.labels!.data[index])).toEqual([1, 1]);
    expect(result.current.selection.canRedo).toBe(false);
    expect(result.current.selection.included).toBe(2);
  });

  it('counts a same-tick edit and its hard marks before admitting enhancement', () => {
    const { result } = setup();
    let retained = 0;
    act(() => {
      result.current.selection.stroke(Uint32Array.of(30), 'include');
      retained = result.current.selection.prepareEnhancement();
    });
    expect(retained).toBe(10);
    expect(result.current.selection.retainedBytes).toBe(retained);
    expect(result.current.selection.canUndo).toBe(true);
    expect(result.current.selection.included).toBe(1);
    expect(result.current.labels?.data[30]).toBe(1);
  });

  it('coalesces rapid marks into one solver request without collapsing distinct brush undo steps', async () => {
    vi.useFakeTimers();
    const run = vi.spyOn(SeededVolumeWorker.prototype, 'run').mockResolvedValue(proposedRegion([30, 31, 32, 33]));
    const { result } = setup(volume(), null, true);
    act(() => result.current.selection.stroke(Uint32Array.of(30), 'include'));
    await act(async () => vi.advanceTimersByTimeAsync(200));
    act(() => result.current.selection.stroke(Uint32Array.of(32), 'exclude'));
    await act(async () => vi.advanceTimersByTimeAsync(350));
    expect(run).toHaveBeenCalledOnce();
    expect(run.mock.calls[0]![0]).toMatchObject({ foreground: Uint32Array.of(30), background: Uint32Array.of(32) });
    expect(result.current.labels?.data[32]).toBe(0);
    act(() => result.current.selection.travel('undo'));
    expect(result.current.labels?.data[30]).toBe(1);
    expect(result.current.labels?.data[31]).toBe(0);
    expect(result.current.selection.excluded).toBe(0);
    act(() => result.current.selection.travel('undo'));
    expect(result.current.labels?.data.some(Boolean)).toBe(false);
  });

  it.each(['off', 'cancel', 'undo', 'clear', 'hydrate', 'source', 'unmount'] as const)(
    'cancels queued auto-fill on %s and never starts it from restored labels',
    async (action) => {
      vi.useFakeTimers();
      const run = vi.spyOn(SeededVolumeWorker.prototype, 'run');
      const source = volume();
      const saved: SvrLabelVolume = {
        data: new Uint8Array(source.data.length),
        dims: source.dims,
        meta: SELECTION_LABEL_META,
        seeds: { foreground: Uint32Array.of(30), background: new Uint32Array() },
        reviewState: 'reviewed',
      };
      saved.data[30] = 1;
      const { result, rerender, unmount } = setup(source, saved, true);
      await act(async () => vi.advanceTimersByTimeAsync(1000));
      expect(run).not.toHaveBeenCalled();
      expect(result.current.labels).toBe(saved);
      act(() => result.current.selection.stroke(Uint32Array.of(31), 'include'));
      act(() => {
        if (action === 'off') rerender({ source, automatic: false });
        else if (action === 'source') rerender({ source: volume(), automatic: true });
        else if (action === 'hydrate') result.current.setLabels(saved);
        else if (action === 'unmount') unmount();
        else if (action === 'undo') result.current.selection.travel('undo');
        else result.current.selection[action]();
      });
      await act(async () => vi.advanceTimersByTimeAsync(1000));
      expect(run).not.toHaveBeenCalled();
      if (action !== 'unmount') expect(result.current.selection.status.running).toBe(false);
    },
  );

  it('rejects a late automatic proposal after a correction and keeps its latest hard marks', async () => {
    vi.useFakeTimers();
    const resolvers: Array<(value: Awaited<ReturnType<SeededVolumeWorker['run']>>) => void> = [];
    const run = vi
      .spyOn(SeededVolumeWorker.prototype, 'run')
      .mockImplementation(() => new Promise((resolve) => resolvers.push(resolve)));
    const { result } = setup(volume(), null, true);
    act(() => result.current.selection.stroke(Uint32Array.of(30), 'include'));
    await act(async () => vi.advanceTimersByTimeAsync(350));
    act(() => result.current.selection.stroke(Uint32Array.of(31), 'exclude'));
    expect(run.mock.calls[0]![1]?.signal?.aborted).toBe(true);
    const proposal = proposedRegion([30, 31, 99]);
    await act(async () => resolvers[0]!(proposal));
    expect(result.current.labels?.data[99]).toBe(0);
    await act(async () => vi.advanceTimersByTimeAsync(350));
    expect(run).toHaveBeenCalledTimes(2);
    await act(async () => resolvers[1]!(proposal));
    expect(result.current.labels?.data[31]).toBe(0);
    expect(result.current.labels?.data[99]).toBe(1);
    act(() => result.current.selection.travel('undo'));
    expect(result.current.labels?.data[30]).toBe(1);
    expect(result.current.labels?.data[99]).toBe(0);
    expect(result.current.selection.excluded).toBe(0);
  });

  it('releases the idle suggestion copy before enhancement, preserving labels, marks, history and later suggestions', async () => {
    const workers = selectionWorkers();
    const source = volume();
    const sourceData = source.data.slice();
    const sourceSupport = source.observedSupport!.slice();
    const { result, rerender } = setup(source);
    act(() => result.current.selection.stroke(Uint32Array.of(30), 'include'));
    act(() => result.current.selection.stroke(Uint32Array.of(31), 'exclude'));
    await act(async () => {
      const pending = result.current.selection.grow();
      workers[0]!.complete([30, 31, 32]);
      await pending;
    });
    const worker = workers[0]!;
    expect(worker.postMessage.mock.calls[0]![0]).toMatchObject({
      type: 'init',
      volume: source.data,
      observedSupport: source.observedSupport,
    });
    const labels = result.current.labels;
    const values = labels!.data.slice();
    const marks = result.current.selection.marks;
    const retainedBefore = result.current.selection.retainedBytes;
    const sourceBytes = source.data.buffer.byteLength + source.observedSupport!.buffer.byteLength;
    expect(retainedBefore).toBeGreaterThan(sourceBytes);
    let retainedAfter = 0;
    act(() => {
      retainedAfter = result.current.selection.prepareEnhancement();
    });
    expect(retainedAfter).toBe(retainedBefore - sourceBytes);
    expect(worker.terminate).toHaveBeenCalledOnce();
    expect(result.current.selection.prepareEnhancement()).toBe(retainedAfter);
    expect(worker.terminate).toHaveBeenCalledOnce();
    expect(result.current.labels).toBe(labels);
    expect(result.current.labels!.data).toEqual(values);
    expect(result.current.selection.marks).toBe(marks);
    expect(source.data).toEqual(sourceData);
    expect(source.observedSupport).toEqual(sourceSupport);
    rerender({ source, automatic: false });
    expect(result.current.selection.retainedBytes).toBe(retainedAfter);

    act(() => result.current.selection.travel('undo'));
    expect(result.current.labels!.data[30]).toBe(1);
    expect(result.current.labels!.data[31]).toBe(0);
    expect(result.current.labels!.data[32]).toBe(0);
    expect(result.current.labels!.seeds).toEqual(labels!.seeds);
    expect(result.current.selection.canRedo).toBe(true);
    act(() => result.current.selection.travel('redo'));
    expect(result.current.labels!.data).toEqual(values);
    expect(result.current.labels!.seeds).toEqual(labels!.seeds);
    expect(result.current.selection.retainedBytes).toBe(retainedAfter);

    await act(async () => {
      const pending = result.current.selection.grow();
      expect(workers).toHaveLength(2);
      expect(workers[1]!.postMessage.mock.calls[0]![0]).toMatchObject({
        type: 'init',
        volume: source.data,
        observedSupport: source.observedSupport,
      });
      expect(workers[1]!.postMessage.mock.calls[1]![0]).toMatchObject({ type: 'run', ...labels!.seeds });
      workers[1]!.complete([31, 33]);
      await pending;
    });
    expect(result.current.labels!.data[30]).toBe(1);
    expect(result.current.labels!.data[31]).toBe(0);
    expect(result.current.labels!.data[33]).toBe(1);
    expect(result.current.labels!.seeds).toEqual(labels!.seeds);
    expect(source.data).toEqual(sourceData);
    expect(source.observedSupport).toEqual(sourceSupport);
  });

  it('refuses enhancement preparation during a suggestion without canceling it or touching edits', async () => {
    const workers = selectionWorkers();
    const { result } = setup();
    act(() => result.current.selection.stroke(Uint32Array.of(30), 'include'));
    const before = result.current.labels;
    let pending!: Promise<void>;
    act(() => {
      pending = result.current.selection.grow();
    });
    const worker = workers[0]!;
    expect(result.current.selection.status.running).toBe(true);
    expect(() => result.current.selection.prepareEnhancement()).toThrow(/wait for the boundary suggestion/i);
    expect(worker.terminate).not.toHaveBeenCalled();
    expect(worker.postMessage.mock.calls.map(([message]) => message.type)).toEqual(['init', 'run']);
    expect(result.current.labels).toBe(before);
    expect(result.current.selection.status.running).toBe(true);
    await act(async () => {
      worker.complete([30, 32]);
      await pending;
    });
    expect(result.current.labels!.data[32]).toBe(1);
    expect(result.current.selection.status.running).toBe(false);
    expect(result.current.selection.prepareEnhancement()).toBeGreaterThan(0);
    expect(worker.terminate).toHaveBeenCalledOnce();
  });

  it('counts unique history and hard-mark buffers plus the live worker source, releasing replaced history', async () => {
    vi.spyOn(SeededVolumeWorker.prototype, 'residentSourceBytes', 'get').mockReturnValue(8192);
    vi.spyOn(SeededVolumeWorker.prototype, 'run').mockResolvedValue({
      indices: Uint32Array.of(30, 32),
      bounds: { min: { x: 0, y: 0, z: 0 }, max: { x: 11, y: 11, z: 11 } },
      boundaryCount: 0,
      domainVoxels: 1728,
    });
    const { result } = setup();
    expect(result.current.selection.retainedBytes).toBe(0);
    act(() => result.current.selection.stroke(Uint32Array.of(30), 'include'));
    // A 4-byte changed index, two 1-byte patch values, and the shared 4-byte inside mark.
    expect(result.current.selection.retainedBytes).toBe(10);
    act(() => result.current.selection.stroke(Uint32Array.of(31), 'exclude'));
    const before = result.current.selection.retainedBytes;
    await act(async () => result.current.selection.grow());
    expect(result.current.selection.retainedBytes).toBe(before + 8192 + 6);
    const retained = result.current.selection.retainedBytes;
    act(() => result.current.selection.travel('undo'));
    expect(result.current.selection.retainedBytes).toBe(retained);
    act(() => result.current.selection.travel('redo'));
    expect(result.current.selection.retainedBytes).toBe(retained);
    act(() => result.current.setLabels(null));
    expect(result.current.selection.canUndo).toBe(false);
    expect(result.current.selection.retainedBytes).toBe(8192);
  });

  it('can confirm newly hydrated labels at the first interactive commit', () => {
    const source = volume();
    const changed = vi.fn();
    const saved: SvrLabelVolume = {
      data: new Uint8Array(source.data.length),
      dims: source.dims,
      meta: SELECTION_LABEL_META,
      reviewState: 'draft',
    };
    saved.data[31] = 1;
    const { rerender } = renderHook(
      ({ labels }: { labels: SvrLabelVolume | null }) => {
        const { accept } = useSvrSelection(source, labels, changed);
        useLayoutEffect(() => {
          if (labels) accept();
        }, [labels, accept]);
      },
      { initialProps: { labels: null as SvrLabelVolume | null } },
    );
    rerender({ labels: saved });
    expect(changed).toHaveBeenCalledWith(
      expect.objectContaining({ data: saved.data, reviewState: 'reviewed' }),
      undefined,
      saved.data,
    );
  });
  it('requires an inside mark without submitting unmarked or outside-only requests', async () => {
    const run = vi.spyOn(SeededVolumeWorker.prototype, 'run');
    const { result } = setup();
    await act(async () => result.current.selection.grow());
    expect(result.current.selection.included).toBe(0);
    expect(result.current.selection.status.error).toMatch(/mark inside/i);
    expect(result.current.selection.status.running).toBe(false);
    expect(result.current.labels).toBeNull();
    act(() => result.current.selection.stroke(Uint32Array.of(32), 'exclude'));
    await act(async () => result.current.selection.grow());
    expect(result.current.selection.included).toBe(0);
    expect(result.current.selection.excluded).toBe(1);
    expect(result.current.selection.status.error).toMatch(/mark inside/i);
    expect(result.current.labels?.data.some(Boolean)).toBe(false);
    expect(run).not.toHaveBeenCalled();
  });

  it('suggests a draft from inside marks alone and sends an empty outside-mark set', async () => {
    const run = vi.spyOn(SeededVolumeWorker.prototype, 'run').mockResolvedValue({
      indices: Uint32Array.of(31, 33),
      bounds: { min: { x: 0, y: 0, z: 0 }, max: { x: 11, y: 11, z: 11 } },
      boundaryCount: 0,
      domainVoxels: 1728,
    });
    const source = volume();
    const { result } = setup(source);
    act(() => result.current.selection.stroke(Uint32Array.of(30), 'include'));
    expect(result.current.selection.included).toBe(1);
    expect(result.current.selection.excluded).toBe(0);
    await act(async () => result.current.selection.grow());
    expect(run).toHaveBeenCalledOnce();
    expect(run.mock.calls[0]![0]).toMatchObject({
      volume: source.data,
      observedSupport: source.observedSupport,
      foreground: Uint32Array.of(30),
      background: new Uint32Array(),
    });
    expect(result.current.labels?.data[30]).toBe(1);
    expect(result.current.labels?.data[33]).toBe(1);
    expect(result.current.labels?.reviewState).toBe('draft');
    expect(result.current.selection.status).toMatchObject({ running: false, contextLimited: false });
    expect(result.current.selection.status.error).toBeUndefined();
    act(() => result.current.selection.travel('undo'));
    expect(result.current.labels?.data[30]).toBe(1);
    expect(result.current.labels?.data[33]).toBe(0);
    expect(result.current.labels?.seeds?.foreground).toEqual(Uint32Array.of(30));
    act(() => result.current.selection.travel('redo'));
    expect(result.current.labels?.data[30]).toBe(1);
    expect(result.current.labels?.data[33]).toBe(1);
  });

  it('keeps cross-slice hard marks authoritative over repeated proposals and later outside corrections', async () => {
    const inside = [30, 31, 180, 181, 900, 901];
    const outside = [32, 182, 902];
    const run = vi.spyOn(SeededVolumeWorker.prototype, 'run').mockResolvedValue({
      indices: Uint32Array.from([...outside, 1200]),
      bounds: { min: { x: 0, y: 0, z: 0 }, max: { x: 11, y: 11, z: 11 } },
      boundaryCount: 0,
      domainVoxels: 1728,
    });
    const { result } = setup();
    act(() => result.current.selection.stroke(Uint32Array.from(inside), 'include'));
    act(() => result.current.selection.stroke(Uint32Array.from(outside), 'exclude'));
    for (let repeat = 0; repeat < 2; repeat++) {
      await act(async () => result.current.selection.grow());
      expect(inside.map((index) => result.current.labels!.data[index])).toEqual(inside.map(() => 1));
      expect(outside.map((index) => result.current.labels!.data[index])).toEqual(outside.map(() => 0));
      expect(result.current.labels?.data[1200]).toBe(1);
      expect(result.current.labels?.seeds).toEqual({
        foreground: Uint32Array.from(inside),
        background: Uint32Array.from(outside),
      });
    }
    act(() => result.current.selection.stroke(Uint32Array.of(180, 1200), 'exclude'));
    await act(async () => result.current.selection.grow());
    const latestInside = inside.filter((index) => index !== 180);
    const latestOutside = [...outside, 180, 1200];
    expect(latestInside.map((index) => result.current.labels!.data[index])).toEqual(latestInside.map(() => 1));
    expect(latestOutside.map((index) => result.current.labels!.data[index])).toEqual(latestOutside.map(() => 0));
    const submitted = run.mock.calls.at(-1)![0];
    expect([...submitted.foreground].sort((a, b) => a - b)).toEqual(latestInside.sort((a, b) => a - b));
    expect([...submitted.background].sort((a, b) => a - b)).toEqual(latestOutside.sort((a, b) => a - b));
    act(() => result.current.selection.travel('undo'));
    act(() => result.current.selection.travel('undo'));
    expect(result.current.labels?.data[180]).toBe(1);
    expect(result.current.labels?.data[1200]).toBe(1);
    expect(result.current.labels?.seeds?.foreground).toContain(180);
    expect(result.current.labels?.seeds?.background).not.toContain(180);
    act(() => result.current.selection.travel('redo'));
    expect(result.current.labels?.data[180]).toBe(0);
    expect(result.current.labels?.data[1200]).toBe(0);
    expect(result.current.labels?.seeds?.foreground).not.toContain(180);
    expect(result.current.labels?.seeds?.background).toContain(180);
  });

  it.each([
    { min: { x: 0, y: 0, z: 0 }, max: { x: 11, y: 11, z: 11 }, contextLimited: false },
    { min: { x: 1, y: 0, z: 0 }, max: { x: 11, y: 11, z: 11 }, contextLimited: true },
    { min: { x: 0, y: 0, z: 0 }, max: { x: 11, y: 10, z: 11 }, contextLimited: true },
    { min: { x: 0, y: 0, z: 0 }, max: { x: 11, y: 11, z: 10 }, contextLimited: true },
  ])('reports contextLimited=$contextLimited from bounds $min to $max', async ({ min, max, contextLimited }) => {
    vi.spyOn(SeededVolumeWorker.prototype, 'run').mockResolvedValue({
      indices: Uint32Array.of(30),
      bounds: { min, max },
      boundaryCount: 3,
      domainVoxels: (max.x - min.x + 1) * (max.y - min.y + 1) * (max.z - min.z + 1),
    });
    const { result } = setup();
    act(() => result.current.selection.stroke(Uint32Array.of(30), 'include'));
    await act(async () => result.current.selection.grow());
    expect(result.current.selection.status).toMatchObject({ running: false, boundaryCount: 3, contextLimited });
  });

  it.each([12, 180])('publishes edits and explicit review for a %i-cubed volume', (size) => {
    const { result } = setup(volume(size));
    act(() => result.current.selection.stroke(new Uint32Array([30, 31]), 'include'));
    expect(result.current.labels?.data[30]).toBe(1);
    expect(result.current.labels?.reviewState).toBe('draft');
    act(() => result.current.selection.stroke(new Uint32Array([32]), 'exclude'));
    expect(result.current.selection.excluded).toBe(1);
    act(() => result.current.selection.accept());
    expect(result.current.labels?.reviewState).toBe('reviewed');
    act(() => result.current.selection.stroke(new Uint32Array([30]), 'exclude'));
    expect(result.current.labels?.reviewState).toBe('draft');
    expect(result.current.labels?.data[30]).toBe(0);
    act(() => result.current.selection.travel('undo'));
    expect(result.current.labels?.data[30]).toBe(1);
    expect(result.current.labels?.reviewState).toBe('reviewed');
    act(() => result.current.selection.travel('redo'));
    expect(result.current.labels?.data[30]).toBe(0);
    expect(result.current.labels?.reviewState).toBe('draft');
  });

  it.each([true, false])(
    'reuses saved hard constraints with optional outside marks: %s, without growing on correction',
    async (outsideMarks) => {
      const run = vi.spyOn(SeededVolumeWorker.prototype, 'run').mockResolvedValue({
        indices: new Uint32Array([30, 31, 33]),
        bounds: { min: { x: 0, y: 0, z: 0 }, max: { x: 11, y: 11, z: 11 } },
        boundaryCount: 0,
        domainVoxels: 1728,
      });
      const source = volume();
      const saved: SvrLabelVolume = {
        data: new Uint8Array(source.data.length),
        dims: source.dims,
        meta: SELECTION_LABEL_META,
        seeds: { foreground: new Uint32Array([30]), background: Uint32Array.from(outsideMarks ? [32] : []) },
      };
      saved.data[30] = 1;
      const { result } = setup(source, saved);
      expect(result.current.selection.included).toBe(1);
      await act(async () => result.current.selection.grow());
      expect(run).toHaveBeenCalledOnce();
      expect(run.mock.calls[0]![0]).toMatchObject(saved.seeds!);
      expect(result.current.labels?.data[33]).toBe(1);
      act(() => result.current.selection.stroke(new Uint32Array([33]), 'exclude'));
      expect(run).toHaveBeenCalledOnce();
      expect(result.current.labels?.data[33]).toBe(0);
      expect(result.current.labels?.seeds?.background).toContain(33);
      act(() => result.current.selection.travel('undo'));
      expect(result.current.labels?.data[33]).toBe(1);
      expect(result.current.labels?.seeds?.background).not.toContain(33);
    },
  );

  it('a cancelled late computation cannot overwrite a newer correction', async () => {
    let resolve!: (result: Awaited<ReturnType<SeededVolumeWorker['run']>>) => void;
    vi.spyOn(SeededVolumeWorker.prototype, 'run').mockImplementation(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    );
    const { result } = setup();
    act(() => result.current.selection.stroke(new Uint32Array([30]), 'include'));
    act(() => result.current.selection.stroke(new Uint32Array([32]), 'exclude'));
    let pending!: Promise<void>;
    act(() => {
      pending = result.current.selection.grow();
    });
    act(() => result.current.selection.stroke(new Uint32Array([33]), 'include'));
    await act(async () => {
      resolve({
        indices: new Uint32Array([99]),
        bounds: { min: { x: 0, y: 0, z: 0 }, max: { x: 11, y: 11, z: 11 } },
        boundaryCount: 0,
        domainVoxels: 1728,
      });
      await pending;
    });
    expect(result.current.labels?.data[33]).toBe(1);
    expect(result.current.labels?.data[99]).toBe(0);
  });

  it('clears and restores the mask and both kinds of marks together', () => {
    const { result } = setup();
    act(() => result.current.selection.stroke(new Uint32Array([30]), 'include'));
    act(() => result.current.selection.stroke(new Uint32Array([32]), 'exclude'));
    act(() => result.current.selection.clear());
    expect(result.current.labels?.data.some(Boolean)).toBe(false);
    expect(result.current.selection.marks.size).toBe(0);
    act(() => result.current.selection.travel('undo'));
    expect(result.current.labels?.data[30]).toBe(1);
    expect(result.current.selection.marks.size).toBe(2);
  });
});
