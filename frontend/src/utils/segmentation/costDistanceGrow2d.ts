export type Roi = { x0: number; y0: number; x1: number; y1: number };

type RobustStats = { mu: number; sigma: number };

type PxPoint = { x: number; y: number };

function clamp(v: number, lo: number, hi: number) {
  return Math.max(lo, Math.min(hi, v));
}

function clampInt(v: number, lo: number, hi: number): number {
  if (!Number.isFinite(v)) return lo;
  return clamp(Math.round(v), lo, hi);
}

function mixU32(x: number): number {
  // A small 32-bit mixing function for deterministic RNG seeding.
  // https://en.wikipedia.org/wiki/Fowler%E2%80%93Noll%E2%80%93Vo_hash_function (in spirit; not exact)
  let y = x >>> 0;
  y ^= y >>> 16;
  y = Math.imul(y, 0x7feb352d);
  y ^= y >>> 15;
  y = Math.imul(y, 0x846ca68b);
  y ^= y >>> 16;
  return y >>> 0;
}

function mulberry32(seed: number): () => number {
  // Deterministic PRNG returning [0,1).
  // Good enough for sampling UI seeds; not for crypto.
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function medianOfNumbers(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[mid] ?? 0;
  const a = sorted[mid - 1] ?? 0;
  const b = sorted[mid] ?? 0;
  return (a + b) / 2;
}

function robustStats(samples: number[], sigmaFloor = 6): RobustStats | null {
  if (samples.length < 16) return null;

  const mu = medianOfNumbers(samples);
  const abs = samples.map((v) => Math.abs(v - mu));
  const mad = medianOfNumbers(abs);

  // Convert MAD to a robust estimate of sigma (normal distribution factor).
  const sigmaMad = 1.4826 * mad;

  // Keep a floor so we don't become overly confident from small/noisy samples.
  const sigma = Math.max(sigmaFloor, sigmaMad);

  if (!Number.isFinite(mu) || !Number.isFinite(sigma)) return null;
  return { mu, sigma };
}

type GradientCache = { w: number; h: number; grad: Uint8Array };
const gradientCache = new WeakMap<Uint8Array, GradientCache>();

function getGradientMagnitude(gray: Uint8Array, w: number, h: number): Uint8Array {
  const existing = gradientCache.get(gray);
  if (existing && existing.w === w && existing.h === h) return existing.grad;

  const out = new Uint8Array(w * h);

  // Simple Sobel gradient magnitude (L1 approx), scaled to 0..255.
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i00 = gray[(y - 1) * w + (x - 1)] ?? 0;
      const i01 = gray[(y - 1) * w + x] ?? 0;
      const i02 = gray[(y - 1) * w + (x + 1)] ?? 0;
      const i10 = gray[y * w + (x - 1)] ?? 0;
      const i12 = gray[y * w + (x + 1)] ?? 0;
      const i20 = gray[(y + 1) * w + (x - 1)] ?? 0;
      const i21 = gray[(y + 1) * w + x] ?? 0;
      const i22 = gray[(y + 1) * w + (x + 1)] ?? 0;

      const gx = -i00 - 2 * i10 - i20 + i02 + 2 * i12 + i22;
      const gy = -i00 - 2 * i01 - i02 + i20 + 2 * i21 + i22;

      const mag = (Math.abs(gx) + Math.abs(gy)) / 4;
      out[y * w + x] = clamp(Math.round(mag), 0, 255);
    }
  }

  gradientCache.set(gray, { w, h, grad: out });
  return out;
}

type Heap = {
  idx: number[];
  d: number[];
  lastD: number;
  push: (idx: number, d: number) => void;
  pop: () => number | null;
  size: () => number;
};

function createMinHeap(): Heap {
  const idx: number[] = [];
  const d: number[] = [];

  const heap: Heap = {
    idx,
    d,
    lastD: 0,
    push: (i: number, dist: number) => {
      idx.push(i);
      d.push(dist);
      let k = idx.length - 1;
      while (k > 0) {
        const p = (k - 1) >> 1;
        if ((d[p] ?? 0) <= dist) break;

        // Swap with parent.
        idx[k] = idx[p]!;
        d[k] = d[p]!;
        idx[p] = i;
        d[p] = dist;
        k = p;
      }
    },
    pop: () => {
      const n = idx.length;
      if (n === 0) return null;

      const outIdx = idx[0]!;
      const outD = d[0]!;

      const lastIdx = idx.pop()!;
      const lastD = d.pop()!;

      if (n > 1) {
        idx[0] = lastIdx;
        d[0] = lastD;

        let k = 0;
        for (;;) {
          const l = k * 2 + 1;
          const r = l + 1;
          let smallest = k;

          if (l < idx.length && (d[l] ?? 0) < (d[smallest] ?? 0)) smallest = l;
          if (r < idx.length && (d[r] ?? 0) < (d[smallest] ?? 0)) smallest = r;

          if (smallest === k) break;

          // Swap.
          {
            const ti = idx[k]!;
            const td = d[k]!;
            idx[k] = idx[smallest]!;
            d[k] = d[smallest]!;
            idx[smallest] = ti;
            d[smallest] = td;
          }

          k = smallest;
        }
      }

      heap.lastD = outD;
      return outIdx;
    },
    size: () => idx.length,
  };

  return heap;
}

function computeDefaultRoi(seedPx: PxPoint, w: number, h: number): Roi {
  const minDim = Math.max(1, Math.min(w, h));

  // Heuristic: keep the ROI large enough to capture typical tumors but bounded enough
  // that contour extraction stays responsive.
  const r = clamp(Math.round(minDim * 0.45), 80, Math.round(minDim * 0.9));

  const x0 = clamp(Math.round(seedPx.x - r), 0, w - 1);
  const x1 = clamp(Math.round(seedPx.x + r), 0, w - 1);
  const y0 = clamp(Math.round(seedPx.y - r), 0, h - 1);
  const y1 = clamp(Math.round(seedPx.y + r), 0, h - 1);

  return { x0, y0, x1, y1 };
}

function sampleDisk(gray: Uint8Array, w: number, cx: number, cy: number, r: number, roi: Roi): number[] {
  const out: number[] = [];

  const x0 = clamp(Math.floor(cx - r), roi.x0, roi.x1);
  const x1 = clamp(Math.ceil(cx + r), roi.x0, roi.x1);
  const y0 = clamp(Math.floor(cy - r), roi.y0, roi.y1);
  const y1 = clamp(Math.ceil(cy + r), roi.y0, roi.y1);

  const r2 = r * r;

  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const dx = x - cx;
      const dy = y - cy;
      if (dx * dx + dy * dy > r2) continue;
      out.push(gray[y * w + x] ?? 0);
    }
  }

  return out;
}

function sampleAnnulus(params: {
  gray: Uint8Array;
  grad: Uint8Array | null;
  w: number;
  h: number;
  cx: number;
  cy: number;
  rMin: number;
  rMax: number;
  roi: Roi;
  edgeExclusionGrad: number;
  maxSamples: number;
}): number[] {
  const { gray, grad, w, cx, cy, rMin, rMax, roi, edgeExclusionGrad, maxSamples } = params;

  const out: number[] = [];
  const rMin2 = rMin * rMin;
  const rMax2 = rMax * rMax;

  // Deterministic coarse sampling grid.
  const roiW = Math.max(1, roi.x1 - roi.x0 + 1);
  const roiH = Math.max(1, roi.y1 - roi.y0 + 1);
  const roiArea = roiW * roiH;

  // Keep samples bounded for performance.
  const stride = clamp(Math.floor(Math.sqrt(roiArea / Math.max(1, maxSamples))), 1, 8);

  for (let y = roi.y0; y <= roi.y1; y += stride) {
    for (let x = roi.x0; x <= roi.x1; x += stride) {
      const dx = x - cx;
      const dy = y - cy;
      const d2 = dx * dx + dy * dy;
      if (d2 < rMin2 || d2 > rMax2) continue;

      const i = y * w + x;
      const g = grad ? grad[i] ?? 0 : 0;
      if (g > edgeExclusionGrad) continue;

      out.push(gray[i] ?? 0);
      if (out.length >= maxSamples) return out;
    }
  }

  return out;
}

export type CostDistanceGrow2dWeights = {
  /** How strongly strong edges act like distance walls. */
  edgeCostStrength?: number;
  /** If omitted, computed near the seed; values <= barrier contribute 0 edge cost. */
  edgeBarrierGrad?: number;

  /** Penalty for stepping across large intensity jumps. */
  crossCostStrength?: number;

  /** Soft penalty for tumor-unlike intensities. */
  tumorCostStrength?: number;

  /** Soft penalty when a pixel is more background-like than tumor-like. */
  bgCostStrength?: number;
  bgRejectMarginZ?: number;

  /** Whether to allow diagonal steps (recommended for smoother growth). */
  allowDiagonal?: boolean;

  /** Robust sigma floor for tumor/background stats. */
  sigmaFloor?: number;
};

// UI-tunable parameters for the 2D cost-distance grow.
// Kept separate from weights so we can expose a small, curated set of live sliders.
export type CostDistanceGrow2dTuning = {
  /** Radial prior penalty weight (outside the seed box), in cost units. */
  radialOuterW?: number;
  /** Radial prior penalty cap (outside the seed box), in cost units. */
  radialOuterCap?: number;

  /** Global path-length penalty scale. */
  baseStepScale?: number;

  /** Exponent shaping the low/mid intensity penalty ramp (lower => harsher mid). */
  preferHighExponent?: number;
  /** Multiplier for the low/mid intensity penalty (relative to edgeCostStrength). */
  preferHighStrengthMul?: number;

  /** Additional multiplier applied to uphill steps starting in low intensities (helps prevent bridging). */
  uphillFromLowMult?: number;
};

export type CostDistanceGrow2dResult = {
  w: number;
  h: number;
  /** Anchor point selected by the user (and always included as a seed). */
  seedPx: PxPoint;
  /** All seeds actually used to initialize the distance map (multi-source Dijkstra). */
  seedPxs: PxPoint[];
  /** Sampling box used to choose additional seeds (clamped inside `roi`). */
  seedBox: Roi;
  roi: Roi;
  dist: Float32Array;

  quantileLut: Float32Array; // 256 entries
  maxFiniteDist: number;

  stats: {
    tumor: RobustStats;
    bg: RobustStats | null;
    edgeBarrier: number;
  };

  weights: Required<CostDistanceGrow2dWeights>;
  tuning: Required<CostDistanceGrow2dTuning>;
};

export async function computeCostDistanceMap(params: {
  gray: Uint8Array;
  w: number;
  h: number;
  /** Anchor seed. Additional seeds (if any) are sampled around this point. */
  seedPx: PxPoint;
  roi?: Roi;
  weights?: CostDistanceGrow2dWeights;
  tuning?: CostDistanceGrow2dTuning;

  /**
   * Total number of seeds to initialize the distance map with.
   * - 1 => single-seed (previous behavior)
   * - >1 => multi-seed (more robust to single-pixel noise)
   */
  seedCount?: number;

  /** Optional explicit box for sampling additional seeds (in px coords). */
  seedBox?: Roi;

  /** Optional deterministic RNG seed for seed sampling. */
  seedRngSeed?: number;

  /** Yield to UI after this many heap pops. 0 disables yielding. */
  yieldEvery?: number;
  yieldToUi?: () => Promise<void>;
  signal?: AbortSignal;
}): Promise<CostDistanceGrow2dResult> {
  const { gray, w, h } = params;

  if (w <= 0 || h <= 0) {
    throw new Error('Invalid image size');
  }

  const seedPx = {
    x: clampInt(params.seedPx.x, 0, w - 1),
    y: clampInt(params.seedPx.y, 0, h - 1),
  };

  const roi = (() => {
    const r = params.roi ?? computeDefaultRoi(seedPx, w, h);
    return {
      x0: clampInt(r.x0, 0, w - 1),
      y0: clampInt(r.y0, 0, h - 1),
      x1: clampInt(r.x1, 0, w - 1),
      y1: clampInt(r.y1, 0, h - 1),
    };
  })();

  const weights: Required<CostDistanceGrow2dWeights> = {
    edgeCostStrength: params.weights?.edgeCostStrength ?? 8,
    edgeBarrierGrad: params.weights?.edgeBarrierGrad ?? -1,
    crossCostStrength: params.weights?.crossCostStrength ?? 0.6,
    tumorCostStrength: params.weights?.tumorCostStrength ?? 0.15,
    bgCostStrength: params.weights?.bgCostStrength ?? 1.0,
    bgRejectMarginZ: params.weights?.bgRejectMarginZ ?? 0.75,
    allowDiagonal: params.weights?.allowDiagonal ?? true,
    sigmaFloor: params.weights?.sigmaFloor ?? 6,
  };

  const debugEnabled =
    typeof localStorage !== 'undefined' && localStorage.getItem('miraviewer:debug-grow2d') === '1';

  const grad = getGradientMagnitude(gray, w, h);

  const seedBoxExplicit = !!params.seedBox;

  const seedBox = (() => {
    const box = params.seedBox;
    if (box) {
      const x0 = clampInt(box.x0, roi.x0, roi.x1);
      const x1 = clampInt(box.x1, roi.x0, roi.x1);
      const y0 = clampInt(box.y0, roi.y0, roi.y1);
      const y1 = clampInt(box.y1, roi.y0, roi.y1);
      return {
        x0: Math.min(x0, x1),
        x1: Math.max(x0, x1),
        y0: Math.min(y0, y1),
        y1: Math.max(y0, y1),
      };
    }

    // Default: sample extra seeds within a small box around the anchor seed,
    // but always clamp inside the ROI.
    const roiW = Math.max(1, roi.x1 - roi.x0 + 1);
    const roiH = Math.max(1, roi.y1 - roi.y0 + 1);
    const minDim = Math.max(1, Math.min(roiW, roiH));
    const half = clampInt(Math.round(minDim * 0.07), 6, 24);

    return {
      x0: clampInt(seedPx.x - half, roi.x0, roi.x1),
      x1: clampInt(seedPx.x + half, roi.x0, roi.x1),
      y0: clampInt(seedPx.y - half, roi.y0, roi.y1),
      y1: clampInt(seedPx.y + half, roi.y0, roi.y1),
    };
  })();

  const tuning: Required<CostDistanceGrow2dTuning> = {
    // NOTE: default these to 0 so the baseline behavior is governed by edge/jump costs + baseStepScale.
    // The UI can selectively enable additional priors if they prove useful.
    radialOuterW:
      typeof params.tuning?.radialOuterW === 'number' && Number.isFinite(params.tuning.radialOuterW)
        ? clamp(params.tuning.radialOuterW, 0, 30)
        : 0,
    radialOuterCap:
      typeof params.tuning?.radialOuterCap === 'number' && Number.isFinite(params.tuning.radialOuterCap)
        ? clamp(params.tuning.radialOuterCap, 0, 192)
        : 0,

    baseStepScale:
      typeof params.tuning?.baseStepScale === 'number' && Number.isFinite(params.tuning.baseStepScale)
        ? clamp(params.tuning.baseStepScale, 0.25, 50)
        : 1.65,

    preferHighExponent:
      typeof params.tuning?.preferHighExponent === 'number' && Number.isFinite(params.tuning.preferHighExponent)
        ? clamp(params.tuning.preferHighExponent, 0.5, 3)
        : 1.15,
    preferHighStrengthMul:
      typeof params.tuning?.preferHighStrengthMul === 'number' && Number.isFinite(params.tuning.preferHighStrengthMul)
        ? clamp(params.tuning.preferHighStrengthMul, 0, 20)
        : 0,

    uphillFromLowMult:
      typeof params.tuning?.uphillFromLowMult === 'number' && Number.isFinite(params.tuning.uphillFromLowMult)
        ? clamp(params.tuning.uphillFromLowMult, 1, 20)
        : 1.0,
  };

  // Optional spatial prior: apply a smooth radial penalty outside a small centroid neighborhood.
  //
  // This intentionally does *not* depend on the user-drawn seed box shape/size; the seed box is only
  // used to pick the centroid.
  const radialPrior = (() => {
    if (!(tuning.radialOuterW > 0) || !(tuning.radialOuterCap > 0)) return null;

    const cx = seedPx.x;
    const cy = seedPx.y;

    // Use the (possibly default) seedBox dimensions only as a stable scale for when the penalty starts.
    // The UI no longer passes an explicit seed box for segmentation.
    const hx = Math.max(1e-6, (seedBox.x1 - seedBox.x0 + 1) * 0.5);
    const hy = Math.max(1e-6, (seedBox.y1 - seedBox.y0 + 1) * 0.5);

    return { cx, cy, hx, hy };
  })();

  // Radial prior (centroid neighborhood):
  // - Inside the core box: no radial bias. Let edges + intensities determine the boundary.
  // - Outside the core box: smooth penalty ramp to discourage long-distance leakage.

  const radialPenaltyAt = (x: number, y: number): number => {
    const rp = radialPrior;
    if (!rp) return 0;

    // L∞ "radius" in box-normalized coordinates.
    const dx = Math.abs(x - rp.cx) / rp.hx;
    const dy = Math.abs(y - rp.cy) / rp.hy;
    const rInf = Math.max(dx, dy);

    if (rInf <= 1) return 0;

    const t = rInf - 1;
    return Math.min(tuning.radialOuterCap, tuning.radialOuterW * t * t);
  };

  // Estimate tumor stats:
  // - If the user drew an explicit seed box, sample inside that box (better captures multi-modal tumors,
  //   including very bright/cystic regions on FLAIR).
  // - Otherwise, fall back to a small disk around the anchor seed.
  //
  // We also compute loose low/high intensity gates used to shape *directional* edge/jump costs:
  // - stepping into brighter values should be easier (to include bright cystic areas)
  // - stepping into much darker values should be harder (to prevent leaking into background)
  const tumorPrior = (() => {
    let qLo: number | null = null;
    let qHi: number | null = null;

    if (seedBoxExplicit) {
      const box = seedBox;
      const boxW = Math.max(1, box.x1 - box.x0 + 1);
      const boxH = Math.max(1, box.y1 - box.y0 + 1);
      const boxArea = boxW * boxH;

      // Keep sampling bounded for performance.
      const maxSamples = 2048;
      const stride = clamp(Math.floor(Math.sqrt(boxArea / Math.max(1, maxSamples))), 1, 6);

      const samples: number[] = [];

      // Avoid seeding stats from strong edges (they tend to be background boundaries).
      const edgeExclusionGrad = 220;

      for (let y = box.y0; y <= box.y1; y += stride) {
        for (let x = box.x0; x <= box.x1; x += stride) {
          const i = y * w + x;
          const g = grad[i] ?? 0;
          if (g > edgeExclusionGrad) continue;
          samples.push(gray[i] ?? 0);
          if (samples.length >= maxSamples) break;
        }
        if (samples.length >= maxSamples) break;
      }

      if (samples.length >= 32) {
        const sorted = [...samples].sort((a, b) => a - b);
        const n = sorted.length;
        qLo = sorted[Math.floor(0.02 * (n - 1))] ?? null;
        qHi = sorted[Math.floor(0.995 * (n - 1))] ?? null;
      }

      const s = robustStats(samples, weights.sigmaFloor);
      if (s) return { stats: s, qLo, qHi };
    }

    const disk = sampleDisk(gray, w, seedPx.x, seedPx.y, 5, roi);
    const s = robustStats(disk, weights.sigmaFloor) ?? { mu: gray[seedPx.y * w + seedPx.x] ?? 0, sigma: 10 };
    return { stats: s, qLo, qHi };
  })();

  const tumorStats = tumorPrior.stats;

  const tumorLoGate = clamp(tumorPrior.qLo ?? (tumorStats.mu - 2.0 * tumorStats.sigma), 0, 255);
  const tumorHiGate = clamp(tumorPrior.qHi ?? (tumorStats.mu + 2.0 * tumorStats.sigma), 0, 255);

  // Estimate background stats from an annulus around the seed.
  const bgStats = (() => {
    const samples = sampleAnnulus({
      gray,
      grad,
      w,
      h,
      cx: seedPx.x,
      cy: seedPx.y,
      rMin: 14,
      rMax: 52,
      roi,
      edgeExclusionGrad: 200,
      maxSamples: 1024,
    });
    return robustStats(samples, weights.sigmaFloor);
  })();

  // Edge barrier: estimate typical gradient near the seed neighborhood.
  const edgeBarrier = (() => {
    if (weights.edgeBarrierGrad >= 0) return clamp(Math.round(weights.edgeBarrierGrad), 0, 255);

    const edgeSamples: number[] = [];

    // Re-sample gradients deterministically on a small ring.
    // We keep this separate to avoid making edgeBarrier sensitive to intensity distributions.
    const rMin2 = 8 * 8;
    const rMax2 = 22 * 22;
    const stride = 2;
    for (let y = roi.y0; y <= roi.y1; y += stride) {
      for (let x = roi.x0; x <= roi.x1; x += stride) {
        const dx = x - seedPx.x;
        const dy = y - seedPx.y;
        const d2 = dx * dx + dy * dy;
        if (d2 < rMin2 || d2 > rMax2) continue;
        edgeSamples.push(grad[y * w + x] ?? 0);
        if (edgeSamples.length >= 256) break;
      }
      if (edgeSamples.length >= 256) break;
    }

    const med = edgeSamples.length ? medianOfNumbers(edgeSamples) : 0;
    return Math.max(25, Math.round(med * 1.2));
  })();

  const seedCount = clampInt(params.seedCount ?? 1, 1, 64);

  const seedPxs = (() => {
    const all: PxPoint[] = [{ ...seedPx }];
    if (seedCount <= 1) return all;

    const extraWanted = seedCount - 1;
    const seedIdx0 = seedPx.y * w + seedPx.x;

    const rngSeed =
      typeof params.seedRngSeed === 'number' && Number.isFinite(params.seedRngSeed)
        ? mixU32(params.seedRngSeed)
        : mixU32(
            seedIdx0 ^
              Math.imul(roi.x0 + 1, 0x9e3779b1) ^
              Math.imul(roi.y0 + 1, 0x85ebca6b) ^
              Math.imul(roi.x1 + 1, 0xc2b2ae35) ^
              Math.imul(roi.y1 + 1, 0x27d4eb2f) ^
              Math.imul(seedBox.x0 + 1, 0x165667b1) ^
              Math.imul(seedBox.y0 + 1, 0xd3a2646c),
          );

    const rng = mulberry32(rngSeed);

    const chosen = new Set<number>();
    chosen.add(seedIdx0);

    const vMu = tumorStats.mu;
    const invSigmaT = 1 / Math.max(1e-6, tumorStats.sigma);
    const invSigmaB = bgStats ? 1 / Math.max(1e-6, bgStats.sigma) : 0;

    const scoreAt = (i: number): number => {
      const v = gray[i] ?? 0;
      const zT = Math.abs(v - vMu) * invSigmaT;

      // Prefer low gradients so we don't plant seeds on edges.
      const g = grad[i] ?? 0;
      const edge = g / 255;

      // Prefer pixels that aren't more background-like than tumor-like.
      let bgLike = 0;
      if (bgStats) {
        const zB = Math.abs(v - bgStats.mu) * invSigmaB;
        const delta = zT - (zB + weights.bgRejectMarginZ);
        if (delta > 0) bgLike = delta;
      }

      return zT + 0.15 * edge + 0.75 * bgLike;
    };

    const tryPick = (opts: { zMax: number; gMax: number; attempts: number }) => {
      for (let t = 0; t < opts.attempts && all.length < 1 + extraWanted; t++) {
        // Bias sampling toward the box center (triangular distribution) so seeds are less likely to land on edges.
        const ux = (rng() + rng()) * 0.5;
        const uy = (rng() + rng()) * 0.5;
        const x = seedBox.x0 + Math.floor(ux * (seedBox.x1 - seedBox.x0 + 1));
        const y = seedBox.y0 + Math.floor(uy * (seedBox.y1 - seedBox.y0 + 1));
        const i = y * w + x;
        if (chosen.has(i)) continue;

        const g = grad[i] ?? 0;
        if (g > opts.gMax) continue;

        const v = gray[i] ?? 0;
        const zT = Math.abs(v - vMu) * invSigmaT;
        if (zT > opts.zMax) continue;

        // Reject points that are clearly more background-like than tumor-like.
        if (bgStats) {
          const zB = Math.abs(v - bgStats.mu) * invSigmaB;
          if (zB + weights.bgRejectMarginZ < zT) continue;
        }

        chosen.add(i);
        all.push({ x, y });
      }
    };

    // Use a few deterministic passes that relax constraints if we can't find enough.
    const edgeSlack = clampInt(edgeBarrier + 80, 0, 255);
    tryPick({ zMax: 0.9, gMax: edgeSlack, attempts: extraWanted * 220 });
    tryPick({ zMax: 1.4, gMax: clampInt(edgeBarrier + 120, 0, 255), attempts: extraWanted * 220 });
    tryPick({ zMax: 2.2, gMax: 255, attempts: extraWanted * 220 });

    // If we still couldn't find enough, just keep what we have (better than forcing bad seeds).
    // Sort extra seeds by score so the earliest seeds are the strongest (useful if callers decide
    // to cap seeds in the future).
    if (all.length > 2) {
      const head = all[0]!;
      const rest = all.slice(1);
      rest.sort((a, b) => scoreAt(a.y * w + a.x) - scoreAt(b.y * w + b.x));
      return [head, ...rest];
    }

    return all;
  })();

  if (debugEnabled) {
    console.log('[grow2d] seed+roi+stats', {
      seedPx,
      seedCount,
      seedBox,
      roi,
      tumorStats,
      bgStats,
      edgeBarrier,
      weights,
      tuning,
    });
  }

  const dist = new Float32Array(w * h);
  dist.fill(Number.POSITIVE_INFINITY);

  const heap = createMinHeap();

  const pushSeedIdx = (i: number) => {
    if (dist[i] === 0) return;
    dist[i] = 0;
    heap.push(i, 0);
  };

  for (const sp of seedPxs) {
    pushSeedIdx(sp.y * w + sp.x);
  }

  const invSigmaTumor = 1 / Math.max(1e-6, tumorStats.sigma);
  const invSigmaBg = bgStats ? 1 / Math.max(1e-6, bgStats.sigma) : 0;

  // Cross-intensity scale: intentionally a bit tighter than the tumor sigma so we strongly penalize
  // big step edges (especially high→low) even when the seed-box stats include heterogeneous tissue.
  const crossSigma = Math.max(6, tumorStats.sigma * 0.9);
  const invCrossSigma = 1 / Math.max(1e-6, crossSigma);

  const OFFS: Array<{ dx: number; dy: number; len: number }> = weights.allowDiagonal
    ? [
        { dx: -1, dy: 0, len: 1 },
        { dx: 1, dy: 0, len: 1 },
        { dx: 0, dy: -1, len: 1 },
        { dx: 0, dy: 1, len: 1 },
        { dx: -1, dy: -1, len: Math.SQRT2 },
        { dx: 1, dy: -1, len: Math.SQRT2 },
        { dx: -1, dy: 1, len: Math.SQRT2 },
        { dx: 1, dy: 1, len: Math.SQRT2 },
      ]
    : [
        { dx: -1, dy: 0, len: 1 },
        { dx: 1, dy: 0, len: 1 },
        { dx: 0, dy: -1, len: 1 },
        { dx: 0, dy: 1, len: 1 },
      ];

  const x0 = roi.x0;
  const y0 = roi.y0;
  const x1 = roi.x1;
  const y1 = roi.y1;

  const yieldEvery = Math.max(0, Math.round(params.yieldEvery ?? 0));
  const yieldToUi = params.yieldToUi;
  let popsSinceYield = 0;

  const stepCost = (fromIdx: number, toIdx: number) => {
    const vFrom = gray[fromIdx] ?? 0;
    const vTo = gray[toIdx] ?? 0;

    const dI = vTo - vFrom;

    // Edge cost with barrier onset.
    const gRaw = grad[toIdx] ?? 0;
    const edgeFrac = (() => {
      if (gRaw <= edgeBarrier) return 0;
      const denom = Math.max(1, 255 - edgeBarrier);
      return clamp((gRaw - edgeBarrier) / denom, 0, 1);
    })();

    const zT = Math.abs(vTo - tumorStats.mu) * invSigmaTumor;

    // Background-likeness guardrail.
    let bg = 0;
    let isBgLike = false;
    if (bgStats) {
      const zB = Math.abs(vTo - bgStats.mu) * invSigmaBg;
      if (zB + weights.bgRejectMarginZ < zT) {
        isBgLike = true;
        bg = weights.bgCostStrength * (zT - (zB + weights.bgRejectMarginZ));
      }
    }

    // Directional edge weighting:
    // - Strict in low intensity regions.
    // - Very permissive in high intensity regions (minimize false negatives on bright tumor areas).
    //
    // IMPORTANT: Use "core" gates that are tighter than extreme quantiles. A 2% low quantile can be
    // too permissive if the seed box includes any background; for directionality we want to strongly
    // discourage drops below the tumor core.
    const loCore = clamp(Math.max(tumorLoGate, tumorStats.mu - 0.75 * tumorStats.sigma), 0, 255);

    // Two "high" gates:
    // - hiLoose: used to disable bg-likeness (bright regions shouldn't be treated as background-like).
    // - hiCore: used for the strongest leniency branch (to avoid being too lenient in mid intensities).
    const hiLoose = clamp(Math.min(tumorHiGate, tumorStats.mu + 0.75 * tumorStats.sigma), 0, 255);
    const hiCore = clamp(Math.min(tumorHiGate, tumorStats.mu + 1.25 * tumorStats.sigma), 0, 255);

    const coreDenom = Math.max(1e-6, hiCore - loCore);
    const toCore01 = clamp((vTo - loCore) / coreDenom, 0, 1);

    // Absolute intensity preference:
    // Even when gradients/intensity jumps are weak, we want low/mid-intensity regions to accumulate cost
    // much faster than high-intensity ones, so dist-thresholding reaches bright tumor first.
    const looseDenom = Math.max(1e-6, hiLoose - loCore);
    const toLoose01 = clamp((vTo - loCore) / looseDenom, 0, 1);
    const preferHighPenalty = (() => {
      // Penalize mid+low intensities much more than high intensities.
      // Lower exponent => harsher mid range.
      const lowish = 1 - toLoose01;
      const t = Math.pow(lowish, tuning.preferHighExponent);

      const strength = weights.edgeCostStrength * tuning.preferHighStrengthMul;
      return strength * t;
    })();

    const fromHigh = vFrom >= hiLoose;
    const fromLow = vFrom <= loCore;
    const upLowMult = fromLow ? tuning.uphillFromLowMult : 1.0;

    const toLow = vTo <= loCore;
    const toHigh = vTo >= hiCore;

    // Background-likeness guardrail is only meaningful in lower intensities.
    // For high intensities, we intentionally disable it to avoid FN on bright tumor regions.
    if (vTo >= hiLoose) {
      isBgLike = false;
      bg = 0;
    }

    const edgeDir = (() => {
      if (dI >= 0) {
        // Entering high intensity: permissive by default, but penalize low→high transitions
        // when the path is currently in low intensities (helps prevent bridging across dark gaps).
        if (toHigh) return 0.02 * upLowMult;

        // Low/background-like destinations: strict.
        if (toLow || isBgLike) return 2.0;

        // Mid intensities: stricter than before (avoid mid-intensity leakage), but smoothly relax as we approach hiCore.
        const base = 0.85 - 0.55 * toCore01;

        // Additional penalty for leaving low-intensity gaps (prevents bridging across dark gaps).
        return base * upLowMult;
      }

      // Downhill (high→low): only extremely permissive if we still end in a high intensity region.
      if (toHigh) return 0.20;

      if (toLow || isBgLike) {
        return fromHigh ? 16.0 : 12.0;
      }

      // Mid intensities: penalize more when ending closer to loCore.
      return fromHigh ? 12.0 - 7.0 * toCore01 : 9.0 - 5.0 * toCore01;
    })();

    const edge = weights.edgeCostStrength * edgeDir * edgeFrac * edgeFrac;

    // Penalize large intensity jumps (helps when Sobel is weak due to noise).
    // Same directional idea as above.
    const crossDir = (() => {
      if (dI >= 0) {
        if (toHigh) return 0.004 * upLowMult;
        if (toLow || isBgLike) return 3.0;

        const base = 0.30 - 0.22 * toCore01;
        return base * upLowMult;
      }

      if (toHigh) return 0.06;

      if (toLow || isBgLike) {
        return fromHigh ? 45.0 : 34.0;
      }

      return fromHigh ? 26.0 - 16.0 * toCore01 : 20.0 - 12.0 * toCore01;
    })();

    const zCross = Math.abs(dI) * invCrossSigma;
    const cross = weights.crossCostStrength * crossDir * Math.min(4, zCross * zCross);

    // Absolute "ending low" downhill penalty.
    //
    // The edge/jump terms above scale with edgeFrac / dI, which can be small on gradual boundaries.
    // This term ensures that once we start stepping *downhill* into intensities below the tumor core,
    // the path cost ramps up quickly (prevents low-intensity false positives).
    const endLowDownhill = (() => {
      if (!(dI < 0)) return 0;
      if (!(toLow || isBgLike)) return 0;
      if (toHigh) return 0;

      const zEndLow = Math.max(0, (loCore - vTo) * invSigmaTumor);
      const t = Math.min(1, zEndLow / 2.0);

      const base = 2.5;
      const scale = fromHigh ? 60.0 : 48.0;
      return base + scale * t * t;
    })();

    // Soft tumor likeness term.
    // Asymmetric penalty: penalize darker-than-tumor more than brighter-than-tumor.
    const dHi = Math.max(0, vTo - tumorStats.mu);
    const dLo = Math.max(0, tumorStats.mu - vTo);

    const zHi = dHi * invSigmaTumor;
    const zLo = dLo * invSigmaTumor;

    // Do not penalize bright values here.
    // Bright regions are handled primarily via direction-aware edge/jump gating and the bg-like guardrail.
    const hiCoef = 0.0;

    const tumor =
      weights.tumorCostStrength *
      (1.35 * Math.min(9, zLo * zLo) + hiCoef * Math.min(9, zHi * zHi));

    return edge + cross + endLowDownhill + tumor + bg + preferHighPenalty;
  };

  while (heap.size() > 0) {
    if (params.signal?.aborted) {
      throw new Error('Segmentation cancelled');
    }

    const idx = heap.pop();
    if (idx == null) break;

    const d0 = heap.lastD;

    // Skip stale entries.
    if (d0 !== dist[idx]) continue;

    const x = idx % w;
    const y = (idx - x) / w;

    for (const o of OFFS) {
      const nx = x + o.dx;
      const ny = y + o.dy;
      if (nx < x0 || nx > x1 || ny < y0 || ny > y1) continue;
      const ni = ny * w + nx;

      const nd = d0 + tuning.baseStepScale * o.len + stepCost(idx, ni) + radialPenaltyAt(nx, ny);

      // IMPORTANT: dist is Float32. Compare the Float32-rounded candidate distance to avoid
      // pathological "phantom improvements" where nd < dist[ni] in double precision but
      // fround(nd) === dist[ni], which can cause unbounded heap growth.
      const nd32 = Math.fround(nd);
      if (nd32 < dist[ni]) {
        dist[ni] = nd32;
        heap.push(ni, nd32);
      }
    }

    if (yieldEvery > 0 && yieldToUi) {
      popsSinceYield++;
      if (popsSinceYield >= yieldEvery) {
        popsSinceYield = 0;
        await yieldToUi();
      }
    }
  }

  // Build a small quantile LUT so slider → threshold feels stable across cases.
  const quantileLut = new Float32Array(256);
  const samples: number[] = [];

  const roiW = Math.max(1, x1 - x0 + 1);
  const roiH = Math.max(1, y1 - y0 + 1);
  const roiArea = roiW * roiH;

  const target = 20000;
  const stride = clamp(Math.floor(Math.sqrt(roiArea / Math.max(1, target))), 1, 8);

  let maxFinite = 0;
  for (let y = y0; y <= y1; y += stride) {
    for (let x = x0; x <= x1; x += stride) {
      const v = dist[y * w + x] ?? Number.POSITIVE_INFINITY;
      if (!Number.isFinite(v)) continue;
      if (v > maxFinite) maxFinite = v;
      samples.push(v);
    }
  }

  samples.sort((a, b) => a - b);

  if (samples.length === 0) {
    // Degenerate case (should not happen): fallback to linear LUT.
    for (let i = 0; i < 256; i++) {
      quantileLut[i] = i;
    }
  } else {
    const n = samples.length;
    for (let i = 0; i < 256; i++) {
      const q = i / 255;
      const pos = q * (n - 1);
      const lo = Math.floor(pos);
      const hi = Math.min(n - 1, lo + 1);
      const t = pos - lo;
      const a = samples[lo] ?? 0;
      const b = samples[hi] ?? a;
      quantileLut[i] = a * (1 - t) + b * t;
    }
  }

    return {
      w,
      h,
      seedPx,
      seedPxs,
      seedBox,
      roi,
      dist,
      quantileLut,
      maxFiniteDist: maxFinite,
      stats: { tumor: tumorStats, bg: bgStats, edgeBarrier },
      weights,
      tuning,
    };
}

export function distThresholdFromSlider(params: {
  quantileLut: Float32Array;
  slider01: number;
  gamma?: number;
}): number {
  const lut = params.quantileLut;
  if (lut.length < 2) return 0;

  const s = clamp(params.slider01, 0, 1);
  const gamma = typeof params.gamma === 'number' && Number.isFinite(params.gamma) ? clamp(params.gamma, 0.2, 5) : 1.6;

  const q = Math.pow(s, gamma);
  const f = q * 255;
  const i0 = clamp(Math.floor(f), 0, 255);
  const i1 = clamp(i0 + 1, 0, 255);
  const t = f - i0;

  const a = lut[i0] ?? 0;
  const b = lut[i1] ?? a;
  return a * (1 - t) + b * t;
}
