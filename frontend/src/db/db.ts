import { openDB } from 'idb';
import type { IDBPDatabase } from 'idb';
import type { MiraDB } from './schema';

export const DB_NAME = 'MiraViewerDB';
const DB_VERSION = 6;
export const SELECTED_PATIENT_STATE_KEY = 'selected_patient_key';
export const DATASET_REVISION_STATE_KEY = 'dataset_revision';

export type StorageHealth = {
  checked: boolean;
  persisted: boolean;
  usage?: number;
  quota?: number;
};

let dbPromise: Promise<IDBPDatabase<MiraDB>> | null = null;
let storageHealth: StorageHealth = { checked: false, persisted: false };
const storageHealthListeners = new Set<(health: StorageHealth) => void>();
const datasetMutationListeners = new Set<(seriesUid?: string) => void>();

/**
 * Delete the entire MiraViewer IndexedDB database.
 *
 * This is the most reliable way to "reset" the app's stored MRI data because it
 * removes all object stores (studies/series/instances/panel_settings) in one go.
 */
export async function deleteAllStoredMriData(options?: { onBlocked?: () => void }): Promise<void> {
  // Close any open connection first; otherwise deleteDatabase can be "blocked".
  if (dbPromise) {
    try {
      const db = await dbPromise;
      db.close();
    } catch {
      // ignore
    }
  }

  dbPromise = null;

  await new Promise<void>((resolve, reject) => {
    const req = indexedDB.deleteDatabase(DB_NAME);

    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error ?? new Error('Failed to delete IndexedDB database'));
    // A blocked delete remains queued and cannot be cancelled. Reporting it as a
    // terminal failure would let it silently destroy data after the user left.
    req.onblocked = () => options?.onBlocked?.();
  });

  notifyDatasetMutation();
}

export function getDB() {
  if (!dbPromise) {
    const opening = openDB<MiraDB>(DB_NAME, DB_VERSION, {
      upgrade(db, _oldVersion, _newVersion, transaction) {
        // Studies
        if (!db.objectStoreNames.contains('studies')) {
          db.createObjectStore('studies', { keyPath: 'studyInstanceUid' });
        }

        // Series
        {
          const seriesStore = db.objectStoreNames.contains('series')
            ? transaction.objectStore('series')
            : db.createObjectStore('series', { keyPath: 'seriesInstanceUid' });

          if (!seriesStore.indexNames.contains('by-study')) {
            seriesStore.createIndex('by-study', 'studyInstanceUid');
          }
        }

        // Instances
        {
          const instanceStore = db.objectStoreNames.contains('instances')
            ? transaction.objectStore('instances')
            : db.createObjectStore('instances', { keyPath: 'sopInstanceUid' });

          if (!instanceStore.indexNames.contains('by-series')) {
            instanceStore.createIndex('by-series', 'seriesInstanceUid');
          }

          // Sorted-by-instanceNumber ordering without loading Blob values.
          // Includes sopInstanceUid as a tie-breaker for stable ordering.
          if (!instanceStore.indexNames.contains('by-series-instanceNumber-uid')) {
            instanceStore.createIndex('by-series-instanceNumber-uid', [
              'seriesInstanceUid',
              'instanceNumber',
              'sopInstanceUid',
            ]);
          }

          if (!instanceStore.indexNames.contains('by-series-physicalPosition-uid')) {
            instanceStore.createIndex('by-series-physicalPosition-uid', [
              'seriesInstanceUid',
              'physicalSlicePosition',
              'sopInstanceUid',
            ]);
          }
        }

        // Panel Settings
        if (!db.objectStoreNames.contains('panel_settings')) {
          db.createObjectStore('panel_settings', { keyPath: 'comboId' });
        }

        // Tumor segmentations
        {
          const segStore = db.objectStoreNames.contains('tumor_segmentations')
            ? transaction.objectStore('tumor_segmentations')
            : db.createObjectStore('tumor_segmentations', { keyPath: 'id' });

          if (!segStore.indexNames.contains('by-series')) {
            segStore.createIndex('by-series', 'seriesUid');
          }
          if (!segStore.indexNames.contains('by-sop')) {
            segStore.createIndex('by-sop', 'sopInstanceUid');
          }
          if (!segStore.indexNames.contains('by-combo-date')) {
            segStore.createIndex('by-combo-date', ['comboId', 'dateIso']);
          }
        }

        // Tumor ground truth (manual polygon)
        {
          const gtStore = db.objectStoreNames.contains('tumor_ground_truth')
            ? transaction.objectStore('tumor_ground_truth')
            : db.createObjectStore('tumor_ground_truth', { keyPath: 'id' });

          if (!gtStore.indexNames.contains('by-series')) {
            gtStore.createIndex('by-series', 'seriesUid');
          }
          if (!gtStore.indexNames.contains('by-sop')) {
            gtStore.createIndex('by-sop', 'sopInstanceUid');
          }
          if (!gtStore.indexNames.contains('by-combo-date')) {
            gtStore.createIndex('by-combo-date', ['comboId', 'dateIso']);
          }
        }

        if (!db.objectStoreNames.contains('app_state')) {
          db.createObjectStore('app_state', { keyPath: 'key' });
        }

        {
          const volumeStore = db.objectStoreNames.contains('volume_segmentations')
            ? transaction.objectStore('volume_segmentations')
            : db.createObjectStore('volume_segmentations', { keyPath: 'volumeKey' });
          if (!volumeStore.indexNames.contains('by-study')) {
            volumeStore.createIndex('by-study', 'studyUid');
          }
        }

        {
          const derivedStore = db.objectStoreNames.contains('derived_alignment_frames')
            ? transaction.objectStore('derived_alignment_frames')
            : db.createObjectStore('derived_alignment_frames', { keyPath: 'id' });
          if (!derivedStore.indexNames.contains('by-patient')) {
            derivedStore.createIndex('by-patient', 'patientKey');
          }
          if (!derivedStore.indexNames.contains('by-created-at')) {
            derivedStore.createIndex('by-created-at', 'createdAt');
          }
        }
      },
      blocking(_currentVersion, _blockedVersion, event) {
        const connection = event.target as IDBDatabase | null;
        connection?.close();
        dbPromise = null;
      },
      terminated() {
        dbPromise = null;
      },
    });

    dbPromise = opening.catch((error: unknown) => {
      dbPromise = null;
      throw error;
    });
  }
  return dbPromise;
}

// Test helper to force a fresh DB connection between runs.
export async function resetDbForTests() {
  if (dbPromise) {
    try {
      const db = await dbPromise;
      db.close();
    } catch {
      // ignore
    }
  }
  dbPromise = null;
}

export async function initStoragePersistence() {
  try {
    const storage: Partial<StorageManager> | undefined = navigator.storage;
    const persisted = (await storage?.persist?.()) ?? false;
    const estimate = storage?.persist ? await storage.estimate?.() : undefined;
    storageHealth = { checked: true, persisted, usage: estimate?.usage, quota: estimate?.quota };
  } catch (err) {
    console.warn('Failed to request persistent storage:', err);
    storageHealth = { checked: true, persisted: false };
  }
  publishStorageHealth();
  return storageHealth.persisted;
}

function publishStorageHealth() {
  for (const listener of storageHealthListeners) listener(storageHealth);
}

export function getStorageHealth(): StorageHealth {
  return storageHealth;
}

export function subscribeStorageHealth(listener: (health: StorageHealth) => void): () => void {
  storageHealthListeners.add(listener);
  return () => storageHealthListeners.delete(listener);
}

export async function assertStorageHeadroom(requiredBytes: number): Promise<void> {
  if (!Number.isFinite(requiredBytes) || requiredBytes <= 0 || !navigator.storage?.estimate) return;
  const estimate = await navigator.storage.estimate();
  if (typeof estimate.quota !== 'number' || typeof estimate.usage !== 'number') return;

  storageHealth = { ...storageHealth, usage: estimate.usage, quota: estimate.quota };
  publishStorageHealth();

  const reserveBytes = Math.min(64 * 1024 * 1024, Math.max(1024 * 1024, estimate.quota * 0.05));
  const availableBytes = estimate.quota - estimate.usage - reserveBytes;
  if (requiredBytes > availableBytes) {
    throw new Error('Insufficient browser storage for this import. Export a backup or free storage before continuing.');
  }
}

export function notifyDatasetMutation(seriesUid?: string): void {
  for (const listener of datasetMutationListeners) listener(seriesUid);
}

export function subscribeDatasetMutations(listener: (seriesUid?: string) => void): () => void {
  datasetMutationListeners.add(listener);
  return () => datasetMutationListeners.delete(listener);
}
