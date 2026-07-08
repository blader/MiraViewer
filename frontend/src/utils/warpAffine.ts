import type { Mat2 } from './affine2d';
import { invert2 } from './affine2d';

function bilinearSampleInto(
  image: Float32Array,
  size: number,
  x: number,
  y: number,
  pixels: Float32Array,
  validityOut: Float32Array,
  outIdx: number
): void {
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const x1 = x0 + 1;
  const y1 = y0 + 1;

  const tx = x - x0;
  const ty = y - y0;

  let value = 0;
  let validity = 0;
  const w00 = (1 - tx) * (1 - ty);
  const w10 = tx * (1 - ty);
  const w01 = (1 - tx) * ty;
  const w11 = tx * ty;

  if (w00 !== 0 && x0 >= 0 && y0 >= 0 && x0 < size && y0 < size) {
    value += (image[y0 * size + x0] ?? 0) * w00;
    validity += w00;
  }
  if (w10 !== 0 && x1 >= 0 && y0 >= 0 && x1 < size && y0 < size) {
    value += (image[y0 * size + x1] ?? 0) * w10;
    validity += w10;
  }
  if (w01 !== 0 && x0 >= 0 && y1 >= 0 && x0 < size && y1 < size) {
    value += (image[y1 * size + x0] ?? 0) * w01;
    validity += w01;
  }
  if (w11 !== 0 && x1 >= 0 && y1 >= 0 && x1 < size && y1 < size) {
    value += (image[y1 * size + x1] ?? 0) * w11;
    validity += w11;
  }

  pixels[outIdx] = value;
  validityOut[outIdx] = validity;
}

export type WarpedGrayscale = {
  pixels: Float32Array;
  validity: Float32Array;
};

/**
 * Replace geometric padding with the mean of valid samples before a registration optimizer sees it.
 * `pixels` is zero-padding-premultiplied at fractional boundaries, so the missing fraction is filled
 * additively instead of dividing unstable edge samples by tiny validity values.
 */
export function fillInvalidWarpWithValidMean(warped: WarpedGrayscale): Float32Array {
  if (warped.pixels.length !== warped.validity.length) {
    throw new Error('fillInvalidWarpWithValidMean: pixels/validity length mismatch');
  }
  let weightedValueSum = 0;
  let validitySum = 0;
  for (let index = 0; index < warped.pixels.length; index++) {
    const validity = Math.max(0, Math.min(1, warped.validity[index] ?? 0));
    weightedValueSum += warped.pixels[index] ?? 0;
    validitySum += validity;
  }
  const validMean = validitySum > 1e-8 ? weightedValueSum / validitySum : 0;
  const output = new Float32Array(warped.pixels.length);
  for (let index = 0; index < output.length; index++) {
    const validity = Math.max(0, Math.min(1, warped.validity[index] ?? 0));
    output[index] = (warped.pixels[index] ?? 0) + validMean * (1 - validity);
  }
  return output;
}

export function warpGrayscaleAffineWithValidity(
  input: Float32Array,
  size: number,
  transform: {
    // moving -> fixed linear transform about center
    A: Mat2;
    // display-space translation in pixels (applied after A about center)
    translateX: number;
    translateY: number;
  }
): WarpedGrayscale {
  if (input.length !== size * size) {
    throw new Error(`warpGrayscaleAffine: expected ${size}x${size} image (got ${input.length} pixels)`);
  }

  const out = new Float32Array(size * size);
  const validity = new Float32Array(size * size);

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

      const outIdx = y * size + x;
      bilinearSampleInto(input, size, u, v, out, validity, outIdx);
    }
  }

  return { pixels: out, validity };
}

export function warpGrayscaleAffine(
  input: Float32Array,
  size: number,
  transform: {
    A: Mat2;
    translateX: number;
    translateY: number;
  }
): Float32Array {
  return warpGrayscaleAffineWithValidity(input, size, transform).pixels;
}
