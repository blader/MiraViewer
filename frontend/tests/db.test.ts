import { afterEach, describe, expect, it, vi } from 'vitest';
import { deleteAllStoredMriData, getDB, initStoragePersistence, resetDbForTests } from '../src/db/db';

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
});
