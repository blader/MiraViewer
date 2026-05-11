export type GrayscaleImage = {
  gray: Uint8Array;
  width: number;
  height: number;
};

function toGrayscaleByte(r: number, g: number, b: number): number {
  return Math.round(0.2126 * r + 0.7152 * g + 0.0722 * b);
}

async function decodePngBlobToImageData(blob: Blob): Promise<ImageData> {
  // Prefer createImageBitmap (fast); fall back to <img> decoding for broader compatibility.
  try {
    const bitmap = await createImageBitmap(blob);
    const canvas = document.createElement('canvas');
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('Failed to create canvas context');
    ctx.drawImage(bitmap, 0, 0);
    return ctx.getImageData(0, 0, canvas.width, canvas.height);
  } catch {
    const url = URL.createObjectURL(blob);
    try {
      const img = new Image();
      img.decoding = 'async';
      img.src = url;

      if (typeof img.decode === 'function') {
        await img.decode();
      } else {
        await new Promise<void>((resolve, reject) => {
          img.onload = () => resolve();
          img.onerror = () => reject(new Error('Failed to decode PNG'));
        });
      }

      const canvas = document.createElement('canvas');
      canvas.width = img.naturalWidth;
      canvas.height = img.naturalHeight;
      const ctx = canvas.getContext('2d');
      if (!ctx) throw new Error('Failed to create canvas context');
      ctx.drawImage(img, 0, 0);
      return ctx.getImageData(0, 0, canvas.width, canvas.height);
    } finally {
      URL.revokeObjectURL(url);
    }
  }
}

export async function decodeCapturedPngToGrayscale(png: Blob): Promise<GrayscaleImage> {
  const imageData = await decodePngBlobToImageData(png);
  const w = imageData.width;
  const h = imageData.height;

  const gray = new Uint8Array(w * h);
  const d = imageData.data;
  for (let i = 0, p = 0; i < d.length; i += 4, p++) {
    gray[p] = toGrayscaleByte(d[i], d[i + 1], d[i + 2]);
  }

  return { gray, width: w, height: h };
}
