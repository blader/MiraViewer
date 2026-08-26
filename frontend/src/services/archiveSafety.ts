import type JSZip from 'jszip';
import { Inflate } from 'pako';
import { assertStorageHeadroom } from '../db/db';

const MAX_ARCHIVE_ENTRIES = 50_000;
const MAX_ENTRY_BYTES = 512 * 1024 * 1024;
const MAX_CENTRAL_DIRECTORY_BYTES = 64 * 1024 * 1024;
const MAX_EXPANSION_RATIO = 500;
const END_OF_CENTRAL_DIRECTORY = 0x06054b50;
const ZIP64_END_OF_CENTRAL_DIRECTORY = 0x06064b50;
const ZIP64_END_OF_CENTRAL_DIRECTORY_LOCATOR = 0x07064b50;
const CENTRAL_DIRECTORY_ENTRY = 0x02014b50;
const LOCAL_FILE_HEADER = 0x04034b50;
const MAX_UINT16 = 0xffff;
const MAX_UINT32 = 0xffffffff;

const CRC_TABLE = Uint32Array.from({ length: 256 }, (_, index) => {
  let crc = index;
  for (let bit = 0; bit < 8; bit++) crc = (crc & 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1) >>> 0;
  return crc;
});

export type ArchiveReadOptions = {
  signal?: AbortSignal;
};

export type ArchiveLoadOptions = ArchiveReadOptions & {
  onProgress?: (current: number, total: number) => void;
  deferStorageCheck?: boolean;
};

type LazyArchiveEntry = JSZip.JSZipObject & {
  _data: Pick<ArchiveMember, 'compressedSize' | 'uncompressedSize' | 'crc32'>;
  readVerified: (signal?: AbortSignal) => Promise<Blob>;
};

type ArchiveMember = {
  compressedSize: number;
  uncompressedSize: number;
  crc32: number;
  compressionMethod: number;
  localHeaderOffset: number;
};

export type SafeArchive = {
  zip: JSZip;
  entries: JSZip.JSZipObject[];
  uncompressedBytes: number;
};

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new DOMException('Archive import cancelled.', 'AbortError');
}

function readUint64(view: DataView, offset: number): number {
  const value = view.getBigUint64(offset, true);
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error('This archive contains an offset or file size beyond the supported browser range.');
  }
  return Number(value);
}

async function readSlice(file: Blob, start: number, end: number, signal?: AbortSignal): Promise<Uint8Array> {
  throwIfAborted(signal);
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end < start || end > file.size) {
    throw new Error('This archive contains an invalid file offset.');
  }
  const bytes = new Uint8Array(await file.slice(start, end).arrayBuffer());
  throwIfAborted(signal);
  if (bytes.byteLength !== end - start) throw new Error('This archive is truncated or incomplete.');
  return bytes;
}

function updateCrc(crc: number, bytes: Uint8Array): number {
  for (let index = 0; index < bytes.length; index++) {
    crc = CRC_TABLE[(crc ^ bytes[index]!) & 0xff]! ^ (crc >>> 8);
  }
  return crc >>> 0;
}

function parseZip64Extra(
  view: DataView,
  start: number,
  end: number,
  uncompressedSize: number,
  compressedSize: number,
  localHeaderOffset: number,
): Pick<ArchiveMember, 'compressedSize' | 'uncompressedSize' | 'localHeaderOffset'> {
  let offset = start;
  while (offset + 4 <= end) {
    const field = view.getUint16(offset, true);
    const length = view.getUint16(offset + 2, true);
    offset += 4;
    if (offset + length > end) throw new Error('This archive contains an invalid ZIP64 extra field.');
    if (field !== 1) {
      offset += length;
      continue;
    }
    const limit = offset + length;
    const next = () => {
      if (offset + 8 > limit) throw new Error('This archive contains an incomplete ZIP64 extra field.');
      const value = readUint64(view, offset);
      offset += 8;
      return value;
    };
    if (uncompressedSize === MAX_UINT32) uncompressedSize = next();
    if (compressedSize === MAX_UINT32) compressedSize = next();
    if (localHeaderOffset === MAX_UINT32) localHeaderOffset = next();
    return { compressedSize, uncompressedSize, localHeaderOffset };
  }
  throw new Error('This archive is missing required ZIP64 file information.');
}

async function locateCentralDirectory(file: Blob, signal?: AbortSignal) {
  if (!Number.isSafeInteger(file.size) || file.size < 22) throw new Error('This archive is truncated or invalid.');
  const tailStart = Math.max(0, file.size - (MAX_UINT16 + 22));
  const tail = await readSlice(file, tailStart, file.size, signal);
  const view = new DataView(tail.buffer, tail.byteOffset, tail.byteLength);
  let endOffset = -1;
  for (let offset = tail.length - 22; offset >= 0; offset--) {
    if (
      view.getUint32(offset, true) === END_OF_CENTRAL_DIRECTORY &&
      offset + 22 + view.getUint16(offset + 20, true) === tail.length
    ) {
      endOffset = offset;
      break;
    }
  }
  if (endOffset < 0) throw new Error('This archive has no valid central directory.');
  if (view.getUint16(endOffset + 4, true) !== 0 || view.getUint16(endOffset + 6, true) !== 0) {
    throw new Error('Multi-disk ZIP archives are not supported.');
  }

  let count = view.getUint16(endOffset + 10, true);
  let size = view.getUint32(endOffset + 12, true);
  let offset = view.getUint32(endOffset + 16, true);
  if (count === MAX_UINT16 || size === MAX_UINT32 || offset === MAX_UINT32) {
    const locatorOffset = tailStart + endOffset - 20;
    const locatorBytes = await readSlice(file, locatorOffset, locatorOffset + 20, signal);
    const locator = new DataView(locatorBytes.buffer, locatorBytes.byteOffset, locatorBytes.byteLength);
    if (
      locator.getUint32(0, true) !== ZIP64_END_OF_CENTRAL_DIRECTORY_LOCATOR ||
      locator.getUint32(4, true) !== 0 ||
      locator.getUint32(16, true) !== 1
    ) {
      throw new Error('This archive has an invalid or multi-disk ZIP64 directory.');
    }
    const recordOffset = readUint64(locator, 8);
    const recordBytes = await readSlice(file, recordOffset, recordOffset + 56, signal);
    const record = new DataView(recordBytes.buffer, recordBytes.byteOffset, recordBytes.byteLength);
    if (
      record.getUint32(0, true) !== ZIP64_END_OF_CENTRAL_DIRECTORY ||
      readUint64(record, 4) < 44 ||
      record.getUint32(16, true) !== 0 ||
      record.getUint32(20, true) !== 0
    ) {
      throw new Error('This archive has an invalid or multi-disk ZIP64 directory.');
    }
    count = readUint64(record, 32);
    size = readUint64(record, 40);
    offset = readUint64(record, 48);
  }

  if (count > MAX_ARCHIVE_ENTRIES) throw new Error(`This archive contains too many files (${count}).`);
  if (size > MAX_CENTRAL_DIRECTORY_BYTES) {
    throw new Error('This archive has too much directory metadata to inspect safely.');
  }
  if (offset + size > tailStart + endOffset || !Number.isSafeInteger(offset + size)) {
    throw new Error('This archive has an invalid central-directory location.');
  }
  return { count, offset, size };
}

async function readMember(file: Blob, member: ArchiveMember, directoryOffset: number, signal?: AbortSignal) {
  throwIfAborted(signal);
  const headerBytes = await readSlice(file, member.localHeaderOffset, member.localHeaderOffset + 30, signal);
  const header = new DataView(headerBytes.buffer, headerBytes.byteOffset, headerBytes.byteLength);
  if (
    header.getUint32(0, true) !== LOCAL_FILE_HEADER ||
    header.getUint16(8, true) !== member.compressionMethod ||
    (header.getUint16(6, true) & 1) !== 0
  ) {
    throw new Error('This archive contains an invalid or encrypted local file header.');
  }
  const dataOffset = member.localHeaderOffset + 30 + header.getUint16(26, true) + header.getUint16(28, true);
  const dataEnd = dataOffset + member.compressedSize;
  if (!Number.isSafeInteger(dataEnd) || dataEnd > directoryOffset) {
    throw new Error('This archive contains a truncated or invalid compressed file.');
  }

  const reader = file.slice(dataOffset, dataEnd).stream().getReader();
  const chunks: Uint8Array<ArrayBuffer>[] = [];
  let total = 0;
  let crc = MAX_UINT32;
  const accept = (chunk: Uint8Array) => {
    throwIfAborted(signal);
    total += chunk.byteLength;
    if (total > member.uncompressedSize || total > MAX_ENTRY_BYTES) {
      throw new Error('An archive entry exceeded its declared safe uncompressed size.');
    }
    crc = updateCrc(crc, chunk);
    chunks.push(new Uint8Array(chunk));
  };
  const inflater = member.compressionMethod === 8 ? new Inflate({ raw: true, chunkSize: 64 * 1024 }) : undefined;
  if (inflater) inflater.onData = accept;
  const cancel = () => void reader.cancel().catch(() => {});
  signal?.addEventListener('abort', cancel, { once: true });
  try {
    while (true) {
      throwIfAborted(signal);
      const result = await reader.read();
      throwIfAborted(signal);
      if (result.done) break;
      if (inflater) {
        if (!inflater.push(result.value, false)) {
          throw new Error('An archive entry is corrupt or cannot be decompressed.');
        }
      } else {
        accept(result.value);
      }
    }
    if (inflater && !inflater.ended && !inflater.push(new Uint8Array(), true)) {
      throw new Error('An archive entry is corrupt or cannot be decompressed.');
    }
  } finally {
    signal?.removeEventListener('abort', cancel);
    reader.releaseLock();
  }
  throwIfAborted(signal);
  if (total !== member.uncompressedSize)
    throw new Error('An archive entry did not match its declared uncompressed size.');
  if ((crc ^ MAX_UINT32) >>> 0 !== member.crc32) {
    throw new Error('An archive entry failed its CRC32 integrity check.');
  }
  return new Blob(chunks);
}

export async function loadSafeArchive(file: Blob, options: ArchiveLoadOptions = {}): Promise<SafeArchive> {
  const { signal, onProgress, deferStorageCheck = false } = options;
  const directory = await locateCentralDirectory(file, signal);
  const bytes = await readSlice(file, directory.offset, directory.offset + directory.size, signal);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const decoder = new TextDecoder();
  const files: Record<string, JSZip.JSZipObject> = Object.create(null) as Record<string, JSZip.JSZipObject>;
  const normalizedPaths = new Set<string>();
  const entries: JSZip.JSZipObject[] = [];
  let uncompressedBytes = 0;
  let offset = 0;

  for (let index = 0; index < directory.count; index++) {
    throwIfAborted(signal);
    if (offset + 46 > bytes.length || view.getUint32(offset, true) !== CENTRAL_DIRECTORY_ENTRY) {
      throw new Error('This archive has an invalid central-directory record.');
    }
    const flags = view.getUint16(offset + 8, true);
    const compressionMethod = view.getUint16(offset + 10, true);
    const crc32 = view.getUint32(offset + 16, true);
    let compressedSize = view.getUint32(offset + 20, true);
    let uncompressedSize = view.getUint32(offset + 24, true);
    const nameLength = view.getUint16(offset + 28, true);
    const extraLength = view.getUint16(offset + 30, true);
    const commentLength = view.getUint16(offset + 32, true);
    let localHeaderOffset = view.getUint32(offset + 42, true);
    const nameOffset = offset + 46;
    const extraOffset = nameOffset + nameLength;
    const nextOffset = extraOffset + extraLength + commentLength;
    if (nextOffset > bytes.length || nameLength === 0) {
      throw new Error('This archive has an invalid central-directory record.');
    }
    if (uncompressedSize === MAX_UINT32 || compressedSize === MAX_UINT32 || localHeaderOffset === MAX_UINT32) {
      ({ compressedSize, uncompressedSize, localHeaderOffset } = parseZip64Extra(
        view,
        extraOffset,
        extraOffset + extraLength,
        uncompressedSize,
        compressedSize,
        localHeaderOffset,
      ));
    }
    const name = decoder.decode(bytes.subarray(nameOffset, extraOffset));
    const normalizedName = name.replace(/\\/g, '/').normalize('NFC');
    if (
      !normalizedName ||
      normalizedName.includes('\0') ||
      normalizedName.startsWith('/') ||
      /^[a-z]:/i.test(normalizedName) ||
      normalizedName.split('/').includes('..')
    ) {
      throw new Error('This archive contains an unsafe file path.');
    }
    if (normalizedPaths.has(normalizedName)) throw new Error('This archive contains duplicate file paths.');
    normalizedPaths.add(normalizedName);
    if ((flags & 1) !== 0) throw new Error('Encrypted ZIP archives are not supported.');
    if (compressionMethod !== 0 && compressionMethod !== 8) {
      throw new Error('This archive uses an unsupported compression method.');
    }
    if (
      uncompressedSize > MAX_ENTRY_BYTES ||
      compressedSize > MAX_ENTRY_BYTES ||
      (compressionMethod === 0 && compressedSize !== uncompressedSize)
    ) {
      throw new Error('This archive contains a file that exceeds the safe import size.');
    }
    if (compressedSize > 0 && uncompressedSize / compressedSize > MAX_EXPANSION_RATIO) {
      throw new Error('This archive expands far beyond its compressed size and cannot be safely imported.');
    }
    if (localHeaderOffset >= directory.offset) throw new Error('This archive contains an invalid file offset.');

    const member: ArchiveMember = {
      compressedSize,
      uncompressedSize,
      crc32,
      compressionMethod,
      localHeaderOffset,
    };
    const readVerified = (entrySignal?: AbortSignal) => readMember(file, member, directory.offset, entrySignal);
    const entry = {
      name,
      dir: normalizedName.endsWith('/'),
      unsafeOriginalName: name,
      _data: { compressedSize, uncompressedSize, crc32 },
      readVerified,
      async async(type: string) {
        const blob = await readVerified();
        if (type === 'blob') return blob;
        const data = new Uint8Array(await blob.arrayBuffer());
        if (type === 'uint8array') return data;
        if (type === 'arraybuffer') return data.buffer;
        if (type === 'string' || type === 'text') return decoder.decode(data);
        throw new Error('This archive entry output format is not supported.');
      },
    } as unknown as LazyArchiveEntry;
    files[name] = entry;
    if (!entry.dir) {
      uncompressedBytes += uncompressedSize;
      if (!Number.isSafeInteger(uncompressedBytes)) {
        throw new Error('This archive exceeds the supported browser storage range.');
      }
      entries.push(entry);
    }
    offset = nextOffset;
    onProgress?.(index + 1, directory.count);
  }
  if (offset !== bytes.length) throw new Error('This archive contains unexpected central-directory data.');
  throwIfAborted(signal);
  if (!deferStorageCheck) await assertStorageHeadroom(uncompressedBytes);
  throwIfAborted(signal);
  const zip = { files, file: (name: string) => files[name] ?? null } as unknown as JSZip;
  return { zip, entries, uncompressedBytes };
}

export async function readArchiveEntry(entry: JSZip.JSZipObject, options: ArchiveReadOptions = {}): Promise<Blob> {
  throwIfAborted(options.signal);
  const lazy = entry as Partial<LazyArchiveEntry>;
  if (lazy.readVerified) return lazy.readVerified(options.signal);
  const bytes = await entry.async('uint8array');
  throwIfAborted(options.signal);
  const metadata = lazy._data;
  if (typeof metadata?.uncompressedSize === 'number' && bytes.byteLength !== metadata.uncompressedSize) {
    throw new Error('An archive entry did not match its declared uncompressed size.');
  }
  if (
    typeof metadata?.crc32 === 'number' &&
    (updateCrc(MAX_UINT32, bytes) ^ MAX_UINT32) >>> 0 !== metadata.crc32 >>> 0
  ) {
    throw new Error('An archive entry failed its CRC32 integrity check.');
  }
  return new Blob([new Uint8Array(bytes)]);
}
