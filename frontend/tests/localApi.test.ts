import { afterEach, describe, expect, it } from 'vitest';
import { getDB, resetDbForTests } from '../src/db/db';
import { getComparisonData, getImageIdForInstance, getPanelSettings, savePanelSettings } from '../src/utils/localApi';

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
});
