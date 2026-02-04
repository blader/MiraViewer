export type Point = { x: number; y: number };

/**
 * Chaikin corner-cutting smoothing for a closed polygon.
 *
 * Notes:
 * - This assumes `points` is a simple (non-self-intersecting) polygon.
 * - It returns a new point array and does not repeat the start point at the end.
 * - Chaikin smoothing shrinks the polygon slightly; that's desirable here to remove pixel jaggies.
 */
export function chaikinSmooth(points: Point[], iterations: number = 2): Point[] {
  if (points.length < 3) return points;

  let pts = points;

  for (let it = 0; it < iterations; it++) {
    const n = pts.length;
    const next: Point[] = [];

    for (let i = 0; i < n; i++) {
      const p0 = pts[i];
      const p1 = pts[(i + 1) % n];

      // Q and R points for the edge.
      const q = {
        x: 0.75 * p0.x + 0.25 * p1.x,
        y: 0.75 * p0.y + 0.25 * p1.y,
      };
      const r = {
        x: 0.25 * p0.x + 0.75 * p1.x,
        y: 0.25 * p0.y + 0.75 * p1.y,
      };

      next.push(q, r);
    }

    pts = next;
  }

  return pts;
}
