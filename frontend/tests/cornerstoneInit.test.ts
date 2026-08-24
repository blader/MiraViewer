import { describe, it, expect, vi, beforeEach } from 'vitest';

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

import cornerstone from 'cornerstone-core';
import cornerstoneTools from 'cornerstone-tools';
import cornerstoneWADOImageLoader from 'cornerstone-wado-image-loader';
import { initCornerstone } from '../src/utils/cornerstoneInit';

describe('cornerstoneInit', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('registers image loader and initializes tools once', () => {
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
  });
});
