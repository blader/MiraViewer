import type { NormalizedPoint, TumorPolygon } from '../../../db/schema';

function clamp(v: number, lo: number, hi: number) {
  return Math.max(lo, Math.min(hi, v));
}

function clamp01(v: number) {
  return clamp(v, 0, 1);
}

function hashStringToSeed(s: string): number {
  // FNV-1a 32-bit
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function makeLcg(seed: number) {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(1664525, state) + 1013904223) >>> 0;
    return state / 4294967296;
  };
}

function polygonBounds01(poly: TumorPolygon): { minX: number; minY: number; maxX: number; maxY: number } {
  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;

  for (const p of poly.points) {
    minX = Math.min(minX, p.x);
    minY = Math.min(minY, p.y);
    maxX = Math.max(maxX, p.x);
    maxY = Math.max(maxY, p.y);
  }

  return {
    minX: clamp01(minX),
    minY: clamp01(minY),
    maxX: clamp01(maxX),
    maxY: clamp01(maxY),
  };
}

function pointInPolygon(pt: NormalizedPoint, poly: TumorPolygon): boolean {
  // Ray casting.
  const pts = poly.points;
  const n = pts.length;
  if (n < 3) return false;

  let inside = false;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const a = pts[i]!;
    const b = pts[j]!;
    const intersects = a.y > pt.y !== b.y > pt.y && pt.x < ((b.x - a.x) * (pt.y - a.y)) / (b.y - a.y + 1e-12) + a.x;

    if (intersects) inside = !inside;
  }

  return inside;
}

function polygonAreaCentroid01(poly: TumorPolygon): NormalizedPoint {
  const pts = poly.points;
  const n = pts.length;
  if (n < 3) {
    // Fallback: average.
    let sx = 0;
    let sy = 0;
    for (const p of pts) {
      sx += p.x;
      sy += p.y;
    }
    const d = Math.max(1, n);
    return { x: clamp01(sx / d), y: clamp01(sy / d) };
  }

  // Polygon centroid (shoelace). Works for simple polygons.
  let a2 = 0;
  let cx = 0;
  let cy = 0;

  for (let i = 0; i < n; i++) {
    const p0 = pts[i]!;
    const p1 = pts[(i + 1) % n]!;
    const cross = p0.x * p1.y - p1.x * p0.y;
    a2 += cross;
    cx += (p0.x + p1.x) * cross;
    cy += (p0.y + p1.y) * cross;
  }

  if (Math.abs(a2) < 1e-10) {
    // Degenerate polygon.
    let sx = 0;
    let sy = 0;
    for (const p of pts) {
      sx += p.x;
      sy += p.y;
    }
    const d = Math.max(1, n);
    return { x: clamp01(sx / d), y: clamp01(sy / d) };
  }

  const inv6a = 1 / (3 * a2);
  return { x: clamp01(cx * inv6a), y: clamp01(cy * inv6a) };
}

function findInteriorPoint01(poly: TumorPolygon): NormalizedPoint {
  const c = polygonAreaCentroid01(poly);
  if (pointInPolygon(c, poly)) return c;

  // Try bbox center.
  const b = polygonBounds01(poly);
  const mid = { x: (b.minX + b.maxX) / 2, y: (b.minY + b.maxY) / 2 };
  if (pointInPolygon(mid, poly)) return mid;

  // Brute force a small grid search.
  const steps = 9;
  for (let yi = 0; yi < steps; yi++) {
    for (let xi = 0; xi < steps; xi++) {
      const x = b.minX + ((xi + 0.5) / steps) * (b.maxX - b.minX);
      const y = b.minY + ((yi + 0.5) / steps) * (b.maxY - b.minY);
      const p = { x, y };
      if (pointInPolygon(p, poly)) return p;
    }
  }

  // Give up: return clamped centroid.
  return c;
}

/**
 * Deterministically generate a set of "paint" points inside the GT polygon.
 *
 * This lets us benchmark/tune without requiring real user paint gestures.
 */
export function generateSyntheticPaintPointsFromGt(gt: TumorPolygon, seedKey: string, targetCount: number): NormalizedPoint[] {
  const pts: NormalizedPoint[] = [];
  const seed = findInteriorPoint01(gt);

  // Always include a small cross around the seed for robustness.
  const j = 0.004;
  pts.push(seed);
  pts.push({ x: clamp01(seed.x + j), y: seed.y });
  pts.push({ x: clamp01(seed.x - j), y: seed.y });
  pts.push({ x: seed.x, y: clamp01(seed.y + j) });
  pts.push({ x: seed.x, y: clamp01(seed.y - j) });

  const b = polygonBounds01(gt);
  const rand = makeLcg(hashStringToSeed(seedKey));

  const want = Math.max(8, targetCount);
  const maxAttempts = want * 80;

  for (let attempt = 0; attempt < maxAttempts && pts.length < want; attempt++) {
    // Bias sampling toward the seed by mixing uniform bbox with a seed-centered jitter.
    const mix = rand();

    let x: number;
    let y: number;

    if (mix < 0.7) {
      // Seed-centered jitter (roughly "scribble" sized).
      const r = 0.03;
      x = clamp01(seed.x + (rand() * 2 - 1) * r);
      y = clamp01(seed.y + (rand() * 2 - 1) * r);
    } else {
      // Uniform in bbox.
      x = b.minX + rand() * (b.maxX - b.minX);
      y = b.minY + rand() * (b.maxY - b.minY);
    }

    const p = { x, y };
    if (pointInPolygon(p, gt)) {
      pts.push(p);
    }
  }

  return pts;
}
