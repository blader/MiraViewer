import { createTrackingController, type TrackingGraph, type TrackingSessions } from '../interactiveTracking';
import { loadOrtAll } from '../onnx/ortLoader';
import { loadTrackingAsset } from './loadAsset';
import manifest from './assetManifest.json';

/** GPU placements are retained for explicit diagnostics, never selected by production admission. */
export type InteractiveTrackingProvider = 'wasm' | 'hybrid' | 'gpu-memory' | 'webgpu';

function supportsWasmThreads(): boolean {
  if (
    globalThis.crossOriginIsolated !== true ||
    typeof SharedArrayBuffer !== 'function' ||
    typeof Worker !== 'function' ||
    typeof MessageChannel !== 'function' ||
    typeof WebAssembly === 'undefined' ||
    !WebAssembly.validate(
      // Same threaded-instruction capability probe used by the installed ORT runtime.
      new Uint8Array([
        0, 97, 115, 109, 1, 0, 0, 0, 1, 4, 1, 96, 0, 0, 3, 2, 1, 0, 5, 4, 1, 3, 1, 1, 10, 11, 1, 9, 0, 65, 0, 254, 16,
        2, 0, 26, 11,
      ]),
    )
  )
    return false;
  const channel = new MessageChannel();
  try {
    channel.port1.postMessage(new SharedArrayBuffer(1));
    return true;
  } finally {
    try {
      channel.port1.close();
    } finally {
      channel.port2.close();
    }
  }
}

/** Each caller owns one model. Partial setup and cancellation release every created session. */
export async function createInteractiveTrackingModel({
  provider,
  wasmThreads = 1,
  signal,
  onProgress,
}: {
  provider: InteractiveTrackingProvider;
  /** Normal workers request auto; explicit diagnostic counts and the omitted default remain stable. */
  wasmThreads?: 1 | 4 | 'auto';
  signal?: AbortSignal;
  onProgress?: (asset: TrackingGraph) => void;
}) {
  const sessions: Partial<TrackingSessions> = {};
  try {
    signal?.throwIfAborted();
    if (provider !== 'wasm' && provider !== 'hybrid' && provider !== 'gpu-memory' && provider !== 'webgpu')
      throw new Error('Choose an explicit interactive selection runtime.');
    if (wasmThreads !== 1 && wasmThreads !== 4 && wasmThreads !== 'auto')
      throw new Error('Interactive selection supports one or four WASM threads, or automatic selection.');
    const hardwareThreads = typeof navigator === 'undefined' ? 0 : navigator.hardwareConcurrency;
    let selectedThreads: 1 | 4 = 1;
    if (
      wasmThreads === 4 ||
      (wasmThreads === 'auto' && provider === 'wasm' && Number.isSafeInteger(hardwareThreads) && hardwareThreads >= 4)
    ) {
      let supported = false;
      try {
        supported = supportsWasmThreads();
      } catch (error) {
        // Only capability probing can select one thread. No runtime/session retry is permitted.
        if (wasmThreads !== 'auto') throw error;
      }
      if (!supported && wasmThreads === 4)
        throw new Error('Four-thread selection diagnostics require an isolated browser with shared WASM memory.');
      if (supported) selectedThreads = 4;
    }
    const ort = await loadOrtAll();
    signal?.throwIfAborted();
    if (selectedThreads === 4 && ort.env.wasm.proxy) {
      if (wasmThreads !== 'auto')
        throw new Error('Four-thread selection diagnostics require their directly owned worker, not a proxy runtime.');
      selectedThreads = 1;
    }
    // This factory owns the dedicated runtime's configuration before its first session.
    ort.env.wasm.numThreads = selectedThreads;
    // Serial setup bounds transient model downloads and compilation buffers.
    for (const name of Object.keys(manifest.graphs) as TrackingGraph[]) {
      onProgress?.(name);
      signal?.throwIfAborted();
      const bytes = await loadTrackingAsset(name, signal);
      signal?.throwIfAborted();
      if (selectedThreads === 4 && ort.env.wasm.numThreads !== 4)
        throw new Error('The runtime did not retain the explicitly requested four WASM threads.');
      const graphProvider =
        provider === 'webgpu' ||
        (provider === 'hybrid' && name === 'encoder') ||
        (provider === 'gpu-memory' && name === 'memoryAttention')
          ? 'webgpu'
          : 'wasm';
      sessions[name] = await ort.InferenceSession.create(bytes, {
        // Diagnostic placement is explicit; failures never select a fallback.
        executionProviders: [graphProvider],
        graphOptimizationLevel: 'all',
        preferredOutputLocation: 'cpu',
      });
      signal?.throwIfAborted();
      if (selectedThreads === 4 && ort.env.wasm.numThreads !== 4)
        throw new Error('The runtime did not retain the explicitly requested four WASM threads.');
    }
    const positionBytes = await loadTrackingAsset('memoryPosition', signal);
    const temporalBytes = await loadTrackingAsset('temporalPositions', signal);
    signal?.throwIfAborted();
    const floats = (bytes: Uint8Array<ArrayBuffer>) => {
      const values = new Float32Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 4);
      if (new Uint8Array(Uint32Array.of(1).buffer)[0] !== 1) {
        const source = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
        return Float32Array.from(values, (_, index) => source.getFloat32(index * 4, true));
      }
      return values;
    };
    return createTrackingController({
      ort,
      sessions: sessions as TrackingSessions,
      position: floats(positionBytes),
      temporalPosition: floats(temporalBytes),
    });
  } catch (error) {
    await Promise.allSettled(Object.values(sessions).map((session) => session.release()));
    throw error;
  }
}
