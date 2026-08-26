import type { VolumeDims } from './trilinear';
import { sampleTrilinear, sampleTrilinearWithSupport, splatTrilinearScaled } from './trilinear';
import type { Vec3 } from './vec3';
import { assertNotAborted, clamp01, withinTrilinearSupport } from './svrUtils';

export type SvrPsfMode = 'none' | 'box' | 'gaussian';
export type SvrRobustLoss = 'none' | 'huber' | 'tukey';

export type SvrReconstructionOptions = {
  iterations: number;
  stepSize: number;
  clampOutput: boolean;

  // Forward model knobs
  psfMode: SvrPsfMode;

  // Solver knobs
  robustLoss: SvrRobustLoss;
  robustDelta: number;
  laplacianWeight: number;
};

export type SvrReconstructionGrid = {
  dims: VolumeDims;
  originMm: Vec3;
  voxelSizeMm: number;
};

export type SvrReconstructionSlice = {
  // Downsampled pixel grid (normalized to [0,1])
  pixels: Float32Array;
  /** Acquired-pixel support; when absent, every finite pixel is valid. */
  valid?: Uint8Array;
  /** Maximum encoded validity value; omitted legacy masks use binary 0/1 support. */
  validScale?: number;
  dsRows: number;
  dsCols: number;

  // Spatial mapping
  ippMm: Vec3;
  rowDir: Vec3;
  colDir: Vec3;
  normalDir: Vec3;

  rowSpacingDsMm: number;
  colSpacingDsMm: number;

  // Optional thickness/spacing hints (if present in DICOM metadata)
  sliceThicknessMm: number | null;
  spacingBetweenSlicesMm: number | null;
  /** DICOM patient-space compatibility authority; absent means unverified. */
  frameOfReferenceUid?: string;
  /** Optional native-image identity retained for derived-plane provenance. */
  sopInstanceUid?: string;
};

export type SvrCoreHooks = {
  signal?: AbortSignal;
  yieldToMain?: () => Promise<void>;
  onProgress?: (p: { current: number; total: number; message: string }) => void;
};

/** Decode compact fractional support while preserving legacy binary 0/1 masks. */
export function acquiredObservationWeight(
  slice: Pick<SvrReconstructionSlice, 'valid' | 'validScale'>,
  index: number,
): number {
  if (!slice.valid) return 1;
  const encoded = slice.valid[index] ?? 0;
  if (encoded === 0) return 0;
  const scale = slice.validScale;
  return typeof scale === 'number' && scale > 0 && encoded < scale ? encoded / scale : 1;
}

type SlicePsf = {
  offsetsXMm: Float32Array;
  offsetsYMm: Float32Array;
  offsetsZMm: Float32Array;
  weights: Float32Array;
  count: number;
};

const SINGLE_SAMPLE_PSF: SlicePsf = {
  offsetsXMm: new Float32Array([0]),
  offsetsYMm: new Float32Array([0]),
  offsetsZMm: new Float32Array([0]),
  weights: new Float32Array([1]),
  count: 1,
};

function buildSlicePsf(params: { slice: SvrReconstructionSlice; voxelSizeMm: number; mode: SvrPsfMode }): SlicePsf {
  const { slice, voxelSizeMm, mode } = params;

  if (mode === 'none') return SINGLE_SAMPLE_PSF;

  // Inter-slice center spacing describes sampling cadence, not the excitation
  // profile: using it as thickness would turn an unobserved slab into anatomy.
  const hint = slice.sliceThicknessMm;
  const thicknessMm = typeof hint === 'number' && Number.isFinite(hint) && hint > 0 ? hint : voxelSizeMm;

  const ratio = thicknessMm / Math.max(1e-6, voxelSizeMm);

  // Preserve the cheap one-sample path for source pixels no larger than the
  // destination grid. Coarser pixels receive bounded separable box quadrature
  // so their physically acquired footprint is not collapsed into a point.
  const inPlaneSamples = (spacingMm: number): number => {
    if (!(spacingMm > voxelSizeMm * 1.25)) return 1;
    return Math.min(5, Math.max(2, Math.ceil(spacingMm / voxelSizeMm)));
  };
  const rowCount = inPlaneSamples(slice.rowSpacingDsMm);
  const colCount = inPlaneSamples(slice.colSpacingDsMm);

  // Use an odd count so the through-plane kernel stays centered and symmetric.
  let normalCount = Math.round(ratio);
  if (normalCount < 1) normalCount = 1;
  if (normalCount > 15) normalCount = 15;
  if (normalCount % 2 === 0) normalCount += 1;
  if (rowCount === 1 && colCount === 1 && normalCount === 1) return SINGLE_SAMPLE_PSF;

  const normalOffsetsMm = new Float32Array(normalCount);
  const normalWeights = new Float32Array(normalCount);

  const half = 0.5 * thicknessMm;
  const step = thicknessMm / normalCount;

  // Gaussian: distance-to-plane weighting within the thickness support.
  // We pick sigma so that the tails are non-trivial within [-half, +half].
  const sigma = Math.max(1e-6, half * 0.5);

  let wSum = 0;
  for (let i = 0; i < normalCount; i++) {
    const off = -half + (i + 0.5) * step;
    normalOffsetsMm[i] = off;

    let w = 1;
    if (mode === 'gaussian') {
      const u = off / sigma;
      w = Math.exp(-0.5 * u * u);
    }

    normalWeights[i] = w;
    wSum += w;
  }

  if (wSum > 1e-12) {
    const inv = 1 / wSum;
    for (let i = 0; i < normalCount; i++) {
      normalWeights[i] *= inv;
    }
  }

  const count = rowCount * colCount * normalCount;
  const offsetsXMm = new Float32Array(count);
  const offsetsYMm = new Float32Array(count);
  const offsetsZMm = new Float32Array(count);
  const weights = new Float32Array(count);
  const inPlaneWeight = 1 / (rowCount * colCount);
  let cursor = 0;

  for (let row = 0; row < rowCount; row++) {
    const rowOffsetMm = rowCount === 1 ? 0 : ((row + 0.5) / rowCount - 0.5) * slice.rowSpacingDsMm;
    for (let column = 0; column < colCount; column++) {
      const colOffsetMm = colCount === 1 ? 0 : ((column + 0.5) / colCount - 0.5) * slice.colSpacingDsMm;
      for (let normal = 0; normal < normalCount; normal++) {
        const normalOffsetMm = normalOffsetsMm[normal] ?? 0;
        offsetsXMm[cursor] =
          slice.colDir.x * rowOffsetMm + slice.rowDir.x * colOffsetMm + slice.normalDir.x * normalOffsetMm;
        offsetsYMm[cursor] =
          slice.colDir.y * rowOffsetMm + slice.rowDir.y * colOffsetMm + slice.normalDir.y * normalOffsetMm;
        offsetsZMm[cursor] =
          slice.colDir.z * rowOffsetMm + slice.rowDir.z * colOffsetMm + slice.normalDir.z * normalOffsetMm;
        weights[cursor] = (normalWeights[normal] ?? 0) * inPlaneWeight;
        cursor++;
      }
    }
  }

  return { offsetsXMm, offsetsYMm, offsetsZMm, weights, count };
}

function robustResidualWeight(residual: number, mode: SvrRobustLoss, delta: number): number {
  if (mode === 'none') return 1;

  const a = Math.abs(residual);
  if (mode === 'huber') {
    return a <= delta ? 1 : delta / a;
  }

  // Tukey's biweight.
  if (a >= delta) return 0;
  const r = a / delta;
  const t = 1 - r * r;
  return t * t;
}

function normalizeVolumeInPlace(volume: Float32Array, weight: Float32Array, observedSupport?: Uint8Array): number {
  let supportedVoxelCount = 0;
  for (let i = 0; i < volume.length; i++) {
    const w = weight[i];
    const supported = w > 1e-12;
    volume[i] = supported ? volume[i] / w : 0;
    if (observedSupport) {
      observedSupport[i] = supported ? 1 : 0;
      if (supported) supportedVoxelCount++;
    }
  }
  return supportedVoxelCount;
}

function markTrilinearObservedSupport(
  support: Uint8Array,
  dims: VolumeDims,
  x: number,
  y: number,
  z: number,
  weightScale: number,
): number {
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const z0 = Math.floor(z);
  const fx = x - x0;
  const fy = y - y0;
  const fz = z - z0;
  const strideY = dims.nx;
  const strideZ = dims.nx * dims.ny;
  const base = x0 + y0 * strideY + z0 * strideZ;
  const xStep = x0 + 1 < dims.nx ? 1 : 0;
  const yStep = y0 + 1 < dims.ny ? strideY : 0;
  const zStep = z0 + 1 < dims.nz ? strideZ : 0;
  const wx0 = 1 - fx;
  const wy0 = 1 - fy;
  const wz0 = 1 - fz;

  let added = 0;
  let index = base;
  if (wx0 * wy0 * wz0 * weightScale > 1e-12 && !support[index]) {
    support[index] = 1;
    added++;
  }
  index = base + xStep;
  if (fx * wy0 * wz0 * weightScale > 1e-12 && !support[index]) {
    support[index] = 1;
    added++;
  }
  index = base + yStep;
  if (wx0 * fy * wz0 * weightScale > 1e-12 && !support[index]) {
    support[index] = 1;
    added++;
  }
  index = base + yStep + xStep;
  if (fx * fy * wz0 * weightScale > 1e-12 && !support[index]) {
    support[index] = 1;
    added++;
  }
  index = base + zStep;
  if (wx0 * wy0 * fz * weightScale > 1e-12 && !support[index]) {
    support[index] = 1;
    added++;
  }
  index = base + zStep + xStep;
  if (fx * wy0 * fz * weightScale > 1e-12 && !support[index]) {
    support[index] = 1;
    added++;
  }
  index = base + zStep + yStep;
  if (wx0 * fy * fz * weightScale > 1e-12 && !support[index]) {
    support[index] = 1;
    added++;
  }
  index = base + zStep + yStep + xStep;
  if (fx * fy * fz * weightScale > 1e-12 && !support[index]) {
    support[index] = 1;
    added++;
  }
  return added;
}

/** Builds fine-grid acquired support without allocating a pair of full Float32 volumes. */
export async function buildObservedSupportFromSlices(params: {
  slices: readonly SvrReconstructionSlice[];
  grid: SvrReconstructionGrid;
  psfMode: SvrPsfMode;
  hooks?: SvrCoreHooks;
  onObservedSupport?: (supportedVoxelCount: number) => void;
}): Promise<Uint8Array> {
  const { slices, grid, psfMode, hooks } = params;
  const { dims, originMm, voxelSizeMm } = grid;
  const observedSupport = new Uint8Array(dims.nx * dims.ny * dims.nz);
  let supportedVoxelCount = 0;
  const invVox = 1 / voxelSizeMm;

  for (let sliceIndex = 0; sliceIndex < slices.length; sliceIndex++) {
    assertNotAborted(hooks?.signal);
    const slice = slices[sliceIndex];
    if (!slice) continue;
    if (slice.valid && slice.valid.length !== slice.pixels.length) {
      throw new Error('SVR acquired-pixel support does not match its image dimensions');
    }

    const psf = buildSlicePsf({ slice, voxelSizeMm, mode: psfMode });
    for (let row = 0; row < slice.dsRows; row++) {
      const baseX = slice.ippMm.x + slice.colDir.x * row * slice.rowSpacingDsMm;
      const baseY = slice.ippMm.y + slice.colDir.y * row * slice.rowSpacingDsMm;
      const baseZ = slice.ippMm.z + slice.colDir.z * row * slice.rowSpacingDsMm;
      const rowBase = row * slice.dsCols;

      for (let column = 0; column < slice.dsCols; column++) {
        const index = rowBase + column;
        const observation = slice.pixels[index];
        const observationWeight = acquiredObservationWeight(slice, index);
        if (!(observationWeight > 0) || observation === undefined || !Number.isFinite(observation)) {
          continue;
        }

        const worldX = baseX + slice.rowDir.x * column * slice.colSpacingDsMm;
        const worldY = baseY + slice.rowDir.y * column * slice.colSpacingDsMm;
        const worldZ = baseZ + slice.rowDir.z * column * slice.colSpacingDsMm;

        for (let sampleIndex = 0; sampleIndex < psf.count; sampleIndex++) {
          const weight = psf.weights[sampleIndex] ?? 0;
          if (!(weight > 0)) continue;

          const x = (worldX + (psf.offsetsXMm[sampleIndex] ?? 0) - originMm.x) * invVox;
          const y = (worldY + (psf.offsetsYMm[sampleIndex] ?? 0) - originMm.y) * invVox;
          const z = (worldZ + (psf.offsetsZMm[sampleIndex] ?? 0) - originMm.z) * invVox;
          if (withinTrilinearSupport(dims, x, y, z)) {
            supportedVoxelCount += markTrilinearObservedSupport(
              observedSupport,
              dims,
              x,
              y,
              z,
              weight * observationWeight,
            );
          }
        }
      }
    }

    if (sliceIndex % 4 === 0) await hooks?.yieldToMain?.();
  }

  params.onObservedSupport?.(supportedVoxelCount);
  return observedSupport;
}

function laplacianSmoothInPlace(
  volume: Float32Array,
  dims: VolumeDims,
  lambda: number,
  scratch: Float32Array,
  occupancy?: Uint8Array,
): void {
  if (!(lambda > 0)) return;
  const { nx, ny, nz } = dims;
  if (nx < 3 || ny < 3 || nz < 3) return;

  const strideY = nx;
  const strideZ = nx * ny;

  // Compute Laplacian into scratch (interior only).
  for (let z = 1; z < nz - 1; z++) {
    const zBase = z * strideZ;
    for (let y = 1; y < ny - 1; y++) {
      const base = zBase + y * strideY;
      for (let x = 1; x < nx - 1; x++) {
        const idx = base + x;
        if (occupancy && !occupancy[idx]) continue;
        const c = volume[idx] ?? 0;
        let laplacian = 0;
        if (!occupancy || occupancy[idx - 1]) laplacian += (volume[idx - 1] ?? 0) - c;
        if (!occupancy || occupancy[idx + 1]) laplacian += (volume[idx + 1] ?? 0) - c;
        if (!occupancy || occupancy[idx - strideY]) laplacian += (volume[idx - strideY] ?? 0) - c;
        if (!occupancy || occupancy[idx + strideY]) laplacian += (volume[idx + strideY] ?? 0) - c;
        if (!occupancy || occupancy[idx - strideZ]) laplacian += (volume[idx - strideZ] ?? 0) - c;
        if (!occupancy || occupancy[idx + strideZ]) laplacian += (volume[idx + strideZ] ?? 0) - c;

        scratch[idx] = laplacian;
      }
    }
  }

  // Apply update (interior only).
  for (let z = 1; z < nz - 1; z++) {
    const zBase = z * strideZ;
    for (let y = 1; y < ny - 1; y++) {
      const base = zBase + y * strideY;
      for (let x = 1; x < nx - 1; x++) {
        const idx = base + x;
        if (occupancy && !occupancy[idx]) continue;
        const lap = scratch[idx] ?? 0;
        volume[idx] = (volume[idx] ?? 0) + lambda * lap;
      }
    }
  }
}

export async function reconstructVolumeFromSlices(params: {
  slices: SvrReconstructionSlice[];
  grid: SvrReconstructionGrid;
  options: SvrReconstructionOptions;
  hooks?: SvrCoreHooks;
  /** Optional caller-owned support map: 1 iff the voxel received an observation. */
  occupancy?: Uint8Array;
  onObservedSupport?: (supportedVoxelCount: number) => void;
}): Promise<Float32Array> {
  const { slices, grid, options, hooks } = params;
  const { dims, originMm, voxelSizeMm } = grid;

  const yieldToMain = hooks?.yieldToMain ?? (async () => {});

  const nvox = dims.nx * dims.ny * dims.nz;
  if (params.occupancy && params.occupancy.length !== nvox) {
    throw new Error('SVR occupancy map does not match reconstruction grid');
  }
  const volume = new Float32Array(nvox);
  const weight = new Float32Array(nvox);

  const psfBySlice = slices.map((s) => buildSlicePsf({ slice: s, voxelSizeMm, mode: options.psfMode }));

  // 1) Initial splat (backprojection of observations).
  const invVox = 1 / voxelSizeMm;

  for (let sIdx = 0; sIdx < slices.length; sIdx++) {
    assertNotAborted(hooks?.signal);
    const s = slices[sIdx];
    if (!s) continue;
    if (s.valid && s.valid.length !== s.pixels.length) {
      throw new Error('SVR acquired-pixel support does not match its image dimensions');
    }

    const psf = psfBySlice[sIdx];

    for (let r = 0; r < s.dsRows; r++) {
      const baseX = s.ippMm.x + s.colDir.x * (r * s.rowSpacingDsMm);
      const baseY = s.ippMm.y + s.colDir.y * (r * s.rowSpacingDsMm);
      const baseZ = s.ippMm.z + s.colDir.z * (r * s.rowSpacingDsMm);

      const rowBase = r * s.dsCols;

      for (let c = 0; c < s.dsCols; c++) {
        const index = rowBase + c;
        const obs = s.pixels[index];
        const observationWeight = acquiredObservationWeight(s, index);
        if (!(observationWeight > 0) || obs === undefined || !Number.isFinite(obs)) continue;

        const wx0 = baseX + s.rowDir.x * (c * s.colSpacingDsMm);
        const wy0 = baseY + s.rowDir.y * (c * s.colSpacingDsMm);
        const wz0 = baseZ + s.rowDir.z * (c * s.colSpacingDsMm);

        for (let k = 0; k < psf.count; k++) {
          const w = psf.weights[k] ?? 0;
          if (!(w > 0)) continue;

          const wx = wx0 + (psf.offsetsXMm[k] ?? 0);
          const wy = wy0 + (psf.offsetsYMm[k] ?? 0);
          const wz = wz0 + (psf.offsetsZMm[k] ?? 0);

          const vx = (wx - originMm.x) * invVox;
          const vy = (wy - originMm.y) * invVox;
          const vz = (wz - originMm.z) * invVox;

          if (!withinTrilinearSupport(dims, vx, vy, vz)) continue;

          splatTrilinearScaled(volume, weight, dims, vx, vy, vz, obs, w * observationWeight);
        }
      }
    }

    if (sIdx % 4 === 0) {
      hooks?.onProgress?.({
        current: sIdx,
        total: slices.length,
        message: `Splatting slices… ${sIdx + 1}/${slices.length}`,
      });
      await yieldToMain();
    }
  }

  const observedSupport = params.occupancy ?? (options.iterations > 0 ? new Uint8Array(nvox) : undefined);
  const supportedVoxelCount = normalizeVolumeInPlace(volume, weight, observedSupport);
  if (observedSupport) params.onObservedSupport?.(supportedVoxelCount);

  // Memory optimization: the `weight` buffer is only needed for the initial splat normalization.
  // After that, we can reuse it as the per-iteration `updateW` accumulator to avoid allocating
  // an additional full-size Float32Array.
  await refineVolumeInPlace({
    volume,
    slices,
    grid,
    options,
    hooks,
    occupancy: observedSupport,
    psfBySlice,
    scratch: { updateW: weight },
  });

  return volume;
}

export async function refineVolumeInPlace(params: {
  volume: Float32Array;
  slices: SvrReconstructionSlice[];
  grid: SvrReconstructionGrid;
  options: SvrReconstructionOptions;
  hooks?: SvrCoreHooks;
  /** Stable acquired-observation domain; unsupported voxels must remain exactly zero. */
  occupancy?: Uint8Array;
  psfBySlice?: SlicePsf[];
  /** Optional scratch buffers to reduce allocations / peak memory. */
  scratch?: {
    update?: Float32Array;
    updateW?: Float32Array;
  };
}): Promise<void> {
  const { volume, slices, grid, options, hooks, occupancy } = params;
  const { dims, originMm, voxelSizeMm } = grid;

  const yieldToMain = hooks?.yieldToMain ?? (async () => {});

  // Iterative refinement: forward-project → residual → backproject.
  const iterations = Math.max(0, Math.round(options.iterations));
  if (iterations <= 0) {
    // IMPORTANT: avoid allocating full-volume scratch buffers when we aren't refining.
    return;
  }

  const invVox = 1 / voxelSizeMm;

  const psfBySlice =
    params.psfBySlice ?? slices.map((s) => buildSlicePsf({ slice: s, voxelSizeMm, mode: options.psfMode }));

  const nvox = dims.nx * dims.ny * dims.nz;
  if (occupancy && occupancy.length !== nvox) {
    throw new Error('SVR occupancy map does not match reconstruction grid');
  }

  if (occupancy) {
    for (let i = 0; i < nvox; i++) {
      if (!occupancy[i]) volume[i] = 0;
    }
  }

  const stepSize = options.stepSize;
  const robustDelta = Number.isFinite(options.robustDelta) && options.robustDelta > 1e-12 ? options.robustDelta : 0.1;

  // Scratch reused for update accumulation and regularization.
  // Allow callers to provide/reuse buffers so peak memory doesn't scale as badly for large volumes.
  let update = params.scratch?.update;
  if (!update || update.length !== nvox) {
    update = new Float32Array(nvox);
  }

  let updateW = params.scratch?.updateW;
  if (!updateW || updateW.length !== nvox) {
    updateW = new Float32Array(nvox);
  }

  // Yield on a wall-clock budget rather than a fixed slice stride: with large slices an
  // 8-slice stride blocked the UI for hundreds of ms, while a fixed per-slice yield would
  // overpay on small volumes. ~16ms keeps the page at interactive frame cadence.
  const YIELD_BUDGET_MS = 16;
  let lastYieldMs = performance.now();
  const interpolatedObservation = new Float64Array(2);

  for (let iter = 0; iter < iterations; iter++) {
    assertNotAborted(hooks?.signal);

    update.fill(0);
    updateW.fill(0);

    for (let sIdx = 0; sIdx < slices.length; sIdx++) {
      assertNotAborted(hooks?.signal);
      const s = slices[sIdx];
      if (!s) continue;

      const psf = psfBySlice[sIdx];

      for (let r = 0; r < s.dsRows; r++) {
        const baseX = s.ippMm.x + s.colDir.x * (r * s.rowSpacingDsMm);
        const baseY = s.ippMm.y + s.colDir.y * (r * s.rowSpacingDsMm);
        const baseZ = s.ippMm.z + s.colDir.z * (r * s.rowSpacingDsMm);

        const rowBase = r * s.dsCols;

        for (let c = 0; c < s.dsCols; c++) {
          const index = rowBase + c;
          const obs = s.pixels[index];
          const observationWeight = acquiredObservationWeight(s, index);
          if (!(observationWeight > 0) || obs === undefined || !Number.isFinite(obs)) continue;

          const wx0 = baseX + s.rowDir.x * (c * s.colSpacingDsMm);
          const wy0 = baseY + s.rowDir.y * (c * s.colSpacingDsMm);
          const wz0 = baseZ + s.rowDir.z * (c * s.colSpacingDsMm);

          // Forward projection: integrate the volume along the slice normal.
          let pred = 0;
          let wUsed = 0;
          let vx = 0;
          let vy = 0;
          let vz = 0;

          for (let k = 0; k < psf.count; k++) {
            const w = psf.weights[k] ?? 0;
            if (!(w > 0)) continue;

            const wx = wx0 + (psf.offsetsXMm[k] ?? 0);
            const wy = wy0 + (psf.offsetsYMm[k] ?? 0);
            const wz = wz0 + (psf.offsetsZMm[k] ?? 0);

            vx = (wx - originMm.x) * invVox;
            vy = (wy - originMm.y) * invVox;
            vz = (wz - originMm.z) * invVox;

            if (!withinTrilinearSupport(dims, vx, vy, vz)) continue;

            let sampleSupport = 1;
            let sampledIntensity: number;
            if (occupancy) {
              sampleTrilinearWithSupport(volume, occupancy, dims, vx, vy, vz, interpolatedObservation);
              sampleSupport = interpolatedObservation[1]!;
              sampledIntensity = interpolatedObservation[0]!;
            } else {
              sampledIntensity = sampleTrilinear(volume, dims, vx, vy, vz);
            }
            if (!(sampleSupport > 1e-12)) continue;

            // Unsupported interpolation corners represent missing evidence,
            // never zero-intensity tissue. Renormalize the matched observation.
            pred += sampledIntensity * w;
            wUsed += w * sampleSupport;
          }

          if (!(wUsed > 1e-12)) continue;
          pred /= wUsed;

          const residual = obs - pred;
          const rW = robustResidualWeight(residual, options.robustLoss, robustDelta);
          if (!(rW > 0)) continue;

          // Backproject residual into volume using the same PSF weights.
          const scaleBase = (rW * observationWeight) / wUsed;

          // Thin native slices at or below the output resolution have one PSF
          // sample. Its accepted voxel coordinates already belong to the
          // matched forward projection, so do not recompute or retest them.
          if (psf.count === 1) {
            splatTrilinearScaled(update, updateW, dims, vx, vy, vz, residual, (psf.weights[0] ?? 0) * scaleBase);
            continue;
          }

          for (let k = 0; k < psf.count; k++) {
            const w = psf.weights[k] ?? 0;
            if (!(w > 0)) continue;

            const wx = wx0 + (psf.offsetsXMm[k] ?? 0);
            const wy = wy0 + (psf.offsetsYMm[k] ?? 0);
            const wz = wz0 + (psf.offsetsZMm[k] ?? 0);

            const vx = (wx - originMm.x) * invVox;
            const vy = (wy - originMm.y) * invVox;
            const vz = (wz - originMm.z) * invVox;

            if (!withinTrilinearSupport(dims, vx, vy, vz)) continue;

            const scale = w * scaleBase;
            splatTrilinearScaled(update, updateW, dims, vx, vy, vz, residual, scale);
          }
        }
      }

      if (performance.now() - lastYieldMs >= YIELD_BUDGET_MS) {
        await yieldToMain();
        lastYieldMs = performance.now();
      }
    }

    for (let i = 0; i < nvox; i++) {
      if (occupancy && !occupancy[i]) {
        volume[i] = 0;
        continue;
      }
      const w = updateW[i];
      if (w > 1e-12) {
        volume[i] = (volume[i] ?? 0) + ((update[i] ?? 0) / w) * stepSize;
      }

      if (options.clampOutput) {
        volume[i] = clamp01(volume[i] ?? 0);
      }
    }

    // Light regularization to suppress noise without erasing edges.
    if (options.laplacianWeight > 0) {
      update.fill(0);
      laplacianSmoothInPlace(volume, dims, options.laplacianWeight, update, occupancy);
      if (options.clampOutput) {
        for (let i = 0; i < nvox; i++) {
          volume[i] = clamp01(volume[i] ?? 0);
        }
      }
    }

    hooks?.onProgress?.({
      current: iter + 1,
      total: iterations,
      message: `Refining volume… iteration ${iter + 1}/${iterations}`,
    });

    await yieldToMain();
  }
}

export async function resampleVolumeToGridTrilinear(params: {
  src: Float32Array;
  /** Canonical acquired support for the source lattice; unsupported zeros are not anatomy. */
  srcOccupancy?: Uint8Array;
  srcGrid: SvrReconstructionGrid;
  dstGrid: SvrReconstructionGrid;
  hooks?: SvrCoreHooks;
}): Promise<Float32Array> {
  const { src, srcOccupancy, srcGrid, dstGrid, hooks } = params;
  const { dims: sDims, originMm: sOrigin, voxelSizeMm: sVox } = srcGrid;
  const { dims: dDims, originMm: dOrigin, voxelSizeMm: dVox } = dstGrid;

  if (srcOccupancy && srcOccupancy.length !== src.length) {
    throw new Error('SVR acquired support does not match its source volume');
  }

  const yieldToMain = hooks?.yieldToMain ?? (async () => {});

  const out = new Float32Array(dDims.nx * dDims.ny * dDims.nz);

  const invSrcVox = 1 / sVox;

  const strideY = dDims.nx;
  const strideZ = dDims.nx * dDims.ny;
  const interpolatedObservation = new Float64Array(2);

  for (let z = 0; z < dDims.nz; z++) {
    assertNotAborted(hooks?.signal);
    const wz = dOrigin.z + z * dVox;

    for (let y = 0; y < dDims.ny; y++) {
      const wy = dOrigin.y + y * dVox;

      const base = z * strideZ + y * strideY;

      for (let x = 0; x < dDims.nx; x++) {
        const wx = dOrigin.x + x * dVox;

        const sx = (wx - sOrigin.x) * invSrcVox;
        const sy = (wy - sOrigin.y) * invSrcVox;
        const sz = (wz - sOrigin.z) * invSrcVox;

        if (!withinTrilinearSupport(sDims, sx, sy, sz)) continue;
        let support = 1;
        let sampledIntensity: number;
        if (srcOccupancy) {
          sampleTrilinearWithSupport(src, srcOccupancy, sDims, sx, sy, sz, interpolatedObservation);
          support = interpolatedObservation[1]!;
          sampledIntensity = interpolatedObservation[0]!;
        } else {
          sampledIntensity = sampleTrilinear(src, sDims, sx, sy, sz);
        }
        if (support > 1e-12) {
          out[base + x] = sampledIntensity / support;
        }
      }
    }

    if (z % 4 === 0) {
      await yieldToMain();
    }
  }

  return out;
}
