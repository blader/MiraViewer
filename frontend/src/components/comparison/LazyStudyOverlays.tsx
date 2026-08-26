import { lazy } from 'react';

export const GroundTruthPolygonOverlay = lazy(() =>
  import('../GroundTruthPolygonOverlay').then((module) => ({ default: module.GroundTruthPolygonOverlay })),
);

export const TumorSavedSegmentationOverlay = lazy(() =>
  import('../TumorSavedSegmentationOverlay').then((module) => ({ default: module.TumorSavedSegmentationOverlay })),
);

export const TumorSegmentationOverlay = lazy(() =>
  import('../TumorSegmentationOverlaySeedGrow').then((module) => ({ default: module.TumorSegmentationOverlay })),
);
