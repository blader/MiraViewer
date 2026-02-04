import type { NormalizedPoint, TumorPolygon, TumorThreshold } from '../../db/schema';
import { computeGeodesicDistanceToSeeds } from './geodesicDistance';
import { marchingSquaresContour } from './marchingSquares';
import { morphologicalClose, morphologicalOpen } from './morphology';
import { rdpSimplify } from './simplify';
import { chaikinSmooth } from './smooth';

export type SegmentationResult = {
  polygon: TumorPolygon;
  threshold: TumorThreshold;
  /** Seed centroid in normalized image coordinates. */
  seed: NormalizedPoint;
  meta: {
    areaPx: number;
    areaNorm: number;
    imageWidth: number;
    imageHeight: number;
  };
};

export type SegmentTumorOptions = {
  /**
   * Optional overrides for max distance gating from the painted boundary.
   *
   * maxDist ~= max(baseMin, paintScale * paintScaleFactor) + thresholdWidth * thresholdWidthFactor
   */
  maxDistToPaint?: {
    baseMin: number;
    paintScaleFactor: number;
    thresholdWidthFactor: number;
  };

  /**
   * Optional *soft* distance penalty.
   *
   * If provided, the intensity tolerance is linearly scaled by distance-to-painted-boundary:
   * - distance=0   => scale=1
   * - distance=max => scale=distanceToleranceScaleMin
   *
   * Lower values reduce leakage/FP and usually improve boundary alignment (more "granular"),
   * but can increase FN if the tumor extends far beyond the painted region.
   */
  distanceToleranceScaleMin?: number;

  /**
   * Optional edge-aware tightening of the intensity tolerance.
   *
   * When enabled (>0), pixels with higher local gradient magnitude are held to a tighter tolerance.
   * This helps stop region-grow leakage across edges and typically improves boundary granularity.
   *
   * 0 disables the edge penalty.
   */
  edgePenaltyStrength?: number;

  /**
   * Optional asymmetric tolerance band around the anchor.
   *
   * Default is symmetric: [anchor - tolerance, anchor + tolerance].
   * With these scales, the band becomes:
   * - low = anchor - tolerance * toleranceLowScale
   * - high = anchor + tolerance * toleranceHighScale
   *
   * This can help reduce leakage when only one side of the intensity spectrum is problematic.
   */
  toleranceLowScale?: number;
  toleranceHighScale?: number;

  /**
   * Automatic background model derived from an annulus around the painted stroke.
   *
   * This is brush-only: it does not require explicit negative/background marking.
   *
   * If `enabled` is undefined, the implementation may fall back to a localStorage gate
   * (e.g. `miraviewer:segmentation-v2`).
   */
  bgModel?: {
    enabled?: boolean;
    /** Minimum manhattan distance (px) from paint to consider as background samples. */
    annulusMinPx?: number;
    /** Maximum manhattan distance (px) from paint to consider as background samples. */
    annulusMaxPx?: number;
    /** Cap on background sample count for performance. */
    maxSamples?: number;
    /** How much more background-like a pixel must be to get rejected (z-score margin). */
    rejectMarginZ?: number;
    /** Exclude very strong edges from background sampling to reduce mixing. */
    edgeExclusionGrad?: number;
  };

  /**
   * Edge-aware geodesic distance gating. Distances grow faster when crossing strong edges.
   *
   * If `enabled` is undefined, the implementation may fall back to a localStorage gate
   * (e.g. `miraviewer:segmentation-v2`).
   */
  geodesic?: {
    enabled?: boolean;
    /** How strongly edges penalize distance (0 disables edge penalty in the distance metric). */
    edgeCostStrength?: number;
  };

  /**
   * How many times to run morphological open before contour extraction.
   * 0 disables the open.
   */
  morphologicalOpenIterations?: number;

  /**
   * How many times to run morphological close before contour extraction.
   * 0 disables the close.
   */
  morphologicalCloseIterations?: number;

  /** Chaikin smoothing iterations for the output polygon. (0 disables smoothing.) */
  smoothingIterations?: number;

  /** RDP epsilon for output polygon simplification. */
  simplifyEpsilon?: number;

  /**
   * Force-enable/disable the experimental local-adaptive path.
   *
   * - If undefined, falls back to the localStorage gate.
   * - If true/false, overrides the gate.
   */
  adaptiveEnabled?: boolean;
};

function clamp(v: number, lo: number, hi: number) {
  return Math.max(lo, Math.min(hi, v));
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

type RobustStats = { mu: number; sigma: number };

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

type IntegralImages = {
  w: number;
  h: number;
  sum: Float64Array; // (w+1)*(h+1)
  sumSq: Float64Array; // (w+1)*(h+1)
};

const integralCache = new WeakMap<Uint8Array, IntegralImages>();

function getIntegralImages(gray: Uint8Array, w: number, h: number): IntegralImages {
  const existing = integralCache.get(gray);
  if (existing && existing.w === w && existing.h === h) return existing;

  const w1 = w + 1;
  const h1 = h + 1;
  const sum = new Float64Array(w1 * h1);
  const sumSq = new Float64Array(w1 * h1);

  for (let y = 0; y < h; y++) {
    let rowSum = 0;
    let rowSumSq = 0;
    for (let x = 0; x < w; x++) {
      const v = gray[y * w + x] ?? 0;
      rowSum += v;
      rowSumSq += v * v;

      const i = (y + 1) * w1 + (x + 1);
      const above = y * w1 + (x + 1);
      sum[i] = sum[above] + rowSum;
      sumSq[i] = sumSq[above] + rowSumSq;
    }
  }

  const computed: IntegralImages = { w, h, sum, sumSq };
  integralCache.set(gray, computed);
  return computed;
}

function rectSum(prefix: Float64Array, w1: number, x0: number, y0: number, x1: number, y1: number): number {
  // x0,y0,x1,y1 are inclusive in image coordinates.
  // Convert to integral image coordinates (exclusive upper bounds).
  const xa = x0;
  const ya = y0;
  const xb = x1 + 1;
  const yb = y1 + 1;

  const A = prefix[ya * w1 + xa] ?? 0;
  const B = prefix[ya * w1 + xb] ?? 0;
  const C = prefix[yb * w1 + xa] ?? 0;
  const D = prefix[yb * w1 + xb] ?? 0;
  return D - B - C + A;
}

function localMeanStd(
  integrals: IntegralImages,
  x: number,
  y: number,
  radius: number
): { mean: number; std: number } {
  const w = integrals.w;
  const h = integrals.h;
  const w1 = w + 1;

  const x0 = clamp(x - radius, 0, w - 1);
  const y0 = clamp(y - radius, 0, h - 1);
  const x1 = clamp(x + radius, 0, w - 1);
  const y1 = clamp(y + radius, 0, h - 1);

  const area = Math.max(1, (x1 - x0 + 1) * (y1 - y0 + 1));
  const s = rectSum(integrals.sum, w1, x0, y0, x1, y1);
  const s2 = rectSum(integrals.sumSq, w1, x0, y0, x1, y1);
  const mean = s / area;
  const v = Math.max(0, s2 / area - mean * mean);
  const std = Math.sqrt(v);
  return { mean, std };
}

type GradientCache = {
  w: number;
  h: number;
  grad: Uint8Array;
};

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

function toGrayscaleByte(r: number, g: number, b: number): number {
  // Perceptual luminance approximation.
  return Math.round(0.2126 * r + 0.7152 * g + 0.0722 * b);
}

async function decodePngBlobToImageData(blob: Blob): Promise<ImageData> {
  // Prefer createImageBitmap (fast), but fall back to <img> decoding for broader compatibility.
  try {
    const bitmap = await createImageBitmap(blob);
    const canvas = document.createElement('canvas');
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('Failed to create canvas context');
    ctx.drawImage(bitmap, 0, 0);
    return ctx.getImageData(0, 0, canvas.width, canvas.height);
  } catch {
    const url = URL.createObjectURL(blob);
    try {
      const img = new Image();
      img.decoding = 'async';
      img.src = url;

      if (typeof img.decode === 'function') {
        await img.decode();
      } else {
        await new Promise<void>((resolve, reject) => {
          img.onload = () => resolve();
          img.onerror = () => reject(new Error('Failed to decode PNG'));
        });
      }

      const canvas = document.createElement('canvas');
      canvas.width = img.naturalWidth;
      canvas.height = img.naturalHeight;
      const ctx = canvas.getContext('2d');
      if (!ctx) throw new Error('Failed to create canvas context');
      ctx.drawImage(img, 0, 0);
      return ctx.getImageData(0, 0, canvas.width, canvas.height);
    } finally {
      URL.revokeObjectURL(url);
    }
  }
}

function computeSeedCentroid(seedPx: Array<{ x: number; y: number }>, w: number, h: number): NormalizedPoint {
  let sx = 0;
  let sy = 0;
  for (const p of seedPx) {
    sx += p.x;
    sy += p.y;
  }
  const n = Math.max(1, seedPx.length);
  const cx = sx / n;
  const cy = sy / n;
  return { x: clamp(cx / Math.max(1, w - 1), 0, 1), y: clamp(cy / Math.max(1, h - 1), 0, 1) };
}

function estimateThresholdFromSeeds(gray: Uint8Array, w: number, h: number, seedPx: Array<{ x: number; y: number }>): TumorThreshold {
  if (seedPx.length === 0) {
    console.warn('[estimateThresholdFromSeeds] No seed points, using default range');
    return { low: 64, high: 192 };
  }

  const samples: number[] = [];
  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;

  for (const p of seedPx) {
    const x = clamp(Math.round(p.x), 0, w - 1);
    const y = clamp(Math.round(p.y), 0, h - 1);

    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
    maxX = Math.max(maxX, x);
    maxY = Math.max(maxY, y);

    samples.push(gray[y * w + x] ?? 0);
  }

  if (samples.length === 0) {
    console.warn('[estimateThresholdFromSeeds] No valid samples, using default range');
    return { low: 64, high: 192 };
  }

  const bboxW = Number.isFinite(maxX) ? Math.max(1, maxX - minX + 1) : 1;
  const bboxH = Number.isFinite(maxY) ? Math.max(1, maxY - minY + 1) : 1;
  const paintAreaPx = bboxW * bboxH;
  const isLargePaintBlob = paintAreaPx > 2500 || seedPx.length > 200;

  samples.sort((a, b) => a - b);
  const pick = (q: number) => samples[Math.floor(clamp(q, 0, 1) * (samples.length - 1))] ?? 0;

  // Initial threshold should start *near the paint* (so the first polygon looks reasonable).
  //
  // For very large/filled paint blobs, stroke samples often span multiple tissues (crossing the
  // boundary). In practice, auto-tune frequently lands on a very large tolerance and relies on
  // distance gating to prevent huge FP leaks. If we start too narrow here, the default result can be
  // extremely conservative (high precision but terrible recall), which matches the failure mode
  // we keep seeing in GT reports.
  const p05 = pick(0.05);
  const p20 = pick(0.2);
  const p50 = pick(0.5);
  const p80 = pick(0.8);
  const p95 = pick(0.95);

  const isVeryLargePaintBlob = paintAreaPx > 8000 || seedPx.length > 400;

  // Keep the anchor stable (paint median). Any asymmetry should come from explicit opts / auto-tune
  // rather than trying to infer contrast direction from paint samples.
  const anchor = clamp(p50, 0, 255);

  const width = (() => {
    if (isVeryLargePaintBlob) {
      // Near-max band: rely on distance gating + background model (if enabled) to contain leakage.
      // This intentionally mirrors what auto-tune often finds for big paint blobs.
      return 240; // tolerance = 120
    }

    if (isLargePaintBlob) {
      // Wider band for filled strokes so we don't miss heterogeneous tumor signal.
      const base = (p95 - p05) + 24;
      return clamp(base, 160, 240);
    }

    // Small/medium strokes: keep it tighter so the first result doesn't explode.
    return clamp((p80 - p20) + 12, 24, 64);
  })();

  const tolerance = clamp(Math.round(width / 2), 0, 127);

  return {
    low: clamp(anchor - tolerance, 0, 255),
    high: clamp(anchor + tolerance, 0, 255),
    anchor,
    tolerance,
  };
}

export type GrayscaleImage = {
  gray: Uint8Array;
  width: number;
  height: number;
};

export async function decodeCapturedPngToGrayscale(png: Blob): Promise<GrayscaleImage> {
  const imageData = await decodePngBlobToImageData(png);
  const w = imageData.width;
  const h = imageData.height;

  const gray = new Uint8Array(w * h);
  const d = imageData.data;
  for (let i = 0, p = 0; i < d.length; i += 4, p++) {
    gray[p] = toGrayscaleByte(d[i], d[i + 1], d[i + 2]);
  }

  return { gray, width: w, height: h };
}

export function estimateThresholdFromSeedPoints(
  gray: Uint8Array,
  w: number,
  h: number,
  seedPointsNorm: NormalizedPoint[]
): TumorThreshold {
  const seedPx = seedPointsNorm.map((p) => ({
    x: clamp(p.x, 0, 1) * (w - 1),
    y: clamp(p.y, 0, 1) * (h - 1),
  }));
  return estimateThresholdFromSeeds(gray, w, h, seedPx);
}

export function regionGrowMask(
  allowed: Uint8Array,
  w: number,
  h: number,
  seeds: Array<{ x: number; y: number }>,
  roi?: { x0: number; y0: number; x1: number; y1: number }
): { mask: Uint8Array; area: number } {
  const mask = new Uint8Array(w * h);
  const visited = new Uint8Array(w * h);

  const x0 = roi ? clamp(Math.floor(roi.x0), 0, w - 1) : 0;
  const y0 = roi ? clamp(Math.floor(roi.y0), 0, h - 1) : 0;
  const x1 = roi ? clamp(Math.ceil(roi.x1), 0, w - 1) : w - 1;
  const y1 = roi ? clamp(Math.ceil(roi.y1), 0, h - 1) : h - 1;

  // Use a smaller queue size based on ROI to avoid memory issues.
  const roiW = x1 - x0 + 1;
  const roiH = y1 - y0 + 1;
  const maxQueueSize = roiW * roiH;

  const qx = new Int32Array(maxQueueSize);
  const qy = new Int32Array(maxQueueSize);
  let qh = 0;
  let qt = 0;

  const push = (x: number, y: number) => {
    const i = y * w + x;
    if (visited[i]) return;
    visited[i] = 1; // mark enqueued so we never overflow the queue with duplicates
    if (qt >= maxQueueSize) {
      // This should be impossible if `visited` is correct, but keep a guard anyway.
      console.error('[regionGrowMask] Queue overflow (bug)', { qt, maxQueueSize });
      return;
    }
    qx[qt] = x;
    qy[qt] = y;
    qt++;
  };

  for (const s of seeds) {
    const x = clamp(Math.round(s.x), x0, x1);
    const y = clamp(Math.round(s.y), y0, y1);
    push(x, y);
  }

  let area = 0;
  let iterations = 0;
  const maxIterations = maxQueueSize; // each pixel can be enqueued at most once

  while (qh < qt && iterations++ < maxIterations) {
    const x = qx[qh];
    const y = qy[qh];
    qh++;

    const i = y * w + x;

    if (!allowed[i]) continue;

    mask[i] = 1;
    area++;

    // 4-neighborhood.
    if (x > x0) push(x - 1, y);
    if (x < x1) push(x + 1, y);
    if (y > y0) push(x, y - 1);
    if (y < y1) push(x, y + 1);
  }

  if (iterations >= maxIterations) {
    console.warn('[regionGrowMask] Hit max iteration guard (unexpected)');
  }

  return { mask, area };
}

let cachedDistKey: string | null = null;
let cachedDist: Int32Array | null = null;

type GeodesicCacheEntry = { key: string; dist: Float32Array; maxComputed: number };
const geodesicCache = new WeakMap<Uint8Array, GeodesicCacheEntry>();

function computeDistanceToPaint(
  paintPx: Array<{ x: number; y: number }>,
  w: number,
  h: number,
  roi: { x0: number; y0: number; x1: number; y1: number }
): Int32Array {
  const dist = new Int32Array(w * h);
  dist.fill(-1);

  if (paintPx.length === 0) return dist;

  const x0 = clamp(Math.floor(roi.x0), 0, w - 1);
  const y0 = clamp(Math.floor(roi.y0), 0, h - 1);
  const x1 = clamp(Math.ceil(roi.x1), 0, w - 1);
  const y1 = clamp(Math.ceil(roi.y1), 0, h - 1);

  // We want distance-to-*boundary* rather than distance-to-any-stroke-point.
  //
  // If the user paints a filled scribble, interior pixels have many nearby stroke points,
  // so distance-to-stroke would be ~0 everywhere inside and wouldn't express "how deep inside"
  // a pixel is. Instead, we approximate the painted boundary by using the outer ring of paint points.
  let cx = 0;
  let cy = 0;
  for (const p of paintPx) {
    cx += p.x;
    cy += p.y;
  }
  cx /= paintPx.length;
  cy /= paintPx.length;

  let maxD2 = 0;
  const d2s = new Float64Array(paintPx.length);
  for (let i = 0; i < paintPx.length; i++) {
    const dx = paintPx[i].x - cx;
    const dy = paintPx[i].y - cy;
    const d2 = dx * dx + dy * dy;
    d2s[i] = d2;
    if (d2 > maxD2) maxD2 = d2;
  }

  // Decide whether the paint looks like a filled "blob" or a thin/elongated stroke.
  //
  // Why:
  // - For blob-like paint, we want distance-to-*boundary* (prevents interior pixels being treated as "distance 0").
  // - For thin/elongated strokes, the "outer ring" heuristic tends to pick only the endpoints, which makes
  //   distance-to-paint meaningless and can cause large FP leaks or brittle FN behavior.
  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  for (const p of paintPx) {
    if (p.x < minX) minX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.x > maxX) maxX = p.x;
    if (p.y > maxY) maxY = p.y;
  }
  const bboxW = Math.max(1, maxX - minX);
  const bboxH = Math.max(1, maxY - minY);
  const aspect = Math.min(bboxW, bboxH) / Math.max(bboxW, bboxH);

  // Outer ring threshold (~70% of max radius). If too few points qualify, fall back to all points.
  const ringD2 = maxD2 * 0.7 * 0.7;
  const boundarySeeds: Array<{ x: number; y: number }> = [];
  for (let i = 0; i < paintPx.length; i++) {
    if (d2s[i] >= ringD2) boundarySeeds.push(paintPx[i]);
  }

  // If paint is very elongated, prefer distance-to-stroke to avoid endpoint-only seeding.
  const seeds = aspect < 0.35 ? paintPx : boundarySeeds.length >= 8 ? boundarySeeds : paintPx;

  const roiW = x1 - x0 + 1;
  const roiH = y1 - y0 + 1;
  const maxQueueSize = roiW * roiH;

  const qx = new Int32Array(maxQueueSize);
  const qy = new Int32Array(maxQueueSize);
  let qh = 0;
  let qt = 0;

  const push = (x: number, y: number, d: number) => {
    const i = y * w + x;
    if (dist[i] !== -1) return;
    dist[i] = d;
    qx[qt] = x;
    qy[qt] = y;
    qt++;
  };

  // Guard against pathological cases where we have more seeds than ROI pixels.
  const maxSeeds = Math.max(1, Math.min(seeds.length, maxQueueSize));
  const seedStep = Math.max(1, Math.floor(seeds.length / maxSeeds));

  for (let si = 0; si < seeds.length; si += seedStep) {
    const s = seeds[si]!;
    const x = clamp(Math.round(s.x), x0, x1);
    const y = clamp(Math.round(s.y), y0, y1);
    push(x, y, 0);
  }

  while (qh < qt) {
    const x = qx[qh];
    const y = qy[qh];
    qh++;

    const base = dist[y * w + x];
    const nd = base + 1;

    if (x > x0) push(x - 1, y, nd);
    if (x < x1) push(x + 1, y, nd);
    if (y > y0) push(x, y - 1, nd);
    if (y < y1) push(x, y + 1, nd);
  }

  return dist;
}

function computeSeedRoi(seeds: Array<{ x: number; y: number }>, w: number, h: number): { x0: number; y0: number; x1: number; y1: number } {
  if (seeds.length === 0) {
    return { x0: 0, y0: 0, x1: w - 1, y1: h - 1 };
  }

  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;

  for (const s of seeds) {
    minX = Math.min(minX, s.x);
    minY = Math.min(minY, s.y);
    maxX = Math.max(maxX, s.x);
    maxY = Math.max(maxY, s.y);
  }

  // Expand ROI so the tumor can extend beyond the rough paint strokes.
  //
  // We treat the paint region as a hint (where to start), not a hard boundary.
  const bboxW = Math.max(1, maxX - minX);
  const bboxH = Math.max(1, maxY - minY);

  // Minimum expansion based on image size so small paint strokes don't overly constrain ROI.
  //
  // Precision note:
  // If this margin is too large, the allowed mask may include large same-intensity regions far from the paint,
  // which can produce huge false-positive expansions (low precision), especially on FLAIR.
  const minDim = Math.min(w, h);
  const minMargin = Math.max(24, Math.round(minDim * 0.08));

  // Expand to ~2.0x bbox search region (margin ~= 0.5*bbox).
  const marginX = Math.max(minMargin, Math.round(bboxW * 0.5));
  const marginY = Math.max(minMargin, Math.round(bboxH * 0.5));

  return {
    x0: clamp(minX - marginX, 0, w - 1),
    y0: clamp(minY - marginY, 0, h - 1),
    x1: clamp(maxX + marginX, 0, w - 1),
    y1: clamp(maxY + marginY, 0, h - 1),
  };
}

function buildAllowedMask(params: {
  gray: Uint8Array;
  w: number;
  h: number;
  roi: { x0: number; y0: number; x1: number; y1: number };
  paintPx: Array<{ x: number; y: number }>;
  threshold: TumorThreshold;
  looksLikePaintGesture: boolean;
  distToPaint?: Int32Array;
  maxDistToPaint?: number;
  /** Optional soft distance penalty (see SegmentTumorOptions). */
  distanceToleranceScaleMin?: number;
  /** Optional edge penalty (see SegmentTumorOptions). */
  edgePenaltyStrength?: number;
  /** Optional asymmetric tolerance scales (see SegmentTumorOptions). */
  toleranceLowScale?: number;
  toleranceHighScale?: number;
  /** Optional brush-only background model (see SegmentTumorOptions). */
  bgModel?: SegmentTumorOptions['bgModel'];
  /** Optional edge-aware geodesic gating (see SegmentTumorOptions). */
  geodesic?: SegmentTumorOptions['geodesic'];
  adaptiveEnabled?: boolean;
}): Uint8Array {
  const { gray, w, h, roi, paintPx, threshold, looksLikePaintGesture, distToPaint, maxDistToPaint } = params;

  const allowed = new Uint8Array(w * h);
  if (w <= 0 || h <= 0 || paintPx.length === 0) return allowed;

  const x0 = clamp(Math.floor(roi.x0), 0, w - 1);
  const y0 = clamp(Math.floor(roi.y0), 0, h - 1);
  const x1 = clamp(Math.ceil(roi.x1), 0, w - 1);
  const y1 = clamp(Math.ceil(roi.y1), 0, h - 1);

  const anchor =
    typeof threshold.anchor === 'number'
      ? clamp(Math.round(threshold.anchor), 0, 255)
      : clamp(Math.round((threshold.low + threshold.high) / 2), 0, 255);
  const tolerance =
    typeof threshold.tolerance === 'number'
      ? clamp(Math.round(threshold.tolerance), 0, 127)
      : clamp(Math.round((threshold.high - threshold.low) / 2), 0, 127);

  const maxDist = typeof maxDistToPaint === 'number' ? Math.max(0, Math.round(maxDistToPaint)) : undefined;
  const distTolScaleMin =
    typeof params.distanceToleranceScaleMin === 'number'
      ? clamp(params.distanceToleranceScaleMin, 0.15, 1)
      : looksLikePaintGesture
        ? 0.25
        : 1;
  const edgePenaltyStrength =
    typeof params.edgePenaltyStrength === 'number' ? clamp(params.edgePenaltyStrength, 0, 1) : 0;

  const tolLowScale =
    typeof params.toleranceLowScale === 'number' ? clamp(params.toleranceLowScale, 0.25, 2) : 1;
  const tolHighScale =
    typeof params.toleranceHighScale === 'number' ? clamp(params.toleranceHighScale, 0.25, 2) : 1;

  const lowTolBase = tolerance * tolLowScale;
  const highTolBase = tolerance * tolHighScale;

  // Approximate "inner" paint region by a radial cutoff relative to the paint centroid.
  //
  // IMPORTANT: We apply distance gating / penalties mainly to prevent *outward leakage*.
  // Penalizing deep interior pixels can create false negatives when the user paints a small
  // or off-center scribble. So we treat the inner region as always eligible and only apply
  // distance-based constraints outside of it.
  let paintCx = 0;
  let paintCy = 0;
  for (const p of paintPx) {
    paintCx += p.x;
    paintCy += p.y;
  }
  paintCx /= paintPx.length;
  paintCy /= paintPx.length;

  let paintMaxD2 = 0;
  const paintD2s = new Float64Array(paintPx.length);
  for (let i = 0; i < paintPx.length; i++) {
    const dx = paintPx[i].x - paintCx;
    const dy = paintPx[i].y - paintCy;
    const d2 = dx * dx + dy * dy;
    paintD2s[i] = d2;
    if (d2 > paintMaxD2) paintMaxD2 = d2;
  }

  // Compute an "inner" paint region cutoff.
  //
  // IMPORTANT: using max radius can make this way too large for thin/elongated strokes (line scribbles),
  // which disables distance gating over a huge area and can lead to low precision leaks.
  //
  // We scale the inner fraction by paint bbox aspect ratio:
  // - blob-like paint (aspect~1) => innerFrac ~0.7 (original behavior)
  // - elongated paint (aspect<<1) => innerFrac shrinks toward ~0.35
  let bboxMinX = Number.POSITIVE_INFINITY;
  let bboxMinY = Number.POSITIVE_INFINITY;
  let bboxMaxX = Number.NEGATIVE_INFINITY;
  let bboxMaxY = Number.NEGATIVE_INFINITY;
  for (const p of paintPx) {
    if (p.x < bboxMinX) bboxMinX = p.x;
    if (p.y < bboxMinY) bboxMinY = p.y;
    if (p.x > bboxMaxX) bboxMaxX = p.x;
    if (p.y > bboxMaxY) bboxMaxY = p.y;
  }
  const bboxW = Math.max(1, bboxMaxX - bboxMinX);
  const bboxH = Math.max(1, bboxMaxY - bboxMinY);
  const aspect = Math.min(bboxW, bboxH) / Math.max(bboxW, bboxH);

  const innerFrac = 0.35 + 0.35 * clamp(aspect, 0, 1);
  const paintInnerD2 = paintMaxD2 * innerFrac * innerFrac;

  // "Outer ring" (fixed fraction) used for edge sampling + boundary seeding.
  const ringD2 = paintMaxD2 * 0.7 * 0.7;
  const boundarySeeds: Array<{ x: number; y: number }> = [];
  for (let i = 0; i < paintPx.length; i++) {
    if (paintD2s[i] >= ringD2) boundarySeeds.push(paintPx[i]!);
  }

  const distSeeds = (() => {
    // Prefer boundary seeding for blob-like paint so distance expresses "how far outside the paint boundary".
    // For thin/elongated strokes, boundary seeding tends to pick endpoints and becomes unstable, so fall back
    // to distance-to-stroke instead.
    const raw = aspect < 0.35 ? paintPx : boundarySeeds.length >= 8 ? boundarySeeds : paintPx;

    // Cap seed count for performance + stable cache keys.
    const maxSeeds = 256;
    const step = Math.max(1, Math.floor(raw.length / maxSeeds));
    return raw.filter((_, i) => i % step === 0);
  })();

  // Rollout gate for segmentation v2 (background model + geodesic distance).
  const v2Enabled =
    looksLikePaintGesture &&
    typeof localStorage !== 'undefined' &&
    localStorage.getItem('miraviewer:segmentation-v2') === '1';

  const geodesicEnabled =
    typeof params.geodesic?.enabled === 'boolean' ? params.geodesic.enabled : v2Enabled;
  const bgModelEnabled = typeof params.bgModel?.enabled === 'boolean' ? params.bgModel.enabled : v2Enabled;

  // Compute gradient once when needed; cached by grayscale buffer identity.
  const grad =
    looksLikePaintGesture && (edgePenaltyStrength > 0 || geodesicEnabled || bgModelEnabled)
      ? getGradientMagnitude(gray, w, h)
      : null;

  const edgePenalty = (() => {
    if (edgePenaltyStrength <= 0) return null;
    if (!looksLikePaintGesture) return null;
    if (!grad) return null;

    // Estimate edge strength near painted boundary ring.
    const sampleCount = 64;
    const step = Math.max(1, Math.floor(paintPx.length / sampleCount));

    const edgeSamples: number[] = [];
    for (let i = 0; i < paintPx.length; i += step) {
      if (paintD2s[i] < paintInnerD2) continue;
      const x = clamp(Math.round(paintPx[i].x), 0, w - 1);
      const y = clamp(Math.round(paintPx[i].y), 0, h - 1);
      edgeSamples.push(grad[y * w + x] ?? 0);
    }

    if (edgeSamples.length === 0) return null;

    const edgeMedian = medianOfNumbers(edgeSamples);

    // Use a floor so we don't massively over-penalize weak/noisy gradients.
    // This keeps the edge penalty focused on truly strong edges (e.g. tissue boundaries)
    // while still allowing it to activate even if the painted ring isn't perfectly on the edge.
    const barrier = Math.max(25, edgeMedian * 1.2);
    return { grad, barrier };
  })();

  // Local-adaptive, edge-aware thresholding is still experimental. Gate it behind a flag so we don't
  // regress segmentation quality by default.
  const adaptiveEnabled =
    typeof params.adaptiveEnabled === 'boolean'
      ? params.adaptiveEnabled
      : looksLikePaintGesture &&
        typeof localStorage !== 'undefined' &&
        localStorage.getItem('miraviewer:segmentation-adaptive') === '1';

  const hasDist = distToPaint && typeof maxDist === 'number' && maxDist > 0;

  const geoDistToPaint = (() => {
    if (!hasDist) return null;
    if (!geodesicEnabled) return null;
    if (!grad) return null;
    if (distSeeds.length === 0) return null;

    const k =
      typeof params.geodesic?.edgeCostStrength === 'number' ? clamp(params.geodesic.edgeCostStrength, 0, 20) : 6;

    // Cache keyed by image identity (gray buffer) + ROI + a subsample signature of boundary/stroke seeds.
    // NOTE: We deliberately do NOT key on maxDist, so slider moves don't trigger recomputes.
    const sampleCount = 64;
    const step = Math.max(1, Math.floor(distSeeds.length / sampleCount));
    const sampled = distSeeds
      .filter((_, i) => i % step === 0)
      .map((p) => `${Math.round(p.x)},${Math.round(p.y)}`)
      .join(';');

    const key = `${w}x${h}|${x0},${y0},${x1},${y1}|k=${k}|${sampled}`;
    const cached = geodesicCache.get(gray);
    if (cached && cached.key === key && cached.maxComputed >= maxDist!) return cached.dist;

    // Compute a bit beyond the current maxDist so small slider moves can reuse the cached map.
    const computeMaxDist = Math.ceil(maxDist! + 8);

    const edgeBarrier = (() => {
      if (!grad) return null;

      const edgeSamples: number[] = [];
      const seeds = boundarySeeds.length >= 8 ? boundarySeeds : distSeeds;
      const step = Math.max(1, Math.floor(seeds.length / 64));

      for (let i = 0; i < seeds.length; i += step) {
        const p = seeds[i]!;
        const xi = clamp(Math.round(p.x), 0, w - 1);
        const yi = clamp(Math.round(p.y), 0, h - 1);
        edgeSamples.push(grad[yi * w + xi] ?? 0);
      }

      if (edgeSamples.length === 0) return null;

      const edgeMedian = medianOfNumbers(edgeSamples);
      return Math.max(25, edgeMedian * 1.2);
    })();

    const dist = computeGeodesicDistanceToSeeds({
      w,
      h,
      roi: { x0, y0, x1, y1 },
      seeds: distSeeds,
      grad,
      edgeCostStrength: k,
      edgeBarrier: edgeBarrier ?? undefined,
      maxDist: computeMaxDist,
    });

    geodesicCache.set(gray, { key, dist, maxComputed: computeMaxDist });
    return dist;
  })();

  const bgModel = (() => {
    if (!bgModelEnabled) return null;
    if (!hasDist) return null;

    const cfg = params.bgModel;
    const annulusMinPx = typeof cfg?.annulusMinPx === 'number' ? clamp(Math.round(cfg.annulusMinPx), 1, 64) : 2;
    const annulusMaxPxRaw =
      typeof cfg?.annulusMaxPx === 'number' ? Math.round(cfg.annulusMaxPx) : Math.min(24, maxDist ?? 24);
    const annulusMaxPx = clamp(annulusMaxPxRaw, annulusMinPx + 1, 128);

    const maxSamples = typeof cfg?.maxSamples === 'number' ? clamp(Math.round(cfg.maxSamples), 64, 8192) : 2048;
    const rejectMarginZ = typeof cfg?.rejectMarginZ === 'number' ? clamp(cfg.rejectMarginZ, 0, 3) : 0.75;
    const edgeExclusionGrad =
      typeof cfg?.edgeExclusionGrad === 'number' ? clamp(Math.round(cfg.edgeExclusionGrad), 0, 255) : 200;

    // Tumor samples: sample intensities under the paint stroke.
    const tumorSamples: number[] = [];
    const paintStep = Math.max(1, Math.floor(paintPx.length / 96));
    for (let k = 0; k < paintPx.length; k += paintStep) {
      const px = paintPx[k]!;
      const xi = clamp(Math.round(px.x), 0, w - 1);
      const yi = clamp(Math.round(px.y), 0, h - 1);
      tumorSamples.push(gray[yi * w + xi] ?? 0);
    }

    const tumor = robustStats(tumorSamples, 6);
    if (!tumor) return null;

    // Background samples: annulus just outside paint.
    let candCount = 0;
    for (let yy = y0; yy <= y1; yy++) {
      for (let xx = x0; xx <= x1; xx++) {
        const ii = yy * w + xx;
        const dd = distToPaint![ii];
        if (dd < annulusMinPx || dd > annulusMaxPx) continue;

        const g = grad ? grad[ii] ?? 0 : 0;
        if (g > edgeExclusionGrad) continue;

        candCount++;
      }
    }

    if (candCount < 64) return null;

    const stride = Math.max(1, Math.floor(candCount / maxSamples));
    const bgSamples: number[] = [];
    let seen = 0;

    for (let yy = y0; yy <= y1 && bgSamples.length < maxSamples; yy++) {
      for (let xx = x0; xx <= x1 && bgSamples.length < maxSamples; xx++) {
        const ii = yy * w + xx;
        const dd = distToPaint![ii];
        if (dd < annulusMinPx || dd > annulusMaxPx) continue;

        const g = grad ? grad[ii] ?? 0 : 0;
        if (g > edgeExclusionGrad) continue;

        if (seen % stride === 0) {
          bgSamples.push(gray[ii] ?? 0);
        }
        seen++;
      }
    }

    const bg = robustStats(bgSamples, 6);
    if (!bg) return null;

    return { tumor, bg, rejectMarginZ };
  })();

  const debugEnabled =
    looksLikePaintGesture &&
    typeof localStorage !== 'undefined' &&
    localStorage.getItem('miraviewer:debug-segmentation') === '1';

  if (debugEnabled) {
    console.log('[segmentTumor] buildAllowedMask', {
      adaptiveEnabled,
      v2Enabled,
      geodesicEnabled,
      bgModelEnabled,
      maxDist,
      anchor,
      tolerance,
      tolLowScale,
      tolHighScale,
    });
  }

  if (!adaptiveEnabled) {
    // Default path: absolute intensity band + optional distance gating.
    //
    // If distanceToleranceScaleMin < 1, we additionally tighten the intensity tolerance as distance
    // from the painted boundary increases. This reduces leaking into similar-intensity regions.

    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        const i = y * w + x;

        const dx = x - paintCx;
        const dy = y - paintCy;
        const radialD2 = dx * dx + dy * dy;

        // Only apply distance penalties outside the inner paint region.
        const enforceDist = hasDist && radialD2 >= paintInnerD2;

        let effLowTol = lowTolBase;
        let effHighTol = highTolBase;
        let d = 0;

        if (enforceDist) {
          d = geoDistToPaint ? geoDistToPaint[i]! : distToPaint![i];
          // Geodesic distance returns +Infinity for pixels outside the explored region. Treat non-finite
          // values as out-of-range so they don't accidentally bypass distance gating.
          if (!Number.isFinite(d) || d < 0) continue;

          // IMPORTANT: maxDist is a hard cutoff. This prevents "infinite radius" leakage into far-away
          // same-intensity tissue when distanceToleranceScaleMin < 1.
          if (d > maxDist!) continue;

          // Optional soft penalty *within* [0, maxDist]: linearly tighten tolerance with distance.
          if (distTolScaleMin < 0.999) {
            const frac = clamp(d / maxDist!, 0, 1);
            const scale = 1 - frac * (1 - distTolScaleMin);
            effLowTol = lowTolBase * scale;
            effHighTol = highTolBase * scale;
          }

          // Edge penalty is intended to prevent *outward leakage* across strong edges.
          // We keep it selective so it doesn't create false negatives due to interior texture.
          if (edgePenalty) {
            const EDGE_PENALTY_START_FRAC = 0.3;
            if (d >= Math.round(maxDist! * EDGE_PENALTY_START_FRAC)) {
              const g = edgePenalty.grad[i] ?? 0;
              const t = g / edgePenalty.barrier;

              // Only penalize sufficiently strong edges.
              const ONSET = 0.6;
              if (t > ONSET) {
                const edgeNorm = clamp((t - ONSET) / (1 - ONSET), 0, 1);
                const edgeWeight = edgeNorm * edgeNorm;
                const mult = 1 - edgeWeight * edgePenaltyStrength;
                effLowTol *= mult;
                effHighTol *= mult;
              }
            }
          }
        }

        const v = gray[i] ?? 0;
        if (v >= anchor - effLowTol && v <= anchor + effHighTol) {
          // Background model is intended to prevent outward leakage; don't apply it deep inside the paint.
          if (bgModel && enforceDist) {
            const zTumor = Math.abs(v - bgModel.tumor.mu) / bgModel.tumor.sigma;
            const zBg = Math.abs(v - bgModel.bg.mu) / bgModel.bg.sigma;

            // Only reject when the pixel is substantially more background-like.
            if (zBg + bgModel.rejectMarginZ < zTumor) {
              continue;
            }
          }

          allowed[i] = 1;
        }
      }
    }

    return allowed;
  }

  // Adaptive path: compare locally normalized intensity (z-score) to a paint-derived anchor.
  // This can help in the presence of intensity inhomogeneity / bias fields, but can also hurt.
  const integrals = getIntegralImages(gray, w, h);

  // Window radius for local stats. ~17x17 at 512px.
  const radius = clamp(Math.round(Math.min(w, h) * 0.015), 5, 14);

  // Estimate anchorZ and sigmaPaint from painted pixels.
  const sampleCount = 64;
  const step = Math.max(1, Math.floor(paintPx.length / sampleCount));

  const zs: number[] = [];
  const sigmas: number[] = [];

  for (let k = 0; k < paintPx.length; k += step) {
    const px = paintPx[k];
    const x = clamp(Math.round(px.x), 0, w - 1);
    const y = clamp(Math.round(px.y), 0, h - 1);
    const i = y * w + x;

    const { mean, std } = localMeanStd(integrals, x, y, radius);
    const s = std > 1e-6 ? std : 1;
    const v = gray[i] ?? 0;
    zs.push((v - mean) / s);
    sigmas.push(s);
  }

  const anchorZ = medianOfNumbers(zs);
  const sigmaPaint = Math.max(6, medianOfNumbers(sigmas));

  // Convert intensity tolerance (0..127) into a normalized tolerance.
  const zTolLowBase = (tolerance * tolLowScale) / sigmaPaint;
  const zTolHighBase = (tolerance * tolHighScale) / sigmaPaint;

  // Edge-aware soft penalty.
  const gradMag = getGradientMagnitude(gray, w, h);

  // Estimate edge strength near painted boundary ring.
  const edgeSamples: number[] = [];
  for (let i = 0; i < paintPx.length; i += step) {
    if (paintD2s[i] < ringD2) continue;
    const x = clamp(Math.round(paintPx[i]!.x), 0, w - 1);
    const y = clamp(Math.round(paintPx[i]!.y), 0, h - 1);
    edgeSamples.push(gradMag[y * w + x] ?? 0);
  }

  const edgeMedian = medianOfNumbers(edgeSamples);
  const edgeBarrier = edgeMedian >= 25 ? Math.max(1, edgeMedian * 1.2) : null;

  // Distance penalty: pixels far from the painted boundary get a tighter tolerance.
  // 1.0 near boundary -> distanceToleranceScaleMin (default 0.2) at max distance.
  const distScaleMin =
    typeof params.distanceToleranceScaleMin === 'number'
      ? clamp(params.distanceToleranceScaleMin, 0.15, 1)
      : v2Enabled
        ? 1
        : 0.2;
  const distScaleFor = (d: number) => {
    if (!maxDist || maxDist <= 0) return 1;
    const frac = clamp(d / maxDist, 0, 1);
    return distScaleMin + (1 - distScaleMin) * (1 - frac);
  };

  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const i = y * w + x;

      const dx = x - paintCx;
      const dy = y - paintCy;
      const radialD2 = dx * dx + dy * dy;

      // Only apply distance penalties outside the inner paint region.
      const enforceDist = hasDist && radialD2 >= paintInnerD2;

      let scale = 1;
      if (enforceDist) {
        const d = geoDistToPaint ? geoDistToPaint[i]! : distToPaint![i];
        if (!Number.isFinite(d) || d < 0 || d > maxDist!) continue;
        scale *= distScaleFor(d);
      }

      if (edgeBarrier) {
        const g = gradMag[i] ?? 0;
        const edgeNorm = clamp(g / edgeBarrier, 0, 1);
        // Tighten tolerance near strong edges to avoid leaking across boundaries.
        scale *= 1 - edgeNorm * 0.5;
      }

      const zTolLow = zTolLowBase * scale;
      const zTolHigh = zTolHighBase * scale;
      if (zTolLow <= 0 && zTolHigh <= 0) continue;

      const { mean, std } = localMeanStd(integrals, x, y, radius);
      const s = std > 1e-6 ? std : 1;
      const v = gray[i] ?? 0;
      const z = (v - mean) / s;
      if (z >= anchorZ - zTolLow && z <= anchorZ + zTolHigh) {
        // Background model is intended to prevent outward leakage; don't apply it deep inside the paint.
        if (bgModel && enforceDist) {
          const zTumor = Math.abs(v - bgModel.tumor.mu) / bgModel.tumor.sigma;
          const zBg = Math.abs(v - bgModel.bg.mu) / bgModel.bg.sigma;

          // Only reject when the pixel is substantially more background-like.
          if (zBg + bgModel.rejectMarginZ < zTumor) {
            continue;
          }
        }

        allowed[i] = 1;
      }
    }
  }

  return allowed;
}

export function segmentTumorFromGrayscale(
  gray: Uint8Array,
  w: number,
  h: number,
  seedPointsNorm: NormalizedPoint[],
  threshold: TumorThreshold,
  opts?: SegmentTumorOptions
): SegmentationResult {
  // If the caller provided an anchor+tolerance (tolerance mode), normalize low/high from it.
  // This guarantees monotonic behavior when the UI adjusts tolerance.
  const normalizedThreshold: TumorThreshold =
    typeof threshold.anchor === 'number' && typeof threshold.tolerance === 'number'
      ? (() => {
          const anchor = clamp(Math.round(threshold.anchor), 0, 255);
          const tolerance = clamp(Math.round(threshold.tolerance), 0, 127);
          return {
            ...threshold,
            anchor,
            tolerance,
            low: clamp(anchor - tolerance, 0, 255),
            high: clamp(anchor + tolerance, 0, 255),
          };
        })()
      : threshold;

  const paintPx = seedPointsNorm.map((p) => ({
    x: clamp(p.x, 0, 1) * (w - 1),
    y: clamp(p.y, 0, 1) * (h - 1),
  }));

  // Painted region is a rough hint. We use it to determine the flood-fill seed (centroid)
  // and a generous search ROI, but we do NOT treat it as a hard boundary.
  const seed = computeSeedCentroid(paintPx, w, h);
  const seedPx = { x: seed.x * (w - 1), y: seed.y * (h - 1) };

  const roi = computeSeedRoi(paintPx, w, h);

  // If this looks like a real paint gesture (not the tiny seed cross used in propagation),
  // compute a distance-to-paint map so pixels far outside the painted region are penalized.
  const bbox = (() => {
    let minX = Number.POSITIVE_INFINITY;
    let minY = Number.POSITIVE_INFINITY;
    let maxX = Number.NEGATIVE_INFINITY;
    let maxY = Number.NEGATIVE_INFINITY;
    for (const p of paintPx) {
      minX = Math.min(minX, p.x);
      minY = Math.min(minY, p.y);
      maxX = Math.max(maxX, p.x);
      maxY = Math.max(maxY, p.y);
    }
    return { minX, minY, maxX, maxY };
  })();

  const bboxW = Number.isFinite(bbox.maxX) ? Math.max(0, bbox.maxX - bbox.minX) : 0;
  const bboxH = Number.isFinite(bbox.maxY) ? Math.max(0, bbox.maxY - bbox.minY) : 0;
  const paintScale = Math.max(bboxW, bboxH);

  const looksLikePaintGesture = paintPx.length >= 16 || bboxW * bboxH >= 400;

  // Default: symmetric tolerance band. Asymmetry should come from auto-tune or explicit opts,
  // because the "right" asymmetry depends on whether the tumor is brighter or darker than
  // surrounding tissue (varies case-by-case).
  const tolLowScale =
    typeof opts?.toleranceLowScale === 'number' ? clamp(opts.toleranceLowScale, 0.25, 2) : 1;
  const tolHighScale =
    typeof opts?.toleranceHighScale === 'number' ? clamp(opts.toleranceHighScale, 0.25, 2) : 1;

  const baseTol =
    typeof normalizedThreshold.tolerance === 'number'
      ? Math.max(0, normalizedThreshold.tolerance)
      : Math.max(0, (normalizedThreshold.high - normalizedThreshold.low) / 2);

  const thresholdWidth = baseTol * (tolLowScale + tolHighScale);

  // Default distance gating tuned to avoid large false-positive expansions.
  //
  // Precision note:
  // We bias defaults toward staying close to the painted region. It's better UX if the first
  // segmentation is conservative (higher precision) and the user can paint a bit more to recover FN,
  // rather than the first result exploding into far-away same-intensity tissue.
  const distParams = opts?.maxDistToPaint ?? {
    // Tuned from GT-driven auto-tune on axial T2 FLAIR.
    //
    // Note: maxDist is a hard cutoff; these defaults intentionally allow a wider search region,
    // while distanceToleranceScaleMin (default 0.25) prevents far-away leakage.
    baseMin: 2,
    paintScaleFactor: 0.6,
    thresholdWidthFactor: 0.1,
  };

  // Max allowed manhattan distance from the painted boundary.
  //
  // IMPORTANT: For large paint blobs, use a tighter cap. When the user paints a filled region,
  // they're expressing "the tumor is approximately here" — we should stay close to that boundary.
  //
  // For small/medium strokes: allow some expansion (user is giving a rough hint).
  // For large filled blobs: be conservative (user has already outlined the region).
  const paintAreaPx = bboxW * bboxH;
  const isLargePaintBlob = paintAreaPx > 2500 || paintPx.length > 200;

  const maxDistCap = isLargePaintBlob
    ? Math.round(Math.min(w, h) * 0.04) // ~20px for 512×512
    : Math.round(Math.min(w, h) * 0.12); // ~61px for 512×512

  const maxDistToPaint = looksLikePaintGesture
    ? Math.min(
        maxDistCap,
        Math.round(
          Math.max(distParams.baseMin, paintScale * distParams.paintScaleFactor) +
            thresholdWidth * distParams.thresholdWidthFactor
        )
      )
    : undefined;

  // Cache the distance transform across threshold updates while the paint strokes stay the same.
  // This keeps the slider responsive (distance transform is O(ROI area)).
  const distToPaint = (() => {
    if (!looksLikePaintGesture) return undefined;

    const sampleCount = 32;
    const step = Math.max(1, Math.floor(paintPx.length / sampleCount));
    const sampled = paintPx
      .filter((_, i) => i % step === 0)
      .map((p) => `${Math.round(p.x)},${Math.round(p.y)}`)
      .join(';');

    const key = `${w}x${h}|${Math.round(roi.x0)},${Math.round(roi.y0)},${Math.round(roi.x1)},${Math.round(roi.y1)}|${sampled}`;
    if (cachedDistKey === key && cachedDist) {
      return cachedDist;
    }

    const computed = computeDistanceToPaint(paintPx, w, h, roi);
    cachedDistKey = key;
    cachedDist = computed;
    return computed;
  })();

  const allowed = buildAllowedMask({
    gray,
    w,
    h,
    roi,
    paintPx,
    threshold: normalizedThreshold,
    looksLikePaintGesture,
    distToPaint,
    maxDistToPaint,
    distanceToleranceScaleMin: opts?.distanceToleranceScaleMin,
    edgePenaltyStrength: opts?.edgePenaltyStrength,
    toleranceLowScale: tolLowScale,
    toleranceHighScale: tolHighScale,
    bgModel: opts?.bgModel,
    geodesic: opts?.geodesic,
    adaptiveEnabled: opts?.adaptiveEnabled,
  });

  // Flood fill from the painted region.
  //
  // IMPORTANT: Do not only seed from the centroid. The allowed mask can be disconnected (e.g. due to
  // local intensity changes, edge gating, or the user's stroke spanning multiple lobes). Seeding from
  // multiple paint points makes the result much more robust and typically improves recall.
  const floodSeeds = (() => {
    const seeds: Array<{ x: number; y: number }> = [seedPx];
    if (!looksLikePaintGesture) return seeds;

    const sampleCount = Math.min(12, paintPx.length);
    const step = Math.max(1, Math.floor(paintPx.length / sampleCount));
    for (let i = 0; i < paintPx.length; i += step) {
      seeds.push(paintPx[i]!);
    }

    return seeds;
  })();

  const { mask, area } = regionGrowMask(allowed, w, h, floodSeeds, roi);

  if (area === 0) {
    throw new Error('No tumor region found in threshold range');
  }

  // Light morphology before contour extraction.
  //
  // - Open removes thin spurs / narrow bridges that often cause leakage FP.
  // - Close fills tiny holes / gaps but can also bridge and create FP.
  //
  // Defaults tuned from GT-driven auto-tune on axial T2 FLAIR.
  //
  // - Close=1 helps fill small interior holes/gaps without overly blurring boundaries.
  // - Open remains off by default to avoid deleting thin tumor structures.
  const openIterations = clamp(Math.round(opts?.morphologicalOpenIterations ?? 0), 0, 3);
  const closeIterations = clamp(Math.round(opts?.morphologicalCloseIterations ?? 1), 0, 3);

  let cleaned = mask;
  for (let i = 0; i < openIterations; i++) {
    cleaned = morphologicalOpen(cleaned, w, h);
  }
  for (let i = 0; i < closeIterations; i++) {
    cleaned = morphologicalClose(cleaned, w, h);
  }

  // Recompute area after cleanup.
  let cleanedArea = 0;
  for (let i = 0; i < cleaned.length; i++) {
    if (cleaned[i]) cleanedArea++;
  }

  // Extract a clean outer contour (largest loop) from the binary mask.
  const contourPx = marchingSquaresContour(cleaned, w, h, roi);
  if (contourPx.length < 3) {
    throw new Error('Failed to extract tumor boundary');
  }

  const contourNorm = contourPx.map((p) => ({
    x: p.x / Math.max(1, w - 1),
    y: p.y / Math.max(1, h - 1),
  }));

  // Smooth jagged pixel edges, then simplify.
  //
  // Keep epsilon fairly small so the polygon stays detailed enough to track the tumor boundary.
  // (Too much simplification looks "blocky" / coarse.)
  // Default is no smoothing; smoothing can slightly shrink boundaries and hurt overlap metrics.
  const smoothingIterations = clamp(Math.round(opts?.smoothingIterations ?? 0), 0, 4);

  // Slightly higher default epsilon reduces tiny boundary wiggles without materially impacting overlap.
  const simplifyEpsilon = opts?.simplifyEpsilon ?? 0.0024;

  const smoothed = smoothingIterations > 0 ? chaikinSmooth(contourNorm, smoothingIterations) : contourNorm;
  const simplified = rdpSimplify(smoothed, simplifyEpsilon);

  return {
    polygon: { points: simplified },
    threshold: normalizedThreshold,
    seed,
    meta: {
      areaPx: cleanedArea,
      areaNorm: cleanedArea / Math.max(1, w * h),
      imageWidth: w,
      imageHeight: h,
    },
  };
}

export async function segmentTumorFromCapturedPng(
  png: Blob,
  paintPointsNorm: NormalizedPoint[],
  thresholdOverride?: TumorThreshold
): Promise<SegmentationResult> {
  if (paintPointsNorm.length < 2) {
    throw new Error('Not enough paint points to segment');
  }

  const { gray, width: w, height: h } = await decodeCapturedPngToGrayscale(png);

  const paintPx = paintPointsNorm.map((p) => ({
    x: clamp(p.x, 0, 1) * (w - 1),
    y: clamp(p.y, 0, 1) * (h - 1),
  }));

  const threshold = thresholdOverride ?? estimateThresholdFromSeeds(gray, w, h, paintPx);

  return segmentTumorFromGrayscale(gray, w, h, paintPointsNorm, threshold);
}
