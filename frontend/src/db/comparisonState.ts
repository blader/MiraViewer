import type { IDBPDatabase } from 'idb';
import type { DicomSeries, MiraDB } from './schema';
import { SELECTED_PATIENT_STATE_KEY, SELECTED_PATIENT_STUDY_STATE_KEY } from './db';
import { getPatientIdentityKeys } from './patientIdentity';
import { acquisitionChoiceKey, getSeriesSequenceCombo } from './comparisonIdentity';

export async function countSeriesImages(
  series: readonly DicomSeries[],
  count: (uid: string) => Promise<number>,
): Promise<Record<string, number>> {
  const result: Record<string, number> = {};
  for (let offset = 0; offset < series.length; offset += 64) {
    const group = series.slice(offset, offset + 64);
    const counts = await Promise.all(group.map((item) => count(item.seriesInstanceUid)));
    for (let position = 0; position < group.length; position++)
      result[group[position]!.seriesInstanceUid] = counts[position]!;
  }
  return result;
}

/** Idempotent catalog migration, run on database open and after an import, never on a read. */
export async function initializeComparisonState(db: IDBPDatabase<MiraDB>): Promise<void> {
  const tx = db.transaction(['studies', 'series', 'instances', 'app_state'], 'readwrite');
  const state = tx.objectStore('app_state');
  const [studies, series, saved] = await Promise.all([
    tx.objectStore('studies').getAll(),
    tx.objectStore('series').getAll(),
    state.getAll(),
  ]);
  const values = new Map(saved.map((row) => [row.key, row.value]));
  const identities = getPatientIdentityKeys(studies);
  const anchor = values.get(SELECTED_PATIENT_STUDY_STATE_KEY);
  const storedPatient = values.get(SELECTED_PATIENT_STATE_KEY);
  const selected =
    studies.find((study) => study.studyInstanceUid === anchor) ??
    studies.find((study) => identities.get(study.studyInstanceUid) === storedPatient) ??
    [...studies].sort((a, b) =>
      (a.patientName || a.patientId || identities.get(a.studyInstanceUid)!).localeCompare(
        b.patientName || b.patientId || identities.get(b.studyInstanceUid)!,
      ),
    )[0];
  if (selected) {
    const patientKey = identities.get(selected.studyInstanceUid)!;
    if (storedPatient !== patientKey) await state.put({ key: SELECTED_PATIENT_STATE_KEY, value: patientKey });
    if (anchor !== selected.studyInstanceUid)
      await state.put({ key: SELECTED_PATIENT_STUDY_STATE_KEY, value: selected.studyInstanceUid });
  }
  const counts = await countSeriesImages(series, (uid) => tx.objectStore('instances').index('by-series').count(uid));
  const choices = new Map<string, DicomSeries[]>();
  for (const source of series) {
    if (!counts[source.seriesInstanceUid]) continue;
    const key = acquisitionChoiceKey(source.studyInstanceUid, getSeriesSequenceCombo(source).id);
    const group = choices.get(key) ?? [];
    group.push(source);
    choices.set(key, group);
  }
  for (const [key, candidates] of choices) {
    if (candidates.some((source) => source.seriesInstanceUid === values.get(key))) continue;
    candidates.sort(
      (a, b) =>
        counts[b.seriesInstanceUid]! - counts[a.seriesInstanceUid]! ||
        a.seriesInstanceUid.localeCompare(b.seriesInstanceUid),
    );
    await state.put({ key, value: candidates[0]!.seriesInstanceUid });
  }
  await tx.done;
}
