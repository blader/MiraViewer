import { InteractiveTrackingWorker } from '../../src/utils/segmentation/interactiveTrackingWorker';
import type { TrackingPhaseTiming } from '../../src/utils/segmentation/interactiveTracking';
import {
  admitInteractiveSelection,
  estimateInteractiveSelectionMemory,
} from '../../src/utils/segmentation/interactiveAdmission';

const width = 32;
const height = 32;
const frameCount = 3;

function sourcePlanes() {
  return Array.from({ length: frameCount }, (_, z) =>
    Float32Array.from({ length: width * height }, (_, i) => {
      const x = (i % width) - 15.5;
      const y = Math.floor(i / width) - 15.5;
      return -120 + 800 * Math.exp(-(x * x + y * y + (z - 1) ** 2 * 8) / 100) + 15 * Math.sin(x * 1.3 + y * 0.7 + z);
    }),
  );
}

async function sha256(values: Float32Array<ArrayBuffer>) {
  const bytes = new Uint8Array(values.buffer, values.byteOffset, values.byteLength);
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  return Array.from(digest, (value) => value.toString(16).padStart(2, '0')).join('');
}

/** Actual pinned model + actual module worker. Synthetic intensities, never patient pixels. */
async function measureInference(
  worker: InteractiveTrackingWorker,
  cancel: boolean,
  retainRuntimeAfterRun: boolean,
  corrected = false,
) {
  const planes = sourcePlanes();
  const before = await Promise.all(planes.map(sha256));
  const controller = new AbortController();
  const timings: TrackingPhaseTiming[] = [];
  const frames: Array<{ index: number; direction: number; initial: boolean; sha256: string; positivePixels: number }> =
    [];
  let canceledAt: number | null = null;
  let animationCallbacks = 0;
  let animation = 0;
  const animate = () => {
    animationCallbacks++;
    animation = requestAnimationFrame(animate);
  };
  animation = requestAnimationFrame(animate);
  const start = performance.now();
  let result: Awaited<ReturnType<InteractiveTrackingWorker['run']>> | null = null;
  let error: { name: string; message: string } | null = null;
  const admission = {
    signal: controller.signal,
    retainedRuntimeBytes: worker.retainedBytes,
    retainRuntimeAfterRun,
    retainedBytes: width * height * frameCount * 4,
    sourceLoadPeakBytes: width * height * frameCount * 4,
    contextBytes: width * height * frameCount * 5,
    editingVoxels: width * height * frameCount,
    width,
    height,
    frameCount,
    conditioningFrames: corrected ? 3 : 2,
    literalMarkCount: corrected ? 4 : 3,
    maximumFramePrompts: 2,
  };
  try {
    const { provider, estimate } = await admitInteractiveSelection(admission);
    result = await worker.run({
      width,
      height,
      frameCount,
      anchorIndex: 1,
      sourceRange: [-140, 710],
      points: [
        [16, 16],
        [1, 1],
      ],
      labels: [1, 0],
      // A real second-plane correction exercises preparation + fresh final sweeps.
      markedFrames: [
        { index: 0, points: [[1, 1]], labels: [0] },
        ...(corrected ? [{ index: 2, points: [[13, 15] as [number, number]], labels: [1 as const] }] : []),
      ],
      provider,
      admittedRuntimeBytes: Math.max(estimate.runtimeBytes, estimate.retainedRuntimeBytes),
      signal: controller.signal,
      readFrame: (index) => planes[index]!,
      onProgress(progress) {
        if (progress.phase === 'timing') {
          timings.push({ stage: progress.stage, asset: progress.asset, elapsedMs: progress.elapsedMs });
        }
        // Cancel after at least one real graph completed. This does not claim
        // cancellation occurred inside an uninterruptible graph invocation.
        if (cancel && canceledAt === null && progress.phase === 'timing' && progress.stage === 'graph-run') {
          canceledAt = performance.now();
          controller.abort();
        }
      },
      async onFrame({ index, direction, initial, nativeLogits }) {
        frames.push({
          index,
          direction,
          initial,
          sha256: await sha256(nativeLogits),
          positivePixels: nativeLogits.reduce((count, value) => count + Number(value > 0), 0),
        });
      },
    });
  } catch (failure) {
    error =
      failure instanceof Error
        ? { name: failure.name, message: failure.message }
        : { name: 'Error', message: String(failure) };
  } finally {
    if (!retainRuntimeAfterRun) worker.dispose();
    cancelAnimationFrame(animation);
  }
  const end = performance.now();
  return {
    result,
    error,
    frames,
    timings,
    animationCallbacks,
    elapsedMs: end - start,
    startedAtUnixMs: performance.timeOrigin + start,
    finishedAtUnixMs: performance.timeOrigin + end,
    cancelToReleaseMs: canceledAt === null ? null : end - canceledAt,
    ownedInputBytes: planes.reduce((bytes, plane) => bytes + plane.byteLength, 0),
    sourceUnchanged: JSON.stringify(before) === JSON.stringify(await Promise.all(planes.map(sha256))),
    fixture: {
      kind: 'synthetic Gaussian/texture',
      width,
      height,
      frameCount,
      conditioningFrames: admission.conditioningFrames,
    },
    memoryEstimate: estimateInteractiveSelectionMemory(admission),
    retainedRuntimeAllowanceBytes: worker.retainedBytes,
  };
}

export function measureInteractiveInference(cancel = false, corrected = false) {
  return measureInference(new InteractiveTrackingWorker(), cancel, false, corrected);
}

/** Same runtime, independent correction snapshots; no feature/temporal-state cache is shared. */
export async function measureRetainedInteractiveInference() {
  const worker = new InteractiveTrackingWorker();
  const runs: Awaited<ReturnType<typeof measureInference>>[] = [];
  try {
    for (let correction = 0; correction < 2; correction++) {
      const run = await measureInference(worker, false, true, correction > 0);
      runs.push(run);
      if (run.error) break;
    }
  } finally {
    worker.dispose();
  }
  return { runs, releasedRuntimeAllowanceBytes: worker.retainedBytes };
}
