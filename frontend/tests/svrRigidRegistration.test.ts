/**
 * Tests for SVR rigid registration module.
 *
 * These tests verify the correctness of:
 * - Euler angle to rotation matrix conversion
 * - Rigid transform application (rotation + translation)
 * - Normalized cross-correlation (NCC) scoring
 * - Optimization convergence
 */

import { describe, expect, it } from 'vitest';
import {
  mat3FromEulerXYZ,
  mat3MulVec3,
  applyRigidToPoint,
  boundsCenterMm,
  scoreNcc,
  scoreBidirectionalNcc,
  invertRigidParams,
  buildSeriesSamples,
  optimizeRigidNcc,
} from '../src/utils/svr/rigidRegistration';
import type { SeriesSamples, BoundsMm } from '../src/utils/svr/rigidRegistration';
import { sampleTrilinear } from '../src/utils/svr/trilinear';
import { v3 } from '../src/utils/svr/vec3';

describe('svr/rigidRegistration', () => {
  describe('mat3FromEulerXYZ', () => {
    it('produces identity matrix for zero angles', () => {
      const m = mat3FromEulerXYZ(0, 0, 0);

      // Identity matrix: diagonal 1s, off-diagonal 0s
      expect(m[0]).toBeCloseTo(1); // m00
      expect(m[4]).toBeCloseTo(1); // m11
      expect(m[8]).toBeCloseTo(1); // m22

      expect(m[1]).toBeCloseTo(0); // m01
      expect(m[2]).toBeCloseTo(0); // m02
      expect(m[3]).toBeCloseTo(0); // m10
      expect(m[5]).toBeCloseTo(0); // m12
      expect(m[6]).toBeCloseTo(0); // m20
      expect(m[7]).toBeCloseTo(0); // m21
    });

    it('rotates 90° about X axis correctly', () => {
      const m = mat3FromEulerXYZ(Math.PI / 2, 0, 0);

      // After 90° X rotation: Y → Z, Z → -Y
      const v = mat3MulVec3(m, 0, 1, 0); // Rotate unit Y
      expect(v.x).toBeCloseTo(0);
      expect(v.y).toBeCloseTo(0);
      expect(v.z).toBeCloseTo(1);
    });

    it('rotates 90° about Y axis correctly', () => {
      const m = mat3FromEulerXYZ(0, Math.PI / 2, 0);

      // After 90° Y rotation: X → -Z, Z → X
      const v = mat3MulVec3(m, 1, 0, 0); // Rotate unit X
      expect(v.x).toBeCloseTo(0);
      expect(v.y).toBeCloseTo(0);
      expect(v.z).toBeCloseTo(-1);
    });

    it('rotates 90° about Z axis correctly', () => {
      const m = mat3FromEulerXYZ(0, 0, Math.PI / 2);

      // After 90° Z rotation: X → Y, Y → -X
      const v = mat3MulVec3(m, 1, 0, 0); // Rotate unit X
      expect(v.x).toBeCloseTo(0);
      expect(v.y).toBeCloseTo(1);
      expect(v.z).toBeCloseTo(0);
    });

    it('produces orthonormal matrix for arbitrary angles', () => {
      const m = mat3FromEulerXYZ(0.3, 0.5, 0.7);

      // Check that columns are unit vectors
      const col0 = Math.sqrt(m[0] ** 2 + m[3] ** 2 + m[6] ** 2);
      const col1 = Math.sqrt(m[1] ** 2 + m[4] ** 2 + m[7] ** 2);
      const col2 = Math.sqrt(m[2] ** 2 + m[5] ** 2 + m[8] ** 2);

      expect(col0).toBeCloseTo(1);
      expect(col1).toBeCloseTo(1);
      expect(col2).toBeCloseTo(1);

      // Check that columns are orthogonal (dot products = 0)
      const dot01 = m[0] * m[1] + m[3] * m[4] + m[6] * m[7];
      const dot02 = m[0] * m[2] + m[3] * m[5] + m[6] * m[8];
      const dot12 = m[1] * m[2] + m[4] * m[5] + m[7] * m[8];

      expect(dot01).toBeCloseTo(0);
      expect(dot02).toBeCloseTo(0);
      expect(dot12).toBeCloseTo(0);
    });
  });

  describe('applyRigidToPoint', () => {
    it('returns same point when no rotation or translation', () => {
      const p = v3(5, 10, 15);
      const center = v3(0, 0, 0);
      const rot = mat3FromEulerXYZ(0, 0, 0);
      const t = v3(0, 0, 0);

      const result = applyRigidToPoint(p, center, rot, t);

      expect(result.x).toBeCloseTo(5);
      expect(result.y).toBeCloseTo(10);
      expect(result.z).toBeCloseTo(15);
    });

    it('applies translation only (no rotation)', () => {
      const p = v3(5, 10, 15);
      const center = v3(0, 0, 0);
      const rot = mat3FromEulerXYZ(0, 0, 0);
      const t = v3(1, 2, 3);

      const result = applyRigidToPoint(p, center, rot, t);

      expect(result.x).toBeCloseTo(6);
      expect(result.y).toBeCloseTo(12);
      expect(result.z).toBeCloseTo(18);
    });

    it('rotates about center point correctly', () => {
      // Point on the X axis, 10 units from center
      const p = v3(10, 0, 0);
      const center = v3(0, 0, 0);
      const rot = mat3FromEulerXYZ(0, 0, Math.PI / 2); // 90° about Z
      const t = v3(0, 0, 0);

      const result = applyRigidToPoint(p, center, rot, t);

      // After 90° Z rotation: (10,0,0) → (0,10,0)
      expect(result.x).toBeCloseTo(0);
      expect(result.y).toBeCloseTo(10);
      expect(result.z).toBeCloseTo(0);
    });

    it('rotates about non-origin center correctly', () => {
      // Point at (20, 10, 0), center at (10, 10, 0)
      // Offset from center is (10, 0, 0)
      const p = v3(20, 10, 0);
      const center = v3(10, 10, 0);
      const rot = mat3FromEulerXYZ(0, 0, Math.PI / 2); // 90° about Z
      const t = v3(0, 0, 0);

      const result = applyRigidToPoint(p, center, rot, t);

      // After 90° Z rotation about (10,10,0): offset (10,0,0) → (0,10,0)
      // Final position: (10,10,0) + (0,10,0) = (10,20,0)
      expect(result.x).toBeCloseTo(10);
      expect(result.y).toBeCloseTo(20);
      expect(result.z).toBeCloseTo(0);
    });

    it('combines rotation and translation correctly', () => {
      const p = v3(10, 0, 0);
      const center = v3(0, 0, 0);
      const rot = mat3FromEulerXYZ(0, 0, Math.PI / 2);
      const t = v3(5, 5, 0);

      const result = applyRigidToPoint(p, center, rot, t);

      // (10,0,0) rotated 90° about Z → (0,10,0), then translated by (5,5,0) → (5,15,0)
      expect(result.x).toBeCloseTo(5);
      expect(result.y).toBeCloseTo(15);
      expect(result.z).toBeCloseTo(0);
    });
  });

  describe('boundsCenterMm', () => {
    it('computes center of axis-aligned box', () => {
      const bounds: BoundsMm = {
        min: v3(0, 0, 0),
        max: v3(10, 20, 30),
      };

      const center = boundsCenterMm(bounds);

      expect(center.x).toBeCloseTo(5);
      expect(center.y).toBeCloseTo(10);
      expect(center.z).toBeCloseTo(15);
    });

    it('handles negative coordinates', () => {
      const bounds: BoundsMm = {
        min: v3(-10, -20, -30),
        max: v3(10, 20, 30),
      };

      const center = boundsCenterMm(bounds);

      expect(center.x).toBeCloseTo(0);
      expect(center.y).toBeCloseTo(0);
      expect(center.z).toBeCloseTo(0);
    });
  });

  describe('scoreNcc', () => {
    it('returns -Infinity for empty samples', () => {
      const samples: SeriesSamples = {
        obs: new Float32Array(0),
        pos: new Float32Array(0),
        count: 0,
      };

      const dims = { nx: 10, ny: 10, nz: 10 };
      const volume = new Float32Array(dims.nx * dims.ny * dims.nz);

      const result = scoreNcc({
        samples,
        refVolume: volume,
        dims,
        originMm: v3(0, 0, 0),
        voxelSizeMm: 1,
        centerMm: v3(5, 5, 5),
        rigid: { tx: 0, ty: 0, tz: 0, rx: 0, ry: 0, rz: 0 },
      });

      expect(result.ncc).toBe(Number.NEGATIVE_INFINITY);
      expect(result.used).toBe(0);
    });

    it('returns -Infinity when too few samples are in bounds', () => {
      // Create a small number of samples (less than the MIN_SAMPLES threshold of 512)
      const samples: SeriesSamples = {
        obs: new Float32Array([0.5, 0.6, 0.7]),
        pos: new Float32Array([1, 1, 1, 2, 2, 2, 3, 3, 3]),
        count: 3,
      };

      const dims = { nx: 10, ny: 10, nz: 10 };
      const volume = new Float32Array(dims.nx * dims.ny * dims.nz);

      const result = scoreNcc({
        samples,
        refVolume: volume,
        dims,
        originMm: v3(0, 0, 0),
        voxelSizeMm: 1,
        centerMm: v3(5, 5, 5),
        rigid: { tx: 0, ty: 0, tz: 0, rx: 0, ry: 0, rz: 0 },
      });

      expect(result.ncc).toBe(Number.NEGATIVE_INFINITY);
      expect(result.used).toBeLessThan(512);
    });

    it('returns high NCC for identical signals', () => {
      const dims = { nx: 20, ny: 20, nz: 20 };
      const volume = new Float32Array(dims.nx * dims.ny * dims.nz);

      // Fill volume with a gradient
      for (let z = 0; z < dims.nz; z++) {
        for (let y = 0; y < dims.ny; y++) {
          for (let x = 0; x < dims.nx; x++) {
            const idx = x + y * dims.nx + z * dims.nx * dims.ny;
            volume[idx] = (x + y + z) / (dims.nx + dims.ny + dims.nz);
          }
        }
      }

      // Create samples that match the volume exactly (large enough to pass threshold)
      const obs: number[] = [];
      const pos: number[] = [];
      for (let z = 2; z < dims.nz - 2; z += 2) {
        for (let y = 2; y < dims.ny - 2; y += 2) {
          for (let x = 2; x < dims.nx - 2; x += 2) {
            const idx = x + y * dims.nx + z * dims.nx * dims.ny;
            obs.push(volume[idx] ?? 0);
            pos.push(x, y, z);
          }
        }
      }

      const samples: SeriesSamples = {
        obs: Float32Array.from(obs),
        pos: Float32Array.from(pos),
        count: obs.length,
      };

      const result = scoreNcc({
        samples,
        refVolume: volume,
        dims,
        originMm: v3(0, 0, 0),
        voxelSizeMm: 1,
        centerMm: v3(10, 10, 10),
        rigid: { tx: 0, ty: 0, tz: 0, rx: 0, ry: 0, rz: 0 },
      });

      // NCC of identical signals should be 1 (or very close)
      expect(result.ncc).toBeGreaterThan(0.99);
      expect(result.used).toBeGreaterThan(100);
    });

    it('rejects fully supported but anatomically flat signals instead of inventing zero-confidence NCC', () => {
      const dims = { nx: 10, ny: 10, nz: 10 };
      const count = 600;
      const positions = new Float32Array(count * 3);
      for (let index = 0; index < count; index++) {
        positions.set([1 + (index % 8), 1 + (Math.floor(index / 8) % 8), 1], index * 3);
      }

      const result = scoreNcc({
        samples: { obs: new Float32Array(count).fill(0.5), pos: positions, count },
        refVolume: new Float32Array(1000).fill(0.5),
        occupancy: new Uint8Array(1000).fill(1),
        dims,
        originMm: v3(0, 0, 0),
        voxelSizeMm: 1,
        centerMm: v3(5, 5, 5),
        rigid: { tx: 0, ty: 0, tz: 0, rx: 0, ry: 0, rz: 0 },
      });

      expect(result.coverage).toBe(1);
      expect(result.used).toBe(count);
      expect(result.ncc).toBe(Number.NEGATIVE_INFINITY);
      expect(result.rawNcc).toBe(Number.NEGATIVE_INFINITY);
    });

    it('rejects a deceptively perfect registration that discards most anatomical support', () => {
      const dims = { nx: 22, ny: 100, nz: 3 };
      const field = (x: number, y: number) => Math.sin(x * 0.31) + Math.cos(y * 0.13);
      const volume = new Float32Array(dims.nx * dims.ny * dims.nz);
      for (let z = 0; z < dims.nz; z++) {
        for (let y = 0; y < dims.ny; y++) {
          for (let x = 0; x < dims.nx; x++) volume[x + y * dims.nx + z * dims.nx * dims.ny] = field(x, y);
        }
      }

      const count = 21 * 99 * 6;
      const obs = new Float32Array(count);
      const pos = new Float32Array(count * 3);
      let cursor = 0;
      for (let repetition = 0; repetition < 6; repetition++) {
        for (let y = 0; y < 99; y++) {
          for (let x = 0; x < 21; x++) {
            obs[cursor] = x === 0 ? field(20, y) : -field(x, y);
            pos.set([x, y, 0.5], cursor * 3);
            cursor++;
          }
        }
      }

      const result = scoreNcc({
        samples: { obs, pos, count },
        refVolume: volume,
        dims,
        originMm: v3(0, 0, 0),
        voxelSizeMm: 1,
        centerMm: v3(0, 0, 0),
        rigid: { tx: 20, ty: 0, tz: 0, rx: 0, ry: 0, rz: 0 },
      });

      expect(result.used).toBeGreaterThanOrEqual(512);
      expect(result.ncc).toBe(Number.NEGATIVE_INFINITY);
    });

    it('never treats zero-filled unsupported reference voxels as observed anatomy', () => {
      const dims = { nx: 10, ny: 10, nz: 10 };
      const count = 600;
      const samples: SeriesSamples = {
        obs: new Float32Array(count).fill(1),
        pos: new Float32Array(count * 3),
        count,
      };
      for (let index = 0; index < count; index++) samples.pos.set([1 + (index % 8), 1, 1], index * 3);

      const result = scoreNcc({
        samples,
        refVolume: new Float32Array(1000),
        occupancy: new Uint8Array(1000),
        dims,
        originMm: v3(0, 0, 0),
        voxelSizeMm: 1,
        centerMm: v3(0, 0, 0),
        rigid: { tx: 0, ty: 0, tz: 0, rx: 0, ry: 0, rz: 0 },
      });

      expect(result.used).toBe(0);
      expect(result.ncc).toBe(Number.NEGATIVE_INFINITY);
    });

    it('rejects otherwise convincing forward evidence when reverse anatomy is unsupported', () => {
      const dims = { nx: 10, ny: 10, nz: 10 };
      const count = 600;
      const positions = new Float32Array(count * 3);
      const values = new Float32Array(count);
      const volume = new Float32Array(1000);
      for (let index = 0; index < count; index++) {
        const x = 1 + (index % 8);
        positions.set([x, 1, 1], index * 3);
        values[index] = x;
        volume[x + 10 + 100] = x;
      }
      const common = {
        samples: { obs: values, pos: positions, count },
        refVolume: volume,
        dims,
        originMm: v3(0, 0, 0),
        voxelSizeMm: 1,
      };

      const result = scoreBidirectionalNcc({
        ...common,
        centerMm: v3(0, 0, 0),
        rigid: { tx: 0, ty: 0, tz: 0, rx: 0, ry: 0, rz: 0 },
        reverse: { ...common, occupancy: new Uint8Array(volume.length) },
      });

      expect(result.forward.ncc).toBeGreaterThan(0.99);
      expect(result.reverse.used).toBe(0);
      expect(result.ncc).toBe(Number.NEGATIVE_INFINITY);
    });
  });

  it('samples across the complete slice field instead of exhausting its quota in the first rows', () => {
    const samples = buildSeriesSamples({
      slices: [
        {
          pixels: new Float32Array(20 * 20).fill(1),
          dsRows: 20,
          dsCols: 20,
          ippMm: v3(0, 0, 0),
          rowDir: v3(1, 0, 0),
          colDir: v3(0, 1, 0),
          normalDir: v3(0, 0, 1),
          rowSpacingDsMm: 1,
          colSpacingDsMm: 1,
          sliceThicknessMm: 1,
          spacingBetweenSlicesMm: 1,
        },
      ],
      roiBounds: { min: v3(0, 0, 0), max: v3(20, 20, 1) },
      maxSamples: 80,
    });

    let highestRow = 0;
    for (let index = 0; index < samples.count; index++) highestRow = Math.max(highestRow, samples.pos[index * 3 + 1]!);
    expect(highestRow).toBeGreaterThanOrEqual(18);
  });

  it('uses acquired validity rather than intensity to include zero and negative registration samples', () => {
    const samples = buildSeriesSamples({
      slices: [
        {
          pixels: new Float32Array([-2, 0, 5, 999]),
          valid: new Uint8Array([1, 1, 1, 0]),
          dsRows: 2,
          dsCols: 2,
          ippMm: v3(0, 0, 0),
          rowDir: v3(1, 0, 0),
          colDir: v3(0, 1, 0),
          normalDir: v3(0, 0, 1),
          rowSpacingDsMm: 1,
          colSpacingDsMm: 1,
          sliceThicknessMm: 1,
          spacingBetweenSlicesMm: 1,
        },
      ],
      roiBounds: { min: v3(0, 0, 0), max: v3(2, 2, 1) },
      maxSamples: 10,
    });

    expect(samples.count).toBe(3);
    expect(Array.from(samples.obs)).toEqual([-2, 0, 5]);
  });

  it('retains quantized acquired-footprint weights in supported registration samples', () => {
    const samples = buildSeriesSamples({
      slices: [
        {
          pixels: new Float32Array([10, 20, 30, 40]),
          valid: new Uint8Array([255, 64, 0, 128]),
          validScale: 255,
          dsRows: 2,
          dsCols: 2,
          ippMm: v3(0, 0, 0),
          rowDir: v3(1, 0, 0),
          colDir: v3(0, 1, 0),
          normalDir: v3(0, 0, 1),
          rowSpacingDsMm: 1,
          colSpacingDsMm: 1,
          sliceThicknessMm: 1,
          spacingBetweenSlicesMm: 1,
        },
      ],
      roiBounds: { min: v3(0, 0, 0), max: v3(2, 2, 1) },
      maxSamples: 10,
    });

    expect(samples.count).toBe(3);
    expect(Array.from(samples.obs)).toEqual([10, 20, 40]);
    expect(samples.weights).toBeDefined();
    expect(samples.weights![0]).toBeCloseTo(1, 6);
    expect(samples.weights![1]).toBeCloseTo(64 / 255, 6);
    expect(samples.weights![2]).toBeCloseTo(128 / 255, 6);
  });

  it('refines physically supported rigid translations below the former half-millimeter floor', async () => {
    const dims = { nx: 24, ny: 24, nz: 24 };
    const volume = new Float32Array(dims.nx * dims.ny * dims.nz);
    for (let z = 0; z < dims.nz; z++) {
      for (let y = 0; y < dims.ny; y++) {
        for (let x = 0; x < dims.nx; x++) {
          volume[x + y * dims.nx + z * dims.nx * dims.ny] =
            Math.sin(x * 0.63 + z * 0.11) + Math.cos(y * 0.51 - x * 0.09) + Math.sin(z * 0.43);
        }
      }
    }

    const observed: number[] = [];
    const positions: number[] = [];
    for (let z = 4; z <= 19; z++) {
      for (let y = 4; y <= 19; y++) {
        for (let x = 4; x <= 19; x++) {
          observed.push(sampleTrilinear(volume, dims, x + 0.2, y - 0.15, z + 0.1));
          positions.push(x, y, z);
        }
      }
    }

    const result = await optimizeRigidNcc({
      samples: { obs: Float32Array.from(observed), pos: Float32Array.from(positions), count: observed.length },
      refVolume: volume,
      dims,
      originMm: v3(0, 0, 0),
      voxelSizeMm: 1,
      centerMm: v3(12, 12, 12),
      maxTranslationMm: 2,
      maxRotationRad: 0,
      finestTranslationStepMm: 0.05,
    });

    expect(result.best.tx).toBeCloseTo(0.2, 1);
    expect(result.best.ty).toBeCloseTo(-0.15, 1);
    expect(result.best.tz).toBeCloseTo(0.1, 1);
  });

  it('inverts center-relative 3D rigid transforms without assuming commuting rotations', () => {
    const rigid = { tx: 2, ty: -3, tz: 4, rx: 0.2, ry: -0.15, rz: 0.1 };
    const inverse = invertRigidParams(rigid);
    const center = v3(10, 20, -5);
    const source = v3(4, -2, 8);
    const transformed = applyRigidToPoint(
      source,
      center,
      mat3FromEulerXYZ(rigid.rx, rigid.ry, rigid.rz),
      v3(rigid.tx, rigid.ty, rigid.tz),
    );
    const restored = applyRigidToPoint(
      transformed,
      center,
      mat3FromEulerXYZ(inverse.rx, inverse.ry, inverse.rz),
      v3(inverse.tx, inverse.ty, inverse.tz),
    );

    expect(restored.x).toBeCloseTo(source.x, 8);
    expect(restored.y).toBeCloseTo(source.y, 8);
    expect(restored.z).toBeCloseTo(source.z, 8);
  });
});
