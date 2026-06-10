export type VolumeDims = { nx: number; ny: number; nz: number };

// These two functions are the innermost hot path of SVR reconstruction — they run once
// per PSF sample per pixel per iteration (billions of calls on a real dataset). Both use
// hoisted row/slice strides and derive all 8 corner indices from one base index with
// integer offsets (+1 / +strideY / +strideZ) instead of recomputing x + y*nx + z*nx*ny
// per corner: identical integer results, ~7 fewer multiplies per call, and no reliance on
// the JIT inlining a helper.

export function sampleTrilinear(volume: Float32Array, dims: VolumeDims, x: number, y: number, z: number): number {
  const { nx, ny, nz } = dims;

  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const z0 = Math.floor(z);

  const x1 = x0 + 1;
  const y1 = y0 + 1;
  const z1 = z0 + 1;

  if (x0 < 0 || y0 < 0 || z0 < 0 || x1 >= nx || y1 >= ny || z1 >= nz) {
    return 0;
  }

  const fx = x - x0;
  const fy = y - y0;
  const fz = z - z0;

  const wx0 = 1 - fx;
  const wy0 = 1 - fy;
  const wz0 = 1 - fz;
  const wx1 = fx;
  const wy1 = fy;
  const wz1 = fz;

  const strideY = nx;
  const strideZ = nx * ny;
  const i000 = x0 + y0 * strideY + z0 * strideZ;

  const c000 = volume[i000];
  const c100 = volume[i000 + 1];
  const c010 = volume[i000 + strideY];
  const c110 = volume[i000 + strideY + 1];
  const c001 = volume[i000 + strideZ];
  const c101 = volume[i000 + strideZ + 1];
  const c011 = volume[i000 + strideZ + strideY];
  const c111 = volume[i000 + strideZ + strideY + 1];

  const v00 = c000 * wx0 + c100 * wx1;
  const v10 = c010 * wx0 + c110 * wx1;
  const v01 = c001 * wx0 + c101 * wx1;
  const v11 = c011 * wx0 + c111 * wx1;

  const v0 = v00 * wy0 + v10 * wy1;
  const v1 = v01 * wy0 + v11 * wy1;

  return v0 * wz0 + v1 * wz1;
}

export function splatTrilinear(
  accum: Float32Array,
  weight: Float32Array,
  dims: VolumeDims,
  x: number,
  y: number,
  z: number,
  value: number,
): void {
  splatTrilinearScaled(accum, weight, dims, x, y, z, value, 1);
}

export function splatTrilinearScaled(
  accum: Float32Array,
  weight: Float32Array,
  dims: VolumeDims,
  x: number,
  y: number,
  z: number,
  value: number,
  weightScale: number,
): void {
  const { nx, ny, nz } = dims;

  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const z0 = Math.floor(z);

  const x1 = x0 + 1;
  const y1 = y0 + 1;
  const z1 = z0 + 1;

  if (x0 < 0 || y0 < 0 || z0 < 0 || x1 >= nx || y1 >= ny || z1 >= nz) {
    return;
  }

  const fx = x - x0;
  const fy = y - y0;
  const fz = z - z0;

  const wx0 = 1 - fx;
  const wy0 = 1 - fy;
  const wz0 = 1 - fz;
  const wx1 = fx;
  const wy1 = fy;
  const wz1 = fz;

  const w000 = wx0 * wy0 * wz0;
  const w100 = wx1 * wy0 * wz0;
  const w010 = wx0 * wy1 * wz0;
  const w110 = wx1 * wy1 * wz0;
  const w001 = wx0 * wy0 * wz1;
  const w101 = wx1 * wy0 * wz1;
  const w011 = wx0 * wy1 * wz1;
  const w111 = wx1 * wy1 * wz1;

  // A non-finite scale would poison both accumulators (NaN spreads through normalize).
  const s = Number.isFinite(weightScale) ? weightScale : 0;

  const strideY = nx;
  const strideZ = nx * ny;
  const i000 = x0 + y0 * strideY + z0 * strideZ;

  // Writes stay in the same order as the original per-corner version so accumulation is
  // bit-identical (float addition is order-sensitive).
  let idx = i000;
  accum[idx] += value * (w000 * s);
  weight[idx] += w000 * s;

  idx = i000 + 1;
  accum[idx] += value * (w100 * s);
  weight[idx] += w100 * s;

  idx = i000 + strideY;
  accum[idx] += value * (w010 * s);
  weight[idx] += w010 * s;

  idx = i000 + strideY + 1;
  accum[idx] += value * (w110 * s);
  weight[idx] += w110 * s;

  idx = i000 + strideZ;
  accum[idx] += value * (w001 * s);
  weight[idx] += w001 * s;

  idx = i000 + strideZ + 1;
  accum[idx] += value * (w101 * s);
  weight[idx] += w101 * s;

  idx = i000 + strideZ + strideY;
  accum[idx] += value * (w011 * s);
  weight[idx] += w011 * s;

  idx = i000 + strideZ + strideY + 1;
  accum[idx] += value * (w111 * s);
  weight[idx] += w111 * s;
}
