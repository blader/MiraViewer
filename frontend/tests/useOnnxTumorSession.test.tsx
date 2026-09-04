import { webcrypto } from 'node:crypto';
import cornerstone from 'cornerstone-core';
import { Blob as NodeBlob } from 'node:buffer';
import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as modelManifest from '../src/utils/segmentation/onnx/modelManifest';
import type * as ModelCache from '../src/utils/segmentation/onnx/modelCache';
import type { SvrVolume } from '../src/types/svr';
import { deferred } from './helpers/deferred';

const { cache, createSession, enabledImages } = vi.hoisted(() => ({
  cache: new Map<string, Blob>(),
  createSession: vi.fn(async () => ({ release: vi.fn(async () => undefined) })),
  enabledImages: [] as { image: { getPixelData: () => Uint8Array; data?: { byteArray: Uint8Array } } }[],
}));

vi.mock('../src/utils/segmentation/onnx/modelCache', () => ({
  getModelBlob: vi.fn(async (key: string) => cache.get(key) ?? null),
  getModelRecord: vi.fn(async (key: string) => {
    const blob = cache.get(key);
    return blob ? { key, blob, savedAtMs: 1 } : null;
  }),
  putModelBlobs: vi.fn(
    async (models: ReadonlyArray<{ key: string; blob: Blob }>, options: { signal?: AbortSignal } = {}) => {
      options.signal?.throwIfAborted();
      for (const { key, blob } of models) cache.set(key, blob);
    },
  ),
  deleteModelBlobs: vi.fn(async (keys: readonly string[], options: { signal?: AbortSignal } = {}) => {
    options.signal?.throwIfAborted();
    for (const key of keys) cache.delete(key);
  }),
}));

vi.mock('../src/utils/segmentation/onnx/ortLoader', () => ({
  createOrtSessionFromModelBlob: createSession,
}));

vi.mock('../src/utils/segmentation/onnx/tumorSegmentation', () => ({
  runTumorSegmentationOnnx: vi.fn(),
}));

vi.mock('cornerstone-core', () => ({
  default: {
    imageCache: {
      cachedImages: [],
      getCacheInfo: () => ({ maximumSizeInBytes: 256 * 1024 * 1024, cacheSizeInBytes: 0 }),
    },
    getEnabledElements: () => enabledImages,
  },
}));

import { useOnnxTumorSession } from '../src/hooks/useOnnxTumorSession';
import { runTumorSegmentationOnnx } from '../src/utils/segmentation/onnx/tumorSegmentation';
import { deleteModelBlobs, putModelBlobs } from '../src/utils/segmentation/onnx/modelCache';
import { executeCustomModel } from '../src/utils/segmentation/onnx/customModel.worker';
import {
  runCustomModelWorker,
  CUSTOM_MODEL_INIT_TIMEOUT_MS,
  CUSTOM_MODEL_RUN_TIMEOUT_MS,
  customModelRuntimeBytes,
  customModelBudgetBytes,
  type CustomModelRequest,
  type CustomModelResponse,
} from '../src/utils/segmentation/onnx/customModelWorker';
import { SVR_MEMORY_BUDGET_BYTES } from '../src/utils/svr/svrMemoryPlan';

const MODEL_KEY = 'brats-tumor-v1';
const MANIFEST_KEY = `${MODEL_KEY}:manifest`;
const syntheticVolume = {
  data: new Float32Array([0.5]),
  dims: [1, 1, 1] as [number, number, number],
  voxelSizeMm: [1, 1, 1] as [number, number, number],
  originMm: [0, 0, 0] as [number, number, number],
  boundsMm: {
    min: [0, 0, 0] as [number, number, number],
    max: [1, 1, 1] as [number, number, number],
  },
};

async function files(
  wrongHash = false,
  spatialFrame?: 'patient-lps' | 'source-grid',
  version = 0,
  size = 7,
): Promise<[File, File]> {
  const bytes = new Uint8Array(size);
  bytes.set([4, 8, 15, 16, 23, 42, version]);
  const model = new File([bytes], `synthetic-${version}.onnx`);
  const digest = await webcrypto.subtle.digest('SHA-256', await model.arrayBuffer());
  const hash = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
  const manifest = new File(
    [
      JSON.stringify({
        ...modelManifest.TUMOR_MODEL_MANIFEST_EXAMPLE,
        input: { ...modelManifest.TUMOR_MODEL_MANIFEST_EXAMPLE.input, ...(spatialFrame ? { spatialFrame } : {}) },
        modelSha256: wrongHash ? '0'.repeat(64) : hash,
      }),
    ],
    'synthetic.json',
    { type: 'application/json' },
  );
  return [model, manifest];
}

function deferVerification(...models: Blob[]) {
  const verify = modelManifest.verifyTumorModelManifest;
  const gates = models.map(() => deferred<void>());
  const calls = vi.spyOn(modelManifest, 'verifyTumorModelManifest').mockImplementation(async (model, manifest) => {
    const index = models.indexOf(model);
    if (index >= 0) await gates[index]!.promise;
    return verify(model, manifest);
  });
  return {
    calls,
    async finish(index = 0) {
      gates[index]!.resolve();
      const call = calls.mock.calls.findIndex(([model]) => model === models[index]);
      await (calls.mock.results[call]!.value as Promise<unknown>).catch(() => undefined);
    },
  };
}

class WorkerHarness {
  static instances: WorkerHarness[] = [];
  onmessage: ((event: MessageEvent<CustomModelResponse>) => void) | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;
  onmessageerror: (() => void) | null = null;
  terminated = false;
  request?: CustomModelRequest;
  terminate = vi.fn(() => {
    this.terminated = true;
  });
  constructor() {
    WorkerHarness.instances.push(this);
  }
  postMessage(request: CustomModelRequest) {
    this.request = request;
    void executeCustomModel(request, (data) => {
      if (!this.terminated) this.onmessage?.({ data } as MessageEvent<CustomModelResponse>);
    });
  }
}

beforeEach(() => {
  cache.clear();
  enabledImages.length = 0;
  vi.clearAllMocks();
  vi.stubGlobal('crypto', webcrypto);
  WorkerHarness.instances = [];
  vi.stubGlobal('Worker', WorkerHarness);
  vi.mocked(runTumorSegmentationOnnx).mockImplementation(async ({ dims }) => ({
    labels: new Uint8Array(dims[0] * dims[1] * dims[2]),
    logitsDims: [1, 4, dims[2], dims[1], dims[0]],
  }));
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('useOnnxTumorSession verified model ownership', () => {
  it('retains legacy cached models but blocks initialization and inference without a manifest', async () => {
    const [model] = await files();
    cache.set(MODEL_KEY, model);
    const onLabels = vi.fn();
    const { result } = renderHook(() => useOnnxTumorSession(syntheticVolume, onLabels));

    await waitFor(() => {
      expect(result.current.status.cached).toBe(true);
      expect(result.current.status.verified).toBe(false);
      expect(result.current.status.error).toMatch(/unverified/i);
    });
    expect(cache.get(MODEL_KEY)).toBe(model);

    act(() => result.current.runSegmentation());
    await waitFor(() => expect(result.current.status.error).toMatch(/unverified/i));

    act(() => result.current.runSegmentation());
    await waitFor(() => {
      expect(result.current.status.error).toMatch(/unverified/i);
      expect(result.current.segRunning).toBe(false);
    });
    expect(createSession).not.toHaveBeenCalled();
    expect(onLabels).not.toHaveBeenCalled();
  });

  it('rejects a mismatched upload without caching either invalid artifact', async () => {
    const selected = await files(true);
    const { result } = renderHook(() => useOnnxTumorSession(syntheticVolume, vi.fn()));

    act(() => result.current.handleSelectedFiles(selected));

    await waitFor(() => {
      expect(result.current.status.cached).toBe(false);
      expect(result.current.status.verified).toBe(false);
      expect(result.current.status.error).toMatch(/does not match/i);
    });
    expect(cache.has(MODEL_KEY)).toBe(false);
    expect(cache.has(MANIFEST_KEY)).toBe(false);
    expect(putModelBlobs).not.toHaveBeenCalled();

    act(() => result.current.runSegmentation());
    await waitFor(() => expect(result.current.status.error).toMatch(/no cached/i));
    expect(createSession).not.toHaveBeenCalled();
  });

  it('caches and executes only a cryptographically verified model and manifest pair', async () => {
    const selected = await files();
    const { result } = renderHook(() => useOnnxTumorSession(syntheticVolume, vi.fn()));

    act(() => result.current.handleSelectedFiles(selected));
    await waitFor(() => {
      expect(result.current.status.cached).toBe(true);
      expect(result.current.status.verified).toBe(true);
    });
    expect(cache.has(MODEL_KEY)).toBe(true);
    expect(cache.has(MANIFEST_KEY)).toBe(true);
    expect(putModelBlobs).toHaveBeenCalledExactlyOnceWith(
      [
        { key: MODEL_KEY, blob: selected[0] },
        { key: MANIFEST_KEY, blob: selected[1] },
      ],
      { signal: expect.any(AbortSignal) },
    );

    act(() => result.current.runSegmentation());
    await waitFor(() => expect(result.current.status.loading).toBe(false));
    await waitFor(() => expect(createSession).toHaveBeenCalledOnce());
  });

  it.each(['verification', 'storage', 'missing-manifest'] as const)(
    'preserves the prior verified pair when a replacement fails %s',
    async (failure) => {
      const original = await files();
      const replacement = await files(failure === 'verification', undefined, 1);
      cache.set(MODEL_KEY, original[0]);
      cache.set(MANIFEST_KEY, original[1]);
      const { result } = renderHook(() => useOnnxTumorSession(syntheticVolume, vi.fn()));
      await waitFor(() => expect(result.current.status.verified).toBe(true));
      if (failure === 'storage') vi.mocked(putModelBlobs).mockRejectedValueOnce(new Error('Storage quota exceeded'));

      act(() => result.current.handleSelectedFiles(failure === 'missing-manifest' ? [replacement[0]] : replacement));
      await waitFor(() => {
        expect(result.current.status.loading).toBe(false);
        expect(result.current.status.error).toMatch(
          failure === 'verification' ? /does not match/i : failure === 'storage' ? /quota/i : /unverified/i,
        );
        expect(result.current.status.cached).toBe(true);
        expect(result.current.status.verified).toBe(true);
      });
      expect(cache.get(MODEL_KEY)).toBe(original[0]);
      expect(cache.get(MANIFEST_KEY)).toBe(original[1]);
      act(() => result.current.runSegmentation());
      await waitFor(() => expect(result.current.status.loading).toBe(false));
      expect(createSession).toHaveBeenCalledWith(expect.objectContaining({ model: original[0] }));
    },
  );

  it('recovers prior cache truth when a failed upload supersedes the initial cache verification', async () => {
    const original = await files();
    const replacement = await files(true, undefined, 1);
    cache.set(MODEL_KEY, original[0]);
    cache.set(MANIFEST_KEY, original[1]);
    const delayed = deferVerification(original[0]);
    const { result } = renderHook(() => useOnnxTumorSession(syntheticVolume, vi.fn()));
    await waitFor(() => expect(delayed.calls).toHaveBeenCalledWith(...original));
    act(() => result.current.handleSelectedFiles(replacement));
    await waitFor(() => expect(result.current.status.error).toMatch(/does not match/i));
    expect(result.current.status.loading).toBe(true);
    await act(() => delayed.finish());
    await waitFor(() => expect(result.current.status.loading).toBe(false));
    expect(result.current.status.cached).toBe(true);
    expect(result.current.status.verified).toBe(true);
    expect(result.current.status.error).toMatch(/does not match/i);
    expect(cache.get(MODEL_KEY)).toBe(original[0]);
    expect(cache.get(MANIFEST_KEY)).toBe(original[1]);
  });

  it.each([
    { firstInvalid: false, finishFirst: true },
    { firstInvalid: false, finishFirst: false },
    { firstInvalid: true, finishFirst: true },
    { firstInvalid: true, finishFirst: false },
  ])('only commits the latest upload: %j', async ({ firstInvalid, finishFirst }) => {
    const first = await files(firstInvalid);
    const replacement = await files(false, undefined, 1);
    const delayed = deferVerification(first[0], replacement[0]);
    const { result } = renderHook(() => useOnnxTumorSession(syntheticVolume, vi.fn()));
    act(() => result.current.handleSelectedFiles(first));
    await waitFor(() => expect(delayed.calls).toHaveBeenCalledWith(...first));
    act(() => result.current.handleSelectedFiles(replacement));
    await waitFor(() => expect(delayed.calls).toHaveBeenCalledWith(...replacement));
    if (finishFirst) {
      await act(() => delayed.finish(0));
      expect(cache.size).toBe(0);
      expect(result.current.status.loading).toBe(true);
      expect(result.current.status.error).toBeUndefined();
      expect(result.current.status.message).toContain(replacement[0].name);
    }
    await act(() => delayed.finish(1));
    await waitFor(() => expect(result.current.status.cached && result.current.status.verified).toBe(true));
    if (!finishFirst) await act(() => delayed.finish(0));
    expect(cache.get(MODEL_KEY)).toBe(replacement[0]);
    expect(cache.get(MANIFEST_KEY)).toBe(replacement[1]);
    expect(result.current.status.loading).toBe(false);
    expect(result.current.status.error).toBeUndefined();
    expect(result.current.status.verified).toBe(true);
    expect(putModelBlobs).toHaveBeenCalledOnce();
  });

  it.each(['clear', 'unmount'] as const)(
    'never publishes an upload whose verification finishes after %s',
    async (action) => {
      const selected = await files();
      const delayed = deferVerification(selected[0]);
      const { result, unmount } = renderHook(() => useOnnxTumorSession(syntheticVolume, vi.fn()));
      act(() => result.current.handleSelectedFiles(selected));
      await waitFor(() => expect(delayed.calls).toHaveBeenCalledWith(...selected));
      if (action === 'clear') {
        act(() => result.current.clearModel());
        await waitFor(() => expect(result.current.status.loading).toBe(false));
      } else unmount();
      await act(() => delayed.finish());
      expect(cache.size).toBe(0);
      expect(putModelBlobs).not.toHaveBeenCalled();
      if (action === 'clear') {
        expect(result.current.status.cached).toBe(false);
        expect(result.current.status.verified).toBe(false);
        expect(result.current.status.message).toBe('Cleared cached model');
        expect(result.current.status.error).toBeUndefined();
      }
    },
  );

  it('keeps model upload loading and accepts its verified pair across a volume change', async () => {
    const selected = await files();
    const delayed = deferVerification(selected[0]);
    const { result, rerender } = renderHook(({ volume }) => useOnnxTumorSession(volume, vi.fn()), {
      initialProps: { volume: syntheticVolume },
    });
    act(() => result.current.handleSelectedFiles(selected));
    await waitFor(() => expect(delayed.calls).toHaveBeenCalledWith(...selected));
    rerender({ volume: { ...syntheticVolume, data: Float32Array.of(0.2) } });
    expect(result.current.status.loading).toBe(true);
    expect(result.current.status.message).toContain(selected[0].name);
    expect(cache.size).toBe(0);
    await act(() => delayed.finish());
    await waitFor(() => expect(result.current.status.cached && result.current.status.verified).toBe(true));
    expect(result.current.status.loading).toBe(false);
    expect(cache.get(MODEL_KEY)).toBe(selected[0]);
    expect(cache.get(MANIFEST_KEY)).toBe(selected[1]);
  });

  it.each(['clear', 'unmount'] as const)(
    'aborts an atomic upload waiting on database access after %s',
    async (action) => {
      const selected = await files();
      const write = deferred<void>();
      vi.mocked(putModelBlobs).mockImplementationOnce(async (models, options) => {
        await write.promise;
        options?.signal?.throwIfAborted();
        for (const { key, blob } of models) cache.set(key, blob);
      });
      const { result, unmount } = renderHook(() => useOnnxTumorSession(syntheticVolume, vi.fn()));
      act(() => result.current.handleSelectedFiles(selected));
      await waitFor(() => expect(putModelBlobs).toHaveBeenCalledOnce());
      if (action === 'clear') {
        act(() => result.current.clearModel());
        await waitFor(() => expect(result.current.status.loading).toBe(false));
      } else unmount();
      expect(vi.mocked(putModelBlobs).mock.calls[0]![1]?.signal?.aborted).toBe(true);
      await act(async () => write.resolve());
      expect(cache.size).toBe(0);
      if (action === 'clear') expect(result.current.status.error).toBeUndefined();
    },
  );

  it.each([false, true])('ignores a superseded clear completion (failure=%s)', async (failure) => {
    const selected = await files();
    const clearing = deferred<void>();
    vi.mocked(deleteModelBlobs).mockImplementationOnce(async (keys, options) => {
      await clearing.promise;
      if (failure) throw new Error('Obsolete clear failure');
      options?.signal?.throwIfAborted();
      for (const key of keys) cache.delete(key);
    });
    const { result } = renderHook(() => useOnnxTumorSession(syntheticVolume, vi.fn()));
    act(() => result.current.clearModel());
    act(() => result.current.handleSelectedFiles(selected));
    await waitFor(() => expect(result.current.status.cached && result.current.status.verified).toBe(true));
    expect(vi.mocked(deleteModelBlobs).mock.calls[0]![1]?.signal?.aborted).toBe(true);
    await act(async () => clearing.resolve());
    expect(result.current.status.message).toBe('Verified model and manifest cached');
    expect(result.current.status.error).toBeUndefined();
    expect(cache.get(MODEL_KEY)).toBe(selected[0]);
    expect(cache.get(MANIFEST_KEY)).toBe(selected[1]);
  });

  it('does not let an obsolete worker initialization reset a replacement upload', async () => {
    const original = await files();
    const replacement = await files(false, undefined, 1);
    cache.set(MODEL_KEY, original[0]);
    cache.set(MANIFEST_KEY, original[1]);
    const session = { release: vi.fn(async () => undefined) };
    const initialization = deferred<typeof session>();
    createSession.mockReturnValueOnce(initialization.promise);
    const delayed = deferVerification(replacement[0]);
    const { result } = renderHook(() => useOnnxTumorSession(syntheticVolume, vi.fn()));
    await waitFor(() => expect(result.current.status.verified).toBe(true));
    act(() => result.current.runSegmentation());
    await waitFor(() => expect(createSession).toHaveBeenCalledOnce());
    act(() => result.current.handleSelectedFiles(replacement));
    await waitFor(() => expect(delayed.calls).toHaveBeenCalledWith(...replacement));
    await act(async () => initialization.resolve(session));
    expect(WorkerHarness.instances[0]!.terminate).toHaveBeenCalledOnce();
    expect(result.current.status.loading).toBe(true);
    expect(result.current.status.error).toBeUndefined();
    expect(result.current.status.message).toContain(replacement[0].name);
    await act(() => delayed.finish());
    await waitFor(() => expect(result.current.status.loading).toBe(false));
    expect(cache.get(MODEL_KEY)).toBe(replacement[0]);
  });

  it('removes model-generated lesion labels from every unsupported reconstruction voxel', async () => {
    const selected = await files();
    const supportedVolume = {
      ...syntheticVolume,
      data: new Float32Array([0.5, 0.7, 0.6]),
      observedSupport: new Uint8Array([1, 0, 1]),
      dims: [3, 1, 1] as [number, number, number],
    };
    vi.mocked(runTumorSegmentationOnnx).mockResolvedValueOnce({
      labels: new Uint8Array([1, 2, 4]),
      logitsDims: [1, 4, 1, 1, 3],
    });
    const onLabels = vi.fn();
    const { result } = renderHook(() => useOnnxTumorSession(supportedVolume, onLabels));

    act(() => result.current.handleSelectedFiles(selected));
    await waitFor(() => expect(result.current.status.verified).toBe(true));

    act(() => result.current.runSegmentation());
    await waitFor(() => expect(onLabels).toHaveBeenCalledOnce());
    const labels = onLabels.mock.calls[0]?.[0];
    expect(Array.from(labels.data)).toEqual([1, 0, 4]);
    const modelInput = vi.mocked(runTumorSegmentationOnnx).mock.calls[0]?.[0].volume;
    expect(Array.from(modelInput ?? [])).toEqual([expect.closeTo(0.5, 6), 0, expect.closeTo(0.6, 6)]);
    expect(supportedVolume.data[1]).toBeCloseTo(0.7, 6);
  });

  it('refuses inference when acquired-support evidence is incompatible with the volume', async () => {
    const invalidVolume = { ...syntheticVolume, observedSupport: new Uint8Array([1, 0]) };
    const onLabels = vi.fn();
    const { result } = renderHook(() => useOnnxTumorSession(invalidVolume, onLabels));

    act(() => result.current.runSegmentation());
    await waitFor(() => expect(result.current.status.error).toMatch(/acquired-support.*dimensions/i));
    expect(createSession).not.toHaveBeenCalled();
    expect(onLabels).not.toHaveBeenCalled();
  });

  it('normalizes raw native values for an explicitly compatible model without using display appearance', async () => {
    const selected = await files(false, 'source-grid');
    const native: SvrVolume = {
      ...syntheticVolume,
      data: Float32Array.of(-100, 0, 100, 900),
      dims: [4, 1, 1],
      intensityRange: [-100, 100],
      nativeVoxelSizeMm: [1, 1, 1],
      displayWindow: [0, 10],
      displayInvert: true,
      observedSupport: Uint8Array.of(1, 1, 1, 0),
    };
    const original = native.data.slice();
    vi.mocked(runTumorSegmentationOnnx).mockResolvedValueOnce({
      labels: Uint8Array.of(1, 2, 4, 1),
      logitsDims: [1, 4, 1, 1, 4],
    });
    const onLabels = vi.fn();
    const { result } = renderHook(() => useOnnxTumorSession(native, onLabels));
    act(() => result.current.handleSelectedFiles(selected));
    await waitFor(() => expect(result.current.status.verified).toBe(true));
    act(() => result.current.runSegmentation());
    await waitFor(() => expect(onLabels).toHaveBeenCalledOnce());
    expect(vi.mocked(runTumorSegmentationOnnx).mock.calls[0]![0].volume).toEqual(Float32Array.of(0, 0.5, 1, 0));
    expect(native.data).toEqual(original);
    expect(onLabels.mock.calls[0]![0].data).toEqual(Uint8Array.of(1, 2, 4, 0));
    expect(result.current.status.message).toMatch(/source-aligned suggestion.*review/i);
    expect(result.current.preflight?.preprocessingBytes).toBe(
      native.data.byteLength * 2 + native.observedSupport!.byteLength,
    );
    expect(result.current.preflight?.readyResidentBytes).toBeGreaterThan(288 * 1024 * 1024);
  });

  it('refuses native-grid inference for legacy manifests instead of guessing a model orientation or pitch', async () => {
    const selected = await files();
    const native = { ...syntheticVolume, nativeVoxelSizeMm: [1, 1, 2] as [number, number, number] };
    const onLabels = vi.fn();
    const { result } = renderHook(() => useOnnxTumorSession(native, onLabels));
    act(() => result.current.handleSelectedFiles(selected));
    await waitFor(() => expect(result.current.status.verified).toBe(true));
    act(() => result.current.runSegmentation());
    await waitFor(() => expect(result.current.status.error).toMatch(/source-grid.*compatibility/i));
    expect(runTumorSegmentationOnnx).not.toHaveBeenCalled();
    expect(onLabels).not.toHaveBeenCalled();
  });

  it.each(['clear-model', 'new-volume'] as const)('discards an old inference result after %s', async (change) => {
    const selected = await files();
    const inference = deferred<{ labels: Uint8Array; logitsDims: number[] }>();
    vi.mocked(runTumorSegmentationOnnx).mockReturnValueOnce(inference.promise);
    const onLabels = vi.fn();
    const { result, rerender } = renderHook(({ volume }) => useOnnxTumorSession(volume, onLabels), {
      initialProps: { volume: syntheticVolume },
    });
    act(() => result.current.handleSelectedFiles(selected));
    await waitFor(() => expect(result.current.status.verified).toBe(true));
    act(() => result.current.runSegmentation());
    await waitFor(() => expect(runTumorSegmentationOnnx).toHaveBeenCalledOnce());
    if (change === 'clear-model') {
      act(() => result.current.clearModel());
      await waitFor(() => expect(result.current.status.cached).toBe(false));
    } else rerender({ volume: { ...syntheticVolume, data: Float32Array.of(0.2) } });
    await act(async () => inference.resolve({ labels: Uint8Array.of(1), logitsDims: [1, 4, 1, 1, 1] }));
    await waitFor(() => expect(result.current.segRunning).toBe(false));
    expect(onLabels).not.toHaveBeenCalled();
    expect(result.current.status.message).not.toMatch(/Segmentation complete/);
  });

  it.each(['cancel', 'source', 'blocked', 'clear', 'unmount'] as const)(
    'terminates an active worker immediately on %s and rejects its late output',
    async (action) => {
      const selected = await files();
      const inference = deferred<{ labels: Uint8Array; logitsDims: number[] }>();
      vi.mocked(runTumorSegmentationOnnx).mockReturnValueOnce(inference.promise);
      const onLabels = vi.fn();
      const { result, rerender, unmount } = renderHook(
        ({ volume, blocked }) => useOnnxTumorSession(volume, onLabels, { blocked }),
        {
          initialProps: { volume: syntheticVolume, blocked: false },
        },
      );
      act(() => result.current.handleSelectedFiles(selected));
      await waitFor(() => expect(result.current.status.verified).toBe(true));
      act(() => result.current.runSegmentation());
      await waitFor(() => expect(runTumorSegmentationOnnx).toHaveBeenCalledOnce());
      const worker = WorkerHarness.instances[0]!;
      if (action === 'cancel') act(() => result.current.cancelSegmentation());
      else if (action === 'source')
        rerender({ volume: { ...syntheticVolume, data: Float32Array.of(0.2) }, blocked: false });
      else if (action === 'blocked') rerender({ volume: syntheticVolume, blocked: true });
      else if (action === 'clear') act(() => result.current.clearModel());
      else unmount();
      expect(worker.terminate).toHaveBeenCalledOnce();
      if (action !== 'unmount') expect(result.current.segRunning).toBe(false);
      await act(async () => inference.resolve({ labels: Uint8Array.of(1), logitsDims: [1, 4, 1, 1, 1] }));
      expect(onLabels).not.toHaveBeenCalled();
      if (action === 'cancel') {
        act(() => result.current.runSegmentation());
        await waitFor(() => expect(onLabels).toHaveBeenCalledOnce());
        expect(WorkerHarness.instances).toHaveLength(2);
        expect(WorkerHarness.instances[1]!.terminate).toHaveBeenCalledOnce();
      }
    },
  );

  it('admits a 128-cubed native volume and 20 MiB model with an on-demand device-derived budget', async () => {
    vi.stubGlobal('navigator', { deviceMemory: 8 });
    const native: SvrVolume = {
      ...syntheticVolume,
      dims: [128, 128, 128],
      data: new Float32Array(128 ** 3),
      nativeVoxelSizeMm: [1, 1, 1],
      boundsMm: { min: [0, 0, 0], max: [128, 128, 128] },
    };
    const selected = await files(false, 'source-grid', 0, 20 * 1024 * 1024);
    cache.set(MODEL_KEY, selected[0]);
    cache.set(MANIFEST_KEY, selected[1]);
    const measured = vi.spyOn(cornerstone.imageCache, 'getCacheInfo');
    const onLabels = vi.fn();
    const { result, rerender } = renderHook(() => useOnnxTumorSession(native, onLabels));
    await waitFor(() => expect(result.current.status.verified).toBe(true));
    rerender();
    expect(result.current.preflight).toBeNull();
    expect(measured).not.toHaveBeenCalled();
    act(() => result.current.runSegmentation());
    await waitFor(() => expect(onLabels).toHaveBeenCalledOnce());
    expect(result.current.preflight).toMatchObject({ blockedByDefault: false, budgetBytes: 2048 * 1024 * 1024 });
    expect(result.current.preflight!.estimatedPeakBytes).toBeGreaterThan(SVR_MEMORY_BUDGET_BYTES);
    expect(WorkerHarness.instances).toHaveLength(1);
    expect(WorkerHarness.instances[0]!.terminate).toHaveBeenCalledOnce();
  });

  it('blocks an oversized volume against the device envelope before constructing a worker', async () => {
    vi.stubGlobal('navigator', { deviceMemory: 2 });
    // A 260³ volume has only ~268 MiB of four-class logits, so the obsolete
    // logits-only 384 MiB limit admitted it despite exceeding 512 MiB overall.
    const largeVolume = {
      ...syntheticVolume,
      dims: [260, 260, 260] as [number, number, number],
      data: new Float32Array(260 ** 3),
    };
    const selected = await files();
    cache.set(MODEL_KEY, selected[0]);
    cache.set(MANIFEST_KEY, selected[1]);
    const onLabels = vi.fn();
    const { result } = renderHook(() => useOnnxTumorSession(largeVolume, onLabels));

    expect(result.current.preflight).toBeNull();
    await waitFor(() => expect(result.current.status.verified).toBe(true));
    act(() => result.current.runSegmentation());
    await waitFor(() => expect(result.current.status.error).toMatch(/memory budget/));
    expect(result.current.preflight?.logitsBytes).toBeLessThan(384 * 1024 * 1024);
    expect(result.current.preflight?.estimatedPeakBytes).toBeGreaterThan(512 * 1024 * 1024);
    expect(result.current.preflight?.budgetBytes).toBe(512 * 1024 * 1024);
    expect(result.current.preflight?.blockedByDefault).toBe(true);
    expect(createSession).not.toHaveBeenCalled();
    expect(onLabels).not.toHaveBeenCalled();
  });

  it('measures newly displayed DICOM ownership on demand without replacing the accepted volume', async () => {
    vi.stubGlobal('navigator', { deviceMemory: 2 });
    const selected = await files();
    cache.set(MODEL_KEY, selected[0]);
    cache.set(MANIFEST_KEY, selected[1]);
    const onLabels = vi.fn();
    const { result } = renderHook(() => useOnnxTumorSession(syntheticVolume, onLabels));
    await act(async () => undefined);
    expect(result.current.preflight).toBeNull();
    const data = new Uint8Array(256 * 1024 * 1024);
    const pixels = new Uint8Array(data.buffer, 0, 4);
    enabledImages.push({ image: { getPixelData: () => pixels, data: { byteArray: data } } });
    act(() => result.current.runSegmentation());
    await waitFor(() => expect(result.current.status.error).toMatch(/memory budget/));
    expect(createSession).not.toHaveBeenCalled();
    expect(onLabels).not.toHaveBeenCalled();
    expect(enabledImages[0]!.image.getPixelData()).toBe(pixels);
    expect(enabledImages[0]!.image.data!.byteArray).toBe(data);
    expect(syntheticVolume.data).toEqual(Float32Array.of(0.5));
  });
});

describe('custom-model worker lifetime', () => {
  it.each(['initialization', 'execution'] as const)(
    'bounds %s and terminates before returning the timeout',
    async (phase) => {
      const [model, manifest] = await files();
      vi.useFakeTimers();
      vi.spyOn(WorkerHarness.prototype, 'postMessage').mockImplementation(function (request) {
        this.request = request;
      });
      const running = runCustomModelWorker(
        { model, manifest, volume: syntheticVolume },
        {
          signal: new AbortController().signal,
          estimatedPeakBytes: customModelRuntimeBytes(model.size) + 1024,
        },
      );
      const rejected = expect(running).rejects.toThrow(
        phase === 'initialization' ? /initialization exceeded/ : /execution exceeded/,
      );
      const worker = WorkerHarness.instances[0]!;
      if (phase === 'execution')
        worker.onmessage!({ data: { type: 'running', mode: 'wasm' } } as MessageEvent<CustomModelResponse>);
      await vi.advanceTimersByTimeAsync(
        phase === 'execution' ? CUSTOM_MODEL_RUN_TIMEOUT_MS : CUSTOM_MODEL_INIT_TIMEOUT_MS,
      );
      await rejected;
      expect(worker.terminate).toHaveBeenCalledOnce();
      expect(worker.onmessage).toBeNull();
      expect(worker.onerror).toBeNull();
      expect(worker.onmessageerror).toBeNull();
    },
  );

  it('replaces a failed provider only after terminating its whole worker', async () => {
    const [model, manifest] = await files();
    createSession.mockImplementationOnce(async () => {
      throw new Error('WebGPU initialization failed');
    });
    createSession.mockImplementationOnce(async () => {
      expect(WorkerHarness.instances[0]!.terminated).toBe(true);
      return { release: vi.fn(async () => undefined) };
    });
    const output = await runCustomModelWorker(
      { model, manifest, volume: syntheticVolume },
      {
        signal: new AbortController().signal,
        estimatedPeakBytes: customModelRuntimeBytes(model.size) + 1024,
      },
    );
    expect(output.mode).toBe('wasm');
    expect(WorkerHarness.instances.map((worker) => worker.request!.mode)).toEqual(['webgpu-preferred', 'wasm']);
    for (const worker of WorkerHarness.instances) expect(worker.terminate).toHaveBeenCalledOnce();
  });

  it.each(['error', 'messageerror', 'bad-response', 'post-failure'] as const)(
    'retires malformed/failed transport (%s)',
    async (failure) => {
      const [model, manifest] = await files();
      vi.spyOn(WorkerHarness.prototype, 'postMessage').mockImplementation(function () {
        if (failure === 'post-failure') throw new Error('Could not clone input');
      });
      const operation = runCustomModelWorker(
        { model, manifest, volume: syntheticVolume },
        {
          signal: new AbortController().signal,
          estimatedPeakBytes: customModelRuntimeBytes(model.size) + 1024,
        },
      );
      const rejected = expect(operation).rejects.toThrow();
      const worker = WorkerHarness.instances[0]!;
      if (failure === 'error') worker.onerror!({ message: 'Worker crashed' } as ErrorEvent);
      else if (failure === 'messageerror') worker.onmessageerror!();
      else if (failure === 'bad-response')
        worker.onmessage!({ data: { type: 'unknown' } } as unknown as MessageEvent<CustomModelResponse>);
      await rejected;
      expect(worker.terminate).toHaveBeenCalledOnce();
    },
  );

  it('refuses an over-budget compiled-model allowance before cloning any source or creating a worker', async () => {
    const [model, manifest] = await files();
    await expect(
      runCustomModelWorker(
        { model, manifest, volume: syntheticVolume },
        {
          signal: new AbortController().signal,
          estimatedPeakBytes: customModelBudgetBytes() + 1,
        },
      ),
    ).rejects.toThrow(/memory budget/);
    expect(WorkerHarness.instances).toHaveLength(0);
  });
});

describe('model-pair IndexedDB transaction cancellation', () => {
  it.each(['put', 'delete'] as const)(
    'rolls back both artifacts when canceled after the final %s request succeeds',
    async (operation) => {
      const actual = await vi.importActual<typeof ModelCache>('../src/utils/segmentation/onnx/modelCache');
      await actual.deleteModelCache();
      try {
        await actual.putModelBlobs([
          { key: MODEL_KEY, blob: new NodeBlob(['original-model']) as Blob },
          { key: MANIFEST_KEY, blob: new NodeBlob(['original-manifest']) as Blob },
        ]);
        const snapshot = async () =>
          Promise.all(
            (await actual.getAllModelRecords()).map(async (record) => ({
              key: record.key,
              savedAtMs: record.savedAtMs,
              content: await record.blob.text(),
            })),
          );
        const before = await snapshot();
        const controller = new AbortController();
        const original = IDBObjectStore.prototype[operation];
        let finalRequestSucceeded = false;
        let finalSignalCheckPassed = false;
        const readAborted = Object.getOwnPropertyDescriptor(AbortSignal.prototype, 'aborted')!.get!;
        vi.spyOn(controller.signal, 'aborted', 'get').mockImplementation(() => {
          const aborted = readAborted.call(controller.signal) as boolean;
          if (finalRequestSucceeded && !aborted) finalSignalCheckPassed = true;
          return aborted;
        });
        vi.spyOn(IDBObjectStore.prototype, operation).mockImplementation(function (
          this: IDBObjectStore,
          ...args: unknown[]
        ) {
          const request = Reflect.apply(original, this, args) as IDBRequest;
          const key = operation === 'put' ? args[1] : args[0];
          if (key === MANIFEST_KEY)
            request.addEventListener('success', () => {
              finalRequestSucceeded = true;
              // Let the awaiting helper pass its last signal check, then cancel
              // before IDB's later transaction-complete event.
              queueMicrotask(() => queueMicrotask(() => controller.abort()));
            });
          return request;
        });
        const pending =
          operation === 'put'
            ? actual.putModelBlobs(
                [
                  { key: MODEL_KEY, blob: new NodeBlob(['replacement-model']) as Blob },
                  { key: MANIFEST_KEY, blob: new NodeBlob(['replacement-manifest']) as Blob },
                ],
                { signal: controller.signal },
              )
            : actual.deleteModelBlobs([MODEL_KEY, MANIFEST_KEY], { signal: controller.signal });
        await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
        expect(finalRequestSucceeded).toBe(true);
        expect(finalSignalCheckPassed).toBe(true);
        expect(await snapshot()).toEqual(before);
      } finally {
        await actual.deleteModelCache();
      }
    },
  );
});
