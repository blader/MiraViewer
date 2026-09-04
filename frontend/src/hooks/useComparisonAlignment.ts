import { useCallback } from 'react';
import { DEFAULT_PANEL_SETTINGS } from '../utils/constants';
import { clearDerivedAlignmentFrame } from '../utils/derivedAlignmentFrame';
import { clearPersistedDerivedAlignmentFrames } from '../utils/localApi';
import { useAutoAlign } from './useAutoAlign';
import { useApplyAlignmentResults } from './useApplyAlignmentResults';
import { useVisibleAlignment } from './useVisibleAlignment';
import type { usePanelSettings } from './usePanelSettings';

type Options = Pick<
  Parameters<typeof useVisibleAlignment>[0],
  'data' | 'sequenceId' | 'columns' | 'presentedDates' | 'viewportSize' | 'outputMode' | 'enabled'
> & {
  panel: ReturnType<typeof usePanelSettings>;
};

/** Bind background computation, live-view application, and explicit presentation overrides. */
export function useComparisonAlignment({ panel, data, sequenceId, columns, ...view }: Options) {
  const engine = useAutoAlign();
  const { abort, clearRegistrationCache } = engine;
  const {
    panelSettings,
    progress,
    settingsReady,
    manuallyAdjustedDates,
    batchUpdateSettings,
    reportPersistenceError,
    updatePanelSetting,
  } = panel;
  const visible = useVisibleAlignment({
    ...view,
    data,
    sequenceId,
    columns,
    panelSettings,
    progress,
    settingsReady,
    alignAllDates: engine.alignAllDates,
    canReuseRegistration: engine.canReuseRegistration,
    abort,
  });
  useApplyAlignmentResults({
    isAligning: engine.isAligning,
    alignmentResults: engine.results,
    panelSettings,
    data,
    selectedSeqId: sequenceId,
    batchUpdateSettings,
    onPersistenceError: reportPersistenceError,
    activeRequestKey: visible.activeRequestKey,
  });
  const useAcquiredImage = useCallback(
    (date: string) => {
      const series = sequenceId && data?.series_map[sequenceId]?.[date];
      if (!series) return;
      abort();
      clearDerivedAlignmentFrame(series.series_uid);
      const settings = panelSettings.get(date) ?? DEFAULT_PANEL_SETTINGS;
      updatePanelSetting(date, {
        ...DEFAULT_PANEL_SETTINGS,
        offset: settings.offset,
        reverseSliceOrder: settings.reverseSliceOrder,
        progress,
        alignmentPaused: true,
      });
      if (data?.selected_patient_key) {
        void clearPersistedDerivedAlignmentFrames(data.selected_patient_key, series.series_uid).catch(
          reportPersistenceError,
        );
      }
    },
    [abort, data, panelSettings, progress, reportPersistenceError, sequenceId, updatePanelSetting],
  );
  const { realign: scheduleRealignment } = visible;
  const realign = useCallback(() => {
    clearRegistrationCache();
    for (const { date } of columns) {
      if (panelSettings.get(date)?.alignmentPaused) updatePanelSetting(date, { alignmentPaused: false });
    }
    scheduleRealignment();
  }, [clearRegistrationCache, columns, panelSettings, scheduleRealignment, updatePanelSetting]);

  const currentResults = engine.results.filter(
    (result) => !result.requestKey || result.requestKey === visible.activeRequestKey,
  );
  // Automatic navigation waits only for the currently presented targets. A
  // completed visible pair must not be held by an offscreen registration.
  const waitingForVisibleAlignment = Boolean(
    visible.activeRequestKey &&
    engine.isAligning &&
    columns.some(
      ({ date, ref }) =>
        ref &&
        visible.browsing?.targetSeriesUids.has(ref.series_uid) &&
        (!view.presentedDates || view.presentedDates.includes(date)) &&
        !currentResults.some((result) => result.date === date && result.outcome !== 'cancelled'),
    ),
  );

  return {
    ...engine,
    results: currentResults,
    waitingForVisibleAlignment,
    error: !engine.requestKey || engine.requestKey === visible.activeRequestKey ? engine.error : null,
    targetCount: visible.targetCount,
    browsing: visible.browsing
      ? {
          ...visible.browsing,
          updating: Boolean(
            visible.activeRequestKey && (engine.requestKey !== visible.activeRequestKey || engine.isAligning),
          ),
          unavailableSeriesUids: new Set(
            engine.requestKey === visible.activeRequestKey
              ? engine.error
                ? visible.browsing.targetSeriesUids
                : engine.results.flatMap((result) =>
                    result.outcome && result.outcome !== 'aligned' && result.outcome !== 'cancelled'
                      ? [result.seriesUid]
                      : [],
                  )
              : [],
          ),
        }
      : null,
    hasManualAdjustments: columns.some(
      ({ date }) =>
        date !== visible.referenceDate && !panelSettings.get(date)?.alignmentPaused && manuallyAdjustedDates?.has(date),
    ),
    realign,
    useAcquiredImage,
  };
}
