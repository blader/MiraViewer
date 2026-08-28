import { describe, expect, it } from 'vitest';
import { RAYMARCH_FRAGMENT_SHADER, SVR3D_CAMERA_Z, SVR3D_FOCAL_Z } from '../src/utils/svr/glRaymarch';
import { nativePlaneCamera, type NativePlaneCamera } from '../src/utils/svr/nativePlaneCamera';

type Point = [number, number, number];
type Plane = Parameters<typeof nativePlaneCamera>[0];
const identity = [1, 0, 0, 0, 1, 0, 0, 0, 1];
const square: Plane = {
  frame: { columns: 512, rows: 512 },
  origin: [-0.5 + 0.5 / 512, -0.5 + 0.5 / 512, 0],
  columnStep: [1 / 512, 0, 0],
  rowStep: [0, 1 / 512, 0],
};
const oblique: Plane = {
  frame: { columns: 1024, rows: 384 },
  origin: [11.3, -7.6, 5.2],
  columnStep: [0.0036, 0.0048, 0],
  rowStep: [-0.00432, 0.00324, 0.0072],
};
// Rows of the rotation are the source column, row and normal unit directions.
const faceOblique = [0.6, -0.48, 0.64, 0.8, 0.36, -0.48, 0, 0.8, 0.6];

function nativeCorners(plane: Plane): Point[] {
  return [-0.5, plane.frame.columns - 0.5].flatMap((column) =>
    [-0.5, plane.frame.rows - 0.5].map(
      (row) =>
        plane.origin.map(
          (value, axis) => value + column * plane.columnStep[axis]! + row * plane.rowStep[axis]!,
        ) as Point,
    ),
  );
}

function rotationY(angle: number): number[] {
  return [Math.cos(angle), 0, -Math.sin(angle), 0, 1, 0, Math.sin(angle), 0, Math.cos(angle)];
}

function multiply(a: number[], b: number[]): number[] {
  return Array.from({ length: 9 }, (_, index) => {
    const row = index % 3,
      column = Math.floor(index / 3);
    return [0, 1, 2].reduce((sum, axis) => sum + a[axis * 3 + row]! * b[column * 3 + axis]!, 0);
  });
}

/** Project a world point using the same pinhole model as a generated GPU ray. */
function project(point: Point, camera: NativePlaneCamera, rotation: ArrayLike<number>, aspect: number) {
  const offset = point.map((value, axis) => value - camera.center[axis]!);
  const view = [0, 1, 2].map((row) =>
    offset.reduce((sum, value, column) => sum + rotation[column * 3 + row]! * value, 0),
  );
  const depth = camera.distance - view[2]!;
  return {
    x: (view[0]! * SVR3D_FOCAL_Z * camera.zoom) / (depth * aspect),
    y: (view[1]! * SVR3D_FOCAL_Z * camera.zoom) / depth,
    depth,
  };
}

function expectFit(points: Point[], camera: NativePlaneCamera, rotation: ArrayLike<number>, aspect: number) {
  const projected = points.map((point) => project(point, camera, rotation, aspect));
  for (const point of projected) {
    expect(point.depth).toBeGreaterThan(0);
    expect(Math.abs(point.x)).toBeLessThanOrEqual(0.9 + 1e-12);
    expect(Math.abs(point.y)).toBeLessThanOrEqual(0.9 + 1e-12);
  }
  expect(Math.max(...projected.flatMap((point) => [Math.abs(point.x), Math.abs(point.y)]))).toBeCloseTo(0.9, 12);
}

describe('source-faithful MRI camera framing', () => {
  it('fits the complete acquired square at 90%, instead of fitting the nearer reconstruction-box face', () => {
    const camera = nativePlaneCamera(square, identity, 1000, 1000);
    expect(camera.center).toEqual([0, 0, 0]);
    expect(camera.distance).toBe(SVR3D_CAMERA_Z);
    expect(camera.zoom).toBeCloseTo(2.4, 14);
    expectFit(nativeCorners(square), camera, identity, 1);
  });

  it('includes the full pixel footprint even for a one-pixel acquired image', () => {
    const plane: Plane = {
      frame: { rows: 1, columns: 1 },
      origin: [7, -3, 12],
      columnStep: [2, 0, 0],
      rowStep: [0, 1, 0],
    };
    const camera = nativePlaneCamera(plane, identity, 800, 800);
    expect(camera.center).toEqual(plane.origin);
    expect(camera.distance).toBeCloseTo(Math.hypot(1, 0.5) + 0.6, 14);
    expectFit(nativeCorners(plane), camera, identity, 1);
  });

  it.each([
    { angle: 0, width: 1600, height: 1000 },
    { angle: 0, width: 500, height: 1200 },
    { angle: Math.PI / 3, width: 1600, height: 1000 },
    { angle: -Math.PI / 3, width: 500, height: 1200 },
    { angle: Math.PI * 0.49, width: 1600, height: 1000 },
    { angle: Math.PI, width: 1600, height: 1000 },
  ])('fits anisotropic oblique pixel edges at angle=$angle in $width×$height', ({ angle, width, height }) => {
    const rotation = Float32Array.from(multiply(rotationY(angle), faceOblique));
    const camera = nativePlaneCamera(oblique, rotation, width, height);
    const corners = nativeCorners(oblique);
    expect(camera.center[0]).toBeGreaterThan(10);
    expect(camera.center[2]).toBeGreaterThan(5);
    expect(camera.distance).toBeGreaterThan(4);
    // The full original image is several times larger and well outside a unit ROI box.
    for (const corner of corners) {
      expect(Math.hypot(...corner.map((value, axis) => value - camera.center[axis]!))).toBeLessThan(camera.distance);
    }
    expectFit(corners, camera, rotation, width / height);
  });

  it('keeps distance rotation-invariant rather than moving the camera through the source as it turns', () => {
    const distances = [0, Math.PI / 4, Math.PI / 2, Math.PI].map(
      (angle) => nativePlaneCamera(oblique, multiply(rotationY(angle), faceOblique), 1000, 800).distance,
    );
    expect(new Set(distances).size).toBe(1);
  });

  it('fits all eight tumor-box corners while remaining outside the complete off-center source image', () => {
    const focus = { center: [0.2, -0.1, 0.3] as Point, boxScale: [0.4, 0.2, 0.6] as Point };
    const rotation = multiply(rotationY(Math.PI / 3), faceOblique);
    const camera = nativePlaneCamera(oblique, rotation, 1300, 800, focus);
    expect(camera.center).toEqual(focus.center);
    expect(camera.center).not.toBe(focus.center);
    expect(camera.distance).toBeGreaterThan(10);
    const focusCorners = [-1, 1].flatMap((x) =>
      [-1, 1].flatMap((y) =>
        [-1, 1].map(
          (z) => focus.center.map((value, axis) => value + ([x, y, z][axis]! * focus.boxScale[axis]!) / 2) as Point,
        ),
      ),
    );
    expectFit(focusCorners, camera, rotation, 1300 / 800);
    for (const corner of nativeCorners(oblique)) {
      expect(project(corner, camera, rotation, 1300 / 800).depth).toBeGreaterThan(0.6 - 1e-12);
      expect(Math.hypot(...corner.map((value, axis) => value - focus.center[axis]!))).toBeLessThan(camera.distance);
    }
  });

  it('also includes a focus domain larger than the source when choosing a safe camera distance', () => {
    const focus = { center: [0, 0, 0] as Point, boxScale: [10, 8, 6] as Point };
    const camera = nativePlaneCamera(square, identity, 1000, 1000, focus);
    expect(camera.distance).toBeCloseTo(Math.hypot(5, 4, 3) + 0.6, 14);
    expect(project([5, 4, 3], camera, identity, 1).x).toBeCloseTo(0.9, 14);
  });

  it('applies deliberate relative zoom without changing source geometry or orbit center', () => {
    const before = structuredClone(oblique);
    const base = nativePlaneCamera(oblique, faceOblique, 1200, 800);
    const zoomed = nativePlaneCamera(oblique, faceOblique, 1200, 800, undefined, 2);
    expect(zoomed.center).toEqual(base.center);
    expect(zoomed.distance).toBe(base.distance);
    expect(zoomed.zoom).toBe(base.zoom * 2);
    expect(oblique).toEqual(before);
  });

  it.each([
    [0, 0, 0],
    [NaN, Infinity, NaN],
    [-10, -30, -1],
    [1, 10000, Infinity],
    [10000, 1, 1],
  ])('keeps a finite positive camera during viewport/zoom transients (%s, %s, %s)', (width, height, zoom) => {
    const camera = nativePlaneCamera(square, identity, width, height, undefined, zoom);
    expect([...camera.center, camera.distance, camera.zoom].every(Number.isFinite)).toBe(true);
    expect(camera.distance).toBeGreaterThan(0);
    expect(camera.zoom).toBeGreaterThan(0);
  });

  it('rejects invalid geometry or rotation instead of publishing a NaN camera', () => {
    expect(() => nativePlaneCamera({ ...square, origin: [NaN, 0, 0] }, identity, 800, 800)).toThrow(/finite/);
    expect(() => nativePlaneCamera(square, [1, 0], 800, 800)).toThrow(/finite/);
    expect(() =>
      nativePlaneCamera(
        square,
        identity.map(() => NaN),
        800,
        800,
      ),
    ).toThrow(/finite/);
    expect(() => nativePlaneCamera({ ...square, frame: { rows: 0, columns: 512 } }, identity, 800, 800)).toThrow(
      /finite/,
    );
    expect(() =>
      nativePlaneCamera({ ...square, columnStep: [0, 0, 0], rowStep: [0, 0, 0] }, identity, 800, 800),
    ).toThrow(/degenerate/);
  });

  it('uses one explicit camera origin, independently of the focused raymarch domain', () => {
    expect(RAYMARCH_FRAGMENT_SHADER).toContain('uniform float u_cameraZ;');
    expect(RAYMARCH_FRAGMENT_SHADER).toContain('uniform vec3 u_cameraCenter;');
    expect(RAYMARCH_FRAGMENT_SHADER).toContain('vec3 roW = vec3(0.0, 0.0, u_cameraZ);');
    expect(RAYMARCH_FRAGMENT_SHADER).toContain('vec3 ro = u_invRot * roW + u_cameraCenter;');
    expect(RAYMARCH_FRAGMENT_SHADER).not.toContain('u_focusCenter');
    expect(RAYMARCH_FRAGMENT_SHADER).toContain('bmin = max(bmin, u_focusMin);');
    expect(RAYMARCH_FRAGMENT_SHADER).toContain('bmax = min(bmax, u_focusMax);');
  });

  it('keeps DICOM width-one thresholding exact in the volume as well as the native plane', () => {
    const windowing = RAYMARCH_FRAGMENT_SHADER.slice(
      RAYMARCH_FRAGMENT_SHADER.indexOf('float windowed('),
      RAYMARCH_FRAGMENT_SHADER.indexOf('void addLesionSample('),
    );
    expect(windowing).toContain('u_windowWidth > 0.0');
    expect(windowing).toContain('intensity > u_windowLow ? 1.0 : 0.0');
    expect(windowing).not.toContain('max(1e-6');
  });
});
