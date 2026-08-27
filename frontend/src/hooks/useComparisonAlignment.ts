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
  'data' | 'sequenceId' | 'columns' | 'viewportSize' | 'outputMode' | 'enabled'
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
    holdAlignment,
    updatePanelSetting,
    clearManualAdjustments,
  } = panel;
  const visible = useVisibleAlignment({
    ...view,
    data,
    sequenceId,
    columns,
    panelSettings,
    progress,
    settingsReady,
    manuallyAdjustedDates,
    alignAllDates: engine.alignAllDates,
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
      holdAlignment(date);
      clearDerivedAlignmentFrame(series.series_uid);
      const settings = panelSettings.get(date) ?? DEFAULT_PANEL_SETTINGS;
      updatePanelSetting(date, {
        ...DEFAULT_PANEL_SETTINGS,
        offset: settings.offset,
        reverseSliceOrder: settings.reverseSliceOrder,
        progress,
      });
      if (data?.selected_patient_key) {
        void clearPersistedDerivedAlignmentFrames(data.selected_patient_key, series.series_uid).catch(
          reportPersistenceError,
        );
      }
    },
    [abort, data, holdAlignment, panelSettings, progress, reportPersistenceError, sequenceId, updatePanelSetting],
  );
  const { realign: scheduleRealignment } = visible;
  const realign = useCallback(() => {
    clearRegistrationCache();
    clearManualAdjustments();
    scheduleRealignment();
  }, [clearRegistrationCache, clearManualAdjustments, scheduleRealignment]);

  return {
    ...engine,
    results: engine.results.filter((result) => !result.requestKey || result.requestKey === visible.activeRequestKey),
    error: !engine.requestKey || engine.requestKey === visible.activeRequestKey ? engine.error : null,
    targetCount: visible.targetCount,
    hasManualAdjustments: columns.some(({ date }, index) => index > 0 && manuallyAdjustedDates?.has(date)),
    realign,
    useAcquiredImage,
  };
}
