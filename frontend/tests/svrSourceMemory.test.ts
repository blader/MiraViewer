import { describe, expect, it } from 'vitest';
import { DEFAULT_SVR_PARAMS } from '../src/types/svr';
import type { SeriesFrameManifest } from '../src/utils/localApi';
import { estimateSvrSourceMemory, SVR_SOURCE_PREFETCH_LIMIT } from '../src/utils/svr/sourceMemory';
import { CORNERSTONE_MEMORY_FALLBACK_BYTES, measureCornerstoneImageMemory } from '../src/utils/cornerstoneMemory';

function manifest(rows = 4, columns = 4, count = 2): SeriesFrameManifest {
  return {
    seriesUid: 'source',
    patientKey: 'patient',
    studyUid: 'study',
    frameOfReferenceUid: 'frame',
    geometryReliable: true,
    ordering: 'physical',
    frames: Array.from({ length: count }, (_, index) => ({
      seriesInstanceUid: 'source',
      sopInstanceUid: `source-${index}`,
      studyInstanceUid: 'study',
      instanceNumber: index,
      frameOfReferenceUid: 'frame',
      rows,
      columns,
      dicomByteLength: rows * columns * 2,
      imagePositionPatient: `0\\0\\${index}`,
      imageOrientationPatient: '1\\0\\0\\0\\1\\0',
      pixelSpacing: '1\\1',
      sliceThickness: 1,
    })),
  };
}
const params = {
  ...DEFAULT_SVR_PARAMS,
  sliceDownsampleMode: 'fixed' as const,
  sliceDownsampleMaxSize: 2,
  seriesRegistrationMode: 'none' as const,
  maxVolumeDim: 64,
};

describe('shared SVR source-copy memory authority', () => {
  it('counts each admitted frame geometry instead of assuming the first frame size', () => {
    const source = manifest();
    source.frames[1]!.columns = 8;
    const plan = estimateSvrSourceMemory([source], params, {
      cacheInfo: { cacheSizeInBytes: 32, maximumSizeInBytes: 1024 },
    });
    expect(plan.sourceBytes).toBe((2 * 2 + 1 * 2) * 5);
    expect(plan.decodedSourceCacheBytes).toBe(32);
    expect(plan.sourceDecodeBytes).toBe((4 * 4 + 4 * 8) * 4 * 2);
  });

  it('budgets source pixels at native pitch after inverse-mapping the accepted regional pose', () => {
    const source = manifest(100, 100, 4);
    const transform = { rotation: [1, 0, 0, 0, 1, 0, 0, 0, 1] as const, translationMm: [100, 100, 100] as const };
    const plan = estimateSvrSourceMemory([source], params, {
      roi: { mode: 'cube', sourcePlane: 'axial', boundsMm: { min: [150, 150, 101], max: [152, 152, 102] } },
      acceptedSourceTransforms: { source: transform },
      cacheInfo: { cacheSizeInBytes: 0, maximumSizeInBytes: 32 * 1024 * 1024 },
    });
    expect(plan.sourceBytes).toBe(4 * 7 * 7 * 5);
    expect(plan.decodedSourceCacheBytes).toBe(0);
    expect(plan.sourceDecodeBytes).toBe(4 * 100 * 100 * 4 * 2);
  });

  it('never shrinks measured cache residency to a smaller configured cap or invents free missing telemetry', () => {
    const source = manifest();
    expect(
      estimateSvrSourceMemory([source], params, { cacheInfo: { cacheSizeInBytes: 1024, maximumSizeInBytes: 512 } })
        .decodedSourceCacheBytes,
    ).toBe(1024);
    expect(estimateSvrSourceMemory([source], params).decodedSourceCacheBytes).toBe(256 * 1024 * 1024);
    expect(
      estimateSvrSourceMemory([source], params, { cacheInfo: { cacheSizeInBytes: NaN, maximumSizeInBytes: Infinity } })
        .decodedSourceCacheBytes,
    ).toBe(256 * 1024 * 1024);
  });

  it('keeps measured parsed/displayed owners separate from the bounded processing batch', () => {
    const pixels = new Uint8Array(8),
      dataset = new Uint8Array(23);
    const current = { getPixelData: () => pixels, data: { byteArray: dataset } };
    const displayPixels = new Uint8Array(4),
      displayDataset = new Uint8Array(7);
    const displayed = { getPixelData: () => displayPixels, data: { byteArray: displayDataset } };
    const imageCache = {
      cachedImages: [{ image: current, loaded: true, sizeInBytes: pixels.byteLength }],
      getCacheInfo: () => ({ cacheSizeInBytes: 8, maximumSizeInBytes: 128 }),
    };
    const sources = manifest();
    sources.frames[0]!.dicomByteLength = 1; // A compressed file cannot reduce the native pixel-storage floor.
    sources.frames[1]!.dicomByteLength = 200;
    const cacheMemory = measureCornerstoneImageMemory({ imageCache, getEnabledElements: () => [{ image: displayed }] });
    const plan = estimateSvrSourceMemory([sources], params, { cacheMemory });
    expect(plan.decodedSourceCacheBytes).toBe(8 + 23 + 4 + 7);
    expect(plan.sourceDecodeBytes).toBe(64 + 64 + 64 + 200);
    const opaque = measureCornerstoneImageMemory({ imageCache });
    expect(estimateSvrSourceMemory([sources], params, { cacheMemory: opaque }).decodedSourceCacheBytes).toBe(
      CORNERSTONE_MEMORY_FALLBACK_BYTES + 23,
    );
    expect(current.getPixelData()).toBe(pixels);
    expect(current.data.byteArray).toBe(dataset);
  });

  it('does not cap encoded-source retention at a pixel-cache limit', () => {
    const source = manifest(4, 4, 1);
    source.frames[0]!.dicomByteLength = 4096;
    expect(
      estimateSvrSourceMemory([source], params, {
        cacheInfo: { cacheSizeInBytes: 0, maximumSizeInBytes: 8 },
      }).sourceDecodeBytes,
    ).toBe(64 + 4096);
  });

  it.each([undefined, NaN, -1, Infinity])('keeps the conservative forecast when source file size is %s', (size) => {
    const source = manifest(4, 4, 1);
    source.frames[0]!.dicomByteLength = size;
    expect(
      estimateSvrSourceMemory([source], params, {
        cacheInfo: { cacheSizeInBytes: 0, maximumSizeInBytes: 128 },
      }).sourceDecodeBytes,
    ).toBe(CORNERSTONE_MEMORY_FALLBACK_BYTES);
  });

  it('bounds transient raw/parsed owners independently of stack length and sequential source count', () => {
    const short = estimateSvrSourceMemory([manifest(4, 4, 5)], params);
    const long = estimateSvrSourceMemory([manifest(4, 4, 500)], params);
    const sequential = estimateSvrSourceMemory([manifest(4, 4, 500), manifest(4, 4, 500)], params);
    expect(short.sourceDecodeBytes).toBe((SVR_SOURCE_PREFETCH_LIMIT + 1) * 16 * 8);
    expect(long.sourceDecodeBytes).toBe(short.sourceDecodeBytes);
    expect(sequential.sourceDecodeBytes).toBe(short.sourceDecodeBytes);
    expect(long.sourceBytes).toBe(short.sourceBytes * 100);
    expect(sequential.sourceBytes).toBe(long.sourceBytes * 2);
  });
});
