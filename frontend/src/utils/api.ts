
// Deprecated: the HTTP backend is removed in the frontend-only build.
// This file is kept for compatibility but now proxies to local implementations where possible.

export function getImageUrl(
  studyId: string,
  seriesUid: string,
  instanceIndex: number
): string {
  return `miradb:${seriesUid}-${instanceIndex}-${studyId}`; // not used directly; we pass miradb imageIds via localApi
}

// AI endpoints are disabled in offline mode.
export async function fetchNanoBananaProAcpAnnotation() {
  throw new Error('AI annotation is disabled in offline mode. Provide an API key and server endpoint to enable.');
}

export async function uploadDicomArchive() {
  throw new Error('Upload endpoint is not available in offline mode. Use in-app DICOM file picker instead.');
}
