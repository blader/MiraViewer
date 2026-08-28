import type { SvrLabelVolume, SvrParams, SvrRoi, SvrVolume } from '../../types/svr';
import { IDENTITY_DIRECTION, volumeVoxelToPatient } from './volumeGeometry';
import { transferSelectionAnnotations } from './annotationTransfer';

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
  const patientMin = [Infinity, Infinity, Infinity],
    patientMax = [-Infinity, -Infinity, -Infinity];
  const nativePitch = volume.nativeVoxelSizeMm;
  if (nativePitch && (nativePitch.length !== 3 || nativePitch.some((value) => !Number.isFinite(value) || value <= 0)))
    throw new Error('Native detail requires finite positive source sampling.');
  const direction = volume.direction ?? IDENTITY_DIRECTION;
  const nativeHalfExtents = nativePitch
    ? [0, 1, 2].map(
        (axis) =>
          (Math.abs(direction[axis * 3]!) * volume.voxelSizeMm[0] +
            Math.abs(direction[axis * 3 + 1]!) * volume.voxelSizeMm[1] +
            Math.abs(direction[axis * 3 + 2]!) * volume.voxelSizeMm[2]) /
          2,
      )
    : null;
  const [nx, ny] = volume.dims;
  const includeVoxel = (index: number) => {
    const point: [number, number, number] = [index % nx, Math.floor(index / nx) % ny, Math.floor(index / (nx * ny))];
    if (nativeHalfExtents) {
      const patient = volumeVoxelToPatient(volume, point);
      for (let axis = 0; axis < 3; axis++) {
        patientMin[axis] = Math.min(patientMin[axis]!, patient[axis]! - nativeHalfExtents[axis]!);
        patientMax[axis] = Math.max(patientMax[axis]!, patient[axis]! + nativeHalfExtents[axis]!);
      }
    } else {
      for (let axis = 0; axis < 3; axis++) {
        min[axis] = Math.min(min[axis]!, point[axis]!);
        max[axis] = Math.max(max[axis]!, point[axis]!);
      }
    }
  };
  for (let index = 0; index < labels.data.length; index++) {
    if (!labels.data[index] || (volume.observedSupport && !volume.observedSupport[index])) continue;
    includeVoxel(index);
  }
  if (!Number.isFinite(nativePitch ? patientMin[0] : min[0]))
    throw new Error('Mark a region before reconstructing its finer detail.');
  // Both explicit mark classes contribute their full voxel footprints, not just mask bounds.
  for (const seeds of [labels.seeds?.foreground, labels.seeds?.background])
    for (const index of seeds ?? []) {
      if (index >= volume.data.length) {
        if (nativePitch)
          throw new Error('A selection mark does not belong to this volume. The original selection is retained.');
        continue;
      }
      includeVoxel(index);
    }
  if (nativePitch) {
    // The independently displayed original MRI plane supplies wider context.
    // Native copying needs no inverse-solver/registration halo and must not
    // inflate a long narrow selection to a cube or lower its stored sampling.
    const haloMm = Math.max(2, 2 * Math.max(...nativePitch));
    return {
      mode: 'box',
      sourcePlane: 'axial',
      sourceSeriesUid,
      boundsMm: {
        min: patientMin.map((value) => value - haloMm) as [number, number, number],
        max: patientMax.map((value) => value + haloMm) as [number, number, number],
      },
    };
  }
  for (const x of [min[0]! - 0.5, max[0]! + 0.5])
    for (const y of [min[1]! - 0.5, max[1]! + 0.5])
      for (const z of [min[2]! - 0.5, max[2]! + 0.5]) {
        const point = volumeVoxelToPatient(volume, [x, y, z]);
        for (let axis = 0; axis < 3; axis++) {
          patientMin[axis] = Math.min(patientMin[axis]!, point[axis]!);
          patientMax[axis] = Math.max(patientMax[axis]!, point[axis]!);
        }
      }
  const side = Math.max(...patientMin.map((lower, axis) => patientMax[axis]! - lower)) + 24;
  const center = patientMin.map((lower, axis) => (lower + patientMax[axis]!) * 0.5);
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
      volume.dims.reduce((size, axis) => size * axis, 1) !== volume.data.length ||
      (volume.observedSupport && volume.observedSupport.length !== volume.data.length)
    ) {
      throw new Error('Selection transfer requires matching volume and physical support geometry.');
    }
  }
  return transferSelectionAnnotations(source, labels, target, {
    signal,
    sourceSupported: (index) =>
      (!source.observedSupport || Boolean(source.observedSupport[index])) && Number.isFinite(source.data[index]),
    targetSupported: (index) =>
      (!target.observedSupport || Boolean(target.observedSupport[index])) && Number.isFinite(target.data[index]),
  });
}
