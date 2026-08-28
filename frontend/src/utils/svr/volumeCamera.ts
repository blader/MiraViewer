import { SVR3D_CAMERA_Z, SVR3D_FOCAL_Z } from './glRaymarch';

type Point = readonly [number, number, number];

export type VolumeCamera = { center: [number, number, number]; distance: number; zoom: number };

/**
 * Fit physical volume or focus bounds using the raymarcher's actual perspective.
 * The complete volume owns orbit safety; a browsed source plane never moves the camera.
 * Rotation is column-major object→camera, matching the renderer and orientation overlay.
 */
export function volumeCamera(
  boxScale: Point,
  rotationColumnMajor: ArrayLike<number>,
  viewportWidth: number,
  viewportHeight: number,
  focus?: { center: Point; boxScale: Point },
  relativeZoom = 1,
): VolumeCamera {
  const validExtent = (point: Point) =>
    point.length === 3 && point.every((value) => Number.isFinite(value) && value > 0);
  if (
    !validExtent(boxScale) ||
    rotationColumnMajor.length !== 9 ||
    !Array.from(rotationColumnMajor).every(Number.isFinite) ||
    (focus && (focus.center.length !== 3 || !focus.center.every(Number.isFinite) || !validExtent(focus.boxScale)))
  ) {
    throw new Error('The volume camera requires finite physical bounds and rotation.');
  }

  const center: [number, number, number] = focus ? [...focus.center] : [0, 0, 0];
  const fit = focus?.boxScale ?? boxScale;
  // The farthest full-volume corner from this orbit center bounds every rotation.
  const volumeRadius = Math.hypot(
    Math.abs(center[0]) + boxScale[0] / 2,
    Math.abs(center[1]) + boxScale[1] / 2,
    Math.abs(center[2]) + boxScale[2] / 2,
  );
  const radius = Math.max(volumeRadius, Math.hypot(fit[0] / 2, fit[1] / 2, fit[2] / 2));
  const distance = Math.max(SVR3D_CAMERA_Z, radius + 0.6);
  // A collapsed canvas can briefly have no area; never publish an invalid camera.
  const width = Number.isFinite(viewportWidth) && viewportWidth > 0 ? viewportWidth : 1;
  const height = Number.isFinite(viewportHeight) && viewportHeight > 0 ? viewportHeight : 1;
  const aspect = width / height;
  const m = rotationColumnMajor;
  let projectedExtent = 0;
  for (let ix = -1; ix <= 1; ix += 2) {
    for (let iy = -1; iy <= 1; iy += 2) {
      for (let iz = -1; iz <= 1; iz += 2) {
        const x = (ix * fit[0]) / 2;
        const y = (iy * fit[1]) / 2;
        const z = (iz * fit[2]) / 2;
        const viewX = m[0]! * x + m[3]! * y + m[6]! * z;
        const viewY = m[1]! * x + m[4]! * y + m[7]! * z;
        const depth = distance - (m[2]! * x + m[5]! * y + m[8]! * z);
        if (!(depth > 0)) throw new Error('The volume camera must remain outside the physical bounds.');
        projectedExtent = Math.max(projectedExtent, Math.abs(viewX) / (depth * aspect), Math.abs(viewY) / depth);
      }
    }
  }
  const zoomScale = Number.isFinite(relativeZoom) && relativeZoom > 0 ? relativeZoom : 1;
  const zoom = (0.9 * zoomScale) / (SVR3D_FOCAL_Z * projectedExtent);
  if (!Number.isFinite(distance) || !Number.isFinite(zoom) || !(zoom > 0)) {
    throw new Error('The volume camera cannot frame degenerate physical bounds.');
  }
  return { center, distance, zoom };
}
