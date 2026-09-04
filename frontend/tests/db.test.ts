import { afterEach, describe, expect, it, vi } from 'vitest';
import { Blob as NativeBlob } from 'node:buffer';
import { getSeriesFrameManifest } from '../src/utils/localApi';
import { DEFAULT_PANEL_SETTINGS } from '../src/utils/constants';
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

  it('upgrades older spatial metadata while keeping source-owned settings, literal marks, and image bytes', async () => {
    const savedSettings = {
      comboId: 'source:legacy-series',
      source: { studyUid: 'legacy-study', seriesUid: 'legacy-series' },
      settings: { 'legacy-study': { ...DEFAULT_PANEL_SETTINGS, zoom: 2.5 } },
    };
    const previous = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open('MiraViewerDB', 6);
      request.onupgradeneeded = () => {
        const db = request.result;
        db.createObjectStore('studies', { keyPath: 'studyInstanceUid' }).put({
          studyInstanceUid: 'legacy-study',
          studyDate: '20350101',
          patientName: 'Synthetic Legacy',
          patientId: 'synthetic-legacy',
          studyDescription: 'Synthetic',
          modality: 'MR',
        });
        db.createObjectStore('series', { keyPath: 'seriesInstanceUid' }).put({
          seriesInstanceUid: 'legacy-series',
          studyInstanceUid: 'legacy-study',
          seriesDescription: 'Axial T2',
          seriesNumber: 1,
          modality: 'MR',
          frameOfReferenceUid: 'legacy-frame',
        });
        const instances = db.createObjectStore('instances', { keyPath: 'sopInstanceUid' });
        for (let index = 0; index < 2; index++)
          instances.put({
            sopInstanceUid: `legacy-${index}`,
            seriesInstanceUid: 'legacy-series',
            studyInstanceUid: 'legacy-study',
            instanceNumber: 2 - index,
            rows: 2,
            columns: 2,
            frameOfReferenceUid: 'legacy-frame',
            imagePositionPatient: `0\\0\\${index * 2}`,
            imageOrientationPatient: '1\\0\\0\\0\\1\\0',
            pixelSpacing: '1\\1',
            acquisitionMetadata: {
              version: 1,
              imageType: ['ORIGINAL', 'PRIMARY'],
              sourceSopInstanceUids: [],
              derivationSopInstanceUids: [],
            },
            fileBlob: new NativeBlob([Uint8Array.of(index, 55)]),
          });
        db.createObjectStore('panel_settings', { keyPath: 'comboId' }).put(savedSettings);
        db.createObjectStore('volume_segmentations', { keyPath: 'volumeKey' }).put({
          volumeKey: 'legacy-selection',
          studyUid: 'legacy-study',
          dims: [2, 2, 2],
          labels: Uint8Array.of(1, 0, 0, 0, 0, 0, 0, 0),
          seeds: { foreground: Uint32Array.of(0), background: Uint32Array.of(1) },
          updatedAt: 42,
        });
        const state = db.createObjectStore('app_state', { keyPath: 'key' });
        state.put({ key: 'dataset_revision', value: 7 });
        state.put({ key: 'dataset_token', value: 'synthetic-legacy-token' });
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    previous.close();
    const manifest = await getSeriesFrameManifest('legacy-series');
    expect(manifest.geometryReliable).toBe(true);
    expect(manifest.frames.map((frame) => frame.sopInstanceUid)).toEqual(['legacy-0', 'legacy-1']);
    const db = await getDB();
    expect(await db.get('panel_settings', savedSettings.comboId)).toEqual(savedSettings);
    expect((await db.get('app_state', 'dataset_revision'))?.value).toBe(7);
    expect((await db.get('app_state', 'dataset_token'))?.value).toBe('synthetic-legacy-token');
    const saved = await db.get('volume_segmentations', 'legacy-selection');
    expect(saved && 'labels' in saved ? Array.from(saved.labels) : null).toEqual([1, 0, 0, 0, 0, 0, 0, 0]);
    expect(Array.from(saved!.seeds!.foreground)).toEqual([0]);
    expect(Array.from(saved!.seeds!.background)).toEqual([1]);
    expect(saved!.updatedAt).toBe(42);
    expect(new Uint8Array(await (await db.get('instances', 'legacy-1'))!.fileBlob.arrayBuffer())).toEqual(
      Uint8Array.of(1, 55),
    );
  });

  it('adds restore staging to a schema-9 database without replacing already migrated models', async () => {
    const previous = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open('MiraViewerDB', 9);
      request.onupgradeneeded = () =>
        request.result
          .createObjectStore('models')
          .put(
            { key: 'retained-model', blob: new NativeBlob(['synthetic retained bytes']), savedAtMs: 123 },
            'retained-model',
          );
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    previous.close();
    const db = await getDB();
    const model = await db.get('models', 'retained-model');
    expect(await model!.blob.text()).toBe('synthetic retained bytes');
    expect(model!.savedAtMs).toBe(123);
    await db.put(
      'backup_staging',
      { store: 'models', row: { ...model!, blob: new NativeBlob(['unpublished replacement']) } },
      ['synthetic-operation', 0],
    );
    expect(await (await db.get('models', 'retained-model'))!.blob.text()).toBe('synthetic retained bytes');
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
