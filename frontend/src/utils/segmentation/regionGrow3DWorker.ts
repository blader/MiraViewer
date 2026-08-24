import type { RegionGrow3DResult, RegionGrow3DRoi, Vec3i } from './regionGrow3D_v2';

type Progress = { processed: number; queued: number };

export type RegionGrow3DWorkerRequest =
  | { type: 'init'; volume: Float32Array; dims: [number, number, number] }
  | {
      type: 'run';
      runId: number;
      seed: Vec3i;
      min: number;
      max: number;
      roi: RegionGrow3DRoi;
      maxVoxels: number;
      yieldEvery: number;
      debug: boolean;
    }
  | { type: 'cancel'; runId: number };

export type RegionGrow3DWorkerResponse =
  | { type: 'progress'; runId: number; progress: Progress }
  | { type: 'done'; runId: number; result: RegionGrow3DResult }
  | { type: 'error'; runId: number; message: string };

type RunOptions = {
  volume: Float32Array;
  dims: [number, number, number];
  seed: Vec3i;
  min: number;
  max: number;
  roi: RegionGrow3DRoi;
  maxVoxels: number;
  yieldEvery: number;
  debug?: boolean;
  signal?: AbortSignal;
  onProgress?: (progress: Progress) => void;
};

type PendingRun = {
  runId: number;
  resolve: (result: RegionGrow3DResult) => void;
  reject: (error: Error) => void;
  signal?: AbortSignal;
  onAbort: () => void;
  onProgress?: (progress: Progress) => void;
};

function abortError(): Error {
  return new DOMException('3D segmentation was cancelled.', 'AbortError');
}

/** Keeps one worker-side copy of a volume across interactive threshold previews. */
export class RegionGrow3DWorkerController {
  private worker: Worker | null = null;
  private volume: Float32Array | null = null;
  private pending: PendingRun | null = null;
  private nextRunId = 0;

  run(options: RunOptions): Promise<RegionGrow3DResult> {
    if (options.signal?.aborted) return Promise.reject(abortError());

    if (this.volume !== options.volume) {
      this.dispose();
      try {
        if (typeof Worker === 'undefined') {
          throw new Error('3D segmentation requires browser worker support.');
        }
        this.worker = new Worker(new URL('./regionGrow3D.worker.ts', import.meta.url), { type: 'module' });
        this.worker.onmessage = (event: MessageEvent<RegionGrow3DWorkerResponse>) => {
          this.handleMessage(event.data);
        };
        this.worker.onerror = (event: ErrorEvent) => {
          const pending = this.pending;
          if (pending)
            this.finish(pending, () => pending.reject(new Error(event.message || '3D segmentation failed.')));
          this.worker?.terminate();
          this.worker = null;
          this.volume = null;
        };
        // Do not transfer: the renderer still owns and reads its original volume.
        this.worker.postMessage({
          type: 'init',
          volume: options.volume,
          dims: options.dims,
        } satisfies RegionGrow3DWorkerRequest);
        this.volume = options.volume;
      } catch (error) {
        this.dispose();
        return Promise.reject(error instanceof Error ? error : new Error(String(error)));
      }
    }

    const previous = this.pending;
    if (previous) {
      this.worker?.postMessage({ type: 'cancel', runId: previous.runId } satisfies RegionGrow3DWorkerRequest);
      this.finish(previous, () => previous.reject(abortError()));
    }

    const runId = ++this.nextRunId;
    return new Promise<RegionGrow3DResult>((resolve, reject) => {
      const pending: PendingRun = {
        runId,
        resolve,
        reject,
        signal: options.signal,
        onProgress: options.onProgress,
        onAbort: () => {
          if (this.pending !== pending) return;
          this.worker?.postMessage({ type: 'cancel', runId } satisfies RegionGrow3DWorkerRequest);
          this.finish(pending, () => reject(abortError()));
        },
      };
      this.pending = pending;
      options.signal?.addEventListener('abort', pending.onAbort, { once: true });

      this.worker?.postMessage({
        type: 'run',
        runId,
        seed: options.seed,
        min: options.min,
        max: options.max,
        roi: options.roi,
        maxVoxels: options.maxVoxels,
        yieldEvery: options.yieldEvery,
        debug: options.debug === true,
      } satisfies RegionGrow3DWorkerRequest);
    });
  }

  dispose(): void {
    const pending = this.pending;
    if (pending) this.finish(pending, () => pending.reject(abortError()));
    this.worker?.terminate();
    this.worker = null;
    this.volume = null;
  }

  private handleMessage(message: RegionGrow3DWorkerResponse): void {
    const pending = this.pending;
    if (!pending || pending.runId !== message.runId) return;
    if (message.type === 'progress') {
      pending.onProgress?.(message.progress);
      return;
    }
    if (message.type === 'done') {
      this.finish(pending, () => pending.resolve(message.result));
      return;
    }
    this.finish(pending, () => pending.reject(new Error(message.message)));
  }

  private finish(pending: PendingRun, settle: () => void): void {
    if (this.pending === pending) this.pending = null;
    pending.signal?.removeEventListener('abort', pending.onAbort);
    settle();
  }
}
