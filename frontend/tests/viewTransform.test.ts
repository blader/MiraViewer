import { describe, expect, test } from 'vitest';
import type { ViewerTransform } from '../src/db/schema';
import {
  remapPointBetweenViewerTransforms,
  remapPolygonBetweenViewerTransforms,
  type ViewportSize,
} from '../src/utils/viewTransform';

describe('viewTransform', () => {
  test('remapPointBetweenViewerTransforms round-trips between two transforms', () => {
    const size: ViewportSize = { w: 400, h: 300 };

    const a: ViewerTransform = {
      zoom: 1,
      rotation: 0,
      panX: 0,
      panY: 0,
      affine00: 1,
      affine01: 0,
      affine10: 0,
      affine11: 1,
    };

    // Non-trivial but invertible matrix (det != 0) + rotation/zoom + pan.
    const b: ViewerTransform = {
      zoom: 1.6,
      rotation: 27,
      panX: 0.12,
      panY: -0.08,
      affine00: 1,
      affine01: 0.2,
      affine10: -0.15,
      affine11: 0.95,
    };

    const pts = [
      { x: 0.5, y: 0.5 },
      { x: 0.1, y: 0.2 },
      { x: 0.9, y: 0.8 },
      { x: 0, y: 0 },
      { x: 1, y: 1 },
    ];

    for (const p of pts) {
      const q = remapPointBetweenViewerTransforms(p, size, a, b);
      expect(Number.isFinite(q.x)).toBe(true);
      expect(Number.isFinite(q.y)).toBe(true);

      const r = remapPointBetweenViewerTransforms(q, size, b, a);
      expect(r.x).toBeCloseTo(p.x, 8);
      expect(r.y).toBeCloseTo(p.y, 8);
    }
  });

  test('remapPolygonBetweenViewerTransforms remaps each point and round-trips', () => {
    const size: ViewportSize = { w: 512, h: 512 };

    const from: ViewerTransform = {
      zoom: 1.25,
      rotation: -15,
      panX: -0.05,
      panY: 0.07,
      affine00: 1,
      affine01: 0.12,
      affine10: 0,
      affine11: 0.9,
    };

    const to: ViewerTransform = {
      zoom: 0.85,
      rotation: 42,
      panX: 0.04,
      panY: 0.02,
      affine00: 0.95,
      affine01: 0,
      affine10: 0.08,
      affine11: 1.05,
    };

    const poly = {
      points: [
        { x: 0.2, y: 0.2 },
        { x: 0.8, y: 0.2 },
        { x: 0.75, y: 0.75 },
        { x: 0.25, y: 0.8 },
      ],
    };

    const remapped = remapPolygonBetweenViewerTransforms(poly, size, from, to);
    expect(remapped.points).toHaveLength(poly.points.length);

    const roundTripped = remapPolygonBetweenViewerTransforms(remapped, size, to, from);
    for (let i = 0; i < poly.points.length; i++) {
      expect(roundTripped.points[i]!.x).toBeCloseTo(poly.points[i]!.x, 8);
      expect(roundTripped.points[i]!.y).toBeCloseTo(poly.points[i]!.y, 8);
    }
  });
});
