import { studyIdentityConflict } from '../db/patientIdentity';
import dicomParser from 'dicom-parser';
import { assertStorageHeadroom, DATASET_REVISION_STATE_KEY, getDB, notifyDatasetMutation } from '../db/db';
import { initializeComparisonState } from '../db/comparisonState';
import type { DicomStudy, DicomSeries, DicomInstance } from '../db/schema';
import {
  DICOM_METADATA_VERSION,
  extractDicomInstanceMetadata,
  mergeDicomInstanceMetadata,
  getDicomNumber as getNumber,
  getDicomText as getText,
} from './dicomMetadata';
import { parseSeriesDescription } from '../utils/dicomSeriesParsing';
import {
  parseImageOrientationPatient,
  parseImagePositionPatient,
  parsePixelSpacingMm,
} from '../utils/svr/dicomGeometry';

export type DicomIngestResult =
  | { status: 'ingested'; fileName: string; sopInstanceUid: string }
  | { status: 'duplicate'; fileName: string; sopInstanceUid: string; metadataUpdated?: true }
  | {
      status: 'skipped';
      fileName: string;
      reason:
        | 'non-dicom-file'
        | 'non-displayable'
        | 'missing-uids'
        | 'secondary-capture'
        | 'excluded-localizer-orientation'
        | 'excluded-incompatible-series-orientation';
    }
  | {
      status: 'error';
      fileName: string;
      reason: 'parse-error' | 'db-error' | 'unsupported-multiframe';
      message: string;
    };

export type ProcessFilesResult = {
  total: number;
  ingested: number;
  duplicates: number;
  metadataUpdated?: number;
  skipped: number;
  errors: number;
  /** A small sample of error messages (bounded) for display in the UI. */
  errorSamples: string[];
  skipReasons?: Partial<Record<Extract<DicomIngestResult, { status: 'skipped' }>['reason'], number>>;
  errorReasons?: Partial<Record<Extract<DicomIngestResult, { status: 'error' }>['reason'], number>>;
  cancelled?: boolean;
  affectedSeriesUids?: string[];
};

export type ProcessFilesProgress = Pick<
  ProcessFilesResult,
  'ingested' | 'duplicates' | 'metadataUpdated' | 'skipped' | 'errors'
> & {
  fileName?: string;
};

export type ProcessFilesOptions = {
  signal?: AbortSignal;
  total?: number;
  batchMaxItems?: number;
  batchMaxBytes?: number;
  probeDuplicates?: boolean;
};

type PreparedDicom = {
  status: 'prepared';
  fileName: string;
  file: File;
  study: DicomStudy;
  series: DicomSeries;
  instance: Omit<DicomInstance, 'fileBlob'>;
  sopClassUid: string;
  imageType: string;
};

type ProbedDicom = {
  status: 'probed';
  fileName: string;
  file: File;
  instance: Pick<DicomInstance, 'sopInstanceUid' | 'studyInstanceUid' | 'seriesInstanceUid'>;
};

function basename(filename: string): string {
  // ZIP entries often come through with "folders" in their name (e.g. "1.2.3/IM0001").
  // Most of our heuristics (hidden file check, extension check) should only look at the
  // last path segment.
  const normalized = filename.replace(/\\/g, '/');
  const parts = normalized.split('/');
  return parts[parts.length - 1] || filename;
}

/**
 * Returns true if this dataset looks like a DICOM *image* we can actually display.
 *
 * Why this exists:
 * - Real-world DICOM folders often contain non-image objects (e.g. SR, PR, RTSTRUCT, etc.)
 * - They may parse fine, but have no pixel data, and will fail at display time.
 *
 * We prefer to skip these at ingestion so they:
 * - don't inflate instance counts
 * - don't create "broken" slices while scrolling
 * - don't waste IndexedDB space
 */
function hasDisplayablePixelData(dataSet: dicomParser.DataSet): boolean {
  // Pixel Data: (7FE0,0010)
  const pixelDataEl = (dataSet as unknown as { elements?: Record<string, { length?: number }> }).elements?.x7fe00010;
  if (!pixelDataEl) return false;

  // Some transfer syntaxes use an undefined length (e.g. encapsulated/compressed),
  // so we only reject explicit zero-length payloads.
  if (typeof pixelDataEl.length === 'number' && pixelDataEl.length === 0) return false;

  // Rows/Columns should be present for displayable images.
  const rowsNum = getNumber(dataSet, 'x00280010');
  const colsNum = getNumber(dataSet, 'x00280011');
  if (!Number.isFinite(rowsNum) || !Number.isFinite(colsNum) || rowsNum <= 0 || colsNum <= 0) return false;

  return true;
}

function inferPlaneFromImageOrientationPatient(iop: string): string | undefined {
  const axes = parseImageOrientationPatient(iop);
  if (!axes) return undefined;

  const ax = Math.abs(axes.normalDir.x);
  const ay = Math.abs(axes.normalDir.y);
  const az = Math.abs(axes.normalDir.z);

  // In DICOM patient coordinates:
  // - Normal ~ X (L/R) => sagittal slices
  // - Normal ~ Y (A/P) => coronal slices
  // - Normal ~ Z (H/F) => axial slices
  if (ax >= ay && ax >= az) return 'Sagittal';
  if (ay >= ax && ay >= az) return 'Coronal';
  return 'Axial';
}

// DICOM Tags
const TAGS = {
  PatientName: 'x00100010',
  PatientID: 'x00100020',
  PatientIDIssuer: 'x00100021',
  StudyInstanceUID: 'x0020000d',
  StudyDate: 'x00080020',
  StudyTime: 'x00080030',
  AcquisitionTime: 'x00080032',
  StudyDescription: 'x00081030',
  AccessionNumber: 'x00080050',
  Modality: 'x00080060',

  SeriesInstanceUID: 'x0020000e',
  SeriesDescription: 'x0008103e',
  ProtocolName: 'x00181030',
  SequenceName: 'x00180024',
  SeriesNumber: 'x00200011',

  // SOP Class UID identifies the *type* of object (MR Image Storage vs Secondary Capture, etc.).
  ImageType: 'x00080008',
  SOPClassUID: 'x00080016',
  SOPInstanceUID: 'x00080018',
  InstanceNumber: 'x00200013',
  FrameOfReferenceUID: 'x00200052',
  NumberOfFrames: 'x00280008',

  Rows: 'x00280010',
  Columns: 'x00280011',
  PixelPaddingValue: 'x00280120',
  PixelPaddingRangeLimit: 'x00280121',
  SliceLocation: 'x00201041',
  ImagePositionPatient: 'x00200032',
  ImageOrientationPatient: 'x00200037',
  PixelSpacing: 'x00280030',
  SliceThickness: 'x00180050',
  SpacingBetweenSlices: 'x00180088',
  WindowCenter: 'x00281050',
  WindowWidth: 'x00281051',
};

// Common non-DICOM file extensions to skip
const SKIP_EXTENSIONS = new Set(
  [
    '.txt .md .json .xml .html .htm .css .js',
    '.jpg .jpeg .png .gif .bmp .tiff .pdf',
    '.zip .tar .gz .rar .7z',
    '.doc .docx .xls .xlsx .ppt .pptx',
    '.log .csv .ini .cfg .conf',
    '.ds_store .gitignore .gitkeep',
  ]
    .join(' ')
    .split(' '),
);

function shouldSkipFile(filename: string): boolean {
  const base = basename(filename);
  const lower = base.toLowerCase();

  // Skip hidden files
  if (lower.startsWith('.')) return true;

  // Skip known non-DICOM extensions
  const dot = lower.lastIndexOf('.');
  const ext = dot >= 0 ? lower.slice(dot) : '';
  if (ext && SKIP_EXTENSIONS.has(ext)) return true;

  return false;
}

export function isDicomCandidate(filename: string): boolean {
  return !shouldSkipFile(filename);
}

async function prepareDicomFile(file: File): Promise<DicomIngestResult | PreparedDicom> {
  const fileName = basename(file.name);

  // Skip files that are obviously not DICOM
  if (shouldSkipFile(file.name)) {
    return { status: 'skipped', fileName, reason: 'non-dicom-file' };
  }

  let dataSet: dicomParser.DataSet;
  try {
    const arrayBuffer = await file.arrayBuffer();
    const byteArray = new Uint8Array(arrayBuffer);

    // Quick check for DICOM magic bytes (DICM at offset 128).
    // Note: The preamble is optional in DICOM. We do not use this check to skip ingestion.
    // Some real-world archives lack the preamble and would otherwise be skipped.
    void (
      byteArray.length > 132 &&
      byteArray[128] === 0x44 && // D
      byteArray[129] === 0x49 && // I
      byteArray[130] === 0x43 && // C
      byteArray[131] === 0x4d // M
    );

    // Parse DICOM
    dataSet = dicomParser.parseDicom(byteArray);
  } catch {
    // dicom-parser exceptions can retain the complete dataset, patient tags, and pixels.
    console.error('Failed to parse a DICOM image safely');
    return { status: 'error', fileName, reason: 'parse-error', message: 'Invalid or unsupported DICOM data.' };
  }

  // Filter out non-image (or otherwise non-displayable) DICOM objects.
  // We do this before writing anything to IndexedDB.
  if (!hasDisplayablePixelData(dataSet)) {
    return { status: 'skipped', fileName, reason: 'non-displayable' };
  }

  const numberOfFrames = Math.max(1, Math.round(getNumber(dataSet, TAGS.NumberOfFrames)));
  if (numberOfFrames > 1) {
    return {
      status: 'error',
      fileName,
      reason: 'unsupported-multiframe',
      message: `Enhanced multi-frame DICOM (${numberOfFrames} frames) is not supported yet; no incomplete series was imported.`,
    };
  }

  // Secondary Capture (SOPClassUID=1.2.840.10008.5.1.4.1.1.7*) is commonly included in
  // exports as "Screenshots". These are typically 8-bit RGB images and not part of the
  // actual scan stack. Importing them pollutes "Unknown" sequences and can make
  // auto-alignment look broken (because it's trying to align screenshots to MR volumes).
  const sopClassUid = getText(dataSet, TAGS.SOPClassUID);
  if (sopClassUid.startsWith('1.2.840.10008.5.1.4.1.1.7')) {
    return { status: 'skipped', fileName, reason: 'secondary-capture' };
  }

  // Extract UIDs
  const studyUid = getText(dataSet, TAGS.StudyInstanceUID);
  const seriesUid = getText(dataSet, TAGS.SeriesInstanceUID);
  const instanceUid = getText(dataSet, TAGS.SOPInstanceUID);

  if (!studyUid || !seriesUid || !instanceUid) {
    console.warn('A DICOM image is missing required examination identifiers');
    return { status: 'skipped', fileName, reason: 'missing-uids' };
  }

  // Extract Study Info
  const study: DicomStudy = {
    studyInstanceUid: studyUid,
    studyDate: getText(dataSet, TAGS.StudyDate),
    studyTime: getText(dataSet, TAGS.StudyTime) || undefined,
    studyDescription: getText(dataSet, TAGS.StudyDescription) || 'No Description',
    patientName: getText(dataSet, TAGS.PatientName),
    patientId: getText(dataSet, TAGS.PatientID),
    patientIdIssuer: getText(dataSet, TAGS.PatientIDIssuer) || undefined,
    modality: getText(dataSet, TAGS.Modality),
    accessionNumber: getText(dataSet, TAGS.AccessionNumber),
  };

  // Extract Series Info
  const seriesDesc = getText(dataSet, TAGS.SeriesDescription);
  const protocolName = getText(dataSet, TAGS.ProtocolName);
  const sequenceName = getText(dataSet, TAGS.SequenceName);

  const seriesClassificationText = [seriesDesc, protocolName, sequenceName].filter(Boolean).join(' | ');
  const parsedSeries = parseSeriesDescription(seriesClassificationText);

  // Fallback: derive plane from orientation if text parsing didn't find it.
  const iop = getText(dataSet, TAGS.ImageOrientationPatient);
  const imagePosition = getText(dataSet, TAGS.ImagePositionPatient);
  const pixelSpacing = getText(dataSet, TAGS.PixelSpacing);
  for (const [value, parser, label, consequence] of [
    [iop, parseImageOrientationPatient, 'image orientation', 'positioned'],
    [imagePosition, parseImagePositionPatient, 'image position', 'positioned'],
    [pixelSpacing, parsePixelSpacingMm, 'pixel spacing', 'calibrated'],
  ] as const) {
    if (value && !parser(value)) {
      return {
        status: 'error',
        fileName,
        reason: 'parse-error',
        message: `Invalid DICOM ${label}; the frame cannot be ${consequence} safely.`,
      };
    }
  }
  const frameOfReferenceUid = getText(dataSet, TAGS.FrameOfReferenceUID) || undefined;
  const acquisitionTime = getText(dataSet, TAGS.AcquisitionTime) || undefined;
  const planeFromOrientation = iop ? inferPlaneFromImageOrientationPatient(iop) : undefined;
  const rows = getNumber(dataSet, TAGS.Rows);
  const columns = getNumber(dataSet, TAGS.Columns);

  const series: DicomSeries = {
    seriesInstanceUid: seriesUid,
    studyInstanceUid: studyUid,
    seriesDescription: seriesDesc || 'No Description',
    seriesNumber: getNumber(dataSet, TAGS.SeriesNumber),
    modality: getText(dataSet, TAGS.Modality),

    protocolName: protocolName || undefined,
    sequenceName: sequenceName || undefined,
    frameOfReferenceUid,
    acquisitionTime,
    rows,
    columns,
    pixelSpacing: pixelSpacing || undefined,
    imageOrientationPatient: iop || undefined,

    plane: planeFromOrientation ?? parsedSeries.plane,
    weight: parsedSeries.weight,
    sequenceType: parsedSeries.sequenceType,
  };

  // Import and legacy header enrichment share one canonical metadata extractor.
  const instance = extractDicomInstanceMetadata(dataSet);

  return {
    status: 'prepared',
    fileName,
    file,
    study,
    series,
    instance,
    sopClassUid,
    imageType: getText(dataSet, TAGS.ImageType),
  };
}

class DicomAdmissionError extends Error {}

const DEFAULT_BATCH_MAX_ITEMS = 64;
const DEFAULT_BATCH_MAX_BYTES = 16 * 1024 * 1024;
const ESTIMATED_IMAGE_METADATA_BYTES = 1024;
const DUPLICATE_PROBE_MIN_FILE_BYTES = 32 * 1024;
const DUPLICATE_HEADER_PROBE_BYTES = [4096, 16 * 1024] as const;

function databaseError(fileName: string, error: unknown): DicomIngestResult {
  console.error('A DICOM image could not be admitted to local storage safely');
  const quotaExceeded =
    typeof error === 'object' &&
    error !== null &&
    'name' in error &&
    (error.name === 'QuotaExceededError' ||
      ('message' in error &&
        typeof error.message === 'string' &&
        error.message.startsWith('Insufficient browser storage')));
  const message =
    error instanceof DicomAdmissionError
      ? error.message
      : quotaExceeded
        ? 'Insufficient browser storage for this import.'
        : 'Failed to store the DICOM image safely.';
  return { status: 'error', fileName, reason: 'db-error', message };
}

function persistedOwnershipResult(
  existing: Pick<DicomInstance, 'seriesInstanceUid' | 'studyInstanceUid'>,
  next: PreparedDicom | ProbedDicom,
): DicomIngestResult {
  if (
    existing.seriesInstanceUid === next.instance.seriesInstanceUid &&
    existing.studyInstanceUid === next.instance.studyInstanceUid
  ) {
    return { status: 'duplicate', fileName: next.fileName, sopInstanceUid: next.instance.sopInstanceUid };
  }
  return databaseError(
    next.fileName,
    new DicomAdmissionError('A DICOM instance UID already belongs to a different examination'),
  );
}

async function probeDicomIdentity(file: File): Promise<ProbedDicom | undefined> {
  if (file.size < DUPLICATE_PROBE_MIN_FILE_BYTES || shouldSkipFile(file.name)) return undefined;
  for (const windowBytes of DUPLICATE_HEADER_PROBE_BYTES) {
    let dataSet: dicomParser.DataSet | undefined;
    try {
      const bytes = new Uint8Array(await file.slice(0, windowBytes).arrayBuffer());
      try {
        dataSet = dicomParser.parseDicom(bytes, { untilTag: TAGS.SeriesInstanceUID });
      } catch (error) {
        // dicom-parser deliberately returns successfully decoded leading tags on
        // bounded-input exhaustion. Never publish its patient-bearing exception.
        if (typeof error === 'object' && error && 'dataSet' in error) {
          dataSet = error.dataSet as dicomParser.DataSet;
        }
      }
      if (!dataSet || getText(dataSet, TAGS.SOPClassUID).startsWith('1.2.840.10008.5.1.4.1.1.7')) continue;
      const sopInstanceUid = getText(dataSet, TAGS.SOPInstanceUID);
      const studyInstanceUid = getText(dataSet, TAGS.StudyInstanceUID);
      const seriesInstanceUid = getText(dataSet, TAGS.SeriesInstanceUID);
      if (sopInstanceUid && studyInstanceUid && seriesInstanceUid) {
        return {
          status: 'probed',
          fileName: basename(file.name),
          file,
          instance: { sopInstanceUid, studyInstanceUid, seriesInstanceUid },
        };
      }
    } catch {
      // Short, compressed, malformed, or vendor-specific headers fall back to
      // the original complete-image parser without weakening its validation.
    }
  }
  return undefined;
}

async function readPersistedOwnership(
  candidates: readonly (PreparedDicom | ProbedDicom)[],
  database?: Awaited<ReturnType<typeof getDB>>,
): Promise<Map<string, DicomInstance | undefined>> {
  const db = database ?? (await getDB());
  const transaction = db.transaction('instances', 'readonly');
  const instanceUids = Array.from(new Set(candidates.map((candidate) => candidate.instance.sopInstanceUid)));
  const [instances] = await Promise.all([
    Promise.all(instanceUids.map((instanceUid) => transaction.store.get(instanceUid))),
    transaction.done,
  ]);
  return new Map(instanceUids.map((instanceUid, index) => [instanceUid, instances[index]]));
}

function missingCanonicalValue(value: unknown): boolean {
  return value === undefined || value === null || (typeof value === 'string' && !value.trim());
}

function enrichCanonicalParent<T extends object>(existing: T | undefined, incoming: T): { value: T; changed: boolean } {
  if (!existing) return { value: incoming, changed: true };
  let value = existing;
  for (const key of Object.keys(incoming) as (keyof T)[]) {
    if (!missingCanonicalValue(existing[key]) || missingCanonicalValue(incoming[key])) continue;
    if (value === existing) value = { ...existing };
    value[key] = incoming[key];
  }
  return { value, changed: value !== existing };
}

function validateCanonicalParents(
  existingStudy: DicomStudy | undefined,
  existingSeries: DicomSeries | undefined,
  next: PreparedDicom,
): void {
  const study = next.study;
  const series = next.series;
  const identityConflict = studyIdentityConflict(existingStudy, study);
  if (identityConflict) throw new DicomAdmissionError(identityConflict);
  if (existingSeries && existingSeries.studyInstanceUid !== study.studyInstanceUid) {
    throw new DicomAdmissionError('A series UID cannot belong to a different examination');
  }
  if (
    existingSeries?.frameOfReferenceUid &&
    series.frameOfReferenceUid &&
    existingSeries.frameOfReferenceUid !== series.frameOfReferenceUid
  ) {
    throw new DicomAdmissionError('A series cannot mix incompatible spatial frames of reference');
  }
  if (
    existingSeries &&
    (((existingSeries.rows ?? 0) > 0 && existingSeries.rows !== series.rows) ||
      ((existingSeries.columns ?? 0) > 0 && existingSeries.columns !== series.columns))
  ) {
    throw new DicomAdmissionError('A series cannot mix incompatible row or column dimensions');
  }
  if (existingSeries?.pixelSpacing && series.pixelSpacing) {
    const expectedSpacing = parsePixelSpacingMm(existingSeries.pixelSpacing);
    const actualSpacing = parsePixelSpacingMm(series.pixelSpacing);
    if (
      expectedSpacing &&
      actualSpacing &&
      (Math.abs(expectedSpacing.rowSpacingMm - actualSpacing.rowSpacingMm) > 1e-6 ||
        Math.abs(expectedSpacing.colSpacingMm - actualSpacing.colSpacingMm) > 1e-6)
    ) {
      throw new DicomAdmissionError('A series cannot mix incompatible calibrated row or column spacing');
    }
  }
  if (existingSeries?.imageOrientationPatient && series.imageOrientationPatient) {
    const expectedAxes = parseImageOrientationPatient(existingSeries.imageOrientationPatient);
    const actualAxes = parseImageOrientationPatient(series.imageOrientationPatient);
    if (expectedAxes && actualAxes) {
      const aligned = (['rowDir', 'colDir', 'normalDir'] as const).every((axis) => {
        const expected = expectedAxes[axis];
        const actual = actualAxes[axis];
        return expected.x * actual.x + expected.y * actual.y + expected.z * actual.z >= 0.999;
      });
      if (!aligned) throw new DicomAdmissionError('A series cannot mix incompatible slice orientations');
    }
  }
}

function isLocalizerOrientationConflict(candidate: PreparedDicom, error: unknown): boolean {
  if (!(error instanceof DicomAdmissionError) || !error.message.includes('slice orientations')) return false;
  return /(?:locali[sz]er|scout|survey)/i.test(
    [candidate.series.seriesDescription, candidate.series.protocolName, candidate.series.sequenceName]
      .filter(Boolean)
      .join(' '),
  );
}

function isOrthogonalOriginalMrOrientationConflict(
  existingSeries: DicomSeries | undefined,
  candidate: PreparedDicom,
  error: unknown,
): boolean {
  if (!(error instanceof DicomAdmissionError) || !error.message.includes('slice orientations')) return false;
  if (
    candidate.sopClassUid !== '1.2.840.10008.5.1.4.1.1.4' ||
    candidate.series.modality !== 'MR' ||
    !/(?:^|\\)ORIGINAL(?:\\|$)/i.test(candidate.imageType) ||
    !/(?:^|\\)PRIMARY(?:\\|$)/i.test(candidate.imageType) ||
    !existingSeries?.frameOfReferenceUid ||
    existingSeries.frameOfReferenceUid !== candidate.series.frameOfReferenceUid ||
    !candidate.instance.imagePositionPatient ||
    !existingSeries.imageOrientationPatient ||
    !candidate.series.imageOrientationPatient
  ) {
    return false;
  }
  const canonical = parseImageOrientationPatient(existingSeries.imageOrientationPatient);
  const incoming = parseImageOrientationPatient(candidate.series.imageOrientationPatient);
  if (!canonical || !incoming) return false;
  const dot = (left: { x: number; y: number; z: number }, right: { x: number; y: number; z: number }) =>
    left.x * right.x + left.y * right.y + left.z * right.z;
  const normalsOrthogonal = Math.abs(dot(canonical.normalDir, incoming.normalDir)) <= 0.01;
  const rowsShared = dot(canonical.rowDir, incoming.rowDir) >= 0.999;
  const columnsShared = dot(canonical.colDir, incoming.colDir) >= 0.999;
  const rowsOrthogonal = Math.abs(dot(canonical.rowDir, incoming.rowDir)) <= 0.01;
  const columnsOrthogonal = Math.abs(dot(canonical.colDir, incoming.colDir)) <= 0.01;
  return normalsOrthogonal && ((rowsShared && columnsOrthogonal) || (columnsShared && rowsOrthogonal));
}

function throwIfImportAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new DOMException('DICOM import cancelled.', 'AbortError');
}

function isImportAbort(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'name' in error && error.name === 'AbortError';
}

async function writePreparedBatch(candidates: PreparedDicom[], signal?: AbortSignal): Promise<DicomIngestResult[]> {
  if (!candidates.length || signal?.aborted) return [];
  const db = await getDB();
  const ownership = await readPersistedOwnership(candidates, db);
  if (signal?.aborted) return [];

  const results: (DicomIngestResult | undefined)[] = Array(candidates.length);
  const incoming = new Set<string>();
  let incrementalBytes = 0;
  for (let index = 0; index < candidates.length; index += 1) {
    const candidate = candidates[index];
    const instanceUid = candidate.instance.sopInstanceUid;
    const existing = ownership.get(instanceUid);
    if (existing) {
      const ownership = persistedOwnershipResult(existing, candidate);
      if (ownership.status === 'error') results[index] = ownership;
      else {
        try {
          const updated = mergeDicomInstanceMetadata(existing, candidate.instance);
          if (
            (Object.keys(updated) as (keyof DicomInstance)[]).every((field) =>
              Object.is(updated[field], existing[field]),
            )
          )
            results[index] = ownership;
        } catch (error) {
          results[index] = databaseError(candidate.fileName, error);
        }
      }
      continue;
    }
    if (!incoming.has(instanceUid)) {
      incoming.add(instanceUid);
      incrementalBytes += candidate.file.size + ESTIMATED_IMAGE_METADATA_BYTES;
    }
  }
  if (candidates.every((_, index) => results[index] !== undefined)) return results as DicomIngestResult[];
  if (incrementalBytes) await assertStorageHeadroom(incrementalBytes);
  if (signal?.aborted) return [];

  const tx = db.transaction(['studies', 'series', 'instances', 'app_state'], 'readwrite');
  const studies = tx.objectStore('studies');
  const series = tx.objectStore('series');
  const instances = tx.objectStore('instances');
  const state = tx.objectStore('app_state');
  const stagedStudies = new Map<string, DicomStudy>();
  const stagedSeries = new Map<string, DicomSeries>();
  const changedStudies = new Set<string>();
  const changedSeries = new Set<string>();
  const stagedInstances = new Map<string, DicomInstance>();
  const accepted: { candidate: PreparedDicom; index: number; instance: DicomInstance; isNew: boolean }[] = [];
  try {
    const revision = await state.get(DATASET_REVISION_STATE_KEY);
    for (let index = 0; index < candidates.length; index += 1) {
      throwIfImportAborted(signal);
      if (results[index]) continue;
      const candidate = candidates[index];
      const instanceUid = candidate.instance.sopInstanceUid;
      const existingInstance = stagedInstances.get(instanceUid) ?? (await instances.get(instanceUid));
      if (existingInstance) {
        const ownership = persistedOwnershipResult(existingInstance, candidate);
        if (ownership.status === 'error') {
          results[index] = ownership;
          continue;
        }
      }

      const studyUid = candidate.study.studyInstanceUid;
      const seriesUid = candidate.series.seriesInstanceUid;
      const existingStudy = stagedStudies.get(studyUid) ?? (await studies.get(studyUid));
      const existingSeries = stagedSeries.get(seriesUid) ?? (await series.get(seriesUid));
      let instance: DicomInstance;
      try {
        validateCanonicalParents(existingStudy, existingSeries, candidate);
        instance = existingInstance
          ? mergeDicomInstanceMetadata(existingInstance, candidate.instance)
          : {
              ...candidate.instance,
              fileBlob: new Blob([candidate.file], { type: candidate.file.type || 'application/dicom' }),
            };
      } catch (error) {
        if (isLocalizerOrientationConflict(candidate, error)) {
          results[index] = {
            status: 'skipped',
            fileName: candidate.fileName,
            reason: 'excluded-localizer-orientation',
          };
        } else if (isOrthogonalOriginalMrOrientationConflict(existingSeries, candidate, error)) {
          results[index] = {
            status: 'skipped',
            fileName: candidate.fileName,
            reason: 'excluded-incompatible-series-orientation',
          };
        } else {
          results[index] = databaseError(candidate.fileName, error);
        }
        continue;
      }

      const mergedStudy = enrichCanonicalParent(existingStudy, candidate.study);
      const mergedSeries = enrichCanonicalParent(existingSeries, candidate.series);
      stagedStudies.set(studyUid, mergedStudy.value);
      stagedSeries.set(seriesUid, mergedSeries.value);
      if (mergedStudy.changed) changedStudies.add(studyUid);
      if (mergedSeries.changed) changedSeries.add(seriesUid);
      stagedInstances.set(instanceUid, instance);
      const changed =
        !existingInstance ||
        mergedStudy.changed ||
        mergedSeries.changed ||
        (Object.keys(instance) as (keyof DicomInstance)[]).some(
          (field) => !Object.is(instance[field], existingInstance[field]),
        );
      if (changed) accepted.push({ candidate, index, instance, isNew: !existingInstance });
      results[index] = existingInstance
        ? {
            status: 'duplicate',
            fileName: candidate.fileName,
            sopInstanceUid: instanceUid,
            ...(changed ? { metadataUpdated: true as const } : {}),
          }
        : { status: 'ingested', fileName: candidate.fileName, sopInstanceUid: instanceUid };
    }

    if (accepted.length) {
      for (const uid of changedStudies) {
        throwIfImportAborted(signal);
        await studies.put(stagedStudies.get(uid)!);
      }
      for (const uid of changedSeries) {
        throwIfImportAborted(signal);
        await series.put(stagedSeries.get(uid)!);
      }
      for (const { instance } of accepted) {
        throwIfImportAborted(signal);
        // Store as Blob to maximize IndexedDB compatibility across browsers.
        await instances.put(instance);
      }
      throwIfImportAborted(signal);
      const previousRevision = typeof revision?.value === 'number' ? revision.value : 0;
      const added = accepted.filter((item) => item.isNew).length;
      if (added) await state.put({ key: DATASET_REVISION_STATE_KEY, value: previousRevision + added });
    }
    await tx.done;
  } catch (error) {
    try {
      tx.abort();
    } catch {
      // An already-aborted transaction has no remaining work to cancel.
    }
    await tx.done.catch(() => undefined);
    if (isImportAbort(error)) return [];
    for (const { candidate, index } of accepted) results[index] = databaseError(candidate.fileName, error);
    for (let index = 0; index < candidates.length; index += 1) {
      if (!results[index]) results[index] = databaseError(candidates[index].fileName, error);
    }
    return results as DicomIngestResult[];
  }

  for (const uid of new Set(accepted.map(({ candidate }) => candidate.series.seriesInstanceUid))) {
    notifyDatasetMutation(uid);
  }
  return results as DicomIngestResult[];
}

export async function processDicomFile(file: File): Promise<DicomIngestResult> {
  try {
    const prepared = await prepareDicomFile(file);
    if (prepared.status !== 'prepared') return prepared;
    const result = (await writePreparedBatch([prepared]))[0];
    if (result.status === 'ingested' || (result.status === 'duplicate' && result.metadataUpdated))
      await initializeComparisonState(await getDB());
    return result;
  } catch (error) {
    return databaseError(basename(file.name), error);
  }
}

export async function processFiles(
  files: File[] | AsyncIterable<File>,
  onProgress?: (current: number, total: number, detail?: ProcessFilesProgress) => void,
  options: ProcessFilesOptions = {},
): Promise<ProcessFilesResult> {
  const { signal } = options;
  const knownTotal = options.total ?? (Array.isArray(files) ? files.length : undefined);
  const result: ProcessFilesResult = {
    total: knownTotal ?? 0,
    ingested: 0,
    duplicates: 0,
    skipped: 0,
    errors: 0,
    errorSamples: [],
  };
  if (signal?.aborted) return { ...result, cancelled: true };
  const maxItems = Math.max(1, Math.floor(options.batchMaxItems ?? DEFAULT_BATCH_MAX_ITEMS));
  const maxBytes = Math.max(1, Math.floor(options.batchMaxBytes ?? DEFAULT_BATCH_MAX_BYTES));
  const affectedSeries = new Set<string>();
  let probeDuplicates = options.probeDuplicates ?? (await (await getDB()).count('instances')) > 0;
  const pending: (PreparedDicom | ProbedDicom | DicomIngestResult)[] = [];
  let pendingBytes = 0;
  let completed = 0;

  const publish = (outcome: DicomIngestResult) => {
    if (outcome.status === 'ingested') result.ingested += 1;
    else if (outcome.status === 'duplicate') {
      result.duplicates += 1;
      if (outcome.metadataUpdated) result.metadataUpdated = (result.metadataUpdated ?? 0) + 1;
    } else if (outcome.status === 'skipped') {
      result.skipped += 1;
      result.skipReasons ??= {};
      result.skipReasons[outcome.reason] = (result.skipReasons[outcome.reason] ?? 0) + 1;
    } else {
      result.errors += 1;
      result.errorReasons ??= {};
      result.errorReasons[outcome.reason] = (result.errorReasons[outcome.reason] ?? 0) + 1;
    }
    if (outcome.status === 'error' && result.errorSamples.length < 3) {
      result.errorSamples.push(`${outcome.fileName}: ${outcome.message}`);
    }
    completed += 1;
    if (!onProgress) return;
    if (onProgress.length > 2) {
      onProgress(completed, result.total, {
        ingested: result.ingested,
        duplicates: result.duplicates,
        ...(result.metadataUpdated ? { metadataUpdated: result.metadataUpdated } : {}),
        skipped: result.skipped,
        errors: result.errors,
        fileName: outcome.fileName,
      });
    } else {
      // Existing callers and test doubles observe exactly the historical two arguments.
      onProgress(completed, result.total);
    }
  };

  const flush = async () => {
    if (!pending.length) return;
    const probes = pending.filter((candidate): candidate is ProbedDicom => candidate.status === 'probed');
    if (probes.length) {
      const ownership = await readPersistedOwnership(probes);
      let duplicatesFound = 0;
      for (let index = 0; index < pending.length; index += 1) {
        const candidate = pending[index];
        if (candidate.status !== 'probed') continue;
        const existing = ownership.get(candidate.instance.sopInstanceUid);
        const existingResult = existing ? persistedOwnershipResult(existing, candidate) : undefined;
        if (
          existing &&
          existingResult &&
          (existingResult.status === 'error' ||
            (existing.metadataVersion === DICOM_METADATA_VERSION &&
              existing.acquisitionMetadata?.version === 1 &&
              !existing.acquisitionMetadata.unavailable))
        ) {
          pending[index] = existingResult;
          if (pending[index].status === 'duplicate') duplicatesFound += 1;
        } else {
          pending[index] = await prepareDicomFile(candidate.file);
        }
      }
      // Avoid double-parsing an entire new examination simply because unrelated
      // prior scans are already present in the user's local database.
      if (!duplicatesFound) probeDuplicates = false;
    }
    const prepared = pending.filter((candidate): candidate is PreparedDicom => candidate.status === 'prepared');
    let written: DicomIngestResult[] = [];
    if (prepared.length) {
      try {
        written = await writePreparedBatch(prepared, signal);
      } catch (error) {
        if (isImportAbort(error)) return;
        written = prepared.map((candidate) => databaseError(candidate.fileName, error));
      }
      if (!written.length && signal?.aborted) return;
    }
    let writtenIndex = 0;
    for (const candidate of pending) {
      const outcome = candidate.status === 'prepared' ? written[writtenIndex++] : (candidate as DicomIngestResult);
      if (
        candidate.status === 'prepared' &&
        (outcome.status === 'ingested' || (outcome.status === 'duplicate' && outcome.metadataUpdated))
      ) {
        affectedSeries.add(candidate.series.seriesInstanceUid);
      }
      // A completed transaction is indivisible: report every durable row even if a
      // progress callback requests cancellation while this batch is being published.
      publish(outcome);
    }
    pending.length = 0;
    pendingBytes = 0;
  };

  let iteratorCancelled = false;
  try {
    for await (const file of files) {
      throwIfImportAborted(signal);
      if (knownTotal === undefined) result.total += 1;
      if (pending.length && (pending.length >= maxItems || pendingBytes + file.size > maxBytes)) {
        await flush();
        throwIfImportAborted(signal);
      }

      let candidate: PreparedDicom | ProbedDicom | DicomIngestResult;
      try {
        candidate = (probeDuplicates && (await probeDicomIdentity(file))) || (await prepareDicomFile(file));
      } catch {
        console.error('Failed to inspect a DICOM image safely');
        candidate = {
          status: 'error',
          fileName: basename(file.name),
          reason: 'parse-error',
          message: 'Invalid or unsupported DICOM data.',
        };
      }
      throwIfImportAborted(signal);
      pending.push(candidate);
      if (candidate.status === 'prepared' || candidate.status === 'probed') pendingBytes += file.size;
      if (pending.length >= maxItems || pendingBytes >= maxBytes) await flush();
      throwIfImportAborted(signal);
    }
    if (!signal?.aborted) await flush();
  } catch (error) {
    if (!isImportAbort(error)) throw error;
    iteratorCancelled = true;
  }
  if (iteratorCancelled || signal?.aborted) result.cancelled = true;
  if (affectedSeries.size) {
    await initializeComparisonState(await getDB());
    result.affectedSeriesUids = [...affectedSeries];
  }
  return result;
}
