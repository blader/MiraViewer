import type { NormalizedPoint, TumorPolygon, TumorThreshold } from '../../../db/schema';
import type { SegmentTumorOptions } from '../segmentTumor';
import { estimateThresholdFromSeedPoints, segmentTumorFromGrayscale } from '../segmentTumor';
import { computeMaskMetrics, type MaskMetrics } from '../maskMetrics';
import {
  computePolygonBoundaryMetrics,
  type PolygonBoundaryMetrics,
} from '../polygonBoundaryMetrics';
import { rasterizePolygonToMask } from '../rasterizePolygon';
import {
  propagateTumorAcrossFramesCore,
  type PropagationFrame,
} from '../../tumorPropagationCore';
import { base64ToBytes } from './base64';
import type {
  TumorHarnessCaseV1,
  TumorHarnessDatasetV1,
  TumorHarnessPropagationFrameV1,
} from './dataset';
import { generateSyntheticPaintPointsFromGt } from './syntheticPaint';

export type TumorHarnessConfig = {
  name: string;
  // Segmentation opts used for both single-slice and propagation runs.
  opts?: SegmentTumorOptions;
};

export type TumorHarnessCaseResult = {
  caseId: string;
  ok: boolean;
  error?: string;
  threshold?: TumorThreshold;
  metrics?: MaskMetrics;
  boundary?: PolygonBoundaryMetrics;
  predPolygonPointCount?: number;
};

export type TumorHarnessPropagationSliceEval = {
  effectiveIndex: number;
  sopInstanceUid: string;
  ok: boolean;
  hadPrediction: boolean;
  metrics: MaskMetrics;
  boundary?: PolygonBoundaryMetrics;
};

export type TumorHarnessPropagationScenarioResult = {
  scenarioId: string;
  config: string;
  startIndex: number;
  savedCount: number;
  scoredGtSlices: number;
  micro: MaskMetrics;
  boundaryAgg: {
    meanPredToGtPx: number;
    meanGtToPredPx: number;
    meanSymPx: number;
    maxSymPx: number;
    count: number;
  };
  slices: TumorHarnessPropagationSliceEval[];
};

export type TumorHarnessReport = {
  version: 1;
  generatedAtIso: string;
  dataset: {
    generatedAtIso: string;
    maxEvalDim: number;
    cases: number;
    propagationScenarios: number;
  };
  configs: Array<{ name: string; opts?: SegmentTumorOptions }>;
  segmentation: {
    byConfig: Array<{
      config: string;
      casesTotal: number;
      casesOk: number;
      casesError: number;
      micro: MaskMetrics;
      boundaryAgg: {
        meanPredToGtPx: number;
        meanGtToPredPx: number;
        meanSymPx: number;
        maxSymPx: number;
        count: number;
      };
      cases: TumorHarnessCaseResult[];
    }>;
  };
  propagation: {
    byScenarioConfig: TumorHarnessPropagationScenarioResult[];
  };
};

function safeDiv(num: number, den: number) {
  return den > 0 ? num / den : 0;
}

function metricsFromCounts(tp: number, fp: number, fn: number, tn: number): MaskMetrics {
  const precision = safeDiv(tp, tp + fp);
  const recall = safeDiv(tp, tp + fn);
  const dice = safeDiv(2 * tp, 2 * tp + fp + fn);
  const iou = safeDiv(tp, tp + fp + fn);

  const beta2 = 4;
  const f2 = safeDiv((1 + beta2) * precision * recall, beta2 * precision + recall);

  return { tp, fp, fn, tn, precision, recall, dice, iou, f2 };
}

function decodeGray(caseOrFrame: { image: { w: number; h: number; grayB64: string } }): Uint8Array {
  const { w, h, grayB64 } = caseOrFrame.image;
  const bytes = base64ToBytes(grayB64);
  const want = w * h;
  if (bytes.length !== want) {
    throw new Error(`Decoded gray length mismatch (got ${bytes.length}, want ${want} for ${w}x${h})`);
  }
  return bytes;
}

function getPaintPointsForCase(c: TumorHarnessCaseV1): NormalizedPoint[] {
  if (c.paintPointsImage01 && c.paintPointsImage01.length >= 2) return c.paintPointsImage01;
  return generateSyntheticPaintPointsFromGt(c.gtPolygonImage01, c.id, 24);
}

function jitterCross(seed: NormalizedPoint, w: number, h: number): NormalizedPoint[] {
  const clamp01 = (v: number) => Math.max(0, Math.min(1, v));
  const jitter = Math.max(0.002, 1 / Math.max(w, h));
  return [
    { x: clamp01(seed.x), y: clamp01(seed.y) },
    { x: clamp01(seed.x + jitter), y: clamp01(seed.y) },
    { x: clamp01(seed.x - jitter), y: clamp01(seed.y) },
    { x: clamp01(seed.x), y: clamp01(seed.y + jitter) },
    { x: clamp01(seed.x), y: clamp01(seed.y - jitter) },
  ];
}

export async function runTumorHarnessDataset(args: {
  dataset: TumorHarnessDatasetV1;
  configs: TumorHarnessConfig[];
}): Promise<TumorHarnessReport> {
  const { dataset, configs } = args;

  const report: TumorHarnessReport = {
    version: 1,
    generatedAtIso: new Date().toISOString(),
    dataset: {
      generatedAtIso: dataset.generatedAtIso,
      maxEvalDim: dataset.settings.maxEvalDim,
      cases: dataset.cases.length,
      propagationScenarios: dataset.propagationScenarios?.length ?? 0,
    },
    configs: configs.map((c) => ({ name: c.name, opts: c.opts })),
    segmentation: { byConfig: [] },
    propagation: { byScenarioConfig: [] },
  };

  // --------
  // Single-slice segmentation evaluation
  // --------
  for (const cfg of configs) {
    const casesOut: TumorHarnessCaseResult[] = [];

    let tp = 0;
    let fp = 0;
    let fn = 0;
    let tn = 0;

    let bCount = 0;
    let bMeanPredToGtSum = 0;
    let bMeanGtToPredSum = 0;
    let bMeanSymSum = 0;
    let bMaxSymMax = 0;

    for (const c of dataset.cases) {
      try {
        const gray = decodeGray(c);
        const w = c.image.w;
        const h = c.image.h;

        const paint = getPaintPointsForCase(c);
        const threshold = estimateThresholdFromSeedPoints(gray, w, h, paint);
        const seg = segmentTumorFromGrayscale(gray, w, h, paint, threshold, cfg.opts);

        const gtMask = rasterizePolygonToMask(c.gtPolygonImage01, w, h);
        const predMask = rasterizePolygonToMask(seg.polygon, w, h);

        const metrics = computeMaskMetrics(predMask, gtMask);
        const boundary = computePolygonBoundaryMetrics(seg.polygon, c.gtPolygonImage01, w, h);

        casesOut.push({
          caseId: c.id,
          ok: true,
          threshold,
          metrics,
          boundary,
          predPolygonPointCount: seg.polygon.points.length,
        });

        tp += metrics.tp;
        fp += metrics.fp;
        fn += metrics.fn;
        tn += metrics.tn;

        if (Number.isFinite(boundary.meanSymPx)) {
          bCount++;
          bMeanPredToGtSum += boundary.meanPredToGtPx;
          bMeanGtToPredSum += boundary.meanGtToPredPx;
          bMeanSymSum += boundary.meanSymPx;
          bMaxSymMax = Math.max(bMaxSymMax, boundary.maxSymPx);
        }
      } catch (e) {
        casesOut.push({
          caseId: c.id,
          ok: false,
          error: e instanceof Error ? e.message : 'Segmentation failed',
        });
      }
    }

    report.segmentation.byConfig.push({
      config: cfg.name,
      casesTotal: dataset.cases.length,
      casesOk: casesOut.filter((r) => r.ok).length,
      casesError: casesOut.filter((r) => !r.ok).length,
      micro: metricsFromCounts(tp, fp, fn, tn),
      boundaryAgg: {
        meanPredToGtPx: bCount ? bMeanPredToGtSum / bCount : Number.POSITIVE_INFINITY,
        meanGtToPredPx: bCount ? bMeanGtToPredSum / bCount : Number.POSITIVE_INFINITY,
        meanSymPx: bCount ? bMeanSymSum / bCount : Number.POSITIVE_INFINITY,
        maxSymPx: bCount ? bMaxSymMax : Number.POSITIVE_INFINITY,
        count: bCount,
      },
      cases: casesOut,
    });
  }

  // --------
  // Propagation evaluation
  // --------
  const scenarios = dataset.propagationScenarios ?? [];
  for (const scenario of scenarios) {
    for (const cfg of configs) {
      const startIdx = scenario.start.effectiveIndex;

      if (scenario.frames.length === 0) {
        report.propagation.byScenarioConfig.push({
          scenarioId: scenario.id,
          config: cfg.name,
          startIndex: startIdx,
          savedCount: 0,
          scoredGtSlices: 0,
          micro: metricsFromCounts(0, 0, 0, 0),
          boundaryAgg: {
            meanPredToGtPx: Number.POSITIVE_INFINITY,
            meanGtToPredPx: Number.POSITIVE_INFINITY,
            meanSymPx: Number.POSITIVE_INFINITY,
            maxSymPx: Number.POSITIVE_INFINITY,
            count: 0,
          },
          slices: [],
        });
        continue;
      }

      const framesByIndex = new Map<number, TumorHarnessPropagationFrameV1>();
      for (const f of scenario.frames) {
        framesByIndex.set(f.effectiveIndex, f);
      }

      const minIdx = Math.min(...scenario.frames.map((f) => f.effectiveIndex));
      const maxIdx = Math.max(...scenario.frames.map((f) => f.effectiveIndex));

      const startFrame = framesByIndex.get(startIdx);
      if (!startFrame) {
        report.propagation.byScenarioConfig.push({
          scenarioId: scenario.id,
          config: cfg.name,
          startIndex: startIdx,
          savedCount: 0,
          scoredGtSlices: 0,
          micro: metricsFromCounts(0, 0, 0, 0),
          boundaryAgg: {
            meanPredToGtPx: Number.POSITIVE_INFINITY,
            meanGtToPredPx: Number.POSITIVE_INFINITY,
            meanSymPx: Number.POSITIVE_INFINITY,
            maxSymPx: Number.POSITIVE_INFINITY,
            count: 0,
          },
          slices: [],
        });
        continue;
      }

      // Initial segmentation on the start slice (from paint).
      const startGray = decodeGray(startFrame);
      const startW = startFrame.image.w;
      const startH = startFrame.image.h;

      const startPaint = scenario.start.paintPointsImage01;
      const startThreshold =
        scenario.start.threshold ?? estimateThresholdFromSeedPoints(startGray, startW, startH, startPaint);

      const startSeg = segmentTumorFromGrayscale(startGray, startW, startH, startPaint, startThreshold, cfg.opts);
      const seed = startSeg.seed;

      const getFrame = async (index: number): Promise<PropagationFrame | null> => {
        const f = framesByIndex.get(index);
        if (!f) return null;
        const gray = decodeGray(f);
        return {
          sopInstanceUid: f.sopInstanceUid,
          w: f.image.w,
          h: f.image.h,
          gray,
          seedPointsNorm: jitterCross(seed, f.image.w, f.image.h),
        };
      };

      const stop = scenario.stop ?? { minAreaPx: 80, maxMissesInARow: 3 };
      const propRes = await propagateTumorAcrossFramesCore({
        minIndex: minIdx,
        maxIndex: maxIdx,
        startEffectiveIndex: startIdx,
        getFrame,
        threshold: startThreshold,
        opts: cfg.opts,
        stop,
      });

      // Merge start slice into predictions.
      const predByIndex = new Map<number, TumorPolygon>();
      predByIndex.set(startIdx, startSeg.polygon);
      for (const r of propRes.results) {
        predByIndex.set(r.index, r.segmentation.polygon);
      }

      let tp = 0;
      let fp = 0;
      let fn = 0;
      let tn = 0;

      let bCount = 0;
      let bMeanPredToGtSum = 0;
      let bMeanGtToPredSum = 0;
      let bMeanSymSum = 0;
      let bMaxSymMax = 0;

      const sliceEvals: TumorHarnessPropagationSliceEval[] = [];

      for (const f of scenario.frames) {
        const gt = f.gtPolygonImage01;
        if (!gt || (gt.points?.length ?? 0) < 3) continue;

        const w = f.image.w;
        const h = f.image.h;

        const gtMask = rasterizePolygonToMask(gt, w, h);

        const predPoly = predByIndex.get(f.effectiveIndex) ?? null;
        const hadPrediction = !!predPoly;
        const predMask = predPoly ? rasterizePolygonToMask(predPoly, w, h) : new Uint8Array(w * h);

        const metrics = computeMaskMetrics(predMask, gtMask);

        const boundary = predPoly ? computePolygonBoundaryMetrics(predPoly, gt, w, h) : undefined;

        sliceEvals.push({
          effectiveIndex: f.effectiveIndex,
          sopInstanceUid: f.sopInstanceUid,
          ok: true,
          hadPrediction,
          metrics,
          boundary,
        });

        tp += metrics.tp;
        fp += metrics.fp;
        fn += metrics.fn;
        tn += metrics.tn;

        if (boundary && Number.isFinite(boundary.meanSymPx)) {
          bCount++;
          bMeanPredToGtSum += boundary.meanPredToGtPx;
          bMeanGtToPredSum += boundary.meanGtToPredPx;
          bMeanSymSum += boundary.meanSymPx;
          bMaxSymMax = Math.max(bMaxSymMax, boundary.maxSymPx);
        }
      }

      report.propagation.byScenarioConfig.push({
        scenarioId: scenario.id,
        config: cfg.name,
        startIndex: startIdx,
        savedCount: propRes.saved,
        scoredGtSlices: sliceEvals.length,
        micro: metricsFromCounts(tp, fp, fn, tn),
        boundaryAgg: {
          meanPredToGtPx: bCount ? bMeanPredToGtSum / bCount : Number.POSITIVE_INFINITY,
          meanGtToPredPx: bCount ? bMeanGtToPredSum / bCount : Number.POSITIVE_INFINITY,
          meanSymPx: bCount ? bMeanSymSum / bCount : Number.POSITIVE_INFINITY,
          maxSymPx: bCount ? bMaxSymMax : Number.POSITIVE_INFINITY,
          count: bCount,
        },
        slices: sliceEvals,
      });
    }
  }

  return report;
}

export function parseTumorHarnessDataset(jsonText: string): TumorHarnessDatasetV1 {
  const raw = JSON.parse(jsonText) as unknown;
  const d = raw as TumorHarnessDatasetV1;

  if (!d || d.version !== 1) {
    throw new Error('Unsupported tumor harness dataset version');
  }

  if (!Array.isArray(d.cases)) {
    throw new Error('Invalid tumor harness dataset: missing cases');
  }

  return d;
}

export function summarizeReport(report: TumorHarnessReport): {
  bestSegConfigByF2: { name: string; f2: number } | null;
  bestSegConfigByDice: { name: string; dice: number } | null;
} {
  const seg = report.segmentation.byConfig;
  if (!seg.length) return { bestSegConfigByF2: null, bestSegConfigByDice: null };

  const bestF2 = seg.reduce((a, b) => (b.micro.f2 > a.micro.f2 ? b : a));
  const bestDice = seg.reduce((a, b) => (b.micro.dice > a.micro.dice ? b : a));

  return {
    bestSegConfigByF2: { name: bestF2.config, f2: bestF2.micro.f2 },
    bestSegConfigByDice: { name: bestDice.config, dice: bestDice.micro.dice },
  };
}
