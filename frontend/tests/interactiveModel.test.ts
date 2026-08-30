import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { deferred } from './helpers/deferred';
import { createInteractiveTrackingModel } from '../src/utils/segmentation/efficientTam/model';
import { loadTrackingAsset } from '../src/utils/segmentation/efficientTam/loadAsset';
import { loadOrtAll } from '../src/utils/segmentation/onnx/ortLoader';
import { createTrackingController, type TrackingController } from '../src/utils/segmentation/interactiveTracking';

vi.mock('../src/utils/segmentation/efficientTam/loadAsset', () => ({ loadTrackingAsset: vi.fn() }));
vi.mock('../src/utils/segmentation/onnx/ortLoader', () => ({ loadOrtAll: vi.fn() }));
vi.mock('../src/utils/segmentation/interactiveTracking', () => ({ createTrackingController: vi.fn() }));

const create = vi.fn();
const tensor = vi.fn();
const env: { wasm: { numThreads: number; proxy?: boolean } } = { wasm: { numThreads: 8 } };
const controller: TrackingController = { run: vi.fn(), runSnapshot: vi.fn(), dispose: vi.fn() };
const sessions: { run: ReturnType<typeof vi.fn>; release: ReturnType<typeof vi.fn> }[] = [];
const threadCounts: number[] = [];

beforeEach(() => {
  vi.resetAllMocks();
  env.wasm.numThreads = 8;
  delete env.wasm.proxy;
  sessions.length = 0;
  threadCounts.length = 0;
  create.mockImplementation(async () => {
    threadCounts.push(env.wasm.numThreads);
    const session = { run: vi.fn(), release: vi.fn().mockResolvedValue(undefined) };
    sessions.push(session);
    return session;
  });
  vi.mocked(loadOrtAll).mockResolvedValue({ Tensor: tensor, InferenceSession: { create }, env } as never);
  vi.mocked(loadTrackingAsset).mockImplementation(async (name) =>
    name === 'memoryPosition' || name === 'temporalPositions'
      ? new Uint8Array(Float32Array.of(name === 'memoryPosition' ? 1.25 : -2.5).buffer)
      : Uint8Array.of(1, 2, 3),
  );
  vi.mocked(createTrackingController).mockReturnValue(controller);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function fourThreadPlatform() {
  const postMessage = vi.fn(),
    closeFirst = vi.fn(),
    closeSecond = vi.fn();
  vi.stubGlobal('crossOriginIsolated', true);
  vi.stubGlobal('navigator', { hardwareConcurrency: 8 });
  vi.stubGlobal('Worker', class {});
  vi.stubGlobal(
    'MessageChannel',
    class {
      port1 = { postMessage, close: closeFirst };
      port2 = { close: closeSecond };
    },
  );
  vi.spyOn(WebAssembly, 'validate').mockReturnValue(true);
  return { postMessage, closeFirst, closeSecond };
}

describe('interactive model setup ownership', () => {
  it.each([
    ['wasm', ['wasm', 'wasm', 'wasm', 'wasm']],
    ['hybrid', ['webgpu', 'wasm', 'wasm', 'wasm']],
    ['gpu-memory', ['wasm', 'wasm', 'webgpu', 'wasm']],
    ['webgpu', ['webgpu', 'webgpu', 'webgpu', 'webgpu']],
  ] as const)(
    'loads only verified assets and hands owned sessions to the %s controller',
    async (provider, graphProviders) => {
      const onProgress = vi.fn();
      expect(await createInteractiveTrackingModel({ provider, onProgress })).toBe(controller);
      expect(vi.mocked(loadTrackingAsset).mock.calls.map(([name]) => name)).toEqual([
        'encoder',
        'decoder',
        'memoryAttention',
        'memoryEncoder',
        'memoryPosition',
        'temporalPositions',
      ]);
      expect(onProgress.mock.calls.map(([name]) => name)).toEqual([
        'encoder',
        'decoder',
        'memoryAttention',
        'memoryEncoder',
      ]);
      expect(create).toHaveBeenCalledTimes(4);
      for (const [index, [, options]] of create.mock.calls.entries())
        expect(options).toEqual({
          executionProviders: [graphProviders[index]],
          graphOptimizationLevel: 'all',
          preferredOutputLocation: 'cpu',
        });
      expect(createTrackingController).toHaveBeenCalledWith({
        ort: { Tensor: tensor, InferenceSession: { create }, env },
        sessions: {
          encoder: sessions[0],
          decoder: sessions[1],
          memoryAttention: sessions[2],
          memoryEncoder: sessions[3],
        },
        position: Float32Array.of(1.25),
        temporalPosition: Float32Array.of(-2.5),
      });
      expect(sessions.every((session) => session.release.mock.calls.length === 0)).toBe(true);
    },
  );

  it('explicitly configures four diagnostic threads before every graph without changing its provider', async () => {
    const platform = fourThreadPlatform();
    expect(await createInteractiveTrackingModel({ provider: 'wasm', wasmThreads: 4 })).toBe(controller);
    expect(threadCounts).toEqual([4, 4, 4, 4]);
    expect(create.mock.calls.every(([, options]) => options.executionProviders[0] === 'wasm')).toBe(true);
    expect(platform.postMessage).toHaveBeenCalledWith(expect.any(SharedArrayBuffer));
    expect(platform.closeFirst).toHaveBeenCalledOnce();
    expect(platform.closeSecond).toHaveBeenCalledOnce();
    expect(sessions.every((session) => !session.release.mock.calls.length)).toBe(true);
  });

  it.each([4, 8, 16])(
    'automatically chooses exactly four threads on a capable %s-thread device',
    async (hardwareConcurrency) => {
      const platform = fourThreadPlatform();
      vi.stubGlobal('navigator', { hardwareConcurrency });
      expect(await createInteractiveTrackingModel({ provider: 'wasm', wasmThreads: 'auto' })).toBe(controller);
      expect(threadCounts).toEqual([4, 4, 4, 4]);
      expect(create.mock.calls.every(([, options]) => options.executionProviders[0] === 'wasm')).toBe(true);
      expect(platform.postMessage).toHaveBeenCalledOnce();
      expect(platform.closeFirst).toHaveBeenCalledOnce();
      expect(platform.closeSecond).toHaveBeenCalledOnce();
      expect(platform.closeSecond.mock.invocationCallOrder[0]).toBeLessThan(
        vi.mocked(loadOrtAll).mock.invocationCallOrder[0],
      );
    },
  );

  it.each([undefined, 0, 1, 2, 3, 3.5, 4.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])(
    'keeps one thread before session creation when hardware concurrency is %s',
    async (hardwareConcurrency) => {
      const platform = fourThreadPlatform();
      vi.stubGlobal('navigator', { hardwareConcurrency });
      await createInteractiveTrackingModel({ provider: 'wasm', wasmThreads: 'auto' });
      expect(threadCounts).toEqual([1, 1, 1, 1]);
      expect(platform.postMessage).not.toHaveBeenCalled();
    },
  );

  it.each(['isolation', 'shared memory', 'worker', 'channel', 'WASM instructions', 'WASM runtime'])(
    'chooses one thread before session creation when automatic preflight lacks %s',
    async (missing) => {
      fourThreadPlatform();
      if (missing === 'isolation') vi.stubGlobal('crossOriginIsolated', false);
      if (missing === 'shared memory') vi.stubGlobal('SharedArrayBuffer', undefined);
      if (missing === 'worker') vi.stubGlobal('Worker', undefined);
      if (missing === 'channel') vi.stubGlobal('MessageChannel', undefined);
      if (missing === 'WASM instructions') vi.mocked(WebAssembly.validate).mockReturnValue(false);
      if (missing === 'WASM runtime') vi.stubGlobal('WebAssembly', undefined);
      const createSession = create.getMockImplementation()!;
      create.mockImplementation(async (...args) => {
        expect(env.wasm.numThreads).toBe(1);
        return createSession(...args);
      });
      expect(await createInteractiveTrackingModel({ provider: 'wasm', wasmThreads: 'auto' })).toBe(controller);
      expect(create).toHaveBeenCalledTimes(4);
    },
  );

  it.each(['post', 'close'])(
    'closes both probe ports and selects one thread on an automatic %s failure',
    async (at) => {
      const platform = fourThreadPlatform();
      (at === 'post' ? platform.postMessage : platform.closeFirst).mockImplementation(() => {
        throw new Error('Capability probe unavailable');
      });
      const createSession = create.getMockImplementation()!;
      create.mockImplementation(async (...args) => {
        expect(env.wasm.numThreads).toBe(1);
        return createSession(...args);
      });
      await createInteractiveTrackingModel({ provider: 'wasm', wasmThreads: 'auto' });
      expect(platform.closeFirst).toHaveBeenCalledOnce();
      expect(platform.closeSecond).toHaveBeenCalledOnce();
      expect(create).toHaveBeenCalledTimes(4);
    },
  );

  it('selects one thread for an automatic proxy runtime before fetching any graph', async () => {
    fourThreadPlatform();
    env.wasm.proxy = true;
    const loadAsset = vi.mocked(loadTrackingAsset).getMockImplementation()!;
    vi.mocked(loadTrackingAsset).mockImplementation(async (...args) => {
      expect(env.wasm.numThreads).toBe(1);
      return loadAsset(...args);
    });
    await createInteractiveTrackingModel({ provider: 'wasm', wasmThreads: 'auto' });
    expect(create).toHaveBeenCalledTimes(4);
    expect(create.mock.calls.every(([, options]) => options.executionProviders[0] === 'wasm')).toBe(true);
  });

  it.each(['hybrid', 'gpu-memory', 'webgpu'] as const)(
    'does not automatically change diagnostic %s placement threading',
    async (provider) => {
      const platform = fourThreadPlatform();
      const createSession = create.getMockImplementation()!;
      create.mockImplementation(async (...args) => {
        expect(env.wasm.numThreads).toBe(1);
        return createSession(...args);
      });
      await createInteractiveTrackingModel({ provider, wasmThreads: 'auto' });
      expect(create).toHaveBeenCalledTimes(4);
      expect(platform.postMessage).not.toHaveBeenCalled();
    },
  );

  it.each([0, 1, 2, 3])(
    'does not retry with one thread when automatic graph%s initialization fails',
    async (failedGraph) => {
      fourThreadPlatform();
      const failure = new Error('Selected runtime failed');
      const createSession = create.getMockImplementation()!;
      let graph = 0;
      create.mockImplementation(async (...args) => {
        expect(env.wasm.numThreads).toBe(4);
        if (graph++ === failedGraph) throw failure;
        return createSession(...args);
      });
      await expect(createInteractiveTrackingModel({ provider: 'wasm', wasmThreads: 'auto' })).rejects.toBe(failure);
      expect(create).toHaveBeenCalledTimes(failedGraph + 1);
      expect(sessions.every((session) => session.release.mock.calls.length === 1)).toBe(true);
      expect(createTrackingController).not.toHaveBeenCalled();
      expect(env.wasm.numThreads).toBe(4);
    },
  );

  it('does not retry a failed runtime import after automatic capability selection', async () => {
    fourThreadPlatform();
    const failure = new Error('Runtime import unavailable');
    vi.mocked(loadOrtAll).mockRejectedValue(failure);
    await expect(createInteractiveTrackingModel({ provider: 'wasm', wasmThreads: 'auto' })).rejects.toBe(failure);
    expect(loadOrtAll).toHaveBeenCalledOnce();
    expect(create).not.toHaveBeenCalled();
    expect(loadTrackingAsset).not.toHaveBeenCalled();
  });

  it.each([0, 2, 8, NaN])('rejects unsupported diagnostic thread count %s before loading anything', async (count) => {
    await expect(createInteractiveTrackingModel({ provider: 'wasm', wasmThreads: count as 1 })).rejects.toThrow(
      /one or four/,
    );
    expect(loadOrtAll).not.toHaveBeenCalled();
    expect(loadTrackingAsset).not.toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();
  });

  it.each(['isolation', 'shared memory', 'worker', 'channel', 'WASM instructions'])(
    'rejects missing four-thread %s capability before loading anything',
    async (missing) => {
      fourThreadPlatform();
      if (missing === 'isolation') vi.stubGlobal('crossOriginIsolated', false);
      if (missing === 'shared memory') vi.stubGlobal('SharedArrayBuffer', undefined);
      if (missing === 'worker') vi.stubGlobal('Worker', undefined);
      if (missing === 'channel') vi.stubGlobal('MessageChannel', undefined);
      if (missing === 'WASM instructions') vi.mocked(WebAssembly.validate).mockReturnValue(false);
      await expect(createInteractiveTrackingModel({ provider: 'wasm', wasmThreads: 4 })).rejects.toThrow(
        /isolated browser/,
      );
      expect(loadOrtAll).not.toHaveBeenCalled();
      expect(loadTrackingAsset).not.toHaveBeenCalled();
      expect(create).not.toHaveBeenCalled();
    },
  );

  it('closes both capability-probe ports even when shared memory cannot be posted', async () => {
    const platform = fourThreadPlatform();
    const failure = new Error('Shared memory cannot cross this worker boundary');
    platform.postMessage.mockImplementation(() => {
      throw failure;
    });
    await expect(createInteractiveTrackingModel({ provider: 'wasm', wasmThreads: 4 })).rejects.toBe(failure);
    expect(platform.closeFirst).toHaveBeenCalledOnce();
    expect(platform.closeSecond).toHaveBeenCalledOnce();
    expect(loadOrtAll).not.toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();
  });

  it('rejects a proxy runtime before fetching a diagnostic graph', async () => {
    fourThreadPlatform();
    env.wasm.proxy = true;
    await expect(createInteractiveTrackingModel({ provider: 'wasm', wasmThreads: 4 })).rejects.toThrow(/proxy/);
    expect(loadTrackingAsset).not.toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();
  });

  it.each([4, 'auto'] as const)(
    'rejects a silent four-to-one downgrade for %s and releases without fallback',
    async (wasmThreads) => {
      fourThreadPlatform();
      const createSession = create.getMockImplementation()!;
      create.mockImplementation(async (...args) => {
        const session = await createSession(...args);
        env.wasm.numThreads = 1;
        return session;
      });
      await expect(createInteractiveTrackingModel({ provider: 'wasm', wasmThreads })).rejects.toThrow(
        /explicitly requested four/,
      );
      expect(create).toHaveBeenCalledOnce();
      expect(sessions[0]!.release).toHaveBeenCalledOnce();
      expect(createTrackingController).not.toHaveBeenCalled();
    },
  );

  it.each([4, 'auto'] as const)(
    'rejects changed %s configuration before creating the affected graph',
    async (wasmThreads) => {
      fourThreadPlatform();
      const onProgress = vi.fn((graph) => {
        if (graph === 'decoder') env.wasm.numThreads = 1;
      });
      await expect(createInteractiveTrackingModel({ provider: 'wasm', wasmThreads, onProgress })).rejects.toThrow(
        /explicitly requested four/,
      );
      expect(create).toHaveBeenCalledOnce();
      expect(sessions[0]!.release).toHaveBeenCalledOnce();
      expect(createTrackingController).not.toHaveBeenCalled();
    },
  );

  it.each(['wasm', 'hybrid', 'gpu-memory', 'webgpu'] as const)(
    'sets one WASM thread before any %s graph initializes in the dedicated runtime',
    async (provider) => {
      await createInteractiveTrackingModel({ provider });
      expect(threadCounts).toEqual([1, 1, 1, 1]);
      expect(env.wasm.numThreads).toBe(1);
    },
  );

  it.each([
    ['hybrid', 0],
    ['hybrid', 1],
    ['hybrid', 2],
    ['hybrid', 3],
    ['gpu-memory', 0],
    ['gpu-memory', 1],
    ['gpu-memory', 2],
    ['gpu-memory', 3],
  ] as const)(
    'never falls back when %s graph %s fails and releases all preceding sessions',
    async (provider, failedGraph) => {
      const failure = new Error('Explicit graph provider failed');
      let graph = 0;
      create.mockImplementation(async () => {
        if (graph++ === failedGraph) throw failure;
        const session = { run: vi.fn(), release: vi.fn().mockResolvedValue(undefined) };
        sessions.push(session);
        return session;
      });
      await expect(createInteractiveTrackingModel({ provider })).rejects.toBe(failure);
      expect(create).toHaveBeenCalledTimes(failedGraph + 1);
      expect(sessions.every((session) => session.release.mock.calls.length === 1)).toBe(true);
      expect(createTrackingController).not.toHaveBeenCalled();
    },
  );

  it('rejects unknown runtime policies before loading model assets or creating sessions', async () => {
    await expect(createInteractiveTrackingModel({ provider: 'automatic' as 'wasm' })).rejects.toThrow(/explicit/);
    expect(loadOrtAll).not.toHaveBeenCalled();
    expect(loadTrackingAsset).not.toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();
  });

  it('does not overlap graph creation or retain the next downloaded graph while the prior session initializes', async () => {
    const pending = deferred<{ run: ReturnType<typeof vi.fn>; release: ReturnType<typeof vi.fn> }>();
    create.mockImplementationOnce(() => pending.promise);
    const promise = createInteractiveTrackingModel({ provider: 'wasm' });
    await vi.waitFor(() => expect(create).toHaveBeenCalledOnce());
    expect(loadTrackingAsset).toHaveBeenCalledOnce();
    pending.resolve({ run: vi.fn(), release: vi.fn().mockResolvedValue(undefined) });
    await promise;
    expect(create).toHaveBeenCalledTimes(4);
  });

  it.each([1, 4, 'auto'] as const)(
    'waits for uncancelable %s initialization, releases its result and creates no replacement',
    async (wasmThreads) => {
      fourThreadPlatform();
      const pending = deferred<{ run: ReturnType<typeof vi.fn>; release: ReturnType<typeof vi.fn> }>();
      create.mockImplementationOnce(() => pending.promise);
      const abort = new AbortController();
      const promise = createInteractiveTrackingModel({ provider: 'wasm', wasmThreads, signal: abort.signal });
      await vi.waitFor(() => expect(create).toHaveBeenCalledOnce());
      abort.abort();
      const session = { run: vi.fn(), release: vi.fn().mockResolvedValue(undefined) };
      pending.resolve(session);
      await expect(promise).rejects.toMatchObject({ name: 'AbortError' });
      expect(session.release).toHaveBeenCalledOnce();
      expect(create).toHaveBeenCalledOnce();
      expect(createTrackingController).not.toHaveBeenCalled();
    },
  );

  it('releases preceding sessions when a later graph fails and preserves the original setup error', async () => {
    const failure = new Error('Memory graph unavailable');
    create
      .mockImplementationOnce(async () => {
        const session = { run: vi.fn(), release: vi.fn().mockRejectedValue(new Error('Release failure')) };
        sessions.push(session);
        return session;
      })
      .mockRejectedValueOnce(failure);
    await expect(createInteractiveTrackingModel({ provider: 'wasm' })).rejects.toBe(failure);
    expect(sessions[0]!.release).toHaveBeenCalledOnce();
    expect(createTrackingController).not.toHaveBeenCalled();
  });

  it('releases all sessions when a constant fails verification without invoking the controller', async () => {
    vi.mocked(loadTrackingAsset).mockImplementation(async (name) => {
      if (name === 'memoryPosition') throw new Error('Constant SHA mismatch');
      return Uint8Array.of(1);
    });
    await expect(createInteractiveTrackingModel({ provider: 'wasm' })).rejects.toThrow(/SHA mismatch/);
    expect(sessions).toHaveLength(4);
    expect(sessions.every((session) => session.release.mock.calls.length === 1)).toBe(true);
    expect(createTrackingController).not.toHaveBeenCalled();
  });

  it('aborts before importing a runtime or fetching model bytes', async () => {
    const abort = new AbortController();
    abort.abort();
    await expect(createInteractiveTrackingModel({ provider: 'wasm', signal: abort.signal })).rejects.toMatchObject({
      name: 'AbortError',
    });
    expect(loadOrtAll).not.toHaveBeenCalled();
    expect(loadTrackingAsset).not.toHaveBeenCalled();
  });
});
