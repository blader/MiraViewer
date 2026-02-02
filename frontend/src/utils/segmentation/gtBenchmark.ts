import cornerstone from 'cornerstone-core';
import type { NormalizedPoint, TumorPolygon, TumorThreshold, ViewerTransform } from '../../db/schema';
import {
  estimateThresholdFromSeedPoints,
  segmentTumorFromGrayscale,
  type SegmentTumorOptions,
} from './segmentTumor';
import { remapPolygonToImage01 } from './harness/canonicalize';
import { computeMaskMetrics, type MaskMetrics } from './maskMetrics';
import {
  computePolygonBoundaryMetrics,
  type PolygonBoundaryMetrics,
} from './polygonBoundaryMetrics';
import { rasterizePolygonToMask } from './rasterizePolygon';

type CornerstoneImageLike = {
  rows: number;
  columns: number;
  getPixelData: () => ArrayLike<number>;
  minPixelValue?: number;
  maxPixelValue?: number;
};

function clamp(v: number, lo: number, hi: number) {
  return Math.max(lo, Math.min(hi, v));
}

function clamp01(v: number) {
  return clamp(v, 0, 1);
}

function safeViewportSize(v?: { w: number; h: number } | null): { w: number; h: number } {
  const w = Math.max(1, Math.round(Number.isFinite(v?.w) ? v!.w : 0));
  const h = Math.max(1, Math.round(Number.isFinite(v?.h) ? v!.h : 0));
  return { w, h };
}

function toByte(v: number) {
  return Math.max(0, Math.min(255, Math.round(v)));
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
    const intersects =
      a.y > pt.y !== b.y > pt.y &&
      pt.x < ((b.x - a.x) * (pt.y - a.y)) / (b.y - a.y + 1e-12) + a.x;

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

function generatePaintPointsFromGt(
  gt: TumorPolygon,
  seedKey: string,
  targetCount: number
): NormalizedPoint[] {
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

function computeMaskMetricsFromCounts(tp: number, fp: number, fn: number, tn: number): MaskMetrics {
  const safeDiv = (num: number, den: number) => (den > 0 ? num / den : 0);

  const precision = safeDiv(tp, tp + fp);
  const recall = safeDiv(tp, tp + fn);
  const dice = safeDiv(2 * tp, 2 * tp + fp + fn);
  const iou = safeDiv(tp, tp + fp + fn);

  const beta2 = 4;
  const f2 = safeDiv((1 + beta2) * precision * recall, beta2 * precision + recall);

  return { tp, fp, fn, tn, precision, recall, dice, iou, f2 };
}

async function yieldToUi() {
  await new Promise<void>((resolve) => {
    (globalThis.setTimeout ?? setTimeout)(resolve, 0);
  });
}

export type GtBenchmarkCase = {
  id: string;
  comboId: string;
  dateIso: string;
  seriesUid: string;
  sopInstanceUid: string;

  // GT polygon is stored in viewer-normalized coordinates.
  gtPolygon: TumorPolygon;

  // Optional metadata needed to canonicalize GT into image coordinates.
  gtViewTransform?: ViewerTransform;
  gtViewportSize?: { w: number; h: number };
};

export type GtBenchmarkConfig = {
  name: string;
  opts?: SegmentTumorOptions;
};

export type GtBenchmarkCaseConfigResult = {
  ok: boolean;
  error?: string;
  threshold?: TumorThreshold;
  metrics?: MaskMetrics;
  boundary?: PolygonBoundaryMetrics;
  predPolygonPointCount?: number;
  timingMs?: {
    segment: number;
    evaluate: number;
  };
};

export type GtBenchmarkCaseResult = {
  id: string;
  comboId: string;
  dateIso: string;
  seriesUid: string;
  sopInstanceUid: string;
  image: {
    imageId: string;
    sourceW: number;
    sourceH: number;
    evalW: number;
    evalH: number;
  };
  paintPointsCount: number;
  resultsByConfig: Record<string, GtBenchmarkCaseConfigResult>;
  timingMs: {
    loadImage: number;
    total: number;
  };
};

export type GtBenchmarkSummary = {
  config: string;
  casesTotal: number;
  casesOk: number;
  casesError: number;
  micro: MaskMetrics;
  boundary: {
    meanPredToGtPx: number;
    meanGtToPredPx: number;
    meanSymPx: number;
    maxSymPx: number;
    count: number;
  };
};

export type GtBenchmarkReport = {
  version: 1;
  generatedAtIso: string;
  settings: {
    maxEvalDim: number;
    paintPointsPerCase: number;
  };
  configs: Array<{ name: string; opts?: SegmentTumorOptions }>;
  summary: GtBenchmarkSummary[];
  cases: GtBenchmarkCaseResult[];
  note: string;
};

async function loadAndNormalizeImage(
  sopInstanceUid: string,
  maxEvalDim: number
): Promise<{ imageId: string; gray: Uint8Array; w: number; h: number; sourceW: number; sourceH: number }> {
  const imageId = `miradb:${sopInstanceUid}`;
  const image = (await cornerstone.loadImage(imageId)) as unknown as CornerstoneImageLike;

  const rows = image.rows;
  const cols = image.columns;
  const getPixelData = image.getPixelData;
  if (!rows || !cols || typeof getPixelData !== 'function') {
    throw new Error('Cornerstone image missing pixel data');
  }

  const pd = getPixelData();

  let min = image.minPixelValue;
  let max = image.maxPixelValue;

  if (!Number.isFinite(min) || !Number.isFinite(max)) {
    min = Number.POSITIVE_INFINITY;
    max = Number.NEGATIVE_INFINITY;
    for (let i = 0; i < pd.length; i++) {
      const v = pd[i];
      if (v < min) min = v;
      if (v > max) max = v;
    }
  }

  const denom = (max as number) - (min as number);

  // Downsample for speed, preserving aspect ratio.
  const scale = Math.max(cols, rows) / Math.max(16, maxEvalDim);
  const w = scale > 1 ? Math.max(16, Math.round(cols / scale)) : cols;
  const h = scale > 1 ? Math.max(16, Math.round(rows / scale)) : rows;

  const gray = new Uint8Array(w * h);

  if (!Number.isFinite(denom) || Math.abs(denom) < 1e-8) {
    gray.fill(0);
    return { imageId, gray, w, h, sourceW: cols, sourceH: rows };
  }

  for (let y = 0; y < h; y++) {
    const sy = h <= 1 ? 0 : Math.round((y * (rows - 1)) / (h - 1));
    for (let x = 0; x < w; x++) {
      const sx = w <= 1 ? 0 : Math.round((x * (cols - 1)) / (w - 1));
      const v = pd[sy * cols + sx];
      const t = ((v - (min as number)) / denom) * 255;
      gray[y * w + x] = toByte(t);
    }
  }

  return { imageId, gray, w, h, sourceW: cols, sourceH: rows };
}

export type RunGtBenchmarkInput = {
  cases: GtBenchmarkCase[];
  configs: GtBenchmarkConfig[];
  maxEvalDim?: number;
  paintPointsPerCase?: number;
  yieldEveryCases?: number;
  onProgress?: (p: { caseIndex: number; caseCount: number; configName?: string; message: string }) => void;
};

export async function runGtBenchmark(input: RunGtBenchmarkInput): Promise<GtBenchmarkReport> {
  const maxEvalDim = input.maxEvalDim ?? 256;
  const paintPointsPerCase = input.paintPointsPerCase ?? 24;
  const yieldEveryCases = input.yieldEveryCases ?? 1;

  const configs = input.configs.map((c) => ({ name: c.name, opts: c.opts }));

  const cases: GtBenchmarkCaseResult[] = [];

  type Agg = {
    casesOk: number;
    casesError: number;
    tp: number;
    fp: number;
    fn: number;
    tn: number;
    bMeanPredToGtSum: number;
    bMeanGtToPredSum: number;
    bMeanSymSum: number;
    bMaxSymMax: number;
    bCount: number;
  };

  const aggs: Record<string, Agg> = {};
  for (const c of configs) {
    aggs[c.name] = {
      casesOk: 0,
      casesError: 0,
      tp: 0,
      fp: 0,
      fn: 0,
      tn: 0,
      bMeanPredToGtSum: 0,
      bMeanGtToPredSum: 0,
      bMeanSymSum: 0,
      bMaxSymMax: 0,
      bCount: 0,
    };
  }

  const caseCount = input.cases.length;

  for (let caseIndex = 0; caseIndex < caseCount; caseIndex++) {
    const c = input.cases[caseIndex]!;
    const tCase0 = performance.now();

    input.onProgress?.({
      caseIndex,
      caseCount,
      message: `Benchmark: loading slice ${caseIndex + 1}/${caseCount}…`,
    });

    const tLoad0 = performance.now();
    let image:
      | { imageId: string; gray: Uint8Array; w: number; h: number; sourceW: number; sourceH: number }
      | null = null;
    let loadError: string | null = null;

    try {
      image = await loadAndNormalizeImage(c.sopInstanceUid, maxEvalDim);
    } catch (e) {
      loadError = e instanceof Error ? e.message : 'Failed to load image';
    }
    const tLoad1 = performance.now();

    const resultsByConfig: Record<string, GtBenchmarkCaseConfigResult> = {};

    if (!image) {
      for (const cfg of configs) {
        resultsByConfig[cfg.name] = { ok: false, error: `Image load failed: ${loadError ?? 'unknown error'}` };
        aggs[cfg.name].casesError++;
      }

      const tCase1 = performance.now();
      cases.push({
        id: c.id,
        comboId: c.comboId,
        dateIso: c.dateIso,
        seriesUid: c.seriesUid,
        sopInstanceUid: c.sopInstanceUid,
        image: {
          imageId: `miradb:${c.sopInstanceUid}`,
          sourceW: 0,
          sourceH: 0,
          evalW: 0,
          evalH: 0,
        },
        paintPointsCount: 0,
        resultsByConfig,
        timingMs: {
          loadImage: tLoad1 - tLoad0,
          total: tCase1 - tCase0,
        },
      });

      if (yieldEveryCases > 0 && caseIndex % yieldEveryCases === 0) {
        await yieldToUi();
      }
      continue;
    }

    const gtPolyImage01 = remapPolygonToImage01({
      polygon: c.gtPolygon,
      viewportSize: safeViewportSize(c.gtViewportSize ?? { w: 512, h: 512 }),
      fromViewTransform: c.gtViewTransform,
      imageSize: { w: image.w, h: image.h },
    });

    const paintPoints = generatePaintPointsFromGt(gtPolyImage01, c.id, paintPointsPerCase);
    const threshold = estimateThresholdFromSeedPoints(image.gray, image.w, image.h, paintPoints);

    for (const cfg of configs) {
      const tSeg0 = performance.now();
      input.onProgress?.({
        caseIndex,
        caseCount,
        configName: cfg.name,
        message: `Benchmark: segmenting (${cfg.name}) ${caseIndex + 1}/${caseCount}…`,
      });

      try {
        const res = segmentTumorFromGrayscale(image.gray, image.w, image.h, paintPoints, threshold, cfg.opts);

        const tEval0 = performance.now();
        const gtMask = rasterizePolygonToMask(gtPolyImage01, image.w, image.h);
        const predMask = rasterizePolygonToMask(res.polygon, image.w, image.h);
        const metrics = computeMaskMetrics(predMask, gtMask);
        const boundary = computePolygonBoundaryMetrics(res.polygon, gtPolyImage01, image.w, image.h);
        const tEval1 = performance.now();

        resultsByConfig[cfg.name] = {
          ok: true,
          threshold,
          metrics,
          boundary,
          predPolygonPointCount: res.polygon.points.length,
          timingMs: {
            segment: tEval0 - tSeg0,
            evaluate: tEval1 - tEval0,
          },
        };

        const a = aggs[cfg.name];
        a.casesOk++;
        a.tp += metrics.tp;
        a.fp += metrics.fp;
        a.fn += metrics.fn;
        a.tn += metrics.tn;

        if (Number.isFinite(boundary.meanSymPx)) {
          a.bMeanPredToGtSum += boundary.meanPredToGtPx;
          a.bMeanGtToPredSum += boundary.meanGtToPredPx;
          a.bMeanSymSum += boundary.meanSymPx;
          a.bMaxSymMax = Math.max(a.bMaxSymMax, boundary.maxSymPx);
          a.bCount++;
        }
      } catch (e) {
        const msg = e instanceof Error ? e.message : 'Segmentation failed';
        resultsByConfig[cfg.name] = {
          ok: false,
          error: msg,
        };
        aggs[cfg.name].casesError++;
      }
    }

    const tCase1 = performance.now();

    cases.push({
      id: c.id,
      comboId: c.comboId,
      dateIso: c.dateIso,
      seriesUid: c.seriesUid,
      sopInstanceUid: c.sopInstanceUid,
      image: {
        imageId: image.imageId,
        sourceW: image.sourceW,
        sourceH: image.sourceH,
        evalW: image.w,
        evalH: image.h,
      },
      paintPointsCount: paintPoints.length,
      resultsByConfig,
      timingMs: {
        loadImage: tLoad1 - tLoad0,
        total: tCase1 - tCase0,
      },
    });

    if (yieldEveryCases > 0 && caseIndex % yieldEveryCases === 0) {
      await yieldToUi();
    }
  }

  const summary: GtBenchmarkSummary[] = [];
  for (const cfg of configs) {
    const a = aggs[cfg.name];
    const micro = computeMaskMetricsFromCounts(a.tp, a.fp, a.fn, a.tn);

    summary.push({
      config: cfg.name,
      casesTotal: caseCount,
      casesOk: a.casesOk,
      casesError: a.casesError,
      micro,
      boundary: {
        meanPredToGtPx: a.bCount ? a.bMeanPredToGtSum / a.bCount : Number.POSITIVE_INFINITY,
        meanGtToPredPx: a.bCount ? a.bMeanGtToPredSum / a.bCount : Number.POSITIVE_INFINITY,
        meanSymPx: a.bCount ? a.bMeanSymSum / a.bCount : Number.POSITIVE_INFINITY,
        maxSymPx: a.bCount ? a.bMaxSymMax : Number.POSITIVE_INFINITY,
        count: a.bCount,
      },
    });
  }

  return {
    version: 1,
    generatedAtIso: new Date().toISOString(),
    settings: {
      maxEvalDim,
      paintPointsPerCase,
    },
    configs,
    summary,
    cases,
    note:
      'This benchmark uses auto-generated paint points inside the GT polygon (deterministic per GT id) and thresholds estimated from those samples. Images are loaded from Cornerstone pixel data and downsampled (preserving aspect ratio) to maxEvalDim for speed.',
  };
}
