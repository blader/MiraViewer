import type { SvrVolume } from '../../../types/svr';
import { learnedImagingBudgetBytes } from '../learnedMemoryBudget';
import type { TumorModelManifest } from './modelManifest';

export type CustomModelMode = 'webgpu-preferred' | 'wasm';
export type CustomModelInputVolume = Pick<
  SvrVolume,
  | 'data'
  | 'dims'
  | 'originMm'
  | 'voxelSizeMm'
  | 'boundsMm'
  | 'direction'
  | 'intensityRange'
  | 'nativeVoxelSizeMm'
  | 'observedSupport'
>;
export type CustomModelResult = { labels: Uint8Array; mode: CustomModelMode; manifest: TumorModelManifest };
export type CustomModelRequest = {
  model: Blob;
  manifest: Blob | null;
  volume: CustomModelInputVolume;
  mode: CustomModelMode;
};
export type CustomModelResponse =
  | { type: 'running'; mode: CustomModelMode }
  | { type: 'inference' }
  | { type: 'done'; result: CustomModelResult }
  | { type: 'error'; message: string; initializationFailed?: boolean };

export const CUSTOM_MODEL_INIT_TIMEOUT_MS = 30_000;
export const CUSTOM_MODEL_RUN_TIMEOUT_MS = 120_000;
export function customModelBudgetBytes(): number {
  return learnedImagingBudgetBytes(
    typeof navigator === 'undefined' ? undefined : (navigator as Navigator & { deviceMemory?: number }).deviceMemory,
  );
}
/**
 * An admission allowance, not a claim to inspect ORT's opaque allocator. Reserve
 * encoded bytes, CPU/compiled weights and a possible GPU copy, plus a 256 MiB
 * session/arena floor. Tensors, immutable source copies and live UI owners are
 * counted separately. A 128 MiB floor undershot the observed renderer growth in
 * the 128-cube/20 MiB browser fixture; this remains an allowance, not a hard cap.
 * The worker is never retained between suggestions.
 */
export function customModelRuntimeBytes(modelBytes: number): number {
  if (!Number.isSafeInteger(modelBytes) || modelBytes < 0) throw new Error('Invalid custom-model byte count.');
  return 256 * 1024 * 1024 + modelBytes * 4;
}

export function customModelWorkingMemory(modelBytes: number, dims: readonly number[], supportBytes: number) {
  const nvox = dims.reduce((count, size) => count * size, 1);
  if (
    dims.length !== 3 ||
    dims.some((size) => !Number.isSafeInteger(size) || size < 1) ||
    !Number.isSafeInteger(nvox) ||
    !Number.isSafeInteger(supportBytes) ||
    supportBytes < 0
  )
    throw new Error('Custom inference requires valid dimensions and source-support bytes.');
  const modelRuntimeBytes = customModelRuntimeBytes(modelBytes);
  const inputBytes = nvox * 4;
  const preprocessingBytes = nvox * 8 + supportBytes; // Immutable worker copy + normalization.
  const logitsBytes = nvox * 4 * 4;
  const labelBytes = nvox * 2; // Published result and transport/previous-output overlap.
  return {
    nvox,
    modelRuntimeBytes,
    inputBytes,
    preprocessingBytes,
    logitsBytes,
    labelBytes,
    totalBytes: modelRuntimeBytes + inputBytes + preprocessingBytes + logitsBytes + labelBytes,
  };
}

/** One operation per worker. Termination, not a result-id change, owns cancellation. */
export async function runCustomModelWorker(
  input: Omit<CustomModelRequest, 'mode'>,
  options: {
    signal: AbortSignal;
    estimatedPeakBytes: number;
    budgetBytes?: number;
    onRunning?: (mode: CustomModelMode) => void;
    onInference?: () => void;
    /** Explicit WASM is also useful for a reproducible browser qualification. */
    mode?: CustomModelMode;
  },
): Promise<CustomModelResult> {
  options.signal.throwIfAborted();
  const working = customModelWorkingMemory(
    input.model.size,
    input.volume.dims,
    input.volume.observedSupport?.byteLength ?? 0,
  );
  if (
    working.nvox !== input.volume.data.length ||
    (input.volume.observedSupport && input.volume.observedSupport.length !== working.nvox)
  )
    throw new Error('Custom inference requires matching source and support dimensions.');
  const budgetBytes = options.budgetBytes ?? customModelBudgetBytes();
  if (
    !Number.isSafeInteger(budgetBytes) ||
    budgetBytes <= 0 ||
    budgetBytes > customModelBudgetBytes() ||
    !Number.isSafeInteger(options.estimatedPeakBytes) ||
    options.estimatedPeakBytes < working.totalBytes ||
    options.estimatedPeakBytes > budgetBytes
  )
    throw new Error('Custom-model execution exceeds its admitted resident-memory budget.');
  if (typeof Worker === 'undefined') throw new Error('Custom models require Web Worker support.');

  const run = (mode: CustomModelMode) =>
    new Promise<CustomModelResult>((resolve, reject) => {
      options.signal.throwIfAborted();
      const worker = new Worker(new URL('./customModel.worker.ts', import.meta.url), { type: 'module' });
      let settled = false;
      let running = false;
      let inference = false;
      let timer: ReturnType<typeof setTimeout>;
      const finish = (result?: CustomModelResult, error?: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        options.signal.removeEventListener('abort', cancel);
        worker.onmessage = null;
        worker.onerror = null;
        worker.onmessageerror = null;
        worker.terminate();
        if (error) reject(error);
        else resolve(result!);
      };
      const cancel = () => finish(undefined, new DOMException('Model suggestion canceled.', 'AbortError'));
      const deadline = (milliseconds: number, phase: string) => {
        clearTimeout(timer);
        timer = setTimeout(
          () =>
            finish(
              undefined,
              new Error(
                `Model ${phase} exceeded its ${milliseconds / 1000}-second limit. The worker was stopped; your selection is unchanged.`,
              ),
            ),
          milliseconds,
        );
      };
      deadline(CUSTOM_MODEL_INIT_TIMEOUT_MS, 'initialization');
      worker.onmessage = (event: MessageEvent<CustomModelResponse>) => {
        const response = event.data;
        if (response?.type === 'running' && !running) {
          running = true;
          deadline(CUSTOM_MODEL_RUN_TIMEOUT_MS, 'execution');
          options.onRunning?.(mode);
        } else if (response?.type === 'inference' && running && !inference) {
          inference = true;
          options.onInference?.();
        } else if (response?.type === 'done' && inference) {
          const result = response.result;
          if (
            !(result?.labels instanceof Uint8Array) ||
            result.labels.length !== input.volume.data.length ||
            result.labels.some((label) => ![0, 1, 2, 4].includes(label))
          )
            finish(undefined, new Error('The model worker returned incompatible labels.'));
          else finish(result);
        } else if (response?.type === 'error') {
          const error = new Error(response.message || 'The model worker failed.');
          error.name = response.initializationFailed && !running ? 'ModelProviderInitializationError' : 'Error';
          finish(undefined, error);
        } else finish(undefined, new Error('The model worker returned an invalid response.'));
      };
      worker.onerror = (event) => finish(undefined, new Error(event.message || 'The model worker failed.'));
      worker.onmessageerror = () => finish(undefined, new Error('The model worker response could not be read.'));
      options.signal.addEventListener('abort', cancel, { once: true });
      if (options.signal.aborted) return cancel();
      try {
        // Structured clone preserves the accepted source. Its worker-owned copy
        // is included in admission; transferring the live image would detach it.
        worker.postMessage({ ...input, mode } satisfies CustomModelRequest);
      } catch (error) {
        finish(undefined, error instanceof Error ? error : new Error(String(error)));
      }
    });

  const mode = options.mode ?? 'webgpu-preferred';
  try {
    return await run(mode);
  } catch (error) {
    // Never create a second provider in a possibly poisoned/resident first realm.
    // The first worker has terminated before its replacement can be admitted.
    if (mode !== 'wasm' && error instanceof Error && error.name === 'ModelProviderInitializationError') {
      options.signal.throwIfAborted();
      return run('wasm');
    }
    throw error;
  }
}
