import { describe, expect, it } from 'vitest';
import { normalizeModalityPixelsToGrayscale } from '../src/utils/segmentation/segmentTumor';

describe('native-image segmentation input', () => {
  it('normalizes signed modality-linear pixels without a viewer or screenshot', () => {
    const normalized = normalizeModalityPixelsToGrayscale(new Float32Array([-1200, -600, 0, 600, 1200]));

    expect(normalized[0]).toBe(0);
    expect(normalized[4]).toBe(255);
    expect(normalized[1]).toBeLessThan(normalized[2]!);
    expect(normalized[2]).toBeLessThan(normalized[3]!);
  });

  it('handles invalid and flat source frames without producing invalid image data', () => {
    expect(Array.from(normalizeModalityPixelsToGrayscale(new Float32Array([5, 5, 5])))).toEqual([0, 0, 0]);
    expect(Array.from(normalizeModalityPixelsToGrayscale(new Float32Array([NaN, Infinity])))).toEqual([0, 0]);
  });

  it('clips isolated high-intensity outliers using a stable frame histogram', () => {
    const pixels = Float32Array.from({ length: 200 }, (_, index) => (index === 199 ? 1_000_000 : index));
    const normalized = normalizeModalityPixelsToGrayscale(pixels);

    expect(normalized[100]).toBeGreaterThan(0);
    expect(normalized[199]).toBe(255);
  });
});
