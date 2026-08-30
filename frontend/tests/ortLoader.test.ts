import { afterEach, describe, expect, it, vi } from 'vitest';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.resetModules();
  vi.doUnmock('onnxruntime-web/all');
});

describe('shared ONNX runtime loading', () => {
  it.each([
    [true, 32, 8],
    [true, 4, 4],
    [true, 0, 1],
    [false, 32, 1],
  ])('uses isolation=%s and %s cores to configure %s WASM threads', async (isolated, cores, expected) => {
    vi.resetModules();
    vi.stubEnv('DEV', true);
    vi.stubGlobal('crossOriginIsolated', isolated);
    vi.stubGlobal('navigator', { hardwareConcurrency: cores });
    const runtime = { env: { wasm: { numThreads: 0 } } };
    const load = vi.fn(() => ({ default: runtime }));
    vi.doMock('onnxruntime-web/all', load);

    const { loadOrtAll } = await import('../src/utils/segmentation/onnx/ortLoader');
    const [first, concurrent] = await Promise.all([loadOrtAll(), loadOrtAll()]);
    expect(first).toBe(runtime);
    expect(concurrent).toBe(first);
    expect(await loadOrtAll()).toBe(first);
    expect(load).toHaveBeenCalledTimes(1);
    expect(runtime.env.wasm.numThreads).toBe(expected);
  });
});
