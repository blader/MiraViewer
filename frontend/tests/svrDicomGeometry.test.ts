import { describe, expect, it } from 'vitest';
import {
  parseImageOrientationPatient,
  parseImagePositionPatient,
  parsePixelSpacingMm,
  sliceCornersMm,
} from '../src/utils/svr/dicomGeometry';

describe('svr/dicomGeometry', () => {
  it('parses PixelSpacing', () => {
    expect(parsePixelSpacingMm('0.5\\0.6')).toEqual({ rowSpacingMm: 0.5, colSpacingMm: 0.6 });
  });

  it('parses ImagePositionPatient', () => {
    expect(parseImagePositionPatient('1\\2\\3')).toEqual({ x: 1, y: 2, z: 3 });
  });

  it('parses ImageOrientationPatient and computes a normal', () => {
    const axes = parseImageOrientationPatient('1\\0\\0\\0\\1\\0');
    expect(axes).not.toBeNull();
    if (!axes) return;

    expect(axes.rowDir.x).toBeCloseTo(1);
    expect(axes.rowDir.y).toBeCloseTo(0);
    expect(axes.rowDir.z).toBeCloseTo(0);

    expect(axes.colDir.x).toBeCloseTo(0);
    expect(axes.colDir.y).toBeCloseTo(1);
    expect(axes.colDir.z).toBeCloseTo(0);

    // Right-hand rule: row x col = +Z
    expect(axes.normalDir.x).toBeCloseTo(0);
    expect(axes.normalDir.y).toBeCloseTo(0);
    expect(axes.normalDir.z).toBeCloseTo(1);
  });

  it('computes slice corners using DICOM row/col conventions (non-square spacing)', () => {
    const axes = parseImageOrientationPatient('1\\0\\0\\0\\1\\0');
    expect(axes).not.toBeNull();
    if (!axes) return;

    const corners = sliceCornersMm({
      ippMm: { x: 0, y: 0, z: 0 },
      rowDir: axes.rowDir,
      colDir: axes.colDir,
      rowSpacingMm: 2,
      colSpacingMm: 3,
      rows: 2,
      cols: 2,
    });

    // (row=0,col=1) goes +X by colSpacing
    expect(corners[1]).toEqual({ x: 3, y: 0, z: 0 });
    // (row=1,col=0) goes +Y by rowSpacing
    expect(corners[2]).toEqual({ x: 0, y: 2, z: 0 });
    // (row=1,col=1)
    expect(corners[3]).toEqual({ x: 3, y: 2, z: 0 });
  });
});
