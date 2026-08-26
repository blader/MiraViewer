import { webcrypto } from 'node:crypto';
import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TUMOR_MODEL_MANIFEST_EXAMPLE } from '../src/utils/segmentation/onnx/modelManifest';

const { cache, createSession } = vi.hoisted(() => ({
  cache: new Map<string, Blob>(),
  createSession: vi.fn(async () => ({ release: vi.fn(async () => undefined) })),
}));

vi.mock('../src/utils/segmentation/onnx/modelCache', () => ({
  getModelBlob: vi.fn(async (key: string) => cache.get(key) ?? null),
  getModelRecord: vi.fn(async (key: string) => {
    const blob = cache.get(key);
    return blob ? { key, blob, savedAtMs: 1 } : null;
  }),
  putModelBlob: vi.fn(async (key: string, blob: Blob) => {
    cache.set(key, blob);
  }),
  deleteModelBlob: vi.fn(async (key: string) => {
    cache.delete(key);
  }),
}));

vi.mock('../src/utils/segmentation/onnx/ortLoader', () => ({
  createOrtSessionFromModelBlob: createSession,
}));

vi.mock('../src/utils/segmentation/onnx/tumorSegmentation', () => ({
  runTumorSegmentationOnnx: vi.fn(),
}));

import { useOnnxTumorSession } from '../src/hooks/useOnnxTumorSession';
import { runTumorSegmentationOnnx } from '../src/utils/segmentation/onnx/tumorSegmentation';
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

async function files(wrongHash = false): Promise<[File, File]> {
  const model = new File([new Uint8Array([4, 8, 15, 16, 23, 42])], 'synthetic.onnx');
  const digest = await webcrypto.subtle.digest('SHA-256', await model.arrayBuffer());
  const hash = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
  const manifest = new File(
    [JSON.stringify({ ...TUMOR_MODEL_MANIFEST_EXAMPLE, modelSha256: wrongHash ? '0'.repeat(64) : hash })],
    'synthetic.json',
    { type: 'application/json' },
  );
  return [model, manifest];
}

beforeEach(() => {
  cache.clear();
  vi.clearAllMocks();
  vi.stubGlobal('crypto', webcrypto);
});

afterEach(() => vi.unstubAllGlobals());

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

    act(() => result.current.initSession());
    await waitFor(() => expect(result.current.status.error).toMatch(/unverified/i));

    act(() => result.current.runSegmentation());
    await waitFor(() => {
      expect(result.current.status.error).toMatch(/unverified/i);
      expect(result.current.segRunning).toBe(false);
    });
    expect(createSession).not.toHaveBeenCalled();
    expect(onLabels).not.toHaveBeenCalled();
  });

  it('retains a mismatched model unverified without caching its invalid sidecar', async () => {
    const selected = await files(true);
    const { result } = renderHook(() => useOnnxTumorSession(null, vi.fn()));

    act(() => result.current.handleSelectedFiles(selected));

    await waitFor(() => {
      expect(result.current.status.cached).toBe(true);
      expect(result.current.status.verified).toBe(false);
      expect(result.current.status.error).toMatch(/does not match/i);
    });
    expect(cache.has(MODEL_KEY)).toBe(true);
    expect(cache.has(MANIFEST_KEY)).toBe(false);

    act(() => result.current.initSession());
    await waitFor(() => expect(result.current.status.error).toMatch(/unverified/i));
    expect(createSession).not.toHaveBeenCalled();
  });

  it('caches and initializes only a cryptographically verified model and manifest pair', async () => {
    const selected = await files();
    const { result } = renderHook(() => useOnnxTumorSession(null, vi.fn()));

    act(() => result.current.handleSelectedFiles(selected));
    await waitFor(() => {
      expect(result.current.status.cached).toBe(true);
      expect(result.current.status.verified).toBe(true);
    });
    expect(cache.has(MODEL_KEY)).toBe(true);
    expect(cache.has(MANIFEST_KEY)).toBe(true);

    act(() => result.current.initSession());
    await waitFor(() => expect(result.current.status.sessionReady).toBe(true));
    expect(createSession).toHaveBeenCalledOnce();
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

  it('never overlaps a canceled but still-running model operation with its replacement', async () => {
    const selected = await files();
    let finishFirstRun!: (result: { labels: Uint8Array; logitsDims: number[] }) => void;
    vi.mocked(runTumorSegmentationOnnx).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishFirstRun = resolve;
        }),
    );
    const onLabels = vi.fn();
    const { result } = renderHook(() => useOnnxTumorSession(syntheticVolume, onLabels));

    act(() => result.current.handleSelectedFiles(selected));
    await waitFor(() => expect(result.current.status.verified).toBe(true));

    act(() => result.current.runSegmentation());
    await waitFor(() => expect(runTumorSegmentationOnnx).toHaveBeenCalledOnce());

    act(() => result.current.cancelSegmentation());
    expect(result.current.segRunning).toBe(true);
    expect(result.current.status.message).toMatch(/waiting.*release its memory/i);

    act(() => result.current.runSegmentation());
    expect(runTumorSegmentationOnnx).toHaveBeenCalledOnce();

    await act(async () => {
      finishFirstRun({ labels: new Uint8Array([1]), logitsDims: [1, 4, 1, 1, 1] });
    });
    await waitFor(() => expect(result.current.segRunning).toBe(false));
    expect(onLabels).not.toHaveBeenCalled();

    vi.mocked(runTumorSegmentationOnnx).mockResolvedValueOnce({
      labels: new Uint8Array([2]),
      logitsDims: [1, 4, 1, 1, 1],
    });
    act(() => result.current.runSegmentation());
    await waitFor(() => expect(onLabels).toHaveBeenCalledOnce());
    expect(runTumorSegmentationOnnx).toHaveBeenCalledTimes(2);
  });

  it('counts old and replacement labels when model tensors otherwise appear to fit', async () => {
    // 257³ at the former 31 bytes/voxel was falsely admitted at 501.84 MiB;
    // the overlapping replacement label raises the real peak to 518.02 MiB.
    const borderlineVolume = { ...syntheticVolume, dims: [257, 257, 257] as [number, number, number] };
    const { result } = renderHook(() => useOnnxTumorSession(borderlineVolume, vi.fn()));

    expect(result.current.preflight?.estimatedPeakBytes).toBeGreaterThan(SVR_MEMORY_BUDGET_BYTES);
    expect(result.current.preflight?.blockedByDefault).toBe(true);
    await act(async () => undefined);
  });

  it('blocks inference when total ready-volume and tensor residency exceeds the shared SVR budget', async () => {
    // A 260³ volume has only ~268 MiB of four-class logits, so the obsolete
    // logits-only 384 MiB limit admitted it despite exceeding 512 MiB overall.
    const largeVolume = { ...syntheticVolume, dims: [260, 260, 260] as [number, number, number] };
    const onLabels = vi.fn();
    const { result } = renderHook(() => useOnnxTumorSession(largeVolume, onLabels));

    expect(result.current.preflight?.logitsBytes).toBeLessThan(384 * 1024 * 1024);
    expect(result.current.preflight?.estimatedPeakBytes).toBeGreaterThan(SVR_MEMORY_BUDGET_BYTES);
    expect(result.current.preflight?.budgetBytes).toBe(SVR_MEMORY_BUDGET_BYTES);
    expect(result.current.preflight?.blockedByDefault).toBe(true);

    act(() => result.current.setAllowUnsafeFullRes(true));
    act(() => result.current.runSegmentation());
    await waitFor(() =>
      expect(result.current.status.error).toMatch(/memory budget.*smaller focus|memory budget.*lower resolution/i),
    );
    expect(createSession).not.toHaveBeenCalled();
    expect(onLabels).not.toHaveBeenCalled();
  });
});
