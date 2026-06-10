import { describe, expect, it } from 'vitest';
import { float32ToFloat16Bits } from '../src/utils/svr/glRaymarch';
import { computeRenderPlan } from '../src/utils/svr/renderLod';

// The 3D viewer uploads its float render volume as R16F (HALF_FLOAT), which requires raw
// IEEE 754 half-float bit patterns in a Uint16Array. These tests pin the converter against
// well-known half-float encodings so a regression can't silently corrupt the rendered volume.
describe('svr/float16 upload path', () => {
  it('float32ToFloat16Bits encodes canonical values', () => {
    const out = float32ToFloat16Bits(new Float32Array([0, 1, 0.5, -1, 2, -0.25]));

    expect(Array.from(out)).toEqual([
      0x0000, // +0
      0x3c00, // 1.0
      0x3800, // 0.5
      0xbc00, // -1.0
      0x4000, // 2.0
      0xb400, // -0.25
    ]);
  });

  it('float32ToFloat16Bits handles overflow, underflow, and NaN backstops', () => {
    const out = float32ToFloat16Bits(new Float32Array([65504, 1e6, Infinity, -Infinity, NaN, 2 ** -24, 1e-10]));

    expect(out[0]).toBe(0x7bff); // largest finite half
    expect(out[1]).toBe(0x7c00); // overflow -> +Inf
    expect(out[2]).toBe(0x7c00); // +Inf
    expect(out[3]).toBe(0xfc00); // -Inf
    expect(out[4]).toBe(0x7e00); // NaN stays NaN (quiet bit set)
    expect(out[5]).toBe(0x0001); // smallest subnormal
    expect(out[6]).toBe(0x0000); // below subnormal range -> +0
  });

  it('float32ToFloat16Bits round-trips display-range values within half precision', () => {
    // Volume intensities are normalized [0,1]; half has an 11-bit significand, so the
    // worst-case relative error in this range must stay under 2^-11.
    const values = new Float32Array([0.001, 0.123, 0.25, 0.333, 0.5, 0.666, 0.875, 0.999]);
    const bits = float32ToFloat16Bits(values);

    for (let i = 0; i < values.length; i++) {
      const h = bits[i]!;
      // Decode the half-float bits back to a number (normalized values only in this range).
      const sign = h & 0x8000 ? -1 : 1;
      const exp = (h >> 10) & 0x1f;
      const mant = h & 0x3ff;
      const decoded = sign * 2 ** (exp - 15) * (1 + mant / 1024);

      expect(Math.abs(decoded - values[i]!) / values[i]!).toBeLessThan(2 ** -11);
    }
  });

  it('computeRenderPlan budgets the float plan at 2 bytes/voxel (R16F, not R32F)', () => {
    // 512^3 voxels at R16F = 256 MiB exactly; under the old R32F accounting (512 MiB)
    // this budget would have forced a downgrade to u8 or a lower-res grid.
    const plan = computeRenderPlan({
      srcDims: { nx: 512, ny: 512, nz: 512 },
      labelsEnabled: false,
      hasLabels: false,
      budgetMiB: 384,
      quality: 'auto',
      textureMode: 'auto',
    });

    expect(plan.kind).toBe('f32');
    expect(plan.dims).toEqual({ nx: 512, ny: 512, nz: 512 });
    expect(plan.estGpuVolBytes).toBe(2 * 512 * 512 * 512);
  });
});
