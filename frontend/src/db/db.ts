import { openDB } from 'idb';
import type { IDBPDatabase } from 'idb';
import type { MiraDB } from './schema';

const DB_NAME = 'MiraViewerDB';
const DB_VERSION = 1;

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
      upgrade(db) {
        // Studies
        if (!db.objectStoreNames.contains('studies')) {
          db.createObjectStore('studies', { keyPath: 'studyInstanceUid' });
        }

        // Series
        if (!db.objectStoreNames.contains('series')) {
          const seriesStore = db.createObjectStore('series', { keyPath: 'seriesInstanceUid' });
          seriesStore.createIndex('by-study', 'studyInstanceUid');
        }

        // Instances
        if (!db.objectStoreNames.contains('instances')) {
          const instanceStore = db.createObjectStore('instances', { keyPath: 'sopInstanceUid' });
          instanceStore.createIndex('by-series', 'seriesInstanceUid');
        }
        
        // Panel Settings
        if (!db.objectStoreNames.contains('panel_settings')) {
          db.createObjectStore('panel_settings', { keyPath: 'comboId' });
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
