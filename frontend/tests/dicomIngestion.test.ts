import { afterEach, describe, expect, it, vi } from 'vitest';
import { processDicomFile, processFiles } from '../src/services/dicomIngestion';
import { DATASET_REVISION_STATE_KEY, getDB, resetDbForTests, subscribeDatasetMutations } from '../src/db/db';

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

function imageDataSet(overrides: Record<string, string> = {}) {
  const tags: Record<string, string> = {
    x0020000d: 'synthetic-study',
    x0020000e: 'synthetic-series',
    x00080018: 'synthetic-instance',
    x00080060: 'MR',
    x00100010: 'Synthetic^Patient',
    x00100020: 'synthetic-patient',
    x00280010: '64',
    x00280011: '64',
    ...overrides,
  };
  const numeric = (tag: string) => {
    const value = tags[tag]?.split('\\')[0];
    return value ? Number(value) : undefined;
  };
  return {
    string: (tag: string) => tags[tag] ?? '',
    floatString: numeric,
    intString: numeric,
    uint16: numeric,
    int16: numeric,
    uint32: numeric,
    int32: numeric,
    float: numeric,
    double: numeric,
    elements: { x7fe00010: { length: 1 } },
  };
}

function mockImageSequence(tags: Record<string, string>[]) {
  const parser = dicomParser.parseDicom as unknown as ReturnType<typeof vi.fn>;
  for (const image of tags) parser.mockReturnValueOnce(imageDataSet(image));
}

function imageFile(index: number, size = 1): File {
  return new File([new Uint8Array(size).fill(index)], `synthetic-${index}.dcm`, { type: 'application/dicom' });
}

describe('dicom ingestion', () => {
  afterEach(async () => {
    await resetDbForTests();
    await resetDb();
    vi.restoreAllMocks();
    vi.clearAllMocks();
    vi.mocked(dicomParser.parseDicom).mockReset();
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
      x00280103: '1',
      x00201041: '4.2',
      x00200032: '1\\2\\3',
      x00200037: '1\\0\\0\\0\\1\\0',
      x00280030: '0.5\\0.5',
      x00180050: '1.5',
      x00281050: '40',
      x00281051: '400',
      x00280120: '-2000',
      x00280121: '-1998',
    };

    (dicomParser.parseDicom as unknown as ReturnType<typeof vi.fn>).mockReturnValue({
      string: (tag: string) => tags[tag],
      floatString: (tag: string) => {
        if (tag === 'x00280120' || tag === 'x00280121') return undefined;
        const v = tags[tag];
        if (!v) return undefined;
        return parseFloat(v.split('\\\\')[0]);
      },
      intString: (tag: string) => {
        if (tag === 'x00280120' || tag === 'x00280121') return undefined;
        const v = tags[tag];
        if (!v) return undefined;
        return parseInt(v.split('\\\\')[0], 10);
      },
      uint16: (tag: string) => {
        const v = tags[tag];
        if (!v) return undefined;
        if (tag === 'x00280120' || tag === 'x00280121') return (parseInt(v, 10) + 65_536) % 65_536;
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
        x00280120: { length: 2 },
        x00280121: { length: 2 },
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
    expect(instance?.pixelPaddingValue).toBe(-2000);
    expect(instance?.pixelPaddingRangeLimit).toBe(-1998);
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

  it.each([
    ['a same-normal 90-degree in-plane rotation', { x00200037: '0\\1\\0\\-1\\0\\0' }, /orientations/i],
    ['mismatched row dimensions', { x00280010: '128' }, /dimensions/i],
    ['mismatched column dimensions', { x00280011: '128' }, /dimensions/i],
    ['swapped calibrated row and column spacing', { x00280030: '0.75\\0.5' }, /spacing/i],
  ])('rejects %s before contaminating an existing physical stack', async (_description, conflicting, message) => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const base = {
      x0020000d: 'study-uid',
      x0020000e: 'series-uid',
      x00080018: 'instance-one',
      x00080060: 'MR',
      x00280010: '256',
      x00280011: '256',
      x00200032: '0\\0\\0',
      x00200037: '1\\0\\0\\0\\1\\0',
      x00280030: '0.5\\0.75',
    };
    const dataset = (tags: Record<string, string>) => ({
      string: (tag: string) => tags[tag] ?? '',
      uint16: (tag: string) => (tags[tag] ? Number(tags[tag]) : undefined),
      intString: (tag: string) => (tags[tag] ? Number(tags[tag]) : undefined),
      floatString: (tag: string) => (tags[tag] ? Number(tags[tag]) : undefined),
      elements: { x7fe00010: { length: 1 } },
    });
    const parser = dicomParser.parseDicom as unknown as ReturnType<typeof vi.fn>;
    parser.mockReturnValueOnce(dataset(base));
    parser.mockReturnValueOnce(dataset({ ...base, ...conflicting, x00080018: 'instance-two' }));

    expect((await processDicomFile(new File([new Uint8Array([1])], 'first.dcm'))).status).toBe('ingested');
    const rejected = await processDicomFile(new File([new Uint8Array([2])], 'second.dcm'));

    expect(rejected).toMatchObject({ status: 'error', reason: 'db-error' });
    if (rejected.status === 'error') expect(rejected.message).toMatch(message);
    const db = await getDB();
    expect((await db.getAll('instances')).length).toBe(1);
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

  it.each([
    ['patient identity', 'x00100020', 'patient-A', 'patient-B', 'patientId', /patient identity/i],
    ['patient issuer', 'x00100021', 'issuer-A', 'issuer-B', 'patientIdIssuer', /issuer/i],
    ['frame of reference', 'x00200052', 'frame-A', 'frame-B', 'frameOfReferenceUid', /frames/i],
    ['pixel spacing', 'x00280030', '0.5\\0.75', '0.6\\0.75', 'pixelSpacing', /spacing/i],
    [
      'image orientation',
      'x00200037',
      '1\\0\\0\\0\\1\\0',
      '0\\1\\0\\-1\\0\\0',
      'imageOrientationPatient',
      /orientations/i,
    ],
  ])(
    'binds missing canonical %s once and rejects a conflicting value staged in the same batch',
    async (_description, tag, established, conflicting, field, error) => {
      vi.spyOn(console, 'error').mockImplementation(() => undefined);
      mockImageSequence([
        { x00080018: 'synthetic-one', [tag]: '' },
        { x00080018: 'synthetic-two', [tag]: established },
        { x00080018: 'synthetic-three', [tag]: conflicting },
      ]);

      const summary = await processFiles([imageFile(1), imageFile(2), imageFile(3)]);
      const db = await getDB();
      const parent = await db.get(
        tag === 'x00100020' || tag === 'x00100021' ? 'studies' : 'series',
        tag === 'x00100020' || tag === 'x00100021' ? 'synthetic-study' : 'synthetic-series',
      );

      expect(summary).toMatchObject({ ingested: 2, errors: 1 });
      expect(summary.errorSamples[0]).toMatch(error);
      expect(parent).toMatchObject({ [field]: established });
      expect(await db.count('instances')).toBe(2);
      expect((await db.get('app_state', DATASET_REVISION_STATE_KEY))?.value).toBe(2);
    },
  );

  it('rejects conflicting nonempty names under the same study without manufacturing identity from a missing name', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    mockImageSequence([
      { x00080018: 'synthetic-one', x00100010: '' },
      { x00080018: 'synthetic-two', x00100010: 'Synthetic^Alice' },
      { x00080018: 'synthetic-three', x00100010: 'Synthetic^Bob' },
    ]);

    const summary = await processFiles([imageFile(1), imageFile(2), imageFile(3)]);

    expect(summary).toMatchObject({ ingested: 2, errors: 1 });
    expect(summary.errorSamples[0]).toMatch(/patient.*name/i);
    expect((await (await getDB()).get('studies', 'synthetic-study'))?.patientName).toBe('Synthetic^Alice');
  });

  it('commits a bounded batch atomically, writes the exact historical revision, and invalidates each changed series once', async () => {
    mockImageSequence([
      { x00080018: 'synthetic-one' },
      { x00080018: 'synthetic-two' },
      { x00080018: 'synthetic-three', x0020000e: 'synthetic-second-series' },
    ]);
    const db = await getDB();
    const transactions = vi.spyOn(db, 'transaction');
    const notifications: (string | undefined)[] = [];
    const unsubscribe = subscribeDatasetMutations((seriesUid) => notifications.push(seriesUid));

    try {
      const summary = await processFiles([imageFile(1), imageFile(2), imageFile(3)]);

      expect(summary).toMatchObject({ ingested: 3, errors: 0 });
      expect(transactions.mock.calls.filter((call) => call[1] === 'readwrite')).toHaveLength(1);
      expect((await db.get('app_state', DATASET_REVISION_STATE_KEY))?.value).toBe(3);
      expect(notifications.sort()).toEqual(['synthetic-second-series', 'synthetic-series']);
    } finally {
      unsubscribe();
    }
  });

  it('admits duplicate-only replays under low quota without a readwrite transaction or parent mutation', async () => {
    mockImageSequence([{ x00080018: 'synthetic-one' }, { x00080018: 'synthetic-one' }]);
    expect(await processDicomFile(imageFile(1, 4))).toMatchObject({ status: 'ingested' });
    const db = await getDB();
    const transactions = vi.spyOn(db, 'transaction');
    const priorStorage = Object.getOwnPropertyDescriptor(navigator, 'storage');
    Object.defineProperty(navigator, 'storage', {
      configurable: true,
      value: { estimate: vi.fn().mockResolvedValue({ quota: 1_048_580, usage: 4 }) },
    });

    try {
      const summary = await processFiles([imageFile(2, 4)]);

      expect(summary).toMatchObject({ ingested: 0, duplicates: 1, errors: 0 });
      expect(transactions.mock.calls.filter((call) => call[1] === 'readwrite')).toHaveLength(0);
      expect((await db.get('app_state', DATASET_REVISION_STATE_KEY))?.value).toBe(1);
    } finally {
      if (priorStorage) Object.defineProperty(navigator, 'storage', priorStorage);
      else Reflect.deleteProperty(navigator, 'storage');
    }
  });

  it('probes only bounded headers for large existing duplicates without rereading their complete source bytes', async () => {
    const parser = dicomParser.parseDicom as unknown as ReturnType<typeof vi.fn>;
    parser.mockReturnValue(imageDataSet({ x00080018: 'synthetic-large-duplicate' }));
    const original = imageFile(1, 64 * 1024);
    expect(await processDicomFile(original)).toMatchObject({ status: 'ingested' });
    parser.mockClear();
    const replay = imageFile(2, 64 * 1024);
    const fullSourceRead = vi.spyOn(replay, 'arrayBuffer');

    const summary = await processFiles([replay]);

    expect(summary).toMatchObject({ ingested: 0, duplicates: 1 });
    expect(fullSourceRead).not.toHaveBeenCalled();
    expect(parser).toHaveBeenCalledOnce();
    expect((parser.mock.calls[0]?.[0] as Uint8Array).byteLength).toBe(4096);
    expect(parser.mock.calls[0]?.[1]).toEqual({ untilTag: 'x0020000e' });
  });

  it('does not double-parse a cold new examination solely to enable future duplicate replay', async () => {
    mockImageSequence([{ x00080018: 'synthetic-large-one' }, { x00080018: 'synthetic-large-two' }]);

    const summary = await processFiles([imageFile(1, 64 * 1024), imageFile(2, 64 * 1024)]);

    expect(summary).toMatchObject({ ingested: 2, errors: 0 });
    expect(dicomParser.parseDicom).toHaveBeenCalledTimes(2);
  });

  it('stops lazy discovery between committed bounded batches and returns exact committed cancellation outcomes', async () => {
    mockImageSequence([
      { x00080018: 'synthetic-one' },
      { x00080018: 'synthetic-two' },
      { x00080018: 'synthetic-three' },
    ]);
    const controller = new AbortController();
    let discovered = 0;
    async function* files() {
      for (let i = 1; i <= 5; i += 1) {
        discovered += 1;
        yield imageFile(i);
      }
    }

    const snapshots: { ingested: number; duplicates: number; skipped: number; errors: number }[] = [];
    const summary = await processFiles(
      files(),
      (_current, _total, detail) => {
        if (detail) snapshots.push(detail);
        if (detail?.ingested === 1) controller.abort();
      },
      { signal: controller.signal, total: 5, batchMaxItems: 2 },
    );

    expect(summary).toMatchObject({ total: 5, ingested: 2, cancelled: true });
    expect(discovered).toBe(2);
    expect(snapshots.at(-1)?.ingested).toBe(2);
    expect(await (await getDB()).count('instances')).toBe(2);
  });

  it('preserves committed results when an archive iterator itself throws AbortError after a durable batch', async () => {
    mockImageSequence([{ x00080018: 'synthetic-one' }, { x00080018: 'synthetic-two' }]);
    const controller = new AbortController();
    async function* files() {
      yield imageFile(1);
      yield imageFile(2);
      throw new DOMException('The operation was aborted.', 'AbortError');
    }

    const summary = await processFiles(files(), undefined, { signal: controller.signal, total: 5, batchMaxItems: 2 });

    expect(summary).toMatchObject({
      total: 5,
      ingested: 2,
      cancelled: true,
      affectedSeriesUids: ['synthetic-series'],
    });
    expect(await (await getDB()).count('instances')).toBe(2);
  });

  it('does not conceal non-abort archive corruption behind a canceled terminal state', async () => {
    mockImageSequence([{ x00080018: 'synthetic-one' }]);
    async function* files(): AsyncGenerator<File> {
      yield imageFile(1);
      throw new Error('Synthetic archive member checksum mismatch');
    }

    await expect(processFiles(files(), undefined, { batchMaxItems: 1 })).rejects.toThrow(/checksum mismatch/i);
    expect(await (await getDB()).count('instances')).toBe(1);
  });

  it('rolls back canonical parents and instances when cancellation interrupts a staged write transaction', async () => {
    mockImageSequence([{ x00080018: 'synthetic-one' }, { x00080018: 'synthetic-two' }]);
    const controller = new AbortController();
    const originalPut = IDBObjectStore.prototype.put;
    vi.spyOn(IDBObjectStore.prototype, 'put').mockImplementation(function (this: IDBObjectStore, value, key) {
      const request = key === undefined ? originalPut.call(this, value) : originalPut.call(this, value, key);
      if (this.name === 'studies') controller.abort();
      return request;
    });
    const notifications: (string | undefined)[] = [];
    const unsubscribe = subscribeDatasetMutations((seriesUid) => notifications.push(seriesUid));

    try {
      const summary = await processFiles([imageFile(1), imageFile(2)], undefined, {
        signal: controller.signal,
        batchMaxItems: 2,
      });
      const db = await getDB();

      expect(summary).toMatchObject({ ingested: 0, errors: 0, cancelled: true });
      expect(await db.count('studies')).toBe(0);
      expect(await db.count('series')).toBe(0);
      expect(await db.count('instances')).toBe(0);
      expect(await db.get('app_state', DATASET_REVISION_STATE_KEY)).toBeUndefined();
      expect(notifications).toEqual([]);
    } finally {
      unsubscribe();
    }
  });

  it('aborts the entire bounded transaction after an injected image-write quota failure', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    mockImageSequence([{ x00080018: 'synthetic-one' }, { x00080018: 'synthetic-two' }]);
    const originalPut = IDBObjectStore.prototype.put;
    vi.spyOn(IDBObjectStore.prototype, 'put').mockImplementation(function (this: IDBObjectStore, value, key) {
      if (this.name === 'instances') throw new DOMException('Synthetic quota exhaustion', 'QuotaExceededError');
      return key === undefined ? originalPut.call(this, value) : originalPut.call(this, value, key);
    });

    const summary = await processFiles([imageFile(1), imageFile(2)]);
    const db = await getDB();

    expect(summary).toMatchObject({ ingested: 0, errors: 2, errorReasons: { 'db-error': 2 } });
    expect(summary.errorSamples[0]).toMatch(/insufficient browser storage/i);
    expect(await db.count('studies')).toBe(0);
    expect(await db.count('series')).toBe(0);
    expect(await db.count('instances')).toBe(0);
    expect(await db.get('app_state', DATASET_REVISION_STATE_KEY)).toBeUndefined();
  });

  it('does not publish raw parser exceptions, nested patient data, identifiers, or source paths', async () => {
    const spies = ['error', 'warn', 'log', 'info', 'debug'].map((method) =>
      vi.spyOn(console, method as 'error').mockImplementation(() => undefined),
    );
    const forbidden = ['SYNTHETIC-PATIENT-SECRET', 'SYNTHETIC-UID-SECRET', 'SYNTHETIC-SOURCE-PATH'];
    (dicomParser.parseDicom as unknown as ReturnType<typeof vi.fn>).mockImplementationOnce(() => {
      throw {
        exception: new Error(forbidden[0]),
        dataSet: { patientName: forbidden[0], byteArray: new Uint8Array([1, 2, 3]) },
        sourcePath: forbidden[2],
        sopInstanceUid: forbidden[1],
      };
    });

    expect(await processDicomFile(imageFile(1))).toMatchObject({ status: 'error', reason: 'parse-error' });
    const published = spies
      .flatMap((spy) => spy.mock.calls)
      .flatMap((args) => args.map((value) => (typeof value === 'string' ? value : JSON.stringify(value))))
      .join(' ');
    for (const value of forbidden) expect(published).not.toContain(value);
  });

  it('classifies an orthogonal scout intentionally while retaining unsafe ordinary orientation conflicts as errors', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    mockImageSequence([
      { x00080018: 'synthetic-one', x0008103e: 'Scout localizer', x00200037: '1\\0\\0\\0\\1\\0' },
      { x00080018: 'synthetic-two', x0008103e: 'Scout localizer', x00200037: '0\\1\\0\\-1\\0\\0' },
      { x00080018: 'synthetic-three', x0008103e: 'Diagnostic scan', x00200037: '0\\1\\0\\-1\\0\\0' },
    ]);

    const summary = await processFiles([imageFile(1), imageFile(2), imageFile(3)]);

    expect(summary).toMatchObject({
      ingested: 1,
      skipped: 1,
      errors: 1,
      skipReasons: { 'excluded-localizer-orientation': 1 },
      errorReasons: { 'db-error': 1 },
    });
    expect(await (await getDB()).count('instances')).toBe(1);
  });

  it('explicitly excludes positively identified original-primary orthogonal MR planes without calling them scouts', async () => {
    const acquisition = {
      x00080016: '1.2.840.10008.5.1.4.1.1.4',
      x00080008: 'ORIGINAL\\PRIMARY\\OTHER',
      x0008103e: 'Synthetic unlabeled three-plane acquisition',
      x00181030: 'Synthetic acquisition protocol',
      x00200052: 'synthetic-safe-frame',
      x00200032: '0\\0\\0',
      x00280030: '0.5\\0.5',
      x00280010: '512',
      x00280011: '512',
    };
    mockImageSequence([
      { ...acquisition, x00080018: 'synthetic-axial', x00200037: '1\\0\\0\\0\\1\\0' },
      { ...acquisition, x00080018: 'synthetic-coronal', x00200037: '1\\0\\0\\0\\0\\1' },
      { ...acquisition, x00080018: 'synthetic-sagittal', x00200037: '0\\0\\1\\0\\1\\0' },
    ]);

    const summary = await processFiles([imageFile(1), imageFile(2), imageFile(3)]);

    expect(summary).toMatchObject({
      ingested: 1,
      skipped: 2,
      errors: 0,
      skipReasons: { 'excluded-incompatible-series-orientation': 2 },
    });
    expect(summary.skipReasons?.['excluded-localizer-orientation']).toBeUndefined();
    expect(await (await getDB()).count('instances')).toBe(1);
  });

  it('does not downgrade orthogonal diagnostic conflicts without a shared validated frame of reference', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const acquisition = {
      x00080016: '1.2.840.10008.5.1.4.1.1.4',
      x00080008: 'ORIGINAL\\PRIMARY',
      x00200032: '0\\0\\0',
    };
    mockImageSequence([
      { ...acquisition, x00080018: 'synthetic-one', x00200037: '1\\0\\0\\0\\1\\0' },
      { ...acquisition, x00080018: 'synthetic-two', x00200037: '1\\0\\0\\0\\0\\1' },
    ]);

    const summary = await processFiles([imageFile(1), imageFile(2)]);

    expect(summary).toMatchObject({ ingested: 1, skipped: 0, errors: 1, errorReasons: { 'db-error': 1 } });
    expect(summary.errorSamples[0]).toMatch(/orientation/i);
  });

  it('does not discover, parse, mutate, or publish an operation canceled before it begins', async () => {
    const controller = new AbortController();
    controller.abort();
    let discovered = 0;
    async function* files() {
      discovered += 1;
      yield imageFile(1);
    }
    const progress = vi.fn();

    const summary = await processFiles(files(), progress, { signal: controller.signal, total: 1 });

    expect(summary).toMatchObject({ total: 1, ingested: 0, cancelled: true });
    expect(discovered).toBe(0);
    expect(progress).not.toHaveBeenCalled();
    expect(dicomParser.parseDicom).not.toHaveBeenCalled();
  });

  it('continues after a malformed candidate and publishes truthful error categories', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const parser = dicomParser.parseDicom as unknown as ReturnType<typeof vi.fn>;
    parser.mockReturnValueOnce(imageDataSet({ x00080018: 'synthetic-one' }));
    parser.mockImplementationOnce(() => {
      throw new Error('malformed secret payload');
    });
    parser.mockReturnValueOnce(imageDataSet({ x00080018: 'synthetic-three' }));

    const summary = await processFiles([imageFile(1), imageFile(2), imageFile(3)]);

    expect(summary).toMatchObject({ ingested: 2, errors: 1, errorReasons: { 'parse-error': 1 } });
    expect(summary.errorSamples[0]).not.toContain('secret');
    expect(await (await getDB()).count('instances')).toBe(2);
  });

  it('isolates same-SOP ownership conflicts without creating an orphaned staged examination', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    mockImageSequence([
      { x00080018: 'synthetic-reused' },
      { x00080018: 'synthetic-reused', x0020000d: 'synthetic-other-study', x0020000e: 'synthetic-other-series' },
      { x00080018: 'synthetic-safe' },
    ]);

    const summary = await processFiles([imageFile(1), imageFile(2), imageFile(3)]);
    const db = await getDB();

    expect(summary).toMatchObject({ ingested: 2, errors: 1 });
    expect(await db.get('studies', 'synthetic-other-study')).toBeUndefined();
    expect(await db.get('series', 'synthetic-other-series')).toBeUndefined();
    expect(await db.count('instances')).toBe(2);
  });

  it('enforces byte and image-count batch bounds without changing final revision semantics', async () => {
    mockImageSequence([
      { x00080018: 'synthetic-one' },
      { x00080018: 'synthetic-two' },
      { x00080018: 'synthetic-three' },
    ]);
    const db = await getDB();
    const transactions = vi.spyOn(db, 'transaction');

    const summary = await processFiles([imageFile(1, 2), imageFile(2, 2), imageFile(3, 2)], undefined, {
      batchMaxItems: 8,
      batchMaxBytes: 3,
    });

    expect(summary).toMatchObject({ ingested: 3, errors: 0 });
    expect(transactions.mock.calls.filter((call) => call[1] === 'readwrite')).toHaveLength(3);
    expect((await db.get('app_state', DATASET_REVISION_STATE_KEY))?.value).toBe(3);
  });
});
