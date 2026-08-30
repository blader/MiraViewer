import {
  markedRegionBounds,
  MAX_SEGMENTATION_DOMAIN_VOXELS,
  voxelIndex,
  voxelPoint,
  type SeededVolumeInput,
  type SeededVolumeResult,
  type VoxelBounds,
} from './seededVolume';

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

/** Validate the core's exact native-grid domain before allocating any source copies. */
function sourceDomain(input: SeededVolumeInput) {
  const { volume, observedSupport, dims, voxelSizeMm, foreground, background } = input;
  const total = dims[0] * dims[1] * dims[2];
  if (
    dims.some((dimension) => !Number.isSafeInteger(dimension) || dimension < 1) ||
    !Number.isSafeInteger(total) ||
    total > 0xffffffff ||
    volume.length !== total ||
    (observedSupport && observedSupport.length !== total) ||
    voxelSizeMm.some((spacing, axis) => !Number.isFinite(spacing * dims[axis]!) || spacing <= 0)
  )
    throw new Error('Segmentation requires matching volume, physical spacing, and acquired-support geometry.');
  if (!foreground.length) throw new Error('Mark inside the tissue you want to select before suggesting a boundary.');
  for (const indices of [foreground, background])
    for (const index of indices)
      if (index >= total || !Number.isFinite(volume[index]) || (observedSupport && !observedSupport[index]))
        throw new Error('Place all marks on acquired MRI tissue. Missing data cannot seed a selection.');

  const requested = input.bounds ?? markedRegionBounds(input);
  const bounds: VoxelBounds = { min: { ...requested.min }, max: { ...requested.max } };
  const croppedDims = (['x', 'y', 'z'] as const).map((axis, position) => {
    const minimum = bounds.min[axis],
      maximum = bounds.max[axis];
    if (
      !Number.isInteger(minimum) ||
      !Number.isInteger(maximum) ||
      minimum < 0 ||
      maximum < minimum ||
      maximum >= dims[position]!
    )
      throw new Error('The segmentation search region is outside the acquired volume.');
    return maximum - minimum + 1;
  }) as [number, number, number];
  const count = croppedDims[0] * croppedDims[1] * croppedDims[2];
  if (count > MAX_SEGMENTATION_DOMAIN_VOXELS)
    throw new Error(
      'These marks span too much tissue for an interactive selection. Keep the marks close to the region of interest.',
    );
  return { bounds, dims: croppedDims, sourceDims: [...dims] as [number, number, number], count };
}

function restoreSourceCoordinates(result: SeededVolumeResult, domain: ReturnType<typeof sourceDomain>) {
  const [nx, ny, nz] = domain.dims;
  if (nx === domain.sourceDims[0] && ny === domain.sourceDims[1] && nz === domain.sourceDims[2]) return result;
  const { min } = domain.bounds;
  for (let offset = 0; offset < result.indices.length; offset++) {
    const index = result.indices[offset]!;
    result.indices[offset] =
      ((Math.floor(index / (nx * ny)) + min.z) * domain.sourceDims[1] + (Math.floor(index / nx) % ny) + min.y) *
        domain.sourceDims[0] +
      (index % nx) +
      min.x;
  }
  const translate = (point: VoxelBounds['min']) => ({ x: point.x + min.x, y: point.y + min.y, z: point.z + min.z });
  return { ...result, bounds: { min: translate(result.bounds.min), max: translate(result.bounds.max) } };
}

/** One retained worker-side native crop; marks and results belong to a single cancellable request. */
export class SeededVolumeWorker {
  private worker: Worker | null = null;
  private source: Float32Array | null = null;
  private support?: Uint8Array;
  private geometry = '';
  private sourceBytes = 0;
  private pending: Pending | null = null;
  private sequence = 0;

  /** Exact transferred crop ownership, independent of caller backing buffers and detached local views. */
  get residentSourceBytes(): number {
    return this.worker ? this.sourceBytes : 0;
  }

  run(input: SeededVolumeInput, options: { signal?: AbortSignal; onProgress?: Pending['onProgress'] } = {}) {
    if (options.signal?.aborted) return Promise.reject(new DOMException('Segmentation cancelled.', 'AbortError'));
    if (typeof Worker === 'undefined')
      return Promise.reject(
        new Error('Boundary suggestions require browser worker support. Direct brush editing is still available.'),
      );
    this.cancel();
    let domain: ReturnType<typeof sourceDomain>;
    let foreground: Uint32Array<ArrayBuffer>, background: Uint32Array<ArrayBuffer>;
    try {
      domain = sourceDomain(input);
      const localIndex = (index: number) => {
        const point = voxelPoint(index, domain.sourceDims);
        if (
          (['x', 'y', 'z'] as const).some(
            (axis) => point[axis] < domain.bounds.min[axis] || point[axis] > domain.bounds.max[axis],
          )
        )
          throw new Error('The search region must contain every explicit mark.');
        return voxelIndex(
          { x: point.x - domain.bounds.min.x, y: point.y - domain.bounds.min.y, z: point.z - domain.bounds.min.z },
          domain.dims,
        );
      };
      foreground = Uint32Array.from(input.foreground, localIndex);
      background = Uint32Array.from(input.background, localIndex);
    } catch (error) {
      return Promise.reject(error instanceof Error ? error : new Error(String(error)));
    }
    const geometry = JSON.stringify([domain.sourceDims, input.voxelSizeMm, domain.bounds]);
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
            if (data.type === 'done') pending.resolve(restoreSourceCoordinates(data.result, domain));
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
        // Transfer only the core's exact native domain, never caller-owned MRI
        // or support buffers (including bytes outside their typed-array views).
        const volume = new Float32Array(domain.count);
        const observedSupport = input.observedSupport ? new Uint8Array(domain.count) : undefined;
        let target = 0;
        for (let z = domain.bounds.min.z; z <= domain.bounds.max.z; z++)
          for (let y = domain.bounds.min.y; y <= domain.bounds.max.y; y++) {
            const start = (z * domain.sourceDims[1] + y) * domain.sourceDims[0] + domain.bounds.min.x;
            volume.set(input.volume.subarray(start, start + domain.dims[0]), target);
            if (observedSupport)
              observedSupport.set(input.observedSupport!.subarray(start, start + domain.dims[0]), target);
            target += domain.dims[0];
          }
        this.sourceBytes = volume.byteLength + (observedSupport?.byteLength ?? 0);
        this.worker.postMessage(
          {
            type: 'init',
            volume,
            observedSupport,
            dims: domain.dims,
            voxelSizeMm: input.voxelSizeMm,
          } satisfies SeededWorkerRequest,
          observedSupport ? [volume.buffer, observedSupport.buffer] : [volume.buffer],
        );
        this.source = input.volume;
        this.support = input.observedSupport;
        this.geometry = geometry;
      } catch (error) {
        this.dispose();
        return Promise.reject(error instanceof Error ? error : new Error(String(error)));
      }
    }
    const id = ++this.sequence;
    return new Promise<SeededVolumeResult>((resolve, reject) => {
      const cancel = () => {
        if (this.pending?.id === id) this.cancel();
      };
      const timeout = window.setTimeout(() => {
        if (this.pending?.id === id)
          this.fail(
            new Error(
              'Boundary suggestion took too long. Your marks are unchanged; retry or continue editing directly.',
            ),
          );
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
        this.worker!.postMessage(
          {
            type: 'run',
            id,
            foreground,
            background,
            bounds: {
              min: { x: 0, y: 0, z: 0 },
              max: { x: domain.dims[0] - 1, y: domain.dims[1] - 1, z: domain.dims[2] - 1 },
            },
          } satisfies SeededWorkerRequest,
          [foreground.buffer, background.buffer],
        );
      } catch (error) {
        this.fail(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  cancel(): void {
    // Terminate even non-cooperative work; only a completed, idle crop is reusable.
    if (this.pending) this.dispose();
  }

  private fail(error: Error): void {
    const pending = this.pending;
    this.pending = null;
    pending?.cleanup();
    pending?.reject(error);
    this.dispose();
  }

  dispose(): void {
    const pending = this.pending;
    this.pending = null;
    pending?.cleanup();
    pending?.reject(new DOMException('Segmentation cancelled.', 'AbortError'));
    this.worker?.terminate();
    this.worker = null;
    this.source = null;
    this.support = undefined;
    this.geometry = '';
    this.sourceBytes = 0;
  }
}
