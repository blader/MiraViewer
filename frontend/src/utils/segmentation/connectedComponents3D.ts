export type Connectivity3D = 6 | 26;

function idx3(x: number, y: number, z: number, nx: number, ny: number): number {
  return z * (nx * ny) + y * nx + x;
}

function inBounds(x: number, y: number, z: number, nx: number, ny: number, nz: number): boolean {
  return x >= 0 && x < nx && y >= 0 && y < ny && z >= 0 && z < nz;
}

/**
 * Keep only the largest connected component in a 3D binary mask.
 *
 * This is useful as a cleanup step when region-growing or morphological operations
 * leave tiny disconnected islands.
 */
export function keepLargestConnectedComponent3D(params: {
  mask: Uint8Array;
  dims: [number, number, number];
  connectivity?: Connectivity3D;
}): { mask: Uint8Array; keptSize: number } {
  const { mask, dims } = params;
  const nx = dims[0];
  const ny = dims[1];
  const nz = dims[2];

  const n = nx * ny * nz;
  if (mask.length !== n) {
    throw new Error(`keepLargestConnectedComponent3D: mask length mismatch (expected ${n}, got ${mask.length})`);
  }

  const connectivity: Connectivity3D = params.connectivity ?? 6;

  const visited = new Uint8Array(n);
  const queue = new Uint32Array(n);

  const strideY = nx;
  const strideZ = nx * ny;

  let bestStart = -1;
  let bestSize = 0;

  const bfsCount = (start: number): number => {
    let head = 0;
    let tail = 0;
    queue[tail++] = start;
    visited[start] = 1;

    let size = 0;

    while (head < tail) {
      const i = queue[head++]!;
      size++;

      const z = Math.floor(i / strideZ);
      const yz = i - z * strideZ;
      const y = Math.floor(yz / strideY);
      const x = yz - y * strideY;

      const tryNeighbor = (nx0: number, ny0: number, nz0: number) => {
        if (!inBounds(nx0, ny0, nz0, nx, ny, nz)) return;
        const ni = idx3(nx0, ny0, nz0, nx, ny);
        if (visited[ni]) return;
        if (!mask[ni]) return;
        visited[ni] = 1;
        queue[tail++] = ni;
      };

      if (connectivity === 6) {
        tryNeighbor(x - 1, y, z);
        tryNeighbor(x + 1, y, z);
        tryNeighbor(x, y - 1, z);
        tryNeighbor(x, y + 1, z);
        tryNeighbor(x, y, z - 1);
        tryNeighbor(x, y, z + 1);
      } else {
        for (let dz = -1; dz <= 1; dz++) {
          for (let dy = -1; dy <= 1; dy++) {
            for (let dx = -1; dx <= 1; dx++) {
              if (dx === 0 && dy === 0 && dz === 0) continue;
              tryNeighbor(x + dx, y + dy, z + dz);
            }
          }
        }
      }
    }

    return size;
  };

  for (let i = 0; i < n; i++) {
    if (!mask[i] || visited[i]) continue;
    const size = bfsCount(i);
    if (size > bestSize) {
      bestSize = size;
      bestStart = i;
    }
  }

  if (bestStart < 0 || bestSize === 0) {
    return { mask: new Uint8Array(n), keptSize: 0 };
  }

  // Second pass: BFS from bestStart to build the kept mask.
  visited.fill(0);
  const kept = new Uint8Array(n);

  let head = 0;
  let tail = 0;
  queue[tail++] = bestStart;
  visited[bestStart] = 1;
  kept[bestStart] = 1;

  while (head < tail) {
    const i = queue[head++]!;

    const z = Math.floor(i / strideZ);
    const yz = i - z * strideZ;
    const y = Math.floor(yz / strideY);
    const x = yz - y * strideY;

    const tryNeighbor = (nx0: number, ny0: number, nz0: number) => {
      if (!inBounds(nx0, ny0, nz0, nx, ny, nz)) return;
      const ni = idx3(nx0, ny0, nz0, nx, ny);
      if (visited[ni]) return;
      if (!mask[ni]) return;
      visited[ni] = 1;
      kept[ni] = 1;
      queue[tail++] = ni;
    };

    if (connectivity === 6) {
      tryNeighbor(x - 1, y, z);
      tryNeighbor(x + 1, y, z);
      tryNeighbor(x, y - 1, z);
      tryNeighbor(x, y + 1, z);
      tryNeighbor(x, y, z - 1);
      tryNeighbor(x, y, z + 1);
    } else {
      for (let dz = -1; dz <= 1; dz++) {
        for (let dy = -1; dy <= 1; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            if (dx === 0 && dy === 0 && dz === 0) continue;
            tryNeighbor(x + dx, y + dy, z + dz);
          }
        }
      }
    }
  }

  return { mask: kept, keptSize: bestSize };
}
