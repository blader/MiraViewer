import type { NormalizedPoint, TumorPolygon, TumorThreshold } from '../../../db/schema';
import type { SegmentTumorOptions } from '../segmentTumor';

export type TumorHarnessImageV1 = {
  // Evaluated image size (may be downsampled).
  w: number;
  h: number;

  // Original DICOM pixel dimensions (for reference/debug).
  sourceW: number;
  sourceH: number;

  // Base64 of raw grayscale bytes (Uint8Array, length = w*h).
  grayB64: string;
};

export type TumorHarnessCaseV1 = {
  id: string;

  comboId: string;
  dateIso: string;
  studyId: string;
  seriesUid: string;
  sopInstanceUid: string;

  image: TumorHarnessImageV1;

  // Ground truth polygon in *image* normalized coordinates (0..1).
  gtPolygonImage01: TumorPolygon;

  // Optional paint points (image coords). If omitted, the harness can synthesize paint from GT.
  paintPointsImage01?: NormalizedPoint[];
};

export type TumorHarnessPropagationFrameV1 = {
  // Index in the series' effective ordering (0..N-1).
  effectiveIndex: number;
  sopInstanceUid: string;

  image: TumorHarnessImageV1;

  // Present only for frames where GT exists.
  gtPolygonImage01?: TumorPolygon;
};

export type TumorHarnessPropagationScenarioV1 = {
  id: string;

  comboId: string;
  dateIso: string;
  studyId: string;
  seriesUid: string;

  // Ordered frames for a slice range.
  frames: TumorHarnessPropagationFrameV1[];

  start: {
    effectiveIndex: number;
    sopInstanceUid: string;

    // Starting paint gesture in image coords (used to compute initial threshold + seed).
    paintPointsImage01: NormalizedPoint[];

    // If provided, this is the threshold the user used at the start slice.
    // If omitted, the harness can initialize via estimateThresholdFromSeedPoints.
    threshold?: TumorThreshold;

    // Optional overrides for the initial segmentation/seed computation.
    // Propagation may still use defaults unless explicitly threaded through.
    initialOpts?: SegmentTumorOptions;
  };

  // Propagation stopping rules (defaults should mirror the UI).
  stop?: {
    minAreaPx: number;
    maxMissesInARow: number;
  };

  note?: string;
};

export type TumorHarnessDatasetV1 = {
  version: 1;
  generatedAtIso: string;

  settings: {
    // Max dimension used during export downsampling (preserves aspect ratio).
    maxEvalDim: number;
  };

  // Single-slice cases (GT rows).
  cases: TumorHarnessCaseV1[];

  // Optional propagation scenarios.
  propagationScenarios?: TumorHarnessPropagationScenarioV1[];

  note?: string;
};
