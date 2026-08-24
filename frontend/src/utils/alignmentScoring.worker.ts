import {
  AlignmentScoringEngine,
  type AlignmentScoredCandidate,
  type AlignmentFinalScoringInput,
  type AlignmentScoringConfiguration,
} from './alignmentScoringEngine';
import type { GridSeedTransform } from './alignmentTransform';
import type { PhaseCorrection } from './phaseCorrelation';

type ScoringRequest =
  | { kind: 'initialize'; requestId: number; config: AlignmentScoringConfiguration }
  | { kind: 'coarse'; requestId: number; pixels: Float32Array; seed: GridSeedTransform }
  | { kind: 'fine'; requestId: number; pixels: Float32Array; seed: GridSeedTransform; phase: PhaseCorrection }
  | { kind: 'final'; requestId: number; input: AlignmentFinalScoringInput };

let engine: AlignmentScoringEngine | null = null;

self.onmessage = (event: MessageEvent<ScoringRequest>) => {
  const request = event.data;
  try {
    if (request.kind === 'initialize') {
      engine = new AlignmentScoringEngine(request.config);
      self.postMessage({ kind: 'ready', requestId: request.requestId });
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
        ? engine.scoreCoarse(request.pixels, request.seed)
        : engine.scoreFine(request.pixels, request.seed, request.phase);
    self.postMessage({ kind: 'result', requestId: request.requestId, result });
  } catch (error) {
    self.postMessage({
      kind: 'error',
      requestId: request.requestId,
      message: error instanceof Error ? error.message : 'Alignment scoring failed',
    });
  }
};
