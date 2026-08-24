import JSZip from 'jszip';
import { DATASET_REVISION_STATE_KEY, getDB, notifyDatasetMutation, SELECTED_PATIENT_STATE_KEY } from '../db/db';
import { getPatientIdentityKey } from '../db/patientIdentity';
import type {
  AppStateRow,
  DerivedAlignmentFrameRow,
  DicomInstance,
  DicomSeries,
  DicomStudy,
  PanelSettingsRow,
  TumorGroundTruthRow,
  TumorSegmentationRow,
  VolumeSegmentationRow,
} from '../db/schema';
import { OWNED_EXACT_STORAGE_KEYS, OWNED_STORAGE_KEY_PREFIX } from '../utils/storageKeys';
import { getAllModelRecords, putModelBlob } from '../utils/segmentation/onnx/modelCache';
import { assertValidDerivedAlignmentFrameShape } from '../utils/localApi';
import type { ProcessFilesResult } from './dicomIngestion';
import { readArchiveEntry } from './archiveSafety';

export type ExportProgress = {
  stage: 'collecting' | 'zipping' | 'finalizing';
  current: number;
  total: number;
  detail?: string;
};

type SnapshotFile = {
  path: string;
  byteLength: number;
  sha256?: string;
};

type SnapshotInstance = Omit<DicomInstance, 'fileBlob'> & { file: SnapshotFile };
type SnapshotVolume = Omit<VolumeSegmentationRow, 'labels'> & { file: SnapshotFile };
type SnapshotDerivedFrame = Omit<DerivedAlignmentFrameRow, 'pixels'> & { file: SnapshotFile };
type SnapshotModel = { key: string; savedAtMs: number; file: SnapshotFile };

type SnapshotManifest = {
  format: 'miraviewer-complete-snapshot';
  version: 2;
  exportedAt: string;
  studyIds: string[];
  records: {
    studies: DicomStudy[];
    series: DicomSeries[];
    instances: SnapshotInstance[];
    panelSettings: PanelSettingsRow[];
    tumorSegmentations: TumorSegmentationRow[];
    tumorGroundTruth: TumorGroundTruthRow[];
    volumeSegmentations: SnapshotVolume[];
    /** Optional for backward compatibility with complete v2 snapshots created before durable derived frames. */
    derivedAlignmentFrames?: SnapshotDerivedFrame[];
    appState: AppStateRow[];
    models: SnapshotModel[];
    localStorage: Record<string, string>;
  };
};

async function toArrayBuffer(value: Blob | ArrayBuffer | ArrayBufferView): Promise<ArrayBuffer> {
  if (value instanceof ArrayBuffer) return value;
  if (ArrayBuffer.isView(value)) {
    const copy = new Uint8Array(value.byteLength);
    copy.set(new Uint8Array(value.buffer, value.byteOffset, value.byteLength));
    return copy.buffer;
  }
  if (typeof value.arrayBuffer === 'function') return value.arrayBuffer();
  return new Blob([value as BlobPart]).arrayBuffer();
}

async function describeFile(path: string, bytes: ArrayBuffer): Promise<SnapshotFile> {
  const file: SnapshotFile = { path, byteLength: bytes.byteLength };
  if (globalThis.crypto?.subtle) {
    const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes);
    file.sha256 = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
  }
  return file;
}

function captureOwnedLocalStorage(): Record<string, string> {
  const records: Record<string, string> = {};
  if (typeof localStorage === 'undefined') return records;
  const exactKeys = new Set<string>(OWNED_EXACT_STORAGE_KEYS);
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i);
    if (!key || (!key.startsWith(OWNED_STORAGE_KEY_PREFIX) && !exactKeys.has(key))) continue;
    const value = localStorage.getItem(key);
    if (value !== null) records[key] = value;
  }
  return records;
}

export async function exportStudiesToZip(
  studyIds: string[],
  onProgress?: (progress: ExportProgress) => void,
): Promise<Blob> {
  const db = await getDB();
  const zip = new JSZip();
  const addSnapshotFile = async (
    path: string,
    value: Blob | ArrayBufferView,
    uncompressed = false,
  ): Promise<SnapshotFile> => {
    const bytes = await toArrayBuffer(value);
    zip.file(path, bytes, uncompressed ? { compression: 'STORE' } : undefined);
    return describeFile(path, bytes);
  };
  const selectedStudies = new Set(studyIds);
  const allStudies = await db.getAll('studies');
  const studies = allStudies.filter((study) => selectedStudies.has(study.studyInstanceUid));
  if (studies.length !== selectedStudies.size) throw new Error('One or more selected examinations no longer exist.');

  const patientKeys = new Set(studies.map((study) => getPatientIdentityKey(study, allStudies)));
  if (patientKeys.size > 1) throw new Error('A backup cannot combine examinations from different patients.');
  const selectedPatientKey = patientKeys.values().next().value as string | undefined;
  const series = (await db.getAll('series')).filter((item) => selectedStudies.has(item.studyInstanceUid));
  const selectedSeries = new Set(series.map((item) => item.seriesInstanceUid));

  const instances: SnapshotInstance[] = [];
  const totalInstances = (
    await Promise.all(series.map((item) => db.countFromIndex('instances', 'by-series', item.seriesInstanceUid)))
  ).reduce((count, next) => count + next, 0);
  let collected = 0;

  for (const item of series) {
    const rows = await db.getAllFromIndex('instances', 'by-series', item.seriesInstanceUid);
    for (const row of rows) {
      const { fileBlob, ...metadata } = row;
      const path = `studies/${encodeURIComponent(row.studyInstanceUid)}/series/${encodeURIComponent(row.seriesInstanceUid)}/${encodeURIComponent(row.sopInstanceUid)}.dcm`;
      const file = await addSnapshotFile(path, fileBlob);
      instances.push({ ...metadata, file });
      collected += 1;
      onProgress?.({ stage: 'collecting', current: collected, total: Math.max(totalInstances, 1) });
    }
  }

  const panelSettings = (await db.getAll('panel_settings')).filter(
    (row) => !selectedPatientKey || row.comboId.startsWith(`${selectedPatientKey}::`) || !row.comboId.includes('::'),
  );
  const tumorSegmentations = (await db.getAll('tumor_segmentations')).filter((row) => selectedStudies.has(row.studyId));
  const tumorGroundTruth = (await db.getAll('tumor_ground_truth')).filter((row) => selectedStudies.has(row.studyId));

  const volumeSegmentations: SnapshotVolume[] = [];
  for (const row of await db.getAll('volume_segmentations')) {
    if (row.studyUid && !selectedStudies.has(row.studyUid)) continue;
    if (row.patientKey && selectedPatientKey && row.patientKey !== selectedPatientKey) continue;
    if (row.seriesUids?.length && !row.seriesUids.some((uid: string) => selectedSeries.has(uid))) continue;
    const { labels, ...metadata } = row;
    const path = `segmentations/${encodeURIComponent(row.volumeKey)}.labels`;
    // Sparse label masks can legitimately exceed archive expansion-ratio guards.
    const file = await addSnapshotFile(path, labels, true);
    volumeSegmentations.push({ ...metadata, file });
  }

  const derivedAlignmentFrames: SnapshotDerivedFrame[] = [];
  for (const row of await db.getAll('derived_alignment_frames')) {
    if (!selectedStudies.has(row.targetStudyUid)) continue;
    if (selectedPatientKey && row.patientKey !== selectedPatientKey) continue;
    if (row.referenceStudyUid && !selectedStudies.has(row.referenceStudyUid)) continue;
    if (row.referenceSeriesUid && !selectedSeries.has(row.referenceSeriesUid)) continue;
    const { pixels, ...metadata } = row;
    const path = `derived-frames/${encodeURIComponent(row.id)}.f32`;
    const file = await addSnapshotFile(path, pixels, true);
    derivedAlignmentFrames.push({ ...metadata, file });
  }

  const models: SnapshotModel[] = [];
  for (const model of await getAllModelRecords()) {
    const path = `models/${encodeURIComponent(model.key)}.onnx`;
    const file = await addSnapshotFile(path, model.blob);
    models.push({ key: model.key, savedAtMs: model.savedAtMs, file });
  }

  const manifest: SnapshotManifest = {
    format: 'miraviewer-complete-snapshot',
    version: 2,
    exportedAt: new Date().toISOString(),
    studyIds: studies.map((study) => study.studyInstanceUid),
    records: {
      studies,
      series,
      instances,
      panelSettings,
      tumorSegmentations,
      tumorGroundTruth,
      volumeSegmentations,
      derivedAlignmentFrames,
      appState: await db.getAll('app_state'),
      models,
      localStorage: captureOwnedLocalStorage(),
    },
  };
  zip.file('export.json', JSON.stringify(manifest));

  onProgress?.({ stage: 'zipping', current: 0, total: 100 });
  const blob = await zip.generateAsync(
    { type: 'blob', compression: 'DEFLATE', compressionOptions: { level: 6 } },
    (metadata) => onProgress?.({ stage: 'zipping', current: Math.round(metadata.percent), total: 100 }),
  );
  onProgress?.({ stage: 'finalizing', current: 1, total: 1 });
  return blob;
}

export async function readSnapshotManifest(zip: JSZip): Promise<SnapshotManifest | null> {
  const entry = zip.file('export.json');
  if (!entry) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(await entry.async('string'));
  } catch {
    throw new Error('The backup manifest is invalid.');
  }
  if (!parsed || typeof parsed !== 'object') return null;
  const manifest = parsed as Partial<SnapshotManifest>;
  if (manifest.format !== 'miraviewer-complete-snapshot') return null;
  if (manifest.version !== 2 || !manifest.records) throw new Error('This backup uses an unsupported snapshot format.');
  const required = [
    'studies',
    'series',
    'instances',
    'panelSettings',
    'tumorSegmentations',
    'tumorGroundTruth',
    'volumeSegmentations',
    'appState',
    'models',
  ] as const;
  for (const key of required) {
    if (!Array.isArray(manifest.records[key])) throw new Error(`The backup manifest is missing ${key}.`);
  }
  if (
    manifest.records.derivedAlignmentFrames !== undefined &&
    !Array.isArray(manifest.records.derivedAlignmentFrames)
  ) {
    throw new Error('The backup manifest contains invalid derived alignment frames.');
  }
  return manifest as SnapshotManifest;
}

async function readVerifiedFile(zip: JSZip, descriptor: SnapshotFile): Promise<Blob> {
  const entry = zip.file(descriptor.path);
  if (!entry) throw new Error('The backup is incomplete: a referenced file is missing.');
  const blob = await readArchiveEntry(entry);
  if (blob.size !== descriptor.byteLength) throw new Error('A backup file has an invalid size.');
  if (descriptor.sha256 && globalThis.crypto?.subtle) {
    const actual = await describeFile(descriptor.path, await toArrayBuffer(blob));
    if (actual.sha256 !== descriptor.sha256) throw new Error('A backup file failed its integrity check.');
  }
  return blob;
}

export async function restoreSnapshot(
  zip: JSZip,
  manifest: SnapshotManifest,
  onProgress?: (current: number, total: number) => void,
): Promise<ProcessFilesResult> {
  const studyUids = new Set(manifest.records.studies.map((study) => study.studyInstanceUid));
  if (studyUids.size !== manifest.records.studies.length) {
    throw new Error('The backup contains duplicate examination identifiers.');
  }
  const patientKeys = new Set(
    manifest.records.studies.map((study) => getPatientIdentityKey(study, manifest.records.studies)),
  );
  if (patientKeys.size > 1) throw new Error('This backup contains multiple patients and cannot be safely restored.');
  const selectedPatientKey = patientKeys.values().next().value as string | undefined;
  for (const series of manifest.records.series) {
    if (!studyUids.has(series.studyInstanceUid)) throw new Error('The backup contains an orphaned series.');
  }
  const seriesByUid = new Map(manifest.records.series.map((series) => [series.seriesInstanceUid, series]));
  if (seriesByUid.size !== manifest.records.series.length) {
    throw new Error('The backup contains duplicate series identifiers.');
  }

  const instancesByUid = new Map<string, DicomInstance>();
  let current = 0;
  for (const metadata of manifest.records.instances) {
    const parentSeries = seriesByUid.get(metadata.seriesInstanceUid);
    if (!studyUids.has(metadata.studyInstanceUid) || parentSeries?.studyInstanceUid !== metadata.studyInstanceUid) {
      throw new Error('The backup contains an orphaned image.');
    }
    if (instancesByUid.has(metadata.sopInstanceUid))
      throw new Error('The backup contains duplicate image identifiers.');
    const { file, ...instance } = metadata;
    instancesByUid.set(metadata.sopInstanceUid, { ...instance, fileBlob: await readVerifiedFile(zip, file) });
    onProgress?.(++current, manifest.records.instances.length);
  }
  const instances = Array.from(instancesByUid.values());
  const orderedInstancesForSeries = (seriesUid: string): DicomInstance[] => {
    const matching = instances.filter((instance) => instance.seriesInstanceUid === seriesUid);
    const hasPhysicalOrdering = matching.every(
      (instance) =>
        typeof instance.physicalSlicePosition === 'number' && Number.isFinite(instance.physicalSlicePosition),
    );
    return matching.sort((first, second) => {
      const firstPosition = hasPhysicalOrdering ? first.physicalSlicePosition! : first.instanceNumber;
      const secondPosition = hasPhysicalOrdering ? second.physicalSlicePosition! : second.instanceNumber;
      if (firstPosition !== secondPosition) return firstPosition - secondPosition;
      if (first.sopInstanceUid === second.sopInstanceUid) return 0;
      return first.sopInstanceUid < second.sopInstanceUid ? -1 : 1;
    });
  };

  for (const annotation of [...manifest.records.tumorSegmentations, ...manifest.records.tumorGroundTruth]) {
    const parentSeries = seriesByUid.get(annotation.seriesUid);
    if (
      parentSeries?.studyInstanceUid !== annotation.studyId ||
      instancesByUid.get(annotation.sopInstanceUid)?.seriesInstanceUid !== annotation.seriesUid
    ) {
      throw new Error('The backup contains an annotation without a matching examination and image.');
    }
  }

  const volumes: VolumeSegmentationRow[] = [];
  for (const metadata of manifest.records.volumeSegmentations) {
    const { file, ...volume } = metadata;
    const bytes = new Uint8Array(await toArrayBuffer(await readVerifiedFile(zip, file)));
    if (bytes.length !== volume.dims[0] * volume.dims[1] * volume.dims[2]) {
      throw new Error('A saved volume segmentation does not match its reconstruction geometry.');
    }
    volumes.push({ ...volume, labels: bytes });
  }

  const derivedFrames: DerivedAlignmentFrameRow[] = [];
  const derivedFrameIds = new Set<string>();
  for (const metadata of manifest.records.derivedAlignmentFrames ?? []) {
    const { file, ...frame } = metadata;
    const target = seriesByUid.get(frame.targetSeriesUid);
    const targetInstance = frame.targetSopInstanceUid ? instancesByUid.get(frame.targetSopInstanceUid) : undefined;
    const reference = frame.referenceSeriesUid ? seriesByUid.get(frame.referenceSeriesUid) : undefined;
    const referenceInstance = frame.referenceSopInstanceUid
      ? instancesByUid.get(frame.referenceSopInstanceUid)
      : undefined;
    if (
      frame.patientKey !== selectedPatientKey ||
      derivedFrameIds.has(frame.id) ||
      !studyUids.has(frame.targetStudyUid) ||
      target?.studyInstanceUid !== frame.targetStudyUid ||
      !targetInstance ||
      targetInstance.seriesInstanceUid !== frame.targetSeriesUid ||
      targetInstance.studyInstanceUid !== frame.targetStudyUid ||
      orderedInstancesForSeries(frame.targetSeriesUid)[frame.targetFrameIndex]?.sopInstanceUid !==
        frame.targetSopInstanceUid ||
      frame.sourceImageId !== `miradb:${frame.targetSopInstanceUid}` ||
      (frame.referenceStudyUid && !studyUids.has(frame.referenceStudyUid)) ||
      (frame.referenceSeriesUid && !reference) ||
      (frame.referenceStudyUid && reference?.studyInstanceUid !== frame.referenceStudyUid) ||
      (frame.referenceSopInstanceUid && referenceInstance?.seriesInstanceUid !== frame.referenceSeriesUid) ||
      (frame.referenceFrameIndex !== undefined &&
        (!frame.referenceSeriesUid ||
          orderedInstancesForSeries(frame.referenceSeriesUid)[frame.referenceFrameIndex]?.sopInstanceUid !==
            frame.referenceSopInstanceUid)) ||
      (frame.referenceImagePositionPatient &&
        frame.referenceImagePositionPatient !== referenceInstance?.imagePositionPatient) ||
      (frame.referenceImageOrientationPatient &&
        frame.referenceImageOrientationPatient !== referenceInstance?.imageOrientationPatient) ||
      (frame.referencePixelSpacing && frame.referencePixelSpacing !== referenceInstance?.pixelSpacing) ||
      (frame.referenceRows !== undefined && frame.referenceRows !== referenceInstance?.rows) ||
      (frame.referenceColumns !== undefined && frame.referenceColumns !== referenceInstance?.columns) ||
      (frame.targetFrameOfReferenceUid &&
        target.frameOfReferenceUid &&
        frame.targetFrameOfReferenceUid !== target.frameOfReferenceUid) ||
      (frame.referenceFrameOfReferenceUid &&
        reference?.frameOfReferenceUid &&
        frame.referenceFrameOfReferenceUid !== reference.frameOfReferenceUid)
    ) {
      throw new Error('The backup contains a derived alignment frame without matching patient-space sources.');
    }
    derivedFrameIds.add(frame.id);
    const bytes = await toArrayBuffer(await readVerifiedFile(zip, file));
    if (bytes.byteLength !== frame.rows * frame.columns * Float32Array.BYTES_PER_ELEMENT) {
      throw new Error('A saved derived alignment frame does not match its pixel geometry.');
    }
    const pixels = new Float32Array(bytes);
    const derivedFrame = { ...frame, pixels };
    assertValidDerivedAlignmentFrameShape(derivedFrame);
    derivedFrames.push(derivedFrame);
  }
  if (derivedFrames.length > 12)
    throw new Error('The backup contains more derived frames than the safe storage limit.');

  const models = [] as Array<{ key: string; blob: Blob }>;
  for (const model of manifest.records.models) {
    models.push({ key: model.key, blob: await readVerifiedFile(zip, model.file) });
  }

  const db = await getDB();
  const tx = db.transaction(
    [
      'studies',
      'series',
      'instances',
      'panel_settings',
      'tumor_segmentations',
      'tumor_ground_truth',
      'volume_segmentations',
      'derived_alignment_frames',
      'app_state',
    ],
    'readwrite',
  );
  const revisionStore = tx.objectStore('app_state');
  const existingRevision = await revisionStore.get(DATASET_REVISION_STATE_KEY);
  for (const row of manifest.records.studies) {
    const existing = await tx.objectStore('studies').get(row.studyInstanceUid);
    if (existing?.patientId && row.patientId && existing.patientId !== row.patientId) {
      await tx.done;
      throw new Error('A restored examination conflicts with an existing patient identity.');
    }
  }
  for (const row of manifest.records.series) {
    const existing = await tx.objectStore('series').get(row.seriesInstanceUid);
    if (existing && existing.studyInstanceUid !== row.studyInstanceUid) {
      await tx.done;
      throw new Error('A restored series conflicts with an existing examination.');
    }
  }
  for (const row of instances) {
    const existing = await tx.objectStore('instances').get(row.sopInstanceUid);
    if (
      existing &&
      (existing.studyInstanceUid !== row.studyInstanceUid || existing.seriesInstanceUid !== row.seriesInstanceUid)
    ) {
      await tx.done;
      throw new Error('A restored image conflicts with an existing examination.');
    }
  }
  for (const row of manifest.records.studies) await tx.objectStore('studies').put(row);
  for (const row of manifest.records.series) await tx.objectStore('series').put(row);
  for (const row of instances) await tx.objectStore('instances').put(row);
  for (const row of manifest.records.panelSettings) await tx.objectStore('panel_settings').put(row);
  for (const row of manifest.records.tumorSegmentations) await tx.objectStore('tumor_segmentations').put(row);
  for (const row of manifest.records.tumorGroundTruth) await tx.objectStore('tumor_ground_truth').put(row);
  for (const row of volumes) await tx.objectStore('volume_segmentations').put(row);
  let archivedRevision = 0;
  for (const row of manifest.records.appState) {
    if (row.key === DATASET_REVISION_STATE_KEY) {
      archivedRevision = typeof row.value === 'number' ? row.value : 0;
      continue;
    }
    if (row.key === SELECTED_PATIENT_STATE_KEY) continue;
    await revisionStore.put(row);
  }
  if (selectedPatientKey) {
    await revisionStore.put({ key: SELECTED_PATIENT_STATE_KEY, value: selectedPatientKey });
  }
  const nextRevision =
    Math.max(typeof existingRevision?.value === 'number' ? existingRevision.value : 0, archivedRevision) + 1;
  for (const row of derivedFrames) {
    await tx.objectStore('derived_alignment_frames').put({ ...row, datasetRevision: nextRevision });
  }
  await revisionStore.put({ key: DATASET_REVISION_STATE_KEY, value: nextRevision });
  await tx.done;

  for (const model of models) {
    await putModelBlob(model.key, model.blob);
  }
  if (typeof localStorage !== 'undefined') {
    for (const [key, value] of Object.entries(manifest.records.localStorage ?? {})) {
      if (key.startsWith(OWNED_STORAGE_KEY_PREFIX) || (OWNED_EXACT_STORAGE_KEYS as readonly string[]).includes(key)) {
        localStorage.setItem(key, value);
      }
    }
  }
  notifyDatasetMutation();

  return {
    total: instances.length,
    ingested: instances.length,
    duplicates: 0,
    skipped: 0,
    errors: 0,
    errorSamples: [],
  };
}
