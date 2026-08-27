import { describe, expect, it } from 'vitest';
import {
  applyAlignmentDisplayTone,
  createAlignmentDisplayTone,
  validAlignmentDisplayTone,
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
});
