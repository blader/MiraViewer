import { afterEach, describe, expect, it, vi } from 'vitest';
import { Blob as NodeBlob } from 'node:buffer';
import {
  DATASET_REVISION_STATE_KEY,
  DATASET_TOKEN_STATE_KEY,
  deleteAllStoredMriData,
  getDB,
  resetDbForTests,
} from '../src/db/db';
import { DEFAULT_PANEL_SETTINGS } from '../src/utils/constants';
import { alignmentDisplayBaseline, DEFAULT_ALIGNMENT_ADJUSTMENT } from '../src/utils/alignmentAdjustment';
import {
  getComparisonData,
  getImageIdForInstance,
  getPanelSettingsSnapshot,
  getSeriesFrameManifest,
  getStudies,
  savePanelSettings,
  saveVolumeSegmentation,
  getVolumeSegmentation,
  getVolumeSegmentationSnapshot,
  deleteVolumeSegmentation,
  selectAcquisition,
  setSelectedPatientKey,
} from '../src/utils/localApi';
import { initializeComparisonState } from '../src/db/comparisonState';
import { sourceSettingsKey } from '../src/db/comparisonIdentity';
import type { VolumeSegmentationRow } from '../src/db/schema';
import { SELECTION_CHUNK_BYTES } from '../src/db/volumeSegmentations';
import { selectionPatch } from '../src/utils/segmentation/selectionEditing';

async function resetDb() {
  await new Promise<void>((resolve) => {
    const req = indexedDB.deleteDatabase('MiraViewerDB');
    req.onsuccess = () => resolve();
    req.onerror = () => resolve();
    req.onblocked = () => resolve();
  });
}

async function seedAcquisition(studyUid: string, seriesUid: string, count = 1, patientName = 'Synthetic Patient') {
  const db = await getDB();
  await db.put('studies', {
    studyInstanceUid: studyUid,
    studyDate: '20350101',
    studyTime: '120000',
    patientId: 'reused-id',
    patientName,
    studyDescription: 'Synthetic',
    modality: 'MR',
  });
  await db.put('series', {
    studyInstanceUid: studyUid,
    seriesInstanceUid: seriesUid,
    seriesDescription: 'Axial T2 SE',
    seriesNumber: 1,
    plane: 'Axial',
    weight: 'T2',
    sequenceType: 'SE',
    modality: 'MR',
  });
  for (let i = 0; i < count; i++)
    await db.put('instances', {
      studyInstanceUid: studyUid,
      seriesInstanceUid: seriesUid,
      sopInstanceUid: `${seriesUid}.${i}`,
      instanceNumber: i + 1,
      rows: 2,
      columns: 2,
      fileBlob: new Blob([Uint8Array.of(i)]),
    });
  await initializeComparisonState(db);
}

async function selectedSettings(patient?: string) {
  const data = await getComparisonData(patient);
  const combo = data.sequences[0]!.id;
  const date = data.dates[0]!;
  const snapshot = await getPanelSettingsSnapshot(combo, data.selected_patient_key, data.series_map[combo]);
  return { data, combo, date, snapshot, owner: snapshot.verifiedSources[date]! };
}

describe('localApi', () => {
  afterEach(async () => {
    vi.restoreAllMocks();
    await resetDbForTests();
    await resetDb();
  });

  it('keeps acquisition choices and source-owned settings through a timestamp collision and a larger import', async () => {
    await seedAcquisition('study-a', 'series-a', 2);
    let data = await getComparisonData();
    const combo = data.sequences[0]!.id;
    const date = data.dates[0]!;
    const { owner } = await selectedSettings();
    await savePanelSettings(owner, { ...DEFAULT_PANEL_SETTINGS, zoom: 2 });
    await seedAcquisition('study-b', 'series-b');
    await seedAcquisition('study-a', 'larger-series', 4);
    data = await getComparisonData();
    const movedDate = Object.keys(data.examinations).find((key) => data.examinations[key]!.study_uid === 'study-a')!;
    expect(movedDate).not.toBe(date);
    expect(data.series_map[combo]![movedDate]!.series_uid).toBe('series-a');
    expect(data.series_candidates![combo]![movedDate]).toHaveLength(2);
    let settings = await getPanelSettingsSnapshot(combo, data.selected_patient_key, data.series_map[combo]);
    expect(settings.settings[movedDate]?.zoom).toBe(2);
    await selectAcquisition('study-a', combo, 'larger-series');
    data = await getComparisonData();
    settings = await getPanelSettingsSnapshot(combo, data.selected_patient_key, data.series_map[combo]);
    expect(settings.settings[movedDate]).toBeUndefined();
    await savePanelSettings(settings.verifiedSources[movedDate]!, { ...DEFAULT_PANEL_SETTINGS, zoom: 3 });
    await selectAcquisition('study-a', combo, 'series-a');
    data = await getComparisonData();
    expect(
      (await getPanelSettingsSnapshot(combo, data.selected_patient_key, data.series_map[combo])).settings[movedDate]
        ?.zoom,
    ).toBe(2);
    expect(
      (await (await getDB()).get('panel_settings', sourceSettingsKey('larger-series')))?.settings['study-a']?.zoom,
    ).toBe(3);
  });

  it('projects unambiguous legacy settings without writing on read, but asks for a source when ambiguous', async () => {
    await seedAcquisition('study-a', 'series-a');
    let data = await getComparisonData();
    const combo = data.sequences[0]!.id;
    const date = data.dates[0]!;
    await (
      await getDB()
    ).put('panel_settings', {
      comboId: `${data.selected_patient_key}::${combo}`,
      settings: { [date]: { ...DEFAULT_PANEL_SETTINGS, zoom: 2 } },
    });
    const migrated = await getPanelSettingsSnapshot(combo, data.selected_patient_key, data.series_map[combo]);
    expect(migrated.settings[date]?.zoom).toBe(2);
    expect(migrated.legacySettings).toEqual([]);
    const db = await getDB();
    expect((await db.get('panel_settings', `${data.selected_patient_key}::${combo}`))?.settings[date]?.zoom).toBe(2);
    expect(await db.get('panel_settings', sourceSettingsKey('series-a'))).toBeUndefined();
    await savePanelSettings(migrated.verifiedSources[date]!, { ...DEFAULT_PANEL_SETTINGS, zoom: 3 });
    expect((await db.get('panel_settings', sourceSettingsKey('series-a')))?.source?.legacyOrigin).toEqual({
      comboId: `${data.selected_patient_key}::${combo}`,
      dateIso: date,
    });
    await db.delete('panel_settings', sourceSettingsKey('series-a'));
    await seedAcquisition('study-a', 'series-alternative', 2);
    data = await getComparisonData();
    const ambiguous = await getPanelSettingsSnapshot(combo, data.selected_patient_key, data.series_map[combo]);
    expect(ambiguous.settings[date]).toBeUndefined();
    expect(ambiguous.legacySettings).toHaveLength(1);
    await savePanelSettings(
      ambiguous.verifiedSources[date]!,
      { ...DEFAULT_PANEL_SETTINGS, zoom: 2 },
      ambiguous.legacySettings[0]!.origin,
    );
    const assigned = await getPanelSettingsSnapshot(combo, data.selected_patient_key, data.series_map[combo]);
    expect(assigned.settings[date]?.zoom).toBe(2);
    expect(assigned.legacySettings).toEqual([]);
  });

  it('keeps malformed legacy assignment evidence recoverable without granting automatic source ownership', async () => {
    await seedAcquisition('study-a', 'series-a');
    const data = await getComparisonData();
    const combo = data.sequences[0]!.id;
    const date = data.dates[0]!;
    const legacy = {
      comboId: `${data.selected_patient_key}::${combo}`,
      settings: { [date]: { ...DEFAULT_PANEL_SETTINGS, zoom: 2 } },
      assignmentRequired: [false] as unknown as string[],
    };
    const db = await getDB();
    await db.put('panel_settings', legacy);
    const snapshot = await getPanelSettingsSnapshot(combo, data.selected_patient_key, data.series_map[combo]);
    expect(snapshot.settings).toEqual({});
    expect(snapshot.legacySettings[0]?.settings.zoom).toBe(2);
    expect(await db.get('panel_settings', legacy.comboId)).toStrictEqual(legacy);
  });

  it('retains the selected source and its labels when conservative patient grouping changes', async () => {
    await seedAcquisition('study-a', 'series-a', 1, 'Zulu');
    const original = await getComparisonData();
    await saveVolumeSegmentation({
      volumeKey: 'source-labels',
      patientKey: original.selected_patient_key!,
      studyUid: 'study-a',
      seriesUids: ['series-a'],
      dims: [2, 1, 1],
      labels: Uint8Array.of(1, 0),
      updatedAt: 1,
    });
    await seedAcquisition('study-b', 'series-b', 1, 'Alpha');
    const changed = await getComparisonData();
    expect(changed.selected_patient_key).toBe('reused-id#study-a');
    expect(changed.patients).toHaveLength(2);
    expect(Array.from((await getVolumeSegmentation('source-labels'))!.labels)).toEqual([1, 0]);
    await setSelectedPatientKey('reused-id#study-b');
    expect(await getVolumeSegmentation('source-labels')).toBeNull();
  });

  it('captures a sparse edit before yielding and writes only its touched label chunks', async () => {
    const record: VolumeSegmentationRow = {
      volumeKey: 'sparse',
      dims: [128, 64, 64],
      labels: new Uint8Array(128 * 64 * 64),
      updatedAt: 1,
    };
    await saveVolumeSegmentation(record);
    const snapshot = await getVolumeSegmentationSnapshot(record.volumeKey);
    const labels = record.labels.slice();
    const indices = Uint32Array.of(23, SELECTION_CHUNK_BYTES + 37);
    for (const index of indices) labels[index] = 1;
    const patch = selectionPatch(record.labels, labels, indices);
    const foreground = indices.slice();
    const put = vi.spyOn(IDBObjectStore.prototype, 'put');
    const getAll = vi.spyOn(IDBObjectStore.prototype, 'getAll');
    const saving = saveVolumeSegmentation(
      { ...record, labels, seeds: { foreground, background: new Uint32Array() } },
      {
        expectedRevision: snapshot.revision,
        revision: 'edit-1',
        datasetToken: snapshot.datasetToken,
        patch,
      },
    );
    labels.fill(0);
    foreground.fill(99);
    patch.after.fill(0);
    await saving;
    const written = put.mock.calls.map(([value]) => value);
    const chunkWrites = written.filter((value) => value.data instanceof Uint8Array);
    expect(chunkWrites.map((value) => value.offset)).toEqual([0, SELECTION_CHUNK_BYTES]);
    expect(chunkWrites.reduce((bytes, value) => bytes + value.data.byteLength, 0)).toBe(2 * SELECTION_CHUNK_BYTES);
    expect(written.some((value) => 'labels' in value)).toBe(false);
    expect(getAll.mock.contexts.some((store) => store.name === 'volume_segmentation_chunks')).toBe(false);
    const reopened = await getVolumeSegmentation(record.volumeKey);
    expect(reopened!.labels.reduce((sum, value) => sum + value, 0)).toBe(2);
    expect(indices.map((index) => reopened!.labels[index]!)).toEqual(Uint32Array.of(1, 1));
    expect(Array.from(reopened!.seeds!.foreground)).toEqual(Array.from(indices));
  });

  it('commits queued revisions before an immediate reopen, and stores review-only changes without reading label chunks', async () => {
    const key = 'queued';
    const snapshot = await getVolumeSegmentationSnapshot(key);
    const blank = new Uint8Array(8192),
      first = blank.slice(),
      second = blank.slice();
    first[3] = 1;
    second.set(first);
    second[5000] = 1;
    const record = { volumeKey: key, dims: [128, 64, 1] as [number, number, number], labels: first, updatedAt: 1 };
    const firstSave = saveVolumeSegmentation(record, {
      expectedRevision: null,
      revision: 'first',
      datasetToken: snapshot.datasetToken,
      patch: selectionPatch(blank, first, Uint32Array.of(3)),
    });
    const secondSave = saveVolumeSegmentation(
      { ...record, labels: second, updatedAt: 2 },
      {
        expectedRevision: 'first',
        revision: 'second',
        datasetToken: snapshot.datasetToken,
        patch: selectionPatch(first, second, Uint32Array.of(5000)),
      },
    );
    const reopened = await getVolumeSegmentationSnapshot(key);
    await Promise.all([firstSave, secondSave]);
    expect(reopened.revision).toBe('second');
    expect(reopened.record!.labels).toEqual(second);
    const get = vi.spyOn(IDBObjectStore.prototype, 'get');
    const put = vi.spyOn(IDBObjectStore.prototype, 'put');
    await saveVolumeSegmentation(
      { ...reopened.record!, reviewState: 'reviewed' },
      {
        expectedRevision: reopened.revision,
        revision: 'review',
        datasetToken: reopened.datasetToken,
        patch: selectionPatch(second, second, new Uint32Array()),
      },
    );
    expect(get.mock.contexts.some((store) => store.name === 'volume_segmentation_chunks')).toBe(false);
    expect(put.mock.contexts.filter((store) => store.name === 'volume_segmentation_chunks')).toHaveLength(0);
    expect((await getVolumeSegmentation(key))!.reviewState).toBe('reviewed');
  });

  it('captures a dense proposal as one checkpoint instead of copying its larger reversible patch', async () => {
    const record: VolumeSegmentationRow = {
      volumeKey: 'dense-proposal',
      dims: [128, 64, 1],
      labels: new Uint8Array(8192),
      updatedAt: 1,
    };
    await saveVolumeSegmentation(record);
    const snapshot = await getVolumeSegmentationSnapshot(record.volumeKey);
    const after = new Uint8Array(record.labels.length).fill(1);
    const patch = selectionPatch(record.labels, after);
    const copyIndices = vi.spyOn(patch.indices, 'slice');
    const saving = saveVolumeSegmentation(
      { ...record, labels: after },
      {
        expectedRevision: snapshot.revision,
        revision: 'dense',
        datasetToken: snapshot.datasetToken,
        patch,
      },
    );
    after.fill(0);
    await saving;
    expect(copyIndices).not.toHaveBeenCalled();
    expect((await getVolumeSegmentation(record.volumeKey))!.labels.every((value) => value === 1)).toBe(true);
  });

  it.each(['conflict', 'quota'] as const)(
    'rolls back every chunk and metadata after a late %s failure, then allows an exact retry',
    async (failure) => {
      const record: VolumeSegmentationRow = {
        volumeKey: 'atomic',
        dims: [128, 64, 1],
        labels: new Uint8Array(8192),
        updatedAt: 1,
      };
      await saveVolumeSegmentation(record);
      const snapshot = await getVolumeSegmentationSnapshot(record.volumeKey);
      const after = record.labels.slice();
      after[3] = after[5000] = 1;
      const patch = selectionPatch(record.labels, after, Uint32Array.of(3, 5000));
      if (failure === 'conflict') patch.before[1] = 1;
      const originalPut = IDBObjectStore.prototype.put;
      const put = vi.spyOn(IDBObjectStore.prototype, 'put').mockImplementation(function (
        this: IDBObjectStore,
        value,
        key,
      ) {
        if (failure === 'quota' && this.name === 'volume_segmentation_chunks' && value.offset === 4096)
          throw new DOMException('Synthetic quota exhaustion', 'QuotaExceededError');
        return key === undefined ? originalPut.call(this, value) : originalPut.call(this, value, key);
      });
      await expect(
        saveVolumeSegmentation(
          { ...record, labels: after, reviewState: 'reviewed' },
          {
            expectedRevision: snapshot.revision,
            revision: 'failed',
            datasetToken: snapshot.datasetToken,
            patch,
          },
        ),
      ).rejects.toThrow(failure === 'quota' ? /quota/i : /changed/i);
      put.mockRestore();
      expect(await getVolumeSegmentationSnapshot(record.volumeKey)).toEqual(snapshot);
      expect(await (await getDB()).count('volume_segmentation_chunks')).toBe(0);
      patch.before[1] = 0;
      await saveVolumeSegmentation(
        { ...record, labels: after, reviewState: 'reviewed' },
        {
          expectedRevision: snapshot.revision,
          revision: 'retry',
          datasetToken: snapshot.datasetToken,
          patch,
        },
      );
      expect((await getVolumeSegmentation(record.volumeKey))!.labels).toEqual(after);
      expect((await getVolumeSegmentation(record.volumeKey))!.reviewState).toBe('reviewed');
    },
  );

  it('keeps legacy dense rows readable and migrates their complete contents on the first patch', async () => {
    const record: VolumeSegmentationRow = {
      volumeKey: 'legacy-labels',
      dims: [128, 64, 1],
      labels: new Uint8Array(8192),
      updatedAt: 1,
      seeds: { foreground: Uint32Array.of(7), background: Uint32Array.of(8) },
    };
    record.labels[7] = 2;
    record.labels[8000] = 3;
    // Open the actual earlier schema, not just a dense row in a new database.
    await new Promise<void>((resolve, reject) => {
      const request = indexedDB.open('MiraViewerDB', 7);
      request.onupgradeneeded = () =>
        request.result.createObjectStore('volume_segmentations', { keyPath: 'volumeKey' }).put(record);
      request.onerror = () => reject(request.error);
      request.onblocked = () => reject(new Error('The synthetic legacy database is still open.'));
      request.onsuccess = () => {
        request.result.close();
        resolve();
      };
    });
    const db = await getDB();
    const snapshot = await getVolumeSegmentationSnapshot(record.volumeKey);
    expect(snapshot.record).toEqual(structuredClone(record));
    expect(await db.get('volume_segmentations', record.volumeKey)).toEqual(structuredClone(record));
    const next = record.labels.slice();
    next[16] = 1;
    await saveVolumeSegmentation(
      { ...record, labels: next },
      {
        expectedRevision: snapshot.revision,
        revision: 'migrated',
        datasetToken: snapshot.datasetToken,
        patch: selectionPatch(record.labels, next, Uint32Array.of(16)),
      },
    );
    expect(await getVolumeSegmentation(record.volumeKey)).toEqual({ ...structuredClone(record), labels: next });
    expect(await db.get('volume_segmentations', record.volumeKey)).not.toHaveProperty('labels');
    await deleteVolumeSegmentation(record.volumeKey);
    expect(await db.count('volume_segmentation_chunks')).toBe(0);
  });

  it('rejects an incomplete chunk set instead of reopening missing saved tissue as background', async () => {
    const record: VolumeSegmentationRow = {
      volumeKey: 'missing-chunk',
      dims: [128, 64, 1],
      labels: new Uint8Array(8192).fill(1),
      updatedAt: 1,
    };
    await saveVolumeSegmentation(record);
    const db = await getDB();
    await db.delete('volume_segmentation_chunks', [record.volumeKey, 4096]);
    await expect(getVolumeSegmentation(record.volumeKey)).rejects.toThrow(/missing label chunks/i);
    expect(await db.get('volume_segmentations', record.volumeKey)).toMatchObject({ chunkCount: 2 });
  });

  it('rejects writers from an older saved revision or replaced dataset without changing the newer saved work', async () => {
    const record: VolumeSegmentationRow = {
      volumeKey: 'fenced',
      dims: [2, 1, 1],
      labels: Uint8Array.of(1, 0),
      updatedAt: 1,
    };
    await saveVolumeSegmentation(record);
    const stale = await getVolumeSegmentationSnapshot(record.volumeKey);
    await saveVolumeSegmentation({ ...record, labels: Uint8Array.of(1, 1), updatedAt: 2 });
    const current = await getVolumeSegmentationSnapshot(record.volumeKey);
    await expect(
      saveVolumeSegmentation(record, {
        expectedRevision: stale.revision,
        revision: 'stale',
        datasetToken: stale.datasetToken,
      }),
    ).rejects.toThrow(/changed/i);
    await (await getDB()).put('app_state', { key: DATASET_TOKEN_STATE_KEY, value: 'replacement' });
    await expect(
      saveVolumeSegmentation(record, {
        expectedRevision: current.revision,
        revision: 'stale-dataset',
        datasetToken: current.datasetToken,
      }),
    ).rejects.toThrow(/replaced/i);
    await expect(
      deleteVolumeSegmentation(record.volumeKey, {
        expectedRevision: current.revision,
        datasetToken: current.datasetToken,
      }),
    ).rejects.toThrow(/replaced/i);
    expect(await getVolumeSegmentation(record.volumeKey)).toEqual(current.record);
  });

  it.each([
    [undefined, undefined],
    [0, false],
    [152, true],
  ] as const)(
    'round trips mask-owned clipping %s and context %s, including explicit false and unknown legacy evidence',
    async (clippedNativeVoxels, contextLimited) => {
      const record: VolumeSegmentationRow = {
        volumeKey: 'coverage',
        dims: [2, 1, 1],
        labels: Uint8Array.of(1, 0),
        updatedAt: 1,
        ...(clippedNativeVoxels !== undefined ? { clippedNativeVoxels } : {}),
        ...(contextLimited !== undefined ? { contextLimited } : {}),
      };
      await saveVolumeSegmentation(record);
      const restored = await getVolumeSegmentation(record.volumeKey);
      expect(restored?.clippedNativeVoxels).toBe(clippedNativeVoxels);
      expect(restored?.contextLimited).toBe(contextLimited);
      expect(Array.from(restored!.labels)).toEqual([1, 0]);
      if (clippedNativeVoxels === undefined) expect(restored).not.toHaveProperty('clippedNativeVoxels');
      if (contextLimited === undefined) expect(restored).not.toHaveProperty('contextLimited');
    },
  );

  it.each([
    ...[null, '152', -1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1].map((value) => ({
      field: 'clippedNativeVoxels' as const,
      value,
    })),
    ...[null, 'false', 0, 1, {}].map((value) => ({ field: 'contextLimited' as const, value })),
  ])('rejects malformed $field ($value) without overwriting or hiding saved work', async ({ field, value }) => {
    const original: VolumeSegmentationRow = {
      volumeKey: 'coverage',
      dims: [1, 1, 1],
      labels: Uint8Array.of(1),
      clippedNativeVoxels: 152,
      contextLimited: true,
      updatedAt: 1,
    };
    await saveVolumeSegmentation(original);
    const malformed = Object.assign({ ...original }, { [field]: value }) as VolumeSegmentationRow;
    await expect(saveVolumeSegmentation(malformed)).rejects.toThrow(/invalid viewing-region coverage/i);
    expect(await getVolumeSegmentation(original.volumeKey)).toStrictEqual({
      ...structuredClone(original),
      labels: original.labels,
    });
    const db = await getDB();
    await db.put('volume_segmentations', malformed);
    await expect(getVolumeSegmentation(original.volumeKey)).rejects.toThrow(/invalid viewing-region coverage/i);
    expect((await db.get('volume_segmentations', original.volumeKey))?.[field]).toEqual(value);
  });

  it('builds comparison data from stored studies/series/instances', async () => {
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
      seriesDescription: 'Axial T1',
      seriesNumber: 1,
      modality: 'MR',
      plane: 'Axial',
      weight: 'T1',
      sequenceType: 'SE',
    });
    await db.put('instances', {
      sopInstanceUid: 'inst-1',
      seriesInstanceUid: 'series-1',
      studyInstanceUid: 'study-1',
      instanceNumber: 1,
      rows: 256,
      columns: 256,
      fileBlob: new Blob([new Uint8Array([1])]),
    });

    const data = await getComparisonData();
    expect(data.planes).toContain('Axial');
    expect(data.dates[0]).toContain('2024-01-01');
    expect(data.sequences[0].label).toContain('Axial');
    expect(Object.keys(data.series_map).length).toBe(1);
  });

  it('prefers the highest-instance series when multiple series map to the same date+combo', async () => {
    const db = await getDB();
    await db.put('studies', {
      studyInstanceUid: 'study-1',
      studyDate: '20240101',
      studyDescription: 'Test Study',
      patientName: 'Test',
      patientId: 'P1',
      modality: 'MR',
    });

    // Two series that both parse to the "unknown" combo (no plane/weight/sequenceType).
    // Note: avoid substrings like "SE" which would be picked up by our simple heuristics.
    await db.put('series', {
      seriesInstanceUid: 'series-1',
      studyInstanceUid: 'study-1',
      seriesDescription: 'Mystery Scan A',
      seriesNumber: 1,
      modality: 'MR',
    });
    await db.put('series', {
      seriesInstanceUid: 'series-2',
      studyInstanceUid: 'study-1',
      seriesDescription: 'Mystery Scan B',
      seriesNumber: 2,
      modality: 'MR',
    });

    // series-1 has 1 instance; series-2 has 5 instances.
    await db.put('instances', {
      sopInstanceUid: 's1-inst-1',
      seriesInstanceUid: 'series-1',
      studyInstanceUid: 'study-1',
      instanceNumber: 1,
      rows: 256,
      columns: 256,
      fileBlob: new Blob([new Uint8Array([1])]),
    });

    for (let i = 1; i <= 5; i++) {
      await db.put('instances', {
        sopInstanceUid: `s2-inst-${i}`,
        seriesInstanceUid: 'series-2',
        studyInstanceUid: 'study-1',
        instanceNumber: i,
        rows: 256,
        columns: 256,
        fileBlob: new Blob([new Uint8Array([1])]),
      });
    }

    const data = await getComparisonData();

    const dateIso = '2024-01-01T00:00:00';
    const chosen = data.series_map['unknown']?.[dateIso];

    expect(chosen).toBeTruthy();
    expect(chosen?.series_uid).toBe('series-2');
    expect(chosen?.instance_count).toBe(5);
  });

  it('uses read-only catalog and settings snapshots, then only the token and one source row on save', async () => {
    await seedAcquisition('study-a', 'series-a');
    const transactions = vi.spyOn(IDBDatabase.prototype, 'transaction');
    const { owner } = await selectedSettings();
    expect(transactions.mock.calls.every(([, mode]) => !mode || mode === 'readonly')).toBe(true);
    transactions.mockClear();
    await savePanelSettings(owner, { ...DEFAULT_PANEL_SETTINGS, zoom: 1.5 });
    expect(transactions.mock.calls).toHaveLength(1);
    expect(transactions.mock.calls[0]!.slice(0, 2)).toEqual([['panel_settings', 'app_state'], 'readwrite']);
    expect((await selectedSettings()).snapshot.settings[(await selectedSettings()).date]?.zoom).toBe(1.5);
  });

  it('fences settings writes against replacement/reset without rejecting additive content revisions', async () => {
    await seedAcquisition('study-a', 'series-a');
    const { owner, date } = await selectedSettings();
    const db = await getDB();
    await db.put('app_state', { key: DATASET_REVISION_STATE_KEY, value: 42 });
    await savePanelSettings(owner, { ...DEFAULT_PANEL_SETTINGS, zoom: 2 });
    expect((await selectedSettings()).snapshot.settings[date]?.zoom).toBe(2);
    await db.put('app_state', { key: DATASET_TOKEN_STATE_KEY, value: 'replacement' });
    await expect(savePanelSettings(owner, DEFAULT_PANEL_SETTINGS)).rejects.toThrow(/replaced/);
    expect((await selectedSettings()).snapshot.settings[date]?.zoom).toBe(2);
    const replacement = (await selectedSettings()).owner;
    await deleteAllStoredMriData();
    await expect(savePanelSettings(replacement, DEFAULT_PANEL_SETTINGS)).rejects.toThrow(/replaced/);
    expect(await (await getDB()).count('panel_settings')).toBe(0);
  });

  it('round-trips correction intent and unclipped baseline under its verified source, including explicit clearing', async () => {
    await seedAcquisition('study-a', 'series-a');
    const { owner, date, data, combo } = await selectedSettings();
    const baseline = { ...DEFAULT_PANEL_SETTINGS, brightness: 199, affine01: 0.02 };
    const settings = {
      ...baseline,
      brightness: 200,
      alignmentAdjustment: { ...DEFAULT_ALIGNMENT_ADJUSTMENT, brightness: 10, sliceOffset: -2 },
      alignmentBaseline: alignmentDisplayBaseline(baseline),
      alignmentPaused: true,
    };
    await savePanelSettings(owner, settings);
    expect((await selectedSettings()).snapshot.settings[date]).toEqual(settings);
    await expect(getPanelSettingsSnapshot(combo, 'another-patient', data.series_map[combo])).rejects.toThrow(/patient/);
    await savePanelSettings(owner, {
      ...baseline,
      alignmentAdjustment: undefined,
      alignmentBaseline: undefined,
      alignmentPaused: false,
    });
    const reset = (await selectedSettings()).snapshot.settings[date]!;
    expect(reset.alignmentAdjustment).toBeUndefined();
    expect(reset.alignmentBaseline).toBeUndefined();
    expect(reset.alignmentPaused).toBe(false);
    expect(reset.brightness).toBe(199);
  });

  it('resolves imageId for instance index', async () => {
    const db = await getDB();
    await db.put('instances', {
      sopInstanceUid: 'inst-1',
      seriesInstanceUid: 'series-1',
      studyInstanceUid: 'study-1',
      instanceNumber: 2,
      rows: 256,
      columns: 256,
      fileBlob: new Blob([new Uint8Array([1])]),
    });
    await db.put('instances', {
      sopInstanceUid: 'inst-0',
      seriesInstanceUid: 'series-1',
      studyInstanceUid: 'study-1',
      instanceNumber: 1,
      rows: 256,
      columns: 256,
      fileBlob: new Blob([new Uint8Array([1])]),
    });

    const imageId = await getImageIdForInstance('series-1', 0);
    expect(imageId).toBe('miradb:inst-0');
  });

  it('counts all selected series through one bounded IndexedDB read transaction', async () => {
    const db = await getDB();
    await db.put('studies', {
      studyInstanceUid: 'count-study',
      studyDate: '20350101',
      studyDescription: 'Synthetic examination',
      patientName: 'Synthetic Patient',
      patientId: 'synthetic-patient',
      modality: 'MR',
    });

    for (let index = 0; index < 80; index++) {
      const seriesUid = `count-series-${index}`;
      await db.put('series', {
        seriesInstanceUid: seriesUid,
        studyInstanceUid: 'count-study',
        seriesDescription: 'Axial T2',
        seriesNumber: index,
        modality: 'MR',
      });
      await db.put('instances', {
        sopInstanceUid: `count-instance-${index}`,
        seriesInstanceUid: seriesUid,
        studyInstanceUid: 'count-study',
        instanceNumber: 1,
        rows: 16,
        columns: 16,
        fileBlob: new Blob([new Uint8Array([index])]),
      });
    }

    const transactions = vi.spyOn(IDBDatabase.prototype, 'transaction');
    const comparison = await getComparisonData();
    const instanceTransactions = transactions.mock.calls.filter(([stores]) =>
      (typeof stores === 'string' ? [stores] : Array.from(stores)).includes('instances'),
    );

    expect(comparison.patients).toHaveLength(1);
    expect(instanceTransactions).toHaveLength(1);

    transactions.mockClear();
    expect(await getStudies()).toHaveLength(1);
    const exportStudyTransactions = transactions.mock.calls.filter(([stores]) =>
      (typeof stores === 'string' ? [stores] : Array.from(stores)).includes('instances'),
    );
    expect(exportStudyTransactions).toHaveLength(1);
  });

  it('rejects conflicting frame ownership before enriching legacy metadata', async () => {
    await seedAcquisition('legacy-study', 'legacy-series');
    const db = await getDB();
    const original = (await db.get('instances', 'legacy-series.0'))!;
    const conflicting = { ...original, studyInstanceUid: 'another-study' };
    await db.put('instances', conflicting);
    await expect(getSeriesFrameManifest('legacy-series')).rejects.toThrow(/does not belong/);
    expect((await db.get('instances', original.sopInstanceUid))?.metadataVersion).toBeUndefined();
  });

  it.each([true, false])(
    'rejects mixed frame identities when the first identity is present: %s',
    async (firstPresent) => {
      await seedAcquisition('mixed-study', 'mixed-series', 3);
      const db = await getDB();
      for (let index = 0; index < 3; index++) {
        const frame = (await db.get('instances', `mixed-series.${index}`))!;
        await db.put('instances', {
          ...frame,
          metadataVersion: 1,
          physicalSlicePosition: index,
          imagePositionPatient: `0\\0\\${index}`,
          imageOrientationPatient: '1\\0\\0\\0\\1\\0',
          pixelSpacing: '1\\1',
          frameOfReferenceUid:
            index === 0 && !firstPresent ? undefined : index === 2 ? 'foreign-frame' : 'source-frame',
        });
      }
      const manifest = await getSeriesFrameManifest('mixed-series');
      expect(manifest.geometryReliable).toBe(false);
      expect(manifest.frameOfReferenceUid).toBeUndefined();
    },
  );

  it('recovers legacy physical ordering without replacing source bytes or saved work', async () => {
    await seedAcquisition('legacy-study', 'legacy-series', 3);
    const db = await getDB();
    const beforeState = await db.getAll('app_state');
    const { owner } = await selectedSettings();
    await savePanelSettings(owner, { ...DEFAULT_PANEL_SETTINGS, zoom: 2.5 });
    const beforeSettings = await db.getAll('panel_settings');
    for (let index = 0; index < 3; index++) {
      const source = (await db.get('instances', `legacy-series.${index}`))!;
      await db.put('instances', {
        ...source,
        instanceNumber: 3 - index,
        frameOfReferenceUid: 'legacy-frame',
        imageOrientationPatient: '1\\0\\0\\0\\1\\0',
        imagePositionPatient: `0\\0\\${index * 2}`,
        pixelSpacing: '0.5\\0.5',
        acquisitionMetadata: {
          version: 1,
          imageType: ['ORIGINAL', 'PRIMARY'],
          sourceSopInstanceUids: [],
          derivationSopInstanceUids: [],
        },
        fileBlob: new NodeBlob([Uint8Array.of(index, 99)]),
      });
    }
    const reads = vi.spyOn(NodeBlob.prototype, 'arrayBuffer');
    const manifest = await getSeriesFrameManifest('legacy-series');
    expect(manifest.geometryReliable).toBe(true);
    expect(manifest.ordering).toBe('physical');
    expect(manifest.frames.map((frame) => frame.sopInstanceUid)).toEqual([
      'legacy-series.0',
      'legacy-series.1',
      'legacy-series.2',
    ]);
    expect(manifest.sliceSpacingMm).toBe(2);
    expect(manifest.frameOfReferenceUid).toBe('legacy-frame');
    expect(reads).not.toHaveBeenCalled();
    expect(await getImageIdForInstance('legacy-series', 0)).toBe('miradb:legacy-series.0');
    for (let index = 0; index < 3; index++) {
      const stored = (await db.get('instances', `legacy-series.${index}`))!;
      expect(stored.physicalSlicePosition).toBe(index * 2);
      expect(new Uint8Array(await stored.fileBlob.arrayBuffer())).toEqual(Uint8Array.of(index, 99));
    }
    expect(await db.getAll('panel_settings')).toEqual(beforeSettings);
    expect(await db.getAll('app_state')).toEqual(beforeState);
  });

  it('reads a complete ordered frame manifest through one IndexedDB snapshot transaction', async () => {
    const db = await getDB();
    await db.put('studies', {
      studyInstanceUid: 'manifest-study',
      studyDate: '20350101',
      studyDescription: 'Synthetic examination',
      patientName: 'Synthetic Patient',
      patientId: 'synthetic-patient',
      modality: 'MR',
    });
    await db.put('series', {
      seriesInstanceUid: 'manifest-series',
      studyInstanceUid: 'manifest-study',
      seriesDescription: 'Axial T2',
      seriesNumber: 1,
      modality: 'MR',
      frameOfReferenceUid: 'synthetic-frame',
    });

    for (let index = 0; index < 24; index++) {
      await db.put('instances', {
        sopInstanceUid: `manifest-instance-${String(index).padStart(2, '0')}`,
        seriesInstanceUid: 'manifest-series',
        studyInstanceUid: 'manifest-study',
        instanceNumber: 24 - index,
        physicalSlicePosition: index,
        metadataVersion: 1,
        frameOfReferenceUid: 'synthetic-frame',
        imageOrientationPatient: '1\\0\\0\\0\\1\\0',
        imagePositionPatient: `0\\0\\${index}`,
        pixelSpacing: '1\\1',
        rows: 16,
        columns: 16,
        fileBlob: new NodeBlob([new Uint8Array(index + 1)]),
      });
    }

    const transactions = vi.spyOn(IDBDatabase.prototype, 'transaction');
    const manifest = await getSeriesFrameManifest('manifest-series');
    const instanceTransactions = transactions.mock.calls.filter(([stores]) =>
      (typeof stores === 'string' ? [stores] : Array.from(stores)).includes('instances'),
    );

    expect(manifest.ordering).toBe('physical');
    expect(manifest.geometryReliable).toBe(true);
    expect(manifest.frames).toHaveLength(24);
    expect(manifest.frames[0]?.physicalSlicePosition).toBe(0);
    expect(manifest.frames[23]?.physicalSlicePosition).toBe(23);
    expect(manifest.frames.map((frame) => frame.dicomByteLength)).toEqual(Array.from({ length: 24 }, (_, i) => i + 1));
    expect(manifest.frames.every((frame) => !('fileBlob' in frame))).toBe(true);
    expect(instanceTransactions).toHaveLength(1);
    const persisted = await db.get('instances', 'manifest-instance-00');
    expect(persisted).not.toHaveProperty('dicomByteLength');
    expect(persisted!.fileBlob.size).toBe(1);
  });
});
