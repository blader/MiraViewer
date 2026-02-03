import cornerstone from 'cornerstone-core';
import cornerstoneWADOImageLoader from 'cornerstone-wado-image-loader';
import cornerstoneTools from 'cornerstone-tools';
import cornerstoneMath from 'cornerstone-math';
import Hammer from 'hammerjs';
import dicomParser from 'dicom-parser';
import { getDB } from '../db/db';

// Configure external dependencies
cornerstoneWADOImageLoader.external.cornerstone = cornerstone;
cornerstoneWADOImageLoader.external.dicomParser = dicomParser;
cornerstoneTools.external.cornerstone = cornerstone;
cornerstoneTools.external.Hammer = Hammer;
cornerstoneTools.external.cornerstoneMath = cornerstoneMath;

let initialized = false;

function miraDbLoader(imageId: string) {
  // imageId format: "miradb:<sopInstanceUid>"
  const sopInstanceUid = imageId.split(':')[1];

  // Cornerstone image loaders must return an object with a `promise` property
  const promise = (async () => {
    const db = await getDB();
    const instance = await db.get('instances', sopInstanceUid);

    if (!instance) {
      throw new Error(`Instance not found: ${sopInstanceUid}`);
    }

    // Add the file Blob to the WADO loader's fileManager to get a local file imageId.
    // NOTE: The WADO loader can cache both the decoded image and the parsed DICOM dataset.
    // If we don't clean these up, repeated loads (e.g. SVR decoding hundreds of slices)
    // can create large memory spikes.
    const fileImageId = cornerstoneWADOImageLoader.wadouri.fileManager.add(instance.fileBlob);

    try {
      // Delegate to the WADO URI loader and await its result.
      return await cornerstone.loadImage(fileImageId);
    } finally {
      // Best-effort cleanup:
      // - Remove the inner fileImageId from Cornerstone's image cache (the outer `miradb:`
      //   imageId is the one we actually want cached for interactive viewing).
      // - Unload the parsed dataset.
      // - Remove the Blob from the fileManager.
      try {
        cornerstone.imageCache?.removeImageLoadObject?.(fileImageId);
      } catch {
        // Ignore.
      }

      try {
        cornerstoneWADOImageLoader.wadouri?.dataSetCacheManager?.unload?.(fileImageId);
      } catch {
        // Ignore.
      }

      try {
        const idxStr = fileImageId.split(':')[1] ?? '';
        const idx = Number(idxStr);
        if (Number.isFinite(idx)) {
          cornerstoneWADOImageLoader.wadouri?.fileManager?.remove?.(idx);
        }
      } catch {
        // Ignore.
      }
    }
  })();

  return {
    promise,
  };
}

export function initCornerstone() {
  if (initialized) return;

  // Register custom loader
  cornerstone.registerImageLoader('miradb', miraDbLoader);

  // Configure cache limits.
  // IMPORTANT: Cornerstone's global image cache can otherwise grow without bound.
  // We keep this conservative and allow power users to override via localStorage.
  try {
    if (typeof window !== 'undefined') {
      const key = 'miraviewer:cornerstone-cache-mib';
      const raw = window.localStorage.getItem(key);

      // Default cache size: 256MiB.
      const fallbackMiB = 256;
      const mib = raw ? Math.max(32, Math.min(2048, Math.round(Number(raw)))) : fallbackMiB;
      const bytes = mib * 1024 * 1024;

      cornerstone.imageCache?.setMaximumSizeBytes?.(bytes);
      console.info('[cornerstone] imageCache.setMaximumSizeBytes', { mib });
    }
  } catch {
    // Ignore.
  }

  // Initialize tools
  cornerstoneTools.init();

  // Configure web worker (optional but recommended for performance)
  // We might need to point to the worker files in public/ or node_modules
  // For now, we'll try without explicit worker config or assume default locations

  initialized = true;
}
