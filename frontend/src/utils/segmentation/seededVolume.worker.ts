import { segmentSeededVolume } from './seededVolume';
import type { SeededWorkerRequest, SeededWorkerResponse } from './seededVolumeWorker';

const scope = globalThis as unknown as {
  onmessage: (event: MessageEvent<SeededWorkerRequest>) => void;
  postMessage: (message: SeededWorkerResponse, transfer?: Transferable[]) => void;
};
let source: Extract<SeededWorkerRequest, { type: 'init' }> | null = null;
let active: { id: number; controller: AbortController } | null = null;

scope.onmessage = ({ data }) => {
  if (data.type === 'cancel') {
    if (active?.id === data.id) active.controller.abort();
    return;
  }
  active?.controller.abort();
  active = null;
  if (data.type === 'init') {
    source = data;
    return;
  }
  if (!source) {
    scope.postMessage({ type: 'error', id: data.id, message: 'Load a reconstruction before segmenting.' });
    return;
  }
  const run = { id: data.id, controller: new AbortController() };
  active = run;
  void segmentSeededVolume(
    { ...source, ...data },
    {
      signal: run.controller.signal,
      yieldFn: () => new Promise((resolve) => setTimeout(resolve, 0)),
      onProgress: (processed, total) => {
        if (active === run && !run.controller.signal.aborted)
          scope.postMessage({ type: 'progress', id: run.id, processed, total });
      },
    },
  )
    .then((result) => {
      if (active !== run || run.controller.signal.aborted) return;
      active = null;
      scope.postMessage({ type: 'done', id: run.id, result }, [result.indices.buffer]);
    })
    .catch((error: unknown) => {
      if (active !== run || run.controller.signal.aborted) return;
      active = null;
      scope.postMessage({ type: 'error', id: run.id, message: error instanceof Error ? error.message : String(error) });
    });
};
