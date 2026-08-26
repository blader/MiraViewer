import { clamp, clamp01, clampInt } from '../math';
import { idx3, inBounds3 as inBounds } from '../grid3d';
import { robustStats } from '../stats';

export type Vec3i = { x: number; y: number; z: number };

export type RegionGrow3DRoiMode = 'hard' | 'guide';

export type RegionGrow3DRoi = {
  mode: RegionGrow3DRoiMode;
  min: Vec3i;
  max: Vec3i;
  /**
   * Tolerance shrinkage factor used as a *spatial prior* outside the ROI.
   * - 1: no spatial prior (outside behaves like inside)
   * - 0: extremely strict outside
   */
  outsideToleranceScale?: number;
};

export type RegionGrow3DResult = {
  /** Sparse list of voxel indices: `idx = z*(nx*ny) + y*nx + x`. */
  indices: Uint32Array;
  /** Number of voxels included (<= indices.length). */
  count: number;
  /** Seed intensity value (raw value from `volume[seedIdx]`). */
  seedValue: number;
  /** Whether the grow hit the configured max voxel limit and stopped early. */
  hitMaxVoxels: boolean;
};

export type RegionGrow3DOptions = {
  maxVoxels?: number;
  connectivity?: 6 | 26;
  yieldEvery?: number;
  signal?: AbortSignal;
  onProgress?: (p: { processed: number; queued: number }) => void;
  yieldFn?: () => Promise<void>;
  debug?: boolean;
};

class MinHeap {
  private indices = new Uint32Array(64);
  private distances = new Float32Array(64);
  private length = 0;
  distance = 0;

  push(index: number, distance: number): void {
    if (this.length === this.indices.length) {
      const indices = new Uint32Array(this.indices.length * 2);
      indices.set(this.indices);
      this.indices = indices;
      const distances = new Float32Array(this.distances.length * 2);
      distances.set(this.distances);
      this.distances = distances;
    }

    let current = this.length++;
    while (current > 0) {
      const parent = (current - 1) >> 1;
      if (this.distances[parent]! <= distance) break;
      this.indices[current] = this.indices[parent]!;
      this.distances[current] = this.distances[parent]!;
      current = parent;
    }
    this.indices[current] = index;
    this.distances[current] = distance;
  }

  pop(): number {
    if (this.length === 0) return -1;

    const index = this.indices[0]!;
    this.distance = this.distances[0]!;
    const lastIndex = this.indices[--this.length]!;
    const lastDistance = this.distances[this.length]!;
    if (this.length > 0) {
      let current = 0;
      for (;;) {
        const left = current * 2 + 1;
        const right = left + 1;
        let smallest = current;
        let smallestDistance = lastDistance;

        if (left < this.length && this.distances[left]! < smallestDistance) {
          smallest = left;
          smallestDistance = this.distances[left]!;
        }
        if (right < this.length && this.distances[right]! < smallestDistance) smallest = right;

        if (smallest === current) break;
        this.indices[current] = this.indices[smallest]!;
        this.distances[current] = this.distances[smallest]!;
        current = smallest;
      }
      this.indices[current] = lastIndex;
      this.distances[current] = lastDistance;
    }

    return index;
  }

  get size(): number {
    return this.length;
  }
}

export type RegionGrow3DV2Tuning = {
  /** Additional margin (in voxels) around the ROI when mode='guide'. */
  roiMarginVoxels?: number;

  /** Base step cost inside the ROI. */
  baseStepInside?: number;

  /** Base step cost outside the ROI (within the margin domain). */
  baseStepOutside?: number;

  /** Global path-length penalty scale applied to the base step cost. */
  baseStepScale?: number;

  /** Exponent shaping the low/mid intensity penalty ramp (lower => harsher mid). */
  preferHighExponent?: number;
  /** Multiplier for the low/mid intensity penalty (relative to intensityWeight). */
  preferHighStrengthMul?: number;

  /** Weight for edge-crossing penalty. */
  edgeWeight?: number;

  /**
   * Weight for penalizing large intensity jumps between neighboring voxels.
   *
   * This complements the edge term: it still triggers when a boundary is present but edgePenalty is weak
   * (e.g. noisy / low-gradient boundaries), and it allows us to make costs direction-aware (high→low harder).
   */
  crossWeight?: number;

  /** Weight for intensity-outside-band penalty. */
  intensityWeight?: number;

  /** Weight for the "more background-like than tumor-like" penalty. */
  bgLikeWeight?: number;

  /** Margin in z-scores: how much more background-like a voxel must be before being penalized. */
  bgRejectMarginZ?: number;

  /** Seed neighborhood radius (in voxels) used to estimate tumor stats (median+MAD). */
  seedStatsRadiusVox?: number;

  /** Max samples to use for background stats. */
  bgMaxSamples?: number;

  /** Thickness of the outside-ROI shell (in voxels) used to estimate background stats. */
  bgShellThicknessVox?: number;
};

export async function regionGrow3D_v2(params: {
  volume: Float32Array;
  /** Zero-valued entries are unobserved and must never seed or connect a lesion. */
  observedSupport?: Uint8Array;
  dims: [number, number, number];
  seed: Vec3i;
  seedIndices?: Uint32Array;
  min: number;
  max: number;
  roi?: RegionGrow3DRoi;
  opts?: RegionGrow3DOptions & {
    /** Optional explicit path-cost budget. If not provided, derived from the tolerance implied by [min,max]. */
    maxCost?: number;
    tuning?: RegionGrow3DV2Tuning;
    /** Debug logging gate. */
    debug?: boolean;
  };
}): Promise<RegionGrow3DResult> {
  const { volume, observedSupport, dims, seed } = params;
  const nx = dims[0];
  const ny = dims[1];
  const nz = dims[2];

  const n = nx * ny * nz;
  if (volume.length !== n) {
    throw new Error(`regionGrow3D_v2: volume length mismatch (expected ${n}, got ${volume.length})`);
  }
  if (observedSupport && observedSupport.length !== n) {
    throw new Error(`regionGrow3D_v2: acquired-support length mismatch (expected ${n}, got ${observedSupport.length})`);
  }

  if (!inBounds(seed.x, seed.y, seed.z, nx, ny, nz)) {
    throw new Error(`regionGrow3D_v2: seed out of bounds: (${seed.x}, ${seed.y}, ${seed.z})`);
  }

  let minV = Math.min(params.min, params.max);
  let maxV = Math.max(params.min, params.max);

  const seedIdx = idx3(seed.x, seed.y, seed.z, nx, ny);
  if (observedSupport && !observedSupport[seedIdx]) {
    throw new Error('regionGrow3D_v2: segmentation seed is not supported by observed MRI data');
  }
  const acquiredSeedValue = volume[seedIdx] ?? 0;
  let seedValue = acquiredSeedValue;

  const opts = params.opts;
  const tuning = opts?.tuning;

  const connectivity: 6 | 26 = opts?.connectivity ?? 6;
  const maxVoxels = Math.max(1, Math.min(opts?.maxVoxels ?? n, n));
  const yieldEvery = Math.max(0, Math.floor(opts?.yieldEvery ?? 120_000));
  const yieldFn = opts?.yieldFn ?? (() => new Promise<void>((r) => window.setTimeout(r, 0)));

  const debug = opts?.debug === true;

  const roiParsed = (() => {
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

    const rawOutsideScale = r.outsideToleranceScale;
    const outsideScale = clamp01(
      typeof rawOutsideScale === 'number' && Number.isFinite(rawOutsideScale) ? rawOutsideScale : 0.25,
    );

    return { mode, minX, maxX: maxX2, minY, maxY: maxY2, minZ, maxZ: maxZ2, outsideScale };
  })();

  // Safety: without an ROI, v2 may require allocating cost arrays the size of the full volume.
  // We guard against accidental use on huge volumes.
  if (!roiParsed && n > 5_000_000) {
    throw new Error('regionGrow3D_v2 requires an ROI for large volumes');
  }
  if (opts?.signal?.aborted) {
    return { indices: new Uint32Array(0), count: 0, seedValue: acquiredSeedValue, hitMaxVoxels: false };
  }

  const roiSamplesForTumorStats = (() => {
    const r = roiParsed;
    if (!r) return null;

    const rx = r.maxX - r.minX + 1;
    const ry = r.maxY - r.minY + 1;
    const rz = r.maxZ - r.minZ + 1;
    const roiN = rx * ry * rz;

    // Keep sampling bounded for performance.
    const maxSamples = 8192;
    const stride = clampInt(Math.ceil(Math.cbrt(roiN / maxSamples)), 1, 8);

    const samples: number[] = [];

    for (let z = r.minZ; z <= r.maxZ; z += stride) {
      for (let y = r.minY; y <= r.maxY; y += stride) {
        for (let x = r.minX; x <= r.maxX; x += stride) {
          const i = idx3(x, y, z, nx, ny);
          if (observedSupport && !observedSupport[i]) continue;
          samples.push(volume[i] ?? 0);
          if (samples.length >= maxSamples) return samples;
        }
      }
    }

    return samples;
  })();

  const roiBackground = roiSamplesForTumorStats ? robustStats(roiSamplesForTumorStats, 0.02) : null;
  const localSeedBackground = (() => {
    if (
      !observedSupport ||
      roiParsed?.mode !== 'guide' ||
      tuning ||
      params.seedIndices?.length ||
      opts?.maxCost !== undefined
    ) {
      return null;
    }

    const samples: number[] = [];
    for (let dz = -8; dz <= 8; dz++) {
      const z = seed.z + dz;
      if (z < 0 || z >= nz) continue;
      for (let dy = -8; dy <= 8; dy++) {
        const y = seed.y + dy;
        if (y < 0 || y >= ny) continue;
        for (let dx = -8; dx <= 8; dx++) {
          const squaredDistance = dx * dx + dy * dy + dz * dz;
          if (squaredDistance < 9 || squaredDistance > 64) continue;
          if (dz < 0 || (dz === 0 && (dy < 0 || (dy === 0 && dx <= 0)))) continue;
          const x = seed.x + dx;
          const oppositeX = seed.x - dx;
          const oppositeY = seed.y - dy;
          const oppositeZ = seed.z - dz;
          if (
            x < 0 ||
            x >= nx ||
            oppositeX < 0 ||
            oppositeX >= nx ||
            oppositeY < 0 ||
            oppositeY >= ny ||
            oppositeZ < 0 ||
            oppositeZ >= nz
          ) {
            continue;
          }
          const index = idx3(x, y, z, nx, ny);
          const opposite = idx3(oppositeX, oppositeY, oppositeZ, nx, ny);
          if (observedSupport[index] && observedSupport[opposite]) {
            samples.push(((volume[index] ?? 0) + (volume[opposite] ?? 0)) * 0.5);
          }
        }
      }
    }

    return robustStats(samples, 0.025);
  })();
  const locallyDistinctSeed = Boolean(
    localSeedBackground && Math.abs(seedValue - localSeedBackground.mu) >= 2 * localSeedBackground.sigma,
  );
  const invertAcquiredContrast = Boolean(
    observedSupport &&
    roiParsed &&
    !tuning &&
    ((roiBackground && seedValue < roiBackground.mu - 3 * roiBackground.sigma) ||
      (localSeedBackground && seedValue < localSeedBackground.mu - 2 * localSeedBackground.sigma)),
  );
  if (invertAcquiredContrast) {
    const originalMinimum = minV;
    minV = 1 - maxV;
    maxV = 1 - originalMinimum;
    seedValue = 1 - seedValue;
    for (let index = 0; index < roiSamplesForTumorStats!.length; index++) {
      roiSamplesForTumorStats![index] = 1 - roiSamplesForTumorStats![index]!;
    }
  }
  const acquiredIntensity = (index: number): number => {
    const value = volume[index] ?? 0;
    return invertAcquiredContrast ? 1 - value : value;
  };

  const roiQuantiles = (() => {
    const s = roiSamplesForTumorStats;
    if (!s || s.length < 64) return null;

    const sorted = [...s].sort((a, b) => a - b);
    const n = sorted.length;

    const qLo = sorted[Math.floor(0.02 * (n - 1))] ?? sorted[0] ?? 0;
    const qHi = sorted[Math.floor(0.995 * (n - 1))] ?? sorted[n - 1] ?? 1;
    const q99 = sorted[Math.floor(0.99 * (n - 1))] ?? sorted[n - 1] ?? 1;

    return { qLo, qHi, q99 };
  })();

  // Bright-intensity inclusion: if the ROI contains a non-trivial amount of very bright voxels,
  // extend the upper intensity bound so we don't consistently miss cystic/hyperintense regions.
  if (roiSamplesForTumorStats && roiSamplesForTumorStats.length >= 64) {
    let aboveCount = 0;
    for (let i = 0; i < roiSamplesForTumorStats.length; i++) {
      if ((roiSamplesForTumorStats[i] ?? 0) > maxV) aboveCount++;
    }

    const minAbove = Math.max(8, Math.floor(roiSamplesForTumorStats.length * 0.002));
    if (aboveCount >= minAbove && roiQuantiles) {
      const q = roiQuantiles.q99;
      if (Number.isFinite(q)) {
        maxV = Math.max(maxV, q);
      }
    }
  }

  const tolLo = seedValue - minV;
  const tolHi = maxV - seedValue;
  const tolWidth = Math.max(1e-6, Math.max(tolLo, tolHi));

  const roiMarginVoxels = (() => {
    const raw = tuning?.roiMarginVoxels;
    if (typeof raw === 'number' && Number.isFinite(raw)) {
      return clampInt(raw, 0, 32);
    }

    if (!roiParsed) return 0;

    // Default margin scales mildly with ROI size but is capped.
    const rx = roiParsed.maxX - roiParsed.minX + 1;
    const ry = roiParsed.maxY - roiParsed.minY + 1;
    const rz = roiParsed.maxZ - roiParsed.minZ + 1;
    const m = Math.round(Math.max(rx, ry, rz) * 0.1);
    return clampInt(m, 2, 12);
  })();

  // Domain bounds: ROI for hard, ROI±margin for guide, full volume when no ROI.
  const dom = (() => {
    if (!roiParsed) {
      return {
        minX: 0,
        maxX: nx - 1,
        minY: 0,
        maxY: ny - 1,
        minZ: 0,
        maxZ: nz - 1,
        roi: null as typeof roiParsed,
      };
    }

    if (roiParsed.mode === 'hard' || roiMarginVoxels <= 0) {
      return { ...roiParsed, roi: roiParsed };
    }

    return {
      roi: roiParsed,
      minX: clampInt(roiParsed.minX - roiMarginVoxels, 0, nx - 1),
      maxX: clampInt(roiParsed.maxX + roiMarginVoxels, 0, nx - 1),
      minY: clampInt(roiParsed.minY - roiMarginVoxels, 0, ny - 1),
      maxY: clampInt(roiParsed.maxY + roiMarginVoxels, 0, ny - 1),
      minZ: clampInt(roiParsed.minZ - roiMarginVoxels, 0, nz - 1),
      maxZ: clampInt(roiParsed.maxZ + roiMarginVoxels, 0, nz - 1),
    };
  })();

  if (!inBounds(seed.x, seed.y, seed.z, nx, ny, nz)) {
    throw new Error('regionGrow3D_v2: seed out of bounds');
  }

  if (roiParsed && roiParsed.mode === 'hard') {
    const inside =
      seed.x >= roiParsed.minX &&
      seed.x <= roiParsed.maxX &&
      seed.y >= roiParsed.minY &&
      seed.y <= roiParsed.maxY &&
      seed.z >= roiParsed.minZ &&
      seed.z <= roiParsed.maxZ;

    if (!inside) {
      return { indices: new Uint32Array(0), count: 0, seedValue: acquiredSeedValue, hitMaxVoxels: false };
    }
  }

  const domNx = dom.maxX - dom.minX + 1;
  const domNy = dom.maxY - dom.minY + 1;
  const domNz = dom.maxZ - dom.minZ + 1;
  const domN = domNx * domNy * domNz;

  // Allocate per-domain cost arrays.
  const dist = new Float32Array(domN);
  dist.fill(Number.POSITIVE_INFINITY);
  const finalized = new Uint8Array(domN);

  const toLocal = (x: number, y: number, z: number): number => {
    return (z - dom.minZ) * (domNx * domNy) + (y - dom.minY) * domNx + (x - dom.minX);
  };

  const fromLocal = (li: number): { x: number; y: number; z: number } => {
    const plane = domNx * domNy;
    const z = Math.floor(li / plane);
    const yz = li - z * plane;
    const y = Math.floor(yz / domNx);
    const x = yz - y * domNx;
    return { x: x + dom.minX, y: y + dom.minY, z: z + dom.minZ };
  };

  const maxCost = (() => {
    const raw = opts?.maxCost;
    if (typeof raw === 'number' && Number.isFinite(raw) && raw >= 0) return raw;

    // Default mapping: tolerance controls how far we allow growth to extend.
    // This is intentionally conservative; leakage is more harmful than slightly under-growing.
    const base = 18;
    const scale = 220;
    return base + tolWidth * scale;
  })();

  const baseStepInside = typeof tuning?.baseStepInside === 'number' ? clamp(tuning.baseStepInside, 0.1, 10) : 1;
  const baseStepOutside = typeof tuning?.baseStepOutside === 'number' ? clamp(tuning.baseStepOutside, 0.1, 20) : 3;

  const baseStepScale =
    typeof tuning?.baseStepScale === 'number' && Number.isFinite(tuning.baseStepScale)
      ? clamp(tuning.baseStepScale, 0.25, 5)
      : 1.65;

  const edgeWeight = typeof tuning?.edgeWeight === 'number' ? clamp(tuning.edgeWeight, 0, 20) : 2.5;
  const crossWeight = typeof tuning?.crossWeight === 'number' ? clamp(tuning.crossWeight, 0, 20) : 1.4;
  const intensityWeight = typeof tuning?.intensityWeight === 'number' ? clamp(tuning.intensityWeight, 0, 20) : 2.0;
  const bgLikeWeight = typeof tuning?.bgLikeWeight === 'number' ? clamp(tuning.bgLikeWeight, 0, 20) : 1.25;

  const bgRejectMarginZ =
    typeof tuning?.bgRejectMarginZ === 'number' && Number.isFinite(tuning.bgRejectMarginZ)
      ? tuning.bgRejectMarginZ
      : 0.5;

  const seedStatsRadiusVox =
    typeof tuning?.seedStatsRadiusVox === 'number' && Number.isFinite(tuning.seedStatsRadiusVox)
      ? clampInt(tuning.seedStatsRadiusVox, 1, 6)
      : 2;

  const bgMaxSamples =
    typeof tuning?.bgMaxSamples === 'number' && Number.isFinite(tuning.bgMaxSamples)
      ? clampInt(tuning.bgMaxSamples, 64, 32_768)
      : 4096;

  const bgShellThicknessVox =
    typeof tuning?.bgShellThicknessVox === 'number' && Number.isFinite(tuning.bgShellThicknessVox)
      ? clampInt(tuning.bgShellThicknessVox, 1, 6)
      : 2;

  // Estimate the lesion from acquired anatomy connected to its user-selected seed.
  // A guide ROI deliberately includes surrounding healthy tissue, so its median is
  // usually a background statistic rather than a representative tumor intensity.
  const tumorStats = (() => {
    const samples: number[] = [];
    const seedSamples: number[] = [];

    for (let dz = -seedStatsRadiusVox; dz <= seedStatsRadiusVox; dz++) {
      const z = seed.z + dz;
      if (z < dom.minZ || z > dom.maxZ) continue;

      for (let dy = -seedStatsRadiusVox; dy <= seedStatsRadiusVox; dy++) {
        const y = seed.y + dy;
        if (y < dom.minY || y > dom.maxY) continue;

        for (let dx = -seedStatsRadiusVox; dx <= seedStatsRadiusVox; dx++) {
          const x = seed.x + dx;
          if (x < dom.minX || x > dom.maxX) continue;

          const i = idx3(x, y, z, nx, ny);
          if (observedSupport && !observedSupport[i]) continue;
          const value = acquiredIntensity(i);
          samples.push(value);
          if (value >= minV && value <= maxV) seedSamples.push(value);
        }
      }
    }

    if (roiParsed) {
      const seedLocal = robustStats(seedSamples, 0.02);
      const roiSamples = roiSamplesForTumorStats;
      if (seedLocal && roiSamples && roiSamples.length >= 64) {
        const surrounding = robustStats(roiSamples, 0.02);
        if (surrounding && Math.abs(seedLocal.mu - surrounding.mu) >= 3 * surrounding.sigma) {
          const midpoint = (seedLocal.mu + surrounding.mu) * 0.5;
          const foreground = roiSamples.filter((value) =>
            seedLocal.mu > surrounding.mu ? value >= midpoint : value <= midpoint,
          );
          return robustStats(foreground, 0.02) ?? seedLocal;
        }
      }
      if (seedLocal) return seedLocal;
      if (roiSamples && roiSamples.length >= 64) {
        return robustStats(roiSamples, 0.02) ?? { mu: seedValue, sigma: 0.05 };
      }
    }

    return robustStats(samples, 0.02) ?? { mu: seedValue, sigma: 0.05 };
  })();

  // Background stats from a thin shell *outside* the ROI (if ROI is present), or from the domain boundary.
  const bgStats = (() => {
    const r = roiParsed;
    if (!r) return null;

    const outer = {
      minX: clampInt(r.minX - bgShellThicknessVox, 0, nx - 1),
      maxX: clampInt(r.maxX + bgShellThicknessVox, 0, nx - 1),
      minY: clampInt(r.minY - bgShellThicknessVox, 0, ny - 1),
      maxY: clampInt(r.maxY + bgShellThicknessVox, 0, ny - 1),
      minZ: clampInt(r.minZ - bgShellThicknessVox, 0, nz - 1),
      maxZ: clampInt(r.maxZ + bgShellThicknessVox, 0, nz - 1),
    };

    // Sample outside ROI but within the outer bounds.
    const samples: number[] = [];
    let stride = 1;

    const outerN = (outer.maxX - outer.minX + 1) * (outer.maxY - outer.minY + 1) * (outer.maxZ - outer.minZ + 1);

    if (outerN > bgMaxSamples) {
      stride = Math.max(1, Math.floor(outerN / bgMaxSamples));
    }

    let seen = 0;
    for (let z = outer.minZ; z <= outer.maxZ; z++) {
      for (let y = outer.minY; y <= outer.maxY; y++) {
        for (let x = outer.minX; x <= outer.maxX; x++) {
          const insideRoi = x >= r.minX && x <= r.maxX && y >= r.minY && y <= r.maxY && z >= r.minZ && z <= r.maxZ;
          if (insideRoi) continue;

          if (seen % stride === 0) {
            const i = idx3(x, y, z, nx, ny);
            if (observedSupport && !observedSupport[i]) continue;
            samples.push(acquiredIntensity(i));
            if (samples.length >= bgMaxSamples) break;
          }
          seen++;
        }
        if (samples.length >= bgMaxSamples) break;
      }
      if (samples.length >= bgMaxSamples) break;
    }

    return robustStats(samples, 0.02);
  })();

  if (
    observedSupport &&
    roiParsed?.mode === 'guide' &&
    !tuning &&
    !params.seedIndices?.length &&
    opts?.maxCost === undefined &&
    !locallyDistinctSeed &&
    roiSamplesForTumorStats &&
    roiSamplesForTumorStats.length >= 64 &&
    roiBackground &&
    bgStats &&
    Math.abs(tumorStats.mu - (invertAcquiredContrast ? 1 - roiBackground.mu : roiBackground.mu)) <=
      3 * Math.max(tumorStats.sigma, roiBackground.sigma) &&
    Math.abs(tumorStats.mu - bgStats.mu) <= 3 * Math.max(tumorStats.sigma, bgStats.sigma)
  ) {
    return { indices: new Uint32Array(0), count: 0, seedValue: acquiredSeedValue, hitMaxVoxels: false };
  }

  const roiLoGate = clamp(roiQuantiles?.qLo ?? tumorStats.mu - 2.0 * tumorStats.sigma, 0, 1);
  const roiHiGate = clamp(roiQuantiles?.qHi ?? tumorStats.mu + 2.0 * tumorStats.sigma, 0, 1);
  const acquiredForegroundContrast =
    observedSupport &&
    roiParsed &&
    !tuning &&
    bgStats &&
    tumorStats.mu > bgStats.mu + 3 * Math.max(tumorStats.sigma, bgStats.sigma);
  const foregroundMaxCost =
    acquiredForegroundContrast && opts?.maxCost === undefined
      ? Math.max(maxCost, 18 + (Math.abs(seedValue - tumorStats.mu) + 2 * tumorStats.sigma) * 220)
      : maxCost;

  // Directionality gates.
  // The extreme quantiles (especially qLo) can be too permissive if the ROI contains some background.
  //
  // We keep a *looser* high gate to disable bg-likeness for bright regions, and a *stricter* high gate
  // for the strongest leniency branch (to avoid being too permissive in mid intensities).
  const roiLoCore = clamp(
    Math.max(roiLoGate, tumorStats.mu - (acquiredForegroundContrast ? 2 : 0.75) * tumorStats.sigma),
    0,
    1,
  );
  const foregroundMinimum = acquiredForegroundContrast ? Math.min(minV, roiLoCore) : minV;
  const foregroundTolerance = seedValue - foregroundMinimum;
  const roiHiLoose = clamp(Math.min(roiHiGate, tumorStats.mu + 0.75 * tumorStats.sigma), 0, 1);
  const roiHiCore = clamp(Math.min(roiHiGate, tumorStats.mu + 1.25 * tumorStats.sigma), 0, 1);

  const roiCoreDenom = Math.max(1e-6, roiHiCore - roiLoCore);
  const invRoiCoreDenom = 1 / roiCoreDenom;

  const roiLooseDenom = Math.max(1e-6, roiHiLoose - roiLoCore);
  const invRoiLooseDenom = 1 / roiLooseDenom;

  // Edge barrier: don’t penalize small within-tumor variations; focus on large jumps.
  const edgeBarrier = clamp(2.5 * tumorStats.sigma, 0.02, 0.2);

  // Cross-intensity penalty scale: choose a robust sigma-based scale so gentle ramps are cheap,
  // while strong step edges are expensive (especially for high→low direction).
  const crossSigma = Math.max(0.03, tumorStats.sigma * 0.9);
  const invCrossSigma = 1 / Math.max(1e-6, crossSigma);

  const insideRoiAt = (x: number, y: number, z: number): boolean => {
    const r = roiParsed;
    if (!r) return true;
    return x >= r.minX && x <= r.maxX && y >= r.minY && y <= r.maxY && z >= r.minZ && z <= r.maxZ;
  };

  // Smooth ROI guidance: apply a radial decay about the ROI centroid.
  //
  // IMPORTANT: We *only* apply the decay outside the ROI (rInf > 1). Inside the ROI we keep w=1,
  // so the grow is driven primarily by edges/intensity terms (avoids overly radial segmentations).
  const ROI_DECAY_K = 1.6;

  const BAND_SCALE_MAX = 1.3;

  const roiRadial = (() => {
    const r = roiParsed;
    if (!r) return null;

    const cx = (r.minX + r.maxX) * 0.5;
    const cy = (r.minY + r.maxY) * 0.5;
    const cz = (r.minZ + r.maxZ) * 0.5;

    const hx = Math.max(1e-6, (r.maxX - r.minX + 1) * 0.5);
    const hy = Math.max(1e-6, (r.maxY - r.minY + 1) * 0.5);
    const hz = Math.max(1e-6, (r.maxZ - r.minZ + 1) * 0.5);

    return { cx, cy, cz, hx, hy, hz, outsideScale: r.outsideScale };
  })();

  const intensityPenaltyAt = (v: number, bandScale: number): number => {
    // Shrink (or slightly widen) the acceptance band around the seed as a function of ROI radius.
    // - bandScale = 1 => base tolerance band
    // - bandScale < 1 => stricter (near ROI edges / outside)
    // - bandScale > 1 => slightly looser (near ROI center, to reduce central holes)
    let minR = foregroundMinimum;
    let maxR = maxV;

    if (roiParsed) {
      const s = clamp(bandScale, 0, BAND_SCALE_MAX);
      const minOutRaw = seedValue - foregroundTolerance * s;
      const maxOutRaw = seedValue + tolHi * s;
      minR = Math.min(minOutRaw, maxOutRaw);
      maxR = Math.max(minOutRaw, maxOutRaw);
    }

    if (v >= minR && v <= maxR) return 0;

    const denom = maxR - minR + tumorStats.sigma;
    const invDenom = 1 / Math.max(1e-6, denom);

    if (v > maxR) {
      const d = v - maxR;
      // Bright voxels: penalize less so we don't systematically miss cystic/hyperintense regions.
      return Math.min(1.0, 0.35 * d * invDenom);
    }

    const d = minR - v;
    return Math.min(3.0, d * invDenom);
  };

  const bgLikePenaltyAt = (v: number): number => {
    if (!bgStats) return 0;

    const zTumor = Math.abs(v - tumorStats.mu) / Math.max(1e-6, tumorStats.sigma);
    const zBg = Math.abs(v - bgStats.mu) / Math.max(1e-6, bgStats.sigma);

    const delta = zTumor - zBg - bgRejectMarginZ;
    return delta > 0 ? delta : 0;
  };

  const edgePenalty = (v0: number, v1: number): number => {
    const dv = Math.abs(v1 - v0);
    if (dv <= edgeBarrier) return 0;

    const denom = Math.max(1e-6, 1 - edgeBarrier);
    return clamp((dv - edgeBarrier) / denom, 0, 1);
  };

  const stepCost = (x0: number, y0: number, z0: number, x1: number, y1: number, z1: number): number => {
    const inside1 = insideRoiAt(x1, y1, z1);

    // Reject any domain points outside the hard ROI.
    if (roiParsed?.mode === 'hard' && !inside1) {
      return Number.POSITIVE_INFINITY;
    }

    const i0 = idx3(x0, y0, z0, nx, ny);
    const i1 = idx3(x1, y1, z1, nx, ny);

    const v0 = acquiredIntensity(i0);
    const v1 = acquiredIntensity(i1);

    // Compute a smooth ROI guidance weight based on how far (in a box-normalized sense) the voxel is
    // from the ROI centroid.
    // - w=1 inside the ROI
    // - w→0 smoothly as we move farther out
    let w = 1;
    let bandScale = 1;

    const rr = roiRadial;
    const priorStrength = rr ? 1 - rr.outsideScale : 0;

    if (rr) {
      const dx = Math.abs(x1 - rr.cx) / rr.hx;
      const dy = Math.abs(y1 - rr.cy) / rr.hy;
      const dz = Math.abs(z1 - rr.cz) / rr.hz;

      const rInf = Math.max(dx, dy, dz);
      if (rInf > 1) {
        const t = rInf - 1;
        w = Math.exp(-ROI_DECAY_K * t * t);
        bandScale = rr.outsideScale + priorStrength * w;
      }
    }

    const priorT = priorStrength * (1 - w);

    const base = (baseStepInside + (baseStepOutside - baseStepInside) * priorT) * baseStepScale;

    const dI = v1 - v0;
    const edgeRaw = edgePenalty(v0, v1);

    // Direction-aware costs:
    // - Strict in low intensity regions.
    // - Very permissive in high intensity regions (minimize false negatives on bright tumor areas).

    const toCore01 = clamp((v1 - roiLoCore) * invRoiCoreDenom, 0, 1);

    // Absolute intensity preference: make low/mid intensities accumulate cost even when edge/cross is weak,
    // so the grow strongly prefers staying in brighter regions.
    const toLoose01 = clamp((v1 - roiLoCore) * invRoiLooseDenom, 0, 1);
    const preferHighPenalty = (() => {
      const lowish = 1 - toLoose01;

      const exp =
        typeof tuning?.preferHighExponent === 'number' && Number.isFinite(tuning.preferHighExponent)
          ? clamp(tuning.preferHighExponent, 0.5, 3)
          : 1.15;

      const t = Math.pow(lowish, exp);

      // Prefer-high penalty is helpful to discourage leakage into low/mid intensities,
      // but it must stay *light* inside a user-provided ROI so we can still traverse gentle ramps.
      const insideScale = inside1 ? 0.15 : 1.0;

      const mul =
        typeof tuning?.preferHighStrengthMul === 'number' && Number.isFinite(tuning.preferHighStrengthMul)
          ? clamp(tuning.preferHighStrengthMul, 0, 50)
          : 5.5;

      const strength = intensityWeight * mul * insideScale;
      return strength * t;
    })();

    // Background-likeness delta (0 => not more background-like, >0 => increasingly bg-like).
    let bgLikeDelta = bgLikePenaltyAt(v1);
    let isBgLike = bgLikeDelta > 0;

    if (v1 >= roiHiLoose) {
      bgLikeDelta = 0;
      isBgLike = false;
    }

    const fromHigh = v0 >= roiHiLoose;
    const toLow = v1 <= roiLoCore;
    const toHigh = v1 >= roiHiCore;

    const edgeDir = (() => {
      if (dI >= 0) {
        if (toHigh) return 0.02;
        if (toLow || isBgLike) return 2.0;
        return 0.85 - 0.55 * toCore01;
      }

      if (toHigh) return 0.2;

      if (toLow || isBgLike) {
        return fromHigh ? 16.0 : 12.0;
      }

      return fromHigh ? 12.0 - 7.0 * toCore01 : 9.0 - 5.0 * toCore01;
    })();

    const edge = edgeWeight * edgeDir * edgeRaw;

    const zCross = Math.abs(dI) * invCrossSigma;
    const crossRaw = Math.min(4, zCross * zCross);

    const crossDir = (() => {
      if (dI >= 0) {
        if (toHigh) return 0.004;
        if (toLow || isBgLike) return 3.0;
        return 0.3 - 0.22 * toCore01;
      }

      if (toHigh) return 0.06;

      if (toLow || isBgLike) {
        return fromHigh ? 45.0 : 34.0;
      }

      return fromHigh ? 26.0 - 16.0 * toCore01 : 20.0 - 12.0 * toCore01;
    })();

    const cross = crossWeight * crossDir * crossRaw;

    // Absolute "ending low" downhill penalty.
    //
    // Helps prevent leakage into low-intensity/background regions when the boundary is gradual
    // (edgeRaw and dI can both be small, so multipliers alone may be insufficient).
    const endLowDownhill = (() => {
      if (!(dI < 0)) return 0;
      if (!(toLow || isBgLike)) return 0;
      if (toHigh) return 0;

      const zEndLow = Math.max(0, (roiLoCore - v1) / Math.max(1e-6, tumorStats.sigma));
      const t = Math.min(1, zEndLow / 2.0);

      const base = 2.5;
      const scale = fromHigh ? 60.0 : 48.0;
      return base + scale * t * t;
    })();

    const intenW = 1 / Math.max(0.05, bandScale);
    const inten = intensityWeight * intenW * intensityPenaltyAt(v1, bandScale);

    const bgW = 1 + 0.75 * priorT;
    const bg = bgLikeWeight * bgW * bgLikeDelta;

    return base + edge + cross + endLowDownhill + inten + bg + preferHighPenalty;
  };

  // Initialize heap with seed and any additional seeds.
  const heap = new MinHeap();

  const pushSeed = (x: number, y: number, z: number) => {
    if (!inBounds(x, y, z, nx, ny, nz)) return;
    if (x < dom.minX || x > dom.maxX || y < dom.minY || y > dom.maxY || z < dom.minZ || z > dom.maxZ) return;
    if (observedSupport && !observedSupport[idx3(x, y, z, nx, ny)]) return;

    if (roiParsed?.mode === 'hard' && !insideRoiAt(x, y, z)) return;

    const li = toLocal(x, y, z);
    if (dist[li] === 0) return;

    dist[li] = 0;
    heap.push(li, 0);
  };

  pushSeed(seed.x, seed.y, seed.z);

  if (params.seedIndices) {
    const seeds = params.seedIndices;
    const strideY = nx;
    const strideZ = nx * ny;
    for (let si = 0; si < seeds.length; si++) {
      const gi = seeds[si]!;
      if (!(gi >= 0 && gi < n)) continue;

      const z = Math.floor(gi / strideZ);
      const yz = gi - z * strideZ;
      const y = Math.floor(yz / strideY);
      const x = yz - y * strideY;

      pushSeed(x, y, z);
    }
  }

  if (heap.size === 0) {
    return { indices: new Uint32Array(0), count: 0, seedValue: acquiredSeedValue, hitMaxVoxels: false };
  }

  const out = new Uint32Array(Math.min(maxVoxels, domN));
  let outCount = 0;

  let processed = 0;
  let hitMaxVoxels = false;

  // Debug counters.
  let dbgInside = 0;
  let dbgOutside = 0;

  while (heap.size > 0) {
    if (opts?.signal?.aborted) break;

    const li = heap.pop();
    if (li < 0) break;
    const d = heap.distance;

    if (d !== dist[li]) continue;
    if (finalized[li]) continue;

    if (d > foregroundMaxCost) {
      // Costs are non-negative, so all remaining candidates will be >= d.
      break;
    }

    finalized[li] = 1;

    const { x, y, z } = fromLocal(li);
    const gi = idx3(x, y, z, nx, ny);

    if (outCount >= out.length) {
      hitMaxVoxels = true;
      break;
    }

    out[outCount++] = gi;

    const inside = insideRoiAt(x, y, z);
    if (inside) dbgInside++;
    else dbgOutside++;

    processed++;
    if (yieldEvery > 0 && processed % yieldEvery === 0) {
      opts?.onProgress?.({ processed, queued: outCount });
      await yieldFn();
    }

    const tryNeighbor = (xn: number, yn: number, zn: number) => {
      if (!inBounds(xn, yn, zn, nx, ny, nz)) return;
      if (xn < dom.minX || xn > dom.maxX || yn < dom.minY || yn > dom.maxY || zn < dom.minZ || zn > dom.maxZ) return;
      if (observedSupport && !observedSupport[idx3(xn, yn, zn, nx, ny)]) return;

      const li2 = toLocal(xn, yn, zn);
      if (finalized[li2]) return;

      const c = stepCost(x, y, z, xn, yn, zn);
      if (!Number.isFinite(c)) return;

      const nd = d + c;
      if (nd < dist[li2]) {
        dist[li2] = nd;
        // IMPORTANT: dist is stored in a Float32Array; push the stored (float32-rounded) value
        // so the stale-entry check `item.d !== dist[item.i]` is stable.
        heap.push(li2, dist[li2]!);
      }
    };

    if (connectivity === 6) {
      tryNeighbor(x - 1, y, z);
      tryNeighbor(x + 1, y, z);
      tryNeighbor(x, y - 1, z);
      tryNeighbor(x, y + 1, z);
      tryNeighbor(x, y, z - 1);
      tryNeighbor(x, y, z + 1);
    } else {
      for (let dz = -1; dz <= 1; dz++) {
        for (let dy = -1; dy <= 1; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            if (dx === 0 && dy === 0 && dz === 0) continue;
            tryNeighbor(x + dx, y + dy, z + dz);
          }
        }
      }
    }
  }

  if (debug) {
    console.log('[regionGrow3D_v2] done', {
      dims,
      seed,
      seedValue: acquiredSeedValue,
      minV,
      maxV,
      maxCost: foregroundMaxCost,
      roi: roiParsed,
      dom: { minX: dom.minX, maxX: dom.maxX, minY: dom.minY, maxY: dom.maxY, minZ: dom.minZ, maxZ: dom.maxZ },
      tumorStats,
      bgStats,
      edgeBarrier,
      counts: { kept: outCount, inside: dbgInside, outside: dbgOutside },
    });
  }

  return {
    indices: out.subarray(0, outCount),
    count: outCount,
    seedValue: acquiredSeedValue,
    hitMaxVoxels,
  };
}
