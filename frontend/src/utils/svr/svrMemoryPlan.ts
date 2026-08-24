/** Shared resident-memory authority for SVR admission and reconstruction. */
export const SVR_MEMORY_BUDGET_BYTES = 512 * 1024 * 1024;

export type SvrMemoryPlan = {
  sourceBytes: number;
  solverBytes: number;
  displayBytes: number;
  supportBytes: number;
  retainedBytes: number;
  labelBytes: number;
  registrationBytes: number;
  modelTensorBytes: number;
  totalBytes: number;
};

/** Simultaneous reference/moving score volumes, masks, splat scratch, and bounded sample vectors. */
export function estimateSvrRegistrationBytes(voxelCount: number, scoreMaxDim = 160): number {
  if (!Number.isFinite(voxelCount) || voxelCount <= 0) return 0;

  const boundedScoreDim = Number.isFinite(scoreMaxDim) ? Math.max(64, Math.min(256, Math.round(scoreMaxDim))) : 160;
  const scoreVoxelCount = Math.min(Math.ceil(voxelCount), boundedScoreDim ** 3);
  const scoreGridBytes = scoreVoxelCount * (3 * Float32Array.BYTES_PER_ELEMENT + 2 * Uint8Array.BYTES_PER_ELEMENT);
  const boundedSampleBytes = 2 * 40_000 * 5 * Float32Array.BYTES_PER_ELEMENT;
  return scoreGridBytes + boundedSampleBytes;
}

/**
 * Accounts for simultaneous source, volume, acquired support, and presentation
 * ownership. Display reserves half-float CPU staging, its half-float GPU
 * texture, and an independent one-byte auxiliary GPU texture. Callers declare
 * any independently retained previous result, labels, registration scratch,
 * or inference tensors; inference owns its accepted volume but no solver scratch.
 */
export function estimateSvrPeakMemoryBytes(params: {
  voxelCount: number;
  sourceBytes: number;
  iterations: number;
  phase?: 'reconstruction' | 'inference';
  retainedBytes?: number;
  labelBytes?: number;
  registrationBytes?: number;
  modelTensorBytes?: number;
}): SvrMemoryPlan {
  const normalizeBytes = (value: number | undefined): number =>
    typeof value === 'number' && Number.isFinite(value) ? Math.max(0, Math.ceil(value)) : 0;

  const voxelCount = normalizeBytes(params.voxelCount);
  const sourceBytes = normalizeBytes(params.sourceBytes);
  const iterations = Number.isFinite(params.iterations) ? Math.max(0, Math.round(params.iterations)) : 0;

  const solverBuffers = params.phase === 'inference' ? 1 : iterations > 0 ? 3 : 2;
  const solverBytes = voxelCount * Float32Array.BYTES_PER_ELEMENT * solverBuffers;
  const supportBytes = voxelCount * Uint8Array.BYTES_PER_ELEMENT;
  const displayBytes = voxelCount * (Uint16Array.BYTES_PER_ELEMENT * 2 + Uint8Array.BYTES_PER_ELEMENT);
  const retainedBytes = normalizeBytes(params.retainedBytes);
  const labelBytes = normalizeBytes(params.labelBytes);
  const registrationBytes = normalizeBytes(params.registrationBytes);
  const modelTensorBytes = normalizeBytes(params.modelTensorBytes);

  return {
    sourceBytes,
    solverBytes,
    displayBytes,
    supportBytes,
    retainedBytes,
    labelBytes,
    registrationBytes,
    modelTensorBytes,
    totalBytes:
      sourceBytes +
      solverBytes +
      displayBytes +
      supportBytes +
      retainedBytes +
      labelBytes +
      registrationBytes +
      modelTensorBytes,
  };
}
