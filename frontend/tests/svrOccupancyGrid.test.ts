import { describe, expect, it, vi } from 'vitest';
import {
  RAYMARCH_FRAGMENT_SHADER,
  SVR3D_OCC_BLOCK,
  buildOccupancyMaxGrid,
  buildOccupancyMaxGridAsync,
  createObservedSupportTexture,
} from '../src/utils/svr/glRaymarch';

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

  it('cooperative occupancy staging produces the identical conservative display grid', async () => {
    const dims = { nx: 21, ny: 13, nz: 10 };
    const data = new Float32Array(dims.nx * dims.ny * dims.nz);
    for (let index = 0; index < data.length; index++) data[index] = ((index * 37) % 997) / 997;

    const asyncGrid = await buildOccupancyMaxGridAsync({ data, dims }, () => false);
    const syncGrid = buildOccupancyMaxGrid({ data, dims });
    expect(asyncGrid.dims).toEqual(syncGrid.dims);
    expect(asyncGrid.data).toEqual(syncGrid.data);
  });

  it('cooperative occupancy staging honors cancellation before building stale GPU resources', async () => {
    const dims = { nx: 4, ny: 4, nz: 4 };
    await expect(buildOccupancyMaxGridAsync({ data: new Float32Array(64), dims }, () => true)).rejects.toThrow(
      /cancel/i,
    );
  });
});

function createSupportTextureGl(error = 0) {
  const texture = {} as WebGLTexture;
  const gl = {
    TEXTURE4: 4,
    TEXTURE_3D: 3,
    TEXTURE_WRAP_S: 10,
    TEXTURE_WRAP_T: 11,
    TEXTURE_WRAP_R: 12,
    TEXTURE_MIN_FILTER: 13,
    TEXTURE_MAG_FILTER: 14,
    CLAMP_TO_EDGE: 15,
    NEAREST: 16,
    UNPACK_ALIGNMENT: 17,
    R8: 18,
    RED: 19,
    UNSIGNED_BYTE: 20,
    NO_ERROR: 0,
    createTexture: vi.fn(() => texture),
    activeTexture: vi.fn(),
    bindTexture: vi.fn(),
    pixelStorei: vi.fn(),
    texParameteri: vi.fn(),
    texImage3D: vi.fn(),
    getError: vi.fn(() => error),
    deleteTexture: vi.fn(),
  };
  return { gl, texture };
}

describe('svr/acquired-support texture', () => {
  it('uploads authoritative raw 0/1 evidence as an independent nearest-filtered R8 texture', () => {
    const { gl, texture } = createSupportTextureGl();
    const support = new Uint8Array([1, 0, 1, 0]);

    const result = createObservedSupportTexture(gl as unknown as WebGL2RenderingContext, {
      data: support,
      dims: { nx: 2, ny: 2, nz: 1 },
    });

    expect(result).toEqual({ texture, enabled: true });
    expect(gl.activeTexture).toHaveBeenCalledWith(gl.TEXTURE4);
    expect(gl.texParameteri).toHaveBeenCalledWith(gl.TEXTURE_3D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    expect(gl.texParameteri).toHaveBeenCalledWith(gl.TEXTURE_3D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    expect(gl.texImage3D).toHaveBeenCalledWith(gl.TEXTURE_3D, 0, gl.R8, 2, 2, 1, 0, gl.RED, gl.UNSIGNED_BYTE, support);
    expect(gl.texImage3D.mock.calls[0]?.[9]).toBe(support);
  });

  it('keeps legacy support-free volumes visible using a complete always-supported placeholder', () => {
    const { gl } = createSupportTextureGl();

    const result = createObservedSupportTexture(gl as unknown as WebGL2RenderingContext, {
      dims: { nx: 64, ny: 64, nz: 64 },
    });

    expect(result.enabled).toBe(false);
    expect(gl.texImage3D).toHaveBeenCalledWith(
      gl.TEXTURE_3D,
      0,
      gl.R8,
      1,
      1,
      1,
      0,
      gl.RED,
      gl.UNSIGNED_BYTE,
      new Uint8Array([255]),
    );
  });

  it('rejects misaligned support evidence without allocating or leaking a GPU texture', () => {
    const { gl } = createSupportTextureGl();

    expect(() =>
      createObservedSupportTexture(gl as unknown as WebGL2RenderingContext, {
        data: new Uint8Array([1]),
        dims: { nx: 2, ny: 1, nz: 1 },
      }),
    ).toThrow(/support.*match/i);
    expect(gl.createTexture).not.toHaveBeenCalled();
  });

  it('deletes its independently owned texture when the GPU rejects support evidence', () => {
    const { gl, texture } = createSupportTextureGl(1285);

    expect(() =>
      createObservedSupportTexture(gl as unknown as WebGL2RenderingContext, {
        data: new Uint8Array([1, 0]),
        dims: { nx: 2, ny: 1, nz: 1 },
      }),
    ).toThrow(/gpu.*support/i);
    expect(gl.deleteTexture).toHaveBeenCalledWith(texture);
    expect(gl.bindTexture).toHaveBeenLastCalledWith(gl.TEXTURE_3D, null);
  });

  it('rejects unsupported ray positions before linear intensity can bleed across an acquired boundary', () => {
    const supportGate = RAYMARCH_FRAGMENT_SHADER.indexOf('texture(u_support, tc).r <= 0.0');
    const occupancyLookup = RAYMARCH_FRAGMENT_SHADER.indexOf('texelFetch(u_occ, cell, 0)');
    const intensityLookup = RAYMARCH_FRAGMENT_SHADER.indexOf('texture(u_vol, tc).r');

    expect(supportGate).toBeGreaterThan(0);
    expect(supportGate).toBeLessThan(occupancyLookup);
    expect(supportGate).toBeLessThan(intensityLookup);
    expect(RAYMARCH_FRAGMENT_SHADER.slice(supportGate, supportGate + 90)).toContain('continue;');
  });
});
