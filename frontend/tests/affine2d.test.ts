import { describe, expect, test } from 'vitest';
import {
  composeSimilarityAndResidual,
  decomposeAffineToSimilarityAndResidual,
  type Mat2,
} from '../src/utils/affine2d';
import {
  affineAboutCenterToPanelGeometry,
  panelGeometryToAffineAboutCenter,
  type PanelGeometry,
} from '../src/utils/panelTransform';

function expectMat2Close(actual: Mat2, expected: Mat2, eps = 1e-10) {
  expect(actual.m00).toBeCloseTo(expected.m00, Math.max(0, Math.ceil(-Math.log10(eps))));
  expect(actual.m01).toBeCloseTo(expected.m01, Math.max(0, Math.ceil(-Math.log10(eps))));
  expect(actual.m10).toBeCloseTo(expected.m10, Math.max(0, Math.ceil(-Math.log10(eps))));
  expect(actual.m11).toBeCloseTo(expected.m11, Math.max(0, Math.ceil(-Math.log10(eps))));
}

describe('affine2d', () => {
  test('decompose -> compose round-trips an arbitrary affine matrix', () => {
    const A: Mat2 = { m00: 1.2, m01: 0.3, m10: -0.1, m11: 0.9 };

    const { rotationDeg, zoom, residual } = decomposeAffineToSimilarityAndResidual(A);
    const recomposed = composeSimilarityAndResidual(rotationDeg, zoom, residual);

    expectMat2Close(recomposed, A, 1e-8);
  });
});

describe('panelTransform', () => {
  test('panel geometry -> affine -> geometry preserves the *full* transform', () => {
    // Shear with det=1.
    const residual: Mat2 = { m00: 1, m01: 0.2, m10: 0, m11: 1 };

    const geom: PanelGeometry = {
      zoom: 1.75,
      rotation: 30,
      panX: 0.1,
      panY: -0.2,
      affine00: residual.m00,
      affine01: residual.m01,
      affine10: residual.m10,
      affine11: residual.m11,
    };

    const size = 256;

    const affine = panelGeometryToAffineAboutCenter(geom, size);
    const roundTripped = affineAboutCenterToPanelGeometry({ A: affine.A, translatePx: affine.t }, size);

    // Rotation/zoom/residual are not unique for a general affine matrix.
    // We assert invariants: the round-tripped geometry produces the same full matrix + translation.
    const affine2 = panelGeometryToAffineAboutCenter(roundTripped, size);

    expectMat2Close(affine2.A, affine.A, 1e-8);
    expect(affine2.t.x).toBeCloseTo(affine.t.x, 6);
    expect(affine2.t.y).toBeCloseTo(affine.t.y, 6);
  });
});
