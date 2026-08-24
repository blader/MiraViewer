import { describe, expect, it, vi } from 'vitest';
import JSZip from 'jszip';
import { loadSafeArchive, readArchiveEntry } from '../src/services/archiveSafety';
import { readSnapshotManifest } from '../src/services/exportBackup';

async function makeArchive(
  entries: Array<{ name: string; bytes: Uint8Array }>,
  compression: 'STORE' | 'DEFLATE' = 'DEFLATE',
): Promise<Blob> {
  const zip = new JSZip();
  for (const entry of entries) zip.file(entry.name, entry.bytes);
  return zip.generateAsync({ type: 'blob', compression });
}

async function changeFirstCentralDirectoryRecord(
  archive: Blob,
  change: (view: DataView, offset: number) => void,
): Promise<Blob> {
  const bytes = new Uint8Array(await archive.arrayBuffer());
  const view = new DataView(bytes.buffer);
  for (let offset = 0; offset <= bytes.length - 46; offset++) {
    if (view.getUint32(offset, true) !== 0x02014b50) continue;
    change(view, offset);
    return new Blob([bytes]);
  }
  throw new Error('Synthetic archive has no central-directory record');
}

async function corruptCentralDirectoryCrc(archive: Blob): Promise<Blob> {
  return changeFirstCentralDirectoryRecord(archive, (view, offset) => {
    view.setUint32(offset + 16, view.getUint32(offset + 16, true) ^ 1, true);
  });
}

async function makeSparseZip64(options: { entries?: number; declaredBytes?: number } = {}) {
  const count = options.entries ?? 1;
  const source = await makeArchive([{ name: 'synthetic.dcm', bytes: new Uint8Array([4, 8, 15, 16]) }], 'STORE');
  const sourceBytes = new Uint8Array(await source.arrayBuffer());
  const sourceView = new DataView(sourceBytes.buffer);
  const sourceEnd = sourceBytes.length - 22;
  const sourceDirectoryOffset = sourceView.getUint32(sourceEnd + 16, true);
  const sourceHeader = sourceBytes.subarray(sourceDirectoryOffset, sourceDirectoryOffset + 46);
  const actualLocal = sourceBytes.subarray(0, sourceDirectoryOffset);
  const memberBytes = options.declaredBytes ?? 4;
  const readable = options.declaredBytes === undefined;
  const localStart = readable ? 7 * 1024 * 1024 * 1024 : 0;
  const directoryOffset = readable ? localStart + actualLocal.length : count * (memberBytes + 64);
  const centralRecords: Uint8Array[] = [];

  for (let index = 0; index < count; index++) {
    const name = new TextEncoder().encode(`synthetic-${index}.dcm`);
    const record = new Uint8Array(46 + name.length + 12);
    record.set(sourceHeader);
    const view = new DataView(record.buffer);
    view.setUint32(20, memberBytes, true);
    view.setUint32(24, memberBytes, true);
    view.setUint16(28, name.length, true);
    view.setUint16(30, 12, true);
    view.setUint16(32, 0, true);
    view.setUint32(42, 0xffffffff, true);
    record.set(name, 46);
    const extra = 46 + name.length;
    view.setUint16(extra, 1, true);
    view.setUint16(extra + 2, 8, true);
    view.setBigUint64(extra + 4, BigInt(localStart + index * (memberBytes + 64)), true);
    centralRecords.push(record);
  }

  const directorySize = centralRecords.reduce((total, record) => total + record.length, 0);
  const directory = new Uint8Array(directorySize);
  let cursor = 0;
  for (const record of centralRecords) {
    directory.set(record, cursor);
    cursor += record.length;
  }
  const zip64 = new Uint8Array(56);
  const zip64View = new DataView(zip64.buffer);
  zip64View.setUint32(0, 0x06064b50, true);
  zip64View.setBigUint64(4, 44n, true);
  zip64View.setUint16(12, 45, true);
  zip64View.setUint16(14, 45, true);
  zip64View.setBigUint64(24, BigInt(count), true);
  zip64View.setBigUint64(32, BigInt(count), true);
  zip64View.setBigUint64(40, BigInt(directorySize), true);
  zip64View.setBigUint64(48, BigInt(directoryOffset), true);
  const locator = new Uint8Array(20);
  const locatorView = new DataView(locator.buffer);
  locatorView.setUint32(0, 0x07064b50, true);
  locatorView.setBigUint64(8, BigInt(directoryOffset + directorySize), true);
  locatorView.setUint32(16, 1, true);
  const end = new Uint8Array(22);
  const endView = new DataView(end.buffer);
  endView.setUint32(0, 0x06054b50, true);
  endView.setUint16(8, 0xffff, true);
  endView.setUint16(10, 0xffff, true);
  endView.setUint32(12, 0xffffffff, true);
  endView.setUint32(16, 0xffffffff, true);
  const suffix = new Uint8Array(directory.length + zip64.length + locator.length + end.length);
  suffix.set(directory);
  suffix.set(zip64, directory.length);
  suffix.set(locator, directory.length + zip64.length);
  suffix.set(end, directory.length + zip64.length + locator.length);
  const segments = [
    ...(readable ? [{ offset: localStart, bytes: actualLocal }] : []),
    { offset: directoryOffset, bytes: suffix },
  ];
  let bytesRead = 0;
  const size = directoryOffset + suffix.length;
  const archive = {
    size,
    slice(start: number, end: number): Blob {
      const requested = new Uint8Array(end - start);
      bytesRead += requested.length;
      for (const segment of segments) {
        const overlapStart = Math.max(start, segment.offset);
        const overlapEnd = Math.min(end, segment.offset + segment.bytes.length);
        if (overlapStart >= overlapEnd) continue;
        requested.set(
          segment.bytes.subarray(overlapStart - segment.offset, overlapEnd - segment.offset),
          overlapStart - start,
        );
      }
      return new Blob([requested]);
    },
    arrayBuffer(): Promise<ArrayBuffer> {
      throw new Error('The complete multi-gigabyte archive must never be buffered');
    },
  } as unknown as Blob;

  return { archive, bytesRead: () => bytesRead, count, memberBytes };
}

describe('archiveSafety', () => {
  it.each(['STORE', 'DEFLATE'] as const)(
    'reads and verifies %s members without eagerly inflating them',
    async (mode) => {
      const original = new Uint8Array([4, 8, 15, 16, 23, 42]);
      const archive = await loadSafeArchive(
        await makeArchive([{ name: 'nested/synthetic.dcm', bytes: original }], mode),
      );

      expect(archive.entries).toHaveLength(1);
      expect(archive.entries[0]!.name).toBe('nested/synthetic.dcm');
      expect(new Uint8Array(await (await readArchiveEntry(archive.entries[0]!)).arrayBuffer())).toEqual(original);
    },
  );

  it('rejects a member whose central-directory CRC does not match its actual bytes', async () => {
    const broken = await corruptCentralDirectoryCrc(
      await makeArchive([{ name: 'synthetic.dcm', bytes: new Uint8Array([1, 2, 3, 4]) }]),
    );
    const archive = await loadSafeArchive(broken);

    await expect(readArchiveEntry(archive.entries[0]!)).rejects.toThrow(/crc|integrity|corrupt/i);
  });

  it('verifies the backup manifest CRC before trusting its contents', async () => {
    const manifest = new Uint8Array(
      new TextEncoder().encode(JSON.stringify({ format: 'miraviewer-complete-snapshot' })),
    );
    const broken = await corruptCentralDirectoryCrc(await makeArchive([{ name: 'export.json', bytes: manifest }]));
    const archive = await loadSafeArchive(broken);

    await expect(readSnapshotManifest(archive.zip)).rejects.toThrow(/crc|integrity|corrupt/i);
  });

  it('reads a member beyond the 32-bit ZIP offset boundary without buffering the complete archive', async () => {
    const sparse = await makeSparseZip64();
    const archive = await loadSafeArchive(sparse.archive);

    expect(sparse.archive.size).toBeGreaterThan(7 * 1024 * 1024 * 1024);
    expect(archive.entries).toHaveLength(1);
    expect(new Uint8Array(await (await readArchiveEntry(archive.entries[0]!)).arrayBuffer())).toEqual(
      new Uint8Array([4, 8, 15, 16]),
    );
    expect(sparse.bytesRead()).toBeLessThan(70 * 1024);
  });

  it('admits aggregate ZIP64 payloads above four GiB when actual browser quota permits them', async () => {
    const sparse = await makeSparseZip64({ entries: 9, declaredBytes: 512 * 1024 * 1024 });
    const descriptor = Object.getOwnPropertyDescriptor(navigator, 'storage');
    Object.defineProperty(navigator, 'storage', {
      configurable: true,
      value: { estimate: async () => ({ quota: 8 * 1024 * 1024 * 1024, usage: 0 }) },
    });

    try {
      const archive = await loadSafeArchive(sparse.archive);
      expect(archive.entries).toHaveLength(9);
      expect(archive.uncompressedBytes).toBe(9 * 512 * 1024 * 1024);
      expect(sparse.bytesRead()).toBeLessThan(80 * 1024);
    } finally {
      if (descriptor) Object.defineProperty(navigator, 'storage', descriptor);
      else Reflect.deleteProperty(navigator, 'storage');
    }
  });

  it('can defer nominal ZIP quota admission until canonical duplicate-aware image ingestion', async () => {
    const source = await makeArchive([{ name: 'synthetic.dcm', bytes: new Uint8Array(2048).fill(9) }], 'STORE');
    const descriptor = Object.getOwnPropertyDescriptor(navigator, 'storage');
    Object.defineProperty(navigator, 'storage', {
      configurable: true,
      value: { estimate: async () => ({ quota: 2 * 1024 * 1024, usage: 1024 * 1024 - 1024 }) },
    });

    try {
      await expect(loadSafeArchive(source)).rejects.toThrow(/insufficient browser storage/i);
      const deferred = await loadSafeArchive(source, { deferStorageCheck: true });
      expect(deferred.entries).toHaveLength(1);
      expect(deferred.uncompressedBytes).toBe(2048);
    } finally {
      if (descriptor) Object.defineProperty(navigator, 'storage', descriptor);
      else Reflect.deleteProperty(navigator, 'storage');
    }
  });

  it('honors cancellation before archive discovery and before a member is inflated', async () => {
    const source = await makeArchive([{ name: 'synthetic.dcm', bytes: new Uint8Array([1, 2, 3]) }]);
    const admission = new AbortController();
    admission.abort();
    await expect(loadSafeArchive(source, { signal: admission.signal })).rejects.toMatchObject({ name: 'AbortError' });

    const archive = await loadSafeArchive(source);
    const member = new AbortController();
    member.abort();
    await expect(readArchiveEntry(archive.entries[0]!, { signal: member.signal })).rejects.toMatchObject({
      name: 'AbortError',
    });
  });

  it('stops member reads after cancellation arrives between compressed chunks', async () => {
    const source = await makeArchive([{ name: 'synthetic.dcm', bytes: new Uint8Array([1, 2, 3, 4]) }], 'STORE');
    const archive = await loadSafeArchive(source);
    const controller = new AbortController();
    let deliveredChunks = 0;
    const original = Blob.prototype.stream;
    const stream = vi.spyOn(Blob.prototype, 'stream').mockImplementation(function (this: Blob) {
      const readBytes = this.arrayBuffer.bind(this);
      return new ReadableStream<Uint8Array>({
        async pull(streamController) {
          if (deliveredChunks++ === 0) {
            const bytes = new Uint8Array(await readBytes());
            streamController.enqueue(bytes.subarray(0, 1));
          } else {
            controller.abort();
          }
        },
      });
    });

    try {
      await expect(readArchiveEntry(archive.entries[0]!, { signal: controller.signal })).rejects.toMatchObject({
        name: 'AbortError',
      });
      expect(deliveredChunks).toBeGreaterThanOrEqual(1);
    } finally {
      stream.mockRestore();
      expect(Blob.prototype.stream).toBe(original);
    }
  });

  it.each([
    ['slash aliases', 'nested/synthetic.dcm', 'nested\\synthetic.dcm'],
    ['Unicode normalization aliases', 'caf\u00e9.dcm', 'cafe\u0301.dcm'],
  ])('rejects central-directory %s before any member is exposed', async (_label, first, second) => {
    const source = await makeArchive([
      { name: first, bytes: new Uint8Array([1]) },
      { name: second, bytes: new Uint8Array([2]) },
    ]);
    await expect(loadSafeArchive(source)).rejects.toThrow(/duplicate file paths/i);
  });

  it.each([
    ['encrypted members', 8, 1, /encrypted/i],
    ['unsupported compression', 10, 12, /unsupported compression/i],
  ])('rejects %s during bounded central-directory admission', async (_label, field, value, error) => {
    const source = await changeFirstCentralDirectoryRecord(
      await makeArchive([{ name: 'synthetic.dcm', bytes: new Uint8Array([1, 2, 3]) }]),
      (view, offset) => view.setUint16(offset + field, value, true),
    );
    await expect(loadSafeArchive(source)).rejects.toThrow(error);
  });

  it('rejects traversal paths before allowing member reads', async () => {
    const source = await makeArchive([{ name: '../synthetic.dcm', bytes: new Uint8Array([1, 2, 3]) }]);
    await expect(loadSafeArchive(source)).rejects.toThrow(/unsafe file path/i);
  });
});
