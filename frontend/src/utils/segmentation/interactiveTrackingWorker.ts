import type {
  TrackingFrameOutput,
  TrackingGraph,
  TrackingSnapshotOptions,
  TrackingProgress,
  TrackingFrameDecision,
  TrackingSnapshotResult,
} from './interactiveTracking';
import type { InteractiveTrackingProvider } from './efficientTam/model';

export const TRACKING_INACTIVITY_MS = 120_000;

export type InteractiveTrackingFrame = Pick<TrackingFrameOutput, 'index' | 'direction' | 'initial'> & {
  /** Owned, tight source-grid logits; the consumer may retain or transfer this array. */
  nativeLogits: Float32Array<ArrayBuffer>;
};

export type InteractiveTrackingProgress =
  | { phase: 'loading'; asset?: TrackingGraph }
  | (Omit<TrackingProgress, 'phase'> & {
      phase: 'preparing' | 'frames';
      stage: string;
      completedFrames: number;
      totalFrames: number;
      conditioningFrames?: number;
    });

export type InteractiveTrackingWorkerOptions = Omit<
  TrackingSnapshotOptions,
  'direction' | 'stopIndex' | 'onFrame' | 'onProgress'
> & {
  provider: InteractiveTrackingProvider;
  /** Streamed predictions are provisional; only a successful run() signals complete, released work. */
  onFrame(frame: InteractiveTrackingFrame): TrackingFrameDecision | Promise<TrackingFrameDecision>;
  onProgress?(progress: InteractiveTrackingProgress): void;
};

export type InteractiveTrackingJob = Pick<
  InteractiveTrackingWorkerOptions,
  | 'width'
  | 'height'
  | 'frameCount'
  | 'sourceRange'
  | 'anchorIndex'
  | 'points'
  | 'labels'
  | 'provider'
  | 'markedFrames'
  | 'allowDirectionStop'
>;
export type InteractiveTrackingWorkerResult = TrackingSnapshotResult;

export type InteractiveTrackingWorkerRequest =
  | { type: 'start'; job: InteractiveTrackingJob }
  | { type: 'source'; requestId: number; pixels: Float32Array<ArrayBuffer> }
  | { type: 'consumed'; requestId: number; stopDirection?: true };

export type InteractiveTrackingWorkerResponse =
  | { type: 'progress'; progress: InteractiveTrackingProgress }
  | { type: 'read-frame'; requestId: number; index: number; direction: 1 | -1; stage?: 'prepare' | 'final' }
  | { type: 'frame'; requestId: number; frame: InteractiveTrackingFrame }
  | ({ type: 'done' } & InteractiveTrackingWorkerResult)
  | { type: 'error'; message: string };

function snapshotJob(options: InteractiveTrackingWorkerOptions): InteractiveTrackingJob {
  const { width, height, frameCount, anchorIndex, sourceRange, points, labels, provider } = options;
  if (options.allowDirectionStop !== undefined && options.allowDirectionStop !== true)
    throw new Error('Directional stopping requires explicit permission.');
  if (
    ![width, height, frameCount].every((value) => Number.isSafeInteger(value) && value > 0) ||
    !Number.isSafeInteger(width * height) ||
    !Number.isSafeInteger(frameCount + 1) ||
    !Number.isSafeInteger(anchorIndex) ||
    anchorIndex < 0 ||
    anchorIndex >= frameCount
  )
    throw new Error('Interactive selection requires a complete source grid and an actual conditioning plane.');
  if (
    sourceRange.length !== 2 ||
    !sourceRange.every(Number.isFinite) ||
    sourceRange[1] <= sourceRange[0] ||
    !Number.isFinite(sourceRange[1] - sourceRange[0])
  )
    throw new Error('Interactive selection requires a finite, fixed source range.');
  if (
    !Array.isArray(points) ||
    !points.length ||
    !Array.isArray(labels) ||
    points.length !== labels.length ||
    points.some(
      (point) =>
        !Array.isArray(point) ||
        point.length !== 2 ||
        !point.every(Number.isFinite) ||
        point[0] < 0 ||
        point[0] >= width ||
        point[1] < 0 ||
        point[1] >= height,
    ) ||
    labels.some((label) => label !== 0 && label !== 1)
  )
    throw new Error('Interactive selection requires explicit in-grid source-plane points and matching labels.');
  if (provider !== 'wasm' && provider !== 'hybrid' && provider !== 'gpu-memory' && provider !== 'webgpu')
    throw new Error('Choose an explicit interactive selection runtime.');
  if (!labels.includes(1)) throw new Error('Interactive selection needs an actual foreground anchor.');
  const seen = new Set<number>();
  const markedFrames = options.markedFrames?.map((frame) => {
    if (!Number.isSafeInteger(frame.index) || frame.index < 0 || frame.index >= frameCount || seen.has(frame.index))
      throw new Error('Each marked source plane must occur once within the selection snapshot.');
    seen.add(frame.index);
    if (
      !frame.points.length ||
      frame.points.length !== frame.labels.length ||
      frame.points.some(
        (point) =>
          point.length !== 2 ||
          !point.every(Number.isFinite) ||
          point[0] < 0 ||
          point[0] >= width ||
          point[1] < 0 ||
          point[1] >= height,
      ) ||
      frame.labels.some((label) => label !== 0 && label !== 1)
    )
      throw new Error('Snapshot prompts must remain on their actual in-grid source planes.');
    if (
      frame.index === anchorIndex &&
      (frame.points.length !== points.length ||
        frame.points.some(
          (point, index) =>
            point[0] !== points[index][0] || point[1] !== points[index][1] || frame.labels[index] !== labels[index],
        ))
    )
      throw new Error('The snapshot anchor must match its explicit source-plane prompts.');
    return {
      index: frame.index,
      points: frame.points.map((point): [number, number] => [point[0], point[1]]),
      labels: [...frame.labels],
    };
  });
  if (options.allowDirectionStop && markedFrames?.some((frame) => frame.index !== anchorIndex))
    throw new Error('Directional stopping requires a single marked source plane.');
  return {
    width,
    height,
    frameCount,
    anchorIndex,
    provider,
    sourceRange: [sourceRange[0], sourceRange[1]],
    points: points.map((point) => [point[0], point[1]] as const),
    labels: [...labels],
    ...(markedFrames ? { markedFrames } : {}),
    ...(options.allowDirectionStop ? { allowDirectionStop: true as const } : {}),
  };
}

/** One job owns one worker/model. Each direction is fresh and deliberately emits the anchor again. */
export class InteractiveTrackingWorker {
  private active: { worker: Worker; fail(error: Error): void } | null = null;

  run(options: InteractiveTrackingWorkerOptions): Promise<InteractiveTrackingWorkerResult> {
    if (options.signal?.aborted)
      return Promise.reject(new DOMException('Interactive selection cancelled.', 'AbortError'));
    if (this.active) return Promise.reject(new Error('Only one interactive selection job can run at a time.'));
    if (typeof Worker === 'undefined')
      return Promise.reject(new Error('Interactive selection requires browser worker support.'));
    let job: InteractiveTrackingJob;
    let worker: Worker;
    try {
      job = snapshotJob(options);
      worker = new Worker(new URL('./interactiveTracking.worker.ts', import.meta.url), { type: 'module' });
    } catch (error) {
      return Promise.reject(error instanceof Error ? error : new Error(String(error)));
    }
    const { signal, readFrame, onFrame, onProgress } = options;
    const sourceAbort = new AbortController();
    return new Promise((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout>;
      let awaiting: 'read' | 'frame' = 'read';
      let handshaking = false;
      let requestId = 0;
      let completedFrames = 0;
      // Only a decision acknowledged by this owner can shorten a directional prefix.
      const directionEndpoints = { forward: job.frameCount - 1, reverse: 0 };
      const requiredFrames = () => directionEndpoints.forward - directionEndpoints.reverse + 2;
      const conditioning = new Set([job.anchorIndex, ...(job.markedFrames ?? []).map((frame) => frame.index)]);
      const hasCorrections = conditioning.size > 1;
      let preparationMin = job.anchorIndex,
        preparationMax = job.anchorIndex;
      for (const index of conditioning) {
        preparationMin = Math.min(preparationMin, index);
        preparationMax = Math.max(preparationMax, index);
      }
      const preparationFrames = hasCorrections ? preparationMax - preparationMin + 1 : 0;
      let preparedFrames = 0;
      const current = () => this.active === active;
      const finish = (error?: Error) => {
        if (!current()) return;
        this.active = null;
        clearTimeout(timer);
        signal?.removeEventListener('abort', cancel);
        worker.onmessage = null;
        worker.onerror = null;
        worker.onmessageerror = null;
        sourceAbort.abort();
        worker.terminate();
        if (error) reject(error);
        else
          resolve({
            completedFrames,
            ...(job.allowDirectionStop ? { directionEndpoints: { ...directionEndpoints } } : {}),
          });
      };
      const active = { worker, fail: (error: Error) => finish(error) };
      const cancel = () => finish(new DOMException('Interactive selection cancelled.', 'AbortError'));
      const touch = () => {
        clearTimeout(timer);
        timer = setTimeout(
          () =>
            finish(
              new Error(
                'Interactive selection stopped responding. Your marks are unchanged; retry or continue editing directly.',
              ),
            ),
          TRACKING_INACTIVITY_MS,
        );
      };
      const expectedFrame = () => {
        const forwardFrames = directionEndpoints.forward - job.anchorIndex + 1;
        return completedFrames < forwardFrames
          ? { index: job.anchorIndex + completedFrames, direction: 1 }
          : { index: job.anchorIndex - (completedFrames - forwardFrames), direction: -1 };
      };
      const exchange = async (
        message: Extract<InteractiveTrackingWorkerResponse, { type: 'read-frame' | 'frame' }>,
      ) => {
        const preparing = message.type === 'read-frame' && message.stage === 'prepare';
        const preparedForward = preparationMax - job.anchorIndex + 1;
        const expected = preparing
          ? preparedFrames < preparedForward
            ? { index: job.anchorIndex + preparedFrames, direction: 1 }
            : { index: job.anchorIndex - (preparedFrames - preparedForward + 1), direction: -1 }
          : expectedFrame();
        const frame = message.type === 'read-frame' ? message : message.frame;
        if (
          handshaking ||
          (preparing
            ? !hasCorrections || preparedFrames >= preparationFrames
            : preparedFrames !== preparationFrames || completedFrames >= requiredFrames()) ||
          !Number.isSafeInteger(message.requestId) ||
          message.requestId !== requestId + 1 ||
          frame.index !== expected.index ||
          frame.direction !== expected.direction ||
          (message.type === 'read-frame'
            ? awaiting !== 'read' || (!preparing && hasCorrections && conditioning.has(frame.index))
            : awaiting !== 'frame' && !(hasCorrections && conditioning.has(frame.index)))
        )
          throw new Error('Interactive selection returned an out-of-order frame. Please retry.');
        requestId = message.requestId;
        handshaking = true;
        if (message.type === 'read-frame') {
          const pixels = await readFrame(message.index, sourceAbort.signal);
          if (!current()) return;
          if (
            !(pixels instanceof Float32Array) ||
            pixels.length !== job.width * job.height ||
            !pixels.every(Number.isFinite)
          )
            throw new Error('Interactive selection requires a complete, finite original source plane.');
          // Never transfer/detach a caller-owned MRI view or its larger backing volume.
          const copy = new Float32Array(pixels);
          if (preparing) preparedFrames++;
          else awaiting = 'frame';
          handshaking = false;
          touch();
          worker.postMessage({ type: 'source', requestId, pixels: copy } satisfies InteractiveTrackingWorkerRequest, [
            copy.buffer,
          ]);
        } else {
          const { nativeLogits, initial, index, direction } = message.frame;
          if (
            initial !== (index === job.anchorIndex) ||
            !(nativeLogits instanceof Float32Array) ||
            nativeLogits.length !== job.width * job.height ||
            nativeLogits.byteOffset !== 0 ||
            nativeLogits.byteLength !== nativeLogits.buffer.byteLength ||
            !nativeLogits.every(Number.isFinite)
          )
            throw new Error('Interactive selection returned an invalid source-grid prediction.');
          const decision = await onFrame(message.frame);
          if (!current()) return;
          if (decision !== undefined && decision !== 'stop-direction')
            throw new Error('Interactive selection received an invalid frame decision.');
          if (decision === 'stop-direction') {
            if (!job.allowDirectionStop || hasCorrections || initial)
              throw new Error('Directional stopping requires explicit permission on a non-anchor frame.');
            directionEndpoints[direction === 1 ? 'forward' : 'reverse'] = index;
          }
          completedFrames++;
          awaiting = 'read';
          handshaking = false;
          touch();
          worker.postMessage({
            type: 'consumed',
            requestId,
            ...(decision === 'stop-direction' ? { stopDirection: true as const } : {}),
          } satisfies InteractiveTrackingWorkerRequest);
        }
      };
      this.active = active;
      worker.onmessage = ({ data }: MessageEvent<InteractiveTrackingWorkerResponse>) => {
        if (!current()) return;
        touch();
        try {
          if (data.type === 'progress') onProgress?.(data.progress);
          else if (data.type === 'error') finish(new Error(data.message));
          else if (data.type === 'done') {
            if (
              handshaking ||
              awaiting !== 'read' ||
              completedFrames !== requiredFrames() ||
              preparedFrames !== preparationFrames ||
              data.completedFrames !== requiredFrames() ||
              (job.allowDirectionStop
                ? !data.directionEndpoints ||
                  data.directionEndpoints.forward !== directionEndpoints.forward ||
                  data.directionEndpoints.reverse !== directionEndpoints.reverse
                : data.directionEndpoints !== undefined)
            )
              throw new Error('Interactive selection ended before every source plane was returned.');
            finish();
          } else
            void exchange(data).catch((error: unknown) =>
              active.fail(error instanceof Error ? error : new Error(String(error))),
            );
        } catch (error) {
          active.fail(error instanceof Error ? error : new Error(String(error)));
        }
      };
      worker.onerror = () =>
        active.fail(new Error('The interactive selection worker failed. Your marks are unchanged; please retry.'));
      worker.onmessageerror = () =>
        active.fail(new Error('The interactive selection worker returned unreadable data. Please retry.'));
      signal?.addEventListener('abort', cancel, { once: true });
      touch();
      try {
        if (signal?.aborted) cancel();
        else worker.postMessage({ type: 'start', job } satisfies InteractiveTrackingWorkerRequest);
      } catch (error) {
        active.fail(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  /** Interrupts only this job, including an uncancelable graph/session call in its dedicated worker. */
  dispose(): void {
    this.active?.fail(new DOMException('Interactive selection cancelled.', 'AbortError'));
  }
}
