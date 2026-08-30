import type { SvrParams, SvrPatientTransform, SvrRoi } from '../../types/svr';
import type { SeriesFrameManifest } from '../localApi';
import { getSliceGeometryFromInstance } from './dicomGeometry';
import { computeSvrDownsampleSize } from './downsample';
import { filterSvrManifestFramesForRoi, getSvrSourceCropWindow } from './sliceRoiCrop';
import { CORNERSTONE_MEMORY_FALLBACK_BYTES, type CornerstoneImageMemory } from '../cornerstoneMemory';

export type SvrDecodedCacheInfo = { cacheSizeInBytes?: number; maximumSizeInBytes?: number };
export const SVR_SOURCE_PREFETCH_LIMIT = 4;

/** Pure source-copy authority shared by the UI planner and pre-decode runtime admission. */
export function estimateSvrSourceMemory(
  manifests: readonly SeriesFrameManifest[],
  params: SvrParams,
  options: {
    roi?: SvrRoi | null;
    acceptedSourceTransforms?: Readonly<Record<string, SvrPatientTransform>>;
    cacheInfo?: SvrDecodedCacheInfo;
    cacheMemory?: CornerstoneImageMemory;
  } = {},
): { sourceBytes: number; decodedSourceCacheBytes: number; sourceDecodeBytes: number } {
  const roi = options.roi === undefined ? params.roi : options.roi;
  let sourceBytes = 0,
    sourceDecodeBytes = 0;
  for (const manifest of manifests) {
    const concurrentImageBytes: number[] = [];
    let missingDicomSize = false;
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
      const nativeBytes = geometry.rows * geometry.cols * Float32Array.BYTES_PER_ELEMENT;
      const encodedBytes = frame.dicomByteLength;
      const knownSize = Number.isSafeInteger(encodedBytes) && encodedBytes! >= 0;
      missingDicomSize ||= !knownSize;
      // Blob size forecasts retained source bytes, not arbitrary parser inflation;
      // compressed files cannot reduce the known uncompressed pixel-storage floor.
      concurrentImageBytes.push(nativeBytes + (knownSize ? Math.max(nativeBytes, encodedBytes!) : nativeBytes));
      concurrentImageBytes.sort((a, b) => b - a);
      // Refill precedes conversion: the current image can coexist with four queued images.
      concurrentImageBytes.length = Math.min(concurrentImageBytes.length, SVR_SOURCE_PREFETCH_LIMIT + 1);
    }
    const seriesDecodeBytes = concurrentImageBytes.reduce((sum, bytes) => sum + bytes, 0);
    sourceDecodeBytes = Math.max(
      sourceDecodeBytes,
      missingDicomSize ? Math.max(seriesDecodeBytes, CORNERSTONE_MEMORY_FALLBACK_BYTES) : seriesDecodeBytes,
    );
  }
  const cacheInfo = options.cacheMemory?.cacheInfo ?? options.cacheInfo;
  const measured = cacheInfo?.cacheSizeInBytes;
  // Processing reuses but never populates the global cache. Only the bounded
  // current/prefetch batch overlaps decoding; it is not retained during compute.
  const decodedSourceCacheBytes =
    options.cacheMemory?.bytes ??
    (Number.isFinite(measured) && measured! >= 0 ? measured! : CORNERSTONE_MEMORY_FALLBACK_BYTES);
  // nativePlaneMemoryBytes separately reserves the current 17B/native-pixel
  // conversion/padding/crop peak and existing native browsing/display ownership.
  return { sourceBytes, decodedSourceCacheBytes, sourceDecodeBytes };
}
