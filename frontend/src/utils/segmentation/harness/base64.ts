// Cross-platform base64 helpers.
//
// We want the tumor harness dataset to be usable both:
// - in the browser (exporter UI), and
// - in Node (offline harness runner).
//
// Node has Buffer; browsers typically have atob/btoa.
// These helpers avoid pulling in additional dependencies.

type BufferCtor = {
  from(data: Uint8Array | string, encoding?: string): Uint8Array & { toString(encoding: string): string };
};

function getBufferCtor(): BufferCtor | null {
  const maybe = (globalThis as unknown as { Buffer?: BufferCtor }).Buffer;
  return typeof maybe?.from === 'function' ? maybe : null;
}

export function bytesToBase64(bytes: Uint8Array): string {
  const Buffer = getBufferCtor();
  if (Buffer) {
    return Buffer.from(bytes).toString('base64');
  }

  if (typeof btoa !== 'function') {
    throw new Error('bytesToBase64: no Buffer and no btoa available');
  }

  // btoa expects a binary string. Build it in chunks to avoid stack/arg limits.
  const chunkSize = 0x8000;
  let binary = '';
  for (let i = 0; i < bytes.length; i += chunkSize) {
    const chunk = bytes.subarray(i, Math.min(bytes.length, i + chunkSize));

    let s = '';
    for (let j = 0; j < chunk.length; j++) {
      s += String.fromCharCode(chunk[j] ?? 0);
    }

    binary += s;
  }

  return btoa(binary);
}

export function base64ToBytes(b64: string): Uint8Array {
  const Buffer = getBufferCtor();
  if (Buffer) {
    return Buffer.from(b64, 'base64');
  }

  if (typeof atob !== 'function') {
    throw new Error('base64ToBytes: no Buffer and no atob available');
  }

  const binary = atob(b64);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    out[i] = binary.charCodeAt(i) & 0xff;
  }
  return out;
}
