import { lazy } from 'react';

export const GroundTruthPolygonOverlay = lazy(async () => {
  const module = await import('../GroundTruthPolygonOverlay');
  return { default: module.GroundTruthPolygonOverlay };
});

export const TumorSavedSegmentationOverlay = lazy(async () => {
  const module = await import('../TumorSavedSegmentationOverlay');
  return { default: module.TumorSavedSegmentationOverlay };
});

export const TumorSegmentationOverlay = lazy(async () => {
  const module = await import('../TumorSegmentationOverlaySeedGrow');
  return { default: module.TumorSegmentationOverlay };
});
