import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  deleteAllStoredMriData,
  getDB,
  initStoragePersistence,
  notifyDatasetMutation,
  resetDbForTests,
  subscribeDatasetMutations,
  subscribeStorageHealth,
} from '../src/db/db';

async function resetDb() {
  await new Promise<void>((resolve) => {
    const req = indexedDB.deleteDatabase('MiraViewerDB');
    req.onsuccess = () => resolve();
    req.onerror = () => resolve();
    req.onblocked = () => resolve();
  });
}

describe('db', () => {
  afterEach(async () => {
    await resetDbForTests();
    await resetDb();
  });

  it('creates required object stores', async () => {
    const db = await getDB();
    expect(db.objectStoreNames.contains('studies')).toBe(true);
    expect(db.objectStoreNames.contains('series')).toBe(true);
    expect(db.objectStoreNames.contains('instances')).toBe(true);
    expect(db.objectStoreNames.contains('panel_settings')).toBe(true);
    expect(db.objectStoreNames.contains('derived_alignment_frames')).toBe(true);
    db.close();
  });

  it('deletes all stored data when requested', async () => {
    const db = await getDB();
    await db.put('studies', {
      studyInstanceUid: 'study-1',
      studyDate: '20240101',
      studyDescription: 'Test Study',
      patientName: 'Test^Patient',
      patientId: 'PID',
      modality: 'MR',
    });
    db.close();

    await deleteAllStoredMriData();

    const db2 = await getDB();
    expect(await db2.get('studies', 'study-1')).toBeUndefined();
    db2.close();
  });

  it('indexes existing derived frames when upgrading an older database without rewriting pixels', async () => {
    const legacy = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open('MiraViewerDB', 6);
      request.onupgradeneeded = () => {
        const frames = request.result.createObjectStore('derived_alignment_frames', { keyPath: 'id' });
        frames.createIndex('by-patient', 'patientKey');
        frames.createIndex('by-created-at', 'createdAt');
        frames.put({
          id: 'retained-plane',
          patientKey: 'patient',
          datasetRevision: 4,
          sequenceId: 'axial-t2',
          targetSeriesUid: 'series',
          createdAt: 1,
          pixels: Float32Array.of(3, 4),
        });
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    legacy.close();

    const db = await getDB();
    const frames = await db.getAllFromIndex('derived_alignment_frames', 'by-patient-revision-source', [
      'patient',
      4,
      'axial-t2',
      'series',
    ]);
    expect(frames.map((frame) => frame.id)).toEqual(['retained-plane']);
    expect(Array.from(frames[0]!.pixels)).toEqual([3, 4]);
  });

  it('requests persistent storage when available', async () => {
    const persist = vi.fn().mockResolvedValue(true);
    const estimate = vi.fn().mockResolvedValue({ usage: 1024, quota: 2048 });

    Object.defineProperty(navigator, 'storage', {
      value: { persist, estimate },
      configurable: true,
    });

    const result = await initStoragePersistence();
    expect(result).toBe(true);
    expect(persist).toHaveBeenCalled();
  });

  it.each([
    {
      name: 'storage health',
      subscribe: (listener: () => void) => subscribeStorageHealth(listener),
      publish: () => initStoragePersistence(),
    },
    {
      name: 'dataset mutations',
      subscribe: (listener: () => void) => subscribeDatasetMutations(listener),
      publish: () => notifyDatasetMutation('changed-series'),
    },
  ])(
    'notifies each $name subscriber once while honoring removals during publication',
    async ({ subscribe, publish }) => {
      const removed = vi.fn();
      const stable = vi.fn();
      let unsubscribeChanging = () => {};
      let unsubscribeRemoved = () => {};
      const changing = vi.fn(() => {
        unsubscribeChanging();
        unsubscribeRemoved();
        if (changing.mock.calls.length < 4) unsubscribeChanging = subscribe(changing);
      });
      unsubscribeChanging = subscribe(changing);
      unsubscribeRemoved = subscribe(removed);
      const unsubscribeStable = subscribe(stable);

      try {
        await publish();

        expect(changing).toHaveBeenCalledOnce();
        expect(removed).not.toHaveBeenCalled();
        expect(stable).toHaveBeenCalledOnce();
      } finally {
        unsubscribeChanging();
        unsubscribeRemoved();
        unsubscribeStable();
      }
    },
  );
});
