import type { SvrDirection, SvrParams, SvrPatientTransform, SvrVolume } from '../../types/svr';
import type { SeriesFrameManifest } from '../localApi';
import { getSliceGeometryFromInstance } from './dicomGeometry';
import { waitForNativeFrame } from './nativeFrameWait';
import { estimateSvrPeakMemoryBytes, SVR_MEMORY_BUDGET_BYTES, type SvrMemoryPlan } from './svrMemoryPlan';
import { assertNotAborted, yieldToMain } from './svrUtils';
import {
  IDENTITY_PATIENT_TRANSFORM,
  patientToVolumeVoxel,
  physicalVolumeBounds,
  rotatePoint,
  snapshotPatientTransform,
  transformPoint,
} from './volumeGeometry';

type NativeFrame = SeriesFrameManifest['frames'][number];
type Triple = [number, number, number];
export type NativeVolumePlan = {
  dims: Triple;
  voxelSizeMm: Triple;
  nativeVoxelSizeMm: Triple;
  direction: SvrDirection;
  originMm: Triple;
  boundsMm: SvrVolume['boundsMm'];
  sourceDims: Triple;
  cropMin: Triple;
  cropMax: Triple;
  sourceStrides: Triple;
  sourceAxes: Triple;
  sourceFlips: Triple;
  frames: readonly { frame: NativeFrame; slice: number }[];
  sourceBytes: number;
  decodedCacheBytes: number;
  memoryPlan: SvrMemoryPlan;
  totalBytes: number;
  budgetBytes: number;
  overview: boolean;
};

export type NativeVolumePlanOptions = {
  retainedBytes?: number;
  decodedCacheBytes?: number;
  budgetBytes?: number;
  transform?: SvrPatientTransform;
  nativePlaneBytes?: number;
};

/** Converted cache, one decode/display transition, and up to three future raw browsing frames. */
export function nativePlaneMemoryBytes(
  manifests: readonly { frames: readonly { rows: number; columns: number }[] }[],
): number {
  let pixels = 0;
  for (const manifest of manifests)
    for (const frame of manifest.frames) pixels = Math.max(pixels, frame.rows * frame.columns);
  // 17B decode peak + 6B GPU textures + 1B categorical projection + 1B validity upload,
  // plus three independently cached raw Cornerstone frames at worst-case Float32 pitch.
  return 32 * 1024 * 1024 + pixels * (25 + 3 * Float32Array.BYTES_PER_ELEMENT);
}

/** Native assembly reuses cached images but does not insert new ones; reserve measured residency. */
export function nativeDecodedCacheBudgetBytes(cache?: {
  maximumSizeInBytes?: number;
  cacheSizeInBytes?: number;
}): number {
  const measured = cache?.cacheSizeInBytes;
  return Number.isFinite(measured) && measured! >= 0 ? measured! : 256 * 1024 * 1024;
}

/** Accepted CPU, normalization, staging, GPU and annotation owners survive until replacement publishes. */
export function retainedSvrVolumeBytes(volume?: SvrVolume | null): number {
  if (!volume) return 0;
  let planePixels = 0;
  for (const source of volume.sourceProvenance?.sources ?? [])
    for (const frame of source.frames) planePixels = Math.max(planePixels, frame.rows * frame.columns);
  return (
    volume.data.byteLength +
    (volume.observedSupport?.byteLength ?? 0) +
    volume.data.length * (7 + (volume.intensityRange ? 4 : 0)) +
    planePixels * 7
  );
}

/** Find the same densest-axis-first overview without visiting every integer stride. */
function overviewStrides(counts: Triple, spacing: Triple, fits: (strides: Triple) => boolean): Triple {
  // Incrementing axis i at stride k is an event at physical pitch spacing[i]*k.
  // These three ordered event sequences reproduce the original axis-order ties.
  const afterEvent = (axis: number, step: number): Triple => {
    const pitch = spacing[axis]! * step;
    return counts.map((count, other) => {
      if (other === axis) return step + 1;
      let lower = 0,
        upper = count - 1;
      while (lower < upper) {
        const middle = lower + Math.ceil((upper - lower) / 2);
        const otherPitch = spacing[other]! * middle;
        if (otherPitch < pitch || (otherPitch === pitch && other < axis)) lower = middle;
        else upper = middle - 1;
      }
      return lower + 1;
    }) as Triple;
  };
  let best = counts,
    bestPitch = Infinity;
  for (let axis = 0; axis < 3; axis++) {
    let lower = 1,
      upper = counts[axis]! - 1;
    if (upper < lower || !fits(afterEvent(axis, upper))) continue;
    // Safe integer dimensions bound each search to at most 53 probes.
    while (lower < upper) {
      const middle = lower + Math.floor((upper - lower) / 2);
      if (fits(afterEvent(axis, middle))) upper = middle;
      else lower = middle + 1;
    }
    const pitch = spacing[axis]! * lower;
    if (pitch < bestPitch) {
      best = afterEvent(axis, lower);
      bestPitch = pitch;
    }
  }
  return best;
}

/** Native indexing is reordered, never interpolated, into dominant positive patient LPS axes. */
export function planNativeVolume(
  manifest: SeriesFrameManifest,
  params: Pick<SvrParams, 'roi'>,
  options: NativeVolumePlanOptions = {},
): NativeVolumePlan {
  if (!manifest.geometryReliable || !manifest.frames.length)
    throw new Error('The source stack needs reliable patient-space geometry.');
  const geometry = getSliceGeometryFromInstance(manifest.frames[0]!);
  const normal = [geometry.normalDir.x, geometry.normalDir.y, geometry.normalDir.z] as Triple;
  const position = (frame: NativeFrame) => {
    const p = getSliceGeometryFromInstance(frame).ippMm;
    const value = p.x * normal[0] + p.y * normal[1] + p.z * normal[2];
    if (!Number.isFinite(value)) throw new Error('The source stack has invalid native slice positions.');
    return value;
  };
  const ordered = [...manifest.frames].sort((a, b) => position(a) - position(b));
  const first = getSliceGeometryFromInstance(ordered[0]!);
  if ([first.rows, first.cols].some((size) => !Number.isSafeInteger(size) || size < 1))
    throw new Error('The source stack has invalid native pixel dimensions.');
  const firstPosition = position(ordered[0]!);
  const deltas = ordered.slice(1).map((frame, index) => position(frame) - position(ordered[index]!));
  const declared = ordered[0]!.spacingBetweenSlices;
  const geometricPitch = deltas.length ? [...deltas].sort((a, b) => a - b)[Math.floor(deltas.length / 2)]! : null;
  const declaredFits =
    declared &&
    declared > 0 &&
    deltas.every(
      (delta) => Math.abs(delta / declared - Math.round(delta / declared)) < 1e-3 && delta / declared >= 0.999,
    );
  const pitch = declaredFits ? declared : (geometricPitch ?? ordered[0]!.sliceThickness ?? 1);
  if (!Number.isFinite(pitch) || pitch <= 0) throw new Error('The source stack has invalid native slice spacing.');
  const sourceSpacing: Triple = [first.colSpacingMm, first.rowSpacingMm, pitch];
  const sourceOrigin: Triple = [first.ippMm.x, first.ippMm.y, first.ippMm.z];
  const axes: Triple[] = [
    [first.rowDir.x, first.rowDir.y, first.rowDir.z],
    [first.colDir.x, first.colDir.y, first.colDir.z],
    normal,
  ];
  const seenSlices = new Set<number>();
  const frames = ordered.map((frame) => {
    const current = getSliceGeometryFromInstance(frame);
    const offset = (position(frame) - firstPosition) / pitch;
    const slice = Math.round(offset);
    if (!Number.isSafeInteger(slice + 1) || slice < 0)
      throw new Error('This source stack exceeds safe native-grid dimensions. Its original slices remain available.');
    const expected = sourceOrigin.map((value, axis) => value + normal[axis]! * slice * pitch);
    const actual = [current.ippMm.x, current.ippMm.y, current.ippMm.z];
    if (
      current.rows !== first.rows ||
      current.cols !== first.cols ||
      Math.abs(current.rowSpacingMm - first.rowSpacingMm) > 1e-5 ||
      Math.abs(current.colSpacingMm - first.colSpacingMm) > 1e-5 ||
      Math.abs(offset - slice) > 1e-3 ||
      seenSlices.has(slice) ||
      actual.some((value, axis) => Math.abs(value - expected[axis]!) > 0.01) ||
      [current.rowDir.x, current.rowDir.y, current.rowDir.z].some(
        (value, axis) => Math.abs(value - axes[0]![axis]!) > 1e-4,
      ) ||
      [current.colDir.x, current.colDir.y, current.colDir.z].some(
        (value, axis) => Math.abs(value - axes[1]![axis]!) > 1e-4,
      )
    )
      throw new Error('This source stack is not a coherent regular native grid. Its original slices remain available.');
    seenSlices.add(slice);
    return { frame, slice };
  });
  const sourceDims: Triple = [first.cols, first.rows, frames.at(-1)!.slice + 1];
  if (!Number.isSafeInteger(sourceDims.reduce((product, size) => product * size, 1)))
    throw new Error('This source stack exceeds safe native-grid dimensions. Its original slices remain available.');
  if (sourceDims.some((size, axis) => !Number.isFinite(size * sourceSpacing[axis]!)))
    throw new Error('The source stack has unrepresentable native physical dimensions.');
  const transform = snapshotPatientTransform(options.transform ?? IDENTITY_PATIENT_TRANSFORM);
  const acceptedAxes = axes.map((axis) => rotatePoint(transform.rotation, axis));
  const acceptedOrigin = transformPoint(transform, sourceOrigin);
  const sourceDirection: SvrDirection = [
    acceptedAxes[0]![0],
    acceptedAxes[1]![0],
    acceptedAxes[2]![0],
    acceptedAxes[0]![1],
    acceptedAxes[1]![1],
    acceptedAxes[2]![1],
    acceptedAxes[0]![2],
    acceptedAxes[1]![2],
    acceptedAxes[2]![2],
  ];
  const cropMin: Triple = [0, 0, 0],
    cropMax: Triple = sourceDims.map((size) => size - 1) as Triple;
  if (params.roi) {
    const lower: Triple = [Infinity, Infinity, Infinity],
      upper: Triple = [-Infinity, -Infinity, -Infinity];
    const roi = params.roi.boundsMm;
    if (
      roi.min.some(
        (value, axis) => !Number.isFinite(value) || !Number.isFinite(roi.max[axis]) || value >= roi.max[axis]!,
      )
    )
      throw new Error('The native detail region has invalid patient-space bounds.');
    for (const x of [roi.min[0], roi.max[0]])
      for (const y of [roi.min[1], roi.max[1]])
        for (const z of [roi.min[2], roi.max[2]]) {
          const point = patientToVolumeVoxel(
            { originMm: acceptedOrigin, direction: sourceDirection, voxelSizeMm: sourceSpacing },
            [x, y, z],
          );
          for (let axis = 0; axis < 3; axis++) {
            lower[axis] = Math.min(lower[axis]!, point[axis]!);
            upper[axis] = Math.max(upper[axis]!, point[axis]!);
          }
        }
    for (let axis = 0; axis < 3; axis++) {
      if (upper[axis]! < -0.5 || lower[axis]! > sourceDims[axis]! - 0.5)
        throw new Error('The native detail region does not intersect this source stack.');
      cropMin[axis] = Math.max(0, Math.floor(lower[axis]!) - 1);
      cropMax[axis] = Math.min(sourceDims[axis]! - 1, Math.ceil(upper[axis]!) + 1);
    }
  }
  const permutations: Triple[] = [
    [0, 1, 2],
    [0, 2, 1],
    [1, 0, 2],
    [1, 2, 0],
    [2, 0, 1],
    [2, 1, 0],
  ];
  const sourceAxes = permutations.sort(
    (a, b) =>
      b.reduce((sum, index, patientAxis) => sum + Math.abs(acceptedAxes[index]![patientAxis]!), 0) -
      a.reduce((sum, index, patientAxis) => sum + Math.abs(acceptedAxes[index]![patientAxis]!), 0),
  )[0]!;
  const sourceFlips = sourceAxes.map((axis, patientAxis) => (acceptedAxes[axis]![patientAxis]! < 0 ? -1 : 1)) as Triple;
  const nativeVoxelSizeMm = sourceAxes.map((axis) => sourceSpacing[axis]!) as Triple;
  const direction = Array.from(
    { length: 9 },
    (_, index) => acceptedAxes[sourceAxes[index % 3]!]![Math.floor(index / 3)]! * sourceFlips[index % 3]!,
  ) as unknown as SvrDirection;
  let sourceStrides: Triple = [1, 1, 1];
  const sourceBytes = first.rows * first.cols * Float32Array.BYTES_PER_ELEMENT;
  const decodedCacheBytes = Math.max(0, options.decodedCacheBytes ?? nativeDecodedCacheBudgetBytes());
  // Source-plane cache plus R32F intensity / acquired validity / categorical mask.
  const nativePlaneBytes = options.nativePlaneBytes ?? nativePlaneMemoryBytes([manifest]);
  const budgetBytes = options.budgetBytes ?? SVR_MEMORY_BUDGET_BYTES;
  if (
    [sourceBytes, decodedCacheBytes, nativePlaneBytes, options.retainedBytes ?? 0, budgetBytes].some(
      (bytes) => !Number.isFinite(bytes) || bytes < 0,
    )
  )
    throw new Error('Native-volume admission requires finite, nonnegative memory estimates.');
  const sourceCounts = (strides = sourceStrides) =>
    sourceDims.map((_, axis) => Math.floor((cropMax[axis]! - cropMin[axis]!) / strides[axis]!) + 1) as Triple;
  const memory = (strides = sourceStrides) => {
    const voxelCount = sourceCounts(strides).reduce((a, b) => a * b, 1);
    return estimateSvrPeakMemoryBytes({
      voxelCount,
      sourceBytes,
      iterations: 0,
      phase: 'inference',
      // Raw native data survives display normalization: its Float32 staging is an independent owner.
      retainedBytes: decodedCacheBytes + (options.retainedBytes ?? 0) + nativePlaneBytes + voxelCount * 4,
      labelBytes: voxelCount * 2,
    });
  };
  let memoryPlan = memory();
  // Only an overview may subsample. A regional plan remains exact and reports admission failure before allocation.
  if (
    !params.roi &&
    memoryPlan.totalBytes > budgetBytes &&
    sourceBytes + decodedCacheBytes + (options.retainedBytes ?? 0) + nativePlaneBytes < budgetBytes
  ) {
    sourceStrides = overviewStrides(
      sourceCounts(),
      sourceSpacing,
      (strides) => memory(strides).totalBytes <= budgetBytes,
    );
    memoryPlan = memory();
  }
  const counts = sourceCounts();
  const dims = sourceAxes.map((axis) => counts[axis]!) as Triple;
  const voxelSizeMm = sourceAxes.map((axis) => sourceSpacing[axis]! * sourceStrides[axis]!) as Triple;
  const firstVoxel = [...cropMin] as Triple;
  sourceAxes.forEach((axis, outputAxis) => {
    if (sourceFlips[outputAxis] === -1) firstVoxel[axis] = cropMin[axis]! + (counts[axis]! - 1) * sourceStrides[axis]!;
  });
  const delta = rotatePoint(sourceDirection, firstVoxel.map((value, axis) => value * sourceSpacing[axis]!) as Triple);
  const originMm = acceptedOrigin.map((value, axis) => value + delta[axis]!) as Triple;
  const boundsMm = physicalVolumeBounds({ dims, voxelSizeMm, direction, originMm });
  if ([...originMm, ...boundsMm.min, ...boundsMm.max].some((value) => !Number.isFinite(value)))
    throw new Error('The source stack has unrepresentable native patient-space bounds.');
  return {
    dims,
    voxelSizeMm,
    nativeVoxelSizeMm,
    direction,
    originMm,
    boundsMm,
    sourceDims,
    cropMin,
    cropMax,
    sourceStrides,
    sourceAxes,
    sourceFlips,
    frames,
    sourceBytes,
    decodedCacheBytes,
    memoryPlan,
    totalBytes: memoryPlan.totalBytes,
    budgetBytes,
    overview: sourceStrides.some((stride) => stride > 1),
  };
}

export type NativeFrameSamples = {
  pixels: ArrayLike<number>;
  slope?: number;
  intercept?: number;
  pixelPaddingValue?: number;
  pixelPaddingRangeLimit?: number;
  invert?: boolean;
};

/** One decoded frame at a time; ROI extraction precedes any source-copy allocation. */
export async function assembleNativeVolume(
  plan: NativeVolumePlan,
  readFrame: (frame: NativeFrame) => Promise<NativeFrameSamples>,
  options: { signal?: AbortSignal; onProgress?: (current: number, total: number) => void } = {},
): Promise<SvrVolume> {
  if (plan.totalBytes > plan.budgetBytes)
    throw new Error(
      'This native-resolution region exceeds the browser memory budget. Select a smaller region or clear the previous volume; native detail will not be silently reduced.',
    );
  assertNotAborted(options.signal);
  const data = new Float32Array(plan.dims[0] * plan.dims[1] * plan.dims[2]);
  const observedSupport = new Uint8Array(data.length);
  const outputStrides = [1, plan.dims[0], plan.dims[0] * plan.dims[1]];
  const sourceWeights: Triple = [0, 0, 0];
  let flippedOrigin = 0;
  plan.sourceAxes.forEach((axis, outputAxis) => {
    sourceWeights[axis] = outputStrides[outputAxis]! * plan.sourceFlips[outputAxis]!;
    if (plan.sourceFlips[outputAxis] === -1) flippedOrigin += (plan.dims[outputAxis]! - 1) * outputStrides[outputAxis]!;
  });
  let displayInvert = false;
  let minimum = Infinity,
    maximum = -Infinity,
    supportedVoxelCount = 0;
  const frames = plan.frames.filter(
    ({ slice }) =>
      slice >= plan.cropMin[2] && slice <= plan.cropMax[2] && (slice - plan.cropMin[2]) % plan.sourceStrides[2] === 0,
  );
  for (const [position, { frame, slice }] of frames.entries()) {
    assertNotAborted(options.signal);
    const source = await waitForNativeFrame(readFrame(frame), options.signal);
    assertNotAborted(options.signal);
    if (position === 0) displayInvert = Boolean(source.invert);
    else if (displayInvert !== Boolean(source.invert))
      throw new Error(
        'Native source frames disagree on photometric inversion. Review their original slices separately.',
      );
    if (source.pixels.length !== frame.rows * frame.columns)
      throw new Error('A native frame no longer matches its accepted pixel geometry.');
    const slope = Number.isFinite(source.slope) ? source.slope! : 1,
      intercept = Number.isFinite(source.intercept) ? source.intercept! : 0;
    const padding = source.pixelPaddingValue;
    const limit = Number.isFinite(source.pixelPaddingRangeLimit) ? source.pixelPaddingRangeLimit! : padding;
    const hasPadding = Number.isFinite(padding);
    const sliceBase = flippedOrigin + ((slice - plan.cropMin[2]) / plan.sourceStrides[2]) * sourceWeights[2];
    for (let row = plan.cropMin[1]; row <= plan.cropMax[1]; row += plan.sourceStrides[1]) {
      const rowBase = sliceBase + ((row - plan.cropMin[1]) / plan.sourceStrides[1]) * sourceWeights[1];
      for (let column = plan.cropMin[0]; column <= plan.cropMax[0]; column += plan.sourceStrides[0]) {
        const stored = source.pixels[row * frame.columns + column]!;
        if (
          !Number.isFinite(stored) ||
          (hasPadding && stored >= Math.min(padding!, limit!) && stored <= Math.max(padding!, limit!))
        )
          continue;
        const value = stored * slope + intercept;
        if (!Number.isFinite(value) || Math.abs(value) > 3.4028234663852886e38)
          throw new Error('A native source contains invalid modality-scaled intensities.');
        const index = rowBase + ((column - plan.cropMin[0]) / plan.sourceStrides[0]) * sourceWeights[0];
        data[index] = value;
        observedSupport[index] = 1;
        supportedVoxelCount++;
        minimum = Math.min(minimum, data[index]!);
        maximum = Math.max(maximum, data[index]!);
      }
    }
    options.onProgress?.(position + 1, frames.length);
    await yieldToMain();
  }
  assertNotAborted(options.signal);
  if (!supportedVoxelCount) throw new Error('The native source region contains no finite acquired pixels.');
  const center = frames[0]?.frame.windowCenter,
    width = frames[0]?.frame.windowWidth;
  const intensityRange: [number, number] = [minimum, maximum > minimum ? maximum : minimum + 1];
  const displayWindow: [number, number] =
    Number.isFinite(center) && Number.isFinite(width) && width! > 0
      ? [center! - 0.5 - Math.max(0, width! - 1) / 2, center! - 0.5 + Math.max(0, width! - 1) / 2]
      : intensityRange;
  return {
    data,
    observedSupport,
    supportedVoxelCount,
    dims: plan.dims,
    voxelSizeMm: plan.voxelSizeMm,
    nativeVoxelSizeMm: plan.nativeVoxelSizeMm,
    direction: plan.direction,
    originMm: plan.originMm,
    boundsMm: plan.boundsMm,
    intensityRange,
    displayWindow,
    displayInvert,
    acquiredOrientationCount: 1,
  };
}
