import { describe, expect, it } from 'vitest';
import { keepLargestConnectedComponent3D } from '../src/utils/segmentation/connectedComponents3D';
import { dilate3x3x3, erode3x3x3 } from '../src/utils/segmentation/morphology3D';
import { regionGrow3D } from '../src/utils/segmentation/regionGrow3D';

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
