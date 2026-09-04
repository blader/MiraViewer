import {
  AlignmentScoringEngine,
  type AlignmentScoredCandidate,
  type AlignmentFinalScoringInput,
  type AlignmentScoringConfiguration,
} from './alignmentScoringEngine';
import type { GridSeedTransform } from './alignmentTransform';
import type { PhaseCorrection } from './phaseCorrelation';
import { selectFinalAffineProposal } from './structuralAffineSelection';

type ScoringRequest =
  | { kind: 'initialize'; requestId: number; config: AlignmentScoringConfiguration }
  | { kind: 'coarse'; requestId: number; pixels: Float32Array; seed: GridSeedTransform; validity?: Float32Array }
  | {
      kind: 'fine';
      requestId: number;
      pixels: Float32Array;
      seed: GridSeedTransform;
      phase: PhaseCorrection;
      validity?: Float32Array;
    }
  | { kind: 'final'; requestId: number; input: AlignmentFinalScoringInput }
  | { kind: 'final-only'; requestId: number; input: Parameters<typeof selectFinalAffineProposal>[0] };

let engine: AlignmentScoringEngine | null = null;

self.onmessage = (event: MessageEvent<ScoringRequest>) => {
  const request = event.data;
  try {
    if (request.kind === 'initialize') {
      engine = new AlignmentScoringEngine(request.config);
      self.postMessage({ kind: 'ready', requestId: request.requestId });
      return;
    }
    if (request.kind === 'final-only') {
      self.postMessage({ kind: 'started', requestId: request.requestId });
      performance.mark('alignment-final-scoring:start');
      const result = selectFinalAffineProposal(request.input);
      performance.measure('alignment-final-scoring', 'alignment-final-scoring:start');
      self.postMessage({
        kind: 'final-result',
        requestId: request.requestId,
        result,
      });
      return;
    }
    if (!engine) throw new Error('Alignment scoring worker has not initialized its reference image');
    if (request.kind === 'final') {
      self.postMessage({
        kind: 'final-result',
        requestId: request.requestId,
        result: engine.scoreFinal(request.input),
      });
      return;
    }
    const result: AlignmentScoredCandidate =
      request.kind === 'coarse'
        ? engine.scoreCoarse(request.pixels, request.seed, request.validity)
        : engine.scoreFine(request.pixels, request.seed, request.phase, request.validity);
    self.postMessage({ kind: 'result', requestId: request.requestId, result });
  } catch (error) {
    self.postMessage({
      kind: 'error',
      requestId: request.requestId,
      message: error instanceof Error ? error.message : 'Alignment scoring failed',
    });
  }
};
