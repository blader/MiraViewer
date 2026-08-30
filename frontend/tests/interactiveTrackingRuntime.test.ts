import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { deferred } from './helpers/deferred';
import type {
  TrackingController,
  TrackingOptions,
  TrackingResult,
} from '../src/utils/segmentation/interactiveTracking';
import type {
  InteractiveTrackingJob,
  InteractiveTrackingWorkerRequest,
  InteractiveTrackingWorkerResponse,
} from '../src/utils/segmentation/interactiveTrackingWorker';

const { createModel } = vi.hoisted(() => ({ createModel: vi.fn() }));
vi.mock('../src/utils/segmentation/efficientTam/model', () => ({ createInteractiveTrackingModel: createModel }));

const job: InteractiveTrackingJob = {
  width: 2,
  height: 2,
  frameCount: 3,
  anchorIndex: 1,
  sourceRange: [0, 3],
  points: [
    [0, 1],
    [1, 0],
  ],
  labels: [1, 0],
  provider: 'wasm',
};
const messages: InteractiveTrackingWorkerResponse[] = [];
const transferred: Transferable[][] = [];
const borrowed: Float32Array[] = [];
let autoConsume = true;
let stopAt: { forward: number; reverse: number } | undefined;
const dispose = vi.fn<TrackingController['dispose']>();
const runModel = vi.fn<TrackingController['run']>();
const runSnapshot = vi.fn<TrackingController['runSnapshot']>();
const post = vi.fn<(message: InteractiveTrackingWorkerResponse, transfer?: Transferable[]) => void>();

function send(data: InteractiveTrackingWorkerRequest) {
  const scope = globalThis as unknown as { onmessage(event: MessageEvent<InteractiveTrackingWorkerRequest>): void };
  scope.onmessage({ data } as MessageEvent<InteractiveTrackingWorkerRequest>);
}

beforeEach(async () => {
  vi.resetModules();
  messages.length = 0;
  transferred.length = 0;
  borrowed.length = 0;
  autoConsume = true;
  stopAt = undefined;
  dispose.mockReset().mockResolvedValue();
  runSnapshot.mockReset();
  runModel.mockReset().mockImplementation(async (options: TrackingOptions): Promise<TrackingResult> => {
    const direction = options.direction!;
    const stop = direction === 1 ? options.frameCount - 1 : 0;
    let completedFrames = 0;
    for (let index = options.anchorIndex; (stop - index) * direction >= 0; index += direction) {
      options.signal?.throwIfAborted();
      const pixels = await options.readFrame(index, options.signal);
      expect(pixels).toEqual(Float32Array.of(0, 1, 2, 3));
      const native = Float32Array.of(-index - 0.5, 0.25, 0.5, index + 0.75);
      borrowed.push(native);
      const decision = await options.onFrame({
        index,
        direction,
        initial: index === options.anchorIndex,
        nativeLogits: native,
        lowLogits: new Float32Array(128 * 128),
        pointer: new Float32Array(256),
        objectScore: Float32Array.of(1),
        selectedIou: Float32Array.of(0.5),
      });
      expect(native.byteLength).toBe(16);
      expect(native[0]).toBe(-index - 0.5);
      options.onProgress?.({
        phase: 'frame-complete',
        index,
        direction,
        spatialMemories: 1,
        pointers: 1,
        retainedStateBytes: 132096,
        liveTensorBackingBytes: 0,
      });
      completedFrames++;
      if (decision === 'stop-direction') break;
    }
    return { completedFrames, direction, freshAnchor: true };
  });
  createModel.mockReset().mockImplementation(async ({ onProgress }) => {
    onProgress('encoder');
    return { run: runModel, runSnapshot, dispose };
  });
  post.mockReset().mockImplementation((message, transfer = []) => {
    const received = structuredClone(message, { transfer });
    if (received.type === 'frame') received.frame.nativeLogits = new Float32Array(received.frame.nativeLogits.buffer);
    messages.push(received);
    transferred.push(transfer);
    if (received.type === 'read-frame')
      queueMicrotask(() =>
        send({ type: 'source', requestId: received.requestId, pixels: Float32Array.of(0, 1, 2, 3) }),
      );
    if (received.type === 'frame' && autoConsume)
      queueMicrotask(() =>
        send({
          type: 'consumed',
          requestId: received.requestId,
          ...(stopAt?.[received.frame.direction === 1 ? 'forward' : 'reverse'] === received.frame.index
            ? { stopDirection: true as const }
            : {}),
        }),
      );
  });
  vi.stubGlobal('postMessage', post);
  vi.stubGlobal('onmessage', null);
  await import('../src/utils/segmentation/interactiveTracking.worker');
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('production interactive tracking worker runtime', () => {
  it.each(['wasm', 'hybrid', 'gpu-memory', 'webgpu'] as const)(
    'uses the explicit %s provider and fresh directions, copying only native logits',
    async (provider) => {
      send({ type: 'start', job: { ...job, provider } });
      await vi.waitFor(() => expect(messages.at(-1)).toEqual({ type: 'done', completedFrames: 4 }));
      expect(createModel).toHaveBeenCalledOnce();
      expect(runSnapshot).not.toHaveBeenCalled();
      expect(createModel.mock.calls[0][0]).toMatchObject({
        provider,
        wasmThreads: 1,
        signal: expect.any(AbortSignal),
      });
      expect(
        runModel.mock.calls.map(([options]) => [
          options.anchorIndex,
          options.direction,
          options.points,
          options.labels,
          options.sourceRange,
        ]),
      ).toEqual([
        [1, 1, job.points, job.labels, job.sourceRange],
        [1, -1, job.points, job.labels, job.sourceRange],
      ]);
      const frames = messages.filter((message) => message.type === 'frame');
      expect(frames.map(({ frame }) => [frame.index, frame.direction, frame.initial])).toEqual([
        [1, 1, true],
        [2, 1, false],
        [1, -1, true],
        [0, -1, false],
      ]);
      for (const [index, message] of frames.entries()) {
        expect(Object.keys(message.frame).sort()).toEqual(['direction', 'index', 'initial', 'nativeLogits']);
        expect(message.frame.nativeLogits).toEqual(borrowed[index]);
        expect(message.frame.nativeLogits.buffer).not.toBe(borrowed[index].buffer);
        expect(message.frame.nativeLogits.byteLength).toBe(16);
      }
      expect(
        transferred
          .filter((list) => list.length)
          .every((list) => list.length === 1 && (list[0] as ArrayBuffer).byteLength === 0),
      ).toBe(true);
      expect(
        messages.filter((message) => message.type === 'progress').map((message) => message.progress.phase),
      ).toContain('loading');
      expect(
        messages.filter((message) => message.type === 'progress').map((message) => message.progress.phase),
      ).toContain('frames');
      expect(dispose).toHaveBeenCalledOnce();
    },
  );

  it('honors acknowledged prefixes with fresh directions and reports actual endpoints only after release', async () => {
    stopAt = { forward: 4, reverse: 2 };
    const released = deferred<void>();
    dispose.mockReturnValue(released.promise);
    send({ type: 'start', job: { ...job, frameCount: 7, anchorIndex: 3, allowDirectionStop: true } });
    await vi.waitFor(() => expect(dispose).toHaveBeenCalledOnce());
    expect(
      messages.filter((message) => message.type === 'frame').map(({ frame }) => [frame.index, frame.direction]),
    ).toEqual([
      [3, 1],
      [4, 1],
      [3, -1],
      [2, -1],
    ]);
    expect(messages.filter((message) => message.type === 'read-frame').map(({ index }) => index)).toEqual([3, 4, 3, 2]);
    expect(
      runModel.mock.calls.map(([options]) => [options.frameCount, options.allowDirectionStop, options.sourceRange]),
    ).toEqual([
      [7, true, job.sourceRange],
      [7, true, job.sourceRange],
    ]);
    expect(messages.some((message) => message.type === 'done')).toBe(false);
    released.resolve();
    await vi.waitFor(() =>
      expect(messages.at(-1)).toEqual({
        type: 'done',
        completedFrames: 4,
        directionEndpoints: { forward: 4, reverse: 2 },
      }),
    );
    expect(createModel).toHaveBeenCalledOnce();
    expect(runSnapshot).not.toHaveBeenCalled();
  });

  it('reports natural endpoints for an opted run whose consumer never requests a stop', async () => {
    send({ type: 'start', job: { ...job, allowDirectionStop: true } });
    await vi.waitFor(() =>
      expect(messages.at(-1)).toEqual({
        type: 'done',
        completedFrames: 4,
        directionEndpoints: { forward: 2, reverse: 0 },
      }),
    );
    expect(dispose).toHaveBeenCalledOnce();
  });

  it.each([0, 1] as const)(
    'rejects stop permission with an off-anchor label%s before initializing a model',
    async (label) => {
      send({
        type: 'start',
        job: { ...job, allowDirectionStop: true, markedFrames: [{ index: 2, points: [[0, 0]], labels: [label] }] },
      });
      await vi.waitFor(() =>
        expect(messages.at(-1)).toMatchObject({
          type: 'error',
          message: expect.stringMatching(/single marked source plane/),
        }),
      );
      expect(createModel).not.toHaveBeenCalled();
      expect(
        messages.some(
          (message) => message.type === 'frame' || message.type === 'read-frame' || message.type === 'done',
        ),
      ).toBe(false);
    },
  );

  it('rejects false stop permission before model initialization', async () => {
    send({ type: 'start', job: { ...job, allowDirectionStop: false as never } });
    await vi.waitFor(() =>
      expect(messages.at(-1)).toMatchObject({ type: 'error', message: expect.stringMatching(/explicit permission/) }),
    );
    expect(createModel).not.toHaveBeenCalled();
  });

  it.each(['no-permission', 'anchor'] as const)(
    'rejects a stop ACK for %s and never starts another direction',
    async (invalid) => {
      stopAt = { forward: invalid === 'anchor' ? 1 : 2, reverse: 0 };
      send({ type: 'start', job: { ...job, ...(invalid === 'anchor' ? { allowDirectionStop: true as const } : {}) } });
      await vi.waitFor(() =>
        expect(messages.at(-1)).toMatchObject({
          type: 'error',
          message: expect.stringMatching(/explicit permission.*non-anchor/),
        }),
      );
      expect(runModel).toHaveBeenCalledOnce();
      expect(dispose).toHaveBeenCalledOnce();
      expect(messages.some((message) => message.type === 'done')).toBe(false);
    },
  );

  it('rejects malformed stop ACK values without reporting successful completion', async () => {
    autoConsume = false;
    send({ type: 'start', job: { ...job, allowDirectionStop: true } });
    await vi.waitFor(() => expect(messages.some((message) => message.type === 'frame')).toBe(true));
    const returned = messages.find((message) => message.type === 'frame')!;
    send({ type: 'consumed', requestId: returned.requestId, stopDirection: false as never });
    await vi.waitFor(() => expect(dispose).toHaveBeenCalledOnce());
    expect(messages.filter((message) => message.type === 'error')).toHaveLength(1);
    expect(messages.some((message) => message.type === 'done')).toBe(false);
  });

  it('does not request another plane until the current owned output is acknowledged', async () => {
    autoConsume = false;
    send({ type: 'start', job });
    await vi.waitFor(() => expect(messages.filter((message) => message.type === 'frame')).toHaveLength(1));
    expect(messages.filter((message) => message.type === 'read-frame')).toHaveLength(1);
    const first = messages.find((message) => message.type === 'frame')!;
    first.frame.nativeLogits[0] = 99;
    expect(borrowed[0][0]).toBe(-1.5);
    autoConsume = true;
    send({ type: 'consumed', requestId: first.requestId });
    await vi.waitFor(() => expect(messages.at(-1)).toEqual({ type: 'done', completedFrames: 4 }));
    expect(borrowed[0][0]).toBe(-1.5);
  });

  it('does not announce completion before every session has been released', async () => {
    const released = deferred<void>();
    dispose.mockReturnValue(released.promise);
    send({ type: 'start', job });
    await vi.waitFor(() => expect(dispose).toHaveBeenCalledOnce());
    expect(messages.some((message) => message.type === 'done')).toBe(false);
    released.resolve();
    await vi.waitFor(() => expect(messages.at(-1)).toEqual({ type: 'done', completedFrames: 4 }));
  });

  it('surfaces model creation failure without starting a source stream', async () => {
    createModel.mockRejectedValue(new Error('Runtime unavailable'));
    send({ type: 'start', job });
    await vi.waitFor(() => expect(messages.at(-1)).toEqual({ type: 'error', message: 'Runtime unavailable' }));
    expect(runModel).not.toHaveBeenCalled();
    expect(messages.some((message) => message.type === 'read-frame')).toBe(false);
  });

  it('rejects a second start and disposes a model that finishes initialization after the failure', async () => {
    const created = deferred<TrackingController>();
    createModel.mockReturnValue(created.promise);
    send({ type: 'start', job });
    send({ type: 'start', job });
    expect(messages.at(-1)).toMatchObject({ type: 'error', message: expect.stringMatching(/exactly one job/) });
    expect(createModel.mock.calls[0][0].signal.aborted).toBe(true);
    created.resolve({ run: runModel, runSnapshot, dispose });
    await vi.waitFor(() => expect(dispose).toHaveBeenCalledOnce());
    expect(runModel).not.toHaveBeenCalled();
    expect(messages.filter((message) => message.type === 'error')).toHaveLength(1);
  });

  it('rejects an out-of-order handshake without publishing a completed job', async () => {
    autoConsume = false;
    send({ type: 'start', job });
    await vi.waitFor(() => expect(messages.some((message) => message.type === 'frame')).toBe(true));
    send({ type: 'consumed', requestId: 999 });
    await vi.waitFor(() => expect(dispose).toHaveBeenCalledOnce());
    expect(messages.filter((message) => message.type === 'error')).toHaveLength(1);
    expect(messages.some((message) => message.type === 'done')).toBe(false);
    expect(runModel).toHaveBeenCalledOnce();
  });

  it('prepares corrections once without outputs, then streams both final directions and cached conditions', async () => {
    const markedFrames = [{ index: 2, points: [[1, 1]] as [number, number][], labels: [0] as (0 | 1)[] }];
    runSnapshot.mockImplementation(async (options) => {
      expect(options.markedFrames).toEqual(markedFrames);
      const progress = (stage: 'prepare' | 'final', index: number, direction: 1 | -1) =>
        options.onProgress?.({
          stage,
          phase: 'before-source-frame',
          index,
          direction,
          conditioningFrames: 2,
          spatialMemories: 2,
          pointers: 2,
          retainedStateBytes: 395312,
          liveTensorBackingBytes: 0,
        });
      for (const index of [1, 2]) {
        progress('prepare', index, 1);
        expect(await options.readFrame(index, options.signal)).toEqual(Float32Array.of(0, 1, 2, 3));
      }
      expect(messages.some((message) => message.type === 'frame')).toBe(false);
      for (const [index, direction] of [
        [1, 1],
        [2, 1],
        [1, -1],
        [0, -1],
      ] as const) {
        progress('final', index, direction);
        if (index === 0) await options.readFrame(index, options.signal);
        const native = new Float32Array(4).fill(index);
        borrowed.push(native);
        await options.onFrame({
          index,
          direction,
          initial: index === 1,
          nativeLogits: native,
          lowLogits: new Float32Array(128 * 128),
          pointer: new Float32Array(256),
          objectScore: Float32Array.of(1),
          selectedIou: Float32Array.of(0.5),
        });
        expect(native.byteLength).toBe(16);
      }
      return { completedFrames: 4 };
    });
    send({ type: 'start', job: { ...job, markedFrames } });
    await vi.waitFor(() => expect(messages.at(-1)).toEqual({ type: 'done', completedFrames: 4 }));
    expect(runSnapshot).toHaveBeenCalledOnce();
    expect(runModel).not.toHaveBeenCalled();
    expect(
      messages
        .filter((message) => message.type === 'read-frame')
        .map(({ index, direction, stage }) => [index, direction, stage]),
    ).toEqual([
      [1, 1, 'prepare'],
      [2, 1, 'prepare'],
      [0, -1, 'final'],
    ]);
    const frames = messages.filter((message) => message.type === 'frame');
    expect(frames.map(({ frame }) => [frame.index, frame.direction])).toEqual([
      [1, 1],
      [2, 1],
      [1, -1],
      [0, -1],
    ]);
    for (const [index, message] of frames.entries()) {
      expect(message.frame.nativeLogits).toEqual(borrowed[index]);
      expect(message.frame.nativeLogits.buffer).not.toBe(borrowed[index].buffer);
    }
    const phases = messages.filter((message) => message.type === 'progress').map((message) => message.progress.phase);
    expect(phases).toContain('preparing');
    expect(phases).toContain('frames');
    expect(dispose).toHaveBeenCalledOnce();
  });

  it('releases the snapshot model after preparation fails and publishes no provisional masks', async () => {
    runSnapshot.mockImplementation(async (options) => {
      options.onProgress?.({
        stage: 'prepare',
        phase: 'before-source-frame',
        index: 1,
        direction: 1,
        conditioningFrames: 0,
        spatialMemories: 0,
        pointers: 0,
        retainedStateBytes: 0,
        liveTensorBackingBytes: 0,
      });
      await options.readFrame(1, options.signal);
      throw new Error('preparation failed');
    });
    send({ type: 'start', job: { ...job, markedFrames: [{ index: 2, points: [[1, 1]], labels: [0] }] } });
    await vi.waitFor(() => expect(messages.at(-1)).toEqual({ type: 'error', message: 'preparation failed' }));
    expect(runModel).not.toHaveBeenCalled();
    expect(dispose).toHaveBeenCalledOnce();
    expect(messages.some((message) => message.type === 'frame' || message.type === 'done')).toBe(false);
  });
});
