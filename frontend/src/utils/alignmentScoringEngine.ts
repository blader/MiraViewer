import type { ExclusionMask } from '../types/api';
import {
  correctedWarpAtSize,
  expandExclusionRect,
  mapFixedExclusionToMovingBounds,
  type GridSeedTransform,
  type WarpTransform,
} from './alignmentTransform';
import {
  buildSoftForegroundSupportSquare,
  buildStructuralPhaseImageSquare,
  erodeFractionalSupportSquare,
  inpaintExclusionRectSquare,
} from './imageFeatures';
import {
  createPerceptualScoringScratch,
  normalizePerceptualSource,
  preparePerceptualReference,
  scoreAlignedCandidate,
  type PerceptualComponents,
} from './perceptualSliceSimilarity';
import {
  estimatePreparedPhaseCorrection,
  preparePhaseCorrectionReference,
  type PhaseCorrection,
} from './phaseCorrelation';
import { warpGrayscaleAffineWithValidity } from './warpAffine';
import {
  selectFinalAffineProposal,
  type FinalAffineSelection,
  type OptimizerFinalAffineProposal,
} from './structuralAffineSelection';

export type AlignmentScoringConfiguration = {
  referenceFinePixels: Float32Array;
  referenceCoarsePixels: Float32Array;
  fineSize: number;
  coarseSize: number;
  fineScales: number[];
  coarseScales: number[];
  phaseFftSize: number;
  phaseMaxCorrectionPx: number;
  exclusionMask?: ExclusionMask;
};

export type AlignmentScoredCandidate = {
  phase: PhaseCorrection;
  components: PerceptualComponents;
};

export type AlignmentFinalScoringInput = {
  movingPixels: Float32Array;
  winningWarp: WarpTransform;
  fixedExclusionRect?: ExclusionMask;
  optimizerProposals: readonly OptimizerFinalAffineProposal[];
};

/** Pure, reusable owner of candidate pyramids, reference descriptors, FFT state, and MIND scratch. */
export class AlignmentScoringEngine {
  private readonly config: AlignmentScoringConfiguration;
  private readonly scratch = createPerceptualScoringScratch();
  private readonly coarseReference;
  private readonly fineReference;
  private readonly phaseReference;
  private readonly normalizedFine: Float32Array;

  constructor(config: AlignmentScoringConfiguration) {
    this.config = config;
    const { referenceFinePixels, referenceCoarsePixels, fineSize, coarseSize, exclusionMask } = config;
    const coarseExclusion = exclusionMask
      ? expandExclusionRect(exclusionMask, config.phaseMaxCorrectionPx / coarseSize)
      : undefined;
    const normalizedCoarse = normalizePerceptualSource(referenceCoarsePixels, coarseSize, {
      exclusionRect: coarseExclusion,
    });
    const normalizedFine = normalizePerceptualSource(referenceFinePixels, fineSize, {
      exclusionRect: exclusionMask ? expandExclusionRect(exclusionMask, 3 / fineSize) : undefined,
    });
    this.normalizedFine = normalizedFine;

    this.coarseReference = preparePerceptualReference(normalizedCoarse, coarseSize, {
      scales: config.coarseScales,
      exclusionRect: exclusionMask,
    });
    this.fineReference = preparePerceptualReference(normalizedFine, fineSize, {
      scales: config.fineScales,
      exclusionRect: exclusionMask,
    });
    const referenceSupport = buildSoftForegroundSupportSquare(normalizedCoarse, coarseSize);
    const referenceStructure = buildStructuralPhaseImageSquare(
      inpaintExclusionRectSquare(normalizedCoarse, coarseSize, coarseExclusion, 6).pixels,
      coarseSize,
    );
    this.phaseReference = preparePhaseCorrectionReference(referenceStructure, coarseSize, {
      fftSize: config.phaseFftSize,
      maxCorrectionPx: config.phaseMaxCorrectionPx,
      support: referenceSupport,
    });
  }

  scoreCoarse(pixels: Float32Array, seed: GridSeedTransform): AlignmentScoredCandidate {
    const { coarseSize, phaseFftSize, phaseMaxCorrectionPx, exclusionMask } = this.config;
    const initialWarp = correctedWarpAtSize(
      seed,
      { correctionX: 0, correctionY: 0, sampleGridSize: coarseSize, fftSize: phaseFftSize },
      coarseSize,
    );
    const sourceExclusion = exclusionMask
      ? mapFixedExclusionToMovingBounds(exclusionMask, initialWarp, coarseSize, phaseMaxCorrectionPx)
      : undefined;
    const normalized = normalizePerceptualSource(pixels, coarseSize, { exclusionRect: sourceExclusion });
    const inpainted = inpaintExclusionRectSquare(normalized, coarseSize, sourceExclusion, 6).pixels;
    const sourceStructure = buildStructuralPhaseImageSquare(inpainted, coarseSize);
    const warpedStructure = warpGrayscaleAffineWithValidity(sourceStructure, coarseSize, initialWarp);
    const sourceSupport = buildSoftForegroundSupportSquare(normalized, coarseSize);
    const warpedSupport = warpGrayscaleAffineWithValidity(sourceSupport, coarseSize, initialWarp);
    const erodedValidity = erodeFractionalSupportSquare(warpedStructure.validity, coarseSize, 1);
    const phasePixels = new Float32Array(warpedStructure.pixels.length);
    const phaseSupport = new Float32Array(phasePixels.length);

    for (let index = 0; index < phasePixels.length; index++) {
      const structureValidity = warpedStructure.validity[index] ?? 0;
      const supportValidity = warpedSupport.validity[index] ?? 0;
      phasePixels[index] = structureValidity > 1e-6 ? (warpedStructure.pixels[index] ?? 0) / structureValidity : 0;
      const support = supportValidity > 1e-6 ? (warpedSupport.pixels[index] ?? 0) / supportValidity : 0;
      phaseSupport[index] = support * (erodedValidity[index] ?? 0);
    }

    const phase = estimatePreparedPhaseCorrection(this.phaseReference, phasePixels, { support: phaseSupport });
    const correctedWarp = correctedWarpAtSize(seed, phase, coarseSize);
    const aligned = warpGrayscaleAffineWithValidity(normalized, coarseSize, correctedWarp);
    return {
      phase,
      components: scoreAlignedCandidate(
        this.coarseReference,
        aligned.pixels,
        aligned.validity,
        coarseSize,
        this.scratch,
      ),
    };
  }

  scoreFine(pixels: Float32Array, seed: GridSeedTransform, phase: PhaseCorrection): AlignmentScoredCandidate {
    const { fineSize, exclusionMask } = this.config;
    const warp = correctedWarpAtSize(seed, phase, fineSize);
    const sourceExclusion = exclusionMask
      ? mapFixedExclusionToMovingBounds(exclusionMask, warp, fineSize, 3)
      : undefined;
    const normalized = normalizePerceptualSource(pixels, fineSize, { exclusionRect: sourceExclusion });
    const aligned = warpGrayscaleAffineWithValidity(normalized, fineSize, warp);
    return {
      phase,
      components: scoreAlignedCandidate(this.fineReference, aligned.pixels, aligned.validity, fineSize, this.scratch),
    };
  }

  scoreFinal(input: AlignmentFinalScoringInput): FinalAffineSelection {
    return selectFinalAffineProposal({
      ...input,
      normalizedReference: this.normalizedFine,
      size: this.config.fineSize,
      scales: this.config.fineScales,
    });
  }
}
