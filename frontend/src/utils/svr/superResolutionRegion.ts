import type { SvrLabelVolume, SvrRoi, SvrVolume } from '../../types/svr';
import { nativeDecodedCacheBudgetBytes, retainedSvrVolumeBytes } from './nativeVolume';
import { SVR_MEMORY_BUDGET_BYTES } from './svrMemoryPlan';
import { assertNotAborted, yieldToMain } from './svrUtils';
import { MAX_SR_OUTPUT_VOXELS, MIN_SR_CONTEXT_DIM } from './superResolutionTypes';
import { IDENTITY_DIRECTION, patientToVolumeVoxel, physicalVolumeBounds, volumeVoxelToPatient } from './volumeGeometry';

type Triple = [number, number, number];
type EnhancementGrid = Pick<SvrVolume, 'dims' | 'voxelSizeMm' | 'originMm' | 'direction'>;

/** Shift a context window inward at a real source edge; never pad or discard real samples. */
function sourceInterval(lower: number, upper: number, size: number): [number, number] {
  const width = Math.min(upper - lower, size);
  const start = Math.max(-0.5, Math.min(lower, size - 0.5 - width));
  return [start, start + width];
}

/** Whole cell footprints, not patient-axis AABBs, decide whether a native crop can be reused. */
export function enhancementContextFits(volume: EnhancementGrid, context: EnhancementGrid): boolean {
  for (const x of [-0.5, context.dims[0] - 0.5])
    for (const y of [-0.5, context.dims[1] - 0.5])
      for (const z of [-0.5, context.dims[2] - 0.5]) {
        const point = patientToVolumeVoxel(volume, volumeVoxelToPatient(context, [x, y, z]));
        if (
          point.some(
            (value, axis) => !Number.isFinite(value) || value < -0.50001 || value > volume.dims[axis]! - 0.49999,
          )
        )
          return false;
      }
  return true;
}
export type EnhancementSourceOptions = {
  signal?: AbortSignal;
  onProgress?: (progress: { current: number; total: number; message: string }) => void;
  retainedBytes?: number;
};
export type EnhancementSourceLoader = (labels: SvrLabelVolume, options: EnhancementSourceOptions) => Promise<SvrVolume>;

/** Only completed, reproducible MRI images may be reclaimed; no persistent data or cache limits are changed. */
export type EnhancementImageCache = {
  getCacheInfo?: () => { cacheSizeInBytes?: number; maximumSizeInBytes?: number };
  cachedImages?: readonly {
    loaded: boolean;
    imageId: string;
    timeStamp: number;
    sizeInBytes: number;
    imageLoadObject?: object;
  }[];
  getImageLoadObject?: (imageId: string) => unknown;
  removeImageLoadObject?: (imageId: string) => void;
};
export type EnhancementProtectedImageIds = ReadonlySet<string> | (() => ReadonlySet<string>);

/** Includes worker copies, training scratch, output, normalization staging and GPU ownership. */
export function enhancementWorkingBytes(sourceVoxels: number): number {
  if (!Number.isSafeInteger(sourceVoxels) || sourceVoxels < 1) return Infinity;
  return 32 * 1024 * 1024 + sourceVoxels * 104;
}

export function assertEnhancementFits(sourceVoxels: number, retainedBytes = 0): void {
  if (!Number.isSafeInteger(sourceVoxels) || sourceVoxels < 1 || !Number.isFinite(retainedBytes) || retainedBytes < 0)
    throw new Error(
      'Enhancement requires a valid source size and a finite, nonnegative retained-memory estimate. Original detail will not be reduced.',
    );
  if (sourceVoxels * 8 > MAX_SR_OUTPUT_VOXELS)
    throw new Error(
      'This region is too large for 2× enhancement in the browser. Select a smaller region; original detail will not be reduced.',
    );
  const totalBytes = enhancementWorkingBytes(sourceVoxels) + retainedBytes;
  if (totalBytes <= SVR_MEMORY_BUDGET_BYTES) return;
  const budgetMiB = Math.floor(SVR_MEMORY_BUDGET_BYTES / (1024 * 1024));
  if (retainedBytes + enhancementWorkingBytes(MIN_SR_CONTEXT_DIM ** 3) > SVR_MEMORY_BUDGET_BYTES)
    throw new Error(
      `The open volume and working data leave no room for even a small enhancement (${Math.ceil(retainedBytes / (1024 * 1024))} MiB retained; ${budgetMiB} MiB budget). Load native detail for this selection, then try again. Original detail will not be reduced.`,
    );
  throw new Error(
    `This region is too large for 2× enhancement with the currently open data (estimated ${Math.ceil(totalBytes / (1024 * 1024))} MiB; ${budgetMiB} MiB budget). Select a smaller region; original detail will not be reduced.`,
  );
}

/** Reclaim only enough idle decoded MRI cache to admit this region, using measured residency after every removal. */
export async function prepareEnhancementMemory(
  sourceVoxels: number,
  retainedBytes: number,
  cache: EnhancementImageCache,
  protectedImageIds?: EnhancementProtectedImageIds,
  signal?: AbortSignal,
): Promise<number> {
  assertNotAborted(signal);
  // A larger-than-supported region or an irreducible resident floor cannot be fixed by discarding cache entries.
  assertEnhancementFits(sourceVoxels, retainedBytes);
  const measure = () => {
    try {
      const info = cache.getCacheInfo?.();
      return {
        bytes: nativeDecodedCacheBudgetBytes(info),
        measured: Number.isFinite(info?.cacheSizeInBytes) && info!.cacheSizeInBytes! >= 0,
      };
    } catch {
      return { bytes: nativeDecodedCacheBudgetBytes(), measured: false };
    }
  };
  const availableBytes = SVR_MEMORY_BUDGET_BYTES - retainedBytes - enhancementWorkingBytes(sourceVoxels);
  let residency = measure();
  let removed = false;
  if (
    residency.bytes > availableBytes &&
    residency.measured &&
    cache.removeImageLoadObject &&
    cache.getImageLoadObject
  ) {
    const reclaimable = (entry: NonNullable<EnhancementImageCache['cachedImages']>[number]) =>
      entry.loaded &&
      Number.isFinite(entry.sizeInBytes) &&
      entry.sizeInBytes > 0 &&
      Number.isFinite(entry.timeStamp) &&
      entry.imageLoadObject !== undefined &&
      /^(miradb|miraderived):/.test(entry.imageId);
    // The public cache owns an ID dictionary. Check its current loader identity instead of rescanning its array.
    const candidates = (cache.cachedImages ?? []).filter(reclaimable);
    candidates.sort((a, b) => a.timeStamp - b.timeStamp);
    try {
      for (const candidate of candidates) {
        assertNotAborted(signal);
        if (residency.bytes <= availableBytes) break;
        if (!reclaimable(candidate)) continue;
        const protectedIds = typeof protectedImageIds === 'function' ? protectedImageIds() : protectedImageIds;
        if (protectedIds?.has(candidate.imageId)) continue;
        const before = residency.bytes;
        try {
          // A synchronous cache event may replace this ID with a pending load. Never cancel the replacement.
          if (cache.getImageLoadObject(candidate.imageId) !== candidate.imageLoadObject) continue;
          cache.removeImageLoadObject(candidate.imageId);
          removed = true;
        } catch {
          // Another cache owner may have removed it. Fresh totals, never the advertised entry size, decide.
        }
        residency = measure();
        // Missing or unchanged accounting cannot justify blindly discarding the rest of the cache.
        if (!residency.measured || residency.bytes >= before) break;
      }
    } finally {
      // Drop every loader/pixel reference before yielding or allocating the source/enhancement buffers.
      candidates.length = 0;
    }
  }
  if (removed) await yieldToMain();
  assertNotAborted(signal);
  residency = measure();
  assertEnhancementFits(sourceVoxels, retainedBytes + residency.bytes);
  return residency.bytes;
}

/** Native-context bounds, without stretching a long narrow selection into a cube. */
async function selectionBounds(volume: SvrVolume, labels: SvrLabelVolume, signal?: AbortSignal) {
  assertNotAborted(signal);
  const direction = volume.direction ?? IDENTITY_DIRECTION;
  if (
    volume.dims.length !== 3 ||
    volume.dims.some((size) => !Number.isSafeInteger(size) || size < 1) ||
    volume.voxelSizeMm.length !== 3 ||
    volume.voxelSizeMm.some((pitch) => !Number.isFinite(pitch) || pitch <= 0) ||
    volume.originMm.length !== 3 ||
    volume.originMm.some((value) => !Number.isFinite(value)) ||
    direction.length !== 9 ||
    direction.some((value) => !Number.isFinite(value))
  )
    throw new Error('Enhancement requires finite source geometry and positive voxel spacing.');
  for (let row = 0; row < 3; row++)
    for (let other = row; other < 3; other++) {
      const dot = [0, 1, 2].reduce((sum, axis) => sum + direction[row * 3 + axis]! * direction[other * 3 + axis]!, 0);
      if (Math.abs(dot - (row === other ? 1 : 0)) > 1e-4)
        throw new Error('Enhancement requires orthonormal source geometry.');
    }
  const count = volume.dims.reduce((product, axis) => product * axis, 1);
  if (
    !Number.isSafeInteger(count) ||
    count !== volume.data.length ||
    labels.data.length !== count ||
    labels.dims.some((size, axis) => size !== volume.dims[axis]) ||
    (volume.observedSupport && volume.observedSupport.length !== count)
  )
    throw new Error('The selection no longer matches this volume. Reopen the volume before enhancing it.');
  const min: Triple = [Infinity, Infinity, Infinity],
    max: Triple = [-Infinity, -Infinity, -Infinity];
  const [nx, ny, nz] = volume.dims;
  for (let z = 0; z < nz; z++) {
    if (z % 8 === 0) {
      assertNotAborted(signal);
      await yieldToMain();
    }
    for (let y = 0; y < ny; y++)
      for (let x = 0; x < nx; x++) {
        const index = (z * ny + y) * nx + x;
        if (!labels.data[index] || (volume.observedSupport && !volume.observedSupport[index])) continue;
        if (!Number.isFinite(volume.data[index])) continue;
        min[0] = Math.min(min[0], x);
        min[1] = Math.min(min[1], y);
        min[2] = Math.min(min[2], z);
        max[0] = Math.max(max[0], x);
        max[1] = Math.max(max[1], y);
        max[2] = Math.max(max[2], z);
      }
  }
  assertNotAborted(signal);
  if (!Number.isFinite(min[0])) throw new Error('Mark a region before enhancing its detail.');
  return { min, max };
}

/** Learn from tissue around the selection too; a zeroed mask is never an MRI input. */
export async function enhancementSelectionRoi(
  volume: SvrVolume,
  labels: SvrLabelVolume,
  signal?: AbortSignal,
  sourceGrid?: EnhancementGrid,
): Promise<SvrRoi> {
  const bounds = await selectionBounds(volume, labels, signal);
  const grid = sourceGrid ?? volume;
  if (sourceGrid) {
    const sourceMin: Triple = [Infinity, Infinity, Infinity],
      sourceMax: Triple = [-Infinity, -Infinity, -Infinity];
    for (const x of [bounds.min[0] - 0.5, bounds.max[0] + 0.5])
      for (const y of [bounds.min[1] - 0.5, bounds.max[1] + 0.5])
        for (const z of [bounds.min[2] - 0.5, bounds.max[2] + 0.5]) {
          const point = patientToVolumeVoxel(sourceGrid, volumeVoxelToPatient(volume, [x, y, z]));
          for (let axis = 0; axis < 3; axis++) {
            sourceMin[axis] = Math.min(sourceMin[axis]!, point[axis]!);
            sourceMax[axis] = Math.max(sourceMax[axis]!, point[axis]!);
          }
        }
    // Convert the selected cell-edge bounds back to the center convention below.
    for (let axis = 0; axis < 3; axis++) {
      bounds.min[axis] = sourceMin[axis]! + 0.5;
      bounds.max[axis] = sourceMax[axis]! - 0.5;
    }
  }
  const native = sourceGrid?.voxelSizeMm ?? volume.nativeVoxelSizeMm ?? volume.voxelSizeMm;
  const lower: Triple = [0, 0, 0],
    upper: Triple = [0, 0, 0];
  for (let axis = 0; axis < 3; axis++) {
    const pitch = grid.voxelSizeMm[axis]!;
    if (!(pitch > 0) || !Number.isFinite(pitch) || !(native[axis]! > 0) || !Number.isFinite(native[axis]))
      throw new Error('Enhancement requires finite positive source spacing.');
    const center = (bounds.min[axis]! + bounds.max[axis]!) / 2;
    // 3³ predictor context plus enough independent blocks for local model fitting.
    const half = Math.max(
      (bounds.max[axis]! - bounds.min[axis]! + 1) / 2 + (6 * native[axis]!) / pitch,
      ((MIN_SR_CONTEXT_DIM / 2) * native[axis]!) / pitch,
    );
    lower[axis] = center - half;
    upper[axis] = center + half;
    if (sourceGrid) [lower[axis], upper[axis]] = sourceInterval(lower[axis]!, upper[axis]!, sourceGrid.dims[axis]!);
  }
  const min: Triple = [Infinity, Infinity, Infinity],
    max: Triple = [-Infinity, -Infinity, -Infinity];
  for (const x of [lower[0], upper[0]])
    for (const y of [lower[1], upper[1]])
      for (const z of [lower[2], upper[2]]) {
        const point = volumeVoxelToPatient(grid, [x, y, z]);
        for (let axis = 0; axis < 3; axis++) {
          min[axis] = Math.min(min[axis]!, point[axis]!);
          max[axis] = Math.max(max[axis]!, point[axis]!);
        }
      }
  return {
    mode: 'box',
    sourcePlane: 'axial',
    sourceSeriesUid: volume.sourceProvenance?.primarySeriesUid,
    boundsMm: { min, max },
  };
}

/** Copy a bounded source-grid region. The returned buffers belong exclusively to enhancement. */
export async function cropEnhancementSource(
  volume: SvrVolume,
  labels: SvrLabelVolume,
  options: EnhancementSourceOptions & {
    imageCache?: EnhancementImageCache;
    protectedImageIds?: EnhancementProtectedImageIds;
  } = {},
): Promise<SvrVolume> {
  const { min, max } = await selectionBounds(volume, labels, options.signal);
  for (let axis = 0; axis < 3; axis++) {
    const center = (min[axis]! + max[axis]!) / 2;
    const half = Math.max(MIN_SR_CONTEXT_DIM / 2, (max[axis]! - min[axis]! + 1) / 2 + 6);
    const [lower, upper] = sourceInterval(
      Math.floor(center - half + 0.5) - 0.5,
      Math.ceil(center + half - 0.5) + 0.5,
      volume.dims[axis]!,
    );
    min[axis] = lower + 0.5;
    max[axis] = upper - 0.5;
  }
  const dims = min.map((value, axis) => max[axis]! - value + 1) as Triple;
  const count = dims[0] * dims[1] * dims[2];
  const retainedBytes = retainedSvrVolumeBytes(volume) + (options.retainedBytes ?? 0);
  if (options.imageCache)
    await prepareEnhancementMemory(count, retainedBytes, options.imageCache, options.protectedImageIds, options.signal);
  else assertEnhancementFits(count, retainedBytes);
  const data = new Float32Array(count),
    observedSupport = new Uint8Array(count);
  let supportedVoxelCount = 0;
  for (let z = 0; z < dims[2]; z++) {
    assertNotAborted(options.signal);
    for (let y = 0; y < dims[1]; y++) {
      const start = ((z + min[2]) * volume.dims[1] + y + min[1]) * volume.dims[0] + min[0];
      const target = (z * dims[1] + y) * dims[0];
      data.set(volume.data.subarray(start, start + dims[0]), target);
      for (let x = 0; x < dims[0]; x++) {
        const supported =
          Number.isFinite(data[target + x]) && (!volume.observedSupport || Boolean(volume.observedSupport[start + x]));
        observedSupport[target + x] = supported ? 1 : 0;
        supportedVoxelCount += supported ? 1 : 0;
      }
    }
    if (z % 8 === 0) await yieldToMain();
  }
  assertNotAborted(options.signal);
  // Decoding/browsing can refill the cache during cooperative copying; admit the next phase against current owners.
  if (options.imageCache)
    await prepareEnhancementMemory(count, retainedBytes, options.imageCache, options.protectedImageIds, options.signal);
  const cropped: SvrVolume = {
    ...volume,
    data,
    observedSupport,
    supportedVoxelCount,
    dims,
    originMm: volumeVoxelToPatient(volume, min),
  };
  cropped.boundsMm = physicalVolumeBounds(cropped);
  return cropped;
}
