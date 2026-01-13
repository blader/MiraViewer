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

// Persisted per-date viewer settings for a specific sequence combo.
export interface PanelSettings {
  offset: number;
  zoom: number; // 1 = 100%
  rotation: number; // degrees, typically [-180, 180]
  brightness: number; // 0-200, 100 = normal
  contrast: number; // 0-200, 100 = normal
  panX: number; // normalized pan (-1..1), as fraction of viewport width
  panY: number; // normalized pan (-1..1), as fraction of viewport height
  progress: number; // normalized 0..1, last viewed global slice position for this date
}

// What the backend may return (values may be missing or null).
export type PanelSettingsFromApi = Partial<{
  offset: number | null;
  zoom: number | null;
  rotation: number | null;
  brightness: number | null;
  contrast: number | null;
  panX: number | null;
  panY: number | null;
  progress: number | null;
}>;
