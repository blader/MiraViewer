import { estimateTrackingSnapshotMemory } from './interactiveTracking';
import manifest from './efficientTam/assetManifest.json';
import {
  learnedImagingBudgetBytes as interactiveSelectionBudgetBytes,
  LEARNED_IMAGING_MAX_BUDGET_BYTES as MAX_BUDGET_BYTES,
} from './learnedMemoryBudget';
export { learnedImagingBudgetBytes as interactiveSelectionBudgetBytes } from './learnedMemoryBudget';

const MIB = 1024 * 1024;

function temporalWorkspaceBytes(memoryTokens: number): number {
  const graph = manifest.graphs.memoryAttention;
  const policy = graph.queryChunking;
  if (
    !policy ||
    !/^[a-f0-9]{64}$/.test(policy.sourceSha256) ||
    policy.sourceSha256 === graph.sha256 ||
    ![
      policy.sourceBytes,
      policy.queryRows,
      policy.queryChunkRows,
      policy.layers,
      policy.heads,
      policy.keyValueChannels,
      policy.projectionBufferAllowance,
    ].every((value) => Number.isSafeInteger(value) && value > 0) ||
    policy.queryRows % policy.queryChunkRows !== 0
  )
    throw new Error('Boundary suggestion memory metadata does not match its derived attention graph.');
  // Operational allowance for the pinned sequential WASM graph, not a heap
  // guarantee: all-layer score/softmax blocks plus full-key projection/rotary
  // workspace. These are combined allowances, not simultaneous tensor peaks.
  // Rotary liveness (including WASM input copies) can exceed six full buffers;
  // its peak does not overlap the score peak. The combined eight-buffer bound
  // retains arena headroom, and the fixed runtime reserve is still separate.
  // Revalidate liveness and measured arenas if graph, provider or scheduling changes.
  return (
    memoryTokens *
    Float32Array.BYTES_PER_ELEMENT *
    (2 * policy.layers * policy.heads * policy.queryChunkRows +
      policy.projectionBufferAllowance * policy.keyValueChannels)
  );
}

export type InteractiveSelectionAdmission = {
  signal: AbortSignal;
  retainedBytes: number;
  /** Existing worker high-water allowance; separate from application/source owners. */
  retainedRuntimeBytes?: number;
  /** Keep sessions beside projection/publication only when that phase is admitted. */
  retainRuntimeAfterRun?: boolean;
  /** Absolute native-assembly peak, already including retained source/display owners. */
  sourceLoadPeakBytes: number;
  /** Exact native intensity/support crop, separate from a possible oversized loader region. */
  contextBytes: number;
  editingVoxels: number;
  width: number;
  height: number;
  frameCount: number;
  conditioningFrames: number;
  /** All literal marks retained for mapping and component scratch; none are dropped to fit. */
  literalMarkCount: number;
  /** Largest per-frame decoder prompt count or conservative bound, before special tokens. */
  maximumFramePrompts: number;
};

type TrackingMemoryRequest = Pick<
  InteractiveSelectionAdmission,
  'width' | 'height' | 'frameCount' | 'conditioningFrames' | 'literalMarkCount' | 'maximumFramePrompts'
>;

/** Conservative pinned-model high-water allowance, not measured resident memory. */
export function estimateInteractiveTrackingMemory({
  width,
  height,
  frameCount,
  conditioningFrames,
  literalMarkCount,
  maximumFramePrompts,
}: TrackingMemoryRequest) {
  if (
    ![literalMarkCount, maximumFramePrompts, conditioningFrames].every(
      (value) => Number.isSafeInteger(value) && value > 0,
    ) ||
    literalMarkCount < conditioningFrames ||
    maximumFramePrompts > literalMarkCount - conditioningFrames + 1
  )
    throw new Error('Boundary suggestion memory requires valid source, editing and mark counts.');
  const snapshot = estimateTrackingSnapshotMemory(width, height, frameCount, conditioningFrames);
  // Compiled sessions, optimizer/model copies, constants and fixed graph arenas.
  // Dynamic attention and full-key state are additional, not hidden in this reserve.
  const runtimeAllowanceBytes = 1024 * MIB;
  const temporalAttentionBytes = temporalWorkspaceBytes(snapshot.maximumMemoryTokens);
  // Pinned decoder: two layers/eight heads, one marked frame at a time, plus
  // padding and the four mask, IoU and object-score tokens.
  const tokens = maximumFramePrompts + 7;
  const promptAttentionBytes = 2 * 4 * 8 * (2 * tokens * tokens + 5 * tokens * 1024);
  // One source/output exchange, native/low outputs, mapping and prompt scratch.
  // Retaining the complete phase allowance conservatively covers arena high-water
  // even after per-job JS tensors/history have been released.
  const frameScratchBytes = 16 * MIB + width * height * 64 + 512 * height + literalMarkCount * 1024;
  const { retainedStateBytes, packedMemoryBytes } = snapshot;
  const plan = {
    runtimeAllowanceBytes,
    temporalAttentionBytes,
    promptAttentionBytes,
    frameScratchBytes,
    retainedStateBytes,
    packedMemoryBytes,
    runtimeBytes:
      runtimeAllowanceBytes +
      temporalAttentionBytes +
      promptAttentionBytes +
      frameScratchBytes +
      retainedStateBytes +
      packedMemoryBytes,
  };
  if (!Object.values(plan).every((value) => Number.isSafeInteger(value) && value >= 0))
    throw new Error('Boundary suggestion memory exceeds safe allocation dimensions.');
  return plan;
}

export type InteractiveSelectionMemoryEstimate = Readonly<{
  retainedBytes: number;
  retainedRuntimeBytes: number;
  /** Includes retained owners; do not add retainedBytes again to the source phase. */
  sourceLoadPeakBytes: number;
  contextBytes: number;
  contextMaskBytes: number;
  runtimeAllowanceBytes: number;
  runtimeBytes: number;
  publicationRuntimeBytes: number;
  retainedStateBytes: number;
  packedMemoryBytes: number;
  temporalAttentionBytes: number;
  promptAttentionBytes: number;
  frameScratchBytes: number;
  publicationScratchBytes: number;
  sourcePeakBytes: number;
  trackingPeakBytes: number;
  publicationPeakBytes: number;
  totalBytes: number;
}>;

/** Phase peaks, not a sum of non-overlapping native assembly and inference. */
export function estimateInteractiveSelectionMemory(
  request: Omit<InteractiveSelectionAdmission, 'signal'>,
): InteractiveSelectionMemoryEstimate {
  const {
    retainedBytes,
    retainedRuntimeBytes = 0,
    retainRuntimeAfterRun = false,
    sourceLoadPeakBytes,
    contextBytes,
    editingVoxels,
    width,
    height,
    frameCount,
  } = request;
  if (
    ![retainedBytes, retainedRuntimeBytes, sourceLoadPeakBytes, contextBytes].every(
      (value) => Number.isSafeInteger(value) && value >= 0,
    ) ||
    !Number.isSafeInteger(editingVoxels) ||
    editingVoxels <= 0 ||
    typeof retainRuntimeAfterRun !== 'boolean' ||
    sourceLoadPeakBytes < retainedBytes
  )
    throw new Error('Boundary suggestion memory requires valid source, editing and mark counts.');
  const tracking = estimateInteractiveTrackingMemory(request);
  const planePixels = width * height;
  const contextVoxels = planePixels * frameCount;
  if (!Number.isSafeInteger(contextVoxels * 5) || contextBytes !== contextVoxels * 5)
    throw new Error('Boundary suggestion memory does not match its complete native source context.');

  const contextMaskBytes = contextVoxels;
  const sourcePeakBytes = sourceLoadPeakBytes + contextBytes + retainedRuntimeBytes;
  const runtimePeakBytes = Math.max(tracking.runtimeBytes, retainedRuntimeBytes);
  const trackingPeakBytes = retainedBytes + contextBytes + contextMaskBytes + runtimePeakBytes;
  // Publication can allocate before trimming the 32 MiB history: proposal +
  // next mask, two 6-byte/cell patches and 4-byte/cell coalescing sort scratch.
  const publicationScratchBytes = editingVoxels * 18;
  const publicationRuntimeBytes = retainRuntimeAfterRun ? runtimePeakBytes : 0;
  const publicationPeakBytes =
    retainedBytes + contextBytes + contextMaskBytes + publicationScratchBytes + publicationRuntimeBytes;
  const totalBytes = Math.max(sourcePeakBytes, trackingPeakBytes, publicationPeakBytes);
  const plan = {
    retainedBytes,
    retainedRuntimeBytes,
    sourceLoadPeakBytes,
    contextBytes,
    contextMaskBytes,
    ...tracking,
    publicationScratchBytes,
    sourcePeakBytes,
    trackingPeakBytes,
    publicationPeakBytes,
    publicationRuntimeBytes,
    totalBytes,
  };
  if (!Object.values(plan).every((value) => Number.isSafeInteger(value) && value >= 0))
    throw new Error('Boundary suggestion memory exceeds safe allocation dimensions.');
  return plan;
}

type PromptCounts = Pick<
  InteractiveSelectionAdmission,
  'conditioningFrames' | 'maximumFramePrompts' | 'literalMarkCount'
>;

/** An admission estimate and application safety policy, never a measured browser allocation limit. */
export class InteractiveSelectionMemoryError extends Error {
  readonly estimate: InteractiveSelectionMemoryEstimate;
  readonly budgetBytes: number;
  readonly atAppCap: boolean;
  readonly counts: Readonly<PromptCounts>;
  constructor(estimate: InteractiveSelectionMemoryEstimate, budgetBytes: number, counts: PromptCounts) {
    const atAppCap = budgetBytes === MAX_BUDGET_BYTES;
    super(
      `This boundary suggestion is estimated to need ${Math.ceil(estimate.totalBytes / MIB)} MiB at peak; ` +
        `MiraViewer's safety budget is ${Math.floor(budgetBytes / MIB)} MiB. ` +
        'This is an estimate, not measured memory usage or a browser hard limit. ' +
        (atAppCap ? 'MiraViewer has reached its application safety cap. ' : '') +
        'Model inference was not started. Your current selection and marks are unchanged.',
    );
    this.name = 'InteractiveSelectionMemoryError';
    this.estimate = estimate;
    this.budgetBytes = budgetBytes;
    this.atAppCap = atAppCap;
    this.counts = Object.freeze({
      conditioningFrames: counts.conditioningFrames,
      maximumFramePrompts: counts.maximumFramePrompts,
      literalMarkCount: counts.literalMarkCount,
    });
  }
}

/** One explicit faithful provider; a model failure never triggers a classifier/provider retry. */
export async function admitInteractiveSelection(request: InteractiveSelectionAdmission): Promise<{
  provider: 'wasm';
  estimate: InteractiveSelectionMemoryEstimate;
}> {
  const { signal } = request;
  signal.throwIfAborted();
  const plan = estimateInteractiveSelectionMemory(request);
  const budget = interactiveSelectionBudgetBytes(
    typeof navigator === 'undefined' ? undefined : (navigator as Navigator & { deviceMemory?: number }).deviceMemory,
  );
  if (plan.totalBytes > budget) throw new InteractiveSelectionMemoryError(plan, budget, request);
  if (typeof Worker === 'undefined' || typeof WebAssembly === 'undefined')
    throw new Error(
      'This browser does not support local learned selection. Your current selection and marks are unchanged.',
    );
  signal.throwIfAborted();
  // All-GPU decoding failed numerical validation. Hybrid encoding also changed
  // native binary decisions in the frozen MRI regression; neither is a default.
  return { provider: 'wasm', estimate: plan };
}
