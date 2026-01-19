export type Mat2 = {
  // Row-major 2x2 matrix:
  // [ m00 m01 ]
  // [ m10 m11 ]
  m00: number;
  m01: number;
  m10: number;
  m11: number;
};

export type Vec2 = { x: number; y: number };

export const IDENTITY_MAT2: Mat2 = { m00: 1, m01: 0, m10: 0, m11: 1 };

export function det2(m: Mat2): number {
  return m.m00 * m.m11 - m.m01 * m.m10;
}

export function mul2(a: Mat2, b: Mat2): Mat2 {
  return {
    m00: a.m00 * b.m00 + a.m01 * b.m10,
    m01: a.m00 * b.m01 + a.m01 * b.m11,
    m10: a.m10 * b.m00 + a.m11 * b.m10,
    m11: a.m10 * b.m01 + a.m11 * b.m11,
  };
}

export function mul2Vec(m: Mat2, v: Vec2): Vec2 {
  return {
    x: m.m00 * v.x + m.m01 * v.y,
    y: m.m10 * v.x + m.m11 * v.y,
  };
}

export function transpose2(m: Mat2): Mat2 {
  return {
    m00: m.m00,
    m01: m.m10,
    m10: m.m01,
    m11: m.m11,
  };
}

export function invert2(m: Mat2): Mat2 {
  const d = det2(m);
  if (!Number.isFinite(d) || Math.abs(d) < 1e-12) {
    throw new Error('invert2: matrix is singular');
  }

  const invDet = 1 / d;
  return {
    m00: m.m11 * invDet,
    m01: -m.m01 * invDet,
    m10: -m.m10 * invDet,
    m11: m.m00 * invDet,
  };
}

/**
 * Standard affine representation: y = A * x + b
 */
export type StandardAffine2D = {
  A: Mat2;
  b: Vec2;
};

/**
 * Viewer-style affine representation about an origin O:
 *   y = A * (x - O) + O + t
 *
 * Note: t is applied in output/display space after the linear part.
 */
export type AffineAboutOrigin2D = {
  A: Mat2;
  t: Vec2;
  origin: Vec2;
};

export function affineAboutOriginToStandard(t: AffineAboutOrigin2D): StandardAffine2D {
  // y = A*(x-O) + O + t
  //   = A*x + (O + t - A*O)
  const AO = mul2Vec(t.A, t.origin);
  return {
    A: t.A,
    b: { x: t.origin.x + t.t.x - AO.x, y: t.origin.y + t.t.y - AO.y },
  };
}

export function standardToAffineAboutOrigin(A: Mat2, b: Vec2, origin: Vec2): AffineAboutOrigin2D {
  // y = A*x + b
  // y = A*(x-O) + O + t  => b = O + t - A*O
  // t = b - O + A*O
  const AO = mul2Vec(A, origin);
  return {
    A,
    origin,
    t: { x: b.x - origin.x + AO.x, y: b.y - origin.y + AO.y },
  };
}

export function composeStandardAffine2D(outer: StandardAffine2D, inner: StandardAffine2D): StandardAffine2D {
  // outer(inner(x)) = A2*(A1*x + b1) + b2 = (A2*A1)x + (A2*b1 + b2)
  const A = mul2(outer.A, inner.A);
  const Ab1 = mul2Vec(outer.A, inner.b);
  return {
    A,
    b: { x: Ab1.x + outer.b.x, y: Ab1.y + outer.b.y },
  };
}

export function invertStandardAffine2D(t: StandardAffine2D): StandardAffine2D {
  const AInv = invert2(t.A);
  const bInv = mul2Vec(AInv, { x: -t.b.x, y: -t.b.y });
  return { A: AInv, b: bInv };
}

export function rotationScaleToMat2(rotationDeg: number, zoom: number): Mat2 {
  const theta = (rotationDeg * Math.PI) / 180;
  const c = Math.cos(theta);
  const s = Math.sin(theta);

  // Similarity: zoom * R
  return {
    m00: zoom * c,
    m01: -zoom * s,
    m10: zoom * s,
    m11: zoom * c,
  };
}

export type SimilarityAndResidual = {
  rotationDeg: number;
  zoom: number;
  residual: Mat2;
};

/**
 * Decompose an affine linear transform A into:
 *   A ≈ (zoom * R) * residual
 * where R is a rotation, zoom is an isotropic scale, and residual contains shear/anisotropy.
 *
 * The residual is constructed to have det(residual) ≈ 1 (area-preserving), using zoom = sqrt(|det(A)|).
 */
export function decomposeAffineToSimilarityAndResidual(A: Mat2): SimilarityAndResidual {
  // Closest rotation (orthogonal Procrustes) for 2D:
  // theta = atan2(m10 - m01, m00 + m11)
  const theta = Math.atan2(A.m10 - A.m01, A.m00 + A.m11);
  const rotationDeg = (theta * 180) / Math.PI;

  const detA = det2(A);
  const zoom = Math.sqrt(Math.abs(detA));
  if (!Number.isFinite(zoom) || zoom < 1e-12) {
    // Degenerate; fall back to identity similarity.
    return { rotationDeg: 0, zoom: 1, residual: A };
  }

  const c = Math.cos(theta);
  const s = Math.sin(theta);
  const RT: Mat2 = {
    m00: c,
    m01: s,
    m10: -s,
    m11: c,
  };

  // residual = (1/zoom) * R^T * A
  const RTA = mul2(RT, A);
  const invZoom = 1 / zoom;
  const residual: Mat2 = {
    m00: RTA.m00 * invZoom,
    m01: RTA.m01 * invZoom,
    m10: RTA.m10 * invZoom,
    m11: RTA.m11 * invZoom,
  };

  return { rotationDeg, zoom, residual };
}

export function composeSimilarityAndResidual(rotationDeg: number, zoom: number, residual: Mat2): Mat2 {
  const S = rotationScaleToMat2(rotationDeg, zoom);
  return mul2(S, residual);
}

/**
 * CSS matrix() uses column-major for the 2x2 part: matrix(a, b, c, d, e, f)
 * corresponds to:
 *   [ a c e ]
 *   [ b d f ]
 *   [ 0 0 1 ]
 */
export function toCssMatrixArgs(m: Mat2): { a: number; b: number; c: number; d: number } {
  return { a: m.m00, b: m.m10, c: m.m01, d: m.m11 };
}
