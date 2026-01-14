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

type NanoBananaProAcpAnnotateRequest = {
  studyId: string;
  seriesUid: string;
  instanceIndex: number;
  /** Base64 (no data: prefix) of the exact pixels visible in the viewer viewport. */
  imageBase64?: string;
  /** MIME type for imageBase64 (typically image/png). */
  imageMimeType?: string;
};

type NanoBananaProAcpAnnotateResponse = {
  analysis_text: string;
  analysis_json: unknown | null;
  nano_banana_prompt: string;
  mime_type: string;
  image_base64: string;
};

export type NanoBananaProAcpAnnotateResult = {
  blob: Blob;
  analysisText: string;
  analysisJson: unknown | null;
  nanoBananaPrompt: string;
  mimeType: string;
};

function base64ToBlob(base64: string, mimeType: string): Blob {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return new Blob([bytes], { type: mimeType });
}

export async function fetchNanoBananaProAcpAnnotation(
  req: NanoBananaProAcpAnnotateRequest
): Promise<NanoBananaProAcpAnnotateResult> {
  const res = await fetch(`${API_BASE}/nano-banana-pro/acp-annotate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      study_id: req.studyId,
      series_uid: req.seriesUid,
      instance_index: req.instanceIndex,
      image_base64: req.imageBase64,
      image_mime_type: req.imageMimeType,
    }),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    const details = text ? `: ${text}` : '';
    throw new Error(`Nano Banana Pro request failed (${res.status})${details}`);
  }

  const data = (await res.json()) as NanoBananaProAcpAnnotateResponse;
  const blob = base64ToBlob(data.image_base64, data.mime_type);

  return {
    blob,
    analysisText: data.analysis_text,
    analysisJson: data.analysis_json,
    nanoBananaPrompt: data.nano_banana_prompt,
    mimeType: data.mime_type,
  };
}
