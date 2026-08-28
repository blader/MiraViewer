import type { SvrVolume } from '../../types/svr';
import {
  MAX_SR_OUTPUT_VOXELS,
  MIN_SR_CONTEXT_DIM,
  type SvrEnhancedVolume,
  type SvrSuperResolutionOptions,
  type SvrSuperResolutionWorkerResponse,
} from './superResolutionTypes';
import { IDENTITY_DIRECTION, volumeVoxelToPatient } from './volumeGeometry';

function finiteArray(value: unknown, length: number): value is number[] {
  return (
    Array.isArray(value) &&
    value.length === length &&
    value.every((item) => typeof item === 'number' && Number.isFinite(item))
  );
}

function finiteGeometry(volume: Partial<SvrVolume>): boolean {
  return (
    finiteArray(volume.originMm, 3) &&
    finiteArray(volume.voxelSizeMm, 3) &&
    volume.voxelSizeMm.every((pitch) => pitch > 0) &&
    (volume.direction === undefined || finiteArray(volume.direction, 9)) &&
    finiteArray(volume.boundsMm?.min, 3) &&
    finiteArray(volume.boundsMm?.max, 3)
  );
}

/** Validate the small protocol envelope here; the core and renderer own full pixel-value validation. */
function validResult(value: unknown, source: SvrVolume): value is SvrEnhancedVolume {
  if (!value || typeof value !== 'object') return false;
  const result = value as Partial<SvrEnhancedVolume>;
  if (
    !finiteGeometry(result) ||
    !finiteArray(result.dims, 3) ||
    result.dims.some((size, axis) => size !== source.dims[axis]! * 2) ||
    !(result.data instanceof Float32Array) ||
    result.data.length !== source.data.length * 8 ||
    !(result.observedSupport instanceof Uint8Array) ||
    result.observedSupport.length !== result.data.length ||
    (result.intensityRange !== undefined && !finiteArray(result.intensityRange, 2)) ||
    (result.displayWindow !== undefined && !finiteArray(result.displayWindow, 2)) ||
    (result.displayInvert !== undefined && typeof result.displayInvert !== 'boolean')
  )
    return false;
  const origin = volumeVoxelToPatient(source, [-0.25, -0.25, -0.25]);
  if (
    result.originMm!.some((value, axis) => Math.abs(value - origin[axis]!) > 1e-6) ||
    result.voxelSizeMm!.some((value, axis) => Math.abs(value * 2 - source.voxelSizeMm[axis]!) > 1e-6) ||
    (result.direction ?? IDENTITY_DIRECTION).some(
      (value, axis) => Math.abs(value - (source.direction ?? IDENTITY_DIRECTION)[axis]!) > 1e-6,
    )
  )
    return false;
  const stats = result.stats;
  return (
    !!stats &&
    typeof stats.method === 'string' &&
    [
      stats.trainingSamples,
      stats.calibrationSamples,
      stats.heldOutSamples,
      stats.trainingBlocks,
      stats.calibrationBlocks,
      stats.heldOutBlocks,
      stats.baselineMse,
      stats.enhancedMse,
      stats.consistencyMaxError,
      stats.durationMs,
      stats.modelStrength,
    ].every((value) => typeof value === 'number' && Number.isFinite(value) && value >= 0) &&
    stats.modelStrength <= 1
  );
}

/** Public callers keep ownership: only these dedicated copies are transferred to the disposable worker. */
export function runSuperResolution(
  input: SvrVolume,
  options: SvrSuperResolutionOptions = {},
): Promise<SvrEnhancedVolume> {
  if (options.signal?.aborted) return Promise.reject(new DOMException('Detail enhancement cancelled.', 'AbortError'));
  if (typeof Worker === 'undefined')
    return Promise.reject(
      new Error('Learned detail requires browser worker support. The original MRI remains available.'),
    );
  const count = Array.isArray(input?.dims) ? input.dims.reduce((product, size) => product * size, 1) : NaN;
  if (
    !(input?.data instanceof Float32Array) ||
    !finiteArray(input.dims, 3) ||
    input.dims.some((size) => !Number.isSafeInteger(size) || size < MIN_SR_CONTEXT_DIM) ||
    !Number.isSafeInteger(count) ||
    count !== input.data.length ||
    count * 8 > MAX_SR_OUTPUT_VOXELS ||
    (input.observedSupport !== undefined &&
      (!(input.observedSupport instanceof Uint8Array) || input.observedSupport.length !== count)) ||
    !finiteGeometry(input)
  )
    return Promise.reject(
      new Error(
        'Learned detail requires matching source dimensions and support within the memory budget, with finite 3D geometry.',
      ),
    );
  return new Promise((resolve, reject) => {
    let worker: Worker;
    try {
      worker = new Worker(new URL('./superResolution.worker.ts', import.meta.url), { type: 'module' });
    } catch (error) {
      reject(error);
      return;
    }
    let settled = false;
    const cleanup = () => {
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', abort);
      worker.onmessage = null;
      worker.onerror = null;
      worker.onmessageerror = null;
      worker.terminate();
    };
    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    };
    const abort = () => fail(new DOMException('Detail enhancement cancelled.', 'AbortError'));
    const timer = setTimeout(
      () =>
        fail(
          new Error('Learned detail exceeded its three-minute limit. Try a smaller region; the original is unchanged.'),
        ),
      180_000,
    );
    worker.onmessage = ({ data }: MessageEvent<SvrSuperResolutionWorkerResponse>) => {
      if (settled) return;
      try {
        if (!data || typeof data !== 'object') throw new Error('The detail worker returned an unreadable response.');
        if (data.type === 'progress') {
          const progress = data.progress;
          if (
            !progress ||
            !['preparing', 'training', 'validating', 'enhancing'].includes(progress.phase) ||
            !Number.isFinite(progress.current) ||
            !Number.isFinite(progress.total) ||
            progress.total <= 0 ||
            progress.current < 0 ||
            progress.current > progress.total ||
            typeof progress.message !== 'string'
          )
            throw new Error('The detail worker returned invalid progress.');
          options.onProgress?.(progress);
        } else if (data.type === 'done' && validResult(data.result, input)) {
          settled = true;
          cleanup();
          resolve(data.result);
        } else
          throw new Error(
            data.type === 'error' && typeof data.message === 'string'
              ? data.message
              : 'The detail worker returned an unreadable result.',
          );
      } catch (error) {
        fail(error instanceof Error ? error : new Error(String(error)));
      }
    };
    worker.onerror = (event) => fail(new Error(event.message || 'Learned detail failed. The original is unchanged.'));
    worker.onmessageerror = () =>
      fail(new Error('The detail worker returned unreadable data. The original is unchanged.'));
    options.signal?.addEventListener('abort', abort, { once: true });
    if (options.signal?.aborted) {
      abort();
      return;
    }
    try {
      const volume: SvrVolume = {
        data: input.data.slice(),
        observedSupport: input.observedSupport?.slice(),
        dims: [...input.dims],
        voxelSizeMm: [...input.voxelSizeMm],
        originMm: [...input.originMm],
        direction: input.direction ? [...input.direction] : undefined,
        boundsMm: { min: [...input.boundsMm.min], max: [...input.boundsMm.max] },
        intensityRange: input.intensityRange ? [...input.intensityRange] : undefined,
        displayWindow: input.displayWindow ? [...input.displayWindow] : undefined,
        displayInvert: input.displayInvert,
      };
      const transfer = [volume.data.buffer as ArrayBuffer];
      if (volume.observedSupport) transfer.push(volume.observedSupport.buffer as ArrayBuffer);
      worker.postMessage(volume, transfer);
    } catch (error) {
      fail(error instanceof Error ? error : new Error(String(error)));
    }
  });
}
