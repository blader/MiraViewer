import type { NormalizedPoint } from '../../db/schema';

function sqr(x: number) {
  return x * x;
}

function distPointToSegmentSq(p: NormalizedPoint, a: NormalizedPoint, b: NormalizedPoint): number {
  const vx = b.x - a.x;
  const vy = b.y - a.y;
  const wx = p.x - a.x;
  const wy = p.y - a.y;

  const c1 = vx * wx + vy * wy;
  if (c1 <= 0) return sqr(p.x - a.x) + sqr(p.y - a.y);

  const c2 = vx * vx + vy * vy;
  if (c2 <= c1) return sqr(p.x - b.x) + sqr(p.y - b.y);

  const t = c1 / c2;
  const projX = a.x + t * vx;
  const projY = a.y + t * vy;
  return sqr(p.x - projX) + sqr(p.y - projY);
}

function rdp(points: NormalizedPoint[], epsSq: number): NormalizedPoint[] {
  if (points.length <= 2) return points;

  const a = points[0];
  const b = points[points.length - 1];

  let maxD = -1;
  let idx = -1;

  for (let i = 1; i < points.length - 1; i++) {
    const d = distPointToSegmentSq(points[i], a, b);
    if (d > maxD) {
      maxD = d;
      idx = i;
    }
  }

  if (maxD <= epsSq || idx === -1) {
    return [a, b];
  }

  const left = rdp(points.slice(0, idx + 1), epsSq);
  const right = rdp(points.slice(idx), epsSq);
  return [...left.slice(0, -1), ...right];
}

export function rdpSimplify(points: NormalizedPoint[], epsilon: number): NormalizedPoint[] {
  if (points.length <= 3) return points;

  // Ensure the polygon is closed for simplification stability, then drop the repeated point.
  const first = points[0];
  const last = points[points.length - 1];
  const closed = first.x === last.x && first.y === last.y ? points : [...points, first];

  const simplified = rdp(closed, epsilon * epsilon);
  // Remove closing duplicate if present.
  if (simplified.length >= 2) {
    const s0 = simplified[0];
    const sl = simplified[simplified.length - 1];
    if (s0.x === sl.x && s0.y === sl.y) {
      simplified.pop();
    }
  }

  return simplified;
}
