import type { SeededVolumeInput, SeededVolumeResult } from './seededVolume';

export type SeededWorkerRequest =
  | ({ type: 'init' } & Pick<SeededVolumeInput, 'volume' | 'observedSupport' | 'dims' | 'voxelSizeMm'>)
  | ({ type: 'run'; id: number } & Pick<SeededVolumeInput, 'foreground' | 'background' | 'bounds'>)
  | { type: 'cancel'; id: number };

export type SeededWorkerResponse =
  | { type: 'progress'; id: number; processed: number; total: number }
  | { type: 'done'; id: number; result: SeededVolumeResult }
  | { type: 'error'; id: number; message: string };

type Pending = {
  id: number;
  resolve: (result: SeededVolumeResult) => void;
  reject: (error: Error) => void;
  cleanup: () => void;
  onProgress?: (processed: number, total: number) => void;
};

/** One retained worker-side source; marks and results belong to a single cancellable request. */
export class SeededVolumeWorker {
  private worker: Worker | null = null;
  private source: Float32Array | null = null;
  private support?: Uint8Array;
  private geometry = '';
  private pending: Pending | null = null;
  private sequence = 0;

  run(input: SeededVolumeInput, options: { signal?: AbortSignal; onProgress?: Pending['onProgress'] } = {}) {
    if (options.signal?.aborted) return Promise.reject(new DOMException('Segmentation cancelled.', 'AbortError'));
    if (typeof Worker === 'undefined')
      return Promise.reject(
        new Error('Selection growth requires browser worker support. Direct brush editing is still available.'),
      );
    const geometry = JSON.stringify([input.dims, input.voxelSizeMm]);
    if (this.source !== input.volume || this.support !== input.observedSupport || this.geometry !== geometry) {
      this.dispose();
      try {
        this.worker = new Worker(new URL('./seededVolume.worker.ts', import.meta.url), { type: 'module' });
        const worker = this.worker;
        this.worker.onmessage = ({ data }: MessageEvent<SeededWorkerResponse>) => {
          if (this.worker !== worker) return;
          const pending = this.pending;
          if (!pending || pending.id !== data.id) return;
          if (data.type === 'progress') pending.onProgress?.(data.processed, data.total);
          else {
            this.pending = null;
            pending.cleanup();
            if (data.type === 'done') pending.resolve(data.result);
            else pending.reject(new Error(data.message));
          }
        };
        this.worker.onerror = () => {
          if (this.worker === worker)
            this.fail(new Error('Selection computation failed. Your previous selection is unchanged.'));
        };
        this.worker.onmessageerror = () => {
          if (this.worker === worker)
            this.fail(new Error('The selection worker returned unreadable data. Please retry.'));
        };
        this.worker.postMessage({
          type: 'init',
          volume: input.volume,
          observedSupport: input.observedSupport,
          dims: input.dims,
          voxelSizeMm: input.voxelSizeMm,
        } satisfies SeededWorkerRequest);
        this.source = input.volume;
        this.support = input.observedSupport;
        this.geometry = geometry;
      } catch (error) {
        this.dispose();
        return Promise.reject(error instanceof Error ? error : new Error(String(error)));
      }
    }
    this.cancel();
    const id = ++this.sequence;
    return new Promise<SeededVolumeResult>((resolve, reject) => {
      const cancel = () => {
        if (this.pending?.id === id) this.cancel();
      };
      const timeout = window.setTimeout(() => {
        if (this.pending?.id === id)
          this.fail(new Error('Selection took too long. Keep the marks closer together and retry.'));
      }, 30_000);
      this.pending = {
        id,
        resolve,
        reject,
        onProgress: options.onProgress,
        cleanup: () => {
          window.clearTimeout(timeout);
          options.signal?.removeEventListener('abort', cancel);
        },
      };
      options.signal?.addEventListener('abort', cancel, { once: true });
      try {
        this.worker!.postMessage({
          type: 'run',
          id,
          foreground: input.foreground,
          background: input.background,
          bounds: input.bounds,
        } satisfies SeededWorkerRequest);
      } catch (error) {
        this.fail(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  cancel(): void {
    const pending = this.pending;
    if (!pending) return;
    this.pending = null;
    pending.cleanup();
    try {
      this.worker?.postMessage({ type: 'cancel', id: pending.id } satisfies SeededWorkerRequest);
    } catch {
      // Cancellation must still settle if the worker has already become unavailable.
      this.worker?.terminate();
      this.worker = null;
      this.source = null;
      this.support = undefined;
      this.geometry = '';
    }
    pending.reject(new DOMException('Segmentation cancelled.', 'AbortError'));
  }

  private fail(error: Error): void {
    const pending = this.pending;
    this.pending = null;
    pending?.cleanup();
    pending?.reject(error);
    this.dispose();
  }

  dispose(): void {
    this.cancel();
    this.worker?.terminate();
    this.worker = null;
    this.source = null;
    this.support = undefined;
    this.geometry = '';
  }
}
