import { DATASET_REVISION_STATE_KEY, getDB, SELECTED_PATIENT_STATE_KEY, subscribeDatasetMutations } from '../db/db';
import { getPatientIdentityKeys } from '../db/patientIdentity';
import type {
  DicomInstance,
  DicomSeries,
  DicomStudy,
  DerivedAlignmentFrameRow,
  TumorSegmentationRow,
  TumorGroundTruthRow,
  TumorThreshold,
  TumorPolygon,
  NormalizedPoint,
  ViewerTransform,
  ViewportSize,
  VolumeSegmentationRow,
} from '../db/schema';
import type { ComparisonData, SequenceCombo, SeriesRef, PanelSettingsPartial, PanelSettings } from '../types/api';
import { parseSeriesDescription } from './dicomSeriesParsing';
import { MAX_OUTPUT_GRID_PIXELS, validateOutputGridReference, validateOutputPlaneGrid } from './outputPlaneGrid';
import { getSliceGeometryFromInstance } from './svr/dicomGeometry';
import { dot } from './svr/vec3';

export type PatientSummary = NonNullable<ComparisonData['patients']>[number];
export type ExaminationSummary = NonNullable<ComparisonData['examinations']>[string];

export type PatientScopedComparisonData = ComparisonData & {
  patients: PatientSummary[];
  selected_patient_key: string | null;
  dataset_revision: number;
  examinations: Record<string, ExaminationSummary>;
};

export async function getSelectedPatientKey(): Promise<string | null> {
  const db = await getDB();
  const selected = await db.get('app_state', SELECTED_PATIENT_STATE_KEY);
  return typeof selected?.value === 'string' ? selected.value : null;
}

export async function setSelectedPatientKey(patientKey: string): Promise<void> {
  const db = await getDB();
  await db.put('app_state', { key: SELECTED_PATIENT_STATE_KEY, value: patientKey });
}

export async function getDatasetRevision(): Promise<number> {
  const db = await getDB();
  const row = await db.get('app_state', DATASET_REVISION_STATE_KEY);
  return typeof row?.value === 'number' ? row.value : 0;
}

function formatStudyDate(study: DicomStudy): string {
  const date = study.studyDate;
  if (date.length !== 8) return date || `unknown#${study.studyInstanceUid}`;
  const hhmmss = (study.studyTime ?? '').replace(/\D/g, '').slice(0, 6).padEnd(6, '0');
  return `${date.slice(0, 4)}-${date.slice(4, 6)}-${date.slice(6, 8)}T${hhmmss.slice(0, 2) || '00'}:${hhmmss.slice(2, 4) || '00'}:${hhmmss.slice(4, 6) || '00'}`;
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

function buildSeriesClassificationText(series: {
  seriesDescription: string;
  protocolName?: string;
  sequenceName?: string;
}): string {
  // Many datasets put the most informative string in ProtocolName or SequenceName.
  // Joining these aggressively reduces "Unknown" buckets without forcing defaults.
  return [series.seriesDescription, series.protocolName, series.sequenceName].filter(Boolean).join(' | ');
}

// Helper to generate a stable ID for the combo
function slugifyCombo(plane?: string, weight?: string, sequence?: string): string {
  const parts = [plane, weight, sequence].filter(Boolean);
  const slug = parts.join('-').toLowerCase().replace(/\s+/g, '-');
  return slug || 'unknown';
}

function labelCombo(plane?: string, weight?: string, sequence?: string): string {
  return [plane, weight, sequence].filter(Boolean).join(' ') || 'Unknown';
}

export async function getImageCounts(series: readonly DicomSeries[]): Promise<Record<string, number>> {
  const instanceCounts: Record<string, number> = {};
  if (series.length === 0) return instanceCounts;

  const db = await getDB();
  const transaction = db.transaction('instances', 'readonly');
  const index = transaction.store.index('by-series');
  const maxPendingCounts = 64;

  for (let offset = 0; offset < series.length; offset += maxPendingCounts) {
    const group = series.slice(offset, offset + maxPendingCounts);
    const counts = await Promise.all(group.map((item) => index.count(item.seriesInstanceUid)));
    for (let position = 0; position < group.length; position++) {
      instanceCounts[group[position]!.seriesInstanceUid] = counts[position]!;
    }
  }

  await transaction.done;
  return instanceCounts;
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
        const parsed = parseSeriesDescription(buildSeriesClassificationText(s));
        return [
          {
            series_uid: s.seriesInstanceUid,
            series_description: s.seriesDescription,
            series_number: s.seriesNumber,
            modality: s.modality,
            plane: s.plane || parsed.plane,
            weight: s.weight || parsed.weight,
            sequence_type: s.sequenceType || parsed.sequenceType,
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
  const [allSeries, allStudies, storedPatientKey] = await Promise.all([
    db.getAll('series'),
    db.getAll('studies'),
    getSelectedPatientKey(),
  ]);
  const patientIdentityKeys = getPatientIdentityKeys(allStudies);

  const patientMap = new Map<string, PatientSummary>();
  for (const study of allStudies) {
    const key = patientIdentityKeys.get(study.studyInstanceUid)!;
    const existing = patientMap.get(key);
    if (existing) existing.study_count += 1;
    else
      patientMap.set(key, {
        key,
        patient_id: study.patientId,
        patient_name: study.patientName,
        study_count: 1,
      });
  }
  const patients = Array.from(patientMap.values()).sort((a, b) =>
    (a.patient_name || a.patient_id || a.key).localeCompare(b.patient_name || b.patient_id || b.key),
  );
  const candidatePatientKey = requestedPatientKey ?? storedPatientKey;
  const selectedPatientKey =
    candidatePatientKey && patientMap.has(candidatePatientKey) ? candidatePatientKey : (patients[0]?.key ?? null);
  if (selectedPatientKey && selectedPatientKey !== storedPatientKey) {
    await setSelectedPatientKey(selectedPatientKey);
  }

  const selectedStudies = allStudies.filter(
    (study) => patientIdentityKeys.get(study.studyInstanceUid) === selectedPatientKey,
  );
  const studyByUid = new Map(selectedStudies.map((study) => [study.studyInstanceUid, study]));
  const studyDateCounts = new Map<string, number>();
  for (const study of selectedStudies) {
    const date = formatStudyDate(study);
    studyDateCounts.set(date, (studyDateCounts.get(date) ?? 0) + 1);
  }
  const examinationByStudy = new Map<string, string>();
  const examinations: Record<string, ExaminationSummary> = {};
  for (const study of selectedStudies) {
    let examinationKey = formatStudyDate(study);
    if ((studyDateCounts.get(examinationKey) ?? 0) > 1) {
      examinationKey += `#${study.studyInstanceUid}`;
    }
    examinationByStudy.set(study.studyInstanceUid, examinationKey);
    examinations[examinationKey] = {
      study_uid: study.studyInstanceUid,
      date_iso: formatStudyDate(study),
      acquisition_time: study.studyTime,
      patient_key: selectedPatientKey!,
    };
  }
  const selectedSeries = allSeries.filter((series) => studyByUid.has(series.studyInstanceUid));

  // Instance counts without loading instance Blob payloads.
  const instanceCounts = await getImageCounts(selectedSeries);

  const planes = new Set<string>();
  const dates = new Set<string>();
  const sequences: Record<string, SequenceCombo> = {};
  const seriesMap: Record<string, Record<string, SeriesRef>> = {};

  for (const s of selectedSeries) {
    const instanceCount = instanceCounts[s.seriesInstanceUid] || 0;
    if (instanceCount === 0) continue;

    const parsed = parseSeriesDescription(buildSeriesClassificationText(s));
    const plane = s.plane || parsed.plane || null;
    const weight = s.weight || parsed.weight || null;
    const sequenceType = s.sequenceType || parsed.sequenceType || null;

    if (plane) planes.add(plane);

    const dateIso = examinationByStudy.get(s.studyInstanceUid);
    if (!dateIso) continue;
    dates.add(dateIso);

    const comboId = slugifyCombo(plane ?? undefined, weight ?? undefined, sequenceType ?? undefined);

    if (!sequences[comboId]) {
      sequences[comboId] = {
        id: comboId,
        plane,
        weight,
        sequence: sequenceType,
        label: labelCombo(plane ?? undefined, weight ?? undefined, sequenceType ?? undefined),
        date_count: 0,
      };
      seriesMap[comboId] = {};
    }

    const prev = seriesMap[comboId][dateIso];

    if (!prev) sequences[comboId].date_count++;

    // If multiple series map to the same (plane, weight, sequenceType) combo for a given date,
    // prefer the one with the most instances.
    //
    // Why:
    // - In real-world DICOM exports it's common to have "extra" image series (e.g. screenshots,
    //   localizers, reformats) that would otherwise get picked arbitrarily based on ingestion order.
    // - Auto-alignment relies on having a full through-plane stack; choosing a tiny series can make
    //   alignment look "broken" even though the real series exists.
    if (!prev || instanceCount > prev.instance_count) {
      seriesMap[comboId][dateIso] = {
        study_id: s.studyInstanceUid,
        study_uid: s.studyInstanceUid,
        series_uid: s.seriesInstanceUid,
        instance_count: instanceCount,
        patient_key: selectedPatientKey ?? undefined,
        frame_of_reference_uid: s.frameOfReferenceUid,
        acquisition_time: s.acquisitionTime,
        rows: s.rows,
        columns: s.columns,
        pixel_spacing: parsePixelSpacing(s.pixelSpacing),
      };
    }
  }

  return {
    planes: Array.from(planes).sort(),
    dates: Array.from(dates).sort(),
    sequences: Object.values(sequences).sort((a, b) => (a.plane || '').localeCompare(b.plane || '')),
    series_map: seriesMap,
    patients,
    selected_patient_key: selectedPatientKey,
    dataset_revision: await getDatasetRevision(),
    examinations,
  };
}

export async function getPanelSettings(
  comboId: string,
  requestedPatientKey?: string | null,
): Promise<Record<string, PanelSettingsPartial>> {
  const db = await getDB();
  const patientKey = requestedPatientKey === undefined ? await getSelectedPatientKey() : requestedPatientKey;
  const scopedComboId = patientKey ? `${patientKey}::${comboId}` : comboId;
  let row = await db.get('panel_settings', scopedComboId);
  if (!row && patientKey) {
    const studies = await db.getAll('studies');
    const distinctPatients = new Set(getPatientIdentityKeys(studies).values());
    if (distinctPatients.size <= 1) row = await db.get('panel_settings', comboId);
  }
  if (!row) return {};

  // Convert stored settings to a partial shape (callers treat missing fields as defaults).
  const result: Record<string, PanelSettingsPartial> = {};
  for (const [date, settings] of Object.entries(row.settings)) {
    // idb's inferred types for Object.entries can degrade to `unknown` under strict settings.
    // The stored value is a subset of PanelSettings (numbers), which is safe to treat as partial.
    result[date] = settings as PanelSettingsPartial;
  }
  return result;
}

export async function savePanelSettings(
  comboId: string,
  dateIso: string,
  settings: PanelSettings,
  requestedPatientKey?: string | null,
): Promise<void> {
  const db = await getDB();
  const patientKey = requestedPatientKey === undefined ? await getSelectedPatientKey() : requestedPatientKey;
  const scopedComboId = patientKey ? `${patientKey}::${comboId}` : comboId;
  const tx = db.transaction('panel_settings', 'readwrite');
  const store = tx.objectStore('panel_settings');

  let row = await store.get(scopedComboId);
  if (!row) {
    row = { comboId: scopedComboId, settings: {} };
  }

  row.settings[dateIso] = {
    ...row.settings[dateIso],
    ...settings,
  };

  await store.put(row);
  await tx.done;
}

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
  frames: Array<Omit<DicomInstance, 'fileBlob'>>;
};

export async function getSeriesFrameManifest(seriesUid: string): Promise<SeriesFrameManifest> {
  const db = await getDB();
  const transaction = db.transaction(['series', 'studies', 'instances'], 'readonly');
  const [series, studies] = await Promise.all([
    transaction.objectStore('series').get(seriesUid),
    transaction.objectStore('studies').getAll(),
  ]);
  if (!series) throw new Error('Series not found');
  const study = studies.find((candidate) => candidate.studyInstanceUid === series.studyInstanceUid);
  if (!study) throw new Error('Series study not found');

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
    const { fileBlob: _fileBlob, ...metadata } = cursor.value;
    void _fileBlob;
    frames.push(metadata);
    orderedUids.push(metadata.sopInstanceUid);
    cursor = await cursor.continue();
  }
  await transaction.done;
  if (frames.length === 0) throw new Error('No instances for series');
  cacheSeriesInstanceOrder(seriesUid, orderedUids);
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
          (series.frameOfReferenceUid &&
            frame.frameOfReferenceUid &&
            series.frameOfReferenceUid !== frame.frameOfReferenceUid)
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
    patientKey: getPatientIdentityKeys(studies).get(study.studyInstanceUid)!,
    frameOfReferenceUid: series.frameOfReferenceUid,
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

export async function saveVolumeSegmentation(record: VolumeSegmentationRow): Promise<void> {
  const expectedVoxels = record.dims[0] * record.dims[1] * record.dims[2];
  if (record.labels.length !== expectedVoxels) {
    throw new Error(`Volume segmentation does not match its geometry (${record.labels.length}/${expectedVoxels})`);
  }
  const selectedPatient = await getSelectedPatientKey();
  if (record.patientKey && selectedPatient && record.patientKey !== selectedPatient) {
    throw new Error('Cannot save a volume segmentation for another patient');
  }
  const db = await getDB();
  await db.put('volume_segmentations', record);
}

export async function getVolumeSegmentation(volumeKey: string): Promise<VolumeSegmentationRow | null> {
  const db = await getDB();
  const record = await db.get('volume_segmentations', volumeKey);
  if (!record) return null;
  const selectedPatient = await getSelectedPatientKey();
  if (record.patientKey && selectedPatient && record.patientKey !== selectedPatient) return null;
  const expectedVoxels = record.dims[0] * record.dims[1] * record.dims[2];
  return record.labels.length === expectedVoxels ? record : null;
}

export async function deleteVolumeSegmentation(volumeKey: string): Promise<void> {
  const db = await getDB();
  await db.delete('volume_segmentations', volumeKey);
}

export const MAX_DERIVED_ALIGNMENT_FRAMES = 12;

export function matchesReferenceGeometry(frame: Partial<DerivedAlignmentFrameRow>, reference?: DicomInstance): boolean {
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

async function validateDerivedFrameIdentity(frame: DerivedAlignmentFrameRow): Promise<DerivedAlignmentFrameRow> {
  assertValidDerivedAlignmentFrameShape(frame);
  const db = await getDB();
  const studies = await db.getAll('studies');
  const patientIdentityKeys = getPatientIdentityKeys(studies);
  const targetStudy = studies.find((study) => study.studyInstanceUid === frame.targetStudyUid);
  if (!targetStudy || patientIdentityKeys.get(targetStudy.studyInstanceUid) !== frame.patientKey) {
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
    const referenceStudy = studies.find((study) => study.studyInstanceUid === referenceSeries.studyInstanceUid);
    if (!referenceStudy || patientIdentityKeys.get(referenceStudy.studyInstanceUid) !== frame.patientKey) {
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
  const normalized = await validateDerivedFrameIdentity(frame);
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
  const entries = await store.index('by-created-at').getAll();
  await Promise.all(
    entries.slice(0, Math.max(0, entries.length - MAX_DERIVED_ALIGNMENT_FRAMES)).map((stale) => store.delete(stale.id)),
  );
  await tx.done;
}

export async function loadDerivedAlignmentFrames(
  patientKey: string,
  datasetRevision?: number,
): Promise<DerivedAlignmentFrameRow[]> {
  const [db, currentRevision, selectedPatient] = await Promise.all([
    getDB(),
    getDatasetRevision(),
    getSelectedPatientKey(),
  ]);
  if (datasetRevision !== undefined && datasetRevision !== currentRevision) return [];
  if (selectedPatient && selectedPatient !== patientKey) return [];
  const candidates = await db.getAllFromIndex('derived_alignment_frames', 'by-patient', patientKey);
  const frames: DerivedAlignmentFrameRow[] = [];
  for (const candidate of candidates) {
    if (candidate.datasetRevision !== currentRevision) continue;
    try {
      frames.push(await validateDerivedFrameIdentity(candidate));
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
  const deletions: Promise<void>[] = [];
  for (const frame of await store.index('by-patient').getAll(patientKey)) {
    if (targetSeriesUid && frame.targetSeriesUid !== targetSeriesUid) continue;
    deletions.push(store.delete(frame.id));
  }
  await Promise.all(deletions);
  await tx.done;
}
