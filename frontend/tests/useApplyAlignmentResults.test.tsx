import { act, renderHook, waitFor } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import { useApplyAlignmentResults } from '../src/hooks/useApplyAlignmentResults';
import { DEFAULT_PANEL_SETTINGS } from '../src/utils/constants';
import type { AlignmentResult, ComparisonData, PanelSettings } from '../src/types/api';
import * as localApi from '../src/utils/localApi';
import {
  clearDerivedAlignmentFrames,
  getDerivedAlignmentFrame,
  setDerivedAlignmentFrame,
  subscribeToDerivedAlignmentFrames,
} from '../src/utils/derivedAlignmentFrame';
import { buildOutputPlaneGrid } from '../src/utils/outputPlaneGrid';

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
      }),
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
      },
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

  it('applies a replacement run to an examination already updated by the interrupted run', async () => {
    const date = '2024-01-01T00:00:00';
    const sequenceId = 'sequence-a';
    const data: ComparisonData = {
      planes: ['Axial'],
      dates: [date],
      sequences: [],
      series_map: {
        [sequenceId]: {
          [date]: { study_id: 'study-a', series_uid: 'series-a', instance_count: 10 },
        },
      },
    };
    const firstResult: AlignmentResult = {
      date,
      seriesUid: 'series-a',
      bestSliceIndex: 2,
      nmiScore: 1,
      computedSettings: { ...DEFAULT_PANEL_SETTINGS, zoom: 1.2 },
      slicesChecked: 10,
      runId: 'interrupted-run',
      outcome: 'aligned',
    };
    const batchUpdateSettings = vi.fn();
    const { rerender } = renderHook(
      ({ alignmentResults }: { alignmentResults: AlignmentResult[] }) =>
        useApplyAlignmentResults({
          isAligning: true,
          alignmentResults,
          panelSettings: new Map(),
          data,
          selectedSeqId: sequenceId,
          batchUpdateSettings,
        }),
      { initialProps: { alignmentResults: [firstResult] } },
    );

    await waitFor(() => expect(batchUpdateSettings).toHaveBeenCalledTimes(1));

    rerender({
      alignmentResults: [
        {
          ...firstResult,
          runId: 'replacement-run',
          computedSettings: { ...DEFAULT_PANEL_SETTINGS, zoom: 1.7 },
        },
      ],
    });

    await waitFor(() => expect(batchUpdateSettings).toHaveBeenCalledTimes(2));
    const replacement = batchUpdateSettings.mock.calls[1]?.[0] as Map<string, PanelSettings>;
    expect(replacement.get(date)?.zoom).toBe(1.7);
    expect(batchUpdateSettings.mock.calls[1]?.[1]).toBe('replacement-run');
  });

  it('discards obsolete target planes when a successful replacement presents acquired anatomy', () => {
    const date = '2024-01-01';
    const sequenceId = 'sequence-a';
    const clearPersisted = vi.spyOn(localApi, 'clearPersistedDerivedAlignmentFrames').mockResolvedValue();
    const publishPreviousPlane = (seriesUid: string, bestSliceIndex: number) =>
      setDerivedAlignmentFrame({
        date,
        seriesUid,
        bestSliceIndex,
        nmiScore: 1,
        computedSettings: DEFAULT_PANEL_SETTINGS,
        slicesChecked: 1,
        runId: 'previous-derived-run',
        outcome: 'aligned',
        derivedFrame: {
          rows: 2,
          columns: 2,
          pixels: new Float32Array([1, 2, 3, 4]),
          sourceImageId: `miradb:${seriesUid}-${bestSliceIndex}`,
        },
      });
    publishPreviousPlane('target-series', 1);
    publishPreviousPlane('target-series', 4);
    publishPreviousPlane('fixed-reference-series', 2);

    const data: ComparisonData = {
      planes: ['Axial'],
      dates: [date],
      sequences: [],
      selected_patient_key: 'patient-a',
      series_map: {
        [sequenceId]: {
          [date]: {
            study_id: 'target-study',
            series_uid: 'target-series',
            instance_count: 10,
            patient_key: 'patient-a',
          },
        },
      },
    };
    const batchUpdateSettings = vi.fn();

    try {
      renderHook(() =>
        useApplyAlignmentResults({
          isAligning: true,
          alignmentResults: [
            {
              date,
              seriesUid: 'target-series',
              bestSliceIndex: 1,
              nmiScore: 1,
              computedSettings: DEFAULT_PANEL_SETTINGS,
              slicesChecked: 10,
              runId: 'replacement-native-run',
              patientKey: 'patient-a',
              referenceSeriesUid: 'fixed-reference-series',
              outcome: 'aligned',
            },
          ],
          panelSettings: new Map(),
          data,
          selectedSeqId: sequenceId,
          batchUpdateSettings,
        }),
      );

      expect(batchUpdateSettings).toHaveBeenCalledOnce();
      expect(getDerivedAlignmentFrame('target-series', 1)).toBeNull();
      expect(getDerivedAlignmentFrame('target-series', 4)).toBeNull();
      expect(getDerivedAlignmentFrame('fixed-reference-series', 2)).not.toBeNull();
      expect(clearPersisted).toHaveBeenCalledOnce();
      expect(clearPersisted).toHaveBeenCalledWith('patient-a', 'target-series');
    } finally {
      clearPersisted.mockRestore();
      clearDerivedAlignmentFrames();
    }
  });

  it('atomically replaces obsolete target indices and persists only the newest derived plane', async () => {
    const date = '2024-01-01';
    const sequenceId = 'sequence-a';
    const operations: string[] = [];
    const durableFrames = new Map([
      ['target-series:1', 'old-target-one'],
      ['target-series:4', 'old-target-four'],
      ['fixed-reference-series:2', 'fixed-reference'],
    ]);
    const clearPersisted = vi
      .spyOn(localApi, 'clearPersistedDerivedAlignmentFrames')
      .mockImplementation(async (_patientKey, seriesUid) => {
        operations.push(`clear:${seriesUid}`);
        for (const key of durableFrames.keys()) {
          if (key.startsWith(`${seriesUid}:`)) durableFrames.delete(key);
        }
      });
    const save = vi.spyOn(localApi, 'saveDerivedAlignmentFrame').mockImplementation(async (frame) => {
      operations.push(`save:${frame.targetFrameIndex}`);
      durableFrames.set(`${frame.targetSeriesUid}:${frame.targetFrameIndex}`, frame.runId ?? 'saved');
    });
    const previous = (seriesUid: string, bestSliceIndex: number) =>
      setDerivedAlignmentFrame({
        date,
        seriesUid,
        bestSliceIndex,
        nmiScore: 1,
        computedSettings: DEFAULT_PANEL_SETTINGS,
        slicesChecked: 1,
        runId: 'previous-derived-run',
        outcome: 'aligned',
        derivedFrame: {
          rows: 2,
          columns: 2,
          pixels: new Float32Array([1, 2, 3, 4]),
          sourceImageId: `miradb:${seriesUid}-${bestSliceIndex}`,
        },
      });
    previous('target-series', 1);
    previous('target-series', 4);
    previous('fixed-reference-series', 2);
    const observedPresentations: Array<{ current: boolean; obsolete: boolean; reference: boolean }> = [];
    const unsubscribe = subscribeToDerivedAlignmentFrames(() => {
      observedPresentations.push({
        current: getDerivedAlignmentFrame('target-series', 6) !== null,
        obsolete:
          getDerivedAlignmentFrame('target-series', 1) !== null ||
          getDerivedAlignmentFrame('target-series', 4) !== null,
        reference: getDerivedAlignmentFrame('fixed-reference-series', 2) !== null,
      });
    });
    const data: ComparisonData = {
      planes: ['Axial'],
      dates: [date],
      sequences: [],
      selected_patient_key: 'patient-a',
      dataset_revision: 7,
      series_map: {
        [sequenceId]: {
          [date]: {
            study_id: 'target-study',
            study_uid: 'target-study',
            series_uid: 'target-series',
            instance_count: 10,
            patient_key: 'patient-a',
          },
        },
      },
    };

    try {
      renderHook(() =>
        useApplyAlignmentResults({
          isAligning: true,
          alignmentResults: [
            {
              date,
              seriesUid: 'target-series',
              bestSliceIndex: 6,
              nmiScore: 1,
              computedSettings: DEFAULT_PANEL_SETTINGS,
              slicesChecked: 10,
              runId: 'replacement-derived-run',
              patientKey: 'patient-a',
              sequenceId,
              datasetRevision: 7,
              referenceSeriesUid: 'fixed-reference-series',
              outcome: 'aligned',
              derivedFrame: {
                rows: 2,
                columns: 2,
                pixels: new Float32Array([5, 6, 7, 8]),
                sourceImageId: 'miradb:target-sop-six',
                targetStudyUid: 'target-study',
                targetSopInstanceUid: 'target-sop-six',
              },
            },
          ],
          panelSettings: new Map(),
          data,
          selectedSeqId: sequenceId,
          batchUpdateSettings: vi.fn(),
        }),
      );

      expect(observedPresentations).toEqual([{ current: true, obsolete: false, reference: true }]);
      await waitFor(() => expect(save).toHaveBeenCalledOnce());
      expect(operations).toEqual(['clear:target-series', 'save:6']);
      expect(clearPersisted).toHaveBeenCalledWith('patient-a', 'target-series');
      expect(Array.from(durableFrames.keys()).sort()).toEqual(['fixed-reference-series:2', 'target-series:6']);
    } finally {
      unsubscribe();
      clearPersisted.mockRestore();
      save.mockRestore();
      clearDerivedAlignmentFrames();
    }
  });

  it.each([
    { predecessor: 'finishes late', fails: false },
    { predecessor: 'fails late', fails: true },
  ])('does not resurrect an obsolete derived plane when its older durable write $predecessor', async ({ fails }) => {
    const date = '2024-01-01';
    const sequenceId = 'sequence-a';
    const operations: string[] = [];
    const onPersistenceError = vi.fn();
    const predecessorError = new Error('Previous aligned-plane write failed');
    let persistedDerivedPlane = false;
    let finishPreviousWrite!: () => void;
    const save = vi.spyOn(localApi, 'saveDerivedAlignmentFrame').mockImplementation(
      () =>
        new Promise<void>((resolve, reject) => {
          operations.push('save-started');
          finishPreviousWrite = () => {
            operations.push(fails ? 'save-failed' : 'save-completed');
            if (fails) reject(predecessorError);
            else {
              persistedDerivedPlane = true;
              resolve();
            }
          };
        }),
    );
    const clearPersisted = vi.spyOn(localApi, 'clearPersistedDerivedAlignmentFrames').mockImplementation(async () => {
      persistedDerivedPlane = false;
      operations.push('clear-completed');
    });
    const data: ComparisonData = {
      planes: ['Axial'],
      dates: [date],
      sequences: [],
      selected_patient_key: 'patient-a',
      dataset_revision: 7,
      series_map: {
        [sequenceId]: {
          [date]: {
            study_id: 'target-study',
            study_uid: 'target-study',
            series_uid: 'target-series',
            instance_count: 10,
            patient_key: 'patient-a',
          },
        },
      },
    };
    const derivedResult: AlignmentResult = {
      date,
      seriesUid: 'target-series',
      bestSliceIndex: 1,
      nmiScore: 1,
      computedSettings: DEFAULT_PANEL_SETTINGS,
      slicesChecked: 10,
      runId: 'previous-derived-run',
      patientKey: 'patient-a',
      sequenceId,
      datasetRevision: 7,
      referenceSeriesUid: 'fixed-reference-series',
      outcome: 'aligned',
      derivedFrame: {
        rows: 2,
        columns: 2,
        pixels: new Float32Array([1, 2, 3, 4]),
        sourceImageId: 'miradb:target-sop',
        targetStudyUid: 'target-study',
        targetSopInstanceUid: 'target-sop',
      },
    };

    try {
      const { rerender } = renderHook(
        ({ alignmentResults }: { alignmentResults: AlignmentResult[] }) =>
          useApplyAlignmentResults({
            isAligning: true,
            alignmentResults,
            panelSettings: new Map(),
            data,
            selectedSeqId: sequenceId,
            batchUpdateSettings: vi.fn(),
            onPersistenceError,
          }),
        { initialProps: { alignmentResults: [derivedResult] } },
      );
      await waitFor(() => expect(save).toHaveBeenCalledOnce());

      await act(async () => {
        rerender({
          alignmentResults: [{ ...derivedResult, runId: 'replacement-native-run', derivedFrame: undefined }],
        });
      });
      await act(async () => {
        finishPreviousWrite();
      });

      await waitFor(() => expect(clearPersisted).toHaveBeenCalledTimes(2));
      expect(operations).toEqual([
        'clear-completed',
        'save-started',
        fails ? 'save-failed' : 'save-completed',
        'clear-completed',
      ]);
      expect(persistedDerivedPlane).toBe(false);
      expect(onPersistenceError).toHaveBeenCalledTimes(fails ? 1 : 0);
      if (fails) expect(onPersistenceError).toHaveBeenCalledWith(predecessorError);
    } finally {
      clearPersisted.mockRestore();
      save.mockRestore();
      clearDerivedAlignmentFrames();
    }
  });

  it.each([
    { predecessor: 'completes late', fails: false },
    { predecessor: 'fails late', fails: true },
  ])('preserves a newer derived plane when an older durable deletion $predecessor', async ({ fails }) => {
    const date = '2024-01-01';
    const sequenceId = 'sequence-a';
    const operations: string[] = [];
    const onPersistenceError = vi.fn();
    const predecessorError = new Error('Previous aligned-plane removal failed');
    let persistedDerivedPlane = true;
    let finishPreviousClear!: () => void;
    let clearCount = 0;
    const clearPersisted = vi.spyOn(localApi, 'clearPersistedDerivedAlignmentFrames').mockImplementation(() => {
      if (clearCount++ > 0) {
        persistedDerivedPlane = false;
        operations.push('replacement-clear-completed');
        return Promise.resolve();
      }
      return new Promise<void>((resolve, reject) => {
        operations.push('clear-started');
        finishPreviousClear = () => {
          operations.push(fails ? 'clear-failed' : 'clear-completed');
          if (fails) reject(predecessorError);
          else {
            persistedDerivedPlane = false;
            resolve();
          }
        };
      });
    });
    const save = vi.spyOn(localApi, 'saveDerivedAlignmentFrame').mockImplementation(async () => {
      persistedDerivedPlane = true;
      operations.push('save-completed');
    });
    const data: ComparisonData = {
      planes: ['Axial'],
      dates: [date],
      sequences: [],
      selected_patient_key: 'patient-a',
      dataset_revision: 7,
      series_map: {
        [sequenceId]: {
          [date]: {
            study_id: 'target-study',
            study_uid: 'target-study',
            series_uid: 'target-series',
            instance_count: 10,
            patient_key: 'patient-a',
          },
        },
      },
    };
    const nativeResult: AlignmentResult = {
      date,
      seriesUid: 'target-series',
      bestSliceIndex: 1,
      nmiScore: 1,
      computedSettings: DEFAULT_PANEL_SETTINGS,
      slicesChecked: 10,
      runId: 'previous-native-run',
      patientKey: 'patient-a',
      sequenceId,
      datasetRevision: 7,
      referenceSeriesUid: 'fixed-reference-series',
      outcome: 'aligned',
    };

    try {
      const { rerender } = renderHook(
        ({ alignmentResults }: { alignmentResults: AlignmentResult[] }) =>
          useApplyAlignmentResults({
            isAligning: true,
            alignmentResults,
            panelSettings: new Map(),
            data,
            selectedSeqId: sequenceId,
            batchUpdateSettings: vi.fn(),
            onPersistenceError,
          }),
        { initialProps: { alignmentResults: [nativeResult] } },
      );
      await waitFor(() => expect(clearPersisted).toHaveBeenCalledOnce());

      await act(async () => {
        rerender({
          alignmentResults: [
            {
              ...nativeResult,
              runId: 'replacement-derived-run',
              derivedFrame: {
                rows: 2,
                columns: 2,
                pixels: new Float32Array([1, 2, 3, 4]),
                sourceImageId: 'miradb:target-sop',
                targetStudyUid: 'target-study',
                targetSopInstanceUid: 'target-sop',
              },
            },
          ],
        });
      });
      await act(async () => {
        finishPreviousClear();
      });

      await waitFor(() => expect(save).toHaveBeenCalledOnce());
      expect(operations).toEqual([
        'clear-started',
        fails ? 'clear-failed' : 'clear-completed',
        'replacement-clear-completed',
        'save-completed',
      ]);
      expect(persistedDerivedPlane).toBe(true);
      expect(onPersistenceError).toHaveBeenCalledTimes(fails ? 1 : 0);
      if (fails) expect(onPersistenceError).toHaveBeenCalledWith(predecessorError);
    } finally {
      clearPersisted.mockRestore();
      save.mockRestore();
      clearDerivedAlignmentFrames();
    }
  });

  it.each([
    { label: 'a changed sequence', result: { sequenceId: 'different-sequence' } },
    { label: 'a changed patient', result: { patientKey: 'patient-b' } },
    { label: 'a replaced dataset', result: { datasetRevision: 8 } },
    { label: 'a different target series', result: { seriesUid: 'different-series' } },
    { label: 'the selected reference examination', result: { referenceSeriesUid: 'series-a' } },
    { label: 'a negative target slice', result: { bestSliceIndex: -1 } },
    { label: 'a target slice beyond the acquisition', result: { bestSliceIndex: 10 } },
    { label: 'a fractional target slice', result: { bestSliceIndex: 2.5 } },
    { label: 'an ambiguous registration', result: { outcome: 'ambiguous' as const } },
    { label: 'insufficient physical overlap', result: { outcome: 'insufficient-overlap' as const } },
  ])('does not apply stale or unsafe results from $label', ({ result }) => {
    const date = '2024-01-01';
    const sequenceId = 'sequence-a';
    const data: ComparisonData = {
      planes: ['Axial'],
      dates: [date],
      sequences: [],
      selected_patient_key: 'patient-a',
      dataset_revision: 7,
      series_map: {
        [sequenceId]: {
          [date]: {
            study_id: 'study-a',
            series_uid: 'series-a',
            instance_count: 10,
            patient_key: 'patient-a',
          },
        },
      },
    };
    const batchUpdateSettings = vi.fn();

    renderHook(() =>
      useApplyAlignmentResults({
        isAligning: true,
        alignmentResults: [
          {
            date,
            seriesUid: 'series-a',
            bestSliceIndex: 2,
            nmiScore: 1,
            computedSettings: DEFAULT_PANEL_SETTINGS,
            slicesChecked: 10,
            sequenceId,
            patientKey: 'patient-a',
            datasetRevision: 7,
            outcome: 'aligned',
            ...result,
          },
        ],
        panelSettings: new Map(),
        data,
        selectedSeqId: sequenceId,
        batchUpdateSettings,
      }),
    );

    expect(batchUpdateSettings).not.toHaveBeenCalled();
  });

  it.each([
    { label: 'missing operation identity', result: { runId: undefined } },
    { label: 'missing successful registration status', result: { outcome: undefined } },
    { label: 'missing patient identity', result: { patientKey: undefined } },
    { label: 'a different patient', result: { patientKey: 'patient-b' } },
    { label: 'missing sequence identity', result: { sequenceId: undefined } },
    { label: 'a different sequence', result: { sequenceId: 'different-sequence' } },
    { label: 'missing dataset revision', result: { datasetRevision: undefined } },
    { label: 'a different dataset revision', result: { datasetRevision: 8 } },
    { label: 'missing examination identity', frame: { targetStudyUid: undefined } },
    { label: 'a different examination', frame: { targetStudyUid: 'different-study' } },
    { label: 'missing selected patient', data: { selected_patient_key: undefined } },
    { label: 'missing live dataset revision', data: { dataset_revision: undefined } },
  ] as Array<{
    label: string;
    result?: Partial<AlignmentResult>;
    frame?: Partial<NonNullable<AlignmentResult['derivedFrame']>>;
    data?: Partial<ComparisonData>;
  }>)('rejects a derived plane with $label before changing displayed or durable anatomy', async (failure) => {
    const date = 'target-date';
    const sequenceId = 'target-sequence';
    const patientKey = 'patient-a';
    const seriesUid = 'target-series';
    const clearPersisted = vi.spyOn(localApi, 'clearPersistedDerivedAlignmentFrames').mockResolvedValue();
    const save = vi.spyOn(localApi, 'saveDerivedAlignmentFrame').mockResolvedValue();
    const batchUpdateSettings = vi.fn();
    const onPersistenceError = vi.fn();
    const previousResult: AlignmentResult = {
      date,
      seriesUid,
      bestSliceIndex: 1,
      nmiScore: 1,
      computedSettings: DEFAULT_PANEL_SETTINGS,
      slicesChecked: 3,
      runId: 'previously-verified-run',
      patientKey,
      sequenceId,
      datasetRevision: 7,
      referenceSeriesUid: 'reference-series',
      outcome: 'aligned',
      derivedFrame: {
        rows: 2,
        columns: 2,
        pixels: new Float32Array([1, 2, 3, 4]),
        sourceImageId: 'miradb:target-sop-one',
        targetStudyUid: 'target-study',
        targetSopInstanceUid: 'target-sop-one',
      },
    };
    setDerivedAlignmentFrame(previousResult);
    const previousFrame = getDerivedAlignmentFrame(seriesUid, 1);
    const data: ComparisonData = {
      planes: [],
      dates: [date],
      sequences: [],
      selected_patient_key: patientKey,
      dataset_revision: 7,
      series_map: {
        [sequenceId]: {
          [date]: {
            study_id: 'legacy-study-id',
            study_uid: 'target-study',
            series_uid: seriesUid,
            instance_count: 3,
            patient_key: patientKey,
          },
        },
      },
      ...failure.data,
    };
    const candidate: AlignmentResult = {
      ...previousResult,
      bestSliceIndex: 2,
      runId: 'replacement-run',
      derivedFrame: {
        ...previousResult.derivedFrame!,
        pixels: new Float32Array([5, 6, 7, 8]),
        sourceImageId: 'miradb:target-sop-two',
        targetSopInstanceUid: 'target-sop-two',
        ...failure.frame,
      },
      ...failure.result,
    };

    try {
      renderHook(() =>
        useApplyAlignmentResults({
          isAligning: true,
          alignmentResults: [candidate],
          panelSettings: new Map(),
          data,
          selectedSeqId: sequenceId,
          batchUpdateSettings,
          onPersistenceError,
        }),
      );

      await act(async () => {
        await Promise.resolve();
      });

      expect(batchUpdateSettings).not.toHaveBeenCalled();
      expect(getDerivedAlignmentFrame(seriesUid, 1)).toBe(previousFrame);
      expect(getDerivedAlignmentFrame(seriesUid, 2)).toBeNull();
      expect(clearPersisted).not.toHaveBeenCalled();
      expect(save).not.toHaveBeenCalled();
      expect(onPersistenceError).not.toHaveBeenCalled();
    } finally {
      clearPersisted.mockRestore();
      save.mockRestore();
      clearDerivedAlignmentFrames();
    }
  });

  it.each([
    'missing-derived-grid',
    'mismatched-derived-grid',
    'mismatched-pixel-lattice',
    'mismatched-validity-mask',
  ] as const)('does not apply an aligned result whose verified output authority is %s', (failure) => {
    const date = '2024-01-01';
    const sequenceId = 'sequence-a';
    const grid = buildOutputPlaneGrid({
      rows: 2,
      columns: 2,
      imagePositionPatient: '0\\0\\0',
      imageOrientationPatient: '1\\0\\0\\0\\1\\0',
      pixelSpacing: '1\\1',
      sopInstanceUid: 'reference-sop',
    });
    const mismatchedGrid = buildOutputPlaneGrid({
      rows: 2,
      columns: 2,
      imagePositionPatient: '4\\0\\0',
      imageOrientationPatient: '1\\0\\0\\0\\1\\0',
      pixelSpacing: '1\\1',
      sopInstanceUid: 'different-reference-sop',
    });
    const data: ComparisonData = {
      planes: ['Axial'],
      dates: [date],
      sequences: [],
      selected_patient_key: 'patient-a',
      dataset_revision: 7,
      series_map: {
        [sequenceId]: {
          [date]: {
            study_id: 'study-a',
            series_uid: 'series-a',
            instance_count: 10,
            patient_key: 'patient-a',
          },
        },
      },
    };
    const batchUpdateSettings = vi.fn();

    renderHook(() =>
      useApplyAlignmentResults({
        isAligning: true,
        alignmentResults: [
          {
            date,
            seriesUid: 'series-a',
            bestSliceIndex: 2,
            nmiScore: 1,
            computedSettings: DEFAULT_PANEL_SETTINGS,
            slicesChecked: 10,
            runId: 'verified-grid-run',
            patientKey: 'patient-a',
            sequenceId,
            datasetRevision: 7,
            outcome: 'aligned',
            outputGrid: grid,
            derivedFrame: {
              pixels: new Float32Array([1, 2, 3, 4]),
              rows: failure === 'mismatched-pixel-lattice' ? 1 : 2,
              columns: 2,
              sourceImageId: 'miradb:target-sop',
              targetStudyUid: 'study-a',
              ...(failure === 'mismatched-validity-mask' ? { valid: new Uint8Array([1, 0]) } : {}),
              ...(failure === 'missing-derived-grid'
                ? {}
                : { outputGrid: failure === 'mismatched-derived-grid' ? mismatchedGrid : grid }),
            },
          },
        ],
        panelSettings: new Map(),
        data,
        selectedSeqId: sequenceId,
        batchUpdateSettings,
      }),
    );

    expect(batchUpdateSettings).not.toHaveBeenCalled();
  });

  it('surfaces verified-plane persistence errors instead of claiming aligned anatomy survives restart', async () => {
    const save = vi.spyOn(localApi, 'saveDerivedAlignmentFrame').mockRejectedValue(new Error('Storage quota exceeded'));
    const date = 'target-date';
    const sequenceId = 'target-sequence';
    const reportPersistenceError = vi.fn();
    const data: ComparisonData = {
      planes: [],
      dates: [date],
      sequences: [],
      selected_patient_key: 'patient-a',
      dataset_revision: 7,
      series_map: {
        [sequenceId]: {
          [date]: {
            study_id: 'target-study',
            study_uid: 'target-study',
            series_uid: 'target-series',
            instance_count: 3,
            patient_key: 'patient-a',
          },
        },
      },
    };

    renderHook(() =>
      useApplyAlignmentResults({
        isAligning: true,
        alignmentResults: [
          {
            date,
            seriesUid: 'target-series',
            bestSliceIndex: 1,
            nmiScore: 1,
            computedSettings: DEFAULT_PANEL_SETTINGS,
            slicesChecked: 3,
            runId: 'verified-run',
            patientKey: 'patient-a',
            sequenceId,
            datasetRevision: 7,
            outcome: 'aligned',
            derivedFrame: {
              rows: 2,
              columns: 2,
              pixels: new Float32Array([1, 2, 3, 4]),
              sourceImageId: 'miradb:target-sop',
              targetStudyUid: 'target-study',
              targetSopInstanceUid: 'target-sop',
            },
          },
        ],
        panelSettings: new Map(),
        data,
        selectedSeqId: sequenceId,
        batchUpdateSettings: vi.fn(),
        onPersistenceError: reportPersistenceError,
      }),
    );

    await waitFor(() => {
      expect(reportPersistenceError).toHaveBeenCalledWith(
        expect.objectContaining({ message: 'Storage quota exceeded' }),
      );
    });
    save.mockRestore();
    clearDerivedAlignmentFrames();
  });
});
