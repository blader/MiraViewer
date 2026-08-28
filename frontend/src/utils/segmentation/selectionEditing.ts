import type { SvrLabelVolume, SvrRoiPlane, SvrVolume } from '../../types/svr';
import { voxelIndex, type VoxelPoint } from './seededVolume';

export const SLICE_AXES = {
  axial: {
    column: 'x',
    row: 'y',
    slice: 'z',
    label: 'Axial',
    horizontal: ['R', 'L'],
    vertical: ['A', 'P'],
    flipRows: false,
  },
  coronal: {
    column: 'x',
    row: 'z',
    slice: 'y',
    label: 'Coronal',
    horizontal: ['R', 'L'],
    vertical: ['S', 'I'],
    flipRows: true,
  },
  sagittal: {
    column: 'y',
    row: 'z',
    slice: 'x',
    label: 'Sagittal',
    horizontal: ['A', 'P'],
    vertical: ['S', 'I'],
    flipRows: true,
  },
} as const;
export const SELECTION_LABEL_META: SvrLabelVolume['meta'] = [
  { id: 1, name: 'Selected tissue', color: [103, 207, 193] },
];

/** A continuous in-plane physical brush; interpolation prevents holes between pointer events. */
export function physicalBrushIndices(
  volume: SvrVolume,
  plane: SvrRoiPlane,
  start: VoxelPoint,
  end: VoxelPoint,
  radiusMm: number,
): Uint32Array {
  const axes = SLICE_AXES[plane];
  const dimensions = { x: volume.dims[0], y: volume.dims[1], z: volume.dims[2] };
  const spacing = { x: volume.voxelSizeMm[0], y: volume.voxelSizeMm[1], z: volume.voxelSizeMm[2] };
  const radius = Math.max(0.1, Math.min(20, radiusMm));
  const columnRadius = Math.ceil(radius / spacing[axes.column]);
  const rowRadius = Math.ceil(radius / spacing[axes.row]);
  const steps = Math.max(
    1,
    Math.ceil(Math.max(Math.abs(end[axes.column] - start[axes.column]), Math.abs(end[axes.row] - start[axes.row])) * 2),
  );
  const selected = new Set<number>();
  for (let step = 0; step <= steps; step++) {
    const centerColumn = start[axes.column] + ((end[axes.column] - start[axes.column]) * step) / steps;
    const centerRow = start[axes.row] + ((end[axes.row] - start[axes.row]) * step) / steps;
    for (
      let row = Math.max(0, Math.floor(centerRow) - rowRadius);
      row <= Math.min(dimensions[axes.row] - 1, Math.ceil(centerRow) + rowRadius);
      row++
    ) {
      for (
        let column = Math.max(0, Math.floor(centerColumn) - columnRadius);
        column <= Math.min(dimensions[axes.column] - 1, Math.ceil(centerColumn) + columnRadius);
        column++
      ) {
        if (
          ((column - centerColumn) * spacing[axes.column]) ** 2 + ((row - centerRow) * spacing[axes.row]) ** 2 >
          radius ** 2
        )
          continue;
        const point = { ...end, [axes.column]: column, [axes.row]: row };
        const index = voxelIndex(point, volume.dims);
        if (
          index < 0 ||
          index >= volume.data.length ||
          (volume.observedSupport && !volume.observedSupport[index]) ||
          !Number.isFinite(volume.data[index])
        )
          continue;
        selected.add(index);
      }
    }
  }
  return Uint32Array.from(selected);
}

export type SelectionPatch = { indices: Uint32Array; before: Uint8Array; after: Uint8Array };

/** Sparse reversible changes; undo storage scales with an edit, not with the entire reconstruction. */
export function selectionPatch(before: Uint8Array, after: Uint8Array, candidates?: Uint32Array): SelectionPatch {
  if (before.length !== after.length) throw new Error('Selection edit geometry changed.');
  const changed: number[] = [];
  if (candidates) {
    for (const index of new Set(candidates))
      if (index < before.length && before[index] !== after[index]) changed.push(index);
  } else {
    for (let index = 0; index < before.length; index++) if (before[index] !== after[index]) changed.push(index);
  }
  const indices = Uint32Array.from(changed);
  return {
    indices,
    before: Uint8Array.from(indices, (index) => before[index]!),
    after: Uint8Array.from(indices, (index) => after[index]!),
  };
}

export function applySelectionPatch(data: Uint8Array, patch: SelectionPatch, direction: 'undo' | 'redo'): Uint8Array {
  const next = data.slice();
  const values = direction === 'undo' ? patch.before : patch.after;
  for (let offset = 0; offset < patch.indices.length; offset++) next[patch.indices[offset]!] = values[offset]!;
  return next;
}
