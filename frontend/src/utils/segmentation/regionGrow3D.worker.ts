import { regionGrow3D_v2 } from './regionGrow3D_v2';
import type { RegionGrow3DWorkerRequest, RegionGrow3DWorkerResponse } from './regionGrow3DWorker';

const workerScope = globalThis as unknown as {
  onmessage: ((event: MessageEvent<RegionGrow3DWorkerRequest>) => void) | null;
  postMessage: (message: RegionGrow3DWorkerResponse, transfer?: Transferable[]) => void;
};

let volume: Float32Array | null = null;
let dims: [number, number, number] | null = null;
let activeRun: { runId: number; controller: AbortController } | null = null;

workerScope.onmessage = ({ data }) => {
  if (data.type === 'init') {
    activeRun?.controller.abort();
    activeRun = null;
    volume = data.volume;
    dims = data.dims;
    return;
  }

  if (data.type === 'cancel') {
    if (activeRun?.runId === data.runId) activeRun.controller.abort();
    return;
  }

  activeRun?.controller.abort();
  if (!volume || !dims) {
    workerScope.postMessage({ type: 'error', runId: data.runId, message: 'The 3D volume was not initialized.' });
    return;
  }

  const controller = new AbortController();
  const run = { runId: data.runId, controller };
  activeRun = run;

  void regionGrow3D_v2({
    volume,
    dims,
    seed: data.seed,
    min: data.min,
    max: data.max,
    roi: data.roi,
    opts: {
      signal: controller.signal,
      maxVoxels: data.maxVoxels,
      connectivity: 6,
      yieldEvery: data.yieldEvery,
      debug: data.debug,
      yieldFn: () => new Promise<void>((resolve) => setTimeout(resolve, 0)),
      onProgress: (progress) => {
        if (activeRun === run && !controller.signal.aborted) {
          workerScope.postMessage({ type: 'progress', runId: run.runId, progress });
        }
      },
    },
  })
    .then((result) => {
      if (activeRun !== run || controller.signal.aborted) return;
      activeRun = null;
      // Region-grow results are often views into a much larger scratch buffer.
      const indices =
        result.indices.byteLength === result.indices.buffer.byteLength
          ? result.indices
          : new Uint32Array(result.indices);
      workerScope.postMessage({ type: 'done', runId: run.runId, result: { ...result, indices } }, [indices.buffer]);
    })
    .catch((error: unknown) => {
      if (activeRun !== run || controller.signal.aborted) return;
      activeRun = null;
      workerScope.postMessage({
        type: 'error',
        runId: run.runId,
        message: error instanceof Error ? error.message : String(error),
      });
    });
};
