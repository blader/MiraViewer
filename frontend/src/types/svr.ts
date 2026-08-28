export type SvrPhase = 'idle' | 'loading' | 'initializing' | 'reconstructing' | 'finalizing';

export type SvrProgress = {
  phase: SvrPhase;
  current: number;
  total: number;
  message: string;
};

export type SvrRoiPlane = 'axial' | 'coronal' | 'sagittal';

export type SvrRoi = {
  /** Drawn focus cubes or tight patient-space boxes around native-source annotations. */
  mode: 'cube' | 'box';
  /** Which preview plane the user drew the ROI on (used for metadata / debugging). */
  sourcePlane: SvrRoiPlane;
  /**
   * Which input series the ROI was defined against.
   *
   * When using `seriesRegistrationMode: 'bounds-center'`, we use this series as the alignment reference so the ROI stays
   * in the same coordinate frame.
   */
  sourceSeriesUid?: string;
  /** ROI bounds in world/patient mm coordinates (same frame as DICOM IPP/IOP). */
  boundsMm: {
    min: [number, number, number];
    max: [number, number, number];
  };
};

export type SvrParams = {
  /** Target isotropic voxel size in mm (may be increased automatically to fit within maxVolumeDim). */
  targetVoxelSizeMm: number;
  /** Clamp each output dimension (x/y/z) to this maximum by increasing voxel size if needed. */
  maxVolumeDim: number;

  /** Downsample behavior for input slices before reconstruction. */
  sliceDownsampleMode: 'fixed' | 'voxel-aware';

  /** Downsample each slice (keeping aspect) so max(rows, cols) <= this value before reconstruction. */
  sliceDownsampleMaxSize: number;

  /**
   * Inter-series registration mode applied before fusion.
   *
   * - 'none': trust DICOM geometry as-is.
   * - 'bounds-center': translate each series so its 3D bounds center matches the reference series.
   *   This is a coarse but cheap stabilization when the scanner's spatial tags are inconsistent.
   */
  seriesRegistrationMode: 'none' | 'bounds-center' | 'roi-rigid';

  /** SVR refinement iterations (forward-project residuals back into the volume). */
  iterations: number;
  /** Step size for each refinement iteration (0..1-ish). */
  stepSize: number;

  /** Clamp output voxel intensities to [0, 1]. */
  clampOutput: boolean;

  /**
   * Slice-thickness forward model.
   *
   * - 'none': treat each pixel as a point sample on the slice plane.
   * - 'box': integrate uniformly across the slice thickness support.
   * - 'gaussian': distance-to-plane weighting within the thickness support.
   */
  psfMode?: 'none' | 'box' | 'gaussian';

  /** Robust loss applied to residuals during refinement iterations. */
  robustLoss?: 'none' | 'huber' | 'tukey';
  /** Residual scale parameter for robust loss (in normalized intensity units [0,1]). */
  robustDelta?: number;

  /**
   * Light edge-preserving 3D regularization between iterations.
   * 0 disables regularization.
   */
  laplacianWeight?: number;

  /** Multi-resolution schedule: coarse grid bootstrapping before fine iterations. */
  multiResolution?: boolean;
  /** Coarse voxel size factor relative to target voxel size (e.g. 2 -> 2x coarser). */
  multiResolutionFactor?: number;
  /** How many iterations to run at the coarse level (0 disables coarse refinement). */
  multiResolutionCoarseIterations?: number;

  /** Optional reconstruction ROI. If set, the output grid is restricted to this region (faster + smaller). */
  roi?: SvrRoi | null;
};

export const DEFAULT_SVR_PARAMS: SvrParams = {
  targetVoxelSizeMm: 1.0,
  maxVolumeDim: 192,
  sliceDownsampleMode: 'voxel-aware',
  sliceDownsampleMaxSize: 128,
  seriesRegistrationMode: 'roi-rigid',

  // Core solver defaults (chosen to be conservative but higher-fidelity than point-sample SVR).
  psfMode: 'gaussian',
  robustLoss: 'huber',
  robustDelta: 0.1,
  laplacianWeight: 0.02,
  multiResolution: false,
  multiResolutionFactor: 2,
  multiResolutionCoarseIterations: 1,

  iterations: 3,
  stepSize: 0.6,
  clampOutput: true,
};

/** Row-major orthonormal matrix: columns are the grid axes in patient LPS millimeters. */
export type SvrDirection = readonly [number, number, number, number, number, number, number, number, number];

/** Absolute patient-space transform; crop/downsample offsets are not registration. */
export type SvrPatientTransform = {
  rotation: SvrDirection;
  translationMm: readonly [number, number, number];
};

/** Canonical full DICOM frame geometry, never the cropped or reduced sampling grid. */
export type SvrSourceFrame = {
  sopInstanceUid: string;
  rows: number;
  columns: number;
  originMm: readonly [number, number, number];
  columnDirection: readonly [number, number, number];
  rowDirection: readonly [number, number, number];
  pixelSpacingMm: readonly [number, number];
  windowCenter?: number;
  windowWidth?: number;
};

export type SvrNativeSource = {
  seriesUid: string;
  label: string;
  kind: 'original-3d' | 'original-2d' | 'derived' | 'unknown';
  /** Native patient mm -> accepted volume patient mm. Identity must be explicit. */
  transform: SvrPatientTransform;
  frames: readonly SvrSourceFrame[];
  contributingSopInstanceUids: readonly string[];
};

export type SvrSourceProvenance = {
  mode: 'native-3d' | 'independent-2d' | 'source-stack';
  datasetRevision: number;
  patientKey: string;
  studyUid: string;
  frameOfReferenceUid: string;
  fingerprint: string;
  primarySeriesUid: string;
  sources: readonly SvrNativeSource[];
  explanation: string;
};

export type SvrVolume = {
  data: Float32Array;
  /** Suggested display-only window in data units; native stacks retain signed modality values. */
  displayWindow?: [number, number];
  /** Display/GPU normalization range only. CPU source values are never windowed or clipped. */
  intensityRange?: [number, number];
  /** MONOCHROME1 display convention; never changes stored modality values. */
  displayInvert?: boolean;
  /** Acquired-observation support in the same voxel order as `data`; zero means no physical evidence. */
  observedSupport?: Uint8Array;
  /** Number of acquired-supported voxels, counted when `observedSupport` is produced. */
  supportedVoxelCount?: number;
  /** Orientation diversity, not proof of acquisition independence. See sourceProvenance. */
  acquiredOrientationCount?: number;
  /** Conservative source-derived patient-axis resolution estimate; absent when an axis cannot be verified. */
  effectiveResolutionMm?: [number, number, number];
  /** Whether contributing frames explicitly declared their slice-excitation thickness. */
  sliceProfileSource?: 'declared' | 'mixed' | 'unknown';
  /** Metadata-only fingerprint binding accepted source identity, geometry, settings, and output evidence. */
  reconstructionFingerprint?: string;
  sourceProvenance?: SvrSourceProvenance;
  /** Original stored grid pitch, not measured acquired resolution. Present on native-source volumes. */
  nativeVoxelSizeMm?: [number, number, number];
  dims: [number, number, number];
  voxelSizeMm: [number, number, number];
  /** Omitted only for legacy patient-axis-aligned reconstruction grids (identity). */
  direction?: SvrDirection;
  originMm: [number, number, number];
  boundsMm: {
    min: [number, number, number];
    max: [number, number, number];
  };
};

/**
 * A semantic label that can be used to colorize the reconstructed volume.
 *
 * Notes:
 * - Label IDs must fit in uint8 (0..255).
 * - Label ID 0 is reserved for background/unlabeled.
 */
export type SvrLabelMeta = {
  id: number;
  name: string;
  /** RGB color in 0..255. */
  color: [number, number, number];
};

export type SvrLabelVolume = {
  /** Per-voxel label IDs, in the same indexing order as `SvrVolume.data`. */
  data: Uint8Array;
  /** Must exactly match `SvrVolume.dims`. */
  dims: [number, number, number];
  meta: SvrLabelMeta[];
  /** Explicit user review, not algorithmic confidence or a clinical diagnosis. Missing legacy state is draft. */
  reviewState?: 'draft' | 'reviewed';
  /** Explicit editing constraints, retained so saved drafts can be grown and corrected again. */
  seeds?: { foreground: Uint32Array; background: Uint32Array };
};

export type SvrResult = {
  volume: SvrVolume;
  /** Settings that produced this accepted reconstruction, independent of pending UI changes. */
  parameters?: SvrParams;
  /** A transferred draft published atomically with a finer regional reconstruction. Saved edits take precedence. */
  initialSelection?: SvrLabelVolume;
};

export type SvrSelectedSeries = {
  seriesUid: string;
  studyId: string;
  dateIso: string;
  instanceCount: number;
  label: string;
  plane?: string | null;
  weight?: string | null;
  sequence?: string | null;
};
