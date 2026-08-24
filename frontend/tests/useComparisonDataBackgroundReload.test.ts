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
});
