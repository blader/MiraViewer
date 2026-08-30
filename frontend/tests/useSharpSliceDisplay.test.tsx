import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DerivedAlignmentFrame } from '../src/utils/derivedAlignmentFrame';
import type { DerivedImagePresentation } from '../src/utils/derivedImagePresentation';
import { deferred } from './helpers/deferred';

const mocks = vi.hoisted(() => ({ request: vi.fn(), present: vi.fn() }));
vi.mock('../src/utils/sharpSliceDisplay', () => ({ requestSharpSliceDisplay: mocks.request }));
vi.mock('../src/utils/derivedImagePresentation', () => ({ createDerivedImagePresentation: mocks.present }));

import { useSharpSliceDisplay } from '../src/hooks/useSharpSliceDisplay';

function frame(): DerivedAlignmentFrame {
  return {
    imageId: 'miraderived:synthetic-plane',
    runId: 'synthetic-run',
    seriesUid: 'synthetic-series',
    instanceIndex: 3,
    sourceImageId: 'miradb:synthetic-source',
    pixels: Float32Array.from([1, 2, 3, 4]),
    valid: Uint8Array.from([1, 1, 1, 0]),
    rows: 2,
    columns: 2,
  };
}

const replacement = {
  pixels: Float32Array.from([1, 2.25, 2.75, 5]),
  valid: Uint8Array.from([1, 1, 1, 1]),
  rows: 2,
  columns: 2,
  stats: { method: 'synthetic-test', durationMs: 1, synthesizedPlanes: 1 },
};
const image: DerivedImagePresentation = {
  imageId: 'miraderived:synthetic-plane:sharp',
  rows: 2,
  columns: 2,
  height: 2,
  width: 2,
  slope: 1,
  intercept: 0,
  windowCenter: 2,
  windowWidth: 4,
  derivedSource: new WeakRef(frame()),
  getPixelData: () => Uint16Array.from([1, 2, 3, 0]),
};

beforeEach(() => {
  mocks.request.mockReset();
  mocks.present.mockReset().mockResolvedValue(image);
});

describe('useSharpSliceDisplay display-only ownership', () => {
  it('is opt-in, reports progress, and preserves the exact original arrays', async () => {
    const source = frame();
    const pixels = source.pixels.slice();
    const support = source.valid!.slice();
    const job = deferred<typeof replacement>();
    mocks.request.mockReturnValue(job.promise);
    const { result, rerender } = renderHook(
      ({ enabled }) => useSharpSliceDisplay(source, { enabled, suspended: false }),
      { initialProps: { enabled: false } },
    );
    expect(result.current.status).toBe('original');
    expect(mocks.request).not.toHaveBeenCalled();

    rerender({ enabled: true });
    expect(result.current.status).toBe('loading');
    expect(result.current.image).toBeUndefined();
    await waitFor(() => expect(mocks.request).toHaveBeenCalledOnce());
    const options = mocks.request.mock.calls[0]![1];
    act(() => options.onProgress('Synthesizing native detail'));
    expect(result.current.message).toBe('Synthesizing native detail');
    await act(async () => job.resolve(replacement));

    expect(result.current.status).toBe('ready');
    expect(result.current.image).toBe(image);
    expect(mocks.present).toHaveBeenCalledWith(
      source,
      expect.stringContaining(`${source.imageId}:sharp:`),
      replacement,
      options.signal,
    );
    expect(source.pixels).toEqual(pixels);
    expect(source.valid).toEqual(support);
    expect(source.pixels.buffer.byteLength).toBe(16);

    rerender({ enabled: false });
    expect(result.current.image).toBeUndefined();
    expect(result.current.sourceKey).toBeNull();
    expect(result.current.status).toBe('original');
    rerender({ enabled: true });
    expect(result.current.image).toBe(image);
    expect(mocks.request).toHaveBeenCalledOnce();
    expect(mocks.present).toHaveBeenCalledOnce();
  });

  it('keeps acquired slices unchanged and makes no enhancement request', () => {
    const { result } = renderHook(() => useSharpSliceDisplay(null, { enabled: true, suspended: false }));
    expect(result.current.status).toBe('unavailable');
    expect(result.current.image).toBeUndefined();
    expect(mocks.request).not.toHaveBeenCalled();
  });

  it.each(['disable', 'suspend', 'unmount'] as const)(
    'cancels on %s and ignores later progress and completion',
    async (action) => {
      const source = frame();
      const job = deferred<typeof replacement>();
      mocks.request.mockReturnValue(job.promise);
      const { result, rerender, unmount } = renderHook((options) => useSharpSliceDisplay(source, options), {
        initialProps: { enabled: true, suspended: false },
      });
      await waitFor(() => expect(mocks.request).toHaveBeenCalledOnce());
      const options = mocks.request.mock.calls[0]![1];
      if (action === 'unmount') unmount();
      else rerender({ enabled: action !== 'disable', suspended: action === 'suspend' });
      expect(options.signal.aborted).toBe(true);
      await act(async () => {
        options.onProgress('Stale progress');
        job.resolve(replacement);
      });
      expect(mocks.present).not.toHaveBeenCalled();
      expect(result.current.image).toBeUndefined();
      expect(result.current.message).not.toBe('Stale progress');
    },
  );

  it('rejects a replaced source object even if its image ID is reused', async () => {
    const first = frame();
    const second = { ...frame(), pixels: Float32Array.from([5, 6, 7, 8]) };
    const oldJob = deferred<typeof replacement>();
    const newJob = deferred<typeof replacement>();
    mocks.request.mockReturnValueOnce(oldJob.promise).mockReturnValueOnce(newJob.promise);
    const { result, rerender } = renderHook(
      ({ source }) => useSharpSliceDisplay(source, { enabled: true, suspended: false }),
      { initialProps: { source: first } },
    );
    await waitFor(() => expect(mocks.request).toHaveBeenCalledOnce());
    const oldSignal = mocks.request.mock.calls[0]![1].signal;
    rerender({ source: second });
    await waitFor(() => expect(mocks.request).toHaveBeenCalledTimes(2));
    expect(oldSignal.aborted).toBe(true);
    await act(async () => oldJob.resolve(replacement));
    expect(mocks.present).not.toHaveBeenCalled();
    expect(result.current.image).toBeUndefined();
    await act(async () => newJob.resolve(replacement));
    expect(mocks.present.mock.calls[0]![0]).toBe(second);
    expect(result.current.image).toBe(image);
  });

  it('discards a late presentation conversion after its source changes', async () => {
    const source = frame();
    const conversion = deferred<DerivedImagePresentation>();
    mocks.request.mockResolvedValue(replacement);
    mocks.present.mockReturnValue(conversion.promise);
    const { result, rerender } = renderHook(
      ({ enabled }) => useSharpSliceDisplay(source, { enabled, suspended: false }),
      { initialProps: { enabled: true } },
    );
    await waitFor(() => expect(mocks.present).toHaveBeenCalledOnce());
    rerender({ enabled: false });
    await act(async () => conversion.resolve(image));
    expect(result.current.status).toBe('original');
    expect(result.current.image).toBeUndefined();
  });

  it('assigns a fresh render-cache identity when a completed source is replaced under the same image ID', async () => {
    const first = frame();
    mocks.request.mockResolvedValue(replacement);
    const { result, rerender } = renderHook(
      ({ source }) => useSharpSliceDisplay(source, { enabled: true, suspended: false }),
      { initialProps: { source: first } },
    );
    await waitFor(() => expect(result.current.status).toBe('ready'));
    const firstId = mocks.present.mock.calls[0]![1];
    rerender({ source: { ...first, pixels: Float32Array.from([4, 3, 2, 1]) } });
    await waitFor(() => expect(mocks.present).toHaveBeenCalledTimes(2));
    expect(mocks.present.mock.calls[1]![1]).not.toBe(firstId);
    expect(mocks.present.mock.calls[1]![1]).toContain(`${first.imageId}:sharp:`);
  });

  it('restarts cancelled work after interaction, but reuses a completed current image', async () => {
    const source = frame();
    const cancelledJob = deferred<typeof replacement>();
    mocks.request.mockReturnValueOnce(cancelledJob.promise).mockResolvedValue(replacement);
    const { result, rerender } = renderHook(
      ({ suspended }) => useSharpSliceDisplay(source, { enabled: true, suspended }),
      { initialProps: { suspended: false } },
    );
    await waitFor(() => expect(mocks.request).toHaveBeenCalledOnce());
    rerender({ suspended: true });
    expect(result.current.message).toBe('Enhancement paused');
    rerender({ suspended: false });
    await waitFor(() => expect(result.current.status).toBe('ready'));
    expect(mocks.request).toHaveBeenCalledTimes(2);
    rerender({ suspended: true });
    expect(result.current.image).toBe(image);
    rerender({ suspended: false });
    expect(mocks.request).toHaveBeenCalledTimes(2);
    await act(async () => cancelledJob.resolve(replacement));
    expect(mocks.present).toHaveBeenCalledOnce();
  });

  it('surfaces failure over the original without retry loops, and lets a fresh opt-in retry', async () => {
    const source = frame();
    mocks.request.mockRejectedValueOnce(new Error('Native geometry is unavailable')).mockResolvedValue(replacement);
    const { result, rerender } = renderHook(
      ({ enabled }) => useSharpSliceDisplay(source, { enabled, suspended: false }),
      { initialProps: { enabled: true } },
    );
    await waitFor(() => expect(result.current.status).toBe('error'));
    expect(result.current.message).toBe('Native geometry is unavailable');
    expect(result.current.image).toBeUndefined();
    expect(mocks.request).toHaveBeenCalledOnce();
    rerender({ enabled: false });
    rerender({ enabled: true });
    await waitFor(() => expect(result.current.status).toBe('ready'));
    expect(mocks.request).toHaveBeenCalledTimes(2);
  });
});
