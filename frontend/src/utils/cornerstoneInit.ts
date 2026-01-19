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
    
    // Add the file to the fileManager to get a local file imageId
    // cornerstone-wado-image-loader will handle the parsing
    const fileImageId = cornerstoneWADOImageLoader.wadouri.fileManager.add(instance.fileBlob);
    
    // Delegate to the WADO URI loader and await its result
    const image = await cornerstone.loadImage(fileImageId);
    return image;
  })();
  
  return {
    promise,
  };
}

export function initCornerstone() {
  if (initialized) return;
  
  // Register custom loader
  cornerstone.registerImageLoader('miradb', miraDbLoader);
  
  // Initialize tools
  cornerstoneTools.init();
  
  // Configure web worker (optional but recommended for performance)
  // We might need to point to the worker files in public/ or node_modules
  // For now, we'll try without explicit worker config or assume default locations
  
  initialized = true;
}
