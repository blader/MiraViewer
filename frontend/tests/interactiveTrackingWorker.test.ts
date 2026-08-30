import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { deferred } from './helpers/deferred';
import { InteractiveTrackingWorker, TRACKING_INACTIVITY_MS } from '../src/utils/segmentation/interactiveTrackingWorker';
import type { TrackingFrameDecision } from '../src/utils/segmentation/interactiveTracking';
import type {
  InteractiveTrackingFrame,
  InteractiveTrackingWorkerOptions,
  InteractiveTrackingWorkerRequest,
  InteractiveTrackingWorkerResponse,
} from '../src/utils/segmentation/interactiveTrackingWorker';

class MockWorker {
  static instances: MockWorker[] = [];
  onmessage: ((event: MessageEvent<InteractiveTrackingWorkerResponse>) => void) | null = null;
  onerror: (() => void) | null = null;
  onmessageerror: (() => void) | null = null;
  messages: InteractiveTrackingWorkerRequest[] = [];
  transfers: Transferable[][] = [];
  terminate = vi.fn();
  constructor() {
    MockWorker.instances.push(this);
  }
  postMessage(message: InteractiveTrackingWorkerRequest, transfer: Transferable[] = []) {
    const received = structuredClone(message, { transfer });
    if (received.type === 'source') received.pixels = new Float32Array(received.pixels.buffer);
    this.messages.push(received);
    this.transfers.push(transfer);
  }
  respond(message: InteractiveTrackingWorkerResponse) {
    this.onmessage?.({ data: message } as MessageEvent<InteractiveTrackingWorkerResponse>);
  }
}

function options(overrides: Partial<InteractiveTrackingWorkerOptions> = {}): InteractiveTrackingWorkerOptions {
  return {
    width: 2,
    height: 2,
    frameCount: 1,
    anchorIndex: 0,
    sourceRange: [0, 3],
    points: [
      [0, 0],
      [1, 1],
    ],
    labels: [1, 0],
    provider: 'wasm',
    readFrame: async () => Float32Array.of(0, 1, 2, 3),
    onFrame: () => {},
    ...overrides,
  };
}

function frame(index = 0, direction: 1 | -1 = 1): InteractiveTrackingFrame {
  return { index, direction, initial: index === 0, nativeLogits: Float32Array.of(-0.5, 0.3, 4, -1) };
}

async function flush() {
  await Promise.resolve();
  await Promise.resolve();
}
async function deliver(worker: MockWorker, requestId: number, direction: 1 | -1) {
  worker.respond({ type: 'read-frame', requestId, index: 0, direction });
  await flush();
  worker.respond({ type: 'frame', requestId: requestId + 1, frame: frame(0, direction) });
  await flush();
}

async function deliverAt(worker: MockWorker, requestId: number, index: number, direction: 1 | -1, anchor = 3) {
  worker.respond({ type: 'read-frame', requestId, index, direction });
  await flush();
  worker.respond({
    type: 'frame',
    requestId: requestId + 1,
    frame: { ...frame(index, direction), initial: index === anchor },
  });
  await flush();
}

let runner: InteractiveTrackingWorker;
beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal('Worker', MockWorker);
  MockWorker.instances = [];
  runner = new InteractiveTrackingWorker();
});
afterEach(() => {
  runner.dispose();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('dedicated interactive tracking transport', () => {
  it('validates both acknowledged prefixes and returns true endpoints without inventing skipped frames', async () => {
    const readFrame = vi.fn(async () => new Float32Array(4));
    const onFrame = vi.fn<InteractiveTrackingWorkerOptions['onFrame']>((value) => {
      if (value.index === (value.direction === 1 ? 4 : 2)) return 'stop-direction';
    });
    const run = runner.run(options({ frameCount: 7, anchorIndex: 3, allowDirectionStop: true, readFrame, onFrame }));
    const worker = MockWorker.instances[0];
    expect(worker.messages[0]).toMatchObject({
      type: 'start',
      job: { frameCount: 7, anchorIndex: 3, allowDirectionStop: true, sourceRange: [0, 3] },
    });
    let id = 1;
    for (const [index, direction] of [
      [3, 1],
      [4, 1],
      [3, -1],
      [2, -1],
    ] as const) {
      await deliverAt(worker, id, index, direction);
      id += 2;
    }
    expect(worker.messages.filter((message) => message.type === 'consumed')).toEqual([
      { type: 'consumed', requestId: 2 },
      { type: 'consumed', requestId: 4, stopDirection: true },
      { type: 'consumed', requestId: 6 },
      { type: 'consumed', requestId: 8, stopDirection: true },
    ]);
    worker.respond({ type: 'done', completedFrames: 4, directionEndpoints: { forward: 4, reverse: 2 } });
    await expect(run).resolves.toEqual({ completedFrames: 4, directionEndpoints: { forward: 4, reverse: 2 } });
    expect(readFrame.mock.calls.map(([index]) => index)).toEqual([3, 4, 3, 2]);
    expect(onFrame).toHaveBeenCalledTimes(4);
    expect(worker.terminate).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('derives stop endpoints from validated metadata even if the consumer mutates its owned frame object', async () => {
    const run = runner.run(
      options({
        frameCount: 7,
        anchorIndex: 3,
        allowDirectionStop: true,
        onFrame(value) {
          if (!value.initial) {
            value.index = 1000;
            value.direction = 1;
            return 'stop-direction';
          }
        },
      }),
    );
    const worker = MockWorker.instances[0];
    let id = 1;
    for (const [index, direction] of [
      [3, 1],
      [4, 1],
      [3, -1],
      [2, -1],
    ] as const) {
      await deliverAt(worker, id, index, direction);
      id += 2;
    }
    worker.respond({ type: 'done', completedFrames: 4, directionEndpoints: { forward: 4, reverse: 2 } });
    await expect(run).resolves.toEqual({ completedFrames: 4, directionEndpoints: { forward: 4, reverse: 2 } });
  });

  it('rejects endpoint metadata on a default full-result protocol', async () => {
    const run = runner.run(options());
    const rejected = expect(run).rejects.toThrow(/before every source plane/);
    const worker = MockWorker.instances[0];
    await deliver(worker, 1, 1);
    await deliver(worker, 3, -1);
    worker.respond({ type: 'done', completedFrames: 2, directionEndpoints: { forward: 0, reverse: 0 } });
    await rejected;
    expect(worker.terminate).toHaveBeenCalledOnce();
  });

  it.each([
    { stopForward: true, stopReverse: false, forward: 4, reverse: 0 },
    { stopForward: false, stopReverse: true, forward: 6, reverse: 2 },
    { stopForward: false, stopReverse: false, forward: 6, reverse: 0 },
  ])(
    'supports independently stopped or natural endpoints: %j',
    async ({ stopForward, stopReverse, forward, reverse }) => {
      const run = runner.run(
        options({
          frameCount: 7,
          anchorIndex: 3,
          allowDirectionStop: true,
          onFrame(value) {
            if (
              (stopForward && value.direction === 1 && value.index === 4) ||
              (stopReverse && value.direction === -1 && value.index === 2)
            )
              return 'stop-direction';
          },
        }),
      );
      const worker = MockWorker.instances[0];
      let id = 1;
      for (const direction of [1, -1] as const) {
        const end = direction === 1 ? forward : reverse;
        for (let index = 3; (end - index) * direction >= 0; index += direction) {
          await deliverAt(worker, id, index, direction);
          id += 2;
        }
      }
      const completedFrames = forward - reverse + 2;
      worker.respond({ type: 'done', completedFrames, directionEndpoints: { forward, reverse } });
      await expect(run).resolves.toEqual({ completedFrames, directionEndpoints: { forward, reverse } });
    },
  );

  it('accepts a certified stop at the natural end without claiming extra skipped deliveries', async () => {
    const run = runner.run(
      options({
        frameCount: 3,
        anchorIndex: 1,
        allowDirectionStop: true,
        onFrame(value) {
          if (!value.initial) return 'stop-direction';
        },
      }),
    );
    const worker = MockWorker.instances[0];
    let id = 1;
    for (const [index, direction] of [
      [1, 1],
      [2, 1],
      [1, -1],
      [0, -1],
    ] as const) {
      await deliverAt(worker, id, index, direction, 1);
      id += 2;
    }
    worker.respond({ type: 'done', completedFrames: 4, directionEndpoints: { forward: 2, reverse: 0 } });
    await expect(run).resolves.toEqual({ completedFrames: 4, directionEndpoints: { forward: 2, reverse: 0 } });
  });

  it.each(['missing-opt-in', 'anchor'] as const)(
    'rejects a consumer stop for %s before sending a stop ACK',
    async (invalid) => {
      const run = runner.run(
        options({
          frameCount: 7,
          anchorIndex: 3,
          ...(invalid === 'anchor' ? { allowDirectionStop: true as const } : {}),
          onFrame(value) {
            if (invalid === 'anchor' || !value.initial) return 'stop-direction';
          },
        }),
      );
      const rejected = expect(run).rejects.toThrow(/explicit permission.*non-anchor/);
      const worker = MockWorker.instances[0];
      await deliverAt(worker, 1, 3, 1);
      if (invalid !== 'anchor') await deliverAt(worker, 3, 4, 1);
      await rejected;
      expect(worker.messages.some((message) => message.type === 'consumed' && message.stopDirection)).toBe(false);
      expect(worker.terminate).toHaveBeenCalledOnce();
    },
  );

  it.each([0, 1] as const)('rejects opted off-anchor label%s before creating a worker', async (label) => {
    await expect(
      runner.run(
        options({
          frameCount: 7,
          anchorIndex: 3,
          allowDirectionStop: true,
          markedFrames: [{ index: 4, points: [[0, 0]], labels: [label] }],
        }),
      ),
    ).rejects.toThrow(/single marked source plane/);
    expect(MockWorker.instances).toHaveLength(0);
  });

  it.each([
    { completedFrames: 4 },
    { completedFrames: 8, directionEndpoints: { forward: 4, reverse: 2 } },
    { completedFrames: 4, directionEndpoints: { forward: 6, reverse: 2 } },
    { completedFrames: 4, directionEndpoints: { forward: 4, reverse: 0 } },
  ])("rejects terminal coverage not derived from this owner's ACKs: %j", async (terminal) => {
    const run = runner.run(
      options({
        frameCount: 7,
        anchorIndex: 3,
        allowDirectionStop: true,
        onFrame(value) {
          if (!value.initial) return 'stop-direction';
        },
      }),
    );
    const rejected = expect(run).rejects.toThrow(/before every source plane/);
    const worker = MockWorker.instances[0];
    let id = 1;
    for (const [index, direction] of [
      [3, 1],
      [4, 1],
      [3, -1],
      [2, -1],
    ] as const) {
      await deliverAt(worker, id, index, direction);
      id += 2;
    }
    worker.respond({ type: 'done', ...terminal });
    await rejected;
    expect(worker.terminate).toHaveBeenCalledOnce();
  });

  it.each(['continued-forward', 'skipped-reverse-anchor', 'continued-reverse'] as const)(
    'rejects %s after acknowledged stops',
    async (invalid) => {
      const readFrame = vi.fn(async () => new Float32Array(4));
      const run = runner.run(
        options({
          frameCount: 7,
          anchorIndex: 3,
          allowDirectionStop: true,
          readFrame,
          onFrame(value) {
            if (!value.initial) return 'stop-direction';
          },
        }),
      );
      const rejected = expect(run).rejects.toThrow(/out-of-order/);
      const worker = MockWorker.instances[0];
      await deliverAt(worker, 1, 3, 1);
      await deliverAt(worker, 3, 4, 1);
      if (invalid === 'continued-reverse') {
        await deliverAt(worker, 5, 3, -1);
        await deliverAt(worker, 7, 2, -1);
      }
      const before = readFrame.mock.calls.length;
      worker.respond({
        type: 'read-frame',
        requestId: invalid === 'continued-reverse' ? 9 : 5,
        index: invalid === 'continued-forward' ? 5 : invalid === 'continued-reverse' ? 1 : 2,
        direction: invalid === 'continued-forward' ? 1 : -1,
      });
      await rejected;
      expect(readFrame).toHaveBeenCalledTimes(before);
    },
  );

  it('rejects a terminal reply while a stop decision remains unacknowledged', async () => {
    const sink = deferred<TrackingFrameDecision>();
    const run = runner.run(
      options({
        frameCount: 7,
        anchorIndex: 3,
        allowDirectionStop: true,
        onFrame(value) {
          if (!value.initial) return sink.promise;
        },
      }),
    );
    const rejected = expect(run).rejects.toThrow(/before every source plane/);
    const worker = MockWorker.instances[0];
    await deliverAt(worker, 1, 3, 1);
    await deliverAt(worker, 3, 4, 1);
    worker.respond({ type: 'done', completedFrames: 4, directionEndpoints: { forward: 4, reverse: 2 } });
    await rejected;
    const before = worker.messages.length;
    sink.resolve('stop-direction');
    await flush();
    expect(worker.messages).toHaveLength(before);
    expect(worker.terminate).toHaveBeenCalledOnce();
  });

  it('does not send a late stop ACK after cancel or damage the immediate replacement job', async () => {
    const abort = new AbortController(),
      sink = deferred<TrackingFrameDecision>();
    const run = runner.run(
      options({
        frameCount: 7,
        anchorIndex: 3,
        allowDirectionStop: true,
        signal: abort.signal,
        onFrame(value) {
          if (!value.initial) return sink.promise;
        },
      }),
    );
    const rejected = expect(run).rejects.toMatchObject({ name: 'AbortError' });
    const old = MockWorker.instances[0];
    await deliverAt(old, 1, 3, 1);
    await deliverAt(old, 3, 4, 1);
    abort.abort();
    await rejected;
    const before = old.messages.length;
    const replacement = runner.run(options());
    const current = MockWorker.instances[1];
    sink.resolve('stop-direction');
    await flush();
    expect(old.messages).toHaveLength(before);
    expect(current.terminate).not.toHaveBeenCalled();
    await deliver(current, 1, 1);
    await deliver(current, 3, -1);
    current.respond({ type: 'done', completedFrames: 2 });
    await expect(replacement).resolves.toEqual({ completedFrames: 2 });
    expect(old.terminate).toHaveBeenCalledOnce();
    expect(current.terminate).toHaveBeenCalledOnce();
  });

  it.each(['hybrid', 'gpu-memory'] as const)(
    'forwards the explicit %s policy unchanged through the worker job',
    async (provider) => {
      const run = runner.run(options({ provider }));
      const worker = MockWorker.instances[0];
      expect(worker.messages[0]).toMatchObject({ type: 'start', job: { provider } });
      await deliver(worker, 1, 1);
      await deliver(worker, 3, -1);
      worker.respond({ type: 'done', completedFrames: 2 });
      await expect(run).resolves.toEqual({ completedFrames: 2 });
      expect(worker.terminate).toHaveBeenCalledOnce();
    },
  );

  it('snapshots only explicit source metadata/prompts and copies a tight frame without detaching MRI', async () => {
    const backing = new Float32Array(40).fill(99);
    const pixels = backing.subarray(10, 14);
    pixels.set([0, 1, 2, 3]);
    const points: [number, number][] = [
      [0, 0],
      [1, 1],
    ];
    const labels: (0 | 1)[] = [1, 0];
    const range: [number, number] = [0, 3];
    const request = options({ points, labels, sourceRange: range, readFrame: async () => pixels });
    const run = runner.run(request);
    const rejection = expect(run).rejects.toMatchObject({ name: 'AbortError' });
    points[0][0] = 100;
    labels[0] = 0;
    range[1] = 100;
    request.width = 100;
    const worker = MockWorker.instances[0];
    expect(worker.messages[0]).toEqual({
      type: 'start',
      job: {
        width: 2,
        height: 2,
        frameCount: 1,
        anchorIndex: 0,
        sourceRange: [0, 3],
        points: [
          [0, 0],
          [1, 1],
        ],
        labels: [1, 0],
        provider: 'wasm',
      },
    });
    worker.respond({ type: 'read-frame', requestId: 1, index: 0, direction: 1 });
    await flush();
    const message = worker.messages[1];
    expect(message.type).toBe('source');
    if (message.type !== 'source') throw new Error('Missing source frame');
    expect(message.pixels).toEqual(Float32Array.of(0, 1, 2, 3));
    expect(message.pixels.buffer.byteLength).toBe(16);
    expect(message.pixels.buffer).not.toBe(backing.buffer);
    expect((worker.transfers[1][0] as ArrayBuffer).byteLength).toBe(0);
    expect(backing.byteLength).toBe(160);
    expect(backing[9]).toBe(99);
    expect(pixels).toEqual(Float32Array.of(0, 1, 2, 3));
    runner.dispose();
    await rejection;
    expect(worker.terminate).toHaveBeenCalledOnce();
  });

  it('waits for source and owned-output consumers, includes both anchors, and tears down on completion', async () => {
    const source = deferred<Float32Array>();
    const sink = deferred<void>();
    const readFrame = vi
      .fn()
      .mockReturnValueOnce(source.promise)
      .mockResolvedValue(Float32Array.of(0, 1, 2, 3));
    const received: InteractiveTrackingFrame[] = [];
    const run = runner.run(
      options({
        readFrame,
        onFrame: async (output) => {
          received.push(output);
          if (received.length === 1) await sink.promise;
        },
      }),
    );
    const worker = MockWorker.instances[0];
    worker.respond({ type: 'read-frame', requestId: 1, index: 0, direction: 1 });
    expect(readFrame).toHaveBeenCalledOnce();
    expect(worker.messages).toHaveLength(1);
    source.resolve(Float32Array.of(0, 1, 2, 3));
    await flush();
    const first = frame();
    worker.respond({ type: 'frame', requestId: 2, frame: first });
    await flush();
    expect(received[0]).toBe(first);
    expect(worker.messages).toHaveLength(2);
    first.nativeLogits[0] = -7; // This is the consumer's owned copy, not a borrowed model tensor.
    sink.resolve();
    await flush();
    expect(worker.messages[2]).toEqual({ type: 'consumed', requestId: 2 });
    await deliver(worker, 3, -1);
    expect(received.map((output) => [output.index, output.direction])).toEqual([
      [0, 1],
      [0, -1],
    ]);
    worker.respond({ type: 'done', completedFrames: 2 });
    await expect(run).resolves.toEqual({ completedFrames: 2 });
    expect(worker.terminate).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
    expect(readFrame.mock.calls[0][1].aborted).toBe(true);
    runner.dispose();
    expect(worker.terminate).toHaveBeenCalledOnce();
  });

  it.each(['loading', 'source', 'output'] as const)(
    'cancels promptly during %s and ignores late callbacks from that worker',
    async (stage) => {
      const abort = new AbortController();
      const source = deferred<Float32Array>();
      const sink = deferred<void>();
      const onFrame = vi.fn(() => sink.promise);
      const run = runner.run(
        options({
          signal: abort.signal,
          readFrame: () => (stage === 'source' ? source.promise : Float32Array.of(0, 1, 2, 3)),
          onFrame,
        }),
      );
      const rejection = expect(run).rejects.toMatchObject({ name: 'AbortError' });
      const old = MockWorker.instances[0];
      const stale = old.onmessage!;
      const crash = old.onerror!;
      if (stage !== 'loading') old.respond({ type: 'read-frame', requestId: 1, index: 0, direction: 1 });
      if (stage === 'output') {
        await flush();
        old.respond({ type: 'frame', requestId: 2, frame: frame() });
      }
      abort.abort();
      await rejection;
      expect(old.terminate).toHaveBeenCalledOnce();
      const newer = runner.run(options());
      const current = MockWorker.instances[1];
      const oldMessages = old.messages.length;
      source.resolve(Float32Array.of(0, 1, 2, 3));
      sink.resolve();
      stale({ data: { type: 'done', completedFrames: 2 } } as MessageEvent<InteractiveTrackingWorkerResponse>);
      crash();
      await flush();
      expect(old.messages).toHaveLength(oldMessages);
      expect(current.terminate).not.toHaveBeenCalled();
      await deliver(current, 1, 1);
      await deliver(current, 3, -1);
      current.respond({ type: 'done', completedFrames: 2 });
      await newer;
      expect(onFrame).toHaveBeenCalledTimes(stage === 'output' ? 1 : 0);
    },
  );

  it('rejects concurrent runs without replacing the owned worker', async () => {
    const first = runner.run(options());
    const rejection = expect(first).rejects.toMatchObject({ name: 'AbortError' });
    await expect(runner.run(options())).rejects.toThrow(/one interactive selection job/);
    expect(MockWorker.instances).toHaveLength(1);
    expect(MockWorker.instances[0].terminate).not.toHaveBeenCalled();
    runner.dispose();
    await rejection;
  });

  it('accepts the complete forward/reverse schedule around a nonzero anchor without filtering duplicates', async () => {
    const readFrame = vi.fn<InteractiveTrackingWorkerOptions['readFrame']>(async () => new Float32Array(4));
    const onFrame = vi.fn();
    const run = runner.run(options({ frameCount: 4, anchorIndex: 2, readFrame, onFrame }));
    const worker = MockWorker.instances[0];
    let requestId = 0;
    for (const [index, direction] of [
      [2, 1],
      [3, 1],
      [2, -1],
      [1, -1],
      [0, -1],
    ] as const) {
      worker.respond({ type: 'read-frame', requestId: ++requestId, index, direction });
      await flush();
      worker.respond({
        type: 'frame',
        requestId: ++requestId,
        frame: { ...frame(index, direction), initial: index === 2 },
      });
      await flush();
    }
    worker.respond({ type: 'done', completedFrames: 5 });
    await expect(run).resolves.toEqual({ completedFrames: 5 });
    expect(readFrame.mock.calls.map(([index]) => index)).toEqual([2, 3, 2, 1, 0]);
    expect(onFrame.mock.calls.map(([output]) => output.index)).toEqual([2, 3, 2, 1, 0]);
  });

  it('rejects invalid output before its consumer and closes the owned worker', async () => {
    const onFrame = vi.fn();
    const run = runner.run(options({ onFrame }));
    const rejection = expect(run).rejects.toThrow(/invalid source-grid prediction/);
    const worker = MockWorker.instances[0];
    worker.respond({ type: 'read-frame', requestId: 1, index: 0, direction: 1 });
    await flush();
    worker.respond({ type: 'frame', requestId: 2, frame: { ...frame(), nativeLogits: Float32Array.of(NaN, 1, 2, 3) } });
    await rejection;
    expect(onFrame).not.toHaveBeenCalled();
    expect(worker.terminate).toHaveBeenCalledOnce();
  });

  it('cleans the worker and timer if the first postMessage fails', async () => {
    vi.spyOn(MockWorker.prototype, 'postMessage').mockImplementationOnce(() => {
      throw new Error('message failed');
    });
    await expect(runner.run(options())).rejects.toThrow('message failed');
    expect(MockWorker.instances[0].terminate).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([
    { width: 0 },
    { anchorIndex: 1 },
    { sourceRange: [1, 1] as const },
    { points: [] },
    { points: [[Infinity, 0]] as [number, number][] },
    {
      points: [
        [-0.01, 0],
        [1, 1],
      ] as [number, number][],
    },
    {
      points: [
        [2, 0],
        [1, 1],
      ] as [number, number][],
    },
    {
      points: [
        [0, -0.01],
        [1, 1],
      ] as [number, number][],
    },
    {
      points: [
        [0, 2],
        [1, 1],
      ] as [number, number][],
    },
    { labels: [1] as const },
    { provider: 'automatic' as 'wasm' },
    { allowDirectionStop: false as never },
  ])('validates before creating or posting to a worker: %j', async (invalid) => {
    await expect(runner.run(options(invalid))).rejects.toThrow();
    expect(MockWorker.instances).toHaveLength(0);
  });

  it('accepts literal in-grid subpixel coordinates without rounding them', async () => {
    const run = runner.run(
      options({
        points: [
          [0.25, 1.75],
          [1.5, 0.5],
        ],
      }),
    );
    const rejection = expect(run).rejects.toMatchObject({ name: 'AbortError' });
    expect(MockWorker.instances[0].messages[0]).toMatchObject({
      type: 'start',
      job: {
        points: [
          [0.25, 1.75],
          [1.5, 0.5],
        ],
      },
    });
    runner.dispose();
    await rejection;
  });

  it('accepts preparation source handshakes but publishes only the complete final frame schedule', async () => {
    const markedFrames = [{ index: 2, points: [[0.5, 1.25]] as [number, number][], labels: [0] as (0 | 1)[] }];
    const readFrame = vi.fn<InteractiveTrackingWorkerOptions['readFrame']>(async () => new Float32Array(4));
    const onFrame = vi.fn();
    const run = runner.run(options({ frameCount: 3, anchorIndex: 1, markedFrames, readFrame, onFrame }));
    const worker = MockWorker.instances[0];
    markedFrames[0].points[0][0] = 100;
    markedFrames[0].labels[0] = 1;
    expect(worker.messages[0]).toMatchObject({
      type: 'start',
      job: { markedFrames: [{ index: 2, points: [[0.5, 1.25]], labels: [0] }] },
    });
    for (const [requestId, index] of [
      [1, 1],
      [2, 2],
    ]) {
      worker.respond({ type: 'read-frame', stage: 'prepare', requestId, index, direction: 1 });
      await flush();
    }
    expect(onFrame).not.toHaveBeenCalled();
    let requestId = 2;
    for (const [index, direction] of [
      [1, 1],
      [2, 1],
      [1, -1],
      [0, -1],
    ] as const) {
      if (index === 0) {
        worker.respond({ type: 'read-frame', stage: 'final', requestId: ++requestId, index, direction });
        await flush();
      }
      worker.respond({
        type: 'frame',
        requestId: ++requestId,
        frame: { ...frame(index, direction), initial: index === 1 },
      });
      await flush();
    }
    worker.respond({ type: 'done', completedFrames: 4 });
    await expect(run).resolves.toEqual({ completedFrames: 4 });
    expect(readFrame.mock.calls.map(([index]) => index)).toEqual([1, 2, 0]);
    expect(onFrame.mock.calls.map(([output]) => [output.index, output.direction])).toEqual([
      [1, 1],
      [2, 1],
      [1, -1],
      [0, -1],
    ]);
    expect(worker.terminate).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('checks forward-then-reverse preparation ordering without inventing extra source planes', async () => {
    const readFrame = vi.fn<InteractiveTrackingWorkerOptions['readFrame']>(async () => new Float32Array(4));
    const run = runner.run(
      options({
        frameCount: 7,
        anchorIndex: 3,
        readFrame,
        markedFrames: [
          { index: 1, points: [[0, 0]], labels: [1] },
          { index: 5, points: [[1, 1]], labels: [0] },
        ],
      }),
    );
    const rejection = expect(run).rejects.toMatchObject({ name: 'AbortError' });
    const worker = MockWorker.instances[0];
    let requestId = 0;
    for (const [index, direction] of [
      [3, 1],
      [4, 1],
      [5, 1],
      [2, -1],
      [1, -1],
    ] as const) {
      worker.respond({ type: 'read-frame', stage: 'prepare', requestId: ++requestId, index, direction });
      await flush();
    }
    expect(readFrame.mock.calls.map(([index]) => index)).toEqual([3, 4, 5, 2, 1]);
    expect(worker.terminate).not.toHaveBeenCalled();
    runner.dispose();
    await rejection;
  });

  it.each(['provisional-output', 'skipped-preparation', 'duplicate-source'] as const)(
    'rejects %s before publishing a correction snapshot',
    async (failure) => {
      const onFrame = vi.fn();
      const run = runner.run(
        options({
          frameCount: 3,
          anchorIndex: 1,
          onFrame,
          markedFrames: [{ index: 2, points: [[1, 1]], labels: [0] }],
        }),
      );
      const rejection = expect(run).rejects.toThrow(/out-of-order/);
      const worker = MockWorker.instances[0];
      if (failure === 'provisional-output')
        worker.respond({ type: 'frame', requestId: 1, frame: { ...frame(1, 1), initial: true } });
      else if (failure === 'skipped-preparation')
        worker.respond({ type: 'read-frame', stage: 'final', requestId: 1, index: 1, direction: 1 });
      else {
        worker.respond({ type: 'read-frame', stage: 'prepare', requestId: 1, index: 1, direction: 1 });
        await flush();
        worker.respond({ type: 'read-frame', stage: 'prepare', requestId: 2, index: 1, direction: 1 });
      }
      await rejection;
      expect(onFrame).not.toHaveBeenCalled();
      expect(worker.terminate).toHaveBeenCalledOnce();
    },
  );

  it('terminates an in-flight preparation read and ignores its late source buffer', async () => {
    const source = deferred<Float32Array>();
    const abort = new AbortController();
    const onFrame = vi.fn();
    const run = runner.run(
      options({
        frameCount: 3,
        anchorIndex: 1,
        signal: abort.signal,
        readFrame: () => source.promise,
        onFrame,
        markedFrames: [{ index: 2, points: [[1, 1]], labels: [0] }],
      }),
    );
    const rejection = expect(run).rejects.toMatchObject({ name: 'AbortError' });
    const worker = MockWorker.instances[0];
    worker.respond({ type: 'read-frame', stage: 'prepare', requestId: 1, index: 1, direction: 1 });
    abort.abort();
    await rejection;
    source.resolve(new Float32Array(4));
    await flush();
    expect(worker.messages).toHaveLength(1);
    expect(onFrame).not.toHaveBeenCalled();
    expect(worker.terminate).toHaveBeenCalledOnce();
  });

  it.each([
    [{ index: 1, points: [[2, 0]], labels: [0] }],
    [{ index: 3, points: [[0, 0]], labels: [1] }],
    [
      { index: 1, points: [[0, 0]], labels: [1] },
      { index: 1, points: [[1, 1]], labels: [0] },
    ],
    [{ index: 0, points: [[1, 0]], labels: [1] }],
  ] satisfies NonNullable<InteractiveTrackingWorkerOptions['markedFrames']>[])(
    'rejects invalid marked-plane records before worker creation: %j',
    async (...markedFrames) => {
      await expect(runner.run(options({ frameCount: 3, markedFrames }))).rejects.toThrow();
      expect(MockWorker.instances).toHaveLength(0);
    },
  );

  it('does not create a worker for an already-aborted request', async () => {
    await expect(runner.run(options({ signal: AbortSignal.abort() }))).rejects.toMatchObject({ name: 'AbortError' });
    expect(MockWorker.instances).toHaveLength(0);
  });

  it.each(['source', 'sink', 'progress', 'crash', 'decode', 'model'] as const)(
    'terminates the owned worker on %s failure',
    async (failure) => {
      const run = runner.run(
        options({
          readFrame: async () => {
            if (failure === 'source') throw new Error('source failed');
            return new Float32Array(4);
          },
          onFrame: () => {
            if (failure === 'sink') throw new Error('sink failed');
          },
          onProgress: () => {
            if (failure === 'progress') throw new Error('progress failed');
          },
        }),
      );
      const rejection = expect(run).rejects.toThrow();
      const worker = MockWorker.instances[0];
      if (failure === 'crash') worker.onerror!();
      else if (failure === 'decode') worker.onmessageerror!();
      else if (failure === 'model') worker.respond({ type: 'error', message: 'WebGPU unavailable' });
      else if (failure === 'progress')
        worker.respond({ type: 'progress', progress: { phase: 'loading', asset: 'encoder' } });
      else {
        worker.respond({ type: 'read-frame', requestId: 1, index: 0, direction: 1 });
        await flush();
        if (failure === 'sink') worker.respond({ type: 'frame', requestId: 2, frame: frame() });
      }
      await rejection;
      expect(worker.terminate).toHaveBeenCalledOnce();
      expect(vi.getTimerCount()).toBe(0);
    },
  );

  it.each(['short', 'nonfinite'] as const)('rejects %s source planes without transferring them', async (kind) => {
    const run = runner.run(
      options({ readFrame: async () => (kind === 'short' ? new Float32Array(1) : new Float32Array(4).fill(NaN)) }),
    );
    const rejection = expect(run).rejects.toThrow(/complete, finite original source plane/);
    const worker = MockWorker.instances[0];
    worker.respond({ type: 'read-frame', requestId: 1, index: 0, direction: 1 });
    await rejection;
    expect(worker.messages).toHaveLength(1);
    expect(worker.terminate).toHaveBeenCalledOnce();
  });

  it('fails closed on overlapping reads and early completion, with no queued MRI planes', async () => {
    const source = deferred<Float32Array>();
    const readFrame = vi.fn(() => source.promise);
    const run = runner.run(options({ readFrame }));
    const rejection = expect(run).rejects.toThrow(/out-of-order/);
    const worker = MockWorker.instances[0];
    worker.respond({ type: 'read-frame', requestId: 1, index: 0, direction: 1 });
    worker.respond({ type: 'read-frame', requestId: 2, index: 0, direction: 1 });
    await rejection;
    expect(readFrame).toHaveBeenCalledOnce();
    source.resolve(new Float32Array(4));
    await flush();
    expect(worker.messages).toHaveLength(1);
    const next = runner.run(options());
    const early = expect(next).rejects.toThrow(/before every source plane/);
    MockWorker.instances[1].respond({ type: 'done', completedFrames: 2 });
    await early;
  });

  it('uses an inactivity deadline, not a total run cap, and aborts the owned source on silence', async () => {
    const source = deferred<Float32Array>();
    let sourceSignal: AbortSignal | undefined;
    const run = runner.run(
      options({
        readFrame: (_index, signal) => {
          sourceSignal = signal;
          return source.promise;
        },
      }),
    );
    const rejection = expect(run).rejects.toThrow(/stopped responding/);
    const worker = MockWorker.instances[0];
    for (let interval = 0; interval < 3; interval++) {
      await vi.advanceTimersByTimeAsync(TRACKING_INACTIVITY_MS - 1);
      worker.respond({ type: 'progress', progress: { phase: 'loading', asset: 'encoder' } });
      expect(worker.terminate).not.toHaveBeenCalled();
    }
    worker.respond({ type: 'read-frame', requestId: 1, index: 0, direction: 1 });
    await vi.advanceTimersByTimeAsync(TRACKING_INACTIVITY_MS);
    await rejection;
    expect(sourceSignal?.aborted).toBe(true);
    expect(worker.terminate).toHaveBeenCalledOnce();
    source.resolve(new Float32Array(4));
    await flush();
    expect(worker.messages).toHaveLength(1);
  });
});
