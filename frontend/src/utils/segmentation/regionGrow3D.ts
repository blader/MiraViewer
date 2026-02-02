export type Vec3i = { x: number; y: number; z: number };

export type RegionGrow3DResult = {
  /** Binary mask (0/1) in the same indexing order as the input volume. */
  mask: Uint8Array;
  /** Number of voxels included in the region (<= mask.length). */
  count: number;
  /** Seed intensity value (raw value from `volume[seedIdx]`). */
  seedValue: number;
  /** Whether the grow hit the configured max voxel limit and stopped early. */
  hitMaxVoxels: boolean;
};

export type RegionGrow3DOptions = {
  /**
   * Maximum number of voxels to include before stopping early.
   *
   * This is a safety valve to prevent accidental runaway segmentation.
   */
  maxVoxels?: number;

  /**
   * Neighborhood connectivity.
   * - 6: faces only (less leakage)
   * - 26: faces+edges+corners (more permissive)
   */
  connectivity?: 6 | 26;

  /** Yield to the event loop every N dequeued voxels (helps keep UI responsive). */
  yieldEvery?: number;

  /** Optional abort signal for cancellation. */
  signal?: AbortSignal;

  /** Optional progress callback. */
  onProgress?: (p: { processed: number; queued: number }) => void;

  /** Optional yield function (defaults to setTimeout(0)). Useful for tests. */
  yieldFn?: () => Promise<void>;
};

function clamp01(x: number): number {
  return x < 0 ? 0 : x > 1 ? 1 : x;
}

function inBounds(x: number, y: number, z: number, nx: number, ny: number, nz: number): boolean {
  return x >= 0 && x < nx && y >= 0 && y < ny && z >= 0 && z < nz;
}

function idx3(x: number, y: number, z: number, nx: number, ny: number): number {
  return z * (nx * ny) + y * nx + x;
}

/**
 * Simple intensity-threshold 3D region growing.
 *
 * Intended as a baseline interactive segmentation tool:
 * - user picks a seed voxel (via the slice inspector)
 * - we flood-fill neighbors whose intensity lies in [min,max]
 *
 * Notes:
 * - Input volume is expected to be roughly normalized to [0,1] but this isn't strictly required.
 * - `yieldEvery` lets the implementation cooperate with the UI thread for large regions.
 */
export async function regionGrow3D(params: {
  volume: Float32Array;
  dims: [number, number, number];
  seed: Vec3i;
  min: number;
  max: number;
  opts?: RegionGrow3DOptions;
}): Promise<RegionGrow3DResult> {
  const { volume, dims, seed } = params;
  const nx = dims[0];
  const ny = dims[1];
  const nz = dims[2];

  const n = nx * ny * nz;
  if (volume.length !== n) {
    throw new Error(`regionGrow3D: volume length mismatch (expected ${n}, got ${volume.length})`);
  }

  if (!inBounds(seed.x, seed.y, seed.z, nx, ny, nz)) {
    throw new Error(`regionGrow3D: seed out of bounds: (${seed.x}, ${seed.y}, ${seed.z})`);
  }

  const minV = Math.min(params.min, params.max);
  const maxV = Math.max(params.min, params.max);

  const opts = params.opts;
  const connectivity: 6 | 26 = opts?.connectivity ?? 6;
  const maxVoxels = Math.max(1, Math.min(opts?.maxVoxels ?? n, n));
  const yieldEvery = Math.max(0, Math.floor(opts?.yieldEvery ?? 120_000));
  const yieldFn = opts?.yieldFn ?? (() => new Promise<void>((r) => window.setTimeout(r, 0)));

  const mask = new Uint8Array(n);

  const seedIdx = idx3(seed.x, seed.y, seed.z, nx, ny);
  const seedValue = volume[seedIdx] ?? 0;

  // Fast exit if seed is outside the acceptance range.
  if (!(seedValue >= minV && seedValue <= maxV)) {
    return { mask, count: 0, seedValue, hitMaxVoxels: false };
  }

  // Queue holds voxel indices.
  const queue = new Uint32Array(maxVoxels);
  let head = 0;
  let tail = 0;

  queue[tail++] = seedIdx;
  mask[seedIdx] = 1;

  const strideY = nx;
  const strideZ = nx * ny;

  const accept = (i: number): boolean => {
    const v = volume[i] ?? 0;
    return v >= minV && v <= maxV;
  };

  const enqueue = (i: number): void => {
    mask[i] = 1;
    queue[tail++] = i;
  };

  let processed = 0;
  let hitMaxVoxels = false;

  while (head < tail) {
    if (opts?.signal?.aborted) {
      // Preserve partial work: caller can decide whether to keep it.
      break;
    }

    const i = queue[head++]!;
    processed++;

    if (yieldEvery > 0 && (processed % yieldEvery === 0)) {
      opts?.onProgress?.({ processed, queued: tail });
      // Yield to keep the UI responsive.
      await yieldFn();
    }

    // Decode x/y/z for boundary checks.
    const z = Math.floor(i / strideZ);
    const yz = i - z * strideZ;
    const y = Math.floor(yz / strideY);
    const x = yz - y * strideY;

    const tryNeighbor = (nx0: number, ny0: number, nz0: number) => {
      if (tail >= maxVoxels) {
        hitMaxVoxels = true;
        return;
      }
      if (!inBounds(nx0, ny0, nz0, nx, ny, nz)) return;
      const ni = idx3(nx0, ny0, nz0, nx, ny);
      if (mask[ni]) return;
      if (!accept(ni)) return;
      enqueue(ni);
    };

    if (connectivity === 6) {
      tryNeighbor(x - 1, y, z);
      tryNeighbor(x + 1, y, z);
      tryNeighbor(x, y - 1, z);
      tryNeighbor(x, y + 1, z);
      tryNeighbor(x, y, z - 1);
      tryNeighbor(x, y, z + 1);
      if (hitMaxVoxels) break;
    } else {
      for (let dz = -1; dz <= 1; dz++) {
        for (let dy = -1; dy <= 1; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            if (dx === 0 && dy === 0 && dz === 0) continue;
            tryNeighbor(x + dx, y + dy, z + dz);
            if (hitMaxVoxels) break;
          }
          if (hitMaxVoxels) break;
        }
        if (hitMaxVoxels) break;
      }
      if (hitMaxVoxels) break;
    }
  }

  return {
    mask,
    count: tail,
    seedValue,
    hitMaxVoxels,
  };
}

export function computeSeedRange01(params: { seedValue: number; tolerance: number }): { min: number; max: number } {
  const tol = Math.max(0, params.tolerance);
  const min = clamp01(params.seedValue - tol);
  const max = clamp01(params.seedValue + tol);
  return { min, max };
}
