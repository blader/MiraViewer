import { createSyntheticCustomModel } from '../helpers/customTumorModel';
import { customModelWorkingMemory, runCustomModelWorker } from '../../src/utils/segmentation/onnx/customModelWorker';
import type { SvrVolume } from '../../src/types/svr';

export async function measureCustomModel(cancel = false, calibration = false) {
  const [model, manifest] = await createSyntheticCustomModel(calibration ? 'calibration' : cancel ? 'slow' : 'small');
  const size = calibration ? 128 : cancel ? 72 : 24;
  const count = size ** 3;
  const volume: SvrVolume = {
    dims: [size, size, size],
    voxelSizeMm: [1, 1, 1],
    originMm: [0, 0, 0],
    boundsMm: { min: [0, 0, 0], max: [size, size, size] },
    intensityRange: [0, 1],
    data: Float32Array.from({ length: count }, (_, index) => (index % 101) / 100),
    observedSupport: Uint8Array.from({ length: count }, (_, index) => (index % 17 === 0 ? 0 : 1)),
  };
  const controller = new AbortController();
  let inferenceStartedAt: number | null = null,
    cancelAt: number | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let animationCallbacks = 0,
    frame = 0;
  const tick = () => {
    animationCallbacks++;
    frame = requestAnimationFrame(tick);
  };
  frame = requestAnimationFrame(tick);
  const working = customModelWorkingMemory(model.size, volume.dims, volume.observedSupport!.byteLength);
  const estimatedPeakBytes = working.totalBytes + volume.data.byteLength + volume.observedSupport!.byteLength;
  const started = performance.now();
  let output: Uint8Array | undefined;
  let error: { name: string; message: string } | null = null;
  try {
    output = (
      await runCustomModelWorker(
        { model, manifest, volume },
        {
          mode: 'wasm',
          signal: controller.signal,
          estimatedPeakBytes,
          onInference: () => {
            inferenceStartedAt = performance.now();
            if (cancel)
              timer = setTimeout(() => {
                cancelAt = performance.now();
                controller.abort();
              }, 100);
          },
        },
      )
    ).labels;
  } catch (failure) {
    error = { name: (failure as Error).name, message: String(failure) };
  } finally {
    clearTimeout(timer);
    cancelAnimationFrame(frame);
  }
  const finished = performance.now();
  const expected = (value: number) => (value >= 0.5 ? 1 : 2);
  let mismatches = 0;
  if (output)
    for (let index = 0; index < count; index++) {
      if (output[index] !== (volume.observedSupport![index] ? expected(volume.data[index]!) : 0)) mismatches++;
    }
  return {
    cancel,
    calibration,
    size,
    modelBytes: model.size,
    estimatedPeakBytes,
    working,
    elapsedMs: finished - started,
    inferenceStartedAt,
    cancelAt,
    cancelToReturnMs: cancelAt === null ? null : finished - cancelAt,
    animationCallbacks,
    outputCount: output?.length ?? 0,
    mismatches,
    error,
    sourceUnchanged: volume.data.every((value, index) => value === Math.fround((index % 101) / 100)),
    provider: 'wasm',
    wasmThreads: crossOriginIsolated ? Math.max(1, Math.min(8, navigator.hardwareConcurrency || 1)) : 1,
  };
}
