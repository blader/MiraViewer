import { describe, expect, test } from 'vitest';
import {
  composeResidualWithWarpAtSize,
  correctedWarpAtSize,
  expandExclusionRect,
  mapFixedExclusionToMovingBounds,
} from '../src/utils/alignmentTransform';
import { warpGrayscaleAffine } from '../src/utils/warpAffine';
import {
  affineAboutOriginToStandard,
  composeStandardAffine2D,
  standardToAffineAboutOrigin,
} from '../src/utils/affine2d';
import { computeAlignedSettings } from '../src/utils/alignment';
import { affineAboutCenterToPanelGeometry, panelGeometryToAffineAboutCenter } from '../src/utils/panelTransform';

describe('correctedWarpAtSize', () => {
  test('adds phase correction in output coordinates and scales only from source grids', () => {
    const A = { m00: 0, m01: -1, m10: 1, m11: 0 };

    const transform = correctedWarpAtSize(
      {
        A,
        translatePx: { x: 10, y: -4 },
        gridSize: 256,
      },
      {
        correctionX: 3,
        correctionY: -2,
        sampleGridSize: 128,
        fftSize: 1024,
      },
      512,
    );

    expect(transform.A).toEqual(A);
    expect(transform.translateX).toBe(32);
    expect(transform.translateY).toBe(-16);
  });

  test('composes a residual affine after the winning centered warp in moving-to-fixed order', () => {
    const total = composeResidualWithWarpAtSize(
      {
        A: { m00: 1, m01: 0.1, m10: 0, m11: 1 },
        b: { x: 2, y: -3 },
      },
      {
        A: { m00: 0, m01: -1, m10: 1, m11: 0 },
        translateX: 4,
        translateY: -2,
      },
      32,
    );

    const point = { x: 7, y: 11 };
    const center = 15.5;
    const afterWinning = {
      x: -(point.y - center) + center + 4,
      y: point.x - center + center - 2,
    };
    const expected = {
      x: afterWinning.x + 0.1 * afterWinning.y + 2,
      y: afterWinning.y - 3,
    };

    expect(total.A.m00 * point.x + total.A.m01 * point.y + total.b.x).toBeCloseTo(expected.x, 10);
    expect(total.A.m10 * point.x + total.A.m11 * point.y + total.b.y).toBeCloseTo(expected.y, 10);
  });

  test('applies a non-identity rigid seed plus phase translation in one image interpolation', () => {
    const size = 5;
    const input = new Float32Array(size * size);
    input[2 * size + 1] = 1;
    const transform = correctedWarpAtSize(
      {
        A: { m00: 0, m01: -1, m10: 1, m11: 0 },
        translatePx: { x: 1, y: 0 },
        gridSize: size,
      },
      {
        correctionX: 0,
        correctionY: 1,
        sampleGridSize: size,
        fftSize: 64,
      },
      size,
    );

    const output = warpGrayscaleAffine(input, size, transform);

    expect(output[2 * size + 3]).toBeCloseTo(1, 6);
    expect(Array.from(output).reduce((sum, value) => sum + value, 0)).toBeCloseTo(1, 6);
  });

  test('round-trips the composed target transform through final panel geometry', () => {
    const size = 32;
    const total = composeResidualWithWarpAtSize(
      {
        A: { m00: 1.03, m01: 0.04, m10: -0.02, m11: 0.98 },
        b: { x: 2, y: -1 },
      },
      {
        A: { m00: 0.98, m01: -0.2, m10: 0.2, m11: 0.98 },
        translateX: 3,
        translateY: -2,
      },
      size,
    );
    const origin = { x: (size - 1) / 2, y: (size - 1) / 2 };
    const aboutCenter = standardToAffineAboutOrigin(total.A, total.b, origin);
    const geometry = affineAboutCenterToPanelGeometry({ A: aboutCenter.A, translatePx: aboutCenter.t }, size);
    const roundTripped = affineAboutOriginToStandard(panelGeometryToAffineAboutCenter(geometry, size));

    expect(roundTripped.A.m00).toBeCloseTo(total.A.m00, 10);
    expect(roundTripped.A.m01).toBeCloseTo(total.A.m01, 10);
    expect(roundTripped.A.m10).toBeCloseTo(total.A.m10, 10);
    expect(roundTripped.A.m11).toBeCloseTo(total.A.m11, 10);
    expect(roundTripped.b.x).toBeCloseTo(total.b.x, 10);
    expect(roundTripped.b.y).toBeCloseTo(total.b.y, 10);
  });

  test('final panel settings reproduce the sequential Elastix and reference-display warp', () => {
    const size = 33;
    const origin = { x: (size - 1) / 2, y: (size - 1) / 2 };
    const target = new Float32Array(size * size);
    for (let y = 11; y <= 21; y++) {
      for (let x = 12; x <= 20; x++) {
        target[y * size + x] = (((x * 7 + y * 11) % 17) + 1) / 18;
      }
    }

    const winningWarp = correctedWarpAtSize(
      {
        A: { m00: 0, m01: -1, m10: 1, m11: 0 },
        translatePx: { x: 1, y: -1 },
        gridSize: size,
      },
      {
        correctionX: 1,
        correctionY: 2,
        sampleGridSize: size,
        fftSize: 128,
      },
      size,
    );
    const residualAboutCenter = {
      A: { m00: 1, m01: 1, m10: 0, m11: 1 },
      origin,
      t: { x: 1, y: -1 },
    };
    const residualMovingToFixed = affineAboutOriginToStandard(residualAboutCenter);
    const referenceGeometry = {
      zoom: 1,
      rotation: 90,
      panX: 1 / size,
      panY: -1 / size,
      affine00: 1,
      affine01: 0,
      affine10: 0,
      affine11: 1,
    };

    // This is the image sequence visible inside the registration pipeline: winning rigid+phase,
    // residual Elastix affine, then the already-displayed reference geometry.
    const prewarped = warpGrayscaleAffine(target, size, winningWarp);
    const elastixResampled = warpGrayscaleAffine(prewarped, size, {
      A: residualAboutCenter.A,
      translateX: residualAboutCenter.t.x,
      translateY: residualAboutCenter.t.y,
    });
    const referenceDisplay = panelGeometryToAffineAboutCenter(referenceGeometry, size);
    const expectedDisplayed = warpGrayscaleAffine(elastixResampled, size, {
      A: referenceDisplay.A,
      translateX: referenceDisplay.t.x,
      translateY: referenceDisplay.t.y,
    });

    const targetToReference = composeResidualWithWarpAtSize(residualMovingToFixed, winningWarp, size);
    const referenceToDisplayed = affineAboutOriginToStandard(referenceDisplay);
    const targetToDisplayed = composeStandardAffine2D(referenceToDisplayed, targetToReference);
    const targetToDisplayedAboutCenter = standardToAffineAboutOrigin(targetToDisplayed.A, targetToDisplayed.b, origin);
    const computedGeometry = affineAboutCenterToPanelGeometry(
      { A: targetToDisplayedAboutCenter.A, translatePx: targetToDisplayedAboutCenter.t },
      size,
    );
    const neutralStats = { mean: 0.4, stddev: 0.2, min: 0, max: 1, p10: 0.1, p50: 0.4, p90: 0.8 };
    const settings = computeAlignedSettings(neutralStats, neutralStats, 4, 9, 0.5, computedGeometry);
    const viewerTransform = panelGeometryToAffineAboutCenter(settings, size);
    const viewerRendered = warpGrayscaleAffine(target, size, {
      A: viewerTransform.A,
      translateX: viewerTransform.t.x,
      translateY: viewerTransform.t.y,
    });

    let maxAbsoluteDifference = 0;
    for (let index = 0; index < viewerRendered.length; index++) {
      maxAbsoluteDifference = Math.max(
        maxAbsoluteDifference,
        Math.abs((viewerRendered[index] ?? 0) - (expectedDisplayed[index] ?? 0)),
      );
    }
    expect(maxAbsoluteDifference).toBeLessThan(1e-5);
  });

  test('inverse-maps and dilates the fixed exclusion for source-space normalization', () => {
    const mapped = mapFixedExclusionToMovingBounds(
      { x: 0.5, y: 0.25, width: 0.2, height: 0.25 },
      {
        A: { m00: 1, m01: 0, m10: 0, m11: 1 },
        translateX: 10,
        translateY: -5,
      },
      100,
      2,
    );

    expect(mapped.x).toBeCloseTo(0.38, 6);
    expect(mapped.y).toBeCloseTo(0.28, 6);
    expect(mapped.width).toBeCloseTo(0.24, 6);
    expect(mapped.height).toBeCloseTo(0.29, 6);

    const expanded = expandExclusionRect({ x: 0.1, y: 0.1, width: 0.2, height: 0.2 }, 0.15);
    expect(expanded.x).toBe(0);
    expect(expanded.y).toBe(0);
    expect(expanded.width).toBeCloseTo(0.45, 10);
    expect(expanded.height).toBeCloseTo(0.45, 10);
  });

  test('dilates the exclusion in fixed space before inverse-mapping a rotated seed', () => {
    const angle = Math.PI / 4;
    const cos = Math.cos(angle);
    const sin = Math.sin(angle);

    const mapped = mapFixedExclusionToMovingBounds(
      { x: 0.45, y: 0.45, width: 0.1, height: 0.1 },
      {
        A: { m00: cos, m01: -sin, m10: sin, m11: cos },
        translateX: 0,
        translateY: 0,
      },
      100,
      10,
    );

    // A 10 px square expanded by 10 px per side in fixed space becomes a 30 px
    // square. Its inverse-rotated axis-aligned bounds span 30 * sqrt(2), not the
    // smaller 10 * sqrt(2) + 2 * 10 produced by padding in moving axes.
    expect(mapped.width).toBeCloseTo((30 * Math.SQRT2) / 100, 6);
    expect(mapped.height).toBeCloseTo((30 * Math.SQRT2) / 100, 6);
  });
});
