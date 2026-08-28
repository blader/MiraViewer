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
      minPixelValue: 1,
      maxPixelValue: 1,
      slope: 1,
      intercept: 11,
      imagePositionPatient: [10, 20, 30],
      imageOrientationPatient: [1, 0, 0, 0, 1, 0],
    });

    Object.assign(nativeImage, {
      cachedLut: { lutArray: new Uint8ClampedArray(2) },
      modalityLUT: { lut: [100, 200], firstValueMapped: 0 },
      voiLUT: { lut: [0, 255], firstValueMapped: 0 },
      invert: true,
    });
    const displayDerivedPixels = (pixels: Float32Array, valid = new Uint8Array(pixels.length).fill(1)) =>
      sources.derived.mockReturnValue({
        rows: 2,
        columns: 3,
        pixels,
        valid,
        sourceImageId: 'miradb:native-frame',
      });
    const fractionalPixels = Float32Array.from([-100_000, -48.75, -12.125, 3.5, 23.875, 91.625]);
    const fractionalSupport = Uint8Array.from([0, 1, 1, 1, 1, 1]);
    displayDerivedPixels(fractionalPixels, fractionalSupport);

    const fractional = await derivedLoader('miraderived:fractional').promise;
    const presentationPixels = fractional.getPixelData();

    expect(presentationPixels).toBeInstanceOf(Uint16Array);
    expect(presentationPixels[0]).toBe(0);
    expect(presentationPixels[1]).toBe(1);
    expect(presentationPixels[5]).toBe(65_535);
    expect(fractional).toMatchObject({
      minPixelValue: 1,
      maxPixelValue: 65_535,
      pixelPaddingValue: 0,
      pixelPaddingRangeLimit: 0,
      sizeInBytes: presentationPixels.byteLength,
      invert: true,
    });
    expect(fractional.cachedLut).toBeUndefined();
    expect(fractional.modalityLUT).toBeUndefined();
    expect(fractional.voiLUT).toBeUndefined();
    for (let index = 1; index < fractionalPixels.length; index++) {
      expect(presentationPixels[index] * fractional.slope + fractional.intercept).toBeCloseTo(
        fractionalPixels[index]!,
        2,
      );
    }
    expect(fractionalPixels[0]).toBe(-100_000);

    const actualCornerstone = (await vi.importActual<{ default: typeof cornerstone }>('cornerstone-core')).default;
    const renderImageLuminance = (image: typeof fractional, invert: boolean): number[] => {
      image.stats = {};
      const lut = actualCornerstone.generateLut(image, image.windowWidth, image.windowCenter, invert);
      const rgba = new Uint8ClampedArray(image.getPixelData().length * 4).fill(255);
      actualCornerstone.storedPixelDataToCanvasImageData(image, lut, rgba);
      return Array.from(rgba).filter((_value, index) => index % 4 === 3);
    };

    const normalLuminance = renderImageLuminance(fractional, false);
    expect(normalLuminance[0]).toBe(0);
    expect(normalLuminance[2]).toBeGreaterThan(0);
    expect(normalLuminance[3]).toBeGreaterThan(normalLuminance[2]!);
    expect(normalLuminance[4]).toBeGreaterThan(normalLuminance[3]!);
    expect(normalLuminance[5]).toBe(255);

    const invertedLuminance = renderImageLuminance(fractional, true);
    expect(invertedLuminance[0]).toBe(0);
    expect(invertedLuminance[1]).toBe(255);
    expect(invertedLuminance[2]).toBeGreaterThan(invertedLuminance[3]!);

    derived.stats = {};
    const constantLut = actualCornerstone.generateLut(derived, derived.windowWidth, derived.windowCenter, false);
    const constantRgba = new Uint8ClampedArray(derived.getPixelData().length * 4).fill(255);
    actualCornerstone.storedPixelDataToCanvasImageData(derived, constantLut, constantRgba);
    expect(constantRgba[3]).toBe(0);
    expect(constantRgba[7]).toBe(128);

    Object.assign(nativeImage, { windowCenter: 50, windowWidth: 100, invert: false });
    displayDerivedPixels(Float32Array.from([0, 25, 50, 75, 100, 10_000]));
    const windowed = await derivedLoader('miraderived:native-window').promise;
    expect(windowed).toMatchObject({ windowCenter: 50, windowWidth: 100 });
    const windowedLuminance = renderImageLuminance(windowed, false);
    expect(windowedLuminance[0]).toBe(0);
    expect(windowedLuminance[1]).toBeGreaterThan(50);
    expect(windowedLuminance[2]).toBeGreaterThan(110);
    expect(windowedLuminance[3]).toBeGreaterThan(170);
    expect(windowedLuminance[4]).toBe(255);
    expect(windowedLuminance[5]).toBe(255);

    Object.assign(nativeImage, { windowCenter: 0, windowWidth: 1 });
    displayDerivedPixels(Float32Array.from([-1, -0.25, 0, 0.25, 1, 2]));
    const zeroCentered = await derivedLoader('miraderived:zero-centered').promise;
    expect(zeroCentered).toMatchObject({ windowCenter: 0, windowWidth: 1 });
    const zeroCenteredLuminance = renderImageLuminance(zeroCentered, false);
    expect(zeroCenteredLuminance[0]).toBe(0);
    expect(zeroCenteredLuminance[1]).toBeGreaterThan(50);
    expect(zeroCenteredLuminance[2]).toBeGreaterThan(110);
    expect(zeroCenteredLuminance[3]).toBeGreaterThan(170);
    expect(zeroCenteredLuminance[4]).toBe(255);

    Object.assign(nativeImage, { windowCenter: 0, windowWidth: 0 });
    const invalidWidth = await derivedLoader('miraderived:invalid-window-width').promise;
    expect(invalidWidth).toMatchObject({ windowCenter: 0.5, windowWidth: 3 });

    Object.assign(nativeImage, { windowCenter: Number.NaN, windowWidth: 1 });
    const invalidCenter = await derivedLoader('miraderived:invalid-window-center').promise;
    expect(invalidCenter).toMatchObject({ windowCenter: 0.5, windowWidth: 3 });

    const raw = Float32Array.from([0, 25, 50, 75, 100, -100]);
    sources.derived.mockReturnValue({
      rows: 2,
      columns: 3,
      pixels: raw,
      valid: Uint8Array.from([1, 1, 1, 1, 1, 0]),
      sourceImageId: 'miradb:native-frame',
      displayTone: { windowCenter: 50, windowWidth: 100, source: [0.25, 0.5, 0.75], reference: [0.3, 0.55, 0.8] },
    });
    const calibrated = await derivedLoader('miraderived:calibrated').promise;
    const calibratedLuminance = renderImageLuminance(calibrated, false);
    expect(calibratedLuminance[0]).toBe(0);
    expect(calibratedLuminance[5]).toBe(0);
    for (const [index, value] of [
      [1, 0.3],
      [2, 0.55],
      [3, 0.8],
      [4, 1],
    ]) {
      expect(Math.abs(calibratedLuminance[index]! / 255 - value!)).toBeLessThan(1 / 255);
    }
    expect(Array.from(raw)).toEqual([0, 25, 50, 75, 100, -100]);

    const referencePixels = Uint16Array.from([0, 50, 100, 150, 250, 0]);
    const referenceImage = {
      rows: 2,
      columns: 3,
      minPixelValue: 0,
      maxPixelValue: 250,
      slope: 1,
      intercept: 0,
      windowCenter: 200,
      windowWidth: 400,
      invert: false,
      getPixelData: () => referencePixels,
    };
    const calibratedRaw = Float32Array.from([0, 25, 50, 75, 125, -100]);
    const tone = {
      windowCenter: 50,
      windowWidth: 100,
      source: [0.25, 0.5, 0.75],
      reference: [0.25, 0.5, 0.75],
      referenceWindow: { windowCenter: 100, windowWidth: 200 },
    };
    const toneBeforeDisplay = JSON.stringify(tone);
    const calibratedFrame = {
      rows: 2,
      columns: 3,
      pixels: calibratedRaw,
      valid: Uint8Array.from([1, 1, 1, 1, 1, 0]),
      sourceImageId: 'miradb:native-frame',
      referenceSopInstanceUid: 'current-reference-frame',
      displayTone: tone,
    };
    sources.derived.mockReturnValue(calibratedFrame);
    sources.decoded.mockImplementation(async (imageId: string) => {
      if (imageId === 'miradb:native-frame') return nativeImage;
      if (imageId === 'miradb:current-reference-frame') return referenceImage;
      throw new Error(`Unexpected display source: ${imageId}`);
    });

    // A cached native-intensity mapping must follow the visible reference's VOI,
    // including when its polarity differs from the acquired moving image.
    for (const referenceInvert of [false, true]) {
      Object.assign(nativeImage, { windowCenter: 900, windowWidth: 1800, invert: !referenceInvert });
      referenceImage.invert = referenceInvert;
      for (const width of [400, 200, 100]) {
        referenceImage.windowWidth = width;
        referenceImage.windowCenter = width / 2;
        sources.decoded.mockClear();
        const current = await derivedLoader(`miraderived:reference-window-${width}-${referenceInvert}`).promise;
        expect(sources.decoded).toHaveBeenCalledWith('miradb:current-reference-frame');
        expect(current.invert).toBe(referenceInvert);
        const matchedLuminance = renderImageLuminance(current, current.invert);
        const referenceLuminance = renderImageLuminance(referenceImage, referenceInvert);
        for (let index = 0; index < referencePixels.length - 1; index++) {
          expect(Math.abs(matchedLuminance[index]! - referenceLuminance[index]!)).toBeLessThanOrEqual(1);
        }
        // Unsupported padding stays black, even for MONOCHROME1 reference tissue.
        expect(matchedLuminance.at(-1)).toBe(0);
      }
    }
    expect(JSON.stringify(tone)).toBe(toneBeforeDisplay);
    expect(Array.from(calibratedRaw)).toEqual([0, 25, 50, 75, 125, -100]);
    expect(Array.from(referencePixels)).toEqual([0, 50, 100, 150, 250, 0]);

    // Persisted pre-calibration frames also have a reference identity. Its presence
    // alone must not reinterpret their legacy normalized mapping or inversion.
    sources.derived.mockReturnValue({
      ...calibratedFrame,
      displayTone: { ...tone, referenceWindow: undefined },
    });
    Object.assign(nativeImage, { invert: true });
    sources.decoded.mockClear();
    const legacyRestored = await derivedLoader('miraderived:restored-legacy-tone').promise;
    expect(sources.decoded).toHaveBeenCalledTimes(1);
    expect(sources.decoded).toHaveBeenCalledWith('miradb:native-frame');
    expect(legacyRestored.invert).toBe(true);
    expect(renderImageLuminance(legacyRestored, legacyRestored.invert)).toEqual([255, 191, 128, 64, 0, 0]);

    const highlightRaw = Float32Array.from([20, 50, 80, 100, 125, -100]);
    const highlightReference = {
      ...referenceImage,
      maxPixelValue: 270,
      windowCenter: 200,
      windowWidth: 400,
      invert: false,
      cachedLut: undefined,
      getPixelData: () => Uint16Array.from([60, 120, 180, 220, 270, 0]),
    };
    sources.derived.mockReturnValue({
      ...calibratedFrame,
      pixels: highlightRaw,
      displayTone: {
        ...tone,
        source: [0.2, 0.5, 0.8],
        reference: [0.15, 0.3, 0.45],
        referenceWindow: { windowCenter: 200, windowWidth: 400 },
      },
    });
    sources.decoded.mockImplementation(async (imageId: string) => {
      if (imageId === 'miradb:native-frame') return nativeImage;
      if (imageId === 'miradb:current-reference-frame') return highlightReference;
      throw new Error(`Unexpected display source: ${imageId}`);
    });
    const highlightMatched = await derivedLoader('miraderived:measured-highlight-contrast').promise;
    const highlightLuminance = renderImageLuminance(highlightMatched, highlightMatched.invert);
    const expectedHighlightLuminance = renderImageLuminance(highlightReference, highlightReference.invert);
    for (let index = 0; index < highlightRaw.length - 1; index++) {
      expect(Math.abs(highlightLuminance[index]! - expectedHighlightLuminance[index]!)).toBeLessThanOrEqual(1);
    }
    // Native moving values at and above its calibration window remain textured gray,
    // not artificially boosted toward white or clipped before reference windowing.
    expect(highlightLuminance[3]).toBeLessThan(150);
    expect(highlightLuminance[4]).toBeGreaterThan(highlightLuminance[3]!);
    expect(highlightLuminance[4]).toBeLessThan(180);
    expect(highlightLuminance[5]).toBe(0);
    expect(Array.from(highlightRaw)).toEqual([20, 50, 80, 100, 125, -100]);
  });
});
