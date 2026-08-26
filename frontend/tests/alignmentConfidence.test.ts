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

function assessCandidateEvidence(
  candidates: ReturnType<typeof rankFixedCandidateSet>,
  overrides: Partial<Parameters<typeof assessSliceAlignmentEvidence>[0]> = {},
) {
  return assessSliceAlignmentEvidence({
    winner: candidates[candidates.length - 1]!,
    candidates,
    normalizedReference: texturedReference,
    imageSize: 256,
    ...overrides,
  });
}

describe('absolute anatomical alignment confidence', () => {
  it('accepts the best structurally valid candidate even when its lead is below the numerical floor', () => {
    const ranked = rankFixedCandidateSet([candidate(8, 0.500001), candidate(16, 0.500003)], 8);
    expect(ranked[1]!.perceptualRank - ranked[0]!.perceptualRank).toBeCloseTo(0.5);

    const evidence = assessCandidateEvidence(ranked);

    expect(evidence.outcome).toBe('aligned');
    expect(evidence.runnerUpGap).toBeCloseTo(0.000001);
    expect(evidence.runnerUpGap).toBeLessThan(evidence.minimumDistinguishableGap);
  });

  it('accepts clearly distinguishable fixed-domain structural anatomy', () => {
    const ranked = rankFixedCandidateSet([candidate(8, 0.55), candidate(16, 0.82)], 8);
    const evidence = assessCandidateEvidence(ranked);

    expect(evidence.outcome).toBe('aligned');
    expect(evidence.runnerUpGap).toBeCloseTo(0.135);
  });

  it('rejects almost unrelated anatomy even when its physically distinct rival is marginally worse', () => {
    const ranked = rankFixedCandidateSet([candidate(0, 0.02, { ngf: 0.02 }), candidate(4, 0.0195, { ngf: 0.0195 })], 0);
    const evidence = assessCandidateEvidence(ranked, { winner: ranked[0]!, sliceSpacingMm: 1 });

    expect(evidence.structuralScore).toBeCloseTo(0.02);
    expect(evidence.runnerUpGap).toBeGreaterThan(evidence.minimumDistinguishableGap);
    expect(evidence.outcome).toBe('ambiguous');
  });

  it('rejects insufficient supported coverage before comparing deceptive appearance ranks', () => {
    const ranked = rankFixedCandidateSet([candidate(4, 0.55), candidate(8, 0.95, { coverage: 0.54 })], 4);
    expect(assessCandidateEvidence(ranked).outcome).toBe('insufficient-overlap');
  });

  it('rejects a flat reference even when one candidate receives a strong relative rank', () => {
    const ranked = rankFixedCandidateSet([candidate(2, 0.5), candidate(8, 0.9)], 2);
    expect(
      assessCandidateEvidence(ranked, { normalizedReference: new Float32Array(256 * 256).fill(0.5) }).outcome,
    ).toBe('ambiguous');
  });

  it('rejects a single flat candidate without boundary evidence', () => {
    const ranked = rankFixedCandidateSet([candidate(4, 0.9)], 4);
    expect(assessCandidateEvidence(ranked).outcome).toBe('ambiguous');
  });

  it('does not count an excluded changing lesion as informative stable reference anatomy', () => {
    const ranked = rankFixedCandidateSet([candidate(2, 0.5), candidate(8, 0.9)], 2);
    const reference = new Float32Array(256 * 256).fill(0.5);
    for (let y = 100; y < 140; y++) {
      for (let x = 100; x < 140; x++) reference[y * 256 + x] = 100;
    }

    const evidence = assessCandidateEvidence(ranked, {
      normalizedReference: reference,
      exclusionMask: { x: 100 / 256, y: 100 / 256, width: 40 / 256, height: 40 / 256 },
    });

    expect(evidence.referenceIntensityVariance).toBe(0);
    expect(evidence.outcome).toBe('ambiguous');
  });

  it('does not accept invalid padding as informative reference anatomy', () => {
    const ranked = rankFixedCandidateSet([candidate(2, 0.5), candidate(8, 0.9)], 2);
    const reference = new Float32Array(256 * 256).fill(0.5);
    const referenceValidity = new Uint8Array(reference.length).fill(1);
    for (let y = 100; y < 140; y++) {
      for (let x = 100; x < 140; x++) {
        reference[y * 256 + x] = 100;
        referenceValidity[y * 256 + x] = 0;
      }
    }

    const evidence = assessCandidateEvidence(ranked, {
      normalizedReference: reference,
      referenceValidity,
    });

    expect(evidence.referenceIntensityVariance).toBe(0);
    expect(evidence.outcome).toBe('ambiguous');
  });

  it('does not treat neighboring sub-two-millimeter slices as independent rival anatomy', () => {
    const ranked = rankFixedCandidateSet([candidate(8, 0.8), candidate(9, 0.800002)], 8);
    expect(assessCandidateEvidence(ranked, { sliceSpacingMm: 1 }).outcome).toBe('aligned');
  });
});
