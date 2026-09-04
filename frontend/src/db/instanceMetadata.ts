import type { IDBPTransaction } from 'idb';
import {
  DATASET_REVISION_STATE_KEY,
  DATASET_TOKEN_STATE_KEY,
  getDB,
  notifyDatasetMutation,
  SELECTED_PATIENT_STATE_KEY,
} from './db';
import { getPatientIdentityKeys } from './patientIdentity';
import type { DicomInstance, MiraDB } from './schema';
import {
  DICOM_METADATA_VERSION,
  needsDicomHeader,
  mergeDicomInstanceMetadata,
  readDicomInstanceMetadata,
} from '../services/dicomMetadata';
import type { SeriesFrameManifest } from '../utils/localApi';

type MetadataTransaction = IDBPTransaction<
  MiraDB,
  ['instances', 'app_state', 'studies', 'series'],
  'readonly' | 'readwrite'
>;
const METADATA_STORES = ['instances', 'app_state', 'studies', 'series'] as const;
export type MetadataHydrationOptions = {
  signal?: AbortSignal;
  datasetRevision?: number;
  datasetToken?: string;
  selectedPatientKey?: string | null;
};
const frameIdentity = (frame: Omit<DicomInstance, 'fileBlob'>) =>
  JSON.stringify([
    frame.sopInstanceUid,
    frame.seriesInstanceUid,
    frame.studyInstanceUid,
    frame.frameOfReferenceUid,
    frame.rows,
    frame.columns,
    frame.imagePositionPatient,
    frame.imageOrientationPatient,
    frame.pixelSpacing,
    frame.sliceThickness,
    frame.spacingBetweenSlices,
    frame.numberOfFrames,
  ]);

/** Enrich legacy rows from their own immutable Blob; no image replacement, reimport, or dataset revision change. */
export async function hydrateDicomMetadata(
  manifest: Pick<SeriesFrameManifest, 'seriesUid' | 'studyUid' | 'patientKey' | 'frames'>,
  options: MetadataHydrationOptions = {},
): Promise<void> {
  const abort = () => {
    if (options.signal?.aborted) throw new DOMException('Acquisition metadata loading canceled.', 'AbortError');
  };
  abort();
  const db = await getDB();
  let expectedRevision = options.datasetRevision;
  let expectedToken = options.datasetToken;
  let expectedPatient = options.selectedPatientKey;
  const assertScope = async (transaction: MetadataTransaction) => {
    abort();
    const [revisionRow, tokenRow, patientRow, studies, series] = await Promise.all([
      transaction.objectStore('app_state').get(DATASET_REVISION_STATE_KEY),
      transaction.objectStore('app_state').get(DATASET_TOKEN_STATE_KEY),
      transaction.objectStore('app_state').get(SELECTED_PATIENT_STATE_KEY),
      transaction.objectStore('studies').getAll(),
      transaction.objectStore('series').get(manifest.seriesUid),
    ]);
    const revision = typeof revisionRow?.value === 'number' ? revisionRow.value : 0;
    const patient = typeof patientRow?.value === 'string' ? patientRow.value : null;
    expectedRevision ??= revision;
    expectedToken ??= typeof tokenRow?.value === 'string' ? tokenRow.value : undefined;
    if (expectedPatient === undefined) expectedPatient = patient;
    const patientKeys = getPatientIdentityKeys(studies);
    if (
      revision !== expectedRevision ||
      typeof expectedToken !== 'string' ||
      tokenRow?.value !== expectedToken ||
      patient !== expectedPatient ||
      !series ||
      series.studyInstanceUid !== manifest.studyUid ||
      patientKeys.get(manifest.studyUid) !== manifest.patientKey ||
      (patient !== null && patient !== manifest.patientKey)
    )
      throw new Error(
        'The currently selected patient or MRI dataset changed while loading acquisition metadata. Refresh the examination.',
      );
    abort();
  };
  const readScope = db.transaction(METADATA_STORES, 'readonly');
  await assertScope(readScope);
  await readScope.done;
  const missing = manifest.frames.filter((frame) => frame.metadataVersion !== DICOM_METADATA_VERSION);
  for (let offset = 0; offset < missing.length; offset += 32) {
    abort();
    const batch = missing.slice(offset, offset + 32);
    const transaction = db.transaction(METADATA_STORES, 'readonly');
    await assertScope(transaction);
    const stored = await Promise.all(
      batch.map((frame) => transaction.objectStore('instances').get(frame.sopInstanceUid)),
    );
    await transaction.done;
    const instances = stored.map((instance, index) => {
      if (!instance || frameIdentity(instance) !== frameIdentity(batch[index]!))
        throw new Error('The stored MRI source changed while loading acquisition metadata. Refresh the examination.');
      return instance;
    });
    const metadata: DicomInstance[] = [];
    for (let start = 0; start < instances.length; start += 4)
      metadata.push(
        ...(await Promise.all(
          instances
            .slice(start, start + 4)
            .map(async (instance) =>
              mergeDicomInstanceMetadata(
                instance,
                needsDicomHeader(instance) ? await readDicomInstanceMetadata(instance, options.signal) : undefined,
              ),
            ),
        )),
      );
    const write = db.transaction(METADATA_STORES, 'readwrite');
    try {
      await assertScope(write);
      const current = await Promise.all(
        instances.map((instance) => write.objectStore('instances').get(instance.sopInstanceUid)),
      );
      for (let index = 0; index < instances.length; index++) {
        abort();
        const before = instances[index]!,
          row = current[index];
        if (
          !row ||
          frameIdentity(row) !== frameIdentity(before) ||
          row.fileBlob.size !== before.fileBlob.size ||
          row.fileBlob.type !== before.fileBlob.type
        )
          throw new Error('The stored MRI source changed while loading acquisition metadata. Refresh the examination.');
        const updated =
          row.metadataVersion === DICOM_METADATA_VERSION ? row : mergeDicomInstanceMetadata(row, metadata[index]!);
        if (updated !== row) await write.objectStore('instances').put(updated);
      }
      await write.done;
      notifyDatasetMutation(manifest.seriesUid);
    } catch (error) {
      try {
        write.abort();
      } catch {
        /* Already completed or aborted. */
      }
      await write.done.catch(() => {});
      throw error;
    }
  }
  abort();
}
