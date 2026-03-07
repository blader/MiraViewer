import type { NormalizedPoint, TumorPolygon, TumorThreshold } from '../db/schema';
import type { SegmentTumorOptions, SegmentationResult } from './segmentation/segmentTumor';
import { segmentTumorFromGrayscale } from './segmentation/segmentTumor';

export type PropagationFrame = {
  sopInstanceUid?: string;
  w: number;
  h: number;
  gray: Uint8Array;
  /** Seed/paint points in normalized image coords (0..1). */
  seedPointsNorm: NormalizedPoint[];
};

export type PropagateTumorCoreInput = {
  minIndex: number;
  maxIndex: number;
  startEffectiveIndex: number;

  getFrame: (effectiveIndex: number) => Promise<PropagationFrame | null>;

  threshold: TumorThreshold;
  opts?: SegmentTumorOptions;

  stop: {
    minAreaPx: number;
    maxMissesInARow: number;
  };

  onProgress?: (p: { direction: 'left' | 'right'; index: number; saved: number; misses: number }) => void;

  /** Optional callback invoked when a slice segmentation is accepted (area >= minAreaPx). */
  onAcceptedResult?: (r: {
    direction: 'left' | 'right';
    index: number;
    sopInstanceUid?: string;
    segmentation: SegmentationResult;
  }) => Promise<void> | void;
};

export type PropagateTumorCoreResult = {
  saved: number;
  results: Array<{ index: number; sopInstanceUid?: string; segmentation: SegmentationResult }>;
};

export async function propagateTumorAcrossFramesCore(input: PropagateTumorCoreInput): Promise<PropagateTumorCoreResult> {
  const minIndex = Math.min(input.minIndex, input.maxIndex);
  const maxIndex = Math.max(input.minIndex, input.maxIndex);

  const start = Math.max(minIndex, Math.min(maxIndex, Math.round(input.startEffectiveIndex)));

  let saved = 0;
  const results: PropagateTumorCoreResult['results'] = [];

  const runDir = async (direction: 'left' | 'right') => {
    let misses = 0;
    const step = direction === 'left' ? -1 : 1;

    for (let i = start + step; i >= minIndex && i <= maxIndex; i += step) {
      try {
        const frame = await input.getFrame(i);
        if (!frame) {
          misses++;
          input.onProgress?.({ direction, index: i, saved, misses });
          if (misses >= input.stop.maxMissesInARow) break;
          continue;
        }

        const { gray, w, h, seedPointsNorm } = frame;
        const seg = segmentTumorFromGrayscale(gray, w, h, seedPointsNorm, input.threshold, input.opts);

        if (seg.meta.areaPx < input.stop.minAreaPx) {
          misses++;
          input.onProgress?.({ direction, index: i, saved, misses });
          if (misses >= input.stop.maxMissesInARow) break;
          continue;
        }

        // Allow the caller to persist/stream results. If it throws, treat it like a miss (same behavior
        // as the old propagation adapter which wrapped segmentation+save in a try/catch).
        if (input.onAcceptedResult) {
          await input.onAcceptedResult({
            direction,
            index: i,
            sopInstanceUid: frame.sopInstanceUid,
            segmentation: seg,
          });
        }

        results.push({ index: i, sopInstanceUid: frame.sopInstanceUid, segmentation: seg });
        saved++;
        misses = 0;
        input.onProgress?.({ direction, index: i, saved, misses });
      } catch (e) {
        console.warn('[propagateTumorAcrossFramesCore] Failed slice', direction, i, e);
        misses++;
        input.onProgress?.({ direction, index: i, saved, misses });
        if (misses >= input.stop.maxMissesInARow) break;
      }
    }
  };

  await runDir('left');
  await runDir('right');

  return { saved, results };
}

// Backwards-compatible helper for harness code that wants polygons without the full segmentation result.
export function getPolygonsByIndexFromCoreResult(res: PropagateTumorCoreResult): Map<number, TumorPolygon> {
  const out = new Map<number, TumorPolygon>();
  for (const r of res.results) {
    out.set(r.index, r.segmentation.polygon);
  }
  return out;
}
