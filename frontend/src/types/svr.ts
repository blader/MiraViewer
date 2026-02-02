export type SvrPhase = 'idle' | 'loading' | 'initializing' | 'reconstructing' | 'finalizing';

export type SvrProgress = {
  phase: SvrPhase;
  current: number;
  total: number;
  message: string;
};

export type SvrRoiPlane = 'axial' | 'coronal' | 'sagittal';

export type SvrRoi = {
  /** For now we only support cube ROIs (square in-plane + equal extent through-plane). */
  mode: 'cube';
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
   * Light 3D Laplacian smoothing between iterations.
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
  multiResolution: true,
  multiResolutionFactor: 2,
  multiResolutionCoarseIterations: 1,

  iterations: 3,
  stepSize: 0.6,
  clampOutput: true,
};

export type SvrVolume = {
  data: Float32Array;
  dims: [number, number, number];
  voxelSizeMm: [number, number, number];
  originMm: [number, number, number];
  boundsMm: {
    min: [number, number, number];
    max: [number, number, number];
  };
};

export type SvrPreviewImages = {
  axial: Blob;
  coronal: Blob;
  sagittal: Blob;
};

export type SvrResult = {
  volume: SvrVolume;
  previews: SvrPreviewImages;
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
