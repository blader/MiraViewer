import { describe, expect, it } from 'vitest';
import { marchingSquaresContour } from '../src/utils/segmentation/marchingSquares';
import { morphologicalClose } from '../src/utils/segmentation/morphology';
import { rdpSimplify } from '../src/utils/segmentation/simplify';
import { chaikinSmooth } from '../src/utils/segmentation/smooth';

describe('segmentation utilities', () => {
  it('rdpSimplify reduces points on a nearly straight polyline', () => {
    const pts = Array.from({ length: 20 }, (_, i) => ({ x: i / 19, y: 0.5 + (i % 2 ? 1e-4 : -1e-4) }));
    const simplified = rdpSimplify(pts, 0.01);
    expect(simplified.length).toBeLessThan(pts.length);
    expect(simplified.length).toBeGreaterThanOrEqual(2);
  });

  it('marchingSquaresContour returns a contour around a filled square', () => {
    const w = 10;
    const h = 10;
    const mask = new Uint8Array(w * h);

    // Fill a 4x4 square.
    for (let y = 3; y <= 6; y++) {
      for (let x = 3; x <= 6; x++) {
        mask[y * w + x] = 1;
      }
    }

    const contour = marchingSquaresContour(mask, w, h);
    expect(contour.length).toBeGreaterThan(0);

    // Contour points should lie near the square boundary (midpoints between pixels).
    for (const p of contour) {
      expect(p.x).toBeGreaterThanOrEqual(2.5);
      expect(p.x).toBeLessThanOrEqual(6.5);
      expect(p.y).toBeGreaterThanOrEqual(2.5);
      expect(p.y).toBeLessThanOrEqual(6.5);
    }
  });

  it('morphologicalClose fills a 1px hole', () => {
    const w = 7;
    const h = 7;
    const mask = new Uint8Array(w * h);

    // Fill a 3x3 block, but leave a 1px hole in the center.
    for (let y = 2; y <= 4; y++) {
      for (let x = 2; x <= 4; x++) {
        mask[y * w + x] = 1;
      }
    }
    mask[3 * w + 3] = 0;

    const closed = morphologicalClose(mask, w, h);
    expect(closed[3 * w + 3]).toBe(1);
  });

  it('chaikinSmooth increases point count and keeps points in bounds', () => {
    const square = [
      { x: 0, y: 0 },
      { x: 1, y: 0 },
      { x: 1, y: 1 },
      { x: 0, y: 1 },
    ];

    const smoothed = chaikinSmooth(square, 2);
    expect(smoothed.length).toBeGreaterThan(square.length);

    for (const p of smoothed) {
      expect(p.x).toBeGreaterThanOrEqual(0);
      expect(p.x).toBeLessThanOrEqual(1);
      expect(p.y).toBeGreaterThanOrEqual(0);
      expect(p.y).toBeLessThanOrEqual(1);
    }
  });
});
