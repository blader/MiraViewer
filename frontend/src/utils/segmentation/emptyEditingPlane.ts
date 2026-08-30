import type { SvrRoiPlane, SvrSelectionSeeds, SvrVolume } from '../../types/svr';
import { patientToVolumeVoxel, volumeVoxelToPatient } from '../svr/volumeGeometry';
import { yieldToMain } from '../svr/svrUtils';
import { SLICE_AXES } from './selectionEditing';

const AXIS = { x: 0, y: 1, z: 2 } as const;
type Triple = [number, number, number];

/**
 * A zero EDITING plane separates 26-connected cells only when consecutive
 * editing sections sample consecutive native frames. An empty native plane
 * between coarse editing sections is not a separator: [1,0,1] can sample [1,1].
 * The caller must already have validated the grids and literal mark ownership.
 */
export async function prepareEmptyEditingPlanePruning(
  native: SvrVolume,
  editing: SvrVolume,
  seeds: SvrSelectionSeeds,
  plane: SvrRoiPlane,
  anchor: number,
  signal: AbortSignal,
): Promise<null | ((frame: number, direction: 1 | -1, nativeMask: Uint8Array) => Promise<boolean>)> {
  signal.throwIfAborted();
  const trackingAxis = AXIS[SLICE_AXES[plane].slice];
  // Identical arithmetic to inverse categorical sampling in annotationTransfer.
  const offset = patientToVolumeVoxel(native, editing.originMm);
  const steps = [0, 1, 2].map((axis) => {
    const point: Triple = [0, 0, 0];
    point[axis] = 1;
    return patientToVolumeVoxel(native, volumeVoxelToPatient(editing, point)).map((value, i) => value - offset[i]!);
  });
  const pitch = Math.min(...native.voxelSizeMm, ...editing.voxelSizeMm);
  const scale = Math.max(
    1,
    ...native.dims,
    ...editing.dims,
    ...native.originMm.map((value) => Math.abs(value) / pitch),
    ...editing.originMm.map((value) => Math.abs(value) / pitch),
  );
  const tolerance = 64 * Number.EPSILON * scale;
  if (!Number.isFinite(tolerance) || tolerance > 1e-6) return null;
  const integer = (value: number) =>
    Number.isSafeInteger(Math.round(value)) && Math.abs(value - Math.round(value)) <= tolerance;
  if (![...offset, ...steps.flat()].every(integer)) return null;
  const phase = offset.map(Math.round),
    lattice = steps.map((step) => step.map(Math.round));
  const nativeToEditing: number[] = [];
  for (let axis = 0; axis < 3; axis++) {
    const active = [0, 1, 2].filter((editAxis) => lattice[editAxis]![axis] !== 0);
    if (active.length !== 1) return null;
    nativeToEditing[axis] = active[0]!;
    const error =
      Math.abs(offset[axis]! - phase[axis]!) +
      steps.reduce(
        (sum, step, editAxis) =>
          sum + (editing.dims[editAxis]! - 1) * Math.abs(step[axis]! - lattice[editAxis]![axis]!),
        0,
      );
    // Bound accumulated off-axis drift, not just the individual coefficients.
    if (error + tolerance > 1e-6) return null;
  }
  if (new Set(nativeToEditing).size !== 3) return null;
  const editingAxis = nativeToEditing[trackingAxis]!;
  const trackingStep = lattice[editingAxis]![trackingAxis]!;
  if (Math.abs(trackingStep) !== 1) return null;
  const mapped = (point: Triple): Triple =>
    [0, 1, 2].map((axis) =>
      Math.round(
        offset[axis]! + point[0] * steps[0]![axis]! + point[1] * steps[1]![axis]! + point[2] * steps[2]![axis]!,
      ),
    ) as Triple;
  for (const x of [0, editing.dims[0] - 1])
    for (const y of [0, editing.dims[1] - 1])
      for (const z of [0, editing.dims[2] - 1]) {
        const point: Triple = [x, y, z],
          actual = mapped(point);
        if (
          actual.some(
            (value, axis) =>
              value !==
              phase[axis]! +
                point.reduce((sum, coordinate, editAxis) => sum + coordinate * lattice[editAxis]![axis]!, 0),
          )
        )
          return null;
      }
  const inside = new Set(seeds.foreground),
    outside = new Set(seeds.background);
  if (!inside.size) return null;
  // Use ALL literal marks, not compressed prompts; off-anchor Remove marks also disable pruning.
  for (const indices of [inside, outside]) {
    let count = 0;
    for (const index of indices) {
      if (++count % 65_536 === 0) {
        await yieldToMain();
        signal.throwIfAborted();
      }
      if (index >= editing.data.length) return null;
      const point: Triple = [
        index % editing.dims[0],
        Math.floor(index / editing.dims[0]) % editing.dims[1],
        Math.floor(index / (editing.dims[0] * editing.dims[1])),
      ];
      if (mapped(point)[trackingAxis] !== anchor) return null;
    }
  }
  // The reader otherwise validates lazily. Pruning must not hide a corrupt future frame.
  for (let start = 0; start < native.data.length; start += 65_536) {
    await yieldToMain();
    signal.throwIfAborted();
    for (let i = start; i < Math.min(native.data.length, start + 65_536); i++)
      if (!Number.isFinite(native.data[i]) || (native.observedSupport && !native.observedSupport[i]))
        throw new Error('The tracking context contains unavailable or nonfinite acquired source samples.');
  }
  const inPlane = [0, 1, 2].filter((axis) => axis !== editingAxis);
  return async (frame, direction, nativeMask) => {
    signal.throwIfAborted();
    if (!Number.isSafeInteger(frame) || (frame - anchor) * direction <= 0) return false;
    const section = (frame - phase[trackingAxis]!) / trackingStep;
    if (!Number.isSafeInteger(section) || section < 0 || section >= editing.dims[editingAxis]!) return false;
    const point: Triple = [0, 0, 0];
    point[editingAxis] = section;
    let checked = 0;
    for (let row = 0; row < editing.dims[inPlane[1]!]!; row++)
      for (let column = 0; column < editing.dims[inPlane[0]!]!; column++) {
        if (++checked % 65_536 === 0) {
          await yieldToMain();
          signal.throwIfAborted();
        }
        point[inPlane[0]!] = column;
        point[inPlane[1]!] = row;
        const index = (point[2] * editing.dims[1] + point[1]) * editing.dims[0] + point[0];
        if (
          !Number.isFinite(editing.data[index]) ||
          (editing.observedSupport && !editing.observedSupport[index]) ||
          outside.has(index)
        )
          continue;
        if (inside.has(index)) return false;
        const nativePoint = mapped(point);
        // A candidate can inspect only its observed frame, never an unseen zero-initialized cell.
        if (nativePoint[trackingAxis] !== frame) return false;
        if (nativePoint.some((value, axis) => value < 0 || value >= native.dims[axis]!)) continue;
        if (nativeMask[(nativePoint[2] * native.dims[1] + nativePoint[1]) * native.dims[0] + nativePoint[0]])
          return false;
      }
    signal.throwIfAborted();
    return true;
  };
}
