import type { NormalizedPoint, TumorPolygon, ViewerTransform } from '../../../db/schema';
import { normalizeViewerTransform, remapPointsBetweenViewerTransforms, remapPolygonBetweenViewerTransforms, type ViewportSize } from '../../viewTransform';
import { viewerNormToImageNorm, type ImageSizePx } from '../../viewportMapping';

function clamp01(v: number) {
  return Math.max(0, Math.min(1, v));
}

export function remapPointsToImage01(args: {
  points: NormalizedPoint[];
  viewportSize: ViewportSize;
  fromViewTransform?: ViewerTransform | null;
  imageSize: ImageSizePx;
}): NormalizedPoint[] {
  const { points, viewportSize, fromViewTransform, imageSize } = args;
  const from = normalizeViewerTransform(fromViewTransform ?? null);
  const to = normalizeViewerTransform(null);

  const pointsIdentity = remapPointsBetweenViewerTransforms(points, viewportSize, from, to);
  return pointsIdentity.map((p) => viewerNormToImageNorm({ x: clamp01(p.x), y: clamp01(p.y) }, viewportSize, imageSize));
}

export function remapPolygonToImage01(args: {
  polygon: TumorPolygon;
  viewportSize: ViewportSize;
  fromViewTransform?: ViewerTransform | null;
  imageSize: ImageSizePx;
}): TumorPolygon {
  const { polygon, viewportSize, fromViewTransform, imageSize } = args;
  const from = normalizeViewerTransform(fromViewTransform ?? null);
  const to = normalizeViewerTransform(null);

  const polyIdentity = remapPolygonBetweenViewerTransforms(polygon, viewportSize, from, to);
  return {
    points: polyIdentity.points.map((p) => viewerNormToImageNorm({ x: clamp01(p.x), y: clamp01(p.y) }, viewportSize, imageSize)),
  };
}
