import type { ExclusionMask } from '../types/api';
import type { SeriesFrameManifest } from './localApi';
import { outputGridPixelToWorld, type OutputPlaneGrid } from './outputPlaneGrid';
import { getSliceGeometryFromInstance } from './svr/dicomGeometry';
import { applyRigidToPoint, invertRigidParams, mat3FromEulerXYZ, type RigidParams } from './svr/rigidRegistration';
import { dot, v3, type Vec3 } from './svr/vec3';

type RegisteredPose = { rigid: RigidParams; centerMm: Vec3; outputGrid?: OutputPlaneGrid };

function frameCenter(manifest: SeriesFrameManifest, index: number): Vec3 {
  const frame = manifest.frames[index];
  if (!frame) throw new Error('Physical frame index is outside its series manifest');
  const geometry = getSliceGeometryFromInstance(frame);
  const rowOffset = ((geometry.rows - 1) * geometry.rowSpacingMm) / 2;
  const colOffset = ((geometry.cols - 1) * geometry.colSpacingMm) / 2;
  return v3(
    geometry.ippMm.x + geometry.colDir.x * rowOffset + geometry.rowDir.x * colOffset,
    geometry.ippMm.y + geometry.colDir.y * rowOffset + geometry.rowDir.y * colOffset,
    geometry.ippMm.z + geometry.colDir.z * rowOffset + geometry.rowDir.z * colOffset,
  );
}

/** Never compare absolute cross-study coordinates without an explicit verified rigid frame mapping. */
export function selectPhysicalTargetSlice(
  reference: SeriesFrameManifest,
  target: SeriesFrameManifest,
  referenceIndex: number,
  registeredPose?: RegisteredPose,
): number {
  const referenceFrame = reference.frames[referenceIndex];
  if (!referenceFrame || target.frames.length === 0) {
    throw new Error('Physical slice selection requires a valid reference and target frame');
  }

  const sameFrame = !!reference.frameOfReferenceUid && reference.frameOfReferenceUid === target.frameOfReferenceUid;
  if (!sameFrame && !registeredPose) {
    const fraction = referenceIndex / Math.max(1, reference.frames.length - 1);
    return Math.round(fraction * Math.max(0, target.frames.length - 1));
  }

  let referenceCenter = registeredPose?.outputGrid
    ? outputGridPixelToWorld(
        registeredPose.outputGrid,
        (registeredPose.outputGrid.rows - 1) / 2,
        (registeredPose.outputGrid.columns - 1) / 2,
      )
    : frameCenter(reference, referenceIndex);
  if (registeredPose) {
    const inverse = invertRigidParams(registeredPose.rigid);
    referenceCenter = applyRigidToPoint(
      referenceCenter,
      registeredPose.centerMm,
      mat3FromEulerXYZ(inverse.rx, inverse.ry, inverse.rz),
      v3(inverse.tx, inverse.ty, inverse.tz),
    );
  }
  let winner = 0;
  let nearestDistance = Number.POSITIVE_INFINITY;

  for (let index = 0; index < target.frames.length; index++) {
    const geometry = getSliceGeometryFromInstance(target.frames[index]!);
    const delta = v3(
      referenceCenter.x - geometry.ippMm.x,
      referenceCenter.y - geometry.ippMm.y,
      referenceCenter.z - geometry.ippMm.z,
    );
    const throughPlaneDistance = Math.abs(dot(delta, geometry.normalDir));
    if (throughPlaneDistance < nearestDistance) {
      nearestDistance = throughPlaneDistance;
      winner = index;
    }
  }
  return winner;
}

export function rasterizeImageExclusion(
  exclusion: ExclusionMask | undefined,
  rows: number,
  columns: number,
): Uint8Array | undefined {
  if (!exclusion) return undefined;
  const mask = new Uint8Array(rows * columns);
  const left = Math.max(0, Math.floor(exclusion.x * columns));
  const right = Math.min(columns, Math.ceil((exclusion.x + exclusion.width) * columns));
  const top = Math.max(0, Math.floor(exclusion.y * rows));
  const bottom = Math.min(rows, Math.ceil((exclusion.y + exclusion.height) * rows));
  for (let row = top; row < bottom; row++) {
    mask.fill(1, row * columns + left, row * columns + right);
  }
  return mask;
}
