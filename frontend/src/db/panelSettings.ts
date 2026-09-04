import { DATASET_TOKEN_STATE_KEY, DatasetReplacedError, getDB, SELECTED_PATIENT_STATE_KEY } from './db';
import { getPatientIdentityAliases, getPatientIdentityKeys } from './patientIdentity';
import { formatStudyDate, getSeriesSequenceCombo, sourceSettingsKey } from './comparisonIdentity';
import type { DicomSeries, DicomStudy, PanelSettingsRow } from './schema';
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
  comboId: string | undefined,
  singlePatient: boolean,
): boolean {
  if (row.source) return false;
  const aliases = getPatientIdentityAliases(study);
  const scoped =
    comboId === undefined
      ? !row.comboId.includes('::') || aliases.some((key) => row.comboId.startsWith(`${key}::`))
      : aliases.some((key) => row.comboId === `${key}::${comboId}`) || (singlePatient && row.comboId === comboId);
  if (!scoped) return false;
  const timestamp = formatStudyDate(study);
  return (
    date === timestamp ||
    date === `${timestamp}#${study.studyInstanceUid}` ||
    (!study.studyTime && date === timestamp.split('T')[0])
  );
}

/** Hydration and subset export share the same legacy ownership decision. */
function legacyCandidates(
  rows: readonly PanelSettingsRow[],
  studies: readonly DicomStudy[],
  series: readonly DicomSeries[],
  comboId: string,
) {
  const singlePatient = new Set(getPatientIdentityKeys(studies).values()).size <= 1;
  const assigned = new Set(
    rows.flatMap((row) => (row.source?.legacyOrigin ? [legacyId(row.source.legacyOrigin)] : [])),
  );
  const candidates = rows.flatMap((row) =>
    row.source
      ? []
      : Object.entries(row.settings).flatMap(([dateIso, settings]) => {
          const origin = { comboId: row.comboId, dateIso };
          const id = legacyId(origin);
          if (assigned.has(id)) return [];
          const studyUids = studies
            .filter((study) => legacyMatchesStudy(row, dateIso, study, comboId, singlePatient))
            .map((study) => study.studyInstanceUid);
          return studyUids.length
            ? [{ entry: { id, origin, settings }, studyUids, assignmentRequired: row.assignmentRequired }]
            : [];
        }),
  );
  return candidates.map(({ entry, studyUids, assignmentRequired }) => {
    const acquisitions = series.filter(
      (source) => studyUids.includes(source.studyInstanceUid) && getSeriesSequenceCombo(source).id === comboId,
    );
    const uniqueLegacy = candidates.filter((candidate) => candidate.studyUids.includes(studyUids[0]!)).length === 1;
    // Malformed ambiguity metadata cannot grant an automatic assignment.
    const requiresAssignment =
      assignmentRequired !== undefined &&
      (!Array.isArray(assignmentRequired) ||
        assignmentRequired.some((date) => typeof date !== 'string') ||
        assignmentRequired.includes(entry.origin.dateIso));
    return {
      entry,
      studyUids,
      automaticSeriesUid:
        !requiresAssignment && studyUids.length === 1 && acquisitions.length === 1 && uniqueLegacy
          ? acquisitions[0]!.seriesInstanceUid
          : undefined,
    };
  });
}

/** Preserve unresolved settings without embedding excluded study or patient identifiers in the backup. */
export function panelSettingsForExport(
  rows: readonly PanelSettingsRow[],
  studies: readonly DicomStudy[],
  series: readonly DicomSeries[],
  selectedStudies: ReadonlySet<string>,
): PanelSettingsRow[] {
  const automatic = new Set(
    [...new Set(series.map((source) => getSeriesSequenceCombo(source).id))].flatMap((comboId) =>
      legacyCandidates(rows, studies, series, comboId).flatMap((candidate) =>
        candidate.automaticSeriesUid ? [candidate.entry.id] : [],
      ),
    ),
  );
  const selectedSeries = new Set(
    series.filter((source) => selectedStudies.has(source.studyInstanceUid)).map((source) => source.seriesInstanceUid),
  );
  const includedStudies = studies.filter((study) => selectedStudies.has(study.studyInstanceUid));
  return rows.flatMap((row) => {
    if (row.source)
      return selectedStudies.has(row.source.studyUid) && selectedSeries.has(row.source.seriesUid) ? [row] : [];
    const settings = Object.fromEntries(
      Object.entries(row.settings).filter(([date]) =>
        includedStudies.some((study) => legacyMatchesStudy(row, date, study, undefined, false)),
      ),
    );
    if (!Object.keys(settings).length) return [];
    const assignmentRequired = Object.keys(settings).filter(
      (dateIso) => !automatic.has(legacyId({ comboId: row.comboId, dateIso })),
    );
    return [{ ...row, settings, assignmentRequired }];
  });
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
    for (const { entry, studyUids, automaticSeriesUid } of legacyCandidates(rows, studies, series, comboId)) {
      const eligibleDates = Object.entries(sources).flatMap(([date, source]) =>
        studyUids.includes(source.study_id) ? [date] : [],
      );
      const date = eligibleDates[0];
      if (!date) continue;
      const source = sources[date]!;
      if (automaticSeriesUid === source.series_uid && !canonical.has(source.series_uid)) {
        const migrated: PanelSettingsRow = {
          comboId: sourceSettingsKey(source.series_uid),
          source: { studyUid: source.study_id, seriesUid: source.series_uid, legacyOrigin: entry.origin },
          settings: { [source.study_id]: entry.settings as PanelSettings },
        };
        // Project an unambiguous legacy row without mutating a read. The first
        // intentional save materializes it under its verified acquisition key.
        canonical.set(source.series_uid, migrated);
      } else result.legacySettings.push({ ...entry, eligibleDates });
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
