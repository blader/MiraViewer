import { describe, expect, it } from 'vitest';
import { RAYMARCH_FRAGMENT_SHADER, SVR3D_CAMERA_Z, SVR3D_FOCAL_Z } from '../src/utils/svr/glRaymarch';
import { volumeCamera, type VolumeCamera } from '../src/utils/svr/volumeCamera';

type Point = [number, number, number];
const identity = [1, 0, 0, 0, 1, 0, 0, 0, 1];
const cube: Point = [1, 1, 1];
const anisotropic: Point = [6.144, 3.456, 1.152];
const oblique = [0.6, -0.48, 0.64, 0.8, 0.36, -0.48, 0, 0.8, 0.6];

function boxCorners(boxScale: readonly [number, number, number], center: Point = [0, 0, 0]): Point[] {
  return [-1, 1].flatMap((x) =>
    [-1, 1].flatMap((y) =>
      [-1, 1].map((z) => center.map((value, axis) => value + ([x, y, z][axis]! * boxScale[axis]!) / 2) as Point),
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
function project(point: Point, camera: VolumeCamera, rotation: ArrayLike<number>, aspect: number) {
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

function expectFit(points: Point[], camera: VolumeCamera, rotation: ArrayLike<number>, aspect: number) {
  const projected = points.map((point) => project(point, camera, rotation, aspect));
  for (const point of projected) {
    expect(point.depth).toBeGreaterThan(0);
    expect(Math.abs(point.x)).toBeLessThanOrEqual(0.9 + 1e-12);
    expect(Math.abs(point.y)).toBeLessThanOrEqual(0.9 + 1e-12);
  }
  expect(Math.max(...projected.flatMap((point) => [Math.abs(point.x), Math.abs(point.y)]))).toBeCloseTo(0.9, 12);
}

describe('stable physical-volume camera framing', () => {
  it('fits all physical box corners to 90% using their actual perspective depth', () => {
    const camera = volumeCamera(cube, identity, 1000, 1000);
    expect(camera.center).toEqual([0, 0, 0]);
    expect(camera.distance).toBe(SVR3D_CAMERA_Z);
    expect(camera.zoom).toBeCloseTo(1.65, 14);
    expectFit(boxCorners(cube), camera, identity, 1);
  });

  it('keeps the camera outside the complete physical volume, including deep anisotropic slabs', () => {
    const box: Point = [4, 2, 6];
    const camera = volumeCamera(box, identity, 800, 800);
    expect(camera.center).toEqual([0, 0, 0]);
    expect(camera.distance).toBeCloseTo(Math.hypot(2, 1, 3) + 0.6, 14);
    expectFit(boxCorners(box), camera, identity, 1);
  });

  it.each([
    { angle: 0, width: 1600, height: 1000 },
    { angle: 0, width: 500, height: 1200 },
    { angle: Math.PI / 3, width: 1600, height: 1000 },
    { angle: -Math.PI / 3, width: 500, height: 1200 },
    { angle: Math.PI * 0.49, width: 1600, height: 1000 },
    { angle: Math.PI, width: 1600, height: 1000 },
  ])('fits rotated anisotropic volume corners at angle=$angle in $width×$height', ({ angle, width, height }) => {
    const rotation = Float32Array.from(multiply(rotationY(angle), oblique));
    const camera = volumeCamera(anisotropic, rotation, width, height);
    const corners = boxCorners(anisotropic);
    expect(camera.center).toEqual([0, 0, 0]);
    expect(camera.distance).toBeGreaterThan(4);
    for (const corner of corners) {
      expect(Math.hypot(...corner.map((value, axis) => value - camera.center[axis]!))).toBeLessThan(camera.distance);
    }
    expectFit(corners, camera, rotation, width / height);
  });

  it('keeps distance rotation-invariant rather than moving through tissue as the volume turns', () => {
    const distances = [0, Math.PI / 4, Math.PI / 2, Math.PI].map(
      (angle) => volumeCamera(anisotropic, multiply(rotationY(angle), oblique), 1000, 800).distance,
    );
    expect(new Set(distances).size).toBe(1);
  });

  it('fits all eight selected-box corners while remaining outside the complete off-center volume', () => {
    const focus = { center: [0.2, -0.1, 0.3] as Point, boxScale: [0.4, 0.2, 0.6] as Point };
    const rotation = multiply(rotationY(Math.PI / 3), oblique);
    const camera = volumeCamera(anisotropic, rotation, 1300, 800, focus);
    expect(camera.center).toEqual(focus.center);
    expect(camera.center).not.toBe(focus.center);
    expect(camera.distance).toBeGreaterThan(4);
    expectFit(boxCorners(focus.boxScale, focus.center), camera, rotation, 1300 / 800);
    for (const corner of boxCorners(anisotropic)) {
      expect(project(corner, camera, rotation, 1300 / 800).depth).toBeGreaterThan(0.6 - 1e-12);
      expect(Math.hypot(...corner.map((value, axis) => value - focus.center[axis]!))).toBeLessThan(camera.distance);
    }
  });

  it('fits off-center occupied-anatomy bounds without changing the physical volume', () => {
    const focus = { center: [-0.13, 0.08, 0.04] as Point, boxScale: [0.5, 0.75, 0.3] as Point };
    const camera = volumeCamera(cube, oblique, 700, 1000, focus);
    expect(camera.center).toEqual(focus.center);
    expectFit(boxCorners(focus.boxScale, focus.center), camera, oblique, 0.7);
    for (const corner of boxCorners(cube)) {
      expect(project(corner, camera, oblique, 0.7).depth).toBeGreaterThan(0.6 - 1e-12);
    }
  });

  it('also includes a focus domain larger than the volume when choosing a safe camera distance', () => {
    const focus = { center: [0, 0, 0] as Point, boxScale: [10, 8, 6] as Point };
    const camera = volumeCamera(cube, identity, 1000, 1000, focus);
    expect(camera.distance).toBeCloseTo(Math.hypot(5, 4, 3) + 0.6, 14);
    expect(project([5, 4, 3], camera, identity, 1).x).toBeCloseTo(0.9, 14);
  });

  it.each([false, true])('applies relative zoom without changing geometry or orbit center (focus=%s)', (focused) => {
    const focus = focused ? { center: [0.2, -0.1, 0.3] as Point, boxScale: [0.4, 0.2, 0.6] as Point } : undefined;
    const before = structuredClone({ anisotropic, focus, oblique });
    const base = volumeCamera(anisotropic, oblique, 1200, 800, focus);
    const zoomed = volumeCamera(anisotropic, oblique, 1200, 800, focus, 2);
    expect(zoomed.center).toEqual(base.center);
    expect(zoomed.distance).toBe(base.distance);
    expect(zoomed.zoom).toBe(base.zoom * 2);
    expect({ anisotropic, focus, oblique }).toEqual(before);
  });

  it.each([
    [0, 0, 0],
    [NaN, Infinity, NaN],
    [-10, -30, -1],
    [1, 10000, Infinity],
    [10000, 1, 1],
  ])('keeps a finite positive camera during viewport/zoom transients (%s, %s, %s)', (width, height, zoom) => {
    const camera = volumeCamera(cube, identity, width, height, undefined, zoom);
    expect([...camera.center, camera.distance, camera.zoom].every(Number.isFinite)).toBe(true);
    expect(camera.distance).toBeGreaterThan(0);
    expect(camera.zoom).toBeGreaterThan(0);
  });

  it('rejects invalid geometry or rotation instead of publishing a NaN camera', () => {
    expect(() => volumeCamera([NaN, 1, 1], identity, 800, 800)).toThrow(/finite/);
    expect(() => volumeCamera([1, 0, 1], identity, 800, 800)).toThrow(/finite/);
    expect(() => volumeCamera([1, -1, 1], identity, 800, 800)).toThrow(/finite/);
    expect(() => volumeCamera(cube, [1, 0], 800, 800)).toThrow(/finite/);
    expect(() =>
      volumeCamera(
        cube,
        identity.map(() => NaN),
        800,
        800,
      ),
    ).toThrow(/finite/);
    expect(() => volumeCamera(cube, identity, 800, 800, { center: [Infinity, 0, 0], boxScale: [1, 1, 1] })).toThrow(
      /finite/,
    );
    expect(() => volumeCamera(cube, identity, 800, 800, { center: [0, 0, 0], boxScale: [1, 0, 1] })).toThrow(/finite/);
    expect(() =>
      volumeCamera(
        cube,
        identity.map(() => 0),
        800,
        800,
      ),
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
