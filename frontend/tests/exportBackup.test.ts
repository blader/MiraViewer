import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import JSZip from 'jszip';
import { openDB } from 'idb';
import { Blob as NativeBlob } from 'node:buffer';
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { DATASET_TOKEN_STATE_KEY, deleteAllStoredMriData, getDB, resetDbForTests } from '../src/db/db';
import { initializeComparisonState } from '../src/db/comparisonState';
import { acquisitionChoiceKey, sourceSettingsKey } from '../src/db/comparisonIdentity';
import { usePanelSettings } from '../src/hooks/usePanelSettings';
import {
  getComparisonData,
  getPanelSettingsSnapshot,
  getVolumeSegmentation,
  savePanelSettings,
  saveVolumeSegmentation,
} from '../src/utils/localApi';
import { DEFAULT_PANEL_SETTINGS } from '../src/utils/constants';
import type { VolumeSegmentationRow } from '../src/db/schema';
import { loadSafeArchive } from '../src/services/archiveSafety';
import {
  exportStudiesToZip,
  assertSnapshotCapacity,
  getSnapshotRestoreBytes,
  MAX_SNAPSHOT_RESTORE_BYTES,
  readSnapshotManifest,
  restoreSnapshot,
} from '../src/services/exportBackup';
import {
  deleteModelCache,
  deleteModelBlob,
  getAllModelRecords,
  getModelBlob,
  MODEL_CACHE_DB_NAME,
  putModelBlob,
} from '../src/utils/segmentation/onnx/modelCache';

// The IndexedDB emulator uses Node's structured-clone algorithm. Use its Blob
// implementation for both source and restored payloads; jsdom Blob loses bytes
// at that boundary. Feed JSZip ArrayBuffers instead of jsdom's FileReader.
beforeAll(() => vi.stubGlobal('Blob', NativeBlob));
afterAll(() => vi.unstubAllGlobals());

async function resetDb() {
  await new Promise<void>((resolve) => {
    const req = indexedDB.deleteDatabase('MiraViewerDB');
    req.onsuccess = () => resolve();
    req.onerror = () => resolve();
    req.onblocked = () => resolve();
  });
}

async function seedSnapshot(
  options: { model?: boolean | Blob; segmentation?: VolumeSegmentationRow; chunked?: boolean } = {},
) {
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
    // fake-indexeddb uses Node structuredClone; jsdom Blob becomes an empty
    // object there. Keep real bytes across the actual persistence boundary.
    fileBlob: new NativeBlob([new Uint8Array([1, 2, 3])]),
  });
  if (options.model)
    await putModelBlob(
      'synthetic-model',
      options.model === true ? new NativeBlob([new Uint8Array([5, 6, 7])]) : options.model,
    );
  if (options.segmentation) {
    if (options.chunked) await saveVolumeSegmentation(options.segmentation);
    else await db.put('volume_segmentations', options.segmentation);
  }

  await initializeComparisonState(db);
  const blob = await exportStudiesToZip(['study-1']);
  await resetDbForTests();
  await resetDb();
  await deleteModelCache();
  const archive = await loadSafeArchive(blob, { deferStorageCheck: true });
  const manifest = await readSnapshotManifest(archive.zip);
  if (!manifest) throw new Error('Synthetic complete backup has no manifest');
  return { archive, manifest, blob };
}

it('restores settings into a mounted viewer without allowing old timers or unload writes to overwrite them', async () => {
  const { archive, manifest } = await seedSnapshot();
  manifest.records.panelSettings = [
    {
      comboId: sourceSettingsKey('series-1'),
      source: { studyUid: 'study-1', seriesUid: 'series-1' },
      settings: { 'study-1': { ...DEFAULT_PANEL_SETTINGS, zoom: 5 } },
    },
  ];
  await restoreSnapshot(archive.zip, manifest);
  const data = await getComparisonData();
  const combo = data.sequences[0]!.id;
  const date = data.dates[0]!;
  const sources = data.series_map[combo];
  const readSettings = () => getPanelSettingsSnapshot(combo, data.selected_patient_key, sources);
  const original = await readSettings();
  await savePanelSettings(original.verifiedSources[date]!, { ...DEFAULT_PANEL_SETTINGS, zoom: 2 });
  const hook = renderHook(
    ({ token }) => usePanelSettings(combo, date, data.selected_patient_key, false, sources, token),
    {
      initialProps: { token: original.datasetToken },
    },
  );
  try {
    await waitFor(() => expect(hook.result.current.settingsReady).toBe(true));
    expect(hook.result.current.panelSettings.get(date)?.zoom).toBe(2);
    act(() => hook.result.current.setProgress(0.5));
    await act(async () => {
      await restoreSnapshot(archive.zip, manifest);
    });
    expect(hook.result.current.settingsReady).toBe(false);
    await expect(savePanelSettings(original.verifiedSources[date]!, DEFAULT_PANEL_SETTINGS)).rejects.toThrow(
      /replaced/,
    );
    const restored = await readSettings();
    expect(restored.datasetToken).not.toBe(original.datasetToken);
    await act(async () => hook.rerender({ token: restored.datasetToken }));
    await waitFor(() => expect(hook.result.current.settingsReady).toBe(true));
    expect(hook.result.current.panelSettings.get(date)?.zoom).toBe(5);
    act(() => hook.result.current.setProgress(0.75));
    await waitFor(async () => expect((await readSettings()).settings[date]).toMatchObject({ zoom: 5, progress: 0.75 }));

    act(() => hook.result.current.setProgress(0.9));
    await act(async () => {
      await deleteAllStoredMriData();
      window.dispatchEvent(new Event('beforeunload'));
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 250));
    });
    expect(await (await getDB()).count('panel_settings')).toBe(0);
  } finally {
    cleanup();
    await resetDbForTests();
    await resetDb();
  }
});

async function rewriteSnapshotManifest(
  blob: Blob,
  manifest: NonNullable<Awaited<ReturnType<typeof readSnapshotManifest>>>,
) {
  // The validated lazy archive is read-only; edited wire fixtures need a new ZIP and CRC-verified read.
  const zip = await JSZip.loadAsync(new Uint8Array(await blob.arrayBuffer()));
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
  it('round trips one conservatively isolated patient without stranding source settings or labels', async () => {
    const { archive, manifest } = await seedSnapshot();
    await restoreSnapshot(archive.zip, manifest);
    const db = await getDB();
    await db.put('studies', {
      ...manifest.records.studies[0]!,
      studyInstanceUid: 'conflicting-study',
      patientName: 'Another name',
    });
    await initializeComparisonState(db);
    const foreignChoice = { key: acquisitionChoiceKey('conflicting-study', 'unknown'), value: 'foreign-series' };
    await db.put('app_state', foreignChoice);
    const data = await getComparisonData();
    expect(data.selected_patient_key).toBe('P1#study-1');
    const combo = data.sequences[0]!.id;
    const date = data.dates[0]!;
    const owner = (await getPanelSettingsSnapshot(combo, data.selected_patient_key, data.series_map[combo]))
      .verifiedSources[date]!;
    await savePanelSettings(owner, { ...DEFAULT_PANEL_SETTINGS, zoom: 2, panX: 0.2 });
    await saveVolumeSegmentation({
      volumeKey: 'source-labels',
      patientKey: data.selected_patient_key!,
      studyUid: 'study-1',
      seriesUids: ['series-1'],
      dims: [2, 1, 1],
      labels: Uint8Array.of(1, 0),
      updatedAt: 1,
    });
    const backup = await exportStudiesToZip(['study-1']);
    await deleteAllStoredMriData();
    const isolated = await loadSafeArchive(backup, { deferStorageCheck: true });
    const isolatedManifest = await readSnapshotManifest(isolated.zip);
    expect(isolatedManifest!.records.appState.some((row) => row.key === foreignChoice.key)).toBe(false);
    // Old backups may have included foreign choices; they must not be republished.
    isolatedManifest!.records.appState.push(foreignChoice);
    await restoreSnapshot(isolated.zip, isolatedManifest!);
    expect(await (await getDB()).get('app_state', foreignChoice.key)).toBeUndefined();
    const restored = await getComparisonData();
    expect(restored.selected_patient_key).toBe('P1');
    const settings = await getPanelSettingsSnapshot(combo, restored.selected_patient_key, restored.series_map[combo]);
    expect(settings.settings[date]).toMatchObject({ zoom: 2, panX: 0.2 });
    expect(Array.from((await getVolumeSegmentation('source-labels'))!.labels)).toEqual([1, 0]);
  });

  it('enforces the import identity policy when a restored Study UID has a conflicting patient name', async () => {
    const { archive, manifest } = await seedSnapshot({ model: true });
    await putModelBlob('synthetic-model', new NativeBlob(['previous model']));
    const db = await getDB();
    await db.put('studies', { ...manifest.records.studies[0]!, patientName: 'Conflicting patient' });
    await expect(restoreSnapshot(archive.zip, manifest)).rejects.toThrow(/conflicting patient names/i);
    expect((await db.get('studies', 'study-1'))?.patientName).toBe('Conflicting patient');
    expect(await db.count('instances')).toBe(0);
    expect(await (await getModelBlob('synthetic-model'))!.text()).toBe('previous model');
  });

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
      fileBlob: new NativeBlob([new Uint8Array([1, 2, 3])]),
    });

    const blob = await exportStudiesToZip(['study-1']);
    const zip = await JSZip.loadAsync(new Uint8Array(await blob.arrayBuffer()));
    const files = Object.keys(zip.files);

    expect(files).toContain('export.json');
    // UID-addressed folders cannot collide when human descriptions repeat.
    expect(files.some((f) => f.includes('studies/study-1/series/series-1/'))).toBe(true);
    // DICOM file should exist
    expect(files.some((f) => f.endsWith('.dcm'))).toBe(true);
    expect(Array.from(await zip.file(files.find((file) => file.endsWith('.dcm'))!)!.async('uint8array'))).toEqual([
      1, 2, 3,
    ]);
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

  it('round trips chunked selections through the compatible backup format and removes replaced chunks on restore', async () => {
    const saved = { ...selectionRow(), patientKey: 'P1' };
    const { archive, manifest } = await seedSnapshot({ segmentation: saved, chunked: true, model: true });
    expect(manifest.records.volumeSegmentations[0]).not.toHaveProperty('storage');
    expect(manifest.records.volumeSegmentations[0]).not.toHaveProperty('revision');
    await restoreSnapshot(archive.zip, manifest);
    expect(await getVolumeSegmentation(saved.volumeKey)).toStrictEqual(structuredClone(saved));
    await saveVolumeSegmentation({ ...saved, labels: new Uint8Array(saved.labels.length).fill(1) });
    expect(await (await getDB()).count('volume_segmentation_chunks')).toBeGreaterThan(0);
    await restoreSnapshot(archive.zip, manifest);
    expect(await getVolumeSegmentation(saved.volumeKey)).toStrictEqual(structuredClone(saved));
    expect(await (await getDB()).count('volume_segmentation_chunks')).toBe(0);
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

  it('rejects aggregate export capacity before consuming file bytes, labels, hashes or ZIP entries', async () => {
    const saved = selectionRow();
    const { archive, manifest } = await seedSnapshot({ model: true, segmentation: saved });
    await restoreSnapshot(archive.zip, manifest);
    await saveVolumeSegmentation(saved);
    const db = await getDB();
    const original = (await db.get('instances', 'inst-1'))!;
    // Virtual declared sizes exercise admission without allocating a GiB fixture.
    const rows = [original, { ...original, sopInstanceUid: 'inst-2', fileBlob: new NativeBlob([Uint8Array.of(4)]) }];
    for (const row of rows) Object.defineProperty(row.fileBlob, 'size', { value: MAX_SNAPSHOT_RESTORE_BYTES / 2 });
    const query = vi.spyOn(db, 'getAllFromIndex').mockResolvedValueOnce(rows);
    const bytes = vi.spyOn(NativeBlob.prototype, 'arrayBuffer');
    const entries = vi.spyOn(JSZip.prototype, 'file');
    const reads = vi.spyOn(IDBObjectStore.prototype, 'getAll');
    try {
      await expect(exportStudiesToZip(['study-1'])).rejects.toThrow(/512 MiB safe restore limit/);
      expect(bytes).not.toHaveBeenCalled();
      expect(entries).not.toHaveBeenCalled();
      expect(reads.mock.contexts.filter((store) => store.name === 'volume_segmentation_chunks')).toHaveLength(0);
      expect(await db.count('instances')).toBe(1);
      expect(Array.from(new Uint8Array(await (await db.get('instances', 'inst-1'))!.fileBlob.arrayBuffer()))).toEqual([
        1, 2, 3,
      ]);
    } finally {
      query.mockRestore();
      bytes.mockRestore();
      entries.mockRestore();
      reads.mockRestore();
    }
  });

  it('uses an inclusive payload ceiling in both directions', () => {
    expect(() => assertSnapshotCapacity(MAX_SNAPSHOT_RESTORE_BYTES)).not.toThrow();
    expect(() => assertSnapshotCapacity(MAX_SNAPSHOT_RESTORE_BYTES + 1)).toThrow(/512 MiB/);
    expect(() => assertSnapshotCapacity(Number.MAX_SAFE_INTEGER + 1)).toThrow(/invalid payload size/);
  });

  it('round trips a highly compressible below-cap model without weakening archive expansion guards', async () => {
    const bytes = new Uint8Array(1024 * 1024);
    const { archive, manifest } = await seedSnapshot({ model: new NativeBlob([bytes]) });
    expect(getSnapshotRestoreBytes(manifest)).toBeLessThan(MAX_SNAPSHOT_RESTORE_BYTES);
    await expect(restoreSnapshot(archive.zip, manifest)).resolves.toMatchObject({ ingested: 1 });
    const restored = new Uint8Array(await (await getModelBlob('synthetic-model'))!.arrayBuffer());
    expect(restored.byteLength).toBe(bytes.byteLength);
    expect(restored.some((value) => value !== 0)).toBe(false);
  });

  it.each(['before reading', 'collecting', 'packaging'] as const)(
    'cancels export %s without publishing a result',
    async (phase) => {
      const { archive, manifest } = await seedSnapshot({ model: true, segmentation: selectionRow() });
      await restoreSnapshot(archive.zip, manifest);
      const controller = new AbortController();
      if (phase === 'before reading') controller.abort();
      const progress = vi.fn((update: { stage: string; current: number }) => {
        if (
          (phase === 'collecting' && update.stage === 'collecting') ||
          (phase === 'packaging' && update.stage === 'zipping' && update.current > 0)
        )
          controller.abort();
      });
      await expect(exportStudiesToZip(['study-1'], progress, { signal: controller.signal })).rejects.toMatchObject({
        name: 'AbortError',
      });
      expect(controller.signal.aborted).toBe(true);
      expect(progress.mock.calls.some(([update]) => update.stage === 'finalizing')).toBe(false);
      expect(await (await getDB()).count('instances')).toBe(1);
    },
  );

  it('detects model-cache version conflicts before committing medical images or annotations', async () => {
    const { archive, manifest } = await seedSnapshot({ model: true });
    // A fresh shared database must first admit an unmigrated legacy cache.
    await deleteAllStoredMriData();
    const newer = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open(MODEL_CACHE_DB_NAME, 3);
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

  it('migrates legacy model bytes once, preserving metadata and avoiding resurrection after a model deletion', async () => {
    await deleteModelCache();
    await deleteAllStoredMriData();
    const record = { key: 'legacy-private-model', blob: new NativeBlob(['synthetic legacy bytes']), savedAtMs: 123 };
    const legacy = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open(MODEL_CACHE_DB_NAME, 1);
      request.onupgradeneeded = () => request.result.createObjectStore('models').put(record, record.key);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    let retired = false;
    legacy.onversionchange = () => {
      retired = true;
      legacy.close();
    };
    const copied = await getAllModelRecords();
    expect(retired).toBe(true);
    expect(copied).toHaveLength(1);
    expect(copied[0]).toMatchObject({ key: record.key, savedAtMs: 123 });
    expect(await copied[0]!.blob.text()).toBe('synthetic legacy bytes');
    expect(await (await getDB()).count('models')).toBe(1);
    await deleteModelBlob(record.key);
    await resetDbForTests();
    expect(await getAllModelRecords()).toEqual([]);
  });

  it('rolls back medical rows, models and saved-work identity when the final model write fails', async () => {
    const selection = selectionRow();
    const { archive, manifest } = await seedSnapshot({ model: true, segmentation: selection });
    await restoreSnapshot(archive.zip, manifest);
    const db = await getDB();
    await db.put('instances', { ...(await db.get('instances', 'inst-1'))!, fileBlob: new NativeBlob(['prior scan']) });
    await putModelBlob('synthetic-model', new NativeBlob(['prior model']));
    await saveVolumeSegmentation({
      ...selection,
      labels: Uint8Array.from(selection.labels, (_, index) => Number(index === 5)),
      seeds: {
        foreground: Uint32Array.of(5),
        background: Uint32Array.of(19),
        lastStroke: { plane: 'axial', slice: 0 },
      },
      reviewState: 'draft',
    });
    const token = await db.get('app_state', DATASET_TOKEN_STATE_KEY);
    const labels = await getVolumeSegmentation(selection.volumeKey);
    const original = IDBObjectStore.prototype.put;
    const put = vi.spyOn(IDBObjectStore.prototype, 'put').mockImplementation(function (this: IDBObjectStore, ...args) {
      if (this.name === 'models') throw new DOMException('Synthetic model quota exhaustion', 'QuotaExceededError');
      return Reflect.apply(original, this, args);
    });
    try {
      await expect(restoreSnapshot(archive.zip, manifest)).rejects.toThrow(/quota exhaustion/);
    } finally {
      put.mockRestore();
    }
    expect(await (await db.get('instances', 'inst-1'))!.fileBlob.text()).toBe('prior scan');
    expect(await (await getModelBlob('synthetic-model'))!.text()).toBe('prior model');
    expect(await db.get('app_state', DATASET_TOKEN_STATE_KEY)).toEqual(token);
    expect(await getVolumeSegmentation(selection.volumeKey)).toEqual(labels);
  });

  it('does not let restored app state re-enable an obsolete model authority', async () => {
    const { archive, manifest } = await seedSnapshot({ model: true });
    const legacy = await openDB(MODEL_CACHE_DB_NAME, 2, {
      upgrade(db) {
        db.createObjectStore('models');
      },
    });
    await legacy.put(
      'models',
      { key: 'synthetic-model', blob: new NativeBlob(['obsolete bytes']), savedAtMs: 1 },
      'synthetic-model',
    );
    legacy.close();
    manifest.records.appState.push({ key: 'model_cache_migrated', value: false });
    await restoreSnapshot(archive.zip, manifest);
    await resetDbForTests();
    expect(Array.from(new Uint8Array(await (await getModelBlob('synthetic-model'))!.arrayBuffer()))).toEqual([5, 6, 7]);
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
