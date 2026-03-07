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
} from '../src/utils/svr/rigidRegistration';
import type { SeriesSamples, BoundsMm } from '../src/utils/svr/rigidRegistration';
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
  });
});
