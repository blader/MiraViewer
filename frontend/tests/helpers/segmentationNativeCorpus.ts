import { readFileSync, statSync } from 'node:fs';
import dicomParser from 'dicom-parser';
import type { SvrVolume } from '../../src/types/svr';
import { buildOutputPlaneGrid, outputGridPixelToWorld } from '../../src/utils/outputPlaneGrid';
import { getSliceGeometryFromInstance } from '../../src/utils/svr/dicomGeometry';
import { physicalVolumeBounds } from '../../src/utils/svr/volumeGeometry';
import {
  decodeAlignmentCorpusFrame,
  type AlignmentCorpusFrame,
  type AlignmentCorpusSeries,
  type loadAlignmentLosslessCodec,
} from './alignmentRealCorpus';
import { pixelFingerprint, retainedIntensityWindow, type NativeCorpusPlane } from './interSliceCorpus';

type NativeAnchorResult = {
  slice: number;
  kind: 'inside' | 'outside';
  point: readonly number[];
  voxels: number;
  selected: number;
};

/** Sparse frozen-annotation regression guard only; passing never proves a dense anatomical boundary. */
export function nativeAnchorRegressions(
  current: readonly NativeAnchorResult[],
  baseline: readonly NativeAnchorResult[],
) {
  const key = (anchor: NativeAnchorResult) => `${anchor.slice}:${anchor.kind}:${anchor.point.join(',')}`;
  const previous = new Map(baseline.map((anchor) => [key(anchor), anchor]));
  const updated = new Map(current.map((anchor) => [key(anchor), anchor]));
  return [...new Set([...previous.keys(), ...updated.keys()])].flatMap((anchor) => {
    const before = previous.get(anchor),
      after = updated.get(anchor);
    const reason =
      !before || !after || before.voxels !== after.voxels
        ? 'changed frozen anchor coverage'
        : after.kind === 'inside' && after.selected < before.selected
          ? 'lost previously retained inside tissue'
          : after.kind === 'outside' && after.selected > before.selected
            ? 'new outside leakage'
            : undefined;
    return reason ? [{ anchor, reason, baseline: before ?? null, candidate: after ?? null }] : [];
  });
}

/** A common source-only window; later heterogeneous examinations retain their full native signal range. */
export function segmentationDisplayWindow(frames: readonly NativeCorpusPlane[], fullRange: boolean) {
  if (!fullRange) return retainedIntensityWindow(frames);
  let lower = Infinity,
    upper = -Infinity;
  for (const frame of frames)
    for (let index = 0; index < frame.pixels.length; index++) {
      const value = frame.pixels[index]!;
      if (!Number.isFinite(value) || (frame.valid && !frame.valid[index])) continue;
      lower = Math.min(lower, value);
      upper = Math.max(upper, value);
    }
  if (!Number.isFinite(lower) || !Number.isFinite(upper) || upper <= lower)
    throw new Error('Native MRI display context must contain a finite signal range.');
  return { lower, upper, range: upper - lower, center: (lower + upper) / 2, width: upper - lower };
}

/** Independent six-neighbor audit of the whole native crop, not an anatomical accuracy score. */
export function nativeMaskTopology(mask: Uint8Array, dims: readonly number[], foreground: Uint32Array) {
  const [nx, ny, nz] = dims as [number, number, number];
  const plane = nx * ny;
  const visited = new Uint8Array(mask.length);
  const queue = new Uint32Array(mask.length);
  const seeds = new Set(foreground);
  const components = [];
  const selectedByDepth = new Array<number>(nz).fill(0);
  const faces = { xMin: 0, xMax: 0, yMin: 0, yMax: 0, zMin: 0, zMax: 0 };
  let selectedBoundaryVoxels = 0,
    selectedBoundaryBandVoxels = 0;
  for (let start = 0; start < mask.length; start++) {
    if (!mask[start] || visited[start]) continue;
    let head = 0,
      tail = 1,
      markedForeground = 0;
    queue[0] = start;
    visited[start] = 1;
    const add = (index: number) => {
      if (!mask[index] || visited[index]) return;
      visited[index] = 1;
      queue[tail++] = index;
    };
    while (head < tail) {
      const index = queue[head++]!;
      const x = index % nx,
        y = Math.floor(index / nx) % ny,
        z = Math.floor(index / plane);
      selectedByDepth[z]!++;
      if (seeds.has(index)) markedForeground++;
      if (x === 0) faces.xMin++;
      if (x === nx - 1) faces.xMax++;
      if (y === 0) faces.yMin++;
      if (y === ny - 1) faces.yMax++;
      if (z === 0) faces.zMin++;
      if (z === nz - 1) faces.zMax++;
      if (x === 0 || x === nx - 1 || y === 0 || y === ny - 1 || z === 0 || z === nz - 1) selectedBoundaryVoxels++;
      if (x <= 1 || x >= nx - 2 || y <= 1 || y >= ny - 2 || z <= 1 || z >= nz - 2) selectedBoundaryBandVoxels++;
      if (x > 0) add(index - 1);
      if (x < nx - 1) add(index + 1);
      if (y > 0) add(index - nx);
      if (y < ny - 1) add(index + nx);
      if (z > 0) add(index - plane);
      if (z < nz - 1) add(index + plane);
    }
    components.push({ voxels: tail, markedForeground });
  }
  return {
    components: components.sort((first, second) => second.voxels - first.voxels),
    orphanVoxels: components.reduce(
      (total, component) => total + (component.markedForeground ? 0 : component.voxels),
      0,
    ),
    selectedBoundaryVoxels,
    selectedBoundaryBandVoxels,
    faces,
    selectedByDepth,
  };
}

/** Diagnostic reproduction of the frozen fc6cd4ad appearance model; does not run segmentation or relabel voxels. */
export function auditNativeAppearance(
  volume: Pick<SvrVolume, 'data' | 'observedSupport'>,
  foreground: Uint32Array,
  background: Uint32Array,
  groups: readonly { label: string; indices: readonly number[] | Uint32Array }[],
) {
  const { data, observedSupport } = volume;
  const stride = Math.max(1, Math.floor(data.length / 4096));
  const included = new Set(foreground);
  const samples: number[] = [];
  const context: number[] = [];
  for (let index = 0; index < data.length; index += stride) {
    if ((observedSupport && !observedSupport[index]) || !Number.isFinite(data[index])) continue;
    samples.push(data[index]!);
    if (!included.has(index)) context.push(data[index]!);
  }
  samples.sort((first, second) => first - second);
  const valuesAt = (indices: readonly number[] | Uint32Array) => Array.from(indices, (index) => data[index]!);
  const inside = valuesAt(foreground),
    outside = valuesAt(background);
  let low = samples[Math.floor((samples.length - 1) * 0.01)] ?? 0;
  let high = samples[Math.floor((samples.length - 1) * 0.99)] ?? 1;
  const seedFallback = high - low <= 1e-8;
  if (seedFallback) {
    low = Math.min(samples[0] ?? Infinity, ...inside, ...outside);
    high = Math.max(samples.at(-1) ?? -Infinity, ...inside, ...outside);
  }
  const inverseRange = high - low > 1e-8 ? 1 / (high - low) : 0;
  const binAt = (value: number) => Math.max(0, Math.min(1, (value - low) * inverseRange)) * 63;
  const histogram = (values: readonly number[]) => {
    const counts = new Array<number>(64).fill(0);
    for (const value of values) counts[Math.round(binAt(value))]!++;
    return counts;
  };
  const histograms = {
    foreground: histogram(inside),
    explicitBackground: histogram(outside),
    implicitContext: histogram(context),
  };
  const densities = Object.fromEntries(
    Object.entries(histograms).map(([name, counts]) => [
      name,
      Array.from(
        { length: 64 },
        (_, bin) =>
          counts.reduce((sum, count, sample) => sum + count * Math.exp(-0.5 * ((bin - sample) / 2.5) ** 2), 0) /
            Math.max(
              1,
              counts.reduce((sum, count) => sum + count, 0),
            ) +
          1e-4,
      ),
    ]),
  );
  const uniform = Array.from(
    { length: 64 },
    (_, bin) =>
      Array.from({ length: 64 }, (_, sample) => Math.exp(-0.5 * ((bin - sample) / 2.5) ** 2) / 64).reduce(
        (sum, value) => sum + value,
        0,
      ) + 1e-4,
  );
  const implicitAffinity = densities.foreground!.map((density, bin) => {
    const negative = densities.implicitContext![bin]!;
    const affinity = density / (density + negative);
    return affinity < 0.5 && negative <= uniform[bin]! ? 0.5 : affinity;
  });
  const explicitAffinity = densities.foreground!.map(
    (density, bin) => density / (density + densities.explicitBackground![bin]!),
  );
  const affinityAt = (value: number, affinities: number[]) => {
    const bin = binAt(value),
      first = Math.floor(bin),
      last = Math.min(63, first + 1);
    return Math.fround(affinities[first]! + (affinities[last]! - affinities[first]!) * (bin - first));
  };
  const quantiles = (values: readonly number[]) => {
    const sorted = [...values].sort((first, second) => first - second);
    return Object.fromEntries(
      [0, 0.01, 0.1, 0.25, 0.5, 0.75, 0.9, 0.99, 1].map((q) => [
        q,
        sorted[Math.floor((sorted.length - 1) * q)] ?? null,
      ]),
    );
  };
  const summarize = (values: readonly number[]) => {
    const counts = histogram(values);
    return {
      count: values.length,
      quantiles: quantiles(values),
      occupiedBins: counts.flatMap((count, bin) => (count ? [{ bin, count }] : [])),
      withinForegroundRange: values.filter((value) => value >= Math.min(...inside) && value <= Math.max(...inside))
        .length,
      inOccupiedForegroundBin: values.filter((value) => histograms.foreground[Math.round(binAt(value))]! > 0).length,
      implicitAffinityQuantiles: quantiles(values.map((value) => affinityAt(value, implicitAffinity))),
      explicitAffinityQuantiles: quantiles(values.map((value) => affinityAt(value, explicitAffinity))),
      values: values.length <= 100 ? [...values].sort((first, second) => first - second) : undefined,
    };
  };
  return {
    normalization: {
      low,
      high,
      stride,
      sampleCount: samples.length,
      seedFallback,
      bins: 64,
      gaussianSigmaBins: 2.5,
      symmetricFloor: 1e-4,
    },
    foreground: summarize(inside),
    explicitBackground: summarize(outside),
    implicitContext: summarize(context),
    histograms,
    modelByBin: { densities, uniform, implicitAffinity, explicitAffinity },
    groups: groups.map((group) => ({ label: group.label, ...summarize(valuesAt(group.indices)) })),
  };
}

/** Direct acquired-grid section, with no interpolation or intensity conversion. */
export function nativeOrthogonalSection(
  volume: Pick<SvrVolume, 'data' | 'dims' | 'voxelSizeMm'>,
  mask: Uint8Array,
  axis: 'coronal' | 'sagittal',
  index: number,
) {
  const [nx, ny, nz] = volume.dims;
  const columns = axis === 'coronal' ? nx : ny;
  const pixels = new Float32Array(columns * nz);
  const labels = new Uint8Array(pixels.length);
  if (!Number.isInteger(index) || index < 0 || index >= (axis === 'coronal' ? ny : nx))
    throw new Error('The native orthogonal section lies outside its source crop.');
  for (let z = 0; z < nz; z++)
    for (let column = 0; column < columns; column++) {
      const source = axis === 'coronal' ? (z * ny + index) * nx + column : (z * ny + column) * nx + index;
      const destination = z * columns + column;
      pixels[destination] = volume.data[source]!;
      labels[destination] = mask[source]!;
    }
  return {
    pixels,
    labels,
    columns,
    rows: nz,
    spacing: [volume.voxelSizeMm[axis === 'coronal' ? 0 : 1], volume.voxelSizeMm[2]] as [number, number],
  };
}

/** Nearest-cell display only: preserve physical aspect and letterbox the full source-grid section. */
export function physicalAspectSection(
  pixels: Float32Array,
  columns: number,
  rows: number,
  spacing: readonly [number, number],
  background: number,
) {
  const output = new Float32Array(512 * 512).fill(background);
  const physicalWidth = columns * spacing[0],
    physicalHeight = rows * spacing[1];
  const scale = 512 / Math.max(physicalWidth, physicalHeight);
  const width = physicalWidth * scale,
    height = physicalHeight * scale;
  const left = (512 - width) / 2,
    top = (512 - height) / 2;
  for (let y = 0; y < 512; y++)
    for (let x = 0; x < 512; x++) {
      if (x + 0.5 < left || x + 0.5 >= left + width || y + 0.5 < top || y + 0.5 >= top + height) continue;
      const column = Math.min(columns - 1, Math.floor((x + 0.5 - left) / (scale * spacing[0])));
      const row = Math.min(rows - 1, Math.floor((y + 0.5 - top) / (scale * spacing[1])));
      output[y * 512 + x] = pixels[row * columns + column]!;
    }
  return output;
}

/** Original native modality values and padding support; never hydrate remote placeholders for this fixture. */
export async function decodeSegmentationNativeFrame(
  frame: AlignmentCorpusFrame,
  codec: ReturnType<typeof loadAlignmentLosslessCodec>,
) {
  if (statSync(frame.path).blocks === 0)
    throw new Error('This private MRI frame is not resident; no hydration attempted.');
  const bytes = readFileSync(frame.path);
  const dataset = dicomParser.parseDicom(new Uint8Array(bytes), { untilTag: 'x7fe00010' });
  if (dataset.string('x00080018')?.trim() !== frame.sopInstanceUid)
    throw new Error('The anonymous MRI source identity changed after inspection.');
  const slope = dataset.floatString('x00281053') ?? 1;
  const intercept = dataset.floatString('x00281052') ?? 0;
  const signed = dataset.uint16('x00280103') === 1;
  const paddingValue = dataset.elements.x00280120
    ? signed
      ? dataset.int16('x00280120')
      : dataset.uint16('x00280120')
    : undefined;
  const paddingLimit = dataset.elements.x00280121
    ? signed
      ? dataset.int16('x00280121')
      : dataset.uint16('x00280121')
    : paddingValue;
  const low =
    paddingValue === undefined ? NaN : Math.min(paddingValue * slope + intercept, paddingLimit! * slope + intercept);
  const high =
    paddingValue === undefined ? NaN : Math.max(paddingValue * slope + intercept, paddingLimit! * slope + intercept);
  const decoded = await decodeAlignmentCorpusFrame(frame, codec);
  const valid = Uint8Array.from(decoded.pixels, (value) =>
    Number(Number.isFinite(value) && !(value >= low && value <= high)),
  );
  return {
    ...decoded,
    valid,
    invert: dataset.string('x00280004') === 'MONOCHROME1',
    sourceKind: dataset.string('x00080008')?.includes('DERIVED') ? 'derived-view' : 'original-or-unspecified',
    fileHash: pixelFingerprint(bytes),
    pixelHash: pixelFingerprint(decoded.pixels),
    supportHash: pixelFingerprint(valid),
    studyDateHash: pixelFingerprint(Buffer.from(dataset.string('x00080020') ?? 'unknown')),
  };
}

export type NativeSegmentationCrop = {
  left: number;
  top: number;
  width: number;
  height: number;
  firstSlice: number;
  lastSlice: number;
};

export type OutsideBoundaryProbes = {
  radiusMm: number;
  slices: number[];
  outside: { point: [number, number]; outwardDirection: [number, number] }[];
};

/** Sparse source-reviewed development probes, never solver input or a dense tumor mask. */
export function evaluateOutsideBoundaryProbes(
  mask: Uint8Array,
  crop: NativeSegmentationCrop,
  spacing: readonly number[],
  definition: OutsideBoundaryProbes,
) {
  const at = (x: number, y: number, z: number) =>
    ((z - crop.firstSlice) * crop.height + y - crop.top) * crop.width + x - crop.left;
  const [sx, sy] = spacing;
  const anchors = definition.slices.flatMap((slice) =>
    definition.outside.map((anchor) => {
      const [x, y] = anchor.point;
      let voxels = 0,
        selected = 0;
      for (let dy = -Math.ceil(definition.radiusMm / sy!); dy <= Math.ceil(definition.radiusMm / sy!); dy++)
        for (let dx = -Math.ceil(definition.radiusMm / sx!); dx <= Math.ceil(definition.radiusMm / sx!); dx++) {
          if ((dx * sx!) ** 2 + (dy * sy!) ** 2 > definition.radiusMm ** 2) continue;
          voxels++;
          selected += Number(Boolean(mask[at(x + dx, y + dy, slice)]));
        }
      let outwardPixels = 0;
      for (let step = 0; step < 40; step++) {
        const px = x + anchor.outwardDirection[0] * step,
          py = y + anchor.outwardDirection[1] * step;
        if (
          px < crop.left ||
          py < crop.top ||
          px >= crop.left + crop.width ||
          py >= crop.top + crop.height ||
          !mask[at(px, py, slice)]
        )
          break;
        outwardPixels++;
      }
      return {
        slice,
        point: anchor.point,
        centerSelected: Boolean(mask[at(x, y, slice)]),
        voxels,
        selected,
        outwardSelectedRunMm:
          outwardPixels * Math.hypot(anchor.outwardDirection[0] * sx!, anchor.outwardDirection[1] * sy!),
      };
    }),
  );
  const voxels = anchors.reduce((total, anchor) => total + anchor.voxels, 0);
  const selected = anchors.reduce((total, anchor) => total + anchor.selected, 0);
  return {
    voxels,
    selected,
    leakageFraction: selected / voxels,
    maximumOutwardSelectedRunMm: Math.max(...anchors.map((anchor) => anchor.outwardSelectedRunMm)),
    anchors,
  };
}

/** Source-index cropping only: no inverse reconstruction, intensity normalization, or voxel interpolation. */
export async function loadSegmentationNativeRegion(
  source: AlignmentCorpusSeries,
  crop: NativeSegmentationCrop,
  codec: ReturnType<typeof loadAlignmentLosslessCodec>,
) {
  const first = source.frames[crop.firstSlice];
  if (
    !first ||
    !source.frames[crop.lastSlice] ||
    crop.lastSlice <= crop.firstSlice ||
    crop.left < 0 ||
    crop.top < 0 ||
    crop.left + crop.width > source.columns ||
    crop.top + crop.height > source.rows
  )
    throw new Error('The approved native crop is outside its source geometry.');
  const geometry = getSliceGeometryFromInstance(first);
  const spacing = source.frames[crop.firstSlice + 1]!.positionMm - first.positionMm;
  const dims: [number, number, number] = [crop.width, crop.height, crop.lastSlice - crop.firstSlice + 1];
  const voxelSizeMm: [number, number, number] = [geometry.colSpacingMm, geometry.rowSpacingMm, spacing];
  const point = outputGridPixelToWorld(buildOutputPlaneGrid(first), crop.top, crop.left);
  const volumeGeometry = {
    dims,
    voxelSizeMm,
    originMm: [point.x, point.y, point.z] as [number, number, number],
    direction: [
      geometry.rowDir.x,
      geometry.colDir.x,
      geometry.normalDir.x,
      geometry.rowDir.y,
      geometry.colDir.y,
      geometry.normalDir.y,
      geometry.rowDir.z,
      geometry.colDir.z,
      geometry.normalDir.z,
    ] as NonNullable<SvrVolume['direction']>,
  };
  const data = new Float32Array(dims[0] * dims[1] * dims[2]);
  const observedSupport = new Uint8Array(data.length);
  const sourceHashes = [];
  let displayInvert = false;
  for (let index = crop.firstSlice; index <= crop.lastSlice; index++) {
    const frame = source.frames[index]!;
    const currentGeometry = getSliceGeometryFromInstance(frame);
    const fields = ['imageOrientationPatient', 'pixelSpacing'] as const;
    if (
      frame.rows !== source.rows ||
      frame.columns !== source.columns ||
      fields.some((field) => frame[field] !== first[field]) ||
      Math.abs(frame.positionMm - first.positionMm - (index - crop.firstSlice) * spacing) > 1e-4
    )
      throw new Error('The selected native crop does not have a stable physical grid.');
    const delta = [
      currentGeometry.ippMm.x - geometry.ippMm.x,
      currentGeometry.ippMm.y - geometry.ippMm.y,
      currentGeometry.ippMm.z - geometry.ippMm.z,
    ];
    const tangential = (axis: typeof geometry.rowDir) =>
      Math.abs(delta[0]! * axis.x + delta[1]! * axis.y + delta[2]! * axis.z);
    if (tangential(geometry.rowDir) > 1e-4 || tangential(geometry.colDir) > 1e-4)
      throw new Error('Native planes drift within their image grid.');
    const decoded = await decodeSegmentationNativeFrame(frame, codec);
    if (index === crop.firstSlice) displayInvert = decoded.invert;
    else if (displayInvert !== decoded.invert) throw new Error('Native source display polarity changed.');
    for (let row = 0; row < crop.height; row++) {
      const start = (crop.top + row) * source.columns + crop.left;
      const destination = ((index - crop.firstSlice) * crop.height + row) * crop.width;
      data.set(decoded.pixels.subarray(start, start + crop.width), destination);
      observedSupport.set(decoded.valid.subarray(start, start + crop.width), destination);
    }
    if (
      pixelFingerprint(decoded.pixels) !== decoded.pixelHash ||
      pixelFingerprint(decoded.valid) !== decoded.supportHash
    )
      throw new Error('Native source buffers changed during ROI extraction.');
    sourceHashes.push({ index, file: decoded.fileHash, pixels: decoded.pixelHash, support: decoded.supportHash });
  }
  const volume: SvrVolume = {
    ...volumeGeometry,
    data,
    observedSupport,
    displayInvert,
    nativeVoxelSizeMm: [...voxelSizeMm],
    boundsMm: physicalVolumeBounds(volumeGeometry),
  };
  return { volume, sourceHashes, dataHash: pixelFingerprint(data), supportHash: pixelFingerprint(observedSupport) };
}
