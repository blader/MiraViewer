import { afterEach, describe, expect, it, vi } from 'vitest';
import { getDB, resetDbForTests } from '../src/db/db';
import { DEFAULT_PANEL_SETTINGS } from '../src/utils/constants';
import { alignmentDisplayBaseline, DEFAULT_ALIGNMENT_ADJUSTMENT } from '../src/utils/alignmentAdjustment';
import {
  getComparisonData,
  getImageIdForInstance,
  getPanelSettings,
  getSeriesFrameManifest,
  getStudies,
  savePanelSettings,
} from '../src/utils/localApi';

async function resetDb() {
  await new Promise<void>((resolve) => {
    const req = indexedDB.deleteDatabase('MiraViewerDB');
    req.onsuccess = () => resolve();
    req.onerror = () => resolve();
    req.onblocked = () => resolve();
  });
}

describe('localApi', () => {
  afterEach(async () => {
    vi.restoreAllMocks();
    await resetDbForTests();
    await resetDb();
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

  it('persists and loads panel settings', async () => {
    await savePanelSettings('combo-1', '2024-01-01T00:00:00', {
      offset: 1,
      zoom: 1.5,
      rotation: 0,
      brightness: 100,
      contrast: 110,
      panX: 0,
      panY: 0,
      progress: 0.5,
    });
    const settings = await getPanelSettings('combo-1');
    expect(settings['2024-01-01T00:00:00']?.zoom).toBe(1.5);
  });

  it('round-trips correction intent and unclipped baseline in patient-scoped storage, including explicit clearing', async () => {
    const date = '2035-01-10T12:00:00';
    const baseline = { ...DEFAULT_PANEL_SETTINGS, brightness: 199, affine01: 0.02 };
    const settings = {
      ...baseline,
      brightness: 200,
      alignmentAdjustment: { ...DEFAULT_ALIGNMENT_ADJUSTMENT, brightness: 10, sliceOffset: -2 },
      alignmentBaseline: alignmentDisplayBaseline(baseline),
      alignmentPaused: true,
    };
    await savePanelSettings('shared-sequence', date, settings, 'patient-a');
    expect((await getPanelSettings('shared-sequence', 'patient-a'))[date]).toEqual(settings);
    expect(await getPanelSettings('shared-sequence', 'patient-b')).toEqual({});

    await savePanelSettings(
      'shared-sequence',
      date,
      {
        ...baseline,
        alignmentAdjustment: undefined,
        alignmentBaseline: undefined,
        alignmentPaused: false,
      },
      'patient-a',
    );
    const reset = (await getPanelSettings('shared-sequence', 'patient-a'))[date]!;
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
        frameOfReferenceUid: 'synthetic-frame',
        imageOrientationPatient: '1\\0\\0\\0\\1\\0',
        imagePositionPatient: `0\\0\\${index}`,
        pixelSpacing: '1\\1',
        rows: 16,
        columns: 16,
        fileBlob: new Blob([new Uint8Array([index])]),
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
    expect(instanceTransactions).toHaveLength(1);
  });
});
