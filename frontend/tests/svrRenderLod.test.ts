import { describe, expect, it } from 'vitest';
import {
  buildRenderVolumeTexData,
  computeRenderPlan,
  downsampleLabelsNearest,
  toUint8Volume,
  updateLabelsNearestRegion,
} from '../src/utils/svr/renderLod';

describe('svr/renderLod', () => {
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

  it('buildRenderVolumeTexData: downsampling keeps corner values (approximately)', async () => {
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

    // First voxel (0,0,0) should be ~0.
    expect(out[0]).toBeCloseTo(0, 6);

    // Last voxel (1,1,1) should be ~1.
    expect(out[out.length - 1]).toBeCloseTo(1, 4);
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
});
