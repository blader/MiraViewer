function idx3(x: number, y: number, z: number, nx: number, ny: number): number {
  return z * (nx * ny) + y * nx + x;
}

/**
 * 3D dilation with a 3x3x3 structuring element.
 *
 * Mask values are expected to be 0 or 1.
 */
export function dilate3x3x3(mask: Uint8Array, dims: [number, number, number]): Uint8Array {
  const nx = dims[0];
  const ny = dims[1];
  const nz = dims[2];

  const n = nx * ny * nz;
  if (mask.length !== n) {
    throw new Error(`dilate3x3x3: mask length mismatch (expected ${n}, got ${mask.length})`);
  }

  const out = new Uint8Array(n);

  for (let z = 0; z < nz; z++) {
    for (let y = 0; y < ny; y++) {
      for (let x = 0; x < nx; x++) {
        let on = 0;

        for (let dz = -1; dz <= 1 && !on; dz++) {
          const zz = z + dz;
          if (zz < 0 || zz >= nz) continue;

          for (let dy = -1; dy <= 1 && !on; dy++) {
            const yy = y + dy;
            if (yy < 0 || yy >= ny) continue;

            for (let dx = -1; dx <= 1; dx++) {
              const xx = x + dx;
              if (xx < 0 || xx >= nx) continue;
              if (mask[idx3(xx, yy, zz, nx, ny)]) {
                on = 1;
                break;
              }
            }
          }
        }

        out[idx3(x, y, z, nx, ny)] = on;
      }
    }
  }

  return out;
}

/**
 * 3D erosion with a 3x3x3 structuring element.
 *
 * Out-of-bounds neighbors are treated as 0.
 */
export function erode3x3x3(mask: Uint8Array, dims: [number, number, number]): Uint8Array {
  const nx = dims[0];
  const ny = dims[1];
  const nz = dims[2];

  const n = nx * ny * nz;
  if (mask.length !== n) {
    throw new Error(`erode3x3x3: mask length mismatch (expected ${n}, got ${mask.length})`);
  }

  const out = new Uint8Array(n);

  for (let z = 0; z < nz; z++) {
    for (let y = 0; y < ny; y++) {
      for (let x = 0; x < nx; x++) {
        let on = 1;

        for (let dz = -1; dz <= 1 && on; dz++) {
          const zz = z + dz;
          if (zz < 0 || zz >= nz) {
            on = 0;
            break;
          }

          for (let dy = -1; dy <= 1 && on; dy++) {
            const yy = y + dy;
            if (yy < 0 || yy >= ny) {
              on = 0;
              break;
            }

            for (let dx = -1; dx <= 1; dx++) {
              const xx = x + dx;
              if (xx < 0 || xx >= nx) {
                on = 0;
                break;
              }
              if (!mask[idx3(xx, yy, zz, nx, ny)]) {
                on = 0;
                break;
              }
            }
          }
        }

        out[idx3(x, y, z, nx, ny)] = on;
      }
    }
  }

  return out;
}

export function morphologicalClose3D(mask: Uint8Array, dims: [number, number, number]): Uint8Array {
  const dilated = dilate3x3x3(mask, dims);
  return erode3x3x3(dilated, dims);
}

export function morphologicalOpen3D(mask: Uint8Array, dims: [number, number, number]): Uint8Array {
  const eroded = erode3x3x3(mask, dims);
  return dilate3x3x3(eroded, dims);
}
