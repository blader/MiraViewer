export interface DicomStudy {
  studyInstanceUid: string;
  studyDate: string; // YYYYMMDD
  studyDescription: string;
  patientName: string;
  patientId: string;
  modality: string;
  accessionNumber?: string;
}

export type NormalizedPoint = { x: number; y: number };

// Viewport size in CSS pixels when the user authored an overlay.
//
// This is needed to correctly re-project viewer-normalized points/polygons into image coordinates
// because the "contain" mapping depends on both viewport size and image aspect ratio.
export type ViewportSize = { w: number; h: number };

export type ViewerTransform = {
  /** Zoom factor (1 = 100%). */
  zoom: number;
  /** Rotation in degrees. */
  rotation: number;
  /** Normalized pan (fraction of viewport width). */
  panX: number;
  /** Normalized pan (fraction of viewport height). */
  panY: number;

  /** Hidden affine residual (shear / anisotropic scale), row-major 2x2. */
  affine00: number;
  affine01: number;
  affine10: number;
  affine11: number;
};

export type TumorPolygon = {
  /**
   * Polygon points in normalized viewer coordinates.
   *
   * IMPORTANT:
   * These points are stored in the viewer's coordinate system at the time they were created.
   * To render them correctly under a different pan/zoom/rotation/affine, re-project using the
   * saved `viewTransform` metadata.
   */
  points: NormalizedPoint[];
};

export type TumorGrow2dMeta = {
  kind: 'cost-distance';
  slider: {
    /** Slider value in [0..1]. */
    value01: number;
    /** Optional gamma used for slider→threshold mapping. */
    gamma?: number;

    /** Optional area-based control metadata (newer UI). */
    targetAreaPx?: number;
    maxTargetAreaPx?: number;
  };
  roi: { x0: number; y0: number; x1: number; y1: number };
  captureSize: { w: number; h: number };
  stats?: {
    tumorMu: number;
    tumorSigma: number;
    bgMu?: number;
    bgSigma?: number;
    edgeBarrier?: number;
  };
  weights?: {
    edgeCostStrength?: number;
    crossCostStrength?: number;
    tumorCostStrength?: number;
    bgCostStrength?: number;
    bgRejectMarginZ?: number;
    allowDiagonal?: boolean;
  };
  tuning?: {
    radialOuterW?: number;
    radialOuterCap?: number;
    baseStepScale?: number;
    preferHighExponent?: number;
    preferHighStrengthMul?: number;
    uphillFromLowMult?: number;
  };
  dist?: {
    maxFiniteDist?: number;
  };
};

export type TumorThreshold = {
  /** Inclusive lower bound in segmentation pixel domain (typically 0..255). */
  low: number;
  /** Inclusive upper bound in segmentation pixel domain (typically 0..255). */
  high: number;

  /**
   * Optional fixed "anchor" intensity used when the UI operates in tolerance mode.
   *
   * Stored so the slider can stay monotonic (tolerance expands/contracts around a fixed anchor).
   * Older rows may omit this.
   */
  anchor?: number;

  /**
   * Optional tolerance (half-width) around `anchor` (0..127-ish).
   * Older rows may omit this.
   */
  tolerance?: number;
};

export interface TumorSegmentationRow {
  /** Stable ID (composite encoded). */
  id: string;

  /** Sequence combo id (plane+weight+sequence). */
  comboId: string;
  /** ISO-ish date key used by the comparison view (see localApi date formatting). */
  dateIso: string;

  studyId: string;
  seriesUid: string;
  sopInstanceUid: string;

  /** Version for future algorithm migrations. */
  algorithmVersion: string;

  polygon: TumorPolygon;
  threshold: TumorThreshold;

  /** Optional seed point used for region growing (normalized). */
  seed?: NormalizedPoint;

  createdAtMs: number;
  updatedAtMs: number;

  meta?: {
    areaPx?: number;
    areaNorm?: number;

    /** Viewer transform at the time this polygon was saved (used to re-project overlays). */
    viewTransform?: ViewerTransform;

    /** Viewport size (CSS pixels) at the time this polygon was saved. */
    viewportSize?: ViewportSize;

    /** Optional parameters for the newer seed-based 2D grow tool. */
    grow2d?: TumorGrow2dMeta;
  };
}

export interface TumorGroundTruthRow {
  /** Stable ID (composite encoded). */
  id: string;

  /** Sequence combo id (plane+weight+sequence). */
  comboId: string;
  /** ISO-ish date key used by the comparison view (see localApi date formatting). */
  dateIso: string;

  studyId: string;
  seriesUid: string;
  sopInstanceUid: string;

  /** Manually drawn polygon points in normalized viewer coordinates. */
  polygon: TumorPolygon;

  /** Viewer transform at the time this polygon was saved (used to re-project overlays). */
  viewTransform?: ViewerTransform;

  /** Viewport size (CSS pixels) at the time this polygon was saved. */
  viewportSize?: ViewportSize;

  createdAtMs: number;
  updatedAtMs: number;
}

export interface DicomSeries {
  seriesInstanceUid: string;
  studyInstanceUid: string;
  seriesDescription: string;
  seriesNumber: number;
  modality: string;

  // Additional naming fields (often more informative than SeriesDescription alone)
  protocolName?: string;
  sequenceName?: string;

  // Derived/Parsed fields
  plane?: string; // Axial, Coronal, Sagittal
  weight?: string; // T1, T2
  sequenceType?: string; // FLAIR, etc.
}

export interface DicomInstance {
  sopInstanceUid: string;
  seriesInstanceUid: string;
  studyInstanceUid: string;
  instanceNumber: number;
  
  // Image metadata
  rows: number;
  columns: number;
  sliceLocation?: number;
  imagePositionPatient?: string; // [x, y, z] as string
  imageOrientationPatient?: string; // [rowX, rowY, rowZ, colX, colY, colZ] as string
  pixelSpacing?: string; // [row, col] as string
  sliceThickness?: number;
  spacingBetweenSlices?: number;
  
  // Windowing
  windowCenter?: number;
  windowWidth?: number;
  
  // The raw DICOM file
  fileBlob: Blob;
}

export interface PanelSettingsRow {
  comboId: string;
  settings: Record<string, {
    offset: number;
    reverseSliceOrder: boolean;
    zoom: number;
    rotation: number;
    brightness: number;
    contrast: number;
    panX: number;
    panY: number;
    affine00: number;
    affine01: number;
    affine10: number;
    affine11: number;
    progress: number;
  }>;
}

export interface MiraDB {
  studies: {
    key: string; // studyInstanceUid
    value: DicomStudy;
  };
  series: {
    key: string; // seriesInstanceUid
    value: DicomSeries;
    indexes: { 'by-study': string };
  };
  instances: {
    key: string; // sopInstanceUid
    value: DicomInstance;
    indexes: {
      'by-series': string;
      /**
       * Compound index for sorted slice retrieval without loading Blob values.
       * Key: [seriesInstanceUid, instanceNumber, sopInstanceUid]
       */
      'by-series-instanceNumber-uid': [string, number, string];
    };
  };
  panel_settings: {
    key: string; // comboId
    value: PanelSettingsRow;
  };
  tumor_segmentations: {
    key: string; // id
    value: TumorSegmentationRow;
    indexes: {
      'by-series': string;
      'by-sop': string;
      'by-combo-date': [string, string];
    };
  };

  tumor_ground_truth: {
    key: string; // id
    value: TumorGroundTruthRow;
    indexes: {
      'by-series': string;
      'by-sop': string;
      'by-combo-date': [string, string];
    };
  };
}
