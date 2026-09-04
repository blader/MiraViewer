import type JSZip from 'jszip';
import { BackupZip, type BackupZipSink } from './backupZip';
import { assertArchiveActive as throwIfSnapshotAborted } from './archiveIntegrity';
import {
  assertStorageHeadroom,
  DATASET_REVISION_STATE_KEY,
  DATASET_TOKEN_STATE_KEY,
  DatasetReplacedError,
  getDB,
  notifyDatasetMutation,
  newDatasetToken,
  SELECTED_PATIENT_STATE_KEY,
  SELECTED_PATIENT_STUDY_STATE_KEY,
} from '../db/db';
import { getPatientIdentityAliases, getPatientIdentityKeys, studyIdentityConflict } from '../db/patientIdentity';
import { acquisitionChoiceKey, formatStudyDate, getSeriesSequenceCombo } from '../db/comparisonIdentity';
import { initializeComparisonState } from '../db/comparisonState';
import { readStoredVolumeSegmentation, SELECTION_CHUNK_BYTES, volumeChunkRange } from '../db/volumeSegmentations';
import type {
  AppStateRow,
  BackupStagingRow,
  DerivedAlignmentFrameRow,
  DicomInstance,
  DicomSeries,
  DicomStudy,
  PanelSettingsRow,
  TumorGroundTruthRow,
  TumorSegmentationRow,
  VolumeSegmentationRow,
} from '../db/schema';
import type { SvrSelectionPlane, SvrSelectionSeeds } from '../types/svr';
import { isOwnedStorageKey } from '../utils/storageKeys';
import { getAllModelRecords, prepareModelStore } from '../utils/segmentation/onnx/modelCache';
import * as localApi from '../utils/localApi';
import { validateOutputGridReference } from '../utils/outputPlaneGrid';
import type { ProcessFilesResult } from './dicomIngestion';
import { loadSafeArchive, MAX_ENTRY_BYTES, readArchiveEntry, type ArchiveReadOptions } from './archiveSafety';
import { isSelectionContextValid, isSelectionCoverageValid } from '../utils/segmentation/selectionEditing';
import { formatBytes } from '../utils/format';

export type ExportProgress = {
  stage: 'checking' | 'collecting' | 'zipping' | 'finalizing';
  current: number;
  total: number;
  detail?: string;
};

export type SnapshotWriteOptions = ArchiveReadOptions & {
  onCommitStart?: () => void;
};

export type RestoreSnapshotResult = ProcessFilesResult & {
  integrityWarnings?: string[];
};

type SnapshotFile = {
  path: string;
  byteLength: number;
  sha256?: string;
};

type SnapshotInstance = Omit<DicomInstance, 'fileBlob'> & { file: SnapshotFile };
type SnapshotSeeds = Omit<SvrSelectionSeeds, 'foreground' | 'background'> & {
  /** Older v2 exports used JSON.stringify(Uint32Array), which emits numeric-key objects. */
  foreground: number[] | Record<string, number>;
  background: number[] | Record<string, number>;
};
type SnapshotVolume = Omit<VolumeSegmentationRow, 'labels' | 'seeds'> & { file: SnapshotFile; seeds?: SnapshotSeeds };
type SnapshotDerivedFrame = Omit<DerivedAlignmentFrameRow, 'pixels' | 'valid'> & {
  file: SnapshotFile;
  validFile?: SnapshotFile;
};
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

function snapshotVoxelCount(dims: unknown): number {
  if (!Array.isArray(dims) || dims.length !== 3 || dims.some((size) => !Number.isSafeInteger(size) || size < 1))
    throw new Error('A saved volume segmentation does not match its reconstruction geometry.');
  const count = dims.reduce((product, size: number) => product * size, 1);
  if (!Number.isSafeInteger(count))
    throw new Error('A saved volume segmentation does not match its reconstruction geometry.');
  return count;
}

/** Validate before typed-array construction can coerce, truncate or discard editing marks. */
function decodeSnapshotSeeds(value: unknown, dims: VolumeSegmentationRow['dims']): SvrSelectionSeeds | undefined {
  if (value === undefined) return undefined;
  const invalid = () => new Error('A saved volume segmentation contains invalid editing marks.');
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalid();
  const count = snapshotVoxelCount(dims);
  const marks = (input: unknown): Uint32Array => {
    let length: number;
    if (Array.isArray(input)) length = input.length;
    else if (ArrayBuffer.isView(input) && Object.prototype.toString.call(input) === '[object Uint32Array]')
      length = (input as Uint32Array).length;
    else if (input && Object.prototype.toString.call(input) === '[object Object]') {
      const keys = Object.keys(input);
      if (keys.some((key, index) => key !== String(index))) throw invalid();
      length = keys.length;
    } else throw invalid();
    const result = new Uint32Array(length);
    for (let index = 0; index < length; index++) {
      const mark = (input as Record<number, unknown>)[index];
      if (typeof mark !== 'number' || !Number.isSafeInteger(mark) || mark < 0 || mark > 0xffffffff || mark >= count)
        throw invalid();
      result[index] = mark;
    }
    return result;
  };
  const { foreground, background, lastStroke, ...metadata } = value as Record<string, unknown>;
  const seeds: SvrSelectionSeeds = { ...metadata, foreground: marks(foreground), background: marks(background) };
  if (lastStroke !== undefined) {
    const stroke = lastStroke as SvrSelectionPlane;
    const axis = ['sagittal', 'coronal', 'axial'].indexOf(stroke?.plane);
    if (axis < 0 || !Number.isSafeInteger(stroke?.slice) || stroke.slice < 0 || stroke.slice >= dims[axis]!)
      throw new Error('A saved volume segmentation contains invalid last-stroke geometry.');
    // Earlier accumulated marks need not occupy this one editing section.
    seeds.lastStroke = { ...stroke };
  }
  return seeds;
}

function snapshotFileBytes(files: Iterable<SnapshotFile>): number {
  let total = 0;
  for (const file of files) {
    if (!Number.isSafeInteger(file?.byteLength) || file.byteLength < 0) {
      throw new Error('The backup contains a file with an invalid declared size.');
    }
    if (file.byteLength > MAX_ENTRY_BYTES)
      throw new Error(`A backup file exceeds the ${formatBytes(MAX_ENTRY_BYTES)} per-file restore limit.`);
    total += file.byteLength;
    if (!Number.isSafeInteger(total)) throw new Error('The complete backup exceeds the supported browser range.');
  }
  return total;
}

/** Both directions validate individual payloads; aggregate capacity is governed by storage headroom. */
export function getSnapshotRestoreBytes(manifest: SnapshotManifest): number {
  return snapshotFileBytes([
    ...manifest.records.instances.map((entry) => entry.file),
    ...manifest.records.volumeSegmentations.map((entry) => entry.file),
    ...(manifest.records.derivedAlignmentFrames ?? []).flatMap((entry) =>
      entry.validFile ? [entry.file, entry.validFile] : [entry.file],
    ),
    ...manifest.records.models.map((entry) => entry.file),
  ]);
}

function captureOwnedLocalStorage(): Record<string, string> {
  const records: Record<string, string> = {};
  if (typeof localStorage === 'undefined') return records;
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i);
    if (!key || !isOwnedStorageKey(key)) continue;
    const value = localStorage.getItem(key);
    if (value !== null) records[key] = value;
  }
  return records;
}

function ownsAcquisitionChoice(row: AppStateRow, seriesByUid: ReadonlyMap<string, DicomSeries>): boolean {
  const source = typeof row.value === 'string' ? seriesByUid.get(row.value) : undefined;
  return !!source && row.key === acquisitionChoiceKey(source.studyInstanceUid, getSeriesSequenceCombo(source).id);
}

async function buildSnapshotZip(
  zip: BackupZip,
  studyIds: string[],
  onProgress?: (progress: ExportProgress) => void,
  options: SnapshotWriteOptions = {},
): Promise<Blob | null> {
  const { signal } = options;
  throwIfSnapshotAborted(signal);
  onProgress?.({ stage: 'checking', current: 0, total: 1 });
  const db = await getDB();
  const datasetToken = (await db.get('app_state', DATASET_TOKEN_STATE_KEY))?.value;
  const files: Array<{
    file: SnapshotFile;
    read: (file: SnapshotFile) => Blob | ArrayBufferView | Promise<Blob | ArrayBufferView>;
  }> = [];
  const addSnapshotFile = (
    path: string,
    byteLength: number,
    read: (file: SnapshotFile) => Blob | ArrayBufferView | Promise<Blob | ArrayBufferView>,
  ): SnapshotFile => {
    throwIfSnapshotAborted(signal);
    const file = { path, byteLength };
    files.push({ file, read });
    return file;
  };
  const selectedStudies = new Set(studyIds);
  const allStudies = await db.getAll('studies');
  const studies = allStudies.filter((study) => selectedStudies.has(study.studyInstanceUid));
  if (studies.length !== selectedStudies.size) throw new Error('One or more selected examinations no longer exist.');

  const identityByStudy = getPatientIdentityKeys(allStudies);
  const patientKeys = new Set(studies.map((study) => identityByStudy.get(study.studyInstanceUid)!));
  if (patientKeys.size > 1) throw new Error('A backup cannot combine examinations from different patients.');
  const selectedPatientKey = patientKeys.values().next().value as string | undefined;
  const series = (await db.getAll('series')).filter((item) => selectedStudies.has(item.studyInstanceUid));
  const selectedSeries = new Set(series.map((item) => item.seriesInstanceUid));
  const selectedSeriesByUid = new Map(series.map((item) => [item.seriesInstanceUid, item]));

  const instances: SnapshotInstance[] = [];
  for (const item of series) {
    throwIfSnapshotAborted(signal);
    const rows = await db.getAllFromIndex('instances', 'by-series', item.seriesInstanceUid);
    for (const row of rows) {
      const { fileBlob, ...metadata } = row;
      const path = `studies/${encodeURIComponent(row.studyInstanceUid)}/series/${encodeURIComponent(row.seriesInstanceUid)}/${encodeURIComponent(row.sopInstanceUid)}.dcm`;
      const file = addSnapshotFile(path, fileBlob.size, () => fileBlob);
      instances.push({ ...metadata, file });
    }
  }

  const panelSettings = (await db.getAll('panel_settings')).flatMap((row) => {
    if (row.source)
      return selectedStudies.has(row.source.studyUid) && selectedSeries.has(row.source.seriesUid) ? [row] : [];
    const settings = Object.fromEntries(
      Object.entries(row.settings).filter(([date]) =>
        studies.some((study) => {
          const scopeMatches =
            !row.comboId.includes('::') ||
            getPatientIdentityAliases(study).some((key) => row.comboId.startsWith(`${key}::`));
          const timestamp = formatStudyDate(study);
          return (
            scopeMatches &&
            (date === timestamp ||
              date === `${timestamp}#${study.studyInstanceUid}` ||
              (!study.studyTime && date === timestamp.split('T')[0]))
          );
        }),
      ),
    );
    return Object.keys(settings).length ? [{ ...row, settings }] : [];
  });
  const tumorSegmentations = (await db.getAll('tumor_segmentations')).filter((row) => selectedStudies.has(row.studyId));
  const tumorGroundTruth = (await db.getAll('tumor_ground_truth')).filter((row) => selectedStudies.has(row.studyId));

  const volumeSegmentations: SnapshotVolume[] = [];
  for (const key of await db.getAllKeys('volume_segmentations')) {
    throwIfSnapshotAborted(signal);
    const stored = await db.get('volume_segmentations', key);
    if (!stored) continue;
    if (stored.studyUid && !selectedStudies.has(stored.studyUid)) continue;
    if (!stored.studyUid && stored.patientKey && selectedPatientKey && stored.patientKey !== selectedPatientKey)
      continue;
    if (stored.seriesUids?.length && !stored.seriesUids.some((uid: string) => selectedSeries.has(uid))) continue;
    const path = `segmentations/${encodeURIComponent(stored.volumeKey)}.labels`;
    // Sparse label masks can legitimately exceed archive expansion-ratio guards;
    // complete archives use STORE for these and every other payload below.
    const expectedRevision = 'labels' in stored ? 'legacy' : stored.revision;
    addSnapshotFile(path, 'labels' in stored ? stored.labels.byteLength : stored.labelBytes, async (file) => {
      const transaction = db.transaction(['volume_segmentations', 'volume_segmentation_chunks']);
      const current = await transaction.objectStore('volume_segmentations').get(key);
      if (!current || ('labels' in current ? 'legacy' : current.revision) !== expectedRevision)
        throw new Error('A saved selection changed while preparing the backup. Retry export to include it.');
      const row = await readStoredVolumeSegmentation(current, transaction.objectStore('volume_segmentation_chunks'));
      await transaction.done;
      const { labels, seeds: savedSeeds, ...metadata } = row;
      if (!isSelectionCoverageValid(row.clippedNativeVoxels) || !isSelectionContextValid(row.contextLimited))
        throw new Error('A saved volume segmentation contains invalid viewing-region coverage.');
      const seeds = decodeSnapshotSeeds(savedSeeds, row.dims);
      volumeSegmentations.push({
        ...metadata,
        file,
        ...(seeds && {
          seeds: { ...seeds, foreground: Array.from(seeds.foreground), background: Array.from(seeds.background) },
        }),
      });
      return labels;
    });
  }

  const derivedAlignmentFrames: SnapshotDerivedFrame[] = [];
  for (const key of await db.getAllKeys('derived_alignment_frames')) {
    throwIfSnapshotAborted(signal);
    const row = await db.get('derived_alignment_frames', key);
    if (!row) continue;
    if (!selectedStudies.has(row.targetStudyUid)) continue;
    if (selectedPatientKey && identityByStudy.get(row.targetStudyUid) !== selectedPatientKey) continue;
    if (row.referenceStudyUid && !selectedStudies.has(row.referenceStudyUid)) continue;
    if (row.referenceSeriesUid && !selectedSeries.has(row.referenceSeriesUid)) continue;
    const { pixels, valid, ...metadata } = row;
    const read = async (field: 'pixels' | 'valid') => {
      const current = await db.get('derived_alignment_frames', key);
      if (!current || current.createdAt !== metadata.createdAt || current.datasetRevision !== metadata.datasetRevision)
        throw new Error('An aligned image changed while preparing the backup. Retry export to include it.');
      const value = current[field];
      if (!value) throw new Error('An aligned image is incomplete. Retry export.');
      return value;
    };
    const path = `derived-frames/${encodeURIComponent(row.id)}.f32`;
    const file = addSnapshotFile(path, pixels.byteLength, () => read('pixels'));
    const validFile = valid
      ? addSnapshotFile(`derived-frames/${encodeURIComponent(row.id)}.valid`, valid.byteLength, () => read('valid'))
      : undefined;
    derivedAlignmentFrames.push({ ...metadata, file, ...(validFile && { validFile }) });
  }

  const models: SnapshotModel[] = [];
  for (const model of await getAllModelRecords()) {
    const path = `models/${encodeURIComponent(model.key)}.onnx`;
    const file = addSnapshotFile(path, model.blob.size, () => model.blob);
    models.push({ key: model.key, savedAtMs: model.savedAtMs, file });
  }

  // Admit the complete payload before reading Blob contents, materializing
  // chunked labels, hashing, or packaging any file. Descriptors are shared
  // with the final manifest so these two phases cannot count different files.
  const totalBytes = snapshotFileBytes(files.map(({ file }) => file));
  let writtenBytes = 0;
  let reportedProgress = -1;
  for (let index = 0; index < files.length; index++) {
    onProgress?.({ stage: 'collecting', current: index + 1, total: files.length });
    throwIfSnapshotAborted(signal);
    const { file, read } = files[index]!;
    const value = await read(file);
    const blob = ArrayBuffer.isView(value)
      ? new Blob([new Uint8Array(value.buffer, value.byteOffset, value.byteLength) as Uint8Array<ArrayBuffer>])
      : value;
    throwIfSnapshotAborted(signal);
    if (blob.size !== file.byteLength) throw new Error('A backup payload changed size. Retry export.');
    file.sha256 = await zip.add(file.path, blob, (bytes) => {
      writtenBytes += bytes;
      const percentage = Math.round((writtenBytes / Math.max(1, totalBytes)) * 100);
      if (percentage === reportedProgress) return;
      reportedProgress = percentage;
      onProgress?.({
        stage: 'zipping',
        current: percentage,
        total: 100,
      });
    });
    throwIfSnapshotAborted(signal);
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
      appState: (await db.getAll('app_state')).filter((row) => {
        if (row.key.startsWith('acquisition:')) return ownsAcquisitionChoice(row, selectedSeriesByUid);
        if (row.key === SELECTED_PATIENT_STUDY_STATE_KEY) return selectedStudies.has(row.value as string);
        if (row.key === SELECTED_PATIENT_STATE_KEY) return row.value === selectedPatientKey;
        // A backup carries its content revision, not another live writer's token.
        return row.key === DATASET_REVISION_STATE_KEY;
      }),
      models,
      localStorage: captureOwnedLocalStorage(),
    },
  };
  await zip.add('export.json', new Blob([JSON.stringify(manifest)]));

  throwIfSnapshotAborted(signal);
  if ((await db.get('app_state', DATASET_TOKEN_STATE_KEY))?.value !== datasetToken) throw new DatasetReplacedError();
  onProgress?.({ stage: 'finalizing', current: 1, total: 1 });
  const blob = await zip.finish(options.onCommitStart);
  if (blob) await loadSafeArchive(blob, { signal, deferStorageCheck: true });
  return blob;
}

export async function exportStudiesToZip(
  studyIds: string[],
  onProgress?: (progress: ExportProgress) => void,
  options: SnapshotWriteOptions = {},
): Promise<Blob> {
  return (await buildSnapshotZip(new BackupZip(options.signal), studyIds, onProgress, options))!;
}

export async function exportStudiesToFile(
  studyIds: string[],
  sink: BackupZipSink,
  onProgress?: (progress: ExportProgress) => void,
  options: SnapshotWriteOptions = {},
): Promise<void> {
  const zip = new BackupZip(options.signal, sink);
  try {
    await buildSnapshotZip(zip, studyIds, onProgress, options);
  } catch (error) {
    try {
      await sink.abort();
    } catch {
      // Preserve the original export failure if the failed file cannot abort.
    }
    throw error;
  }
}

export async function readSnapshotManifest(
  zip: JSZip,
  options: ArchiveReadOptions = {},
): Promise<SnapshotManifest | null> {
  throwIfSnapshotAborted(options.signal);
  const entry = zip.file('export.json');
  if (!entry) return null;
  let parsed: unknown;
  try {
    const bytes = await (await readArchiveEntry(entry, options)).arrayBuffer();
    throwIfSnapshotAborted(options.signal);
    parsed = JSON.parse(new TextDecoder().decode(bytes));
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
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

async function restoreStagedSnapshot(
  zip: JSZip,
  manifest: SnapshotManifest,
  onProgress?: (current: number, total: number) => void,
  options: SnapshotWriteOptions = {},
  discardAbandonedStage = false,
): Promise<RestoreSnapshotResult> {
  const { signal, onCommitStart } = options;
  const integrityWarnings = new Set<string>();
  throwIfSnapshotAborted(signal);
  const restoreBytes = getSnapshotRestoreBytes(manifest);
  const db = await getDB();
  // Only cooperating producers share the lock. An embedded or older context
  // without Web Locks may still be staging, so never collect its namespace.
  const lockedPrefix = 'locked:';
  if (discardAbandonedStage)
    await db.delete(
      'backup_staging',
      IDBKeyRange.bound([lockedPrefix, 0], [`${lockedPrefix}\uffff`, Number.MAX_SAFE_INTEGER]),
    );
  await assertStorageHeadroom(restoreBytes * 2);
  const datasetToken = (await db.get('app_state', DATASET_TOKEN_STATE_KEY))?.value;
  if (typeof datasetToken !== 'string') throw new DatasetReplacedError();
  if (manifest.records.models.length > 0) await prepareModelStore(db);
  throwIfSnapshotAborted(signal);
  const studyUids = new Set(manifest.records.studies.map((study) => study.studyInstanceUid));
  if (studyUids.size !== manifest.records.studies.length) {
    throw new Error('The backup contains duplicate examination identifiers.');
  }
  const patientKeys = new Set(getPatientIdentityKeys(manifest.records.studies).values());
  if (patientKeys.size > 1) throw new Error('This backup contains multiple patients and cannot be safely restored.');
  const selectedPatientKey = patientKeys.values().next().value as string | undefined;
  for (const series of manifest.records.series) {
    throwIfSnapshotAborted(signal);
    if (!studyUids.has(series.studyInstanceUid)) throw new Error('The backup contains an orphaned series.');
  }
  const seriesByUid = new Map(manifest.records.series.map((series) => [series.seriesInstanceUid, series]));
  if (seriesByUid.size !== manifest.records.series.length) {
    throw new Error('The backup contains duplicate series identifiers.');
  }

  const operationId = `${discardAbandonedStage ? lockedPrefix : ''}${newDatasetToken()}`;
  const stageRange = IDBKeyRange.bound([operationId, 0], [operationId, Number.MAX_SAFE_INTEGER]);
  let stagedCount = 0;
  const stage = async (rows: BackupStagingRow[]) => {
    throwIfSnapshotAborted(signal);
    const tx = db.transaction('backup_staging', 'readwrite');
    const completed = tx.done;
    void completed.catch(() => {});
    try {
      for (const row of rows) await tx.store.put(row, [operationId, stagedCount++]);
      throwIfSnapshotAborted(signal);
      await completed;
    } catch (error) {
      try {
        tx.abort();
      } catch {
        /* Already aborted. */
      }
      await completed.catch(() => {});
      throw error;
    }
  };

  try {
    const instancesByUid = new Map<string, Omit<DicomInstance, 'fileBlob'>>();
    let current = 0;
    const total =
      manifest.records.instances.length +
      manifest.records.volumeSegmentations.length +
      manifest.records.models.length +
      (manifest.records.derivedAlignmentFrames ?? []).reduce((sum, frame) => sum + (frame.validFile ? 2 : 1), 0);
    const readFile = async (file: SnapshotFile) => {
      throwIfSnapshotAborted(signal);
      const entry = zip.file(file.path);
      if (!entry) throw new Error('The backup is incomplete: a referenced file is missing.');
      const blob = await readArchiveEntry(entry, { signal, sha256: file.sha256 });
      if (blob.size !== file.byteLength) throw new Error('A backup file has an invalid size.');
      throwIfSnapshotAborted(signal);
      onProgress?.(++current, total);
      throwIfSnapshotAborted(signal);
      return blob;
    };
    for (const metadata of manifest.records.instances) {
      throwIfSnapshotAborted(signal);
      const parentSeries = seriesByUid.get(metadata.seriesInstanceUid);
      if (!studyUids.has(metadata.studyInstanceUid) || parentSeries?.studyInstanceUid !== metadata.studyInstanceUid) {
        throw new Error('The backup contains an orphaned image.');
      }
      if (instancesByUid.has(metadata.sopInstanceUid))
        throw new Error('The backup contains duplicate image identifiers.');
      const { file, ...instance } = metadata;
      instancesByUid.set(metadata.sopInstanceUid, instance);
      await stage([{ store: 'instances', row: { ...instance, fileBlob: await readFile(file) } }]);
      throwIfSnapshotAborted(signal);
    }
    const instances = Array.from(instancesByUid.values());
    const orderedInstancesForSeries = (seriesUid: string) => {
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
      throwIfSnapshotAborted(signal);
      const parentSeries = seriesByUid.get(annotation.seriesUid);
      if (
        parentSeries?.studyInstanceUid !== annotation.studyId ||
        instancesByUid.get(annotation.sopInstanceUid)?.seriesInstanceUid !== annotation.seriesUid
      ) {
        throw new Error('The backup contains an annotation without a matching examination and image.');
      }
    }

    const volumeKeys = new Set<string>();
    for (const metadata of manifest.records.volumeSegmentations) {
      throwIfSnapshotAborted(signal);
      const { file, seeds: savedSeeds, ...volume } = metadata;
      if (volumeKeys.has(volume.volumeKey)) throw new Error('The backup contains duplicate selection identifiers.');
      volumeKeys.add(volume.volumeKey);
      if (!isSelectionCoverageValid(volume.clippedNativeVoxels) || !isSelectionContextValid(volume.contextLimited))
        throw new Error('A saved volume segmentation contains invalid viewing-region coverage.');
      const blob = await readFile(file);
      if (blob.size !== snapshotVoxelCount(volume.dims)) {
        throw new Error('A saved volume segmentation does not match its reconstruction geometry.');
      }
      const seeds = decodeSnapshotSeeds(savedSeeds, volume.dims);
      let chunkCount = 0;
      for (let start = 0; start < blob.size; start += 1024 * 1024) {
        throwIfSnapshotAborted(signal);
        const bytes = new Uint8Array(await blob.slice(start, start + 1024 * 1024).arrayBuffer());
        const batch: BackupStagingRow[] = [];
        for (let offset = 0; offset < bytes.length; offset += SELECTION_CHUNK_BYTES) {
          const data = bytes.subarray(offset, offset + SELECTION_CHUNK_BYTES);
          if (data.some(Boolean)) {
            // Clone only the chunk, not the entire backing block, into IndexedDB.
            batch.push({
              store: 'volume_segmentation_chunks',
              row: { volumeKey: volume.volumeKey, offset: start + offset, data: data.slice() },
            });
            chunkCount++;
          }
        }
        if (batch.length > 0) await stage(batch);
      }
      await stage([
        {
          store: 'volume_segmentations',
          row: {
            ...volume,
            ...(seeds && { seeds }),
            storage: 'chunks-v1',
            revision: newDatasetToken(),
            labelBytes: blob.size,
            chunkCount,
          },
        },
      ]);
    }

    if ((manifest.records.derivedAlignmentFrames?.length ?? 0) > localApi.MAX_DERIVED_ALIGNMENT_FRAMES)
      throw new Error('The backup contains more derived frames than the safe storage limit.');
    const derivedFrameIds = new Set<string>();
    for (const metadata of manifest.records.derivedAlignmentFrames ?? []) {
      throwIfSnapshotAborted(signal);
      const { file, validFile, ...frame } = metadata;
      const target = seriesByUid.get(frame.targetSeriesUid);
      const targetInstance = frame.targetSopInstanceUid ? instancesByUid.get(frame.targetSopInstanceUid) : undefined;
      const reference = frame.referenceSeriesUid ? seriesByUid.get(frame.referenceSeriesUid) : undefined;
      const referenceInstance = frame.referenceSopInstanceUid
        ? instancesByUid.get(frame.referenceSopInstanceUid)
        : undefined;
      if (
        derivedFrameIds.has(frame.id) ||
        !studyUids.has(frame.targetStudyUid) ||
        target?.studyInstanceUid !== frame.targetStudyUid ||
        !targetInstance ||
        targetInstance.seriesInstanceUid !== frame.targetSeriesUid ||
        targetInstance.studyInstanceUid !== frame.targetStudyUid ||
        orderedInstancesForSeries(frame.targetSeriesUid)[frame.targetFrameIndex]?.sopInstanceUid !==
          frame.targetSopInstanceUid ||
        frame.sourceImageId !== `miradb:${frame.targetSopInstanceUid}` ||
        frame.contributingSourceSopInstanceUids?.some(
          (uid) => instancesByUid.get(uid)?.seriesInstanceUid !== frame.targetSeriesUid,
        ) ||
        (frame.referenceStudyUid && !studyUids.has(frame.referenceStudyUid)) ||
        (frame.referenceSeriesUid && !reference) ||
        (frame.referenceStudyUid && reference?.studyInstanceUid !== frame.referenceStudyUid) ||
        (frame.referenceSopInstanceUid && referenceInstance?.seriesInstanceUid !== frame.referenceSeriesUid) ||
        (frame.referenceFrameIndex !== undefined &&
          (!frame.referenceSeriesUid ||
            orderedInstancesForSeries(frame.referenceSeriesUid)[frame.referenceFrameIndex]?.sopInstanceUid !==
              frame.referenceSopInstanceUid)) ||
        !localApi.matchesReferenceGeometry(frame, referenceInstance) ||
        (frame.targetFrameOfReferenceUid &&
          target.frameOfReferenceUid &&
          frame.targetFrameOfReferenceUid !== target.frameOfReferenceUid) ||
        (frame.referenceFrameOfReferenceUid &&
          reference?.frameOfReferenceUid &&
          frame.referenceFrameOfReferenceUid !== reference.frameOfReferenceUid)
      ) {
        throw new Error('The backup contains a derived alignment frame without matching patient-space sources.');
      }
      if (frame.outputGrid) {
        if (!referenceInstance) {
          throw new Error('The backup contains a physical output grid without its native reference image.');
        }
        validateOutputGridReference(frame.outputGrid, referenceInstance, reference?.frameOfReferenceUid);
      }
      derivedFrameIds.add(frame.id);
      const bytes = await (await readFile(file)).arrayBuffer();
      if (bytes.byteLength !== frame.rows * frame.columns * Float32Array.BYTES_PER_ELEMENT) {
        throw new Error('A saved derived alignment frame does not match its pixel geometry.');
      }
      const pixels = new Float32Array(bytes);
      const valid = validFile ? new Uint8Array(await (await readFile(validFile)).arrayBuffer()) : undefined;
      const derivedFrame = { ...frame, pixels, ...(valid && { valid }) };
      localApi.assertValidDerivedAlignmentFrameShape(derivedFrame);
      await stage([{ store: 'derived_alignment_frames', row: derivedFrame }]);
    }

    const modelKeys = new Set<string>();
    for (const model of manifest.records.models) {
      throwIfSnapshotAborted(signal);
      if (modelKeys.has(model.key)) throw new Error('The backup contains duplicate model identifiers.');
      modelKeys.add(model.key);
      await stage([
        {
          store: 'models',
          row: { key: model.key, savedAtMs: model.savedAtMs, blob: await readFile(model.file) },
        },
      ]);
    }

    throwIfSnapshotAborted(signal);
    onCommitStart?.();
    const tx = db.transaction(
      [
        'studies',
        'series',
        'instances',
        'panel_settings',
        'tumor_segmentations',
        'tumor_ground_truth',
        'volume_segmentations',
        'volume_segmentation_chunks',
        'derived_alignment_frames',
        'app_state',
        'models',
        'backup_staging',
      ],
      'readwrite',
    );
    const completed = tx.done;
    void completed.catch(() => {});
    try {
      const revisionStore = tx.objectStore('app_state');
      if ((await revisionStore.get(DATASET_TOKEN_STATE_KEY))?.value !== datasetToken) throw new DatasetReplacedError();
      const existingRevision = await revisionStore.get(DATASET_REVISION_STATE_KEY);
      for (const row of manifest.records.studies) {
        const existing = await tx.objectStore('studies').get(row.studyInstanceUid);
        const conflict = studyIdentityConflict(existing, row);
        if (conflict) {
          throw new Error(`A restored examination conflicts with an existing patient identity. ${conflict}`);
        }
      }
      for (const row of manifest.records.series) {
        const existing = await tx.objectStore('series').get(row.seriesInstanceUid);
        if (existing && existing.studyInstanceUid !== row.studyInstanceUid) {
          throw new Error('A restored series conflicts with an existing examination.');
        }
      }
      for (const row of instances) {
        const existing = await tx.objectStore('instances').get(row.sopInstanceUid);
        if (
          existing &&
          (existing.studyInstanceUid !== row.studyInstanceUid || existing.seriesInstanceUid !== row.seriesInstanceUid)
        ) {
          throw new Error('A restored image conflicts with an existing examination.');
        }
      }
      for (const row of manifest.records.studies) await tx.objectStore('studies').put(row);
      for (const row of manifest.records.series) await tx.objectStore('series').put(row);
      for (const row of manifest.records.panelSettings) await tx.objectStore('panel_settings').put(row);
      for (const row of manifest.records.tumorSegmentations) await tx.objectStore('tumor_segmentations').put(row);
      for (const row of manifest.records.tumorGroundTruth) await tx.objectStore('tumor_ground_truth').put(row);
      for (const row of manifest.records.volumeSegmentations) {
        await tx.objectStore('volume_segmentation_chunks').delete(volumeChunkRange(row.volumeKey));
      }
      let archivedRevision = 0;
      for (const row of manifest.records.appState) {
        if (row.key === DATASET_REVISION_STATE_KEY) {
          archivedRevision = typeof row.value === 'number' ? row.value : 0;
          continue;
        }
        // Backups carry user choices, not internal migration/publication controls.
        // Patient anchors and saved-work identity are derived from verified rows.
        if (row.key.startsWith('acquisition:') && ownsAcquisitionChoice(row, seriesByUid)) await revisionStore.put(row);
      }
      const restoredIdentities = getPatientIdentityKeys(await tx.objectStore('studies').getAll());
      if (selectedPatientKey) {
        const anchor = manifest.records.studies[0]!.studyInstanceUid;
        await revisionStore.put({
          key: SELECTED_PATIENT_STATE_KEY,
          value: restoredIdentities.get(anchor)!,
        });
        await revisionStore.put({ key: SELECTED_PATIENT_STUDY_STATE_KEY, value: anchor });
      }
      const nextRevision =
        Math.max(typeof existingRevision?.value === 'number' ? existingRevision.value : 0, archivedRevision) + 1;
      let publishedCount = 0;
      let cursor = await tx.objectStore('backup_staging').openCursor(stageRange);
      while (cursor) {
        if (cursor.key[1] !== publishedCount++) throw new Error('The verified backup staging is incomplete.');
        const pending = cursor.value;
        if (pending.store === 'models') await tx.objectStore('models').put(pending.row, pending.row.key);
        else if (pending.store === 'derived_alignment_frames') {
          await tx.objectStore(pending.store).put({
            ...pending.row,
            patientKey: restoredIdentities.get(pending.row.targetStudyUid)!,
            datasetRevision: nextRevision,
          });
        } else await tx.objectStore(pending.store).put(pending.row);
        await cursor.delete();
        cursor = await cursor.continue();
      }
      if (publishedCount !== stagedCount) throw new Error('The verified backup staging is incomplete.');
      await revisionStore.put({ key: DATASET_REVISION_STATE_KEY, value: nextRevision });
      await revisionStore.put({ key: DATASET_TOKEN_STATE_KEY, value: newDatasetToken() });
      await completed;
    } catch (error) {
      try {
        tx.abort();
      } catch {
        /* The transaction may already be aborted. */
      }
      await completed.catch(() => {});
      throw error;
    }
    try {
      await initializeComparisonState(db);
    } catch {
      integrityWarnings.add(
        'All medical data was restored, but some viewer choices could not be initialized. Reload the viewer to retry.',
      );
    }

    if (typeof localStorage !== 'undefined') {
      for (const [key, value] of Object.entries(manifest.records.localStorage ?? {})) {
        if (!isOwnedStorageKey(key)) continue;
        try {
          localStorage.setItem(key, value);
        } catch {
          integrityWarnings.add(
            'Some display preferences could not be restored; all medical data was restored safely.',
          );
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
      ...(integrityWarnings.size > 0 && { integrityWarnings: Array.from(integrityWarnings) }),
    };
  } finally {
    // Publication deletes its own staging in the same transaction. Cancellation
    // and failure release only their private rows; cleanup cannot mask the result.
    await db.delete('backup_staging', stageRange).catch(() => {});
  }
}

export async function restoreSnapshot(
  zip: JSZip,
  manifest: SnapshotManifest,
  onProgress?: (current: number, total: number) => void,
  options: SnapshotWriteOptions = {},
): Promise<RestoreSnapshotResult> {
  throwIfSnapshotAborted(options.signal);
  const run = (exclusive: boolean) => restoreStagedSnapshot(zip, manifest, onProgress, options, exclusive);
  // Queued restores remain cancelable. The lock is released on failure, normal
  // completion, or tab exit, so a later restore can safely reclaim abandoned rows.
  return navigator.locks
    ? navigator.locks.request('miraviewer:backup-restore', { signal: options.signal }, () => run(true))
    : run(false);
}
