export interface DicomStudy {
  studyInstanceUid: string;
  studyDate: string; // YYYYMMDD
  studyDescription: string;
  patientName: string;
  patientId: string;
  modality: string;
  accessionNumber?: string;
}

export interface DicomSeries {
  seriesInstanceUid: string;
  studyInstanceUid: string;
  seriesDescription: string;
  seriesNumber: number;
  modality: string;
  
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
    indexes: { 'by-series': string };
  };
  panel_settings: {
    key: string; // comboId
    value: PanelSettingsRow;
  };
}
