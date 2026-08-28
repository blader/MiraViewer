import { useCallback, useEffect, useEffectEvent, useState, useSyncExternalStore } from 'react';
import type { AlignmentReference, ComparisonData, PanelSettings, SeriesRef } from '../types/api';
import { DEFAULT_PANEL_SETTINGS } from '../utils/constants';
import { alignmentDisplayBaseline } from '../utils/alignmentAdjustment';
import { getDerivedAlignmentFrame, subscribeToDerivedAlignmentFrames } from '../utils/derivedAlignmentFrame';
import { getEffectiveInstanceIndex, getSliceIndex } from '../utils/math';
import type { OutputGridMode } from '../utils/outputPlaneGrid';
import type { useAutoAlign } from './useAutoAlign';

type VisibleAlignmentOptions = {
  data: ComparisonData | null;
  sequenceId: string | null;
  columns: readonly { date: string; ref?: SeriesRef }[];
  panelSettings: Map<string, PanelSettings>;
  progress: number;
  viewportSize: number;
  outputMode: OutputGridMode;
  enabled: boolean;
  settingsReady: boolean;
  alignAllDates: ReturnType<typeof useAutoAlign>['alignAllDates'];
  canReuseRegistration?: ReturnType<typeof useAutoAlign>['canReuseRegistration'];
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
    canReuseRegistration,
    abort,
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
    series && !settings.alignmentPaused
      ? (getDerivedAlignmentFrame(series.series_uid, sliceIndex)?.imageId ?? null)
      : null,
  );
  const targetDates = columns.flatMap(({ date, ref }, index) =>
    index > 0 && ref && !panelSettings.get(date)?.alignmentPaused ? [date] : [],
  );
  const targetSliceOffsets = new Map(
    targetDates.map((date) => [date, panelSettings.get(date)?.alignmentAdjustment?.sliceOffset ?? 0]),
  );
  const reference: AlignmentReference | null =
    first &&
    series &&
    data?.selected_patient_key &&
    sequenceId &&
    data.dataset_revision !== undefined &&
    settingsReady &&
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
  // Only target sampling intent belongs in a request identity. Applying automatic
  // settings or editing target display controls must not restart registration.
  const referenceGeometry = {
    ...alignmentDisplayBaseline(settings),
    offset: settings.offset,
    reverseSliceOrder: settings.reverseSliceOrder,
  };
  const requestKey =
    reference && targetDates.length > 0
      ? JSON.stringify([
          reference.patientKey,
          sequenceId,
          reference.datasetRevision,
          reference.seriesUid,
          sliceIndex,
          referenceGeometry,
          viewportSize,
          outputMode,
          derivedReferenceId,
          generation,
          targetDates.map((date) => [
            date,
            data!.series_map[sequenceId!]?.[date]?.series_uid,
            targetSliceOffsets.get(date),
            !!panelSettings.get(date)?.reverseSliceOrder,
          ]),
        ])
      : null;
  const run = useEffectEvent(async () => {
    if (!reference || !requestKey || !data || !sequenceId) return;
    try {
      await alignAllDates(reference, targetDates, data.series_map[sequenceId] ?? {}, progress, {
        outputMode,
        requestKey,
        reuseRegistration: true,
        targetSliceOffsets,
      });
    } catch {
      // The alignment owner publishes an actionable error. Do not retry a failed
      // view in a render loop; navigation or explicit Realign starts a new attempt.
    }
  });
  const active = enabled && pageVisible;
  const schedulingDelay = useEffectEvent(() =>
    reference && canReuseRegistration?.(reference, targetDates, data!.series_map[sequenceId!] ?? {}, outputMode)
      ? 0
      : 650,
  );
  useEffect(() => {
    if (!active || !requestKey) return;
    // An accepted scan-pair model needs only a new physical plane, not the
    // initial registration's quiet interval. Keep scrolling responsive.
    const timer = window.setTimeout(() => void run(), schedulingDelay());
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
    // Pausing computation must not revoke the accepted presentation. A selected
    // derived reference uses the engine's original physical anchor and legacy
    // exact-frame path, not this native-reference browsing cache.
    browsing: reference
      ? {
          reference: derivedReferenceId ? null : { ...reference, outputMode },
          updating: active,
          adjustments: new Map(
            columns.flatMap(({ date, ref }) => {
              const adjustment = panelSettings.get(date)?.alignmentAdjustment;
              return ref && adjustment ? [[ref.series_uid, adjustment] as const] : [];
            }),
          ),
          acquiredSeriesUids: new Set(
            columns.flatMap(({ date, ref }) =>
              ref && panelSettings.get(date)?.alignmentPaused ? [ref.series_uid] : [],
            ),
          ),
          targetSeriesUids: new Set(
            targetDates.flatMap((date) => {
              const target = data!.series_map[sequenceId!]?.[date];
              return target ? [target.series_uid] : [];
            }),
          ),
        }
      : null,
    realign,
    targetCount: targetDates.length,
  };
}
