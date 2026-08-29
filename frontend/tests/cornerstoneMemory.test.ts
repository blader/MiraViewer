import { afterEach, describe, expect, it, vi } from 'vitest';
import cornerstone from 'cornerstone-core';
import { CORNERSTONE_MEMORY_FALLBACK_BYTES, measureCornerstoneImageMemory } from '../src/utils/cornerstoneMemory';

const image = (pixels: Int16Array, data = new Uint8Array(3)) => ({
  sizeInBytes: pixels.byteLength,
  getPixelData: () => pixels,
  imageFrame: { pixelData: pixels },
  data: { byteArray: data },
});
const source = (images: ReturnType<typeof image>[], displayed: ReturnType<typeof image>[] = []) => ({
  imageCache: {
    cachedImages: images.map((image) => ({ image, loaded: true, sizeInBytes: image.sizeInBytes })),
    getCacheInfo: () => ({ cacheSizeInBytes: images.reduce((sum, image) => sum + image.sizeInBytes, 0) }),
  },
  getEnabledElements: () => displayed.map((image) => ({ image })),
});

describe('retained Cornerstone CPU buffers', () => {
  afterEach(() => vi.restoreAllMocks());

  it('counts distinct decoded and parsed backing buffers, not just the advertised pixel bytes', () => {
    const current = image(new Int16Array(8), new Uint8Array(23));
    const original = current.data.byteArray.slice();
    const result = measureCornerstoneImageMemory(source([current], [current]));
    expect(result.bytes).toBe(16 + 23);
    expect(result.measured).toBe(true);
    expect(result.reservedPixelCacheBytes).toBe(16);
    expect(current.data.byteArray).toEqual(original);
  });

  it('deduplicates shared allocations across pixel subviews, parser data, images and displayed panels', () => {
    const allocation = new ArrayBuffer(200);
    const first = image(new Int16Array(allocation, 40, 8), new Uint8Array(allocation));
    const second = image(new Int16Array(allocation, 80, 12), new Uint8Array(allocation, 0, 10));
    expect(measureCornerstoneImageMemory(source([first, second], [first, second])).bytes).toBe(200);
  });

  it('keeps an uncached displayed image alive in the estimate and drops it only when no owner remains', () => {
    const current = image(new Int16Array(8));
    expect(measureCornerstoneImageMemory(source([], [current])).bytes).toBe(19);
    expect(measureCornerstoneImageMemory(source([])).bytes).toBe(0);
  });

  it('includes converted float/color/LUT arrays without double-counting aliases', () => {
    const current = Object.assign(image(new Int16Array(8)), {
      floatPixelData: new Float32Array(8),
      cachedLut: { lut: new Uint8Array(20) },
    });
    Object.assign(current.imageFrame, { imageData: { data: new Uint8ClampedArray(current.floatPixelData.buffer) } });
    expect(measureCornerstoneImageMemory(source([current])).bytes).toBe(16 + 3 + 32 + 20);
  });

  it('reserves incomplete telemetry without charging known cached pixel buffers twice', () => {
    const current = image(new Int16Array(8), new Uint8Array(23));
    const observation = source([current]);
    const result = measureCornerstoneImageMemory({ imageCache: observation.imageCache });
    expect(result.measured).toBe(false);
    expect(result.bytes).toBe(CORNERSTONE_MEMORY_FALLBACK_BYTES + 23);
    expect(result.reservedPixelCacheBytes).toBe(CORNERSTONE_MEMORY_FALLBACK_BYTES);
    expect(measureCornerstoneImageMemory().bytes).toBe(CORNERSTONE_MEMORY_FALLBACK_BYTES);
  });

  it('does not execute arbitrary property getters, and a throwing pixel API preserves the fallback', () => {
    const current = image(new Int16Array(8));
    const getter = vi.fn(() => {
      throw new Error('Do not inspect arbitrary metadata');
    });
    Object.defineProperty(current, 'data', { get: getter });
    expect(measureCornerstoneImageMemory(source([current])).bytes).toBe(CORNERSTONE_MEMORY_FALLBACK_BYTES);
    expect(getter).not.toHaveBeenCalled();
    current.getPixelData = () => {
      throw new Error('Pixels unavailable');
    };
    expect(measureCornerstoneImageMemory(source([current])).measured).toBe(false);
  });

  it('does not subtract a large parser allocation as though a tiny pixel subview filled the cache reserve', () => {
    const backing = new ArrayBuffer(100 * 1024 * 1024);
    const current = image(new Int16Array(backing, 4096, 512), new Uint8Array(backing));
    const observed = source([current]);
    const result = measureCornerstoneImageMemory({ imageCache: observed.imageCache });
    expect(result.measured).toBe(false);
    expect(result.bytes).toBe(backing.byteLength + CORNERSTONE_MEMORY_FALLBACK_BYTES - 1024);
  });

  it('reads actual installed cache ownership after removal while preserving an enabled image', async () => {
    const current = image(new Int16Array(8), new Uint8Array(23));
    const id = 'miradb:synthetic-memory-accounting';
    const before = cornerstone.imageCache.getCacheInfo();
    const enabled = vi.spyOn(cornerstone, 'getEnabledElements').mockReturnValue([{ image: current }] as never);
    cornerstone.imageCache.putImageLoadObject(id, { promise: Promise.resolve(current) } as never);
    await Promise.resolve();
    try {
      expect(cornerstone.imageCache.getCacheInfo().cacheSizeInBytes).toBe(before.cacheSizeInBytes + 16);
      expect(measureCornerstoneImageMemory(cornerstone).bytes).toBe(39);
      cornerstone.imageCache.removeImageLoadObject(id);
      expect(measureCornerstoneImageMemory(cornerstone).bytes).toBe(39);
      expect(current.getPixelData()).toEqual(new Int16Array(8));
      enabled.mockReturnValue([]);
      expect(measureCornerstoneImageMemory(cornerstone).bytes).toBe(0);
    } finally {
      if (cornerstone.imageCache.getImageLoadObject(id)) cornerstone.imageCache.removeImageLoadObject(id);
    }
    expect(cornerstone.imageCache.getCacheInfo()).toEqual(before);
  });
});
