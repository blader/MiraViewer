type PxPoint = { x: number; y: number };

function clamp(v: number, lo: number, hi: number) {
  return Math.max(lo, Math.min(hi, v));
}

function idx(x: number, y: number, w: number) {
  return y * w + x;
}

function isSet(mask: Uint8Array, w: number, h: number, x: number, y: number): boolean {
  if (x < 0 || y < 0 || x >= w || y >= h) return false;
  return mask[idx(x, y, w)] !== 0;
}

function isBoundaryPixel(mask: Uint8Array, w: number, h: number, x: number, y: number): boolean {
  if (!isSet(mask, w, h, x, y)) return false;
  // 4-neighborhood boundary.
  return (
    !isSet(mask, w, h, x - 1, y) ||
    !isSet(mask, w, h, x + 1, y) ||
    !isSet(mask, w, h, x, y - 1) ||
    !isSet(mask, w, h, x, y + 1)
  );
}

// Moore-Neighbor tracing for an 8-connected boundary.
// Neighbor directions (clockwise) - defined once outside function to avoid allocation.
const DIRS: readonly PxPoint[] = [
  { x: 1, y: 0 },
  { x: 1, y: 1 },
  { x: 0, y: 1 },
  { x: -1, y: 1 },
  { x: -1, y: 0 },
  { x: -1, y: -1 },
  { x: 0, y: -1 },
  { x: 1, y: -1 },
];

// Pre-computed direction lookup: dirLookup[dx+1][dy+1] = direction index
const DIR_LOOKUP: number[][] = [
  [5, 4, 3], // dx=-1: dy=-1,0,1
  [6, -1, 2], // dx=0: dy=-1,0,1 (center is invalid)
  [7, 0, 1], // dx=1: dy=-1,0,1
];

function traceFrom(mask: Uint8Array, w: number, h: number, start: PxPoint): PxPoint[] {
  const boundary: PxPoint[] = [];

  let cx = start.x;
  let cy = start.y;
  // Backtrack point is initially the pixel to the left.
  let bx = start.x - 1;
  let by = start.y;

  // Hard limit to prevent infinite loops - max boundary length is perimeter of image.
  const maxIters = Math.min(50000, (w + h) * 4);

  for (let iter = 0; iter < maxIters; iter++) {
    boundary.push({ x: cx, y: cy });

    // Find direction index from current -> back using lookup table.
    const dx = clamp(bx - cx, -1, 1);
    const dy = clamp(by - cy, -1, 1);
    let startDir = DIR_LOOKUP[dx + 1][dy + 1];
    if (startDir < 0) startDir = 4; // fallback

    // Search neighbors clockwise starting from back direction.
    let foundNext = false;
    let nx = 0, ny = 0, nbx = 0, nby = 0;

    for (let k = 0; k < 8; k++) {
      const di = (startDir + 1 + k) % 8;
      const dir = DIRS[di];
      const testX = cx + dir.x;
      const testY = cy + dir.y;

      if (isBoundaryPixel(mask, w, h, testX, testY)) {
        nx = testX;
        ny = testY;
        // The new backtrack is the neighbor just before nx,ny in the search order.
        const backDi = (di + 7) % 8;
        const backDir = DIRS[backDi];
        nbx = cx + backDir.x;
        nby = cy + backDir.y;
        foundNext = true;
        break;
      }
    }

    if (!foundNext) break;

    // Close when we return to the start with the same backtrack.
    if (nx === start.x && ny === start.y && nbx === bx && nby === by) {
      break;
    }

    cx = nx;
    cy = ny;
    bx = nbx;
    by = nby;
  }

  return boundary;
}

export function traceLargestBoundary(
  mask: Uint8Array,
  w: number,
  h: number,
  roi?: { x0: number; y0: number; x1: number; y1: number }
): PxPoint[] {
  const x0 = roi ? clamp(Math.floor(roi.x0), 0, w - 1) : 0;
  const y0 = roi ? clamp(Math.floor(roi.y0), 0, h - 1) : 0;
  const x1 = roi ? clamp(Math.ceil(roi.x1), 0, w - 1) : w - 1;
  const y1 = roi ? clamp(Math.ceil(roi.y1), 0, h - 1) : h - 1;

  console.log('[traceLargestBoundary] START', { w, h, roi: { x0, y0, x1, y1 } });
  const t0 = performance.now();

  let best: PxPoint[] = [];
  const visited = new Uint8Array(w * h);
  let boundariesFound = 0;

  // Only scan within ROI to avoid O(w*h) scan of entire image.
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const i = idx(x, y, w);
      if (visited[i]) continue;
      if (!isBoundaryPixel(mask, w, h, x, y)) continue;

      const b = traceFrom(mask, w, h, { x, y });
      boundariesFound++;
      for (const p of b) {
        visited[idx(p.x, p.y, w)] = 1;
      }

      if (b.length > best.length) {
        best = b;
      }
    }
  }

  const elapsed = performance.now() - t0;
  console.log('[traceLargestBoundary] DONE', { boundariesFound, bestLength: best.length, elapsed: elapsed.toFixed(1) + 'ms' });

  return best;
}
