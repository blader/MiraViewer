import type { SvrRoi, SvrSelectionSeeds, SvrVolume } from '../../types/svr';
import { mapInteractivePlane } from '../segmentation/interactiveGeometry';
import { SLICE_AXES } from '../segmentation/selectionEditing';
import { voxelPoint, type VoxelBounds } from '../segmentation/seededVolume';
import type { NativeSourceGrid } from './nativeSourceContext';
import { assertNotAborted, yieldToMain } from './svrUtils';
import { IDENTITY_DIRECTION, physicalVolumeBounds, volumeVoxelToPatient } from './volumeGeometry';

type Triple = [number, number, number];
const PLANES = ['sagittal', 'coronal', 'axial'] as const;
const AXIS_INDEX = { x: 0, y: 1, z: 2 } as const;

/** Initial source-only context policy; these are not fitted tumor sizes or an accuracy guarantee. */
const MINIMUM_FIELD_MM = 80;
const MARK_HALO_MM = 32;

/**
 * Keep literal marks and real acquired context, independently of the current mask.
 * The tracking axis includes the complete acquisition. In-plane fields are roughly
 * physically square, limited only by actual source edges; no padding or resampling.
 * Source limits may reduce the nominal field/halo, never exclude a literal mark.
 * This is metadata-only. Native loading, the exact crop copy and model residency
 * must be admitted together by the caller before allocating their working data.
 */
export function planInteractiveSelectionContext(
  editing: SvrVolume,
  source: NativeSourceGrid,
  seeds: SvrSelectionSeeds,
) {
  if (!seeds.lastStroke) throw new Error('Add a mark on a source slice before growing the selection.');
  const lastStroke = mapInteractivePlane(editing, source, seeds.lastStroke);
  const axes = SLICE_AXES[lastStroke.plane];
  const column = AXIS_INDEX[axes.column],
    row = AXIS_INDEX[axes.row],
    slice = AXIS_INDEX[axes.slice];
  const count = editing.dims.reduce((product, size) => product * size, 1);
  if (editing.data.length !== count || (editing.observedSupport && editing.observedSupport.length !== count))
    throw new Error('Selection marks do not match their acquired source grid.');
  for (const marks of [seeds.foreground, seeds.background])
    if (!ArrayBuffer.isView(marks) || Object.prototype.toString.call(marks) !== '[object Uint32Array]')
      throw new Error('Selection marks require unsigned integer native indices.');
  if (!seeds.foreground.length) throw new Error('Add an inside mark before growing the selection.');

  const lower: Triple = [Infinity, Infinity, Infinity],
    upper: Triple = [-Infinity, -Infinity, -Infinity];
  // Reuse the physical-plane mapper's exact phase checks, rather than rounding
  // marks with a second tolerance or allocating a fake full-source pixel array.
  const mapped = PLANES.map(() => new Map<number, ReturnType<typeof mapInteractivePlane>>());
  const conditioningSections = new Set<number>();
  for (const marks of [seeds.foreground, seeds.background])
    for (const index of marks) {
      if (
        index >= count ||
        !Number.isFinite(editing.data[index]) ||
        (editing.observedSupport && !editing.observedSupport[index])
      )
        throw new Error('A selection mark has no finite acquired source sample.');
      const point = voxelPoint(index, editing.dims);
      for (const [axis, coordinate] of [point.x, point.y, point.z].entries()) {
        let section = mapped[axis]!.get(coordinate);
        if (!section) {
          section = mapInteractivePlane(editing, source, { plane: PLANES[axis]!, slice: coordinate });
          mapped[axis]!.set(coordinate, section);
        }
        const nativeAxis = AXIS_INDEX[SLICE_AXES[section.plane].slice];
        lower[nativeAxis] = Math.min(lower[nativeAxis]!, section.slice);
        upper[nativeAxis] = Math.max(upper[nativeAxis]!, section.slice);
        if (nativeAxis === slice) conditioningSections.add(section.slice);
      }
    }
  const requestedFieldMm = Math.max(
    MINIMUM_FIELD_MM,
    ...[column, row].map(
      (axis) =>
        (upper[axis]! - lower[axis]! + 1 + 2 * Math.ceil(MARK_HALO_MM / source.voxelSizeMm[axis]!)) *
        source.voxelSizeMm[axis]!,
    ),
  );
  const fieldMm = Math.min(
    requestedFieldMm,
    source.dims[column]! * source.voxelSizeMm[column]!,
    source.dims[row]! * source.voxelSizeMm[row]!,
  );
  const minimum: Triple = [0, 0, 0],
    maximum = source.dims.map((size) => size - 1) as Triple;
  for (const axis of [column, row]) {
    const cells = Math.min(source.dims[axis]!, Math.ceil(fieldMm / source.voxelSizeMm[axis]!));
    if (cells < upper[axis]! - lower[axis]! + 1)
      throw new Error(
        'The real source field cannot fit all marks in a physically square context. Use a different source plane or review the marks.',
      );
    // Shift a complete field inward when an edge is near; do not center-crop away marks.
    const centered = Math.floor((lower[axis]! + upper[axis]! - cells + 1) / 2);
    minimum[axis] = Math.max(0, Math.min(centered, source.dims[axis]! - cells));
    maximum[axis] = minimum[axis]! + cells - 1;
  }
  const dims = source.dims.map((_, axis) => maximum[axis]! - minimum[axis]! + 1) as Triple;
  const grid: NativeSourceGrid = {
    dims,
    voxelSizeMm: [...source.voxelSizeMm],
    direction: source.direction ? [...source.direction] : undefined,
    originMm: volumeVoxelToPatient(source, minimum),
  };
  const contextVoxels = dims.reduce((product, size) => product * size, 1);
  const contextBytes = contextVoxels * (Float32Array.BYTES_PER_ELEMENT + Uint8Array.BYTES_PER_ELEMENT);
  if (!Number.isSafeInteger(contextBytes)) throw new Error('The marked context exceeds safe native-grid dimensions.');
  const bounds: VoxelBounds = {
    min: { x: minimum[0], y: minimum[1], z: minimum[2] },
    max: { x: maximum[0], y: maximum[1], z: maximum[2] },
  };
  const loaderRoi: SvrRoi = {
    mode: 'box',
    sourcePlane: lastStroke.plane,
    sourceSeriesUid: editing.sourceProvenance?.primarySeriesUid,
    // Oblique patient-axis bounds can load extra native cells. They are not model input.
    boundsMm: physicalVolumeBounds(grid),
  };
  return {
    bounds,
    grid,
    loaderRoi,
    lastStroke,
    contextVoxels,
    contextBytes,
    width: dims[column]!,
    height: dims[row]!,
    conditioningFrames: conditioningSections.size,
    physicalSizeMm: [dims[column]! * source.voxelSizeMm[column]!, dims[row]! * source.voxelSizeMm[row]!] as [
      number,
      number,
    ],
    frameCount: dims[slice]!,
  };
}

/**
 * Extract the exact planned real cells from an oversized patient-AABB load.
 * Owns fresh intensity/support buffers (5 bytes/cell) while the caller still owns
 * the loaded source. No display, labels, padding, interpolation or memory policy.
 */
export async function cropInteractiveSelectionContext(
  loaded: SvrVolume,
  desired: NativeSourceGrid,
  { signal }: { signal?: AbortSignal } = {},
): Promise<SvrVolume> {
  assertNotAborted(signal);
  const offsets: Triple = [0, 0, 0];
  for (const [axis, plane] of PLANES.entries()) {
    const first = mapInteractivePlane(desired, loaded, { plane, slice: 0 });
    const last = mapInteractivePlane(desired, loaded, { plane, slice: desired.dims[axis]! - 1 });
    if (
      first.plane !== plane ||
      last.plane !== plane ||
      last.slice - first.slice !== desired.dims[axis]! - 1 ||
      desired.voxelSizeMm[axis] !== loaded.voxelSizeMm[axis]
    )
      throw new Error('The loaded source does not contain the exact planned native sampling grid.');
    offsets[axis] = first.slice;
  }
  const loadedDirection = loaded.direction ?? IDENTITY_DIRECTION,
    desiredDirection = desired.direction ?? IDENTITY_DIRECTION;
  if (loadedDirection.some((value, index) => Math.abs(value - desiredDirection[index]!) > 1e-12))
    throw new Error('The loaded source changed the planned native axis directions.');
  const sourceCount = loaded.dims.reduce((product, size) => product * size, 1);
  if (loaded.data.length !== sourceCount || (loaded.observedSupport && loaded.observedSupport.length !== sourceCount))
    throw new Error('Loaded native samples do not match their physical grid.');
  const dims = [...desired.dims] as Triple;
  const count = dims.reduce((product, size) => product * size, 1);
  const data = new Float32Array(count),
    observedSupport = new Uint8Array(count);
  let supportedVoxelCount = 0;
  for (let z = 0; z < dims[2]; z++) {
    assertNotAborted(signal);
    for (let y = 0; y < dims[1]; y++) {
      const start = ((z + offsets[2]) * loaded.dims[1] + y + offsets[1]) * loaded.dims[0] + offsets[0];
      const target = (z * dims[1] + y) * dims[0];
      data.set(loaded.data.subarray(start, start + dims[0]), target);
      for (let x = 0; x < dims[0]; x++) {
        const support = loaded.observedSupport?.[start + x] ?? 1;
        observedSupport[target + x] = support;
        if (support && Number.isFinite(data[target + x])) supportedVoxelCount++;
      }
    }
    if (z % 8 === 0) await yieldToMain();
  }
  assertNotAborted(signal);
  const cropped: SvrVolume = {
    ...loaded,
    ...desired,
    dims,
    voxelSizeMm: [...desired.voxelSizeMm],
    originMm: [...desired.originMm],
    direction: desired.direction ? [...desired.direction] : undefined,
    data,
    observedSupport,
    supportedVoxelCount,
  };
  cropped.boundsMm = physicalVolumeBounds(cropped);
  return cropped;
}
