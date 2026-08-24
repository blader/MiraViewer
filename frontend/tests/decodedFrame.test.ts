import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getImageIdForInstance: vi.fn(),
  loadImage: vi.fn(),
  loadAndCacheImage: vi.fn(),
}));

vi.mock('../src/utils/localApi', () => ({
  getImageIdForInstance: mocks.getImageIdForInstance,
}));

vi.mock('cornerstone-core', () => ({
  default: {
    loadImage: mocks.loadImage,
    loadAndCacheImage: mocks.loadAndCacheImage,
  },
}));

import {
  decodeImageWithValidity,
  getDecodedFrame,
  loadCornerstoneImage,
  resampleDecodedImage,
} from '../src/utils/decodedFrame';

describe('canonical decoded DICOM frames', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getImageIdForInstance.mockResolvedValue('miradb:instance-1');
  });

  it('uses the bounded Cornerstone image cache for interactive and algorithmic reads', async () => {
    const image = { imageId: 'miradb:instance-1' };
    mocks.loadAndCacheImage.mockResolvedValue(image);

    await expect(loadCornerstoneImage('miradb:instance-1')).resolves.toBe(image);
    expect(mocks.loadAndCacheImage).toHaveBeenCalledWith('miradb:instance-1');
    expect(mocks.loadImage).not.toHaveBeenCalled();
  });

  it('preserves signed 16-bit precision and applies modality slope/intercept before analysis', async () => {
    mocks.loadAndCacheImage.mockResolvedValue({
      imageId: 'miradb:instance-1',
      rows: 2,
      columns: 2,
      slope: 2,
      intercept: -1024,
      rowPixelSpacing: 0.75,
      columnPixelSpacing: 0.5,
      getPixelData: () => new Int16Array([-100, 0, 512, 2047]),
    });

    const frame = await getDecodedFrame('series-1', 3);

    expect(Array.from(frame.pixels)).toEqual([-1224, -1024, 0, 3070]);
    expect(frame).toMatchObject({
      rows: 2,
      cols: 2,
      imageId: 'miradb:instance-1',
      seriesUid: 'series-1',
      sopInstanceUid: 'instance-1',
      rowSpacingMm: 0.75,
      colSpacingMm: 0.5,
    });
  });

  it.each(['area', 'lanczos3'] as const)(
    '%s-downsamples decoded modality values without an 8-bit display or a DOM canvas',
    (kernel) => {
      const image = {
        rows: 2,
        columns: 2,
        slope: 0.5,
        intercept: 100,
        getPixelData: () => new Uint16Array([1000, 2000, 3000, 4000]),
      };

      const result = resampleDecodedImage(image, 1, 1, kernel);

      expect(Array.from(result)).toEqual([1350]);
      expect(document.querySelector('canvas')).toBeNull();
    },
  );

  it('excludes declared padding before modality scaling and never averages it into adjacent anatomy', () => {
    const image = {
      rows: 1,
      columns: 4,
      pixelPaddingValue: -2000,
      slope: 2,
      intercept: 1000,
      getPixelData: () => new Int16Array([-2000, 100, 100, 100]),
    };

    const result = decodeImageWithValidity(image, 1, 2);

    expect(Array.from(result.pixels)).toEqual([1200, 1200]);
    expect(Array.from(result.validity)).toEqual([0.5, 1]);
    expect(Array.from(resampleDecodedImage(image, 1, 2))).toEqual([1200, 1200]);
  });

  it('respects inclusive stored-domain padding ranges without treating legitimate zero or negative anatomy as invalid', () => {
    const image = {
      rows: 1,
      columns: 5,
      pixelPaddingValue: -2000,
      pixelPaddingRangeLimit: -1998,
      slope: -2,
      intercept: 100,
      getPixelData: () => new Int16Array([-2000, -1999, -1998, -1, 0]),
    };

    const result = decodeImageWithValidity(image, 1, 5);

    expect(Array.from(result.validity)).toEqual([0, 0, 0, 1, 1]);
    expect(Array.from(result.pixels)).toEqual([0, 0, 0, 102, 100]);
  });

  it('preserves explicit validity on full-resolution decoded frames', async () => {
    mocks.loadAndCacheImage.mockResolvedValue({
      imageId: 'miradb:instance-1',
      rows: 1,
      columns: 3,
      pixelPaddingValue: -2000,
      getPixelData: () => new Int16Array([-2000, 0, -3]),
    });

    const frame = await getDecodedFrame('series-1', 0);

    expect(Array.from(frame.validity)).toEqual([0, 1, 1]);
    expect(Array.from(frame.pixels)).toEqual([0, 0, -3]);
  });
});
