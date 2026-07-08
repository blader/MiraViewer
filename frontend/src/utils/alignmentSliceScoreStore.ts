import type { FinalAffineProposalKind } from './structuralAffineSelection';

export type AlignmentFinalAffineProposalMetrics = {
  kind: FinalAffineProposalKind;
  status: 'failed' | 'rejected' | 'eligible' | 'selected';
  rejectionReason?: string;
  failureMessage?: string;
  mindScore?: number;
  ngfScore?: number;
  structuralScore?: number;
  deformationMagnitude?: number;
  bidirectionalCoverage?: number;
};

export type AlignmentPerceptualStageMetrics = {
  universeId: string;
  distanceFromSeed: number;
  rigidSeed: {
    A: { m00: number; m01: number; m10: number; m11: number };
    translatePx: { x: number; y: number };
    gridSize: number;
  };
  coverage: number;
  mindRank: number;
  appearanceRank: number;
  boundaryRank: number;
  structuralRank: number;
  perceptualRank: number;
  mindActive: boolean;
  appearanceActive: boolean;
  boundaryActive: boolean;
  structuralActive: boolean;
  phaseInput: 'structural-edge-energy';
  correctionX: number;
  correctionY: number;
  phasePeak: number;
  phasePeakToSidelobeRatio: number;
  retentionReason: 'local-peak' | 'fallback-fill' | 'peak-neighbor' | 'not-retained';
  perScale: Array<{
    size: number;
    mind: number;
    rawMindDistance?: number;
    contrastStructure: number;
    rawContrastStructure?: number;
    lncc: number;
    rawLncc?: number;
    ngf: number;
    rawNgf?: number;
    lowerQuartile: number;
  }>;
};

export type AlignmentSliceScoreMetrics = {
  ssim: number;
  lncc: number;
  zncc: number;
  ngf: number;
  mind?: number;
  rawMindDistance?: number;
  census: number;
  phase: number | null;
  mi: number;
  nmi: number;
  score: number;
  /** Production perceptual-search diagnostics. Legacy fields above remain for old debug runs. */
  stage?: 'coarse' | 'fine';
  distanceFromSeed?: number;
  rigidSeed?: AlignmentPerceptualStageMetrics['rigidSeed'];
  coverage?: number;
  mindRank?: number;
  appearanceRank?: number;
  boundaryRank?: number;
  structuralRank?: number;
  perceptualRank?: number;
  mindActive?: boolean;
  appearanceActive?: boolean;
  boundaryActive?: boolean;
  structuralActive?: boolean;
  phaseInput?: 'structural-edge-energy';
  correctionX?: number;
  correctionY?: number;
  phasePeakToSidelobeRatio?: number;
  retainedForFine?: boolean;
  selected?: boolean;
  coarseStage?: AlignmentPerceptualStageMetrics;
  fineStage?: AlignmentPerceptualStageMetrics;
  perScale?: AlignmentPerceptualStageMetrics['perScale'];
  finalAffineSelected?: FinalAffineProposalKind;
  finalAffineStructuralScore?: number;
  finalAffineSeedStructuralScore?: number;
  finalAffineProposals?: AlignmentFinalAffineProposalMetrics[];
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
  metrics: Omit<AlignmentSliceScoreMetrics, 'phase'> & { phase?: number | null },
): void {
  if (!seriesUid) return;
  if (!Number.isFinite(instanceIndex) || instanceIndex < 0) return;

  let perSeries = scoresBySeries.get(seriesUid);
  if (!perSeries) {
    perSeries = new Map<number, AlignmentSliceScoreMetrics>();
    scoresBySeries.set(seriesUid, perSeries);
  }

  const existing = perSeries.get(instanceIndex);
  perSeries.set(instanceIndex, { ...existing, ...metrics, phase: metrics.phase ?? null });
}

export function getAlignmentSliceScore(seriesUid: string, instanceIndex: number): AlignmentSliceScoreMetrics | null {
  const perSeries = scoresBySeries.get(seriesUid);
  if (!perSeries) return null;
  return perSeries.get(instanceIndex) ?? null;
}
