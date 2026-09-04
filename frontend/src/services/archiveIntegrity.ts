import { sha256 } from '@noble/hashes/sha2.js';
import { yieldToMain } from '../utils/svr/svrUtils';

const CRC_TABLE = Uint32Array.from({ length: 256 }, (_, index) => {
  let crc = index;
  for (let bit = 0; bit < 8; bit++) crc = (crc & 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1) >>> 0;
  return crc;
});

export function updateCrc(crc: number, bytes: Uint8Array): number {
  for (let index = 0; index < bytes.length; index++) crc = CRC_TABLE[(crc ^ bytes[index]!) & 0xff]! ^ (crc >>> 8);
  return crc >>> 0;
}

export function assertArchiveActive(signal?: AbortSignal): void {
  if (signal?.aborted) throw new DOMException('Backup operation cancelled.', 'AbortError');
}

/** One bounded buffer for hashing and an optional backpressured export sink. */
export async function inspectBlob(
  blob: Blob,
  options: { signal?: AbortSignal; onChunk?: (bytes: Uint8Array<ArrayBuffer>) => void | Promise<void> } = {},
): Promise<{ sha256: string; crc32: number }> {
  assertArchiveActive(options.signal);
  if (!Number.isSafeInteger(blob.size) || blob.size < 0) throw new Error('The backup has an invalid payload size.');
  const hash = sha256.create();
  let crc = 0xffffffff;
  let yielded = performance.now();
  try {
    for (let offset = 0; offset < blob.size; offset += 64 * 1024) {
      assertArchiveActive(options.signal);
      const end = Math.min(offset + 64 * 1024, blob.size);
      const bytes = new Uint8Array(await blob.slice(offset, end).arrayBuffer());
      assertArchiveActive(options.signal);
      if (bytes.length !== end - offset) throw new Error('A backup payload changed size while reading it.');
      hash.update(bytes);
      crc = updateCrc(crc, bytes);
      await options.onChunk?.(bytes);
      if (performance.now() - yielded >= 8) {
        await yieldToMain();
        yielded = performance.now();
      }
    }
    assertArchiveActive(options.signal);
    return {
      sha256: Array.from(hash.digest(), (byte) => byte.toString(16).padStart(2, '0')).join(''),
      crc32: (crc ^ 0xffffffff) >>> 0,
    };
  } finally {
    hash.destroy();
  }
}
