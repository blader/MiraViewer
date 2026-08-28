import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useVisibleAlignment } from '../src/hooks/useVisibleAlignment';
import { DEFAULT_PANEL_SETTINGS } from '../src/utils/constants';
import { DEFAULT_ALIGNMENT_ADJUSTMENT } from '../src/utils/alignmentAdjustment';
import { clearDerivedAlignmentFrames, setDerivedAlignmentFrame } from '../src/utils/derivedAlignmentFrame';
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
    clearDerivedAlignmentFrames();
    vi.useFakeTimers();
    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
  });
  afterEach(() => {
    act(() => clearDerivedAlignmentFrames());
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

  it('does not cancel or register again for progress changes that still show the same slice', async () => {
    const props = options();
    const { result, rerender } = renderHook(useVisibleAlignment, { initialProps: props });
    await settle(props);
    const key = result.current.activeRequestKey;

    rerender({ ...props, progress: 0.5001 });
    rerender({ ...props, progress: 0.502 });

    expect(result.current.activeRequestKey).toBe(key);
    expect(props.abort).not.toHaveBeenCalled();
    await settle(props);
  });

  it('keeps the original quiet interval while repeated input remains on the same physical slice', async () => {
    const props = options();
    const { result, rerender } = renderHook(useVisibleAlignment, { initialProps: props });
    const key = result.current.activeRequestKey;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(600);
    });

    rerender({ ...props, progress: 0.501 });
    expect(result.current.activeRequestKey).toBe(key);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(50);
    });

    expect(props.alignAllDates).toHaveBeenCalledOnce();
    expect(props.abort).not.toHaveBeenCalled();
    expect(vi.mocked(props.alignAllDates).mock.lastCall![0].sliceIndex).toBe(50);
  });

  it('reuses accepted registration immediately when browsing a new slice', async () => {
    const canReuseRegistration = vi.fn(() => true);
    const props = options({ canReuseRegistration });
    const { result, rerender } = renderHook(useVisibleAlignment, { initialProps: props });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });

    expect(props.alignAllDates).toHaveBeenCalledOnce();
    expect(canReuseRegistration).toHaveBeenCalledWith(
      expect.objectContaining({ seriesUid: 'new', sliceIndex: 50, patientKey: 'patient', datasetRevision: 4 }),
      ['old'],
      data.series_map.flair,
      'native',
    );
    const previousKey = result.current.activeRequestKey;

    rerender({ ...props, progress: 0.51 });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });

    expect(props.abort).toHaveBeenCalledOnce();
    expect(props.alignAllDates).toHaveBeenCalledTimes(2);
    expect(result.current.activeRequestKey).not.toBe(previousKey);
    expect(vi.mocked(props.alignAllDates).mock.lastCall![0].sliceIndex).toBe(51);
    expect(vi.mocked(props.alignAllDates).mock.lastCall![4]).toMatchObject({
      reuseRegistration: true,
      requestKey: result.current.activeRequestKey,
    });
  });

  it('still debounces a cold registration when a visible target cannot reuse the accepted pose', async () => {
    const props = options({ canReuseRegistration: vi.fn(() => false) });
    renderHook(() => useVisibleAlignment(props));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(649);
    });
    expect(props.alignAllDates).not.toHaveBeenCalled();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    expect(props.alignAllDates).toHaveBeenCalledOnce();
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

  it('keeps manually adjusted targets linked and never changes reference to the last edited target', async () => {
    const props = options({
      columns: [
        { date: 'new', ref: reference },
        { date: 'old', ref: target },
        { date: 'third', ref: { ...target, series_uid: 'third' } },
      ],
      panelSettings: new Map([
        [
          'old',
          {
            ...DEFAULT_PANEL_SETTINGS,
            panX: 0.1,
            alignmentAdjustment: { ...DEFAULT_ALIGNMENT_ADJUSTMENT, panX: 0.1 },
          },
        ],
      ]),
    });
    renderHook(() => useVisibleAlignment(props));
    await settle();
    expect(vi.mocked(props.alignAllDates).mock.lastCall![0].seriesUid).toBe('new');
    expect(vi.mocked(props.alignAllDates).mock.lastCall![1]).toEqual(['old', 'third']);
  });

  it('only excludes explicit acquired-image pauses and retains their presentation authority when all targets pause', async () => {
    const props = options({
      panelSettings: new Map([['old', { ...DEFAULT_PANEL_SETTINGS, alignmentPaused: true }]]),
    });
    const { result } = renderHook(() => useVisibleAlignment(props));
    await settle();
    expect(props.alignAllDates).not.toHaveBeenCalled();
    expect(result.current.activeRequestKey).toBeNull();
    expect(result.current.targetCount).toBe(0);
    expect(result.current.browsing?.acquiredSeriesUids).toEqual(new Set(['old']));
  });

  it('only reslices for a target slice correction, not display edits or automatic application', async () => {
    const props = options({ canReuseRegistration: vi.fn(() => true) });
    const { result, rerender } = renderHook(useVisibleAlignment, { initialProps: props });
    await settle(props);
    const beforeEdit = result.current.activeRequestKey;
    const adjustment = { ...DEFAULT_ALIGNMENT_ADJUSTMENT, panX: 0.1, brightness: 12 };
    rerender({
      ...props,
      panelSettings: new Map([['old', { ...DEFAULT_PANEL_SETTINGS, alignmentAdjustment: adjustment }]]),
    });
    await settle(props);
    expect(result.current.activeRequestKey).toBe(beforeEdit);
    expect(result.current.browsing?.adjustments.get('old')).toEqual(adjustment);

    rerender({
      ...props,
      panelSettings: new Map([
        [
          'old',
          {
            ...DEFAULT_PANEL_SETTINGS,
            alignmentAdjustment: { ...adjustment, sliceOffset: -2 },
          },
        ],
      ]),
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(props.alignAllDates).toHaveBeenCalledTimes(2);
    expect(result.current.activeRequestKey).not.toBe(beforeEdit);
    expect(vi.mocked(props.alignAllDates).mock.lastCall![4]?.targetSliceOffsets).toEqual(new Map([['old', -2]]));
    expect(result.current.browsing?.targetSeriesUids).toEqual(new Set(['old']));
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
    expect(result.current.browsing).toMatchObject({
      reference: { seriesUid: 'new', sliceIndex: 50 },
      targetSeriesUids: new Set(['old']),
      updating: false,
    });
    rerender({ ...props, enabled: false });
    await settle(props, 1);
    act(() => {
      vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
      document.dispatchEvent(new Event('visibilitychange'));
    });
    rerender(props);
    await settle(props, 2);
  });

  it('pauses computation without removing the accepted presentation scope for a pending plane', async () => {
    const props = options();
    const { result, rerender } = renderHook(useVisibleAlignment, { initialProps: props });
    await settle(props);
    rerender({ ...props, progress: 0.51 });
    expect(result.current.browsing?.reference.sliceIndex).toBe(51);

    rerender({ ...props, progress: 0.51, enabled: false });

    expect(result.current.activeRequestKey).toBeNull();
    expect(result.current.browsing).toMatchObject({
      reference: { seriesUid: 'new', sliceIndex: 51, patientKey: 'patient', datasetRevision: 4 },
      targetSeriesUids: new Set(['old']),
      updating: false,
    });
    await settle(props);
    expect(props.abort).toHaveBeenCalled();

    rerender({ ...props, progress: 0.51 });
    expect(result.current.browsing?.updating).not.toBe(false);
    await settle(props, 2);
  });

  it('uses legacy exact-frame presentation when an already-derived date becomes the first visible reference', async () => {
    setDerivedAlignmentFrame({
      date: 'new',
      seriesUid: 'new',
      bestSliceIndex: 50,
      nmiScore: 0.9,
      computedSettings: DEFAULT_PANEL_SETTINGS,
      slicesChecked: 48,
      runId: 'previous-registration',
      patientKey: 'patient',
      sequenceId: 'flair',
      datasetRevision: 4,
      referenceSeriesUid: 'original-reference',
      outcome: 'aligned',
      derivedFrame: {
        rows: 2,
        columns: 2,
        pixels: new Float32Array([1, 2, 3, 4]),
        sourceImageId: 'miradb:new-50',
        targetStudyUid: 'study-new',
        targetSopInstanceUid: 'new-50',
        referenceStudyUid: 'original-reference-study',
        referenceSeriesUid: 'original-reference',
        referenceFrameIndex: 52,
        referenceSopInstanceUid: 'original-reference-52',
      },
    });
    const props = options();
    const { result } = renderHook(() => useVisibleAlignment(props));

    // The engine must reanchor this displayed derived reference to its original
    // acquired plane. Its verified result is not an automatic native-pair cache hit.
    expect(result.current.browsing?.reference).toBeNull();
    await settle(props);
    expect(vi.mocked(props.alignAllDates).mock.lastCall![0]).toMatchObject({
      seriesUid: 'new',
      sliceIndex: 50,
    });

    act(() => clearDerivedAlignmentFrames());
    expect(result.current.browsing?.reference.seriesUid).toBe('new');
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
