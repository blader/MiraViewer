import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DerivedAlignmentFramePresentation } from '../src/db/schema';
import type { AlignmentResult } from '../src/types/api';
import { DEFAULT_PANEL_SETTINGS } from '../src/utils/constants';
import { buildOutputPlaneGrid } from '../src/utils/outputPlaneGrid';

const load = vi.hoisted(() => vi.fn());
vi.mock('../src/utils/decodedFrame', () => ({ loadCornerstoneImage: load }));
import { createDerivedImagePresentation } from '../src/utils/derivedImagePresentation';

function original(): DerivedAlignmentFramePresentation {
  return {
    pixels: Float32Array.from([0, 10, 30, 100, -1000, 50]),
    valid: Uint8Array.from([1, 1, 1, 1, 0, 1]),
    rows: 2,
    columns: 3,
    sourceImageId: 'miradb:synthetic-moving',
    outputGrid: buildOutputPlaneGrid({
      rows: 2,
      columns: 3,
      imagePositionPatient: '10\\20\\30',
      imageOrientationPatient: '1\\0\\0\\0\\1\\0',
      pixelSpacing: '0.4\\0.8',
    }),
  };
}

const source = {
  windowCenter: 50,
  windowWidth: 100,
  invert: true,
  cachedLut: { lutArray: Uint8Array.from([1, 2]) },
  modalityLUT: { lut: [1, 2] },
  voiLUT: { lut: [2, 3] },
};

beforeEach(() => load.mockReset().mockResolvedValue(source));

describe('derived image presentation', () => {
  it('overlays supported predictions without altering source geometry, masks, polarity, or arrays', async () => {
    const frame = original();
    const pixelsBefore = frame.pixels.slice();
    const supportBefore = frame.valid!.slice();
    const pixels = Float32Array.from([20, 12, Number.NaN, 200, 100, 80]);
    const valid = Uint8Array.from([1, 0, 1, 1, 1, 0]);
    const replacementBefore = pixels.slice();
    const packet = {
      ...frame,
      acceptedResult: {
        date: 'synthetic-date',
        seriesUid: 'synthetic-series',
        bestSliceIndex: 0,
        nmiScore: 1,
        computedSettings: DEFAULT_PANEL_SETTINGS,
        slicesChecked: 1,
        outcome: 'aligned',
        derivedFrame: frame,
      } satisfies AlignmentResult,
    };
    const image = await createDerivedImagePresentation(packet, 'sharp:synthetic', {
      pixels,
      valid,
      rows: 2,
      columns: 3,
    });

    expect(image).toMatchObject({
      imageId: 'sharp:synthetic',
      rows: 2,
      columns: 3,
      rowPixelSpacing: expect.closeTo(0.4, 10),
      columnPixelSpacing: expect.closeTo(0.8, 10),
      imagePositionPatient: [10, 20, 30],
      imageOrientationPatient: [1, 0, 0, 0, 1, 0],
      windowCenter: 50,
      windowWidth: 100,
      invert: true,
      pixelPaddingValue: 0,
      pixelPaddingRangeLimit: 0,
    });
    const displayed = image.getPixelData();
    expect(image.derivedSource).toBeInstanceOf(WeakRef);
    expect(image.derivedSource.deref()).toBe(frame);
    for (const [index, expected] of [
      [0, 20],
      [1, 10],
      [2, 30],
      [3, 200],
      [5, 50],
    ]) {
      expect(displayed[index]! * image.slope + image.intercept).toBeCloseTo(expected!, 2);
    }
    expect(displayed[4]).toBe(0);
    expect(image.cachedLut).toBeUndefined();
    expect(image.modalityLUT).toBeUndefined();
    expect(image.voiLUT).toBeUndefined();
    expect(source.cachedLut.lutArray).toEqual(Uint8Array.from([1, 2]));
    expect(frame.pixels).toEqual(pixelsBefore);
    expect(frame.valid).toEqual(supportBefore);
    expect(pixels).toEqual(replacementBefore);
    expect(valid).toEqual(Uint8Array.from([1, 0, 1, 1, 1, 0]));
  });

  it('anchors fallback windowing and quantization to the original, not sharpened extrema', async () => {
    load.mockResolvedValue({ windowCenter: Number.NaN, windowWidth: 0 });
    const frame = original();
    const baseline = await createDerivedImagePresentation(frame, 'original');
    const sharp = await createDerivedImagePresentation(frame, 'sharp', {
      pixels: Float32Array.from([40, 45, 50, 60, 0, 55]),
      valid: new Uint8Array(6).fill(1),
      rows: 2,
      columns: 3,
    });
    for (const key of ['windowCenter', 'windowWidth', 'slope', 'intercept'] as const) {
      expect(sharp[key]).toBe(baseline[key]);
    }
    expect(sharp.windowCenter).toBe(50);
    expect(sharp.windowWidth).toBe(100);
    expect(sharp.getPixelData()[0]).toBeGreaterThan(1);
    expect(sharp.getPixelData()[3]).toBeLessThan(65_535);
  });

  it.each([false, true])(
    'retains current-reference VOI and polarity for calibrated replacements: %s',
    async (invert) => {
      const frame = original();
      frame.referenceSopInstanceUid = 'synthetic-reference';
      frame.displayTone = {
        windowCenter: 50,
        windowWidth: 100,
        source: [0.25, 0.5, 0.75],
        reference: [0.25, 0.5, 0.75],
        referenceWindow: { windowCenter: 100, windowWidth: 200 },
      };
      const toneBefore = JSON.stringify(frame.displayTone);
      load.mockImplementation(async (id: string) =>
        id === frame.sourceImageId ? { ...source, invert: !invert } : { windowCenter: 200, windowWidth: 400, invert },
      );
      const baseline = await createDerivedImagePresentation(frame, 'original');
      const sharp = await createDerivedImagePresentation(frame, 'sharp', {
        pixels: frame.pixels.slice(),
        valid: new Uint8Array(6).fill(1),
        rows: 2,
        columns: 3,
      });
      expect(sharp.invert).toBe(invert);
      expect(sharp.windowCenter).toBe(baseline.windowCenter);
      expect(sharp.windowWidth).toBe(baseline.windowWidth);
      expect(sharp.getPixelData()).toEqual(baseline.getPixelData());
      expect(sharp.getPixelData()[4]).toBe(0);
      expect(load).toHaveBeenCalledWith('miradb:synthetic-reference');
      expect(JSON.stringify(frame.displayTone)).toBe(toneBefore);
    },
  );

  it.each([
    { rows: 3, columns: 2, pixels: new Float32Array(6), valid: new Uint8Array(6) },
    { rows: 2, columns: 3, pixels: new Float32Array(5), valid: new Uint8Array(6) },
    { rows: 2, columns: 3, pixels: new Float32Array(6), valid: new Uint8Array(5) },
  ])('rejects malformed replacement geometry before loading MRI: %j', async (replacement) => {
    await expect(createDerivedImagePresentation(original(), 'sharp', replacement)).rejects.toThrow(
      /original aligned plane/,
    );
    expect(load).not.toHaveBeenCalled();
  });

  it('stops a cancelled conversion before loading the reference or allocating presentation pixels', async () => {
    const controller = new AbortController();
    const frame = original();
    frame.referenceSopInstanceUid = 'synthetic-reference';
    frame.displayTone = {
      windowCenter: 50,
      windowWidth: 100,
      source: [0.25, 0.75],
      reference: [0.25, 0.75],
      referenceWindow: { windowCenter: 50, windowWidth: 100 },
    };
    load.mockImplementation(async () => {
      controller.abort();
      return source;
    });
    await expect(createDerivedImagePresentation(frame, 'sharp', undefined, controller.signal)).rejects.toMatchObject({
      name: 'AbortError',
    });
    expect(load).toHaveBeenCalledOnce();
  });
});
