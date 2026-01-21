import { renderHook, waitFor } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import { useApplyAlignmentResults } from '../src/hooks/useApplyAlignmentResults';
import { DEFAULT_PANEL_SETTINGS } from '../src/utils/constants';
import type { AlignmentResult, ComparisonData, PanelSettings } from '../src/types/api';

describe('useApplyAlignmentResults', () => {
  it('applies alignment results and preserves reverseSliceOrder (adjusting offset)', async () => {
    const date = '2024-01-01T00:00:00';
    const seqId = 'seq-1';

    const computedSettings: PanelSettings = {
      ...DEFAULT_PANEL_SETTINGS,
      offset: 0,
      zoom: 1.2,
    };

    const alignmentResults: AlignmentResult[] = [
      {
        date,
        seriesUid: 'series-1',
        bestSliceIndex: 2,
        nmiScore: 1.23,
        computedSettings,
        slicesChecked: 10,
      },
    ];

    const panelSettings = new Map<string, PanelSettings>([
      [date, { ...DEFAULT_PANEL_SETTINGS, reverseSliceOrder: true }],
    ]);

    const data: ComparisonData = {
      planes: ['Axial'],
      dates: [date],
      sequences: [
        {
          id: seqId,
          plane: 'Axial',
          weight: 'T1',
          sequence: 'SE',
          label: 'Axial T1 SE',
          date_count: 1,
        },
      ],
      series_map: {
        [seqId]: {
          [date]: { study_id: 'study-1', series_uid: 'series-1', instance_count: 10 },
        },
      },
    };

    const batchUpdateSettings = vi.fn();

    renderHook(() =>
      useApplyAlignmentResults({
        isAligning: true,
        alignmentResults,
        panelSettings,
        data,
        selectedSeqId: seqId,
        batchUpdateSettings,
      })
    );

    await waitFor(() => {
      expect(batchUpdateSettings).toHaveBeenCalledTimes(1);
    });

    const pending = batchUpdateSettings.mock.calls[0]?.[0] as Map<string, PanelSettings>;
    expect(pending.size).toBe(1);

    const applied = pending.get(date);
    expect(applied).toBeTruthy();

    // With reverseSliceOrder and instanceCount=10: max=9; desiredLogicalIndex=7; delta=5.
    expect(applied?.offset).toBe(5);
    expect(applied?.reverseSliceOrder).toBe(true);
    expect(applied?.zoom).toBe(1.2);
  });

  it('does not re-apply results for dates already applied', async () => {
    const date = '2024-01-01T00:00:00';
    const seqId = 'seq-1';

    const computedSettings: PanelSettings = {
      ...DEFAULT_PANEL_SETTINGS,
      offset: 0,
    };

    const alignmentResults: AlignmentResult[] = [
      {
        date,
        seriesUid: 'series-1',
        bestSliceIndex: 0,
        nmiScore: 1,
        computedSettings,
        slicesChecked: 1,
      },
    ];

    const panelSettings = new Map<string, PanelSettings>([[date, { ...DEFAULT_PANEL_SETTINGS }]]);

    const data: ComparisonData = {
      planes: ['Axial'],
      dates: [date],
      sequences: [
        {
          id: seqId,
          plane: 'Axial',
          weight: 'T1',
          sequence: 'SE',
          label: 'Axial T1 SE',
          date_count: 1,
        },
      ],
      series_map: {
        [seqId]: {
          [date]: { study_id: 'study-1', series_uid: 'series-1', instance_count: 10 },
        },
      },
    };

    const batchUpdateSettings = vi.fn();

    const { rerender } = renderHook(
      (props: { results: AlignmentResult[] }) =>
        useApplyAlignmentResults({
          isAligning: true,
          alignmentResults: props.results,
          panelSettings,
          data,
          selectedSeqId: seqId,
          batchUpdateSettings,
        }),
      {
        initialProps: { results: alignmentResults },
      }
    );

    await waitFor(() => {
      expect(batchUpdateSettings).toHaveBeenCalledTimes(1);
    });

    batchUpdateSettings.mockClear();

    // New array reference with the same date should be ignored.
    rerender({ results: [...alignmentResults] });

    await waitFor(() => {
      expect(batchUpdateSettings).not.toHaveBeenCalled();
    });
  });
});
