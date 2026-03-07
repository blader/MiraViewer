import { describe, expect, it } from 'vitest';
import { keepLargestConnectedComponent3D } from '../src/utils/segmentation/connectedComponents3D';
import { dilate3x3x3, erode3x3x3 } from '../src/utils/segmentation/morphology3D';
import { regionGrow3D } from '../src/utils/segmentation/regionGrow3D';
import { regionGrow3D_v2 } from '../src/utils/segmentation/regionGrow3D_v2';

function sumMask(mask: Uint8Array): number {
  let s = 0;
  for (let i = 0; i < mask.length; i++) s += mask[i] ? 1 : 0;
  return s;
}

function indicesToMask(indices: Uint32Array, n: number): Uint8Array {
  const out = new Uint8Array(n);
  for (let i = 0; i < indices.length; i++) {
    out[indices[i]!] = 1;
  }
  return out;
}

describe('regionGrow3D', () => {
  it('grows a simple 3D cube region from a seed', async () => {
    const dims: [number, number, number] = [4, 4, 4];
    const [nx, ny, nz] = dims;
    const n = nx * ny * nz;
    const vol = new Float32Array(n);
    vol.fill(0.1);

    // 2x2x2 cube at x,y,z in [1,2]
    for (let z = 1; z <= 2; z++) {
      for (let y = 1; y <= 2; y++) {
        for (let x = 1; x <= 2; x++) {
          vol[z * (nx * ny) + y * nx + x] = 0.8;
        }
      }
    }

    const res = await regionGrow3D({
      volume: vol,
      dims,
      seed: { x: 1, y: 1, z: 1 },
      min: 0.7,
      max: 0.9,
      opts: { maxVoxels: 100, connectivity: 6, yieldEvery: 0 },
    });

    expect(res.seedValue).toBeCloseTo(0.8, 6);
    expect(res.hitMaxVoxels).toBe(false);
    expect(res.count).toBe(8);
    expect(res.indices.length).toBe(8);
    expect(sumMask(indicesToMask(res.indices, n))).toBe(8);
  });

  it('returns an empty mask if the seed is out of range', async () => {
    const dims: [number, number, number] = [3, 3, 3];
    const vol = new Float32Array(27);
    vol.fill(0.2);

    const res = await regionGrow3D({
      volume: vol,
      dims,
      seed: { x: 1, y: 1, z: 1 },
      min: 0.5,
      max: 0.6,
      opts: { yieldEvery: 0 },
    });

    expect(res.count).toBe(0);
    expect(res.indices.length).toBe(0);
  });

  it('respects a hard ROI constraint', async () => {
    const dims: [number, number, number] = [4, 4, 1];
    const [nx, ny, nz] = dims;
    const n = nx * ny * nz;

    const vol = new Float32Array(n);
    vol.fill(0.8);

    const res = await regionGrow3D({
      volume: vol,
      dims,
      seed: { x: 1, y: 1, z: 0 },
      min: 0.7,
      max: 0.9,
      roi: {
        mode: 'hard',
        min: { x: 1, y: 1, z: 0 },
        max: { x: 2, y: 2, z: 0 },
      },
      opts: { maxVoxels: 100, connectivity: 6, yieldEvery: 0 },
    });

    expect(res.hitMaxVoxels).toBe(false);
    expect(res.count).toBe(4);
    expect(sumMask(indicesToMask(res.indices, n))).toBe(4);
  });

  it('supports a guide ROI that shrinks tolerance outside', async () => {
    const dims: [number, number, number] = [3, 3, 1];
    const [nx, ny, nz] = dims;
    const n = nx * ny * nz;

    const vol = new Float32Array(n);
    vol.fill(0.9);

    // Seed in the ROI.
    vol[0 * (nx * ny) + 1 * nx + 1] = 0.8; // (1,1,0)

    // Outside ROI, only a very tight range around the seed is accepted.
    vol[0 * (nx * ny) + 1 * nx + 2] = 0.8; // (2,1,0)

    const res = await regionGrow3D({
      volume: vol,
      dims,
      seed: { x: 1, y: 1, z: 0 },
      min: 0.7,
      max: 0.9,
      roi: {
        mode: 'guide',
        min: { x: 1, y: 1, z: 0 },
        max: { x: 1, y: 1, z: 0 },
        outsideToleranceScale: 0.2,
      },
      opts: { maxVoxels: 100, connectivity: 6, yieldEvery: 0 },
    });

    expect(res.count).toBe(2);
    expect(sumMask(indicesToMask(res.indices, n))).toBe(2);
  });

  it('supports additional seed indices', async () => {
    const dims: [number, number, number] = [4, 4, 1];
    const [nx, ny, nz] = dims;
    const n = nx * ny * nz;

    const vol = new Float32Array(n);
    vol.fill(0.1);

    vol[0 * (nx * ny) + 0 * nx + 0] = 0.8; // (0,0,0)
    vol[0 * (nx * ny) + 3 * nx + 3] = 0.8; // (3,3,0)

    const res = await regionGrow3D({
      volume: vol,
      dims,
      seed: { x: 0, y: 0, z: 0 },
      seedIndices: new Uint32Array([0 * (nx * ny) + 3 * nx + 3]),
      min: 0.7,
      max: 0.9,
      opts: { maxVoxels: 100, connectivity: 6, yieldEvery: 0 },
    });

    expect(res.count).toBe(2);
    expect(sumMask(indicesToMask(res.indices, n))).toBe(2);
  });

  it('sets hitMaxVoxels when the max voxel limit is reached', async () => {
    const dims: [number, number, number] = [5, 5, 1];
    const [nx, ny, nz] = dims;
    const n = nx * ny * nz;

    const vol = new Float32Array(n);
    vol.fill(0.8);

    const res = await regionGrow3D({
      volume: vol,
      dims,
      seed: { x: 2, y: 2, z: 0 },
      min: 0.7,
      max: 0.9,
      opts: { maxVoxels: 5, connectivity: 6, yieldEvery: 0 },
    });

    expect(res.hitMaxVoxels).toBe(true);
    expect(res.count).toBe(5);
    expect(res.indices.length).toBe(5);
  });
});

describe('regionGrow3D_v2', () => {
  it('prevents long-distance bridge leakage at a moderate cost budget', async () => {
    const dims: [number, number, number] = [40, 5, 1];
    const [nx, ny, nz] = dims;
    const n = nx * ny * nz;

    const vol = new Float32Array(n);
    vol.fill(0.1);

    // Region A: 5x5 block on the left.
    for (let y = 0; y < 5; y++) {
      for (let x = 0; x < 5; x++) {
        vol[y * nx + x] = 0.8;
      }
    }

    // Corridor: a long 1-voxel-wide bridge.
    for (let x = 5; x <= 34; x++) {
      vol[2 * nx + x] = 0.75;
    }

    // Region B: 5x5 block on the right.
    for (let y = 0; y < 5; y++) {
      for (let x = 35; x < 40; x++) {
        vol[y * nx + x] = 0.8;
      }
    }

    const seed = { x: 2, y: 2, z: 0 };
    const roiWhole = { mode: 'hard' as const, min: { x: 0, y: 0, z: 0 }, max: { x: nx - 1, y: ny - 1, z: nz - 1 } };

    const resV1 = await regionGrow3D({
      volume: vol,
      dims,
      seed,
      min: 0.7,
      max: 0.9,
      roi: roiWhole,
      opts: { maxVoxels: 10_000, connectivity: 6, yieldEvery: 0 },
    });

    const resV2 = await regionGrow3D_v2({
      volume: vol,
      dims,
      seed,
      min: 0.7,
      max: 0.9,
      roi: roiWhole,
      opts: { maxVoxels: 10_000, connectivity: 6, yieldEvery: 0, maxCost: 20 },
    });

    // v1 floods across the bridge; v2 stops before reaching the far region.
    expect(resV1.count).toBeGreaterThan(resV2.count);

    const farIdx = 2 * nx + 37; // (37,2,0)
    const maskV1 = indicesToMask(resV1.indices, n);
    const maskV2 = indicesToMask(resV2.indices, n);

    expect(maskV1[farIdx]).toBe(1);
    expect(maskV2[farIdx]).toBe(0);

    // Should still include the local region near the seed.
    expect(resV2.count).toBeGreaterThan(20);
  });

  it('can follow a gradual intensity ramp beyond the seed band (reduces false negatives)', async () => {
    const dims: [number, number, number] = [20, 20, 1];
    const [nx, ny, nz] = dims;
    const n = nx * ny * nz;

    const vol = new Float32Array(n);
    vol.fill(0.1);

    // Tumor region: 16x16, with a smooth ramp from 0.55 -> 0.80 across x.
    for (let y = 2; y <= 17; y++) {
      for (let x = 2; x <= 17; x++) {
        const t = (x - 2) / 15;
        const v = 0.55 + 0.25 * t;
        vol[y * nx + x] = v;
      }
    }

    const seed = { x: 17, y: 10, z: 0 }; // near the high end (0.8)
    const roiTumor = {
      mode: 'hard' as const,
      min: { x: 2, y: 2, z: 0 },
      max: { x: 17, y: 17, z: 0 },
    };

    const resV1 = await regionGrow3D({
      volume: vol,
      dims,
      seed,
      min: 0.7,
      max: 0.9,
      roi: roiTumor,
      opts: { maxVoxels: 10_000, connectivity: 6, yieldEvery: 0 },
    });

    const resV2 = await regionGrow3D_v2({
      volume: vol,
      dims,
      seed,
      min: 0.7,
      max: 0.9,
      roi: roiTumor,
      opts: { maxVoxels: 10_000, connectivity: 6, yieldEvery: 0, maxCost: 120 },
    });

    // v1 rejects low-intensity ramp voxels even when connected; v2 can traverse the ramp.
    expect(resV2.count).toBeGreaterThan(resV1.count + 50);

    const lowRampIdx = 10 * nx + 2; // (2,10,0) => ~0.55
    const maskV1 = indicesToMask(resV1.indices, n);
    const maskV2 = indicesToMask(resV2.indices, n);

    expect(maskV1[lowRampIdx]).toBe(0);
    expect(maskV2[lowRampIdx]).toBe(1);

    // Should include most of the ROI.
    expect(resV2.count).toBeGreaterThan(200);
  });

  it('penalizes high→low transitions more than low→high across the same step edge', async () => {
    const dims: [number, number, number] = [16, 8, 1];
    const [nx, ny, nz] = dims;
    const n = nx * ny * nz;

    const vol = new Float32Array(n);

    // Left half bright, right half dark.
    const splitX = 8;
    for (let y = 0; y < ny; y++) {
      for (let x = 0; x < nx; x++) {
        vol[y * nx + x] = x < splitX ? 0.85 : 0.15;
      }
    }

    const roiWhole = {
      mode: 'hard' as const,
      min: { x: 0, y: 0, z: 0 },
      max: { x: nx - 1, y: ny - 1, z: 0 },
    };

    const maxCost = 9;

    const resDownhill = await regionGrow3D_v2({
      volume: vol,
      dims,
      seed: { x: 7, y: 4, z: 0 },
      min: 0,
      max: 1,
      roi: roiWhole,
      opts: { maxVoxels: 10_000, connectivity: 6, yieldEvery: 0, maxCost },
    });

    const resUphill = await regionGrow3D_v2({
      volume: vol,
      dims,
      seed: { x: 8, y: 4, z: 0 },
      min: 0,
      max: 1,
      roi: roiWhole,
      opts: { maxVoxels: 10_000, connectivity: 6, yieldEvery: 0, maxCost },
    });

    const maskDownhill = indicesToMask(resDownhill.indices, n);
    const maskUphill = indicesToMask(resUphill.indices, n);

    const acrossFromHighIdx = 4 * nx + 8; // (8,4,0) on the dark side
    const acrossFromLowIdx = 4 * nx + 7; // (7,4,0) on the bright side

    expect(maskDownhill[acrossFromHighIdx]).toBe(0);
    expect(maskUphill[acrossFromLowIdx]).toBe(1);
  });
});

describe('keepLargestConnectedComponent3D', () => {
  it('keeps only the largest component', () => {
    const dims: [number, number, number] = [4, 4, 1];
    const n = 4 * 4 * 1;
    const mask = new Uint8Array(n);

    // Component A: 3 voxels along the top row.
    mask[0] = 1; // (0,0,0)
    mask[1] = 1; // (1,0,0)
    mask[2] = 1; // (2,0,0)

    // Component B: 5 voxels along the bottom row + one above (connected).
    mask[12] = 1; // (0,3,0)
    mask[13] = 1; // (1,3,0)
    mask[14] = 1; // (2,3,0)
    mask[15] = 1; // (3,3,0)
    mask[11] = 1; // (3,2,0)

    const out = keepLargestConnectedComponent3D({ mask, dims, connectivity: 6 });
    expect(out.keptSize).toBe(5);
    expect(sumMask(out.mask)).toBe(5);

    // Ensure A is removed.
    expect(out.mask[0]).toBe(0);
    expect(out.mask[1]).toBe(0);
    expect(out.mask[2]).toBe(0);

    // Ensure B remains.
    expect(out.mask[12]).toBe(1);
    expect(out.mask[15]).toBe(1);
    expect(out.mask[11]).toBe(1);
  });
});

describe('morphology3D', () => {
  it('dilate3x3x3 grows a single voxel into a 3x3x3 block', () => {
    const dims: [number, number, number] = [3, 3, 3];
    const mask = new Uint8Array(27);

    // Center voxel (1,1,1)
    mask[13] = 1;

    const dilated = dilate3x3x3(mask, dims);
    expect(sumMask(dilated)).toBe(27);
  });

  it('erode3x3x3 shrinks a full 3x3x3 block to the center voxel', () => {
    const dims: [number, number, number] = [3, 3, 3];
    const mask = new Uint8Array(27);
    mask.fill(1);

    const eroded = erode3x3x3(mask, dims);
    expect(sumMask(eroded)).toBe(1);
    expect(eroded[13]).toBe(1);
  });
});
