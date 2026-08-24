import { describe, expect, test } from 'vitest';
import type { StandardAffine2D } from '../src/utils/affine2d';
import { normalizePerceptualSource } from '../src/utils/perceptualSliceSimilarity';
import {
  selectFinalAffineProposal,
  type FinalAffineProposalKind,
  type OptimizerFinalAffineProposal,
  type RejectedFinalAffineProposal,
  type ScoredFinalAffineProposal,
} from '../src/utils/structuralAffineSelection';
import {
  makeTissueLabelPhantom,
  NONFUNCTIONAL_CONTRAST,
  REFERENCE_CONTRAST,
  renderMovingFromFixed,
  renderTissueContrast,
} from './helpers/alignmentSynthetic';

const IDENTITY_RESIDUAL: StandardAffine2D = {
  A: { m00: 1, m01: 0, m10: 0, m11: 1 },
  b: { x: 0, y: 0 },
};

function requireScored(
  proposals: readonly (ScoredFinalAffineProposal | RejectedFinalAffineProposal)[],
  kind: FinalAffineProposalKind,
): ScoredFinalAffineProposal {
  const proposal = proposals.find((candidate) => candidate.kind === kind);
  expect(proposal?.eligible).toBe(true);
  if (!proposal?.eligible) throw new Error(`${kind} was not scored`);
  return proposal;
}

function baseOptions(size = 64) {
  const fixed = normalizePerceptualSource(renderTissueContrast(makeTissueLabelPhantom(size), REFERENCE_CONTRAST), size);
  return {
    normalizedReference: fixed,
    movingPixels: fixed,
    size,
    scales: [size, size / 2],
    winningWarp: {
      A: IDENTITY_RESIDUAL.A,
      translateX: 0,
      translateY: 0,
    },
  };
}

function makeInsetAnatomy(size: number, lesionValue: number): Float32Array {
  const pixels = new Float32Array(size * size);
  for (let y = 0; y < size; y++) {
    const normalizedY = (y + 0.5) / size;
    for (let x = 0; x < size; x++) {
      const normalizedX = (x + 0.5) / size;
      if (normalizedX < 0.25 || normalizedX >= 0.75 || normalizedY < 0.25 || normalizedY >= 0.75) {
        continue;
      }

      const index = y * size + x;
      pixels[index] = 0.25;
      if (normalizedX >= 0.3 && normalizedX < 0.48 && normalizedY >= 0.32 && normalizedY < 0.68) {
        pixels[index] = 0.7;
      }
      if (normalizedX >= 0.58 && normalizedX < 0.7 && normalizedY >= 0.38 && normalizedY < 0.55) {
        pixels[index] = 0.45;
      }
      if (normalizedX >= 0.39 && normalizedX < 0.62 && normalizedY >= 0.66 && normalizedY < 0.72) {
        pixels[index] = 0.9;
      }
      if (normalizedX >= 0.45 && normalizedX < 0.55 && normalizedY >= 0.45 && normalizedY < 0.55) {
        pixels[index] = lesionValue;
      }
    }
  }
  return pixels;
}

describe('selectFinalAffineProposal', () => {
  test.each(['structure-elastix', 'intensity-elastix'] as const)(
    'selects a correcting %s proposal under nonfunctional contrast',
    (correctiveKind) => {
      const size = 64;
      const labels = makeTissueLabelPhantom(size);
      const fixed = normalizePerceptualSource(renderTissueContrast(labels, REFERENCE_CONTRAST), size);
      const knownResidual: StandardAffine2D = {
        A: { m00: 1.03, m01: 0.035, m10: -0.02, m11: 0.98 },
        b: { x: 2.5, y: -1.75 },
      };
      const movingPixels = renderMovingFromFixed(
        renderTissueContrast(labels, NONFUNCTIONAL_CONTRAST),
        size,
        knownResidual,
      );
      const wrongKind = correctiveKind === 'structure-elastix' ? 'intensity-elastix' : 'structure-elastix';
      const selection = selectFinalAffineProposal({
        normalizedReference: fixed,
        movingPixels,
        size,
        scales: [64, 32],
        winningWarp: {
          A: IDENTITY_RESIDUAL.A,
          translateX: 0,
          translateY: 0,
        },
        optimizerProposals: [
          {
            kind: wrongKind,
            residualMovingToFixed: {
              A: { m00: 0.96, m01: -0.04, m10: 0.02, m11: 1.04 },
              b: { x: -3, y: 2 },
            },
          },
          { kind: correctiveKind, residualMovingToFixed: knownResidual },
        ],
      });

      expect(selection.selected.kind).toBe(correctiveKind);
    },
  );

  test('keeps seed-only when an affine proposal lowers structural agreement', () => {
    const options = baseOptions();
    const selection = selectFinalAffineProposal({
      ...options,
      optimizerProposals: [
        {
          kind: 'intensity-elastix',
          residualMovingToFixed: {
            A: IDENTITY_RESIDUAL.A,
            b: { x: 6, y: -5 },
          },
        },
      ],
    });
    const seed = requireScored(selection.proposals, 'seed-only');
    const intensity = requireScored(selection.proposals, 'intensity-elastix');

    expect(seed.structuralScore).toBeGreaterThan(intensity.structuralScore);
    expect(selection.selected.kind).toBe('seed-only');
  });

  test('excludes acquired padding from final affine normalization and paired structural coverage', () => {
    const size = 64;
    const validity = new Float32Array(size * size).fill(1);
    const source = renderTissueContrast(makeTissueLabelPhantom(size), REFERENCE_CONTRAST);
    for (let y = 26; y < 38; y++) {
      for (let x = 26; x < 38; x++) validity[y * size + x] = 0;
    }
    const normalizedReference = normalizePerceptualSource(source, size, { validity });
    const makeMoving = (padding: number) =>
      Float32Array.from(source, (value, index) => (validity[index] ? value : padding));
    const options = {
      normalizedReference,
      referenceValidity: validity,
      movingValidity: validity,
      size,
      scales: [64, 32],
      winningWarp: { A: IDENTITY_RESIDUAL.A, translateX: 0, translateY: 0 },
      optimizerProposals: [],
    };

    const low = selectFinalAffineProposal({ ...options, movingPixels: makeMoving(-20_000) });
    const high = selectFinalAffineProposal({ ...options, movingPixels: makeMoving(20_000) });

    expect(low.selected.structuralScore).toBeCloseTo(high.selected.structuralScore, 6);
    expect(low.selected.bidirectionalCoverage).toBeCloseTo(1, 6);
    expect(high.selected.bidirectionalCoverage).toBeCloseTo(1, 6);
  });

  test('source-domain coverage rejects zoom that hides anatomy with full forward validity', () => {
    const options = baseOptions();
    const selection = selectFinalAffineProposal({
      ...options,
      optimizerProposals: [
        {
          kind: 'structure-elastix',
          residualMovingToFixed: {
            A: { m00: 1.2, m01: 0, m10: 0, m11: 1.2 },
            b: { x: -6.3, y: -6.3 },
          },
        },
      ],
    });
    const seed = requireScored(selection.proposals, 'seed-only');
    const zoom = selection.proposals.find((proposal) => proposal.kind === 'structure-elastix');

    expect(zoom).toMatchObject({
      eligible: false,
      rejectionReason: 'coverage-regression',
    });
    if (!zoom || zoom.eligible) throw new Error('zoom proposal was not rejected');
    expect(zoom.bidirectionalCoverage).toBeLessThan(seed.bidirectionalCoverage);
    expect(zoom.mindScore).toBeTypeOf('number');
    expect(zoom.ngfScore).toBeTypeOf('number');
  });

  test.each([
    [
      'non-finite',
      {
        A: { ...IDENTITY_RESIDUAL.A, m00: Number.NaN },
        b: { x: 0, y: 0 },
      },
    ],
    ['singular', { A: { m00: 1, m01: 0, m10: 0, m11: 0 }, b: { x: 0, y: 0 } }],
    ['orientation-reversing', { A: { m00: -1, m01: 0, m10: 0, m11: 1 }, b: { x: 0, y: 0 } }],
    ['excessive-displacement', { A: { m00: 1, m01: 0.4, m10: 0, m11: 1 }, b: { x: 0, y: 0 } }],
  ] as const)('rejects %s optimizer residuals', (reason, residualMovingToFixed) => {
    const options = baseOptions();
    const selection = selectFinalAffineProposal({
      ...options,
      scales: [64],
      optimizerProposals: [{ kind: 'intensity-elastix', residualMovingToFixed }],
    });

    expect(selection.proposals.find((proposal) => !proposal.eligible)).toMatchObject({
      rejectionReason: reason,
    });
    expect(selection.selected.kind).toBe('seed-only');
  });

  test('exact structural ties retain the internally synthesized seed', () => {
    const options = baseOptions();
    const selection = selectFinalAffineProposal({
      ...options,
      scales: [64],
      optimizerProposals: [
        { kind: 'intensity-elastix', residualMovingToFixed: IDENTITY_RESIDUAL },
        { kind: 'structure-elastix', residualMovingToFixed: IDENTITY_RESIDUAL },
      ],
    });

    expect(selection.selected.kind).toBe('seed-only');
  });

  test('near-budget motion keeps excluded lesion changes out of every proposal score and domain', () => {
    const size = 128;
    const fixedExclusionRect = { x: 0.45, y: 0.45, width: 0.1, height: 0.1 };
    const fixedSource = makeInsetAnatomy(size, 0.8);
    const normalizedReference = normalizePerceptualSource(fixedSource, size, {
      exclusionRect: fixedExclusionRect,
    });
    const translatedProposal: OptimizerFinalAffineProposal = {
      kind: 'structure-elastix',
      residualMovingToFixed: {
        A: IDENTITY_RESIDUAL.A,
        b: { x: 0.124 * size, y: 0 },
      },
    };
    const commonOptions = {
      normalizedReference,
      size,
      scales: [128, 64],
      winningWarp: {
        A: IDENTITY_RESIDUAL.A,
        translateX: 0,
        translateY: 0,
      },
      fixedExclusionRect,
    };
    const lowLesion = selectFinalAffineProposal({
      ...commonOptions,
      movingPixels: makeInsetAnatomy(size, 0.05),
      optimizerProposals: [translatedProposal],
    });
    const highLesion = selectFinalAffineProposal({
      ...commonOptions,
      movingPixels: makeInsetAnatomy(size, 1),
      optimizerProposals: [translatedProposal],
    });
    const seedOnly = selectFinalAffineProposal({
      ...commonOptions,
      movingPixels: makeInsetAnatomy(size, 0.05),
      optimizerProposals: [],
    });
    const lowTranslated = requireScored(lowLesion.proposals, 'structure-elastix');
    const highTranslated = requireScored(highLesion.proposals, 'structure-elastix');
    const lowSeed = requireScored(lowLesion.proposals, 'seed-only');
    const onlySeed = requireScored(seedOnly.proposals, 'seed-only');

    expect(lowTranslated.eligible).toBe(true);
    expect(highTranslated.eligible).toBe(true);
    expect(lowLesion.fixedScoringExclusionRect?.x).toBeCloseTo(0.325, 12);
    expect(lowLesion.fixedScoringExclusionRect?.y).toBeCloseTo(0.325, 12);
    expect(lowLesion.fixedScoringExclusionRect?.width).toBeCloseTo(0.35, 12);
    expect(lowLesion.fixedScoringExclusionRect?.height).toBeCloseTo(0.35, 12);
    expect(lowLesion.sourceExclusionRect).toEqual(highLesion.sourceExclusionRect);
    expect(lowTranslated.mindScore).toBeCloseTo(highTranslated.mindScore, 6);
    expect(lowTranslated.ngfScore).toBeCloseTo(highTranslated.ngfScore, 6);
    expect(lowTranslated.structuralScore).toBeCloseTo(highTranslated.structuralScore, 6);
    expect(lowTranslated.bidirectionalCoverage).toBeCloseTo(highTranslated.bidirectionalCoverage, 6);
    expect(lowSeed.structuralScore).toBe(onlySeed.structuralScore);
  });

  test('rejects duplicate optimizer kinds before scoring', () => {
    const options = baseOptions();

    expect(() =>
      selectFinalAffineProposal({
        ...options,
        optimizerProposals: [
          { kind: 'structure-elastix', residualMovingToFixed: IDENTITY_RESIDUAL },
          { kind: 'structure-elastix', residualMovingToFixed: IDENTITY_RESIDUAL },
        ],
      }),
    ).toThrow(/at most one structure-elastix proposal/);
  });

  test('rejects a runtime attempt to supply seed-only', () => {
    const options = baseOptions();
    const forged = {
      kind: 'seed-only',
      residualMovingToFixed: IDENTITY_RESIDUAL,
    } as unknown as OptimizerFinalAffineProposal;

    expect(() =>
      selectFinalAffineProposal({
        ...options,
        optimizerProposals: [forged],
      }),
    ).toThrow(/optimizer proposal kind/);
  });

  test('synthesizes a fresh seed-only identity on every call', () => {
    const options = baseOptions();
    const first = selectFinalAffineProposal({ ...options, optimizerProposals: [] });
    first.selected.residualMovingToFixed.A.m00 = 2;
    first.selected.residualMovingToFixed.b.x = 9;

    const second = selectFinalAffineProposal({ ...options, optimizerProposals: [] });

    expect(second.selected.residualMovingToFixed).toEqual(IDENTITY_RESIDUAL);
  });

  test('validates square inputs and a positive integer size', () => {
    const options = baseOptions();

    expect(() =>
      selectFinalAffineProposal({
        ...options,
        normalizedReference: new Float32Array(3),
        optimizerProposals: [],
      }),
    ).toThrow(/normalizedReference/);
    expect(() =>
      selectFinalAffineProposal({
        ...options,
        movingPixels: new Float32Array(3),
        optimizerProposals: [],
      }),
    ).toThrow(/movingPixels/);
    expect(() =>
      selectFinalAffineProposal({
        ...options,
        size: 0,
        optimizerProposals: [],
      }),
    ).toThrow(/positive integer/);
  });
});
