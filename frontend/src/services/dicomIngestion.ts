import dicomParser from 'dicom-parser';
import { getDB } from '../db/db';
import type { DicomStudy, DicomSeries, DicomInstance } from '../db/schema';
import { parseSeriesDescription } from '../utils/dicomSeriesParsing';

export type DicomIngestResult =
  | { status: 'ingested'; fileName: string; sopInstanceUid: string }
  | { status: 'duplicate'; fileName: string; sopInstanceUid: string }
  | {
      status: 'skipped';
      fileName: string;
      reason: 'non-dicom-file' | 'non-displayable' | 'missing-uids' | 'secondary-capture';
    }
  | { status: 'error'; fileName: string; reason: 'parse-error' | 'db-error'; message: string };

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

function getNumber(dataSet: dicomParser.DataSet, tag: string): number {
  // IMPORTANT: Many numeric DICOM tags are *not* stored as ASCII.
  // For example, Rows/Columns are VR=US (binary). Reading them via dataSet.string()
  // yields garbage (e.g. 64 => "@").
  //
  // We therefore try dicom-parser's typed accessors first, and fall back to
  // string parsing only if needed.

  const vr = dataSet.elements?.[tag]?.vr;

  const fromTypedAccessor = (): number | undefined => {
    switch (vr) {
      case 'DS':
        return dataSet.floatString(tag, 0);
      case 'IS':
        return dataSet.intString(tag, 0);
      case 'US':
        return dataSet.uint16(tag, 0);
      case 'SS':
        return dataSet.int16(tag, 0);
      case 'UL':
        return dataSet.uint32(tag, 0);
      case 'SL':
        return dataSet.int32(tag, 0);
      case 'FL':
        return dataSet.float(tag, 0);
      case 'FD':
        return dataSet.double(tag, 0);
      default:
        return undefined;
    }
  };

  const fromCommonAccessors = (): number | undefined => {
    // If VR is missing (common in implicit VR transfer syntaxes), try the
    // most common numeric accessors in a safe order.
    return (
      dataSet.floatString(tag, 0) ??
      dataSet.intString(tag, 0) ??
      dataSet.uint16(tag, 0) ??
      dataSet.int16(tag, 0) ??
      dataSet.uint32(tag, 0) ??
      dataSet.int32(tag, 0) ??
      dataSet.float(tag, 0) ??
      dataSet.double(tag, 0)
    );
  };

  const n = fromTypedAccessor() ?? fromCommonAccessors();
  if (typeof n === 'number' && Number.isFinite(n)) {
    return n;
  }

  const str = dataSet.string(tag, 0);
  if (!str) return 0;

  // Handle multi-value strings by taking the first value.
  const first = str.includes('\\') ? str.split('\\')[0] : str;
  const parsed = parseFloat(first);
  return Number.isFinite(parsed) ? parsed : 0;
}

function toErrorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function parseMultiNumberString(value: string): number[] {
  // Multi-valued DICOM tags are typically separated by backslashes.
  // Some exporters may use spaces/commas; accept those as well.
  return value
    .split(/[\\,\s]+/)
    .filter(Boolean)
    .map((s) => Number.parseFloat(s))
    .filter((n) => Number.isFinite(n));
}

function inferPlaneFromImageOrientationPatient(iop: string): string | undefined {
  // ImageOrientationPatient (0020,0037) is 6 values: row cosines (3) + column cosines (3).
  // The slice normal is row x col. Dominant axis of the normal indicates plane.
  const nums = parseMultiNumberString(iop);
  if (nums.length < 6) return undefined;

  const r0 = nums[0] ?? 0;
  const r1 = nums[1] ?? 0;
  const r2 = nums[2] ?? 0;
  const c0 = nums[3] ?? 0;
  const c1 = nums[4] ?? 0;
  const c2 = nums[5] ?? 0;

  // Cross product r x c
  const nx = r1 * c2 - r2 * c1;
  const ny = r2 * c0 - r0 * c2;
  const nz = r0 * c1 - r1 * c0;

  const ax = Math.abs(nx);
  const ay = Math.abs(ny);
  const az = Math.abs(nz);

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
  StudyInstanceUID: 'x0020000d',
  StudyDate: 'x00080020',
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

  Rows: 'x00280010',
  Columns: 'x00280011',
  SliceLocation: 'x00201041',
  ImagePositionPatient: 'x00200032',
  ImageOrientationPatient: 'x00200037',
  PixelSpacing: 'x00280030',
  SliceThickness: 'x00180050',
  WindowCenter: 'x00281050',
  WindowWidth: 'x00281051',
};

// Common non-DICOM file extensions to skip
const SKIP_EXTENSIONS = new Set([
  '.txt', '.md', '.json', '.xml', '.html', '.htm', '.css', '.js',
  '.jpg', '.jpeg', '.png', '.gif', '.bmp', '.tiff', '.pdf',
  '.zip', '.tar', '.gz', '.rar', '.7z',
  '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx',
  '.log', '.csv', '.ini', '.cfg', '.conf',
  '.ds_store', '.gitignore', '.gitkeep',
]);

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
      byteArray[131] === 0x4D // M
    );

    // Parse DICOM
    dataSet = dicomParser.parseDicom(byteArray);
  } catch (err) {
    console.error('Error parsing DICOM file:', file.name, err);
    return { status: 'error', fileName, reason: 'parse-error', message: toErrorMessage(err) };
  }

  // Filter out non-image (or otherwise non-displayable) DICOM objects.
  // We do this before writing anything to IndexedDB.
  if (!hasDisplayablePixelData(dataSet)) {
    return { status: 'skipped', fileName, reason: 'non-displayable' };
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
    console.warn('Missing UIDs in DICOM file:', file.name);
    return { status: 'skipped', fileName, reason: 'missing-uids' };
  }

  // Extract Study Info
  const study: DicomStudy = {
    studyInstanceUid: studyUid,
    studyDate: getText(dataSet, TAGS.StudyDate),
    studyDescription: getText(dataSet, TAGS.StudyDescription) || 'No Description',
    patientName: getText(dataSet, TAGS.PatientName),
    patientId: getText(dataSet, TAGS.PatientID),
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
  const planeFromOrientation = iop ? inferPlaneFromImageOrientationPatient(iop) : undefined;

  const series: DicomSeries = {
    seriesInstanceUid: seriesUid,
    studyInstanceUid: studyUid,
    seriesDescription: seriesDesc || 'No Description',
    seriesNumber: getNumber(dataSet, TAGS.SeriesNumber),
    modality: getText(dataSet, TAGS.Modality),

    protocolName: protocolName || undefined,
    sequenceName: sequenceName || undefined,

    plane: parsedSeries.plane ?? planeFromOrientation,
    weight: parsedSeries.weight,
    sequenceType: parsedSeries.sequenceType,
  };

  // Extract Instance Info
  // Handle multi-value strings for arrays
  const pixelSpacing = getText(dataSet, TAGS.PixelSpacing); // "row\\col"

  // Window Center/Width can be multi-value. `getNumber()` takes the first value.
  const wc = getNumber(dataSet, TAGS.WindowCenter);
  const ww = getNumber(dataSet, TAGS.WindowWidth);

  const instanceBase = {
    sopInstanceUid: instanceUid,
    seriesInstanceUid: seriesUid,
    studyInstanceUid: studyUid,
    instanceNumber: getNumber(dataSet, TAGS.InstanceNumber),
    rows: getNumber(dataSet, TAGS.Rows),
    columns: getNumber(dataSet, TAGS.Columns),
    sliceLocation: getNumber(dataSet, TAGS.SliceLocation),
    imagePositionPatient: getText(dataSet, TAGS.ImagePositionPatient),
    imageOrientationPatient: getText(dataSet, TAGS.ImageOrientationPatient),
    pixelSpacing: pixelSpacing,
    sliceThickness: getNumber(dataSet, TAGS.SliceThickness),
    windowCenter: wc,
    windowWidth: ww,
  };

  try {
    const db = await getDB();

    // Duplicate protection: if an instance with this SOPInstanceUID already exists,
    // don't store it again. This makes uploads idempotent and avoids wasting space.
    //
    // Note: Use getKey() so we don't read the whole value (which includes a Blob).
    const existingKey = await db.getKey('instances', instanceUid);
    if (existingKey) {
      // Defensive: make sure study/series exist (these are small records).
      const hasStudy = await db.getKey('studies', studyUid);
      if (!hasStudy) await db.put('studies', study);

      const hasSeries = await db.getKey('series', seriesUid);
      if (!hasSeries) await db.put('series', series);

      return { status: 'duplicate', fileName, sopInstanceUid: instanceUid };
    }

    // New instance: store study/series + the instance Blob.
    // We use put() which acts as upsert.
    const instance: DicomInstance = {
      ...instanceBase,
      // Store as Blob to maximize IndexedDB compatibility across browsers.
      fileBlob: new Blob([file], { type: file.type || 'application/dicom' }),
    };

    await db.put('studies', study);
    await db.put('series', series);
    await db.put('instances', instance);

    return { status: 'ingested', fileName, sopInstanceUid: instanceUid };
  } catch (err) {
    console.error('Error writing DICOM to IndexedDB:', file.name, err);
    return { status: 'error', fileName, reason: 'db-error', message: toErrorMessage(err) };
  }
}

export async function processFiles(
  files: File[],
  onProgress?: (current: number, total: number) => void
): Promise<ProcessFilesResult> {
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
    const r = await processDicomFile(file);
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
