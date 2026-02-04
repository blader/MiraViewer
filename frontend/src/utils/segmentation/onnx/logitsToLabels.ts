export type LogitsTensorLike = {
  data: Float32Array;
  /** Expected to be [1,C,Z,Y,X] or [C,Z,Y,X]. */
  dims: readonly number[];
};

export type LogitsToLabelsResult = {
  /** Flattened label volume in Z,Y,X order (x fastest). */
  labels: Uint8Array;
  /** Spatial dims in [x,y,z] order for convenience. */
  spatialDims: [number, number, number];
};

function assertFiniteInt(v: number, name: string): number {
  if (!Number.isFinite(v)) {
    throw new Error(`logitsToLabels: ${name} must be finite`);
  }
  const vi = Math.floor(v);
  if (vi !== v) {
    throw new Error(`logitsToLabels: ${name} must be an integer`);
  }
  return vi;
}

export function logitsToLabels(params: {
  logits: LogitsTensorLike;
  /** Maps class index -> uint8 label id (0..255). */
  labelMap: readonly number[];
}): LogitsToLabelsResult {
  const { logits, labelMap } = params;

  const dims = logits.dims;
  const data = logits.data;

  let c = 0;
  let z = 0;
  let y = 0;
  let x = 0;

  if (dims.length === 5) {
    const n = assertFiniteInt(dims[0] ?? 0, 'N');
    if (n !== 1) {
      throw new Error(`logitsToLabels: only N=1 is supported (got ${n})`);
    }
    c = assertFiniteInt(dims[1] ?? 0, 'C');
    z = assertFiniteInt(dims[2] ?? 0, 'Z');
    y = assertFiniteInt(dims[3] ?? 0, 'Y');
    x = assertFiniteInt(dims[4] ?? 0, 'X');
  } else if (dims.length === 4) {
    c = assertFiniteInt(dims[0] ?? 0, 'C');
    z = assertFiniteInt(dims[1] ?? 0, 'Z');
    y = assertFiniteInt(dims[2] ?? 0, 'Y');
    x = assertFiniteInt(dims[3] ?? 0, 'X');
  } else {
    throw new Error(`logitsToLabels: unsupported logits dims length ${dims.length}`);
  }

  if (!(c > 0 && x > 0 && y > 0 && z > 0)) {
    throw new Error(`logitsToLabels: invalid dims C=${c} Z=${z} Y=${y} X=${x}`);
  }

  const spatial = x * y * z;
  if (data.length !== c * spatial) {
    throw new Error(`logitsToLabels: data length mismatch (expected ${c * spatial}, got ${data.length})`);
  }

  const out = new Uint8Array(spatial);

  for (let p = 0; p < spatial; p++) {
    let bestC = 0;
    let best = -Infinity;

    for (let ci = 0; ci < c; ci++) {
      const v = data[ci * spatial + p] ?? -Infinity;
      if (v > best) {
        best = v;
        bestC = ci;
      }
    }

    const labelId = labelMap[bestC] ?? 0;
    out[p] = (labelId & 0xff) >>> 0;
  }

  return { labels: out, spatialDims: [x, y, z] };
}
