import type { Study, Series, ImageMetadata, ComparisonData, PanelSettings } from '../types/api';

const API_BASE = '/api';

export async function fetchStudies(): Promise<Study[]> {
  const response = await fetch(`${API_BASE}/studies`);
  if (!response.ok) {
    throw new Error('Failed to fetch studies');
  }
  return response.json();
}

export async function fetchStudy(studyId: string): Promise<Study> {
  const response = await fetch(`${API_BASE}/studies/${studyId}`);
  if (!response.ok) {
    throw new Error('Failed to fetch study');
  }
  return response.json();
}

export async function fetchSeries(studyId: string, seriesUid: string): Promise<Series> {
  const response = await fetch(`${API_BASE}/studies/${studyId}/series/${encodeURIComponent(seriesUid)}`);
  if (!response.ok) {
    throw new Error('Failed to fetch series');
  }
  return response.json();
}

export async function fetchImageMetadata(
  studyId: string,
  seriesUid: string,
  instanceIndex: number
): Promise<ImageMetadata> {
  const response = await fetch(
    `${API_BASE}/image-metadata/${studyId}/${encodeURIComponent(seriesUid)}/${instanceIndex}`
  );
  if (!response.ok) {
    throw new Error('Failed to fetch image metadata');
  }
  return response.json();
}

export function getImageUrl(
  studyId: string,
  seriesUid: string,
  instanceIndex: number,
  windowCenter?: number,
  windowWidth?: number
): string {
  const params = new URLSearchParams();
  if (windowCenter !== undefined) params.set('wc', windowCenter.toString());
  if (windowWidth !== undefined) params.set('ww', windowWidth.toString());
  const queryString = params.toString();
  const base = `${API_BASE}/image/${studyId}/${encodeURIComponent(seriesUid)}/${instanceIndex}`;
  return queryString ? `${base}?${queryString}` : base;
}

export function formatDate(dateString: string | null): string {
  if (!dateString) return 'Unknown Date';
  const date = new Date(dateString);
  return date.toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });
}

export async function fetchComparisonData(): Promise<ComparisonData> {
  const response = await fetch(`${API_BASE}/comparison-data`);
  if (!response.ok) {
    throw new Error('Failed to fetch comparison data');
  }
  return response.json();
}

export async function fetchPanelSettings(comboId: string): Promise<Record<string, PanelSettings>> {
  const res = await fetch(`${API_BASE}/panel-settings/${encodeURIComponent(comboId)}`);
  if (!res.ok) throw new Error('Failed to fetch panel settings');
  const data = await res.json();
  return (data && data.settings) || {};
}

export async function savePanelSettings(comboId: string, dateIso: string, settings: PanelSettings): Promise<void> {
  const payload: any = { combo_id: comboId, date_iso: dateIso };
  if (typeof settings.offset === 'number') payload.offset = settings.offset;
  if (typeof settings.zoom === 'number') payload.zoom = settings.zoom;
  if (typeof settings.rotation === 'number') payload.rotation = settings.rotation;
  if (typeof settings.progress === 'number') payload.progress = settings.progress;
  const res = await fetch(`${API_BASE}/panel-settings`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (!res.ok) throw new Error('Failed to save panel settings');
}

export function formatSeriesDescription(description: string): string {
  // Clean up common DICOM series description patterns
  return description
    .replace(/^MR\s*/i, '')
    .replace(/_/g, ' ')
    .trim() || 'Unknown Series';
}
