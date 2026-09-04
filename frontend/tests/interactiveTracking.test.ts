import { Tensor } from 'onnxruntime-web';
import type * as Ort from 'onnxruntime-web';
import { describe, expect, it, vi } from 'vitest';
import { deferred } from './helpers/deferred';
import { prepareTrackingFrame } from '../src/utils/segmentation/interactiveFrame';
import {
  createTrackingController,
  estimateTrackingSnapshotMemory,
  packConditioningMemory,
  packTrackingMemory,
  storeBfloat16,
} from '../src/utils/segmentation/interactiveTracking';
import type {
  TrackingGraph,
  TrackingFrameDecision,
  TrackingMemoryEntry,
  TrackingOptions,
  TrackingProgress,
  TrackingSessions,
  TrackingSnapshotOptions,
  TrackingSnapshotProgress,
  TrackingPhaseTiming,
} from '../src/utils/segmentation/interactiveTracking';

const MEMORY_VALUES = 64 * 32 * 32;
const FEATURE_VALUES = 256 * 32 * 32;
const LOW_VALUES = 128 * 128;

function entry(index: number): TrackingMemoryEntry {
  return {
    index,
    memory: storeBfloat16(new Float32Array(MEMORY_VALUES).fill(index + 1)),
    pointer: Float32Array.from({ length: 256 }, (_, channel) => 10000 * index + channel),
  };
}

function fakeRuntime(
  onRun?: (name: TrackingGraph, feeds: Ort.InferenceSession.FeedsType) => void | Promise<void>,
  onTiming?: (timing: TrackingPhaseTiming) => void,
) {
  const alive = new Set<Ort.Tensor>();
  // Actual CPU Tensor objects exercise the injectable ORT interface; no session/model/runtime initialization.
  const ObservedTensor = new Proxy(Tensor, {
    construct(target, args) {
      const tensor = Reflect.construct(target, args) as Ort.Tensor;
      alive.add(tensor);
      const dispose = tensor.dispose.bind(tensor);
      tensor.dispose = () => {
        expect(alive.delete(tensor)).toBe(true);
        dispose();
      };
      return tensor;
    },
  });
  const calls: {
    name: TrackingGraph;
    flags: number[];
    coords: number[];
    labels: bigint[];
    feature: number | undefined;
    pointerTokens: bigint | undefined;
  }[] = [];
  const session = (name: TrackingGraph): TrackingSessions[TrackingGraph] => ({
    release: vi.fn(async () => {}),
    async run(feeds: Ort.InferenceSession.FeedsType): Promise<Ort.InferenceSession.ReturnType> {
      for (const value of Object.values(feeds)) expect(alive.has(value)).toBe(true);
      calls.push({
        name,
        flags: ['initial', 'multimask', 'has_previous', 'from_points'].flatMap((key) =>
          feeds[key] ? [Number(feeds[key].data[0])] : [],
        ),
        coords: feeds.point_coords ? Array.from(feeds.point_coords.data as Float32Array) : [],
        labels: feeds.point_labels ? Array.from(feeds.point_labels.data as BigInt64Array) : [],
        feature: feeds.features ? Number(feeds.features.data[0]) : undefined,
        pointerTokens: feeds.pointer_tokens ? (feeds.pointer_tokens.data as BigInt64Array)[0] : undefined,
      });
      await onRun?.(name, feeds);
      const float = (length: number, dims: number[], value = 0) =>
        new ObservedTensor('float32', new Float32Array(length).fill(value), dims);
      if (name === 'encoder') return { features: float(FEATURE_VALUES, [1, 256, 32, 32], 1) };
      if (name === 'memoryAttention') return { output: float(FEATURE_VALUES, [1, 256, 32, 32], 2) };
      if (name === 'memoryEncoder') return { output: float(MEMORY_VALUES, [1, 64, 32, 32]) };
      const [height, width] = Array.from(feeds.native_size.data as BigInt64Array, Number);
      return {
        low_logits: float(LOW_VALUES, [1, 1, 128, 128]),
        object_pointer: float(256, [1, 256]),
        object_score: float(1, [1, 1]),
        selected_iou: float(1, [1, 1]),
        native_logits: float(width * height, [1, 1, height, width]),
      };
    },
  });
  const sessions: TrackingSessions = {
    encoder: session('encoder'),
    decoder: session('decoder'),
    memoryAttention: session('memoryAttention'),
    memoryEncoder: session('memoryEncoder'),
  };
  const controller = createTrackingController({
    ort: { Tensor: ObservedTensor },
    sessions,
    position: new Float32Array(MEMORY_VALUES),
    temporalPosition: new Float32Array(7 * 64),
    onTiming,
  });
  return { controller, sessions, alive, calls, Tensor: ObservedTensor };
}

function options(overrides: Partial<TrackingOptions> = {}): TrackingOptions {
  return {
    width: 2,
    height: 2,
    frameCount: 2,
    sourceRange: [0, 3],
    readFrame: async () => Float32Array.of(0, 1, 2, 3),
    anchorIndex: 0,
    points: [
      [0, 0],
      [1, 1],
    ],
    labels: [1, 1],
    onFrame: () => {},
    ...overrides,
  };
}

function snapshotOptions(overrides: Partial<TrackingSnapshotOptions> = {}): TrackingSnapshotOptions {
  return {
    ...options({ frameCount: 7, anchorIndex: 3 }),
    markedFrames: [
      { index: 1, points: [[0.25, 1.5]], labels: [1] },
      {
        index: 5,
        points: [
          [0.5, 0.75],
          [1.5, 1.25],
        ],
        labels: [0, 0],
      },
    ],
    ...overrides,
  };
}

describe('consumer-certified directional prefixes', () => {
  it.each([1, -1] as const)(
    'finishes the barrier frame and its tensor cleanup before stopping direction %s',
    async (direction) => {
      const runtime = fakeRuntime();
      const frames: number[] = [],
        progress: TrackingProgress[] = [];
      const readFrame = vi.fn<TrackingOptions['readFrame']>(async () => Float32Array.of(0, 1, 2, 3));
      const result = await runtime.controller.run(
        options({
          frameCount: 5,
          anchorIndex: 2,
          direction,
          allowDirectionStop: true,
          readFrame,
          onProgress: (value) => {
            progress.push(value);
          },
          onFrame(frame) {
            frames.push(frame.index);
            if (!frame.initial) return 'stop-direction';
          },
        }),
      );
      expect(result).toEqual({ completedFrames: 2, direction, freshAnchor: true });
      expect(frames).toEqual([2, 2 + direction]);
      expect(readFrame.mock.calls).toHaveLength(2);
      expect(runtime.calls.map((call) => call.name)).toEqual([
        'encoder',
        'decoder',
        'memoryEncoder',
        'encoder',
        'memoryAttention',
        'decoder',
        'memoryEncoder',
      ]);
      expect(progress.filter((value) => value.phase === 'frame-complete').map((value) => value.index)).toEqual(frames);
      expect(progress.at(-1)).toMatchObject({
        phase: 'direction-released',
        retainedStateBytes: 0,
        liveTensorBackingBytes: 0,
      });
      expect(runtime.alive.size).toBe(0);
      await runtime.controller.dispose();
      expect(
        Object.values(runtime.sessions).every((session) => vi.mocked(session.release).mock.calls.length === 1),
      ).toBe(true);
    },
  );

  it('preserves full traversal and result shape when the consumer does not opt in', async () => {
    const runtime = fakeRuntime();
    const frames: number[] = [];
    const result = await runtime.controller.run(
      options({
        frameCount: 4,
        onFrame(frame) {
          frames.push(frame.index);
        },
      }),
    );
    expect(frames).toEqual([0, 1, 2, 3]);
    expect(result).toEqual({ completedFrames: 4, direction: 1, freshAnchor: true });
    expect(runtime.calls.filter((call) => call.name === 'memoryEncoder')).toHaveLength(4);
    await runtime.controller.dispose();
  });

  it.each(['missing-opt-in', 'anchor'] as const)(
    'rejects a named stop for %s without leaking current tensors',
    async (invalid) => {
      const runtime = fakeRuntime();
      await expect(
        runtime.controller.run(
          options({
            ...(invalid === 'anchor' ? { allowDirectionStop: true } : {}),
            onFrame(frame) {
              if (invalid === 'anchor' || !frame.initial) return 'stop-direction';
            },
          }),
        ),
      ).rejects.toThrow(/explicit permission.*non-anchor/);
      expect(runtime.alive.size).toBe(0);
      await runtime.controller.dispose();
    },
  );

  it('rejects a false opt-in before reading a source plane or running a graph', async () => {
    const runtime = fakeRuntime();
    const readFrame = vi.fn(async () => new Float32Array(4));
    await expect(runtime.controller.run(options({ allowDirectionStop: false as never, readFrame }))).rejects.toThrow(
      /explicit permission/,
    );
    expect(readFrame).not.toHaveBeenCalled();
    expect(runtime.calls).toHaveLength(0);
    await runtime.controller.dispose();
  });

  it('does not convert cancellation during an awaited barrier callback into successful completion', async () => {
    const runtime = fakeRuntime();
    const gate = deferred<TrackingFrameDecision>(),
      reached = deferred<void>();
    const abort = new AbortController();
    const run = runtime.controller.run(
      options({
        allowDirectionStop: true,
        signal: abort.signal,
        onFrame(frame) {
          if (!frame.initial) {
            reached.resolve();
            return gate.promise;
          }
        },
      }),
    );
    const rejected = expect(run).rejects.toMatchObject({ name: 'AbortError' });
    await reached.promise;
    abort.abort();
    gate.resolve('stop-direction');
    await rejected;
    expect(runtime.calls.filter((call) => call.name === 'memoryEncoder')).toHaveLength(1);
    expect(runtime.alive.size).toBe(0);
    await runtime.controller.dispose();
  });

  it.each([0, 1] as const)(
    'prepares an off-anchor label%s unchanged before stopping only beyond its final-frame fence',
    async (label) => {
      const runtime = fakeRuntime();
      const frames: number[][] = [];
      const progress: TrackingSnapshotProgress[] = [];
      const readFrame = vi.fn(async () => Float32Array.of(0, 1, 2, 3));
      await expect(
        runtime.controller.runSnapshot(
          snapshotOptions({
            allowDirectionStop: true,
            markedFrames: [{ index: 4, points: [[0, 0]], labels: [label] }],
            readFrame,
            onProgress: (value) => progress.push(value),
            onFrame(frame) {
              expect(progress.at(-1)?.stage).toBe('final');
              expect(progress.at(-1)?.conditioningFrames).toBe(2);
              frames.push([frame.index, frame.direction]);
              if (frame.index === (frame.direction === 1 ? 5 : 2)) return 'stop-direction';
            },
          }),
        ),
      ).resolves.toEqual({ completedFrames: 5, directionEndpoints: { forward: 5, reverse: 2 } });
      expect(frames).toEqual([
        [3, 1],
        [4, 1],
        [5, 1],
        [3, -1],
        [2, -1],
      ]);
      expect(readFrame.mock.calls.map(([index]) => index)).toEqual([3, 4, 5, 2]);
      expect(
        runtime.calls.filter((call) => call.name === 'decoder' && call.flags[2] === 1).map((call) => call.labels),
      ).toEqual([[BigInt(label)]]);
      expect(runtime.alive.size).toBe(0);
      await runtime.controller.dispose();
    },
  );

  it('reports true paired endpoints with two fresh anchors for an opted single-plane snapshot', async () => {
    const runtime = fakeRuntime();
    const frames: [number, number][] = [];
    const result = await runtime.controller.runSnapshot(
      snapshotOptions({
        allowDirectionStop: true,
        markedFrames: [],
        onFrame(frame) {
          frames.push([frame.index, frame.direction]);
          if (!frame.initial) return 'stop-direction';
        },
      }),
    );
    expect(result).toEqual({ completedFrames: 4, directionEndpoints: { forward: 4, reverse: 2 } });
    expect(frames).toEqual([
      [3, 1],
      [4, 1],
      [3, -1],
      [2, -1],
    ]);
    expect(runtime.calls.filter((call) => call.name === 'memoryEncoder')).toHaveLength(4);
    expect(runtime.calls.filter((call) => call.name === 'memoryAttention')).toHaveLength(2);
    expect(runtime.alive.size).toBe(0);
    await runtime.controller.dispose();
  });

  it('rejects a stop returned by a non-opted correction snapshot instead of truncating it', async () => {
    const runtime = fakeRuntime();
    await expect(
      runtime.controller.runSnapshot(
        snapshotOptions({
          markedFrames: [{ index: 4, points: [[0, 0]], labels: [0] }],
          onFrame: () => 'stop-direction',
        }),
      ),
    ).rejects.toThrow(/Correction snapshots cannot stop/);
    expect(runtime.alive.size).toBe(0);
    await runtime.controller.dispose();
  });
});

describe('tracking numerical representation', () => {
  it('rounds BF16 ties to even, preserving source offsets, signs and subnormal behavior', () => {
    const bits = Uint32Array.of(
      123,
      0,
      0x80000000,
      0x3f807fff,
      0x3f808000,
      0x3f808001,
      0x3f818000,
      0xbf808000,
      0xbf818000,
      0x00008000,
      0x00008001,
      0x00018000,
      0x7f7fffff,
      0xff7fffff,
      456,
    );
    const before = bits.slice();
    expect(storeBfloat16(new Float32Array(bits.buffer, 4, bits.length - 2))).toEqual(
      Uint16Array.of(0, 0x8000, 0x3f80, 0x3f80, 0x3f81, 0x3f82, 0xbf80, 0xbf82, 0, 1, 2, 0x7f80, 0xff80),
    );
    expect(bits).toEqual(before);
    expect(() => storeBfloat16(Float32Array.of(NaN))).toThrow(/finite/);
    expect(() => storeBfloat16(Float32Array.of(Infinity))).toThrow(/finite/);
  });

  it('packs anchor then oldest spatial memories, and anchor then newest object pointers', () => {
    const anchor = entry(10);
    const recent = new Map(Array.from({ length: 15 }, (_, i) => [i + 11, entry(i + 11)]));
    const position = Float32Array.from({ length: MEMORY_VALUES }, (_, i) => i / 1024);
    const temporal = Float32Array.from({ length: 448 }, (_, i) => i * 2);
    const packed = packTrackingMemory(anchor, recent, 26, 1, 40, position, temporal);
    expect(packed.spatialIndices).toEqual([10, 20, 21, 22, 23, 24, 25]);
    expect(packed.temporalIndices).toEqual([6, 5, 4, 3, 2, 1, 0]);
    expect(packed.pointerIndices).toEqual([10, ...Array.from({ length: 15 }, (_, i) => 25 - i)]);
    expect(packed.pointerTokens).toBe(64);
    expect(packed.tokenCount).toBe(7 * 1024 + 64);
    for (let section = 0; section < 7; section++)
      for (const pixel of [0, 21, 1023])
        for (const channel of [0, 11, 63]) {
          const source = channel * 1024 + pixel;
          const target = section * MEMORY_VALUES + pixel * 64 + channel;
          expect(packed.memory[target]).toBe(packed.spatialIndices[section] + 1);
          expect(packed.memoryPosition[target]).toBe(
            Math.fround(position[source] + temporal[packed.temporalIndices[section] * 64 + channel]),
          );
        }
    for (let section = 0; section < 16; section++)
      for (const channel of [0, 63, 64, 127, 255]) {
        const target = 7 * MEMORY_VALUES + section * 256 + channel;
        expect(packed.memory[target]).toBe(10000 * packed.pointerIndices[section] + channel);
        expect(packed.memoryPosition[target]).toBe(0);
      }
    expect(anchor.pointer[255]).toBe(100255);
  });

  it('reverses the physical traversal without reversing token policy or duplicating the anchor', () => {
    const recent = new Map(Array.from({ length: 15 }, (_, i) => [i + 10, entry(i + 10)]));
    const packed = packTrackingMemory(
      entry(25),
      recent,
      9,
      -1,
      40,
      new Float32Array(MEMORY_VALUES),
      new Float32Array(448),
    );
    expect(packed.spatialIndices).toEqual([25, 15, 14, 13, 12, 11, 10]);
    expect(packed.pointerIndices).toEqual([25, ...Array.from({ length: 15 }, (_, i) => i + 10)]);
    const first = packTrackingMemory(
      entry(31),
      new Map(),
      32,
      1,
      40,
      new Float32Array(MEMORY_VALUES),
      new Float32Array(448),
    );
    expect(first.spatialIndices).toEqual([31]);
    expect(first.pointerIndices).toEqual([31]);
    expect(first.pointerTokens).toBe(4);
  });

  it('packs every conditioning plane in insertion order, filtering only directional object pointers', () => {
    const conditions = new Map([3, 5, 1].map((index) => [index, entry(index)]));
    const position = new Float32Array(MEMORY_VALUES).fill(0.25);
    const temporal = Float32Array.from({ length: 448 }, (_, index) => index / 64);
    for (const [index, direction, recentIndex, spatial, pointers] of [
      [4, 1, undefined, [3, 5, 1], [3, 1]],
      [6, 1, 4, [3, 5, 1, 4], [3, 5, 1, 4]],
      [2, -1, undefined, [3, 5, 1], [3, 5]],
      [0, -1, 2, [3, 5, 1, 2], [3, 5, 1, 2]],
    ] as const) {
      const recent = new Map(recentIndex === undefined ? [] : [[recentIndex, entry(recentIndex)]]);
      const packed = packConditioningMemory(conditions, recent, index, direction, 7, position, temporal);
      expect(packed.spatialIndices).toEqual(spatial);
      expect(packed.pointerIndices).toEqual(pointers);
      expect(packed.temporalIndices).toEqual(recent.size ? [6, 6, 6, 1] : [6, 6, 6]);
      expect(packed.pointerTokens).toBe(pointers.length * 4);
      for (let section = 0; section < spatial.length; section++) {
        expect(packed.memory[section * MEMORY_VALUES]).toBe(spatial[section] + 1);
        expect(packed.memoryPosition[section * MEMORY_VALUES]).toBe(
          Math.fround(0.25 + temporal[packed.temporalIndices[section] * 64]),
        );
      }
      expect(packed.memoryPosition.slice(spatial.length * MEMORY_VALUES).every((value) => value === 0)).toBe(true);
    }
    expect([...conditions.keys()]).toEqual([3, 5, 1]);
  });

  it('accounts all K conditioning outputs and packed attention inputs without an old seven/sixteen cap', () => {
    expect(estimateTrackingSnapshotMemory(2, 2, 40, 1).retainedStateBytes).toBe(933888);
    const estimate = estimateTrackingSnapshotMemory(96, 96, 40, 10);
    const conditioningBytes = 10 * (MEMORY_VALUES * 2 + 256 * 4 + (LOW_VALUES + 96 * 96 + 2) * 4);
    expect(estimate).toEqual({
      conditioningBytes,
      retainedStateBytes: conditioningBytes + 6 * MEMORY_VALUES * 2 + 15 * 256 * 4,
      maximumSpatialMemories: 16,
      maximumPointers: 25,
      maximumMemoryTokens: 16 * 1024 + 25 * 4,
      packedMemoryBytes: (16 * 1024 + 25 * 4) * 64 * 4 * 2,
    });
    expect(estimateTrackingSnapshotMemory(2, 2, 7, 7).maximumSpatialMemories).toBe(7);
    expect(estimateTrackingSnapshotMemory(2, 2, 7, 7).retainedStateBytes).toBe(7 * (197640 + 16));
    expect(() => estimateTrackingSnapshotMemory(2, 2, 7, 8)).toThrow(/conditioning-plane count/);
    expect(() => estimateTrackingSnapshotMemory(Number.MAX_SAFE_INTEGER, 2, 7, 2)).toThrow();
  });
});

describe('complete literal-prompt snapshot tracking', () => {
  it('keeps the no-correction route identical to two original fresh directional runs', async () => {
    const original = fakeRuntime();
    const snapshot = fakeRuntime();
    const expected: number[][] = [];
    const actual: number[][] = [];
    for (const direction of [1, -1] as const)
      await original.controller.run(
        options({
          frameCount: 3,
          anchorIndex: 1,
          direction,
          onFrame: (frame) => {
            expected.push([frame.index, frame.direction, ...frame.nativeLogits]);
          },
        }),
      );
    const progress: TrackingSnapshotProgress[] = [];
    await expect(
      snapshot.controller.runSnapshot(
        snapshotOptions({
          frameCount: 3,
          anchorIndex: 1,
          markedFrames: [
            {
              index: 1,
              points: [
                [0, 0],
                [1, 1],
              ],
              labels: [1, 1],
            },
          ],
          onFrame: (frame) => {
            actual.push([frame.index, frame.direction, ...frame.nativeLogits]);
          },
          onProgress: (value) => progress.push(value),
        }),
      ),
    ).resolves.toEqual({ completedFrames: 4 });
    expect(actual).toEqual(expected);
    expect(snapshot.calls).toEqual(original.calls);
    expect(progress.every((value) => value.stage === 'final')).toBe(true);
    expect(snapshot.alive.size).toBe(0);
    await original.controller.dispose();
    await snapshot.controller.dispose();
  });

  it.each([false, true])(
    'prepares forward then reverse once, corrects raw priors, and reuses the same conditions in both final sweeps (stopping opt-in: %s)',
    async (allowStop) => {
      const sourceReads: number[] = [];
      const outputs: number[][] = [];
      const progress: TrackingSnapshotProgress[] = [];
      const priors: number[] = [];
      const pointerInputs: number[][] = [];
      let decoderCount = 0;
      const runtime = fakeRuntime((name, feeds) => {
        if (name === 'decoder' && Number(feeds.has_previous.data[0]))
          priors.push(Number(feeds.previous_logits.data[0]));
        if (name === 'memoryAttention') {
          const count = Number(feeds.pointer_tokens.data[0]) / 4;
          const values = feeds.memory.data as Float32Array;
          pointerInputs.push(
            Array.from({ length: count }, (_, index) => values[values.length - count * 256 + index * 256]),
          );
        }
      });
      const decode = runtime.sessions.decoder.run.bind(runtime.sessions.decoder);
      runtime.sessions.decoder.run = async (feeds) => {
        const result = await decode(feeds);
        decoderCount++;
        for (const tensor of Object.values(result)) (tensor.data as Float32Array).fill(decoderCount);
        // The pinned decoder graph, not the controller, owns the official [-32,32] clamp.
        (result.low_logits.data as Float32Array).fill(decoderCount * 40);
        return result;
      };
      await expect(
        runtime.controller.runSnapshot(
          snapshotOptions({
            ...(allowStop ? { allowDirectionStop: true } : {}),
            readFrame: async (index) => {
              sourceReads.push(index);
              return Float32Array.of(0, 1, 2, 3);
            },
            onFrame: (frame) => {
              expect(progress.at(-1)?.stage).toBe('final');
              outputs.push([frame.index, frame.direction, frame.nativeLogits[0]]);
            },
            onProgress: (value) => progress.push(value),
          }),
        ),
      ).resolves.toEqual({
        completedFrames: 8,
        ...(allowStop ? { directionEndpoints: { forward: 6, reverse: 0 } } : {}),
      });
      expect(sourceReads).toEqual([3, 4, 5, 2, 1, 4, 6, 2, 0]);
      expect(outputs).toEqual([
        [3, 1, 1],
        [4, 1, 8],
        [5, 1, 4],
        [6, 1, 9],
        [3, -1, 1],
        [2, -1, 10],
        [1, -1, 7],
        [0, -1, 11],
      ]);
      expect(priors).toEqual([120, 240]);
      expect(pointerInputs).toEqual([[1], [1, 2], [1, 4], [1, 4, 5], [1, 7], [1, 4, 7, 8], [1, 4], [1, 4, 7, 10]]);
      const decoders = runtime.calls.filter((call) => call.name === 'decoder');
      expect(
        decoders
          .filter((call) => call.flags[2] === 1)
          .map((call) => [call.flags, call.labels, call.coords, call.feature]),
      ).toEqual([
        [[0, 0, 1], [0n, 0n], [128, 192, 384, 320], 2],
        [[0, 1, 1], [1n], [64, 384], 2],
      ]);
      expect(runtime.calls.filter((call) => call.name === 'encoder')).toHaveLength(9);
      expect(
        runtime.calls.filter((call) => call.name === 'memoryEncoder').map((call) => [call.flags, call.feature]),
      ).toEqual([
        [[1], 1],
        [[0], 1],
        [[1], 1],
        [[0], 1],
        [[1], 1],
        [[0], 1],
        [[0], 1],
        [[0], 1],
        [[0], 1],
      ]);
      const estimate = estimateTrackingSnapshotMemory(2, 2, 7, 3);
      expect(Math.max(...progress.map((value) => value.retainedStateBytes))).toBeLessThanOrEqual(
        estimate.retainedStateBytes,
      );
      expect(
        progress
          .filter((value) => value.stage === 'final' && value.phase === 'conditioned-frame')
          .every((value) => value.conditioningFrames === 3),
      ).toBe(true);
      expect(progress.at(-1)).toMatchObject({
        phase: 'snapshot-released',
        retainedStateBytes: 0,
        liveTensorBackingBytes: 0,
        conditioningFrames: 0,
      });
      expect(runtime.alive.size).toBe(0);
      await runtime.controller.dispose();
    },
  );

  it('keeps complete conditioning inputs and preparation order identical before shortening either final sweep', async () => {
    async function runSnapshot(allowStop: boolean) {
      const runtime = fakeRuntime();
      const progress: TrackingSnapshotProgress[] = [];
      const reads: Array<{ index: number; stage: string; pixels: number[] }> = [];
      const outputs: number[][] = [];
      let preparationCalls: typeof runtime.calls | undefined;
      try {
        const result = await runtime.controller.runSnapshot(
          snapshotOptions({
            frameCount: 11,
            anchorIndex: 5,
            markedFrames: [
              {
                index: 8,
                points: [
                  [0.5, 0.75],
                  [1.5, 1.25],
                ],
                labels: [0, 0],
              },
              { index: 2, points: [[0.25, 1.5]], labels: [1] },
            ],
            ...(allowStop ? { allowDirectionStop: true } : {}),
            readFrame: async (index) => {
              const pixels = Float32Array.of(0, 1, 2, 3);
              reads.push({ index, stage: progress.at(-1)!.stage, pixels: [...pixels] });
              return pixels;
            },
            onProgress: (value) => progress.push(value),
            onFrame(frame) {
              expect(progress.at(-1)?.stage).toBe('final');
              expect(progress.at(-1)?.conditioningFrames).toBe(3);
              preparationCalls ??= runtime.calls.slice();
              outputs.push([frame.index, frame.direction, ...frame.nativeLogits]);
              if (allowStop && frame.index === (frame.direction === 1 ? 9 : 1)) return 'stop-direction';
            },
          }),
        );
        expect(progress.at(-1)).toMatchObject({
          phase: 'snapshot-released',
          retainedStateBytes: 0,
          liveTensorBackingBytes: 0,
          conditioningFrames: 0,
        });
        expect(runtime.alive.size).toBe(0);
        return { result, reads, outputs, preparationCalls, progress };
      } finally {
        await runtime.controller.dispose();
        expect(
          Object.values(runtime.sessions).every((session) => vi.mocked(session.release).mock.calls.length === 1),
        ).toBe(true);
      }
    }
    const full = await runSnapshot(false);
    const pruned = await runSnapshot(true);
    expect(full.result).toEqual({ completedFrames: 12 });
    expect(pruned.result).toEqual({ completedFrames: 10, directionEndpoints: { forward: 9, reverse: 1 } });
    const preparation = (run: typeof full) => run.reads.filter((read) => read.stage === 'prepare');
    expect(preparation(full).map((read) => read.index)).toEqual([5, 6, 7, 8, 4, 3, 2]);
    expect(preparation(pruned)).toEqual(preparation(full));
    expect(pruned.preparationCalls).toEqual(full.preparationCalls);
    expect(pruned.outputs).toEqual(full.outputs.filter(([index]) => index >= 1 && index <= 9));
    expect(pruned.outputs.map(([index, direction]) => [index, direction])).toEqual([
      [5, 1],
      [6, 1],
      [7, 1],
      [8, 1],
      [9, 1],
      [5, -1],
      [4, -1],
      [3, -1],
      [2, -1],
      [1, -1],
    ]);
    expect(pruned.reads.filter((read) => read.stage === 'final').map((read) => read.index)).toEqual([6, 7, 9, 4, 3, 1]);
    expect(
      pruned.progress
        .filter((value) => value.stage === 'final' && value.phase === 'frame-complete')
        .map((value) => [value.index, value.direction]),
    ).toEqual(pruned.outputs.map(([index, direction]) => [index, direction]));
  });

  it.each([
    { direction: 1, stop: 4 },
    { direction: 1, stop: 5 },
    { direction: -1, stop: 2 },
    { direction: -1, stop: 1 },
  ])(
    'rejects a final stop at $stop in direction $direction before or on a literal conditioning fence',
    async ({ direction, stop }) => {
      const runtime = fakeRuntime();
      const frames: number[][] = [];
      await expect(
        runtime.controller.runSnapshot(
          snapshotOptions({
            allowDirectionStop: true,
            onFrame(frame) {
              frames.push([frame.index, frame.direction]);
              if (frame.direction === direction && frame.index === stop) return 'stop-direction';
            },
          }),
        ),
      ).rejects.toThrow();
      expect(frames.at(-1)).toEqual([stop, direction]);
      expect(frames[0]).toEqual([3, 1]);
      expect(runtime.alive.size).toBe(0);
      await runtime.controller.run(options({ frameCount: 1 }));
      await runtime.controller.dispose();
    },
  );

  it('cancels an awaited multi-plane final barrier without releasing a result or leaking tensors', async () => {
    const runtime = fakeRuntime();
    const abort = new AbortController();
    const reached = deferred<void>(),
      gate = deferred<TrackingFrameDecision>();
    const progress: TrackingSnapshotProgress[] = [];
    const run = runtime.controller.runSnapshot(
      snapshotOptions({
        frameCount: 9,
        anchorIndex: 4,
        allowDirectionStop: true,
        signal: abort.signal,
        markedFrames: [
          { index: 2, points: [[0, 0]], labels: [1] },
          { index: 6, points: [[1, 1]], labels: [0] },
        ],
        onProgress: (value) => progress.push(value),
        onFrame(frame) {
          if (frame.direction === 1 && frame.index === 7) {
            reached.resolve();
            return gate.promise;
          }
        },
      }),
    );
    await Promise.race([reached.promise, run]);
    const rejected = expect(run).rejects.toMatchObject({ name: 'AbortError' });
    abort.abort();
    gate.resolve('stop-direction');
    await rejected;
    expect(progress.at(-1)).toMatchObject({
      phase: 'snapshot-released',
      retainedStateBytes: 0,
      liveTensorBackingBytes: 0,
      conditioningFrames: 0,
    });
    expect(runtime.alive.size).toBe(0);
    await runtime.controller.run(options({ frameCount: 1 }));
    await runtime.controller.dispose();
  });

  it('snapshots all literal point records and source fields before same-tick input mutation', async () => {
    const runtime = fakeRuntime();
    const request = snapshotOptions();
    const marked = request.markedFrames![0];
    const run = runtime.controller.runSnapshot(request);
    marked.points[0][0] = 100;
    marked.labels[0] = 0;
    request.width = 100;
    request.sourceRange = [0, 100];
    await run;
    const correction = runtime.calls.filter((call) => call.name === 'decoder' && call.flags[2] === 1).at(-1)!;
    expect(correction.coords).toEqual([64, 384]);
    expect(correction.labels).toEqual([1n]);
    expect(marked.points[0][0]).toBe(100);
    await runtime.controller.dispose();
  });

  it.each([
    { labels: [0, 0] as const },
    {
      points: [
        [2, 0],
        [1, 1],
      ] as [number, number][],
    },
    {
      markedFrames: [
        { index: 1, points: [[0, 0]], labels: [1] },
        { index: 1, points: [[1, 1]], labels: [0] },
      ],
    },
    { markedFrames: [{ index: 7, points: [[0, 0]], labels: [1] }] },
    { markedFrames: [{ index: 1, points: [[0, -0.1]], labels: [1] }] },
    { markedFrames: [{ index: 3, points: [[1, 0]], labels: [1] }] },
  ] satisfies Partial<TrackingSnapshotOptions>[])(
    'rejects invalid or conflicting actual-plane snapshots before reading source: %j',
    async (invalid) => {
      const runtime = fakeRuntime();
      const readFrame = vi.fn(async () => new Float32Array(4));
      await expect(runtime.controller.runSnapshot(snapshotOptions({ ...invalid, readFrame }))).rejects.toThrow();
      expect(readFrame).not.toHaveBeenCalled();
      expect(runtime.calls).toHaveLength(0);
      await runtime.controller.dispose();
    },
  );

  it.each([false, true])(
    'cancels preparation without publishing and cleans late tensors before a fresh job (stopping opt-in: %s)',
    async (allowStop) => {
      const abort = new AbortController();
      const runtime = fakeRuntime((name, feeds) => {
        if (name === 'decoder' && Number(feeds.has_previous.data[0])) abort.abort();
      });
      const onFrame = vi.fn();
      const progress: TrackingSnapshotProgress[] = [];
      await expect(
        runtime.controller.runSnapshot(
          snapshotOptions({
            ...(allowStop ? { allowDirectionStop: true } : {}),
            signal: abort.signal,
            onFrame,
            onProgress: (value) => progress.push(value),
          }),
        ),
      ).rejects.toMatchObject({ name: 'AbortError' });
      expect(onFrame).not.toHaveBeenCalled();
      expect(progress.at(-1)).toMatchObject({ retainedStateBytes: 0, liveTensorBackingBytes: 0 });
      expect(runtime.alive.size).toBe(0);
      await runtime.controller.run(options({ frameCount: 1 }));
      await runtime.controller.dispose();
    },
  );

  it.each(['before-source-frame', 'conditioned-frame', 'after-decoder'] as const)(
    'honors cancellation from %s progress before the next source/output callback',
    async (phase) => {
      const runtime = fakeRuntime();
      const abort = new AbortController();
      const readFrame = vi.fn(async () => new Float32Array(4));
      const onFrame = vi.fn();
      let emittedAtCancellation = -1;
      let sourceReadsAtCancellation = -1;
      await expect(
        runtime.controller.runSnapshot(
          snapshotOptions({
            readFrame,
            onFrame,
            signal: abort.signal,
            onProgress: (value) => {
              if (value.phase === phase && (phase === 'before-source-frame' || value.stage === 'final')) {
                emittedAtCancellation = onFrame.mock.calls.length;
                sourceReadsAtCancellation = readFrame.mock.calls.length;
                abort.abort();
              }
            },
          }),
        ),
      ).rejects.toMatchObject({ name: 'AbortError' });
      expect(emittedAtCancellation).toBeGreaterThanOrEqual(0);
      expect(onFrame).toHaveBeenCalledTimes(emittedAtCancellation);
      expect(readFrame).toHaveBeenCalledTimes(sourceReadsAtCancellation);
      expect(runtime.alive.size).toBe(0);
      await runtime.controller.dispose();
    },
  );

  it('shares stream ownership across run APIs and waits for an active graph before disposing', async () => {
    const entered = deferred<void>();
    const settled = deferred<void>();
    const runtime = fakeRuntime(async () => {
      entered.resolve();
      await settled.promise;
    });
    const onFrame = vi.fn();
    const run = runtime.controller.runSnapshot(snapshotOptions({ onFrame }));
    const rejection = expect(run).rejects.toMatchObject({ name: 'AbortError' });
    await entered.promise;
    await expect(runtime.controller.run(options())).rejects.toThrow(/one source frame stream/);
    await expect(runtime.controller.runSnapshot(snapshotOptions())).rejects.toThrow(/one source frame stream/);
    const closing = runtime.controller.dispose();
    for (const session of Object.values(runtime.sessions)) expect(session.release).not.toHaveBeenCalled();
    settled.resolve();
    await rejection;
    await closing;
    expect(onFrame).not.toHaveBeenCalled();
    expect(runtime.alive.size).toBe(0);
    for (const session of Object.values(runtime.sessions)) expect(session.release).toHaveBeenCalledOnce();
  });

  it.each(['source', 'decoder', 'sink', 'progress'] as const)(
    'cleans all snapshot ownership after a %s failure',
    async (failure) => {
      const runtime = fakeRuntime((name) => {
        if (failure === 'decoder' && name === 'decoder') throw new Error('snapshot failed');
      });
      await expect(
        runtime.controller.runSnapshot(
          snapshotOptions({
            readFrame: async () => {
              if (failure === 'source') throw new Error('snapshot failed');
              return new Float32Array(4);
            },
            onFrame: () => {
              if (failure === 'sink') throw new Error('snapshot failed');
            },
            onProgress: (value) => {
              if (failure === 'progress' && value.phase === 'after-memoryEncoder') throw new Error('snapshot failed');
            },
          }),
        ),
      ).rejects.toThrow('snapshot failed');
      expect(runtime.alive.size).toBe(0);
      await runtime.controller.dispose();
    },
  );
});

describe('single-conditioning-plane tracking lifecycle', () => {
  it('streams native raw outputs, uses raw encoder features for memory, and disposes all tensors', async () => {
    const onTiming = vi.fn<(timing: TrackingPhaseTiming) => void>();
    const runtime = fakeRuntime(undefined, onTiming);
    const progress: TrackingProgress[] = [];
    const source = Float32Array.of(0, 1, 2, 3);
    const visited: number[] = [];
    expect(
      await runtime.controller.run(
        options({
          readFrame: async () => source,
          onFrame: (frame) => {
            visited.push(frame.index);
            expect(frame.nativeLogits).toEqual(new Float32Array(4));
            expect(frame.lowLogits).toHaveLength(LOW_VALUES);
            expect(frame.nativeLogits.buffer).not.toBe(source.buffer);
          },
          onProgress: (value) => progress.push(value),
        }),
      ),
    ).toEqual({ completedFrames: 2, direction: 1, freshAnchor: true });
    expect(visited).toEqual([0, 1]);
    expect(onTiming.mock.calls.map(([timing]) => timing.asset)).toEqual(runtime.calls.map((call) => call.name));
    expect(
      onTiming.mock.calls.every(
        ([timing]) => timing.stage === 'graph-run' && Number.isFinite(timing.elapsedMs) && timing.elapsedMs >= 0,
      ),
    ).toBe(true);
    expect(source).toEqual(Float32Array.of(0, 1, 2, 3));
    expect(runtime.calls.map((call) => call.name)).toEqual([
      'encoder',
      'decoder',
      'memoryEncoder',
      'encoder',
      'memoryAttention',
      'decoder',
      'memoryEncoder',
    ]);
    expect(
      runtime.calls
        .filter((call) => call.name === 'decoder')
        .map((call) => [call.flags, call.feature, call.labels, call.coords]),
    ).toEqual([
      [[1, 0, 0], 1, [1n, 1n], [0, 0, 256, 256]],
      [[0, 1, 0], 2, [-1n], [0, 0]],
    ]);
    expect(
      runtime.calls.filter((call) => call.name === 'memoryEncoder').map((call) => [call.flags, call.feature]),
    ).toEqual([
      [[1], 1],
      [[0], 1],
    ]);
    expect(progress.at(-1)).toMatchObject({
      phase: 'direction-released',
      retainedStateBytes: 0,
      liveTensorBackingBytes: 0,
    });
    expect(runtime.alive.size).toBe(0);
    await runtime.controller.dispose();
    await runtime.controller.dispose();
    for (const session of Object.values(runtime.sessions)) expect(session.release).toHaveBeenCalledTimes(1);
  });

  it('bounds history to seven BF16 spatial memories and sixteen pointers across fresh directions', async () => {
    const runtime = fakeRuntime();
    const progress: TrackingProgress[] = [];
    const visited: number[] = [];
    for (const direction of [1, -1] as const) {
      await runtime.controller.run(
        options({
          frameCount: 19,
          direction,
          anchorIndex: direction === 1 ? 0 : 18,
          onFrame: (frame) => {
            visited.push(frame.index);
          },
          onProgress: (value) => progress.push(value),
        }),
      );
    }
    expect(visited).toEqual([
      ...Array.from({ length: 19 }, (_, i) => i),
      ...Array.from({ length: 19 }, (_, i) => 18 - i),
    ]);
    expect(Math.max(...progress.map((value) => value.spatialMemories))).toBe(7);
    expect(Math.max(...progress.map((value) => value.pointers))).toBe(16);
    expect(Math.max(...progress.map((value) => value.retainedStateBytes))).toBe(933888);
    expect(runtime.calls.filter((call) => call.name === 'decoder' && call.flags[0] === 1)).toHaveLength(2);
    expect(runtime.alive.size).toBe(0);
    await runtime.controller.dispose();
  });

  it('snapshots source geometry, range and literal prompt arrays before callbacks or same-tick mutation', async () => {
    const source = Float32Array.of(0, 1, 2, 3, 4, 5);
    const expected = prepareTrackingFrame(source, 3, 2, [0, 5]);
    const runtime = fakeRuntime((name, feeds) => {
      if (name === 'encoder') {
        const input = feeds.image.data as Float32Array;
        expect(Buffer.from(input.buffer, input.byteOffset, input.byteLength).equals(Buffer.from(expected.buffer))).toBe(
          true,
        );
      }
    });
    const points: [number, number][] = [[1.1, 0.4]];
    const labels: (0 | 1)[] = [0];
    const range: [number, number] = [0, 5];
    const request = options({
      width: 3,
      height: 2,
      frameCount: 1,
      points,
      labels,
      sourceRange: range,
      readFrame: async () => source,
    });
    const run = runtime.controller.run(request);
    points[0][0] = 99;
    points.push([10, 20]);
    labels[0] = 1;
    range[1] = 100;
    request.width = 100;
    await run;
    const decoder = runtime.calls.find((call) => call.name === 'decoder')!;
    expect(decoder.coords).toEqual([
      Math.fround(Math.fround(Math.fround(1.1) / 3) * 512),
      Math.fround(Math.fround(Math.fround(0.4) / 2) * 512),
    ]);
    expect(decoder.labels).toEqual([0n]);
    expect(decoder.flags).toEqual([1, 1, 0]);
    expect(points).toEqual([
      [99, 0.4],
      [10, 20],
    ]);
    expect(labels).toEqual([1]);
    expect(range).toEqual([0, 100]);
    await runtime.controller.dispose();
  });

  it('rejects an already-canceled run before reading source', async () => {
    const runtime = fakeRuntime();
    const signal = AbortSignal.abort();
    const readFrame = vi.fn(async () => new Float32Array(4));
    await expect(runtime.controller.run(options({ signal, readFrame }))).rejects.toMatchObject({ name: 'AbortError' });
    expect(readFrame).not.toHaveBeenCalled();
    expect(runtime.calls).toHaveLength(0);
    await runtime.controller.dispose();
  });

  describe.each(['run', 'runSnapshot'] as const)('%s progress callback cancellation', (api) => {
    it.each([
      ['before-source-frame', 'abort'],
      ['before-source-frame', 'dispose'],
      ['after-decoder', 'abort'],
      ['after-decoder', 'dispose'],
    ] as const)('honors %s %s before the next source/output callback', async (phase, method) => {
      const runtime = fakeRuntime();
      const abort = new AbortController();
      const readFrame = vi.fn(async () => new Float32Array(4));
      const onFrame = vi.fn();
      let closing: Promise<void> | undefined;
      const request = options({
        signal: abort.signal,
        readFrame,
        onFrame,
        onProgress: (value) => {
          if (value.phase !== phase) return;
          if (method === 'abort') abort.abort();
          else closing = runtime.controller.dispose();
        },
      });
      const run =
        api === 'run'
          ? runtime.controller.run(request)
          : runtime.controller.runSnapshot({ ...request, markedFrames: [] });
      await expect(run).rejects.toMatchObject({ name: 'AbortError' });
      expect(onFrame).not.toHaveBeenCalled();
      expect(readFrame).toHaveBeenCalledTimes(phase === 'before-source-frame' ? 0 : 1);
      expect(runtime.alive.size).toBe(0);
      await (closing ?? runtime.controller.dispose());
      for (const session of Object.values(runtime.sessions)) expect(session.release).toHaveBeenCalledOnce();
    });
  });

  it('cleans late graph outputs after cancellation and permits a later fresh run', async () => {
    const abort = new AbortController();
    const runtime = fakeRuntime((name) => {
      if (name === 'encoder') abort.abort();
    });
    const onFrame = vi.fn();
    await expect(runtime.controller.run(options({ signal: abort.signal, onFrame }))).rejects.toMatchObject({
      name: 'AbortError',
    });
    expect(runtime.calls.map((call) => call.name)).toEqual(['encoder']);
    expect(onFrame).not.toHaveBeenCalled();
    expect(runtime.alive.size).toBe(0);
    await expect(runtime.controller.run(options({ frameCount: 1 }))).resolves.toMatchObject({ completedFrames: 1 });
    await runtime.controller.dispose();
  });

  it('waits for an active graph before disposing sessions and rejects concurrent/reentrant work', async () => {
    const entered = deferred<void>();
    const settled = deferred<void>();
    const runtime = fakeRuntime(async () => {
      entered.resolve();
      await settled.promise;
    });
    const onFrame = vi.fn();
    const run = runtime.controller.run(options({ onFrame }));
    const rejected = expect(run).rejects.toMatchObject({ name: 'AbortError' });
    await entered.promise;
    await expect(runtime.controller.run(options())).rejects.toThrow(/one source frame stream/);
    const disposing = runtime.controller.dispose();
    for (const session of Object.values(runtime.sessions)) expect(session.release).not.toHaveBeenCalled();
    expect(runtime.controller.dispose()).toBe(disposing);
    settled.resolve();
    await rejected;
    await disposing;
    expect(onFrame).not.toHaveBeenCalled();
    expect(runtime.alive.size).toBe(0);
    for (const session of Object.values(runtime.sessions)) expect(session.release).toHaveBeenCalledTimes(1);
    await expect(runtime.controller.run(options())).rejects.toThrow(/disposed/);
  });

  it('keeps the source operation owned until its cancellation settles and ignores the stale plane', async () => {
    const entered = deferred<void>();
    const source = deferred<Float32Array>();
    const runtime = fakeRuntime();
    const abort = new AbortController();
    const run = runtime.controller.run(
      options({
        signal: abort.signal,
        readFrame: async (_index, signal) => {
          expect(signal).toBe(abort.signal);
          entered.resolve();
          return source.promise;
        },
      }),
    );
    const rejected = expect(run).rejects.toMatchObject({ name: 'AbortError' });
    await entered.promise;
    abort.abort();
    await expect(runtime.controller.run(options())).rejects.toThrow(/one source frame stream/);
    source.resolve(Float32Array.of(0, 1, 2, 3));
    await rejected;
    expect(runtime.calls).toHaveLength(0);
    await runtime.controller.run(options({ frameCount: 1 }));
    await runtime.controller.dispose();
  });

  it.each(['source', 'encoder', 'sink', 'progress'] as const)(
    'releases all ownership on %s failure',
    async (failure) => {
      const runtime = fakeRuntime((name) => {
        if (failure === 'encoder' && name === 'encoder') throw new Error('test failure');
      });
      await expect(
        runtime.controller.run(
          options({
            readFrame: async () => {
              if (failure === 'source') throw new Error('test failure');
              return new Float32Array(4);
            },
            onFrame: () => {
              if (failure === 'sink') throw new Error('test failure');
            },
            onProgress: (value) => {
              if (failure === 'progress' && value.phase === 'after-encoder') throw new Error('test failure');
            },
          }),
        ),
      ).rejects.toThrow('test failure');
      expect(runtime.alive.size).toBe(0);
      await runtime.controller.dispose();
    },
  );

  it('claims its stream before the first progress callback can reenter', async () => {
    const runtime = fakeRuntime();
    let attempted: Promise<unknown> | undefined;
    await runtime.controller.run(
      options({
        frameCount: 1,
        onProgress: (value) => {
          if (value.phase === 'before-source-frame')
            attempted = expect(runtime.controller.run(options())).rejects.toThrow(/one source frame stream/);
        },
      }),
    );
    await attempted;
    await runtime.controller.dispose();
  });

  it.each(['missing', 'shape', 'nonfinite'] as const)(
    'rejects %s decoder output before publishing and cleans all returned tensors',
    async (failure) => {
      const runtime = fakeRuntime();
      runtime.sessions.decoder.run = async (): Promise<Ort.InferenceSession.ReturnType> => {
        if (failure === 'missing') return {};
        return {
          low_logits: new runtime.Tensor('float32', new Float32Array(failure === 'shape' ? 1 : LOW_VALUES), [
            failure === 'shape' ? 1 : LOW_VALUES,
          ]),
          native_logits: new runtime.Tensor('float32', new Float32Array(4).fill(NaN), [1, 1, 2, 2]),
          object_pointer: new runtime.Tensor('float32', new Float32Array(256), [1, 256]),
          object_score: new runtime.Tensor('float32', new Float32Array(1), [1, 1]),
          selected_iou: new runtime.Tensor('float32', new Float32Array(1), [1, 1]),
        };
      };
      const onFrame = vi.fn();
      await expect(runtime.controller.run(options({ onFrame }))).rejects.toThrow(/unexpected shape|nonfinite/);
      expect(onFrame).not.toHaveBeenCalled();
      expect(runtime.alive.size).toBe(0);
      await runtime.controller.dispose();
    },
  );

  it('attempts every session release even when one fails and never retries disposal', async () => {
    const runtime = fakeRuntime();
    runtime.sessions.encoder.release = vi.fn(async () => {
      throw new Error('release failed');
    });
    const closing = runtime.controller.dispose();
    await expect(closing).rejects.toThrow('release failed');
    expect(runtime.controller.dispose()).toBe(closing);
    for (const session of Object.values(runtime.sessions)) expect(session.release).toHaveBeenCalledTimes(1);
  });

  it.each([
    { width: 0 },
    { stopIndex: 2 },
    { direction: -1 as const, anchorIndex: 0, stopIndex: 1 },
    { points: [] },
    { points: [[NaN, 0]] as [number, number][], labels: [1] as const },
    { labels: [1] as const },
  ])('rejects invalid source/conditioning contracts before source reads: %j', async (invalid) => {
    const runtime = fakeRuntime();
    const readFrame = vi.fn(async () => new Float32Array(4));
    await expect(runtime.controller.run(options({ ...invalid, readFrame }))).rejects.toThrow(
      /source grid|source points and labels/,
    );
    expect(readFrame).not.toHaveBeenCalled();
    expect(runtime.calls).toHaveLength(0);
    await runtime.controller.dispose();
  });
});
