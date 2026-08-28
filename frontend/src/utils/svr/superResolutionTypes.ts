import type { SvrVolume } from '../../types/svr';

/** The renderer must admit this in addition to all retained source/annotation owners. */
export const MAX_SR_OUTPUT_VOXELS = 16 * 1024 * 1024;
export const MIN_SR_CONTEXT_DIM = 32;

export type SvrSuperResolutionProgress = {
  phase: 'preparing' | 'training' | 'validating' | 'enhancing';
  current: number;
  total: number;
  message: string;
};

export type SvrSuperResolutionStats = {
  method: string;
  trainingSamples: number;
  calibrationSamples: number;
  heldOutSamples: number;
  trainingBlocks: number;
  calibrationBlocks: number;
  heldOutBlocks: number;
  /** MSE against withheld native voxels after synthetic 2x degradation, in raw intensity units squared. */
  baselineMse: number;
  enhancedMse: number;
  /** Maximum 2x2x2 child-block mean error against a supported source voxel, in raw intensity units. */
  consistencyMaxError: number;
  durationMs: number;
  /** Frozen using calibration blocks only; held-out blocks never fit or tune the model. */
  modelStrength: number;
};

/** Render-only inferred intensities. These are never acquired evidence or an annotation/measurement grid. */
export type SvrEnhancedVolume = Pick<
  SvrVolume,
  | 'data'
  | 'dims'
  | 'voxelSizeMm'
  | 'direction'
  | 'originMm'
  | 'boundsMm'
  | 'intensityRange'
  | 'displayWindow'
  | 'displayInvert'
> & {
  /** Source-footprint validity replicated at 2x; it does not imply measured subvoxel detail. */
  observedSupport: Uint8Array;
  stats: SvrSuperResolutionStats;
};

export type SvrSuperResolutionOptions = {
  signal?: AbortSignal;
  onProgress?: (progress: SvrSuperResolutionProgress) => void;
};

export type SvrSuperResolutionWorkerResponse =
  | { type: 'progress'; progress: SvrSuperResolutionProgress }
  | { type: 'done'; result: SvrEnhancedVolume }
  | { type: 'error'; message: string };
