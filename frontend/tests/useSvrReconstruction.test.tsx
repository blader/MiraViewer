import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SvrProgress, SvrResult, SvrSelectedSeries } from '../src/types/svr';

const mocks = vi.hoisted(() => ({
  reconstructVolumeMultiPlane: vi.fn(),
}));

vi.mock('../src/utils/svr/reconstructVolume', () => ({
  reconstructVolumeMultiPlane: mocks.reconstructVolumeMultiPlane,
}));

import { useSvrReconstruction } from '../src/hooks/useSvrReconstruction';

const selectedSeries: SvrSelectedSeries[] = [
  {
    seriesUid: 'source-axial',
    studyId: 'study-a',
    dateIso: '2026-08-24',
    instanceCount: 3,
    label: 'Axial T2',
    plane: 'Axial',
  },
  {
    seriesUid: 'source-coronal',
    studyId: 'study-a',
    dateIso: '2026-08-24',
    instanceCount: 3,
    label: 'Coronal T2',
    plane: 'Coronal',
  },
];

function volume(value: number): SvrResult {
  return {
    volume: {
      data: Float32Array.of(value),
      dims: [1, 1, 1],
      voxelSizeMm: [1, 1, 1],
      originMm: [0, 0, 0],
      boundsMm: { min: [0, 0, 0], max: [1, 1, 1] },
      observedSupport: Uint8Array.of(1),
    },
  };
}

describe('useSvrReconstruction', () => {
  beforeEach(() => {
    mocks.reconstructVolumeMultiPlane.mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('publishes a result with its immutable operation identity and clears terminal progress', async () => {
    mocks.reconstructVolumeMultiPlane.mockResolvedValueOnce(volume(1));
    const { result } = renderHook(() => useSvrReconstruction());

    await act(async () => {
      await result.current.run(selectedSeries, undefined, 'patient-a|study-a|revision-2');
    });

    expect(result.current.status).toBe('ready');
    expect(result.current.isRunning).toBe(false);
    expect(result.current.progress).toBeNull();
    expect(result.current.result?.volume.data[0]).toBe(1);
    expect(result.current.resultIdentity).toBe('patient-a|study-a|revision-2');
  });

  it('does not allow progress to move backward across reconstruction phases', async () => {
    let resolveRun: ((result: SvrResult) => void) | undefined;
    let timestamp = 0;
    vi.spyOn(Date, 'now').mockImplementation(() => (timestamp += 200));
    mocks.reconstructVolumeMultiPlane.mockImplementationOnce(
      ({ onProgress }: { onProgress: (progress: SvrProgress) => void }) =>
        new Promise<SvrResult>((resolve) => {
          resolveRun = resolve;
          onProgress({ phase: 'loading', current: 80, total: 100, message: 'Decoding source slices' });
          onProgress({ phase: 'reconstructing', current: 55, total: 100, message: 'Reconstructing anatomy' });
        }),
    );
    const { result } = renderHook(() => useSvrReconstruction());
    let pending: ReturnType<typeof result.current.run>;

    await act(async () => {
      pending = result.current.run(selectedSeries);
      await Promise.resolve();
    });

    expect(result.current.progress).toMatchObject({
      current: 80,
      total: 100,
      message: 'Reconstructing anatomy',
    });

    await act(async () => {
      resolveRun?.(volume(2));
      await pending!;
    });
  });

  it('retains the last accepted same-context result when a replacement fails', async () => {
    mocks.reconstructVolumeMultiPlane
      .mockResolvedValueOnce(volume(3))
      .mockRejectedValueOnce(new Error('Worker failed'));
    const { result } = renderHook(() => useSvrReconstruction());

    await act(async () => {
      await result.current.run(selectedSeries, undefined, 'patient-a');
    });

    await act(async () => {
      await result.current.run(selectedSeries, undefined, 'patient-a');
    });

    expect(result.current.status).toBe('failed');
    expect(result.current.error).toBe('Worker failed');
    expect(result.current.result?.volume.data[0]).toBe(3);
    expect(result.current.resultIdentity).toBe('patient-a');
  });

  it('never lets a superseded operation replace a newer accepted result', async () => {
    let resolveFirst: ((result: SvrResult) => void) | undefined;
    mocks.reconstructVolumeMultiPlane
      .mockImplementationOnce(
        () =>
          new Promise<SvrResult>((resolve) => {
            resolveFirst = resolve;
          }),
      )
      .mockResolvedValueOnce(volume(5));

    const { result } = renderHook(() => useSvrReconstruction());
    let firstRun: ReturnType<typeof result.current.run>;

    await act(async () => {
      firstRun = result.current.run(selectedSeries, undefined, 'patient-a');
      await Promise.resolve();
    });

    await act(async () => {
      await result.current.run(selectedSeries, undefined, 'patient-b');
    });

    await act(async () => {
      resolveFirst?.(volume(4));
      await firstRun!;
    });

    expect(result.current.status).toBe('ready');
    expect(result.current.result?.volume.data[0]).toBe(5);
    expect(result.current.resultIdentity).toBe('patient-b');
  });

  it('preserves the accepted result and clears failure state after cancellation', async () => {
    mocks.reconstructVolumeMultiPlane.mockResolvedValueOnce(volume(6)).mockImplementationOnce(
      ({ signal }: { signal: AbortSignal }) =>
        new Promise<SvrResult>((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(new Error('SVR cancelled')));
        }),
    );
    const { result } = renderHook(() => useSvrReconstruction());

    await act(async () => {
      await result.current.run(selectedSeries, undefined, 'patient-a');
    });

    let pending: ReturnType<typeof result.current.run>;
    await act(async () => {
      pending = result.current.run(selectedSeries, undefined, 'patient-a');
      await Promise.resolve();
    });

    await act(async () => {
      result.current.cancel();
      await pending!;
    });

    expect(result.current.status).toBe('canceled');
    expect(result.current.error).toBeNull();
    expect(result.current.progress).toBeNull();
    expect(result.current.result?.volume.data[0]).toBe(6);
    expect(result.current.resultIdentity).toBe('patient-a');
  });
});
