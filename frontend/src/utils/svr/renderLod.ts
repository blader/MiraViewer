import { formatMiB, yieldToMain } from './svrUtils';
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
  estGpuSupportBytes: number;
  estGpuTotalBytes: number;
  note: string;
};

export type RenderVolumeTexData = {
  kind: 'f32' | 'u8';
  dims: RenderDims;
  data: Float32Array | Uint8Array;
  /** A render voxel is observable only when its footprint contains acquired support. */
  observedSupport?: Uint8Array;
};

/** Normalize physical extents, never raw voxel counts, into the raymarch box. */
export function computePhysicalBoxScale(
  dims: RenderDims,
  voxelSizeMm: readonly [number, number, number],
): readonly [number, number, number] {
  const sizeX = dims.nx * Math.max(Number.EPSILON, Math.abs(voxelSizeMm[0]));
  const sizeY = dims.ny * Math.max(Number.EPSILON, Math.abs(voxelSizeMm[1]));
  const sizeZ = dims.nz * Math.max(Number.EPSILON, Math.abs(voxelSizeMm[2]));
  const maxExtent = Math.max(sizeX, sizeY, sizeZ);
  return [sizeX / maxExtent, sizeY / maxExtent, sizeZ / maxExtent];
}

/**
 * Map a normalized [0,1] float volume into uint8 [0,255].
 *
 * NOTE: This matches the shader's expectation that intensities are in 0..1.
 */
export function toUint8Volume(data: Float32Array, observedSupport?: Uint8Array): Uint8Array {
  const out = new Uint8Array(data.length);
  for (let i = 0; i < data.length; i++) {
    if (observedSupport && !observedSupport[i]) continue;
    const v = data[i] ?? 0;
    out[i] = Math.round(clamp(v, 0, 1) * 255);
  }
  return out;
}

function computeScaledDims(params: { src: RenderDims; maxDim: number }): { dims: RenderDims; scale: number } {
  const { src } = params;
  const srcMax = Math.max(1, src.nx, src.ny, src.nz);

  const targetMax = Math.max(1, Math.round(params.maxDim));
  const scale = srcMax > targetMax ? targetMax / srcMax : 1;

  const nx = Math.max(1, Math.round(src.nx * scale));
  const ny = Math.max(1, Math.round(src.ny * scale));
  const nz = Math.max(1, Math.round(src.nz * scale));

  return { dims: { nx, ny, nz }, scale };
}

export function computeRenderPlan(params: {
  srcDims: RenderDims;
  labelsEnabled: boolean;
  hasLabels: boolean;
  budgetMiB: number;
  quality: RenderQualityPreset;
  textureMode: RenderTextureMode;
  /** Reserve the eventual label texture so adding a label cannot rebuild the volume. */
  reserveLabelTexture?: boolean;
  /** Acquired support is an independent nearest-filtered R8 texture. */
  hasObservedSupport?: boolean;
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

  const wantsLabelsTex = labelsEnabled && (hasLabels || params.reserveLabelTexture === true);

  const estimate = (maxDim: number) => {
    const { dims, scale } = computeScaledDims({ src: srcDims, maxDim });
    const nvox = dims.nx * dims.ny * dims.nz;
    const labelBytes = wantsLabelsTex ? nvox : 0;
    const supportBytes = params.hasObservedSupport ? nvox : 0;

    // WebGL2 texture byte accounting:
    // - the 'f32' plan (Float32Array on the CPU side) uploads as R16F -> 2 bytes/voxel
    //   (see chooseVolumeTextureFormat: half-float halves bandwidth and is filterable
    //   in core WebGL2, so the GPU never holds 4-byte voxels)
    // - u8 volume uses R8 -> 1 byte/voxel
    // - labels use R8UI -> 1 byte/voxel
    // - acquired support uses independent nearest-filtered R8 -> 1 byte/voxel
    const f32Bytes = 2 * nvox;
    const u8Bytes = 1 * nvox;

    return {
      dims,
      scale,
      estGpuVolBytesF32: f32Bytes,
      estGpuVolBytesU8: u8Bytes,
      estGpuLabelBytes: labelBytes,
      estGpuSupportBytes: supportBytes,
      f32Total: f32Bytes + labelBytes + supportBytes,
      u8Total: u8Bytes + labelBytes + supportBytes,
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
  const estGpuSupportBytes = chosen.estGpuSupportBytes;
  const estGpuTotalBytes = estGpuVolBytes + estGpuLabelBytes + estGpuSupportBytes;

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
    estGpuSupportBytes,
    estGpuTotalBytes,
    note,
  };
}

type AxisFootprint = { start: number; weights: Float32Array };

function buildAxisFootprints(srcSize: number, dstSize: number): AxisFootprint[] {
  const footprints: AxisFootprint[] = [];
  const scale = srcSize / dstSize;

  for (let index = 0; index < dstSize; index++) {
    const from = index * scale;
    const to = Math.min(srcSize, (index + 1) * scale);
    const start = Math.max(0, Math.floor(from));
    const end = Math.min(srcSize - 1, Math.ceil(to) - 1);
    const weights = new Float32Array(end - start + 1);

    for (let source = start; source <= end; source++) {
      weights[source - start] = Math.max(0, Math.min(to, source + 1) - Math.max(from, source));
    }

    footprints.push({ start, weights });
  }

  return footprints;
}

/** Integrate each destination footprint instead of point-sampling aliased anatomy. */
async function resampleVolumeAreaAverage(params: {
  src: Float32Array;
  intensityRange?: readonly [number, number];
  invert?: boolean;
  srcObservedSupport?: Uint8Array;
  srcDims: RenderDims;
  dstDims: RenderDims;
  kind: 'f32' | 'u8';
  isCancelled: () => boolean;
}): Promise<RenderVolumeTexData> {
  const { src, srcObservedSupport, srcDims, dstDims, kind, isCancelled } = params;
  const [intensityLow, intensityHigh] = params.intensityRange ?? [0, 1];
  const inverseRange = 1 / Math.max(Number.EPSILON, intensityHigh - intensityLow);
  const length = dstDims.nx * dstDims.ny * dstDims.nz;
  const out = kind === 'f32' ? new Float32Array(length) : new Uint8Array(length);
  const observedSupport = srcObservedSupport ? new Uint8Array(length) : undefined;
  const footprintsX = buildAxisFootprints(srcDims.nx, dstDims.nx);
  const footprintsY = buildAxisFootprints(srcDims.ny, dstDims.ny);
  const footprintsZ = buildAxisFootprints(srcDims.nz, dstDims.nz);
  const srcStrideZ = srcDims.nx * srcDims.ny;
  const dstStrideZ = dstDims.nx * dstDims.ny;
  // Separable X/Y/Z integration preserves the exact rectangular footprint
  // while replacing O(dst * footprintX * footprintY * footprintZ) work with
  // three linear passes over each source slab. The two optional support
  // accumulators keep invalid anatomy out of both numerator and denominator.
  const xValues = new Float32Array(dstDims.nx * srcDims.ny);
  const xSupport = srcObservedSupport ? new Float32Array(xValues.length) : undefined;
  const planeValues = kind === 'u8' ? new Float32Array(dstStrideZ) : undefined;
  const planeSupport = srcObservedSupport ? new Float32Array(dstStrideZ) : undefined;
  const fullFootprintWeight = (srcDims.nx / dstDims.nx) * (srcDims.ny / dstDims.ny) * (srcDims.nz / dstDims.nz);
  let cachedSourceZ = -1;
  let lastYield = performance.now();

  for (let z = 0; z < dstDims.nz; z++) {
    if (isCancelled()) throw new Error('Render volume build cancelled');
    const footprintZ = footprintsZ[z]!;
    const destination = planeValues ?? (out as Float32Array).subarray(z * dstStrideZ, (z + 1) * dstStrideZ);
    destination.fill(0);
    planeSupport?.fill(0);

    for (let iz = 0; iz < footprintZ.weights.length; iz++) {
      const sourceZ = footprintZ.start + iz;
      const zWeight = footprintZ.weights[iz]!;

      if (sourceZ !== cachedSourceZ) {
        if (srcDims.nx === dstDims.nx && !srcObservedSupport) {
          xValues.set(src.subarray(sourceZ * srcStrideZ, (sourceZ + 1) * srcStrideZ));
        } else {
          for (let sourceY = 0; sourceY < srcDims.ny; sourceY++) {
            const sourceBase = sourceZ * srcStrideZ + sourceY * srcDims.nx;
            const xBase = sourceY * dstDims.nx;

            for (let x = 0; x < dstDims.nx; x++) {
              const footprintX = footprintsX[x]!;
              let weightedValue = 0;
              let acquiredWeight = 0;

              for (let ix = 0; ix < footprintX.weights.length; ix++) {
                const sourceIndex = sourceBase + footprintX.start + ix;
                if (srcObservedSupport && !srcObservedSupport[sourceIndex]) continue;
                const weight = footprintX.weights[ix]!;
                weightedValue += (src[sourceIndex] ?? 0) * weight;
                acquiredWeight += weight;
              }

              const xIndex = xBase + x;
              xValues[xIndex] = weightedValue;
              if (xSupport) xSupport[xIndex] = acquiredWeight;
            }
          }
        }
        cachedSourceZ = sourceZ;
      }

      for (let y = 0; y < dstDims.ny; y++) {
        const footprintY = footprintsY[y]!;
        const destinationBase = y * dstDims.nx;

        for (let iy = 0; iy < footprintY.weights.length; iy++) {
          const yzWeight = zWeight * footprintY.weights[iy]!;
          const xBase = (footprintY.start + iy) * dstDims.nx;

          for (let x = 0; x < dstDims.nx; x++) {
            const destinationIndex = destinationBase + x;
            const xIndex = xBase + x;
            destination[destinationIndex] = destination[destinationIndex]! + xValues[xIndex]! * yzWeight;
            if (planeSupport && xSupport) {
              planeSupport[destinationIndex] = planeSupport[destinationIndex]! + xSupport[xIndex]! * yzWeight;
            }
          }
        }
      }
    }

    const destinationOffset = z * dstStrideZ;
    for (let index = 0; index < dstStrideZ; index++) {
      const acquiredWeight = planeSupport ? planeSupport[index]! : fullFootprintWeight;
      if (!(acquiredWeight > 0)) continue;
      const normalized = clamp((destination[index]! / acquiredWeight - intensityLow) * inverseRange, 0, 1);
      const value = params.invert ? 1 - normalized : normalized;
      const destinationIndex = destinationOffset + index;
      out[destinationIndex] = kind === 'u8' ? Math.round(value * 255) : value;
      if (observedSupport) {
        observedSupport[destinationIndex] = 1;
      }
    }

    // Yield to real interaction work on a time budget, not once for every fourth
    // slice: the previous fixed schedule inserted dozens of needless timers.
    const now = performance.now();
    if (now - lastYield >= 8 && z + 1 < dstDims.nz) {
      await yieldToMain();
      lastYield = performance.now();
    }
  }

  return { kind, dims: dstDims, data: out, ...(observedSupport ? { observedSupport } : {}) };
}

export async function buildRenderVolumeTexData(params: {
  src: Float32Array;
  /** Display-only affine. Native signed modality values remain untouched in src. */
  intensityRange?: readonly [number, number];
  invert?: boolean;
  srcObservedSupport?: Uint8Array;
  srcDims: RenderDims;
  plan: Pick<RenderPlan, 'dims' | 'kind'>;
  isCancelled: () => boolean;
}): Promise<RenderVolumeTexData> {
  const { src, srcObservedSupport, srcDims, plan, isCancelled } = params;
  const [intensityLow, intensityHigh] = params.intensityRange ?? [0, 1];
  if (!Number.isFinite(intensityLow) || !Number.isFinite(intensityHigh) || intensityHigh <= intensityLow) {
    throw new Error('The display intensity range must be finite and increasing.');
  }
  const normalize = intensityLow !== 0 || intensityHigh !== 1 || params.invert;
  const inverseRange = 1 / (intensityHigh - intensityLow);

  const sourceLength = srcDims.nx * srcDims.ny * srcDims.nz;
  if (src.length !== sourceLength) {
    throw new Error(`Render volume length mismatch: expected ${sourceLength}, got ${src.length}.`);
  }
  if (srcObservedSupport && srcObservedSupport.length !== sourceLength) {
    throw new Error(
      `Render volume acquired-support length mismatch: expected ${sourceLength}, got ${srcObservedSupport.length}.`,
    );
  }
  if (isCancelled()) throw new Error('Render volume build cancelled');

  const dstDims = plan.dims;

  const isSameDims = srcDims.nx === dstDims.nx && srcDims.ny === dstDims.ny && srcDims.nz === dstDims.nz;

  if (!isSameDims) {
    return resampleVolumeAreaAverage({
      src,
      intensityRange: params.intensityRange,
      invert: params.invert,
      srcObservedSupport,
      srcDims,
      dstDims,
      kind: plan.kind,
      isCancelled,
    });
  }

  let data: Float32Array | Uint8Array =
    plan.kind === 'u8' ? new Uint8Array(src.length) : normalize ? new Float32Array(src.length) : src;
  if (plan.kind === 'u8' || srcObservedSupport || normalize) {
    let lastYield = performance.now();
    const chunkSize = 131_072;

    for (let start = 0; start < src.length; start += chunkSize) {
      if (isCancelled()) throw new Error('Render volume build cancelled');
      const end = Math.min(src.length, start + chunkSize);

      if (plan.kind === 'u8') {
        for (let index = start; index < end; index++) {
          if (!srcObservedSupport || srcObservedSupport[index]) {
            const value = clamp(((src[index] ?? 0) - intensityLow) * inverseRange, 0, 1);
            data[index] = Math.round((params.invert ? 1 - value : value) * 255);
          }
        }
      } else if (normalize) {
        for (let index = start; index < end; index++) {
          if ((!srcObservedSupport || srcObservedSupport[index]) && Number.isFinite(src[index])) {
            const value = clamp((src[index]! - intensityLow) * inverseRange, 0, 1);
            data[index] = params.invert ? 1 - value : value;
          }
        }
      } else if (srcObservedSupport) {
        for (let index = start; index < end; index++) {
          if (!srcObservedSupport[index] && src[index] !== 0) {
            if (data === src) data = new Float32Array(src);
            data[index] = 0;
          }
        }
      }

      if (end < src.length && performance.now() - lastYield >= 8) {
        await yieldToMain();
        if (isCancelled()) throw new Error('Render volume build cancelled');
        lastYield = performance.now();
      }
    }
  }

  return {
    kind: plan.kind,
    dims: dstDims,
    data,
    ...(srcObservedSupport ? { observedSupport: srcObservedSupport } : {}),
  };
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

  // Invert the same pixel-center mapping used by the intensity footprint. Endpoint
  // interpolation would displace categorical labels by up to half a coarse voxel.
  const mapAxisToDstRange = (s0: number, s1: number, srcN: number, dstN: number): [number, number] => {
    const k = dstN / srcN;
    const d0 = Math.max(0, Math.floor(s0 * k - 0.5));
    const d1 = Math.min(dstN - 1, Math.ceil((s1 + 1) * k - 0.5));
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
    const sz = Math.min(srcDims.nz - 1, Math.floor(((z + 0.5) * srcDims.nz) / dstDims.nz));

    for (let y = dy0; y <= dy1; y++) {
      const sy = Math.min(srcDims.ny - 1, Math.floor(((y + 0.5) * srcDims.ny) / dstDims.ny));

      const srcBase = sz * srcStrideZ + sy * srcStrideY;
      const dstBase = z * dstStrideZ + y * dstStrideY;

      for (let x = dx0; x <= dx1; x++) {
        const sx = Math.min(srcDims.nx - 1, Math.floor(((x + 0.5) * srcDims.nx) / dstDims.nx));
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
  const { srcDims, dstDims } = params;

  const out = new Uint8Array(dstDims.nx * dstDims.ny * dstDims.nz);
  updateLabelsNearestRegion({
    ...params,
    dst: out,
    srcBox: { min: { x: 0, y: 0, z: 0 }, max: { x: srcDims.nx - 1, y: srcDims.ny - 1, z: srcDims.nz - 1 } },
  });

  return out;
}
