import type { IDBPObjectStore } from 'idb';
import {
  DATASET_TOKEN_STATE_KEY,
  DATASET_REVISION_STATE_KEY,
  DatasetReplacedError,
  getDB,
  newDatasetToken,
  SELECTED_PATIENT_STATE_KEY,
} from './db';
import { getPatientIdentityAliases, getPatientIdentityKeys } from './patientIdentity';
import type { MiraDB, StoredVolumeSegmentationRow, VolumeSegmentationChunk, VolumeSegmentationRow } from './schema';
import {
  isSelectionContextValid,
  isSelectionCoverageValid,
  type SelectionPatch,
} from '../utils/segmentation/selectionEditing';

export const SELECTION_CHUNK_BYTES = 4096;
export const volumeChunkRange = (key: string) => IDBKeyRange.bound([key, 0], [key, Number.MAX_SAFE_INTEGER]);
const STORES = ['app_state', 'studies', 'volume_segmentations', 'volume_segmentation_chunks'] as const;
const revisionOf = (row: StoredVolumeSegmentationRow | undefined) =>
  row ? ('labels' in row ? 'legacy' : row.revision) : null;
export class SavedSelectionChangedError extends Error {
  constructor() {
    super('The saved selection changed. Reopen this reconstruction before saving more edits.');
    this.name = 'SavedSelectionChangedError';
  }
}
type ChunkReader = Pick<
  IDBPObjectStore<MiraDB, ['volume_segmentation_chunks'], 'volume_segmentation_chunks', 'readonly'>,
  'getAll'
>;

function voxelCount(row: Pick<VolumeSegmentationRow, 'dims' | 'clippedNativeVoxels' | 'contextLimited'>) {
  if (!isSelectionCoverageValid(row.clippedNativeVoxels) || !isSelectionContextValid(row.contextLimited))
    throw new Error('The selection has invalid viewing-region coverage. The saved selection is unchanged.');
  const count = row.dims.reduce((total, size) => total * size, 1);
  if (
    row.dims.length !== 3 ||
    row.dims.some((size) => !Number.isSafeInteger(size) || size < 1) ||
    !Number.isSafeInteger(count)
  )
    throw new Error('The saved selection does not match its reconstruction geometry.');
  return count;
}

/** Materialize only for a consumer that needs the complete mask (reopen, copy, backup). */
export async function readStoredVolumeSegmentation(
  row: StoredVolumeSegmentationRow,
  chunks: ChunkReader,
): Promise<VolumeSegmentationRow> {
  if ('labels' in row) return row;
  const { storage, revision, labelBytes, chunkCount, ...metadata } = row;
  const count = voxelCount(row);
  if (
    storage !== 'chunks-v1' ||
    labelBytes !== count ||
    typeof revision !== 'string' ||
    !Number.isSafeInteger(chunkCount) ||
    chunkCount < 0 ||
    chunkCount > Math.ceil(count / SELECTION_CHUNK_BYTES)
  )
    throw new Error('The saved selection has invalid storage metadata.');
  const labels = new Uint8Array(count);
  const storedChunks = await chunks.getAll(volumeChunkRange(row.volumeKey));
  if (storedChunks.length !== chunkCount) throw new Error('The saved selection is missing label chunks.');
  for (const chunk of storedChunks) {
    if (
      !Number.isSafeInteger(chunk.offset) ||
      chunk.offset < 0 ||
      chunk.offset >= count ||
      chunk.offset % SELECTION_CHUNK_BYTES !== 0 ||
      Object.prototype.toString.call(chunk.data) !== '[object Uint8Array]' ||
      chunk.data.length !== Math.min(SELECTION_CHUNK_BYTES, count - chunk.offset)
    )
      throw new Error('The saved selection contains an invalid label chunk.');
    labels.set(chunk.data, chunk.offset);
  }
  return { ...metadata, labels };
}

export type VolumeSegmentationSnapshot = {
  record: VolumeSegmentationRow | null;
  revision: string | null;
  datasetToken: string;
  legacySource?: { volumeKey: string; revision: string; updatedAt: number };
};

export type VolumeSegmentationLookup = {
  studyUid: string;
  patientKey: string;
  datasetRevision: number;
  matches: (record: StoredVolumeSegmentationRow, patientAliases: readonly string[]) => boolean;
};

export async function getVolumeSegmentationSnapshot(
  volumeKey: string,
  lookup?: VolumeSegmentationLookup,
): Promise<VolumeSegmentationSnapshot> {
  const source = lookup && { ...lookup };
  const db = await getDB();
  const tx = db.transaction(STORES);
  const [current, selected, token, studies, datasetRevision] = await Promise.all([
    tx.objectStore('volume_segmentations').get(volumeKey),
    tx.objectStore('app_state').get(SELECTED_PATIENT_STATE_KEY),
    tx.objectStore('app_state').get(DATASET_TOKEN_STATE_KEY),
    tx.objectStore('studies').getAll(),
    source ? tx.objectStore('app_state').get(DATASET_REVISION_STATE_KEY) : undefined,
  ]);
  if (typeof token?.value !== 'string') throw new DatasetReplacedError();
  const selectedPatient = typeof selected?.value === 'string' ? selected.value : null;
  const identities = getPatientIdentityKeys(studies);
  let stored = current;
  let legacySource: VolumeSegmentationSnapshot['legacySource'];
  let aliases: readonly string[] = [];
  if (source) {
    if (
      (datasetRevision?.value ?? 0) !== source.datasetRevision ||
      selectedPatient !== source.patientKey ||
      identities.get(source.studyUid) !== source.patientKey
    )
      throw new SavedSelectionChangedError();
    aliases = getPatientIdentityAliases(studies.find((study) => study.studyInstanceUid === source.studyUid)!);
    if (stored && !source.matches(stored, aliases)) throw new SavedSelectionChangedError();
    if (!stored) {
      // Only a unique exact match can project automatically. Chunk payloads are
      // read after choosing it, not while scanning metadata on other grids.
      let cursor = await tx.objectStore('volume_segmentations').index('by-study').openCursor(source.studyUid);
      while (cursor) {
        if (source.matches(cursor.value, aliases)) {
          if (stored) {
            stored = undefined;
            break;
          }
          stored = cursor.value;
        }
        cursor = await cursor.continue();
      }
      if (stored)
        legacySource = { volumeKey: stored.volumeKey, revision: revisionOf(stored)!, updatedAt: stored.updatedAt };
    }
  }
  const sourcePatient = stored?.studyUid ? identities.get(stored.studyUid) : undefined;
  const owner = sourcePatient ?? stored?.patientKey;
  const visible = owner && selectedPatient && owner !== selectedPatient ? undefined : stored;
  const record = visible
    ? await readStoredVolumeSegmentation(visible, tx.objectStore('volume_segmentation_chunks'))
    : null;
  if (record && record.labels.length !== voxelCount(record))
    throw new Error('The saved selection does not match its reconstruction geometry.');
  if (record && source && !source.matches(record, aliases)) throw new SavedSelectionChangedError();
  await tx.done;
  return {
    record: record && sourcePatient ? { ...record, patientKey: sourcePatient } : record,
    revision: visible && !legacySource ? revisionOf(visible) : null,
    datasetToken: token.value,
    ...(legacySource && { legacySource }),
  };
}

export async function getVolumeSegmentation(volumeKey: string): Promise<VolumeSegmentationRow | null> {
  return (await getVolumeSegmentationSnapshot(volumeKey)).record;
}

export type VolumeSegmentationWrite = {
  expectedRevision: string | null;
  revision: string;
  datasetToken: string;
  patch?: SelectionPatch;
  legacySource?: VolumeSegmentationSnapshot['legacySource'];
};

/**
 * Capture the completed edit before the first await. Transactions, not a
 * component debounce/queue, order writes across mounts. A patch reads/writes
 * only touched chunks; metadata and those chunks commit atomically.
 */
export async function saveVolumeSegmentation(
  record: Omit<VolumeSegmentationRow, 'labels'> & { labels: Uint8Array | null },
  change?: VolumeSegmentationWrite,
): Promise<void> {
  const count = voxelCount(record);
  if (record.labels && record.labels.length !== count)
    throw new Error('Volume segmentation does not match its geometry.');
  const { labels, ...description } = record;
  const metadata = structuredClone(description);
  const { volumeKey } = metadata;
  const guard = change
    ? {
        expectedRevision: change.expectedRevision,
        datasetToken: change.datasetToken,
        ...(change.legacySource && { legacySource: { ...change.legacySource } }),
      }
    : undefined;
  const patch = change?.patch;
  if (
    patch &&
    (!labels ||
      patch.indices.length !== patch.before.length ||
      patch.indices.length !== patch.after.length ||
      patch.indices.some((index, offset) => index >= count || labels[index] !== patch.after[offset]))
  )
    throw new Error('The selection edit does not match its completed mask.');
  // A dense proposal can cost six bytes per changed voxel as a reversible
  // patch. Do not duplicate that payload when one full checkpoint is smaller.
  const captured =
    patch && !guard?.legacySource && patch.indices.byteLength + patch.before.byteLength + patch.after.byteLength < count
      ? { indices: patch.indices.slice(), before: patch.before.slice(), after: patch.after.slice() }
      : undefined;

  const fullChunks: VolumeSegmentationChunk[] = [];
  if (labels && !captured) {
    for (let offset = 0; offset < count; offset += SELECTION_CHUNK_BYTES) {
      const data = labels.subarray(offset, offset + SELECTION_CHUNK_BYTES);
      if (data.some(Boolean)) fullChunks.push({ volumeKey, offset, data: data.slice() });
    }
  }
  const revision = change?.revision ?? newDatasetToken();
  const db = await getDB();
  const tx = db.transaction(STORES, 'readwrite');
  const completion = tx.done;
  void completion.catch(() => {});
  try {
    const [selected, token, studies, previous] = await Promise.all([
      tx.objectStore('app_state').get(SELECTED_PATIENT_STATE_KEY),
      tx.objectStore('app_state').get(DATASET_TOKEN_STATE_KEY),
      tx.objectStore('studies').getAll(),
      tx.objectStore('volume_segmentations').get(volumeKey),
    ]);
    if (guard && token?.value !== guard.datasetToken) throw new DatasetReplacedError();
    if (guard && revisionOf(previous) !== guard.expectedRevision) throw new SavedSelectionChangedError();
    if (guard?.legacySource && !previous) {
      const original = await tx.objectStore('volume_segmentations').get(guard.legacySource.volumeKey);
      if (
        !original ||
        revisionOf(original) !== guard.legacySource.revision ||
        original.updatedAt !== guard.legacySource.updatedAt ||
        original.studyUid !== metadata.studyUid
      )
        throw new SavedSelectionChangedError();
    }
    const selectedPatient = typeof selected?.value === 'string' ? selected.value : null;
    const sourcePatient = metadata.studyUid ? getPatientIdentityKeys(studies).get(metadata.studyUid) : undefined;
    if (metadata.studyUid && !sourcePatient) throw new SavedSelectionChangedError();
    const owner = sourcePatient ?? metadata.patientKey;
    if (owner && selectedPatient && owner !== selectedPatient)
      throw new Error('Cannot save a volume segmentation for another patient');
    if (previous && previous.studyUid !== metadata.studyUid) throw new SavedSelectionChangedError();
    if (
      captured &&
      previous &&
      (voxelCount(previous) !== count ||
        previous.dims.some((size, axis) => size !== metadata.dims[axis]) ||
        ('labels' in previous ? previous.labels.length !== count : previous.labelBytes !== count))
    )
      throw new SavedSelectionChangedError();
    const chunks = tx.objectStore('volume_segmentation_chunks');
    let chunkCount = captured && previous && !('labels' in previous) ? previous.chunkCount : 0;
    if (!captured || (previous && 'labels' in previous)) {
      await chunks.delete(volumeChunkRange(volumeKey));
      if (captured && previous && 'labels' in previous) {
        for (let offset = 0; offset < count; offset += SELECTION_CHUNK_BYTES) {
          const data = previous.labels.subarray(offset, offset + SELECTION_CHUNK_BYTES);
          if (data.some(Boolean)) {
            await chunks.put({ volumeKey, offset, data: data.slice() });
            chunkCount++;
          }
        }
      } else
        for (const chunk of fullChunks) {
          await chunks.put(chunk);
          chunkCount++;
        }
    }
    if (captured) {
      const groups = new Map<number, number[]>();
      for (let i = 0; i < captured.indices.length; i++) {
        const start = Math.floor(captured.indices[i]! / SELECTION_CHUNK_BYTES) * SELECTION_CHUNK_BYTES;
        const offsets = groups.get(start) ?? [];
        offsets.push(i);
        groups.set(start, offsets);
      }
      for (const [offset, offsets] of groups) {
        const existing = await chunks.get([volumeKey, offset]);
        const data = existing?.data ?? new Uint8Array(Math.min(SELECTION_CHUNK_BYTES, count - offset));
        if (data.length !== Math.min(SELECTION_CHUNK_BYTES, count - offset)) throw new SavedSelectionChangedError();
        for (const i of offsets) {
          const index = captured.indices[i]! - offset;
          if (data[index] !== captured.before[i]) throw new SavedSelectionChangedError();
          data[index] = captured.after[i]!;
        }
        if (data.some(Boolean)) {
          await chunks.put({ volumeKey, offset, data });
          if (!existing) chunkCount++;
        } else {
          await chunks.delete([volumeKey, offset]);
          if (existing) chunkCount--;
        }
      }
    }
    await tx.objectStore('volume_segmentations').put({
      ...metadata,
      ...(sourcePatient ? { patientKey: sourcePatient } : {}),
      storage: 'chunks-v1',
      revision,
      labelBytes: count,
      chunkCount,
    });
    await completion;
  } catch (error) {
    try {
      tx.abort();
    } catch {
      /* A failed transaction is already aborted. */
    }
    await completion.catch(() => {});
    throw error;
  }
}

export async function deleteVolumeSegmentation(
  volumeKey: string,
  guard?: Pick<VolumeSegmentationWrite, 'expectedRevision' | 'datasetToken'>,
): Promise<void> {
  const db = await getDB();
  const tx = db.transaction(['app_state', 'volume_segmentations', 'volume_segmentation_chunks'], 'readwrite');
  if (guard) {
    const [token, previous] = await Promise.all([
      tx.objectStore('app_state').get(DATASET_TOKEN_STATE_KEY),
      tx.objectStore('volume_segmentations').get(volumeKey),
    ]);
    if (token?.value !== guard.datasetToken) throw new DatasetReplacedError();
    if (revisionOf(previous) !== guard.expectedRevision) throw new SavedSelectionChangedError();
  }
  await Promise.all([
    tx.objectStore('volume_segmentations').delete(volumeKey),
    tx.objectStore('volume_segmentation_chunks').delete(volumeChunkRange(volumeKey)),
    tx.done,
  ]);
}
