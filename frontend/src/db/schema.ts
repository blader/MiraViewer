import type { OutputPlaneGrid } from '../utils/outputPlaneGrid';
import type { AlignmentDisplayTone } from '../utils/alignmentDisplayTone';
import type {
  SvrDirection,
  SvrNativeSource,
  SvrPatientTransform,
  SvrSelectionSeeds,
  SvrSourceProvenance,
} from '../types/svr';
import type { PanelSettings } from '../types/api';
import type { DBSchema } from 'idb';

export interface DicomStudy {
  studyInstanceUid: string;
  studyDate: string; // YYYYMMDD
  studyTime?: string;
  studyDescription: string;
  patientName: string;
  patientId: string;
  patientIdIssuer?: string;
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
    coordinateSpace?: 'image-normalized' | 'viewer-normalized';
    imageSize?: { w: number; h: number };

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
  coordinateSpace?: 'image-normalized' | 'viewer-normalized';
  imageSize?: { w: number; h: number };

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
  frameOfReferenceUid?: string;
  acquisitionTime?: string;
  rows?: number;
  columns?: number;
  pixelSpacing?: string;
  imageOrientationPatient?: string;

  // Derived/Parsed fields
  plane?: string; // Axial, Coronal, Sagittal
  weight?: string; // T1, T2
  sequenceType?: string; // FLAIR, etc.
}

/** Header provenance, distinct from the reconstructed image's displayed sampling grid. */
export interface DicomAcquisitionMetadata {
  version: 1;
  imageType: string[];
  mrAcquisitionType?: '2D' | '3D';
  /** Frequency rows, frequency columns, phase rows, phase columns before reconstruction. */
  acquisitionMatrix?: [number, number, number, number];
  reconstructionDiameterMm?: number;
  percentSampling?: number;
  percentPhaseFieldOfView?: number;
  acquisitionNumber?: number;
  acquisitionDateTime?: string;
  scanningSequence?: string[];
  sequenceVariant?: string[];
  echoTimeMs?: number;
  repetitionTimeMs?: number;
  inversionTimeMs?: number;
  sourceSopInstanceUids: string[];
  derivationSopInstanceUids: string[];
  derivationDescription?: string;
  /** A bounded legacy-header read was unavailable; never infer independent acquisitions from missing tags. */
  unavailable?: true;
}

export interface DicomInstance {
  sopInstanceUid: string;
  seriesInstanceUid: string;
  studyInstanceUid: string;
  instanceNumber: number;
  frameOfReferenceUid?: string;
  acquisitionTime?: string;
  acquisitionMetadata?: DicomAcquisitionMetadata;
  numberOfFrames?: number;
  /** Signed patient-space distance along this frame's validated slice normal. */
  physicalSlicePosition?: number;

  // Image metadata
  rows: number;
  columns: number;
  sliceLocation?: number;
  imagePositionPatient?: string; // [x, y, z] as string
  imageOrientationPatient?: string; // [rowX, rowY, rowZ, colX, colY, colZ] as string
  pixelSpacing?: string; // [row, col] as string
  sliceThickness?: number;
  spacingBetweenSlices?: number;
  pixelPaddingValue?: number;
  pixelPaddingRangeLimit?: number;

  // Windowing
  windowCenter?: number;
  windowWidth?: number;

  // The raw DICOM file
  fileBlob: Blob;
}

export interface PanelSettingsRow {
  comboId: string;
  settings: Record<string, PanelSettings>;
  /** Canonical source ownership. Rows without this are retained legacy settings. */
  source?: { studyUid: string; seriesUid: string; legacyOrigin?: { comboId: string; dateIso: string } };
}

export interface AppStateRow {
  key: string;
  value: unknown;
}

/** Enough accepted geometry to transfer annotations explicitly, without persisting MRI pixels. */
export interface VolumeSegmentationGeometry {
  version: 1;
  originMm: [number, number, number];
  direction: SvrDirection;
  reconstructionFingerprint: string;
  sourceProvenance: {
    mode: SvrSourceProvenance['mode'];
    primarySeriesUid: string;
    sources: Array<{
      seriesUid: string;
      kind: SvrNativeSource['kind'];
      transform: SvrPatientTransform;
      /** Full canonical source identities, not only frames intersecting a focus region. */
      sopInstanceUids: string[];
    }>;
  };
}

/** Durable voxel labels bound to the exact reconstruction geometry that created them. */
export interface VolumeSegmentationRow {
  volumeKey: string;
  patientKey?: string;
  studyUid?: string;
  seriesUids?: string[];
  frameOfReferenceUid?: string;
  dims: [number, number, number];
  voxelSizeMm?: [number, number, number];
  geometry?: VolumeSegmentationGeometry;
  labels: Uint8Array;
  classMetadata?: unknown;
  modelKey?: string;
  reviewState?: 'draft' | 'reviewed';
  seeds?: SvrSelectionSeeds;
  /** Mask-owned evidence that its originating prediction was only partially retained. */
  clippedNativeVoxels?: number;
  /** Mask-owned source-context evidence; absence does not establish unrestricted analysis. */
  contextLimited?: boolean;
  datasetRevision?: number;
  updatedAt: number;
}

/** Old dense rows remain readable and migrate atomically on their next edit. */
export type StoredVolumeSegmentationRow =
  | VolumeSegmentationRow
  | (Omit<VolumeSegmentationRow, 'labels'> & {
      storage: 'chunks-v1';
      revision: string;
      labelBytes: number;
      chunkCount: number;
    });

export type VolumeSegmentationChunk = { volumeKey: string; offset: number; data: Uint8Array };

export interface DerivedAlignmentFramePresentation {
  displayTone?: AlignmentDisplayTone;
  pixels: Float32Array;
  valid?: Uint8Array;
  rows: number;
  columns: number;
  sourceImageId: string;
  referenceStudyUid?: string;
  referenceSeriesUid?: string;
  referenceSopInstanceUid?: string;
  referenceFrameIndex?: number;
  referenceImagePositionPatient?: string;
  referenceImageOrientationPatient?: string;
  referencePixelSpacing?: string;
  referenceRows?: number;
  referenceColumns?: number;
  targetSopInstanceUid?: string;
  referenceFrameOfReferenceUid?: string;
  targetFrameOfReferenceUid?: string;
  nativeSliceSpacingMm?: number;
  sourceFrameCount?: number;
  outputGrid?: OutputPlaneGrid;
  contributingSourceSopInstanceUids?: string[];
}

/** A registered reference-plane image that remains bound to both source examinations. */
export interface DerivedAlignmentFrameRow extends DerivedAlignmentFramePresentation {
  id: string;
  patientKey: string;
  datasetRevision: number;
  sequenceId: string;
  targetStudyUid: string;
  targetSeriesUid: string;
  targetFrameIndex: number;
  frameOfReferenceUid?: string;
  sourceFrameOfReferenceUid?: string;
  transform?: number[];
  centerMm?: [number, number, number];
  coverage?: number;
  score?: number;
  margin?: number;
  runId?: string;
  createdAt: number;
}

export type ModelRecord = { key: string; blob: Blob; savedAtMs: number };

export interface MiraDB extends DBSchema {
  models: { key: string; value: ModelRecord };
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
      'by-series-physicalPosition-uid': [string, number, string];
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

  app_state: {
    key: string;
    value: AppStateRow;
  };

  volume_segmentations: {
    key: string;
    value: StoredVolumeSegmentationRow;
    indexes: { 'by-study': string };
  };

  volume_segmentation_chunks: {
    key: [string, number];
    value: VolumeSegmentationChunk;
  };

  derived_alignment_frames: {
    key: string;
    value: DerivedAlignmentFrameRow;
    indexes: {
      'by-patient': string;
      'by-created-at': number;
      'by-patient-revision-source': [string, number, string, string];
    };
  };
}
