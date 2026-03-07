import type { NormalizedPoint, TumorPolygon, ViewerTransform } from '../db/schema';

export type ViewportSize = { w: number; h: number };

export function normalizeViewerTransform(t?: ViewerTransform | null): ViewerTransform {
  return {
    zoom: Number.isFinite(t?.zoom) ? t!.zoom : 1,
    rotation: Number.isFinite(t?.rotation) ? t!.rotation : 0,
    panX: Number.isFinite(t?.panX) ? t!.panX : 0,
    panY: Number.isFinite(t?.panY) ? t!.panY : 0,
    affine00: Number.isFinite(t?.affine00) ? t!.affine00 : 1,
    affine01: Number.isFinite(t?.affine01) ? t!.affine01 : 0,
    affine10: Number.isFinite(t?.affine10) ? t!.affine10 : 0,
    affine11: Number.isFinite(t?.affine11) ? t!.affine11 : 1,
  };
}

function computeLinearMatrix(t: ViewerTransform): { m00: number; m01: number; m10: number; m11: number } {
  const vt = normalizeViewerTransform(t);

  const theta = (vt.rotation * Math.PI) / 180;
  const cos = Math.cos(theta);
  const sin = Math.sin(theta);

  // CSS/canvas rotation in screen coords (y-down) is clockwise for +theta.
  // Using the standard matrix with y-down matches CSS rotate() and ctx.rotate().
  const r00 = cos;
  const r01 = -sin;
  const r10 = sin;
  const r11 = cos;

  // Affine residual A is row-major 2x2: [[a00,a01],[a10,a11]].
  const a00 = vt.affine00;
  const a01 = vt.affine01;
  const a10 = vt.affine10;
  const a11 = vt.affine11;

  // M = zoom * R * A
  const ra00 = r00 * a00 + r01 * a10;
  const ra01 = r00 * a01 + r01 * a11;
  const ra10 = r10 * a00 + r11 * a10;
  const ra11 = r10 * a01 + r11 * a11;

  const z = vt.zoom;
  return {
    m00: z * ra00,
    m01: z * ra01,
    m10: z * ra10,
    m11: z * ra11,
  };
}

function applyViewerTransformPx(
  p: { x: number; y: number },
  size: ViewportSize,
  t: ViewerTransform
): { x: number; y: number } {
  const { w, h } = size;

  const cx = w / 2;
  const cy = h / 2;

  const vt = normalizeViewerTransform(t);
  const panXPx = vt.panX * w;
  const panYPx = vt.panY * h;

  const { m00, m01, m10, m11 } = computeLinearMatrix(vt);

  const dx = p.x - cx;
  const dy = p.y - cy;

  return {
    x: cx + panXPx + (m00 * dx + m01 * dy),
    y: cy + panYPx + (m10 * dx + m11 * dy),
  };
}

function invertViewerTransformPx(
  p: { x: number; y: number },
  size: ViewportSize,
  t: ViewerTransform
): { x: number; y: number } {
  const { w, h } = size;

  const cx = w / 2;
  const cy = h / 2;

  const vt = normalizeViewerTransform(t);
  const panXPx = vt.panX * w;
  const panYPx = vt.panY * h;

  const { m00, m01, m10, m11 } = computeLinearMatrix(vt);
  const det = m00 * m11 - m01 * m10;

  // If the matrix is singular (shouldn't happen in normal use), fall back to identity.
  if (!Number.isFinite(det) || Math.abs(det) < 1e-10) {
    return { x: p.x, y: p.y };
  }

  const inv00 = m11 / det;
  const inv01 = -m01 / det;
  const inv10 = -m10 / det;
  const inv11 = m00 / det;

  const dx = p.x - cx - panXPx;
  const dy = p.y - cy - panYPx;

  return {
    x: cx + (inv00 * dx + inv01 * dy),
    y: cy + (inv10 * dx + inv11 * dy),
  };
}

export function remapPointBetweenViewerTransforms(
  p: NormalizedPoint,
  size: ViewportSize,
  from: ViewerTransform,
  to: ViewerTransform
): NormalizedPoint {
  if (size.w <= 0 || size.h <= 0) return p;

  const pPx = { x: p.x * size.w, y: p.y * size.h };
  const worldPx = invertViewerTransformPx(pPx, size, from);
  const outPx = applyViewerTransformPx(worldPx, size, to);
  return {
    x: outPx.x / size.w,
    y: outPx.y / size.h,
  };
}

export function remapPointsBetweenViewerTransforms(
  points: NormalizedPoint[],
  size: ViewportSize,
  from: ViewerTransform,
  to: ViewerTransform
): NormalizedPoint[] {
  return points.map((p) => remapPointBetweenViewerTransforms(p, size, from, to));
}

export function remapPolygonBetweenViewerTransforms(
  polygon: TumorPolygon,
  size: ViewportSize,
  from: ViewerTransform,
  to: ViewerTransform
): TumorPolygon {
  return {
    points: remapPointsBetweenViewerTransforms(polygon.points ?? [], size, from, to),
  };
}
