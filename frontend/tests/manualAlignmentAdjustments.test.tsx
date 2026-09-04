import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useTestPanelSettings as usePanelSettings, verifiedSourcesForTest } from './helpers/panelSettings';
import { useVisibleAlignment } from '../src/hooks/useVisibleAlignment';
import type {
  AlignmentAdjustment,
  ComparisonData,
  PanelSettings,
  PanelSettingsPartial,
  SeriesRef,
} from '../src/types/api';
import { DEFAULT_PANEL_SETTINGS } from '../src/utils/constants';
import { getPanelSettings, savePanelSettings } from '../src/utils/localApi';
import { getEffectiveInstanceIndex, getSliceIndex } from '../src/utils/math';

vi.mock('../src/utils/localApi', () => ({
  getPanelSettings: vi.fn(),
  getPanelSettingsSnapshot: async (combo: string, patient: string | null, sources: Record<string, SeriesRef>) => ({
    datasetToken: 'test-dataset',
    settings: await getPanelSettings(combo, patient),
    verifiedSources: verifiedSourcesForTest(sources),
  }),
  savePanelSettings: vi.fn(),
  MAX_DERIVED_ALIGNMENT_FRAMES: 32,
  loadDerivedAlignmentFrames: vi.fn().mockResolvedValue([]),
  saveDerivedAlignmentFrame: vi.fn().mockResolvedValue(undefined),
}));

const DATE = '2026-03-28T14:11:00';
const SECOND_DATE = '2026-01-08T09:10:00';
const SEQUENCE = 'synthetic-axial-sequence';
const PATIENT = 'synthetic-patient';

const baselineA = (overrides: Partial<PanelSettings> = {}): PanelSettings => ({
  ...DEFAULT_PANEL_SETTINGS,
  offset: 8,
  zoom: 1.2,
  rotation: 3,
  panX: 0.04,
  panY: -0.03,
  brightness: 110,
  contrast: 95,
  affine00: 1.01,
  affine01: 0.02,
  affine10: -0.015,
  affine11: 0.99,
  ...overrides,
});

const baselineB = (overrides: Partial<PanelSettings> = {}): PanelSettings => ({
  ...DEFAULT_PANEL_SETTINGS,
  offset: 11,
  zoom: 1.5,
  rotation: -2,
  panX: -0.01,
  panY: 0.06,
  brightness: 95,
  contrast: 120,
  affine00: 0.98,
  affine01: -0.01,
  affine10: 0.03,
  affine11: 1.02,
  ...overrides,
});

const adjustment = (overrides: Partial<AlignmentAdjustment> = {}): AlignmentAdjustment => ({
  sliceOffset: 0,
  panX: 0,
  panY: 0,
  rotation: 0,
  zoom: 1,
  brightness: 0,
  contrast: 0,
  ...overrides,
});

type SettingsHook = ReturnType<typeof usePanelSettings>;

async function mountSettings() {
  const hook = renderHook(() => usePanelSettings(SEQUENCE, DATE, PATIENT));
  await act(async () => {});
  expect(hook.result.current.settingsReady).toBe(true);
  return hook;
}

async function mountLinkedSettings() {
  const referenceDate = '2026-07-06T16:40:00';
  const reference = { series_uid: 'synthetic-reference-series', study_id: 'reference-study', instance_count: 101 };
  const target = { series_uid: 'synthetic-target-series', study_id: 'target-study', instance_count: 101 };
  const data: ComparisonData = {
    planes: ['Axial'],
    sequences: [],
    dates: [referenceDate, DATE],
    selected_patient_key: PATIENT,
    dataset_revision: 1,
    series_map: { [SEQUENCE]: { [referenceDate]: reference, [DATE]: target } },
  };
  const columns = [
    { date: referenceDate, ref: reference },
    { date: DATE, ref: target },
  ];
  const alignAllDates = vi.fn<Parameters<typeof useVisibleAlignment>[0]['alignAllDates']>(async () => []);
  const abort = vi.fn();
  const canReuseRegistration = vi.fn(() => true);
  const hook = renderHook(() => {
    const panel = usePanelSettings(SEQUENCE, `${DATE},${referenceDate}`, PATIENT, false, data.series_map[SEQUENCE]);
    const alignment = useVisibleAlignment({
      data,
      sequenceId: SEQUENCE,
      columns,
      panelSettings: panel.panelSettings,
      progress: panel.progress,
      viewportSize: 512,
      outputMode: 'native',
      enabled: true,
      settingsReady: panel.settingsReady,
      alignAllDates,
      abort,
      canReuseRegistration,
    });
    return { panel, alignment };
  });
  await act(async () => {});
  await act(async () => vi.advanceTimersByTimeAsync(0));
  expect(alignAllDates).toHaveBeenCalledOnce();
  return { ...hook, referenceDate, reference, target, alignAllDates, abort, canReuseRegistration };
}

function applyAutomatic(hook: SettingsHook, settings: PanelSettings, runId = 'synthetic-registration') {
  // The engine supplies the index of the physically resampled plane. Its offset
  // already includes sliceOffset; unlike display corrections, it must not be added twice.
  hook.batchUpdateSettings(new Map([[DATE, settings]]), runId, true);
}

function undo() {
  window.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', metaKey: true, bubbles: true }));
}

function redo() {
  window.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', metaKey: true, shiftKey: true, bubbles: true }));
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.mocked(getPanelSettings).mockReset().mockResolvedValue({});
  vi.mocked(savePanelSettings).mockReset().mockResolvedValue(undefined);
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('manual corrections remain linked to automatic alignment', () => {
  it('preserves corrections made before the first automatic result without pausing alignment', async () => {
    const { result } = await mountSettings();
    act(() => {
      result.current.updatePanelSetting(DATE, {
        offset: 2,
        zoom: 1.5,
        panX: 0.08,
        rotation: 2,
        brightness: 120,
      });
      applyAutomatic(result.current, baselineA({ offset: 10 }));
    });

    const settings = result.current.panelSettings.get(DATE)!;
    expect(settings.offset).toBe(10);
    expect(settings.zoom).toBeCloseTo(1.8);
    expect(settings.panX).toBeCloseTo(0.12);
    expect(settings.rotation).toBe(5);
    expect(settings.brightness).toBe(130);
    expect(settings.contrast).toBe(95);
    expect(settings.alignmentPaused).not.toBe(true);
    expect(settings.alignmentAdjustment).toEqual(
      adjustment({ sliceOffset: 2, zoom: 1.5, panX: 0.08, rotation: 2, brightness: 20 }),
    );
  });

  it('composes each latest affine and tone baseline with the correction, rather than freezing the panel', async () => {
    const { result } = await mountSettings();
    act(() => applyAutomatic(result.current, baselineA(), 'registration-a'));
    act(() =>
      result.current.updatePanelSetting(DATE, {
        offset: 10,
        panX: 0.065,
        panY: -0.07,
        rotation: 5,
        zoom: 1.8,
        brightness: 123,
        contrast: 90,
      }),
    );
    act(() => applyAutomatic(result.current, baselineB({ offset: 13 }), 'registration-b'));

    const settings = result.current.panelSettings.get(DATE)!;
    expect(settings).toMatchObject({
      offset: 13,
      rotation: 0,
      brightness: 108,
      contrast: 115,
      affine00: 0.98,
      affine01: -0.01,
      affine10: 0.03,
      affine11: 1.02,
    });
    expect(settings.zoom).toBeCloseTo(2.25);
    expect(settings.panX).toBeCloseTo(0.015);
    expect(settings.panY).toBeCloseTo(0.02);
    expect(settings.alignmentPaused).not.toBe(true);

    // Applying the same cached baseline again must not compound a correction.
    act(() => applyAutomatic(result.current, baselineB({ offset: 13 }), 'registration-b-next-slice'));
    expect(result.current.panelSettings.get(DATE)).toEqual(settings);
  });

  it('undoes and redoes manual intent over the latest automatic baseline without rewinding browsing', async () => {
    const { result } = await mountSettings();
    act(() => applyAutomatic(result.current, baselineA(), 'registration-a'));
    act(() => result.current.updatePanelSetting(DATE, { offset: 10, brightness: 123, zoom: 1.8 }));
    act(() => {
      result.current.setProgress(0.8);
      applyAutomatic(result.current, baselineB({ offset: 13 }), 'registration-b');
    });

    act(undo);
    expect(result.current.panelSettings.get(DATE)).toMatchObject(baselineB());
    expect(result.current.progress).toBe(0.8);

    act(redo);
    const redone = result.current.panelSettings.get(DATE)!;
    expect(redone.offset).toBe(13);
    expect(redone.zoom).toBeCloseTo(2.25);
    expect(redone.brightness).toBe(108);
    expect(redone.affine01).toBe(-0.01);
    expect(result.current.progress).toBe(0.8);
  });

  it('does not add automatic results to undo history, persist each result, or invalidate manual redo', async () => {
    const { result } = await mountSettings();
    act(() => applyAutomatic(result.current, baselineA()));
    expect(savePanelSettings).not.toHaveBeenCalled();
    act(undo);
    expect(result.current.panelSettings.get(DATE)).toMatchObject(baselineA());
    expect(savePanelSettings).not.toHaveBeenCalled();

    act(() => result.current.updatePanelSetting(DATE, { brightness: 123 }));
    act(undo);
    vi.mocked(savePanelSettings).mockClear();
    act(() => applyAutomatic(result.current, baselineB()));
    expect(savePanelSettings).not.toHaveBeenCalled();
    act(redo);
    expect(result.current.panelSettings.get(DATE)).toMatchObject({ brightness: 108, offset: 11 });
    expect(savePanelSettings).toHaveBeenLastCalledWith(
      expect.objectContaining({ studyUid: `${PATIENT}:${DATE}`, datasetToken: 'test-dataset' }),
      expect.objectContaining({ brightness: 108, alignmentAdjustment: expect.objectContaining({ brightness: 13 }) }),
    );
  });

  it('retains unclamped tone intent, including an explicit zero, as automatic matching changes', async () => {
    const { result } = await mountSettings();
    act(() => applyAutomatic(result.current, baselineA({ brightness: 190, contrast: 10 })));
    act(() => result.current.updatePanelSetting(DATE, { brightness: 200, contrast: 0 }));
    act(() => applyAutomatic(result.current, baselineB({ brightness: 199, contrast: 4 })));
    expect(result.current.panelSettings.get(DATE)).toMatchObject({ brightness: 200, contrast: 0 });
    expect(result.current.panelSettings.get(DATE)?.alignmentAdjustment).toMatchObject({
      brightness: 10,
      contrast: -10,
    });

    act(() => applyAutomatic(result.current, baselineB({ brightness: 80, contrast: 110 })));
    expect(result.current.panelSettings.get(DATE)).toMatchObject({ brightness: 90, contrast: 100 });
    act(undo);
    expect(result.current.panelSettings.get(DATE)).toMatchObject({ brightness: 80, contrast: 110 });
    act(redo);
    expect(result.current.panelSettings.get(DATE)).toMatchObject({ brightness: 90, contrast: 100 });
  });

  it('honors a tone edit away from a clamp instead of retaining the invisible clipped excess', async () => {
    const { result } = await mountSettings();
    act(() => applyAutomatic(result.current, baselineA({ brightness: 190, contrast: 10 })));
    act(() => result.current.updatePanelSetting(DATE, { brightness: 200, contrast: 0 }));
    const matched = baselineB({ brightness: 199, contrast: 4 });
    act(() => applyAutomatic(result.current, matched));
    expect(result.current.panelSettings.get(DATE)).toMatchObject({ brightness: 200, contrast: 0 });

    act(() => result.current.updatePanelSetting(DATE, { brightness: 199, contrast: 1 }));
    expect(result.current.panelSettings.get(DATE)).toMatchObject({ brightness: 199, contrast: 1 });
    expect(result.current.panelSettings.get(DATE)?.alignmentAdjustment).toMatchObject({
      brightness: 0,
      contrast: -3,
    });
    act(() => applyAutomatic(result.current, matched));
    expect(result.current.panelSettings.get(DATE)).toMatchObject({ brightness: 199, contrast: 1 });

    act(undo);
    expect(result.current.panelSettings.get(DATE)).toMatchObject({ brightness: 200, contrast: 0 });
    expect(result.current.panelSettings.get(DATE)?.alignmentAdjustment).toMatchObject({
      brightness: 10,
      contrast: -10,
    });
    act(redo);
    expect(result.current.panelSettings.get(DATE)).toMatchObject({ brightness: 199, contrast: 1 });
    act(() => applyAutomatic(result.current, baselineB({ brightness: 80, contrast: 110 })));
    expect(result.current.panelSettings.get(DATE)).toMatchObject({ brightness: 80, contrast: 107 });
  });

  it('honors zoom and pan edits away from limits across cached baseline replay and undo', async () => {
    const { result } = await mountSettings();
    act(() => applyAutomatic(result.current, baselineA({ zoom: 5, panX: 0.8, panY: -0.8 })));
    act(() => result.current.updatePanelSetting(DATE, { zoom: 10, panX: 1, panY: -1 }));
    const matched = baselineB({ zoom: 8, panX: 0.95, panY: -0.95 });
    act(() => applyAutomatic(result.current, matched));
    expect(result.current.panelSettings.get(DATE)).toMatchObject({ zoom: 10, panX: 1, panY: -1 });

    act(() => result.current.updatePanelSetting(DATE, { zoom: 9, panX: 0.99, panY: -0.99 }));
    const edited = result.current.panelSettings.get(DATE)!;
    expect(edited).toMatchObject({ zoom: 9, panX: 0.99, panY: -0.99 });
    expect(edited.alignmentAdjustment!.zoom).toBeCloseTo(1.125);
    expect(edited.alignmentAdjustment!.panX).toBeCloseTo(0.04);
    expect(edited.alignmentAdjustment!.panY).toBeCloseTo(-0.04);
    act(() => applyAutomatic(result.current, matched));
    expect(result.current.panelSettings.get(DATE)).toMatchObject({ zoom: 9, panX: 0.99, panY: -0.99 });

    act(undo);
    expect(result.current.panelSettings.get(DATE)).toMatchObject({ zoom: 10, panX: 1, panY: -1 });
    act(redo);
    expect(result.current.panelSettings.get(DATE)).toMatchObject({ zoom: 9, panX: 0.99, panY: -0.99 });
    act(() => applyAutomatic(result.current, baselineB({ zoom: 2, panX: 0.2, panY: -0.2 })));
    const rebased = result.current.panelSettings.get(DATE)!;
    expect(rebased.zoom).toBeCloseTo(2.25);
    expect(rebased.panX).toBeCloseTo(0.24);
    expect(rebased.panY).toBeCloseTo(-0.24);
  });

  it.each([
    { field: 'brightness', initial: 190, requested: 200, clippedBase: 199, nextBase: 80, nextDisplay: 90 },
    { field: 'panX', initial: 0.8, requested: 1, clippedBase: 0.95, nextBase: 0.2, nextDisplay: 0.4 },
    { field: 'zoom', initial: 5, requested: 10, clippedBase: 8, nextBase: 2, nextDisplay: 4 },
  ] as const)('retains clipped $field intent when its limit control produces a no-op', async (testCase) => {
    const { result } = await mountSettings();
    const { field, initial, requested, clippedBase, nextBase, nextDisplay } = testCase;
    act(() => applyAutomatic(result.current, baselineA({ [field]: initial })));
    act(() => result.current.updatePanelSetting(DATE, { [field]: requested }));
    act(() => applyAutomatic(result.current, baselineB({ [field]: clippedBase })));
    expect(result.current.panelSettings.get(DATE)![field]).toBe(requested);
    const intent = result.current.panelSettings.get(DATE)!.alignmentAdjustment;

    // Pressing Increase while already at the visible limit is not a new correction.
    act(() => result.current.updatePanelSetting(DATE, { [field]: requested }));
    expect(result.current.panelSettings.get(DATE)?.alignmentAdjustment).toEqual(intent);
    act(() => applyAutomatic(result.current, baselineB({ [field]: nextBase })));
    expect(result.current.panelSettings.get(DATE)![field]).toBeCloseTo(nextDisplay);

    // One undo must reach the actual manual edit, not a phantom no-op history entry.
    act(undo);
    expect(result.current.panelSettings.get(DATE)![field]).toBeCloseTo(nextBase);
    act(redo);
    expect(result.current.panelSettings.get(DATE)![field]).toBeCloseTo(nextDisplay);
  });

  it('treats resetting an already matched tone as a no-op without creating an undo or slice jump', async () => {
    const { result } = await mountSettings();
    act(() => {
      result.current.setProgress(0.42);
      applyAutomatic(result.current, baselineA({ brightness: 137, contrast: 91, offset: 18 }));
    });
    expect(result.current.panelSettings.get(DATE)?.alignmentAdjustment).toBeUndefined();
    act(() => result.current.updatePanelSetting(DATE, { alignmentAdjustment: adjustment() }));
    expect(result.current.panelSettings.get(DATE)).toMatchObject({ brightness: 137, contrast: 91, offset: 18 });
    expect(result.current.progress).toBe(0.42);

    // A later automatic plane must not be rewound by an undo entry for that no-op.
    act(() => {
      result.current.setProgress(0.65);
      applyAutomatic(result.current, baselineB({ brightness: 140, contrast: 92, offset: 21 }));
    });
    const current = result.current.panelSettings.get(DATE)!;
    vi.mocked(savePanelSettings).mockClear();
    act(undo);
    act(redo);
    expect(savePanelSettings).not.toHaveBeenCalled();
    expect(result.current.panelSettings.get(DATE)).toEqual(current);
    expect(result.current.progress).toBe(0.65);
    expect(getSliceIndex(101, result.current.progress, result.current.panelSettings.get(DATE)!.offset)).toBe(86);
  });

  it('retains same-event corrections in order, including a new baseline arriving between manual edits', async () => {
    const { result } = await mountSettings();
    act(() => {
      applyAutomatic(result.current, baselineA());
      result.current.updatePanelSetting(DATE, { brightness: 123 });
      applyAutomatic(result.current, baselineB());
      result.current.updatePanelSetting(DATE, { zoom: 3 });
    });

    expect(result.current.panelSettings.get(DATE)).toMatchObject({ brightness: 108, zoom: 3 });
    expect(result.current.panelSettings.get(DATE)?.alignmentAdjustment).toMatchObject({ brightness: 13, zoom: 2 });
    act(undo);
    expect(result.current.panelSettings.get(DATE)).toMatchObject({ brightness: 108, zoom: 1.5 });
    act(undo);
    expect(result.current.panelSettings.get(DATE)).toMatchObject({ brightness: 95, zoom: 1.5 });
    act(redo);
    act(redo);
    expect(result.current.panelSettings.get(DATE)).toMatchObject({ brightness: 108, zoom: 3 });
  });

  it('resets tone corrections independently from spatial corrections and makes the reset undoable', async () => {
    const { result } = await mountSettings();
    act(() => applyAutomatic(result.current, baselineA()));
    act(() => result.current.updatePanelSetting(DATE, { offset: 10, panX: 0.09, brightness: 123, contrast: 90 }));
    const beforeReset = result.current.panelSettings.get(DATE)!.alignmentAdjustment!;
    act(() =>
      result.current.updatePanelSetting(DATE, {
        alignmentAdjustment: { ...beforeReset, brightness: 0, contrast: 0 },
      }),
    );
    act(() => applyAutomatic(result.current, baselineB({ offset: 13 })));
    expect(result.current.panelSettings.get(DATE)).toMatchObject({ offset: 13, brightness: 95, contrast: 120 });
    expect(result.current.panelSettings.get(DATE)!.panX).toBeCloseTo(0.04);

    act(undo);
    expect(result.current.panelSettings.get(DATE)).toMatchObject({ offset: 13, brightness: 108, contrast: 115 });
    act(redo);
    expect(result.current.panelSettings.get(DATE)).toMatchObject({ offset: 13, brightness: 95, contrast: 120 });
  });

  it('resets all corrections to the current registration without discarding that registration or undo history', async () => {
    const { result } = await mountSettings();
    act(() => applyAutomatic(result.current, baselineA()));
    act(() => result.current.updatePanelSetting(DATE, { offset: 10, zoom: 1.8, brightness: 123 }));
    act(() => applyAutomatic(result.current, baselineB({ offset: 13 })));
    act(() => result.current.updatePanelSetting(DATE, { alignmentAdjustment: undefined }));
    expect(result.current.panelSettings.get(DATE)).toMatchObject(baselineB());
    expect(result.current.panelSettings.get(DATE)?.alignmentAdjustment).toBeUndefined();

    act(undo);
    expect(result.current.panelSettings.get(DATE)).toMatchObject({ offset: 13, brightness: 108 });
    expect(result.current.panelSettings.get(DATE)!.zoom).toBeCloseTo(2.25);
    act(redo);
    expect(result.current.panelSettings.get(DATE)).toMatchObject(baselineB());
  });

  it('does not turn a reverse-order toggle into a physical slice correction', async () => {
    const { result } = await mountSettings();
    const count = 101;
    const progress = 0.2;
    act(() => {
      result.current.setProgress(progress);
      applyAutomatic(result.current, baselineA());
      result.current.updatePanelSetting(DATE, { offset: 10 });
    });
    const before = result.current.panelSettings.get(DATE)!;
    const logical = getSliceIndex(count, progress, before.offset);
    const physical = getEffectiveInstanceIndex(logical, count, before.reverseSliceOrder);
    // This is the physical-slice-preserving update produced by ImageControls.
    act(() =>
      result.current.updatePanelSetting(DATE, {
        reverseSliceOrder: true,
        offset: before.offset + (count - 1 - logical - logical),
      }),
    );
    const reversed = result.current.panelSettings.get(DATE)!;
    expect(getEffectiveInstanceIndex(getSliceIndex(count, progress, reversed.offset), count, true)).toBe(physical);
    expect(reversed.alignmentAdjustment?.sliceOffset).toBe(2);

    // A +1 logical nudge while reversed moves -1 in acquired target order.
    act(() => result.current.updatePanelSetting(DATE, { offset: reversed.offset + 1 }));
    expect(result.current.panelSettings.get(DATE)?.alignmentAdjustment?.sliceOffset).toBe(1);
    act(() => applyAutomatic(result.current, baselineB({ reverseSliceOrder: true, offset: 48 })));
    expect(result.current.panelSettings.get(DATE)).toMatchObject({ reverseSliceOrder: true, offset: 48 });
    expect(result.current.panelSettings.get(DATE)?.alignmentAdjustment?.sliceOffset).toBe(1);

    act(undo);
    expect(result.current.panelSettings.get(DATE)).toMatchObject({ reverseSliceOrder: true, offset: 47 });
    expect(result.current.panelSettings.get(DATE)?.alignmentAdjustment?.sliceOffset).toBe(2);
  });

  it('pauses only through an explicit acquired-image action and preserves corrections when resumed', async () => {
    const { result } = await mountSettings();
    act(() => applyAutomatic(result.current, baselineA()));
    act(() => result.current.updatePanelSetting(DATE, { brightness: 123, panX: 0.09 }));
    const correction = result.current.panelSettings.get(DATE)!.alignmentAdjustment;
    expect(result.current.panelSettings.get(DATE)?.alignmentPaused).not.toBe(true);

    act(() => result.current.updatePanelSetting(DATE, { alignmentPaused: true }));
    expect(result.current.panelSettings.get(DATE)?.alignmentPaused).toBe(true);
    expect(result.current.panelSettings.get(DATE)?.alignmentAdjustment).toEqual(correction);
    act(() => result.current.updatePanelSetting(DATE, { alignmentPaused: false }));
    act(() => applyAutomatic(result.current, baselineB()));
    expect(result.current.panelSettings.get(DATE)).toMatchObject({ alignmentPaused: false, brightness: 108 });
    expect(result.current.panelSettings.get(DATE)!.panX).toBeCloseTo(0.04);
    expect(result.current.panelSettings.get(DATE)?.alignmentAdjustment).toEqual(correction);
  });

  it('ignores an in-flight automatic result that arrives after the target explicitly switches to acquired mode', async () => {
    const { result } = await mountSettings();
    act(() => applyAutomatic(result.current, baselineA()));
    act(() => result.current.updatePanelSetting(DATE, { brightness: 123 }));
    act(() => result.current.updatePanelSetting(DATE, { alignmentPaused: true }));
    const acquired = result.current.panelSettings.get(DATE)!;
    vi.mocked(savePanelSettings).mockClear();

    act(() => applyAutomatic(result.current, baselineB(), 'late-in-flight-registration'));
    expect(result.current.panelSettings.get(DATE)).toEqual(acquired);
    expect(savePanelSettings).not.toHaveBeenCalled();

    act(undo);
    expect(result.current.panelSettings.get(DATE)?.alignmentPaused).not.toBe(true);
    expect(result.current.panelSettings.get(DATE)?.brightness).toBe(123);
    act(() => applyAutomatic(result.current, baselineB(), 'resumed-registration'));
    expect(result.current.panelSettings.get(DATE)?.brightness).toBe(108);
  });

  it('undoes acquired mode over the latest automatic baseline after an acquired redo', async () => {
    const { result } = await mountSettings();
    act(() => applyAutomatic(result.current, baselineA()));
    act(() => result.current.updatePanelSetting(DATE, { brightness: 123 }));
    act(() =>
      result.current.updatePanelSetting(DATE, {
        ...DEFAULT_PANEL_SETTINGS,
        offset: result.current.panelSettings.get(DATE)!.offset,
        alignmentPaused: true,
      }),
    );
    act(undo);
    expect(result.current.panelSettings.get(DATE)).toMatchObject({ brightness: 123, affine00: 1.01 });
    act(() => applyAutomatic(result.current, baselineB()));
    expect(result.current.panelSettings.get(DATE)).toMatchObject({ brightness: 108, affine00: 0.98 });

    act(redo);
    expect(result.current.panelSettings.get(DATE)).toMatchObject({
      alignmentPaused: true,
      brightness: 100,
      affine00: 1,
    });
    act(undo);
    expect(result.current.panelSettings.get(DATE)).toMatchObject({
      alignmentPaused: false,
      brightness: 108,
      contrast: 120,
      affine00: 0.98,
      affine01: -0.01,
      affine10: 0.03,
      affine11: 1.02,
    });
    expect(result.current.panelSettings.get(DATE)?.alignmentAdjustment?.brightness).toBe(13);
  });

  it('redoes the full acquired presentation even when its original values equaled the original automatic baseline', async () => {
    const { result } = await mountSettings();
    act(() => applyAutomatic(result.current, { ...DEFAULT_PANEL_SETTINGS }));
    act(() => result.current.updatePanelSetting(DATE, { ...DEFAULT_PANEL_SETTINGS, alignmentPaused: true }));
    act(undo);
    act(() => applyAutomatic(result.current, baselineB({ brightness: 137, contrast: 91, zoom: 1.1 })));

    act(redo);
    expect(result.current.panelSettings.get(DATE)).toMatchObject({
      alignmentPaused: true,
      brightness: 100,
      contrast: 100,
      zoom: 1,
      rotation: 0,
      panX: 0,
      panY: 0,
      affine00: 1,
      affine01: 0,
      affine10: 0,
      affine11: 1,
    });
  });

  it('does not mutate cached registration settings or the correction captured by an earlier frame', async () => {
    const { result } = await mountSettings();
    const original = Object.freeze(baselineA());
    act(() => applyAutomatic(result.current, original));
    act(() => result.current.updatePanelSetting(DATE, { brightness: 123, zoom: 1.8 }));
    const correction = Object.freeze(result.current.panelSettings.get(DATE)!.alignmentAdjustment!);
    const next = Object.freeze(baselineB());

    act(() => applyAutomatic(result.current, next));
    act(() => result.current.updatePanelSetting(DATE, { brightness: 109 }));
    expect(original).toEqual(baselineA());
    expect(next).toEqual(baselineB());
    expect(correction).toEqual(adjustment({ brightness: 13, zoom: 1.5 }));
    expect(result.current.panelSettings.get(DATE)?.alignmentAdjustment).toMatchObject({ brightness: 14, zoom: 1.5 });
  });

  it('undoes reverse order after browsing without returning to the old physical slice', async () => {
    const series: SeriesRef = { series_uid: 'synthetic-series', study_id: 'synthetic-study', instance_count: 101 };
    const { result } = renderHook(() => usePanelSettings(SEQUENCE, DATE, PATIENT, false, { [DATE]: series }));
    await act(async () => {});
    act(() => {
      result.current.setProgress(0.2);
      applyAutomatic(result.current, baselineA());
    });
    // At progress 0.2 the physical slice is 28; reverse changes logical 28 -> 72.
    act(() => result.current.updatePanelSetting(DATE, { reverseSliceOrder: true, offset: 52 }));
    expect(result.current.panelSettings.get(DATE)?.alignmentAdjustment).toBeUndefined();

    act(() => {
      result.current.setProgress(0.35);
      applyAutomatic(result.current, baselineB({ reverseSliceOrder: true, offset: 12 }));
    });
    const currentPhysical = () => {
      const settings = result.current.panelSettings.get(DATE)!;
      return getEffectiveInstanceIndex(
        getSliceIndex(series.instance_count, result.current.progress, settings.offset),
        series.instance_count,
        settings.reverseSliceOrder,
      );
    };
    expect(currentPhysical()).toBe(53);

    act(undo);
    expect(result.current.panelSettings.get(DATE)).toMatchObject({ reverseSliceOrder: false, offset: 18 });
    expect(currentPhysical()).toBe(53);
    expect(result.current.progress).toBe(0.35);
    act(redo);
    expect(result.current.panelSettings.get(DATE)).toMatchObject({ reverseSliceOrder: true, offset: 12 });
    expect(currentPhysical()).toBe(53);
  });
});

describe('durable manual alignment intent', () => {
  it('persists and hydrates corrections without applying them twice on reload or on the next automatic result', async () => {
    const first = await mountSettings();
    act(() => applyAutomatic(first.result.current, baselineA()));
    act(() => first.result.current.updatePanelSetting(DATE, { offset: 10, zoom: 1.8, brightness: 123 }));
    const saved = vi.mocked(savePanelSettings).mock.calls.at(-1)![1];
    expect(saved.alignmentAdjustment).toMatchObject({ sliceOffset: 2, zoom: 1.5, brightness: 13 });
    first.unmount();

    vi.mocked(getPanelSettings).mockResolvedValue({ [DATE]: saved });
    const second = await mountSettings();
    expect(second.result.current.panelSettings.get(DATE)).toEqual({ ...saved, alignmentPaused: false });
    act(() => applyAutomatic(second.result.current, baselineB({ offset: 13 })));
    expect(second.result.current.panelSettings.get(DATE)).toMatchObject({ offset: 13, brightness: 108 });
    expect(second.result.current.panelSettings.get(DATE)!.zoom).toBeCloseTo(2.25);
    expect(second.result.current.panelSettings.get(DATE)?.alignmentAdjustment).toEqual(saved.alignmentAdjustment);
  });

  it('retains acquired-image pause metadata when stored settings are hydrated', async () => {
    const stored = baselineA({
      brightness: 123,
      alignmentAdjustment: adjustment({ brightness: 13 }),
      alignmentPaused: true,
    });
    vi.mocked(getPanelSettings).mockResolvedValue({ [DATE]: stored });
    const { result } = await mountSettings();
    expect(result.current.panelSettings.get(DATE)).toEqual(stored);
    act(() => result.current.updatePanelSetting(DATE, { alignmentPaused: false }));
    act(() => applyAutomatic(result.current, baselineB()));
    expect(result.current.panelSettings.get(DATE)).toMatchObject({ alignmentPaused: false, brightness: 108 });
  });

  it('restores the exact unclipped baseline for a manual tone edit made before the first post-reload alignment', async () => {
    const first = await mountSettings();
    act(() => applyAutomatic(first.result.current, baselineA({ brightness: 190 })));
    act(() => first.result.current.updatePanelSetting(DATE, { brightness: 200 }));
    act(() => applyAutomatic(first.result.current, baselineB({ brightness: 199 })));
    act(() => window.dispatchEvent(new Event('beforeunload')));
    const saved = vi.mocked(savePanelSettings).mock.calls.at(-1)![1];
    expect(saved).toMatchObject({
      brightness: 200,
      alignmentAdjustment: { brightness: 10 },
      alignmentBaseline: { brightness: 199 },
    });
    first.unmount();

    vi.mocked(getPanelSettings).mockResolvedValue({ [DATE]: saved });
    const second = await mountSettings();
    expect(second.result.current.panelSettings.get(DATE)?.brightness).toBe(200);
    act(() => second.result.current.updatePanelSetting(DATE, { brightness: 199 }));
    expect(second.result.current.panelSettings.get(DATE)?.alignmentAdjustment?.brightness ?? 0).toBe(0);
    act(() => applyAutomatic(second.result.current, baselineB({ brightness: 199 })));
    expect(second.result.current.panelSettings.get(DATE)?.brightness).toBe(199);
  });

  it('resumes the saved linked presentation after reloading while paused on the acquired image', async () => {
    const first = await mountSettings();
    act(() => applyAutomatic(first.result.current, baselineA({ brightness: 137, contrast: 91 })));
    act(() => first.result.current.updatePanelSetting(DATE, { panX: 0.09 }));
    act(() =>
      first.result.current.updatePanelSetting(DATE, {
        ...DEFAULT_PANEL_SETTINGS,
        offset: first.result.current.panelSettings.get(DATE)!.offset,
        alignmentPaused: true,
      }),
    );
    const saved = vi.mocked(savePanelSettings).mock.calls.at(-1)![1];
    expect(saved).toMatchObject({
      alignmentPaused: true,
      brightness: 100,
      contrast: 100,
      alignmentBaseline: { brightness: 137, contrast: 91 },
    });
    first.unmount();

    vi.mocked(getPanelSettings).mockResolvedValue({ [DATE]: saved });
    const second = await mountSettings();
    act(() => second.result.current.updatePanelSetting(DATE, { alignmentPaused: false }));
    expect(second.result.current.panelSettings.get(DATE)).toMatchObject({
      alignmentPaused: false,
      brightness: 137,
      contrast: 91,
      affine00: 1.01,
    });
    expect(second.result.current.panelSettings.get(DATE)!.panX).toBeCloseTo(0.09);
    act(() => applyAutomatic(second.result.current, baselineB({ brightness: 80, contrast: 110, panX: 0.2 })));
    expect(second.result.current.panelSettings.get(DATE)).toMatchObject({ brightness: 80, contrast: 110 });
    expect(second.result.current.panelSettings.get(DATE)!.panX).toBeCloseTo(0.25);
  });

  it('does not restore non-finite persisted progress into slice browsing', async () => {
    vi.mocked(getPanelSettings).mockResolvedValue({ [DATE]: { ...DEFAULT_PANEL_SETTINGS, progress: NaN } });
    const { result } = await mountSettings();
    expect(result.current.progress).toBe(0);
    expect(result.current.panelSettings.get(DATE)?.progress).toBe(0);
  });

  it('isolates correction metadata and undo across patient and sequence settings owners', async () => {
    vi.mocked(getPanelSettings).mockImplementation(async (sequenceId, patientKey) =>
      sequenceId === SEQUENCE && patientKey === PATIENT
        ? { [DATE]: baselineA({ alignmentAdjustment: adjustment({ brightness: 13 }), brightness: 123 }) }
        : {},
    );
    const { result, rerender } = renderHook(
      ({ sequenceId, patientKey }) => usePanelSettings(sequenceId, DATE, patientKey),
      { initialProps: { sequenceId: SEQUENCE, patientKey: PATIENT } },
    );
    await act(async () => {});
    act(() => result.current.updatePanelSetting(DATE, { zoom: 2.4 }));
    expect(result.current.panelSettings.get(DATE)?.alignmentAdjustment).toMatchObject({ brightness: 13, zoom: 2 });

    await act(async () => rerender({ sequenceId: 'synthetic-coronal-sequence', patientKey: PATIENT }));
    expect(result.current.panelSettings.get(DATE)).toEqual(DEFAULT_PANEL_SETTINGS);
    act(undo);
    expect(result.current.panelSettings.get(DATE)).toEqual(DEFAULT_PANEL_SETTINGS);

    await act(async () => rerender({ sequenceId: SEQUENCE, patientKey: 'synthetic-patient-b' }));
    expect(result.current.panelSettings.get(DATE)).toEqual(DEFAULT_PANEL_SETTINGS);
    act(() => applyAutomatic(result.current, baselineB()));
    expect(result.current.panelSettings.get(DATE)).toMatchObject(baselineB());
    expect(result.current.panelSettings.get(DATE)?.alignmentAdjustment).toBeUndefined();

    await act(async () => rerender({ sequenceId: SEQUENCE, patientKey: PATIENT }));
    expect(result.current.panelSettings.get(DATE)?.alignmentAdjustment).toEqual(adjustment({ brightness: 13 }));
    expect(result.current.panelSettings.get(DATE)?.brightness).toBe(123);
  });

  it('does not overwrite a current correction while hydrating another newly visible date', async () => {
    vi.mocked(getPanelSettings).mockResolvedValue({
      [DATE]: baselineA(),
      [SECOND_DATE]: { ...DEFAULT_PANEL_SETTINGS },
    });
    const { result, rerender } = renderHook(({ dates }) => usePanelSettings(SEQUENCE, dates, PATIENT), {
      initialProps: { dates: DATE },
    });
    await act(async () => {});
    act(() => result.current.updatePanelSetting(DATE, { brightness: 123 }));
    act(() => applyAutomatic(result.current, baselineB()));
    const before = result.current.panelSettings.get(DATE);

    await act(async () => rerender({ dates: `${DATE},${SECOND_DATE}` }));
    expect(result.current.panelSettings.get(DATE)).toEqual(before);
    expect(result.current.panelSettings.get(DATE)?.alignmentAdjustment?.brightness).toBe(13);
    expect(result.current.panelSettings.get(SECOND_DATE)).toMatchObject(DEFAULT_PANEL_SETTINGS);
    expect(result.current.panelSettings.get(SECOND_DATE)?.alignmentAdjustment).toBeUndefined();
    expect(result.current.panelSettings.get(SECOND_DATE)?.alignmentPaused).not.toBe(true);
  });

  it('rejects malformed persisted correction values instead of poisoning the next automatic presentation', async () => {
    const malformed = {
      ...DEFAULT_PANEL_SETTINGS,
      alignmentPaused: 'true',
      alignmentAdjustment: {
        sliceOffset: Infinity,
        panX: NaN,
        panY: Infinity,
        rotation: -Infinity,
        zoom: 0,
        brightness: NaN,
        contrast: '100',
      },
    } as unknown as PanelSettingsPartial;
    vi.mocked(getPanelSettings).mockResolvedValue({ [DATE]: malformed });
    const { result } = await mountSettings();
    expect(result.current.panelSettings.get(DATE)?.alignmentPaused).not.toBe(true);
    act(() => applyAutomatic(result.current, baselineB()));
    const settings = result.current.panelSettings.get(DATE)!;
    expect(settings).toMatchObject(baselineB());
    for (const key of ['offset', 'panX', 'panY', 'rotation', 'zoom', 'brightness', 'contrast'] as const) {
      expect(Number.isFinite(settings[key]), key).toBe(true);
    }
  });
});

describe('manual correction and visible alignment integration', () => {
  it('keeps a manually adjusted target linked without restarting computation for target display edits', async () => {
    const { result, referenceDate, reference, target, alignAllDates, abort } = await mountLinkedSettings();
    const requestKey = result.current.alignment.activeRequestKey;
    act(() => applyAutomatic(result.current.panel, baselineA()));
    act(() => result.current.panel.updatePanelSetting(DATE, { brightness: 123, contrast: 90, panX: 0.09, zoom: 1.8 }));
    await act(async () => vi.advanceTimersByTimeAsync(0));

    expect(result.current.alignment.targetCount).toBe(1);
    expect(result.current.alignment.activeRequestKey).toBe(requestKey);
    expect(result.current.alignment.browsing?.targetSeriesUids.has(target.series_uid)).toBe(true);
    expect(result.current.alignment.browsing?.adjustments.get(target.series_uid)).toMatchObject({
      brightness: 13,
      contrast: -5,
      zoom: 1.5,
    });
    expect(alignAllDates).toHaveBeenCalledOnce();
    expect(abort).not.toHaveBeenCalled();

    // Changing the reference still propagates its new presentation to this target.
    act(() => result.current.panel.updatePanelSetting(referenceDate, { brightness: 80, contrast: 110 }));
    await act(async () => vi.advanceTimersByTimeAsync(0));
    expect(alignAllDates).toHaveBeenCalledTimes(2);
    expect(alignAllDates.mock.lastCall?.[0]).toMatchObject({
      seriesUid: reference.series_uid,
      settings: { brightness: 80, contrast: 110 },
    });
    expect(alignAllDates.mock.lastCall?.[1]).toEqual([DATE]);
    act(() =>
      applyAutomatic(result.current.panel, baselineB({ brightness: 80, contrast: 110, zoom: 1.4, panX: 0.05 })),
    );
    expect(result.current.panel.panelSettings.get(DATE)).toMatchObject({
      brightness: 93,
      contrast: 105,
      affine00: 0.98,
      affine01: -0.01,
      affine10: 0.03,
      affine11: 1.02,
    });
    expect(result.current.panel.panelSettings.get(DATE)!.zoom).toBeCloseTo(2.1);
    expect(result.current.panel.panelSettings.get(DATE)!.panX).toBeCloseTo(0.1);
    await act(async () => vi.advanceTimersByTimeAsync(0));
    expect(alignAllDates).toHaveBeenCalledTimes(2);
  });

  it('requests a new sampled plane for a manual slice nudge while reusing the accepted registration', async () => {
    const { result, reference, target, alignAllDates, canReuseRegistration } = await mountLinkedSettings();
    act(() => applyAutomatic(result.current.panel, baselineA()));
    const originalKey = result.current.alignment.activeRequestKey;
    act(() => result.current.panel.updatePanelSetting(DATE, { offset: 10 }));
    expect(result.current.alignment.activeRequestKey).not.toBe(originalKey);
    expect(result.current.alignment.targetCount).toBe(1);
    await act(async () => vi.advanceTimersByTimeAsync(0));

    expect(alignAllDates).toHaveBeenCalledTimes(2);
    expect(canReuseRegistration).toHaveBeenCalled();
    expect(alignAllDates.mock.lastCall?.[0]).toMatchObject({ seriesUid: reference.series_uid, sliceIndex: 0 });
    expect(alignAllDates.mock.lastCall?.[4]).toMatchObject({
      reuseRegistration: true,
      targetSliceOffsets: new Map([[DATE, 2]]),
      requestKey: result.current.alignment.activeRequestKey,
    });
    expect(result.current.alignment.browsing?.adjustments.get(target.series_uid)?.sliceOffset).toBe(2);

    const correctedKey = result.current.alignment.activeRequestKey;
    act(() => applyAutomatic(result.current.panel, baselineA({ offset: 10 })));
    expect(result.current.panel.panelSettings.get(DATE)?.offset).toBe(10);
    expect(result.current.alignment.activeRequestKey).toBe(correctedKey);
    await act(async () => vi.advanceTimersByTimeAsync(0));
    expect(alignAllDates).toHaveBeenCalledTimes(2);

    act(undo);
    expect(result.current.panel.panelSettings.get(DATE)?.offset).toBe(8);
    expect(result.current.alignment.activeRequestKey).toBe(originalKey);
    await act(async () => vi.advanceTimersByTimeAsync(0));
    expect(alignAllDates).toHaveBeenCalledTimes(3);
    expect(alignAllDates.mock.lastCall?.[4]?.targetSliceOffsets?.get(DATE)).toBe(0);
  });

  it('removes only an explicitly paused target and restores its corrections when resumed', async () => {
    const { result, target, alignAllDates } = await mountLinkedSettings();
    act(() => applyAutomatic(result.current.panel, baselineA()));
    act(() => result.current.panel.updatePanelSetting(DATE, { panX: 0.09, brightness: 123 }));
    const correction = result.current.panel.panelSettings.get(DATE)?.alignmentAdjustment;
    expect(result.current.alignment.targetCount).toBe(1);

    act(() => result.current.panel.updatePanelSetting(DATE, { alignmentPaused: true }));
    expect(result.current.alignment.targetCount).toBe(0);
    expect(result.current.alignment.activeRequestKey).toBeNull();
    expect(result.current.alignment.browsing?.acquiredSeriesUids.has(target.series_uid)).toBe(true);
    act(() => result.current.panel.setProgress(0.3));
    await act(async () => vi.advanceTimersByTimeAsync(0));
    expect(alignAllDates).toHaveBeenCalledOnce();

    act(() => result.current.panel.updatePanelSetting(DATE, { alignmentPaused: false }));
    expect(result.current.alignment.targetCount).toBe(1);
    expect(result.current.alignment.browsing?.acquiredSeriesUids.has(target.series_uid)).toBe(false);
    expect(result.current.alignment.browsing?.adjustments.get(target.series_uid)).toEqual(correction);
    await act(async () => vi.advanceTimersByTimeAsync(0));
    expect(alignAllDates).toHaveBeenCalledTimes(2);
    expect(alignAllDates.mock.lastCall?.[0].sliceIndex).toBe(30);
    expect(alignAllDates.mock.lastCall?.[1]).toEqual([DATE]);
  });
});
