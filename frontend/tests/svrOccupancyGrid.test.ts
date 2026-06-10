import { describe, expect, it } from 'vitest';
import { SVR3D_OCC_BLOCK, buildOccupancyMaxGrid } from '../src/utils/svr/glRaymarch';

type Dims = { nx: number; ny: number; nz: number };

// The raymarcher skips an entire occupancy cell when the cell's stored max is below the
// threshold floor — so the one property that matters is CONSERVATIVENESS: every cell's
// stored value must be >= any volume value trilinear filtering could produce for a sample
// inside that cell. Filtering reaches at most 1 voxel past the cell boundary, so the
// stored value must dominate the max over the cell's block dilated by one voxel.
function assertConservative(data: Float32Array | Uint8Array, dims: Dims, B: number) {
  const occ = buildOccupancyMaxGrid({ data, dims, blockSize: B });

  const ox = occ.dims.nx;
  const oy = occ.dims.ny;

  for (let cz = 0; cz < occ.dims.nz; cz++) {
    for (let cy = 0; cy < occ.dims.ny; cy++) {
      for (let cx = 0; cx < occ.dims.nx; cx++) {
        // Max over the cell's voxel block, dilated by 1 voxel on every side.
        let m = 0;
        const z0 = Math.max(0, cz * B - 1);
        const z1 = Math.min(dims.nz - 1, (cz + 1) * B);
        const y0 = Math.max(0, cy * B - 1);
        const y1 = Math.min(dims.ny - 1, (cy + 1) * B);
        const x0 = Math.max(0, cx * B - 1);
        const x1 = Math.min(dims.nx - 1, (cx + 1) * B);

        for (let z = z0; z <= z1; z++) {
          for (let y = y0; y <= y1; y++) {
            const base = z * dims.nx * dims.ny + y * dims.nx;
            for (let x = x0; x <= x1; x++) {
              const raw = data[base + x] ?? 0;
              const v = data instanceof Uint8Array ? raw / 255 : raw;
              if (v > m) m = v;
            }
          }
        }

        const stored = (occ.data[cz * ox * oy + cy * ox + cx] ?? 0) / 255;
        expect(stored).toBeGreaterThanOrEqual(Math.min(1, m));
      }
    }
  }
}

describe('svr/occupancy grid', () => {
  it('float volumes: stored cell max dominates the 1-voxel-dilated block max', () => {
    // Dims deliberately not divisible by the block size to exercise partial edge cells.
    const dims = { nx: 21, ny: 13, nz: 10 };
    const data = new Float32Array(dims.nx * dims.ny * dims.nz);

    // Deterministic pseudo-random values in [0,1].
    let s = 7;
    for (let i = 0; i < data.length; i++) {
      s = (s * 16807) % 2147483647;
      data[i] = (s % 1000) / 1000;
    }

    assertConservative(data, dims, SVR3D_OCC_BLOCK);
  });

  it('u8 volumes: same conservativeness property holds', () => {
    const dims = { nx: 17, ny: 9, nz: 9 };
    const data = new Uint8Array(dims.nx * dims.ny * dims.nz);

    let s = 3;
    for (let i = 0; i < data.length; i++) {
      s = (s * 48271) % 2147483647;
      data[i] = s % 256;
    }

    assertConservative(data, dims, 4);
  });

  it('keeps one quantum of headroom so R16F round-to-nearest cannot exceed the stored max', () => {
    const dims = { nx: 8, ny: 8, nz: 8 };
    const data = new Float32Array(dims.nx * dims.ny * dims.nz).fill(0.5);

    const occ = buildOccupancyMaxGrid({ data, dims, blockSize: 8 });

    // ceil(0.5 * 255) = 128, plus the headroom quantum = 129.
    expect(occ.data[0]).toBe(129);
  });

  it('an isolated bright voxel marks its own cell and all face/edge/corner neighbors', () => {
    const B = 4;
    const dims = { nx: 12, ny: 12, nz: 12 }; // 3x3x3 cells
    const data = new Float32Array(dims.nx * dims.ny * dims.nz);

    // Center voxel of the center cell.
    data[6 * 144 + 6 * 12 + 6] = 1.0;

    const occ = buildOccupancyMaxGrid({ data, dims, blockSize: B });

    for (let cz = 0; cz < 3; cz++) {
      for (let cy = 0; cy < 3; cy++) {
        for (let cx = 0; cx < 3; cx++) {
          const v = occ.data[cz * 9 + cy * 3 + cx] ?? 0;
          const isNeighborOfCenter = Math.abs(cx - 1) <= 1 && Math.abs(cy - 1) <= 1 && Math.abs(cz - 1) <= 1;
          if (isNeighborOfCenter) {
            expect(v).toBe(255); // dilation propagates the bright max (clamped at 255)
          }
        }
      }
    }
  });
});
