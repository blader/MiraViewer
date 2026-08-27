import { useCallback, useEffect, useEffectEvent, useState, useSyncExternalStore } from 'react';
import type { AlignmentReference, ComparisonData, PanelSettings, SeriesRef } from '../types/api';
import { DEFAULT_PANEL_SETTINGS } from '../utils/constants';
import { getDerivedAlignmentFrame, subscribeToDerivedAlignmentFrames } from '../utils/derivedAlignmentFrame';
import { getEffectiveInstanceIndex, getSliceIndex } from '../utils/math';
import type { OutputGridMode } from '../utils/outputPlaneGrid';
import type { useAutoAlign } from './useAutoAlign';

type VisibleAlignmentOptions = {
  data: ComparisonData | null;
  sequenceId: string | null;
  columns: readonly { date: string; ref?: SeriesRef }[];
  panelSettings: Map<string, PanelSettings>;
  manuallyAdjustedDates?: ReadonlySet<string>;
  progress: number;
  viewportSize: number;
  outputMode: OutputGridMode;
  enabled: boolean;
  settingsReady: boolean;
  alignAllDates: ReturnType<typeof useAutoAlign>['alignAllDates'];
  abort: () => void;
};

/** One cancellable background operation follows the first visible comparison column. */
export function useVisibleAlignment(options: VisibleAlignmentOptions) {
  const {
    data,
    sequenceId,
    columns,
    panelSettings,
    progress,
    viewportSize,
    outputMode,
    enabled,
    settingsReady,
    alignAllDates,
    abort,
    manuallyAdjustedDates,
  } = options;
  const [generation, setGeneration] = useState(0);
  const [pageVisible, setPageVisible] = useState(() => document.visibilityState !== 'hidden');
  useEffect(() => {
    const changed = () => setPageVisible(document.visibilityState !== 'hidden');
    document.addEventListener('visibilitychange', changed);
    return () => document.removeEventListener('visibilitychange', changed);
  }, []);
  const first = columns[0];
  const series = first?.ref;
  const settings = first ? (panelSettings.get(first.date) ?? DEFAULT_PANEL_SETTINGS) : DEFAULT_PANEL_SETTINGS;
  const sliceIndex = series
    ? getEffectiveInstanceIndex(
        getSliceIndex(series.instance_count, progress, settings.offset),
        series.instance_count,
        settings.reverseSliceOrder,
      )
    : 0;
  const derivedReferenceId = useSyncExternalStore(subscribeToDerivedAlignmentFrames, () =>
    series ? (getDerivedAlignmentFrame(series.series_uid, sliceIndex)?.imageId ?? null) : null,
  );
  const targetDates = columns.flatMap(({ date, ref }, index) =>
    index > 0 && ref && !manuallyAdjustedDates?.has(date) ? [date] : [],
  );
  const reference: AlignmentReference | null =
    first &&
    series &&
    data?.selected_patient_key &&
    sequenceId &&
    data.dataset_revision !== undefined &&
    settingsReady &&
    targetDates.length &&
    viewportSize > 0
      ? {
          date: first.date,
          seriesUid: series.series_uid,
          sliceCount: series.instance_count,
          sliceIndex,
          patientKey: data.selected_patient_key,
          sequenceId,
          datasetRevision: data.dataset_revision,
          studyUid: series.study_uid ?? series.study_id,
          frameOfReferenceUid: series.frame_of_reference_uid,
          imageSize: { width: series.columns ?? 512, height: series.rows ?? 512 },
          viewportSize: { width: viewportSize, height: viewportSize },
          settings,
        }
      : null;
  // Target settings are deliberately absent: applying an automatic result must not
  // schedule another registration. The reference's persisted progress is also derived.
  const { progress: _persistedProgress, ...referenceGeometry } = settings;
  void _persistedProgress;
  const requestKey = reference
    ? JSON.stringify([
        reference.patientKey,
        sequenceId,
        reference.datasetRevision,
        reference.seriesUid,
        sliceIndex,
        referenceGeometry,
        progress,
        viewportSize,
        outputMode,
        derivedReferenceId,
        generation,
        targetDates.map((date) => [date, data!.series_map[sequenceId!]?.[date]?.series_uid]),
      ])
    : null;
  const run = useEffectEvent(async () => {
    if (!reference || !requestKey || !data || !sequenceId) return;
    try {
      await alignAllDates(reference, targetDates, data.series_map[sequenceId] ?? {}, progress, {
        outputMode,
        requestKey,
        reuseRegistration: true,
      });
    } catch {
      // The alignment owner publishes an actionable error. Do not retry a failed
      // view in a render loop; navigation or explicit Realign starts a new attempt.
    }
  });
  const active = enabled && pageVisible;
  useEffect(() => {
    if (!active || !requestKey) return;
    const timer = window.setTimeout(() => void run(), 650);
    return () => {
      window.clearTimeout(timer);
      abort();
    };
  }, [abort, active, requestKey]);
  const realign = useCallback(() => {
    abort();
    setGeneration((value) => value + 1);
  }, [abort]);
  return {
    activeRequestKey: active ? requestKey : null,
    realign,
    targetCount: targetDates.length,
    referenceDate: first?.date,
  };
}
