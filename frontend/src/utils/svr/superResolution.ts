import type { SvrVolume } from '../../types/svr';
import { IDENTITY_DIRECTION, volumeVoxelToPatient } from './volumeGeometry';
import { yieldToMain } from './svrUtils';
import {
  MAX_SR_OUTPUT_VOXELS,
  MIN_SR_CONTEXT_DIM,
  type SvrEnhancedVolume,
  type SvrSuperResolutionOptions,
  type SvrSuperResolutionProgress,
} from './superResolutionTypes';

export const SR_HIGH_ORDER_FEATURES = 33;
const FEATURES = SR_HIGH_ORDER_FEATURES;
const DESCRIPTOR = 6;
const CHILDREN = 8;
const SPATIAL_BLOCK = 16;
const SAMPLE_LIMITS = [16_384, 2_048, 4_096] as const;
type Triple = [number, number, number];
type Grid = { data: Float32Array; support?: Uint8Array; dims: Triple };
type Samples = { indices: Uint32Array; count: number; seen: number; random: number; blocks: Set<number> };

function assertCurrent(signal?: AbortSignal): void {
  if (signal?.aborted) throw new DOMException('Detail enhancement cancelled.', 'AbortError');
}

/** Higher-order residuals must not learn a scale-specific first-gradient gain.
 * Subtract a local quadratic from 3³ neighbors plus six axial distance-two samples.
 * Every feature exactly annihilates degree≤2 polynomials; no bias reintroduces DC/gradient leakage.
 */
export function extractHighOrderPatchFeatures(
  grid: Grid,
  x: number,
  y: number,
  z: number,
  features: Float64Array,
  descriptor: Float64Array,
): number {
  const [nx, ny, nz] = grid.dims;
  if (x < 2 || y < 2 || z < 2 || x >= nx - 2 || y >= ny - 2 || z >= nz - 2) return 0;
  const center = grid.data[(z * ny + y) * nx + x]!;
  let variance = 0,
    feature = 0;
  for (let dz = -1; dz <= 1; dz++)
    for (let dy = -1; dy <= 1; dy++)
      for (let dx = -1; dx <= 1; dx++) {
        const index = ((z + dz) * ny + y + dy) * nx + x + dx;
        if (grid.support && !grid.support[index]) return 0;
        const difference = grid.data[index]! - center;
        features[feature++] = difference;
        variance += difference * difference;
      }
  const scale = Math.sqrt(variance / 26);
  if (!Number.isFinite(scale) || scale <= 1e-6 * Math.max(1, Math.abs(center))) return 0;
  const gx = (features[14]! - features[12]!) / 2,
    gy = (features[16]! - features[10]!) / 2,
    gz = (features[22]! - features[4]!) / 2;
  const hxx = features[14]! + features[12]!,
    hyy = features[16]! + features[10]!,
    hzz = features[22]! + features[4]!;
  const hxy = (features[17]! - features[15]! - features[11]! + features[9]!) / 4;
  const hxz = (features[23]! - features[21]! - features[5]! + features[3]!) / 4;
  const hyz = (features[25]! - features[19]! - features[7]! + features[1]!) / 4;
  descriptor[0] = (2 * gx) / scale;
  descriptor[1] = (2 * gy) / scale;
  descriptor[2] = (2 * gz) / scale;
  descriptor[3] = hxx / scale;
  descriptor[4] = hyy / scale;
  descriptor[5] = hzz / scale;
  feature = 0;
  for (let dz = -1; dz <= 1; dz++)
    for (let dy = -1; dy <= 1; dy++)
      for (let dx = -1; dx <= 1; dx++) {
        const quadratic =
          gx * dx +
          gy * dy +
          gz * dz +
          (hxx * dx * dx + hyy * dy * dy + hzz * dz * dz) / 2 +
          hxy * dx * dy +
          hxz * dx * dz +
          hyz * dy * dz;
        features[feature] = (features[feature]! - quadratic) / scale;
        feature++;
      }
  for (let axis = 0; axis < 3; axis++)
    for (let sign = -1; sign <= 1; sign += 2) {
      const index =
        ((z + (axis === 2 ? 2 * sign : 0)) * ny + y + (axis === 1 ? 2 * sign : 0)) * nx +
        x +
        (axis === 0 ? 2 * sign : 0);
      if (grid.support && !grid.support[index]) return 0;
      const gradient = axis === 0 ? gx : axis === 1 ? gy : gz,
        curvature = axis === 0 ? hxx : axis === 1 ? hyy : hzz;
      features[feature++] = (grid.data[index]! - center - 2 * sign * gradient - 2 * curvature) / scale;
    }
  return scale;
}

/** Cell-centered trilinear interpolation, projected onto the known source-cell mean. */
function baselineChildren(grid: Grid, x: number, y: number, z: number, target: Float64Array): void {
  const [nx, ny, nz] = grid.dims;
  const center = grid.data[(z * ny + y) * nx + x]!;
  let sum = 0;
  for (let child = 0; child < CHILDREN; child++) {
    const dx = child & 1 ? 1 : -1,
      dy = child & 2 ? 1 : -1,
      dz = child & 4 ? 1 : -1;
    let value = 0,
      weight = 0;
    for (let neighbor = 0; neighbor < CHILDREN; neighbor++) {
      const ix = Math.max(0, Math.min(nx - 1, x + (neighbor & 1 ? dx : 0)));
      const iy = Math.max(0, Math.min(ny - 1, y + (neighbor & 2 ? dy : 0)));
      const iz = Math.max(0, Math.min(nz - 1, z + (neighbor & 4 ? dz : 0)));
      const index = (iz * ny + iy) * nx + ix;
      if (grid.support && !grid.support[index]) continue;
      const w = (neighbor & 1 ? 0.25 : 0.75) * (neighbor & 2 ? 0.25 : 0.75) * (neighbor & 4 ? 0.25 : 0.75);
      value += grid.data[index]! * w;
      weight += w;
    }
    target[child] = weight > 0 ? value / weight : center;
    sum += target[child]!;
  }
  const correction = center - sum / CHILDREN;
  for (let child = 0; child < CHILDREN; child++) target[child] = target[child]! + correction;
}

function nearestAnchor(descriptor: Float64Array, anchors: Float64Array): number {
  let best = 0,
    distance = Infinity;
  for (let anchor = 0; anchor < anchors.length / DESCRIPTOR; anchor++) {
    let squared = 0;
    for (let axis = 0; axis < DESCRIPTOR; axis++) {
      const difference = descriptor[axis]! - anchors[anchor * DESCRIPTOR + axis]!;
      squared += difference * difference;
    }
    if (squared < distance) {
      distance = squared;
      best = anchor;
    }
  }
  return best;
}

function fitAnchors(descriptors: Float32Array, count: number): Float64Array {
  const anchorCount = Math.max(1, Math.min(8, Math.floor(count / 128)));
  const anchors = new Float64Array(anchorCount * DESCRIPTOR);
  const descriptor = new Float64Array(DESCRIPTOR);
  // Deterministic farthest-point initialization, followed by five bounded Lloyd passes.
  const distances = new Float64Array(count).fill(Infinity);
  let next = Math.floor(count / 2);
  for (let anchor = 0; anchor < anchorCount; anchor++) {
    const center = descriptors.subarray(next * DESCRIPTOR, (next + 1) * DESCRIPTOR);
    anchors.set(center, anchor * DESCRIPTOR);
    let farthest = -1;
    for (let sample = 0; sample < count; sample++) {
      let squared = 0;
      for (let axis = 0; axis < DESCRIPTOR; axis++) {
        const difference = descriptors[sample * DESCRIPTOR + axis]! - center[axis]!;
        squared += difference * difference;
      }
      distances[sample] = Math.min(distances[sample]!, squared);
      if (distances[sample]! > farthest) {
        farthest = distances[sample]!;
        next = sample;
      }
    }
  }
  for (let iteration = 0; iteration < 5; iteration++) {
    const sums = new Float64Array(anchors.length),
      counts = new Uint32Array(anchorCount);
    for (let sample = 0; sample < count; sample++) {
      descriptor.set(descriptors.subarray(sample * DESCRIPTOR, (sample + 1) * DESCRIPTOR));
      const anchor = nearestAnchor(descriptor, anchors);
      counts[anchor]++;
      for (let axis = 0; axis < DESCRIPTOR; axis++) sums[anchor * DESCRIPTOR + axis] += descriptor[axis]!;
    }
    for (let anchor = 0; anchor < anchorCount; anchor++)
      if (counts[anchor])
        for (let axis = 0; axis < DESCRIPTOR; axis++)
          anchors[anchor * DESCRIPTOR + axis] = sums[anchor * DESCRIPTOR + axis]! / counts[anchor]!;
  }
  return anchors;
}

function solveRidge(covariance: Float64Array, cross: Float64Array): Float64Array {
  let trace = 0;
  for (let feature = 0; feature < FEATURES; feature++) trace += covariance[feature * FEATURES + feature]!;
  const ridge = 0.02 * Math.max(1, trace / FEATURES);
  const lower = new Float64Array(FEATURES * FEATURES);
  for (let row = 0; row < FEATURES; row++)
    for (let column = 0; column <= row; column++) {
      let value = covariance[row * FEATURES + column]! + (row === column ? ridge : 0);
      for (let k = 0; k < column; k++) value -= lower[row * FEATURES + k]! * lower[column * FEATURES + k]!;
      if (row === column && (!Number.isFinite(value) || value <= 0))
        throw new Error('This region could not fit a stable detail model. Its source images remain unchanged.');
      lower[row * FEATURES + column] = row === column ? Math.sqrt(value) : value / lower[column * FEATURES + column]!;
    }
  const weights = new Float64Array(CHILDREN * FEATURES);
  for (let child = 0; child < CHILDREN; child++) {
    const offset = child * FEATURES;
    for (let row = 0; row < FEATURES; row++) {
      let value = cross[offset + row]!;
      for (let k = 0; k < row; k++) value -= lower[row * FEATURES + k]! * weights[offset + k]!;
      weights[offset + row] = value / lower[row * FEATURES + row]!;
    }
    for (let row = FEATURES - 1; row >= 0; row--) {
      let value = weights[offset + row]!;
      for (let k = row + 1; k < FEATURES; k++) value -= lower[k * FEATURES + row]! * weights[offset + k]!;
      weights[offset + row] = value / lower[row * FEATURES + row]!;
    }
  }
  return weights;
}

function predictResidual(
  features: Float64Array,
  descriptor: Float64Array,
  anchors: Float64Array,
  models: Float64Array[],
  result: Float64Array,
): void {
  const weights = models[nearestAnchor(descriptor, anchors)]!;
  let mean = 0;
  for (let child = 0; child < CHILDREN; child++) {
    let value = 0;
    for (let feature = 0; feature < FEATURES; feature++)
      value += weights[child * FEATURES + feature]! * features[feature]!;
    // Limit extrapolation to local contrast, then remove any DC component.
    result[child] = Math.max(-1.5, Math.min(1.5, value));
    mean += result[child]! / CHILDREN;
  }
  for (let child = 0; child < CHILDREN; child++) result[child] -= mean;
}

/** Learn only from this volume; output is experimental render-only inference, not acquired resolution. */
export async function enhanceVolume2x(
  input: SvrVolume,
  options: SvrSuperResolutionOptions = {},
): Promise<SvrEnhancedVolume> {
  const started = performance.now();
  assertCurrent(options.signal);
  const count = input.dims.reduce((product, size) => product * size, 1);
  if (
    input.dims.some((size) => !Number.isSafeInteger(size) || size < MIN_SR_CONTEXT_DIM) ||
    !Number.isSafeInteger(count) ||
    count !== input.data.length ||
    count * CHILDREN > MAX_SR_OUTPUT_VOXELS ||
    (input.observedSupport && input.observedSupport.length !== count)
  )
    throw new Error(
      'Learned detail needs a supported 3D region with more context (normally at least 32 voxels per axis), within the enhancement memory budget.',
    );
  const direction = input.direction ?? IDENTITY_DIRECTION;
  if (
    input.voxelSizeMm.some((value) => !Number.isFinite(value) || value <= 0) ||
    [...input.originMm, ...input.boundsMm.min, ...input.boundsMm.max, ...direction].some(
      (value) => !Number.isFinite(value),
    )
  )
    throw new Error('Learned detail requires finite source-grid geometry.');
  for (let a = 0; a < 3; a++)
    for (let b = 0; b < 3; b++) {
      let dot = 0;
      for (let row = 0; row < 3; row++) dot += direction[row * 3 + a]! * direction[row * 3 + b]!;
      if (Math.abs(dot - (a === b ? 1 : 0)) > 1e-4)
        throw new Error('Learned detail requires orthonormal source-grid axes.');
    }
  const checkpoint = async (
    phase: SvrSuperResolutionProgress['phase'],
    current: number,
    total: number,
    message: string,
  ) => {
    assertCurrent(options.signal);
    options.onProgress?.({ phase, current, total, message });
    await yieldToMain();
    assertCurrent(options.signal);
  };
  const source: Grid = { data: input.data, support: input.observedSupport, dims: input.dims };
  const [nx, ny, nz] = source.dims;
  for (let index = 0; index < count; index++)
    if ((!source.support || source.support[index]) && !Number.isFinite(source.data[index]))
      throw new Error('Learned detail requires finite acquired source intensities.');
  const coarseDims = input.dims.map((size) => Math.floor(size / 2)) as Triple;
  const [cx, cy, cz] = coarseDims;
  const coarse: Grid = {
    data: new Float32Array(cx * cy * cz),
    support: new Uint8Array(cx * cy * cz),
    dims: coarseDims,
  };
  for (let z = 0; z < cz; z++) {
    for (let y = 0; y < cy; y++)
      for (let x = 0; x < cx; x++) {
        let sum = 0,
          valid = true;
        for (let child = 0; child < CHILDREN; child++) {
          const index = ((2 * z + (child >> 2)) * ny + 2 * y + ((child >> 1) & 1)) * nx + 2 * x + (child & 1);
          if (source.support && !source.support[index]) valid = false;
          else sum += source.data[index]!;
        }
        const index = (z * cy + y) * cx + x;
        if (valid) {
          coarse.data[index] = sum / CHILDREN;
          coarse.support![index] = 1;
        }
      }
    if (z % 8 === 0) await checkpoint('preparing', z, cz, 'Preparing within-scan training examples…');
  }
  const samples: Samples[] = SAMPLE_LIMITS.map((limit, role) => ({
    indices: new Uint32Array(limit),
    count: 0,
    seen: 0,
    random: 1931 + role,
    blocks: new Set<number>(),
  }));
  const features = new Float64Array(FEATURES),
    baseline = new Float64Array(CHILDREN),
    residual = new Float64Array(CHILDREN);
  const descriptor = new Float64Array(DESCRIPTOR);
  const blockDims = input.dims.map((size) => Math.ceil(size / SPATIAL_BLOCK));
  const blockAt = (x: number, y: number, z: number) => {
    const bx = Math.floor((2 * x - 4) / SPATIAL_BLOCK),
      by = Math.floor((2 * y - 4) / SPATIAL_BLOCK),
      bz = Math.floor((2 * z - 4) / SPATIAL_BLOCK);
    if (
      bx !== Math.floor((2 * x + 5) / SPATIAL_BLOCK) ||
      by !== Math.floor((2 * y + 5) / SPATIAL_BLOCK) ||
      bz !== Math.floor((2 * z + 5) / SPATIAL_BLOCK)
    )
      return -1;
    return (bz * blockDims[1]! + by) * blockDims[0]! + bx;
  };
  for (let z = 2; z < cz - 2; z++) {
    for (let y = 2; y < cy - 2; y++)
      for (let x = 2; x < cx - 2; x++) {
        const block = blockAt(x, y, z);
        if (block < 0 || !extractHighOrderPatchFeatures(coarse, x, y, z, features, descriptor)) continue;
        const partition = block % 5;
        const group = samples[partition < 2 ? partition + 1 : 0]!;
        group.seen++;
        group.random = (Math.imul(group.random, 1664525) + 1013904223) >>> 0;
        const slot =
          group.seen <= group.indices.length ? group.seen - 1 : Math.floor((group.random / 4294967296) * group.seen);
        if (slot < group.indices.length) group.indices[slot] = (z * cy + y) * cx + x;
      }
    if (z % 8 === 0)
      await checkpoint('preparing', z, cz, 'Separating spatial training, calibration, and held-out blocks…');
  }
  for (const group of samples) {
    group.count = Math.min(group.seen, group.indices.length);
    for (let i = 0; i < group.count; i++) {
      const index = group.indices[i]!;
      group.blocks.add(blockAt(index % cx, Math.floor(index / cx) % cy, Math.floor(index / (cx * cy))));
    }
  }
  if (
    samples[0]!.count < 128 ||
    samples[1]!.count < 32 ||
    samples[2]!.count < 32 ||
    samples.some((group) => group.blocks.size < 2)
  )
    throw new Error(
      'This region has too little independent textured context to learn and check detail. Expand the region around the selection; the original is unchanged.',
    );
  const training = samples[0]!;
  const trainingFeatures = new Float32Array(training.count * FEATURES),
    trainingTargets = new Float32Array(training.count * CHILDREN),
    trainingDescriptors = new Float32Array(training.count * DESCRIPTOR);
  const example = (index: number, target: Float64Array): number => {
    const x = index % cx,
      y = Math.floor(index / cx) % cy,
      z = Math.floor(index / (cx * cy));
    const scale = extractHighOrderPatchFeatures(coarse, x, y, z, features, descriptor);
    baselineChildren(coarse, x, y, z, baseline);
    for (let child = 0; child < CHILDREN; child++) {
      const nativeIndex = ((2 * z + (child >> 2)) * ny + 2 * y + ((child >> 1) & 1)) * nx + 2 * x + (child & 1);
      target[child] = (source.data[nativeIndex]! - baseline[child]!) / scale;
    }
    return scale;
  };
  for (let sample = 0; sample < training.count; sample++) {
    example(training.indices[sample]!, residual);
    trainingFeatures.set(features, sample * FEATURES);
    trainingTargets.set(residual, sample * CHILDREN);
    trainingDescriptors.set(descriptor, sample * DESCRIPTOR);
  }
  await checkpoint('training', 0, training.count, 'Learning scan-specific 3D texture neighborhoods…');
  const anchors = fitAnchors(trainingDescriptors, training.count);
  assertCurrent(options.signal);
  const covariances = Array.from({ length: anchors.length / DESCRIPTOR }, () => new Float64Array(FEATURES * FEATURES));
  const crosses = covariances.map(() => new Float64Array(FEATURES * CHILDREN));
  for (let sample = 0; sample < training.count; sample++) {
    const offset = sample * FEATURES;
    descriptor.set(trainingDescriptors.subarray(sample * DESCRIPTOR, (sample + 1) * DESCRIPTOR));
    const anchor = nearestAnchor(descriptor, anchors),
      covariance = covariances[anchor]!,
      cross = crosses[anchor]!;
    for (let row = 0; row < FEATURES; row++) {
      const value = trainingFeatures[offset + row]!;
      for (let column = 0; column <= row; column++)
        covariance[row * FEATURES + column] += value * trainingFeatures[offset + column]!;
      for (let child = 0; child < CHILDREN; child++)
        cross[child * FEATURES + row] += value * trainingTargets[sample * CHILDREN + child]!;
    }
    if (sample % 2_048 === 0)
      await checkpoint('training', sample, training.count, 'Fitting learned subvoxel residuals…');
  }
  const models = covariances.map((covariance, anchor) => solveRidge(covariance, crosses[anchor]!));
  let numerator = 0,
    denominator = 0;
  const target = new Float64Array(CHILDREN);
  for (let sample = 0; sample < samples[1]!.count; sample++) {
    const scale = example(samples[1]!.indices[sample]!, target);
    predictResidual(features, descriptor, anchors, models, residual);
    for (let child = 0; child < CHILDREN; child++) {
      numerator += target[child]! * residual[child]! * scale * scale;
      denominator += residual[child]! * residual[child]! * scale * scale;
    }
  }
  // This explicitly requested experimental view keeps a positive learned contribution.
  // A negative held-out gain is reported honestly, not hidden behind an interpolation fallback.
  const modelStrength = denominator > 0 ? Math.max(0.25, Math.min(1, numerator / denominator)) : 0.25;
  await checkpoint('validating', 0, samples[2]!.count, 'Checking separate held-out native anatomy…');
  let baselineMse = 0,
    enhancedMse = 0;
  for (let sample = 0; sample < samples[2]!.count; sample++) {
    const scale = example(samples[2]!.indices[sample]!, target);
    predictResidual(features, descriptor, anchors, models, residual);
    for (let child = 0; child < CHILDREN; child++) {
      const error = target[child]! * scale;
      baselineMse += error * error;
      const enhancedError = error - modelStrength * residual[child]! * scale;
      enhancedMse += enhancedError * enhancedError;
    }
  }
  baselineMse /= samples[2]!.count * CHILDREN;
  enhancedMse /= samples[2]!.count * CHILDREN;
  const dims = input.dims.map((size) => size * 2) as Triple;
  const data = new Float32Array(count * CHILDREN),
    observedSupport = new Uint8Array(data.length);
  let consistencyMaxError = 0;
  for (let z = 0; z < nz; z++) {
    for (let y = 0; y < ny; y++)
      for (let x = 0; x < nx; x++) {
        const index = (z * ny + y) * nx + x;
        if (source.support && !source.support[index]) continue;
        baselineChildren(source, x, y, z, baseline);
        const scale = extractHighOrderPatchFeatures(source, x, y, z, features, descriptor);
        if (scale) predictResidual(features, descriptor, anchors, models, residual);
        else residual.fill(0);
        let sum = 0,
          last = 0;
        for (let child = 0; child < CHILDREN; child++) {
          const output =
            ((2 * z + (child >> 2)) * dims[1] + 2 * y + ((child >> 1) & 1)) * dims[0] + 2 * x + (child & 1);
          data[output] = baseline[child]! + modelStrength * scale * residual[child]!;
          if (!Number.isFinite(data[output]))
            throw new Error('The inferred detail exceeds the supported intensity range. The original is unchanged.');
          observedSupport[output] = 1;
          sum += data[output]!;
          last = output;
        }
        // Repair Float32 rounding without clipping or changing the source's DC value.
        const before = data[last]!;
        data[last] = before + CHILDREN * (source.data[index]! - sum / CHILDREN);
        if (!Number.isFinite(data[last]))
          throw new Error('The inferred detail exceeds the supported intensity range. The original is unchanged.');
        consistencyMaxError = Math.max(
          consistencyMaxError,
          Math.abs(source.data[index]! - (sum - before + data[last]!) / CHILDREN),
        );
      }
    if (z % 2 === 0)
      await checkpoint('enhancing', z, nz, 'Inferring 2× detail; original anatomy and measurements are unchanged…');
  }
  await checkpoint('enhancing', nz, nz, 'Inferred detail ready. Compare it with the original MRI.');
  return {
    data,
    observedSupport,
    dims,
    voxelSizeMm: input.voxelSizeMm.map((pitch) => pitch / 2) as Triple,
    originMm: volumeVoxelToPatient(input, [-0.25, -0.25, -0.25]),
    direction: [...direction],
    boundsMm: { min: [...input.boundsMm.min], max: [...input.boundsMm.max] },
    intensityRange: input.intensityRange ? [...input.intensityRange] : undefined,
    displayWindow: input.displayWindow ? [...input.displayWindow] : undefined,
    displayInvert: input.displayInvert,
    stats: {
      method: 'Within-scan 3D anchored ridge regression (experimental 2×)',
      trainingSamples: training.count,
      calibrationSamples: samples[1]!.count,
      heldOutSamples: samples[2]!.count,
      trainingBlocks: training.blocks.size,
      calibrationBlocks: samples[1]!.blocks.size,
      heldOutBlocks: samples[2]!.blocks.size,
      baselineMse,
      enhancedMse,
      consistencyMaxError,
      durationMs: performance.now() - started,
      modelStrength,
    },
  };
}
