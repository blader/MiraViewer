import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useVisibleAlignment } from '../src/hooks/useVisibleAlignment';
import { DEFAULT_PANEL_SETTINGS } from '../src/utils/constants';
import type { ComparisonData } from '../src/types/api';

type Options = Parameters<typeof useVisibleAlignment>[0];
const reference = { study_id: 'study-new', series_uid: 'new', instance_count: 101, rows: 512, columns: 512 };
const target = { study_id: 'study-old', series_uid: 'old', instance_count: 101 };
const data: ComparisonData = {
  planes: ['Axial'],
  sequences: [],
  dates: ['new', 'old'],
  selected_patient_key: 'patient',
  dataset_revision: 4,
  series_map: { flair: { new: reference, old: target } },
};

function options(overrides: Partial<Options> = {}): Options {
  return {
    data,
    sequenceId: 'flair',
    columns: [
      { date: 'new', ref: reference },
      { date: 'old', ref: target },
    ],
    panelSettings: new Map(),
    progress: 0.5,
    viewportSize: 512,
    outputMode: 'native',
    enabled: true,
    settingsReady: true,
    alignAllDates: vi.fn(async () => []),
    abort: vi.fn(),
    ...overrides,
  };
}
const settle = async (props?: Options, calls = 1) => {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(650);
  });
  if (props) expect(props.alignAllDates).toHaveBeenCalledTimes(calls);
};

describe('visible background alignment', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('uses the first visible scan after a quiet interval without a tumor selection', async () => {
    const props = options();
    const { result } = renderHook(() => useVisibleAlignment(props));
    expect(props.alignAllDates).not.toHaveBeenCalled();
    await settle();
    expect(props.alignAllDates).toHaveBeenCalledWith(
      expect.objectContaining({
        date: 'new',
        seriesUid: 'new',
        sliceIndex: 50,
        patientKey: 'patient',
        datasetRevision: 4,
      }),
      ['old'],
      data.series_map.flair,
      0.5,
      expect.objectContaining({
        reuseRegistration: true,
        requestKey: result.current.activeRequestKey,
      }),
    );
    expect(vi.mocked(props.alignAllDates).mock.calls[0]![0].exclusionMask).toBeUndefined();
  });

  it('does not restart when automatic target settings or persisted progress change', async () => {
    const props = options();
    const { result, rerender } = renderHook(useVisibleAlignment, { initialProps: props });
    await settle();
    const key = result.current.activeRequestKey;
    rerender({
      ...props,
      panelSettings: new Map([
        ['old', { ...DEFAULT_PANEL_SETTINGS, offset: 4, zoom: 1.07 }],
        ['new', { ...DEFAULT_PANEL_SETTINGS, progress: 0.5 }],
      ]),
    });
    await settle(props, 1);
    expect(result.current.activeRequestKey).toBe(key);
  });

  it('cancels superseded browsing and publishes a different application identity', async () => {
    const props = options();
    const { result, rerender, unmount } = renderHook(useVisibleAlignment, { initialProps: props });
    await settle();
    const initial = result.current.activeRequestKey;
    rerender({ ...props, progress: 0.6 });
    rerender({ ...props, progress: 0.7 });
    expect(props.abort).toHaveBeenCalled();
    expect(result.current.activeRequestKey).not.toBe(initial);
    await settle(props, 2);
    expect(vi.mocked(props.alignAllDates).mock.lastCall![0].sliceIndex).toBe(70);
    unmount();
    expect(props.abort).toHaveBeenCalledTimes(3);
  });

  it('aligns only visible non-manual targets, and never changes reference to the last edited target', async () => {
    const props = options({
      columns: [
        { date: 'new', ref: reference },
        { date: 'old', ref: target },
        { date: 'third', ref: { ...target, series_uid: 'third' } },
      ],
      manuallyAdjustedDates: new Set(['old']),
    });
    renderHook(() => useVisibleAlignment(props));
    await settle();
    expect(vi.mocked(props.alignAllDates).mock.lastCall![0].seriesUid).toBe('new');
    expect(vi.mocked(props.alignAllDates).mock.lastCall![1]).toEqual(['third']);
  });

  it('pauses for hidden documents and resumes once, without a retry loop after a failure', async () => {
    const props = options({
      alignAllDates: vi.fn(async () => {
        throw new Error('not enough anatomy');
      }),
    });
    const { result, rerender } = renderHook(useVisibleAlignment, { initialProps: props });
    await settle();
    await settle(props, 1);
    act(() => {
      vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
      document.dispatchEvent(new Event('visibilitychange'));
    });
    expect(result.current.activeRequestKey).toBeNull();
    rerender({ ...props, enabled: false });
    await settle(props, 1);
    act(() => {
      vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
      document.dispatchEvent(new Event('visibilitychange'));
    });
    rerender(props);
    await settle(props, 2);
  });

  it.each([
    { settingsReady: false },
    { viewportSize: 0 },
    { sequenceId: null },
    { data: null },
    { data: { ...data, selected_patient_key: undefined } },
    { columns: [{ date: 'new', ref: reference }] },
  ])('does not register before its live identity and settings are ready: %j', async (override) => {
    const props = options(override);
    renderHook(() => useVisibleAlignment(props));
    await settle();
    expect(props.alignAllDates).not.toHaveBeenCalled();
  });

  it('explicit Realign changes the request and retries the current view', async () => {
    const props = options();
    const { result } = renderHook(() => useVisibleAlignment(props));
    await settle();
    const key = result.current.activeRequestKey;
    act(() => result.current.realign());
    expect(result.current.activeRequestKey).not.toBe(key);
    await settle(props, 2);
  });
});
