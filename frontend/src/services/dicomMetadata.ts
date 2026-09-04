import dicomParser from 'dicom-parser';
import type { DicomAcquisitionMetadata, DicomInstance } from '../db/schema';
import {
  getSliceGeometryFromInstance,
  parseImageOrientationPatient,
  parseImagePositionPatient,
  parsePixelSpacingMm,
} from '../utils/svr/dicomGeometry';
import { dot } from '../utils/svr/vec3';

export const DICOM_METADATA_VERSION = 1;

// Helper to get text from a dataset
export function getDicomText(dataSet: dicomParser.DataSet, tag: string): string {
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

export function getDicomNumber(dataSet: dicomParser.DataSet, tag: string): number {
  // IMPORTANT: Many numeric DICOM tags are *not* stored as ASCII.
  // For example, Rows/Columns are VR=US (binary). Reading them via dataSet.string()
  // yields garbage (e.g. 64 => "@").
  //
  // We therefore try dicom-parser's typed accessors first, and fall back to
  // string parsing only if needed.

  const knownVr =
    tag === 'x00280010' || tag === 'x00280011' || tag === 'x00280103'
      ? 'US'
      : tag === 'x00200011' || tag === 'x00200013' || tag === 'x00280008'
        ? 'IS'
        : tag === 'x00280120' || tag === 'x00280121'
          ? getDicomNumber(dataSet, 'x00280103') === 1
            ? 'SS'
            : 'US'
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

const text = (dataset: dicomParser.DataSet, tag: string): string | undefined => {
  try {
    return dataset.string(tag)?.trim() || undefined;
  } catch {
    return undefined;
  }
};
const values = (value?: string): string[] =>
  value
    ?.split('\\')
    .map((entry) => entry.trim().toUpperCase())
    .filter(Boolean) ?? [];
const numeric = (dataset: dicomParser.DataSet, tag: string, zero = false): number | undefined => {
  const raw = text(dataset, tag);
  const value = raw ? Number(raw.split('\\')[0]) : NaN;
  return Number.isFinite(value) && (zero ? value >= 0 : value > 0) ? value : undefined;
};
const sourceReferences = (dataset: dicomParser.DataSet): string[] =>
  (dataset.elements.x00082112?.items ?? []).flatMap((item) => {
    const reference = item.dataSet && text(item.dataSet, 'x00081155');
    return reference ? [reference] : [];
  });

/** Shared by new imports and bounded legacy hydration; optional malformed tags do not invent provenance. */
export function extractDicomAcquisitionMetadata(dataset: dicomParser.DataSet): DicomAcquisitionMetadata {
  const acquisitionType = text(dataset, 'x00180023');
  let acquisitionMatrix: DicomAcquisitionMetadata['acquisitionMatrix'];
  try {
    if (dataset.elements.x00181310?.length === 8) {
      const matrix = [0, 1, 2, 3].map((index) => dataset.uint16('x00181310', index));
      if (matrix.every((value) => Number.isSafeInteger(value) && value! >= 0) && matrix.some((value) => value! > 0)) {
        acquisitionMatrix = matrix as NonNullable<typeof acquisitionMatrix>;
      }
    }
  } catch {
    /* Optional malformed acquisition dimensions remain unknown. */
  }
  const acquisitionDate = text(dataset, 'x00080022');
  const acquisitionTime = text(dataset, 'x00080032');
  const dateTime =
    text(dataset, 'x0008002a') ?? (acquisitionDate && acquisitionTime ? acquisitionDate + acquisitionTime : undefined);
  const acquisitionNumber = numeric(dataset, 'x00200012', true);
  return {
    version: 1,
    imageType: values(text(dataset, 'x00080008')),
    mrAcquisitionType: acquisitionType === '2D' || acquisitionType === '3D' ? acquisitionType : undefined,
    acquisitionMatrix,
    reconstructionDiameterMm: numeric(dataset, 'x00181100'),
    percentSampling: numeric(dataset, 'x00180093'),
    percentPhaseFieldOfView: numeric(dataset, 'x00180094'),
    acquisitionNumber: Number.isSafeInteger(acquisitionNumber) ? acquisitionNumber : undefined,
    acquisitionDateTime: dateTime && /^\d{14}(?:\.\d{1,6})?(?:[+-]\d{4})?$/.test(dateTime) ? dateTime : undefined,
    scanningSequence: values(text(dataset, 'x00180020')),
    sequenceVariant: values(text(dataset, 'x00180021')),
    echoTimeMs: numeric(dataset, 'x00180081'),
    repetitionTimeMs: numeric(dataset, 'x00180080'),
    inversionTimeMs: numeric(dataset, 'x00180082'),
    sourceSopInstanceUids: [...new Set(sourceReferences(dataset))],
    derivationSopInstanceUids: [
      ...new Set(
        (dataset.elements.x00089124?.items ?? []).flatMap((item) =>
          item.dataSet ? sourceReferences(item.dataSet) : [],
        ),
      ),
    ],
    derivationDescription: text(dataset, 'x00082111'),
  };
}

export function extractDicomInstanceMetadata(dataset: dicomParser.DataSet): Omit<DicomInstance, 'fileBlob'> {
  const number = (tag: string) => getDicomNumber(dataset, tag);
  const thickness = number('x00180050');
  const spacing = number('x00180088');
  const padding = dataset.elements.x00280120 || text(dataset, 'x00280120') ? number('x00280120') : undefined;
  return mergeDicomInstanceMetadata({
    sopInstanceUid: getDicomText(dataset, 'x00080018'),
    seriesInstanceUid: getDicomText(dataset, 'x0020000e'),
    studyInstanceUid: getDicomText(dataset, 'x0020000d'),
    instanceNumber: number('x00200013'),
    frameOfReferenceUid: text(dataset, 'x00200052'),
    acquisitionTime: text(dataset, 'x00080032'),
    acquisitionMetadata: extractDicomAcquisitionMetadata(dataset),
    numberOfFrames: Math.max(1, Math.round(number('x00280008'))),
    rows: number('x00280010'),
    columns: number('x00280011'),
    sliceLocation: number('x00201041'),
    imagePositionPatient: getDicomText(dataset, 'x00200032'),
    imageOrientationPatient: getDicomText(dataset, 'x00200037'),
    pixelSpacing: getDicomText(dataset, 'x00280030'),
    sliceThickness: thickness > 0 ? thickness : undefined,
    spacingBetweenSlices: spacing > 0 ? spacing : undefined,
    pixelPaddingValue: padding,
    pixelPaddingRangeLimit:
      padding !== undefined && (dataset.elements.x00280121 || text(dataset, 'x00280121'))
        ? number('x00280121')
        : undefined,
    windowCenter: number('x00281050'),
    windowWidth: number('x00281051'),
  });
}

const missing = (value: unknown) =>
  value === undefined || value === null || (typeof value === 'string' && !value.trim());

const positiveInteger = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
const coordinates = (value: object): number[] =>
  Object.values(value).flatMap((entry) =>
    typeof entry === 'object' && entry !== null ? coordinates(entry) : typeof entry === 'number' ? [entry] : [],
  );

/** Fill unknown metadata from a verified header; never overwrite conflicting valid geometry or source identity. */
export function mergeDicomInstanceMetadata<T extends Omit<DicomInstance, 'fileBlob'>>(
  existing: T,
  incoming?: Omit<DicomInstance, 'fileBlob'> | null,
): T {
  const result = { ...existing };
  if (incoming) {
    for (const field of ['sopInstanceUid', 'seriesInstanceUid', 'studyInstanceUid', 'frameOfReferenceUid'] as const) {
      if (!missing(existing[field]) && !missing(incoming[field]) && existing[field] !== incoming[field])
        throw new Error('Stored DICOM metadata does not match its admitted image identity.');
    }
    for (const field of Object.keys(incoming) as (keyof typeof incoming)[]) {
      if (missing(result[field]) && !missing(incoming[field])) Object.assign(result, { [field]: incoming[field] });
    }
    for (const field of ['rows', 'columns', 'numberOfFrames'] as const) {
      if (positiveInteger(existing[field]) && positiveInteger(incoming[field]) && existing[field] !== incoming[field])
        throw new Error('Stored DICOM metadata does not match its admitted image dimensions.');
      if (!positiveInteger(existing[field]) && positiveInteger(incoming[field]))
        Object.assign(result, { [field]: incoming[field] });
    }
    for (const [field, parse] of [
      ['imagePositionPatient', parseImagePositionPatient],
      ['imageOrientationPatient', parseImageOrientationPatient],
      ['pixelSpacing', parsePixelSpacingMm],
    ] as const) {
      const left = parse(existing[field]),
        right = parse(incoming[field]);
      if (left && right) {
        const expected = coordinates(right);
        if (coordinates(left).some((value, axis) => Math.abs(value - expected[axis]!) > 1e-6))
          throw new Error('Stored DICOM metadata does not match its admitted image geometry.');
      }
      if (!left && right) Object.assign(result, { [field]: incoming[field] });
    }
    if (result.acquisitionMetadata?.unavailable && !incoming.acquisitionMetadata?.unavailable)
      result.acquisitionMetadata = incoming.acquisitionMetadata;
  }
  result.acquisitionMetadata ??= {
    version: 1,
    imageType: [],
    sourceSopInstanceUids: [],
    derivationSopInstanceUids: [],
    unavailable: true,
  };
  const axes = parseImageOrientationPatient(result.imageOrientationPatient);
  const point = parseImagePositionPatient(result.imagePositionPatient);
  result.physicalSlicePosition = axes && point ? dot(axes.normalDir, point) : undefined;
  result.metadataVersion = DICOM_METADATA_VERSION;
  return (Object.keys(result) as (keyof T)[]).every((field) => Object.is(result[field], existing[field]))
    ? existing
    : result;
}

export function needsDicomHeader(instance: Omit<DicomInstance, 'fileBlob'>): boolean {
  if (
    !instance.acquisitionMetadata ||
    instance.acquisitionMetadata.unavailable ||
    missing(instance.frameOfReferenceUid)
  )
    return true;
  try {
    getSliceGeometryFromInstance(instance);
    return false;
  } catch {
    return true;
  }
}

export const MAX_DICOM_HEADER_BYTES = 2 * 1024 * 1024;

/** Read metadata without decoding pixels or retaining parser exceptions that may contain patient tags. */
export async function readDicomInstanceMetadata(
  instance: DicomInstance,
  signal?: AbortSignal,
): Promise<Omit<DicomInstance, 'fileBlob'> | null> {
  const abort = () => {
    if (signal?.aborted) throw new DOMException('Acquisition metadata loading canceled.', 'AbortError');
  };
  const maximum = Math.min(instance.fileBlob.size, MAX_DICOM_HEADER_BYTES);
  for (let size = Math.min(32 * 1024, maximum); size > 0; size = Math.min(maximum, size * 2)) {
    abort();
    const bytes = new Uint8Array(await instance.fileBlob.slice(0, size).arrayBuffer());
    abort();
    let dataset: dicomParser.DataSet | undefined;
    try {
      const parsed = dicomParser.parseDicom(bytes, { untilTag: 'x7fe00010' });
      if (parsed.elements.x7fe00010) dataset = parsed;
    } catch {
      /* A longer header may still parse; raw parser errors stay private. */
    }
    if (dataset) {
      if (
        text(dataset, 'x00080018') !== instance.sopInstanceUid ||
        text(dataset, 'x0020000e') !== instance.seriesInstanceUid ||
        text(dataset, 'x0020000d') !== instance.studyInstanceUid
      )
        throw new Error('Stored acquisition metadata does not match its admitted image identity.');
      return extractDicomInstanceMetadata(dataset);
    }
    if (size === maximum) break;
  }
  abort();
  return null;
}
