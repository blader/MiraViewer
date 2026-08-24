import dicomParser from 'dicom-parser';
import { assertStorageHeadroom, DATASET_REVISION_STATE_KEY, getDB, notifyDatasetMutation } from '../db/db';
import type { DicomStudy, DicomSeries, DicomInstance } from '../db/schema';
import { parseSeriesDescription } from '../utils/dicomSeriesParsing';
import {
  parseImageOrientationPatient,
  parseImagePositionPatient,
  parsePixelSpacingMm,
} from '../utils/svr/dicomGeometry';

export type DicomIngestResult =
  | { status: 'ingested'; fileName: string; sopInstanceUid: string }
  | { status: 'duplicate'; fileName: string; sopInstanceUid: string }
  | {
      status: 'skipped';
      fileName: string;
      reason: 'non-dicom-file' | 'non-displayable' | 'missing-uids' | 'secondary-capture';
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
  skipped: number;
  errors: number;
  /** A small sample of error messages (bounded) for display in the UI. */
  errorSamples: string[];
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

// Helper to get text from a dataset
function getText(dataSet: dicomParser.DataSet, tag: string): string {
  return dataSet.string(tag) || '';
}

const NUMERIC_ACCESSORS = {
  DS: 'floatString',
  IS: 'intString',
  US: 'uint16',
  SS: 'int16',
  UL: 'uint32',
  SL: 'int32',
  FL: 'float',
  FD: 'double',
} as const;

function getNumber(dataSet: dicomParser.DataSet, tag: string): number {
  // IMPORTANT: Many numeric DICOM tags are *not* stored as ASCII.
  // For example, Rows/Columns are VR=US (binary). Reading them via dataSet.string()
  // yields garbage (e.g. 64 => "@").
  //
  // We therefore try dicom-parser's typed accessors first, and fall back to
  // string parsing only if needed.

  const knownVr =
    tag === 'x00280010' || tag === 'x00280011'
      ? 'US'
      : tag === 'x00200011' || tag === 'x00200013' || tag === 'x00280008'
        ? 'IS'
        : undefined;
  const vr = dataSet.elements?.[tag]?.vr ?? knownVr;
  const preferred = vr ? NUMERIC_ACCESSORS[vr as keyof typeof NUMERIC_ACCESSORS] : undefined;
  const candidates = preferred
    ? [preferred, NUMERIC_ACCESSORS.DS, NUMERIC_ACCESSORS.IS]
    : Object.values(NUMERIC_ACCESSORS);

  for (const accessor of candidates) {
    try {
      const value = dataSet[accessor](tag, 0);
      if (typeof value === 'number' && Number.isFinite(value)) return value;
    } catch {
      // Malformed optional values must not abort an otherwise valid import.
    }
  }

  let str: string | undefined;
  try {
    str = dataSet.string(tag, 0);
  } catch {
    return 0;
  }
  if (!str) return 0;

  // Handle multi-value strings by taking the first value.
  const first = str.includes('\\') ? str.split('\\')[0] : str;
  const parsed = parseFloat(first);
  return Number.isFinite(parsed) ? parsed : 0;
}

function toErrorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
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

function physicalSlicePosition(orientation: string, position: string): number | undefined {
  const axes = parseImageOrientationPatient(orientation);
  const point = parseImagePositionPatient(position);
  if (!axes || !point) return undefined;
  const projection = axes.normalDir.x * point.x + axes.normalDir.y * point.y + axes.normalDir.z * point.z;
  return Number.isFinite(projection) ? projection : undefined;
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
  SOPClassUID: 'x00080016',
  SOPInstanceUID: 'x00080018',
  InstanceNumber: 'x00200013',
  FrameOfReferenceUID: 'x00200052',
  NumberOfFrames: 'x00280008',

  Rows: 'x00280010',
  Columns: 'x00280011',
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

export async function processDicomFile(file: File): Promise<DicomIngestResult> {
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
  } catch (err) {
    console.error('Failed to parse a DICOM image:', err);
    return { status: 'error', fileName, reason: 'parse-error', message: toErrorMessage(err) };
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

  // Extract Instance Info
  // Handle multi-value strings for arrays
  // Window Center/Width can be multi-value. `getNumber()` takes the first value.
  const wc = getNumber(dataSet, TAGS.WindowCenter);
  const ww = getNumber(dataSet, TAGS.WindowWidth);

  const sliceThickness = getNumber(dataSet, TAGS.SliceThickness);
  const spacingBetweenSlices = getNumber(dataSet, TAGS.SpacingBetweenSlices);

  const instanceBase = {
    sopInstanceUid: instanceUid,
    seriesInstanceUid: seriesUid,
    studyInstanceUid: studyUid,
    instanceNumber: getNumber(dataSet, TAGS.InstanceNumber),
    frameOfReferenceUid,
    acquisitionTime,
    numberOfFrames,
    physicalSlicePosition: physicalSlicePosition(iop, imagePosition),
    rows,
    columns,
    sliceLocation: getNumber(dataSet, TAGS.SliceLocation),
    imagePositionPatient: imagePosition,
    imageOrientationPatient: iop,
    pixelSpacing: pixelSpacing,
    sliceThickness: sliceThickness > 0 ? sliceThickness : undefined,
    spacingBetweenSlices: spacingBetweenSlices > 0 ? spacingBetweenSlices : undefined,
    windowCenter: wc,
    windowWidth: ww,
  };

  try {
    const db = await getDB();
    const instance: DicomInstance = {
      ...instanceBase,
      // Store as Blob to maximize IndexedDB compatibility across browsers.
      fileBlob: new Blob([file], { type: file.type || 'application/dicom' }),
    };

    const tx = db.transaction(['studies', 'series', 'instances', 'app_state'], 'readwrite');
    const studyStore = tx.objectStore('studies');
    const seriesStore = tx.objectStore('series');
    const instanceStore = tx.objectStore('instances');
    const existingInstance = await instanceStore.get(instanceUid);
    if (existingInstance) {
      if (existingInstance.seriesInstanceUid !== seriesUid || existingInstance.studyInstanceUid !== studyUid) {
        await tx.done;
        throw new Error('A DICOM instance UID already belongs to a different examination');
      }
      await tx.done;
      return { status: 'duplicate', fileName, sopInstanceUid: instanceUid };
    }

    const existingStudy = await studyStore.get(studyUid);
    if (existingStudy?.patientId && study.patientId && existingStudy.patientId !== study.patientId) {
      await tx.done;
      throw new Error('A study UID cannot contain more than one patient identity');
    }
    if (
      existingStudy?.patientIdIssuer &&
      study.patientIdIssuer &&
      existingStudy.patientIdIssuer !== study.patientIdIssuer
    ) {
      await tx.done;
      throw new Error('A study UID cannot contain more than one patient-identifier issuer');
    }
    const existingSeries = await seriesStore.get(seriesUid);
    if (existingSeries && existingSeries.studyInstanceUid !== studyUid) {
      await tx.done;
      throw new Error('A series UID cannot belong to a different examination');
    }
    if (
      existingSeries?.frameOfReferenceUid &&
      frameOfReferenceUid &&
      existingSeries.frameOfReferenceUid !== frameOfReferenceUid
    ) {
      await tx.done;
      throw new Error('A series cannot mix incompatible spatial frames of reference');
    }
    if (existingSeries?.imageOrientationPatient && iop) {
      const expectedAxes = parseImageOrientationPatient(existingSeries.imageOrientationPatient);
      const actualAxes = parseImageOrientationPatient(iop);
      if (expectedAxes && actualAxes) {
        const similarity =
          expectedAxes.normalDir.x * actualAxes.normalDir.x +
          expectedAxes.normalDir.y * actualAxes.normalDir.y +
          expectedAxes.normalDir.z * actualAxes.normalDir.z;
        if (similarity < 0.999) {
          await tx.done;
          throw new Error('A series cannot mix incompatible slice orientations');
        }
      }
    }

    await studyStore.put(existingStudy ? { ...study, ...existingStudy } : study);
    await seriesStore.put(existingSeries ? { ...series, ...existingSeries } : series);
    await instanceStore.put(instance);
    const stateStore = tx.objectStore('app_state');
    const revision = await stateStore.get(DATASET_REVISION_STATE_KEY);
    const nextRevision = (typeof revision?.value === 'number' ? revision.value : 0) + 1;
    await stateStore.put({ key: DATASET_REVISION_STATE_KEY, value: nextRevision });
    await tx.done;
    notifyDatasetMutation(seriesUid);

    return { status: 'ingested', fileName, sopInstanceUid: instanceUid };
  } catch (err) {
    console.error('Failed to write a DICOM image to local storage:', err);
    return { status: 'error', fileName, reason: 'db-error', message: toErrorMessage(err) };
  }
}

export async function processFiles(
  files: File[],
  onProgress?: (current: number, total: number) => void,
): Promise<ProcessFilesResult> {
  await assertStorageHeadroom(files.reduce((total, file) => total + file.size, 0));
  const result: ProcessFilesResult = {
    total: files.length,
    ingested: 0,
    duplicates: 0,
    skipped: 0,
    errors: 0,
    errorSamples: [],
  };

  let count = 0;
  for (const file of files) {
    let r: DicomIngestResult;
    try {
      r = await processDicomFile(file);
    } catch (error) {
      r = { status: 'error', fileName: basename(file.name), reason: 'parse-error', message: toErrorMessage(error) };
    }
    if (r.status === 'ingested') result.ingested += 1;
    else if (r.status === 'duplicate') result.duplicates += 1;
    else if (r.status === 'skipped') result.skipped += 1;
    else result.errors += 1;

    if (r.status === 'error' && result.errorSamples.length < 3) {
      result.errorSamples.push(`${r.fileName}: ${r.message}`);
    }

    count += 1;
    if (onProgress) onProgress(count, files.length);
  }

  return result;
}
