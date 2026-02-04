import cornerstone from 'cornerstone-core';
import type { NormalizedPoint, TumorPolygon, TumorThreshold, ViewerTransform } from '../db/schema';
import { getSortedSopInstanceUidsForSeries, saveTumorSegmentation } from './localApi';
import type { SegmentTumorOptions } from './segmentation/segmentTumor';
import { imageNormToViewerNorm, viewerNormToImageNorm } from './viewportMapping';
import { propagateTumorAcrossFramesCore } from './tumorPropagationCore';
import { remapPointBetweenViewerTransforms, type ViewportSize } from './viewTransform';

type CornerstoneImageLike = {
  rows: number;
  columns: number;
  getPixelData: () => ArrayLike<number>;
  minPixelValue?: number;
  maxPixelValue?: number;
};

const IDENTITY_VIEWER_TRANSFORM: ViewerTransform = {
  zoom: 1,
  rotation: 0,
  panX: 0,
  panY: 0,
  affine00: 1,
  affine01: 0,
  affine10: 0,
  affine11: 1,
};

function clamp01(v: number) {
  return Math.max(0, Math.min(1, v));
}

function toByte(v: number) {
  return Math.max(0, Math.min(255, Math.round(v)));
}

function normalizeToByteArray(pixelData: ArrayLike<number>, min: number, max: number): Uint8Array {
  const n = pixelData.length;
  const out = new Uint8Array(n);
  const denom = max - min;
  if (!Number.isFinite(denom) || Math.abs(denom) < 1e-8) {
    out.fill(0);
    return out;
  }

  for (let i = 0; i < n; i++) {
    const t = (pixelData[i] - min) / denom;
    out[i] = toByte(t * 255);
  }
  return out;
}


export type PropagateAcrossSeriesInput = {
  comboId: string;
  dateIso: string;
  studyId: string;
  seriesUid: string;

  /** Size of the viewer viewport (used to map between viewer coords and image coords). */
  viewportSize: ViewportSize;

  /** Starting slice index in effective series ordering (0..N-1). */
  startEffectiveIndex: number;

  /** Seed point in normalized *viewer* coordinates. */
  seed: NormalizedPoint;

  /** Viewer transform that `seed` was authored under. Defaults to identity. */
  seedViewTransform?: ViewerTransform;

  threshold: TumorThreshold;

  /** Optional segmentation option overrides during propagation. */
  opts?: SegmentTumorOptions;

  stop: {
    minAreaPx: number;
    maxMissesInARow: number;
  };

  onProgress?: (p: { direction: 'left' | 'right'; index: number; saved: number; misses: number }) => void;
};

export async function propagateTumorAcrossSeries(input: PropagateAcrossSeriesInput): Promise<{ saved: number }> {
  const uids = await getSortedSopInstanceUidsForSeries(input.seriesUid);
  const n = uids.length;
  if (n <= 0) return { saved: 0 };

  const viewSize = input.viewportSize;
  if (viewSize.w <= 0 || viewSize.h <= 0) {
    throw new Error('Viewer size not available for propagation');
  }

  // Remap the stored seed back into the identity viewer transform.
  const seedView = remapPointBetweenViewerTransforms(
    input.seed,
    viewSize,
    input.seedViewTransform ?? IDENTITY_VIEWER_TRANSFORM,
    IDENTITY_VIEWER_TRANSFORM
  );

  const start = Math.max(0, Math.min(n - 1, input.startEffectiveIndex));

  const getFrame = async (index: number) => {
    const sop = uids[index];
    if (!sop) return null;

    const imageId = `miradb:${sop}`;
    const image = (await cornerstone.loadImage(imageId)) as unknown as CornerstoneImageLike;

    const rows = image.rows;
    const cols = image.columns;
    const getPixelData = image.getPixelData;
    if (!rows || !cols || typeof getPixelData !== 'function') {
      return null;
    }

    const imgSize = { w: cols, h: rows };
    const seedImg = viewerNormToImageNorm(seedView, viewSize, imgSize);

    // Seed jitter: add a small cross around the centroid to make region growing less brittle.
    // Ensure the jitter moves at least ~1 pixel in either direction.
    const jitter = Math.max(0.002, 1 / Math.max(cols, rows));
    const seedPointsImg: NormalizedPoint[] = [
      { x: clamp01(seedImg.x), y: clamp01(seedImg.y) },
      { x: clamp01(seedImg.x + jitter), y: clamp01(seedImg.y) },
      { x: clamp01(seedImg.x - jitter), y: clamp01(seedImg.y) },
      { x: clamp01(seedImg.x), y: clamp01(seedImg.y + jitter) },
      { x: clamp01(seedImg.x), y: clamp01(seedImg.y - jitter) },
    ];

    const pd = getPixelData();

    let min =
      typeof image.minPixelValue === 'number' && Number.isFinite(image.minPixelValue)
        ? image.minPixelValue
        : Number.POSITIVE_INFINITY;
    let max =
      typeof image.maxPixelValue === 'number' && Number.isFinite(image.maxPixelValue)
        ? image.maxPixelValue
        : Number.NEGATIVE_INFINITY;

    if (!Number.isFinite(min) || !Number.isFinite(max)) {
      min = Number.POSITIVE_INFINITY;
      max = Number.NEGATIVE_INFINITY;
      for (let j = 0; j < pd.length; j++) {
        const v = pd[j];
        if (v < min) min = v;
        if (v > max) max = v;
      }
    }

    const gray = normalizeToByteArray(pd, min, max);

    return {
      sopInstanceUid: sop,
      w: cols,
      h: rows,
      gray,
      seedPointsNorm: seedPointsImg,
    };
  };

  const viewportSize = { w: Math.round(viewSize.w), h: Math.round(viewSize.h) };

  const res = await propagateTumorAcrossFramesCore({
    minIndex: 0,
    maxIndex: n - 1,
    startEffectiveIndex: start,
    getFrame,
    threshold: input.threshold,
    opts: input.opts,
    stop: input.stop,
    onProgress: input.onProgress,
    onAcceptedResult: async ({ sopInstanceUid, segmentation }) => {
      if (!sopInstanceUid) {
        throw new Error('Missing SOPInstanceUID for propagated slice');
      }

      const imgSize = { w: segmentation.meta.imageWidth, h: segmentation.meta.imageHeight };

      // Convert the predicted polygon/seed into normalized viewer coordinates under an identity transform,
      // so it can later be re-projected correctly under pan/zoom/rotation/affine.
      const polygonViewer: TumorPolygon = {
        points: segmentation.polygon.points.map((p) => imageNormToViewerNorm(p, viewSize, imgSize)),
      };
      const seedViewer = imageNormToViewerNorm(segmentation.seed, viewSize, imgSize);

      await saveTumorSegmentation({
        comboId: input.comboId,
        dateIso: input.dateIso,
        studyId: input.studyId,
        seriesUid: input.seriesUid,
        sopInstanceUid,
        polygon: polygonViewer,
        threshold: input.threshold,
        seed: seedViewer,
        meta: {
          areaPx: segmentation.meta.areaPx,
          areaNorm: segmentation.meta.areaNorm,
          viewTransform: IDENTITY_VIEWER_TRANSFORM,
          viewportSize,
        },
        algorithmVersion: 'v2-propagation-viewer-seed-remap',
      });
    },
  });

  return { saved: res.saved };
}
