import { describe, expect, it, vi } from 'vitest';
import {
  buildRenderVolumeTexData,
  computePhysicalBoxScale,
  computeRenderPlan,
  downsampleLabelsNearest,
  toUint8Volume,
  updateLabelsNearestRegion,
} from '../src/utils/svr/renderLod';

describe('svr/renderLod', () => {
  it('computePhysicalBoxScale: preserves anatomy proportions in millimeters for anisotropic voxels', () => {
    expect(computePhysicalBoxScale({ nx: 100, ny: 100, nz: 20 }, [1, 1, 5])).toEqual([1, 1, 1]);
    expect(computePhysicalBoxScale({ nx: 100, ny: 50, nz: 25 }, [1, 2, 2])).toEqual([1, 1, 0.5]);
  });

  it('computeRenderPlan: auto chooses u8 when float+labels exceeds budget but u8 fits', () => {
    const plan = computeRenderPlan({
      srcDims: { nx: 512, ny: 512, nz: 512 },
      labelsEnabled: true,
      hasLabels: true,
      budgetMiB: 256,
      quality: 'auto',
      textureMode: 'auto',
    });

    expect(plan.dims).toEqual({ nx: 512, ny: 512, nz: 512 });
    expect(plan.kind).toBe('u8');

    // u8 volume + u8 labels => 2 bytes/voxel
    const nvox = 512 * 512 * 512;
    expect(plan.estGpuTotalBytes).toBe(2 * nvox);
  });

  it('computeRenderPlan: respects MaxDim quality presets', () => {
    const plan = computeRenderPlan({
      srcDims: { nx: 512, ny: 512, nz: 512 },
      labelsEnabled: true,
      hasLabels: true,
      budgetMiB: 2048,
      quality: '256',
      textureMode: 'auto',
    });

    expect(plan.dims).toEqual({ nx: 256, ny: 256, nz: 256 });
    expect(plan.kind).toBe('f32');
  });

  it('computeRenderPlan: reserves segmentation memory before the first label appears', () => {
    const options = {
      srcDims: { nx: 512, ny: 512, nz: 512 },
      labelsEnabled: true,
      budgetMiB: 256,
      quality: 'auto' as const,
      textureMode: 'auto' as const,
      reserveLabelTexture: true,
    };

    const withoutLabels = computeRenderPlan({ ...options, hasLabels: false });
    const withLabels = computeRenderPlan({ ...options, hasLabels: true });

    expect(withoutLabels).toEqual(withLabels);
    expect(withoutLabels.estGpuLabelBytes).toBe(512 ** 3);
  });

  it('computeRenderPlan: reserves an independent acquired-support texture inside the GPU budget', () => {
    const plan = computeRenderPlan({
      srcDims: { nx: 512, ny: 512, nz: 512 },
      labelsEnabled: true,
      hasLabels: false,
      reserveLabelTexture: true,
      hasObservedSupport: true,
      budgetMiB: 256,
      quality: 'auto',
      textureMode: 'auto',
    });

    expect(plan.dims).toEqual({ nx: 384, ny: 384, nz: 384 });
    expect(plan.kind).toBe('f32');
    expect(plan.estGpuSupportBytes).toBe(384 ** 3);
    expect(plan.estGpuTotalBytes).toBe(4 * 384 ** 3);
    expect(plan.estGpuTotalBytes).toBeLessThanOrEqual(256 * 1024 * 1024);
  });

  it('computeRenderPlan: preserves single-voxel physical axes instead of inventing a second layer', () => {
    const plan = computeRenderPlan({
      srcDims: { nx: 64, ny: 32, nz: 1 },
      labelsEnabled: false,
      hasLabels: false,
      budgetMiB: 256,
      quality: 'full',
      textureMode: 'auto',
    });

    expect(plan.dims).toEqual({ nx: 64, ny: 32, nz: 1 });
  });

  it('downsampleLabelsNearest maps endpoints as expected', () => {
    const src = new Uint8Array([0, 1, 2, 3]);
    const out = downsampleLabelsNearest({
      src,
      srcDims: { nx: 4, ny: 1, nz: 1 },
      dstDims: { nx: 2, ny: 1, nz: 1 },
    });

    expect(Array.from(out)).toEqual([0, 3]);
  });

  // The interactive grow preview patches the GPU label texture through a persistent
  // downsample cache; if the region updater's sampling drifted from the full rebuild, the
  // texture would show stale/incorrect labels around edits. Pin them to byte equality.
  it('updateLabelsNearestRegion matches a full nearest-downsample rebuild', () => {
    const srcDims = { nx: 13, ny: 9, nz: 7 };
    const dstDims = { nx: 5, ny: 4, nz: 3 };
    const n = srcDims.nx * srcDims.ny * srcDims.nz;

    // Deterministic pseudo-random labels (no Math.random so failures reproduce).
    const src = new Uint8Array(n);
    let s = 1;
    for (let i = 0; i < n; i++) {
      s = (s * 16807) % 2147483647;
      src[i] = s % 5;
    }

    const cache = downsampleLabelsNearest({ src, srcDims, dstDims });

    // Mutate a sub-box of the source, refresh only the mapped cache region, and compare
    // against a from-scratch rebuild of the whole downsample.
    const box = { min: { x: 3, y: 2, z: 1 }, max: { x: 9, y: 6, z: 4 } };
    for (let z = box.min.z; z <= box.max.z; z++) {
      for (let y = box.min.y; y <= box.max.y; y++) {
        for (let x = box.min.x; x <= box.max.x; x++) {
          src[z * srcDims.nx * srcDims.ny + y * srcDims.nx + x] = (x + y + z) % 5;
        }
      }
    }

    const dstBox = updateLabelsNearestRegion({ src, srcDims, dst: cache, dstDims, srcBox: box });

    expect(dstBox).not.toBeNull();
    expect(Array.from(cache)).toEqual(Array.from(downsampleLabelsNearest({ src, srcDims, dstDims })));
  });

  it('updateLabelsNearestRegion handles single-voxel edits and degenerate (size-1) axes', () => {
    const srcDims = { nx: 8, ny: 6, nz: 5 };
    const dstDims = { nx: 4, ny: 3, nz: 1 }; // nz=1 exercises the dstN<=1 mapping branch

    const src = new Uint8Array(srcDims.nx * srcDims.ny * srcDims.nz).fill(1);
    const cache = downsampleLabelsNearest({ src, srcDims, dstDims });

    const vox = { x: 5, y: 2, z: 3 };
    src[vox.z * srcDims.nx * srcDims.ny + vox.y * srcDims.nx + vox.x] = 4;

    const dstBox = updateLabelsNearestRegion({
      src,
      srcDims,
      dst: cache,
      dstDims,
      srcBox: { min: vox, max: vox },
    });

    expect(dstBox).not.toBeNull();
    expect(Array.from(cache)).toEqual(Array.from(downsampleLabelsNearest({ src, srcDims, dstDims })));
  });

  it('buildRenderVolumeTexData: f32 + same dims returns the original Float32Array', async () => {
    const src = new Float32Array([0, 0, 0, 0, 0, 0, 0, 0]);
    const tex = await buildRenderVolumeTexData({
      src,
      srcDims: { nx: 2, ny: 2, nz: 2 },
      plan: { dims: { nx: 2, ny: 2, nz: 2 }, kind: 'f32' },
      isCancelled: () => false,
    });

    expect(tex.kind).toBe('f32');
    expect(tex.data).toBe(src);
  });

  it('buildRenderVolumeTexData: u8 + same dims matches toUint8Volume', async () => {
    const src = new Float32Array([0, 0.5, 1, 0.25, 0, 0.75, 1, 0]);
    const tex = await buildRenderVolumeTexData({
      src,
      srcDims: { nx: 2, ny: 2, nz: 2 },
      plan: { dims: { nx: 2, ny: 2, nz: 2 }, kind: 'u8' },
      isCancelled: () => false,
    });

    expect(tex.kind).toBe('u8');
    expect(tex.data).toEqual(toUint8Volume(src));
  });

  it('buildRenderVolumeTexData: downsampling integrates each destination voxel footprint', async () => {
    const srcDims = { nx: 4, ny: 2, nz: 2 };
    const src = new Float32Array(srcDims.nx * srcDims.ny * srcDims.nz);

    // Fill with a simple gradient in X: v = x / (nx - 1)
    for (let z = 0; z < srcDims.nz; z++) {
      for (let y = 0; y < srcDims.ny; y++) {
        const base = z * srcDims.nx * srcDims.ny + y * srcDims.nx;
        for (let x = 0; x < srcDims.nx; x++) {
          src[base + x] = x / (srcDims.nx - 1);
        }
      }
    }

    const tex = await buildRenderVolumeTexData({
      src,
      srcDims,
      plan: { dims: { nx: 2, ny: 2, nz: 2 }, kind: 'f32' },
      isCancelled: () => false,
    });

    const out = tex.data as Float32Array;
    expect(out.length).toBe(2 * 2 * 2);

    // A 4->2 area reduction integrates [0, 1/3] and [2/3, 1] instead of
    // point-sampling the endpoints and aliasing away half the acquired signal.
    expect(out[0]).toBeCloseTo(1 / 6, 6);
    expect(out[out.length - 1]).toBeCloseTo(5 / 6, 6);
  });

  it('buildRenderVolumeTexData: eliminates a high-frequency 3D checkerboard when reducing 16³ to 4³', async () => {
    const srcDims = { nx: 16, ny: 16, nz: 16 };
    const src = new Float32Array(16 ** 3);
    for (let z = 0; z < 16; z++) {
      for (let y = 0; y < 16; y++) {
        for (let x = 0; x < 16; x++) {
          src[z * 256 + y * 16 + x] = (x + y + z) % 2;
        }
      }
    }

    const tex = await buildRenderVolumeTexData({
      src,
      srcDims,
      plan: { dims: { nx: 4, ny: 4, nz: 4 }, kind: 'f32' },
      isCancelled: () => false,
    });

    const values = Array.from(tex.data);
    const mean = values.reduce((total, value) => total + value, 0) / values.length;
    const variance = values.reduce((total, value) => total + (value - mean) ** 2, 0) / values.length;
    expect(mean).toBeCloseTo(0.5, 6);
    expect(variance).toBeLessThan(1e-6);
  });

  it('buildRenderVolumeTexData: excludes unsupported samples without treating them as dark tissue', async () => {
    const tex = await buildRenderVolumeTexData({
      src: new Float32Array([0.8, 0.1, 0.25, 0.9]),
      srcObservedSupport: new Uint8Array([1, 0, 0, 0]),
      srcDims: { nx: 4, ny: 1, nz: 1 },
      plan: { dims: { nx: 2, ny: 1, nz: 1 }, kind: 'f32' },
      isCancelled: () => false,
    });

    expect(Array.from(tex.data)).toEqual([expect.closeTo(0.8, 6), 0]);
    expect(Array.from(tex.observedSupport ?? [])).toEqual([1, 0]);
  });

  it('buildRenderVolumeTexData: integrates fractional footprints without leaking across unsupported gaps', async () => {
    const tex = await buildRenderVolumeTexData({
      src: new Float32Array([0.2, 0.9, 0.6]),
      srcObservedSupport: new Uint8Array([1, 0, 1]),
      srcDims: { nx: 3, ny: 1, nz: 1 },
      plan: { dims: { nx: 2, ny: 1, nz: 1 }, kind: 'u8' },
      isCancelled: () => false,
    });

    expect(Array.from(tex.data)).toEqual([51, 153]);
    expect(Array.from(tex.observedSupport ?? [])).toEqual([1, 1]);
  });

  it('buildRenderVolumeTexData: preserves acquired zero as evidence rather than treating it as missing', async () => {
    const tex = await buildRenderVolumeTexData({
      src: new Float32Array([0, 1]),
      srcObservedSupport: new Uint8Array([1, 1]),
      srcDims: { nx: 2, ny: 1, nz: 1 },
      plan: { dims: { nx: 1, ny: 1, nz: 1 }, kind: 'f32' },
      isCancelled: () => false,
    });

    expect(tex.data[0]).toBeCloseTo(0.5, 6);
    expect(tex.observedSupport?.[0]).toBe(1);
  });

  it('buildRenderVolumeTexData: preserves constant intensities through noninteger 3D scale changes', async () => {
    const srcDims = { nx: 7, ny: 5, nz: 3 };
    const tex = await buildRenderVolumeTexData({
      src: new Float32Array(7 * 5 * 3).fill(0.37),
      srcObservedSupport: new Uint8Array(7 * 5 * 3).fill(1),
      srcDims,
      plan: { dims: { nx: 4, ny: 3, nz: 2 }, kind: 'f32' },
      isCancelled: () => false,
    });

    for (const value of tex.data) expect(value).toBeCloseTo(0.37, 6);
    expect(tex.observedSupport?.every((value) => value === 1)).toBe(true);
  });

  it('buildRenderVolumeTexData: masks unsupported full-resolution voxels without mutating the source', async () => {
    const src = new Float32Array([0.8, 0.9, 0.4, 0.7]);
    const support = new Uint8Array([1, 0, 1, 0]);

    const tex = await buildRenderVolumeTexData({
      src,
      srcObservedSupport: support,
      srcDims: { nx: 4, ny: 1, nz: 1 },
      plan: { dims: { nx: 4, ny: 1, nz: 1 }, kind: 'f32' },
      isCancelled: () => false,
    });

    expect(Array.from(tex.data)).toEqual([expect.closeTo(0.8, 6), 0, expect.closeTo(0.4, 6), 0]);
    expect(Array.from(src)).toEqual([
      expect.closeTo(0.8, 6),
      expect.closeTo(0.9, 6),
      expect.closeTo(0.4, 6),
      expect.closeTo(0.7, 6),
    ]);
    expect(tex.observedSupport).toBe(support);
  });

  it('buildRenderVolumeTexData: rejects inconsistent acquired-support masks', async () => {
    await expect(
      buildRenderVolumeTexData({
        src: new Float32Array(4),
        srcObservedSupport: new Uint8Array(3),
        srcDims: { nx: 4, ny: 1, nz: 1 },
        plan: { dims: { nx: 2, ny: 1, nz: 1 }, kind: 'u8' },
        isCancelled: () => false,
      }),
    ).rejects.toThrow(/support.*length/i);
  });

  it('buildRenderVolumeTexData: throws when cancelled', async () => {
    const srcDims = { nx: 4, ny: 2, nz: 2 };
    const src = new Float32Array(srcDims.nx * srcDims.ny * srcDims.nz);

    await expect(
      buildRenderVolumeTexData({
        src,
        srcDims,
        plan: { dims: { nx: 2, ny: 2, nz: 2 }, kind: 'f32' },
        isCancelled: () => true,
      }),
    ).rejects.toThrow(/cancelled/i);
  });

  it('buildRenderVolumeTexData: yields through the shared main-thread scheduler and observes cancellation', async () => {
    let cancelled = false;
    let clock = 0;
    const schedulerYield = vi.fn(async () => {
      cancelled = true;
    });
    vi.stubGlobal('scheduler', { yield: schedulerYield });
    const now = vi.spyOn(performance, 'now').mockImplementation(() => (clock += 10));

    try {
      await expect(
        buildRenderVolumeTexData({
          src: new Float32Array(4 ** 3),
          srcDims: { nx: 4, ny: 4, nz: 4 },
          plan: { dims: { nx: 2, ny: 2, nz: 2 }, kind: 'f32' },
          isCancelled: () => cancelled,
        }),
      ).rejects.toThrow(/cancelled/i);
      expect(schedulerYield).toHaveBeenCalledOnce();
    } finally {
      now.mockRestore();
      vi.unstubAllGlobals();
    }
  });
});
