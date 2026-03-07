export function resample2dAreaAverage(
  src: ArrayLike<number>,
  srcRows: number,
  srcCols: number,
  dstRows: number,
  dstCols: number
): Float32Array {
  const outRows = Math.max(0, Math.floor(dstRows));
  const outCols = Math.max(0, Math.floor(dstCols));

  if (outRows === 0 || outCols === 0) {
    return new Float32Array(0);
  }

  const inRows = Math.max(0, Math.floor(srcRows));
  const inCols = Math.max(0, Math.floor(srcCols));

  if (inRows === 0 || inCols === 0) {
    return new Float32Array(outRows * outCols);
  }

  // Fast path: no resampling.
  if (inRows === outRows && inCols === outCols) {
    const out = new Float32Array(outRows * outCols);
    for (let i = 0; i < out.length; i++) {
      out[i] = Number(src[i] ?? 0);
    }
    return out;
  }

  // Box-filter (area) resampling.
  //
  // Model each source pixel as a constant value over the unit square [r,r+1)×[c,c+1).
  // Each destination pixel corresponds to a box in source pixel coordinates:
  //   r ∈ [dr*rowScale, (dr+1)*rowScale), c ∈ [dc*colScale, (dc+1)*colScale)
  // We compute the area-weighted average over that box.
  const rowScale = inRows / outRows;
  const colScale = inCols / outCols;
  const invArea = 1 / (rowScale * colScale);

  const out = new Float32Array(outRows * outCols);

  for (let dr = 0; dr < outRows; dr++) {
    const srcR0 = dr * rowScale;
    const srcR1 = (dr + 1) * rowScale;

    const r0 = Math.max(0, Math.floor(srcR0));
    const r1 = Math.min(inRows, Math.ceil(srcR1));

    const outRowBase = dr * outCols;

    for (let dc = 0; dc < outCols; dc++) {
      const srcC0 = dc * colScale;
      const srcC1 = (dc + 1) * colScale;

      const c0 = Math.max(0, Math.floor(srcC0));
      const c1 = Math.min(inCols, Math.ceil(srcC1));

      let sum = 0;

      for (let r = r0; r < r1; r++) {
        const rStart = Math.max(r, srcR0);
        const rEnd = Math.min(r + 1, srcR1);
        const wr = rEnd - rStart;
        if (wr <= 0) continue;

        const srcRowBase = r * inCols;

        for (let c = c0; c < c1; c++) {
          const cStart = Math.max(c, srcC0);
          const cEnd = Math.min(c + 1, srcC1);
          const wc = cEnd - cStart;
          if (wc <= 0) continue;

          const v = Number(src[srcRowBase + c] ?? 0);
          sum += v * wr * wc;
        }
      }

      out[outRowBase + dc] = sum * invArea;
    }
  }

  return out;
}

function sinc(x: number): number {
  if (x === 0) return 1;
  const px = Math.PI * x;
  return Math.sin(px) / px;
}

function lanczos(x: number, a: number): number {
  const ax = Math.abs(x);
  if (ax >= a) return 0;
  return sinc(x) * sinc(x / a);
}

type Contrib = { idx0: number; idx1: number; w: Float32Array };

function buildLanczosContrib(inSize: number, outSize: number, a: number): Contrib[] {
  const inN = Math.max(0, Math.floor(inSize));
  const outN = Math.max(0, Math.floor(outSize));

  const scale = outN / Math.max(1, inN);

  // When downsampling (scale<1), widen the filter footprint to act as an anti-aliasing low-pass.
  const kernelScale = scale < 1 ? scale : 1;
  const radius = a / Math.max(1e-6, kernelScale);

  const contrib: Contrib[] = new Array(outN);

  for (let o = 0; o < outN; o++) {
    // Map output sample centers to input coordinates.
    // (Matches common image resampling conventions.)
    const center = (o + 0.5) / Math.max(1e-6, scale) - 0.5;

    let i0 = Math.ceil(center - radius);
    let i1 = Math.floor(center + radius);

    if (i0 < 0) i0 = 0;
    if (i1 > inN - 1) i1 = inN - 1;

    const len = Math.max(0, i1 - i0 + 1);
    const w = new Float32Array(len);

    let sum = 0;
    for (let i = 0; i < len; i++) {
      const idx = i0 + i;
      const x = (center - idx) * kernelScale;
      const wi = lanczos(x, a) * kernelScale;
      w[i] = wi;
      sum += wi;
    }

    // Normalize so constants stay constant.
    if (sum > 1e-12) {
      const inv = 1 / sum;
      for (let i = 0; i < w.length; i++) {
        w[i] *= inv;
      }
    } else if (w.length > 0) {
      // Degenerate case: fall back to nearest.
      w.fill(0);
      const nearest = Math.max(0, Math.min(w.length - 1, Math.round(center) - i0));
      w[nearest] = 1;
    }

    contrib[o] = { idx0: i0, idx1: i1, w };
  }

  return contrib;
}

export function resample2dLanczos3(
  src: ArrayLike<number>,
  srcRows: number,
  srcCols: number,
  dstRows: number,
  dstCols: number
): Float32Array {
  const outRows = Math.max(0, Math.floor(dstRows));
  const outCols = Math.max(0, Math.floor(dstCols));

  if (outRows === 0 || outCols === 0) {
    return new Float32Array(0);
  }

  const inRows = Math.max(0, Math.floor(srcRows));
  const inCols = Math.max(0, Math.floor(srcCols));

  if (inRows === 0 || inCols === 0) {
    return new Float32Array(outRows * outCols);
  }

  // Fast path: no resampling.
  if (inRows === outRows && inCols === outCols) {
    const out = new Float32Array(outRows * outCols);
    for (let i = 0; i < out.length; i++) {
      out[i] = Number(src[i] ?? 0);
    }
    return out;
  }

  const A = 3;

  const xContrib = buildLanczosContrib(inCols, outCols, A);
  const yContrib = buildLanczosContrib(inRows, outRows, A);

  // Horizontal pass: src (inRows x inCols) -> tmp (inRows x outCols)
  const tmp = new Float32Array(inRows * outCols);

  for (let r = 0; r < inRows; r++) {
    const srcRowBase = r * inCols;
    const tmpRowBase = r * outCols;

    for (let oc = 0; oc < outCols; oc++) {
      const c = xContrib[oc];
      if (!c) continue;

      let sum = 0;
      for (let i = 0; i < c.w.length; i++) {
        sum += Number(src[srcRowBase + c.idx0 + i] ?? 0) * c.w[i];
      }
      tmp[tmpRowBase + oc] = sum;
    }
  }

  // Vertical pass: tmp (inRows x outCols) -> out (outRows x outCols)
  const out = new Float32Array(outRows * outCols);

  for (let or = 0; or < outRows; or++) {
    const c = yContrib[or];
    if (!c) continue;

    const outRowBase = or * outCols;

    for (let oc = 0; oc < outCols; oc++) {
      let sum = 0;
      for (let i = 0; i < c.w.length; i++) {
        const rr = c.idx0 + i;
        sum += tmp[rr * outCols + oc] * c.w[i];
      }
      out[outRowBase + oc] = sum;
    }
  }

  return out;
}
