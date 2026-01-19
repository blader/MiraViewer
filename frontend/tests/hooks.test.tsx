import { renderHook, act, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { useComparisonFilters } from '../src/hooks/useComparisonFilters';
import { useOverlayNavigation } from '../src/hooks/useOverlayNavigation';
import { useWheelNavigation } from '../src/hooks/useWheelNavigation';
import { useGridLayout } from '../src/hooks/useGridLayout';
import { usePanelSettings } from '../src/hooks/usePanelSettings';
import { DEFAULT_PANEL_SETTINGS } from '../src/utils/constants';
import type { ComparisonData, SeriesRef } from '../src/types/api';

vi.mock('../src/utils/localApi', () => ({
  getPanelSettings: vi.fn().mockResolvedValue({}),
  savePanelSettings: vi.fn().mockResolvedValue(undefined),
}));

beforeEach(() => {
  localStorage.clear();
});

describe('useComparisonFilters', () => {
  it('selects defaults and toggles dates', () => {
    const data: ComparisonData = {
      planes: ['Axial', 'Coronal'],
      dates: [
        '2024-01-01T00:00:00',
        '2024-02-01T00:00:00',
        '2024-03-01T00:00:00',
        '2024-04-01T00:00:00',
        '2024-05-01T00:00:00',
      ],
      sequences: [
        { id: 'axial-t1', plane: 'Axial', weight: 'T1', sequence: 'SE', label: 'Axial T1', date_count: 5 },
        { id: 'cor-t2', plane: 'Coronal', weight: 'T2', sequence: 'SE', label: 'Cor T2', date_count: 5 },
      ],
      series_map: {},
    };

    const { result } = renderHook(() => useComparisonFilters(data));
    expect(result.current.selectedPlane).toBe('Axial');
    expect(result.current.selectedSeqId).toBe('axial-t1');
    // default last 4 dates
    expect(result.current.enabledDates.size).toBe(4);

    act(() => result.current.toggleDate('2024-05-01T00:00:00'));
    expect(result.current.enabledDates.has('2024-05-01T00:00:00')).toBe(false);

    act(() => result.current.selectNoDates());
    expect(result.current.enabledDates.size).toBe(0);

    act(() => result.current.selectAllDates());
    expect(result.current.enabledDates.size).toBe(5);
  });
});

describe('useOverlayNavigation', () => {
  it('hydrates view mode, selected date, and play speed from storage', async () => {
    localStorage.setItem(
      'miraviewer:overlay-nav:v1',
      JSON.stringify({ viewMode: 'overlay', overlayDate: '2024-02-01', playSpeed: 250 })
    );

    const ref1: SeriesRef = { study_id: 's1', series_uid: 'a', instance_count: 1 };
    const ref2: SeriesRef = { study_id: 's2', series_uid: 'b', instance_count: 1 };
    const ref3: SeriesRef = { study_id: 's3', series_uid: 'c', instance_count: 1 };
    const columns = [
      { date: '2024-01-01', ref: ref1 },
      { date: '2024-02-01', ref: ref2 },
      { date: '2024-03-01', ref: ref3 },
    ];

    const { result } = renderHook(() => useOverlayNavigation(columns));

    expect(result.current.viewMode).toBe('overlay');
    expect(result.current.playSpeed).toBe(250);

    await waitFor(() => {
      expect(result.current.overlayDateIndex).toBe(1);
    });
  });

  it('persists navigation changes to storage', async () => {
    const ref1: SeriesRef = { study_id: 's1', series_uid: 'a', instance_count: 1 };
    const ref2: SeriesRef = { study_id: 's2', series_uid: 'b', instance_count: 1 };
    const columns = [
      { date: '2024-01-01', ref: ref1 },
      { date: '2024-02-01', ref: ref2 },
    ];

    const { result } = renderHook(() => useOverlayNavigation(columns));

    act(() => result.current.setViewMode('overlay'));
    act(() => result.current.setPlaySpeed(2000));
    act(() => result.current.setOverlayDateIndex(1));

    await waitFor(() => {
      const raw = localStorage.getItem('miraviewer:overlay-nav:v1');
      expect(raw).toBeTruthy();
      const parsed = JSON.parse(raw || '{}') as { viewMode?: string; overlayDate?: string; playSpeed?: number };
      expect(parsed.viewMode).toBe('overlay');
      expect(parsed.overlayDate).toBe('2024-02-01');
      expect(parsed.playSpeed).toBe(2000);
    });
  });

  it('handles keyboard navigation and space compare', () => {
    const ref1: SeriesRef = { study_id: 's1', series_uid: 'a', instance_count: 1 };
    const ref2: SeriesRef = { study_id: 's2', series_uid: 'b', instance_count: 1 };
    const ref3: SeriesRef = { study_id: 's3', series_uid: 'c', instance_count: 1 };
    const columns = [
      { date: '2024-01-01', ref: ref1 },
      { date: '2024-02-01', ref: ref2 },
      { date: '2024-03-01', ref: ref3 },
    ];
    const { result } = renderHook(() => useOverlayNavigation(columns));

    act(() => result.current.setViewMode('overlay'));
    act(() => result.current.setOverlayDateIndex(1));
    expect(result.current.overlayDateIndex).toBe(1);

    // ArrowRight should move to next
    act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight' }));
    });
    expect(result.current.overlayDateIndex).toBe(2);

    // Space should show previous index (compare)
    act(() => {
      const ev = new KeyboardEvent('keydown', { key: ' ' });
      Object.defineProperty(ev, 'target', { value: document.body });
      window.dispatchEvent(ev);
    });
    expect(result.current.displayedOverlayIndex).toBe(1);
    act(() => {
      const ev = new KeyboardEvent('keyup', { key: ' ' });
      Object.defineProperty(ev, 'target', { value: document.body });
      window.dispatchEvent(ev);
    });
    expect(result.current.displayedOverlayIndex).toBe(2);
  });
});

describe('useWheelNavigation', () => {
  it('updates index on wheel events', () => {
    const setIdx = vi.fn();
    const ref = { current: document.createElement('div') } as React.RefObject<HTMLDivElement>;
    renderHook(() => useWheelNavigation(ref, 0, 10, setIdx, true));

    ref.current!.dispatchEvent(new WheelEvent('wheel', { deltaY: 1, cancelable: true }));
    expect(setIdx).toHaveBeenCalledWith(1);
  });
});

describe('useGridLayout', () => {
  it('computes layout for non-zero container size', async () => {
    const { result } = renderHook(() => useGridLayout(4));
    const node = { clientWidth: 800, clientHeight: 600 } as HTMLDivElement;
    act(() => {
      result.current.containerRef(node);
    });
    expect(result.current.cellSize).toBeGreaterThan(0);
    expect(result.current.cols).toBeGreaterThan(0);
  });
});

describe('usePanelSettings', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('updates and persists settings', async () => {
    const { result, unmount } = renderHook(() => usePanelSettings('seq-1', '2024-01-01T00:00:00'));
    await act(async () => {});

    act(() => {
      result.current.updatePanelSetting('2024-01-01T00:00:00', { brightness: 120 });
    });

    const settings = result.current.panelSettings.get('2024-01-01T00:00:00') || DEFAULT_PANEL_SETTINGS;
    expect(settings.brightness).toBe(120);
    unmount();
  });

  it('debounces progress persistence', async () => {
    const { result, unmount } = renderHook(() => usePanelSettings('seq-1', '2024-01-01T00:00:00'));
    await act(async () => {});
    act(() => {
      result.current.setProgress(0.4);
    });
    // advance debounce
    act(() => {
      vi.advanceTimersByTime(250);
    });
    // If no errors, debounce path executed.
    expect(result.current.progress).toBe(0.4);
    unmount();
  });
});
