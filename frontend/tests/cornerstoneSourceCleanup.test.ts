import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as CornerstoneModule from 'cornerstone-core';
import type * as WadoModule from 'cornerstone-wado-image-loader';

const mocks = vi.hoisted(() => ({
  instance: vi.fn(),
  register: vi.fn(),
  load: vi.fn(),
  removeImage: vi.fn(),
}));

vi.mock('cornerstone-core', async (importOriginal) => {
  const { default: actual } = await importOriginal<typeof CornerstoneModule>();
  return {
    default: {
      ...actual,
      registerImageLoader: mocks.register,
      loadImage: mocks.load,
      triggerEvent: vi.fn(),
      imageCache: { ...actual.imageCache, removeImageLoadObject: mocks.removeImage, setMaximumSizeBytes: vi.fn() },
    },
  };
});
vi.mock('dicom-parser', () => ({ default: { parseDicom: (byteArray: Uint8Array) => ({ byteArray }) } }));
vi.mock('../src/db/db', () => ({ getDB: async () => ({ get: mocks.instance }) }));
vi.mock('../src/utils/derivedAlignmentFrame', () => ({ getDerivedAlignmentFrameByImageId: vi.fn() }));
vi.mock('../src/utils/derivedImagePresentation', () => ({ createDerivedImagePresentation: vi.fn() }));
vi.mock('cornerstone-wado-image-loader', async (importOriginal) => {
  // The distributed UMD discovers its asset base from its script tag. jsdom
  // does not fetch this tag; it only supplies that normal module-bootstrap metadata.
  const script = document.createElement('script');
  script.src = 'http://localhost/assets/cornerstone-test.js';
  document.head.append(script);
  try {
    const actual = await importOriginal<typeof WadoModule>();
    // Exercise the installed parser, Blob manager and reference-counted dataset
    // cache, without starting decoder workers or requiring medical fixture files.
    return { default: { ...actual.default, webWorkerManager: { initialize: vi.fn() } } };
  } finally {
    script.remove();
  }
});

import wado from 'cornerstone-wado-image-loader';

type Image = { data: { byteArray: Uint8Array }; pixels: Int16Array };
let nativeLoader: (imageId: string) => { promise: Promise<Image> };

describe('local DICOM processing lifetime', () => {
  beforeEach(async () => {
    vi.resetModules();
    vi.clearAllMocks();
    wado.wadouri.fileManager.purge();
    wado.wadouri.dataSetCacheManager.purge();
    const { initCornerstone } = await import('../src/utils/cornerstoneInit');
    initCornerstone();
    nativeLoader = mocks.register.mock.calls.find(([scheme]) => scheme === 'miradb')![1];
    mocks.instance.mockResolvedValue({ fileBlob: new Blob([Uint8Array.of(3, 7, 11, 19)]) });
  });
  afterEach(() => {
    wado.wadouri.fileManager.purge();
    wado.wadouri.dataSetCacheManager.purge();
  });

  const loadDataset = async (imageId: string) => {
    const { url } = wado.wadouri.parseImageId(imageId);
    const blob = wado.wadouri.fileManager.get(Number(url)) as Blob;
    return wado.wadouri.dataSetCacheManager.load(url, () => blob.arrayBuffer(), imageId);
  };

  it('returns intact decoded images while repeated processing releases its actual dataset and Blob keys', async () => {
    const cache = wado.wadouri.dataSetCacheManager;
    const independent = await cache.load('independent-source', async () => Uint8Array.of(9, 8, 7).buffer);
    const before = cache.getInfo();
    mocks.load.mockImplementation(async (imageId: string) => ({
      data: await loadDataset(imageId),
      pixels: Int16Array.of(-1024, 4095),
    }));
    for (let frame = 0; frame < 20; frame++) {
      const image = await nativeLoader(`miradb:frame-${frame}`).promise;
      expect(image.pixels).toEqual(Int16Array.of(-1024, 4095));
      expect(image.data.byteArray).toEqual(Uint8Array.of(3, 7, 11, 19));
      expect(cache.getInfo()).toEqual(before);
      expect(cache.get(String(frame))).toBeUndefined();
      expect(wado.wadouri.fileManager.get(frame)).toBeUndefined();
      expect(mocks.removeImage).toHaveBeenLastCalledWith(`dicomfile:${frame}`);
    }
    expect(cache.get('independent-source')).toBe(independent);
    expect(mocks.removeImage.mock.calls.every(([key]) => key.startsWith('dicomfile:'))).toBe(true);
  });

  it('releases an already parsed dataset and its Blob when pixel decoding rejects', async () => {
    const error = new Error('Synthetic decoder failure');
    mocks.load.mockImplementation(async (imageId: string) => {
      await loadDataset(imageId);
      throw error;
    });
    await expect(nativeLoader('miradb:failed-frame').promise).rejects.toBe(error);
    expect(wado.wadouri.dataSetCacheManager.getInfo()).toEqual({ cacheSizeInBytes: 0, numberOfDataSetsCached: 0 });
    expect(wado.wadouri.fileManager.get(0)).toBeUndefined();
    expect(mocks.removeImage).toHaveBeenCalledExactlyOnceWith('dicomfile:0');
  });
});
