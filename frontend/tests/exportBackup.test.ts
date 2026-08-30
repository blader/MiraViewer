import { describe, it, expect, afterEach, vi } from 'vitest';
import JSZip from 'jszip';
import { getDB, resetDbForTests } from '../src/db/db';
import type { VolumeSegmentationRow } from '../src/db/schema';
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

async function seedSnapshot(options: { model?: boolean; segmentation?: VolumeSegmentationRow } = {}) {
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
  if (options.segmentation) await db.put('volume_segmentations', options.segmentation);

  const blob = await exportStudiesToZip(['study-1']);
  await resetDbForTests();
  await resetDb();
  await deleteModelCache();
  const archive = await loadSafeArchive(blob, { deferStorageCheck: true });
  const manifest = await readSnapshotManifest(archive.zip);
  if (!manifest) throw new Error('Synthetic complete backup has no manifest');
  return { archive, manifest, blob };
}

async function rewriteSnapshotManifest(
  blob: Blob,
  manifest: NonNullable<Awaited<ReturnType<typeof readSnapshotManifest>>>,
) {
  // The validated lazy archive is read-only; edited wire fixtures need a new ZIP and CRC-verified read.
  const zip = await JSZip.loadAsync(blob);
  zip.file('export.json', JSON.stringify(manifest));
  const archive = await loadSafeArchive(await zip.generateAsync({ type: 'blob', compression: 'STORE' }), {
    deferStorageCheck: true,
  });
  const parsed = await readSnapshotManifest(archive.zip);
  if (!parsed) throw new Error('Synthetic edited backup has no manifest');
  return { archive, manifest: parsed };
}

function selectionRow(): VolumeSegmentationRow {
  const labels = new Uint8Array(24);
  labels[1] = 1;
  labels[13] = labels[19] = 2;
  return {
    volumeKey: 'synthetic-native-selection',
    studyUid: 'study-1',
    seriesUids: ['series-1'],
    frameOfReferenceUid: 'frame-1',
    dims: [2, 3, 4],
    voxelSizeMm: [0.5, 1, 2],
    labels,
    classMetadata: [
      { id: 0, name: 'Background', color: [0, 0, 0] },
      { id: 1, name: 'Region', color: [10, 20, 30] },
      { id: 2, name: 'Other region', color: [40, 50, 60] },
    ],
    reviewState: 'reviewed',
    datasetRevision: 7,
    updatedAt: 1234,
    seeds: {
      foreground: Uint32Array.of(19, 1, 13, 19),
      background: Uint32Array.of(22, 0, 6, 0),
      lastStroke: { plane: 'axial', slice: 3 },
    },
  };
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

  it('exports literal editing marks as ordered JSON arrays without changing duplicate marks or plane metadata', async () => {
    const saved = selectionRow();
    const before = structuredClone(saved);
    const { manifest } = await seedSnapshot({ segmentation: saved });
    expect(manifest.version).toBe(2);
    expect(manifest.records.volumeSegmentations[0]!.seeds).toEqual({
      foreground: [19, 1, 13, 19],
      background: [22, 0, 6, 0],
      lastStroke: { plane: 'axial', slice: 3 },
    });
    expect(structuredClone(saved)).toStrictEqual(before);
  });

  it.each(['axial', 'coronal', 'sagittal', 'absent'] as const)(
    'restores real typed editing arrays and optional %s stroke metadata through export and manifest readback',
    async (plane) => {
      const saved = selectionRow();
      if (plane === 'absent') delete saved.seeds!.lastStroke;
      else saved.seeds!.lastStroke = { plane, slice: 1 };
      const { archive, manifest } = await seedSnapshot({ segmentation: saved });
      await restoreSnapshot(archive.zip, manifest);
      const restored = await (await getDB()).get('volume_segmentations', saved.volumeKey);
      expect(Object.prototype.toString.call(restored!.seeds!.foreground)).toBe('[object Uint32Array]');
      expect(Object.prototype.toString.call(restored!.seeds!.background)).toBe('[object Uint32Array]');
      expect([...restored!.seeds!.foreground]).toEqual([19, 1, 13, 19]);
      expect([...restored!.seeds!.background]).toEqual([22, 0, 6, 0]);
      expect([...restored!.seeds!.foreground.subarray(1, 3)]).toEqual([1, 13]);
      expect(restored!.seeds!.background.every((index) => restored!.labels[index] === 0)).toBe(true);
      expect(restored).toStrictEqual(structuredClone(saved));
    },
  );

  it('revives the contiguous numeric-key objects emitted by old v2 backups without sorting their mark values', async () => {
    const saved = selectionRow();
    const { blob, manifest } = await seedSnapshot({ segmentation: saved });
    Object.assign(manifest.records.volumeSegmentations[0]!, { seeds: JSON.parse(JSON.stringify(saved.seeds)) });
    const legacy = await rewriteSnapshotManifest(blob, manifest);
    expect(legacy.manifest.records.volumeSegmentations[0]!.seeds!.foreground).toEqual({ 0: 19, 1: 1, 2: 13, 3: 19 });
    await restoreSnapshot(legacy.archive.zip, legacy.manifest);
    const restored = await (await getDB()).get('volume_segmentations', saved.volumeKey);
    expect(ArrayBuffer.isView(restored!.seeds!.foreground)).toBe(true);
    expect(ArrayBuffer.isView(restored!.seeds!.background)).toBe(true);
    expect([...restored!.seeds!.foreground]).toEqual([19, 1, 13, 19]);
    expect(restored).toStrictEqual(structuredClone(saved));
  });

  it('re-exports marks already restored as legacy numeric-key objects without silently emptying them', async () => {
    const saved = selectionRow();
    const legacy = { ...saved, seeds: JSON.parse(JSON.stringify(saved.seeds)) };
    const { archive, manifest } = await seedSnapshot({ segmentation: legacy });
    expect(manifest.records.volumeSegmentations[0]!.seeds!.foreground).toEqual([19, 1, 13, 19]);
    await restoreSnapshot(archive.zip, manifest);
    expect(await (await getDB()).get('volume_segmentations', saved.volumeKey)).toStrictEqual(structuredClone(saved));
  });

  it('rejects malformed stored editing marks during export instead of coercing or dropping them', async () => {
    const saved = selectionRow();
    Object.assign(saved.seeds!, { foreground: { 1: 19 } });
    await expect(seedSnapshot({ segmentation: saved })).rejects.toThrow(/invalid editing marks/);
    expect(await (await getDB()).get('volume_segmentations', saved.volumeKey)).toStrictEqual(structuredClone(saved));
  });

  it.each(['absent', 'empty-arrays', 'empty-legacy-objects'] as const)(
    'preserves %s editing metadata without inventing a last stroke',
    async (kind) => {
      const saved = selectionRow();
      if (kind === 'absent') delete saved.seeds;
      else saved.seeds = { foreground: new Uint32Array(), background: new Uint32Array() };
      let snapshot = await seedSnapshot({ segmentation: saved });
      if (kind === 'empty-legacy-objects') {
        Object.assign(snapshot.manifest.records.volumeSegmentations[0]!, { seeds: { foreground: {}, background: {} } });
        snapshot = { ...snapshot, ...(await rewriteSnapshotManifest(snapshot.blob, snapshot.manifest)) };
      }
      await restoreSnapshot(snapshot.archive.zip, snapshot.manifest);
      const restored = await (await getDB()).get('volume_segmentations', saved.volumeKey);
      expect(restored).toStrictEqual(structuredClone(saved));
      if (kind === 'absent') expect(restored).not.toHaveProperty('seeds');
      else {
        expect(restored!.seeds!.foreground.subarray(0)).toHaveLength(0);
        expect(restored!.seeds!.background.subarray(0)).toHaveLength(0);
        expect(restored!.seeds).not.toHaveProperty('lastStroke');
      }
    },
  );

  it.each([
    { foreground: [1.5] },
    { foreground: [-1] },
    { foreground: [24] },
    { foreground: [2 ** 32] },
    { foreground: ['1'] },
    { foreground: [null] },
    { foreground: undefined },
    { background: '0' },
    { background: { 1: 0 } },
    { foreground: { 0: 19, 2: 13 } },
    { foreground: { '00': 19 } },
    { foreground: { 0: 19, length: 1 } },
    { foreground: { 0: '19' } },
    { foreground: { 0: -1 } },
    { lastStroke: null },
    { lastStroke: {} },
    { lastStroke: { plane: 'unknown', slice: 1 } },
    { lastStroke: { plane: 'axial', slice: 0.5 } },
    { lastStroke: { plane: 'axial', slice: -1 } },
    { lastStroke: { plane: 'axial', slice: 4 } },
    { lastStroke: { plane: 'coronal', slice: 3 } },
    { lastStroke: { plane: 'sagittal', slice: 2 } },
  ])('rejects malformed editing metadata before any medical commit: %j', async (invalid) => {
    const saved = selectionRow();
    const { blob, manifest } = await seedSnapshot({ segmentation: saved });
    Object.assign(manifest.records.volumeSegmentations[0]!.seeds!, invalid);
    const edited = await rewriteSnapshotManifest(blob, manifest);
    const db = await getDB();
    const existing = { ...selectionRow(), volumeKey: 'untouched-existing-selection' };
    await db.put('volume_segmentations', existing);
    const committed = vi.fn();
    await expect(
      restoreSnapshot(edited.archive.zip, edited.manifest, undefined, { onCommitStart: committed }),
    ).rejects.toThrow(/invalid.*marks|invalid.*stroke/);
    expect(committed).not.toHaveBeenCalled();
    expect(await db.count('studies')).toBe(0);
    expect(await db.count('instances')).toBe(0);
    expect(await db.count('volume_segmentations')).toBe(1);
    expect(await db.get('volume_segmentations', existing.volumeKey)).toStrictEqual(structuredClone(existing));
  });

  it.each([
    [undefined, undefined],
    [0, false],
    [152, true],
  ] as const)(
    'exports and restores mask-owned clipping %s and context %s without changing legacy evidence',
    async (clippedNativeVoxels, contextLimited) => {
      const saved = {
        ...selectionRow(),
        ...(clippedNativeVoxels !== undefined ? { clippedNativeVoxels } : {}),
        ...(contextLimited !== undefined ? { contextLimited } : {}),
      };
      const { archive, manifest } = await seedSnapshot({ segmentation: saved });
      expect(manifest.records.volumeSegmentations[0]!.clippedNativeVoxels).toBe(clippedNativeVoxels);
      expect(manifest.records.volumeSegmentations[0]!.contextLimited).toBe(contextLimited);
      await restoreSnapshot(archive.zip, manifest);
      const restored = await (await getDB()).get('volume_segmentations', saved.volumeKey);
      expect(restored!.clippedNativeVoxels).toBe(clippedNativeVoxels);
      expect(restored!.contextLimited).toBe(contextLimited);
      if (clippedNativeVoxels === undefined) expect(restored).not.toHaveProperty('clippedNativeVoxels');
      if (contextLimited === undefined) expect(restored).not.toHaveProperty('contextLimited');
    },
  );

  it.each([
    ...[null, '152', -1, 0.5, Number.MAX_SAFE_INTEGER + 1].map((value) => ({ field: 'clippedNativeVoxels', value })),
    ...[null, 'false', 0, 1, {}].map((value) => ({ field: 'contextLimited', value })),
  ])('rejects malformed backup $field ($value) before any medical commit', async ({ field, value }) => {
    const { blob, manifest } = await seedSnapshot({ segmentation: selectionRow() });
    Object.assign(manifest.records.volumeSegmentations[0]!, { [field]: value });
    const edited = await rewriteSnapshotManifest(blob, manifest);
    const db = await getDB();
    const existing = { ...selectionRow(), volumeKey: 'untouched-coverage', clippedNativeVoxels: 152 };
    await db.put('volume_segmentations', existing);
    const committed = vi.fn();
    await expect(
      restoreSnapshot(edited.archive.zip, edited.manifest, undefined, { onCommitStart: committed }),
    ).rejects.toThrow(/invalid viewing-region coverage/i);
    expect(committed).not.toHaveBeenCalled();
    expect(await db.count('studies')).toBe(0);
    expect(await db.count('instances')).toBe(0);
    expect(await db.count('volume_segmentations')).toBe(1);
    expect(await db.get('volume_segmentations', existing.volumeKey)).toStrictEqual(structuredClone(existing));
  });

  it.each(['clippedNativeVoxels', 'contextLimited'] as const)(
    'refuses to export malformed %s rather than silently losing it during JSON serialization',
    async (field) => {
      const saved = Object.assign(selectionRow(), { [field]: Infinity });
      await expect(seedSnapshot({ segmentation: saved })).rejects.toThrow(/invalid viewing-region coverage/i);
      expect((await (await getDB()).get('volume_segmentations', saved.volumeKey))?.[field]).toBe(Infinity);
    },
  );

  it.each([{ dims: [-2, -3, 4] }, { dims: [1.5, 4, 4] }, { dims: ['2', 3, 4] }, { dims: [2, 3, 4, 1] }])(
    'rejects invalid grid dimensions $dims even when the old product check matched the label byte length',
    async ({ dims }) => {
      const { blob, manifest } = await seedSnapshot({ segmentation: selectionRow() });
      Object.assign(manifest.records.volumeSegmentations[0]!, { dims });
      const edited = await rewriteSnapshotManifest(blob, manifest);
      const committed = vi.fn();
      await expect(
        restoreSnapshot(edited.archive.zip, edited.manifest, undefined, {
          onCommitStart: committed,
        }),
      ).rejects.toThrow(/reconstruction geometry/);
      expect(committed).not.toHaveBeenCalled();
      expect(await (await getDB()).count('instances')).toBe(0);
      expect(await (await getDB()).count('volume_segmentations')).toBe(0);
    },
  );

  it('stops restoration before medical mutation when cancelled during preparation', async () => {
    const { archive, manifest } = await seedSnapshot({ segmentation: selectionRow() });
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
    expect(await (await getDB()).count('volume_segmentations')).toBe(0);
  });

  it('finishes the atomic medical commit once the noninterruptible commit phase begins', async () => {
    const saved = selectionRow();
    const { archive, manifest } = await seedSnapshot({ segmentation: saved });
    const controller = new AbortController();

    const result = await restoreSnapshot(archive.zip, manifest, undefined, {
      signal: controller.signal,
      onCommitStart: () => controller.abort(),
    });

    expect(controller.signal.aborted).toBe(true);
    expect(result.ingested).toBe(1);
    expect(await (await getDB()).count('instances')).toBe(1);
    expect(await (await getDB()).get('volume_segmentations', saved.volumeKey)).toStrictEqual(structuredClone(saved));
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
