import { afterEach, describe, expect, it, vi } from 'vitest';
import { processDicomFile, processFiles } from '../src/services/dicomIngestion';
import { getDB, resetDbForTests } from '../src/db/db';

vi.mock('dicom-parser', () => {
  return {
    default: {
      parseDicom: vi.fn(),
    },
  };
});

import dicomParser from 'dicom-parser';

async function resetDb() {
  await new Promise<void>((resolve) => {
    const req = indexedDB.deleteDatabase('MiraViewerDB');
    req.onsuccess = () => resolve();
    req.onerror = () => resolve();
    req.onblocked = () => resolve();
  });
}

describe('dicom ingestion', () => {
  afterEach(async () => {
    await resetDbForTests();
    await resetDb();
    vi.clearAllMocks();
  });

  it('stores study, series, and instance metadata in IndexedDB', async () => {
    const tags: Record<string, string> = {
      x0020000d: 'study-uid',
      x0020000e: 'series-uid',
      x00080018: 'sop-uid',
      x00080020: '20240101',
      x00081030: 'Study Desc',
      x00100010: 'Patient^Name',
      x00100020: 'PID123',
      x00080060: 'MR',
      x0008103e: 'Series Desc',
      x00200011: '7',
      x00200013: '12',
      x00280010: '256',
      x00280011: '256',
      x00201041: '4.2',
      x00200032: '1\\2\\3',
      x00200037: '1\\0\\0\\0\\1\\0',
      x00280030: '0.5\\0.5',
      x00180050: '1.5',
      x00281050: '40',
      x00281051: '400',
    };

    (dicomParser.parseDicom as unknown as ReturnType<typeof vi.fn>).mockReturnValue({
      string: (tag: string) => tags[tag],
      floatString: (tag: string) => {
        const v = tags[tag];
        if (!v) return undefined;
        return parseFloat(v.split('\\\\')[0]);
      },
      intString: (tag: string) => {
        const v = tags[tag];
        if (!v) return undefined;
        return parseInt(v.split('\\\\')[0], 10);
      },
      uint16: (tag: string) => {
        const v = tags[tag];
        if (!v) return undefined;
        return parseInt(v.split('\\\\')[0], 10);
      },
      int16: (tag: string) => {
        const v = tags[tag];
        if (!v) return undefined;
        return parseInt(v.split('\\\\')[0], 10);
      },
      uint32: (tag: string) => {
        const v = tags[tag];
        if (!v) return undefined;
        return parseInt(v.split('\\\\')[0], 10);
      },
      int32: (tag: string) => {
        const v = tags[tag];
        if (!v) return undefined;
        return parseInt(v.split('\\\\')[0], 10);
      },
      float: (tag: string) => {
        const v = tags[tag];
        if (!v) return undefined;
        return parseFloat(v.split('\\\\')[0]);
      },
      double: (tag: string) => {
        const v = tags[tag];
        if (!v) return undefined;
        return parseFloat(v.split('\\\\')[0]);
      },
      // Presence of Pixel Data is what makes this a displayable image.
      elements: {
        x7fe00010: { length: 123 },
      },
    });

    const file = new File([new Uint8Array([1, 2, 3])], 'test.dcm');
    const res = await processDicomFile(file);
    expect(res.status).toBe('ingested');

    const db = await getDB();
    const study = await db.get('studies', 'study-uid');
    const series = await db.get('series', 'series-uid');
    const instance = await db.get('instances', 'sop-uid');

    expect(study?.studyDescription).toBe('Study Desc');
    expect(series?.seriesDescription).toBe('Series Desc');

    // SeriesDescription doesn't include a plane, but ImageOrientationPatient does.
    expect(series?.plane).toBe('Axial');

    expect(instance?.instanceNumber).toBe(12);
    expect(instance?.fileBlob).toBeTruthy();
  });

  it('uses ProtocolName/SequenceName to classify series when SeriesDescription is unhelpful', async () => {
    const tags: Record<string, string> = {
      x0020000d: 'study-uid',
      x0020000e: 'series-uid',
      x00080018: 'sop-uid',
      x00080020: '20240101',
      x00081030: 'Study Desc',
      x00100010: 'Patient^Name',
      x00100020: 'PID123',
      x00080060: 'MR',

      // Intentionally blank SeriesDescription.
      x0008103e: '',
      x00181030: 'CORO MPRAGE',

      x00200011: '7',
      x00200013: '12',
      x00280010: '256',
      x00280011: '256',
    };

    (dicomParser.parseDicom as unknown as ReturnType<typeof vi.fn>).mockReturnValue({
      string: (tag: string) => tags[tag],
      floatString: (tag: string) => {
        const v = tags[tag];
        if (!v) return undefined;
        return parseFloat(v.split('\\\\')[0]);
      },
      intString: (tag: string) => {
        const v = tags[tag];
        if (!v) return undefined;
        return parseInt(v.split('\\\\')[0], 10);
      },
      uint16: (tag: string) => {
        const v = tags[tag];
        if (!v) return undefined;
        return parseInt(v.split('\\\\')[0], 10);
      },
      int16: (tag: string) => {
        const v = tags[tag];
        if (!v) return undefined;
        return parseInt(v.split('\\\\')[0], 10);
      },
      uint32: (tag: string) => {
        const v = tags[tag];
        if (!v) return undefined;
        return parseInt(v.split('\\\\')[0], 10);
      },
      int32: (tag: string) => {
        const v = tags[tag];
        if (!v) return undefined;
        return parseInt(v.split('\\\\')[0], 10);
      },
      float: (tag: string) => {
        const v = tags[tag];
        if (!v) return undefined;
        return parseFloat(v.split('\\\\')[0]);
      },
      double: (tag: string) => {
        const v = tags[tag];
        if (!v) return undefined;
        return parseFloat(v.split('\\\\')[0]);
      },
      // Presence of Pixel Data is what makes this a displayable image.
      elements: {
        x7fe00010: { length: 123 },
      },
    });

    const file = new File([new Uint8Array([1, 2, 3])], 'test.dcm');
    const res = await processDicomFile(file);
    expect(res.status).toBe('ingested');

    const db = await getDB();
    const series = await db.get('series', 'series-uid');

    // Parsed from ProtocolName (not from SeriesDescription).
    expect(series?.protocolName).toBe('CORO MPRAGE');
    expect(series?.plane).toBe('Coronal');
    expect(series?.sequenceType).toBe('MPRAGE');
    // Inferred from sequence type when explicit T1/T2 token is missing.
    expect(series?.weight).toBe('T1');
  });

  it('skips DICOM objects without pixel data (non-displayable)', async () => {
    const tags: Record<string, string> = {
      x0020000d: 'study-uid',
      x0020000e: 'series-uid',
      x00080018: 'sop-uid',
      // Provide rows/cols so the only failing condition is missing Pixel Data.
      x00280010: '256',
      x00280011: '256',
    };

    (dicomParser.parseDicom as unknown as ReturnType<typeof vi.fn>).mockReturnValue({
      string: (tag: string) => tags[tag] || '',
      elements: {
        // Intentionally missing x7fe00010
      },
    });

    const file = new File([new Uint8Array([1, 2, 3])], 'no-pixels.dcm');
    const res = await processDicomFile(file);
    expect(res).toMatchObject({ status: 'skipped', reason: 'non-displayable' });

    const db = await getDB();
    expect(await db.get('instances', 'sop-uid')).toBeUndefined();
  });

  it('skips Secondary Capture images (e.g. DICOM screenshots)', async () => {
    const tags: Record<string, string> = {
      // Secondary Capture Image Storage
      x00080016: '1.2.840.10008.5.1.4.1.1.7',
      x00280010: '256',
      x00280011: '256',
    };

    (dicomParser.parseDicom as unknown as ReturnType<typeof vi.fn>).mockReturnValue({
      string: (tag: string) => tags[tag] || '',
      floatString: (tag: string) => {
        const v = tags[tag];
        if (!v) return undefined;
        return parseFloat(v.split('\\\\')[0]);
      },
      intString: (tag: string) => {
        const v = tags[tag];
        if (!v) return undefined;
        return parseInt(v.split('\\\\')[0], 10);
      },
      uint16: (tag: string) => {
        const v = tags[tag];
        if (!v) return undefined;
        return parseInt(v.split('\\\\')[0], 10);
      },
      int16: (tag: string) => {
        const v = tags[tag];
        if (!v) return undefined;
        return parseInt(v.split('\\\\')[0], 10);
      },
      uint32: (tag: string) => {
        const v = tags[tag];
        if (!v) return undefined;
        return parseInt(v.split('\\\\')[0], 10);
      },
      int32: (tag: string) => {
        const v = tags[tag];
        if (!v) return undefined;
        return parseInt(v.split('\\\\')[0], 10);
      },
      float: (tag: string) => {
        const v = tags[tag];
        if (!v) return undefined;
        return parseFloat(v.split('\\\\')[0]);
      },
      double: (tag: string) => {
        const v = tags[tag];
        if (!v) return undefined;
        return parseFloat(v.split('\\\\')[0]);
      },
      elements: {
        // Presence of Pixel Data means this is technically displayable.
        x7fe00010: { length: 123 },
      },
    });

    const file = new File([new Uint8Array([1, 2, 3])], 'screenshot.dcm');
    const res = await processDicomFile(file);
    expect(res).toMatchObject({ status: 'skipped', reason: 'secondary-capture' });

    const db = await getDB();
    // Ensure we did not write anything to the DB.
    expect((await db.getAll('studies')).length).toBe(0);
    expect((await db.getAll('series')).length).toBe(0);
    expect((await db.getAll('instances')).length).toBe(0);
  });

  it('processFiles iterates files and reports progress', async () => {
    const tags: Record<string, string> = {
      x0020000d: 'study-uid',
      x0020000e: 'series-uid',
      x00080018: 'sop-uid',
    };

    (dicomParser.parseDicom as unknown as ReturnType<typeof vi.fn>).mockReturnValue({
      string: (tag: string) => tags[tag] || '',
    });

    const fileA = new File([new Uint8Array([1])], 'a.dcm');
    const fileB = new File([new Uint8Array([2])], 'b.dcm');

    const progress = vi.fn();
    const summary = await processFiles([fileA, fileB], progress);

    expect(progress).toHaveBeenCalledWith(1, 2);
    expect(progress).toHaveBeenCalledWith(2, 2);
    expect(summary.total).toBe(2);
  });
});
