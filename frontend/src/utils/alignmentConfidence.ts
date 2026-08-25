import type { PerceptualCandidate, PerceptualComponents, RankedPerceptualCandidate } from './perceptualSliceSimilarity';
import type { ExclusionMask } from '../types/api';

export type SliceAlignmentEvidence = {
  outcome: 'aligned' | 'ambiguous' | 'insufficient-overlap';
  structuralScore: number;
  runnerUpGap: number;
  minimumDistinguishableGap: number;
  referenceIntensityVariance: number;
};

const MINIMUM_SUPPORTED_COVERAGE = 0.55;
const MINIMUM_REFERENCE_INTENSITY_VARIANCE = 1e-6;
const MINIMUM_ABSOLUTE_STRUCTURAL_AGREEMENT = 0.35;

function absoluteStructuralScore(components: PerceptualComponents): number {
  if (components.perScale.length === 0) return 0;
  return components.perScale.reduce((sum, scale) => sum + (scale.mind + scale.ngf) / 2, 0) / components.perScale.length;
}

function intensityVariance(
  pixels: Float32Array,
  imageSize: number,
  exclusionMask?: ExclusionMask,
  validity?: Float32Array | Uint8Array,
): { variance: number; supportedPixelCount: number } {
  if (validity && validity.length !== pixels.length) {
    throw new Error('Alignment confidence validity does not match reference image dimensions');
  }
  let supportedPixelCount = 0;
  let mean = 0;
  let squaredDeviation = 0;
  for (let index = 0; index < pixels.length; index++) {
    if (exclusionMask) {
      const x = ((index % imageSize) + 0.5) / imageSize;
      const y = (Math.floor(index / imageSize) + 0.5) / imageSize;
      if (
        x >= exclusionMask.x &&
        x < exclusionMask.x + exclusionMask.width &&
        y >= exclusionMask.y &&
        y < exclusionMask.y + exclusionMask.height
      ) {
        continue;
      }
    }
    const value = pixels[index]!;
    if (!Number.isFinite(value)) continue;
    const support = validity ? Math.max(0, Math.min(1, validity[index] ?? 0)) : 1;
    if (!(support > 0)) continue;
    supportedPixelCount += support;
    const difference = value - mean;
    mean += (difference * support) / supportedPixelCount;
    squaredDeviation += support * difference * (value - mean);
  }
  return {
    variance: supportedPixelCount > 1 ? squaredDeviation / (supportedPixelCount - 1) : 0,
    supportedPixelCount,
  };
}

/**
 * Percentile ranks order candidates but never constitute anatomical confidence: a two-millionths
 * descriptor difference can become a 50-percentile lead. Compare fixed-domain structural evidence
 * instead, and distinguish only slices separated by at least two acquired millimeters.
 *
 * The distinguishability floor is diagnostic, not a reason to discard the best valid candidate.
 */
export function assessSliceAlignmentEvidence<T extends PerceptualCandidate>(options: {
  winner: RankedPerceptualCandidate<T>;
  candidates: readonly RankedPerceptualCandidate<T>[];
  normalizedReference: Float32Array;
  referenceValidity?: Float32Array | Uint8Array;
  imageSize: number;
  sliceSpacingMm?: number;
  exclusionMask?: ExclusionMask;
}): SliceAlignmentEvidence {
  const { winner, candidates, normalizedReference, imageSize } = options;
  const structuralScore = absoluteStructuralScore(winner.components);
  const { variance: referenceIntensityVariance, supportedPixelCount } = intensityVariance(
    normalizedReference,
    imageSize,
    options.exclusionMask,
    options.referenceValidity,
  );
  const coverage = Math.max(0, Math.min(1, winner.components.coverage));
  const minimumDistinguishableGap = Math.max(1e-4, 0.05 / Math.sqrt(Math.max(1, coverage * supportedPixelCount)));
  const sliceSpacingMm = options.sliceSpacingMm && options.sliceSpacingMm > 0 ? options.sliceSpacingMm : 1;
  const distinctSliceDistance = Math.max(1, Math.ceil(2 / sliceSpacingMm));
  const physicallyDistinctRivals = candidates.filter(
    (candidate) => Math.abs(candidate.index - winner.index) >= distinctSliceDistance,
  );
  const runnerUpGap =
    physicallyDistinctRivals.length > 0
      ? structuralScore -
        Math.max(...physicallyDistinctRivals.map((candidate) => absoluteStructuralScore(candidate.components)))
      : structuralScore;

  const hasStructuralEvidence =
    candidates.length === 1
      ? winner.components.perScale.some((scale) => (scale.rawNgf ?? 2 * scale.ngf - 1) > 0.02)
      : winner.mindActive || winner.boundaryActive;
  const outcome =
    coverage < MINIMUM_SUPPORTED_COVERAGE
      ? 'insufficient-overlap'
      : structuralScore < MINIMUM_ABSOLUTE_STRUCTURAL_AGREEMENT ||
          referenceIntensityVariance <= MINIMUM_REFERENCE_INTENSITY_VARIANCE ||
          !hasStructuralEvidence
        ? 'ambiguous'
        : 'aligned';

  return {
    outcome,
    structuralScore,
    runnerUpGap,
    minimumDistinguishableGap,
    referenceIntensityVariance,
  };
}
