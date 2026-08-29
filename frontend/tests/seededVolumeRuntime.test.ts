import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SeededVolumeHooks, SeededVolumeInput, SeededVolumeResult } from '../src/utils/segmentation/seededVolume';
import type { SeededWorkerRequest, SeededWorkerResponse } from '../src/utils/segmentation/seededVolumeWorker';

const { segment } = vi.hoisted(() => ({ segment: vi.fn() }));
vi.mock('../src/utils/segmentation/seededVolume', () => ({ segmentSeededVolume: segment }));

const source = {
  type: 'init',
  volume: Float32Array.of(0.1, 0.5, 0.9),
  observedSupport: Uint8Array.of(1, 1, 1),
  dims: [3, 1, 1],
  voxelSizeMm: [1, 1, 1],
} satisfies SeededWorkerRequest;
const result: SeededVolumeResult = {
  indices: Uint32Array.of(1),
  bounds: { min: { x: 0, y: 0, z: 0 }, max: { x: 2, y: 0, z: 0 } },
  boundaryCount: 1,
  domainVoxels: 3,
};
const post = vi.fn<(message: SeededWorkerResponse, transfer?: Transferable[]) => void>();
const pending: Array<{
  input: SeededVolumeInput;
  hooks: SeededVolumeHooks;
  resolve: (result: SeededVolumeResult) => void;
}> = [];
let now = 0;

function send(data: SeededWorkerRequest) {
  const scope = globalThis as unknown as { onmessage: (event: MessageEvent<SeededWorkerRequest>) => void };
  scope.onmessage({ data } as MessageEvent<SeededWorkerRequest>);
}
function run(id: number) {
  send({ type: 'run', id, foreground: Uint32Array.of(1), background: new Uint32Array() });
  return pending.at(-1)!;
}

beforeEach(async () => {
  vi.resetModules();
  vi.useFakeTimers();
  now = 0;
  vi.spyOn(performance, 'now').mockImplementation(() => now);
  vi.stubGlobal('onmessage', null);
  vi.stubGlobal('postMessage', post);
  post.mockClear();
  pending.length = 0;
  segment
    .mockReset()
    .mockImplementation(
      (input: SeededVolumeInput, hooks: SeededVolumeHooks) =>
        new Promise<SeededVolumeResult>((resolve) => pending.push({ input, hooks, resolve })),
    );
  await import('../src/utils/segmentation/seededVolume.worker');
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('production selection worker scheduling', () => {
  it('yields by elapsed compute time, not once per cheap scan chunk', async () => {
    send(source);
    const { hooks } = run(1);
    for (let chunk = 0; chunk < 30; chunk++) await hooks.yieldFn!();
    expect(vi.getTimerCount()).toBe(0);
    now = 9;
    const yielding = hooks.yieldFn!();
    expect(vi.getTimerCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(0);
    await yielding;
    now = 12;
    await hooks.yieldFn!();
    expect(vi.getTimerCount()).toBe(0);
    now = 17;
    const nextYield = hooks.yieldFn!();
    expect(vi.getTimerCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(0);
    await nextYield;
  });

  it('bounds intermediate UI progress while always forwarding the final update', () => {
    send(source);
    const { hooks } = run(7);
    for (let chunk = 0; chunk < 1000; chunk++) {
      now = chunk / 10;
      hooks.onProgress!(chunk, 1000);
    }
    expect(post.mock.calls.map(([message]) => message)).toEqual([
      { type: 'progress', id: 7, processed: 0, total: 1000 },
      { type: 'progress', id: 7, processed: 500, total: 1000 },
    ]);
    hooks.onProgress!(1000, 1000);
    expect(post.mock.lastCall?.[0]).toEqual({ type: 'progress', id: 7, processed: 1000, total: 1000 });
  });

  it('does not publish canceled or superseded results and transfers only the current output', async () => {
    send(source);
    const first = run(1);
    const second = run(2);
    expect(first.hooks.signal?.aborted).toBe(true);
    first.hooks.onProgress!(1, 1);
    first.resolve(result);
    await Promise.resolve();
    expect(post).not.toHaveBeenCalled();
    send({ type: 'cancel', id: 2 });
    expect(second.hooks.signal?.aborted).toBe(true);
    second.resolve(result);
    await Promise.resolve();
    expect(post).not.toHaveBeenCalled();
    const third = run(3);
    third.resolve(result);
    await Promise.resolve();
    expect(post).toHaveBeenCalledWith({ type: 'done', id: 3, result }, [result.indices.buffer]);
    expect(third.input.volume).toBe(source.volume);
    expect(third.hooks.signal?.aborted).toBe(false);
  });

  it('rejects a request without a source and aborts old work when its source is replaced', () => {
    run(1);
    expect(segment).not.toHaveBeenCalled();
    expect(post.mock.lastCall?.[0]).toMatchObject({ type: 'error', id: 1 });
    send(source);
    const first = run(2);
    send({ ...source, volume: source.volume.slice() });
    expect(first.hooks.signal?.aborted).toBe(true);
  });
});
