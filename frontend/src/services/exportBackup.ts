import JSZip from 'jszip';
import {
  assertStorageHeadroom,
  DATASET_REVISION_STATE_KEY,
  DATASET_TOKEN_STATE_KEY,
  getDB,
  notifyDatasetMutation,
  newDatasetToken,
  SELECTED_PATIENT_STATE_KEY,
  SELECTED_PATIENT_STUDY_STATE_KEY,
} from '../db/db';
import { getPatientIdentityAliases, getPatientIdentityKeys, studyIdentityConflict } from '../db/patientIdentity';
import { acquisitionChoiceKey, formatStudyDate, getSeriesSequenceCombo } from '../db/comparisonIdentity';
import { initializeComparisonState } from '../db/comparisonState';
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
import type { SvrSelectionPlane, SvrSelectionSeeds } from '../types/svr';
import { isOwnedStorageKey } from '../utils/storageKeys';
import { getAllModelRecords, putModelBlobs } from '../utils/segmentation/onnx/modelCache';
import * as localApi from '../utils/localApi';
import { validateOutputGridReference } from '../utils/outputPlaneGrid';
import type { ProcessFilesResult } from './dicomIngestion';
import { readArchiveEntry } from './archiveSafety';
import { isSelectionContextValid, isSelectionCoverageValid } from '../utils/segmentation/selectionEditing';
import type { ArchiveReadOptions } from './archiveSafety';

export type ExportProgress = {
  stage: 'collecting' | 'zipping' | 'finalizing';
  current: number;
  total: number;
  detail?: string;
};

export type RestoreSnapshotOptions = ArchiveReadOptions & {
  onCommitStart?: () => void;
};

export type RestoreSnapshotResult = ProcessFilesResult & {
  integrityWarnings?: string[];
};

export const MAX_SNAPSHOT_RESTORE_BYTES = 512 * 1024 * 1024;

function throwIfRestoreAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new DOMException('Backup restoration cancelled.', 'AbortError');
}

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

/** Complete restores must remain atomic; verified payloads cannot yet be staged without a schema migration. */
export function getSnapshotRestoreBytes(manifest: SnapshotManifest): number {
  let total = 0;
  const add = (file: SnapshotFile) => {
    if (!Number.isSafeInteger(file.byteLength) || file.byteLength < 0) {
      throw new Error('The backup contains a file with an invalid declared size.');
    }
    total += file.byteLength;
    if (!Number.isSafeInteger(total)) throw new Error('The complete backup exceeds the supported browser range.');
  };
  for (const entry of manifest.records.instances) add(entry.file);
  for (const entry of manifest.records.volumeSegmentations) add(entry.file);
  for (const entry of manifest.records.derivedAlignmentFrames ?? []) {
    add(entry.file);
    if (entry.validFile) add(entry.validFile);
  }
  for (const entry of manifest.records.models) add(entry.file);
  return total;
}

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

  const identityByStudy = getPatientIdentityKeys(allStudies);
  const patientKeys = new Set(studies.map((study) => identityByStudy.get(study.studyInstanceUid)!));
  if (patientKeys.size > 1) throw new Error('A backup cannot combine examinations from different patients.');
  const selectedPatientKey = patientKeys.values().next().value as string | undefined;
  const series = (await db.getAll('series')).filter((item) => selectedStudies.has(item.studyInstanceUid));
  const selectedSeries = new Set(series.map((item) => item.seriesInstanceUid));
  const selectedSeriesByUid = new Map(series.map((item) => [item.seriesInstanceUid, item]));

  const instances: SnapshotInstance[] = [];
  const totalInstances = Object.values(await localApi.getImageCounts(series)).reduce((count, next) => count + next, 0);
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
  for (const row of await db.getAll('volume_segmentations')) {
    if (row.studyUid && !selectedStudies.has(row.studyUid)) continue;
    if (!row.studyUid && row.patientKey && selectedPatientKey && row.patientKey !== selectedPatientKey) continue;
    if (row.seriesUids?.length && !row.seriesUids.some((uid: string) => selectedSeries.has(uid))) continue;
    const { labels, seeds: savedSeeds, ...metadata } = row;
    if (!isSelectionCoverageValid(row.clippedNativeVoxels) || !isSelectionContextValid(row.contextLimited))
      throw new Error('A saved volume segmentation contains invalid viewing-region coverage.');
    const seeds = decodeSnapshotSeeds(savedSeeds, row.dims);
    const path = `segmentations/${encodeURIComponent(row.volumeKey)}.labels`;
    // Sparse label masks can legitimately exceed archive expansion-ratio guards.
    const file = await addSnapshotFile(path, labels, true);
    volumeSegmentations.push({
      ...metadata,
      file,
      ...(seeds && {
        seeds: { ...seeds, foreground: Array.from(seeds.foreground), background: Array.from(seeds.background) },
      }),
    });
  }

  const derivedAlignmentFrames: SnapshotDerivedFrame[] = [];
  for (const row of await db.getAll('derived_alignment_frames')) {
    if (!selectedStudies.has(row.targetStudyUid)) continue;
    if (selectedPatientKey && identityByStudy.get(row.targetStudyUid) !== selectedPatientKey) continue;
    if (row.referenceStudyUid && !selectedStudies.has(row.referenceStudyUid)) continue;
    if (row.referenceSeriesUid && !selectedSeries.has(row.referenceSeriesUid)) continue;
    const { pixels, valid, ...metadata } = row;
    const path = `derived-frames/${encodeURIComponent(row.id)}.f32`;
    const file = await addSnapshotFile(path, pixels, true);
    const validFile = valid
      ? await addSnapshotFile(`derived-frames/${encodeURIComponent(row.id)}.valid`, valid, true)
      : undefined;
    derivedAlignmentFrames.push({ ...metadata, file, ...(validFile && { validFile }) });
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
  zip.file('export.json', JSON.stringify(manifest));

  onProgress?.({ stage: 'zipping', current: 0, total: 100 });
  const blob = await zip.generateAsync(
    { type: 'blob', compression: 'DEFLATE', compressionOptions: { level: 6 } },
    (metadata) => onProgress?.({ stage: 'zipping', current: Math.round(metadata.percent), total: 100 }),
  );
  onProgress?.({ stage: 'finalizing', current: 1, total: 1 });
  return blob;
}

export async function readSnapshotManifest(
  zip: JSZip,
  options: ArchiveReadOptions = {},
): Promise<SnapshotManifest | null> {
  throwIfRestoreAborted(options.signal);
  const entry = zip.file('export.json');
  if (!entry) return null;
  let parsed: unknown;
  try {
    const bytes = await (await readArchiveEntry(entry, options)).arrayBuffer();
    throwIfRestoreAborted(options.signal);
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

async function readVerifiedFile(
  zip: JSZip,
  descriptor: SnapshotFile,
  signal?: AbortSignal,
  integrityWarnings?: Set<string>,
): Promise<Blob> {
  throwIfRestoreAborted(signal);
  const entry = zip.file(descriptor.path);
  if (!entry) throw new Error('The backup is incomplete: a referenced file is missing.');
  const blob = await readArchiveEntry(entry, { signal });
  if (blob.size !== descriptor.byteLength) throw new Error('A backup file has an invalid size.');
  if (descriptor.sha256) {
    if (globalThis.crypto?.subtle) {
      const actual = await describeFile(descriptor.path, await toArrayBuffer(blob));
      if (actual.sha256 !== descriptor.sha256) throw new Error('A backup file failed its integrity check.');
    } else {
      integrityWarnings?.add('SHA-256 verification was unavailable; every archive member passed its CRC32 check.');
    }
  }
  throwIfRestoreAborted(signal);
  return blob;
}

export async function restoreSnapshot(
  zip: JSZip,
  manifest: SnapshotManifest,
  onProgress?: (current: number, total: number) => void,
  options: RestoreSnapshotOptions = {},
): Promise<RestoreSnapshotResult> {
  const { signal, onCommitStart } = options;
  const integrityWarnings = new Set<string>();
  throwIfRestoreAborted(signal);
  const restoreBytes = getSnapshotRestoreBytes(manifest);
  if (restoreBytes > MAX_SNAPSHOT_RESTORE_BYTES) {
    throw new Error(
      'This complete backup exceeds the 512 MiB safe restore limit. Import the original DICOM files instead.',
    );
  }
  await assertStorageHeadroom(restoreBytes);
  throwIfRestoreAborted(signal);
  const studyUids = new Set(manifest.records.studies.map((study) => study.studyInstanceUid));
  if (studyUids.size !== manifest.records.studies.length) {
    throw new Error('The backup contains duplicate examination identifiers.');
  }
  const patientKeys = new Set(getPatientIdentityKeys(manifest.records.studies).values());
  if (patientKeys.size > 1) throw new Error('This backup contains multiple patients and cannot be safely restored.');
  const selectedPatientKey = patientKeys.values().next().value as string | undefined;
  for (const series of manifest.records.series) {
    throwIfRestoreAborted(signal);
    if (!studyUids.has(series.studyInstanceUid)) throw new Error('The backup contains an orphaned series.');
  }
  const seriesByUid = new Map(manifest.records.series.map((series) => [series.seriesInstanceUid, series]));
  if (seriesByUid.size !== manifest.records.series.length) {
    throw new Error('The backup contains duplicate series identifiers.');
  }

  const instancesByUid = new Map<string, DicomInstance>();
  let current = 0;
  for (const metadata of manifest.records.instances) {
    throwIfRestoreAborted(signal);
    const parentSeries = seriesByUid.get(metadata.seriesInstanceUid);
    if (!studyUids.has(metadata.studyInstanceUid) || parentSeries?.studyInstanceUid !== metadata.studyInstanceUid) {
      throw new Error('The backup contains an orphaned image.');
    }
    if (instancesByUid.has(metadata.sopInstanceUid))
      throw new Error('The backup contains duplicate image identifiers.');
    const { file, ...instance } = metadata;
    instancesByUid.set(metadata.sopInstanceUid, {
      ...instance,
      fileBlob: await readVerifiedFile(zip, file, signal, integrityWarnings),
    });
    onProgress?.(++current, manifest.records.instances.length);
    throwIfRestoreAborted(signal);
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
    throwIfRestoreAborted(signal);
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
    throwIfRestoreAborted(signal);
    const { file, seeds: savedSeeds, ...volume } = metadata;
    if (!isSelectionCoverageValid(volume.clippedNativeVoxels) || !isSelectionContextValid(volume.contextLimited))
      throw new Error('A saved volume segmentation contains invalid viewing-region coverage.');
    const bytes = new Uint8Array(await toArrayBuffer(await readVerifiedFile(zip, file, signal, integrityWarnings)));
    if (bytes.length !== snapshotVoxelCount(volume.dims)) {
      throw new Error('A saved volume segmentation does not match its reconstruction geometry.');
    }
    const seeds = decodeSnapshotSeeds(savedSeeds, volume.dims);
    volumes.push({ ...volume, labels: bytes, ...(seeds && { seeds }) });
  }

  const derivedFrames: DerivedAlignmentFrameRow[] = [];
  const derivedFrameIds = new Set<string>();
  for (const metadata of manifest.records.derivedAlignmentFrames ?? []) {
    throwIfRestoreAborted(signal);
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
    const bytes = await toArrayBuffer(await readVerifiedFile(zip, file, signal, integrityWarnings));
    if (bytes.byteLength !== frame.rows * frame.columns * Float32Array.BYTES_PER_ELEMENT) {
      throw new Error('A saved derived alignment frame does not match its pixel geometry.');
    }
    const pixels = new Float32Array(bytes);
    const valid = validFile
      ? new Uint8Array(await toArrayBuffer(await readVerifiedFile(zip, validFile, signal, integrityWarnings)))
      : undefined;
    const derivedFrame = { ...frame, pixels, ...(valid && { valid }) };
    localApi.assertValidDerivedAlignmentFrameShape(derivedFrame);
    derivedFrames.push(derivedFrame);
  }
  if (derivedFrames.length > localApi.MAX_DERIVED_ALIGNMENT_FRAMES)
    throw new Error('The backup contains more derived frames than the safe storage limit.');

  const models = [] as Array<{ key: string; blob: Blob }>;
  for (const model of manifest.records.models) {
    throwIfRestoreAborted(signal);
    models.push({ key: model.key, blob: await readVerifiedFile(zip, model.file, signal, integrityWarnings) });
  }

  const db = await getDB();
  throwIfRestoreAborted(signal);
  if (models.length > 0) await putModelBlobs(models, { signal });
  throwIfRestoreAborted(signal);
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
      'derived_alignment_frames',
      'app_state',
    ],
    'readwrite',
  );
  const revisionStore = tx.objectStore('app_state');
  const existingRevision = await revisionStore.get(DATASET_REVISION_STATE_KEY);
  for (const row of manifest.records.studies) {
    const existing = await tx.objectStore('studies').get(row.studyInstanceUid);
    const conflict = studyIdentityConflict(existing, row);
    if (conflict) {
      await tx.done;
      throw new Error(`A restored examination conflicts with an existing patient identity. ${conflict}`);
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
    if (row.key.startsWith('acquisition:') && !ownsAcquisitionChoice(row, seriesByUid)) continue;
    if (row.key === DATASET_REVISION_STATE_KEY) {
      archivedRevision = typeof row.value === 'number' ? row.value : 0;
      continue;
    }
    if (
      row.key === SELECTED_PATIENT_STATE_KEY ||
      row.key === SELECTED_PATIENT_STUDY_STATE_KEY ||
      row.key === DATASET_TOKEN_STATE_KEY
    )
      continue;
    await revisionStore.put(row);
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
  for (const row of derivedFrames) {
    await tx
      .objectStore('derived_alignment_frames')
      .put({ ...row, patientKey: restoredIdentities.get(row.targetStudyUid)!, datasetRevision: nextRevision });
  }
  await revisionStore.put({ key: DATASET_REVISION_STATE_KEY, value: nextRevision });
  await revisionStore.put({ key: DATASET_TOKEN_STATE_KEY, value: newDatasetToken() });
  await tx.done;
  await initializeComparisonState(db);

  if (typeof localStorage !== 'undefined') {
    for (const [key, value] of Object.entries(manifest.records.localStorage ?? {})) {
      if (!isOwnedStorageKey(key)) continue;
      try {
        localStorage.setItem(key, value);
      } catch {
        integrityWarnings.add('Some display preferences could not be restored; all medical data was restored safely.');
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
}
