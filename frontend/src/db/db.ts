import { openDB } from 'idb';
import type { IDBPDatabase } from 'idb';
import type { MiraDB } from './schema';

const DB_NAME = 'MiraViewerDB';
const DB_VERSION = 4;

let dbPromise: Promise<IDBPDatabase<MiraDB>> | null = null;

/**
 * Delete the entire MiraViewer IndexedDB database.
 *
 * This is the most reliable way to "reset" the app's stored MRI data because it
 * removes all object stores (studies/series/instances/panel_settings) in one go.
 */
export async function deleteAllStoredMriData(): Promise<void> {
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
    req.onblocked = () => reject(new Error('Delete blocked: another tab may still be using the database'));
  });
}

export function getDB() {
  if (!dbPromise) {
    dbPromise = openDB<MiraDB>(DB_NAME, DB_VERSION, {
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
      },
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
  if (navigator.storage && navigator.storage.persist) {
    try {
      const isPersisted = await navigator.storage.persist();
      console.log(`Storage Persisted: ${isPersisted}`);
      
      // Check quota usage
      if (navigator.storage.estimate) {
        const estimate = await navigator.storage.estimate();
        console.log(`Storage Usage: ${estimate.usage} / ${estimate.quota} bytes`);
      }
      
      return isPersisted;
    } catch (err) {
      console.warn('Failed to request persistent storage:', err);
      return false;
    }
  }
  return false;
}
