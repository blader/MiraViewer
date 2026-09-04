import { assertArchiveActive, inspectBlob } from './archiveIntegrity';
import {
  MAX_ARCHIVE_ENTRIES,
  MAX_CENTRAL_DIRECTORY_BYTES,
  MAX_ENTRY_BYTES,
  normalizeArchivePath,
} from './archiveSafety';

export type BackupZipSink = Pick<FileSystemWritableFileStream, 'write' | 'close' | 'abort'>;
const UINT32_MAX = 0xffffffff;
const bytes = (length: number) => {
  const data = new Uint8Array(length);
  return { data, view: new DataView(data.buffer) };
};

/** STORE-only ZIP output. Payloads go to a backpressured file or remain immutable Blob references. */
export class BackupZip {
  private readonly parts: BlobPart[] = [];
  private readonly directory: Uint8Array<ArrayBuffer>[] = [];
  private readonly names = new Set<string>();
  private offset = 0;
  private directoryBytes = 0;
  private readonly signal?: AbortSignal;
  private readonly sink?: BackupZipSink;

  constructor(signal?: AbortSignal, sink?: BackupZipSink) {
    this.signal = signal;
    this.sink = sink;
  }

  private async write(data: Uint8Array<ArrayBuffer>) {
    assertArchiveActive(this.signal);
    if (this.sink) await this.sink.write(data);
    else this.parts.push(data);
    this.offset += data.byteLength;
    if (!Number.isSafeInteger(this.offset)) throw new Error('The backup exceeds the supported file range.');
  }

  async add(name: string, blob: Blob, progress?: (bytes: number) => void): Promise<string> {
    const normalized = normalizeArchivePath(name);
    if (this.names.has(normalized)) throw new Error('The backup contains duplicate file paths.');
    if (this.names.size >= MAX_ARCHIVE_ENTRIES) throw new Error('The backup contains too many files.');
    if (!Number.isSafeInteger(blob.size) || blob.size < 0 || blob.size > MAX_ENTRY_BYTES)
      throw new Error('A backup file exceeds the safe per-file import size.');
    const encoded = new TextEncoder().encode(name);
    if (encoded.length > 0xffff) throw new Error('A backup file name is too long.');
    this.names.add(normalized);
    const localOffset = this.offset;
    const local = bytes(30 + encoded.length);
    local.view.setUint32(0, 0x04034b50, true);
    local.view.setUint16(4, 20, true);
    local.view.setUint16(6, 0x0808, true); // UTF-8 name and trailing data descriptor.
    local.view.setUint16(12, 33, true); // 1980-01-01; source dates live in the manifest.
    local.view.setUint16(26, encoded.length, true);
    local.data.set(encoded, 30);
    await this.write(local.data);
    if (!this.sink) {
      this.parts.push(blob);
      this.offset += blob.size;
    }
    const integrity = await inspectBlob(blob, {
      signal: this.signal,
      onChunk: async (chunk) => {
        if (this.sink) await this.write(chunk);
        progress?.(chunk.length);
      },
    });
    const descriptor = bytes(16);
    descriptor.view.setUint32(0, 0x08074b50, true);
    descriptor.view.setUint32(4, integrity.crc32, true);
    descriptor.view.setUint32(8, blob.size, true);
    descriptor.view.setUint32(12, blob.size, true);
    await this.write(descriptor.data);

    const zip64Offset = localOffset >= UINT32_MAX;
    const central = bytes(46 + encoded.length + (zip64Offset ? 12 : 0));
    central.view.setUint32(0, 0x02014b50, true);
    central.view.setUint16(4, 45, true);
    central.view.setUint16(6, zip64Offset ? 45 : 20, true);
    central.view.setUint16(8, 0x0808, true);
    central.view.setUint16(14, 33, true);
    central.view.setUint32(16, integrity.crc32, true);
    central.view.setUint32(20, blob.size, true);
    central.view.setUint32(24, blob.size, true);
    central.view.setUint16(28, encoded.length, true);
    central.view.setUint16(30, zip64Offset ? 12 : 0, true);
    central.view.setUint32(42, zip64Offset ? UINT32_MAX : localOffset, true);
    central.data.set(encoded, 46);
    if (zip64Offset) {
      const extra = 46 + encoded.length;
      central.view.setUint16(extra, 1, true);
      central.view.setUint16(extra + 2, 8, true);
      central.view.setBigUint64(extra + 4, BigInt(localOffset), true);
    }
    this.directoryBytes += central.data.length;
    if (this.directoryBytes > MAX_CENTRAL_DIRECTORY_BYTES)
      throw new Error('The backup has too much directory metadata to import safely.');
    this.directory.push(central.data);
    return integrity.sha256;
  }

  async finish(onCommitStart?: () => void): Promise<Blob | null> {
    const directoryOffset = this.offset;
    for (const record of this.directory) await this.write(record);
    const zip64Offset = this.offset;
    const zip64 = bytes(56);
    zip64.view.setUint32(0, 0x06064b50, true);
    zip64.view.setBigUint64(4, 44n, true);
    zip64.view.setUint16(12, 45, true);
    zip64.view.setUint16(14, 45, true);
    zip64.view.setBigUint64(24, BigInt(this.directory.length), true);
    zip64.view.setBigUint64(32, BigInt(this.directory.length), true);
    zip64.view.setBigUint64(40, BigInt(this.directoryBytes), true);
    zip64.view.setBigUint64(48, BigInt(directoryOffset), true);
    await this.write(zip64.data);
    const locator = bytes(20);
    locator.view.setUint32(0, 0x07064b50, true);
    locator.view.setBigUint64(8, BigInt(zip64Offset), true);
    locator.view.setUint32(16, 1, true);
    await this.write(locator.data);
    const end = bytes(22);
    end.view.setUint32(0, 0x06054b50, true);
    end.view.setUint16(8, 0xffff, true);
    end.view.setUint16(10, 0xffff, true);
    end.view.setUint32(12, UINT32_MAX, true);
    end.view.setUint32(16, UINT32_MAX, true);
    await this.write(end.data);
    assertArchiveActive(this.signal);
    if (this.sink) {
      onCommitStart?.();
      await this.sink.close();
      return null;
    }
    return new Blob(this.parts, { type: 'application/zip' });
  }
}
