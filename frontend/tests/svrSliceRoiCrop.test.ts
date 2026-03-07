import { describe, expect, it } from 'vitest';
import { boundsCornersMm, cropSliceToRoiInPlace } from '../src/utils/svr/sliceRoiCrop';

function makeGridPixels(rows: number, cols: number): Float32Array {
  const out = new Float32Array(rows * cols);
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      out[r * cols + c] = r * 100 + c;
    }
  }
  return out;
}

describe('svr/sliceRoiCrop', () => {
  it('crops an axial slice and shifts IPP so (r0,c0) becomes the new origin', () => {
    const slice = {
      pixels: makeGridPixels(10, 10),
      dsRows: 10,
      dsCols: 10,
      ippMm: { x: 0, y: 0, z: 5 },
      // world(r,c) = IPP + colDir*(r*rowSpacing) + rowDir*(c*colSpacing)
      rowDir: { x: 1, y: 0, z: 0 },
      colDir: { x: 0, y: 1, z: 0 },
      normalDir: { x: 0, y: 0, z: 1 },
      rowSpacingDsMm: 1,
      colSpacingDsMm: 1,
    };

    const bounds = {
      min: { x: 2, y: 3, z: 4 },
      max: { x: 5, y: 7, z: 6 },
    };

    const corners = boundsCornersMm(bounds);
    const ok = cropSliceToRoiInPlace(slice, corners);
    expect(ok).toBe(true);

    // For this axis-aligned slice:
    // r corresponds to +Y, c corresponds to +X.
    // We conservatively expand by 1px: r0=floor(3)-1=2, r1=ceil(7)+1=8 => 7 rows
    // c0=floor(2)-1=1, c1=ceil(5)+1=6 => 6 cols
    expect(slice.dsRows).toBe(7);
    expect(slice.dsCols).toBe(6);

    // New IPP is shifted by (r0,c0) in world space:
    // IPP' = IPP + colDir*(r0*rowSpacing) + rowDir*(c0*colSpacing)
    expect(slice.ippMm).toEqual({ x: 1, y: 2, z: 5 });

    // New (0,0) pixel should match old (r0,c0).
    expect(slice.pixels[0]).toBe(2 * 100 + 1);
  });

  it('rejects a slice when ROI slab does not intersect the slice plane', () => {
    const slice = {
      pixels: makeGridPixels(10, 10),
      dsRows: 10,
      dsCols: 10,
      ippMm: { x: 0, y: 0, z: 5 },
      rowDir: { x: 1, y: 0, z: 0 },
      colDir: { x: 0, y: 1, z: 0 },
      normalDir: { x: 0, y: 0, z: 1 },
      rowSpacingDsMm: 1,
      colSpacingDsMm: 1,
    };

    const before = {
      dsRows: slice.dsRows,
      dsCols: slice.dsCols,
      ipp: { ...slice.ippMm },
    };

    const bounds = {
      min: { x: 0, y: 0, z: 10 },
      max: { x: 1, y: 1, z: 11 },
    };

    const corners = boundsCornersMm(bounds);
    const ok = cropSliceToRoiInPlace(slice, corners);
    expect(ok).toBe(false);

    // Slice should remain unchanged.
    expect(slice.dsRows).toBe(before.dsRows);
    expect(slice.dsCols).toBe(before.dsCols);
    expect(slice.ippMm).toEqual(before.ipp);
  });
});
