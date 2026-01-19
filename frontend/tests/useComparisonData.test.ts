import { describe, it, expect, vi } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import { useComparisonData } from '../src/hooks/useComparisonData';

vi.mock('../src/utils/localApi', () => ({
  getComparisonData: vi.fn(),
}));

import { getComparisonData } from '../src/utils/localApi';

describe('useComparisonData', () => {
  it('loads data and can reload', async () => {
    const first = {
      planes: ['Axial'],
      dates: ['2024-01-01T00:00:00'],
      sequences: [],
      series_map: {},
    };
    const second = {
      planes: ['Sagittal'],
      dates: ['2024-02-01T00:00:00'],
      sequences: [],
      series_map: {},
    };
    (getComparisonData as unknown as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce(first)
      .mockResolvedValueOnce(second);

    const { result } = renderHook(() => useComparisonData());

    await waitFor(() => {
      expect(result.current.data).toEqual(first);
    });

    await act(async () => {
      await result.current.reload();
    });

    expect(result.current.data).toEqual(second);
  });
});
