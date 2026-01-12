export interface Series {
  series_uid: string;
  series_description: string;
  series_number: number;
  modality: string;
  plane: string | null;
  weight: string | null;
  sequence_type: string | null;
  instance_count: number;
  instances?: Instance[];
}

export interface Instance {
  file_path: string;
  instance_number: number;
  slice_location: number;
}

export interface Study {
  study_id: string;
  folder_name: string;
  study_date: string | null;
  scan_type: string;
  series: Series[];
  series_count: number;
  total_instances: number;
}

export interface ImageMetadata {
  series_uid: string;
  series_description: string;
  series_number: number;
  instance_number: number;
  slice_location: number;
  rows: number;
  columns: number;
  patient_name: string;
  study_date: string;
  modality: string;
  window_center: number | number[] | null;
  window_width: number | number[] | null;
}

export interface ViewerState {
  studyId: string | null;
  seriesUid: string | null;
  instanceIndex: number;
  windowCenter: number;
  windowWidth: number;
  zoom: number;
  panX: number;
  panY: number;
}

export interface CompareState {
  enabled: boolean;
  leftStudyId: string | null;
  leftSeriesUid: string | null;
  leftInstanceIndex: number;
  rightStudyId: string | null;
  rightSeriesUid: string | null;
  rightInstanceIndex: number;
  syncScroll: boolean;
}

// Comparison view types
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

export interface PanelSettings {
  offset: number;
  zoom: number;
  rotation: number;
  progress?: number | null; // normalized 0..1 last viewed global slice position for this date
}
