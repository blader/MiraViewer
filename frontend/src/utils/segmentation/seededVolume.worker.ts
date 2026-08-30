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
  let lastYield = performance.now();
  let lastProgress = -Infinity;
  void segmentSeededVolume(
    { ...source, ...data },
    {
      signal: run.controller.signal,
      // Poll cancellation frequently without paying a clamped browser timer for
      // every cheap scan chunk. No long uninterrupted worker phase is introduced.
      yieldFn: async () => {
        if (performance.now() - lastYield < 8) return;
        await new Promise<void>((resolve) => setTimeout(resolve, 0));
        lastYield = performance.now();
      },
      onProgress: (processed, total) => {
        if (active !== run || run.controller.signal.aborted) return;
        const now = performance.now();
        if (processed < total && now - lastProgress < 50) return;
        lastProgress = now;
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
