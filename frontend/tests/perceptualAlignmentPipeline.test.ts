import { describe, expect, test } from 'vitest';
import { affineAboutOriginToStandard, composeStandardAffine2D } from '../src/utils/affine2d';
import { correctedWarpAtSize, type GridSeedTransform } from '../src/utils/alignmentTransform';
import {
  buildSoftForegroundSupportSquare,
  buildStructuralPhaseImageSquare,
  erodeFractionalSupportSquare,
  inpaintExclusionRectSquare,
} from '../src/utils/imageFeatures';
import {
  estimatePreparedPhaseCorrection,
  preparePhaseCorrectionReference,
  type PhaseCorrection,
} from '../src/utils/phaseCorrelation';
import {
  choosePerceptualWinner,
  normalizePerceptualSource,
  preparePerceptualReference,
  rankFixedCandidateSet,
  scoreAlignedCandidate,
} from '../src/utils/perceptualSliceSimilarity';
import { warpGrayscaleAffineWithValidity } from '../src/utils/warpAffine';
import {
  makeTissueLabelPhantom,
  NONFUNCTIONAL_CONTRAST,
  REFERENCE_CONTRAST,
  relocateInternalStructures,
  renderMovingFromFixed,
  renderTissueContrast,
  translateZeroFilled,
} from './helpers/alignmentSynthetic';

const PHASE_FFT_SIZE = 256;
const PHASE_MAX_CORRECTION_PX = 16;

function neutralPhase(size: number): PhaseCorrection {
  return {
    correctionX: 0,
    correctionY: 0,
    peak: 0,
    peakToSidelobeRatio: 0,
    sampleGridSize: size,
    fftSize: PHASE_FFT_SIZE,
    pixelsUsed: size * size,
  };
}

function preparePipelineReference(referenceSource: Float32Array, size: number) {
  const normalized = normalizePerceptualSource(referenceSource, size);
  const structural = buildStructuralPhaseImageSquare(
    inpaintExclusionRectSquare(normalized, size, undefined, 6).pixels,
    size,
  );
  const support = buildSoftForegroundSupportSquare(normalized, size);
  return {
    phase: preparePhaseCorrectionReference(structural, size, {
      fftSize: PHASE_FFT_SIZE,
      maxCorrectionPx: PHASE_MAX_CORRECTION_PX,
      support,
    }),
    perceptual: preparePerceptualReference(normalized, size, {
      scales: [size, size / 2],
    }),
  };
}

function runProductionCandidatePath(
  prepared: ReturnType<typeof preparePipelineReference>,
  source: Float32Array,
  size: number,
  seed: GridSeedTransform,
  index: number,
) {
  const normalizedSource = normalizePerceptualSource(source, size);
  const inpaintedPhaseSource = inpaintExclusionRectSquare(normalizedSource, size, undefined, 6).pixels;
  const structuralPhaseSource = buildStructuralPhaseImageSquare(inpaintedPhaseSource, size);
  const sourceSupport = buildSoftForegroundSupportSquare(normalizedSource, size);
  const seedWarp = correctedWarpAtSize(seed, neutralPhase(size), size);
  const warpedStructuralPhase = warpGrayscaleAffineWithValidity(structuralPhaseSource, size, seedWarp);
  const warpedSupport = warpGrayscaleAffineWithValidity(sourceSupport, size, seedWarp);
  const erodedGeometricValidity = erodeFractionalSupportSquare(warpedStructuralPhase.validity, size, 1);
  const phaseMovingPixels = new Float32Array(source.length);
  const phaseSupport = new Float32Array(source.length);
  for (let pixelIndex = 0; pixelIndex < source.length; pixelIndex++) {
    const structuralValidity = warpedStructuralPhase.validity[pixelIndex] ?? 0;
    const supportValidity = warpedSupport.validity[pixelIndex] ?? 0;
    phaseMovingPixels[pixelIndex] =
      structuralValidity > 1e-6 ? (warpedStructuralPhase.pixels[pixelIndex] ?? 0) / structuralValidity : 0;
    const conditionalSupport = supportValidity > 1e-6 ? (warpedSupport.pixels[pixelIndex] ?? 0) / supportValidity : 0;
    phaseSupport[pixelIndex] = conditionalSupport * (erodedGeometricValidity[pixelIndex] ?? 0);
  }

  const phase = estimatePreparedPhaseCorrection(prepared.phase, phaseMovingPixels, {
    support: phaseSupport,
  });
  const correctedWarp = correctedWarpAtSize(seed, phase, size);
  let originalPixelWarps = 0;
  originalPixelWarps++;
  const aligned = warpGrayscaleAffineWithValidity(normalizedSource, size, correctedWarp);
  const components = scoreAlignedCandidate(prepared.perceptual, aligned.pixels, aligned.validity, size);
  return { index, phase, components, originalPixelWarps };
}

describe('perceptual alignment production path', () => {
  test('structural phase correction lets the nonfunctional-contrast true slice beat a centered histogram distractor', () => {
    const size = 64;
    const dx = 7;
    const dy = -5;
    const labels = makeTissueLabelPhantom(size);
    const reference = renderTissueContrast(labels, REFERENCE_CONTRAST);
    const trueSource = translateZeroFilled(renderTissueContrast(labels, NONFUNCTIONAL_CONTRAST), size, dx, dy);
    const distractorSource = renderTissueContrast(relocateInternalStructures(labels, size), REFERENCE_CONTRAST);
    const seedIndex = 5;
    const seed: GridSeedTransform = {
      A: { m00: 1, m01: 0, m10: 0, m11: 1 },
      translatePx: { x: 0, y: 0 },
      gridSize: size,
    };
    const prepared = preparePipelineReference(reference, size);

    const trueCandidate = runProductionCandidatePath(prepared, trueSource, size, seed, 4);
    const distractor = runProductionCandidatePath(prepared, distractorSource, size, seed, seedIndex);
    const ranked = rankFixedCandidateSet([trueCandidate, distractor], seedIndex);
    const rankedTrue = ranked.find((candidate) => candidate.index === trueCandidate.index);
    const rankedDistractor = ranked.find((candidate) => candidate.index === distractor.index);
    const winner = choosePerceptualWinner(ranked, seedIndex);

    expect(trueCandidate.phase.correctionX).toBeCloseTo(-dx, 0);
    expect(trueCandidate.phase.correctionY).toBeCloseTo(-dy, 0);
    expect(trueCandidate.originalPixelWarps).toBe(1);
    expect(distractor.originalPixelWarps).toBe(1);
    expect(winner.index).toBe(trueCandidate.index);
    expect(rankedTrue?.structuralRank).toBeGreaterThan(rankedDistractor?.structuralRank ?? 0);
  });

  test('recovers a reference-grid residual after a nonidentity rigid seed and still selects true structure', () => {
    const size = 128;
    const labels = makeTissueLabelPhantom(size);
    const reference = renderTissueContrast(labels, REFERENCE_CONTRAST);
    const trueAnatomy = renderTissueContrast(labels, NONFUNCTIONAL_CONTRAST);
    const distractorAnatomy = renderTissueContrast(relocateInternalStructures(labels, size), REFERENCE_CONTRAST);
    const angleRadians = (5 * Math.PI) / 180;
    const A = {
      m00: Math.cos(angleRadians),
      m01: -Math.sin(angleRadians),
      m10: Math.sin(angleRadians),
      m11: Math.cos(angleRadians),
    };
    const seedTranslation = { x: 3, y: -2 };
    const center = { x: (size - 1) / 2, y: (size - 1) / 2 };
    const seedStandard = affineAboutOriginToStandard({
      A,
      origin: center,
      t: seedTranslation,
    });
    const expectedCorrection = { x: 5, y: -4 };
    const total = composeStandardAffine2D(
      {
        A: { m00: 1, m01: 0, m10: 0, m11: 1 },
        b: expectedCorrection,
      },
      seedStandard,
    );
    const trueSource = renderMovingFromFixed(trueAnatomy, size, total);
    const distractorSource = renderMovingFromFixed(distractorAnatomy, size, seedStandard);
    const seedIndex = 10;
    const seed: GridSeedTransform = {
      A,
      translatePx: seedTranslation,
      gridSize: size,
    };
    const prepared = preparePipelineReference(reference, size);

    const trueCandidate = runProductionCandidatePath(prepared, trueSource, size, seed, 11);
    const distractor = runProductionCandidatePath(prepared, distractorSource, size, seed, seedIndex);
    const ranked = rankFixedCandidateSet([trueCandidate, distractor], seedIndex);
    const rankedTrue = ranked.find((candidate) => candidate.index === trueCandidate.index);
    const rankedDistractor = ranked.find((candidate) => candidate.index === distractor.index);
    const winner = choosePerceptualWinner(ranked, seedIndex);

    expect(trueCandidate.phase.correctionX).toBeCloseTo(expectedCorrection.x, 0);
    expect(trueCandidate.phase.correctionY).toBeCloseTo(expectedCorrection.y, 0);
    expect(trueCandidate.originalPixelWarps).toBe(1);
    expect(distractor.originalPixelWarps).toBe(1);
    expect(winner.index).toBe(trueCandidate.index);
    expect(rankedTrue?.structuralRank).toBeGreaterThan(rankedDistractor?.structuralRank ?? 0);
  });
});
