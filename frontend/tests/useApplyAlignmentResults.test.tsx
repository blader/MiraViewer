import { renderHook, waitFor } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import { useApplyAlignmentResults } from '../src/hooks/useApplyAlignmentResults';
import { DEFAULT_PANEL_SETTINGS } from '../src/utils/constants';
import type { AlignmentResult, ComparisonData, PanelSettings } from '../src/types/api';
import * as localApi from '../src/utils/localApi';
import { clearDerivedAlignmentFrames } from '../src/utils/derivedAlignmentFrame';
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

  it.each([
    { label: 'a changed sequence', result: { sequenceId: 'different-sequence' } },
    { label: 'a changed patient', result: { patientKey: 'patient-b' } },
    { label: 'a replaced dataset', result: { datasetRevision: 8 } },
    { label: 'a different target series', result: { seriesUid: 'different-series' } },
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
