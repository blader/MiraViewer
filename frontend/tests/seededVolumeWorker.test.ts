import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  SeededVolumeWorker,
  type SeededWorkerRequest,
  type SeededWorkerResponse,
} from '../src/utils/segmentation/seededVolumeWorker';

class MockWorker {
  static instances: MockWorker[] = [];

  onmessage: ((event: MessageEvent<SeededWorkerResponse>) => void) | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;
  onmessageerror: (() => void) | null = null;
  messages: SeededWorkerRequest[] = [];
  terminate = vi.fn();

  constructor() {
    MockWorker.instances.push(this);
  }

  postMessage(message: SeededWorkerRequest): void {
    this.messages.push(message);
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

let runner: SeededVolumeWorker;
beforeEach(() => {
  MockWorker.instances = [];
  vi.stubGlobal('Worker', MockWorker);
  runner = new SeededVolumeWorker();
});

afterEach(() => {
  runner.dispose();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('SeededVolumeWorker', () => {
  it('reports full retained backing buffers once and releases accounting only when the worker is disposed', async () => {
    const buffer = new ArrayBuffer(32);
    const source = new Float32Array(buffer, 4, 4);
    const support = new Uint8Array(buffer, 0, 4).fill(1);
    expect(runner.residentSourceBytes).toBe(0);
    const first = runner.run({ ...baseOptions, volume: source, observedSupport: support });
    expect(runner.residentSourceBytes).toBe(32);
    MockWorker.instances[0]!.respond({ type: 'done', id: 1, result: result([0]) });
    await first;
    expect(runner.residentSourceBytes).toBe(32);
    const second = runner.run({ ...baseOptions, volume: source, observedSupport: new Uint8Array(4).fill(1) });
    expect(runner.residentSourceBytes).toBe(36);
    runner.cancel();
    await expect(second).rejects.toMatchObject({ name: 'AbortError' });
    expect(runner.residentSourceBytes).toBe(36);
    runner.dispose();
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

  it('cancels stale runs and ignores their late results while forwarding current progress', async () => {
    const signal = new AbortController();
    const first = runner.run(baseOptions, { signal: signal.signal });
    const worker = MockWorker.instances[0]!;

    signal.abort();
    await expect(first).rejects.toMatchObject({ name: 'AbortError' });
    expect(worker.messages.at(-1)).toEqual({ type: 'cancel', id: 1 });

    const onProgress = vi.fn();
    const second = runner.run(baseOptions, { onProgress });
    worker.respond({ type: 'done', id: 1, result: result([0, 1, 2]) });
    worker.respond({ type: 'progress', id: 2, processed: 2, total: 4 });
    expect(onProgress).toHaveBeenCalledWith(2, 4);

    worker.respond({ type: 'done', id: 2, result: result([0]) });
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
