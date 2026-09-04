import {
  DATASET_REVISION_STATE_KEY,
  DATASET_TOKEN_STATE_KEY,
  getDB,
  SELECTED_PATIENT_STATE_KEY,
  SELECTED_PATIENT_STUDY_STATE_KEY,
  subscribeDatasetMutations,
} from '../db/db';
import { getPatientIdentityKeys } from '../db/patientIdentity';
import type {
  DicomInstance,
  DicomSeries,
  DerivedAlignmentFrameRow,
  TumorSegmentationRow,
  TumorGroundTruthRow,
  TumorThreshold,
  TumorPolygon,
  NormalizedPoint,
  ViewerTransform,
  ViewportSize,
} from '../db/schema';
import type { ComparisonData, SequenceCombo, SeriesRef } from '../types/api';
import { acquisitionChoiceKey, formatStudyDate, getSeriesSequenceCombo } from '../db/comparisonIdentity';
import { countSeriesImages } from '../db/comparisonState';
import { hydrateDicomMetadata, type MetadataHydrationOptions } from '../db/instanceMetadata';
import { DICOM_METADATA_VERSION } from '../services/dicomMetadata';
import { MAX_OUTPUT_GRID_PIXELS, validateOutputGridReference, validateOutputPlaneGrid } from './outputPlaneGrid';
import { getSliceGeometryFromInstance } from './svr/dicomGeometry';
import { dot } from './svr/vec3';
export {
  deleteVolumeSegmentation,
  getVolumeSegmentation,
  getVolumeSegmentationSnapshot,
  saveVolumeSegmentation,
} from '../db/volumeSegmentations';

export type PatientSummary = NonNullable<ComparisonData['patients']>[number];
export type ExaminationSummary = NonNullable<ComparisonData['examinations']>[string];

export type PatientScopedComparisonData = ComparisonData & {
  patients: PatientSummary[];
  selected_patient_key: string | null;
  dataset_revision: number;
  dataset_token: string;
  examinations: Record<string, ExaminationSummary>;
};

export async function getSelectedPatientKey(): Promise<string | null> {
  const db = await getDB();
  const selected = await db.get('app_state', SELECTED_PATIENT_STATE_KEY);
  return typeof selected?.value === 'string' ? selected.value : null;
}

export async function setSelectedPatientKey(patientKey: string): Promise<void> {
  const db = await getDB();
  const tx = db.transaction(['studies', 'app_state'], 'readwrite');
  const studies = await tx.objectStore('studies').getAll();
  const identities = getPatientIdentityKeys(studies);
  const study = studies.find((candidate) => identities.get(candidate.studyInstanceUid) === patientKey);
  await tx.objectStore('app_state').put({ key: SELECTED_PATIENT_STATE_KEY, value: patientKey });
  if (study)
    await tx.objectStore('app_state').put({ key: SELECTED_PATIENT_STUDY_STATE_KEY, value: study.studyInstanceUid });
  else await tx.objectStore('app_state').delete(SELECTED_PATIENT_STUDY_STATE_KEY);
  await tx.done;
}

export async function getDatasetRevision(): Promise<number> {
  const db = await getDB();
  const row = await db.get('app_state', DATASET_REVISION_STATE_KEY);
  return typeof row?.value === 'number' ? row.value : 0;
}

function parsePixelSpacing(raw?: string): [number, number] | undefined {
  if (!raw) return undefined;
  const values = raw
    .split(/[\\,\s]+/)
    .filter(Boolean)
    .map(Number);
  const [row, column] = values;
  return Number.isFinite(row) && Number.isFinite(column) && row > 0 && column > 0 ? [row, column] : undefined;
}

export async function getImageCounts(series: readonly DicomSeries[]): Promise<Record<string, number>> {
  if (!series.length) return {};
  const db = await getDB();
  const tx = db.transaction('instances');
  const counts = await countSeriesImages(series, (uid) => tx.store.index('by-series').count(uid));
  await tx.done;
  return counts;
}

export async function getStudies() {
  const db = await getDB();
  const [selectedPatientKey, allStudies, availableSeries] = await Promise.all([
    getSelectedPatientKey(),
    db.getAll('studies'),
    db.getAll('series'),
  ]);
  const patientIdentityKeys = getPatientIdentityKeys(allStudies);
  const studies = allStudies.filter(
    (study) => !selectedPatientKey || patientIdentityKeys.get(study.studyInstanceUid) === selectedPatientKey,
  );
  const selectedStudyUids = new Set(studies.map((study) => study.studyInstanceUid));
  const allSeries = availableSeries.filter((series) => selectedStudyUids.has(series.studyInstanceUid));

  // Aggregate counts without loading instance Blob payloads.
  const seriesByStudy: Record<string, DicomSeries[]> = {};
  allSeries.forEach((s) => {
    if (!seriesByStudy[s.studyInstanceUid]) seriesByStudy[s.studyInstanceUid] = [];
    seriesByStudy[s.studyInstanceUid].push(s);
  });

  const instanceCountsBySeries = await getImageCounts(allSeries);

  return studies
    .map((study) => {
      const series = seriesByStudy[study.studyInstanceUid] || [];
      const seriesList = series.flatMap((s) => {
        const instanceCount = instanceCountsBySeries[s.seriesInstanceUid] || 0;
        if (instanceCount === 0) return [];
        const parsed = getSeriesSequenceCombo(s);
        return [
          {
            series_uid: s.seriesInstanceUid,
            series_description: s.seriesDescription,
            series_number: s.seriesNumber,
            modality: s.modality,
            plane: s.plane || parsed.plane,
            weight: s.weight || parsed.weight,
            sequence_type: parsed.sequence,
            instance_count: instanceCount,
          },
        ];
      });

      const totalInstances = seriesList.reduce((acc, s) => acc + s.instance_count, 0);

      return {
        study_id: study.studyInstanceUid, // Use UID as ID
        study_instance_uid: study.studyInstanceUid,
        folder_name: study.studyDescription, // approximate mapping
        study_date: study.studyDate,
        scan_type: study.studyDescription || study.modality,
        series: seriesList.sort((a, b) => a.series_number - b.series_number),
        series_count: seriesList.length,
        total_instances: totalInstances,
      };
    })
    .sort((a, b) => b.study_date.localeCompare(a.study_date));
}

export async function getComparisonData(requestedPatientKey?: string | null): Promise<PatientScopedComparisonData> {
  const db = await getDB();
  // Catalog, chosen acquisitions and its ownership token come from one snapshot.
  // Only metadata and index counts are read; this never materializes MRI blobs.
  const tx = db.transaction(['studies', 'series', 'instances', 'app_state'], 'readonly');
  const state = tx.objectStore('app_state');
  const [allSeries, allStudies, savedState] = await Promise.all([
    tx.objectStore('series').getAll(),
    tx.objectStore('studies').getAll(),
    state.getAll(),
  ]);
  const values = new Map(savedState.map((row) => [row.key, row.value]));
  const identities = getPatientIdentityKeys(allStudies);
  const patientMap = new Map<string, PatientSummary>();
  for (const study of allStudies) {
    const key = identities.get(study.studyInstanceUid)!;
    const existing = patientMap.get(key);
    if (existing) existing.study_count++;
    else patientMap.set(key, { key, patient_id: study.patientId, patient_name: study.patientName, study_count: 1 });
  }
  const patients = [...patientMap.values()].sort((a, b) =>
    (a.patient_name || a.patient_id || a.key).localeCompare(b.patient_name || b.patient_id || b.key),
  );
  const storedPatient = values.get(SELECTED_PATIENT_STATE_KEY);
  const anchor = values.get(SELECTED_PATIENT_STUDY_STATE_KEY);
  const candidate =
    requestedPatientKey ?? (typeof anchor === 'string' ? identities.get(anchor) : undefined) ?? storedPatient;
  const selectedPatientKey =
    typeof candidate === 'string' && patientMap.has(candidate) ? candidate : (patients[0]?.key ?? null);
  const selectedStudies = allStudies.filter((study) => identities.get(study.studyInstanceUid) === selectedPatientKey);
  const studyByUid = new Map(selectedStudies.map((study) => [study.studyInstanceUid, study]));
  const dateCounts = new Map<string, number>();
  for (const study of selectedStudies) {
    const date = formatStudyDate(study);
    dateCounts.set(date, (dateCounts.get(date) ?? 0) + 1);
  }
  const examinationByStudy = new Map<string, string>();
  const examinations: Record<string, ExaminationSummary> = {};
  for (const study of selectedStudies) {
    const date = formatStudyDate(study);
    const key = (dateCounts.get(date) ?? 0) > 1 ? `${date}#${study.studyInstanceUid}` : date;
    examinationByStudy.set(study.studyInstanceUid, key);
    examinations[key] = {
      study_uid: study.studyInstanceUid,
      date_iso: date,
      acquisition_time: study.studyTime,
      patient_key: selectedPatientKey!,
    };
  }
  const selectedSeries = allSeries.filter((series) => studyByUid.has(series.studyInstanceUid));
  const counts = await countSeriesImages(selectedSeries, (uid) =>
    tx.objectStore('instances').index('by-series').count(uid),
  );
  const sequences: Record<string, SequenceCombo> = {};
  const seriesMap: Record<string, Record<string, SeriesRef>> = {};
  const candidates: Record<string, Record<string, SeriesRef[]>> = {};
  const planes = new Set<string>();
  const dates = new Set<string>();
  for (const series of selectedSeries) {
    const instanceCount = counts[series.seriesInstanceUid] ?? 0;
    if (!instanceCount) continue;
    const combo = getSeriesSequenceCombo(series);
    const date = examinationByStudy.get(series.studyInstanceUid)!;
    if (combo.plane) planes.add(combo.plane);
    dates.add(date);
    sequences[combo.id] ??= combo;
    candidates[combo.id] ??= {};
    (candidates[combo.id][date] ??= []).push({
      study_id: series.studyInstanceUid,
      study_uid: series.studyInstanceUid,
      series_uid: series.seriesInstanceUid,
      instance_count: instanceCount,
      series_description: series.seriesDescription,
      series_number: series.seriesNumber,
      patient_key: selectedPatientKey ?? undefined,
      frame_of_reference_uid: series.frameOfReferenceUid,
      acquisition_time: series.acquisitionTime,
      rows: series.rows,
      columns: series.columns,
      pixel_spacing: parsePixelSpacing(series.pixelSpacing),
    });
  }
  for (const [comboId, byDate] of Object.entries(candidates)) {
    seriesMap[comboId] = {};
    for (const [date, choices] of Object.entries(byDate)) {
      choices.sort((a, b) => b.instance_count - a.instance_count || a.series_uid.localeCompare(b.series_uid));
      const key = acquisitionChoiceKey(choices[0]!.study_id, comboId);
      const chosen = choices.find((ref) => ref.series_uid === values.get(key)) ?? choices[0]!;
      seriesMap[comboId][date] = chosen;
      sequences[comboId]!.date_count++;
    }
  }
  await tx.done;
  return {
    planes: [...planes].sort(),
    dates: [...dates].sort(),
    sequences: Object.values(sequences).sort((a, b) => (a.plane || '').localeCompare(b.plane || '')),
    series_map: seriesMap,
    series_candidates: candidates,
    patients,
    selected_patient_key: selectedPatientKey,
    dataset_revision:
      typeof values.get(DATASET_REVISION_STATE_KEY) === 'number'
        ? (values.get(DATASET_REVISION_STATE_KEY) as number)
        : 0,
    dataset_token: values.get(DATASET_TOKEN_STATE_KEY) as string,
    examinations,
  };
}

export async function selectAcquisition(studyUid: string, comboId: string, seriesUid: string): Promise<void> {
  const db = await getDB();
  const tx = db.transaction(['studies', 'series', 'instances', 'app_state'], 'readwrite');
  const [series, studies, selected] = await Promise.all([
    tx.objectStore('series').get(seriesUid),
    tx.objectStore('studies').getAll(),
    tx.objectStore('app_state').get(SELECTED_PATIENT_STATE_KEY),
  ]);
  const owner = getPatientIdentityKeys(studies).get(studyUid);
  if (
    !series ||
    series.studyInstanceUid !== studyUid ||
    getSeriesSequenceCombo(series).id !== comboId ||
    !owner ||
    owner !== selected?.value ||
    !(await tx.objectStore('instances').index('by-series').count(seriesUid))
  ) {
    await tx.done;
    throw new Error('This acquisition is no longer available for the selected patient. Reload the examinations.');
  }
  await tx.objectStore('app_state').put({ key: acquisitionChoiceKey(studyUid, comboId), value: seriesUid });
  await tx.done;
}

export { getPanelSettings, getPanelSettingsSnapshot, savePanelSettings } from '../db/panelSettings';
export type { PanelSettingsSnapshot, LegacyPanelSettings } from '../db/panelSettings';

/**
 * Resolve the Cornerstone imageId for a given series + instance index.
 * Returns an ID like `miradb:<sopInstanceUid>`.
 */
type SeriesInstanceOrderCacheEntry = {
  // Sorted by physical slice position when every frame supplies valid geometry.
  uids: string[];
};

const SERIES_INSTANCE_ORDER_CACHE_MAX = 64;
const seriesInstanceOrderCache = new Map<string, SeriesInstanceOrderCacheEntry>();

subscribeDatasetMutations((seriesUid) => {
  if (seriesUid) seriesInstanceOrderCache.delete(seriesUid);
  else seriesInstanceOrderCache.clear();
});

function cacheSeriesInstanceOrder(seriesUid: string, uids: string[]) {
  // Refresh LRU ordering.
  if (seriesInstanceOrderCache.has(seriesUid)) {
    seriesInstanceOrderCache.delete(seriesUid);
  }
  seriesInstanceOrderCache.set(seriesUid, { uids });

  // Simple LRU eviction.
  while (seriesInstanceOrderCache.size > SERIES_INSTANCE_ORDER_CACHE_MAX) {
    const oldest = seriesInstanceOrderCache.keys().next().value as string | undefined;
    if (!oldest) break;
    seriesInstanceOrderCache.delete(oldest);
  }
}

export async function getSortedSopInstanceUidsForSeries(seriesUid: string): Promise<string[]> {
  const cached = seriesInstanceOrderCache.get(seriesUid);
  if (cached) {
    cacheSeriesInstanceOrder(seriesUid, cached.uids);
    return cached.uids;
  }

  const db = await getDB();

  const range = IDBKeyRange.bound(
    [seriesUid, -Number.MAX_SAFE_INTEGER, ''],
    [seriesUid, Number.MAX_SAFE_INTEGER, '\uffff'],
  );
  const transaction = db.transaction('instances', 'readonly');
  const store = transaction.store;
  const [totalFrames, physicalKeys] = await Promise.all([
    store.index('by-series').count(seriesUid),
    store.index('by-series-physicalPosition-uid').getAllKeys(range),
  ]);
  const keys =
    physicalKeys.length === totalFrames && totalFrames > 0
      ? physicalKeys
      : await store.index('by-series-instanceNumber-uid').getAllKeys(range);
  await transaction.done;
  const uids = keys.map((k) => String(k));

  if (uids.length === 0) {
    throw new Error('No instances for series');
  }

  cacheSeriesInstanceOrder(seriesUid, uids);
  return uids;
}

export async function getSopInstanceUidForInstanceIndex(seriesUid: string, instanceIndex: number): Promise<string> {
  const uids = await getSortedSopInstanceUidsForSeries(seriesUid);
  const uid = uids[instanceIndex];
  if (!uid) throw new Error('Instance index out of range');
  return uid;
}

export async function getImageIdForInstance(seriesUid: string, instanceIndex: number): Promise<string> {
  const uid = await getSopInstanceUidForInstanceIndex(seriesUid, instanceIndex);
  return `miradb:${uid}`;
}

export type SeriesFrameManifest = {
  seriesUid: string;
  studyUid: string;
  patientKey: string;
  frameOfReferenceUid?: string;
  ordering: 'physical' | 'instance-number';
  geometryReliable: boolean;
  sliceSpacingMm?: number;
  coverageMm?: number;
  frames: Array<Omit<DicomInstance, 'fileBlob'> & { dicomByteLength?: number }>;
};

export async function getSeriesFrameManifest(
  seriesUid: string,
  options: MetadataHydrationOptions = {},
): Promise<SeriesFrameManifest> {
  if (options.signal?.aborted) throw new DOMException('DICOM metadata loading canceled.', 'AbortError');
  const db = await getDB();
  const transaction = db.transaction(['series', 'studies', 'instances', 'app_state'], 'readonly');
  const [series, studies, revision, token, selected] = await Promise.all([
    transaction.objectStore('series').get(seriesUid),
    transaction.objectStore('studies').getAll(),
    transaction.objectStore('app_state').get(DATASET_REVISION_STATE_KEY),
    transaction.objectStore('app_state').get(DATASET_TOKEN_STATE_KEY),
    transaction.objectStore('app_state').get(SELECTED_PATIENT_STATE_KEY),
  ]);
  if (!series) throw new Error('Series not found');
  const study = studies.find((candidate) => candidate.studyInstanceUid === series.studyInstanceUid);
  if (!study) throw new Error('Series study not found');
  const patientKey = getPatientIdentityKeys(studies).get(study.studyInstanceUid)!;
  const datasetRevision = typeof revision?.value === 'number' ? revision.value : 0;
  const datasetToken = typeof token?.value === 'string' ? token.value : undefined;
  const selectedPatientKey = typeof selected?.value === 'string' ? selected.value : null;
  if (
    (options.datasetRevision !== undefined && options.datasetRevision !== datasetRevision) ||
    (options.datasetToken !== undefined && options.datasetToken !== datasetToken) ||
    (options.selectedPatientKey !== undefined &&
      (options.selectedPatientKey !== selectedPatientKey ||
        (selectedPatientKey !== null && selectedPatientKey !== patientKey)))
  )
    throw new Error(
      'The currently selected patient or MRI dataset changed while loading metadata. Refresh the examination.',
    );

  const range = IDBKeyRange.bound(
    [seriesUid, -Number.MAX_SAFE_INTEGER, ''],
    [seriesUid, Number.MAX_SAFE_INTEGER, '\uffff'],
  );
  const instanceStore = transaction.objectStore('instances');
  const physicalIndex = instanceStore.index('by-series-physicalPosition-uid');
  const [totalFrames, physicallyOrderedFrames] = await Promise.all([
    instanceStore.index('by-series').count(seriesUid),
    physicalIndex.count(range),
  ]);
  const orderedIndex =
    physicallyOrderedFrames === totalFrames && totalFrames > 0
      ? physicalIndex
      : instanceStore.index('by-series-instanceNumber-uid');
  const frames: SeriesFrameManifest['frames'] = [];
  const orderedUids: string[] = [];
  let cursor = await orderedIndex.openCursor(range);
  while (cursor) {
    const { fileBlob, ...metadata } = cursor.value;
    if (metadata.seriesInstanceUid !== seriesUid || metadata.studyInstanceUid !== study.studyInstanceUid)
      throw new Error('A stored frame does not belong to its admitted series and examination.');
    // Size metadata only: no Blob decoding, extra read or persisted schema field.
    frames.push({ ...metadata, dicomByteLength: fileBlob?.size });
    orderedUids.push(metadata.sopInstanceUid);
    cursor = await cursor.continue();
  }
  await transaction.done;
  if (options.signal?.aborted) throw new DOMException('DICOM metadata loading canceled.', 'AbortError');
  if (frames.length === 0) throw new Error('No instances for series');
  if (frames.some((frame) => frame.metadataVersion !== DICOM_METADATA_VERSION)) {
    const scope = { ...options, datasetRevision, datasetToken, selectedPatientKey };
    await hydrateDicomMetadata(
      {
        seriesUid,
        studyUid: study.studyInstanceUid,
        patientKey,
        frames,
      },
      scope,
    );
    // A completed batch is durable. Re-read the final manifest and ordering in
    // one snapshot, rejecting replacement/import during header I/O.
    return getSeriesFrameManifest(seriesUid, scope);
  }
  cacheSeriesInstanceOrder(seriesUid, orderedUids);
  const sourceFrameUid =
    series.frameOfReferenceUid || frames.find((frame) => frame.frameOfReferenceUid)?.frameOfReferenceUid;
  let sortedPositions: number[] = [];
  let geometryReliable = frames.every(
    (frame) => typeof frame.physicalSlicePosition === 'number' && Number.isFinite(frame.physicalSlicePosition),
  );
  if (geometryReliable && frames.length > 0) {
    try {
      const first = getSliceGeometryFromInstance(frames[0]!);
      for (const frame of frames) {
        const geometry = getSliceGeometryFromInstance(frame);
        if (
          geometry.rows !== first.rows ||
          geometry.cols !== first.cols ||
          Math.abs(geometry.rowSpacingMm - first.rowSpacingMm) > 1e-6 ||
          Math.abs(geometry.colSpacingMm - first.colSpacingMm) > 1e-6 ||
          dot(geometry.rowDir, first.rowDir) < 0.999 ||
          dot(geometry.colDir, first.colDir) < 0.999 ||
          dot(geometry.normalDir, first.normalDir) < 0.999 ||
          (sourceFrameUid && frame.frameOfReferenceUid && sourceFrameUid !== frame.frameOfReferenceUid)
        ) {
          geometryReliable = false;
          break;
        }
        const position = dot(geometry.ippMm, first.normalDir);
        if (!Number.isFinite(position) || (sortedPositions.length > 0 && position <= sortedPositions.at(-1)! + 1e-6)) {
          geometryReliable = false;
          break;
        }
        sortedPositions.push(position);
      }
    } catch {
      geometryReliable = false;
    }
  }
  if (!geometryReliable) sortedPositions = [];
  const spacings = sortedPositions.slice(1).map((position, index) => position - sortedPositions[index]!);
  spacings.sort((a, b) => a - b);
  const sliceSpacingMm = spacings.length ? spacings[Math.floor(spacings.length / 2)] : undefined;
  const coverageMm =
    sortedPositions.length > 1 ? sortedPositions[sortedPositions.length - 1]! - sortedPositions[0]! : undefined;

  return {
    seriesUid,
    studyUid: study.studyInstanceUid,
    patientKey,
    frameOfReferenceUid:
      series.frameOfReferenceUid ||
      (frames.every((frame) => frame.frameOfReferenceUid === sourceFrameUid) ? sourceFrameUid : undefined),
    ordering: geometryReliable ? 'physical' : 'instance-number',
    geometryReliable,
    sliceSpacingMm,
    coverageMm,
    frames,
  };
}

function tumorSegmentationId(seriesUid: string, sopInstanceUid: string): string {
  // Keep this stable and URL-safe. Series UID can contain dots.
  return `${seriesUid}::${sopInstanceUid}`;
}

export async function getTumorSegmentationForInstance(
  seriesUid: string,
  sopInstanceUid: string,
): Promise<TumorSegmentationRow | null> {
  const db = await getDB();
  const id = tumorSegmentationId(seriesUid, sopInstanceUid);
  const row = await db.get('tumor_segmentations', id);
  return row ?? null;
}

export async function getTumorSegmentationsForSeries(seriesUid: string): Promise<TumorSegmentationRow[]> {
  const db = await getDB();
  return db.getAllFromIndex('tumor_segmentations', 'by-series', seriesUid);
}

export type SaveTumorSegmentationInput = {
  comboId: string;
  dateIso: string;
  studyId: string;
  seriesUid: string;
  sopInstanceUid: string;
  polygon: TumorPolygon;
  threshold: TumorThreshold;
  seed?: NormalizedPoint;
  meta?: TumorSegmentationRow['meta'];
  algorithmVersion?: string;
};

export async function saveTumorSegmentation(input: SaveTumorSegmentationInput): Promise<void> {
  const db = await getDB();
  const now = Date.now();

  const id = tumorSegmentationId(input.seriesUid, input.sopInstanceUid);
  const existing = await db.get('tumor_segmentations', id);

  const row: TumorSegmentationRow = {
    id,
    comboId: input.comboId,
    dateIso: input.dateIso,
    studyId: input.studyId,
    seriesUid: input.seriesUid,
    sopInstanceUid: input.sopInstanceUid,
    algorithmVersion: input.algorithmVersion ?? 'v1-display-domain-threshold',
    polygon: input.polygon,
    threshold: input.threshold,
    seed: input.seed,
    createdAtMs: existing?.createdAtMs ?? now,
    updatedAtMs: now,
    meta: input.meta,
  };

  await db.put('tumor_segmentations', row);
}

export async function deleteTumorSegmentation(seriesUid: string, sopInstanceUid: string): Promise<void> {
  const db = await getDB();
  await db.delete('tumor_segmentations', tumorSegmentationId(seriesUid, sopInstanceUid));
}

function tumorGroundTruthId(seriesUid: string, sopInstanceUid: string): string {
  return `${seriesUid}::${sopInstanceUid}`;
}

export async function getTumorGroundTruthForInstance(
  seriesUid: string,
  sopInstanceUid: string,
): Promise<TumorGroundTruthRow | null> {
  const db = await getDB();
  const id = tumorGroundTruthId(seriesUid, sopInstanceUid);
  const row = await db.get('tumor_ground_truth', id);
  return row ?? null;
}

export async function getAllTumorGroundTruth(): Promise<TumorGroundTruthRow[]> {
  const db = await getDB();
  return db.getAll('tumor_ground_truth');
}

export type SaveTumorGroundTruthInput = {
  comboId: string;
  dateIso: string;
  studyId: string;
  seriesUid: string;
  sopInstanceUid: string;
  polygon: TumorPolygon;
  coordinateSpace?: 'image-normalized' | 'viewer-normalized';
  imageSize?: { w: number; h: number };
  viewTransform?: ViewerTransform;
  viewportSize?: ViewportSize;
};

export async function saveTumorGroundTruth(input: SaveTumorGroundTruthInput): Promise<void> {
  const db = await getDB();
  const now = Date.now();

  const id = tumorGroundTruthId(input.seriesUid, input.sopInstanceUid);
  const existing = await db.get('tumor_ground_truth', id);

  const row: TumorGroundTruthRow = {
    id,
    comboId: input.comboId,
    dateIso: input.dateIso,
    studyId: input.studyId,
    seriesUid: input.seriesUid,
    sopInstanceUid: input.sopInstanceUid,
    polygon: input.polygon,
    coordinateSpace: input.coordinateSpace,
    imageSize: input.imageSize,
    viewTransform: input.viewTransform,
    viewportSize: input.viewportSize,
    createdAtMs: existing?.createdAtMs ?? now,
    updatedAtMs: now,
  };

  await db.put('tumor_ground_truth', row);
}

export async function deleteTumorGroundTruth(seriesUid: string, sopInstanceUid: string): Promise<void> {
  const db = await getDB();
  await db.delete('tumor_ground_truth', tumorGroundTruthId(seriesUid, sopInstanceUid));
}

/** At most 160 MiB: 32 maximum-size 1024² float-and-support registered planes. */
export const MAX_DERIVED_ALIGNMENT_FRAMES = 32;

export function matchesReferenceGeometry(
  frame: Partial<DerivedAlignmentFrameRow>,
  reference?: Omit<DicomInstance, 'fileBlob'>,
): boolean {
  return !(
    (frame.referenceImagePositionPatient && frame.referenceImagePositionPatient !== reference?.imagePositionPatient) ||
    (frame.referenceImageOrientationPatient &&
      frame.referenceImageOrientationPatient !== reference?.imageOrientationPatient) ||
    (frame.referencePixelSpacing && frame.referencePixelSpacing !== reference?.pixelSpacing) ||
    (frame.referenceRows !== undefined && frame.referenceRows !== reference?.rows) ||
    (frame.referenceColumns !== undefined && frame.referenceColumns !== reference?.columns)
  );
}

export function assertValidDerivedAlignmentFrameShape(frame: DerivedAlignmentFrameRow): void {
  if (!frame.id || !frame.patientKey || !frame.sequenceId || !frame.targetStudyUid || !frame.targetSeriesUid) {
    throw new Error('A derived alignment frame is missing its required patient or examination identity');
  }
  if (!Number.isSafeInteger(frame.datasetRevision) || frame.datasetRevision < 0) {
    throw new Error('A derived alignment frame has an invalid dataset revision');
  }
  if (!Number.isSafeInteger(frame.targetFrameIndex) || frame.targetFrameIndex < 0) {
    throw new Error('A derived alignment frame has an invalid target frame index');
  }
  if (
    frame.referenceFrameIndex !== undefined &&
    (!Number.isSafeInteger(frame.referenceFrameIndex) || frame.referenceFrameIndex < 0)
  ) {
    throw new Error('A derived alignment frame has an invalid reference frame index');
  }
  const pixels = frame.rows * frame.columns;
  if (
    !Number.isSafeInteger(frame.rows) ||
    !Number.isSafeInteger(frame.columns) ||
    pixels <= 0 ||
    pixels > MAX_OUTPUT_GRID_PIXELS
  ) {
    throw new Error('A derived alignment frame exceeds the safe 1024 × 1024 geometry limit');
  }
  if (
    !ArrayBuffer.isView(frame.pixels) ||
    Object.prototype.toString.call(frame.pixels) !== '[object Float32Array]' ||
    frame.pixels.BYTES_PER_ELEMENT !== Float32Array.BYTES_PER_ELEMENT ||
    frame.pixels.length !== pixels
  ) {
    throw new Error('A derived alignment frame does not match its source image dimensions');
  }
  if (
    frame.valid &&
    (!ArrayBuffer.isView(frame.valid) ||
      Object.prototype.toString.call(frame.valid) !== '[object Uint8Array]' ||
      frame.valid.length !== pixels)
  ) {
    throw new Error('A derived alignment frame has an invalid anatomical-support map');
  }
  for (let index = 0; index < pixels; index++) {
    const pixel = frame.pixels[index]!;
    if (!Number.isFinite(pixel)) throw new Error('A derived alignment frame contains invalid image samples');
    if (!frame.valid) continue;
    const supported = frame.valid[index]!;
    if (supported !== 0 && supported !== 1) {
      throw new Error('A derived alignment frame has an invalid anatomical-support map');
    }
    if (!supported && pixel !== 0) {
      throw new Error('A derived alignment frame contains unsupported image samples');
    }
  }
  if (frame.outputGrid) {
    validateOutputPlaneGrid(frame.outputGrid);
    if (frame.outputGrid.rows !== frame.rows || frame.outputGrid.columns !== frame.columns) {
      throw new Error('A derived alignment frame does not match its physical output grid');
    }
    if (!frame.valid || !frame.contributingSourceSopInstanceUids?.length) {
      throw new Error('A physical output grid requires its anatomical-support map and contributing source images');
    }
  }
  if (
    frame.contributingSourceSopInstanceUids &&
    (!Array.isArray(frame.contributingSourceSopInstanceUids) ||
      frame.contributingSourceSopInstanceUids.length === 0 ||
      frame.contributingSourceSopInstanceUids.length > 96 ||
      frame.contributingSourceSopInstanceUids.some((uid) => typeof uid !== 'string' || uid.length === 0) ||
      new Set(frame.contributingSourceSopInstanceUids).size !== frame.contributingSourceSopInstanceUids.length)
  ) {
    throw new Error('A derived alignment frame has invalid contributing source-image provenance');
  }
  for (const [values, length, label] of [
    [frame.transform, 6, 'rigid transform'],
    [frame.centerMm, 3, 'rigid-rotation center'],
  ] as const) {
    if (
      values &&
      (!Array.isArray(values) || values.length !== length || values.some((value) => !Number.isFinite(value)))
    ) {
      throw new Error(`A derived alignment frame has an invalid ${label}`);
    }
  }
  for (const quality of [frame.coverage, frame.score, frame.margin]) {
    if (quality !== undefined && !Number.isFinite(quality)) {
      throw new Error('A derived alignment frame has invalid quality evidence');
    }
  }
  if (
    frame.nativeSliceSpacingMm !== undefined &&
    (!Number.isFinite(frame.nativeSliceSpacingMm) || frame.nativeSliceSpacingMm <= 0)
  ) {
    throw new Error('A derived alignment frame has invalid native-slice spacing');
  }
  if (
    frame.sourceFrameCount !== undefined &&
    (!Number.isSafeInteger(frame.sourceFrameCount) || frame.sourceFrameCount <= 0)
  ) {
    throw new Error('A derived alignment frame has an invalid source-frame count');
  }
  if (!Number.isFinite(frame.createdAt)) {
    throw new Error('A derived alignment frame has an invalid creation timestamp');
  }
}

async function validateDerivedFrame(frame: DerivedAlignmentFrameRow, keys?: ReadonlyMap<string, string>) {
  assertValidDerivedAlignmentFrameShape(frame);
  const db = await getDB();
  keys ??= getPatientIdentityKeys(await db.getAll('studies'));
  if (keys.get(frame.targetStudyUid) !== frame.patientKey) {
    throw new Error('A derived alignment frame belongs to a missing or different patient');
  }
  const targetSeries = await db.get('series', frame.targetSeriesUid);
  if (!targetSeries || targetSeries.studyInstanceUid !== frame.targetStudyUid) {
    throw new Error('A derived alignment frame belongs to a missing or different target examination');
  }
  const orderedUids = await getSortedSopInstanceUidsForSeries(frame.targetSeriesUid);
  const targetSop = orderedUids[frame.targetFrameIndex];
  if (!targetSop || (frame.targetSopInstanceUid && frame.targetSopInstanceUid !== targetSop)) {
    throw new Error('A derived alignment frame no longer matches its physical target slice');
  }
  if (frame.sourceImageId !== `miradb:${targetSop}`) {
    throw new Error('A derived alignment frame does not match its source image');
  }
  if (frame.contributingSourceSopInstanceUids?.length) {
    const targetSourceUids = new Set(orderedUids);
    if (frame.contributingSourceSopInstanceUids.some((uid) => !targetSourceUids.has(uid))) {
      throw new Error('A derived alignment frame includes a contributing image from another examination');
    }
  }
  const targetFrame = frame.targetFrameOfReferenceUid ?? frame.sourceFrameOfReferenceUid;
  if (targetFrame && targetSeries.frameOfReferenceUid && targetFrame !== targetSeries.frameOfReferenceUid) {
    throw new Error('A derived alignment frame has an incompatible target spatial frame');
  }

  let referenceFrame = frame.referenceFrameOfReferenceUid ?? frame.frameOfReferenceUid;
  if (frame.outputGrid && (!frame.referenceSeriesUid || !frame.referenceSopInstanceUid)) {
    throw new Error('A physical output grid requires its verified native reference image');
  }
  if (frame.referenceSeriesUid) {
    const referenceSeries = await db.get('series', frame.referenceSeriesUid);
    if (!referenceSeries || (frame.referenceStudyUid && referenceSeries.studyInstanceUid !== frame.referenceStudyUid)) {
      throw new Error('A derived alignment frame has an incompatible reference examination');
    }
    if (keys.get(referenceSeries.studyInstanceUid) !== frame.patientKey) {
      throw new Error('A derived alignment frame reference belongs to a different patient');
    }
    if (
      referenceFrame &&
      referenceSeries.frameOfReferenceUid &&
      referenceFrame !== referenceSeries.frameOfReferenceUid
    ) {
      throw new Error('A derived alignment frame has an incompatible reference spatial frame');
    }
    referenceFrame ??= referenceSeries.frameOfReferenceUid;
    if (frame.referenceSopInstanceUid) {
      const reference = await db.get('instances', frame.referenceSopInstanceUid);
      if (!reference || reference.seriesInstanceUid !== frame.referenceSeriesUid) {
        throw new Error('A derived alignment frame does not match its reference image');
      }
      if (!matchesReferenceGeometry(frame, reference)) {
        throw new Error('A derived alignment frame does not match its reference image geometry');
      }
      if (frame.outputGrid) {
        validateOutputGridReference(frame.outputGrid, reference, referenceSeries.frameOfReferenceUid);
      }
      if (frame.referenceFrameIndex !== undefined) {
        const orderedReferences = await getSortedSopInstanceUidsForSeries(frame.referenceSeriesUid);
        if (orderedReferences[frame.referenceFrameIndex] !== frame.referenceSopInstanceUid) {
          throw new Error('A derived alignment frame no longer matches its physical reference slice');
        }
      }
    }
  }

  return {
    ...frame,
    targetSopInstanceUid: targetSop,
    targetFrameOfReferenceUid: targetFrame ?? targetSeries.frameOfReferenceUid,
    referenceFrameOfReferenceUid: referenceFrame,
  };
}

export async function saveDerivedAlignmentFrame(frame: DerivedAlignmentFrameRow): Promise<void> {
  const normalized = await validateDerivedFrame(frame);
  const selectedPatient = await getSelectedPatientKey();
  if (selectedPatient && selectedPatient !== normalized.patientKey) {
    throw new Error('Cannot save a derived alignment frame for another patient');
  }
  const db = await getDB();
  const tx = db.transaction(['derived_alignment_frames', 'app_state'], 'readwrite');
  const revision = await tx.objectStore('app_state').get(DATASET_REVISION_STATE_KEY);
  if ((typeof revision?.value === 'number' ? revision.value : 0) !== normalized.datasetRevision) {
    await tx.done;
    throw new Error('Cannot save a derived alignment frame for a stale dataset revision');
  }
  const store = tx.objectStore('derived_alignment_frames');
  await store.put(normalized);
  const keys = await store.index('by-created-at').getAllKeys();
  await Promise.all(
    keys.slice(0, Math.max(0, keys.length - MAX_DERIVED_ALIGNMENT_FRAMES)).map((key) => store.delete(key)),
  );
  await tx.done;
}

export async function loadDerivedAlignmentFrames(
  patientKey: string,
  datasetRevision?: number,
  source?: { sequenceId: string; seriesUids: ReadonlySet<string> },
): Promise<DerivedAlignmentFrameRow[]> {
  const [db, currentRevision, selectedPatient] = await Promise.all([
    getDB(),
    getDatasetRevision(),
    getSelectedPatientKey(),
  ]);
  if (datasetRevision !== undefined && datasetRevision !== currentRevision) return [];
  if (selectedPatient && selectedPatient !== patientKey) return [];
  // Select provenance before materializing pixels. Array keys sort after scalar
  // keys, so this upper bound covers every sequence/series at this revision.
  const candidates = source
    ? (
        await Promise.all(
          [...source.seriesUids].map((seriesUid) =>
            db.getAllFromIndex('derived_alignment_frames', 'by-patient-revision-source', [
              patientKey,
              currentRevision,
              source.sequenceId,
              seriesUid,
            ]),
          ),
        )
      ).flat()
    : await db.getAllFromIndex(
        'derived_alignment_frames',
        'by-patient-revision-source',
        IDBKeyRange.bound([patientKey, currentRevision], [patientKey, currentRevision, []]),
      );
  let patientIdentityKeys: ReadonlyMap<string, string> | undefined;
  const frames: DerivedAlignmentFrameRow[] = [];
  for (const candidate of candidates) {
    if (candidate.datasetRevision !== currentRevision) continue;
    try {
      patientIdentityKeys ??= getPatientIdentityKeys(await db.getAll('studies'));
      frames.push(await validateDerivedFrame(candidate, patientIdentityKeys));
    } catch {
      // Stale, incompatible, or orphaned presentation must never become visible anatomy.
    }
  }
  return frames.sort((a, b) => a.createdAt - b.createdAt).slice(-MAX_DERIVED_ALIGNMENT_FRAMES);
}

export async function clearPersistedDerivedAlignmentFrames(
  patientKey?: string,
  targetSeriesUid?: string,
): Promise<void> {
  const db = await getDB();
  if (!patientKey) {
    if (targetSeriesUid) {
      throw new Error('Cannot clear a registered examination without its verified patient identity');
    }
    await db.clear('derived_alignment_frames');
    return;
  }
  const tx = db.transaction('derived_alignment_frames', 'readwrite');
  const store = tx.objectStore('derived_alignment_frames');
  if (targetSeriesUid) {
    let cursor = await store
      .index('by-patient-revision-source')
      .openKeyCursor(IDBKeyRange.bound([patientKey], [patientKey, []]));
    while (cursor) {
      if (Array.isArray(cursor.key) && cursor.key[3] === targetSeriesUid) await store.delete(cursor.primaryKey);
      cursor = await cursor.continue();
    }
  } else {
    const keys = await store.index('by-patient').getAllKeys(patientKey);
    await Promise.all(keys.map((key) => store.delete(key)));
  }
  await tx.done;
}
