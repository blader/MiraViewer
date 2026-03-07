import JSZip from 'jszip';
import type { SvrParams, SvrResult, SvrSelectedSeries } from '../types/svr';

type HarnessRunName = 'baseline' | 'high-detail';

export type SvrHarnessRun = {
  name: HarnessRunName;
  params: SvrParams;
  durationMs: number;
  result: SvrResult;

  /** Optional 3D render capture (from the WebGL viewer), if available. */
  render3dPng?: Blob | null;
};

export type ExportSvrHarnessZipParams = {
  dateIso: string | null;
  selectedSeries: SvrSelectedSeries[];
  runs: [SvrHarnessRun, SvrHarnessRun];
};

async function toArrayBuffer(value: Blob): Promise<ArrayBuffer> {
  // JSZip can consume blobs, but ArrayBuffer is the most compatible across runtimes.
  return value.arrayBuffer();
}

export async function exportSvrHarnessZip(params: ExportSvrHarnessZipParams): Promise<Blob> {
  const { dateIso, selectedSeries, runs } = params;

  const zip = new JSZip();
  const exportedAt = new Date().toISOString();

  const manifest = {
    exportedAt,
    dateIso,
    selectedSeries,
    runs: runs.map((r) => ({
      name: r.name,
      durationMs: Math.round(r.durationMs),
      dims: r.result.volume.dims,
      voxelSizeMm: r.result.volume.voxelSizeMm,
      originMm: r.result.volume.originMm,
      boundsMm: r.result.volume.boundsMm,
      params: r.params,
    })),
    version: 1,
  };

  zip.file('svr_harness.json', JSON.stringify(manifest, null, 2));

  for (const r of runs) {
    const folder = zip.folder(r.name);
    if (!folder) continue;

    folder.file(
      'meta.json',
      JSON.stringify(
        {
          name: r.name,
          durationMs: Math.round(r.durationMs),
          dims: r.result.volume.dims,
          voxelSizeMm: r.result.volume.voxelSizeMm,
          originMm: r.result.volume.originMm,
          boundsMm: r.result.volume.boundsMm,
          params: r.params,
          selectedSeries,
        },
        null,
        2
      )
    );

    const previewsFolder = folder.folder('previews');
    if (!previewsFolder) continue;

    previewsFolder.file('axial.png', await toArrayBuffer(r.result.previews.axial));
    previewsFolder.file('coronal.png', await toArrayBuffer(r.result.previews.coronal));
    previewsFolder.file('sagittal.png', await toArrayBuffer(r.result.previews.sagittal));

    if (r.render3dPng) {
      previewsFolder.file('render3d.png', await toArrayBuffer(r.render3dPng));
    }
  }

  return zip.generateAsync({ type: 'blob', compression: 'DEFLATE', compressionOptions: { level: 6 } });
}
