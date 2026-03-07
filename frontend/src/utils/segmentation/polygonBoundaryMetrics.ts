import type { TumorPolygon } from '../../db/schema';

export type PolygonBoundaryMetrics = {
  /** Mean distance from predicted boundary samples to GT boundary (pixels). */
  meanPredToGtPx: number;
  /** Mean distance from GT boundary samples to predicted boundary (pixels). */
  meanGtToPredPx: number;
  /** Symmetric mean boundary distance (pixels). */
  meanSymPx: number;

  /** Max distance from predicted boundary samples to GT boundary (pixels). */
  maxPredToGtPx: number;
  /** Max distance from GT boundary samples to predicted boundary (pixels). */
  maxGtToPredPx: number;
  /** Symmetric max boundary distance (pixels). */
  maxSymPx: number;

  /** Sample counts (for debugging). */
  samplesPred: number;
  samplesGt: number;
};

type Pt = { x: number; y: number };

type Seg = { x0: number; y0: number; x1: number; y1: number };

function clamp(v: number, lo: number, hi: number) {
  return Math.max(lo, Math.min(hi, v));
}

function toPixelPoints(poly: TumorPolygon, w: number, h: number): Pt[] {
  const pts = poly.points ?? [];
  if (pts.length < 3) return [];

  const out: Pt[] = [];
  for (const p of pts) {
    out.push({
      x: clamp(p.x, 0, 1) * (w - 1),
      y: clamp(p.y, 0, 1) * (h - 1),
    });
  }
  return out;
}

function toSegments(pts: Pt[]): Seg[] {
  if (pts.length < 2) return [];
  const segs: Seg[] = [];
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i]!;
    const b = pts[(i + 1) % pts.length]!;
    segs.push({ x0: a.x, y0: a.y, x1: b.x, y1: b.y });
  }
  return segs;
}

function pointToSegmentDist2(px: number, py: number, s: Seg): number {
  const vx = s.x1 - s.x0;
  const vy = s.y1 - s.y0;
  const wx = px - s.x0;
  const wy = py - s.y0;

  const vv = vx * vx + vy * vy;
  if (vv <= 1e-12) {
    const dx = px - s.x0;
    const dy = py - s.y0;
    return dx * dx + dy * dy;
  }

  let t = (wx * vx + wy * vy) / vv;
  t = clamp(t, 0, 1);

  const cx = s.x0 + t * vx;
  const cy = s.y0 + t * vy;

  const dx = px - cx;
  const dy = py - cy;
  return dx * dx + dy * dy;
}

function samplePolygonBoundary(pts: Pt[], stepPx: number): Pt[] {
  if (pts.length < 3) return [];
  const step = Math.max(0.25, stepPx);

  const out: Pt[] = [];

  for (let i = 0; i < pts.length; i++) {
    const a = pts[i]!;
    const b = pts[(i + 1) % pts.length]!;
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const len = Math.hypot(dx, dy);

    // Always sample at least the segment start.
    const n = Math.max(1, Math.ceil(len / step));
    for (let s = 0; s < n; s++) {
      const t = n <= 1 ? 0 : s / n;
      out.push({ x: a.x + t * dx, y: a.y + t * dy });
    }
  }

  return out;
}

function meanMaxDistanceToSegments(samples: Pt[], segs: Seg[]): { mean: number; max: number; count: number } {
  if (samples.length === 0 || segs.length === 0) {
    return { mean: Number.POSITIVE_INFINITY, max: Number.POSITIVE_INFINITY, count: 0 };
  }

  let sum = 0;
  let max = 0;

  for (const p of samples) {
    let best2 = Number.POSITIVE_INFINITY;
    for (const s of segs) {
      const d2 = pointToSegmentDist2(p.x, p.y, s);
      if (d2 < best2) best2 = d2;
    }

    const d = Math.sqrt(best2);
    sum += d;
    if (d > max) max = d;
  }

  return { mean: sum / samples.length, max, count: samples.length };
}

export function computePolygonBoundaryMetrics(
  pred: TumorPolygon,
  gt: TumorPolygon,
  w: number,
  h: number,
  opts?: { sampleStepPx?: number }
): PolygonBoundaryMetrics {
  const predPts = toPixelPoints(pred, w, h);
  const gtPts = toPixelPoints(gt, w, h);

  if (predPts.length < 3 || gtPts.length < 3) {
    return {
      meanPredToGtPx: Number.POSITIVE_INFINITY,
      meanGtToPredPx: Number.POSITIVE_INFINITY,
      meanSymPx: Number.POSITIVE_INFINITY,
      maxPredToGtPx: Number.POSITIVE_INFINITY,
      maxGtToPredPx: Number.POSITIVE_INFINITY,
      maxSymPx: Number.POSITIVE_INFINITY,
      samplesPred: 0,
      samplesGt: 0,
    };
  }

  const step = opts?.sampleStepPx ?? 1.25;

  const predSegs = toSegments(predPts);
  const gtSegs = toSegments(gtPts);

  const predSamples = samplePolygonBoundary(predPts, step);
  const gtSamples = samplePolygonBoundary(gtPts, step);

  const a = meanMaxDistanceToSegments(predSamples, gtSegs);
  const b = meanMaxDistanceToSegments(gtSamples, predSegs);

  const meanSym = (a.mean + b.mean) / 2;
  const maxSym = Math.max(a.max, b.max);

  return {
    meanPredToGtPx: a.mean,
    meanGtToPredPx: b.mean,
    meanSymPx: meanSym,
    maxPredToGtPx: a.max,
    maxGtToPredPx: b.max,
    maxSymPx: maxSym,
    samplesPred: a.count,
    samplesGt: b.count,
  };
}
