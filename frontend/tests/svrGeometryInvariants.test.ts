import { describe, expect, it } from 'vitest';
import { parseImageOrientationPatient, parseImagePositionPatient, parsePixelSpacingMm } from '../src/utils/svr/dicomGeometry';
import type { Vec3 } from '../src/utils/svr/vec3';
import { dot, v3 } from '../src/utils/svr/vec3';

function worldFromRc(params: {
  ippMm: Vec3;
  rowDir: Vec3;
  colDir: Vec3;
  rowSpacingMm: number;
  colSpacingMm: number;
  r: number;
  c: number;
}): Vec3 {
  const { ippMm, rowDir, colDir, rowSpacingMm, colSpacingMm, r, c } = params;

  // NOTE: This intentionally matches the convention used throughout SVR:
  // world(r, c) = IPP + colDir * (r * rowSpacing) + rowDir * (c * colSpacing)
  return v3(
    ippMm.x + colDir.x * (r * rowSpacingMm) + rowDir.x * (c * colSpacingMm),
    ippMm.y + colDir.y * (r * rowSpacingMm) + rowDir.y * (c * colSpacingMm),
    ippMm.z + colDir.z * (r * rowSpacingMm) + rowDir.z * (c * colSpacingMm)
  );
}

function rcFromWorld(params: {
  ippMm: Vec3;
  rowDir: Vec3;
  colDir: Vec3;
  rowSpacingMm: number;
  colSpacingMm: number;
  worldMm: Vec3;
}): { r: number; c: number } {
  const { ippMm, rowDir, colDir, rowSpacingMm, colSpacingMm, worldMm } = params;

  const dx = v3(worldMm.x - ippMm.x, worldMm.y - ippMm.y, worldMm.z - ippMm.z);

  return {
    r: dot(dx, colDir) / rowSpacingMm,
    c: dot(dx, rowDir) / colSpacingMm,
  };
}

describe('svr geometry invariants', () => {
  it('world(r,c) roundtrips back to (r,c) (axis-aligned, non-square spacing)', () => {
    const ippMm = parseImagePositionPatient('10\\20\\30');
    const axes = parseImageOrientationPatient('1\\0\\0\\0\\1\\0');
    const spacing = parsePixelSpacingMm('2\\3');

    expect(ippMm).not.toBeNull();
    expect(axes).not.toBeNull();
    expect(spacing).not.toBeNull();
    if (!ippMm || !axes || !spacing) return;

    const r = 5;
    const c = 7;

    const worldMm = worldFromRc({
      ippMm,
      rowDir: axes.rowDir,
      colDir: axes.colDir,
      rowSpacingMm: spacing.rowSpacingMm,
      colSpacingMm: spacing.colSpacingMm,
      r,
      c,
    });

    const back = rcFromWorld({
      ippMm,
      rowDir: axes.rowDir,
      colDir: axes.colDir,
      rowSpacingMm: spacing.rowSpacingMm,
      colSpacingMm: spacing.colSpacingMm,
      worldMm,
    });

    expect(back.r).toBeCloseTo(r, 6);
    expect(back.c).toBeCloseTo(c, 6);
  });

  it('world(r,c) roundtrips for rotated in-plane axes', () => {
    const ippMm = parseImagePositionPatient('0\\0\\0');

    // 90° rotation in the XY plane.
    // First triplet (IOP[0..2]) is +Y, second triplet (IOP[3..5]) is -X.
    const axes = parseImageOrientationPatient('0\\1\\0\\-1\\0\\0');
    const spacing = parsePixelSpacingMm('0.5\\2.0');

    expect(ippMm).not.toBeNull();
    expect(axes).not.toBeNull();
    expect(spacing).not.toBeNull();
    if (!ippMm || !axes || !spacing) return;

    const r = 11;
    const c = 3;

    const worldMm = worldFromRc({
      ippMm,
      rowDir: axes.rowDir,
      colDir: axes.colDir,
      rowSpacingMm: spacing.rowSpacingMm,
      colSpacingMm: spacing.colSpacingMm,
      r,
      c,
    });

    const back = rcFromWorld({
      ippMm,
      rowDir: axes.rowDir,
      colDir: axes.colDir,
      rowSpacingMm: spacing.rowSpacingMm,
      colSpacingMm: spacing.colSpacingMm,
      worldMm,
    });

    expect(back.r).toBeCloseTo(r, 6);
    expect(back.c).toBeCloseTo(c, 6);
  });
});
