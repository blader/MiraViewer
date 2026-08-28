import type { SvrDirection, SvrPatientTransform, SvrVolume } from '../../types/svr';

export type PatientPoint = readonly [number, number, number];
export const IDENTITY_DIRECTION: SvrDirection = [1, 0, 0, 0, 1, 0, 0, 0, 1];
export const IDENTITY_PATIENT_TRANSFORM: SvrPatientTransform = {
  rotation: IDENTITY_DIRECTION,
  translationMm: [0, 0, 0],
};

/** Accepted poses are detached rigid snapshots, not mutable aliases of a registration workspace. */
export function snapshotPatientTransform(transform: SvrPatientTransform): SvrPatientTransform {
  const r = transform.rotation;
  let valid =
    r.length === 9 &&
    transform.translationMm.length === 3 &&
    r.every(Number.isFinite) &&
    transform.translationMm.every(Number.isFinite);
  for (let row = 0; row < 3; row++)
    for (let other = row; other < 3; other++) {
      const dot =
        r[row * 3]! * r[other * 3]! + r[row * 3 + 1]! * r[other * 3 + 1]! + r[row * 3 + 2]! * r[other * 3 + 2]!;
      valid &&= Math.abs(dot - (row === other ? 1 : 0)) < 1e-4;
    }
  const determinant =
    r[0] * (r[4] * r[8] - r[5] * r[7]) - r[1] * (r[3] * r[8] - r[5] * r[6]) + r[2] * (r[3] * r[7] - r[4] * r[6]);
  if (!valid || Math.abs(determinant - 1) >= 1e-4)
    throw new Error(
      'The accepted source pose is not a finite rigid patient-space transform. Reopen the volume before refining.',
    );
  return Object.freeze({
    rotation: Object.freeze([...r]) as SvrDirection,
    translationMm: Object.freeze([...transform.translationMm]) as PatientPoint,
  });
}

export function rotatePoint(direction: SvrDirection, point: PatientPoint): [number, number, number] {
  return [
    direction[0] * point[0] + direction[1] * point[1] + direction[2] * point[2],
    direction[3] * point[0] + direction[4] * point[1] + direction[5] * point[2],
    direction[6] * point[0] + direction[7] * point[1] + direction[8] * point[2],
  ];
}

export function transposeDirection(direction: SvrDirection): SvrDirection {
  return [
    direction[0],
    direction[3],
    direction[6],
    direction[1],
    direction[4],
    direction[7],
    direction[2],
    direction[5],
    direction[8],
  ];
}

export function transformPoint(transform: SvrPatientTransform, point: PatientPoint): [number, number, number] {
  const rotated = rotatePoint(transform.rotation, point);
  return rotated.map((value, axis) => value + transform.translationMm[axis]!) as [number, number, number];
}

export function inverseTransformPoint(transform: SvrPatientTransform, point: PatientPoint): [number, number, number] {
  return rotatePoint(
    transposeDirection(transform.rotation),
    point.map((value, axis) => value - transform.translationMm[axis]!) as [number, number, number],
  );
}

/** Compose absolute transforms; a crop-origin shift is never part of registration. */
export function composePatientTransforms(outer: SvrPatientTransform, inner: SvrPatientTransform): SvrPatientTransform {
  const rotation = Array.from({ length: 9 }, (_, index) => {
    const row = Math.floor(index / 3),
      column = index % 3;
    return (
      outer.rotation[row * 3]! * inner.rotation[column]! +
      outer.rotation[row * 3 + 1]! * inner.rotation[column + 3]! +
      outer.rotation[row * 3 + 2]! * inner.rotation[column + 6]!
    );
  }) as unknown as SvrDirection;
  return { rotation, translationMm: transformPoint(outer, inner.translationMm) };
}

type VolumeGeometry = Pick<SvrVolume, 'originMm' | 'voxelSizeMm' | 'direction'>;

export function volumeVoxelToPatient(volume: VolumeGeometry, point: PatientPoint): [number, number, number] {
  return transformPoint(
    { rotation: volume.direction ?? IDENTITY_DIRECTION, translationMm: volume.originMm },
    point.map((value, axis) => value * volume.voxelSizeMm[axis]!) as [number, number, number],
  );
}

export function patientToVolumeVoxel(volume: VolumeGeometry, point: PatientPoint): [number, number, number] {
  const native = inverseTransformPoint(
    { rotation: volume.direction ?? IDENTITY_DIRECTION, translationMm: volume.originMm },
    point,
  );
  return native.map((value, axis) => value / volume.voxelSizeMm[axis]!) as [number, number, number];
}

export function physicalVolumeBounds(volume: VolumeGeometry & Pick<SvrVolume, 'dims'>): SvrVolume['boundsMm'] {
  const min: [number, number, number] = [Infinity, Infinity, Infinity];
  const max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  for (const x of [-0.5, volume.dims[0] - 0.5])
    for (const y of [-0.5, volume.dims[1] - 0.5])
      for (const z of [-0.5, volume.dims[2] - 0.5]) {
        const point = volumeVoxelToPatient(volume, [x, y, z]);
        for (let axis = 0; axis < 3; axis++) {
          min[axis] = Math.min(min[axis]!, point[axis]!);
          max[axis] = Math.max(max[axis]!, point[axis]!);
        }
      }
  return { min, max };
}
