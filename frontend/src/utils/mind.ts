import type { ExclusionMask } from '../types/api';

export type MindOffset = { dx: number; dy: number };

export type MindOptions = {
  /** Optional inclusion mask (same shape as images). Keep pixels where mask[idx] != 0. */
  inclusionMask?: Uint8Array;

  /** Optional exclusion rectangle in normalized [0,1] image coordinates. */
  exclusionRect?: ExclusionMask;

  /** Image width in pixels (required if exclusionRect is provided). */
  imageWidth?: number;
  /** Image height in pixels (required if exclusionRect is provided). */
  imageHeight?: number;

  /** Patch radius in pixels (default: 1 => 3x3). */
  patchRadius?: number;

  /** Offsets used for the self-similarity descriptor (default: 4-neighborhood at radius 1). */
  offsets?: MindOffset[];
};

export type PreparedMindReference = {
  size: number;
  offsets: MindOffset[];
  patchRadius: number;

  /** Effective mask used for descriptor construction (1 = included). */
  effectiveMask: Uint8Array;

  /** Descriptor values per pixel (row-major), concatenated as [idx*K + k]. */
  descriptor: Float32Array;

  /** 1 if descriptor was computed for that pixel (else 0). */
  valid: Uint8Array;
};

function inferSquareSize(n: number): number {
  const s = Math.round(Math.sqrt(n));
  if (s <= 0 || s * s !== n) {
    throw new Error('mind: expected square image (provide imageWidth/imageHeight)');
  }
  return s;
}

function buildEffectiveMask(n: number, size: number, opts: MindOptions): Uint8Array {
  const inclusionMask = opts.inclusionMask;
  if (inclusionMask && inclusionMask.length !== n) {
    throw new Error(`mind: inclusionMask length mismatch (mask=${inclusionMask.length}, image=${n})`);
  }

  const out = new Uint8Array(n);
  if (inclusionMask) {
    for (let i = 0; i < n; i++) out[i] = inclusionMask[i] ? 1 : 0;
  } else {
    out.fill(1);
  }

  const exclusionRect = opts.exclusionRect;
  if (exclusionRect && size > 0) {
    const x0 = Math.floor(exclusionRect.x * size);
    const y0 = Math.floor(exclusionRect.y * size);
    const x1 = Math.ceil((exclusionRect.x + exclusionRect.width) * size);
    const y1 = Math.ceil((exclusionRect.y + exclusionRect.height) * size);

    if (x1 > x0 && y1 > y0) {
      for (let y = Math.max(0, y0); y < Math.min(size, y1); y++) {
        const row = y * size;
        for (let x = Math.max(0, x0); x < Math.min(size, x1); x++) {
          out[row + x] = 0;
        }
      }
    }
  }

  return out;
}

function defaultOffsets(): MindOffset[] {
  // 2D 4-neighborhood (radius 1). This is a simplified MIND-like descriptor.
  return [
    { dx: 1, dy: 0 },
    { dx: -1, dy: 0 },
    { dx: 0, dy: 1 },
    { dx: 0, dy: -1 },
  ];
}

/**
 * Prepare a reference MIND-like self-similarity descriptor.
 *
 * This is intentionally a simplified 2D variant (patch SSD to a small set of offsets, normalized
 * by local variance). It is meant for experimentation in slice search.
 */
export function prepareMindReference(referencePixels: Float32Array, opts: MindOptions = {}): PreparedMindReference {
  const n = referencePixels.length;
  if (n === 0) {
    return {
      size: 0,
      offsets: [],
      patchRadius: 1,
      effectiveMask: new Uint8Array(0),
      descriptor: new Float32Array(0),
      valid: new Uint8Array(0),
    };
  }

  const size =
    typeof opts.imageWidth === 'number' && typeof opts.imageHeight === 'number' && opts.imageWidth === opts.imageHeight
      ? opts.imageWidth
      : inferSquareSize(n);

  const offsets = (opts.offsets && opts.offsets.length > 0 ? opts.offsets : defaultOffsets()).map((o) => ({
    dx: Math.round(o.dx),
    dy: Math.round(o.dy),
  }));

  const patchRadius = Math.max(1, Math.round(opts.patchRadius ?? 1));

  const effectiveMask = buildEffectiveMask(n, size, { ...opts, imageWidth: size, imageHeight: size });

  const k = offsets.length;
  const descriptor = new Float32Array(n * k);
  const valid = new Uint8Array(n);

  // Determine how close to the border we can compute descriptors.
  let maxAbsOffset = 0;
  for (const o of offsets) {
    maxAbsOffset = Math.max(maxAbsOffset, Math.abs(o.dx), Math.abs(o.dy));
  }
  const margin = patchRadius + maxAbsOffset;

  const ssd = new Float64Array(k);

  const eps = 1e-12;

  for (let y = margin; y < size - margin; y++) {
    const row = y * size;
    for (let x = margin; x < size - margin; x++) {
      const centerIdx = row + x;
      if (effectiveMask[centerIdx] === 0) continue;

      let ok = true;

      for (let kk = 0; kk < k; kk++) {
        const { dx, dy } = offsets[kk]!;
        let sum = 0;
        let count = 0;

        for (let py = -patchRadius; py <= patchRadius; py++) {
          const y1 = y + py;
          const y2 = y1 + dy;
          const row1 = y1 * size;
          const row2 = y2 * size;

          for (let px = -patchRadius; px <= patchRadius; px++) {
            const x1 = x + px;
            const x2 = x1 + dx;

            const idx1 = row1 + x1;
            const idx2 = row2 + x2;

            if (effectiveMask[idx1] === 0 || effectiveMask[idx2] === 0) continue;

            const a = referencePixels[idx1]!;
            const b = referencePixels[idx2]!;
            const d = a - b;
            sum += d * d;
            count++;
          }
        }

        if (count === 0) {
          ok = false;
          break;
        }

        // Use mean squared difference so patch size doesn't change the scale.
        ssd[kk] = sum / count;
      }

      if (!ok) continue;

      // Local variance estimate: mean SSD across offsets.
      let v = 0;
      for (let kk = 0; kk < k; kk++) v += ssd[kk]!;
      v /= k;
      if (v < eps) v = eps;

      // Build descriptor and normalize so the max component is 1.
      let maxD = 0;
      const base = centerIdx * k;
      for (let kk = 0; kk < k; kk++) {
        const d = Math.exp(-ssd[kk]! / v);
        descriptor[base + kk] = d;
        if (d > maxD) maxD = d;
      }

      if (maxD > eps) {
        const inv = 1 / maxD;
        for (let kk = 0; kk < k; kk++) {
          descriptor[base + kk] *= inv;
        }
      }

      valid[centerIdx] = 1;
    }
  }

  return { size, offsets, patchRadius, effectiveMask, descriptor, valid };
}

/**
 * Compute similarity between a prepared reference descriptor and a target image.
 *
 * Returns a similarity in (0..1], where 1 means identical descriptors.
 */
export function computeMindSimilarity(
  prepared: PreparedMindReference,
  targetPixels: Float32Array
): { mind: number; pixelsUsed: number } {
  const size = prepared.size;
  if (size <= 0) return { mind: 0, pixelsUsed: 0 };

  const n = size * size;
  if (targetPixels.length !== n) {
    throw new Error(`mind: target size mismatch (expected ${n}, got ${targetPixels.length})`);
  }

  const offsets = prepared.offsets;
  const k = offsets.length;
  const patchRadius = prepared.patchRadius;

  // Determine compute margin based on offsets + patch radius.
  let maxAbsOffset = 0;
  for (const o of offsets) {
    maxAbsOffset = Math.max(maxAbsOffset, Math.abs(o.dx), Math.abs(o.dy));
  }
  const margin = patchRadius + maxAbsOffset;

  const ssd = new Float64Array(k);

  const eps = 1e-12;

  let distSum = 0;
  let used = 0;

  for (let y = margin; y < size - margin; y++) {
    const row = y * size;
    for (let x = margin; x < size - margin; x++) {
      const centerIdx = row + x;
      if (prepared.valid[centerIdx] === 0) continue;
      if (prepared.effectiveMask[centerIdx] === 0) continue;

      let ok = true;

      for (let kk = 0; kk < k; kk++) {
        const { dx, dy } = offsets[kk]!;
        let sum = 0;
        let count = 0;

        for (let py = -patchRadius; py <= patchRadius; py++) {
          const y1 = y + py;
          const y2 = y1 + dy;
          const row1 = y1 * size;
          const row2 = y2 * size;

          for (let px = -patchRadius; px <= patchRadius; px++) {
            const x1 = x + px;
            const x2 = x1 + dx;

            const idx1 = row1 + x1;
            const idx2 = row2 + x2;

            if (prepared.effectiveMask[idx1] === 0 || prepared.effectiveMask[idx2] === 0) continue;

            const a = targetPixels[idx1]!;
            const b = targetPixels[idx2]!;
            const d = a - b;
            sum += d * d;
            count++;
          }
        }

        if (count === 0) {
          ok = false;
          break;
        }

        ssd[kk] = sum / count;
      }

      if (!ok) continue;

      // Local variance estimate.
      let v = 0;
      for (let kk = 0; kk < k; kk++) v += ssd[kk]!;
      v /= k;
      if (v < eps) v = eps;

      // Build target descriptor and compare against the precomputed reference.
      let maxD = 0;
      for (let kk = 0; kk < k; kk++) {
        const d = Math.exp(-ssd[kk]! / v);
        ssd[kk] = d;
        if (d > maxD) maxD = d;
      }

      if (maxD <= eps) continue;
      const invMax = 1 / maxD;

      const base = centerIdx * k;

      let perPixel = 0;
      for (let kk = 0; kk < k; kk++) {
        const t = (ssd[kk]! as number) * invMax;
        const r = prepared.descriptor[base + kk]!;
        const diff = t - r;
        perPixel += diff * diff;
      }

      distSum += perPixel / k;
      used++;
    }
  }

  if (used === 0) return { mind: 0, pixelsUsed: 0 };

  const meanDist = distSum / used;
  const mind = Math.exp(-meanDist);

  return { mind, pixelsUsed: used };
}
