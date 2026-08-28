import type { SeriesFrameManifest } from './localApi';
import { getSliceGeometryFromInstance } from './svr/dicomGeometry';
import { mat3FromEulerXYZ, mat3MulVec3, type RigidParams } from './svr/rigidRegistration';
import { dot } from './svr/vec3';

/**
 * Advance sampling through the ordered target acquisition without changing the
 * reference plane or the verified registration. One step is the series-wide
 * median physical spacing, so a correction cannot drift while browsing.
 */
export function applyAlignmentSliceOffset(
  target: SeriesFrameManifest,
  baseline: RigidParams,
  sliceOffset: number,
): RigidParams {
  if (!Number.isFinite(sliceOffset)) throw new Error('Manual slice correction must be finite');
  if (sliceOffset === 0) return baseline;
  if (!target.geometryReliable || target.frames.length < 2) {
    throw new Error('Manual slice correction requires a reliably ordered physical target stack');
  }
  const normal = getSliceGeometryFromInstance(target.frames[0]!).normalDir;
  const depths = target.frames.map((frame) => dot(getSliceGeometryFromInstance(frame).ippMm, normal));
  const spacings = depths.slice(1).map((depth, index) => depth - depths[index]!);
  if (spacings.some((spacing) => !Number.isFinite(spacing) || spacing <= 1e-6)) {
    throw new Error('Manual slice correction requires positive ordered target-plane spacing');
  }
  spacings.sort((first, second) => first - second);
  const displacementMm = sliceOffset * spacings[Math.floor(spacings.length / 2)]!;
  if (!Number.isFinite(displacementMm)) throw new Error('Manual slice correction exceeds the finite physical range');
  const shift = mat3MulVec3(
    mat3FromEulerXYZ(baseline.rx, baseline.ry, baseline.rz),
    normal.x * displacementMm,
    normal.y * displacementMm,
    normal.z * displacementMm,
  );
  // T(q) = R(q-c)+c+t. Replacing t by t-Rd makes T^-1(p) sample
  // the original target point plus d, including oblique target acquisitions.
  return { ...baseline, tx: baseline.tx - shift.x, ty: baseline.ty - shift.y, tz: baseline.tz - shift.z };
}
