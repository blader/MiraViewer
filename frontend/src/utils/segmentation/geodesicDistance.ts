export type Roi = { x0: number; y0: number; x1: number; y1: number };

type HeapItem = { idx: number; d: number };

class MinHeap {
  private items: HeapItem[] = [];

  push(item: HeapItem) {
    const a = this.items;
    a.push(item);
    let i = a.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (a[p]!.d <= a[i]!.d) break;
      const tmp = a[p]!;
      a[p] = a[i]!;
      a[i] = tmp;
      i = p;
    }
  }

  pop(): HeapItem | null {
    const a = this.items;
    const n = a.length;
    if (n === 0) return null;

    const out = a[0]!;
    const last = a.pop()!;
    if (n > 1) {
      a[0] = last;

      let i = 0;
      for (;;) {
        const l = i * 2 + 1;
        const r = l + 1;
        let smallest = i;

        if (l < a.length && a[l]!.d < a[smallest]!.d) smallest = l;
        if (r < a.length && a[r]!.d < a[smallest]!.d) smallest = r;

        if (smallest === i) break;
        const tmp = a[i]!;
        a[i] = a[smallest]!;
        a[smallest] = tmp;
        i = smallest;
      }
    }

    return out;
  }

  get size() {
    return this.items.length;
  }
}

function clamp(v: number, lo: number, hi: number) {
  return Math.max(lo, Math.min(hi, v));
}

/**
 * Compute an edge-aware geodesic distance from seed pixels within an ROI.
 *
 * The cost to step into a pixel is:
 *   1 + edgeCostStrength * (grad/255)
 *
 * This makes crossing strong edges more expensive, which helps prevent leakage
 * across boundaries without requiring the user to paint negative/background strokes.
 */
export function computeGeodesicDistanceToSeeds(params: {
  w: number;
  h: number;
  roi: Roi;
  /** Seed pixels (image pixel coords). */
  seeds: Array<{ x: number; y: number }>;
  /** Gradient magnitude image (0..255). If omitted, treated as all zeros. */
  grad?: Uint8Array;
  edgeCostStrength: number;
  /**
   * Optional onset for edge costs (0..255).
   *
   * If provided, gradients below this barrier are treated as "not an edge" (zero extra cost),
   * and only gradients above the barrier increase step cost.
   */
  edgeBarrier?: number;
  /** Optional cutoff: distances beyond this are not expanded (remain Infinity). */
  maxDist?: number;
}): Float32Array {
  const { w, h } = params;
  const dist = new Float32Array(w * h);
  dist.fill(Number.POSITIVE_INFINITY);

  if (w <= 0 || h <= 0) return dist;

  const x0 = clamp(Math.floor(params.roi.x0), 0, w - 1);
  const y0 = clamp(Math.floor(params.roi.y0), 0, h - 1);
  const x1 = clamp(Math.ceil(params.roi.x1), 0, w - 1);
  const y1 = clamp(Math.ceil(params.roi.y1), 0, h - 1);

  const grad = params.grad;
  const k = Math.max(0, params.edgeCostStrength);
  const maxDist = typeof params.maxDist === 'number' && Number.isFinite(params.maxDist) ? params.maxDist : null;

  const barrier =
    typeof params.edgeBarrier === 'number' && Number.isFinite(params.edgeBarrier)
      ? clamp(params.edgeBarrier, 0, 255)
      : null;

  const heap = new MinHeap();

  // Seed the heap.
  for (const s of params.seeds) {
    const sx = clamp(Math.round(s.x), x0, x1);
    const sy = clamp(Math.round(s.y), y0, y1);
    const idx = sy * w + sx;
    if (dist[idx] === 0) continue;
    dist[idx] = 0;
    heap.push({ idx, d: 0 });
  }

  if (heap.size === 0) return dist;

  const stepCost = (idx: number) => {
    const gRaw = grad ? grad[idx] ?? 0 : 0;

    const edgeFrac = (() => {
      // Default behavior (no barrier): treat grad as a continuous 0..255 edge weight.
      if (barrier == null) return gRaw / 255;

      // Barrier behavior: only penalize gradients above the onset.
      // This avoids making *all* mild texture act like a distance wall.
      if (gRaw <= barrier) return 0;

      const denom = Math.max(1, 255 - barrier);
      return clamp((gRaw - barrier) / denom, 0, 1);
    })();

    return 1 + k * edgeFrac;
  };

  while (heap.size > 0) {
    const item = heap.pop();
    if (!item) break;

    const d = item.d;
    const idx = item.idx;

    // Skip stale heap entries.
    if (d !== dist[idx]) continue;

    if (maxDist != null && d > maxDist) {
      // With positive costs, all remaining paths will be >= d, so we can stop.
      break;
    }

    const x = idx % w;
    const y = (idx - x) / w;

    // 4-neighborhood within ROI.
    if (x > x0) {
      const ni = idx - 1;
      const nd = d + stepCost(ni);
      if (nd < dist[ni]) {
        dist[ni] = nd;
        heap.push({ idx: ni, d: nd });
      }
    }
    if (x < x1) {
      const ni = idx + 1;
      const nd = d + stepCost(ni);
      if (nd < dist[ni]) {
        dist[ni] = nd;
        heap.push({ idx: ni, d: nd });
      }
    }
    if (y > y0) {
      const ni = idx - w;
      const nd = d + stepCost(ni);
      if (nd < dist[ni]) {
        dist[ni] = nd;
        heap.push({ idx: ni, d: nd });
      }
    }
    if (y < y1) {
      const ni = idx + w;
      const nd = d + stepCost(ni);
      if (nd < dist[ni]) {
        dist[ni] = nd;
        heap.push({ idx: ni, d: nd });
      }
    }
  }

  return dist;
}
