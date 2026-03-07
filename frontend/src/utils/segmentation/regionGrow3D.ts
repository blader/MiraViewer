export type Vec3i = { x: number; y: number; z: number };

export type RegionGrow3DRoiMode = 'hard' | 'guide';

export type RegionGrow3DRoi = {
  mode: RegionGrow3DRoiMode;
  min: Vec3i;
  max: Vec3i;
  /**
   * Tolerance shrinkage factor used as a *spatial prior* outside the ROI.
   *
   * Implementations may apply this as a smooth radial decay about the ROI centroid (instead of a
   * hard inside/outside step).
   * - 1: no spatial prior (outside behaves like inside)
   * - 0: extremely strict outside (only values very close to the seed are accepted)
   */
  outsideToleranceScale?: number;
};

export type RegionGrow3DResult = {
  /**
   * Sparse list of voxel indices included in the region.
   *
   * NOTE: indices are in the same indexing order as the input volume: `idx = z*(nx*ny) + y*nx + x`.
   */
  indices: Uint32Array;
  /** Number of voxels included in the region (<= indices.length). */
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

function clampInt(x: number, min: number, max: number): number {
  if (!Number.isFinite(x)) return min;
  const xi = Math.floor(x);
  return xi < min ? min : xi > max ? max : xi;
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
  /** Optional additional seed voxel indices (same indexing order as `indices` in the result). */
  seedIndices?: Uint32Array;
  min: number;
  max: number;
  roi?: RegionGrow3DRoi;
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

  const strideY = nx;
  const strideZ = nx * ny;

  const seedIdx = idx3(seed.x, seed.y, seed.z, nx, ny);
  const seedValue = volume[seedIdx] ?? 0;

  const roi = (() => {
    const r = params.roi;
    if (!r) return null;

    const mode = r.mode;
    if (mode !== 'hard' && mode !== 'guide') return null;

    const maxX = Math.max(0, nx - 1);
    const maxY = Math.max(0, ny - 1);
    const maxZ = Math.max(0, nz - 1);

    const minX = clampInt(Math.min(r.min.x, r.max.x), 0, maxX);
    const maxX2 = clampInt(Math.max(r.min.x, r.max.x), 0, maxX);
    const minY = clampInt(Math.min(r.min.y, r.max.y), 0, maxY);
    const maxY2 = clampInt(Math.max(r.min.y, r.max.y), 0, maxY);
    const minZ = clampInt(Math.min(r.min.z, r.max.z), 0, maxZ);
    const maxZ2 = clampInt(Math.max(r.min.z, r.max.z), 0, maxZ);

    // Outside the ROI we shrink the acceptance range around the seed by this scale factor.
    const rawOutsideScale = r.outsideToleranceScale;
    const outsideScale = clamp01(
      typeof rawOutsideScale === 'number' && Number.isFinite(rawOutsideScale) ? rawOutsideScale : 0.25,
    );

    return { mode, minX, maxX: maxX2, minY, maxY: maxY2, minZ, maxZ: maxZ2, outsideScale };
  })();

  const tolLo = seedValue - minV;
  const tolHi = maxV - seedValue;

  const outsideScale = roi?.outsideScale ?? 1;
  const minOutRaw = seedValue - tolLo * outsideScale;
  const maxOutRaw = seedValue + tolHi * outsideScale;
  const minOut = Math.min(minOutRaw, maxOutRaw);
  const maxOut = Math.max(minOutRaw, maxOutRaw);

  const acceptAt = (x: number, y: number, z: number, i: number): boolean => {
    const v = volume[i] ?? 0;

    if (roi) {
      const inside =
        x >= roi.minX &&
        x <= roi.maxX &&
        y >= roi.minY &&
        y <= roi.maxY &&
        z >= roi.minZ &&
        z <= roi.maxZ;

      if (!inside) {
        if (roi.mode === 'hard') return false;
        return v >= minOut && v <= maxOut;
      }
    }

    return v >= minV && v <= maxV;
  };

  // Fast exit if seed is outside the acceptance range.
  if (!acceptAt(seed.x, seed.y, seed.z, seedIdx)) {
    return { indices: new Uint32Array(0), count: 0, seedValue, hitMaxVoxels: false };
  }

  // Track visited voxels with a 1-bit-per-voxel bitset to avoid allocating a full-size mask.
  const visited = new Uint32Array((n + 31) >>> 5);

  const isVisited = (i: number): boolean => {
    const w = i >>> 5;
    const b = i & 31;
    return (visited[w]! & (1 << b)) !== 0;
  };

  const markVisited = (i: number): void => {
    const w = i >>> 5;
    const b = i & 31;
    visited[w] = (visited[w]! | (1 << b)) >>> 0;
  };

  // Queue holds voxel indices; we reuse the same buffer as the returned sparse index list.
  const queue = new Uint32Array(maxVoxels);
  let head = 0;
  let tail = 0;

  const enqueue = (i: number): void => {
    markVisited(i);
    queue[tail++] = i;
  };

  let processed = 0;
  let hitMaxVoxels = false;

  const enqueueSeedIndex = (i: number): void => {
    if (hitMaxVoxels) return;
    if (!(i >= 0 && i < n)) return;
    if (isVisited(i)) return;

    const z = Math.floor(i / strideZ);
    const yz = i - z * strideZ;
    const y = Math.floor(yz / strideY);
    const x = yz - y * strideY;

    if (!acceptAt(x, y, z, i)) return;

    if (tail >= maxVoxels) {
      hitMaxVoxels = true;
      return;
    }

    enqueue(i);
  };

  enqueueSeedIndex(seedIdx);

  // Optional additional seeds (useful for multi-island selection).
  if (params.seedIndices) {
    const seeds = params.seedIndices;
    for (let si = 0; si < seeds.length; si++) {
      enqueueSeedIndex(seeds[si]!);
      if (hitMaxVoxels) break;
    }
  }

  while (head < tail) {
    if (opts?.signal?.aborted) {
      // Preserve partial work: caller can decide whether to keep it.
      break;
    }

    const i = queue[head++]!;
    processed++;

    if (yieldEvery > 0 && processed % yieldEvery === 0) {
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
      if (!inBounds(nx0, ny0, nz0, nx, ny, nz)) return;
      const ni = idx3(nx0, ny0, nz0, nx, ny);
      if (isVisited(ni)) return;
      if (!acceptAt(nx0, ny0, nz0, ni)) return;

      if (tail >= maxVoxels) {
        hitMaxVoxels = true;
        return;
      }

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
    indices: queue.subarray(0, tail),
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
