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

export async function getModelBlob(key: string): Promise<Blob | null> {
  const db = await getDb();
  const rec = (await db.get(STORE, key)) as ModelRecord | undefined;
  return rec?.blob ?? null;
}

export async function deleteModelBlob(key: string): Promise<void> {
  const db = await getDb();
  await db.delete(STORE, key);
}

export async function getModelSavedAtMs(key: string): Promise<number | null> {
  const db = await getDb();
  const rec = (await db.get(STORE, key)) as ModelRecord | undefined;
  return rec?.savedAtMs ?? null;
}

export async function getAllModelRecords(): Promise<ModelRecord[]> {
  const db = await getDb();
  return (await db.getAll(STORE)) as ModelRecord[];
}
