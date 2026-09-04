import { DATASET_TOKEN_STATE_KEY, DatasetReplacedError, getDB, SELECTED_PATIENT_STATE_KEY } from './db';
import { getPatientIdentityAliases, getPatientIdentityKeys } from './patientIdentity';
import { formatStudyDate, getSeriesSequenceCombo, sourceSettingsKey } from './comparisonIdentity';
import type { DicomStudy, PanelSettingsRow } from './schema';
import type { PanelSettings, PanelSettingsPartial, SeriesRef } from '../types/api';

export type LegacyPanelSettings = {
  id: string;
  origin: { comboId: string; dateIso: string };
  settings: PanelSettingsPartial;
  eligibleDates: string[];
};

declare const verifiedSource: unique symbol;
/** Issued only by a successful, source-validating snapshot. Never rebind on save. */
export type VerifiedPanelSettingsSource = Readonly<{
  studyUid: string;
  seriesUid: string;
  datasetToken: string;
  legacyOrigin?: Readonly<{ comboId: string; dateIso: string }>;
  [verifiedSource]: true;
}>;

export type PanelSettingsSnapshot = {
  settings: Record<string, PanelSettingsPartial>;
  datasetToken: string;
  legacySettings: LegacyPanelSettings[];
  verifiedSources: Record<string, VerifiedPanelSettingsSource>;
};

const legacyId = (origin: { comboId: string; dateIso: string }) => JSON.stringify([origin.comboId, origin.dateIso]);

function legacyMatchesStudy(
  row: PanelSettingsRow,
  date: string,
  study: DicomStudy,
  comboId: string,
  singlePatient: boolean,
): boolean {
  if (row.source) return false;
  const scoped = getPatientIdentityAliases(study).some((key) => row.comboId === `${key}::${comboId}`);
  if (!scoped && !(singlePatient && row.comboId === comboId)) return false;
  const timestamp = formatStudyDate(study);
  return (
    date === timestamp ||
    date === `${timestamp}#${study.studyInstanceUid}` ||
    (!study.studyTime && date === timestamp.split('T')[0])
  );
}

/** Read-only compatibility API; source-aware UI uses the snapshot below. */
export async function getPanelSettings(
  comboId: string,
  patientKey?: string | null,
): Promise<Record<string, PanelSettingsPartial>> {
  return (await getPanelSettingsSnapshot(comboId, patientKey)).settings;
}

export async function getPanelSettingsSnapshot(
  comboId: string,
  requestedPatientKey?: string | null,
  sources?: Record<string, SeriesRef>,
): Promise<PanelSettingsSnapshot> {
  const db = await getDB();
  const tx = db.transaction(['panel_settings', 'studies', 'series', 'app_state'], 'readonly');
  try {
    const store = tx.objectStore('panel_settings');
    const [token, selected, studies] = await Promise.all([
      tx.objectStore('app_state').get(DATASET_TOKEN_STATE_KEY),
      tx.objectStore('app_state').get(SELECTED_PATIENT_STATE_KEY),
      tx.objectStore('studies').getAll(),
    ]);
    const patientKey = requestedPatientKey === undefined ? selected?.value : requestedPatientKey;
    const identities = getPatientIdentityKeys(studies);
    const singlePatient = new Set(identities.values()).size <= 1;
    const result: PanelSettingsSnapshot = {
      settings: {},
      datasetToken: token!.value as string,
      legacySettings: [],
      verifiedSources: {},
    };
    if (!sources) {
      let row = await store.get(patientKey ? `${patientKey}::${comboId}` : comboId);
      if (!row && patientKey && singlePatient) row = await store.get(comboId);
      result.settings = row?.settings ?? {};
      await tx.done;
      return result;
    }
    const [rows, series] = await Promise.all([store.getAll(), tx.objectStore('series').getAll()]);
    const bySeries = new Map(series.map((source) => [source.seriesInstanceUid, source]));
    for (const source of Object.values(sources)) {
      if (
        bySeries.get(source.series_uid)?.studyInstanceUid !== source.study_id ||
        identities.get(source.study_id) !== patientKey
      ) {
        throw new Error('The acquisition no longer belongs to the selected patient. Reload the examinations.');
      }
    }
    const canonical = new Map(rows.filter((row) => row.source).map((row) => [row.source!.seriesUid, row]));
    const assignedLegacy = new Set(
      rows.flatMap((row) => (row.source?.legacyOrigin ? [legacyId(row.source.legacyOrigin)] : [])),
    );
    const candidates: { entry: LegacyPanelSettings; studyUids: string[] }[] = [];
    for (const row of rows) {
      if (row.source) continue;
      for (const [dateIso, settings] of Object.entries(row.settings)) {
        const origin = { comboId: row.comboId, dateIso };
        const id = legacyId(origin);
        if (assignedLegacy.has(id)) continue;
        const matching = studies.filter((study) => legacyMatchesStudy(row, dateIso, study, comboId, singlePatient));
        const studyUids = matching.map((study) => study.studyInstanceUid);
        const eligibleDates = Object.entries(sources).flatMap(([date, source]) =>
          studyUids.includes(source.study_id) ? [date] : [],
        );
        if (eligibleDates.length)
          candidates.push({
            entry: { id, origin, settings: settings as PanelSettingsPartial, eligibleDates },
            studyUids,
          });
      }
    }
    for (const { entry, studyUids } of candidates) {
      const date = entry.eligibleDates[0]!;
      const source = sources[date]!;
      const acquisitionCount = series.filter(
        (item) => item.studyInstanceUid === source.study_id && getSeriesSequenceCombo(item).id === comboId,
      ).length;
      const uniqueLegacy = candidates.filter((candidate) => candidate.studyUids.includes(source.study_id)).length === 1;
      if (studyUids.length === 1 && acquisitionCount === 1 && uniqueLegacy && !canonical.has(source.series_uid)) {
        const migrated: PanelSettingsRow = {
          comboId: sourceSettingsKey(source.series_uid),
          source: { studyUid: source.study_id, seriesUid: source.series_uid, legacyOrigin: entry.origin },
          settings: { [source.study_id]: entry.settings as PanelSettings },
        };
        // Project an unambiguous legacy row without mutating a read. The first
        // intentional save materializes it under its verified acquisition key.
        canonical.set(source.series_uid, migrated);
      } else result.legacySettings.push(entry);
    }
    for (const [date, source] of Object.entries(sources)) {
      const row = canonical.get(source.series_uid);
      if (row && row.source?.studyUid !== source.study_id)
        throw new Error('Saved settings contain a conflicting source identity.');
      const settings = row?.settings[source.study_id];
      if (settings) result.settings[date] = settings;
      result.verifiedSources[date] = Object.freeze({
        studyUid: source.study_id,
        seriesUid: source.series_uid,
        datasetToken: result.datasetToken,
        ...(row?.source?.legacyOrigin && { legacyOrigin: Object.freeze({ ...row.source.legacyOrigin }) }),
      }) as VerifiedPanelSettingsSource;
    }
    await tx.done;
    return result;
  } catch (error) {
    try {
      tx.abort();
    } catch {
      /* Already complete or aborted. */
    }
    await tx.done.catch(() => undefined);
    throw error;
  }
}

export async function savePanelSettings(
  source: VerifiedPanelSettingsSource,
  settings: PanelSettings,
  legacyOrigin?: { comboId: string; dateIso: string },
): Promise<void> {
  const db = await getDB();
  // app_state shares the write transaction so replacement cannot interleave
  // between the generation check and the one source-owned row write.
  const tx = db.transaction(['panel_settings', 'app_state'], 'readwrite');
  try {
    const state = tx.objectStore('app_state');
    const token = await state.get(DATASET_TOKEN_STATE_KEY);
    if (token?.value !== source.datasetToken) {
      throw new DatasetReplacedError();
    }
    await tx.objectStore('panel_settings').put({
      comboId: sourceSettingsKey(source.seriesUid),
      source: {
        studyUid: source.studyUid,
        seriesUid: source.seriesUid,
        ...((legacyOrigin ?? source.legacyOrigin) && { legacyOrigin: legacyOrigin ?? source.legacyOrigin }),
      },
      settings: { [source.studyUid]: settings },
    });
    await tx.done;
  } catch (error) {
    try {
      tx.abort();
    } catch {
      /* Already complete or aborted. */
    }
    await tx.done.catch(() => undefined);
    throw error;
  }
}
