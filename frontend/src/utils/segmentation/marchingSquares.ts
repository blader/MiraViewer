export type Roi = { x0: number; y0: number; x1: number; y1: number };
export type PxPoint = { x: number; y: number };

function clamp(v: number, lo: number, hi: number) {
  return Math.max(lo, Math.min(hi, v));
}

function edgeKey(a: string, b: string) {
  return a < b ? `${a}|${b}` : `${b}|${a}`;
}

function parseKey(k: string): { x2: number; y2: number } {
  const [xs, ys] = k.split(',');
  return { x2: Number(xs), y2: Number(ys) };
}

function keyOf(x2: number, y2: number): string {
  return `${x2},${y2}`;
}

function addUndirectedEdge(adj: Map<string, string[]>, a: string, b: string) {
  const la = adj.get(a);
  if (la) la.push(b);
  else adj.set(a, [b]);

  const lb = adj.get(b);
  if (lb) lb.push(a);
  else adj.set(b, [a]);
}

function polygonArea(points: PxPoint[]): number {
  let a = 0;
  for (let i = 0; i < points.length; i++) {
    const p = points[i];
    const q = points[(i + 1) % points.length];
    a += p.x * q.y - q.x * p.y;
  }
  return a / 2;
}

// Marching-squares-style table that connects midpoints on the 4 cell edges.
// Edge indices:
// 0 = top, 1 = right, 2 = bottom, 3 = left
const CASE_TO_SEGMENTS: ReadonlyArray<ReadonlyArray<readonly [number, number]>> = [
  [], // 0
  [[3, 2]], // 1
  [[2, 1]], // 2
  [[3, 1]], // 3
  [[0, 1]], // 4
  [
    [0, 1],
    [3, 2],
  ], // 5 (ambiguous)
  [[0, 2]], // 6
  [[0, 3]], // 7
  [[0, 3]], // 8
  [[0, 2]], // 9
  [
    [0, 3],
    [2, 1],
  ], // 10 (ambiguous)
  [[0, 1]], // 11
  [[3, 1]], // 12
  [[2, 1]], // 13
  [[3, 2]], // 14
  [], // 15
];

function edgeMidpointKey2x(edge: number, cellX: number, cellY: number): string {
  // Coordinates are in pixel-index space, scaled by 2 to keep integers.
  // Cell corners are at (cellX, cellY) .. (cellX+1, cellY+1).
  switch (edge) {
    case 0: // top
      return keyOf(2 * cellX + 1, 2 * cellY);
    case 1: // right
      return keyOf(2 * cellX + 2, 2 * cellY + 1);
    case 2: // bottom
      return keyOf(2 * cellX + 1, 2 * cellY + 2);
    case 3: // left
      return keyOf(2 * cellX, 2 * cellY + 1);
    default:
      return keyOf(0, 0);
  }
}

/**
 * Extract the outer contour of a binary mask.
 *
 * Returns a single polygon (the loop with the largest absolute area).
 * Coordinates are returned in pixel-index space (0..w-1 / 0..h-1) with 0.5 increments.
 */
export function marchingSquaresContour(
  mask: Uint8Array,
  w: number,
  h: number,
  roi?: Roi
): PxPoint[] {
  if (w <= 1 || h <= 1) return [];

  // Build segment adjacency graph.
  const adj = new Map<string, string[]>();

  const cellX0 = roi ? clamp(Math.floor(roi.x0) - 1, 0, w - 2) : 0;
  const cellY0 = roi ? clamp(Math.floor(roi.y0) - 1, 0, h - 2) : 0;
  const cellX1 = roi ? clamp(Math.ceil(roi.x1) + 1, 0, w - 1) : w - 1; // exclusive upper bound
  const cellY1 = roi ? clamp(Math.ceil(roi.y1) + 1, 0, h - 1) : h - 1; // exclusive upper bound

  for (let y = cellY0; y < cellY1; y++) {
    const row0 = y * w;
    const row1 = (y + 1) * w;

    for (let x = cellX0; x < cellX1; x++) {
      const tl = mask[row0 + x] ? 1 : 0;
      const tr = mask[row0 + x + 1] ? 1 : 0;
      const br = mask[row1 + x + 1] ? 1 : 0;
      const bl = mask[row1 + x] ? 1 : 0;

      const idx = (tl << 3) | (tr << 2) | (br << 1) | bl;
      const segments = CASE_TO_SEGMENTS[idx];
      if (!segments.length) continue;

      for (const [e0, e1] of segments) {
        const a = edgeMidpointKey2x(e0, x, y);
        const b = edgeMidpointKey2x(e1, x, y);
        addUndirectedEdge(adj, a, b);
      }
    }
  }

  if (adj.size === 0) return [];

  // Trace all loops.
  const visitedEdges = new Set<string>();
  const loops: PxPoint[][] = [];

  for (const [start, nbrs] of adj) {
    for (const first of nbrs) {
      const ek0 = edgeKey(start, first);
      if (visitedEdges.has(ek0)) continue;

      const loopKeys: string[] = [start];
      let prev = start;
      let curr = first;

      // Safety to avoid infinite walks on malformed graphs.
      const maxSteps = 200000;
      let steps = 0;

      while (steps++ < maxSteps) {
        visitedEdges.add(edgeKey(prev, curr));
        loopKeys.push(curr);

        if (curr === start) break;

        const nextCandidates = adj.get(curr);
        if (!nextCandidates || nextCandidates.length === 0) break;

        // Prefer an unvisited edge that doesn't go back to prev.
        const next =
          nextCandidates.find((n) => n !== prev && !visitedEdges.has(edgeKey(curr, n))) ??
          nextCandidates.find((n) => n !== prev) ??
          nextCandidates[0];

        prev = curr;
        curr = next;
      }

      // Keep only closed loops.
      if (loopKeys.length >= 4 && loopKeys[loopKeys.length - 1] === start) {
        // Remove duplicated closing point.
        loopKeys.pop();

        const pts: PxPoint[] = loopKeys.map((k) => {
          const { x2, y2 } = parseKey(k);
          return { x: x2 / 2, y: y2 / 2 };
        });

        // Ignore tiny loops.
        if (pts.length >= 3) {
          loops.push(pts);
        }
      }
    }
  }

  if (loops.length === 0) return [];

  // Return the largest-area loop as the outer contour.
  let best = loops[0];
  let bestArea = Math.abs(polygonArea(best));

  for (let i = 1; i < loops.length; i++) {
    const a = Math.abs(polygonArea(loops[i]));
    if (a > bestArea) {
      bestArea = a;
      best = loops[i];
    }
  }

  return best;
}
