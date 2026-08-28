import dicomParser from 'dicom-parser';
import type { DicomAcquisitionMetadata, DicomInstance } from '../db/schema';

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

export const MAX_ACQUISITION_HEADER_BYTES = 2 * 1024 * 1024;

/** Read metadata without decoding pixels or retaining parser exceptions that may contain patient tags. */
export async function readDicomAcquisitionMetadata(
  instance: DicomInstance,
  signal?: AbortSignal,
): Promise<DicomAcquisitionMetadata> {
  const abort = () => {
    if (signal?.aborted) throw new DOMException('Acquisition metadata loading canceled.', 'AbortError');
  };
  const maximum = Math.min(instance.fileBlob.size, MAX_ACQUISITION_HEADER_BYTES);
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
      return extractDicomAcquisitionMetadata(dataset);
    }
    if (size === maximum) break;
  }
  abort();
  return { version: 1, imageType: [], sourceSopInstanceUids: [], derivationSopInstanceUids: [], unavailable: true };
}
