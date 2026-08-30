import { estimateTrackingSnapshotMemory } from './interactiveTracking';

const MIB = 1024 * 1024;

/**
 * A separate, estimated envelope for learned selection, not a relaxation of the
 * native assembler's 512 MiB limit. Browsers expose neither available RAM nor
 * total ORT/GPU residency. Leave room for the rest of the browser/OS: at most a
 * quarter of reported device RAM, capped at 3 GiB; 1.5 GiB when RAM is unknown.
 */
export function interactiveSelectionBudgetBytes(deviceMemoryGiB?: number): number {
  return typeof deviceMemoryGiB === 'number' && Number.isFinite(deviceMemoryGiB) && deviceMemoryGiB > 0
    ? Math.floor(Math.min(3072 * MIB, (deviceMemoryGiB * 1024 * MIB) / 4))
    : 1536 * MIB;
}

export type InteractiveSelectionAdmission = {
  signal: AbortSignal;
  retainedBytes: number;
  /** Absolute native-assembly peak, already including retained source/display owners. */
  sourceLoadPeakBytes: number;
  /** Exact native intensity/support crop, separate from a possible oversized loader region. */
  contextBytes: number;
  editingVoxels: number;
  width: number;
  height: number;
  frameCount: number;
  conditioningFrames: number;
  /** All literal marks, an upper bound on component-medoid prompts; no marks are dropped to fit. */
  literalMarkCount: number;
};

/** Phase peaks, not a sum of non-overlapping native assembly and inference. */
export function estimateInteractiveSelectionMemory(request: Omit<InteractiveSelectionAdmission, 'signal'>) {
  const {
    retainedBytes,
    sourceLoadPeakBytes,
    contextBytes,
    editingVoxels,
    width,
    height,
    frameCount,
    conditioningFrames,
    literalMarkCount,
  } = request;
  if (
    ![retainedBytes, sourceLoadPeakBytes, contextBytes].every((value) => Number.isSafeInteger(value) && value >= 0) ||
    ![editingVoxels, literalMarkCount].every((value) => Number.isSafeInteger(value) && value > 0) ||
    literalMarkCount < conditioningFrames ||
    sourceLoadPeakBytes < retainedBytes
  )
    throw new Error('Boundary suggestion memory requires valid source, editing and mark counts.');
  const snapshot = estimateTrackingSnapshotMemory(width, height, frameCount, conditioningFrames);
  const planePixels = width * height;
  const contextVoxels = planePixels * frameCount;
  if (!Number.isSafeInteger(contextVoxels * 5) || contextBytes !== contextVoxels * 5)
    throw new Error('Boundary suggestion memory does not match its complete native source context.');

  // Fixed operational allowance, NOT a measured heap or a guarantee against OS
  // pressure: compiled sessions, optimizer/model-byte copies, runtime arenas,
  // constants and fixed 512-square graph workspaces. Dynamic attention and all
  // source/display/history ownership are charged separately below.
  const runtimeAllowanceBytes = 1024 * MIB;
  // Four temporal layers, one head: conservatively retain score + softmax
  // matrices across layers and runtime arenas rather than assuming reuse.
  const temporalAttentionBytes = 2 * 4 * 4 * 1024 * snapshot.maximumMemoryTokens;
  // Pinned decoder: two layers, eight heads; literal marks bound compressed
  // prompts. Include padding plus the four mask, IoU and object-score tokens.
  const tokens = literalMarkCount + 7;
  const promptAttentionBytes = 2 * 4 * 8 * (2 * tokens * tokens + 5 * tokens * 1024);
  // One source/output exchange at a time; normalized image and preprocessing
  // staging, native/low outputs, mapping/component sets and prompt snapshots.
  const frameScratchBytes = 16 * MIB + planePixels * 64 + 512 * height + literalMarkCount * 1024;
  const sourcePeakBytes = sourceLoadPeakBytes + contextBytes;
  const trackingPeakBytes =
    retainedBytes +
    contextBytes +
    contextVoxels +
    runtimeAllowanceBytes +
    snapshot.retainedStateBytes +
    snapshot.packedMemoryBytes +
    temporalAttentionBytes +
    promptAttentionBytes +
    frameScratchBytes;
  // Publication can allocate before trimming the 32 MiB history: proposal +
  // next mask, two 6-byte/cell patches and 4-byte/cell coalescing sort scratch.
  const publicationPeakBytes = retainedBytes + contextBytes + contextVoxels + editingVoxels * 18;
  const totalBytes = Math.max(sourcePeakBytes, trackingPeakBytes, publicationPeakBytes);
  const plan = {
    sourcePeakBytes,
    trackingPeakBytes,
    publicationPeakBytes,
    runtimeAllowanceBytes,
    temporalAttentionBytes,
    promptAttentionBytes,
    frameScratchBytes,
    totalBytes,
  };
  if (!Object.values(plan).every((value) => Number.isSafeInteger(value) && value >= 0))
    throw new Error('Boundary suggestion memory exceeds safe allocation dimensions.');
  return plan;
}

/** One explicit faithful provider; a model failure never triggers a classifier/provider retry. */
export async function admitInteractiveSelection(request: InteractiveSelectionAdmission): Promise<'wasm'> {
  const { signal } = request;
  signal.throwIfAborted();
  const plan = estimateInteractiveSelectionMemory(request);
  const budget = interactiveSelectionBudgetBytes(
    typeof navigator === 'undefined' ? undefined : (navigator as Navigator & { deviceMemory?: number }).deviceMemory,
  );
  if (plan.totalBytes > budget)
    throw new Error(
      `This boundary suggestion is estimated to need ${Math.ceil(plan.totalBytes / MIB)} MiB; ` +
        `this browser's allowance is ${Math.floor(budget / MIB)} MiB. ` +
        'Use a browser with more memory or fewer editing marks. Your current selection and marks are unchanged.',
    );
  if (typeof Worker === 'undefined' || typeof WebAssembly === 'undefined')
    throw new Error(
      'This browser does not support local learned selection. Your current selection and marks are unchanged.',
    );
  signal.throwIfAborted();
  // All-GPU decoding failed numerical validation. Hybrid encoding also changed
  // native binary decisions in the frozen MRI regression; neither is a default.
  return 'wasm';
}
