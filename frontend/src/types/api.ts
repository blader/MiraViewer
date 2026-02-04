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
}

export interface ComparisonData {
  planes: string[];
  dates: string[]; // ISO date strings
  sequences: SequenceCombo[];
  series_map: Record<string, Record<string, SeriesRef>>; // comboId -> dateISO -> ref
}

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

  // Settings that should be used as the *base* view transform for aligned targets.
  // (Targets get a recovered delta transform composed on top of these settings.)
  settings: PanelSettings;

  /**
   * Optional rectangular region to exclude from similarity metrics (e.g., tumor area).
   * Pixels inside this rect are ignored when computing MI/NMI for slice search and registration.
   */
  exclusionMask?: ExclusionMask;
}

// Result of aligning a single date to the reference.
export interface AlignmentResult {
  date: string;
  seriesUid: string;
  bestSliceIndex: number;
  /** Normalized mutual information (Studholme). Higher is better. */
  nmiScore: number;
  computedSettings: PanelSettings;
  slicesChecked: number; // For debugging/stats
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
