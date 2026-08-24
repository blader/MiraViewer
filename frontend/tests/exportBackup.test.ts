import { describe, it, expect, afterEach } from 'vitest';
import JSZip from 'jszip';
import { getDB, resetDbForTests } from '../src/db/db';
import { exportStudiesToZip } from '../src/services/exportBackup';

async function resetDb() {
  await new Promise<void>((resolve) => {
    const req = indexedDB.deleteDatabase('MiraViewerDB');
    req.onsuccess = () => resolve();
    req.onerror = () => resolve();
    req.onblocked = () => resolve();
  });
}

describe('exportBackup', () => {
  afterEach(async () => {
    await resetDbForTests();
    await resetDb();
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
});
