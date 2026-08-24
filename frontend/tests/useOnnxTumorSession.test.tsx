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
});
