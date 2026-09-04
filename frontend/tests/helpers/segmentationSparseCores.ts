import { distanceToSegment, insideRing, type GoldenPolygon, type GoldenVolumeSection } from './segmentationGolden';

type Triple = readonly [number, number, number];

/** Canonical native axes only: origin + local index * signed integer stride, with no resampling. */
export type NativeSamplingGrid = {
  sourceGrid: string;
  dims: Triple;
  origin: Triple;
  stride: Triple;
};

export type SparseCoreReference = Omit<NativeSamplingGrid, 'stride'> & {
  sections: ReadonlyArray<
    Pick<GoldenVolumeSection, 'id' | 'fixedAxis' | 'fixedIndex' | 'acrossAxis' | 'verticalAxis'> & {
      patches: ReadonlyArray<{ label: 'inside' | 'outside' | 'uncertain'; polygon: GoldenPolygon }>;
    }
  >;
};

export type SparseCoreCandidate = NativeSamplingGrid & {
  mask: Uint8Array;
  /** Actual finite, acquired source coverage, never annotation coverage or a mask of reviewed patches. */
  support: Uint8Array;
};

function validateGrid(grid: NativeSamplingGrid) {
  if (
    typeof grid.sourceGrid !== 'string' ||
    !grid.sourceGrid ||
    ![grid.dims, grid.origin, grid.stride].every(
      (values) => Array.isArray(values) && values.length === 3 && values.every(Number.isSafeInteger),
    ) ||
    grid.dims.some((size) => size <= 0) ||
    grid.stride.some((step) => step === 0) ||
    !Number.isSafeInteger(grid.dims.reduce((count, size) => count * size, 1)) ||
    grid.dims.some((size, axis) => !Number.isSafeInteger((size - 1) * grid.stride[axis]!)) ||
    grid.origin.some((start, axis) => !Number.isSafeInteger(start + (grid.dims[axis]! - 1) * grid.stride[axis]!))
  )
    throw new Error('Sparse cores require a named native grid with exact integer origin, dimensions, and strides.');
}

function nativeIndex(point: Triple, grid: NativeSamplingGrid): number | null {
  const offset = point.map((coordinate, axis) => coordinate - grid.origin[axis]!);
  const local = offset.map((coordinate, axis) => coordinate / grid.stride[axis]!);
  if (
    local.some(
      (coordinate, axis) =>
        !Number.isSafeInteger(offset[axis]) ||
        !Number.isSafeInteger(coordinate) ||
        coordinate * grid.stride[axis]! !== offset[axis] ||
        coordinate < 0 ||
        coordinate >= grid.dims[axis]!,
    )
  )
    return null;
  const index = (local[2]! * grid.dims[1] + local[1]!) * grid.dims[0] + local[0]!;
  return index === 0 ? 0 : index;
}

/** Null means this native voxel center is not represented, including centers outside the candidate extent. */
export function exactNativeIndex(point: Triple, grid: NativeSamplingGrid): number | null {
  validateGrid(grid);
  if (point.length !== 3 || !point.every(Number.isSafeInteger))
    throw new Error('Expected an exact native voxel center.');
  return nativeIndex(point, grid);
}

/**
 * Scoped consistency counts, not reference admission or an anatomical accuracy certificate.
 * Callers own independent target adjudication and artifact pins. No draft promotion, contour
 * interpolation, anatomical boundary, or full-mask pass is produced here. Unlisted voxels
 * remain unknown, and explicit uncertainty wins across all sections before any counts.
 */
export function evaluateSparseCores(reference: SparseCoreReference, candidate: SparseCoreCandidate) {
  validateGrid({ ...reference, stride: [1, 1, 1] });
  validateGrid(candidate);
  if (reference.sourceGrid !== candidate.sourceGrid) throw new Error('Cannot compare unrelated native source grids.');
  const count = candidate.dims.reduce((product, size) => product * size, 1);
  if (
    !candidate.mask ||
    !candidate.support ||
    candidate.mask.length !== count ||
    candidate.support.length !== count ||
    candidate.mask.some((value) => value !== 0 && value !== 1) ||
    candidate.support.some((value) => value !== 0 && value !== 1)
  )
    throw new Error('Sparse core masks and acquired support must be binary and match the candidate grid.');
  if (!Array.isArray(reference.sections)) throw new Error('Sparse core references need explicit source sections.');
  const labels = new Map<string, { point: [number, number, number]; bits: number }>();
  const ids = new Set<string>();
  for (const section of reference.sections) {
    const { fixedAxis, fixedIndex, acrossAxis, verticalAxis } = section;
    if (
      typeof section.id !== 'string' ||
      !section.id ||
      ids.has(section.id) ||
      ![fixedAxis, acrossAxis, verticalAxis].every((axis) => [0, 1, 2].includes(axis)) ||
      new Set([fixedAxis, acrossAxis, verticalAxis]).size !== 3 ||
      !Number.isSafeInteger(fixedIndex) ||
      fixedIndex < reference.origin[fixedAxis] ||
      fixedIndex >= reference.origin[fixedAxis] + reference.dims[fixedAxis] ||
      !Array.isArray(section.patches)
    )
      throw new Error('Sparse core sections need unique identities and exact native axes and coordinates.');
    ids.add(section.id);
    for (const patch of section.patches) {
      const bits = patch.label === 'inside' ? 1 : patch.label === 'outside' ? 2 : patch.label === 'uncertain' ? 4 : 0;
      const polygon = patch.polygon;
      if (
        !bits ||
        !Array.isArray(polygon) ||
        polygon.length < 3 ||
        !polygon.every((point) => Array.isArray(point) && point.length === 2 && point.every(Number.isFinite)) ||
        Math.abs(
          polygon.reduce((area, point, i) => {
            const next = polygon[(i + 1) % polygon.length]!;
            return area + point[0] * next[1] - next[0] * point[1];
          }, 0),
        ) < 1e-9 ||
        polygon.some((point) =>
          [acrossAxis, verticalAxis].some(
            (axis, i) =>
              point[i]! < reference.origin[axis]! - 0.5 ||
              point[i]! > reference.origin[axis]! + reference.dims[axis]! - 0.5,
          ),
        )
      )
        throw new Error(
          'Sparse core patches need explicit labels and finite nondegenerate polygons in the source grid.',
        );
      const lower = [acrossAxis, verticalAxis].map((axis, i) =>
        Math.max(reference.origin[axis]!, Math.ceil(Math.min(...polygon.map((point) => point[i]!)))),
      );
      const upper = [acrossAxis, verticalAxis].map((axis, i) =>
        Math.min(
          reference.origin[axis]! + reference.dims[axis]! - 1,
          Math.floor(Math.max(...polygon.map((point) => point[i]!))),
        ),
      );
      for (let row = lower[1]!; row <= upper[1]!; row++)
        for (let column = lower[0]!; column <= upper[0]!; column++) {
          const point = [column, row] as const;
          if (
            !insideRing(point, polygon) &&
            !polygon.some((vertex, i) => distanceToSegment(point, [vertex, polygon[(i + 1) % polygon.length]!]) < 1e-8)
          )
            continue;
          const native: [number, number, number] = [0, 0, 0];
          native[fixedAxis] = fixedIndex;
          native[acrossAxis] = column;
          native[verticalAxis] = row;
          const key = native.join(',');
          const existing = labels.get(key);
          if (existing) existing.bits |= bits;
          else labels.set(key, { point: native, bits });
        }
    }
  }

  const counts = () => ({
    referenceVoxels: 0,
    denominator: 0,
    selected: 0,
    unsampledReferenceVoxels: 0,
    unsupportedReferenceVoxels: 0,
  });
  const inside = counts(),
    outside = counts();
  let explicitUncertainReferenceVoxels = 0,
    uncertaintyOverrides = 0;
  for (const { point, bits } of labels.values()) {
    if (bits & 4) {
      explicitUncertainReferenceVoxels++;
      if (bits & 3) uncertaintyOverrides++;
      continue;
    }
    if (bits === 3) throw new Error('Sparse core references contradict one another at a native voxel.');
    const core = bits === 1 ? inside : outside;
    core.referenceVoxels++;
    const index = nativeIndex(point, candidate);
    if (index === null) core.unsampledReferenceVoxels++;
    else if (!candidate.support[index]) core.unsupportedReferenceVoxels++;
    else {
      core.denominator++;
      core.selected += candidate.mask[index]!;
    }
  }
  let supportedSelections = 0,
    unsupportedSelections = 0;
  for (let i = 0; i < count; i++)
    if (candidate.mask[i]) {
      if (candidate.support[i]) supportedSelections++;
      else unsupportedSelections++;
    }
  const { selected: hits, ...insideCounts } = inside;
  const { selected: selections, ...outsideCounts } = outside;
  return {
    scope: 'sparse-core-consistency' as const,
    sourceGrid: reference.sourceGrid,
    inside: { ...insideCounts, hits, misses: inside.denominator - hits },
    outside: { ...outsideCounts, selections, rejections: outside.denominator - selections },
    // Counts are unique native voxels, never sums that double-count cross-plane intersections.
    unsampledReferenceVoxels: inside.unsampledReferenceVoxels + outside.unsampledReferenceVoxels,
    unsupportedReferenceVoxels: inside.unsupportedReferenceVoxels + outside.unsupportedReferenceVoxels,
    explicitUncertainReferenceVoxels,
    uncertaintyOverrides,
    supportedUnknownSelections: supportedSelections - hits - selections,
    unsupportedSelections,
  };
}
