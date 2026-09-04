import { usePanelSettings } from '../../src/hooks/usePanelSettings';
import type { VerifiedPanelSettingsSource } from '../../src/db/panelSettings';
import type { SeriesRef } from '../../src/types/api';

/** A unit-test snapshot double. Integration tests obtain owners from IndexedDB. */
export function verifiedSourcesForTest(sources: Record<string, SeriesRef> = {}) {
  return Object.fromEntries(
    Object.entries(sources).map(([date, source]) => [
      date,
      Object.freeze({
        studyUid: source.study_id,
        seriesUid: source.series_uid,
        datasetToken: 'test-dataset',
      }) as VerifiedPanelSettingsSource,
    ]),
  );
}

/** Existing settings tests exercise a real selected acquisition for each date. */
export function useTestPanelSettings(
  sequenceId: string | null,
  dates: string,
  patientKey: string | null = null,
  blocked = false,
  sources?: Record<string, SeriesRef>,
  token?: string,
) {
  return usePanelSettings(
    sequenceId,
    dates,
    patientKey,
    blocked,
    sources ??
      Object.fromEntries(
        dates
          .split(',')
          .filter(Boolean)
          .map((date) => [
            date,
            {
              study_id: `${patientKey ?? 'synthetic'}:${date}`,
              series_uid: `${patientKey ?? 'synthetic'}:${sequenceId}:${date}`,
              instance_count: 101,
            },
          ]),
      ),
    token,
  );
}
