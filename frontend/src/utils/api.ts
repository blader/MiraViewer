import type { Study, Series, ImageMetadata } from '../types/api';

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

export function formatSeriesDescription(description: string): string {
  // Clean up common DICOM series description patterns
  return description
    .replace(/^MR\s*/i, '')
    .replace(/_/g, ' ')
    .trim() || 'Unknown Series';
}
