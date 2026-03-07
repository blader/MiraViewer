import type { Vec3 } from './vec3';
import { dot, v3 } from './vec3';

export type BoundsMm = { min: Vec3; max: Vec3 };

export type CropSlice = {
  pixels: Float32Array;
  dsRows: number;
  dsCols: number;

  ippMm: Vec3;
  rowDir: Vec3;
  colDir: Vec3;
  normalDir: Vec3;

  rowSpacingDsMm: number;
  colSpacingDsMm: number;
};

export function boundsCornersMm(bounds: BoundsMm): Vec3[] {
  const xs = [bounds.min.x, bounds.max.x];
  const ys = [bounds.min.y, bounds.max.y];
  const zs = [bounds.min.z, bounds.max.z];

  const corners: Vec3[] = [];
  for (const x of xs) {
    for (const y of ys) {
      for (const z of zs) {
        corners.push(v3(x, y, z));
      }
    }
  }
  return corners;
}

export function cropSliceToRoiInPlace(slice: CropSlice, roiCorners: Vec3[]): boolean {
  // Reject slices whose plane does not intersect the ROI slab along its normal.
  const n = slice.normalDir;
  const planeD = dot(slice.ippMm, n);

  let minD = Number.POSITIVE_INFINITY;
  let maxD = Number.NEGATIVE_INFINITY;
  for (const c of roiCorners) {
    const d = dot(c, n);
    if (d < minD) minD = d;
    if (d > maxD) maxD = d;
  }

  // Small tolerance to avoid dropping boundary slices due to float noise.
  const tol = 1e-3;
  if (planeD < minD - tol || planeD > maxD + tol) {
    return false;
  }

  // Compute a conservative pixel-space bounding box by projecting ROI corners into the slice basis.
  let minR = Number.POSITIVE_INFINITY;
  let maxR = Number.NEGATIVE_INFINITY;
  let minC = Number.POSITIVE_INFINITY;
  let maxC = Number.NEGATIVE_INFINITY;

  for (const p of roiCorners) {
    const dx = p.x - slice.ippMm.x;
    const dy = p.y - slice.ippMm.y;
    const dz = p.z - slice.ippMm.z;

    // DICOM mapping: world(r,c) = IPP + colDir*(r*rowSpacing) + rowDir*(c*colSpacing)
    const r = (dx * slice.colDir.x + dy * slice.colDir.y + dz * slice.colDir.z) / slice.rowSpacingDsMm;
    const c = (dx * slice.rowDir.x + dy * slice.rowDir.y + dz * slice.rowDir.z) / slice.colSpacingDsMm;

    if (r < minR) minR = r;
    if (r > maxR) maxR = r;
    if (c < minC) minC = c;
    if (c > maxC) maxC = c;
  }

  if (!Number.isFinite(minR) || !Number.isFinite(minC)) return false;

  // Expand slightly; we want to be conservative.
  const r0 = Math.max(0, Math.min(slice.dsRows - 1, Math.floor(minR) - 1));
  const r1 = Math.max(0, Math.min(slice.dsRows - 1, Math.ceil(maxR) + 1));
  const c0 = Math.max(0, Math.min(slice.dsCols - 1, Math.floor(minC) - 1));
  const c1 = Math.max(0, Math.min(slice.dsCols - 1, Math.ceil(maxC) + 1));

  if (r1 < r0 || c1 < c0) return false;

  const nextRows = r1 - r0 + 1;
  const nextCols = c1 - c0 + 1;

  const oldCols = slice.dsCols;
  const oldPixels = slice.pixels;

  const nextPixels = new Float32Array(nextRows * nextCols);

  for (let r = r0; r <= r1; r++) {
    const oldBase = r * oldCols + c0;
    const newBase = (r - r0) * nextCols;
    nextPixels.set(oldPixels.subarray(oldBase, oldBase + nextCols), newBase);
  }

  // Shift IPP so (r0,c0) becomes the new (0,0) for the cropped pixel buffer.
  slice.ippMm = v3(
    slice.ippMm.x + slice.colDir.x * (r0 * slice.rowSpacingDsMm) + slice.rowDir.x * (c0 * slice.colSpacingDsMm),
    slice.ippMm.y + slice.colDir.y * (r0 * slice.rowSpacingDsMm) + slice.rowDir.y * (c0 * slice.colSpacingDsMm),
    slice.ippMm.z + slice.colDir.z * (r0 * slice.rowSpacingDsMm) + slice.rowDir.z * (c0 * slice.colSpacingDsMm)
  );

  slice.dsRows = nextRows;
  slice.dsCols = nextCols;
  slice.pixels = nextPixels;

  return true;
}
