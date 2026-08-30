import { Blob as NodeBlob } from 'node:buffer';
import { webcrypto } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { deferred } from './helpers/deferred';

vi.mock('../src/utils/segmentation/efficientTam/assetManifest.json', () => ({
  default: {
    id: 'synthetic-tracking-model',
    directory: 'models/synthetic-tracking-model',
    graphs: {
      encoder: {
        path: 'encoder.onnx',
        bytes: 3,
        sha256: 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
      },
    },
    constants: {},
  },
}));
vi.mock('../src/utils/segmentation/onnx/modelCache', () => ({ getModelBlob: vi.fn(), putModelBlobs: vi.fn() }));
import { loadTrackingAsset } from '../src/utils/segmentation/efficientTam/loadAsset';
import { getModelBlob, putModelBlobs } from '../src/utils/segmentation/onnx/modelCache';

const expected = Uint8Array.of(97, 98, 99);
const cacheKey = 'synthetic-tracking-model:ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad';
const fetchMock = vi.fn<typeof fetch>();

beforeEach(() => {
  vi.stubGlobal('crypto', webcrypto);
  vi.stubGlobal('Blob', NodeBlob);
  vi.stubGlobal('fetch', fetchMock);
  vi.mocked(getModelBlob).mockResolvedValue(null);
  vi.mocked(putModelBlobs).mockResolvedValue();
});
afterEach(() => {
  vi.resetAllMocks();
  vi.unstubAllGlobals();
});

describe('interactive model asset admission', () => {
  it('verifies cached bytes before offline use without a network request', async () => {
    vi.mocked(getModelBlob).mockResolvedValue(new Blob([expected]));
    expect(await loadTrackingAsset('encoder')).toEqual(expected);
    expect(getModelBlob).toHaveBeenCalledWith(cacheKey);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(putModelBlobs).not.toHaveBeenCalled();
  });

  it.each([null, 'bad', 'too large'])(
    'replaces only missing or corrupt cache after SHA verification',
    async (cached) => {
      vi.mocked(getModelBlob).mockResolvedValue(cached === null ? null : new Blob([cached]));
      fetchMock.mockResolvedValue(new Response(expected));
      const signal = new AbortController().signal;
      expect(await loadTrackingAsset('encoder', signal)).toEqual(expected);
      expect(fetchMock).toHaveBeenCalledWith('/models/synthetic-tracking-model/encoder.onnx', {
        signal,
        cache: 'no-cache',
      });
      expect(putModelBlobs).toHaveBeenCalledOnce();
      const [records, options] = vi.mocked(putModelBlobs).mock.calls[0]!;
      expect(records[0]!.key).toBe(cacheKey);
      expect(new Uint8Array(await records[0]!.blob.arrayBuffer())).toEqual(expected);
      expect(options?.signal).toBe(signal);
    },
  );

  it.each(['bad', 'ab', 'abcd'])(
    'rejects altered, truncated or oversized downloads without caching them: %s',
    async (body) => {
      fetchMock.mockResolvedValue(new Response(body));
      await expect(loadTrackingAsset('encoder')).rejects.toThrow(/integrity|pinned size/);
      expect(putModelBlobs).not.toHaveBeenCalled();
    },
  );

  it('cancels a stream as soon as it exceeds the pinned size', async () => {
    const cancel = vi.fn();
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(new Uint8Array(4));
      },
      cancel,
    });
    fetchMock.mockResolvedValue(new Response(stream));
    await expect(loadTrackingAsset('encoder')).rejects.toThrow(/pinned size/);
    expect(cancel).toHaveBeenCalledOnce();
    expect(putModelBlobs).not.toHaveBeenCalled();
  });

  it('does not fetch after cancellation while reading the cache', async () => {
    const cached = deferred<Blob | null>();
    vi.mocked(getModelBlob).mockReturnValue(cached.promise);
    const controller = new AbortController();
    const promise = loadTrackingAsset('encoder', controller.signal);
    controller.abort();
    cached.resolve(null);
    await expect(promise).rejects.toMatchObject({ name: 'AbortError' });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(putModelBlobs).not.toHaveBeenCalled();
  });

  it('does not cache a late fetch after cancellation', async () => {
    const download = deferred<Response>();
    fetchMock.mockReturnValue(download.promise);
    const controller = new AbortController();
    const promise = loadTrackingAsset('encoder', controller.signal);
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
    controller.abort();
    download.resolve(new Response(expected));
    await expect(promise).rejects.toMatchObject({ name: 'AbortError' });
    expect(putModelBlobs).not.toHaveBeenCalled();
  });

  it('reports unavailable assets without accepting an HTML or error response', async () => {
    fetchMock.mockResolvedValue(new Response('missing', { status: 404 }));
    await expect(loadTrackingAsset('encoder')).rejects.toThrow(/unavailable.*404/);
    expect(putModelBlobs).not.toHaveBeenCalled();
  });

  it('does not publish bytes from an interrupted cache transaction', async () => {
    fetchMock.mockResolvedValue(new Response(expected));
    vi.mocked(putModelBlobs).mockRejectedValue(new DOMException('Transaction interrupted', 'AbortError'));
    await expect(loadTrackingAsset('encoder')).rejects.toMatchObject({ name: 'AbortError' });
  });
});
