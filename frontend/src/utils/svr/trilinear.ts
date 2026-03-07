export type VolumeDims = { nx: number; ny: number; nz: number };

function idxOf(x: number, y: number, z: number, dims: VolumeDims): number {
  return x + y * dims.nx + z * dims.nx * dims.ny;
}

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

  const c000 = volume[idxOf(x0, y0, z0, dims)];
  const c100 = volume[idxOf(x1, y0, z0, dims)];
  const c010 = volume[idxOf(x0, y1, z0, dims)];
  const c110 = volume[idxOf(x1, y1, z0, dims)];
  const c001 = volume[idxOf(x0, y0, z1, dims)];
  const c101 = volume[idxOf(x1, y0, z1, dims)];
  const c011 = volume[idxOf(x0, y1, z1, dims)];
  const c111 = volume[idxOf(x1, y1, z1, dims)];

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
  value: number
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
  weightScale: number
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

  const s = Number.isFinite(weightScale) ? weightScale : 0;

  let idx = idxOf(x0, y0, z0, dims);
  accum[idx] += value * (w000 * s);
  weight[idx] += w000 * s;

  idx = idxOf(x1, y0, z0, dims);
  accum[idx] += value * (w100 * s);
  weight[idx] += w100 * s;

  idx = idxOf(x0, y1, z0, dims);
  accum[idx] += value * (w010 * s);
  weight[idx] += w010 * s;

  idx = idxOf(x1, y1, z0, dims);
  accum[idx] += value * (w110 * s);
  weight[idx] += w110 * s;

  idx = idxOf(x0, y0, z1, dims);
  accum[idx] += value * (w001 * s);
  weight[idx] += w001 * s;

  idx = idxOf(x1, y0, z1, dims);
  accum[idx] += value * (w101 * s);
  weight[idx] += w101 * s;

  idx = idxOf(x0, y1, z1, dims);
  accum[idx] += value * (w011 * s);
  weight[idx] += w011 * s;

  idx = idxOf(x1, y1, z1, dims);
  accum[idx] += value * (w111 * s);
  weight[idx] += w111 * s;
}
