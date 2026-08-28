import type { SvrLabelVolume, SvrVolume } from '../../types/svr';
import { IDENTITY_DIRECTION, patientToVolumeVoxel, volumeVoxelToPatient } from './volumeGeometry';
import { yieldToMain } from './svrUtils';

type AnnotationGrid = Pick<SvrVolume, 'dims' | 'voxelSizeMm' | 'originMm' | 'direction'>;
type TransferOptions = {
  signal?: AbortSignal;
  /** Omitted only for validated stored annotations whose source pixels are not resident. */
  sourceSupported?: (index: number) => boolean;
  targetSupported: (index: number) => boolean;
};

function validateGrid(grid: AnnotationGrid): number {
  const count = grid.dims.reduce((product, size) => product * size, 1);
  const direction = grid.direction ?? IDENTITY_DIRECTION;
  let valid =
    grid.dims.length === 3 &&
    grid.dims.every((size) => Number.isSafeInteger(size) && size > 0) &&
    Number.isSafeInteger(count) &&
    grid.voxelSizeMm.length === 3 &&
    grid.voxelSizeMm.every((spacing) => Number.isFinite(spacing) && spacing > 0) &&
    grid.originMm.length === 3 &&
    grid.originMm.every(Number.isFinite) &&
    direction.length === 9 &&
    direction.every(Number.isFinite);
  for (let a = 0; a < 3; a++)
    for (let b = a; b < 3; b++) {
      const product =
        direction[a]! * direction[b]! + direction[a + 3]! * direction[b + 3]! + direction[a + 6]! * direction[b + 6]!;
      valid &&= Math.abs(product - (a === b ? 1 : 0)) <= 1e-4;
    }
  if (!valid) throw new Error('Selection transfer requires finite, orthonormal physical grid geometry.');
  return count;
}

/**
 * One categorical annotation transfer for refinement and explicit saved-draft copies.
 * It never constructs MRI pixels, writes inputs, interpolates label IDs, or drops hard marks.
 */
export async function transferSelectionAnnotations(
  source: AnnotationGrid,
  labels: SvrLabelVolume,
  target: AnnotationGrid,
  { signal, sourceSupported, targetSupported }: TransferOptions,
): Promise<SvrLabelVolume> {
  const abort = () => {
    if (signal?.aborted) throw new DOMException('Selection transfer canceled.', 'AbortError');
  };
  abort();
  const sourceCount = validateGrid(source),
    targetCount = validateGrid(target);
  if (
    !ArrayBuffer.isView(labels.data) ||
    Object.prototype.toString.call(labels.data) !== '[object Uint8Array]' ||
    labels.data.length !== sourceCount ||
    labels.dims.length !== 3 ||
    labels.dims.some((size, axis) => size !== source.dims[axis])
  )
    throw new Error('The selection cannot be transferred from a different reconstruction geometry.');
  const inputMarks = labels.seeds;
  if (
    inputMarks &&
    [inputMarks.foreground, inputMarks.background].some(
      (marks) => !ArrayBuffer.isView(marks) || Object.prototype.toString.call(marks) !== '[object Uint32Array]',
    )
  )
    throw new Error('The selection has invalid editing marks; its original remains unchanged.');
  const inside = new Set(inputMarks?.foreground),
    outside = new Set(inputMarks?.background);
  for (const [marks, isInside] of [
    [inside, true],
    [outside, false],
  ] as const) {
    let processed = 0;
    for (const index of marks) {
      if (processed++ % 4096 === 0) {
        await yieldToMain();
        abort();
      }
      if (
        index >= sourceCount ||
        (sourceSupported && !sourceSupported(index)) ||
        (isInside ? labels.data[index] === 0 || outside.has(index) : labels.data[index] !== 0)
      )
        throw new Error(
          'An inside or outside mark has inconsistent or unsupported source evidence. The original selection is retained.',
        );
    }
  }
  const offset = patientToVolumeVoxel(source, target.originMm);
  const steps = [0, 1, 2].map((axis) => {
    const point: [number, number, number] = [0, 0, 0];
    point[axis] = 1;
    return patientToVolumeVoxel(source, volumeVoxelToPatient(target, point)).map(
      (value, index) => value - offset[index]!,
    );
  });
  const data = new Uint8Array(targetCount);
  const foreground = new Set<number>(),
    background = new Set<number>();
  const [nx, ny, nz] = target.dims,
    [sx, sy, sz] = source.dims;
  for (let index = 0; index < data.length; index++) {
    if (index % 65_536 === 0) {
      await yieldToMain();
      abort();
    }
    if (!targetSupported(index)) continue;
    const tx = index % nx,
      ty = Math.floor(index / nx) % ny,
      tz = Math.floor(index / (nx * ny));
    const x = Math.round(offset[0] + tx * steps[0]![0]! + ty * steps[1]![0]! + tz * steps[2]![0]!),
      y = Math.round(offset[1] + tx * steps[0]![1]! + ty * steps[1]![1]! + tz * steps[2]![1]!),
      z = Math.round(offset[2] + tx * steps[0]![2]! + ty * steps[1]![2]! + tz * steps[2]![2]!);
    if (x < 0 || y < 0 || z < 0 || x >= sx || y >= sy || z >= sz) continue;
    const from = (z * sy + y) * sx + x;
    if (sourceSupported && !sourceSupported(from)) continue;
    data[index] = labels.data[from]!;
    if (inside.has(from)) foreground.add(index);
    if (outside.has(from)) background.add(index);
  }
  // Reverse sampling can miss a one-cell mark when the destination is coarser.
  // Explicit source centers must also remain represented by supported target cells.
  for (const [marks, destination, opposite, isInside] of [
    [inside, foreground, background, true],
    [outside, background, foreground, false],
  ] as const) {
    let processed = 0;
    for (const from of marks) {
      if (processed++ % 4096 === 0) {
        await yieldToMain();
        abort();
      }
      const point = patientToVolumeVoxel(
        target,
        volumeVoxelToPatient(source, [from % sx, Math.floor(from / sx) % sy, Math.floor(from / (sx * sy))]),
      );
      const [x, y, z] = point.map(Math.round) as [number, number, number];
      const index = (z * ny + y) * nx + x;
      if (x < 0 || y < 0 || z < 0 || x >= nx || y >= ny || z >= nz || !targetSupported(index))
        throw new Error(
          'An inside or outside mark is outside this region or has no supported MRI sample. Choose a region that contains all marks; the original selection is retained.',
        );
      if (opposite.has(index))
        throw new Error(
          'Inside and outside marks would occupy the same cell on this grid. Load a finer region before transferring; the original selection is retained.',
        );
      data[index] = isInside ? labels.data[from]! : 0;
      destination.add(index);
    }
  }
  abort();
  return {
    data,
    dims: target.dims,
    meta: labels.meta,
    reviewState: 'draft',
    seeds: { foreground: Uint32Array.from(foreground), background: Uint32Array.from(background) },
  };
}
