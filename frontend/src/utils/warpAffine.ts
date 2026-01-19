import type { Mat2 } from './affine2d';
import { invert2 } from './affine2d';

function bilinearSample(image: Float32Array, size: number, x: number, y: number): number {
  if (x < 0 || y < 0 || x > size - 1 || y > size - 1) return 0;

  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const x1 = Math.min(size - 1, x0 + 1);
  const y1 = Math.min(size - 1, y0 + 1);

  const tx = x - x0;
  const ty = y - y0;

  const i00 = image[y0 * size + x0];
  const i10 = image[y0 * size + x1];
  const i01 = image[y1 * size + x0];
  const i11 = image[y1 * size + x1];

  const a = i00 * (1 - tx) + i10 * tx;
  const b = i01 * (1 - tx) + i11 * tx;
  return a * (1 - ty) + b * ty;
}

export function warpGrayscaleAffine(
  input: Float32Array,
  size: number,
  transform: {
    // moving -> fixed linear transform about center
    A: Mat2;
    // display-space translation in pixels (applied after A about center)
    translateX: number;
    translateY: number;
  }
): Float32Array {
  if (input.length !== size * size) {
    throw new Error(`warpGrayscaleAffine: expected ${size}x${size} image (got ${input.length} pixels)`);
  }

  const out = new Float32Array(size * size);

  const cx = (size - 1) / 2;
  const cy = (size - 1) / 2;

  const AInv = invert2(transform.A);

  // Inverse mapping: output -> input.
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      // Output coords relative to center.
      let dx = x - cx;
      let dy = y - cy;

      // Undo translation (translation is applied last in display space).
      dx -= transform.translateX;
      dy -= transform.translateY;

      // Undo linear transform.
      const sx = AInv.m00 * dx + AInv.m01 * dy;
      const sy = AInv.m10 * dx + AInv.m11 * dy;

      const u = sx + cx;
      const v = sy + cy;

      out[y * size + x] = bilinearSample(input, size, u, v);
    }
  }

  return out;
}
