export type VoxelPoint = { x: number; y: number; z: number };
export type VoxelBounds = { min: VoxelPoint; max: VoxelPoint };

export type SeededVolumeInput = {
  volume: Float32Array;
  observedSupport?: Uint8Array;
  dims: [number, number, number];
  voxelSizeMm: [number, number, number];
  foreground: Uint32Array;
  background: Uint32Array;
  bounds?: VoxelBounds;
};

export type SeededVolumeResult = {
  indices: Uint32Array;
  bounds: VoxelBounds;
  boundaryCount: number;
  domainVoxels: number;
};

export type SeededVolumeHooks = {
  signal?: AbortSignal;
  onProgress?: (processed: number, total: number) => void;
  yieldFn?: () => Promise<void>;
};

export const MAX_SEGMENTATION_DOMAIN_VOXELS = 2_000_000;

export function voxelPoint(index: number, dims: readonly number[]): VoxelPoint {
  const [nx, ny] = dims;
  return { x: index % nx!, y: Math.floor(index / nx!) % ny!, z: Math.floor(index / (nx! * ny!)) };
}

export function voxelIndex(point: VoxelPoint, dims: readonly number[]): number {
  return (point.z * dims[1]! + point.y) * dims[0]! + point.x;
}

/** Physical bounds around all explicit marks, not an intensity-derived tumor hypothesis. */
export function markedRegionBounds(input: SeededVolumeInput): VoxelBounds {
  const min = { x: Infinity, y: Infinity, z: Infinity };
  const max = { x: -Infinity, y: -Infinity, z: -Infinity };
  for (const indices of [input.foreground, input.background]) {
    for (const index of indices) {
      const point = voxelPoint(index, input.dims);
      for (const axis of ['x', 'y', 'z'] as const) {
        min[axis] = Math.min(min[axis], point[axis]);
        max[axis] = Math.max(max[axis], point[axis]);
      }
    }
  }
  for (const [position, axis] of (['x', 'y', 'z'] as const).entries()) {
    const padding = Math.ceil(12 / input.voxelSizeMm[position]!);
    min[axis] = Math.max(0, min[axis] - padding);
    max[axis] = Math.min(input.dims[position]! - 1, max[axis] + padding);
  }
  return { min, max };
}

/** Indexed queue: each voxel occupies at most one heap slot, even after a better path is found. */
class VoxelQueue {
  private heap: Uint32Array;
  private distance: Float64Array;
  private labels: Uint8Array;
  readonly positions: Int32Array;
  size = 0;

  constructor(distance: Float64Array, labels: Uint8Array) {
    this.distance = distance;
    this.labels = labels;
    this.heap = new Uint32Array(distance.length);
    this.positions = new Int32Array(distance.length).fill(-1);
  }

  private before(a: number, b: number): boolean {
    return (
      this.distance[a]! < this.distance[b]! ||
      (this.distance[a] === this.distance[b] &&
        (this.labels[a]! > this.labels[b]! || (this.labels[a] === this.labels[b] && a < b)))
    );
  }

  update(index: number): void {
    let position = this.positions[index]!;
    if (position < 0) position = this.size++;
    while (position > 0) {
      const parent = (position - 1) >> 1;
      const other = this.heap[parent]!;
      if (!this.before(index, other)) break;
      this.heap[position] = other;
      this.positions[other] = position;
      position = parent;
    }
    this.heap[position] = index;
    this.positions[index] = position;
  }

  pop(): number {
    const result = this.heap[0]!;
    const last = this.heap[--this.size]!;
    this.positions[result] = -2;
    if (this.size > 0) {
      let position = 0;
      while (position * 2 + 1 < this.size) {
        let child = position * 2 + 1;
        if (child + 1 < this.size && this.before(this.heap[child + 1]!, this.heap[child]!)) child++;
        const other = this.heap[child]!;
        if (!this.before(other, last)) break;
        this.heap[position] = other;
        this.positions[other] = position;
        position = child;
      }
      this.heap[position] = last;
      this.positions[last] = position;
    }
    return result;
  }
}

/**
 * Competing foreground/background geodesics on acquired anatomy.
 * Marks are hard constraints; no brightness polarity, guessed center, or tumor class is assumed.
 */
export async function segmentSeededVolume(
  input: SeededVolumeInput,
  hooks: SeededVolumeHooks = {},
): Promise<SeededVolumeResult> {
  const { volume, observedSupport, dims, voxelSizeMm, foreground, background } = input;
  const abort = () => {
    if (hooks.signal?.aborted) throw new DOMException('Segmentation cancelled.', 'AbortError');
  };
  abort();
  const total = dims[0] * dims[1] * dims[2];
  if (
    dims.some((dimension) => !Number.isSafeInteger(dimension) || dimension < 1) ||
    !Number.isSafeInteger(total) ||
    total > 0xffffffff ||
    volume.length !== total ||
    (observedSupport && observedSupport.length !== total) ||
    voxelSizeMm.some((spacing) => !Number.isFinite(spacing) || spacing <= 0)
  ) {
    throw new Error('Segmentation requires matching volume, physical spacing, and acquired-support geometry.');
  }
  if (!foreground.length || !background.length) {
    throw new Error('Mark tissue to include and nearby tissue to exclude before growing the selection.');
  }
  const excluded = new Set(background);
  for (const indices of [foreground, background]) {
    for (const index of indices) {
      if (index >= total || !Number.isFinite(volume[index]) || (observedSupport && !observedSupport[index])) {
        throw new Error('Place all marks on acquired MRI tissue. Missing data cannot seed a selection.');
      }
    }
  }
  if (foreground.some((index) => excluded.has(index))) {
    throw new Error('A voxel cannot be marked both included and excluded.');
  }

  const bounds = input.bounds ?? markedRegionBounds(input);
  const axes = ['x', 'y', 'z'] as const;
  for (let axis = 0; axis < 3; axis++) {
    const minimum = bounds.min[axes[axis]!]!;
    const maximum = bounds.max[axes[axis]!]!;
    if (
      !Number.isInteger(minimum) ||
      !Number.isInteger(maximum) ||
      minimum < 0 ||
      maximum < minimum ||
      maximum >= dims[axis]!
    ) {
      throw new Error('The segmentation search region is outside the acquired volume.');
    }
  }
  const localDims: [number, number, number] = axes.map((axis) => bounds.max[axis] - bounds.min[axis] + 1) as [
    number,
    number,
    number,
  ];
  const [nx, ny, nz] = localDims;
  const count = nx * ny * nz;
  if (count > MAX_SEGMENTATION_DOMAIN_VOXELS) {
    throw new Error(
      'These marks span too much tissue for an interactive selection. Keep the marks close to the region of interest.',
    );
  }
  const globalIndex = (local: number) => {
    const point = voxelPoint(local, localDims);
    return ((point.z + bounds.min.z) * dims[1] + point.y + bounds.min.y) * dims[0] + point.x + bounds.min.x;
  };
  const localIndex = (global: number) => {
    const point = voxelPoint(global, dims);
    if (axes.some((axis) => point[axis] < bounds.min[axis] || point[axis] > bounds.max[axis])) {
      throw new Error('The search region must contain every explicit mark.');
    }
    return ((point.z - bounds.min.z) * ny + point.y - bounds.min.y) * nx + point.x - bounds.min.x;
  };

  const samples: number[] = [];
  const stride = Math.max(1, Math.floor(count / 4096));
  for (let local = 0; local < count; local += stride) {
    const global = globalIndex(local);
    if ((!observedSupport || observedSupport[global]) && Number.isFinite(volume[global])) samples.push(volume[global]!);
  }
  samples.sort((a, b) => a - b);
  let range =
    (samples[Math.floor((samples.length - 1) * 0.99)] ?? 1) - (samples[Math.floor((samples.length - 1) * 0.01)] ?? 0);
  if (range <= 1e-8) {
    // A small explicitly marked structure can fall outside both sampled
    // percentiles. A degenerate robust window must not erase its boundary.
    let low = samples[0] ?? Infinity,
      high = samples.at(-1) ?? -Infinity;
    for (const indices of [foreground, background])
      for (const index of indices) {
        low = Math.min(low, volume[index]!);
        high = Math.max(high, volume[index]!);
      }
    range = high - low;
  }
  const inverseRange = range > 1e-8 ? 1 / range : 0;

  const distances = new Float64Array(count).fill(Infinity);
  const labels = new Uint8Array(count);
  const queue = new VoxelQueue(distances, labels);
  const seed = (local: number, label: number) => {
    const global = globalIndex(local);
    if ((observedSupport && !observedSupport[global]) || !Number.isFinite(volume[global])) return;
    distances[local] = 0;
    labels[local] = label;
  };
  // The distant search shell supplies a bounded background, never an automatic foreground.
  for (let z = 0; z < nz; z++) {
    for (let y = 0; y < ny; y++) {
      for (let x = 0; x < nx; x++) {
        if (
          (nx > 1 && (x === 0 || x === nx - 1)) ||
          (ny > 1 && (y === 0 || y === ny - 1)) ||
          (nz > 1 && (z === 0 || z === nz - 1))
        )
          seed((z * ny + y) * nx + x, 2);
      }
    }
  }
  for (const index of background) seed(localIndex(index), 2);
  for (const index of foreground) seed(localIndex(index), 1);
  for (let local = 0; local < count; local++) if (labels[local]) queue.update(local);

  const localOffsets = [-1, 1, -nx, nx, -nx * ny, nx * ny];
  const globalOffsets = [-1, 1, -dims[0], dims[0], -dims[0] * dims[1], dims[0] * dims[1]];
  const steps = voxelSizeMm.flatMap((spacing) => [spacing, spacing]);
  let processed = 0;
  while (queue.size) {
    const current = queue.pop();
    const point = voxelPoint(current, localDims);
    const global = globalIndex(current);
    for (let direction = 0; direction < 6; direction++) {
      const coordinate = point[axes[direction >> 1]!]!;
      if (direction % 2 === 0 ? coordinate === 0 : coordinate + 1 === localDims[direction >> 1]) continue;
      const adjacent = current + localOffsets[direction]!;
      if (queue.positions[adjacent] === -2) continue;
      const otherGlobal = global + globalOffsets[direction]!;
      if ((observedSupport && !observedSupport[otherGlobal]) || !Number.isFinite(volume[otherGlobal])) continue;
      const difference = (volume[global]! - volume[otherGlobal]!) * inverseRange;
      const step = steps[direction]!;
      const cost = distances[current]! + 0.0025 * step + (difference * difference) / step;
      if (cost < distances[adjacent]! || (cost === distances[adjacent] && labels[current]! > labels[adjacent]!)) {
        distances[adjacent] = cost;
        labels[adjacent] = labels[current]!;
        queue.update(adjacent);
      }
    }
    if (++processed % 8192 === 0) {
      abort();
      hooks.onProgress?.(processed, count);
      await hooks.yieldFn?.();
    }
  }
  abort();
  let selected = 0;
  for (const label of labels) if (label === 1) selected++;
  const indices = new Uint32Array(selected);
  let cursor = 0;
  let boundaryCount = 0;
  for (let local = 0; local < count; local++) {
    if (labels[local] !== 1) continue;
    indices[cursor++] = globalIndex(local);
    const { x, y, z } = voxelPoint(local, localDims);
    if (x <= 1 || x >= nx - 2 || y <= 1 || y >= ny - 2 || z <= 1 || z >= nz - 2) boundaryCount++;
  }
  return { indices, bounds, boundaryCount, domainVoxels: count };
}
