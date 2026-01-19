import type { PanelSettings } from '../types/api';
import { CONTROL_LIMITS } from './constants';
import { clamp, normalizeRotation } from './math';
import type { AffineAboutOrigin2D } from './affine2d';
import { composeSimilarityAndResidual, decomposeAffineToSimilarityAndResidual } from './affine2d';

export type PanelGeometry = Pick<
  PanelSettings,
  'zoom' | 'rotation' | 'panX' | 'panY' | 'affine00' | 'affine01' | 'affine10' | 'affine11'
>;

export function panelGeometryToAffineAboutCenter(geometry: PanelGeometry, sizePx: number): AffineAboutOrigin2D {
  const origin = { x: (sizePx - 1) / 2, y: (sizePx - 1) / 2 };

  const residual = {
    m00: geometry.affine00,
    m01: geometry.affine01,
    m10: geometry.affine10,
    m11: geometry.affine11,
  };

  const A = composeSimilarityAndResidual(geometry.rotation, geometry.zoom, residual);

  return {
    A,
    origin,
    t: {
      x: geometry.panX * sizePx,
      y: geometry.panY * sizePx,
    },
  };
}

export function affineAboutCenterToPanelGeometry(t: { A: AffineAboutOrigin2D['A']; translatePx: { x: number; y: number } }, sizePx: number): PanelGeometry {
  const { rotationDeg, zoom, residual } = decomposeAffineToSimilarityAndResidual(t.A);

  return {
    zoom: clamp(zoom, CONTROL_LIMITS.ZOOM.MIN, CONTROL_LIMITS.ZOOM.MAX),
    rotation: normalizeRotation(rotationDeg),
    panX: clamp(t.translatePx.x / sizePx, -1, 1),
    panY: clamp(t.translatePx.y / sizePx, -1, 1),
    affine00: residual.m00,
    affine01: residual.m01,
    affine10: residual.m10,
    affine11: residual.m11,
  };
}
