import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SvrLabelVolume, SvrVolume } from '../src/types/svr';
import {
  assertEnhancementFits,
  cropEnhancementSource,
  enhancementWorkingBytes,
  prepareEnhancementMemory,
  type EnhancementImageCache,
} from '../src/utils/svr/superResolutionRegion';
import { MAX_SR_OUTPUT_VOXELS, MIN_SR_CONTEXT_DIM } from '../src/utils/svr/superResolutionTypes';
import { SVR_MEMORY_BUDGET_BYTES } from '../src/utils/svr/svrMemoryPlan';

const MIB = 1024 * 1024;
const TINY_CONTEXT = 33 ** 3;
type Entry = NonNullable<EnhancementImageCache['cachedImages']>[number];
const entry = (imageId: string, sizeMiB: number, timeStamp = 0, loaded = true): Entry => ({
  imageId,
  sizeInBytes: sizeMiB * MIB,
  timeStamp,
  loaded,
  imageLoadObject: {},
});
function imageCache(entries: Entry[]) {
  const cachedImages = [...entries];
  const getCacheInfo = vi.fn(() => ({
    cacheSizeInBytes: cachedImages.reduce((bytes, current) => bytes + current.sizeInBytes, 0),
    maximumSizeInBytes: 512 * MIB,
  }));
  const removeImageLoadObject = vi.fn((imageId: string) => {
    const index = cachedImages.findIndex((current) => current.imageId === imageId);
    if (index < 0) throw new Error('Image is no longer cached');
    cachedImages.splice(index, 1);
  });
  const getImageLoadObject = vi.fn((imageId: string) => {
    const current = cachedImages.find((candidate) => candidate.imageId === imageId);
    if (current) current.timeStamp = Date.now();
    return current?.imageLoadObject;
  });
  return { cachedImages, getCacheInfo, getImageLoadObject, removeImageLoadObject };
}
function selectedVolume() {
  const count = 48 ** 3;
  const volume: SvrVolume = {
    data: new Float32Array(count).fill(7),
    observedSupport: new Uint8Array(count).fill(1),
    dims: [48, 48, 48],
    voxelSizeMm: [1, 1, 1],
    originMm: [0, 0, 0],
    boundsMm: { min: [-0.5, -0.5, -0.5], max: [47.5, 47.5, 47.5] },
    intensityRange: [0, 8],
  };
  const labels: SvrLabelVolume = {
    dims: volume.dims,
    data: new Uint8Array(count),
    meta: [],
    reviewState: 'reviewed',
  };
  const selected = (24 * 48 + 24) * 48 + 24;
  labels.data[selected] = 1;
  return { volume, labels, selected };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('enhancement admission under retained workspace pressure', () => {
  it('distinguishes a genuinely oversized region from a resident floor that selection shrinking cannot fix', () => {
    expect(() => assertEnhancementFits(MAX_SR_OUTPUT_VOXELS / 8 + 1)).toThrow(/region is too large.*smaller region/i);
    const justBelowMinimumHeadroom = SVR_MEMORY_BUDGET_BYTES - enhancementWorkingBytes(MIN_SR_CONTEXT_DIM ** 3) + 1;
    expect(() => assertEnhancementFits(MIN_SR_CONTEXT_DIM ** 3, justBelowMinimumHeadroom)).toThrow(
      /open volume and working data.*even a small enhancement.*Load native detail for this selection/i,
    );
    expect(() => assertEnhancementFits(100 ** 3, 440 * MIB)).toThrow(/estimated.*smaller region/i);
  });

  it.each([1, MIN_SR_CONTEXT_DIM ** 3, 64 ** 3])(
    'does not discard cache when a %i-voxel region fails even without decoded cache',
    async (count) => {
      const cache = imageCache([entry('miradb:unused', 128)]);
      await expect(prepareEnhancementMemory(count, 490 * MIB, cache)).rejects.toThrow(
        /no room for even a small enhancement/i,
      );
      expect(cache.getCacheInfo).not.toHaveBeenCalled();
      expect(cache.removeImageLoadObject).not.toHaveBeenCalled();
    },
  );

  it.each([
    [0, 0],
    [NaN, 0],
    [1.5, 0],
    [TINY_CONTEXT, Infinity],
    [TINY_CONTEXT, -1],
    [MAX_SR_OUTPUT_VOXELS / 8 + 1, 0],
  ])('rejects invalid or oversized requests (%s, %s) before eviction or pixel allocation', async (count, retained) => {
    const cache = imageCache([entry('miradb:unused', 256)]);
    const allocations: unknown[] = [];
    vi.stubGlobal(
      'Float32Array',
      new Proxy(Float32Array, {
        construct(target, args, newTarget) {
          allocations.push(args[0]);
          return Reflect.construct(target, args, newTarget);
        },
      }),
    );
    await expect(prepareEnhancementMemory(count, retained, cache)).rejects.toThrow();
    expect(cache.getCacheInfo).not.toHaveBeenCalled();
    expect(cache.removeImageLoadObject).not.toHaveBeenCalled();
    expect(allocations).toEqual([]);
  });

  it('removes only the oldest completed MRI entries needed, preserving the configured cache limit', async () => {
    const cache = imageCache([
      entry('miradb:newest', 100, 30),
      entry('miraderived:oldest', 60, 10),
      entry('miradb:middle', 60, 20),
    ]);
    const yieldOnce = vi.fn(async () => undefined);
    vi.stubGlobal('scheduler', { yield: yieldOnce });
    await expect(prepareEnhancementMemory(TINY_CONTEXT, 300 * MIB, cache)).resolves.toBe(160 * MIB);
    expect(cache.removeImageLoadObject.mock.calls).toEqual([['miraderived:oldest']]);
    expect(cache.cachedImages.map((current) => current.imageId)).toEqual(['miradb:newest', 'miradb:middle']);
    expect(cache.getCacheInfo().maximumSizeInBytes).toBe(512 * MIB);
    expect(yieldOnce).toHaveBeenCalledTimes(1);
  });

  it('admits a tiny selection with the saved July overview geometry without reducing its native context', async () => {
    // Saved local corpus overview: 276 × 256 × 256. No source MRI buffers are allocated for this accounting check.
    const overviewVoxels = 276 * 256 * 256;
    const planePixels = 512 * 512;
    const acceptedBytes = overviewVoxels * 16 + planePixels * 7;
    const idleWorkerBytes = overviewVoxels * 5;
    const nativePlaneBytes = 32 * MIB + planePixels * 37;
    const retainedBytes = acceptedBytes + idleWorkerBytes + nativePlaneBytes;
    const cache = imageCache([
      entry('miradb:displayed', 32, 3),
      entry('miradb:older-slices', 64, 1),
      entry('miradb:recent-slices', 32, 2),
    ]);
    expect(() => assertEnhancementFits(TINY_CONTEXT, retainedBytes + 128 * MIB)).toThrow(
      /no room for even a small enhancement/i,
    );
    const decodedBytes = await prepareEnhancementMemory(
      TINY_CONTEXT,
      retainedBytes,
      cache,
      new Set(['miradb:displayed']),
    );
    expect(decodedBytes).toBe(64 * MIB);
    expect(retainedBytes + decodedBytes + enhancementWorkingBytes(TINY_CONTEXT)).toBeLessThanOrEqual(
      SVR_MEMORY_BUDGET_BYTES,
    );
    expect(cache.removeImageLoadObject.mock.calls).toEqual([['miradb:older-slices']]);
  });

  it('uses fresh total residency instead of subtracting advertised per-entry sizes', async () => {
    const cache = imageCache([entry('miradb:first', 100, 1), entry('miradb:second', 100, 2)]);
    let actualBytes = 220 * MIB;
    cache.getCacheInfo.mockImplementation(() => ({ cacheSizeInBytes: actualBytes, maximumSizeInBytes: 512 * MIB }));
    cache.removeImageLoadObject.mockImplementation(() => {
      actualBytes -= 30 * MIB;
    });
    await expect(prepareEnhancementMemory(TINY_CONTEXT, 300 * MIB, cache)).resolves.toBe(160 * MIB);
    expect(cache.removeImageLoadObject.mock.calls).toEqual([['miradb:first'], ['miradb:second']]);
    expect(cache.getCacheInfo).toHaveBeenCalledTimes(4);
  });

  it('does not evict or yield when all retained owners and decoded cache already fit', async () => {
    const cache = imageCache([entry('miradb:keep', 128)]);
    const yieldOnce = vi.fn(async () => undefined);
    vi.stubGlobal('scheduler', { yield: yieldOnce });
    await expect(prepareEnhancementMemory(TINY_CONTEXT, 300 * MIB, cache)).resolves.toBe(128 * MIB);
    expect(cache.removeImageLoadObject).not.toHaveBeenCalled();
    expect(cache.getCacheInfo).toHaveBeenCalledTimes(2);
    expect(yieldOnce).not.toHaveBeenCalled();
  });

  it('never evicts pending loads, displayed images, unrelated loaders, empty entries or unorderable metadata', async () => {
    const cache = imageCache([
      entry('miradb:displayed', 80, 1),
      entry('miraderived:displayed', 80, 2),
      entry('miradb:pending', 80, 3, false),
      entry('wadouri:unrelated', 40, 4),
      entry('miradb:empty', 0, 5),
      entry('miradb:unknown-age', 20, NaN),
      entry('miradb:idle', 24, 6),
    ]);
    const protectedIds = new Set(['miradb:displayed', 'miraderived:displayed']);
    await expect(prepareEnhancementMemory(TINY_CONTEXT, 300 * MIB, cache, protectedIds)).rejects.toThrow(
      /open volume and working data/i,
    );
    expect(cache.removeImageLoadObject.mock.calls).toEqual([['miradb:idle']]);
    expect(cache.cachedImages.map((current) => current.imageId)).toEqual([
      'miradb:displayed',
      'miraderived:displayed',
      'miradb:pending',
      'wadouri:unrelated',
      'miradb:empty',
      'miradb:unknown-age',
    ]);
  });

  it('rechecks live entry eligibility after another removal changes the cache', async () => {
    const cache = imageCache([entry('miradb:first', 60, 1), entry('miradb:now-pending', 160, 2)]);
    const remove = cache.removeImageLoadObject.getMockImplementation()!;
    cache.removeImageLoadObject.mockImplementation((imageId) => {
      remove(imageId);
      cache.cachedImages[0]!.loaded = false;
    });
    await expect(prepareEnhancementMemory(TINY_CONTEXT, 350 * MIB, cache)).rejects.toThrow();
    expect(cache.removeImageLoadObject.mock.calls).toEqual([['miradb:first']]);
  });

  it('resolves current displayed-image protection immediately before each removal', async () => {
    const cache = imageCache([
      entry('miradb:first', 60, 1),
      entry('miradb:becomes-displayed', 60, 2),
      entry('miradb:unused', 100, 3),
    ]);
    let protectedIds = new Set<string>();
    const remove = cache.removeImageLoadObject.getMockImplementation()!;
    cache.removeImageLoadObject.mockImplementation((imageId) => {
      remove(imageId);
      protectedIds = new Set(['miradb:becomes-displayed']);
    });
    await expect(prepareEnhancementMemory(TINY_CONTEXT, 350 * MIB, cache, () => protectedIds)).resolves.toBe(60 * MIB);
    expect(cache.removeImageLoadObject.mock.calls).toEqual([['miradb:first'], ['miradb:unused']]);
    expect(cache.cachedImages.map((current) => current.imageId)).toEqual(['miradb:becomes-displayed']);
  });

  it('does not evict a pending replacement under the same ID after a synchronous cache change', async () => {
    const cache = imageCache([entry('miradb:first', 60, 1), entry('miradb:replaced', 160, 2)]);
    const previousLoader = cache.cachedImages[1]!.imageLoadObject;
    const remove = cache.removeImageLoadObject.getMockImplementation()!;
    cache.removeImageLoadObject.mockImplementation((imageId) => {
      remove(imageId);
      cache.cachedImages[0] = entry('miradb:replaced', 160, 2, false);
    });
    await expect(prepareEnhancementMemory(TINY_CONTEXT, 350 * MIB, cache)).rejects.toThrow();
    expect(cache.removeImageLoadObject.mock.calls).toEqual([['miradb:first']]);
    expect(cache.cachedImages[0]!.loaded).toBe(false);
    expect(cache.cachedImages[0]!.imageLoadObject).not.toBe(previousLoader);
  });

  it.each(['lookup', 'identity'] as const)(
    'does not evict when current loader %s cannot be verified',
    async (missing) => {
      const cache: EnhancementImageCache = imageCache([entry('miradb:unknown', 220, 1)]);
      if (missing === 'lookup') cache.getImageLoadObject = undefined;
      else cache.cachedImages![0]!.imageLoadObject = undefined;
      await expect(prepareEnhancementMemory(TINY_CONTEXT, 300 * MIB, cache)).rejects.toThrow();
      expect(cache.removeImageLoadObject).not.toHaveBeenCalled();
    },
  );

  it.each(['missing', 'throwing', 'nonfinite'] as const)(
    'keeps a conservative cache reservation and avoids blind eviction with %s telemetry',
    async (mode) => {
      const cache: EnhancementImageCache = imageCache([entry('miradb:idle', 128)]);
      cache.getCacheInfo =
        mode === 'missing'
          ? undefined
          : () => {
              if (mode === 'throwing') throw new Error('No cache telemetry');
              return { cacheSizeInBytes: NaN };
            };
      await expect(prepareEnhancementMemory(TINY_CONTEXT, 256 * MIB, cache)).rejects.toThrow(
        /open volume and working data/i,
      );
      await expect(prepareEnhancementMemory(TINY_CONTEXT, 64 * MIB, cache)).resolves.toBe(256 * MIB);
      expect(cache.removeImageLoadObject).not.toHaveBeenCalled();
    },
  );

  it('fails closed on stale totals without blindly emptying the remaining cache', async () => {
    const cache = imageCache([entry('miradb:first', 60, 1), entry('miradb:keep', 160, 2)]);
    cache.getCacheInfo.mockReturnValue({ cacheSizeInBytes: 220 * MIB, maximumSizeInBytes: 512 * MIB });
    await expect(prepareEnhancementMemory(TINY_CONTEXT, 300 * MIB, cache)).rejects.toThrow();
    expect(cache.removeImageLoadObject.mock.calls).toEqual([['miradb:first']]);
    expect(cache.cachedImages.map((current) => current.imageId)).toEqual(['miradb:keep']);
  });

  it('does not assume memory was released when eviction fails', async () => {
    const cache = imageCache([entry('miradb:first', 60, 1), entry('miradb:keep', 160, 2)]);
    cache.removeImageLoadObject.mockImplementation(() => {
      throw new Error('Cache entry cannot be removed');
    });
    await expect(prepareEnhancementMemory(TINY_CONTEXT, 300 * MIB, cache)).rejects.toThrow();
    expect(cache.removeImageLoadObject.mock.calls).toEqual([['miradb:first']]);
    expect(cache.cachedImages).toHaveLength(2);
  });

  it('uses the fresh cache total after yielding, including any newly decoded images', async () => {
    const cache = imageCache([entry('miradb:first', 60, 1), entry('miradb:keep', 160, 2)]);
    vi.stubGlobal('scheduler', {
      yield: async () => {
        cache.cachedImages.push(entry('miradb:just-loaded', 60, 3));
      },
    });
    await expect(prepareEnhancementMemory(TINY_CONTEXT, 300 * MIB, cache)).rejects.toThrow();
    expect(cache.getCacheInfo().cacheSizeInBytes).toBe(220 * MIB);
    expect(cache.removeImageLoadObject.mock.calls).toEqual([['miradb:first']]);
  });

  it('honors cancellation before inspecting cache and after a reclamation yield', async () => {
    const cache = imageCache([entry('miradb:first', 60, 1), entry('miradb:keep', 160, 2)]);
    const before = new AbortController();
    before.abort();
    await expect(prepareEnhancementMemory(TINY_CONTEXT, 300 * MIB, cache, undefined, before.signal)).rejects.toThrow(
      /cancel/i,
    );
    expect(cache.getCacheInfo).not.toHaveBeenCalled();
    expect(cache.removeImageLoadObject).not.toHaveBeenCalled();
    const after = new AbortController();
    vi.stubGlobal('scheduler', { yield: async () => after.abort() });
    await expect(prepareEnhancementMemory(TINY_CONTEXT, 300 * MIB, cache, undefined, after.signal)).rejects.toThrow(
      /cancel/i,
    );
    expect(cache.removeImageLoadObject.mock.calls).toEqual([['miradb:first']]);
  });

  it('admits a small source crop after reclaiming only unused decoding while preserving MRI and labels', async () => {
    const { volume, labels, selected } = selectedVolume();
    const cache = imageCache([entry('miradb:displayed', 464, 2), entry('miradb:idle', 16, 1)]);
    const result = await cropEnhancementSource(volume, labels, {
      imageCache: cache,
      protectedImageIds: new Set(['miradb:displayed']),
    });
    expect(result.dims).toEqual([33, 33, 33]);
    expect(result.voxelSizeMm).toEqual([1, 1, 1]);
    expect(result.data.every((value) => value === 7)).toBe(true);
    expect(result.data.buffer).not.toBe(volume.data.buffer);
    expect(volume.data.every((value) => value === 7)).toBe(true);
    expect(labels.data.reduce((sum, value) => sum + value, 0)).toBe(1);
    expect(labels.data[selected]).toBe(1);
    expect(labels.reviewState).toBe('reviewed');
    expect(cache.removeImageLoadObject.mock.calls).toEqual([['miradb:idle']]);
  });

  it('protects images that become displayed while the selection bounds are being scanned', async () => {
    const { volume, labels } = selectedVolume();
    const cache = imageCache([
      entry('miradb:becomes-displayed', 16, 1),
      entry('miradb:idle', 16, 2),
      entry('miradb:displayed', 448, 3),
    ]);
    let protectedIds = new Set(['miradb:displayed']);
    vi.stubGlobal('scheduler', {
      yield: async () => {
        protectedIds = new Set(['miradb:displayed', 'miradb:becomes-displayed']);
      },
    });
    const result = await cropEnhancementSource(volume, labels, {
      imageCache: cache,
      protectedImageIds: () => protectedIds,
    });
    expect(result.dims).toEqual([33, 33, 33]);
    expect(cache.removeImageLoadObject.mock.calls).toEqual([['miradb:idle']]);
  });

  it.each([false, true])(
    'rechecks cache growth during source copying, preserving newly displayed images (protected: %s)',
    async (protectedNewImage) => {
      const { volume, labels } = selectedVolume();
      const cache = imageCache([entry('miradb:displayed', 464, 1)]);
      const protectedIds = new Set(['miradb:displayed']);
      let yields = 0;
      vi.stubGlobal('scheduler', {
        yield: async () => {
          // Six bounds-scan yields precede the first copying yield for this 48³ source.
          if (++yields === 7) {
            cache.cachedImages.push(entry('miradb:newly-loaded', 16, 2));
            if (protectedNewImage) protectedIds.add('miradb:newly-loaded');
          }
        },
      });
      const result = cropEnhancementSource(volume, labels, {
        imageCache: cache,
        protectedImageIds: () => protectedIds,
      });
      if (protectedNewImage) {
        await expect(result).rejects.toThrow(/no room for even a small enhancement/i);
        expect(cache.removeImageLoadObject).not.toHaveBeenCalled();
      } else {
        expect((await result).dims).toEqual([33, 33, 33]);
        expect(cache.removeImageLoadObject.mock.calls).toEqual([['miradb:newly-loaded']]);
      }
      expect(volume.data.every((value) => value === 7)).toBe(true);
      expect(labels.data.reduce((sum, value) => sum + value, 0)).toBe(1);
    },
  );
});
