import { describe, expect, it } from 'vitest';
import { buildNifti1Uint8 } from '../src/utils/segmentation/nifti1';

describe('buildNifti1Uint8', () => {
  it('writes a minimal .nii with correct header + payload', () => {
    const dims: [number, number, number] = [2, 3, 1];
    const voxelSizeMm: [number, number, number] = [1.5, 2.0, 3.0];
    const data = new Uint8Array([0, 1, 2, 3, 4, 5]);

    const buf = buildNifti1Uint8({ data, dims, voxelSizeMm, description: 'unit test' });
    expect(buf.byteLength).toBe(352 + data.length);

    const dv = new DataView(buf);

    // sizeof_hdr
    expect(dv.getInt32(0, true)).toBe(348);

    // dim
    expect(dv.getInt16(40, true)).toBe(3);
    expect(dv.getInt16(42, true)).toBe(2);
    expect(dv.getInt16(44, true)).toBe(3);
    expect(dv.getInt16(46, true)).toBe(1);

    // datatype (uint8) + bitpix
    expect(dv.getInt16(70, true)).toBe(2);
    expect(dv.getInt16(72, true)).toBe(8);

    // vox_offset
    expect(dv.getFloat32(108, true)).toBe(352);

    // pixdim
    expect(dv.getFloat32(80, true)).toBeCloseTo(1.5);
    expect(dv.getFloat32(84, true)).toBeCloseTo(2.0);
    expect(dv.getFloat32(88, true)).toBeCloseTo(3.0);

    // magic
    const magic = String.fromCharCode(dv.getUint8(344), dv.getUint8(345), dv.getUint8(346));
    expect(magic).toBe('n+1');

    // payload
    const payload = new Uint8Array(buf, 352);
    expect(Array.from(payload)).toEqual(Array.from(data));
  });

  it('throws on size mismatch', () => {
    expect(() => buildNifti1Uint8({ data: new Uint8Array([1, 2, 3]), dims: [2, 2, 1], voxelSizeMm: [1, 1, 1] })).toThrow(
      /data length mismatch/i
    );
  });
});
