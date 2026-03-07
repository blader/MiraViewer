import type { NormalizedPoint } from '../db/schema';
import type { ViewportSize } from './viewTransform';

export type ImageSizePx = { w: number; h: number };

function clamp01(v: number) {
  return Math.max(0, Math.min(1, v));
}

/**
 * Mirror the viewer's "contain" behavior: scale to fit while preserving aspect ratio.
 * Returns the image rect in viewport pixel coordinates.
 */
export function containRectPx(view: ViewportSize, img: ImageSizePx): { dx: number; dy: number; dw: number; dh: number } {
  const vw = Math.max(1, view.w);
  const vh = Math.max(1, view.h);
  const iw = Math.max(1, img.w);
  const ih = Math.max(1, img.h);

  const scale = Math.min(vw / iw, vh / ih);
  const dw = iw * scale;
  const dh = ih * scale;
  const dx = (vw - dw) / 2;
  const dy = (vh - dh) / 2;

  return { dx, dy, dw, dh };
}

export function viewerNormToImageNorm(p: NormalizedPoint, view: ViewportSize, img: ImageSizePx): NormalizedPoint {
  const { dx, dy, dw, dh } = containRectPx(view, img);

  const xPx = clamp01(p.x) * Math.max(1, view.w);
  const yPx = clamp01(p.y) * Math.max(1, view.h);

  const xi = dw > 1e-6 ? (xPx - dx) / dw : 0;
  const yi = dh > 1e-6 ? (yPx - dy) / dh : 0;

  return { x: clamp01(xi), y: clamp01(yi) };
}

export function imageNormToViewerNorm(p: NormalizedPoint, view: ViewportSize, img: ImageSizePx): NormalizedPoint {
  const { dx, dy, dw, dh } = containRectPx(view, img);

  const xPx = dx + clamp01(p.x) * dw;
  const yPx = dy + clamp01(p.y) * dh;

  const xv = xPx / Math.max(1, view.w);
  const yv = yPx / Math.max(1, view.h);

  return { x: clamp01(xv), y: clamp01(yv) };
}
