import { sampleTrilinear, type VolumeDims as TrilinearDims } from './trilinear';
import { formatMiB } from './svrUtils';
import { clamp } from '../math';

export type RenderTextureMode = 'auto' | 'u8';
export type RenderQualityPreset = 'auto' | 'full' | '512' | '384' | '256' | '192' | '128';

export type RenderDims = { nx: number; ny: number; nz: number };

export type RenderPlan = {
  dims: RenderDims;
  kind: 'f32' | 'u8';
  scale: number;
  estGpuVolBytes: number;
  estGpuLabelBytes: number;
  estGpuTotalBytes: number;
  note: string;
};

export type RenderVolumeTexData = {
  kind: 'f32' | 'u8';
  dims: RenderDims;
  data: Float32Array | Uint8Array;
};

/**
 * Map a normalized [0,1] float volume into uint8 [0,255].
 *
 * NOTE: This matches the shader's expectation that intensities are in 0..1.
 */
export function toUint8Volume(data: Float32Array): Uint8Array {
  const out = new Uint8Array(data.length);
  for (let i = 0; i < data.length; i++) {
    const v = data[i] ?? 0;
    out[i] = Math.round(clamp(v, 0, 1) * 255);
  }
  return out;
}

function computeScaledDims(params: { src: RenderDims; maxDim: number }): { dims: RenderDims; scale: number } {
  const { src } = params;
  const srcMax = Math.max(1, src.nx, src.ny, src.nz);

  const targetMax = Math.max(2, Math.round(params.maxDim));
  const scale = srcMax > targetMax ? targetMax / srcMax : 1;

  const nx = Math.max(2, Math.round(src.nx * scale));
  const ny = Math.max(2, Math.round(src.ny * scale));
  const nz = Math.max(2, Math.round(src.nz * scale));

  return { dims: { nx, ny, nz }, scale };
}

export function computeRenderPlan(params: {
  srcDims: RenderDims;
  labelsEnabled: boolean;
  hasLabels: boolean;
  budgetMiB: number;
  quality: RenderQualityPreset;
  textureMode: RenderTextureMode;
}): RenderPlan {
  const { srcDims, labelsEnabled, hasLabels, quality, textureMode } = params;

  const budgetMiB = clamp(params.budgetMiB, 64, 4096);
  const budgetBytes = budgetMiB * 1024 * 1024;

  const srcMax = Math.max(1, srcDims.nx, srcDims.ny, srcDims.nz);

  const requestedMax =
    quality === 'auto'
      ? Math.min(srcMax, 512)
      : quality === 'full'
        ? srcMax
        : Math.min(srcMax, Math.max(2, Math.round(Number(quality))));

  // Candidate max dims (descending). We try to keep high quality while fitting the GPU budget.
  // NOTE: allow >512 when explicitly requested and budget permits.
  const ladder = [requestedMax, 1024, 768, 512, 384, 256, 192, 128];
  const candidates = Array.from(new Set(ladder.filter((d) => Number.isFinite(d) && d >= 2 && d <= requestedMax))).sort(
    (a, b) => b - a,
  );

  const wantsLabelsTex = labelsEnabled && hasLabels;

  const estimate = (maxDim: number) => {
    const { dims, scale } = computeScaledDims({ src: srcDims, maxDim });
    const nvox = dims.nx * dims.ny * dims.nz;
    const labelBytes = wantsLabelsTex ? nvox : 0;

    // WebGL2 texture byte accounting:
    // - the 'f32' plan (Float32Array on the CPU side) uploads as R16F -> 2 bytes/voxel
    //   (see chooseVolumeTextureFormat: half-float halves bandwidth and is filterable
    //   in core WebGL2, so the GPU never holds 4-byte voxels)
    // - u8 volume uses R8 -> 1 byte/voxel
    // - labels use R8UI -> 1 byte/voxel
    const f32Bytes = 2 * nvox;
    const u8Bytes = 1 * nvox;

    return {
      dims,
      scale,
      estGpuVolBytesF32: f32Bytes,
      estGpuVolBytesU8: u8Bytes,
      estGpuLabelBytes: labelBytes,
      f32Total: f32Bytes + labelBytes,
      u8Total: u8Bytes + labelBytes,
    };
  };

  // Choose the highest-res candidate that fits, preferring float unless forced to u8.
  let chosen = estimate(candidates[0] ?? requestedMax);
  let chosenKind: 'f32' | 'u8' = textureMode === 'u8' ? 'u8' : 'f32';

  if (textureMode === 'u8') {
    for (const c of candidates) {
      const e = estimate(c);
      if (e.u8Total <= budgetBytes) {
        chosen = e;
        break;
      }
    }
    chosenKind = 'u8';
  } else {
    for (const c of candidates) {
      const e = estimate(c);
      if (e.f32Total <= budgetBytes) {
        chosen = e;
        chosenKind = 'f32';
        break;
      }
      if (e.u8Total <= budgetBytes) {
        chosen = e;
        chosenKind = 'u8';
        break;
      }
    }

    // If nothing fits (should be rare), fall back to smallest candidate as u8.
    if (chosenKind === 'f32' && chosen.f32Total > budgetBytes && chosen.u8Total > budgetBytes) {
      const smallest = candidates[candidates.length - 1] ?? Math.min(requestedMax, 128);
      chosen = estimate(smallest);
      chosenKind = 'u8';
    }
  }

  const estGpuVolBytes = chosenKind === 'f32' ? chosen.estGpuVolBytesF32 : chosen.estGpuVolBytesU8;
  const estGpuLabelBytes = wantsLabelsTex ? chosen.estGpuLabelBytes : 0;
  const estGpuTotalBytes = estGpuVolBytes + estGpuLabelBytes;

  const fullRes = chosen.dims.nx === srcDims.nx && chosen.dims.ny === srcDims.ny && chosen.dims.nz === srcDims.nz;

  let note = '';
  if (quality === 'auto') {
    note = `Auto LOD (budget ~${formatMiB(budgetBytes)})`;
  } else if (quality === 'full') {
    note = fullRes ? `Full-res (budget ~${formatMiB(budgetBytes)})` : `Downsampled (budget ~${formatMiB(budgetBytes)})`;
  } else {
    note = `MaxDim ≤ ${quality} (budget ~${formatMiB(budgetBytes)})`;
  }

  return {
    dims: chosen.dims,
    kind: chosenKind,
    scale: chosen.scale,
    estGpuVolBytes,
    estGpuLabelBytes,
    estGpuTotalBytes,
    note,
  };
}

/**
 * Resample a source Float32 volume (0..1) into a smaller grid for GPU upload.
 *
 * This uses our trilinear sampler (same convention as SVR): the last voxel layer is treated as padding,
 * so we only sample < (dim - 1) to stay within support.
 */
async function resampleVolumeTrilinearF32(params: {
  src: Float32Array;
  srcDims: TrilinearDims;
  dstDims: TrilinearDims;
  /** Returns true if the caller has requested cancellation. Checked per Z-slice. */
  isCancelled: () => boolean;
}): Promise<Float32Array> {
  const { src, srcDims, dstDims, isCancelled } = params;
  const out = new Float32Array(dstDims.nx * dstDims.ny * dstDims.nz);

  // Trilinear support requires x < (dim - 1). Use a small epsilon so our dst max maps inside support.
  const EPS = 1e-6;
  const srcMaxX = Math.max(0, srcDims.nx - 1 - EPS);
  const srcMaxY = Math.max(0, srcDims.ny - 1 - EPS);
  const srcMaxZ = Math.max(0, srcDims.nz - 1 - EPS);

  const scaleX = dstDims.nx > 1 ? srcMaxX / (dstDims.nx - 1) : 0;
  const scaleY = dstDims.ny > 1 ? srcMaxY / (dstDims.ny - 1) : 0;
  const scaleZ = dstDims.nz > 1 ? srcMaxZ / (dstDims.nz - 1) : 0;

  const strideY = dstDims.nx;
  const strideZ = dstDims.nx * dstDims.ny;

  for (let z = 0; z < dstDims.nz; z++) {
    if (isCancelled()) {
      throw new Error('Render volume build cancelled');
    }

    const sz = z * scaleZ;

    for (let y = 0; y < dstDims.ny; y++) {
      const sy = y * scaleY;
      const base = z * strideZ + y * strideY;

      for (let x = 0; x < dstDims.nx; x++) {
        const sx = x * scaleX;
        out[base + x] = clamp(sampleTrilinear(src, srcDims, sx, sy, sz), 0, 1);
      }
    }

    if (z % 4 === 0) {
      await new Promise((r) => setTimeout(r, 0));
    }
  }

  return out;
}

async function resampleVolumeTrilinearU8(params: {
  src: Float32Array;
  srcDims: TrilinearDims;
  dstDims: TrilinearDims;
  isCancelled: () => boolean;
}): Promise<Uint8Array> {
  const { src, srcDims, dstDims, isCancelled } = params;
  const out = new Uint8Array(dstDims.nx * dstDims.ny * dstDims.nz);

  const EPS = 1e-6;
  const srcMaxX = Math.max(0, srcDims.nx - 1 - EPS);
  const srcMaxY = Math.max(0, srcDims.ny - 1 - EPS);
  const srcMaxZ = Math.max(0, srcDims.nz - 1 - EPS);

  const scaleX = dstDims.nx > 1 ? srcMaxX / (dstDims.nx - 1) : 0;
  const scaleY = dstDims.ny > 1 ? srcMaxY / (dstDims.ny - 1) : 0;
  const scaleZ = dstDims.nz > 1 ? srcMaxZ / (dstDims.nz - 1) : 0;

  const strideY = dstDims.nx;
  const strideZ = dstDims.nx * dstDims.ny;

  for (let z = 0; z < dstDims.nz; z++) {
    if (isCancelled()) {
      throw new Error('Render volume build cancelled');
    }

    const sz = z * scaleZ;

    for (let y = 0; y < dstDims.ny; y++) {
      const sy = y * scaleY;
      const base = z * strideZ + y * strideY;

      for (let x = 0; x < dstDims.nx; x++) {
        const sx = x * scaleX;
        const v = clamp(sampleTrilinear(src, srcDims, sx, sy, sz), 0, 1);
        out[base + x] = Math.round(v * 255);
      }
    }

    if (z % 4 === 0) {
      await new Promise((r) => setTimeout(r, 0));
    }
  }

  return out;
}

export async function buildRenderVolumeTexData(params: {
  src: Float32Array;
  srcDims: RenderDims;
  plan: Pick<RenderPlan, 'dims' | 'kind'>;
  isCancelled: () => boolean;
}): Promise<RenderVolumeTexData> {
  const { src, srcDims, plan, isCancelled } = params;

  const dstDims = plan.dims;

  const isSameDims = srcDims.nx === dstDims.nx && srcDims.ny === dstDims.ny && srcDims.nz === dstDims.nz;

  if (plan.kind === 'f32') {
    const data = isSameDims
      ? src
      : await resampleVolumeTrilinearF32({
          src,
          srcDims,
          dstDims,
          isCancelled,
        });

    return { kind: 'f32', dims: dstDims, data };
  }

  // u8
  const data = isSameDims
    ? toUint8Volume(src)
    : await resampleVolumeTrilinearU8({
        src,
        srcDims,
        dstDims,
        isCancelled,
      });

  return { kind: 'u8', dims: dstDims, data };
}

export type RegionBox = { min: { x: number; y: number; z: number }; max: { x: number; y: number; z: number } };

/**
 * Incrementally refresh a nearest-neighbor label downsample for a dirty source region.
 *
 * Interactive segmentation (grow previews, brush edits) changes a small set of voxels per
 * tick, but the GPU label texture is a downsampled copy of the full volume — recomputing
 * the whole downsample per tick is what made large-volume previews stall. This recomputes
 * only the destination voxels whose nearest-neighbor source falls inside the dirty box,
 * writing into the persistent `dst` cache, and returns that destination box so the caller
 * can sub-upload exactly those texels.
 *
 * IMPORTANT: the sampling formula must stay identical to `downsampleLabelsNearest` or the
 * cache would drift from what a full rebuild produces.
 */
export function updateLabelsNearestRegion(params: {
  src: Uint8Array;
  srcDims: RenderDims;
  dst: Uint8Array;
  dstDims: RenderDims;
  srcBox: RegionBox;
}): RegionBox | null {
  const { src, srcDims, dst, dstDims, srcBox } = params;

  // Invert the dst->src nearest mapping (sx = round(dx * k), k = (srcN-1)/(dstN-1)) to a
  // conservative dst range per axis: every dst index whose rounded source can land inside
  // [s0, s1]. The ±0.5 accounts for round()'s half-open buckets; clamping handles edges.
  const mapAxisToDstRange = (s0: number, s1: number, srcN: number, dstN: number): [number, number] => {
    if (dstN <= 1 || srcN <= 1) return [0, dstN - 1];
    const k = (srcN - 1) / (dstN - 1);
    if (!(k > 0)) return [0, dstN - 1];
    const d0 = Math.max(0, Math.floor((s0 - 0.5) / k));
    const d1 = Math.min(dstN - 1, Math.ceil((s1 + 0.5) / k));
    return [d0, d1];
  };

  const [dx0, dx1] = mapAxisToDstRange(srcBox.min.x, srcBox.max.x, srcDims.nx, dstDims.nx);
  const [dy0, dy1] = mapAxisToDstRange(srcBox.min.y, srcBox.max.y, srcDims.ny, dstDims.ny);
  const [dz0, dz1] = mapAxisToDstRange(srcBox.min.z, srcBox.max.z, srcDims.nz, dstDims.nz);

  if (dx1 < dx0 || dy1 < dy0 || dz1 < dz0) return null;

  const srcStrideY = srcDims.nx;
  const srcStrideZ = srcDims.nx * srcDims.ny;

  const dstStrideY = dstDims.nx;
  const dstStrideZ = dstDims.nx * dstDims.ny;

  for (let z = dz0; z <= dz1; z++) {
    // Same nearest formula as downsampleLabelsNearest (see note above).
    const sz = dstDims.nz > 1 ? Math.round((z / (dstDims.nz - 1)) * Math.max(0, srcDims.nz - 1)) : 0;

    for (let y = dy0; y <= dy1; y++) {
      const sy = dstDims.ny > 1 ? Math.round((y / (dstDims.ny - 1)) * Math.max(0, srcDims.ny - 1)) : 0;

      const srcBase = sz * srcStrideZ + sy * srcStrideY;
      const dstBase = z * dstStrideZ + y * dstStrideY;

      for (let x = dx0; x <= dx1; x++) {
        const sx = dstDims.nx > 1 ? Math.round((x / (dstDims.nx - 1)) * Math.max(0, srcDims.nx - 1)) : 0;
        dst[dstBase + x] = src[srcBase + sx] ?? 0;
      }
    }
  }

  return { min: { x: dx0, y: dy0, z: dz0 }, max: { x: dx1, y: dy1, z: dz1 } };
}

export function downsampleLabelsNearest(params: {
  src: Uint8Array;
  srcDims: RenderDims;
  dstDims: RenderDims;
}): Uint8Array {
  const { src, srcDims, dstDims } = params;

  const out = new Uint8Array(dstDims.nx * dstDims.ny * dstDims.nz);

  const srcStrideY = srcDims.nx;
  const srcStrideZ = srcDims.nx * srcDims.ny;

  const dstStrideY = dstDims.nx;
  const dstStrideZ = dstDims.nx * dstDims.ny;

  for (let z = 0; z < dstDims.nz; z++) {
    const sz = dstDims.nz > 1 ? Math.round((z / (dstDims.nz - 1)) * Math.max(0, srcDims.nz - 1)) : 0;

    for (let y = 0; y < dstDims.ny; y++) {
      const sy = dstDims.ny > 1 ? Math.round((y / (dstDims.ny - 1)) * Math.max(0, srcDims.ny - 1)) : 0;

      const srcBase = sz * srcStrideZ + sy * srcStrideY;
      const dstBase = z * dstStrideZ + y * dstStrideY;

      for (let x = 0; x < dstDims.nx; x++) {
        const sx = dstDims.nx > 1 ? Math.round((x / (dstDims.nx - 1)) * Math.max(0, srcDims.nx - 1)) : 0;
        out[dstBase + x] = src[srcBase + sx] ?? 0;
      }
    }
  }

  return out;
}
