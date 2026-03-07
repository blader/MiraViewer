export type AlignmentSliceScoreMetrics = {
  ssim: number;
  lncc: number;
  zncc: number;
  ngf: number;
  census: number;
  mind: number | null;
  phase: number | null;
  mi: number;
  nmi: number;
  miGrad: number | null;
  nmiGrad: number | null;
  score: number;
};

export type AlignmentSliceScoreContext = {
  referenceSeriesUid: string;
  referenceSliceIndex: number;
  startedAtMs: number;
};

let context: AlignmentSliceScoreContext | null = null;

// Keyed by series UID (moving series), then by instance index (0..instance_count-1).
const scoresBySeries = new Map<string, Map<number, AlignmentSliceScoreMetrics>>();

export function resetAlignmentSliceScoreStore(nextContext: {
  referenceSeriesUid: string;
  referenceSliceIndex: number;
}): void {
  scoresBySeries.clear();
  context = {
    referenceSeriesUid: nextContext.referenceSeriesUid,
    referenceSliceIndex: nextContext.referenceSliceIndex,
    startedAtMs: Date.now(),
  };
}

export function getAlignmentSliceScoreContext(): AlignmentSliceScoreContext | null {
  return context;
}

export function recordAlignmentSliceScore(
  seriesUid: string,
  instanceIndex: number,
  metrics: {
    ssim: number;
    lncc: number;
    zncc: number;
    ngf: number;
    census: number;
    mind?: number | null;
    phase?: number | null;
    mi: number;
    nmi: number;
    miGrad?: number | null;
    nmiGrad?: number | null;
    score: number;
  }
): void {
  if (!seriesUid) return;
  if (!Number.isFinite(instanceIndex) || instanceIndex < 0) return;

  let perSeries = scoresBySeries.get(seriesUid);
  if (!perSeries) {
    perSeries = new Map<number, AlignmentSliceScoreMetrics>();
    scoresBySeries.set(seriesUid, perSeries);
  }

  perSeries.set(instanceIndex, {
    ssim: metrics.ssim,
    lncc: metrics.lncc,
    zncc: metrics.zncc,
    ngf: metrics.ngf,
    census: metrics.census,
    mind: metrics.mind ?? null,
    phase: metrics.phase ?? null,
    mi: metrics.mi,
    nmi: metrics.nmi,
    miGrad: metrics.miGrad ?? null,
    nmiGrad: metrics.nmiGrad ?? null,
    score: metrics.score,
  });
}

export function getAlignmentSliceScore(
  seriesUid: string,
  instanceIndex: number
): AlignmentSliceScoreMetrics | null {
  const perSeries = scoresBySeries.get(seriesUid);
  if (!perSeries) return null;
  return perSeries.get(instanceIndex) ?? null;
}
