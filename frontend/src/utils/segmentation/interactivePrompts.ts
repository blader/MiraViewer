import type { SvrRoiPlane, SvrSelectionSeeds, SvrVolume } from '../../types/svr';
import type { NativeSourceGrid } from '../svr/nativeSourceContext';
import { mapInteractivePlane } from './interactiveGeometry';
import { SLICE_AXES } from './selectionEditing';
import { voxelPoint } from './voxelGeometry';

export type TrackingFramePrompts = {
  index: number;
  points: [number, number][];
  labels: (0 | 1)[];
};

/**
 * Group on the grid where the user painted, then map the representative marked
 * centers exactly. Mapping every coarse mark first would split one brush into
 * disconnected native points. This plan is shared by preflight and inference;
 * native sample/support validation still checks every literal mark after loading.
 */
export function planTrackingPrompts(editing: SvrVolume, nativeGrid: NativeSourceGrid, seeds: SvrSelectionSeeds) {
  if (!seeds.lastStroke) throw new Error('Add a mark on a source slice before growing the selection.');
  const stroke = mapInteractivePlane(editing, nativeGrid, seeds.lastStroke);
  const editingAxes = SLICE_AXES[seeds.lastStroke.plane];
  const nativeAxes = SLICE_AXES[stroke.plane];
  const planes = { x: 'sagittal', y: 'coronal', z: 'axial' } as const;
  const frames = collectTrackingPrompts(editing, seeds.lastStroke.plane, seeds).map((frame) => {
    const section = mapInteractivePlane(editing, nativeGrid, { plane: seeds.lastStroke!.plane, slice: frame.index });
    return {
      index: section.slice,
      labels: frame.labels,
      points: frame.points.map(([column, row]): [number, number] => {
        const point = { x: 0, y: 0, z: 0 };
        for (const [axis, coordinate] of [
          [editingAxes.column, column],
          [editingAxes.row, row],
        ] as const) {
          const mapped = mapInteractivePlane(editing, nativeGrid, { plane: planes[axis], slice: coordinate });
          point[SLICE_AXES[mapped.plane].slice] = mapped.slice;
        }
        return [point[nativeAxes.column], point[nativeAxes.row]];
      }),
    };
  });
  frames.sort((a, b) => a.index - b.index);
  return {
    stroke,
    frames,
    conditioningFrames: frames.length,
    maximumFramePrompts: frames.reduce((maximum, frame) => Math.max(maximum, frame.points.length), 0),
    literalMarkCount: seeds.foreground.length + seeds.background.length,
  };
}

/**
 * One actual marked voxel nearest each connected component's physical centroid.
 * This compresses prompts, not hard marks: every original mark remains authoritative.
 * Marks on other sections stay on their own source section; none are projected.
 */
export function collectTrackingPrompts(
  source: Pick<SvrVolume, 'data' | 'observedSupport' | 'dims' | 'voxelSizeMm'>,
  plane: SvrRoiPlane,
  seeds: Pick<SvrSelectionSeeds, 'foreground' | 'background'>,
): TrackingFramePrompts[] {
  const axes = SLICE_AXES[plane];
  const positions = { x: 0, y: 1, z: 2 } as const;
  const count = source.dims.reduce((product, size) => product * size, 1);
  if (
    !axes ||
    source.dims.length !== 3 ||
    source.dims.some((size) => !Number.isSafeInteger(size) || size < 1) ||
    !Number.isSafeInteger(count) ||
    count !== source.data.length ||
    (source.observedSupport && source.observedSupport.length !== count) ||
    source.voxelSizeMm.length !== 3 ||
    source.voxelSizeMm.some((pitch) => !Number.isFinite(pitch) || pitch <= 0)
  )
    throw new Error('Interactive prompts require matching acquired source geometry.');
  const width = source.dims[positions[axes.column]]!;
  const height = source.dims[positions[axes.row]]!;
  const columnPitch = source.voxelSizeMm[positions[axes.column]]!;
  const rowPitch = source.voxelSizeMm[positions[axes.row]]!;
  const sections = new Map<number, { inside: Set<number>; outside: Set<number> }>();
  const claimed = new Set<number>();
  for (const [indices, kind] of [
    [seeds.foreground, 'inside'],
    [seeds.background, 'outside'],
  ] as const) {
    for (const index of indices) {
      if (
        !Number.isSafeInteger(index) ||
        index < 0 ||
        index >= count ||
        !Number.isFinite(source.data[index]) ||
        (source.observedSupport && !source.observedSupport[index])
      )
        throw new Error('Interactive prompts must be literal marks on acquired source samples.');
      if (kind === 'outside' && claimed.has(index))
        throw new Error('A source voxel cannot be marked both inside and outside.');
      if (kind === 'inside') claimed.add(index);
      const point = voxelPoint(index, source.dims);
      const section = sections.get(point[axes.slice]) ?? { inside: new Set(), outside: new Set() };
      section[kind].add(point[axes.row] * width + point[axes.column]);
      sections.set(point[axes.slice], section);
    }
  }
  return [...sections.entries()]
    .sort(([a], [b]) => a - b)
    .map(([index, section]) => {
      const result: TrackingFramePrompts = { index, points: [], labels: [] };
      for (const [marks, label] of [
        [section.inside, 1],
        [section.outside, 0],
      ] as const) {
        // Keep first-mark component order, as supplied by the editing history.
        // Equal-distance choices use the owning grid's index order, before any mapping.
        for (const first of [...marks]) {
          if (!marks.delete(first)) continue;
          const component = [first];
          let columnSum = 0,
            rowSum = 0;
          for (let cursor = 0; cursor < component.length; cursor++) {
            const current = component[cursor]!;
            const x = current % width,
              y = Math.floor(current / width);
            columnSum += x;
            rowSum += y;
            for (let dy = -1; dy <= 1; dy++)
              for (let dx = -1; dx <= 1; dx++) {
                if ((!dx && !dy) || x + dx < 0 || x + dx >= width || y + dy < 0 || y + dy >= height) continue;
                const neighbor = (y + dy) * width + x + dx;
                if (marks.delete(neighbor)) component.push(neighbor);
              }
          }
          const centerColumn = columnSum / component.length,
            centerRow = rowSum / component.length;
          let selected = first,
            bestDistance = Infinity;
          for (const candidate of component) {
            const distance =
              (((candidate % width) - centerColumn) * columnPitch) ** 2 +
              ((Math.floor(candidate / width) - centerRow) * rowPitch) ** 2;
            if (distance < bestDistance || (distance === bestDistance && candidate < selected)) {
              selected = candidate;
              bestDistance = distance;
            }
          }
          result.points.push([selected % width, Math.floor(selected / width)]);
          result.labels.push(label);
        }
      }
      return result;
    });
}
