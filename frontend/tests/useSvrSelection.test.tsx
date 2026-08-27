import { useState } from 'react';
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

  it('reuses saved hard constraints, and direct correction never starts growth', async () => {
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
      seeds: { foreground: new Uint32Array([30]), background: new Uint32Array([32]) },
    };
    saved.data[30] = 1;
    const { result } = setup(source, saved);
    expect(result.current.selection.included).toBe(1);
    await act(async () => result.current.selection.grow());
    expect(run).toHaveBeenCalledOnce();
    expect(result.current.labels?.data[33]).toBe(1);
    act(() => result.current.selection.stroke(new Uint32Array([33]), 'exclude'));
    expect(run).toHaveBeenCalledOnce();
    expect(result.current.labels?.data[33]).toBe(0);
    expect(result.current.labels?.seeds?.background).toContain(33);
    act(() => result.current.selection.travel('undo'));
    expect(result.current.labels?.data[33]).toBe(1);
    expect(result.current.labels?.seeds?.background).not.toContain(33);
  });

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
