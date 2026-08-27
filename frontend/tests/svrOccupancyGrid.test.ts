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

  it('records exact threshold-visible acquired bounds during the existing occupancy pass', () => {
    const dims = { nx: 10, ny: 9, nz: 6 };
    const data = new Float32Array(dims.nx * dims.ny * dims.nz);
    const observedSupport = new Uint8Array(data.length);
    const index = (x: number, y: number, z: number) => z * dims.nx * dims.ny + y * dims.nx + x;

    data[index(2, 3, 1)] = 0.8;
    observedSupport[index(2, 3, 1)] = 1;
    data[index(8, 7, 4)] = 0.05;
    observedSupport[index(8, 7, 4)] = 1;
    data[index(0, 0, 5)] = 0.99;
    data[index(9, 8, 0)] = 0.049;
    observedSupport[index(9, 8, 0)] = 1;

    const occupancy = buildOccupancyMaxGrid({ data, dims, observedSupport, visibilityThreshold: 0.05 });

    expect(occupancy.visibleBounds).toEqual({ min: [2, 3, 1], max: [8, 7, 4] });
  });

  it('applies normalized visibility thresholds to 8-bit data without inventing unsupported zero tissue', () => {
    const occupancy = buildOccupancyMaxGrid({
      data: new Uint8Array([255, 12, 13, 0]),
      dims: { nx: 4, ny: 1, nz: 1 },
      observedSupport: new Uint8Array([0, 1, 1, 1]),
      visibilityThreshold: 0.05,
    });

    expect(occupancy.visibleBounds).toEqual({ min: [2, 0, 0], max: [2, 0, 0] });
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
  const march = RAYMARCH_FRAGMENT_SHADER.slice(RAYMARCH_FRAGMENT_SHADER.indexOf('for (int i = 0; i < MAX_STEPS; i++)'));

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

  it('skips unsupported empty space before fetching support while still rejecting it before anatomical sampling', () => {
    const supportGate = march.indexOf('texture(u_support, tc).r <= 0.0');
    const occupancyLookup = march.indexOf('texelFetch(u_occ, cell, 0)');
    const intensityLookup = march.indexOf('texture(u_vol, tc).r');

    expect(supportGate).toBeGreaterThan(0);
    expect(occupancyLookup).toBeGreaterThan(0);
    expect(occupancyLookup).toBeLessThan(supportGate);
    expect(supportGate).toBeLessThan(intensityLookup);
    expect(march.slice(supportGate, supportGate + 90)).toContain('continue;');
  });

  it('isolates acquired lesion labels before paying for anatomy and gradient sampling', () => {
    const supportGate = march.indexOf('texture(u_support, tc).r <= 0.0');
    const lesionLookup = march.indexOf('labelCoverage = lesionCoverage(tc, lid)');
    const lesionGate = march.indexOf('labelCoverage <= 0.08');
    const intensityLookup = march.indexOf('texture(u_vol, tc).r');

    expect(RAYMARCH_FRAGMENT_SHADER).toContain('uniform int u_tumorOnly;');
    expect(supportGate).toBeGreaterThan(0);
    expect(lesionLookup).toBeGreaterThan(supportGate);
    expect(lesionGate).toBeGreaterThan(lesionLookup);
    expect(lesionGate).toBeLessThan(intensityLookup);
    expect(march.slice(lesionGate, lesionGate + 90)).toContain('continue;');
    expect(RAYMARCH_FRAGMENT_SHADER).toContain('u_tumorOnly != 0 ? 0.0 : saturate(u_thr)');
  });

  it('renders acquired categorical labels below the anatomical intensity threshold', () => {
    const supportGate = RAYMARCH_FRAGMENT_SHADER.indexOf('texture(u_support, tc).r <= 0.0');
    const lesionLookup = RAYMARCH_FRAGMENT_SHADER.indexOf('lid = texture(u_labels, tc).r');
    const visibilityGate = RAYMARCH_FRAGMENT_SHADER.indexOf('if (v >= thr || (u_labelsEnabled != 0 && lid != 0u))');

    expect(supportGate).toBeGreaterThan(0);
    expect(lesionLookup).toBeGreaterThan(supportGate);
    expect(visibilityGate).toBeGreaterThan(lesionLookup);
    // Opacity may keep a dark annotation visible; its color must still come
    // from the actual MRI value rather than the previous synthetic solid fill.
    expect(RAYMARCH_FRAGMENT_SHADER).toContain('float tissue = v *');
    expect(RAYMARCH_FRAGMENT_SHADER).toContain('sampleColor = mix(vec3(tissue), labelRgb * tissue');
    expect(RAYMARCH_FRAGMENT_SHADER).toContain('max(0.48, val) * dt * 12.0 * boundary');
  });

  it('clips focused rays to the complete lesion domain and smoothly samples categorical boundaries', () => {
    expect(RAYMARCH_FRAGMENT_SHADER).toContain('uniform int u_focusEnabled;');
    expect(RAYMARCH_FRAGMENT_SHADER).toContain('uniform vec3 u_focusCenter;');
    expect(RAYMARCH_FRAGMENT_SHADER).toContain('uniform vec3 u_focusMin;');
    expect(RAYMARCH_FRAGMENT_SHADER).toContain('uniform vec3 u_focusMax;');
    expect(RAYMARCH_FRAGMENT_SHADER).toContain('ro += u_focusCenter;');
    expect(RAYMARCH_FRAGMENT_SHADER).toContain('bmin = max(bmin, u_focusMin);');
    expect(RAYMARCH_FRAGMENT_SHADER).toContain('bmax = min(bmax, u_focusMax);');
    expect(RAYMARCH_FRAGMENT_SHADER).toContain('smoothstep(0.12, 0.78, labelCoverage)');
    expect(RAYMARCH_FRAGMENT_SHADER).not.toContain('normalize(mix(radial, nrm');
    expect(RAYMARCH_FRAGMENT_SHADER).toContain('lesionAccum += (1.0 - lesionAlpha)');
    expect(RAYMARCH_FRAGMENT_SHADER).toContain('accum = mix(accum, visibleLesion');
  });

  it('samples the exact cut plane through categorical support and labels before any display shading', () => {
    const section = RAYMARCH_FRAGMENT_SHADER.slice(
      RAYMARCH_FRAGMENT_SHADER.indexOf('vec4 cutSurface'),
      RAYMARCH_FRAGMENT_SHADER.indexOf('bool intersectBox'),
    );
    const support = section.indexOf('texture(u_support, tc)');
    const labels = section.indexOf('u_tumorOnly != 0 && label == 0u');
    const intensity = section.indexOf('windowed(texture(u_vol, tc).r)');
    expect(support).toBeGreaterThan(0);
    expect(labels).toBeGreaterThan(support);
    expect(intensity).toBeGreaterThan(labels);
    expect(section).toContain('vec3 color = vec3(value)');
    expect(section).not.toMatch(/u_opacity|u_thr|u_gamma|shade/);
    expect(RAYMARCH_FRAGMENT_SHADER).toContain('cutSurface(ro + rd * t0)');
    expect(RAYMARCH_FRAGMENT_SHADER).toContain('cutSurface(ro + rd * t1)');
  });

  it('restores conservative cell skipping through sparse acquired MRI support without changing visible anatomy', () => {
    const size = 96;
    const dims = { nx: size, ny: size, nz: size };
    const data = new Float32Array(size ** 3);
    const support = new Uint8Array(data.length);

    for (let z = 0; z < size; z++) {
      const depth = (z - size * 0.51) / (size * 0.35);
      for (let y = 0; y < size; y++) {
        const row = (y - size * 0.5) / (size * 0.39);
        for (let x = 0; x < size; x++) {
          const column = (x - size * 0.5) / (size * 0.34);
          if (column * column + row * row + depth * depth > 1) continue;
          const index = z * size * size + y * size + x;
          support[index] = 1;
          data[index] = 0.6;
        }
      }
    }

    const occupancy = buildOccupancyMaxGrid({ data, dims });
    const countRayWork = (skipBeforeSupport: boolean) => {
      let samples = 0;
      let supportFetches = 0;
      let visible = 0;

      for (let y = 0; y < size; y += 4) {
        for (let x = 0; x < size; x += 4) {
          for (let z = 0; z < size; z++) {
            samples++;
            const index = z * size * size + y * size + x;
            if (!skipBeforeSupport) {
              supportFetches++;
              if (!support[index]) continue;
            }

            const cell =
              Math.floor(z / SVR3D_OCC_BLOCK) * occupancy.dims.nx * occupancy.dims.ny +
              Math.floor(y / SVR3D_OCC_BLOCK) * occupancy.dims.nx +
              Math.floor(x / SVR3D_OCC_BLOCK);
            if (occupancy.data[cell]! / 255 < 0.05) {
              z = Math.min(size - 1, (Math.floor(z / SVR3D_OCC_BLOCK) + 1) * SVR3D_OCC_BLOCK - 1);
              continue;
            }

            if (skipBeforeSupport) {
              supportFetches++;
              if (!support[index]) continue;
            }

            if (data[index]! >= 0.05) visible++;
          }
        }
      }

      return { samples, supportFetches, visible };
    };

    const previous = countRayWork(false);
    const optimized = countRayWork(true);

    expect(optimized.visible).toBe(previous.visible);
    expect(optimized.samples).toBeLessThan(previous.samples * 0.7);
    expect(optimized.supportFetches).toBeLessThan(previous.supportFetches * 0.65);
  });
});
