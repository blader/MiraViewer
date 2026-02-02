import { openDB } from 'idb';

const DB_NAME = 'miraviewer:model-cache';
const DB_VERSION = 1;
const STORE = 'models';

type ModelRecord = {
  key: string;
  blob: Blob;
  savedAtMs: number;
};

async function getDb() {
  return openDB(DB_NAME, DB_VERSION, {
    upgrade(db) {
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE);
      }
    },
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
