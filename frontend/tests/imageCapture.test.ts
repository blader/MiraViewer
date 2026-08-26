import { describe, expect, it } from 'vitest';
import { computeIntensityMatch } from '../src/utils/alignment';
import {
  computeCorrespondingDisplayStats,
  computeHistogramStats,
  windowDisplayPixels,
} from '../src/utils/imageCapture';

describe('diagnostic display intensity matching', () => {
  it('maps native modality values through the exact Cornerstone display window', () => {
    const pixels = Float32Array.from([-100, 0, 25, 50, 75, 100, 200]);

    expect(Array.from(windowDisplayPixels(pixels, { windowCenter: 50, windowWidth: 100 })!)).toEqual([
      0, 0, 0.25, 0.5, 0.75, 1, 1,
    ]);
    expect(Array.from(pixels)).toEqual([-100, 0, 25, 50, 75, 100, 200]);
    expect(windowDisplayPixels(pixels, { windowCenter: 50, windowWidth: 0 })).toBeNull();
    expect(windowDisplayPixels(pixels, undefined)).toBeNull();
  });

  it('matches only corresponding supported foreground outside the selected lesion', () => {
    const reference = Float32Array.from([0, 0.3, 0.5, 0.7, 0.4, 1, 0.6, 0.8, 0.5, 0.7, 0.9, 0.6, 0.4, 0.5, 0.7, 0.8]);
    const moving = Float32Array.from(reference, (value) => value * 0.6 + 0.1);
    moving[0] = 0;
    moving[5] = 0.25;
    const validity = new Float32Array(reference.length).fill(1);
    validity[15] = 0;

    const stats = computeCorrespondingDisplayStats(reference, moving, {
      referenceValidity: validity,
      movingValidity: validity,
      exclusionRect: { x: 0.25, y: 0.25, width: 0.25, height: 0.25 },
      columns: 4,
    });

    expect(stats).not.toBeNull();
    expect(stats!.moving.mean).toBeCloseTo(stats!.reference.mean * 0.6 + 0.1, 6);
    expect(stats!.moving.stddev).toBeCloseTo(stats!.reference.stddev * 0.6, 6);
    const matched = computeIntensityMatch(stats!.reference, stats!.moving);
    expect(matched.brightness).toBeGreaterThan(100);
    expect(matched.contrast).toBeGreaterThan(100);
  });

  it('computes exact weighted moments and quantiles for healthy tissue near the selected anatomy', () => {
    const stats = computeHistogramStats(Float32Array.from([0, 0.25, 0.75, 1]), Float32Array.from([1, 1, 6, 2]));

    expect(stats.mean).toBeCloseTo(0.675, 8);
    expect(stats.stddev).toBeCloseTo(Math.sqrt(0.088125), 8);
    expect(stats.p10).toBe(0.25);
    expect(stats.p50).toBe(0.75);
    expect(stats.p90).toBe(1);
    expect(() => computeHistogramStats(Float32Array.from([0, 1]), Float32Array.from([1]))).toThrow(
      'Histogram weights must match their source pixels',
    );
  });

  it('emphasizes nearby supported tissue while still retaining distant anatomical evidence', () => {
    const size = 40;
    const reference = new Float32Array(size * size);
    const moving = new Float32Array(size * size);
    for (let row = 0; row < size; row++) {
      for (let column = 0; column < size; column++) {
        const index = row * size + column;
        const tissue = 0.25 + ((row * 3 + column * 5) % 10) * 0.06;
        reference[index] = tissue;
        const near = Math.hypot(row / size - 0.5, column / size - 0.5) < 0.2;
        moving[index] = near ? tissue * 0.55 + 0.08 : tissue * 0.88 + 0.02;
      }
    }

    const focused = computeCorrespondingDisplayStats(reference, moving, {
      columns: size,
      exclusionRect: { x: 0.47, y: 0.47, width: 0.06, height: 0.06 },
    });
    const global = computeCorrespondingDisplayStats(reference, moving, { columns: size });

    expect(focused).not.toBeNull();
    expect(global).not.toBeNull();
    const nearMovingMean = 0.52 * 0.55 + 0.08;
    const display = (stats: NonNullable<typeof focused>) => {
      const match = computeIntensityMatch(stats.reference, stats.moving);
      return (nearMovingMean * (match.brightness / 100) - 0.5) * (match.contrast / 100) + 0.5;
    };
    expect(Math.abs(display(focused!) - 0.52)).toBeLessThan(Math.abs(display(global!) - 0.52));
    expect(focused!.moving.max).toBeGreaterThan(0.65);
  });

  it('rejects incompatible lattices and images without enough shared visible anatomy', () => {
    expect(computeCorrespondingDisplayStats(new Float32Array(4), new Float32Array(3), { columns: 2 })).toBeNull();
    expect(computeCorrespondingDisplayStats(new Float32Array(4), new Float32Array(4), { columns: 2 })).toBeNull();
  });
});
