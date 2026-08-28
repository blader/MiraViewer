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
import { retainedSvrVolumeBytes } from '../src/utils/svr/nativeVolume';

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

  it('publishes transferred annotations atomically with their finer volume and never carries reviewed status forward', async () => {
    const previous = volume(0.4),
      next = volume(0.8);
    mocks.reconstructVolumeMultiPlane.mockResolvedValueOnce(next);
    const states: ReturnType<typeof useSvrReconstruction>[] = [];
    const { result } = renderHook(() => {
      const state = useSvrReconstruction();
      states.push(state);
      return state;
    });
    const labels = {
      data: Uint8Array.of(1),
      dims: previous.volume.dims,
      meta: [{ id: 1, name: 'Selected tissue', color: [103, 207, 193] as [number, number, number] }],
      reviewState: 'reviewed' as const,
      seeds: { foreground: Uint32Array.of(0), background: new Uint32Array() },
    };
    await act(async () => {
      await result.current.run(selectedSeries, undefined, 'patient-a', { volume: previous.volume, labels });
    });
    const accepted = states.filter((state) => state.status === 'ready');
    expect(accepted.length).toBeGreaterThan(0);
    for (const state of accepted) {
      expect(state.result?.volume).toBe(next.volume);
      expect(state.result?.initialSelection?.reviewState).toBe('draft');
      expect(state.result?.initialSelection?.data[0]).toBe(1);
    }
    expect(labels.reviewState).toBe('reviewed');
  });

  it('retains the previous result if an annotation cannot be transferred safely', async () => {
    const previous = volume(0.4);
    mocks.reconstructVolumeMultiPlane.mockResolvedValueOnce(previous).mockResolvedValueOnce(volume(0.8));
    const { result } = renderHook(() => useSvrReconstruction());
    await act(async () => {
      await result.current.run(selectedSeries, undefined, 'patient-a');
    });
    await act(async () => {
      await result.current.run(selectedSeries, undefined, 'patient-a', {
        volume: previous.volume,
        labels: { data: Uint8Array.of(1, 1), dims: [2, 1, 1], meta: [] },
      });
    });
    expect(result.current.status).toBe('failed');
    expect(result.current.result).toBe(previous);
    expect(result.current.error).toMatch(/geometry/);
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

  it('budgets the accepted raw/display owners for ordinary reruns, including retries, and releases them only on clear', async () => {
    const previous = volume(-320);
    previous.volume.intensityRange = [-320, 120];
    mocks.reconstructVolumeMultiPlane
      .mockResolvedValueOnce(previous)
      .mockRejectedValueOnce(new Error('Native region exceeds memory budget'))
      .mockResolvedValueOnce(volume(4))
      .mockResolvedValueOnce(volume(5));
    const { result } = renderHook(() => useSvrReconstruction());
    await act(async () => {
      await result.current.run(selectedSeries);
    });
    expect(mocks.reconstructVolumeMultiPlane.mock.calls[0]![0].retainedBytes).toBe(0);
    await act(async () => {
      await result.current.run(selectedSeries);
    });
    expect(mocks.reconstructVolumeMultiPlane.mock.calls[1]![0].retainedBytes).toBe(
      retainedSvrVolumeBytes(previous.volume),
    );
    expect(result.current.result).toBe(previous);
    await act(async () => {
      await result.current.run(selectedSeries);
    });
    expect(mocks.reconstructVolumeMultiPlane.mock.calls[2]![0].retainedBytes).toBe(
      retainedSvrVolumeBytes(previous.volume),
    );
    act(() => result.current.clear());
    await act(async () => {
      await result.current.run(selectedSeries);
    });
    expect(mocks.reconstructVolumeMultiPlane.mock.calls[3]![0].retainedBytes).toBe(0);
  });

  it('counts a shared accepted refinement source once and passes its accepted source poses unchanged', async () => {
    const previous = volume(1);
    previous.volume.sourceProvenance = {
      mode: 'native-3d',
      datasetRevision: 7,
      patientKey: 'patient',
      studyUid: 'study-a',
      frameOfReferenceUid: 'frame-a',
      fingerprint: 'accepted',
      primarySeriesUid: 'source-axial',
      explanation: 'Native source',
      sources: [],
    };
    mocks.reconstructVolumeMultiPlane.mockResolvedValueOnce(previous).mockResolvedValueOnce(volume(2));
    const { result } = renderHook(() => useSvrReconstruction());
    await act(async () => {
      await result.current.run(selectedSeries);
    });
    await act(async () => {
      await result.current.run(selectedSeries, undefined, 'patient', {
        volume: previous.volume,
        labels: { data: Uint8Array.of(1), dims: [1, 1, 1], meta: [] },
      });
    });
    expect(mocks.reconstructVolumeMultiPlane.mock.calls[1]![0]).toMatchObject({
      retainedBytes: retainedSvrVolumeBytes(previous.volume),
      acceptedProvenance: previous.volume.sourceProvenance,
    });
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
