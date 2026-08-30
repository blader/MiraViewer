import cornerstone from 'cornerstone-core';
import cornerstoneWADOImageLoader from 'cornerstone-wado-image-loader';
import cornerstoneTools from 'cornerstone-tools';
import cornerstoneMath from 'cornerstone-math';
import Hammer from 'hammerjs';
import dicomParser from 'dicom-parser';
import { getDB } from '../db/db';
import { getDerivedAlignmentFrameByImageId } from './derivedAlignmentFrame';
import { createDerivedImagePresentation } from './derivedImagePresentation';

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
      const image = await cornerstone.loadImage(fileImageId);
      if (instance.pixelPaddingValue !== undefined) {
        Object.assign(image, {
          pixelPaddingValue: instance.pixelPaddingValue,
          pixelPaddingRangeLimit: instance.pixelPaddingRangeLimit,
        });
      }
      return image;
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
        // WADO caches by parsed URL ("0"), not image ID ("dicomfile:0").
        const dataSetKey = cornerstoneWADOImageLoader.wadouri.parseImageId(fileImageId).url;
        cornerstoneWADOImageLoader.wadouri?.dataSetCacheManager?.unload?.(dataSetKey);
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

function miraDerivedLoader(imageId: string) {
  return {
    promise: (async () => {
      const frame = getDerivedAlignmentFrameByImageId(imageId);
      if (!frame) throw new Error('The derived registration frame is no longer available');
      return createDerivedImagePresentation(frame, imageId);
    })(),
  };
}

export function initCornerstone() {
  if (initialized) return;

  // Register custom loader
  cornerstone.registerImageLoader('miradb', miraDbLoader);
  cornerstone.registerImageLoader('miraderived', miraDerivedLoader);

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

  // The installed bundled WADO loader includes its JPEG-lossless worker and codecs. Start workers
  // lazily and cap concurrency so compressed MRI decoding works offline without untracked assets.
  cornerstoneWADOImageLoader.webWorkerManager?.initialize?.({
    maxWebWorkers: Math.max(1, Math.min(4, navigator.hardwareConcurrency || 1)),
    startWebWorkersOnDemand: true,
    taskConfiguration: {
      decodeTask: {
        initializeCodecsOnStartup: false,
        strict: false,
      },
    },
  });

  initialized = true;
}
