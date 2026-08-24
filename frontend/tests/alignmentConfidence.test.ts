import { describe, expect, it } from 'vitest';
import { assessSliceAlignmentEvidence } from '../src/utils/alignmentConfidence';
import { rankFixedCandidateSet, type PerceptualScaleComponents } from '../src/utils/perceptualSliceSimilarity';

function candidate(index: number, mind: number, options?: { coverage?: number; ngf?: number }) {
  const ngf = options?.ngf ?? 0.5;
  const scale: PerceptualScaleComponents = {
    size: 64,
    contrastStructure: 0.5,
    lncc: 0.5,
    ngf,
    rawNgf: 2 * ngf - 1,
    mind,
    rawMindDistance: 1 - mind,
    lowerQuartile: 0.5,
  };
  return { index, components: { coverage: options?.coverage ?? 1, perScale: [scale] } };
}

const texturedReference = Float32Array.from({ length: 256 * 256 }, (_, index) => (index % 251) / 250);

describe('absolute anatomical alignment confidence', () => {
  it('rejects a 50-percentile rank lead when fixed-domain structure differs by only two millionths', () => {
    const ranked = rankFixedCandidateSet([candidate(8, 0.500001), candidate(16, 0.500003)], 8);
    expect(ranked[1]!.perceptualRank - ranked[0]!.perceptualRank).toBeCloseTo(0.5);

    const evidence = assessSliceAlignmentEvidence({
      winner: ranked[1]!,
      candidates: ranked,
      normalizedReference: texturedReference,
      imageSize: 256,
    });

    expect(evidence.outcome).toBe('ambiguous');
    expect(evidence.runnerUpGap).toBeCloseTo(0.000001);
    expect(evidence.runnerUpGap).toBeLessThan(evidence.minimumDistinguishableGap);
  });

  it('accepts clearly distinguishable fixed-domain structural anatomy', () => {
    const ranked = rankFixedCandidateSet([candidate(8, 0.55), candidate(16, 0.82)], 8);
    const evidence = assessSliceAlignmentEvidence({
      winner: ranked[1]!,
      candidates: ranked,
      normalizedReference: texturedReference,
      imageSize: 256,
    });

    expect(evidence.outcome).toBe('aligned');
    expect(evidence.runnerUpGap).toBeCloseTo(0.135);
  });

  it('rejects insufficient supported coverage before comparing deceptive appearance ranks', () => {
    const ranked = rankFixedCandidateSet([candidate(4, 0.55), candidate(8, 0.95, { coverage: 0.54 })], 4);
    expect(
      assessSliceAlignmentEvidence({
        winner: ranked[1]!,
        candidates: ranked,
        normalizedReference: texturedReference,
        imageSize: 256,
      }).outcome,
    ).toBe('insufficient-overlap');
  });

  it('rejects a flat reference even when one candidate receives a strong relative rank', () => {
    const ranked = rankFixedCandidateSet([candidate(2, 0.5), candidate(8, 0.9)], 2);
    expect(
      assessSliceAlignmentEvidence({
        winner: ranked[1]!,
        candidates: ranked,
        normalizedReference: new Float32Array(256 * 256).fill(0.5),
        imageSize: 256,
      }).outcome,
    ).toBe('ambiguous');
  });

  it('rejects a single flat candidate without boundary evidence', () => {
    const ranked = rankFixedCandidateSet([candidate(4, 0.9)], 4);
    expect(
      assessSliceAlignmentEvidence({
        winner: ranked[0]!,
        candidates: ranked,
        normalizedReference: texturedReference,
        imageSize: 256,
      }).outcome,
    ).toBe('ambiguous');
  });

  it('does not count an excluded changing lesion as informative stable reference anatomy', () => {
    const ranked = rankFixedCandidateSet([candidate(2, 0.5), candidate(8, 0.9)], 2);
    const reference = new Float32Array(256 * 256).fill(0.5);
    for (let y = 100; y < 140; y++) {
      for (let x = 100; x < 140; x++) reference[y * 256 + x] = 100;
    }

    const evidence = assessSliceAlignmentEvidence({
      winner: ranked[1]!,
      candidates: ranked,
      normalizedReference: reference,
      imageSize: 256,
      exclusionMask: { x: 100 / 256, y: 100 / 256, width: 40 / 256, height: 40 / 256 },
    });

    expect(evidence.referenceIntensityVariance).toBe(0);
    expect(evidence.outcome).toBe('ambiguous');
  });

  it('does not treat neighboring sub-two-millimeter slices as independent rival anatomy', () => {
    const ranked = rankFixedCandidateSet([candidate(8, 0.8), candidate(9, 0.800002)], 8);
    expect(
      assessSliceAlignmentEvidence({
        winner: ranked[1]!,
        candidates: ranked,
        normalizedReference: texturedReference,
        imageSize: 256,
        sliceSpacingMm: 1,
      }).outcome,
    ).toBe('aligned');
  });
});
