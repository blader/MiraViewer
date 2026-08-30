import type { SvrSelectionSeeds, SvrVolume } from '../../types/svr';

export type SelectionProposalRequest = {
  /** Borrowed source and literal marks; the proposer must not mutate either. */
  volume: SvrVolume;
  seeds: SvrSelectionSeeds;
  /** Unique buffers retained by the editor's marks and undo/redo history. */
  retainedBytes: number;
  signal: AbortSignal;
  /** Fraction completed, from zero to one. */
  onProgress: (progress: number) => void;
};

export type SelectionProposalResult = {
  /** Binary mask on the editing volume's grid; publication takes its own copy. */
  data: Uint8Array;
  /** Unknown when unobserved tails were safely pruned from a connected-selection request. */
  boundaryCount?: number;
  contextLimited: boolean;
  /** Positive native predictions outside the editing grid or without supported target samples. */
  clippedNativeVoxels?: number;
};

/** A proposal never owns publication, hard-mark enforcement, or editing history. */
export type SelectionProposer = (request: SelectionProposalRequest) => Promise<SelectionProposalResult>;
