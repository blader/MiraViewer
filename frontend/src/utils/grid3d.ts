/**
 * 3D grid index helper: idx = z*(nx*ny) + y*nx + x.
 */
export function idx3(x: number, y: number, z: number, nx: number, ny: number): number {
  return z * (nx * ny) + y * nx + x;
}

export function inBounds3(
  x: number,
  y: number,
  z: number,
  nx: number,
  ny: number,
  nz: number,
): boolean {
  return x >= 0 && x < nx && y >= 0 && y < ny && z >= 0 && z < nz;
}
