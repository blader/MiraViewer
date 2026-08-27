import type { SvrLabelVolume, SvrParams, SvrRoi, SvrVolume } from '../../types/svr';
import { yieldToMain } from './svrUtils';

/** A detail sampling request, not measured resolution. The shared memory planner may increase it. */
export const REGION_DETAIL_SPACING_MM = 0.5;

/** Refine accepted evidence, not unsaved controls. Existing registration may be recomputed, never silently removed. */
export function regionalRefinementParameters(accepted: SvrParams, roi: SvrRoi): SvrParams {
  // Without a focus region, roi-rigid preserves native DICOM geometry. Adding a
  // detail region must not unexpectedly introduce registration for that volume.
  const mode =
    accepted.seriesRegistrationMode === 'roi-rigid' && !accepted.roi ? 'none' : accepted.seriesRegistrationMode;
  return {
    ...accepted,
    targetVoxelSizeMm: REGION_DETAIL_SPACING_MM,
    seriesRegistrationMode: mode,
    roi: {
      ...roi,
      // A preview-series choice must not change a registered volume's reference.
      // Missing means retain the solver's existing source-count fallback.
      sourceSeriesUid: mode === 'none' ? roi.sourceSeriesUid : accepted.roi?.sourceSeriesUid,
    },
  };
}

/** Reuse the existing physical focus-box pipeline; a mask is not a new source image. */
export function selectionFocusRoi(volume: SvrVolume, labels: SvrLabelVolume, sourceSeriesUid?: string): SvrRoi {
  if (labels.data.length !== volume.data.length || labels.dims.some((size, axis) => size !== volume.dims[axis])) {
    throw new Error('The selection does not match the reconstruction.');
  }
  const min = [Infinity, Infinity, Infinity],
    max = [-Infinity, -Infinity, -Infinity];
  const [nx, ny] = volume.dims;
  for (let index = 0; index < labels.data.length; index++) {
    if (!labels.data[index] || (volume.observedSupport && !volume.observedSupport[index])) continue;
    const point = [index % nx, Math.floor(index / nx) % ny, Math.floor(index / (nx * ny))];
    for (let axis = 0; axis < 3; axis++) {
      min[axis] = Math.min(min[axis]!, point[axis]!);
      max[axis] = Math.max(max[axis]!, point[axis]!);
    }
  }
  if (!Number.isFinite(min[0])) throw new Error('Mark a region before reconstructing its finer detail.');
  // Include surrounding anatomy for review and both classes of growth marks.
  for (const seeds of [labels.seeds?.foreground, labels.seeds?.background])
    for (const index of seeds ?? []) {
      const point = [index % nx, Math.floor(index / nx) % ny, Math.floor(index / (nx * ny))];
      if (index >= volume.data.length) continue;
      for (let axis = 0; axis < 3; axis++) {
        min[axis] = Math.min(min[axis]!, point[axis]!);
        max[axis] = Math.max(max[axis]!, point[axis]!);
      }
    }
  const side = Math.max(...min.map((lower, axis) => (max[axis]! - lower + 1) * volume.voxelSizeMm[axis]!)) + 24;
  const center = min.map(
    (lower, axis) => volume.originMm[axis]! + (lower + max[axis]!) * 0.5 * volume.voxelSizeMm[axis]!,
  );
  return {
    mode: 'cube',
    sourcePlane: 'axial',
    sourceSeriesUid,
    boundsMm: {
      min: center.map((value) => value - side / 2) as [number, number, number],
      max: center.map((value) => value + side / 2) as [number, number, number],
    },
  };
}

/** Transfer annotations in patient millimeters, without treating them as new ground truth. */
export async function resampleSelectionForRefinement(
  source: SvrVolume,
  labels: SvrLabelVolume,
  target: SvrVolume,
  signal?: AbortSignal,
): Promise<SvrLabelVolume> {
  for (const volume of [source, target]) {
    if (
      volume.dims.some((size) => !Number.isSafeInteger(size) || size < 1) ||
      volume.dims.reduce((size, axis) => size * axis, 1) !== volume.data.length ||
      volume.voxelSizeMm.some((spacing) => !Number.isFinite(spacing) || spacing <= 0) ||
      volume.originMm.some((value) => !Number.isFinite(value)) ||
      (volume.observedSupport && volume.observedSupport.length !== volume.data.length)
    ) {
      throw new Error('Selection transfer requires matching volume and physical support geometry.');
    }
  }
  if (labels.data.length !== source.data.length || labels.dims.some((size, axis) => size !== source.dims[axis])) {
    throw new Error('The selection cannot be transferred from a different reconstruction geometry.');
  }
  const data = new Uint8Array(target.data.length);
  const seedClass = new Map<number, 1 | 2>();
  for (const index of labels.seeds?.foreground ?? []) seedClass.set(index, 1);
  for (const index of labels.seeds?.background ?? []) seedClass.set(index, 2);
  const foreground: number[] = [],
    background: number[] = [];
  const [nx, ny] = target.dims;
  const [sx, sy, sz] = source.dims;
  const mapping = target.dims.map((size, axis) =>
    Int32Array.from({ length: size }, (_, index) =>
      Math.round(
        (target.originMm[axis]! + index * target.voxelSizeMm[axis]! - source.originMm[axis]!) /
          source.voxelSizeMm[axis]!,
      ),
    ),
  );
  for (let index = 0; index < data.length; index++) {
    if (index % 65_536 === 0) {
      if (signal?.aborted) throw new DOMException('Selection transfer canceled.', 'AbortError');
      await yieldToMain();
    }
    if ((target.observedSupport && !target.observedSupport[index]) || !Number.isFinite(target.data[index])) continue;
    const x = mapping[0]![index % nx]!,
      y = mapping[1]![Math.floor(index / nx) % ny]!,
      z = mapping[2]![Math.floor(index / (nx * ny))]!;
    if (x < 0 || y < 0 || z < 0 || x >= sx || y >= sy || z >= sz) continue;
    const sourceIndex = (z * sy + y) * sx + x;
    if ((source.observedSupport && !source.observedSupport[sourceIndex]) || !Number.isFinite(source.data[sourceIndex]))
      continue;
    data[index] = labels.data[sourceIndex]!;
    const mark = seedClass.get(sourceIndex);
    if (mark) (mark === 1 ? foreground : background).push(index);
  }
  if (signal?.aborted) throw new DOMException('Selection transfer canceled.', 'AbortError');
  return {
    data,
    dims: target.dims,
    meta: labels.meta,
    reviewState: 'draft',
    seeds: { foreground: Uint32Array.from(foreground), background: Uint32Array.from(background) },
  };
}
