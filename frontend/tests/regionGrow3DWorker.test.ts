import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  RegionGrow3DWorkerController,
  type RegionGrow3DWorkerRequest,
  type RegionGrow3DWorkerResponse,
} from '../src/utils/segmentation/regionGrow3DWorker';

class MockWorker {
  static instances: MockWorker[] = [];

  onmessage: ((event: MessageEvent<RegionGrow3DWorkerResponse>) => void) | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;
  messages: RegionGrow3DWorkerRequest[] = [];
  terminate = vi.fn();

  constructor() {
    MockWorker.instances.push(this);
  }

  postMessage(message: RegionGrow3DWorkerRequest): void {
    this.messages.push(message);
  }

  respond(message: RegionGrow3DWorkerResponse): void {
    this.onmessage?.({ data: message } as MessageEvent<RegionGrow3DWorkerResponse>);
  }
}

const volume = new Float32Array([0.1, 0.2, 0.3, 0.4]);
const baseOptions = {
  volume,
  dims: [2, 2, 1] as [number, number, number],
  seed: { x: 0, y: 0, z: 0 },
  min: 0,
  max: 1,
  roi: {
    mode: 'guide' as const,
    min: { x: 0, y: 0, z: 0 },
    max: { x: 1, y: 1, z: 0 },
  },
  maxVoxels: 4,
  yieldEvery: 2,
};

function result(indices: number[]) {
  return {
    indices: new Uint32Array(indices),
    count: indices.length,
    seedValue: 0.1,
    hitMaxVoxels: false,
  };
}

beforeEach(() => {
  MockWorker.instances = [];
  vi.stubGlobal('Worker', MockWorker);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('RegionGrow3DWorkerController', () => {
  it('initializes a volume once and reuses its worker for threshold previews', async () => {
    const runner = new RegionGrow3DWorkerController();
    const first = runner.run(baseOptions);
    const worker = MockWorker.instances[0]!;

    expect(worker.messages.map((message) => message.type)).toEqual(['init', 'run']);
    expect(worker.messages[0]).toMatchObject({ type: 'init', volume });

    worker.respond({ type: 'done', runId: 1, result: result([0, 1]) });
    await expect(first).resolves.toMatchObject({ count: 2 });

    const second = runner.run({ ...baseOptions, max: 0.25 });
    expect(MockWorker.instances).toHaveLength(1);
    expect(worker.messages.map((message) => message.type)).toEqual(['init', 'run', 'run']);

    worker.respond({ type: 'done', runId: 2, result: result([0]) });
    await expect(second).resolves.toMatchObject({ count: 1 });
    runner.dispose();
    expect(worker.terminate).toHaveBeenCalledOnce();
  });

  it('cancels stale runs and ignores their late results while forwarding current progress', async () => {
    const runner = new RegionGrow3DWorkerController();
    const signal = new AbortController();
    const first = runner.run({ ...baseOptions, signal: signal.signal });
    const worker = MockWorker.instances[0]!;

    signal.abort();
    await expect(first).rejects.toMatchObject({ name: 'AbortError' });
    expect(worker.messages.at(-1)).toEqual({ type: 'cancel', runId: 1 });

    const onProgress = vi.fn();
    const second = runner.run({ ...baseOptions, onProgress });
    worker.respond({ type: 'done', runId: 1, result: result([0, 1, 2]) });
    worker.respond({ type: 'progress', runId: 2, progress: { processed: 2, queued: 2 } });
    expect(onProgress).toHaveBeenCalledWith({ processed: 2, queued: 2 });

    worker.respond({ type: 'done', runId: 2, result: result([0]) });
    await expect(second).resolves.toMatchObject({ count: 1 });
    runner.dispose();
  });

  it('terminates and rejects outstanding work when a reconstructed volume is replaced', async () => {
    const runner = new RegionGrow3DWorkerController();
    const first = runner.run(baseOptions);
    const oldWorker = MockWorker.instances[0]!;
    const replacement = new Float32Array([0.4, 0.3, 0.2, 0.1]);
    const second = runner.run({ ...baseOptions, volume: replacement });

    await expect(first).rejects.toMatchObject({ name: 'AbortError' });
    expect(oldWorker.terminate).toHaveBeenCalledOnce();
    expect(MockWorker.instances).toHaveLength(2);

    const newWorker = MockWorker.instances[1]!;
    newWorker.respond({ type: 'done', runId: 2, result: result([3]) });
    await expect(second).resolves.toMatchObject({ count: 1 });
    runner.dispose();
  });

  it('fails closed when workers are unavailable instead of blocking the UI thread', async () => {
    vi.stubGlobal('Worker', undefined);
    const runner = new RegionGrow3DWorkerController();
    await expect(runner.run(baseOptions)).rejects.toThrow('requires browser worker support');
  });
});
