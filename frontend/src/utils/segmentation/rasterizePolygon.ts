import type { TumorPolygon } from '../../db/schema';

function clamp(v: number, lo: number, hi: number) {
  return Math.max(lo, Math.min(hi, v));
}

/**
 * Rasterize a polygon into a binary mask using an even-odd scanline fill.
 *
 * - Polygon points are expected in normalized image coordinates (0..1).
 * - Output mask is 1 for pixels whose center lies inside the polygon.
 */
export function rasterizePolygonToMask(polygon: TumorPolygon, w: number, h: number): Uint8Array {
  const out = new Uint8Array(Math.max(0, w * h));
  if (w <= 0 || h <= 0) return out;
  if (!polygon.points || polygon.points.length < 3) return out;

  const n = polygon.points.length;

  // Convert to pixel-space float coordinates.
  const xs = new Float64Array(n);
  const ys = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const p = polygon.points[i]!;
    xs[i] = clamp(p.x, 0, 1) * (w - 1);
    ys[i] = clamp(p.y, 0, 1) * (h - 1);
  }

  const intersections: number[] = [];

  for (let y = 0; y < h; y++) {
    intersections.length = 0;

    const yCenter = y + 0.5;

    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n;
      const y0 = ys[i]!;
      const y1 = ys[j]!;

      // Edge crosses scanline? (Half-open to avoid double counting vertices.)
      const crosses = (y0 <= yCenter && y1 > yCenter) || (y1 <= yCenter && y0 > yCenter);
      if (!crosses) continue;

      const x0 = xs[i]!;
      const x1 = xs[j]!;

      const t = (yCenter - y0) / (y1 - y0);
      const x = x0 + t * (x1 - x0);
      intersections.push(x);
    }

    if (intersections.length < 2) continue;

    intersections.sort((a, b) => a - b);

    for (let k = 0; k + 1 < intersections.length; k += 2) {
      const a = intersections[k]!;
      const b = intersections[k + 1]!;
      const xStart = clamp(Math.ceil(Math.min(a, b)), 0, w - 1);
      const xEnd = clamp(Math.floor(Math.max(a, b)), 0, w - 1);

      const rowBase = y * w;
      for (let x = xStart; x <= xEnd; x++) {
        out[rowBase + x] = 1;
      }
    }
  }

  return out;
}
