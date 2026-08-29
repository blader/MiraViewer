export const CORNERSTONE_MEMORY_FALLBACK_BYTES = 256 * 1024 * 1024;

export type CornerstoneCacheInfo = {
  cacheSizeInBytes?: number;
  maximumSizeInBytes?: number;
  numberOfImagesCached?: number;
};

export type CornerstoneMemorySource = {
  imageCache?: {
    getCacheInfo?: () => CornerstoneCacheInfo;
    cachedImages?: readonly { image?: unknown; loaded?: boolean; sizeInBytes?: number }[];
  };
  getEnabledElements?: () => readonly { image?: unknown }[];
};

export type CornerstoneImageMemory = {
  bytes: number;
  measured: boolean;
  cacheInfo?: CornerstoneCacheInfo;
  /** Cache-occupancy counter already covered, including an opaque-telemetry reserve; not another live owner. */
  reservedPixelCacheBytes: number;
};

/** Distinct CPU buffers retained by cached OR displayed images, including full backing allocations of subviews. */
export function measureCornerstoneImageMemory(source: CornerstoneMemorySource = {}): CornerstoneImageMemory {
  const buffers = new Set<ArrayBufferLike>();
  const cachedPixelBytes = new Map<ArrayBufferLike, number>();
  const images = new Map<object, boolean>();
  let measured = true;
  // Inspect only known own data properties; never walk arbitrary parser objects or invoke property accessors.
  const own = (value: unknown, key: string): unknown => {
    if (!value || (typeof value !== 'object' && typeof value !== 'function')) return undefined;
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor && !('value' in descriptor)) measured = false;
    return descriptor?.value;
  };
  let cacheInfo: CornerstoneCacheInfo | undefined;
  let knownCacheCounter = 0;
  const cache = source.imageCache;
  try {
    cacheInfo = cache?.getCacheInfo?.();
    if (!Number.isFinite(cacheInfo?.cacheSizeInBytes) || cacheInfo!.cacheSizeInBytes! < 0) measured = false;
  } catch {
    measured = false;
  }
  const entries = cache?.cachedImages;
  if (!Array.isArray(entries)) measured = false;
  else {
    for (const entry of entries) {
      const image = own(entry, 'image');
      if (!image || typeof image !== 'object') {
        measured = false;
        continue;
      }
      images.set(image, true);
      const size = own(entry, 'sizeInBytes');
      if (typeof size === 'number' && Number.isFinite(size) && size >= 0) knownCacheCounter += size;
    }
    if (Number.isFinite(cacheInfo?.cacheSizeInBytes) && cacheInfo!.cacheSizeInBytes! > knownCacheCounter)
      measured = false;
    if (Number.isFinite(cacheInfo?.numberOfImagesCached) && cacheInfo!.numberOfImagesCached! !== entries.length)
      measured = false;
  }
  try {
    const enabled = source.getEnabledElements?.();
    if (!Array.isArray(enabled)) measured = false;
    else
      for (const element of enabled) {
        const image = own(element, 'image');
        if (image && typeof image === 'object' && !images.has(image)) images.set(image, false);
      }
  } catch {
    measured = false;
  }

  const add = (value: unknown, primaryCachedPixel = false) => {
    if (value === undefined || value === null) return false;
    if (!ArrayBuffer.isView(value)) {
      measured = false;
      return false;
    }
    buffers.add(value.buffer);
    if (primaryCachedPixel)
      cachedPixelBytes.set(value.buffer, Math.max(cachedPixelBytes.get(value.buffer) ?? 0, value.byteLength));
    return true;
  };
  for (const [image, cached] of images) {
    const getPixels = own(image, 'getPixelData');
    try {
      if (typeof getPixels !== 'function' || !add(getPixels.call(image), cached)) measured = false;
    } catch {
      measured = false;
    }
    const frame = own(image, 'imageFrame');
    add(own(frame, 'pixelData'));
    add(own(own(frame, 'imageData'), 'data'));
    add(own(image, 'floatPixelData'));
    add(own(own(image, 'data'), 'byteArray'));
    for (const key of ['cachedLut', 'modalityLUT', 'voiLUT']) add(own(own(image, key), 'lut'));
  }
  const total = (values: Set<ArrayBufferLike>) => [...values].reduce((sum, buffer) => sum + buffer.byteLength, 0);
  const knownBytes = total(buffers);
  const reported = cacheInfo?.cacheSizeInBytes;
  const reportedPixelBytes = Number.isFinite(reported) && reported! >= 0 ? reported! : 0;
  const reservedPixelCacheBytes = measured
    ? reportedPixelBytes
    : Math.max(reportedPixelBytes, CORNERSTONE_MEMORY_FALLBACK_BYTES);
  // The fallback replaces the known cached-pixel portion, not the parsed/displayed buffers beside it.
  const logicalCachedPixels = [...cachedPixelBytes.values()].reduce((sum, bytes) => sum + bytes, 0);
  const bytes = knownBytes + (measured ? 0 : Math.max(0, reservedPixelCacheBytes - logicalCachedPixels));
  return { bytes, measured, cacheInfo, reservedPixelCacheBytes };
}
