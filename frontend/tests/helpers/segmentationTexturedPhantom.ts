import type { SeededVolumeInput } from '../../src/utils/segmentation/seededVolume';

type Point = [number, number, number];
export type TissueAppearance = 'textured' | 'weak' | 'cystic' | 'dark';

/** Rotated, off-center, lobulated tissue with physical texture, bias, and partial-volume boundaries. */
export function segmentationTexturedPhantom(
  kind: TissueAppearance,
  anisotropic: boolean,
  seedPosition: 'center' | 'edge',
  insideOnly = false,
  airShell = false,
): { input: SeededVolumeInput; truth: Uint8Array } {
  const clamp = (value: number) => Math.max(0, Math.min(1, value));
  const cos = Math.cos(0.48),
    sin = Math.sin(0.48);
  const center: Point = [18.8, 22.1, 15.3];
  const dims: Point = anisotropic ? [60, 34, 17] : [48, 44, 33];
  const voxelSizeMm: Point = anisotropic ? [0.8, 1.3, 2] : [1, 1, 1];
  const count = dims[0] * dims[1] * dims[2];
  const volume = new Float32Array(count);
  const truth = new Uint8Array(count);
  const observedSupport = new Uint8Array(count).fill(1);
  const pointAt = (index: number): Point => [
    (index % dims[0]) * voxelSizeMm[0],
    (Math.floor(index / dims[0]) % dims[1]) * voxelSizeMm[1],
    Math.floor(index / (dims[0] * dims[1])) * voxelSizeMm[2],
  ];
  const amplitude = kind === 'weak' ? 0.058 : 0.14;
  for (let index = 0; index < count; index++) {
    const [x, y, z] = pointAt(index);
    const dx = x - center[0],
      dy = y - center[1],
      dz = z - center[2];
    const u = cos * dx + sin * dy,
      v = -sin * dx + cos * dy;
    const radius = Math.hypot(u / 7, v / 5.8, dz / 5.2);
    const lobule = Math.hypot((u - 5.6) / 3.3, (v - 1.2) / 2.8, (dz + 0.5) / 3.1);
    const signedMm = Math.min((radius - 1) * 5.2, (lobule - 1) * 2.8);
    truth[index] = signedMm < 0 ? 1 : 0;
    const fraction = clamp(0.5 - signedMm / (kind === 'weak' ? 3 : 1.5));
    const tissueTexture =
      0.017 * Math.sin(1.13 * x + 0.7 * y) * Math.cos(0.87 * z - 0.24 * x) +
      0.009 * Math.sin(2.31 * x - 1.77 * y + 1.1 * z);
    const bias = 0.025 * (x / 47 - 0.5) + 0.018 * Math.sin(y / 10);
    const lesionTexture =
      0.02 * Math.sin(0.95 * u + 0.7 * dz) * Math.cos(1.05 * v - 0.35 * dz) +
      0.009 * Math.sin(2.77 * u + 2.17 * v - 0.5 * dz);
    let signal = (kind === 'dark' ? -1 : 1) * amplitude + lesionTexture;
    if (kind === 'cystic') {
      const cystFraction = clamp(0.5 - (Math.hypot(u + 2.2, v, dz) - 2) / 0.8);
      signal = signal * (1 - cystFraction) - 0.115 * cystFraction;
    }
    volume[index] = 0.5 + bias + tissueTexture * (1 - fraction) + signal * fraction;
    // A nearby same-signal distractor is neither tumor nor explicitly marked outside.
    if (Math.hypot((u - 13) / 2.8, (v - 5) / 3.5, dz / 4) < 1) volume[index]! += (kind === 'dark' ? -1 : 1) * amplitude;
    if (airShell && Math.hypot((x - 23) / 21, (y - 21) / 19, (z - 16) / 14) > 1) volume[index] = 0;
  }
  const brush = (local: Point, expected: 0 | 1): number[] => {
    const physical: Point = [
      center[0] + cos * local[0] - sin * local[1],
      center[1] + sin * local[0] + cos * local[1],
      center[2] + local[2],
    ];
    const indices: number[] = [];
    let nearest = -1,
      nearestDistance = Infinity;
    for (let index = 0; index < count; index++) {
      if (truth[index] !== expected) continue;
      const [x, y, z] = pointAt(index);
      const distance = Math.hypot(x - physical[0], y - physical[1], z - physical[2]);
      if (distance < nearestDistance) {
        nearestDistance = distance;
        nearest = index;
      }
      // Real marks are a physical brush disc on one acquired plane, not a 3D truth mask.
      if (Math.abs(z - physical[2]) <= voxelSizeMm[2] * 0.51 && Math.hypot(x - physical[0], y - physical[1]) <= 1.45)
        indices.push(index);
    }
    if (nearest < 0) throw new Error('The synthetic mark has no matching tissue.');
    return indices.length ? indices : [nearest];
  };
  const foreground = brush(seedPosition === 'center' ? [1.5, 0, 0] : [4.2, 1.2, 0], 1);
  if (kind === 'cystic') foreground.push(...brush([-2.2, 0, 0], 1));
  const outsidePoints: Point[] = [
    [11, 0, 0],
    [-11, 0, 0],
    [0, 10, 0],
    [0, -10, 0],
  ];
  const background = insideOnly ? [] : outsidePoints.flatMap((point) => brush(point, 0));
  return {
    input: {
      volume,
      observedSupport,
      dims,
      voxelSizeMm,
      foreground: Uint32Array.from(new Set(foreground)),
      background: Uint32Array.from(new Set(background)),
    },
    truth,
  };
}
