import { describe, expect, test } from 'vitest';
import { computeGeodesicDistanceToSeeds } from '../src/utils/segmentation/geodesicDistance';

describe('geodesicDistance', () => {
  test('edgeCostStrength=0 matches Manhattan distance in a rectangular ROI', () => {
    const w = 5;
    const h = 5;

    const dist = computeGeodesicDistanceToSeeds({
      w,
      h,
      roi: { x0: 0, y0: 0, x1: w - 1, y1: h - 1 },
      seeds: [{ x: 0, y: 2 }],
      edgeCostStrength: 0,
    });

    const at = (x: number, y: number) => dist[y * w + x]!;

    expect(at(0, 2)).toBeCloseTo(0, 8);
    expect(at(1, 2)).toBeCloseTo(1, 8);
    expect(at(2, 2)).toBeCloseTo(2, 8);
    expect(at(3, 2)).toBeCloseTo(3, 8);
    expect(at(4, 2)).toBeCloseTo(4, 8);

    // A diagonal corner should be manhattan distance as well.
    expect(at(4, 4)).toBeCloseTo(6, 8);
  });

  test('strong edge cost increases distance across a barrier', () => {
    const w = 5;
    const h = 5;

    // Vertical "edge barrier" at x=2.
    const grad = new Uint8Array(w * h);
    for (let y = 0; y < h; y++) {
      grad[y * w + 2] = 255;
    }

    const dist = computeGeodesicDistanceToSeeds({
      w,
      h,
      roi: { x0: 0, y0: 0, x1: w - 1, y1: h - 1 },
      seeds: [{ x: 0, y: 2 }],
      grad,
      edgeCostStrength: 10,
    });

    const at = (x: number, y: number) => dist[y * w + x]!;

    // Crossing the barrier requires entering an x=2 cell once:
    // base 4 steps + extra 10 cost = 14.
    expect(at(4, 2)).toBeCloseTo(14, 6);

    // The barrier cell itself should reflect the extra cost.
    expect(at(2, 2)).toBeCloseTo(12, 6);
  });
});
