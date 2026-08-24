import type { ExclusionMask } from '../types/api';
import { det2, invert2, invertStandardAffine2D, standardToAffineAboutOrigin, type StandardAffine2D } from './affine2d';
import {
  composeResidualWithWarpAtSize,
  expandExclusionRect,
  mapFixedExclusionToMovingBounds,
  type WarpTransform,
} from './alignmentTransform';
import {
  createPerceptualScoringScratch,
  normalizePerceptualSource,
  preparePerceptualReference,
  scoreAlignedCandidate,
  type PerceptualComponents,
} from './perceptualSliceSimilarity';
import { warpGrayscaleAffineWithValidity } from './warpAffine';

const MAX_RESIDUAL_DISPLACEMENT_FRACTION = 0.125;
const FINAL_AFFINE_SCORE_EPSILON = 1e-6;

export type FinalAffineProposalKind = 'seed-only' | 'intensity-elastix' | 'structure-elastix';

export type OptimizerFinalAffineProposal = {
  kind: Exclude<FinalAffineProposalKind, 'seed-only'>;
  /** Residual moving-to-fixed transform applied after winningWarp. */
  residualMovingToFixed: StandardAffine2D;
};

export type ScoredFinalAffineProposal = {
  kind: FinalAffineProposalKind;
  residualMovingToFixed: StandardAffine2D;
  eligible: true;
  /** residualMovingToFixed composed after the winning rigid-plus-phase warp. */
  totalMovingToFixed: StandardAffine2D;
  components: {
    forward: PerceptualComponents;
    sourceCoverage: number;
  };
  mindScore: number;
  ngfScore: number;
  structuralScore: number;
  bidirectionalCoverage: number;
  deformationMagnitude: number;
};

export type RejectedFinalAffineProposal = {
  kind: Exclude<FinalAffineProposalKind, 'seed-only'>;
  residualMovingToFixed: StandardAffine2D;
  eligible: false;
  rejectionReason:
    | 'non-finite'
    | 'singular'
    | 'orientation-reversing'
    | 'excessive-displacement'
    | 'coverage-regression';
  structuralScore?: number;
  mindScore?: number;
  ngfScore?: number;
  bidirectionalCoverage?: number;
  deformationMagnitude?: number;
};

export type FinalAffineSelection = {
  proposals: readonly (ScoredFinalAffineProposal | RejectedFinalAffineProposal)[];
  selected: ScoredFinalAffineProposal;
  fixedScoringExclusionRect?: ExclusionMask;
  sourceExclusionRect?: ExclusionMask;
};

type GeometricallyAdmissibleProposal = {
  kind: FinalAffineProposalKind;
  residualMovingToFixed: StandardAffine2D;
  totalMovingToFixed: StandardAffine2D;
  deformationMagnitude: number;
};

type GeometricallyAdmissibleOptimizerProposal = Omit<GeometricallyAdmissibleProposal, 'kind'> & {
  kind: OptimizerFinalAffineProposal['kind'];
};

const KIND_ORDER: Record<FinalAffineProposalKind, number> = {
  'seed-only': 0,
  'structure-elastix': 1,
  'intensity-elastix': 2,
};

function assertSquare(pixels: Float32Array, size: number, label: string): void {
  if (pixels.length !== size * size) {
    throw new Error(`${label}: expected ${size}x${size} pixels, got ${pixels.length}`);
  }
}

function createIdentityResidual(): StandardAffine2D {
  return {
    A: { m00: 1, m01: 0, m10: 0, m11: 1 },
    b: { x: 0, y: 0 },
  };
}

function allAffineValuesAreFinite(transform: StandardAffine2D): boolean {
  return (
    Number.isFinite(transform.A.m00) &&
    Number.isFinite(transform.A.m01) &&
    Number.isFinite(transform.A.m10) &&
    Number.isFinite(transform.A.m11) &&
    Number.isFinite(transform.b.x) &&
    Number.isFinite(transform.b.y)
  );
}

function residualDeformationMagnitude(transform: StandardAffine2D, size: number): number {
  const maximumCoordinate = size - 1;
  const corners = [
    { x: 0, y: 0 },
    { x: maximumCoordinate, y: 0 },
    { x: 0, y: maximumCoordinate },
    { x: maximumCoordinate, y: maximumCoordinate },
  ];
  let maximumDisplacement = 0;
  for (const corner of corners) {
    const transformedX = transform.A.m00 * corner.x + transform.A.m01 * corner.y + transform.b.x;
    const transformedY = transform.A.m10 * corner.x + transform.A.m11 * corner.y + transform.b.y;
    maximumDisplacement = Math.max(
      maximumDisplacement,
      Math.abs(transformedX - corner.x),
      Math.abs(transformedY - corner.y),
    );
  }
  return maximumDisplacement / size;
}

function average(values: readonly number[]): number {
  if (values.length === 0) throw new Error('selectFinalAffineProposal: no structural scales were scored');
  let sum = 0;
  for (const value of values) sum += value;
  return sum / values.length;
}

function centeredWarp(transform: StandardAffine2D, size: number): WarpTransform {
  const center = { x: (size - 1) / 2, y: (size - 1) / 2 };
  const aboutCenter = standardToAffineAboutOrigin(transform.A, transform.b, center);
  return {
    A: aboutCenter.A,
    translateX: aboutCenter.t.x,
    translateY: aboutCenter.t.y,
  };
}

function validateOptimizerProposals(proposals: readonly OptimizerFinalAffineProposal[]): void {
  const seen = new Set<OptimizerFinalAffineProposal['kind']>();
  for (const proposal of proposals) {
    if (proposal.kind !== 'intensity-elastix' && proposal.kind !== 'structure-elastix') {
      throw new Error(`selectFinalAffineProposal: invalid optimizer proposal kind ${String(proposal.kind)}`);
    }
    if (seen.has(proposal.kind)) {
      throw new Error(`selectFinalAffineProposal: expected at most one ${proposal.kind} proposal`);
    }
    seen.add(proposal.kind);
  }
}

function validateGeometry(
  proposal: OptimizerFinalAffineProposal,
  winningWarp: WarpTransform,
  size: number,
): GeometricallyAdmissibleOptimizerProposal | RejectedFinalAffineProposal {
  const { residualMovingToFixed } = proposal;
  if (!allAffineValuesAreFinite(residualMovingToFixed)) {
    return { ...proposal, eligible: false, rejectionReason: 'non-finite' };
  }

  const determinant = det2(residualMovingToFixed.A);
  try {
    invert2(residualMovingToFixed.A);
  } catch {
    return { ...proposal, eligible: false, rejectionReason: 'singular' };
  }
  if (determinant < 0) {
    return { ...proposal, eligible: false, rejectionReason: 'orientation-reversing' };
  }

  const deformationMagnitude = residualDeformationMagnitude(residualMovingToFixed, size);
  if (deformationMagnitude > MAX_RESIDUAL_DISPLACEMENT_FRACTION) {
    return {
      ...proposal,
      eligible: false,
      rejectionReason: 'excessive-displacement',
      deformationMagnitude,
    };
  }

  return {
    ...proposal,
    totalMovingToFixed: composeResidualWithWarpAtSize(residualMovingToFixed, winningWarp, size),
    deformationMagnitude,
  };
}

export function selectFinalAffineProposal(options: {
  normalizedReference: Float32Array;
  movingPixels: Float32Array;
  size: number;
  scales: readonly number[];
  winningWarp: WarpTransform;
  fixedExclusionRect?: ExclusionMask;
  optimizerProposals: readonly OptimizerFinalAffineProposal[];
}): FinalAffineSelection {
  const { normalizedReference, movingPixels, size, scales, winningWarp, fixedExclusionRect, optimizerProposals } =
    options;
  if (!Number.isInteger(size) || size <= 0) {
    throw new Error('selectFinalAffineProposal: size must be a positive integer');
  }
  assertSquare(normalizedReference, size, 'selectFinalAffineProposal normalizedReference');
  assertSquare(movingPixels, size, 'selectFinalAffineProposal movingPixels');
  validateOptimizerProposals(optimizerProposals);

  const scaleSizes = [...new Set(scales.map(Math.round).filter((value) => value > 0 && value <= size))].sort(
    (a, b) => b - a,
  );
  if (scaleSizes.length === 0) scaleSizes.push(size);
  // MIND uses a fixed one-pixel patch plus one-pixel offset; constructing an entire unused
  // reference pyramid solely to rediscover its two-pixel footprint was unnecessary.
  const maximumMindFootprintAtFullResolution = Math.max(...scaleSizes.map((scale) => (2 * size) / scale));
  const fixedScoringExclusionRect = fixedExclusionRect
    ? expandExclusionRect(fixedExclusionRect, MAX_RESIDUAL_DISPLACEMENT_FRACTION)
    : undefined;
  const sourceExclusionRect = fixedExclusionRect
    ? mapFixedExclusionToMovingBounds(
        fixedExclusionRect,
        winningWarp,
        size,
        MAX_RESIDUAL_DISPLACEMENT_FRACTION * size + maximumMindFootprintAtFullResolution,
      )
    : undefined;
  const preparedFixedReference = preparePerceptualReference(normalizedReference, size, {
    scales: scaleSizes,
    exclusionRect: fixedScoringExclusionRect,
  });
  const normalizedMoving = normalizePerceptualSource(movingPixels, size, {
    exclusionRect: sourceExclusionRect,
  });
  const preparedMovingSource = preparePerceptualReference(normalizedMoving, size, {
    scales: scaleSizes,
    exclusionRect: sourceExclusionRect,
  });
  const scoringScratch = createPerceptualScoringScratch();

  const seedResidual = createIdentityResidual();
  const seed: GeometricallyAdmissibleProposal = {
    kind: 'seed-only',
    residualMovingToFixed: seedResidual,
    totalMovingToFixed: composeResidualWithWarpAtSize(seedResidual, winningWarp, size),
    deformationMagnitude: 0,
  };
  const validatedOptimizers = optimizerProposals.map((proposal) => validateGeometry(proposal, winningWarp, size));

  const scoreProposal = (proposal: GeometricallyAdmissibleProposal): ScoredFinalAffineProposal => {
    const forwardWarp = warpGrayscaleAffineWithValidity(
      normalizedMoving,
      size,
      centeredWarp(proposal.totalMovingToFixed, size),
    );
    const forward = scoreAlignedCandidate(
      preparedFixedReference,
      forwardWarp.pixels,
      forwardWarp.validity,
      size,
      scoringScratch,
    );
    const mindScore = average(forward.perScale.map((scale) => scale.mind));
    const ngfScore = average(forward.perScale.map((scale) => scale.ngf));
    const structuralScore = (mindScore + ngfScore) / 2;

    const fixedToMoving = invertStandardAffine2D(proposal.totalMovingToFixed);
    const reverseWarp = warpGrayscaleAffineWithValidity(normalizedReference, size, centeredWarp(fixedToMoving, size));
    const sourceCoverage = scoreAlignedCandidate(
      preparedMovingSource,
      reverseWarp.pixels,
      reverseWarp.validity,
      size,
      scoringScratch,
    ).coverage;

    return {
      ...proposal,
      eligible: true,
      components: { forward, sourceCoverage },
      mindScore,
      ngfScore,
      structuralScore,
      bidirectionalCoverage: Math.min(forward.coverage, sourceCoverage),
    };
  };

  const scoredSeed = scoreProposal(seed);
  const proposals: Array<ScoredFinalAffineProposal | RejectedFinalAffineProposal> = [scoredSeed];
  // Forward structural scores already retain fixed-domain FOV loss in their denominator. Reject
  // only additional source-domain loss, which is the signature of hiding moving anatomy. One
  // full-resolution pixel absorbs rasterization differences between the two directional domains.
  const excessSourceCoverageLossTolerance = 1 / size + FINAL_AFFINE_SCORE_EPSILON;
  for (const proposal of validatedOptimizers) {
    if ('rejectionReason' in proposal) {
      proposals.push(proposal);
      continue;
    }
    const scored = scoreProposal(proposal);
    const sourceCoverageLoss = scoredSeed.components.sourceCoverage - scored.components.sourceCoverage;
    const forwardCoverageLoss = scoredSeed.components.forward.coverage - scored.components.forward.coverage;
    if (sourceCoverageLoss - forwardCoverageLoss > excessSourceCoverageLossTolerance) {
      proposals.push({
        kind: proposal.kind,
        residualMovingToFixed: scored.residualMovingToFixed,
        eligible: false,
        rejectionReason: 'coverage-regression',
        mindScore: scored.mindScore,
        ngfScore: scored.ngfScore,
        structuralScore: scored.structuralScore,
        bidirectionalCoverage: scored.bidirectionalCoverage,
        deformationMagnitude: scored.deformationMagnitude,
      });
      continue;
    }
    proposals.push(scored);
  }

  const eligible = proposals.filter((proposal): proposal is ScoredFinalAffineProposal => proposal.eligible);
  const maximumScore = Math.max(...eligible.map((proposal) => proposal.structuralScore));
  const contenders = eligible.filter(
    (proposal) => maximumScore - proposal.structuralScore <= FINAL_AFFINE_SCORE_EPSILON,
  );
  const selected = [...contenders].sort(
    (a, b) => a.deformationMagnitude - b.deformationMagnitude || KIND_ORDER[a.kind] - KIND_ORDER[b.kind],
  )[0];
  if (!selected) {
    throw new Error('selectFinalAffineProposal invariant: no eligible final affine proposal');
  }
  if (selected.structuralScore < scoredSeed.structuralScore - FINAL_AFFINE_SCORE_EPSILON) {
    throw new Error('selectFinalAffineProposal invariant: selected proposal scores below seed-only');
  }

  return {
    proposals,
    selected,
    fixedScoringExclusionRect,
    sourceExclusionRect,
  };
}
