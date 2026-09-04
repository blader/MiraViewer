import type * as Ort from 'onnxruntime-web';
import { prepareTrackingFrame } from './interactiveFrame';
import type { TrackingSourceRange } from './interactiveFrame';
import type { TrackingFramePrompts } from './interactivePrompts';

const SPATIAL_PIXELS = 32 * 32;
const MEMORY_CHANNELS = 64;
const MEMORY_VALUES = SPATIAL_PIXELS * MEMORY_CHANNELS;
const FEATURE_VALUES = SPATIAL_PIXELS * 256;
const LOW_VALUES = 128 * 128;

export type TrackingGraph = 'encoder' | 'decoder' | 'memoryAttention' | 'memoryEncoder';
/** Completed operations only; excludes queueing, source reads and event-loop yields. */
export type TrackingPhaseTiming = {
  stage: 'runtime-load' | 'asset-load' | 'session-init' | 'graph-run';
  asset?: TrackingGraph | 'memoryPosition' | 'temporalPositions';
  elapsedMs: number;
};
export type TrackingSessions = Record<TrackingGraph, Pick<Ort.InferenceSession, 'run' | 'release'>>;
export type TrackingFrameDecision = 'stop-direction' | void;
export type TrackingDirectionEndpoints = { forward: number; reverse: number };

export interface TrackingSource {
  width: number;
  height: number;
  frameCount: number;
  sourceRange: TrackingSourceRange;
  /** Complete source-context planes, row-major XY; no display tone or inferred pixels. */
  readFrame(index: number, signal?: AbortSignal): Float32Array | Promise<Float32Array>;
}

export interface TrackingFrameOutput {
  index: number;
  direction: 1 | -1;
  initial: boolean;
  lowLogits: Float32Array;
  nativeLogits: Float32Array;
  pointer: Float32Array;
  objectScore: Float32Array;
  selectedIou: Float32Array;
}

export interface TrackingProgress {
  phase: string;
  index: number;
  direction: 1 | -1;
  spatialMemories: number;
  pointers: number;
  /** Distinct history buffers only; excludes sessions, runtime, constants and source ownership. */
  retainedStateBytes: number;
  /** Distinct CPU tensor buffers currently owned by this controller, not total runtime memory. */
  liveTensorBackingBytes: number;
}

export interface TrackingOptions extends TrackingSource {
  /** Only this explicitly supplied plane is conditioned; other planes are predictions, not user marks. */
  anchorIndex: number;
  points: readonly (readonly [number, number])[];
  labels: readonly (0 | 1)[];
  direction?: 1 | -1;
  stopIndex?: number;
  /** Consumer-certified directional prefix only; omitted means every requested frame is required. */
  allowDirectionStop?: true;
  signal?: AbortSignal;
  /** Arrays are borrowed until this callback settles. Copy before retaining; never mutate them. */
  onFrame(frame: TrackingFrameOutput): TrackingFrameDecision | Promise<TrackingFrameDecision>;
  onProgress?(progress: TrackingProgress): void;
}

export interface TrackingResult {
  completedFrames: number;
  direction: 1 | -1;
  freshAnchor: true;
}

export interface TrackingSnapshotProgress extends TrackingProgress {
  stage: 'prepare' | 'final';
  conditioningFrames: number;
}

export interface TrackingSnapshotOptions extends Omit<TrackingOptions, 'direction' | 'stopIndex' | 'onProgress'> {
  /** A complete current snapshot of literal per-plane prompts, not inferred cross-plane marks. */
  markedFrames?: readonly TrackingFramePrompts[];
  onProgress?(progress: TrackingSnapshotProgress): void;
}

export interface TrackingSnapshotResult {
  /** Final forward and reverse outputs; the original anchor is intentionally emitted twice. */
  completedFrames: number;
  /** Present only for an opted-in run; these are observed endpoints, never synthetic frame deliveries. */
  directionEndpoints?: TrackingDirectionEndpoints;
}

export interface TrackingController {
  run(options: TrackingOptions): Promise<TrackingResult>;
  runSnapshot(options: TrackingSnapshotOptions): Promise<TrackingSnapshotResult>;
  dispose(): Promise<void>;
}

export interface TrackingMemoryEntry {
  index: number;
  memory: Uint16Array | null;
  pointer: Float32Array;
}

/** Official Float32 -> bfloat16 round-to-nearest-even, stored in actual two-byte elements. */
export function storeBfloat16(values: Float32Array): Uint16Array {
  if (!(values instanceof Float32Array)) throw new Error('Memory features must be Float32.');
  const bits = new Uint32Array(values.buffer, values.byteOffset, values.length);
  const result = new Uint16Array(values.length);
  for (let i = 0; i < bits.length; i++) {
    if (!Number.isFinite(values[i])) throw new Error('Memory features must be finite.');
    result[i] = ((bits[i] + 0x7fff + ((bits[i] >>> 16) & 1)) >>> 16) & 0xffff;
  }
  return result;
}

/** Source base._prepare_memory_conditioned_features: anchor, oldest->newest memory, newest->oldest pointers. */
export function packTrackingMemory(
  anchor: TrackingMemoryEntry | null,
  recent: ReadonlyMap<number, TrackingMemoryEntry>,
  index: number,
  direction: 1 | -1,
  frameCount: number,
  position: Float32Array,
  temporalPosition: Float32Array,
) {
  if (!anchor || (index - anchor.index) * direction <= 0) throw new Error('Tracking needs a preceding anchor.');
  const spatial = [{ entry: anchor, temporalIndex: 6 }];
  for (let relative = 6; relative >= 1; relative--) {
    const entry = recent.get(index - direction * relative);
    if (entry) {
      if (!entry.memory) throw new Error('A required spatial memory was released early.');
      spatial.push({ entry, temporalIndex: relative - 1 });
    }
  }
  const pointers = [anchor];
  for (let relative = 1; relative < Math.min(frameCount, 16); relative++) {
    const previousIndex = index - direction * relative;
    if (previousIndex < 0 || previousIndex >= frameCount) break;
    const entry = recent.get(previousIndex);
    if (entry) pointers.push(entry);
  }
  return packMemoryEntries(spatial, pointers, position, temporalPosition);
}

function packMemoryEntries(
  spatial: { entry: TrackingMemoryEntry; temporalIndex: number }[],
  pointers: TrackingMemoryEntry[],
  position: Float32Array,
  temporalPosition: Float32Array,
) {
  const pointerTokens = pointers.length * 4;
  const tokenCount = spatial.length * SPATIAL_PIXELS + pointerTokens;
  const memory = new Float32Array(tokenCount * MEMORY_CHANNELS);
  const memoryBits = new Uint32Array(memory.buffer);
  const memoryPosition = new Float32Array(memory.length);
  let offset = 0;
  for (const { entry, temporalIndex } of spatial) {
    if (!entry.memory || entry.memory.length !== MEMORY_VALUES)
      throw new Error('Spatial memory has the wrong native model shape.');
    for (let pixel = 0; pixel < SPATIAL_PIXELS; pixel++) {
      for (let channel = 0; channel < MEMORY_CHANNELS; channel++) {
        const source = channel * SPATIAL_PIXELS + pixel;
        const target = offset + pixel * MEMORY_CHANNELS + channel;
        memoryBits[target] = entry.memory[source] << 16;
        memoryPosition[target] = Math.fround(
          position[source] + temporalPosition[temporalIndex * MEMORY_CHANNELS + channel],
        );
      }
    }
    offset += MEMORY_VALUES;
  }
  for (const entry of pointers) {
    if (entry.pointer.length !== 256) throw new Error('Object pointer has the wrong shape.');
    memory.set(entry.pointer, offset); // [256] splits into four contiguous [64] tokens; pointer position stays zero.
    offset += 256;
  }
  return {
    memory,
    memoryPosition,
    pointerTokens,
    tokenCount,
    spatialIndices: spatial.map(({ entry }) => entry.index),
    temporalIndices: spatial.map(({ temporalIndex }) => temporalIndex),
    pointerIndices: pointers.map((entry) => entry.index),
  };
}

/** All conditions retain insertion order; only past conditioning pointers enter a direction's attention. */
export function packConditioningMemory(
  conditioning: ReadonlyMap<number, TrackingMemoryEntry>,
  recent: ReadonlyMap<number, TrackingMemoryEntry>,
  index: number,
  direction: 1 | -1,
  frameCount: number,
  position: Float32Array,
  temporalPosition: Float32Array,
) {
  if (!conditioning.size) throw new Error('Tracking needs an actual foreground conditioning plane.');
  const spatial = [...conditioning.values()].map((entry) => ({ entry, temporalIndex: 6 }));
  for (let relative = 6; relative >= 1; relative--) {
    const entry = recent.get(index - direction * relative);
    if (entry) spatial.push({ entry, temporalIndex: relative - 1 });
  }
  const pointers = [...conditioning.values()].filter((entry) => (index - entry.index) * direction >= 0);
  for (let relative = 1; relative < Math.min(frameCount, 16); relative++) {
    const previousIndex = index - direction * relative;
    if (previousIndex < 0 || previousIndex >= frameCount) break;
    const entry = recent.get(previousIndex);
    if (entry) pointers.push(entry);
  }
  return packMemoryEntries(spatial, pointers, position, temporalPosition);
}

/** Model-state/packing upper bounds only; sessions, graph workspace and source ownership remain separate. */
export function estimateTrackingSnapshotMemory(
  width: number,
  height: number,
  frameCount: number,
  conditioningFrames: number,
) {
  if (
    ![width, height, frameCount, conditioningFrames].every((value) => Number.isSafeInteger(value) && value > 0) ||
    conditioningFrames > frameCount ||
    !Number.isSafeInteger(width * height)
  )
    throw new Error('Tracking memory requires a complete grid and an explicit conditioning-plane count.');
  const recentCount = Math.min(15, frameCount - conditioningFrames);
  const recentMemories = Math.min(6, recentCount);
  const conditioningBytes =
    conditioningFrames *
    (MEMORY_VALUES * 2 + 256 * 4 + (conditioningFrames > 1 ? (LOW_VALUES + width * height + 2) * 4 : 0));
  const retainedStateBytes = conditioningBytes + recentMemories * MEMORY_VALUES * 2 + recentCount * 256 * 4;
  const maximumSpatialMemories = conditioningFrames + recentMemories;
  const maximumPointers = conditioningFrames + recentCount;
  const maximumMemoryTokens = maximumSpatialMemories * SPATIAL_PIXELS + maximumPointers * 4;
  const packedMemoryBytes = maximumMemoryTokens * MEMORY_CHANNELS * 4 * 2;
  if (![retainedStateBytes, packedMemoryBytes].every(Number.isSafeInteger))
    throw new Error('Tracking memory dimensions are too large.');
  return {
    conditioningBytes,
    retainedStateBytes,
    maximumSpatialMemories,
    maximumPointers,
    maximumMemoryTokens,
    packedMemoryBytes,
  };
}

function trimHistory(recent: Map<number, TrackingMemoryEntry>, index: number, direction: 1 | -1): void {
  for (const [previousIndex, entry] of recent) {
    const distance = (index - previousIndex) * direction;
    if (distance >= 15) recent.delete(previousIndex);
    else if (distance >= 6) entry.memory = null;
  }
}

function floatData(tensor: Ort.Tensor | undefined, length: number, stage: string): Float32Array {
  if (!(tensor?.data instanceof Float32Array) || tensor.data.length !== length) {
    throw new Error(`${stage} returned an unexpected shape or non-Float32 output.`);
  }
  return tensor.data;
}

function snapshotSelection(options: TrackingSnapshotOptions): TrackingSnapshotOptions {
  const { width, height, frameCount, anchorIndex, sourceRange, points, labels } = options;
  if (options.allowDirectionStop !== undefined && options.allowDirectionStop !== true)
    throw new Error('Directional stopping requires explicit permission.');
  if (
    ![width, height, frameCount].every((value) => Number.isSafeInteger(value) && value > 0) ||
    !Number.isSafeInteger(width * height) ||
    !Number.isSafeInteger(frameCount + 1) ||
    !Number.isSafeInteger(anchorIndex) ||
    anchorIndex < 0 ||
    anchorIndex >= frameCount ||
    sourceRange.length !== 2 ||
    !sourceRange.every(Number.isFinite) ||
    sourceRange[1] <= sourceRange[0] ||
    !Number.isFinite(sourceRange[1] - sourceRange[0])
  )
    throw new Error('A selection snapshot requires a complete source grid and a fixed finite source range.');
  const copyPrompts = (
    index: number,
    sourcePoints: readonly (readonly [number, number])[],
    sourceLabels: readonly (0 | 1)[],
  ): TrackingFramePrompts => {
    if (
      !Number.isSafeInteger(index) ||
      index < 0 ||
      index >= frameCount ||
      !Array.isArray(sourcePoints) ||
      !sourcePoints.length ||
      !Array.isArray(sourceLabels) ||
      sourcePoints.length !== sourceLabels.length ||
      sourcePoints.some(
        (point) =>
          !Array.isArray(point) ||
          point.length !== 2 ||
          !point.every(Number.isFinite) ||
          point[0] < 0 ||
          point[0] >= width ||
          point[1] < 0 ||
          point[1] >= height,
      ) ||
      sourceLabels.some((label) => label !== 0 && label !== 1)
    )
      throw new Error('Snapshot prompts must be literal in-grid points on their actual source planes.');
    return { index, points: sourcePoints.map((point) => [point[0], point[1]]), labels: [...sourceLabels] };
  };
  const anchor = copyPrompts(anchorIndex, points, labels);
  if (!anchor.labels.includes(1)) throw new Error('A selection snapshot needs a real foreground anchor.');
  const seen = new Set<number>();
  const markedFrames = (options.markedFrames ?? []).map((frame) => {
    if (seen.has(frame.index)) throw new Error('A snapshot must contain only one prompt record per source plane.');
    seen.add(frame.index);
    const copy = copyPrompts(frame.index, frame.points, frame.labels);
    if (
      copy.index === anchorIndex &&
      (copy.points.length !== anchor.points.length ||
        copy.points.some(
          (point, index) =>
            point[0] !== anchor.points[index][0] ||
            point[1] !== anchor.points[index][1] ||
            copy.labels[index] !== anchor.labels[index],
        ))
    )
      throw new Error('The snapshot anchor must match its explicit source-plane prompts.');
    return copy;
  });
  return {
    ...options,
    sourceRange: [sourceRange[0], sourceRange[1]],
    points: anchor.points,
    labels: anchor.labels,
    markedFrames,
  };
}

/** Owns the supplied sessions. Each run is a fresh direction; constants must remain immutable until disposal. */
export function createTrackingController({
  ort,
  sessions,
  position,
  temporalPosition,
  onTiming,
}: {
  ort: Pick<typeof Ort, 'Tensor'>;
  sessions: TrackingSessions;
  position: Float32Array;
  temporalPosition: Float32Array;
  onTiming?(timing: TrackingPhaseTiming): void;
}): TrackingController {
  if (position.length !== MEMORY_VALUES || temporalPosition.length !== 7 * MEMORY_CHANNELS) {
    throw new Error('Tracking constants have the wrong pinned model shape.');
  }
  let disposed = false;
  let operation: Promise<TrackingResult | TrackingSnapshotResult> | null = null;
  let closing: Promise<void> | undefined;

  function createRunScope(signal: AbortSignal | undefined, progress: (phase: string) => void) {
    const owned = new Set<Ort.Tensor>();
    const check = () => {
      if (disposed) throw new DOMException('Tracking was disposed.', 'AbortError');
      signal?.throwIfAborted();
    };
    const release = (tensor: Ort.Tensor) => {
      if (owned.delete(tensor)) tensor.dispose();
    };
    const tensor = (
      type: 'float32' | 'int64' | 'bool',
      data: Float32Array | BigInt64Array | Uint8Array,
      dims: number[],
    ) => {
      const value = new ort.Tensor(type, data, dims);
      owned.add(value);
      return value;
    };
    async function graph(name: TrackingGraph, feeds: Ort.InferenceSession.FeedsType) {
      check();
      progress(`before-${name}`);
      await new Promise((resolve) => setTimeout(resolve, 0)); // Real event-loop boundary for cancellation and progress.
      check();
      const started = onTiming ? performance.now() : 0;
      const result = await sessions[name].run(feeds);
      for (const value of Object.values(result)) owned.add(value);
      onTiming?.({ stage: 'graph-run', asset: name, elapsedMs: performance.now() - started });
      check();
      progress(`after-${name}`);
      check();
      return result;
    }
    const flag = (value: boolean) => tensor('bool', Uint8Array.of(value ? 1 : 0), [1]);
    return { owned, check, release, tensor, graph, flag };
  }

  async function runFrames({
    readFrame,
    width,
    height,
    sourceRange,
    frameCount,
    anchorIndex,
    points,
    labels,
    direction = 1,
    stopIndex = direction === 1 ? frameCount - 1 : 0,
    allowDirectionStop,
    signal,
    onFrame,
    onProgress = () => {},
  }: TrackingOptions): Promise<TrackingResult> {
    if (allowDirectionStop !== undefined && allowDirectionStop !== true)
      throw new Error('Directional stopping requires explicit permission.');
    if (
      ![width, height, frameCount].every((value) => Number.isSafeInteger(value) && value > 0) ||
      !Number.isSafeInteger(width * height) ||
      ![anchorIndex, stopIndex].every((value) => Number.isSafeInteger(value) && value >= 0 && value < frameCount) ||
      ![1, -1].includes(direction) ||
      (stopIndex - anchorIndex) * direction < 0
    ) {
      throw new Error('Tracking requires a complete, ordered source grid.');
    }
    if (
      !Array.isArray(points) ||
      points.length < 1 ||
      points.length !== labels.length ||
      points.some((point) => point.length !== 2 || !point.every(Number.isFinite)) ||
      labels.some((label) => label !== 0 && label !== 1)
    ) {
      throw new Error('Tracking must receive explicit, matching source points and labels.');
    }
    const coords = Float32Array.from(points.flat(), (value, index) =>
      Math.fround(Math.fround(Math.fround(value) / (index % 2 ? height : width)) * 512),
    );
    const promptLabels = BigInt64Array.from(labels, BigInt);
    const recent = new Map<number, TrackingMemoryEntry>();
    const { owned, check, release, tensor, graph, flag } = createRunScope(signal, progress);
    let anchor: TrackingMemoryEntry | null = null;
    let frameIndex = anchorIndex;
    function progress(phase: string): void {
      const entries = anchor ? [anchor, ...recent.values()] : [...recent.values()];
      const retained = new Set<ArrayBufferLike>();
      for (const entry of entries) {
        if (entry.memory) retained.add(entry.memory.buffer);
        retained.add(entry.pointer.buffer);
      }
      const backing = new Set<ArrayBufferLike>();
      for (const value of owned) if (ArrayBuffer.isView(value.data)) backing.add(value.data.buffer);
      onProgress({
        phase,
        index: frameIndex,
        direction,
        spatialMemories: entries.filter((entry) => entry.memory).length,
        pointers: entries.length,
        retainedStateBytes: [...retained].reduce((sum, buffer) => sum + buffer.byteLength, 0),
        liveTensorBackingBytes: [...backing].reduce((sum, buffer) => sum + buffer.byteLength, 0),
      });
    }
    let completedFrames = 0;
    try {
      for (frameIndex = anchorIndex; (stopIndex - frameIndex) * direction >= 0; frameIndex += direction) {
        check();
        progress('before-source-frame');
        check();
        let pixels: Float32Array | null = await readFrame(frameIndex, signal);
        check();
        const normalized = prepareTrackingFrame(pixels, width, height, sourceRange);
        pixels = null;
        const image = tensor('float32', normalized, [1, 3, 512, 512]);
        const { features } = await graph('encoder', { image });
        release(image);
        floatData(features, FEATURE_VALUES, 'Image encoder');
        const initial = frameIndex === anchorIndex;
        let fused = features;
        if (!initial) {
          const packed = packTrackingMemory(
            anchor,
            recent,
            frameIndex,
            direction,
            frameCount,
            position,
            temporalPosition,
          );
          const feeds = {
            features,
            memory: tensor('float32', packed.memory, [packed.tokenCount, 1, 64]),
            memory_position: tensor('float32', packed.memoryPosition, [packed.tokenCount, 1, 64]),
            pointer_tokens: tensor('int64', BigInt64Array.of(BigInt(packed.pointerTokens)), []),
          };
          fused = (await graph('memoryAttention', feeds)).output;
          floatData(fused, FEATURE_VALUES, 'Memory attention');
          for (const value of Object.values(feeds)) if (value !== features) release(value);
        }
        const decoderFeeds = {
          features: fused,
          point_coords: tensor('float32', initial ? coords : new Float32Array(2), [1, initial ? points.length : 1, 2]),
          point_labels: tensor('int64', initial ? promptLabels : BigInt64Array.of(-1n), [
            1,
            initial ? points.length : 1,
          ]),
          previous_logits: tensor('float32', new Float32Array(LOW_VALUES), [1, 1, 128, 128]),
          has_previous: flag(false),
          initial: flag(initial),
          multimask: flag(!initial || points.length <= 1),
          native_size: tensor('int64', BigInt64Array.of(BigInt(height), BigInt(width)), [2]),
        };
        const decoded = await graph('decoder', decoderFeeds);
        for (const value of Object.values(decoderFeeds)) if (value !== features) release(value);
        const lowLogits = floatData(decoded.low_logits, LOW_VALUES, 'Mask decoder');
        const nativeLogits = floatData(decoded.native_logits, width * height, 'Mask decoder');
        const pointer = floatData(decoded.object_pointer, 256, 'Object pointer');
        const objectScore = floatData(decoded.object_score, 1, 'Object score');
        const selectedIou = floatData(decoded.selected_iou, 1, 'Selected IoU');
        if (
          Object.values(decoded).some(
            (value) => !(value.data instanceof Float32Array) || value.data.some((number) => !Number.isFinite(number)),
          )
        ) {
          throw new Error('Mask decoder returned nonfinite values.');
        }
        // Persist raw outputs before downstream memory encoding; consumers must not retain or mutate borrowed arrays.
        const decision = await onFrame({
          index: frameIndex,
          direction,
          initial,
          lowLogits,
          nativeLogits,
          pointer,
          objectScore,
          selectedIou,
        });
        check();
        if (decision !== undefined && decision !== 'stop-direction')
          throw new Error('Tracking received an invalid frame decision.');
        if (decision === 'stop-direction') {
          if (!allowDirectionStop || initial)
            throw new Error('Directional stopping requires explicit permission on a non-anchor frame.');
          stopIndex = frameIndex;
        }
        trimHistory(recent, frameIndex, direction); // Oldest inputs are no longer needed after this frame's attention.
        const rawMemory = (
          await graph('memoryEncoder', {
            features,
            low_logits: decoded.low_logits,
            from_points: flag(initial),
          })
        ).output;
        const entry = {
          index: frameIndex,
          memory: storeBfloat16(floatData(rawMemory, MEMORY_VALUES, 'Memory encoder')),
          pointer: pointer.slice(),
        };
        if (initial) anchor = entry;
        else recent.set(frameIndex, entry);
        for (const value of [...owned]) release(value);
        progress('frame-complete');
        completedFrames++;
      }
      return { completedFrames, direction, freshAnchor: true };
    } finally {
      anchor = null;
      recent.clear();
      for (const value of [...owned]) release(value);
      progress('direction-released');
    }
  }

  async function runSelection(options: TrackingSnapshotOptions): Promise<TrackingSnapshotResult> {
    const marked = new Map<number, TrackingFramePrompts>();
    for (const frame of options.markedFrames ?? [])
      if (frame.index !== options.anchorIndex) marked.set(frame.index, frame);
    if (!marked.size) {
      let completedFrames = 0;
      const directionEndpoints = { forward: options.anchorIndex, reverse: options.anchorIndex };
      for (const direction of [1, -1] as const) {
        const result = await runFrames({
          ...options,
          direction,
          onProgress: (progress) =>
            options.onProgress?.({
              ...progress,
              stage: 'final',
              conditioningFrames: progress.pointers ? 1 : 0,
            }),
        });
        completedFrames += result.completedFrames;
        directionEndpoints[direction === 1 ? 'forward' : 'reverse'] =
          options.anchorIndex + direction * (result.completedFrames - 1);
      }
      return { completedFrames, ...(options.allowDirectionStop ? { directionEndpoints } : {}) };
    }

    type ConditioningEntry = TrackingMemoryEntry & Omit<TrackingFrameOutput, 'direction' | 'initial'>;
    const conditioning = new Map<number, ConditioningEntry>();
    const recent = new Map<number, TrackingMemoryEntry>();
    const { width, height, frameCount, anchorIndex, sourceRange, signal, readFrame, onFrame, onProgress } = options;
    const { owned, check, release, tensor, graph, flag } = createRunScope(signal, progress);
    let stage: 'prepare' | 'final' = 'prepare';
    let direction: 1 | -1 = 1;
    let index = anchorIndex;
    let completedFrames = 0;
    const directionEndpoints = { forward: anchorIndex, reverse: anchorIndex };
    const releaseFrame = () => {
      for (const value of [...owned]) release(value);
    };
    function progress(phase: string) {
      const entries = [...conditioning.values(), ...recent.values()];
      const retained = new Set<ArrayBufferLike>();
      for (const entry of entries) {
        if (entry.memory) retained.add(entry.memory.buffer);
        retained.add(entry.pointer.buffer);
      }
      for (const entry of conditioning.values())
        for (const values of [entry.lowLogits, entry.nativeLogits, entry.objectScore, entry.selectedIou])
          retained.add(values.buffer);
      const backing = new Set<ArrayBufferLike>();
      for (const value of owned) if (ArrayBuffer.isView(value.data)) backing.add(value.data.buffer);
      onProgress?.({
        phase,
        stage,
        index,
        direction,
        conditioningFrames: conditioning.size,
        spatialMemories: entries.filter((entry) => entry.memory).length,
        pointers: entries.length,
        retainedStateBytes: [...retained].reduce((sum, buffer) => sum + buffer.byteLength, 0),
        liveTensorBackingBytes: [...backing].reduce((sum, buffer) => sum + buffer.byteLength, 0),
      });
    }
    async function decode(features: Ort.Tensor, prompts?: TrackingFramePrompts, prior?: Ort.Tensor, initial = false) {
      const coords = prompts
        ? Float32Array.from(prompts.points.flat(), (value, position) =>
            Math.fround(Math.fround(Math.fround(value) / (position % 2 ? height : width)) * 512),
          )
        : new Float32Array(2);
      const feeds = {
        features,
        point_coords: tensor('float32', coords, [1, prompts?.points.length ?? 1, 2]),
        point_labels: tensor('int64', prompts ? BigInt64Array.from(prompts.labels, BigInt) : BigInt64Array.of(-1n), [
          1,
          prompts?.points.length ?? 1,
        ]),
        // The exported decoder clamps raw prior logits to [-32,32]. A missing prior is not a zero-mask prior.
        previous_logits: prior ?? tensor('float32', new Float32Array(LOW_VALUES), [1, 1, 128, 128]),
        has_previous: flag(!!prior),
        initial: flag(initial),
        multimask: flag(!prompts || prompts.points.length <= 1),
        native_size: tensor('int64', BigInt64Array.of(BigInt(height), BigInt(width)), [2]),
      };
      const result = await graph('decoder', feeds);
      for (const value of Object.values(feeds)) if (value !== features && value !== prior) release(value);
      const output = {
        lowLogits: floatData(result.low_logits, LOW_VALUES, 'Mask decoder'),
        nativeLogits: floatData(result.native_logits, width * height, 'Mask decoder'),
        pointer: floatData(result.object_pointer, 256, 'Object pointer'),
        objectScore: floatData(result.object_score, 1, 'Object score'),
        selectedIou: floatData(result.selected_iou, 1, 'Selected IoU'),
      };
      if (
        Object.values(result).some(
          (value) => !(value.data instanceof Float32Array) || value.data.some((number) => !Number.isFinite(number)),
        )
      )
        throw new Error('Mask decoder returned nonfinite values.');
      return { tensors: result, output };
    }
    async function compute(prompts?: TrackingFramePrompts, initial = false) {
      check();
      progress('before-source-frame');
      check();
      let pixels: Float32Array | null = await readFrame(index, signal);
      check();
      const normalized = prepareTrackingFrame(pixels, width, height, sourceRange);
      pixels = null;
      const image = tensor('float32', normalized, [1, 3, 512, 512]);
      const { features } = await graph('encoder', { image });
      release(image);
      floatData(features, FEATURE_VALUES, 'Image encoder');
      let fused = features;
      if (!initial) {
        const packed = packConditioningMemory(
          conditioning,
          recent,
          index,
          direction,
          frameCount,
          position,
          temporalPosition,
        );
        const feeds = {
          features,
          memory: tensor('float32', packed.memory, [packed.tokenCount, 1, 64]),
          memory_position: tensor('float32', packed.memoryPosition, [packed.tokenCount, 1, 64]),
          pointer_tokens: tensor('int64', BigInt64Array.of(BigInt(packed.pointerTokens)), []),
        };
        fused = (await graph('memoryAttention', feeds)).output;
        floatData(fused, FEATURE_VALUES, 'Memory attention');
        for (const value of Object.values(feeds)) if (value !== features) release(value);
      }
      let decoded = await decode(fused, initial ? prompts : undefined, undefined, initial);
      if (prompts && !initial) {
        // A unique marked frame is not yet conditioning. Its provisional current-frame
        // state is never a strict-past attention input, so the correction reuses the same fused features.
        const corrected = await decode(fused, prompts, decoded.tensors.low_logits);
        for (const value of Object.values(decoded.tensors)) release(value);
        decoded = corrected;
      }
      if (fused !== features) release(fused);
      let decision: TrackingFrameDecision = undefined;
      if (stage === 'final') {
        decision = await onFrame({ ...decoded.output, index, direction, initial });
        check();
        if (decision !== undefined && decision !== 'stop-direction')
          throw new Error('Tracking received an invalid frame decision.');
        if (
          decision === 'stop-direction' &&
          (!options.allowDirectionStop ||
            [...conditioning.keys()].some((markedIndex) => (index - markedIndex) * direction <= 0))
        )
          throw new Error('Directional stopping requires explicit permission beyond every conditioned source plane.');
        completedFrames++;
      }
      trimHistory(recent, index, direction);
      const rawMemory = (
        await graph('memoryEncoder', { features, low_logits: decoded.tensors.low_logits, from_points: flag(!!prompts) })
      ).output;
      const memory = storeBfloat16(floatData(rawMemory, MEMORY_VALUES, 'Memory encoder'));
      const pointer = decoded.output.pointer.slice();
      if (prompts)
        conditioning.set(index, {
          index,
          memory,
          pointer,
          lowLogits: decoded.output.lowLogits.slice(),
          nativeLogits: decoded.output.nativeLogits.slice(),
          objectScore: decoded.output.objectScore.slice(),
          selectedIou: decoded.output.selectedIou.slice(),
        });
      else recent.set(index, { index, memory, pointer });
      releaseFrame();
      progress('frame-complete');
      return decision;
    }

    try {
      await compute(
        {
          index: anchorIndex,
          points: options.points.map((point) => [point[0], point[1]]),
          labels: [...options.labels],
        },
        true,
      );
      for (direction of [1, -1] as const) {
        recent.clear();
        const markedIndices = [...marked.keys()].filter((markedIndex) => (markedIndex - anchorIndex) * direction > 0);
        const stop = markedIndices.reduce(
          (limit, markedIndex) => (direction === 1 ? Math.max(limit, markedIndex) : Math.min(limit, markedIndex)),
          anchorIndex,
        );
        for (index = anchorIndex + direction; (stop - index) * direction >= 0; index += direction)
          await compute(marked.get(index));
      }
      stage = 'final';
      for (direction of [1, -1] as const) {
        recent.clear();
        const stop = direction === 1 ? frameCount - 1 : 0;
        for (index = anchorIndex; (stop - index) * direction >= 0; index += direction) {
          check();
          const condition = conditioning.get(index);
          let stopped = false;
          if (condition) {
            progress('conditioned-frame');
            check();
            const decision = await onFrame({
              index,
              direction,
              initial: index === anchorIndex,
              lowLogits: condition.lowLogits,
              nativeLogits: condition.nativeLogits,
              pointer: condition.pointer,
              objectScore: condition.objectScore,
              selectedIou: condition.selectedIou,
            });
            check();
            if (decision !== undefined)
              throw new Error('Correction snapshots cannot stop on a conditioned source plane.');
            completedFrames++;
            trimHistory(recent, index, direction);
            progress('frame-complete');
          } else stopped = (await compute()) === 'stop-direction';
          directionEndpoints[direction === 1 ? 'forward' : 'reverse'] = index;
          if (stopped) break;
        }
        recent.clear();
        progress('direction-released');
      }
      return { completedFrames, ...(options.allowDirectionStop ? { directionEndpoints } : {}) };
    } finally {
      conditioning.clear();
      recent.clear();
      releaseFrame();
      progress('snapshot-released');
    }
  }

  return {
    async run(options) {
      if (disposed) throw new Error('Tracking controller is disposed.');
      if (operation) throw new Error('Only one source frame stream can run at a time.');
      // Caller callbacks may edit their inputs; this run keeps the exact submitted geometry, range and prompts.
      const snapshot: TrackingOptions = {
        ...options,
        sourceRange: [options.sourceRange[0], options.sourceRange[1]],
        points: options.points.map((point) => [...point]),
        labels: [...options.labels],
      };
      const running = Promise.resolve().then(() => runFrames(snapshot));
      operation = running;
      try {
        return await running;
      } finally {
        operation = null;
      }
    },
    async runSnapshot(options) {
      if (disposed) throw new Error('Tracking controller is disposed.');
      if (operation) throw new Error('Only one source frame stream can run at a time.');
      const snapshot = snapshotSelection(options);
      operation = Promise.resolve().then(() => runSelection(snapshot));
      try {
        return await operation;
      } finally {
        operation = null;
      }
    },
    dispose() {
      if (!closing) {
        disposed = true;
        closing = (async () => {
          await operation?.catch(() => {});
          const releases = await Promise.allSettled(Object.values(sessions).map((session) => session.release()));
          const failed = releases.find((result) => result.status === 'rejected');
          if (failed) throw failed.reason;
        })();
      }
      return closing;
    },
  };
}
