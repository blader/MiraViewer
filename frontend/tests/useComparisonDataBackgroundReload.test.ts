import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useComparisonData } from '../src/hooks/useComparisonData';
import type { ComparisonData } from '../src/types/api';

vi.mock('../src/utils/localApi', () => ({
  getComparisonData: vi.fn(),
  setSelectedPatientKey: vi.fn(),
}));

import { getComparisonData } from '../src/utils/localApi';

const initialData: ComparisonData = {
  planes: ['Axial'],
  dates: ['2026-01-01'],
  sequences: [],
  series_map: {},
};

describe('useComparisonData import-safe background refresh', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('retains existing content while imported comparison data loads in the background', async () => {
    let resolveRefresh!: (value: ComparisonData) => void;
    const updatedData: ComparisonData = { ...initialData, dates: ['2026-01-02'] };
    vi.mocked(getComparisonData)
      .mockResolvedValueOnce(initialData)
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveRefresh = resolve;
          }),
      );

    const { result } = renderHook(() => useComparisonData());
    await waitFor(() => expect(result.current.loading).toBe(false));

    let pendingRefresh!: Promise<void>;
    act(() => {
      pendingRefresh = result.current.reload(undefined, { background: true });
    });

    expect(result.current.loading).toBe(false);
    expect(result.current.data).toEqual(initialData);

    await act(async () => {
      resolveRefresh(updatedData);
      await pendingRefresh;
    });

    expect(result.current.loading).toBe(false);
    expect(result.current.data).toEqual(updatedData);
  });

  it('reports a failed background refresh to its caller without replacing the current application', async () => {
    vi.mocked(getComparisonData)
      .mockResolvedValueOnce(initialData)
      .mockRejectedValueOnce(new Error('Local browser storage is temporarily unavailable.'));

    const { result } = renderHook(() => useComparisonData());
    await waitFor(() => expect(result.current.loading).toBe(false));

    await act(async () => {
      await expect(result.current.reload(undefined, { background: true })).rejects.toThrow(
        'Local browser storage is temporarily unavailable.',
      );
    });

    expect(result.current.loading).toBe(false);
    expect(result.current.error).toBeNull();
    expect(result.current.data).toEqual(initialData);
  });

  it('does not let a stale background refresh replace a newer patient selection', async () => {
    const firstPatient = { ...initialData, selected_patient_key: 'synthetic-patient-a' };
    const secondPatient = {
      ...initialData,
      dates: ['2035-02-01'],
      selected_patient_key: 'synthetic-patient-b',
    };
    let resolveBackgroundRefresh!: (value: ComparisonData) => void;
    vi.mocked(getComparisonData)
      .mockResolvedValueOnce(firstPatient)
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveBackgroundRefresh = resolve;
          }),
      )
      .mockResolvedValueOnce(secondPatient);

    const { result } = renderHook(() => useComparisonData());
    await waitFor(() => expect(result.current.data).toEqual(firstPatient));

    let backgroundRefresh!: Promise<void>;
    act(() => {
      backgroundRefresh = result.current.reload(undefined, { background: true });
    });

    await act(async () => {
      await result.current.selectPatient('synthetic-patient-b');
    });
    expect(result.current.data).toEqual(secondPatient);

    await act(async () => {
      resolveBackgroundRefresh(firstPatient);
      await backgroundRefresh;
    });

    expect(result.current.data).toEqual(secondPatient);
    expect(result.current.loading).toBe(false);
    expect(result.current.error).toBeNull();
  });

  it('does not let the initial patient load replace a newer explicit patient selection', async () => {
    const firstPatient = { ...initialData, selected_patient_key: 'synthetic-patient-a' };
    const secondPatient = { ...initialData, selected_patient_key: 'synthetic-patient-b' };
    let resolveInitialLoad!: (value: ComparisonData) => void;
    vi.mocked(getComparisonData)
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveInitialLoad = resolve;
          }),
      )
      .mockResolvedValueOnce(secondPatient);

    const { result } = renderHook(() => useComparisonData());

    await act(async () => {
      await result.current.selectPatient('synthetic-patient-b');
    });
    expect(result.current.data).toEqual(secondPatient);

    await act(async () => {
      resolveInitialLoad(firstPatient);
    });

    expect(result.current.data).toEqual(secondPatient);
    expect(result.current.loading).toBe(false);
  });

  it('clears a superseded foreground spinner when the latest background refresh completes', async () => {
    const refreshedPatient = {
      ...initialData,
      dates: ['2035-03-01'],
      selected_patient_key: 'synthetic-patient-b',
    };
    let resolveSupersededSelection!: (value: ComparisonData) => void;
    vi.mocked(getComparisonData)
      .mockResolvedValueOnce(initialData)
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveSupersededSelection = resolve;
          }),
      )
      .mockResolvedValueOnce(refreshedPatient);

    const { result } = renderHook(() => useComparisonData());
    await waitFor(() => expect(result.current.loading).toBe(false));

    let supersededSelection!: Promise<void>;
    await act(async () => {
      supersededSelection = result.current.selectPatient('synthetic-patient-b');
      await Promise.resolve();
    });
    expect(result.current.loading).toBe(true);

    await act(async () => {
      await result.current.reload(undefined, { background: true });
    });

    expect(result.current.data).toEqual(refreshedPatient);
    expect(result.current.loading).toBe(false);

    await act(async () => {
      resolveSupersededSelection(initialData);
      await supersededSelection;
    });

    expect(result.current.data).toEqual(refreshedPatient);
    expect(result.current.loading).toBe(false);
  });
});
