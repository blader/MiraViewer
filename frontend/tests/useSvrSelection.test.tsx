import { useLayoutEffect, useState } from 'react';
import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SvrLabelVolume, SvrVolume } from '../src/types/svr';
import { useSvrSelection } from '../src/hooks/useSvrSelection';
import { SeededVolumeWorker } from '../src/utils/segmentation/seededVolumeWorker';
import { SELECTION_LABEL_META } from '../src/utils/segmentation/selectionEditing';

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
function setup(source = volume(), saved: SvrLabelVolume | null = null) {
  return renderHook(
    ({ source }) => {
      const [labels, setLabels] = useState(saved);
      return { labels, setLabels, selection: useSvrSelection(source, labels, setLabels) };
    },
    { initialProps: { source } },
  );
}
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('SVR selection publication and editing history', () => {
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
