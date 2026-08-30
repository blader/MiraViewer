import { createInteractiveTrackingModel } from './efficientTam/model';
import type { TrackingController, TrackingFrameDecision, TrackingFrameOutput } from './interactiveTracking';
import type {
  InteractiveTrackingJob,
  InteractiveTrackingWorkerRequest,
  InteractiveTrackingWorkerResponse,
} from './interactiveTrackingWorker';

const scope = globalThis as unknown as {
  onmessage: (event: MessageEvent<InteractiveTrackingWorkerRequest>) => void;
  postMessage(message: InteractiveTrackingWorkerResponse, transfer?: Transferable[]): void;
};
let started = false;
let sequence = 0;
const abort = new AbortController();
let waiting: {
  requestId: number;
  reply: 'source' | 'consumed';
  resolve(value: Float32Array | TrackingFrameDecision): void;
  reject(error: Error): void;
} | null = null;

function exchange(
  message: Extract<InteractiveTrackingWorkerResponse, { type: 'read-frame' | 'frame' }>,
  transfer: Transferable[] = [],
): Promise<Float32Array | TrackingFrameDecision> {
  if (waiting) return Promise.reject(new Error('Only one source/output handshake can be active.'));
  return new Promise((resolve, reject) => {
    waiting = {
      requestId: message.requestId,
      reply: message.type === 'read-frame' ? 'source' : 'consumed',
      resolve,
      reject,
    };
    try {
      scope.postMessage(message, transfer);
    } catch (error) {
      waiting = null;
      reject(error instanceof Error ? error : new Error(String(error)));
    }
  });
}

async function run(job: InteractiveTrackingJob): Promise<void> {
  let model: TrackingController | undefined;
  let completedFrames = 0;
  const directionEndpoints = { forward: job.anchorIndex, reverse: job.anchorIndex };
  const readSource = async (index: number, direction: 1 | -1, stage?: 'prepare' | 'final') => {
    const pixels = await exchange({
      type: 'read-frame',
      requestId: ++sequence,
      index,
      direction,
      ...(stage ? { stage } : {}),
    });
    if (!(pixels instanceof Float32Array)) throw new Error('Expected a source plane from the owning viewer.');
    return pixels;
  };
  const sendFrame = async ({
    index,
    direction,
    initial,
    nativeLogits,
  }: TrackingFrameOutput): Promise<TrackingFrameDecision> => {
    // Controller outputs are borrowed. Only this tight copy crosses the boundary.
    const copy = nativeLogits.slice();
    const decision = await exchange(
      { type: 'frame', requestId: ++sequence, frame: { index, direction, initial, nativeLogits: copy } },
      [copy.buffer],
    );
    if (decision !== undefined && decision !== 'stop-direction') throw new Error('Invalid frame acknowledgement.');
    if (decision === 'stop-direction' && (!job.allowDirectionStop || initial))
      throw new Error('Directional stopping requires explicit permission on a non-anchor frame.');
    completedFrames++;
    directionEndpoints[direction === 1 ? 'forward' : 'reverse'] = index;
    return decision;
  };
  try {
    if (job.allowDirectionStop !== undefined && job.allowDirectionStop !== true)
      throw new Error('Directional stopping requires explicit permission.');
    if (job.allowDirectionStop && job.markedFrames?.some((frame) => frame.index !== job.anchorIndex))
      throw new Error('Directional stopping requires a single marked source plane.');
    scope.postMessage({ type: 'progress', progress: { phase: 'loading' } });
    model = await createInteractiveTrackingModel({
      provider: job.provider,
      // Four-thread diagnostics passed the cropped fixture; normal full-volume adoption remains on hold.
      wasmThreads: 1,
      signal: abort.signal,
      onProgress: (asset) => scope.postMessage({ type: 'progress', progress: { phase: 'loading', asset } }),
    });
    abort.signal.throwIfAborted();
    if (job.markedFrames?.some((frame) => frame.index !== job.anchorIndex)) {
      let stage: 'prepare' | 'final' = 'prepare';
      let direction: 1 | -1 = 1;
      await model.runSnapshot({
        ...job,
        signal: abort.signal,
        readFrame: (index) => readSource(index, direction, stage),
        onFrame: sendFrame,
        onProgress: ({ stage: nextStage, phase, ...progress }) => {
          stage = nextStage;
          direction = progress.direction;
          scope.postMessage({
            type: 'progress',
            progress: {
              ...progress,
              phase: stage === 'prepare' ? 'preparing' : 'frames',
              stage: phase,
              completedFrames,
              totalFrames: job.frameCount + 1,
            },
          });
        },
      });
    } else {
      // Both directions start with the actual conditioning plane and fresh model history.
      // The anchor is intentionally returned twice; filtering/merging is not transport policy.
      for (const direction of [1, -1] as const) {
        await model.run({
          ...job,
          direction,
          signal: abort.signal,
          readFrame: (index) => readSource(index, direction),
          onFrame: sendFrame,
          onProgress: ({ phase, ...progress }) =>
            scope.postMessage({
              type: 'progress',
              progress: {
                ...progress,
                phase: 'frames',
                stage: phase,
                completedFrames,
                totalFrames: job.frameCount + 1,
              },
            }),
        });
      }
    }
  } finally {
    // A successful terminal reply means all model sessions have actually been released.
    await model?.dispose();
  }
  scope.postMessage({ type: 'done', completedFrames, ...(job.allowDirectionStop ? { directionEndpoints } : {}) });
}

function fail(error: Error): void {
  if (abort.signal.aborted) return;
  abort.abort();
  waiting?.reject(error);
  waiting = null;
  scope.postMessage({ type: 'error', message: error.message });
}

scope.onmessage = ({ data }) => {
  if (data.type === 'start') {
    if (started) {
      fail(new Error('A tracking worker belongs to exactly one job.'));
      return;
    }
    started = true;
    void run(data.job).catch((error: unknown) => fail(error instanceof Error ? error : new Error(String(error))));
  } else if (waiting && data.requestId === waiting.requestId && data.type === waiting.reply) {
    if (data.type === 'consumed' && data.stopDirection !== undefined && data.stopDirection !== true) {
      fail(new Error('Invalid directional stop acknowledgement.'));
      return;
    }
    const pending = waiting;
    waiting = null;
    pending.resolve(data.type === 'source' ? data.pixels : data.stopDirection ? 'stop-direction' : undefined);
  } else fail(new Error('Interactive selection received an out-of-order frame reply.'));
};
