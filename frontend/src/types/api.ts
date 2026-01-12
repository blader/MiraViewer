export interface Series {
  series_uid: string;
  series_description: string;
  series_number: number;
  modality: string;
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
