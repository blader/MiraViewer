import { describe, it, expect } from 'vitest';
import { prepareTransformReference, recoverSimilarityTransform, warpGrayscale } from '../src/utils/transformRecovery';

function mulberry32(seed: number) {
  let t = seed >>> 0;
  return () => {
    t += 0x6d2b79f5;
    let x = Math.imul(t ^ (t >>> 15), 1 | t);
    x ^= x + Math.imul(x ^ (x >>> 7), 61 | x);
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  };
}

function makeTexturedImage(size: number, seed: number): Float32Array {
  const rand = mulberry32(seed);
  const out = new Float32Array(size * size);

  const cx = (size - 1) / 2;
  const cy = (size - 1) / 2;
  const maxR = Math.min(cx, cy);

  for (let y = 0; y < size; y++) {
    const dy = y - cy;
    for (let x = 0; x < size; x++) {
      const dx = x - cx;
      const r = Math.sqrt(dx * dx + dy * dy);
      const t = Math.min(1, r / maxR);

      // Central weighting so the spectrum has good content but edges stay calm.
      const w = 0.5 * (1 + Math.cos(Math.PI * t));

      // Mix of structured + random content.
      const stripes = 0.5 + 0.5 * Math.sin((x * 2 * Math.PI) / 17 + (y * 2 * Math.PI) / 23);
      const noise = rand();

      out[y * size + x] = w * (0.65 * stripes + 0.35 * noise);
    }
  }

  // Add a couple of asymmetric blobs to break rotational symmetry.
  const addBlob = (bx: number, by: number, sigma: number, amp: number) => {
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const dx = x - bx;
        const dy = y - by;
        out[y * size + x] += amp * Math.exp(-(dx * dx + dy * dy) / (2 * sigma * sigma));
      }
    }
  };

  addBlob(size * 0.33, size * 0.46, size * 0.06, 0.6);
  addBlob(size * 0.62, size * 0.58, size * 0.04, 0.4);

  // Clamp to [0,1]
  for (let i = 0; i < out.length; i++) {
    out[i] = Math.max(0, Math.min(1, out[i]));
  }

  return out;
}

describe('transformRecovery', () => {
  it('recovers translation sign convention (positive = shift right/down)', () => {
    const size = 128;
    const target = makeTexturedImage(size, 123);

    const truth = { zoom: 1, rotationDeg: 0, translateX: 9, translateY: -7 };
    const reference = warpGrayscale(target, size, truth);

    const ref = prepareTransformReference(reference, size);
    const recovered = recoverSimilarityTransform(ref, target, { includeDebug: true });

    expect(Math.abs(recovered.rotation)).toBeLessThanOrEqual(2);

    const dxPx = recovered.panX * size;
    const dyPx = recovered.panY * size;

    // Phase correlation is subpixel-agnostic here; allow a couple pixels tolerance.
    expect(Math.abs(dxPx - truth.translateX)).toBeLessThanOrEqual(2);
    expect(Math.abs(dyPx - truth.translateY)).toBeLessThanOrEqual(2);
    expect(recovered.confidence).toBeGreaterThan(0);
  });

  it('recovers rotation/scale/translation within reasonable tolerance', () => {
    const size = 128;
    const target = makeTexturedImage(size, 999);

    const truth = { zoom: 1.18, rotationDeg: 14, translateX: 6, translateY: 4 };
    const reference = warpGrayscale(target, size, truth);

    const ref = prepareTransformReference(reference, size);
    const recovered = recoverSimilarityTransform(ref, target, { includeDebug: true });

    const dxPx = recovered.panX * size;
    const dyPx = recovered.panY * size;

    // Rotation/scale recovery from log-polar is approximate; keep tolerances generous.
    expect(Math.abs(recovered.zoom - truth.zoom)).toBeLessThanOrEqual(0.12);
    expect(Math.abs(recovered.rotation - truth.rotationDeg)).toBeLessThanOrEqual(5);

    // Translation tends to be more accurate.
    expect(Math.abs(dxPx - truth.translateX)).toBeLessThanOrEqual(2);
    expect(Math.abs(dyPx - truth.translateY)).toBeLessThanOrEqual(2);
    expect(recovered.confidence).toBeGreaterThan(0);
  });
});
