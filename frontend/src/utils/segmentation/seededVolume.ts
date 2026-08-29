export type VoxelPoint = { x: number; y: number; z: number };
export type VoxelBounds = { min: VoxelPoint; max: VoxelPoint };

export type SeededVolumeInput = {
  volume: Float32Array;
  observedSupport?: Uint8Array;
  dims: [number, number, number];
  voxelSizeMm: [number, number, number];
  foreground: Uint32Array;
  /** Optional outside marks; an empty array uses only the automatic search boundary. */
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

/** Use the widest physical context that fits the worker budget, not a guessed tumor radius. */
export function markedRegionBounds(input: SeededVolumeInput): VoxelBounds {
  const axes = ['x', 'y', 'z'] as const;
  const full = { min: { x: 0, y: 0, z: 0 }, max: { x: input.dims[0] - 1, y: input.dims[1] - 1, z: input.dims[2] - 1 } };
  if (input.volume.length <= MAX_SEGMENTATION_DOMAIN_VOXELS) return full;
  const fitContext = (marks: readonly Uint32Array[]): VoxelBounds => {
    const min = { x: Infinity, y: Infinity, z: Infinity };
    const max = { x: -Infinity, y: -Infinity, z: -Infinity };
    for (const indices of marks) {
      for (const index of indices) {
        const point = voxelPoint(index, input.dims);
        for (const axis of axes) {
          min[axis] = Math.min(min[axis], point[axis]);
          max[axis] = Math.max(max[axis], point[axis]);
        }
      }
    }
    let bounds = { min, max };
    let low = 0;
    let high = Math.max(...input.dims.map((size, axis) => size * input.voxelSizeMm[axis]!));
    // Keep all explicit marks. The caller rejects an over-budget mark span before allocating scratch.
    for (let iteration = 0; iteration < 40; iteration++) {
      const paddingMm = (low + high) / 2;
      const candidate = { min: { ...min }, max: { ...max } };
      let count = 1;
      for (const [position, axis] of axes.entries()) {
        const padding = Math.floor(paddingMm / input.voxelSizeMm[position]!);
        candidate.min[axis] = Math.max(0, min[axis] - padding);
        candidate.max[axis] = Math.min(full.max[axis], max[axis] + padding);
        count *= candidate.max[axis] - candidate.min[axis] + 1;
      }
      if (count <= MAX_SEGMENTATION_DOMAIN_VOXELS) {
        low = paddingMm;
        bounds = candidate;
      } else high = paddingMm;
    }
    return bounds;
  };
  const foregroundContext = fitContext([input.foreground]);
  // A Remove stroke corrects membership, not the search field. Re-centering
  // around already-contained outside marks can clip valid tissue on another axis.
  const containsBackground = input.background.every((index) => {
    const point = voxelPoint(index, input.dims);
    return axes.every(
      (axis) => point[axis] >= foregroundContext.min[axis] && point[axis] <= foregroundContext.max[axis],
    );
  });
  return containsBackground ? foregroundContext : fitContext([input.foreground, input.background]);
}

/** Indexed queue: each voxel occupies at most one heap slot, even after a better path is found. */
class VoxelQueue {
  readonly heap: Uint32Array;
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
    voxelSizeMm.some((spacing, axis) => !Number.isFinite(spacing * dims[axis]!) || spacing <= 0)
  ) {
    throw new Error('Segmentation requires matching volume, physical spacing, and acquired-support geometry.');
  }
  if (!foreground.length) {
    throw new Error('Mark inside the tissue you want to select before suggesting a boundary.');
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
  // 3 marks missing exterior visited during the flood; it never enters the heap.
  const labels = new Uint8Array(count);
  const queue = new VoxelQueue(distances, labels);
  const localOffsets = [-1, 1, -nx, nx, -nx * ny, nx * ny];
  const globalOffsets = [-1, 1, -dims[0], dims[0], -dims[0] * dims[1], dims[0] * dims[1]];
  const steps = voxelSizeMm.flatMap((spacing) => [spacing, spacing]);
  const seed = (local: number, label: number) => {
    const global = globalIndex(local);
    if ((observedSupport && !observedSupport[global]) || !Number.isFinite(volume[global])) return false;
    distances[local] = 0;
    labels[local] = label;
    return true;
  };
  {
    // Reach the acquired exterior through missing data connected to the search shell.
    // Enclosed gaps remain unknown, not automatic outside marks inside the tissue.
    // Flood and shortest-path work do not overlap. Reuse their bounded storage.
    const exterior = queue.heap;
    let tail = 0;
    const visit = (local: number) => {
      if (seed(local, 2) || labels[local] === 3) return;
      labels[local] = 3;
      exterior[tail++] = local;
    };
    for (let z = 0; z < nz; z++) {
      for (let y = 0; y < ny; y++) {
        for (let x = 0; x < nx; x++) {
          if (
            (nx > 1 && (x === 0 || x === nx - 1)) ||
            (ny > 1 && (y === 0 || y === ny - 1)) ||
            (nz > 1 && (z === 0 || z === nz - 1))
          )
            visit((z * ny + y) * nx + x);
        }
      }
    }
    for (let head = 0; head < tail; head++) {
      const current = exterior[head]!;
      const point = voxelPoint(current, localDims);
      for (let direction = 0; direction < 6; direction++) {
        const coordinate = point[axes[direction >> 1]!]!;
        if (direction % 2 === 0 ? coordinate === 0 : coordinate + 1 === localDims[direction >> 1]) continue;
        visit(current + localOffsets[direction]!);
      }
      if ((head + 1) % 8192 === 0) {
        abort();
        await hooks.yieldFn?.();
        abort();
      }
    }
  }
  for (const index of background) seed(localIndex(index), 2);
  for (const index of foreground) seed(localIndex(index), 1);
  for (let local = 0; local < count; local++) if (labels[local] === 1 || labels[local] === 2) queue.update(local);

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
      abort();
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
  hooks.onProgress?.(count, count);
  abort();
  return { indices, bounds, boundaryCount, domainVoxels: count };
}
