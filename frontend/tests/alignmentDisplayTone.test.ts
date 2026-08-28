import { describe, expect, it } from 'vitest';
import {
  applyAlignmentDisplayTone,
  createAlignmentDisplayTone,
  validAlignmentDisplayTone,
  type AlignmentDisplayTone,
} from '../src/utils/alignmentDisplayTone';
import { computeHistogramStats } from '../src/utils/imageCapture';

describe('alignment display calibration', () => {
  const reference = computeHistogramStats(Float32Array.from({ length: 100 }, (_, i) => 0.2 + i * 0.005));
  const moving = computeHistogramStats(Float32Array.from({ length: 100 }, (_, i) => 0.1 + i * 0.006));
  const window = { windowCenter: 500, windowWidth: 1000 };

  it('matches paired tissue quantiles while fixing black and white and preserving monotonicity', () => {
    const tone = createAlignmentDisplayTone(reference, moving, window)!;
    expect(tone).toBeDefined();
    for (let i = 0; i < 3; i++) {
      expect(applyAlignmentDisplayTone(tone.source[i]! * 1000, tone)).toBeCloseTo(tone.reference[i]!, 8);
    }
    expect(applyAlignmentDisplayTone(-100, tone)).toBe(0);
    expect(applyAlignmentDisplayTone(0, tone)).toBe(0);
    expect(applyAlignmentDisplayTone(1000, tone)).toBe(1);
    let previous = 0;
    for (let value = 0; value <= 1000; value++) {
      const mapped = applyAlignmentDisplayTone(value, tone);
      expect(mapped).toBeGreaterThanOrEqual(previous);
      previous = mapped;
    }
  });

  it('declines flat, clipped, non-finite or invalid calibration instead of inventing contrast', () => {
    expect(createAlignmentDisplayTone(reference, { ...moving, p10: 0.1, p50: 0.1 }, window)).toBeUndefined();
    expect(createAlignmentDisplayTone(reference, moving, { ...window, windowWidth: 0 })).toBeUndefined();
    expect(createAlignmentDisplayTone(reference, { ...moving, p90: NaN }, window)).toBeUndefined();
    expect(
      validAlignmentDisplayTone({
        ...createAlignmentDisplayTone(reference, moving, window)!,
        reference: [0.2, 0.1, 0.5],
      }),
    ).toBe(false);
  });

  it('keeps the native intensity correspondence while matching each displayed reference window', () => {
    const sourceWindow = { windowCenter: 50, windowWidth: 100 };
    const referenceWindow = { windowCenter: 200, windowWidth: 400 };
    // Corresponding native tissue is 2 * moving + 20, despite different display windows.
    const tone = createAlignmentDisplayTone(
      { ...reference, p10: 0.15, p50: 0.3, p90: 0.45 },
      { ...moving, p10: 0.2, p50: 0.5, p90: 0.8 },
      sourceWindow,
      referenceWindow,
    )!;
    const originalTone = JSON.stringify(tone);
    const raw = Float32Array.from([20, 27.125, 49.9875, 50, 75, 80, 80.125, 95, 100, 125, 150, 200]);
    const originalPixels = Array.from(raw);

    expect(tone.referenceWindow).toEqual(referenceWindow);
    for (const displayWindow of [
      referenceWindow,
      { windowCenter: 400, windowWidth: 800 },
      { windowCenter: 100, windowWidth: 200 },
      { windowCenter: 250, windowWidth: 300 },
    ]) {
      for (const pixel of raw) {
        const fixedNativeValue = 2 * pixel + 20;
        const expected = Math.max(
          0,
          Math.min(1, (fixedNativeValue - displayWindow.windowCenter) / displayWindow.windowWidth + 0.5),
        );
        expect(applyAlignmentDisplayTone(pixel, tone, displayWindow)).toBeCloseTo(expected, 10);
      }
    }
    expect(applyAlignmentDisplayTone(50, tone)).toBeCloseTo(0.3, 10);
    expect(JSON.stringify(tone)).toBe(originalTone);
    expect(Array.from(raw)).toEqual(originalPixels);
  });

  it('continues measured highlight contrast without adding a brightness gain above the last tissue quantile', () => {
    const tone = createAlignmentDisplayTone(
      { ...reference, p10: 0.15, p50: 0.3, p90: 0.45 },
      { ...moving, p10: 0.2, p50: 0.5, p90: 0.8 },
      { windowCenter: 50, windowWidth: 100 },
      { windowCenter: 200, windowWidth: 400 },
    )!;

    expect(applyAlignmentDisplayTone(20, tone)).toBeCloseTo(0.15, 10);
    expect(applyAlignmentDisplayTone(50, tone)).toBeCloseTo(0.3, 10);
    expect(applyAlignmentDisplayTone(80, tone)).toBeCloseTo(0.45, 10);
    const epsilon = 0.001;
    const leftSlope = (applyAlignmentDisplayTone(80, tone) - applyAlignmentDisplayTone(80 - epsilon, tone)) / epsilon;
    const rightSlope = (applyAlignmentDisplayTone(80 + epsilon, tone) - applyAlignmentDisplayTone(80, tone)) / epsilon;
    expect(leftSlope).toBeCloseTo(0.005, 10);
    expect(rightSlope).toBeCloseTo(leftSlope, 10);
    expect(applyAlignmentDisplayTone(100, tone)).toBeCloseTo(0.55, 10);
    expect(applyAlignmentDisplayTone(150, tone)).toBeCloseTo(0.8, 10);

    // Legacy restored frames keep their original black/white endpoint contract.
    expect(applyAlignmentDisplayTone(100, { ...tone, referenceWindow: undefined })).toBe(1);
    const wider = { windowCenter: 400, windowWidth: 800 };
    let previous = 0;
    for (let pixel = 80; pixel <= 400; pixel += 0.25) {
      const expected = Math.min(1, (2 * pixel + 20) / 800);
      const mapped = applyAlignmentDisplayTone(pixel, tone, wider);
      expect(mapped).toBeCloseTo(expected, 10);
      expect(mapped).toBeGreaterThanOrEqual(previous);
      previous = mapped;
    }
  });

  it('retains highlights and shadows outside the calibration window until the final reference window clips them', () => {
    const anchor = { windowCenter: 50, windowWidth: 100 };
    const identity = { ...reference, p10: 0.25, p50: 0.5, p90: 0.75 };
    const tone = createAlignmentDisplayTone(identity, identity, anchor, anchor)!;
    const wider = { windowCenter: 150, windowWidth: 300 };

    expect(applyAlignmentDisplayTone(125, tone, wider)).toBeCloseTo(125 / 300, 10);
    expect(applyAlignmentDisplayTone(175, tone, wider)).toBeCloseTo(175 / 300, 10);
    expect(applyAlignmentDisplayTone(125, tone, wider)).toBeLessThan(applyAlignmentDisplayTone(175, tone, wider));
    expect(applyAlignmentDisplayTone(-50, tone, { windowCenter: 0, windowWidth: 300 })).toBeCloseTo(1 / 3, 10);
    expect(applyAlignmentDisplayTone(-200, tone, { windowCenter: 0, windowWidth: 300 })).toBe(0);
    expect(applyAlignmentDisplayTone(400, tone, wider)).toBe(1);
    expect(applyAlignmentDisplayTone(125, tone)).toBe(1);

    let previous = 0;
    for (let pixel = -100; pixel <= 400; pixel += 0.5) {
      const mapped = applyAlignmentDisplayTone(pixel, tone, wider);
      expect(mapped).toBeGreaterThanOrEqual(previous);
      expect(mapped).toBeLessThanOrEqual(1);
      previous = mapped;
    }
  });

  it('preserves restored legacy display mappings without guessing their missing reference intensity window', () => {
    const legacy = createAlignmentDisplayTone(reference, moving, window)!;
    const serialized = structuredClone(legacy);
    const unrelatedWindow = { windowCenter: 1000, windowWidth: 2000 };

    expect(serialized.referenceWindow).toBeUndefined();
    expect(validAlignmentDisplayTone(serialized)).toBe(true);
    for (const pixel of [-100, 0, 250, 500, 750, 1000, 1200]) {
      expect(applyAlignmentDisplayTone(pixel, serialized, unrelatedWindow)).toBe(
        applyAlignmentDisplayTone(pixel, legacy),
      );
    }
  });

  it('rejects invalid reference calibration windows while retaining valid zero-centered windows', () => {
    for (const invalid of [
      { windowCenter: 500, windowWidth: 0 },
      { windowCenter: 500, windowWidth: -1 },
      { windowCenter: Number.NaN, windowWidth: 1000 },
      { windowCenter: 500, windowWidth: Number.POSITIVE_INFINITY },
    ]) {
      expect(createAlignmentDisplayTone(reference, moving, window, invalid)).toBeUndefined();
      expect(
        validAlignmentDisplayTone({
          ...createAlignmentDisplayTone(reference, moving, window)!,
          referenceWindow: invalid,
        }),
      ).toBe(false);
    }
    expect(createAlignmentDisplayTone(reference, moving, window, { windowCenter: 0, windowWidth: 1000 })).toBeDefined();
  });

  it('declines malformed persisted reference windows without throwing during restored-frame rendering', () => {
    const legacy = createAlignmentDisplayTone(reference, moving, window)!;
    for (const referenceWindow of [null, {}, [], 'invalid', { windowCenter: 50 }, { windowWidth: 100 }]) {
      const restored = { ...legacy, referenceWindow } as unknown as AlignmentDisplayTone;
      expect(validAlignmentDisplayTone(restored)).toBe(false);
    }
  });
});
