import { lazy } from 'react';

export const GroundTruthPolygonOverlay = lazy(() =>
  import('../GroundTruthPolygonOverlay').then((module) => ({ default: module.GroundTruthPolygonOverlay })),
);

export const TumorSavedSegmentationOverlay = lazy(() =>
  import('../TumorSavedSegmentationOverlay').then((module) => ({ default: module.TumorSavedSegmentationOverlay })),
);
