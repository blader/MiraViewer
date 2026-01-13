import type { ComparisonData, PanelSettings, PanelSettingsFromApi } from '../types/api';

const API_BASE = '/api';

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

export async function fetchComparisonData(): Promise<ComparisonData> {
  const response = await fetch(`${API_BASE}/comparison-data`);
  if (!response.ok) {
    throw new Error('Failed to fetch comparison data');
  }
  return response.json();
}

export async function fetchPanelSettings(comboId: string): Promise<Record<string, PanelSettingsFromApi>> {
  const res = await fetch(`${API_BASE}/panel-settings/${encodeURIComponent(comboId)}`);
  if (!res.ok) throw new Error('Failed to fetch panel settings');
  const data = await res.json();
  return (data && data.settings) || {};
}

type PanelSettingsUpsertPayload = {
  combo_id: string;
  date_iso: string;
  offset?: number;
  zoom?: number;
  rotation?: number;
  brightness?: number;
  contrast?: number;
  panX?: number;
  panY?: number;
  progress?: number;
};

export async function savePanelSettings(comboId: string, dateIso: string, settings: PanelSettings): Promise<void> {
  const payload: PanelSettingsUpsertPayload = {
    combo_id: comboId,
    date_iso: dateIso,
    offset: settings.offset,
    zoom: settings.zoom,
    rotation: settings.rotation,
    brightness: settings.brightness,
    contrast: settings.contrast,
    panX: settings.panX,
    panY: settings.panY,
    progress: settings.progress,
  };

  const res = await fetch(`${API_BASE}/panel-settings`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (!res.ok) throw new Error('Failed to save panel settings');
}
