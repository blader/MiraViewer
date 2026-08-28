import type { SvrParams, SvrPatientTransform, SvrRoi } from '../../types/svr';
import type { SeriesFrameManifest } from '../localApi';
import { getSliceGeometryFromInstance } from './dicomGeometry';
import { computeSvrDownsampleSize } from './downsample';
import { filterSvrManifestFramesForRoi, getSvrSourceCropWindow } from './sliceRoiCrop';

export type SvrDecodedCacheInfo = { cacheSizeInBytes?: number; maximumSizeInBytes?: number };

/** Pure source-copy authority shared by the UI planner and pre-decode runtime admission. */
export function estimateSvrSourceMemory(
  manifests: readonly SeriesFrameManifest[],
  params: SvrParams,
  options: {
    roi?: SvrRoi | null;
    acceptedSourceTransforms?: Readonly<Record<string, SvrPatientTransform>>;
    cacheInfo?: SvrDecodedCacheInfo;
  } = {},
): { sourceBytes: number; decodedSourceCacheBytes: number } {
  const roi = options.roi === undefined ? params.roi : options.roi;
  let sourceBytes = 0,
    selectedNativeBytes = 0;
  for (const manifest of manifests) {
    const transform = options.acceptedSourceTransforms?.[manifest.seriesUid];
    for (const frame of filterSvrManifestFramesForRoi(manifest, roi, params, transform).frames) {
      const geometry = getSliceGeometryFromInstance(frame);
      if (![geometry.rows, geometry.cols].every((size) => Number.isSafeInteger(size) && size > 0))
        throw new Error('Source memory planning requires positive native pixel dimensions.');
      const crop = roi ? getSvrSourceCropWindow(frame, roi, params, transform) : null;
      const sampled = crop
        ? { dsRows: crop.rows, dsCols: crop.columns }
        : computeSvrDownsampleSize({
            rows: geometry.rows,
            cols: geometry.cols,
            maxSize: params.sliceDownsampleMaxSize,
            mode: params.sliceDownsampleMode,
            rowSpacingMm: geometry.rowSpacingMm,
            colSpacingMm: geometry.colSpacingMm,
            targetVoxelSizeMm: params.targetVoxelSizeMm,
          });
      sourceBytes += sampled.dsRows * sampled.dsCols * 5; // Float32 modality values + acquired byte mask.
      selectedNativeBytes += geometry.rows * geometry.cols * Float32Array.BYTES_PER_ELEMENT;
    }
  }
  const measured = options.cacheInfo?.cacheSizeInBytes;
  const existingBytes = Number.isFinite(measured) && measured! > 0 ? measured! : 0;
  const maximumBytes = options.cacheInfo?.maximumSizeInBytes;
  const projectedBytes = existingBytes + selectedNativeBytes;
  const decodedSourceCacheBytes =
    Number.isFinite(maximumBytes) && maximumBytes! > 0
      ? Math.max(existingBytes, Math.min(maximumBytes!, projectedBytes))
      : Math.max(projectedBytes, 256 * 1024 * 1024);
  return { sourceBytes, decodedSourceCacheBytes };
}
