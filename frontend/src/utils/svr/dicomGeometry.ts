import type { DicomInstance } from '../../db/schema';
import type { Vec3 } from './vec3';
import { cross, dot, normalize, v3 } from './vec3';

function parseMultiNumberString(value: string): number[] {
  // Multi-valued DICOM tags are typically separated by backslashes.
  // Some exporters use commas/spaces; accept those as well.
  return value
    .split(/[\\,\s]+/)
    .filter(Boolean)
    .map((s) => Number.parseFloat(s))
    .filter((n) => Number.isFinite(n));
}

export type SliceAxes = {
  rowDir: Vec3;
  colDir: Vec3;
  normalDir: Vec3;
};

export function parseImageOrientationPatient(iop: string | undefined): SliceAxes | null {
  if (!iop) return null;
  const nums = parseMultiNumberString(iop);
  if (nums.length < 6) return null;

  const rowDir = normalize(v3(nums[0] ?? 0, nums[1] ?? 0, nums[2] ?? 0));
  const colDir = normalize(v3(nums[3] ?? 0, nums[4] ?? 0, nums[5] ?? 0));

  // Slice normal is row x col.
  const normalDir = normalize(cross(rowDir, colDir));

  // If the DICOM is malformed (col/row not orthogonal), normal could be zero.
  if (!Number.isFinite(normalDir.x) || !Number.isFinite(normalDir.y) || !Number.isFinite(normalDir.z)) {
    return null;
  }

  return { rowDir, colDir, normalDir };
}

export function parseImagePositionPatient(ipp: string | undefined): Vec3 | null {
  if (!ipp) return null;
  const nums = parseMultiNumberString(ipp);
  if (nums.length < 3) return null;
  return v3(nums[0] ?? 0, nums[1] ?? 0, nums[2] ?? 0);
}

export function parsePixelSpacingMm(pixelSpacing: string | undefined): { rowSpacingMm: number; colSpacingMm: number } | null {
  if (!pixelSpacing) return null;
  const nums = parseMultiNumberString(pixelSpacing);
  if (nums.length < 2) return null;

  const rowSpacingMm = nums[0] ?? NaN;
  const colSpacingMm = nums[1] ?? NaN;

  if (!Number.isFinite(rowSpacingMm) || !Number.isFinite(colSpacingMm) || rowSpacingMm <= 0 || colSpacingMm <= 0) {
    return null;
  }

  return { rowSpacingMm, colSpacingMm };
}

export type SliceGeometry = {
  rows: number;
  cols: number;
  ippMm: Vec3;
  rowDir: Vec3;
  colDir: Vec3;
  normalDir: Vec3;
  rowSpacingMm: number;
  colSpacingMm: number;
};

export function getSliceGeometryFromInstance(instance: Pick<DicomInstance, 'rows' | 'columns' | 'imagePositionPatient' | 'imageOrientationPatient' | 'pixelSpacing'>): SliceGeometry {
  const axes = parseImageOrientationPatient(instance.imageOrientationPatient);
  const ipp = parseImagePositionPatient(instance.imagePositionPatient);
  const spacing = parsePixelSpacingMm(instance.pixelSpacing);

  if (!axes || !ipp || !spacing) {
    throw new Error('Missing spatial metadata (ImagePositionPatient / ImageOrientationPatient / PixelSpacing)');
  }

  return {
    rows: instance.rows,
    cols: instance.columns,
    ippMm: ipp,
    rowDir: axes.rowDir,
    colDir: axes.colDir,
    normalDir: axes.normalDir,
    rowSpacingMm: spacing.rowSpacingMm,
    colSpacingMm: spacing.colSpacingMm,
  };
}

export function sliceCornersMm(params: {
  ippMm: Vec3;
  rowDir: Vec3;
  colDir: Vec3;
  rowSpacingMm: number;
  colSpacingMm: number;
  rows: number;
  cols: number;
}): Vec3[] {
  const { ippMm, rowDir, colDir, rowSpacingMm, colSpacingMm, rows, cols } = params;

  const rMax = Math.max(0, rows - 1);
  const cMax = Math.max(0, cols - 1);

  // DICOM convention recap:
  // - ImageOrientationPatient (IOP): first triplet is the direction of increasing *column* index,
  //   second triplet is the direction of increasing *row* index.
  // - PixelSpacing: [rowSpacing, colSpacing] in mm.
  //
  // Therefore: world(r, c) = IPP + colDir * (r * rowSpacing) + rowDir * (c * colSpacing).
  const p00 = ippMm;
  const p10 = v3(
    ippMm.x + colDir.x * (rMax * rowSpacingMm),
    ippMm.y + colDir.y * (rMax * rowSpacingMm),
    ippMm.z + colDir.z * (rMax * rowSpacingMm)
  );
  const p01 = v3(
    ippMm.x + rowDir.x * (cMax * colSpacingMm),
    ippMm.y + rowDir.y * (cMax * colSpacingMm),
    ippMm.z + rowDir.z * (cMax * colSpacingMm)
  );
  const p11 = v3(
    p10.x + rowDir.x * (cMax * colSpacingMm),
    p10.y + rowDir.y * (cMax * colSpacingMm),
    p10.z + rowDir.z * (cMax * colSpacingMm)
  );

  return [p00, p01, p10, p11];
}

function median(values: number[]): number | null {
  const v = values.filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
  if (v.length === 0) return null;
  const mid = Math.floor(v.length / 2);
  return v.length % 2 === 1 ? v[mid] ?? null : ((v[mid - 1] ?? 0) + (v[mid] ?? 0)) / 2;
}

export function estimateSliceSpacingMm(
  instances: Array<Pick<DicomInstance, 'imagePositionPatient' | 'imageOrientationPatient'>>
): number | null {
  if (instances.length < 2) return null;

  const firstAxes = parseImageOrientationPatient(instances[0]?.imageOrientationPatient);
  if (!firstAxes) return null;

  const ipps: Vec3[] = [];
  for (const inst of instances) {
    const ipp = parseImagePositionPatient(inst.imagePositionPatient);
    if (ipp) ipps.push(ipp);
  }

  if (ipps.length < 2) return null;

  const deltas: number[] = [];
  for (let i = 0; i < ipps.length - 1; i++) {
    const a = ipps[i];
    const b = ipps[i + 1];
    if (!a || !b) continue;

    const d = v3(b.x - a.x, b.y - a.y, b.z - a.z);
    const along = Math.abs(dot(d, firstAxes.normalDir));
    if (Number.isFinite(along) && along > 0) {
      deltas.push(along);
    }
  }

  return median(deltas);
}
