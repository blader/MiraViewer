import JSZip from 'jszip';
import { assertStorageHeadroom } from '../db/db';

const MAX_ARCHIVE_ENTRIES = 50_000;
const MAX_ENTRY_BYTES = 512 * 1024 * 1024;
const MAX_ARCHIVE_BYTES = 4 * 1024 * 1024 * 1024;
const MAX_EXPANSION_RATIO = 500;

type ArchiveEntrySize = {
  compressedSize?: number;
  uncompressedSize?: number;
};

export type SafeArchive = {
  zip: JSZip;
  entries: JSZip.JSZipObject[];
  uncompressedBytes: number;
};

export async function loadSafeArchive(file: Blob): Promise<SafeArchive> {
  const zip = await JSZip.loadAsync(file);
  const entries = Object.values(zip.files).filter((entry) => !entry.dir);
  if (entries.length > MAX_ARCHIVE_ENTRIES) {
    throw new Error(`This archive contains too many files (${entries.length}).`);
  }

  let uncompressedBytes = 0;
  for (const entry of entries) {
    const originalName =
      (entry as JSZip.JSZipObject & { unsafeOriginalName?: string }).unsafeOriginalName ?? entry.name;
    if (originalName.split(/[\\/]+/).includes('..')) {
      throw new Error('This archive contains an unsafe file path.');
    }

    const data = (entry as JSZip.JSZipObject & { _data?: ArchiveEntrySize })._data;
    const size = data?.uncompressedSize;
    const compressed = data?.compressedSize;
    if (typeof size !== 'number' || !Number.isFinite(size) || size < 0) {
      throw new Error('This archive contains a file with an invalid declared size.');
    }
    if (size > MAX_ENTRY_BYTES) {
      throw new Error('This archive contains a file that exceeds the safe import size.');
    }
    if (typeof compressed === 'number' && compressed > 0 && size / compressed > MAX_EXPANSION_RATIO) {
      throw new Error('This archive expands far beyond its compressed size and cannot be safely imported.');
    }
    uncompressedBytes += size;
    if (uncompressedBytes > MAX_ARCHIVE_BYTES) {
      throw new Error('This archive exceeds the maximum safe uncompressed import size.');
    }
  }

  await assertStorageHeadroom(uncompressedBytes);
  return { zip, entries, uncompressedBytes };
}

export async function readArchiveEntry(entry: JSZip.JSZipObject): Promise<Blob> {
  const expectedSize = (entry as JSZip.JSZipObject & { _data?: ArchiveEntrySize })._data?.uncompressedSize;
  const blob = await entry.async('blob');
  if (typeof expectedSize === 'number' && blob.size !== expectedSize) {
    throw new Error('An archive entry did not match its declared uncompressed size.');
  }
  return blob;
}
