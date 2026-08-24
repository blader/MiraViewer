import { describe, it, expect, afterEach, vi } from 'vitest';
import JSZip from 'jszip';
import { getDB, resetDbForTests } from '../src/db/db';
import { loadSafeArchive } from '../src/services/archiveSafety';
import {
  exportStudiesToZip,
  getSnapshotRestoreBytes,
  MAX_SNAPSHOT_RESTORE_BYTES,
  readSnapshotManifest,
  restoreSnapshot,
} from '../src/services/exportBackup';
import { deleteModelCache, MODEL_CACHE_DB_NAME, putModelBlob } from '../src/utils/segmentation/onnx/modelCache';

async function resetDb() {
  await new Promise<void>((resolve) => {
    const req = indexedDB.deleteDatabase('MiraViewerDB');
    req.onsuccess = () => resolve();
    req.onerror = () => resolve();
    req.onblocked = () => resolve();
  });
}

async function seedSnapshot(options: { model?: boolean } = {}) {
  const db = await getDB();
  await db.put('studies', {
    studyInstanceUid: 'study-1',
    studyDate: '20240101',
    studyDescription: 'Test Study',
    patientName: 'Test',
    patientId: 'P1',
    modality: 'MR',
  });
  await db.put('series', {
    seriesInstanceUid: 'series-1',
    studyInstanceUid: 'study-1',
    seriesDescription: 'Series A',
    seriesNumber: 1,
    modality: 'MR',
  });
  await db.put('instances', {
    sopInstanceUid: 'inst-1',
    seriesInstanceUid: 'series-1',
    studyInstanceUid: 'study-1',
    instanceNumber: 1,
    rows: 256,
    columns: 256,
    fileBlob: new Blob([new Uint8Array([1, 2, 3])]),
  });
  if (options.model) await putModelBlob('synthetic-model', new Blob([new Uint8Array([5, 6, 7])]));

  const blob = await exportStudiesToZip(['study-1']);
  await resetDbForTests();
  await resetDb();
  await deleteModelCache();
  const archive = await loadSafeArchive(blob, { deferStorageCheck: true });
  const manifest = await readSnapshotManifest(archive.zip);
  if (!manifest) throw new Error('Synthetic complete backup has no manifest');
  return { archive, manifest };
}

describe('exportBackup', () => {
  afterEach(async () => {
    await resetDbForTests();
    await resetDb();
    await deleteModelCache();
  });

  it('exports studies into a ZIP with metadata and DICOM blobs', async () => {
    const db = await getDB();
    await db.put('studies', {
      studyInstanceUid: 'study-1',
      studyDate: '20240101',
      studyDescription: 'Test Study',
      patientName: 'Test',
      patientId: 'P1',
      modality: 'MR',
    });
    await db.put('series', {
      seriesInstanceUid: 'series-1',
      studyInstanceUid: 'study-1',
      seriesDescription: 'Series A',
      seriesNumber: 1,
      modality: 'MR',
    });
    await db.put('instances', {
      sopInstanceUid: 'inst-1',
      seriesInstanceUid: 'series-1',
      studyInstanceUid: 'study-1',
      instanceNumber: 1,
      rows: 256,
      columns: 256,
      fileBlob: new Blob([new Uint8Array([1, 2, 3])]),
    });

    const blob = await exportStudiesToZip(['study-1']);
    const zip = await JSZip.loadAsync(blob);
    const files = Object.keys(zip.files);

    expect(files).toContain('export.json');
    // UID-addressed folders cannot collide when human descriptions repeat.
    expect(files.some((f) => f.includes('studies/study-1/series/series-1/'))).toBe(true);
    // DICOM file should exist
    expect(files.some((f) => f.endsWith('.dcm'))).toBe(true);
  });

  it('stops restoration before medical mutation when cancelled during preparation', async () => {
    const { archive, manifest } = await seedSnapshot();
    const controller = new AbortController();
    const committed = vi.fn();

    await expect(
      restoreSnapshot(archive.zip, manifest, () => controller.abort(), {
        signal: controller.signal,
        onCommitStart: committed,
      }),
    ).rejects.toMatchObject({ name: 'AbortError' });

    expect(committed).not.toHaveBeenCalled();
    expect(await (await getDB()).count('studies')).toBe(0);
    expect(await (await getDB()).count('instances')).toBe(0);
  });

  it('finishes the atomic medical commit once the noninterruptible commit phase begins', async () => {
    const { archive, manifest } = await seedSnapshot();
    const controller = new AbortController();

    const result = await restoreSnapshot(archive.zip, manifest, undefined, {
      signal: controller.signal,
      onCommitStart: () => controller.abort(),
    });

    expect(controller.signal.aborted).toBe(true);
    expect(result.ingested).toBe(1);
    expect(await (await getDB()).count('instances')).toBe(1);
  });

  it('rejects oversized complete backups before reading members or mutating any durable store', async () => {
    const { archive, manifest } = await seedSnapshot({ model: true });
    manifest.records.instances[0]!.file.byteLength = MAX_SNAPSHOT_RESTORE_BYTES + 1;
    const committed = vi.fn();

    expect(getSnapshotRestoreBytes(manifest)).toBeGreaterThan(MAX_SNAPSHOT_RESTORE_BYTES);
    await expect(restoreSnapshot(archive.zip, manifest, undefined, { onCommitStart: committed })).rejects.toThrow(
      /512 MiB safe restore limit/i,
    );
    expect(committed).not.toHaveBeenCalled();
    expect(await (await getDB()).count('instances')).toBe(0);
    expect((await indexedDB.databases()).some((database) => database.name === MODEL_CACHE_DB_NAME)).toBe(false);
  });

  it('detects model-cache version conflicts before committing medical images or annotations', async () => {
    const { archive, manifest } = await seedSnapshot({ model: true });
    const newer = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open(MODEL_CACHE_DB_NAME, 2);
      request.onupgradeneeded = () => request.result.createObjectStore('models');
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    newer.close();
    const committed = vi.fn();

    await expect(restoreSnapshot(archive.zip, manifest, undefined, { onCommitStart: committed })).rejects.toThrow(
      /version/i,
    );
    expect(committed).not.toHaveBeenCalled();
    expect(await (await getDB()).count('studies')).toBe(0);
    expect(await (await getDB()).count('instances')).toBe(0);
  });

  it('reports bounded SHA-verification degradation while retaining mandatory member CRC verification', async () => {
    const { archive, manifest } = await seedSnapshot();
    manifest.records.instances[0]!.file.sha256 = 'synthetic-digest-not-available';
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'crypto');
    Object.defineProperty(globalThis, 'crypto', { configurable: true, value: {} });

    try {
      const result = await restoreSnapshot(archive.zip, manifest);
      expect(result.ingested).toBe(1);
      expect(result.integrityWarnings).toEqual([
        'SHA-256 verification was unavailable; every archive member passed its CRC32 check.',
      ]);
      expect(await (await getDB()).count('instances')).toBe(1);
    } finally {
      if (descriptor) Object.defineProperty(globalThis, 'crypto', descriptor);
      else Reflect.deleteProperty(globalThis, 'crypto');
    }
  });

  it('reports a recoverable preference failure without falsely claiming the committed medical restore failed', async () => {
    const { archive, manifest } = await seedSnapshot();
    manifest.records.localStorage['miraviewer:overlay-nav:v1'] = 'synthetic-preference';
    const save = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('Synthetic local-storage quota exceeded.', 'QuotaExceededError');
    });

    try {
      const result = await restoreSnapshot(archive.zip, manifest);
      expect(result.ingested).toBe(1);
      expect(result.integrityWarnings).toEqual([
        'Some display preferences could not be restored; all medical data was restored safely.',
      ]);
      expect(await (await getDB()).count('instances')).toBe(1);
    } finally {
      save.mockRestore();
    }
  });
});
