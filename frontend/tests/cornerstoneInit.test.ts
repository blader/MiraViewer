import { describe, it, expect, vi, beforeEach } from 'vitest';

const sources = vi.hoisted(() => ({
  instance: vi.fn(),
  derived: vi.fn(),
  decoded: vi.fn(),
}));

vi.mock('cornerstone-core', () => ({
  default: {
    registerImageLoader: vi.fn(),
    loadImage: vi.fn(),
  },
}));

vi.mock('cornerstone-tools', () => ({
  default: {
    init: vi.fn(),
    external: {},
  },
}));

vi.mock('cornerstone-wado-image-loader', () => ({
  default: {
    external: {},
    wadouri: { fileManager: { add: vi.fn() } },
    webWorkerManager: { initialize: vi.fn() },
  },
}));

vi.mock('cornerstone-math', () => ({ default: {} }));
vi.mock('hammerjs', () => ({ default: {} }));
vi.mock('dicom-parser', () => ({ default: {} }));
vi.mock('../src/db/db', () => ({ getDB: async () => ({ get: sources.instance }) }));
vi.mock('../src/utils/derivedAlignmentFrame', () => ({ getDerivedAlignmentFrameByImageId: sources.derived }));
vi.mock('../src/utils/decodedFrame', () => ({ loadCornerstoneImage: sources.decoded }));

import cornerstone from 'cornerstone-core';
import cornerstoneTools from 'cornerstone-tools';
import cornerstoneWADOImageLoader from 'cornerstone-wado-image-loader';
import { initCornerstone } from '../src/utils/cornerstoneInit';
import { buildOutputPlaneGrid } from '../src/utils/outputPlaneGrid';

describe('cornerstoneInit', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('initializes once while preserving native padding and authoritative derived physical geometry', async () => {
    initCornerstone();
    initCornerstone();
    expect(cornerstone.registerImageLoader).toHaveBeenCalledTimes(2);
    expect(cornerstone.registerImageLoader).toHaveBeenCalledWith('miradb', expect.any(Function));
    expect(cornerstone.registerImageLoader).toHaveBeenCalledWith('miraderived', expect.any(Function));
    expect(cornerstoneTools.init).toHaveBeenCalledTimes(1);
    expect(cornerstoneWADOImageLoader.webWorkerManager.initialize).toHaveBeenCalledWith(
      expect.objectContaining({
        maxWebWorkers: expect.any(Number),
        startWebWorkersOnDemand: true,
        taskConfiguration: { decodeTask: { initializeCodecsOnStartup: false, strict: false } },
      }),
    );

    const registered = vi.mocked(cornerstone.registerImageLoader).mock.calls;
    const nativeLoader = registered.find(([scheme]) => scheme === 'miradb')![1];
    const nativeImage = { rowPixelSpacing: 0.7, columnPixelSpacing: 0.7 };
    sources.instance.mockResolvedValue({
      fileBlob: new Blob(['native pixels']),
      pixelPaddingValue: -2048,
      pixelPaddingRangeLimit: -2000,
    });
    vi.mocked(cornerstoneWADOImageLoader.wadouri.fileManager.add).mockReturnValue('dicomfile:0');
    vi.mocked(cornerstone.loadImage).mockResolvedValue(nativeImage as never);

    expect(await nativeLoader('miradb:native-frame').promise).toBe(nativeImage);
    expect(nativeImage).toMatchObject({ pixelPaddingValue: -2048, pixelPaddingRangeLimit: -2000 });

    const outputGrid = buildOutputPlaneGrid({
      rows: 4,
      columns: 6,
      imagePositionPatient: '10\\20\\30',
      imageOrientationPatient: '1\\0\\0\\0\\1\\0',
      pixelSpacing: '0.4\\0.8',
    });
    const derivedPixels = new Float32Array(24).fill(12);
    derivedPixels[0] = 0;
    const derivedSupport = new Uint8Array(24).fill(1);
    derivedSupport[0] = 0;
    sources.derived.mockReturnValue({
      rows: 4,
      columns: 6,
      pixels: derivedPixels,
      valid: derivedSupport,
      sourceImageId: 'miradb:native-frame',
      outputGrid,
    });
    sources.decoded.mockResolvedValue(nativeImage);
    const derivedLoader = registered.find(([scheme]) => scheme === 'miraderived')![1];

    const derived = await derivedLoader('miraderived:verified').promise;
    expect(derived.rowPixelSpacing).toBeCloseTo(0.4, 10);
    expect(derived.columnPixelSpacing).toBeCloseTo(0.8, 10);
    expect(derived).toMatchObject({
      minPixelValue: 12,
      maxPixelValue: 12,
      imagePositionPatient: [10, 20, 30],
      imageOrientationPatient: [1, 0, 0, 0, 1, 0],
    });
  });
});
