import type { SvrParams, SvrRoi, SvrPatientTransform } from '../../types/svr';
import type { SeriesFrameManifest } from '../localApi';
import { getSliceGeometryFromInstance } from './dicomGeometry';
import type { Vec3 } from './vec3';
import { dot, v3 } from './vec3';
import { inverseTransformPoint } from './volumeGeometry';

export type BoundsMm = { min: Vec3; max: Vec3 };

const MAX_RIGID_TRANSLATION_MM = 20;
const MAX_RIGID_ROTATION_DISPLACEMENT = 2 * Math.sin((3 * 10 * Math.PI) / 360);

export type CropSlice = {
  pixels: Float32Array;
  /** Acquired-pixel support is inseparable from the corresponding pixel grid. */
  valid?: Uint8Array;
  dsRows: number;
  dsCols: number;

  ippMm: Vec3;
  rowDir: Vec3;
  colDir: Vec3;
  normalDir: Vec3;

  rowSpacingDsMm: number;
  colSpacingDsMm: number;
  sliceThicknessMm?: number | null;
  spacingBetweenSlicesMm?: number | null;
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

/** Keep every physical source slab that could contribute to the selected focus region. */
export function filterSvrManifestFramesForRoi(
  manifest: SeriesFrameManifest,
  roi: SvrRoi | null | undefined,
  params: Pick<SvrParams, 'targetVoxelSizeMm' | 'maxVolumeDim' | 'seriesRegistrationMode'>,
  acceptedTransform?: SvrPatientTransform,
): SeriesFrameManifest {
  // Coarse bounds-center registration can translate sources without a physical bound.
  if (!roi || (params.seriesRegistrationMode === 'bounds-center' && !acceptedTransform)) return manifest;

  const spans = roi.boundsMm.min.map((lower, axis) => roi.boundsMm.max[axis]! - lower);
  if (
    spans.some((span) => !Number.isFinite(span) || span < 0) ||
    roi.boundsMm.min.some((coordinate) => !Number.isFinite(coordinate))
  ) {
    throw new Error('The SVR focus region has invalid patient-space bounds');
  }

  const corners = boundsCornersMm({ min: v3(...roi.boundsMm.min), max: v3(...roi.boundsMm.max) }).map((point) =>
    acceptedTransform ? v3(...inverseTransformPoint(acceptedTransform, [point.x, point.y, point.z])) : point,
  );
  const regionExtentMm = Math.hypot(...spans);
  const requestedVoxelSizeMm =
    Number.isFinite(params.targetVoxelSizeMm) && params.targetVoxelSizeMm > 0 ? params.targetVoxelSizeMm : 1;
  const maxVolumeDim = Math.max(2, Math.floor(params.maxVolumeDim));
  const outputVoxelMarginMm = Math.max(requestedVoxelSizeMm, Math.max(...spans) / Math.max(1, maxVolumeDim - 1));
  const rigidRegistration = params.seriesRegistrationMode === 'roi-rigid' && !acceptedTransform;

  const frames = manifest.frames.filter((frame) => {
    const geometry = getSliceGeometryFromInstance(frame);
    const normal = geometry.normalDir;
    let regionMin = Number.POSITIVE_INFINITY;
    let regionMax = Number.NEGATIVE_INFINITY;
    for (const corner of corners) {
      const position = dot(corner, normal);
      regionMin = Math.min(regionMin, position);
      regionMax = Math.max(regionMax, position);
    }

    const declaredThicknessMm = frame.sliceThickness;
    const spacingMm = frame.spacingBetweenSlices ?? manifest.sliceSpacingMm;
    const profileThicknessMm =
      typeof declaredThicknessMm === 'number' && declaredThicknessMm > 0
        ? declaredThicknessMm
        : typeof spacingMm === 'number' && spacingMm > 0
          ? spacingMm
          : requestedVoxelSizeMm;
    const profileMarginMm = profileThicknessMm / 2;
    const interpolationMarginMm = Math.max(outputVoxelMarginMm, geometry.rowSpacingMm, geometry.colSpacingMm);
    let marginMm = profileMarginMm + interpolationMarginMm;

    if (rigidRegistration) {
      // Three independent 10-degree Euler rotations have a composed angular
      // displacement no greater than 30 degrees. A source point capable of
      // entering the ROI lies within its full diagonal plus the maximum
      // translation, physical slice profile, and output sampling footprint.
      const translationMarginMm =
        MAX_RIGID_TRANSLATION_MM * (Math.abs(normal.x) + Math.abs(normal.y) + Math.abs(normal.z));
      const rotationRadiusMm =
        regionExtentMm + MAX_RIGID_TRANSLATION_MM * Math.sqrt(3) + profileMarginMm + interpolationMarginMm;
      marginMm += translationMarginMm + MAX_RIGID_ROTATION_DISPLACEMENT * rotationRadiusMm;
    }

    const slicePositionMm = dot(geometry.ippMm, normal);
    return slicePositionMm >= regionMin - marginMm && slicePositionMm <= regionMax + marginMm;
  });

  return frames.length === manifest.frames.length ? manifest : { ...manifest, frames };
}

/** Native-pixel window shared by admission budgeting and decoding; registered ROIs are inverse-mapped. */
export function getSvrSourceCropWindow(
  frame: SeriesFrameManifest['frames'][number],
  roi: SvrRoi | null | undefined,
  params: Pick<SvrParams, 'targetVoxelSizeMm' | 'maxVolumeDim' | 'seriesRegistrationMode'>,
  acceptedTransform?: SvrPatientTransform,
) {
  const geometry = getSliceGeometryFromInstance(frame);
  const full = { rowStart: 0, columnStart: 0, rows: geometry.rows, columns: geometry.cols, originMm: geometry.ippMm };
  if (!roi || (params.seriesRegistrationMode === 'bounds-center' && !acceptedTransform)) return full;
  const spans = roi.boundsMm.min.map((value, axis) => roi.boundsMm.max[axis]! - value);
  const outputPitch = Math.max(params.targetVoxelSizeMm, Math.max(...spans) / Math.max(1, params.maxVolumeDim - 1));
  const profile = Math.max(0, frame.sliceThickness ?? 0) / 2;
  const registrationMargin =
    !acceptedTransform && params.seriesRegistrationMode === 'roi-rigid'
      ? MAX_RIGID_TRANSLATION_MM +
        MAX_RIGID_ROTATION_DISPLACEMENT *
          (Math.hypot(...spans) + MAX_RIGID_TRANSLATION_MM * Math.sqrt(3) + profile + outputPitch)
      : 0;
  const lower = roi.boundsMm.min.map((value) => value - registrationMargin);
  const upper = roi.boundsMm.max.map((value) => value + registrationMargin);
  let minRow = Infinity,
    maxRow = -Infinity,
    minColumn = Infinity,
    maxColumn = -Infinity;
  for (const x of [lower[0]!, upper[0]!])
    for (const y of [lower[1]!, upper[1]!])
      for (const z of [lower[2]!, upper[2]!]) {
        const point = acceptedTransform ? inverseTransformPoint(acceptedTransform, [x, y, z]) : [x, y, z];
        const delta = v3(point[0]! - geometry.ippMm.x, point[1]! - geometry.ippMm.y, point[2]! - geometry.ippMm.z);
        const row = dot(delta, geometry.colDir) / geometry.rowSpacingMm;
        const column = dot(delta, geometry.rowDir) / geometry.colSpacingMm;
        minRow = Math.min(minRow, row);
        maxRow = Math.max(maxRow, row);
        minColumn = Math.min(minColumn, column);
        maxColumn = Math.max(maxColumn, column);
      }
  const rowPadding = Math.ceil(outputPitch / geometry.rowSpacingMm) + 1;
  const columnPadding = Math.ceil(outputPitch / geometry.colSpacingMm) + 1;
  const rowStart = Math.max(0, Math.min(geometry.rows - 1, Math.floor(minRow) - rowPadding));
  const columnStart = Math.max(0, Math.min(geometry.cols - 1, Math.floor(minColumn) - columnPadding));
  const rowEnd = Math.max(rowStart, Math.min(geometry.rows - 1, Math.ceil(maxRow) + rowPadding));
  const columnEnd = Math.max(columnStart, Math.min(geometry.cols - 1, Math.ceil(maxColumn) + columnPadding));
  return {
    rowStart,
    columnStart,
    rows: rowEnd - rowStart + 1,
    columns: columnEnd - columnStart + 1,
    originMm: v3(
      geometry.ippMm.x +
        geometry.colDir.x * rowStart * geometry.rowSpacingMm +
        geometry.rowDir.x * columnStart * geometry.colSpacingMm,
      geometry.ippMm.y +
        geometry.colDir.y * rowStart * geometry.rowSpacingMm +
        geometry.rowDir.y * columnStart * geometry.colSpacingMm,
      geometry.ippMm.z +
        geometry.colDir.z * rowStart * geometry.rowSpacingMm +
        geometry.rowDir.z * columnStart * geometry.colSpacingMm,
    ),
  };
}

export function cropSliceToRoiInPlace(slice: CropSlice, roiCorners: Vec3[], interpolationMarginMm = 0): boolean {
  if (slice.valid && slice.valid.length !== slice.pixels.length) {
    throw new Error('SVR acquired-pixel support does not match its image dimensions');
  }

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

  const thicknessMm = slice.sliceThicknessMm ?? slice.spacingBetweenSlicesMm ?? 0;
  // The physical slice slab, not just its center plane, contributes to the PSF.
  const tol = 1e-3 + interpolationMarginMm + (Number.isFinite(thicknessMm) && thicknessMm > 0 ? thicknessMm / 2 : 0);
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
  const rowPadding = Math.ceil(interpolationMarginMm / slice.rowSpacingDsMm) + 1;
  const columnPadding = Math.ceil(interpolationMarginMm / slice.colSpacingDsMm) + 1;
  const r0 = Math.max(0, Math.min(slice.dsRows - 1, Math.floor(minR) - rowPadding));
  const r1 = Math.max(0, Math.min(slice.dsRows - 1, Math.ceil(maxR) + rowPadding));
  const c0 = Math.max(0, Math.min(slice.dsCols - 1, Math.floor(minC) - columnPadding));
  const c1 = Math.max(0, Math.min(slice.dsCols - 1, Math.ceil(maxC) + columnPadding));

  if (r1 < r0 || c1 < c0) return false;

  const nextRows = r1 - r0 + 1;
  const nextCols = c1 - c0 + 1;

  const oldCols = slice.dsCols;
  const oldPixels = slice.pixels;

  if (nextRows === slice.dsRows && nextCols === slice.dsCols) {
    return true;
  }

  const nextPixels = new Float32Array(nextRows * nextCols);
  const nextValid = slice.valid ? new Uint8Array(nextRows * nextCols) : undefined;

  for (let r = r0; r <= r1; r++) {
    const oldBase = r * oldCols + c0;
    const newBase = (r - r0) * nextCols;
    nextPixels.set(oldPixels.subarray(oldBase, oldBase + nextCols), newBase);
    if (nextValid && slice.valid) {
      nextValid.set(slice.valid.subarray(oldBase, oldBase + nextCols), newBase);
    }
  }

  // Shift IPP so (r0,c0) becomes the new (0,0) for the cropped pixel buffer.
  slice.ippMm = v3(
    slice.ippMm.x + slice.colDir.x * (r0 * slice.rowSpacingDsMm) + slice.rowDir.x * (c0 * slice.colSpacingDsMm),
    slice.ippMm.y + slice.colDir.y * (r0 * slice.rowSpacingDsMm) + slice.rowDir.y * (c0 * slice.colSpacingDsMm),
    slice.ippMm.z + slice.colDir.z * (r0 * slice.rowSpacingDsMm) + slice.rowDir.z * (c0 * slice.colSpacingDsMm),
  );

  slice.dsRows = nextRows;
  slice.dsCols = nextCols;
  slice.pixels = nextPixels;
  if (nextValid) slice.valid = nextValid;

  return true;
}
