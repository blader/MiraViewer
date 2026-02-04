import type { VolumeDims } from './trilinear';
import { sampleTrilinear, splatTrilinearScaled } from './trilinear';
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
};

export type SvrCoreHooks = {
  signal?: AbortSignal;
  yieldToMain?: () => Promise<void>;
  onProgress?: (p: { current: number; total: number; message: string }) => void;
};

type SlicePsf = { offsetsMm: Float32Array; weights: Float32Array; count: number; effectiveThicknessMm: number };

function buildSlicePsf(params: { slice: SvrReconstructionSlice; voxelSizeMm: number; mode: SvrPsfMode }): SlicePsf {
  const { slice, voxelSizeMm, mode } = params;

  if (mode === 'none') {
    return {
      offsetsMm: new Float32Array([0]),
      weights: new Float32Array([1]),
      count: 1,
      effectiveThicknessMm: 0,
    };
  }

  const hint = slice.sliceThicknessMm ?? slice.spacingBetweenSlicesMm;
  const thicknessMm = typeof hint === 'number' && Number.isFinite(hint) && hint > 0 ? hint : voxelSizeMm;

  const ratio = thicknessMm / Math.max(1e-6, voxelSizeMm);

  // Keep the forward model cheap: a handful of samples along the slice normal.
  // Use an odd count so the kernel is symmetric around offset=0.
  let n = Math.round(ratio);
  if (n < 1) n = 1;
  if (n > 7) n = 7;
  if (n % 2 === 0) n += 1;

  const offsetsMm = new Float32Array(n);
  const weights = new Float32Array(n);

  const half = 0.5 * thicknessMm;
  const step = thicknessMm / n;

  // Gaussian: distance-to-plane weighting within the thickness support.
  // We pick sigma so that the tails are non-trivial within [-half, +half].
  const sigma = Math.max(1e-6, half * 0.5);

  let wSum = 0;
  for (let i = 0; i < n; i++) {
    const off = -half + (i + 0.5) * step;
    offsetsMm[i] = off;

    let w = 1;
    if (mode === 'gaussian') {
      const u = off / sigma;
      w = Math.exp(-0.5 * u * u);
    }

    weights[i] = w;
    wSum += w;
  }

  if (wSum > 1e-12) {
    const inv = 1 / wSum;
    for (let i = 0; i < n; i++) {
      weights[i] *= inv;
    }
  }

  return { offsetsMm, weights, count: n, effectiveThicknessMm: thicknessMm };
}

function robustResidualWeight(residual: number, mode: SvrRobustLoss, delta: number): number {
  if (mode === 'none') return 1;

  const a = Math.abs(residual);
  const d = Number.isFinite(delta) && delta > 1e-12 ? delta : 0.1;

  if (mode === 'huber') {
    return a <= d ? 1 : d / a;
  }

  // Tukey's biweight.
  if (a >= d) return 0;
  const r = a / d;
  const t = 1 - r * r;
  return t * t;
}

function normalizeVolumeInPlace(volume: Float32Array, weight: Float32Array): void {
  for (let i = 0; i < volume.length; i++) {
    const w = weight[i];
    volume[i] = w > 1e-12 ? volume[i] / w : 0;
  }
}

function laplacianSmoothInPlace(volume: Float32Array, dims: VolumeDims, lambda: number, scratch: Float32Array): void {
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
        const c = volume[idx] ?? 0;

        const sum =
          (volume[idx - 1] ?? 0) +
          (volume[idx + 1] ?? 0) +
          (volume[idx - strideY] ?? 0) +
          (volume[idx + strideY] ?? 0) +
          (volume[idx - strideZ] ?? 0) +
          (volume[idx + strideZ] ?? 0);

        scratch[idx] = sum - 6 * c;
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
}): Promise<Float32Array> {
  const { slices, grid, options, hooks } = params;
  const { dims, originMm, voxelSizeMm } = grid;

  const yieldToMain = hooks?.yieldToMain ?? (async () => {});

  const nvox = dims.nx * dims.ny * dims.nz;
  const volume = new Float32Array(nvox);
  const weight = new Float32Array(nvox);

  const psfBySlice = slices.map((s) => buildSlicePsf({ slice: s, voxelSizeMm, mode: options.psfMode }));

  // 1) Initial splat (backprojection of observations).
  const invVox = 1 / voxelSizeMm;

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
        const obs = s.pixels[rowBase + c] ?? 0;
        if (obs <= 0) continue;

        const wx0 = baseX + s.rowDir.x * (c * s.colSpacingDsMm);
        const wy0 = baseY + s.rowDir.y * (c * s.colSpacingDsMm);
        const wz0 = baseZ + s.rowDir.z * (c * s.colSpacingDsMm);

        for (let k = 0; k < psf.count; k++) {
          const off = psf.offsetsMm[k] ?? 0;
          const w = psf.weights[k] ?? 0;
          if (!(w > 0)) continue;

          const wx = wx0 + s.normalDir.x * off;
          const wy = wy0 + s.normalDir.y * off;
          const wz = wz0 + s.normalDir.z * off;

          const vx = (wx - originMm.x) * invVox;
          const vy = (wy - originMm.y) * invVox;
          const vz = (wz - originMm.z) * invVox;

          if (!withinTrilinearSupport(dims, vx, vy, vz)) continue;

          splatTrilinearScaled(volume, weight, dims, vx, vy, vz, obs, w);
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

  normalizeVolumeInPlace(volume, weight);

  // Memory optimization: the `weight` buffer is only needed for the initial splat normalization.
  // After that, we can reuse it as the per-iteration `updateW` accumulator to avoid allocating
  // an additional full-size Float32Array.
  await refineVolumeInPlace({ volume, slices, grid, options, hooks, psfBySlice, scratch: { updateW: weight } });

  return volume;
}

export async function refineVolumeInPlace(params: {
  volume: Float32Array;
  slices: SvrReconstructionSlice[];
  grid: SvrReconstructionGrid;
  options: SvrReconstructionOptions;
  hooks?: SvrCoreHooks;
  psfBySlice?: SlicePsf[];
  /** Optional scratch buffers to reduce allocations / peak memory. */
  scratch?: {
    update?: Float32Array;
    updateW?: Float32Array;
  };
}): Promise<void> {
  const { volume, slices, grid, options, hooks } = params;
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

  const stepSize = options.stepSize;

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
          const obs = s.pixels[rowBase + c] ?? 0;
          if (obs <= 0) continue;

          const wx0 = baseX + s.rowDir.x * (c * s.colSpacingDsMm);
          const wy0 = baseY + s.rowDir.y * (c * s.colSpacingDsMm);
          const wz0 = baseZ + s.rowDir.z * (c * s.colSpacingDsMm);

          // Forward projection: integrate the volume along the slice normal.
          let pred = 0;
          let wUsed = 0;

          for (let k = 0; k < psf.count; k++) {
            const off = psf.offsetsMm[k] ?? 0;
            const w = psf.weights[k] ?? 0;
            if (!(w > 0)) continue;

            const wx = wx0 + s.normalDir.x * off;
            const wy = wy0 + s.normalDir.y * off;
            const wz = wz0 + s.normalDir.z * off;

            const vx = (wx - originMm.x) * invVox;
            const vy = (wy - originMm.y) * invVox;
            const vz = (wz - originMm.z) * invVox;

            if (!withinTrilinearSupport(dims, vx, vy, vz)) continue;

            pred += sampleTrilinear(volume, dims, vx, vy, vz) * w;
            wUsed += w;
          }

          if (!(wUsed > 1e-12)) continue;
          pred /= wUsed;

          const residual = obs - pred;
          const rW = robustResidualWeight(residual, options.robustLoss, options.robustDelta);
          if (!(rW > 0)) continue;

          // Backproject residual into volume using the same PSF weights.
          const scaleBase = rW / wUsed;

          for (let k = 0; k < psf.count; k++) {
            const off = psf.offsetsMm[k] ?? 0;
            const w = psf.weights[k] ?? 0;
            if (!(w > 0)) continue;

            const wx = wx0 + s.normalDir.x * off;
            const wy = wy0 + s.normalDir.y * off;
            const wz = wz0 + s.normalDir.z * off;

            const vx = (wx - originMm.x) * invVox;
            const vy = (wy - originMm.y) * invVox;
            const vz = (wz - originMm.z) * invVox;

            if (!withinTrilinearSupport(dims, vx, vy, vz)) continue;

            const scale = w * scaleBase;
            splatTrilinearScaled(update, updateW, dims, vx, vy, vz, residual, scale);
          }
        }
      }

      if (sIdx % 8 === 0) {
        await yieldToMain();
      }
    }

    for (let i = 0; i < nvox; i++) {
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
      laplacianSmoothInPlace(volume, dims, options.laplacianWeight, update);
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
  srcGrid: SvrReconstructionGrid;
  dstGrid: SvrReconstructionGrid;
  hooks?: SvrCoreHooks;
}): Promise<Float32Array> {
  const { src, srcGrid, dstGrid, hooks } = params;
  const { dims: sDims, originMm: sOrigin, voxelSizeMm: sVox } = srcGrid;
  const { dims: dDims, originMm: dOrigin, voxelSizeMm: dVox } = dstGrid;

  const yieldToMain = hooks?.yieldToMain ?? (async () => {});

  const out = new Float32Array(dDims.nx * dDims.ny * dDims.nz);

  const invSrcVox = 1 / sVox;

  const strideY = dDims.nx;
  const strideZ = dDims.nx * dDims.ny;

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

        out[base + x] = withinTrilinearSupport(sDims, sx, sy, sz) ? sampleTrilinear(src, sDims, sx, sy, sz) : 0;
      }
    }

    if (z % 4 === 0) {
      await yieldToMain();
    }
  }

  return out;
}
