function idx(x: number, y: number, w: number) {
  return y * w + x;
}

/**
 * Morphological dilation (3x3) for a binary mask.
 *
 * Mask values are expected to be 0 or 1.
 */
export function dilate3x3(mask: Uint8Array, w: number, h: number): Uint8Array {
  const out = new Uint8Array(w * h);

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let on = 0;

      for (let dy = -1; dy <= 1 && !on; dy++) {
        const yy = y + dy;
        if (yy < 0 || yy >= h) continue;
        const row = yy * w;

        for (let dx = -1; dx <= 1; dx++) {
          const xx = x + dx;
          if (xx < 0 || xx >= w) continue;
          if (mask[row + xx]) {
            on = 1;
            break;
          }
        }
      }

      out[idx(x, y, w)] = on;
    }
  }

  return out;
}

/**
 * Morphological erosion (3x3) for a binary mask.
 *
 * Out-of-bounds neighbors are treated as 0.
 */
export function erode3x3(mask: Uint8Array, w: number, h: number): Uint8Array {
  const out = new Uint8Array(w * h);

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let on = 1;

      for (let dy = -1; dy <= 1 && on; dy++) {
        const yy = y + dy;
        if (yy < 0 || yy >= h) {
          on = 0;
          break;
        }
        const row = yy * w;

        for (let dx = -1; dx <= 1; dx++) {
          const xx = x + dx;
          if (xx < 0 || xx >= w) {
            on = 0;
            break;
          }
          if (!mask[row + xx]) {
            on = 0;
            break;
          }
        }
      }

      out[idx(x, y, w)] = on;
    }
  }

  return out;
}

/**
 * Morphological close: dilate then erode.
 *
 * This fills small holes and bridges tiny gaps in the mask.
 */
export function morphologicalClose(mask: Uint8Array, w: number, h: number): Uint8Array {
  const dilated = dilate3x3(mask, w, h);
  return erode3x3(dilated, w, h);
}

/**
 * Morphological open: erode then dilate.
 *
 * This removes thin spurs / narrow connections and can reduce small leakage regions.
 */
export function morphologicalOpen(mask: Uint8Array, w: number, h: number): Uint8Array {
  const eroded = erode3x3(mask, w, h);
  return dilate3x3(eroded, w, h);
}
