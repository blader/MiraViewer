import { renderHook, act, waitFor, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { useComparisonFilters } from '../src/hooks/useComparisonFilters';
import { useOverlayNavigation } from '../src/hooks/useOverlayNavigation';
import { useGridLayout } from '../src/hooks/useGridLayout';
import { useTestPanelSettings as usePanelSettings, verifiedSourcesForTest } from './helpers/panelSettings';
import { DEFAULT_PANEL_SETTINGS } from '../src/utils/constants';
import type { ComparisonData, SeriesRef } from '../src/types/api';
import { getPanelSettings, savePanelSettings } from '../src/utils/localApi';
import { deferred } from './helpers/deferred';
import { notifyDatasetMutation } from '../src/db/db';

vi.mock('../src/utils/localApi', () => ({
  getPanelSettings: vi.fn().mockResolvedValue({}),
  getPanelSettingsSnapshot: async (combo: string, patient: string | null, sources: Record<string, SeriesRef>) => ({
    datasetToken: 'test-dataset',
    settings: await getPanelSettings(combo, patient),
    verifiedSources: verifiedSourcesForTest(sources),
  }),
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
    // selectAllDates only selects dates that have data for the selected sequence.
    // This test uses an empty series_map, so all dates are effectively disabled.
    expect(result.current.enabledDates.size).toBe(0);
  });
});

describe('useOverlayNavigation', () => {
  it('keeps the selected and previous examinations attached to Study UID when columns are filtered or renamed', () => {
    const columns = ['2035-01-01', '2035-02-01', '2035-03-01'].map((date, index) => ({
      date,
      ref: { study_id: `study-${index}`, series_uid: `series-${index}`, instance_count: 10 },
    }));
    const { result, rerender } = renderHook(({ visible }) => useOverlayNavigation(visible), {
      initialProps: { visible: columns },
    });
    act(() => result.current.setOverlayDateIndex(1));
    rerender({ visible: columns.slice(1) });
    expect(result.current.overlayDateIndex).toBe(0);
    expect(result.current.compareTargetIndex).toBe(1);
    const renamed = columns.map((column) => ({ ...column, date: `${column.date}#${column.ref.study_id}` }));
    rerender({ visible: renamed });
    expect(result.current.overlayDateIndex).toBe(1);
    expect(result.current.compareTargetIndex).toBe(0);
    expect(JSON.parse(localStorage.getItem('miraviewer:overlay-nav:v1')!)).toMatchObject({
      overlayStudyUid: 'study-1',
    });
  });

  const keyboardColumns = ['2035-01-01', '2035-02-01'].map((date, i) => ({
    date,
    ref: { study_id: `study-${i}`, series_uid: `series-${i}`, instance_count: 1 },
  }));

  it.each(['button', 'a', 'summary', 'input', 'select', 'textarea', 'editable', 'role-button'])(
    'leaves Space and arrows with the focused %s control without blurring it',
    (kind) => {
      const { result } = renderHook(() => useOverlayNavigation(keyboardColumns));
      act(() => {
        result.current.setViewMode('overlay');
        result.current.setOverlayDateIndex(1);
      });
      const control = document.createElement(kind === 'editable' || kind === 'role-button' ? 'div' : kind);
      control.tabIndex = 0;
      if (kind === 'editable') control.setAttribute('contenteditable', 'true');
      if (kind === 'role-button') control.setAttribute('role', 'button');
      if (kind === 'a') control.setAttribute('href', '#synthetic');
      document.body.append(control);
      control.focus();
      try {
        for (const key of [' ', 'ArrowLeft', '1']) {
          const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true });
          fireEvent(control, event);
          expect(event.defaultPrevented).toBe(false);
          expect(result.current.displayedOverlayIndex).toBe(1);
          expect(document.activeElement).toBe(control);
        }
      } finally {
        control.remove();
      }
    },
  );

  it('keeps viewport focus during hold-to-compare, resets on blur, and respects consumed keys', () => {
    const { result } = renderHook(() => useOverlayNavigation(keyboardColumns));
    act(() => {
      result.current.setViewMode('overlay');
      result.current.setOverlayDateIndex(1);
    });
    const viewport = document.createElement('div');
    viewport.tabIndex = 0;
    viewport.setAttribute('role', 'group');
    document.body.append(viewport);
    viewport.focus();
    try {
      fireEvent.keyDown(viewport, { key: ' ' });
      expect(result.current.displayedOverlayIndex).toBe(0);
      expect(document.activeElement).toBe(viewport);
      fireEvent.blur(window);
      expect(result.current.displayedOverlayIndex).toBe(1);
      const consumed = new KeyboardEvent('keydown', { key: ' ', bubbles: true, cancelable: true });
      consumed.preventDefault();
      fireEvent(viewport, consumed);
      expect(result.current.displayedOverlayIndex).toBe(1);
    } finally {
      viewport.remove();
    }
  });

  it('lets focused examination buttons own hold-to-compare, arrow and number navigation', () => {
    const { result } = renderHook(() => useOverlayNavigation(keyboardColumns));
    act(() => {
      result.current.setViewMode('overlay');
      result.current.setOverlayDateIndex(1);
    });
    const control = document.createElement('button');
    control.dataset.overlayNavigation = 'date';
    document.body.append(control);
    control.focus();
    try {
      fireEvent.keyDown(control, { key: ' ' });
      expect(result.current.displayedOverlayIndex).toBe(0);
      fireEvent.keyUp(control, { key: ' ' });
      expect(result.current.displayedOverlayIndex).toBe(1);
      fireEvent.keyDown(control, { key: 'ArrowLeft' });
      expect(result.current.overlayDateIndex).toBe(0);
      fireEvent.keyDown(control, { key: '2' });
      expect(result.current.overlayDateIndex).toBe(1);
      expect(document.activeElement).toBe(control);
    } finally {
      control.remove();
    }
  });

  it('hydrates view mode, selected date, and play speed from storage', async () => {
    localStorage.setItem(
      'miraviewer:overlay-nav:v1',
      JSON.stringify({ viewMode: 'overlay', overlayDate: '2024-02-01', playSpeed: 250 }),
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

  it('compares against the closest full examination timestamp, including duplicate-study suffixes', async () => {
    const selectedExamination = '2035-02-01T12:00:00#synthetic-selected-study';
    localStorage.setItem(
      'miraviewer:overlay-nav:v1',
      JSON.stringify({ viewMode: 'overlay', overlayDate: selectedExamination }),
    );

    const columns = [
      {
        date: '2035-01-01T12:00:00#synthetic-older-study',
        ref: { study_id: 'older', series_uid: 'older', instance_count: 1 },
      },
      {
        date: selectedExamination,
        ref: { study_id: 'selected', series_uid: 'selected', instance_count: 1 },
      },
      {
        date: '2035-02-01T13:00:00#synthetic-nearer-study',
        ref: { study_id: 'nearer', series_uid: 'nearer', instance_count: 1 },
      },
    ];

    const { result } = renderHook(() => useOverlayNavigation(columns));

    await waitFor(() => expect(result.current.overlayDateIndex).toBe(1));
    expect(result.current.compareTargetIndex).toBe(2);
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

  it('retains the immediately preceding comparison target across same-event navigation', () => {
    const columns = [
      { date: '2024-01-01', ref: { study_id: 'one', series_uid: 'one', instance_count: 1 } },
      { date: '2024-02-01', ref: { study_id: 'two', series_uid: 'two', instance_count: 1 } },
      { date: '2024-03-01', ref: { study_id: 'three', series_uid: 'three', instance_count: 1 } },
    ];
    const { result } = renderHook(() => useOverlayNavigation(columns));

    act(() => {
      result.current.setViewMode('overlay');
      result.current.setOverlayDateIndex(1);
      result.current.setOverlayDateIndex(2);
    });

    expect(result.current.overlayDateIndex).toBe(2);
    expect(result.current.compareTargetIndex).toBe(1);
  });

  it('blocks overlay keyboard shortcuts and playback while a modal owns interaction', () => {
    const columns = [
      { date: 'first', ref: { study_id: 'one', series_uid: 'one', instance_count: 2 } },
      { date: 'second', ref: { study_id: 'two', series_uid: 'two', instance_count: 2 } },
    ];
    const { result, rerender } = renderHook(
      ({ blocked }) => useOverlayNavigation(columns, { interactionBlocked: blocked }),
      { initialProps: { blocked: false } },
    );

    act(() => {
      result.current.setViewMode('overlay');
      result.current.setIsPlaying(true);
    });
    rerender({ blocked: true });

    act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight' }));
    });

    expect(result.current.overlayDateIndex).toBe(0);
    expect(result.current.isPlaying).toBe(false);
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
    vi.mocked(getPanelSettings).mockReset().mockResolvedValue({});
    vi.mocked(savePanelSettings).mockReset().mockResolvedValue(undefined);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('preserves shared browsing progress when acquisition choices or display-date keys change', async () => {
    const date = '2035-01-01';
    const source = { study_id: 'study', series_uid: 'first', instance_count: 16 };
    const { result, rerender, unmount } = renderHook(
      ({ dates, sources }) => usePanelSettings('sequence', dates, 'patient', false, sources),
      {
        initialProps: { dates: date, sources: { [date]: source } as Record<string, SeriesRef> },
      },
    );
    await act(async () => {});
    act(() => result.current.setProgress(7 / 15));
    await act(async () =>
      rerender({ dates: date, sources: { [date]: { ...source, series_uid: 'alternative', instance_count: 20 } } }),
    );
    expect(result.current.progress).toBe(7 / 15);
    await act(async () =>
      rerender({
        dates: `${date}#study,${date}#other`,
        sources: {
          [`${date}#study`]: source,
          [`${date}#other`]: { ...source, study_id: 'other', series_uid: 'other' },
        },
      }),
    );
    expect(result.current.progress).toBe(7 / 15);
    unmount();
  });

  it('does not turn a failed read into writable defaults, and retries without losing saved work', async () => {
    const date = '2035-01-01';
    vi.mocked(getPanelSettings)
      .mockRejectedValueOnce(new Error('Recoverable read failure'))
      .mockResolvedValueOnce({ [date]: { ...DEFAULT_PANEL_SETTINGS, zoom: 2, panX: 0.2 } });
    const { result, unmount } = renderHook(() => usePanelSettings('sequence', date, 'patient'));
    await act(async () => {});
    expect(result.current.settingsReady).toBe(false);
    expect(result.current.persistenceError).toContain('Recoverable read failure');
    act(() => {
      result.current.updatePanelSetting(date, { zoom: 1.5, panX: 0.1 });
      result.current.setProgress(0.5);
      window.dispatchEvent(new Event('beforeunload'));
      vi.advanceTimersByTime(250);
    });
    expect(savePanelSettings).not.toHaveBeenCalled();
    expect(result.current.progress).toBe(0.5);
    expect(result.current.panelSettings.get(date)).toMatchObject({ zoom: 1.5, panX: 0.1 });
    await act(async () => result.current.retryLoad());
    expect(result.current.settingsReady).toBe(true);
    expect(result.current.panelSettings.get(date)).toMatchObject({ zoom: 2, panX: 0.2 });
    expect(result.current.persistenceError).toBeNull();
    act(() => vi.advanceTimersByTime(250));
    expect(savePanelSettings).not.toHaveBeenCalled();
    unmount();
  });

  it('never writes a date without an acquisition and chooses an available date for progress', async () => {
    const { result, unmount } = renderHook(() =>
      usePanelSettings('sequence', '2035-01-01,2035-02-01', 'patient', false, {
        '2035-01-01': { study_id: 'study', series_uid: 'series', instance_count: 10 },
      }),
    );
    await act(async () => {});
    expect(result.current.activePanel).toBe('2035-01-01');
    act(() => result.current.updatePanelSetting('2035-02-01', { zoom: 2 }));
    expect(savePanelSettings).not.toHaveBeenCalled();
    act(() => result.current.setProgress(0.5));
    act(() => vi.advanceTimersByTime(250));
    expect(savePanelSettings).toHaveBeenLastCalledWith(
      expect.objectContaining({ studyUid: 'study', seriesUid: 'series' }),
      expect.objectContaining({ progress: 0.5 }),
    );
    unmount();
  });

  it('does not retry failed hydration merely because an unchanged source map was recreated on render', async () => {
    const next = deferred<Record<string, typeof DEFAULT_PANEL_SETTINGS>>();
    vi.mocked(getPanelSettings)
      .mockRejectedValueOnce(new Error('Recoverable read failure'))
      .mockReturnValue(next.promise);
    const hook = renderHook(() =>
      usePanelSettings('sequence', 'date', 'patient', false, {
        date: { study_id: 'study', series_uid: 'series', instance_count: 10 },
      }),
    );
    try {
      await act(async () => {});
      expect(hook.result.current.settingsReady).toBe(false);
      expect(getPanelSettings).toHaveBeenCalledTimes(1);
    } finally {
      hook.unmount();
    }
  });

  it('retires mounted callbacks synchronously on replacement but keeps additive imports editable', async () => {
    const date = '2035-01-01';
    const { result, unmount } = renderHook(() => usePanelSettings('sequence', date, 'patient'));
    await act(async () => {});
    act(() => {
      notifyDatasetMutation('new-series');
      result.current.updatePanelSetting(date, { zoom: 2 });
    });
    expect(result.current.panelSettings.get(date)?.zoom).toBe(2);
    vi.mocked(savePanelSettings).mockClear();
    const staleUpdate = result.current.updatePanelSetting;
    act(() => {
      result.current.setProgress(0.5);
      notifyDatasetMutation();
      staleUpdate(date, { zoom: 3 });
      window.dispatchEvent(new Event('beforeunload'));
      vi.advanceTimersByTime(250);
    });
    expect(result.current.settingsReady).toBe(false);
    expect(savePanelSettings).not.toHaveBeenCalled();
    await act(async () => {});
    expect(getPanelSettings).toHaveBeenCalledTimes(1);
    unmount();
  });

  it('does not let automatic presentation updates fill undo history or write per-slice settings', async () => {
    const { result, unmount } = renderHook(() => usePanelSettings('seq-auto', '2024-01-01,2024-02-01'));
    await act(async () => {});
    act(() => result.current.updatePanelSetting('2024-02-01', { zoom: 1.4 }));
    vi.mocked(savePanelSettings).mockClear();
    act(() =>
      result.current.batchUpdateSettings(
        new Map([['2024-01-01', { ...DEFAULT_PANEL_SETTINGS, zoom: 1.2, offset: 5 }]]),
        'automatic-view',
        true,
      ),
    );
    expect(savePanelSettings).not.toHaveBeenCalled();
    expect(result.current.manuallyAdjustedDates.has('2024-01-01')).toBe(false);
    expect(result.current.manuallyAdjustedDates.has('2024-02-01')).toBe(true);
    act(() => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', metaKey: true, bubbles: true })));
    expect(result.current.panelSettings.get('2024-02-01')?.zoom).toBe(1);
    expect(result.current.panelSettings.get('2024-01-01')).toMatchObject({ zoom: 1.2, offset: 5 });
    unmount();
  });

  it('finishes owner hydration when visible dates change before the first read completes', async () => {
    const first = deferred<Record<string, typeof DEFAULT_PANEL_SETTINGS>>();
    vi.mocked(getPanelSettings)
      .mockReturnValueOnce(first.promise)
      .mockResolvedValueOnce({ '2024-01-01': { ...DEFAULT_PANEL_SETTINGS, zoom: 1.5 } });
    const { result, rerender, unmount } = renderHook(({ dates }) => usePanelSettings('seq-loading', dates, 'patient'), {
      initialProps: { dates: '2024-01-01,2024-02-01' },
    });
    expect(result.current.settingsReady).toBe(false);
    await act(async () => rerender({ dates: '2024-01-01' }));
    expect(result.current.settingsReady).toBe(true);
    expect(result.current.panelSettings.get('2024-01-01')?.zoom).toBe(1.5);
    await act(async () => first.resolve({ '2024-01-01': { ...DEFAULT_PANEL_SETTINGS, zoom: 4 } }));
    expect(result.current.panelSettings.get('2024-01-01')?.zoom).toBe(1.5);
    unmount();
  });

  it('preserves current automatic and manual settings while hydrating a newly visible examination', async () => {
    vi.mocked(getPanelSettings)
      .mockResolvedValueOnce({ '2024-01-01': { ...DEFAULT_PANEL_SETTINGS, zoom: 1.1 } })
      .mockResolvedValueOnce({
        '2024-01-01': { ...DEFAULT_PANEL_SETTINGS, zoom: 1.1 },
        '2024-02-01': { ...DEFAULT_PANEL_SETTINGS },
      });
    const { result, rerender, unmount } = renderHook(({ dates }) => usePanelSettings('seq-visible', dates, 'patient'), {
      initialProps: { dates: '2024-01-01' },
    });
    await act(async () => {});
    act(() =>
      result.current.batchUpdateSettings(
        new Map([['2024-01-01', { ...DEFAULT_PANEL_SETTINGS, zoom: 1.3 }]]),
        'auto',
        true,
      ),
    );
    await act(async () => rerender({ dates: '2024-01-01,2024-02-01' }));
    expect(result.current.panelSettings.get('2024-01-01')?.zoom).toBe(1.3);
    expect(result.current.panelSettings.has('2024-02-01')).toBe(true);
    unmount();
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

  it('preserves same-event panel edits and their independent undo/redo history', async () => {
    const date = '2024-01-01T00:00:00';
    const { result, unmount } = renderHook(() => usePanelSettings('seq-1', date));
    await act(async () => {});

    act(() => {
      result.current.updatePanelSetting(date, { brightness: 135 });
      result.current.updatePanelSetting(date, { zoom: 2 });
    });
    expect(result.current.panelSettings.get(date)).toMatchObject({ brightness: 135, zoom: 2 });

    act(() => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', metaKey: true, bubbles: true })));
    expect(result.current.panelSettings.get(date)).toMatchObject({ brightness: 135, zoom: 1 });

    act(() => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', metaKey: true, bubbles: true })));
    expect(result.current.panelSettings.get(date)).toMatchObject({ brightness: 100, zoom: 1 });

    act(() => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'y', ctrlKey: true, bubbles: true })));
    expect(result.current.panelSettings.get(date)).toMatchObject({ brightness: 135, zoom: 1 });

    act(() => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'y', ctrlKey: true, bubbles: true })));
    expect(result.current.panelSettings.get(date)).toMatchObject({ brightness: 135, zoom: 2 });
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

  it('exposes a failed durable settings write instead of reporting silent success', async () => {
    vi.mocked(savePanelSettings).mockRejectedValueOnce(new Error('IndexedDB quota exceeded'));
    const { result, unmount } = renderHook(() => usePanelSettings('seq-1', '2024-01-01'));
    await act(async () => {});

    await act(async () => {
      result.current.updatePanelSetting('2024-01-01', { brightness: 140 });
      await Promise.resolve();
    });

    expect(result.current.persistenceError).toMatch(/quota exceeded/i);
    unmount();
  });

  it('undoes incrementally arriving alignment results as one producing-run operation', async () => {
    const { result, unmount } = renderHook(() => usePanelSettings('seq-1', '2024-01-01,2024-02-01'));
    await act(async () => {});

    act(() => {
      result.current.batchUpdateSettings(
        new Map([['2024-01-01', { ...DEFAULT_PANEL_SETTINGS, zoom: 1.5 }]]),
        'alignment-run-1',
      );
    });
    act(() => {
      result.current.batchUpdateSettings(
        new Map([['2024-02-01', { ...DEFAULT_PANEL_SETTINGS, zoom: 2 }]]),
        'alignment-run-1',
      );
    });

    act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', metaKey: true, bubbles: true }));
    });

    expect(result.current.panelSettings.get('2024-01-01')?.zoom).toBe(1);
    expect(result.current.panelSettings.get('2024-02-01')?.zoom).toBe(1);
    unmount();
  });

  it('blocks undo and redo from moving the reference while a dialog owns viewer interaction', async () => {
    const date = '2035-01-10T12:00:00';
    const { result, rerender, unmount } = renderHook(
      ({ blocked }) => usePanelSettings('synthetic-sequence', date, null, blocked),
      { initialProps: { blocked: false } },
    );
    await act(async () => {});

    act(() => result.current.updatePanelSetting(date, { zoom: 2 }));
    rerender({ blocked: true });
    act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', metaKey: true, bubbles: true }));
    });
    expect(result.current.panelSettings.get(date)?.zoom).toBe(2);

    rerender({ blocked: false });
    act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', metaKey: true, bubbles: true }));
    });
    expect(result.current.panelSettings.get(date)?.zoom).toBe(1);

    rerender({ blocked: true });
    act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'y', ctrlKey: true, bubbles: true }));
    });
    expect(result.current.panelSettings.get(date)?.zoom).toBe(1);

    rerender({ blocked: false });
    act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'y', ctrlKey: true, bubbles: true }));
    });
    expect(result.current.panelSettings.get(date)?.zoom).toBe(2);
    unmount();
  });

  it('does not undo viewer geometry when another keyboard owner already consumed the shortcut', async () => {
    const date = '2035-01-10T12:00:00';
    const { result, unmount } = renderHook(() => usePanelSettings('synthetic-sequence', date));
    await act(async () => {});

    act(() => {
      result.current.updatePanelSetting(date, { zoom: 2 });
    });

    const consumedShortcut = new KeyboardEvent('keydown', {
      key: 'z',
      metaKey: true,
      bubbles: true,
      cancelable: true,
    });
    consumedShortcut.preventDefault();
    act(() => {
      window.dispatchEvent(consumedShortcut);
    });

    expect(result.current.panelSettings.get(date)?.zoom).toBe(2);
    unmount();
  });

  it('isolates settings, pending writes, progress, and undo history between patients with identical examinations', async () => {
    const date = '2035-01-10T12:00:00';
    let resolveSecondPatient!: (settings: Record<string, typeof DEFAULT_PANEL_SETTINGS>) => void;
    vi.mocked(getPanelSettings)
      .mockReset()
      .mockResolvedValueOnce({
        [date]: { ...DEFAULT_PANEL_SETTINGS, zoom: 2, brightness: 145, progress: 0.75 },
      })
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveSecondPatient = resolve;
          }),
      );
    vi.mocked(savePanelSettings).mockClear();

    const { result, rerender, unmount } = renderHook(
      ({ patientKey }) => usePanelSettings('shared-synthetic-sequence', date, patientKey),
      { initialProps: { patientKey: 'synthetic-patient-a' } },
    );
    await act(async () => {});

    expect(getPanelSettings).toHaveBeenLastCalledWith('shared-synthetic-sequence', 'synthetic-patient-a');
    expect(result.current.panelSettings.get(date)?.zoom).toBe(2);
    expect(result.current.progress).toBe(0.75);

    act(() => {
      result.current.updatePanelSetting(date, { brightness: 190 });
      result.current.setProgress(0.8);
    });
    expect(savePanelSettings).toHaveBeenLastCalledWith(
      expect.objectContaining({ studyUid: `synthetic-patient-a:${date}`, datasetToken: 'test-dataset' }),
      expect.objectContaining({ brightness: 190 }),
    );
    const writesBeforePatientSwitch = vi.mocked(savePanelSettings).mock.calls.length;

    rerender({ patientKey: 'synthetic-patient-b' });

    expect(result.current.panelSettings.size).toBe(0);
    expect(result.current.progress).toBe(0);

    act(() => {
      window.dispatchEvent(new Event('beforeunload'));
      vi.advanceTimersByTime(250);
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', metaKey: true, bubbles: true }));
    });
    expect(vi.mocked(savePanelSettings).mock.calls).toHaveLength(writesBeforePatientSwitch);

    await act(async () => {
      resolveSecondPatient({
        [date]: { ...DEFAULT_PANEL_SETTINGS, zoom: 1.25, brightness: 100, progress: 0.2 },
      });
    });

    expect(result.current.panelSettings.get(date)?.zoom).toBe(1.25);
    expect(result.current.panelSettings.get(date)?.brightness).toBe(100);
    expect(result.current.progress).toBe(0.2);
    expect(getPanelSettings).toHaveBeenLastCalledWith('shared-synthetic-sequence', 'synthetic-patient-b');

    act(() => {
      result.current.setProgress(0.35);
    });
    act(() => {
      vi.advanceTimersByTime(250);
    });
    expect(savePanelSettings).toHaveBeenLastCalledWith(
      expect.objectContaining({ studyUid: `synthetic-patient-b:${date}`, datasetToken: 'test-dataset' }),
      expect.objectContaining({ brightness: 100, progress: 0.35 }),
    );

    const writesBeforeUndo = vi.mocked(savePanelSettings).mock.calls.length;
    act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', metaKey: true, bubbles: true }));
    });
    expect(vi.mocked(savePanelSettings).mock.calls).toHaveLength(writesBeforeUndo);

    vi.mocked(getPanelSettings).mockResolvedValue({});
    unmount();
  });

  it('discards late viewer-settings hydration belonging to a previously selected patient', async () => {
    const date = '2035-01-10T12:00:00';
    let resolvePreviousPatient!: (settings: Record<string, typeof DEFAULT_PANEL_SETTINGS>) => void;
    vi.mocked(getPanelSettings)
      .mockReset()
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolvePreviousPatient = resolve;
          }),
      )
      .mockResolvedValueOnce({ [date]: { ...DEFAULT_PANEL_SETTINGS, zoom: 1.25, progress: 0.2 } });

    const { result, rerender, unmount } = renderHook(
      ({ patientKey }) => usePanelSettings('shared-synthetic-sequence', date, patientKey),
      { initialProps: { patientKey: 'synthetic-patient-a' } },
    );

    await act(async () => {
      rerender({ patientKey: 'synthetic-patient-b' });
    });
    expect(result.current.panelSettings.get(date)?.zoom).toBe(1.25);

    await act(async () => {
      resolvePreviousPatient({ [date]: { ...DEFAULT_PANEL_SETTINGS, zoom: 4, progress: 0.9 } });
    });

    expect(result.current.panelSettings.get(date)?.zoom).toBe(1.25);
    expect(result.current.progress).toBe(0.2);
    vi.mocked(getPanelSettings).mockResolvedValue({});
    unmount();
  });
});
