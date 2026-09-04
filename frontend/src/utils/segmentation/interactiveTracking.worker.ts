import { createInteractiveTrackingModel } from './efficientTam/model';
import type { TrackingController, TrackingFrameDecision, TrackingFrameOutput } from './interactiveTracking';
import type {
  InteractiveTrackingJob,
  InteractiveTrackingWorkerRequest,
  InteractiveTrackingWorkerResponse,
} from './interactiveTrackingWorker';

const scope = globalThis as unknown as {
  onmessage: (event: MessageEvent<InteractiveTrackingWorkerRequest>) => void;
};
let started = false;
let sequence = 0;
let abort = new AbortController();
let channel: MessagePort | null = null;
let model: TrackingController | undefined;
let modelProvider: InteractiveTrackingJob['provider'] | undefined;
let waiting: {
  requestId: number;
  reply: 'source' | 'consumed';
  resolve(value: Float32Array | TrackingFrameDecision): void;
  reject(error: Error): void;
} | null = null;

function post(message: InteractiveTrackingWorkerResponse, transfer: Transferable[] = []): void {
  channel?.postMessage(message, transfer);
}

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
      post(message, transfer);
    } catch (error) {
      waiting = null;
      reject(error instanceof Error ? error : new Error(String(error)));
    }
  });
}

async function run(job: InteractiveTrackingJob): Promise<void> {
  let completedFrames = 0;
  const directionEndpoints = { forward: job.anchorIndex, reverse: job.anchorIndex };
  const conditioning = [job.anchorIndex, ...(job.markedFrames ?? []).map((frame) => frame.index)];
  const hasCorrections = conditioning.some((index) => index !== job.anchorIndex);
  let stage: 'prepare' | 'final' = hasCorrections ? 'prepare' : 'final';
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
    if (stage !== 'final') throw new Error('Conditioning preparation cannot publish a final source plane.');
    // Controller outputs are borrowed. Only this tight copy crosses the boundary.
    const copy = nativeLogits.slice();
    const decision = await exchange(
      { type: 'frame', requestId: ++sequence, frame: { index, direction, initial, nativeLogits: copy } },
      [copy.buffer],
    );
    if (decision !== undefined && decision !== 'stop-direction') throw new Error('Invalid frame acknowledgement.');
    if (
      decision === 'stop-direction' &&
      (!job.allowDirectionStop || initial || conditioning.some((markedIndex) => (index - markedIndex) * direction <= 0))
    )
      throw new Error(
        'Directional stopping requires explicit permission on a non-anchor frame beyond every marked source plane.',
      );
    completedFrames++;
    directionEndpoints[direction === 1 ? 'forward' : 'reverse'] = index;
    return decision;
  };
  try {
    if (job.allowDirectionStop !== undefined && job.allowDirectionStop !== true)
      throw new Error('Directional stopping requires explicit permission.');
    if (model && modelProvider !== job.provider)
      throw new Error('A different tracking provider requires a fresh runtime.');
    if (!model) {
      post({ type: 'progress', progress: { phase: 'loading' } });
      model = await createInteractiveTrackingModel({
        provider: job.provider,
        // Four-thread diagnostics passed the cropped fixture; normal full-volume adoption remains on hold.
        wasmThreads: 1,
        signal: abort.signal,
        onProgress: (asset) => post({ type: 'progress', progress: { phase: 'loading', asset } }),
        // The controller is reused, but progress always belongs to the current isolated job channel.
        onTiming: (timing) => post({ type: 'progress', progress: { phase: 'timing', ...timing } }),
      });
      modelProvider = job.provider;
    }
    abort.signal.throwIfAborted();
    if (hasCorrections) {
      let direction: 1 | -1 = 1;
      await model.runSnapshot({
        ...job,
        signal: abort.signal,
        readFrame: (index) => readSource(index, direction, stage),
        onFrame: sendFrame,
        onProgress: ({ stage: nextStage, phase, ...progress }) => {
          stage = nextStage;
          direction = progress.direction;
          post({
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
            post({
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
  } catch (error) {
    try {
      await model?.dispose();
    } finally {
      model = undefined;
      modelProvider = undefined;
    }
    throw error;
  }
  // run()/runSnapshot() have released all per-job history and tensor ownership.
  // Only the source-owned compiled model survives; a fresh channel fences every later job.
  post({ type: 'done', completedFrames, ...(job.allowDirectionStop ? { directionEndpoints } : {}) });
}

function fail(error: Error): void {
  if (abort.signal.aborted) return;
  abort.abort();
  waiting?.reject(error);
  waiting = null;
  post({ type: 'error', message: error.message });
}

function receive(data: InteractiveTrackingWorkerRequest): void {
  if (abort.signal.aborted) return;
  if (data.type !== 'start' && waiting && data.requestId === waiting.requestId && data.type === waiting.reply) {
    if (data.type === 'consumed' && data.stopDirection !== undefined && data.stopDirection !== true) {
      fail(new Error('Invalid directional stop acknowledgement.'));
      return;
    }
    const pending = waiting;
    waiting = null;
    pending.resolve(data.type === 'source' ? data.pixels : data.stopDirection ? 'stop-direction' : undefined);
  } else fail(new Error('Interactive selection received an out-of-order frame reply.'));
}

scope.onmessage = ({ data, ports }) => {
  const port = ports[0];
  if (data.type !== 'start' || !port) throw new Error('Interactive selection requires a dedicated job channel.');
  if (started) {
    fail(new Error('Only one interactive selection job can run at a time.'));
    port.close();
    return;
  }
  started = true;
  sequence = 0;
  abort = new AbortController();
  channel = port;
  port.onmessage = ({ data }: MessageEvent<InteractiveTrackingWorkerRequest>) => {
    if (channel === port) receive(data);
  };
  port.onmessageerror = () => fail(new Error('Interactive selection received an unreadable frame reply.'));
  void run(data.job)
    .catch((error: unknown) => fail(error instanceof Error ? error : new Error(String(error))))
    .finally(() => {
      port.onmessage = null;
      port.onmessageerror = null;
      port.close();
      if (channel === port) {
        channel = null;
        waiting = null;
        started = false;
      }
    });
};
