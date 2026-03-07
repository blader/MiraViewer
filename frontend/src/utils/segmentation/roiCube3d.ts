import type { Vec3i } from './regionGrow3D';

export type RoiCubePlane = 'axial' | 'coronal' | 'sagittal';

function clampInt(x: number, min: number, max: number): number {
  if (!Number.isFinite(x)) return min;
  const xi = Math.floor(x);
  return xi < min ? min : xi > max ? max : xi;
}

function absMm(v: number): number {
  return Math.abs(Number.isFinite(v) ? v : 0);
}

function computeCenteredSpan(params: { center: number; count: number; min: number; max: number }): { lo: number; hi: number } {
  const { min, max } = params;
  const center = clampInt(params.center, min, max);
  const count = clampInt(params.count, 1, Math.max(1, max - min + 1));

  // Distribute any asymmetry toward the + direction.
  const halfLo = Math.floor((count - 1) / 2);
  const halfHi = (count - 1) - halfLo;

  let lo = center - halfLo;
  let hi = center + halfHi;

  // Shift the window back into bounds while preserving its size as much as possible.
  if (lo < min) {
    hi += min - lo;
    lo = min;
  }
  if (hi > max) {
    lo -= hi - max;
    hi = max;
  }

  lo = clampInt(lo, min, max);
  hi = clampInt(hi, min, max);

  // If the window was larger than the domain, the clamps above may still shrink it.
  // That is fine: callers already clamp `count` to the domain size.
  return { lo, hi };
}

/**
 * Convert a 2D slice-inspector rectangle (defined by voxel endpoints a/b on the current plane)
 * into a bounded 3D cube-like ROI.
 *
 * The depth is chosen so the ROI is roughly isotropic in *mm* (not voxels), then centered on
 * the current slice index along the plane axis.
 */
export function computeRoiCubeBoundsFromSliceDrag(params: {
  plane: RoiCubePlane;
  dims: [number, number, number];
  voxelSizeMm: [number, number, number];
  sliceIndex: number;
  a: Vec3i;
  b: Vec3i;
  /** Optional multiplier on the computed depth (default 1.0). */
  depthScale?: number;
}): { min: Vec3i; max: Vec3i } | null {
  const { plane, dims, voxelSizeMm, a, b } = params;

  const [nx, ny, nz] = dims;
  if (!(nx > 0 && ny > 0 && nz > 0)) return null;

  const maxX = nx - 1;
  const maxY = ny - 1;
  const maxZ = nz - 1;

  const vx = absMm(voxelSizeMm[0]);
  const vy = absMm(voxelSizeMm[1]);
  const vz = absMm(voxelSizeMm[2]);

  const depthScale = typeof params.depthScale === 'number' && Number.isFinite(params.depthScale) ? params.depthScale : 1;

  if (plane === 'axial') {
    const minX2 = clampInt(Math.min(a.x, b.x), 0, maxX);
    const maxX2 = clampInt(Math.max(a.x, b.x), 0, maxX);
    const minY2 = clampInt(Math.min(a.y, b.y), 0, maxY);
    const maxY2 = clampInt(Math.max(a.y, b.y), 0, maxY);

    const sideMm = Math.max((maxX2 - minX2 + 1) * vx, (maxY2 - minY2 + 1) * vy);
    const depthSlices = clampInt(vz > 1e-9 ? Math.round((sideMm / vz) * depthScale) : 1, 1, nz);

    const span = computeCenteredSpan({ center: params.sliceIndex, count: depthSlices, min: 0, max: maxZ });
    return {
      min: { x: minX2, y: minY2, z: span.lo },
      max: { x: maxX2, y: maxY2, z: span.hi },
    };
  }

  if (plane === 'coronal') {
    const minX2 = clampInt(Math.min(a.x, b.x), 0, maxX);
    const maxX2 = clampInt(Math.max(a.x, b.x), 0, maxX);
    const minZ2 = clampInt(Math.min(a.z, b.z), 0, maxZ);
    const maxZ2 = clampInt(Math.max(a.z, b.z), 0, maxZ);

    const sideMm = Math.max((maxX2 - minX2 + 1) * vx, (maxZ2 - minZ2 + 1) * vz);
    const depthSlices = clampInt(vy > 1e-9 ? Math.round((sideMm / vy) * depthScale) : 1, 1, ny);

    const span = computeCenteredSpan({ center: params.sliceIndex, count: depthSlices, min: 0, max: maxY });
    return {
      min: { x: minX2, y: span.lo, z: minZ2 },
      max: { x: maxX2, y: span.hi, z: maxZ2 },
    };
  }

  // sagittal
  const minY2 = clampInt(Math.min(a.y, b.y), 0, maxY);
  const maxY2 = clampInt(Math.max(a.y, b.y), 0, maxY);
  const minZ2 = clampInt(Math.min(a.z, b.z), 0, maxZ);
  const maxZ2 = clampInt(Math.max(a.z, b.z), 0, maxZ);

  const sideMm = Math.max((maxY2 - minY2 + 1) * vy, (maxZ2 - minZ2 + 1) * vz);
  const depthSlices = clampInt(vx > 1e-9 ? Math.round((sideMm / vx) * depthScale) : 1, 1, nx);

  const span = computeCenteredSpan({ center: params.sliceIndex, count: depthSlices, min: 0, max: maxX });
  return {
    min: { x: span.lo, y: minY2, z: minZ2 },
    max: { x: span.hi, y: maxY2, z: maxZ2 },
  };
}
