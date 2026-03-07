import type { SvrPreviewImages } from '../../types/svr';
import type { VolumeDims } from './trilinear';

function clamp01(x: number): number {
  return x < 0 ? 0 : x > 1 ? 1 : x;
}

function sliceToImageData(params: {
  width: number;
  height: number;
  getValue: (x: number, y: number) => number;
}): ImageData {
  const { width, height, getValue } = params;

  const img = new ImageData(width, height);
  const data = img.data;

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const v = clamp01(getValue(x, y));
      const b = Math.round(v * 255);
      const idx = (y * width + x) * 4;
      data[idx] = b;
      data[idx + 1] = b;
      data[idx + 2] = b;
      data[idx + 3] = 255;
    }
  }

  return img;
}

async function imageDataToPng(imageData: ImageData, maxSize: number): Promise<Blob> {
  const srcCanvas = document.createElement('canvas');
  srcCanvas.width = imageData.width;
  srcCanvas.height = imageData.height;
  const srcCtx = srcCanvas.getContext('2d');
  if (!srcCtx) throw new Error('Failed to get canvas context');
  srcCtx.putImageData(imageData, 0, 0);

  const maxDim = Math.max(imageData.width, imageData.height);
  const scale = maxDim > maxSize ? maxSize / maxDim : 1;

  const outCanvas = document.createElement('canvas');
  outCanvas.width = Math.max(1, Math.round(imageData.width * scale));
  outCanvas.height = Math.max(1, Math.round(imageData.height * scale));

  const outCtx = outCanvas.getContext('2d');
  if (!outCtx) throw new Error('Failed to get canvas context');
  outCtx.imageSmoothingEnabled = true;
  outCtx.imageSmoothingQuality = 'high';
  outCtx.drawImage(srcCanvas, 0, 0, outCanvas.width, outCanvas.height);

  return await new Promise<Blob>((resolve, reject) => {
    outCanvas.toBlob((blob) => {
      if (blob) resolve(blob);
      else reject(new Error('Failed to encode PNG')); 
    }, 'image/png');
  });
}

export async function generateVolumePreviews(params: {
  volume: Float32Array;
  dims: VolumeDims;
  maxSize: number;
}): Promise<SvrPreviewImages> {
  const { volume, dims, maxSize } = params;
  const { nx, ny, nz } = dims;

  if (typeof document === 'undefined') {
    throw new Error('generateVolumePreviews requires a DOM');
  }

  const midX = Math.floor(nx / 2);
  const midY = Math.floor(ny / 2);
  const midZ = Math.floor(nz / 2);

  const strideXY = nx * ny;

  // Axial: X (width) × Y (height) at Z=mid
  const axial = sliceToImageData({
    width: nx,
    height: ny,
    getValue: (x, y) => volume[x + y * nx + midZ * strideXY] ?? 0,
  });

  // Coronal: X (width) × Z (height) at Y=mid
  const coronal = sliceToImageData({
    width: nx,
    height: nz,
    getValue: (x, z) => volume[x + midY * nx + z * strideXY] ?? 0,
  });

  // Sagittal: Y (width) × Z (height) at X=mid
  const sagittal = sliceToImageData({
    width: ny,
    height: nz,
    getValue: (y, z) => volume[midX + y * nx + z * strideXY] ?? 0,
  });

  const [axialPng, coronalPng, sagittalPng] = await Promise.all([
    imageDataToPng(axial, maxSize),
    imageDataToPng(coronal, maxSize),
    imageDataToPng(sagittal, maxSize),
  ]);

  return {
    axial: axialPng,
    coronal: coronalPng,
    sagittal: sagittalPng,
  };
}
