import type { DerivedAlignmentFramePresentation } from '../db/schema';
import type { OutputPlaneGrid } from '../utils/outputPlaneGrid';

// ─────────────────────────────────────────────────────────────────────────────
// Comparison view types
// ─────────────────────────────────────────────────────────────────────────────

export interface SequenceCombo {
  id: string;
  plane: string | null;
  weight: string | null;
  sequence: string | null;
  label: string;
  date_count: number;
}

export interface SeriesRef {
  study_id: string;
  series_uid: string;
  instance_count: number;
  series_description?: string;
  series_number?: number;
  /** Stable identity of the patient that owns this series. */
  patient_key?: string;
  /** Explicit spatial frame; distinct longitudinal frames are not directly comparable. */
  frame_of_reference_uid?: string;
  /** The selected examination's canonical study UID. */
  study_uid?: string;
  acquisition_time?: string;
  rows?: number;
  columns?: number;
  pixel_spacing?: [number, number];
}

export interface ComparisonPatient {
  key: string;
  patient_id: string;
  patient_name: string;
  study_count: number;
}

export interface ComparisonExamination {
  study_uid: string;
  date_iso: string;
  acquisition_time?: string;
  patient_key: string;
}

export interface ComparisonData {
  planes: string[];
  dates: string[]; // ISO date strings
  sequences: SequenceCombo[];
  series_map: Record<string, Record<string, SeriesRef>>; // comboId -> dateISO -> ref
  /** All displayable acquisitions; series_map contains the persisted choice. */
  series_candidates?: Record<string, Record<string, SeriesRef[]>>;
  /** Authoritative patient choices returned by the local database. */
  patients?: ComparisonPatient[];
  selected_patient_key?: string | null;
  dataset_revision?: number;
  /** Saved-work ownership; rotates on restore/reset, not additive import. */
  dataset_token?: string;
  /** Examination identity keyed by the visible comparison-column key. */
  examinations?: Record<string, ComparisonExamination>;
}

/** User corrections relative to automatic alignment, not a replacement registration. */
export interface AlignmentAdjustment {
  /** Signed displacement in acquired target slices; independent of reverse display order. */
  sliceOffset: number;
  panX: number;
  panY: number;
  rotation: number;
  /** Multiplicative zoom relative to the automatic presentation. */
  zoom: number;
  brightness: number;
  contrast: number;
}

export type AlignmentDisplayBaseline = Pick<
  PanelSettings,
  'zoom' | 'rotation' | 'panX' | 'panY' | 'brightness' | 'contrast' | 'affine00' | 'affine01' | 'affine10' | 'affine11'
>;

// Persisted per-date viewer settings for a specific sequence combo.
export interface PanelSettings {
  offset: number;
  /** If true, treat slice index 0 as the last DICOM instance (reverse through-plane order). */
  reverseSliceOrder: boolean;
  zoom: number; // 1 = 100%
  rotation: number; // degrees, typically [-180, 180]
  brightness: number; // 0-200, 100 = normal
  contrast: number; // 0-200, 100 = normal
  panX: number; // normalized pan (-1..1), as fraction of viewport width
  panY: number; // normalized pan (-1..1), as fraction of viewport height

  /**
   * Hidden affine residual (shear / anisotropic scale) applied for display.
   *
   * This is a row-major 2x2 matrix, applied around the viewport center.
   * It is not currently user-adjustable via the UI.
   */
  affine00: number;
  affine01: number;
  affine10: number;
  affine11: number;

  progress: number; // normalized 0..1, last viewed global slice position for this date
  /** Durable manual intent, reapplied to each new automatic presentation. */
  alignmentAdjustment?: AlignmentAdjustment;
  /** Last uncorrected display, needed to restore clipped corrections or an acquired pause after reload. */
  alignmentBaseline?: AlignmentDisplayBaseline;
  /** Only an explicit acquired-image action opts a panel out of automatic alignment. */
  alignmentPaused?: boolean;
}

/**
 * Persisted settings may be partial (values may be missing or null).
 * Each property is optional and can be null to indicate "use default".
 */
export type PanelSettingsPartial = {
  [K in keyof PanelSettings]?: PanelSettings[K] | null;
};

// Histogram statistics for intensity matching.
export interface HistogramStats {
  mean: number;
  stddev: number;
  min: number;
  max: number;
  p10: number; // 10th percentile
  p50: number; // median
  p90: number; // 90th percentile
}

/**
 * Rectangular exclusion mask in normalized [0,1] image coordinates.
 * Used to exclude regions (e.g., tumors) from similarity computations during alignment.
 */
export interface ExclusionMask {
  /** Left edge, normalized [0,1]. */
  x: number;
  /** Top edge, normalized [0,1]. */
  y: number;
  /** Width, normalized [0,1]. */
  width: number;
  /** Height, normalized [0,1]. */
  height: number;
}

// Alignment reference for an auto-alignment run.
//
// We intentionally store *only* metadata + the reference panel settings.
// The alignment code renders the reference slice from DICOM directly, which avoids
// relying on a screenshot/capture of the viewer (and keeps alignment deterministic).
export interface AlignmentReference {
  // Source identification
  date: string; // ISO date of reference
  seriesUid: string;
  sliceIndex: number; // Instance index on reference date
  sliceCount: number; // Total slices in reference series
  patientKey?: string;
  sequenceId?: string;
  studyUid?: string;
  frameOfReferenceUid?: string;
  datasetRevision?: number;
  /** Actual viewer dimensions used to translate image-space results into panel pan. */
  viewportSize?: { width: number; height: number };
  /** Native image dimensions before contain/letterbox presentation. */
  imageSize?: { width: number; height: number };

  // Settings that should be used as the *base* view transform for aligned targets.
  // (Targets get a recovered delta transform composed on top of these settings.)
  settings: PanelSettings;

  /**
   * Optional rectangular region to exclude from similarity metrics (e.g., tumor area).
   * Pixels inside this rect are ignored when computing MI/NMI for slice search and registration.
   */
  exclusionMask?: ExclusionMask;

  /** Explicit opt-in: inspect the marked tissue only when choosing its through-plane location. */
  alignmentFocus?: 'anatomy' | 'tumor';
}

// Result of aligning a single date to the reference.
export interface AlignmentResult {
  date: string;
  seriesUid: string;
  bestSliceIndex: number;
  /** Normalized mutual information (Studholme); zero for unscored presentation-only replay. Higher is better. */
  nmiScore: number;
  computedSettings: PanelSettings;
  slicesChecked: number; // For debugging/stats
  /** Immutable producing-operation and target identities. */
  runId?: string;
  /** Accepted scan-pair model shared by its independently resliced browsing planes. */
  registrationId?: string;
  /** Target-space slice correction used to sample this presentation; never refits the cached pose. */
  manualSliceOffset?: number;
  /** Visible-view identity for background results; stale navigation may not apply them. */
  requestKey?: string;
  patientKey?: string;
  sequenceId?: string;
  referenceSeriesUid?: string;
  datasetRevision?: number;
  outputGrid?: OutputPlaneGrid;
  outcome?: 'aligned' | 'ambiguous' | 'insufficient-overlap' | 'incompatible-geometry' | 'failed' | 'cancelled';
  message?: string;
  /** Explicit evidence, never a claim of clinical correctness probability. */
  evidence?: {
    structuralScore: number;
    runnerUpGap: number;
    coverage: number;
    geometryMode: 'registered-3d' | 'physical-2d' | 'fallback-2d';
    planeAngleDegrees?: number;
    maximumNativePlaneDriftMm?: number;
    /** Actual acquired through-plane spacing and contiguous native frames used by the derived presentation. */
    presentationSliceSpacingMm?: number;
    presentationSourceFrameCount?: number;
    forwardAnatomicalSupport?: number;
    reverseAnatomicalSupport?: number;
    outputPlaneSupport?: number;
    requiredRegionSupport?: number;
    effectiveSampleCount?: number;
    heldOutSampleCount?: number;
    effectiveIndependentSamples?: number;
    heldOutEffectiveIndependentSamples?: number;
    minimumDistinguishableScoreMargin?: number;
    inverseConsistencyError?: number;
    outputGridFingerprint?: string;
    translationMm?: [number, number, number];
    rotationDegrees?: [number, number, number];
  };
  /** Verified rigidly resliced frame, explicitly identified as derived presentation. */
  derivedFrame?: DerivedAlignmentFramePresentation & {
    targetStudyUid?: string;
    rigidTransform?: [number, number, number, number, number, number];
    rotationCenterMm?: [number, number, number];
  };
}

// Progress update during alignment.
export interface AlignmentProgress {
  phase: 'capturing' | 'matching' | 'computing' | 'applying';
  currentDate: string | null;
  dateIndex: number;
  totalDates: number;
  slicesChecked: number;
  /**
   * Slice-search score. Higher is better.
   *
   * This value corresponds to whatever metric is being used for slice search (e.g. SSIM or
   * LNCC). It is not necessarily MI/NMI.
   */
  bestMiSoFar: number;
}
