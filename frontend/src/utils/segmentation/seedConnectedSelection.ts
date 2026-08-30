import { yieldToMain } from '../svr/svrUtils';

const SCAN_CHUNK = 65_536;
const WALK_CHUNK = 2_048;

/**
 * Keep the union of 26-neighbor components reached from already-selected marks.
 * The mask must be exclusively owned and unpublished; marks must remain stable
 * until this settles. Cancellation/failure can leave temporary value-2 markers,
 * so discard that buffer. No pixels or marks are added, smoothed, or filled.
 * Scratch is one Uint32 queue: four bytes per initially selected voxel at most.
 */
export async function retainMarkedComponents(
  data: Uint8Array,
  dims: readonly [number, number, number],
  foreground: Uint32Array,
  signal?: AbortSignal,
): Promise<number> {
  const abort = () => {
    if (signal?.aborted) throw new DOMException('Selection connectivity canceled.', 'AbortError');
  };
  const checkpoint = async () => {
    abort();
    await yieldToMain();
    abort();
  };
  abort();
  if (
    !ArrayBuffer.isView(data) ||
    Object.prototype.toString.call(data) !== '[object Uint8Array]' ||
    !Array.isArray(dims) ||
    dims.length !== 3 ||
    !dims.every((size) => Number.isSafeInteger(size) && size > 0) ||
    !ArrayBuffer.isView(foreground) ||
    Object.prototype.toString.call(foreground) !== '[object Uint32Array]'
  )
    throw new Error(
      'Selection connectivity requires a byte mask, three positive integer dimensions, and Uint32 marks.',
    );
  const [nx, ny, nz] = dims;
  const xy = nx * ny;
  const count = xy * nz;
  if (!Number.isSafeInteger(count) || count > 0x1_0000_0000 || data.length !== count)
    throw new Error('Selection connectivity requires a complete grid addressable by Uint32 indices.');

  // Validate every input before using the owned mask as visitation storage.
  let selected = 0;
  for (let start = 0; start < count; start += SCAN_CHUNK) {
    for (let index = start, end = Math.min(count, start + SCAN_CHUNK); index < end; index++) {
      if (data[index] !== 0 && data[index] !== 1) throw new Error('Selection connectivity requires a binary mask.');
      selected += data[index]!;
    }
    await checkpoint();
  }
  for (let start = 0; start < foreground.length; start += SCAN_CHUNK) {
    for (let index = start, end = Math.min(foreground.length, start + SCAN_CHUNK); index < end; index++)
      if (foreground[index]! >= count) throw new Error('A foreground mark lies outside the selection grid.');
    await checkpoint();
  }

  const queue = new Uint32Array(selected);
  let head = 0,
    tail = 0;
  for (let start = 0; start < foreground.length; start += SCAN_CHUNK) {
    for (let index = start, end = Math.min(foreground.length, start + SCAN_CHUNK); index < end; index++) {
      const mark = foreground[index]!;
      if (data[mark] !== 1) continue;
      data[mark] = 2;
      queue[tail++] = mark;
    }
    await checkpoint();
  }
  while (head < tail) {
    // Include newly enqueued neighbors in this chunk, even for a one-voxel-wide path.
    for (const end = head + WALK_CHUNK; head < tail && head < end; head++) {
      const index = queue[head]!;
      const x = index % nx,
        y = Math.floor(index / nx) % ny,
        z = Math.floor(index / xy);
      for (let zz = Math.max(0, z - 1); zz <= Math.min(nz - 1, z + 1); zz++)
        for (let yy = Math.max(0, y - 1); yy <= Math.min(ny - 1, y + 1); yy++)
          for (let xx = Math.max(0, x - 1); xx <= Math.min(nx - 1, x + 1); xx++) {
            const neighbor = (zz * ny + yy) * nx + xx;
            if (data[neighbor] !== 1) continue;
            data[neighbor] = 2;
            queue[tail++] = neighbor;
          }
    }
    await checkpoint();
  }
  for (let start = 0; start < count; start += SCAN_CHUNK) {
    for (let index = start, end = Math.min(count, start + SCAN_CHUNK); index < end; index++)
      data[index] = data[index] === 2 ? 1 : 0;
    await checkpoint();
  }
  return selected - tail;
}
