import { openDB } from 'idb';
import type { IDBPDatabase } from 'idb';

export const MODEL_CACHE_DB_NAME = 'miraviewer:model-cache';
const DB_VERSION = 1;
const STORE = 'models';
let modelDbPromise: Promise<IDBPDatabase> | null = null;

export type ModelRecord = {
  key: string;
  blob: Blob;
  savedAtMs: number;
};

async function getDb() {
  if (!modelDbPromise) {
    modelDbPromise = openDB(MODEL_CACHE_DB_NAME, DB_VERSION, {
      upgrade(db) {
        if (!db.objectStoreNames.contains(STORE)) {
          db.createObjectStore(STORE);
        }
      },
      blocking(_currentVersion, _blockedVersion, event) {
        (event.target as IDBDatabase | null)?.close();
        modelDbPromise = null;
      },
      terminated() {
        modelDbPromise = null;
      },
    }).catch((error: unknown) => {
      modelDbPromise = null;
      throw error;
    });
  }
  return modelDbPromise;
}

export async function closeModelCache(): Promise<void> {
  if (!modelDbPromise) return;
  try {
    const db = await modelDbPromise;
    db.close();
  } finally {
    modelDbPromise = null;
  }
}

export async function deleteModelCache(options?: { onBlocked?: () => void }): Promise<void> {
  await closeModelCache();
  await new Promise<void>((resolve, reject) => {
    const request = indexedDB.deleteDatabase(MODEL_CACHE_DB_NAME);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error ?? new Error('Failed to delete the local model cache'));
    request.onblocked = () => options?.onBlocked?.();
  });
}

export async function putModelBlob(key: string, blob: Blob): Promise<void> {
  const db = await getDb();
  const rec: ModelRecord = { key, blob, savedAtMs: Date.now() };
  await db.put(STORE, rec, key);
}

/** Complete all recoverable model-cache writes before a medical-data restore becomes visible. */
export async function putModelBlobs(
  models: ReadonlyArray<Pick<ModelRecord, 'key' | 'blob'>>,
  options: { signal?: AbortSignal } = {},
): Promise<void> {
  if (models.length === 0) return;
  const abortIfRequested = () => {
    if (options.signal?.aborted) throw new DOMException('Backup restoration cancelled.', 'AbortError');
  };
  abortIfRequested();
  const db = await getDb();
  abortIfRequested();
  const transaction = db.transaction(STORE, 'readwrite');
  try {
    for (const model of models) {
      abortIfRequested();
      await transaction.store.put({ key: model.key, blob: model.blob, savedAtMs: Date.now() }, model.key);
    }
    abortIfRequested();
    await transaction.done;
  } catch (error) {
    try {
      transaction.abort();
    } catch {
      // A completed transaction cannot be aborted; its failure still prevents the medical commit.
    }
    await transaction.done.catch(() => {});
    throw error;
  }
}

export async function getModelRecord(key: string): Promise<ModelRecord | null> {
  const db = await getDb();
  return ((await db.get(STORE, key)) as ModelRecord | undefined) ?? null;
}

export async function getModelBlob(key: string): Promise<Blob | null> {
  return (await getModelRecord(key))?.blob ?? null;
}

export async function deleteModelBlob(key: string): Promise<void> {
  const db = await getDb();
  await db.delete(STORE, key);
}

export async function getAllModelRecords(): Promise<ModelRecord[]> {
  const db = await getDb();
  return (await db.getAll(STORE)) as ModelRecord[];
}
