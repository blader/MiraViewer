import type { SvrRoiPlane, SvrSelectionPlane, SvrVolume } from '../../types/svr';
import type { NativeSourceGrid } from '../svr/nativeSourceContext';
import { IDENTITY_DIRECTION, patientToVolumeVoxel, volumeVoxelToPatient } from '../svr/volumeGeometry';
import { SLICE_AXES, selectionPlaneContainsMarks } from './selectionEditing';
import { voxelIndex, voxelPoint, type VoxelBounds } from './voxelGeometry';

const AXIS_INDEX = { x: 0, y: 1, z: 2 } as const;
const PLANE_BY_AXIS = ['sagittal', 'coronal', 'axial'] as const;
type Triple = [number, number, number];

function validateGrid(grid: NativeSourceGrid): number {
  const direction = grid.direction ?? IDENTITY_DIRECTION;
  const count = grid.dims.reduce((product, size) => product * size, 1);
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
  if (!valid) throw new Error('Interactive selection requires finite, orthonormal physical grids.');
  return count;
}

function validateVolume(volume: SvrVolume): number {
  const count = validateGrid(volume);
  if (volume.data.length !== count || (volume.observedSupport && volume.observedSupport.length !== count))
    throw new Error('Interactive source samples do not match their physical grid.');
  return count;
}

function planeAxes(plane: SvrRoiPlane): Triple {
  const axes = SLICE_AXES[plane];
  if (!axes) throw new Error('Interactive selection needs an explicit editing plane.');
  return [AXIS_INDEX[axes.column], AXIS_INDEX[axes.row], AXIS_INDEX[axes.slice]];
}

function mapping(source: NativeSourceGrid, target: NativeSourceGrid) {
  validateGrid(source);
  validateGrid(target);
  // Bound only arithmetic roundoff from the two patient-coordinate transforms.
  // This is not nearest-cell resampling: a genuinely fractional phase is rejected.
  const pitch = Math.min(...source.voxelSizeMm, ...target.voxelSizeMm);
  const scale = Math.max(
    1,
    ...source.dims,
    ...target.dims,
    ...source.originMm.map((value) => Math.abs(value) / pitch),
    ...target.originMm.map((value) => Math.abs(value) / pitch),
  );
  const tolerance = 64 * Number.EPSILON * scale;
  if (!Number.isFinite(tolerance) || tolerance > 1e-6)
    throw new Error('The physical grids cannot represent an exact native-cell phase reliably.');
  const point = (voxel: Triple) => patientToVolumeVoxel(target, volumeVoxelToPatient(source, voxel));
  const integer = (value: number) => {
    const rounded = Math.round(value);
    if (!Number.isSafeInteger(rounded) || Math.abs(value - rounded) > tolerance)
      throw new Error('The editing plane or mark does not coincide with an exact native-cell center.');
    return rounded === 0 ? 0 : rounded;
  };
  return { point, integer, tolerance };
}

/** Map the actual stored stroke section; never derive a plane from the cursor or project it onto a nearby slice. */
export function mapInteractivePlane(
  editingGrid: NativeSourceGrid,
  nativeGrid: NativeSourceGrid,
  stroke: SvrSelectionPlane,
): SvrSelectionPlane {
  const map = mapping(editingGrid, nativeGrid);
  const [column, row, slice] = planeAxes(stroke?.plane);
  if (!Number.isSafeInteger(stroke.slice) || stroke.slice < 0 || stroke.slice >= editingGrid.dims[slice]!)
    throw new Error('The editing plane lies outside its owning volume.');
  const first: Triple = [0, 0, 0];
  first[slice] = stroke.slice;
  const across = [...first] as Triple,
    down = [...first] as Triple;
  across[column] = Math.max(1, editingGrid.dims[column]! - 1);
  down[row] = Math.max(1, editingGrid.dims[row]! - 1);
  const origin = map.point(first),
    horizontal = map.point(across),
    vertical = map.point(down);
  const fixed = [0, 1, 2].filter(
    (axis) =>
      Math.abs(horizontal[axis]! - origin[axis]!) <= map.tolerance &&
      Math.abs(vertical[axis]! - origin[axis]!) <= map.tolerance,
  );
  if (fixed.length !== 1) throw new Error('The editing section is not coplanar with a native source plane.');
  const axis = fixed[0]!,
    index = map.integer(origin[axis]!);
  if (index < 0 || index >= nativeGrid.dims[axis]!)
    throw new Error('The real editing plane is outside the native source context.');
  return { plane: PLANE_BY_AXIS[axis]!, slice: index };
}

/** Map literal mark centers only. Passing a plane requires every mark to be on that actual section. */
export function mapInteractiveMarks(
  editingVolume: SvrVolume,
  nativeContext: SvrVolume,
  indices: Uint32Array,
  plane?: SvrSelectionPlane,
): Uint32Array {
  const count = validateVolume(editingVolume);
  validateVolume(nativeContext);
  if (!ArrayBuffer.isView(indices) || Object.prototype.toString.call(indices) !== '[object Uint32Array]')
    throw new Error('Interactive marks require native unsigned integer indices.');
  const map = mapping(editingVolume, nativeContext);
  if (plane) {
    mapInteractivePlane(editingVolume, nativeContext, plane);
    if (indices.length && !selectionPlaneContainsMarks(plane, indices, editingVolume.dims))
      throw new Error('Off-plane marks cannot be projected into an interactive prompt.');
  }
  return Uint32Array.from(indices, (index) => {
    if (
      index >= count ||
      !Number.isFinite(editingVolume.data[index]) ||
      (editingVolume.observedSupport && !editingVolume.observedSupport[index])
    )
      throw new Error('An editing mark has no finite acquired source sample.');
    const from = voxelPoint(index, editingVolume.dims);
    const point = map.point([from.x, from.y, from.z]).map(map.integer) as Triple;
    if (point.some((value, axis) => value < 0 || value >= nativeContext.dims[axis]!))
      throw new Error('An editing mark is outside the native source context.');
    const target = voxelIndex({ x: point[0], y: point[1], z: point[2] }, nativeContext.dims);
    if (
      !Number.isFinite(nativeContext.data[target]) ||
      (nativeContext.observedSupport && !nativeContext.observedSupport[target])
    )
      throw new Error('An editing mark has no finite acquired native-context sample.');
    return target;
  });
}

/**
 * Stream complete real context planes, column-fast with increasing native axes.
 * UI row flips, photometric inversion, tone and model normalization are not applied.
 * Output offsets describe a separate crop; they never resize or truncate model input.
 */
export function createInteractivePlaneReader(context: SvrVolume, plane: SvrRoiPlane, outputBounds: VoxelBounds) {
  validateVolume(context);
  const [column, row, slice] = planeAxes(plane);
  const minimum: Triple = [outputBounds.min.x, outputBounds.min.y, outputBounds.min.z];
  const maximum: Triple = [outputBounds.max.x, outputBounds.max.y, outputBounds.max.z];
  if (
    minimum.some(
      (value, axis) =>
        !Number.isSafeInteger(value) ||
        !Number.isSafeInteger(maximum[axis]) ||
        value < 0 ||
        value > maximum[axis]! ||
        maximum[axis]! >= context.dims[axis]!,
    )
  )
    throw new Error('The output crop must contain exact cells inside the complete native context.');
  const { data, observedSupport } = context;
  const dims = [...context.dims] as Triple;
  const width = dims[column]!,
    height = dims[row]!,
    frameCount = dims[slice]!;
  const strides: Triple = [1, dims[0], dims[0] * dims[1]];
  const abort = (signal?: AbortSignal) => {
    if (signal?.aborted) throw new DOMException('Interactive source reading canceled.', 'AbortError');
  };
  return {
    width,
    height,
    frameCount,
    spacingMm: [context.voxelSizeMm[column]!, context.voxelSizeMm[row]!, context.voxelSizeMm[slice]!] as Triple,
    output: {
      columnOffset: minimum[column]!,
      rowOffset: minimum[row]!,
      frameOffset: minimum[slice]!,
      columns: maximum[column]! - minimum[column]! + 1,
      rows: maximum[row]! - minimum[row]! + 1,
      frames: maximum[slice]! - minimum[slice]! + 1,
    },
    readFrame(index: number, signal?: AbortSignal): Float32Array {
      abort(signal);
      if (!Number.isSafeInteger(index) || index < 0 || index >= frameCount)
        throw new Error('The requested tracking frame is outside the native context.');
      const pixels = new Float32Array(width * height);
      for (let y = 0; y < height; y++) {
        abort(signal);
        for (let x = 0; x < width; x++) {
          const from = index * strides[slice]! + y * strides[row]! + x * strides[column]!;
          if ((observedSupport && !observedSupport[from]) || !Number.isFinite(data[from]))
            throw new Error('The tracking context contains unavailable or nonfinite acquired source samples.');
          pixels[y * width + x] = data[from]!;
        }
      }
      return pixels;
    },
  };
}
