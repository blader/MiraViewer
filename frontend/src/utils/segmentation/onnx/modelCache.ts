import { openDB, type IDBPDatabase } from 'idb';
import { getDB } from '../../../db/db';
import type { MiraDB, ModelRecord } from '../../../db/schema';

export type { ModelRecord } from '../../../db/schema';
/** Retained only for importing caches written before the shared database. */
export const MODEL_CACHE_DB_NAME = 'miraviewer:model-cache';
const MIGRATED = 'model_cache_migrated';
const migrations = new WeakMap<IDBPDatabase<MiraDB>, Promise<void>>();

function abort(transaction: { abort(): void }) {
  try {
    transaction.abort();
  } catch {
    // A committed transaction is already durable and cannot be rolled back.
  }
}

/** One model authority, in the same database/transaction boundary as saved MRI. */
export async function prepareModelStore(db?: IDBPDatabase<MiraDB>): Promise<IDBPDatabase<MiraDB>> {
  const database = db ?? (await getDB());
  let migration = migrations.get(database);
  if (!migration) {
    migration = (async () => {
      if ((await database.get('app_state', MIGRATED))?.value === true) return;
      // Upgrading closes old cache writers before taking their snapshot. An
      // interrupted copy can retry from this unchanged store; bytes are not
      // deleted or shadow-read after the new store becomes authoritative.
      const legacy = await openDB(MODEL_CACHE_DB_NAME, 2, {
        upgrade(cache) {
          if (!cache.objectStoreNames.contains('models')) cache.createObjectStore('models');
        },
        blocking(_current, _blocked, event) {
          (event.target as IDBDatabase | null)?.close();
        },
      });
      try {
        const records = (await legacy.getAll('models')) as ModelRecord[];
        const tx = database.transaction(['models', 'app_state'], 'readwrite');
        const completed = tx.done;
        void completed.catch(() => {});
        try {
          if ((await tx.objectStore('app_state').get(MIGRATED))?.value !== true) {
            for (const record of records) {
              if (typeof record.key !== 'string' || typeof record.blob?.size !== 'number')
                throw new Error('A legacy cached model is invalid. Its original bytes have not been changed.');
              await tx.objectStore('models').put(record, record.key);
            }
            await tx.objectStore('app_state').put({ key: MIGRATED, value: true });
          }
          await completed;
        } catch (error) {
          abort(tx);
          await completed.catch(() => {});
          throw error;
        }
      } finally {
        legacy.close();
      }
    })();
    migrations.set(database, migration);
    void migration.catch(() => {
      if (migrations.get(database) === migration) migrations.delete(database);
    });
  }
  await migration;
  return database;
}

export async function deleteModelCache(options?: { onBlocked?: () => void }): Promise<void> {
  const db = await getDB();
  await migrations.get(db)?.catch(() => {});
  const tx = db.transaction(['models', 'app_state'], 'readwrite');
  await Promise.all([
    tx.objectStore('models').clear(),
    // An explicit clear must not resurrect retained legacy records on next read.
    tx.objectStore('app_state').put({ key: MIGRATED, value: true }),
    tx.done,
  ]);
  await new Promise<void>((resolve, reject) => {
    const request = indexedDB.deleteDatabase(MODEL_CACHE_DB_NAME);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error ?? new Error('Failed to delete the local model cache'));
    request.onblocked = () => options?.onBlocked?.();
  });
}

export async function putModelBlob(key: string, blob: Blob): Promise<void> {
  await putModelBlobs([{ key, blob }]);
}

/** Replace related model artifacts atomically, with a cancellable pre-commit boundary. */
export async function putModelBlobs(
  models: ReadonlyArray<Pick<ModelRecord, 'key' | 'blob'>>,
  options: { signal?: AbortSignal } = {},
): Promise<void> {
  await changeModelBlobs(models, options);
}

/** Clear related artifacts together, with the same cancellation boundary as replacement. */
export async function deleteModelBlobs(keys: readonly string[], options: { signal?: AbortSignal } = {}): Promise<void> {
  await changeModelBlobs(
    keys.map((key) => ({ key, blob: null })),
    options,
  );
}

async function changeModelBlobs(
  models: ReadonlyArray<{ key: string; blob: Blob | null }>,
  options: { signal?: AbortSignal },
): Promise<void> {
  if (models.length === 0) return;
  const abortIfRequested = () => {
    if (options.signal?.aborted) throw new DOMException('Model update cancelled.', 'AbortError');
  };
  abortIfRequested();
  const db = await prepareModelStore();
  abortIfRequested();
  const transaction = db.transaction('models', 'readwrite');
  const completed = transaction.done;
  void completed.catch(() => {});
  const abortTransaction = () => abort(transaction);
  options.signal?.addEventListener('abort', abortTransaction, { once: true });
  try {
    for (const model of models) {
      abortIfRequested();
      if (model.blob === null) await transaction.store.delete(model.key);
      else await transaction.store.put({ key: model.key, blob: model.blob, savedAtMs: Date.now() }, model.key);
    }
    abortIfRequested();
    await completed;
  } catch (error) {
    abortTransaction();
    await completed.catch(() => {});
    throw error;
  } finally {
    options.signal?.removeEventListener('abort', abortTransaction);
  }
}

export async function getModelRecord(key: string): Promise<ModelRecord | null> {
  return (await (await prepareModelStore()).get('models', key)) ?? null;
}

export async function getModelBlob(key: string): Promise<Blob | null> {
  return (await getModelRecord(key))?.blob ?? null;
}

export async function deleteModelBlob(key: string): Promise<void> {
  await deleteModelBlobs([key]);
}

export async function getAllModelRecords(): Promise<ModelRecord[]> {
  return (await prepareModelStore()).getAll('models');
}
