import type * as Ort from 'onnxruntime-web';
import type { CustomModelRequest, CustomModelResponse, CustomModelResult } from './customModelWorker';
import { verifyTumorModelManifest } from './modelManifest';
import { createOrtSessionFromModelBlob } from './ortLoader';
import { runTumorSegmentationOnnx } from './tumorSegmentation';
import { assertTumorModelGrid, prepareTumorModelInput } from './volumeInput';

export async function executeCustomModel(
  request: CustomModelRequest,
  postMessage: (message: CustomModelResponse, transfer?: Transferable[]) => void,
): Promise<void> {
  let session: Ort.InferenceSession | undefined;
  let initializing = false;
  let result: CustomModelResult | undefined;
  try {
    const manifest = await verifyTumorModelManifest(request.model, request.manifest);
    assertTumorModelGrid(request.volume, manifest);
    initializing = true;
    session = await createOrtSessionFromModelBlob({
      model: request.model,
      preferWebGpu: request.mode === 'webgpu-preferred',
      logLevel: 'warning',
    });
    initializing = false;
    postMessage({ type: 'running', mode: request.mode });
    const input = await prepareTumorModelInput(request.volume);
    performance.mark('custom-model:inference-start');
    postMessage({ type: 'inference' });
    const { labels } = await runTumorSegmentationOnnx({ session, volume: input, dims: request.volume.dims });
    performance.mark('custom-model:inference-end');
    if (request.volume.observedSupport)
      for (let index = 0; index < labels.length; index++) if (!request.volume.observedSupport[index]) labels[index] = 0;
    result = { labels, mode: request.mode, manifest };
    // A stuck release is covered by the same operation deadline. Cancel/timeout
    // never waits for cooperative session cleanup: the parent terminates us.
    await session.release();
    session = undefined;
    postMessage({ type: 'done', result }, [result.labels.buffer]);
  } catch (error) {
    postMessage({
      type: 'error',
      message: error instanceof Error ? error.message : String(error),
      initializationFailed: initializing,
    });
    // The error message synchronously retires this worker at the parent owner.
    // Do not await a second release or attempt provider replacement here.
  }
}

if (typeof document === 'undefined') {
  const scope = self as unknown as {
    onmessage: ((event: MessageEvent<CustomModelRequest>) => void) | null;
    postMessage: (message: CustomModelResponse, transfer?: Transferable[]) => void;
  };
  scope.onmessage = ({ data }) => {
    scope.onmessage = null;
    void executeCustomModel(data, (message, transfer) => scope.postMessage(message, transfer));
  };
}
