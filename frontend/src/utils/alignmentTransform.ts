import {
  affineAboutOriginToStandard,
  composeStandardAffine2D,
  invert2,
  type Mat2,
  type StandardAffine2D,
  type Vec2,
} from './affine2d';
import type { ExclusionMask } from '../types/api';

export type GridSeedTransform = {
  A: Mat2;
  translatePx: Vec2;
  gridSize: number;
};

export type GridPhaseCorrection = {
  correctionX: number;
  correctionY: number;
  sampleGridSize: number;
  fftSize: number;
};

export type WarpTransform = {
  A: Mat2;
  translateX: number;
  translateY: number;
};

export function correctedWarpAtSize(
  seed: GridSeedTransform,
  phase: GridPhaseCorrection,
  outputSize: number
): WarpTransform {
  if (seed.gridSize <= 0 || phase.sampleGridSize <= 0 || outputSize <= 0) {
    throw new Error('correctedWarpAtSize: grid sizes must be positive');
  }
  const seedScale = outputSize / seed.gridSize;
  const phaseScale = outputSize / phase.sampleGridSize;
  return {
    A: seed.A,
    translateX: seed.translatePx.x * seedScale + phase.correctionX * phaseScale,
    translateY: seed.translatePx.y * seedScale + phase.correctionY * phaseScale,
  };
}

/** Compose a residual moving-to-fixed affine after a centered winning warp. */
export function composeResidualWithWarpAtSize(
  residualMovingToFixed: StandardAffine2D,
  winningWarp: WarpTransform,
  size: number
): StandardAffine2D {
  if (size <= 0) throw new Error('composeResidualWithWarpAtSize: size must be positive');
  const center = (size - 1) / 2;
  const winningStandard = affineAboutOriginToStandard({
    A: winningWarp.A,
    origin: { x: center, y: center },
    t: { x: winningWarp.translateX, y: winningWarp.translateY },
  });
  return composeStandardAffine2D(residualMovingToFixed, winningStandard);
}

export function expandExclusionRect(rect: ExclusionMask, paddingNormalized: number): ExclusionMask {
  const padding = Math.max(0, paddingNormalized);
  const x0 = Math.max(0, rect.x - padding);
  const y0 = Math.max(0, rect.y - padding);
  const x1 = Math.min(1, rect.x + rect.width + padding);
  const y1 = Math.min(1, rect.y + rect.height + padding);
  return { x: x0, y: y0, width: Math.max(0, x1 - x0), height: Math.max(0, y1 - y0) };
}

/**
 * Map a fixed/reference-space exclusion back into the unwarped moving source grid.
 * `paddingPx` is measured in fixed/reference pixels and is applied before the inverse
 * transform so rotations cannot under-cover the padded region in source space.
 */
export function mapFixedExclusionToMovingBounds(
  fixedRect: ExclusionMask,
  movingToFixed: WarpTransform,
  size: number,
  paddingPx = 0
): ExclusionMask {
  if (size <= 0) throw new Error('mapFixedExclusionToMovingBounds: size must be positive');
  const inverseA = invert2(movingToFixed.A);
  const center = (size - 1) / 2;
  const paddedFixedRect = expandExclusionRect(fixedRect, Math.max(0, paddingPx) / size);
  const fixedX0 = paddedFixedRect.x * size;
  const fixedY0 = paddedFixedRect.y * size;
  const fixedX1 = (paddedFixedRect.x + paddedFixedRect.width) * size;
  const fixedY1 = (paddedFixedRect.y + paddedFixedRect.height) * size;
  const corners = [
    [fixedX0, fixedY0],
    [fixedX1, fixedY0],
    [fixedX0, fixedY1],
    [fixedX1, fixedY1],
  ] as const;
  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  for (const [fixedX, fixedY] of corners) {
    const relativeX = fixedX - center - movingToFixed.translateX;
    const relativeY = fixedY - center - movingToFixed.translateY;
    const movingX = inverseA.m00 * relativeX + inverseA.m01 * relativeY + center;
    const movingY = inverseA.m10 * relativeX + inverseA.m11 * relativeY + center;
    minX = Math.min(minX, movingX);
    minY = Math.min(minY, movingY);
    maxX = Math.max(maxX, movingX);
    maxY = Math.max(maxY, movingY);
  }
  const x0 = Math.max(0, Math.min(size, minX));
  const y0 = Math.max(0, Math.min(size, minY));
  const x1 = Math.max(0, Math.min(size, maxX));
  const y1 = Math.max(0, Math.min(size, maxY));
  return { x: x0 / size, y: y0 / size, width: (x1 - x0) / size, height: (y1 - y0) / size };
}
