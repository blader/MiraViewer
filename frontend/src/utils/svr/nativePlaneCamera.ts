import { SVR3D_CAMERA_Z, SVR3D_FOCAL_Z } from './glRaymarch';
import type { NativePlaneData } from './nativePlane';

type Point = [number, number, number];
type PlaneGeometry = Pick<NativePlaneData, 'origin' | 'columnStep' | 'rowStep'> & {
  frame: Pick<NativePlaneData['frame'], 'rows' | 'columns'>;
};

export type NativePlaneCamera = { center: Point; distance: number; zoom: number };

/**
 * Fit acquired pixel edges, not the reconstruction box, using the raymarcher's perspective.
 * Rotation is column-major object→camera. A sphere around the full source keeps the camera
 * outside it at every rotation, including when the reconstruction is only a small ROI.
 */
export function nativePlaneCamera(
  plane: PlaneGeometry,
  rotationColumnMajor: ArrayLike<number>,
  viewportWidth: number,
  viewportHeight: number,
  focus?: { center: readonly [number, number, number]; boxScale: readonly [number, number, number] },
  relativeZoom = 1,
): NativePlaneCamera {
  const { origin, columnStep, rowStep } = plane;
  const { columns, rows } = plane.frame;
  if (
    !Number.isInteger(columns) ||
    !Number.isInteger(rows) ||
    columns < 1 ||
    rows < 1 ||
    ![...origin, ...columnStep, ...rowStep].every(Number.isFinite) ||
    rotationColumnMajor.length !== 9 ||
    !Array.from(rotationColumnMajor).every(Number.isFinite) ||
    (focus &&
      (!focus.center.every(Number.isFinite) ||
        !focus.boxScale.every((extent) => Number.isFinite(extent) && extent > 0)))
  ) {
    throw new Error('The original MRI camera requires finite image geometry and rotation.');
  }

  const point = (column: number, row: number): Point =>
    origin.map((value, axis) => value + columnStep[axis]! * column + rowStep[axis]! * row) as Point;
  const center: Point = focus ? [...focus.center] : point((columns - 1) / 2, (rows - 1) / 2);
  // IPP is a pixel center: framing centers alone crops half a pixel on all four edges.
  const sourceCorners = [-0.5, columns - 0.5].flatMap((column) => [-0.5, rows - 0.5].map((row) => point(column, row)));
  const fitCorners = focus
    ? [-1, 1].flatMap((x) =>
        [-1, 1].flatMap((y) =>
          [-1, 1].map(
            (z): Point => [
              center[0] + (x * focus.boxScale[0]) / 2,
              center[1] + (y * focus.boxScale[1]) / 2,
              center[2] + (z * focus.boxScale[2]) / 2,
            ],
          ),
        ),
      )
    : sourceCorners;
  const radius = Math.max(
    ...[...sourceCorners, ...fitCorners].map((corner) =>
      Math.hypot(corner[0] - center[0], corner[1] - center[1], corner[2] - center[2]),
    ),
  );
  const distance = Math.max(SVR3D_CAMERA_Z, radius + 0.6);
  // A collapsed/hidden canvas can briefly report zero; do not publish an invalid camera.
  const width = Number.isFinite(viewportWidth) && viewportWidth > 0 ? viewportWidth : 1;
  const height = Number.isFinite(viewportHeight) && viewportHeight > 0 ? viewportHeight : 1;
  const aspect = width / height;
  const m = rotationColumnMajor;
  let projectedExtent = 0;
  for (const corner of fitCorners) {
    const [x, y, z] = corner.map((value, axis) => value - center[axis]!) as Point;
    const viewX = m[0]! * x + m[3]! * y + m[6]! * z;
    const viewY = m[1]! * x + m[4]! * y + m[7]! * z;
    const depth = distance - (m[2]! * x + m[5]! * y + m[8]! * z);
    if (!(depth > 0)) throw new Error('The original MRI camera must remain outside the image.');
    projectedExtent = Math.max(projectedExtent, Math.abs(viewX) / (depth * aspect), Math.abs(viewY) / depth);
  }
  const zoomScale = Number.isFinite(relativeZoom) && relativeZoom > 0 ? relativeZoom : 1;
  const zoom = (0.9 * zoomScale) / (SVR3D_FOCAL_Z * projectedExtent);
  if (!Number.isFinite(distance) || !Number.isFinite(zoom) || !(zoom > 0)) {
    throw new Error('The original MRI camera cannot frame degenerate image geometry.');
  }
  return { center, distance, zoom };
}
