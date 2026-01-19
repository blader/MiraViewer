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
  },
}));

vi.mock('cornerstone-math', () => ({ default: {} }));
vi.mock('hammerjs', () => ({ default: {} }));
vi.mock('dicom-parser', () => ({ default: {} }));

import cornerstone from 'cornerstone-core';
import cornerstoneTools from 'cornerstone-tools';
import { initCornerstone } from '../src/utils/cornerstoneInit';

describe('cornerstoneInit', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('registers image loader and initializes tools once', () => {
    initCornerstone();
    initCornerstone();
    expect(cornerstone.registerImageLoader).toHaveBeenCalledTimes(1);
    expect(cornerstoneTools.init).toHaveBeenCalledTimes(1);
  });
});
