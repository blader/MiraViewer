export type Nifti1Units = {
  spatial: 'mm' | 'm' | 'um';
  temporal?: 'sec' | 'msec' | 'usec' | 'hz' | 'ppm' | 'rads';
};

function clampAscii(s: string, maxBytes: number): Uint8Array {
  const out = new Uint8Array(maxBytes);
  const enc = new TextEncoder();
  const bytes = enc.encode(s);
  out.set(bytes.subarray(0, maxBytes));
  return out;
}

function unitsToXyzt(units: Nifti1Units | undefined): number {
  const spatial = units?.spatial ?? 'mm';
  const temporal = units?.temporal;

  const spatialCode = spatial === 'm' ? 1 : spatial === 'mm' ? 2 : 3; // um

  const temporalCode =
    temporal === 'msec'
      ? 16
      : temporal === 'usec'
        ? 24
        : temporal === 'hz'
          ? 32
          : temporal === 'ppm'
            ? 40
            : temporal === 'rads'
              ? 48
              : temporal === 'sec'
                ? 8
                : 0;

  return spatialCode | temporalCode;
}

export function buildNifti1Uint8(params: {
  /** Flattened in X-fastest order (length = nx*ny*nz). */
  data: Uint8Array;
  dims: [number, number, number];
  voxelSizeMm: [number, number, number];
  description?: string;
  /** Defaults to mm. */
  units?: Nifti1Units;
}): ArrayBuffer {
  const [nx, ny, nz] = params.dims;

  if (!(nx > 0 && ny > 0 && nz > 0)) {
    throw new Error(`buildNifti1Uint8: invalid dims ${nx}x${ny}x${nz}`);
  }

  const expected = nx * ny * nz;
  if (params.data.length !== expected) {
    throw new Error(`buildNifti1Uint8: data length mismatch (expected ${expected}, got ${params.data.length})`);
  }

  // NIfTI-1 .nii = 348-byte header + 4-byte extension + payload.
  const HEADER_BYTES = 348;
  const VOX_OFFSET = 352;

  const header = new ArrayBuffer(HEADER_BYTES);
  const dv = new DataView(header);

  // Little-endian NIfTI-1.
  dv.setInt32(0, HEADER_BYTES, true); // sizeof_hdr

  // dim[0..7] (int16), starting at offset 40.
  dv.setInt16(40, 3, true); // 3D
  dv.setInt16(42, nx, true);
  dv.setInt16(44, ny, true);
  dv.setInt16(46, nz, true);
  dv.setInt16(48, 1, true); // dim[4]
  dv.setInt16(50, 1, true);
  dv.setInt16(52, 1, true);
  dv.setInt16(54, 1, true);

  // datatype + bitpix.
  // NIfTI datatype codes: uint8 = 2, bitpix = 8.
  dv.setInt16(70, 2, true); // datatype
  dv.setInt16(72, 8, true); // bitpix

  // pixdim[0..7] (float32), starting at offset 76.
  // pixdim[0] is qfac; keep 1.
  dv.setFloat32(76, 1, true);

  const vx = Math.abs(params.voxelSizeMm[0]);
  const vy = Math.abs(params.voxelSizeMm[1]);
  const vz = Math.abs(params.voxelSizeMm[2]);
  dv.setFloat32(80, vx, true);
  dv.setFloat32(84, vy, true);
  dv.setFloat32(88, vz, true);

  // vox_offset (float32)
  dv.setFloat32(108, VOX_OFFSET, true);

  // Scaling: identity.
  dv.setFloat32(112, 1, true); // scl_slope
  dv.setFloat32(116, 0, true); // scl_inter

  // Units.
  dv.setUint8(123, unitsToXyzt(params.units));

  // descrip[80] at offset 148.
  if (params.description) {
    new Uint8Array(header, 148, 80).set(clampAscii(params.description, 80));
  }

  // Prefer sform affine: voxel -> mm (diagonal).
  dv.setInt16(252, 0, true); // qform_code
  dv.setInt16(254, 1, true); // sform_code

  // srow_x/y/z at offsets 280/296/312.
  // Affine maps (i,j,k,1) to world mm.
  // srow_x = [vx, 0,  0, 0]
  // srow_y = [0,  vy, 0, 0]
  // srow_z = [0,  0,  vz, 0]
  dv.setFloat32(280, vx, true);
  dv.setFloat32(284, 0, true);
  dv.setFloat32(288, 0, true);
  dv.setFloat32(292, 0, true);

  dv.setFloat32(296, 0, true);
  dv.setFloat32(300, vy, true);
  dv.setFloat32(304, 0, true);
  dv.setFloat32(308, 0, true);

  dv.setFloat32(312, 0, true);
  dv.setFloat32(316, 0, true);
  dv.setFloat32(320, vz, true);
  dv.setFloat32(324, 0, true);

  // magic[4] at offset 344: "n+1\0" for .nii
  dv.setUint8(344, 'n'.charCodeAt(0));
  dv.setUint8(345, '+'.charCodeAt(0));
  dv.setUint8(346, '1'.charCodeAt(0));
  dv.setUint8(347, 0);

  const out = new Uint8Array(VOX_OFFSET + params.data.length);

  // Header.
  out.set(new Uint8Array(header), 0);

  // Extension bytes (4): all zeros.
  out[348] = 0;
  out[349] = 0;
  out[350] = 0;
  out[351] = 0;

  // Payload.
  out.set(params.data, VOX_OFFSET);

  return out.buffer;
}
