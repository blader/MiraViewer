import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  SeededVolumeWorker,
  type SeededWorkerRequest,
  type SeededWorkerResponse,
} from '../src/utils/segmentation/seededVolumeWorker';
import {
  markedRegionBounds,
  MAX_SEGMENTATION_DOMAIN_VOXELS,
  segmentSeededVolume,
  voxelIndex,
  type SeededVolumeInput,
} from '../src/utils/segmentation/seededVolume';

class MockWorker {
  static instances: MockWorker[] = [];

  onmessage: ((event: MessageEvent<SeededWorkerResponse>) => void) | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;
  onmessageerror: (() => void) | null = null;
  messages: SeededWorkerRequest[] = [];
  transfers: Transferable[][] = [];
  terminate = vi.fn();

  constructor() {
    MockWorker.instances.push(this);
  }

  postMessage(message: SeededWorkerRequest, transfer: Transferable[] = []): void {
    const received = structuredClone(message, { transfer });
    // Node clones into its host realm; a browser worker delivers receiving-realm
    // typed arrays. Rewrap the transferred buffers without copying their data.
    if (received.type === 'init') {
      received.volume = new Float32Array(received.volume.buffer, received.volume.byteOffset, received.volume.length);
      if (received.observedSupport)
        received.observedSupport = new Uint8Array(
          received.observedSupport.buffer,
          received.observedSupport.byteOffset,
          received.observedSupport.length,
        );
    } else if (received.type === 'run') {
      received.foreground = new Uint32Array(
        received.foreground.buffer,
        received.foreground.byteOffset,
        received.foreground.length,
      );
      received.background = new Uint32Array(
        received.background.buffer,
        received.background.byteOffset,
        received.background.length,
      );
    }
    this.messages.push(received);
    this.transfers.push(transfer);
  }

  respond(message: SeededWorkerResponse): void {
    this.onmessage?.({ data: message } as MessageEvent<SeededWorkerResponse>);
  }
}

const volume = new Float32Array([0.1, 0.2, 0.3, 0.4]);
const baseOptions = {
  volume,
  dims: [2, 2, 1] as [number, number, number],
  voxelSizeMm: [1, 1, 1] as [number, number, number],
  foreground: Uint32Array.of(0),
  background: Uint32Array.of(3),
};

function result(indices: number[]) {
  return {
    indices: new Uint32Array(indices),
    count: indices.length,
    bounds: { min: { x: 0, y: 0, z: 0 }, max: { x: 1, y: 1, z: 0 } },
    boundaryCount: 0,
    domainVoxels: 4,
  };
}

function croppedInput(): SeededVolumeInput {
  const dims: [number, number, number] = [13, 11, 9];
  const at = (x: number, y: number, z: number) => voxelIndex({ x, y, z }, dims);
  const volume = new Float32Array(dims[0] * dims[1] * dims[2]);
  for (let z = 0; z < dims[2]; z++)
    for (let y = 0; y < dims[1]; y++)
      for (let x = 0; x < dims[0]; x++) {
        const inside = ((x - 6) / 3) ** 2 + ((y - 5) / 2) ** 2 + (z - 4) ** 2 <= 1;
        volume[at(x, y, z)] = 0.3 + 0.02 * Math.sin(x * 1.3 + y * 0.7 + z * 2.1) + (inside ? 0.4 : 0);
      }
  const observedSupport = new Uint8Array(volume.length).fill(1);
  observedSupport[at(6, 5, 3)] = 0;
  volume[at(5, 5, 4)] = NaN;
  return {
    volume,
    observedSupport,
    dims,
    voxelSizeMm: [0.7, 1.6, 2.3],
    foreground: Uint32Array.of(at(6, 5, 4), at(7, 5, 4)),
    background: Uint32Array.of(at(3, 5, 4), at(9, 7, 6)),
    bounds: { min: { x: 2, y: 1, z: 2 }, max: { x: 10, y: 9, z: 7 } },
  };
}

function requestFor(worker: MockWorker) {
  const source = worker.messages.find((message) => message.type === 'init');
  const request = worker.messages.at(-1);
  if (!source || request?.type !== 'run') throw new Error('Expected an initialized selection request.');
  return { source, request };
}

function completeForeground(
  worker: MockWorker,
  request: Extract<SeededWorkerRequest, { type: 'run' }>,
  domainVoxels: number,
  boundaryCount = 0,
) {
  worker.respond({
    type: 'done',
    id: request.id,
    result: { indices: request.foreground.slice(), bounds: request.bounds!, boundaryCount, domainVoxels },
  });
}

let runner: SeededVolumeWorker;
beforeEach(() => {
  MockWorker.instances = [];
  vi.stubGlobal('Worker', MockWorker);
  runner = new SeededVolumeWorker();
});

afterEach(() => {
  runner.dispose();
  vi.restoreAllMocks();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('SeededVolumeWorker', () => {
  it('reports transferred tight buffers without retaining aliased caller backing bytes', async () => {
    const buffer = new ArrayBuffer(32);
    const source = new Float32Array(buffer, 4, 4);
    const support = new Uint8Array(buffer, 0, 4).fill(1);
    expect(runner.residentSourceBytes).toBe(0);
    const first = runner.run({ ...baseOptions, volume: source, observedSupport: support });
    expect(runner.residentSourceBytes).toBe(20);
    expect(MockWorker.instances[0]!.transfers[0]).toHaveLength(2);
    for (const transferred of MockWorker.instances[0]!.transfers[0]!) {
      expect(transferred).not.toBe(buffer);
      expect((transferred as ArrayBuffer).byteLength).toBe(0);
    }
    expect(buffer.byteLength).toBe(32);
    expect(source.byteLength).toBe(16);
    expect(support.byteLength).toBe(4);
    MockWorker.instances[0]!.respond({ type: 'done', id: 1, result: result([0]) });
    await first;
    expect(runner.residentSourceBytes).toBe(20);
    const second = runner.run({ ...baseOptions, volume: source, observedSupport: new Uint8Array(4).fill(1) });
    expect(runner.residentSourceBytes).toBe(20);
    runner.cancel();
    await expect(second).rejects.toMatchObject({ name: 'AbortError' });
    expect(runner.residentSourceBytes).toBe(0);
    expect(MockWorker.instances[1]!.terminate).toHaveBeenCalledOnce();
    runner.dispose();
    expect(runner.residentSourceBytes).toBe(0);
  });

  it.each([false, true])(
    'matches the real core bit-for-bit on an offset anisotropic domain with support holes (outside marks: %s)',
    async (outsideMarks) => {
      const input = croppedInput();
      if (!outsideMarks) input.background = new Uint32Array();
      const original = {
        volume: input.volume.slice(),
        support: input.observedSupport!.slice(),
        foreground: input.foreground.slice(),
        background: input.background.slice(),
        bounds: structuredClone(input.bounds),
      };
      const expected = await segmentSeededVolume(input);
      const pending = runner.run(input);
      const worker = MockWorker.instances[0]!;
      const { source, request } = requestFor(worker);
      expect(source.dims).toEqual([9, 9, 6]);
      expect(source.voxelSizeMm).toEqual(input.voxelSizeMm);
      expect(source.volume.buffer.byteLength).toBe(9 * 9 * 6 * 4);
      expect(source.observedSupport!.buffer.byteLength).toBe(9 * 9 * 6);
      expect(runner.residentSourceBytes).toBe(9 * 9 * 6 * 5);
      expect(source.volume).not.toBe(input.volume);
      expect(source.observedSupport).not.toBe(input.observedSupport);
      expect(request.bounds).toEqual({ min: { x: 0, y: 0, z: 0 }, max: { x: 8, y: 8, z: 5 } });
      const localResult = await segmentSeededVolume({ ...source, ...request });
      const ownedIndices = localResult.indices;
      worker.respond({ type: 'done', id: request.id, result: localResult });
      const actual = await pending;
      expect(actual).toEqual(expected);
      expect(actual.indices).toBe(ownedIndices);
      expect(actual.indices.length).toBeGreaterThan(input.foreground.length);
      for (const index of input.foreground) expect(actual.indices).toContain(index);
      for (const index of input.background) expect(actual.indices).not.toContain(index);
      for (const index of actual.indices) {
        expect(input.observedSupport![index]).toBe(1);
        expect(Number.isFinite(input.volume[index])).toBe(true);
      }
      expect(input.volume).toEqual(original.volume);
      expect(input.observedSupport).toEqual(original.support);
      expect(input.foreground).toEqual(original.foreground);
      expect(input.background).toEqual(original.background);
      expect(input.bounds).toEqual(original.bounds);
      for (const transfer of worker.transfers[1]!) expect((transfer as ArrayBuffer).byteLength).toBe(0);
    },
  );

  it('transfers only the exact marked-region domain from a larger native grid', async () => {
    const dims: [number, number, number] = [160, 160, 100];
    const volume = new Float32Array(dims[0] * dims[1] * dims[2]).fill(0.5);
    const input: SeededVolumeInput = {
      volume,
      observedSupport: new Uint8Array(volume.length).fill(1),
      dims,
      voxelSizeMm: [0.7, 1.6, 2.3],
      foreground: Uint32Array.of(voxelIndex({ x: 80, y: 80, z: 50 }, dims)),
      background: Uint32Array.of(voxelIndex({ x: 82, y: 80, z: 50 }, dims)),
    };
    const bounds = markedRegionBounds(input);
    const croppedDims = (['x', 'y', 'z'] as const).map((axis) => bounds.max[axis] - bounds.min[axis] + 1);
    const count = croppedDims.reduce((product, size) => product * size, 1);
    const pending = runner.run(input);
    const worker = MockWorker.instances[0]!;
    const { source, request } = requestFor(worker);
    expect(source.dims).toEqual(croppedDims);
    expect(source.volume.length).toBe(count);
    expect(count).toBeLessThanOrEqual(MAX_SEGMENTATION_DOMAIN_VOXELS);
    expect(count).toBeLessThan(volume.length);
    expect(runner.residentSourceBytes).toBe(count * 5);
    expect(volume.byteLength).toBe(160 * 160 * 100 * 4);
    expect(input.observedSupport!.byteLength).toBe(volume.length);
    completeForeground(worker, request, count, 1);
    await expect(pending).resolves.toEqual({
      indices: input.foreground,
      bounds,
      boundaryCount: 1,
      domainVoxels: count,
    });
  });

  it('keeps the same native crop and worker when adding outside marks within the foreground context', async () => {
    const dims: [number, number, number] = [160, 160, 100];
    const volume = new Float32Array(dims[0] * dims[1] * dims[2]).fill(0.5);
    const input: SeededVolumeInput = {
      volume,
      dims,
      voxelSizeMm: [0.7, 1.6, 2.3],
      foreground: Uint32Array.of(voxelIndex({ x: 80, y: 80, z: 50 }, dims)),
      background: new Uint32Array(),
    };
    const bounds = markedRegionBounds(input);
    const initial = runner.run(input);
    const worker = MockWorker.instances[0]!;
    const { source, request } = requestFor(worker);
    completeForeground(worker, request, source.volume.length);
    await initial;
    const corrected = runner.run({
      ...input,
      background: Uint32Array.of(
        voxelIndex({ x: bounds.min.x + 2, y: 80, z: 50 }, dims),
        voxelIndex({ x: bounds.max.x - 2, y: 80, z: 50 }, dims),
        voxelIndex({ x: 80, y: bounds.min.y + 2, z: 50 }, dims),
        voxelIndex({ x: 80, y: bounds.max.y - 2, z: 50 }, dims),
      ),
    });
    void corrected.catch(() => {});
    expect(MockWorker.instances).toHaveLength(1);
    expect(worker.terminate).not.toHaveBeenCalled();
    expect(worker.messages.map((message) => message.type)).toEqual(['init', 'run', 'run']);
    expect(requestFor(worker).request.bounds).toEqual(request.bounds);
    expect(runner.residentSourceBytes).toBe(source.volume.byteLength);
    runner.cancel();
    await expect(corrected).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('reuses only the same exact crop and replaces it when mutable bounds change', async () => {
    const input = croppedInput();
    const first = runner.run(input);
    const old = MockWorker.instances[0]!;
    const oldRequest = requestFor(old).request;
    completeForeground(old, oldRequest, 486);
    await first;
    const same = runner.run({ ...input, bounds: structuredClone(input.bounds) });
    expect(MockWorker.instances).toHaveLength(1);
    expect(old.messages.map((message) => message.type)).toEqual(['init', 'run', 'run']);
    const sameRequest = requestFor(old).request;
    completeForeground(old, sameRequest, 486);
    await same;

    input.bounds!.min.x = 3;
    input.bounds!.max.x = 11;
    const moved = runner.run(input);
    const current = MockWorker.instances[1]!;
    expect(old.terminate).toHaveBeenCalledOnce();
    expect(requestFor(current).source.dims).toEqual([9, 9, 6]);
    const request = requestFor(current).request;
    expect(request.foreground).not.toEqual(oldRequest.foreground);
    old.respond({ type: 'done', id: request.id, result: result([0]) });
    completeForeground(current, request, 486);
    await expect(moved).resolves.toMatchObject({ indices: input.foreground, bounds: input.bounds });
  });

  it('snapshots source geometry and explicit bounds before an asynchronous result', async () => {
    const input = croppedInput();
    const expected = await segmentSeededVolume({ ...input, bounds: structuredClone(input.bounds) });
    const pending = runner.run(input);
    const worker = MockWorker.instances[0]!;
    const { source, request } = requestFor(worker);
    input.dims[0] = 99;
    input.bounds!.min.x = 99;
    const localResult = await segmentSeededVolume({ ...source, ...request });
    worker.respond({ type: 'done', id: request.id, result: localResult });
    await expect(pending).resolves.toEqual(expected);
  });

  it.each([
    { change: { dims: [2, 3, 1] }, message: /geometry/ },
    { change: { voxelSizeMm: [1, 0, 1] }, message: /geometry/ },
    { change: { observedSupport: new Uint8Array(3) }, message: /geometry/ },
    { change: { foreground: new Uint32Array() }, message: /inside/ },
    { change: { foreground: Uint32Array.of(99) }, message: /acquired/ },
    { change: { observedSupport: Uint8Array.of(0, 1, 1, 1) }, message: /acquired/ },
    { change: { bounds: { min: { x: 0, y: 0, z: 0 }, max: { x: 9, y: 1, z: 0 } } }, message: /outside/ },
    { change: { bounds: { min: { x: 0, y: 0, z: 0 }, max: { x: 0, y: 1, z: 0 } } }, message: /every explicit mark/ },
  ])('rejects invalid $change before copying a source or starting a worker', async ({ change, message }) => {
    const readSource = vi.spyOn(volume, 'subarray');
    await expect(runner.run({ ...baseOptions, ...change } as SeededVolumeInput)).rejects.toThrow(message);
    expect(readSource).not.toHaveBeenCalled();
    expect(MockWorker.instances).toHaveLength(0);
    expect(runner.residentSourceBytes).toBe(0);
  });

  it.each([false, true])('rejects an oversized mark span before copying (explicit bounds: %s)', async (explicit) => {
    const length = MAX_SEGMENTATION_DOMAIN_VOXELS + 1;
    const input: SeededVolumeInput = {
      volume: new Float32Array(length),
      dims: [length, 1, 1],
      voxelSizeMm: [1, 1, 1],
      foreground: Uint32Array.of(0),
      background: Uint32Array.of(length - 1),
      bounds: explicit ? { min: { x: 0, y: 0, z: 0 }, max: { x: length - 1, y: 0, z: 0 } } : undefined,
    };
    const readSource = vi.spyOn(input.volume, 'subarray');
    await expect(runner.run(input)).rejects.toThrow(/span too much tissue/);
    expect(readSource).not.toHaveBeenCalled();
    expect(MockWorker.instances).toHaveLength(0);
    expect(runner.residentSourceBytes).toBe(0);
  });

  it('initializes a volume once and reuses its worker when optional outside marks are added', async () => {
    const first = runner.run({ ...baseOptions, background: new Uint32Array() });
    const worker = MockWorker.instances[0]!;

    expect(worker.messages.map((message) => message.type)).toEqual(['init', 'run']);
    expect(worker.messages[0]).toMatchObject({ type: 'init', volume });
    expect(worker.messages[1]).toMatchObject({
      type: 'run',
      foreground: Uint32Array.of(0),
      background: new Uint32Array(),
    });

    worker.respond({ type: 'done', id: 1, result: result([0, 1]) });
    await expect(first).resolves.toMatchObject({ count: 2 });

    const second = runner.run({ ...baseOptions, foreground: Uint32Array.of(1) });
    expect(MockWorker.instances).toHaveLength(1);
    expect(worker.messages.map((message) => message.type)).toEqual(['init', 'run', 'run']);
    expect(worker.messages[2]).toMatchObject({ foreground: Uint32Array.of(1), background: Uint32Array.of(3) });

    worker.respond({ type: 'done', id: 2, result: result([0]) });
    await expect(second).resolves.toMatchObject({ count: 1 });
    runner.dispose();
    expect(worker.terminate).toHaveBeenCalledOnce();
  });

  it('sends acquired support with the volume and replaces the worker when support ownership changes', async () => {
    const firstSupport = new Uint8Array([1, 0, 1, 1]);
    const first = runner.run({ ...baseOptions, observedSupport: firstSupport });
    const firstWorker = MockWorker.instances[0]!;
    expect(firstWorker.messages[0]).toMatchObject({ type: 'init', volume, observedSupport: firstSupport });

    firstWorker.respond({ type: 'done', id: 1, result: result([0]) });
    await expect(first).resolves.toMatchObject({ count: 1 });

    const secondSupport = new Uint8Array([1, 1, 0, 1]);
    const second = runner.run({ ...baseOptions, observedSupport: secondSupport });
    expect(firstWorker.terminate).toHaveBeenCalledOnce();
    expect(MockWorker.instances).toHaveLength(2);
    const replacement = MockWorker.instances[1]!;
    expect(replacement.messages[0]).toMatchObject({ observedSupport: secondSupport });
    replacement.respond({ type: 'done', id: 2, result: result([0, 1]) });
    await expect(second).resolves.toMatchObject({ count: 2 });
  });

  it.each(['cancel', 'abort', 'supersede'] as const)(
    'terminates active work on %s without a cooperative reply, preserving inputs and lazy idle reuse',
    async (action) => {
      vi.useFakeTimers();
      const input = { ...baseOptions, observedSupport: new Uint8Array(4).fill(1) };
      const before = {
        volume: input.volume.slice(),
        support: input.observedSupport.slice(),
        foreground: input.foreground.slice(),
        background: input.background.slice(),
      };
      const controller = new AbortController();
      const first = runner.run(input, { signal: controller.signal });
      const rejected = expect(first).rejects.toMatchObject({ name: 'AbortError' });
      const old = MockWorker.instances[0]!;
      // This worker never replies, and cannot even receive a cooperative cancel.
      const post = vi.spyOn(old, 'postMessage').mockImplementation(() => {
        throw new Error('Worker is busy');
      });
      let retry: ReturnType<SeededVolumeWorker['run']> | undefined;
      if (action === 'cancel') runner.cancel();
      else if (action === 'abort') controller.abort();
      else retry = runner.run(input);
      await rejected;
      expect(old.terminate).toHaveBeenCalledOnce();
      expect(post).not.toHaveBeenCalled();
      expect(vi.getTimerCount()).toBe(action === 'supersede' ? 1 : 0);
      if (!retry) {
        expect(runner.residentSourceBytes).toBe(0);
        expect(MockWorker.instances).toHaveLength(1);
        retry = runner.run(input);
      }
      const current = MockWorker.instances[1]!;
      expect(MockWorker.instances).toHaveLength(2);
      expect(current.messages.map((message) => message.type)).toEqual(['init', 'run']);
      expect(current.terminate).not.toHaveBeenCalled();
      expect(runner.residentSourceBytes).toBe(20);
      // A previous request's signal must not cancel its replacement.
      controller.abort();
      expect(current.terminate).not.toHaveBeenCalled();
      const request = requestFor(current).request;
      current.respond({ type: 'done', id: request.id, result: result([0, 1]) });
      await expect(retry).resolves.toMatchObject({ indices: Uint32Array.of(0, 1) });
      expect(vi.getTimerCount()).toBe(0);
      runner.cancel();
      expect(current.terminate).not.toHaveBeenCalled();
      expect(runner.residentSourceBytes).toBe(20);
      expect(input.volume).toEqual(before.volume);
      expect(input.observedSupport).toEqual(before.support);
      expect(input.foreground).toEqual(before.foreground);
      expect(input.background).toEqual(before.background);
    },
  );

  it('ignores late canceled-worker results and stale ids while forwarding current progress', async () => {
    const signal = new AbortController();
    const first = runner.run(baseOptions, { signal: signal.signal });
    const worker = MockWorker.instances[0]!;

    signal.abort();
    await expect(first).rejects.toMatchObject({ name: 'AbortError' });
    expect(worker.terminate).toHaveBeenCalledOnce();

    const onProgress = vi.fn();
    const second = runner.run(baseOptions, { onProgress });
    const current = MockWorker.instances[1]!;
    worker.respond({ type: 'done', id: 1, result: result([0, 1, 2]) });
    worker.respond({ type: 'progress', id: 2, processed: 2, total: 4 });
    worker.respond({ type: 'done', id: 2, result: result([0, 1, 2]) });
    current.respond({ type: 'progress', id: 1, processed: 4, total: 4 });
    expect(onProgress).not.toHaveBeenCalled();
    current.respond({ type: 'progress', id: 2, processed: 2, total: 4 });
    expect(onProgress).toHaveBeenCalledWith(2, 4);

    current.respond({ type: 'done', id: 2, result: result([0]) });
    await expect(second).resolves.toMatchObject({ count: 1 });
  });

  it('terminates and rejects outstanding work when a reconstructed volume is replaced', async () => {
    const first = runner.run(baseOptions);
    const oldWorker = MockWorker.instances[0]!;
    const replacement = new Float32Array([0.4, 0.3, 0.2, 0.1]);
    const second = runner.run({ ...baseOptions, volume: replacement });

    await expect(first).rejects.toMatchObject({ name: 'AbortError' });
    expect(oldWorker.terminate).toHaveBeenCalledOnce();
    expect(MockWorker.instances).toHaveLength(2);

    const newWorker = MockWorker.instances[1]!;
    newWorker.respond({ type: 'done', id: 2, result: result([3]) });
    await expect(second).resolves.toMatchObject({ count: 1 });
  });

  it('fails closed when workers are unavailable instead of blocking the UI thread', async () => {
    vi.stubGlobal('Worker', undefined);
    await expect(runner.run(baseOptions)).rejects.toThrow(/browser worker support/i);
  });

  it('reinitializes for physical geometry changes even when the source buffer is unchanged', async () => {
    const first = runner.run(baseOptions);
    MockWorker.instances[0]!.respond({ type: 'done', id: 1, result: result([0]) });
    await first;
    const next = runner.run({ ...baseOptions, voxelSizeMm: [1, 1, 3] });
    expect(MockWorker.instances[0]!.terminate).toHaveBeenCalledOnce();
    const current = MockWorker.instances[1]!;
    expect(current.messages[0]).toMatchObject({ voxelSizeMm: [1, 1, 3] });
    current.respond({ type: 'done', id: 2, result: result([0]) });
    await next;
  });

  it('ignores queued errors from an old worker after a replacement has started', async () => {
    const first = runner.run(baseOptions);
    const rejected = expect(first).rejects.toMatchObject({ name: 'AbortError' });
    const old = MockWorker.instances[0]!;
    const second = runner.run({ ...baseOptions, volume: volume.slice() });
    await rejected;
    old.onerror?.({} as ErrorEvent);
    old.onmessageerror?.();
    const current = MockWorker.instances[1]!;
    expect(current.terminate).not.toHaveBeenCalled();
    current.respond({ type: 'done', id: 2, result: result([1]) });
    await expect(second).resolves.toMatchObject({ indices: Uint32Array.of(1) });
  });

  it('bounds a hung worker and allows retry with a fresh owned source', async () => {
    vi.useFakeTimers();
    const first = runner.run(baseOptions);
    const rejected = expect(first).rejects.toThrow(/took too long/);
    await vi.advanceTimersByTimeAsync(30000);
    await rejected;
    expect(MockWorker.instances[0]!.terminate).toHaveBeenCalledOnce();
    const next = runner.run(baseOptions);
    MockWorker.instances[1]!.respond({ type: 'done', id: 2, result: result([0]) });
    await next;
    runner.dispose();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('settles cancellation even if the worker can no longer receive messages', async () => {
    const signal = new AbortController();
    const pending = runner.run(baseOptions, { signal: signal.signal });
    const rejected = expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    const worker = MockWorker.instances[0]!;
    vi.spyOn(worker, 'postMessage').mockImplementation(() => {
      throw new Error('closed');
    });
    signal.abort();
    await rejected;
    expect(worker.terminate).toHaveBeenCalledOnce();
  });

  it.each(['onerror', 'onmessageerror'] as const)('rejects and releases the current worker on %s', async (event) => {
    const pending = runner.run(baseOptions);
    const rejected = expect(pending).rejects.toThrow(/failed|unreadable/);
    const worker = MockWorker.instances[0]!;
    worker[event]?.({} as ErrorEvent);
    await rejected;
    expect(worker.terminate).toHaveBeenCalledOnce();
  });

  it('does not allocate a worker for an already canceled request', async () => {
    const signal = new AbortController();
    signal.abort();
    await expect(runner.run(baseOptions, { signal: signal.signal })).rejects.toMatchObject({
      name: 'AbortError',
    });
    expect(MockWorker.instances).toHaveLength(0);
  });
});
