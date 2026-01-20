import type { ExclusionMask, HistogramStats, PanelSettings } from '../types/api';
import { CONTROL_LIMITS, DEFAULT_PANEL_SETTINGS } from './constants';
import { clamp } from './math';
import { computeMutualInformation, type MutualInformationOptions } from './mutualInformation';

/**
 * Compute normalized mutual information (NMI) between two grayscale images.
 *
 * Notes:
 * - Higher is better.
 * - NMI is commonly used as a registration quality metric because it can be more robust than
 *   correlation-based metrics when intensity mappings differ.
 */
export function computeNMI(imageA: Float32Array, imageB: Float32Array, bins: number = 64): number {
  return computeMutualInformation(imageA, imageB, bins).nmi;
}

/**
 * Result of the bidirectional slice search.
 */
export interface SliceSearchResult {
  bestIndex: number;
  /** Mutual information (natural log). Higher is better. */
  bestMI: number;
  slicesChecked: number;
  /** Optional perf counters for profiling/debugging. */
  timingMs?: {
    /** Time spent computing MI/NMI scores (excludes rendering / warping). */
    scoreMs: number;
  };
}

type SliceScoreDirection = 'start' | 'left' | 'right';

type FindBestMatchingSliceOptions = {
  /** Override the starting index with a better initial guess (e.g. from a coarse seed). */
  startIndexOverride?: number;
  /** Histogram bins for MI/NMI scoring. Lower values are faster but less sensitive. */
  miBins?: number;
  /** How many consecutive decreases are required before stopping a direction. */
  stopDecreaseStreak?: number;
  /** Optional hook for logging or debugging slice-level scores. */
  onSliceScored?: (index: number, metrics: { mi: number; nmi: number }, direction: SliceScoreDirection) => void;
  /**
   * Optional exclusion rectangle in normalized [0,1] image coordinates.
   * Pixels inside this rect are excluded from MI scoring (useful for ignoring tumors).
   */
  exclusionRect?: ExclusionMask;
  /** Image width in pixels (required if exclusionRect is provided). */
  imageWidth?: number;
  /** Image height in pixels (required if exclusionRect is provided). */
  imageHeight?: number;
};

function nowMs(): number {
  return typeof performance !== 'undefined' && typeof performance.now === 'function' ? performance.now() : Date.now();
}

/**
 * Bidirectional search to find the best matching slice.
 *
 * Strategy:
 * - Start at the normalized slice depth (refIndex/refCount mapped into targetCount)
 * - Search outward in both directions
 * - Stop in each direction only after N consecutive MI decreases (per-direction)
 *
 * Rationale:
 * - Adjacent slices can be noisy; a single decrease is not sufficient to stop.
 * - We intentionally do NOT early-exit based on bestMI, and we do NOT enforce a minimum
 *   search window. That keeps behavior deterministic and avoids premature termination when
 *   MI happens to spike early.
 */
export async function findBestMatchingSlice(
  referencePixels: Float32Array,
  getTargetSlicePixels: (index: number) => Promise<Float32Array>,
  refSliceIndex: number,
  refSliceCount: number,
  targetSliceCount: number,
  onProgress?: (slicesChecked: number, bestMiSoFar: number) => void,
  options?: FindBestMatchingSliceOptions
): Promise<SliceSearchResult> {
  if (targetSliceCount === 0) {
    return { bestIndex: 0, bestMI: 0, slicesChecked: 0, timingMs: { scoreMs: 0 } };
  }

  const STOP_DECREASE_STREAK = options?.stopDecreaseStreak ?? 2;
  const MI_BINS = options?.miBins ?? 64;
  const exclusionRect = options?.exclusionRect;
  const imageWidth = options?.imageWidth;
  const imageHeight = options?.imageHeight;

  let scoreMs = 0;
  const computeMetrics = (targetPixels: Float32Array): { mi: number; nmi: number } => {
    const t0 = nowMs();

    // We compute MI + NMI together from the histogram.
    // If an exclusion rect is provided, skip those pixels.
    const miOptions: MutualInformationOptions = {
      bins: MI_BINS,
      exclusionRect,
      imageWidth,
      imageHeight,
    };
    const miResult = computeMutualInformation(referencePixels, targetPixels, miOptions);

    scoreMs += nowMs() - t0;

    return { mi: miResult.mi, nmi: miResult.nmi };
  };

  // Compute starting index from normalized position.
  //
  // Note: when series have different coverage / slice spacing, the normalized mapping can be
  // noticeably off. Callers can override the start index with a better guess (e.g. from a
  // coarse registration seed).
  const startIdx = Math.round((refSliceIndex / Math.max(1, refSliceCount - 1)) * (targetSliceCount - 1));
  const fallbackStart = clamp(startIdx, 0, targetSliceCount - 1);

  const startIndexOverride = options?.startIndexOverride;

  const clampedStart =
    typeof startIndexOverride === 'number' && Number.isFinite(startIndexOverride)
      ? clamp(Math.round(startIndexOverride), 0, targetSliceCount - 1)
      : fallbackStart;

  // Initialize with starting slice
  const startPixels = await getTargetSlicePixels(clampedStart);
  let bestIdx = clampedStart;
  const startMetrics = computeMetrics(startPixels);
  let bestMI = startMetrics.mi;
  let slicesChecked = 1;

  options?.onSliceScored?.(clampedStart, startMetrics, 'start');
  onProgress?.(slicesChecked, bestMI);

  // Bidirectional search state
  let leftIdx = clampedStart - 1;
  let rightIdx = clampedStart + 1;

  let leftDone = leftIdx < 0;
  let rightDone = rightIdx >= targetSliceCount;

  let leftPrevMI = bestMI;
  let rightPrevMI = bestMI;

  let leftDecreaseStreak = 0;
  let rightDecreaseStreak = 0;

  while (!leftDone || !rightDone) {
    // Search left
    if (!leftDone) {
      const idx = leftIdx;
      if (idx < 0) {
        leftDone = true;
      } else {
        const leftPixels = await getTargetSlicePixels(idx);
        const leftMetrics = computeMetrics(leftPixels);
        const leftMI = leftMetrics.mi;
        slicesChecked++;

        options?.onSliceScored?.(idx, leftMetrics, 'left');

        if (leftMI > bestMI) {
          bestMI = leftMI;
          bestIdx = idx;
        }

        // Track consecutive decreases in this direction.
        if (leftMI < leftPrevMI) {
          leftDecreaseStreak++;
        } else {
          leftDecreaseStreak = 0;
        }
        leftPrevMI = leftMI;

        leftIdx = idx - 1;
        if (leftIdx < 0) {
          leftDone = true;
        } else {
          // Stop only after N consecutive decreases.
          if (leftDecreaseStreak >= STOP_DECREASE_STREAK) {
            leftDone = true;
          }
        }

        onProgress?.(slicesChecked, bestMI);
      }
    }

    // Search right
    if (!rightDone) {
      const idx = rightIdx;
      if (idx >= targetSliceCount) {
        rightDone = true;
      } else {
        const rightPixels = await getTargetSlicePixels(idx);
        const rightMetrics = computeMetrics(rightPixels);
        const rightMI = rightMetrics.mi;
        slicesChecked++;

        options?.onSliceScored?.(idx, rightMetrics, 'right');

        if (rightMI > bestMI) {
          bestMI = rightMI;
          bestIdx = idx;
        }

        if (rightMI < rightPrevMI) {
          rightDecreaseStreak++;
        } else {
          rightDecreaseStreak = 0;
        }
        rightPrevMI = rightMI;

        rightIdx = idx + 1;
        if (rightIdx >= targetSliceCount) {
          rightDone = true;
        } else {
          if (rightDecreaseStreak >= STOP_DECREASE_STREAK) {
            rightDone = true;
          }
        }

        onProgress?.(slicesChecked, bestMI);
      }
    }
  }

  return { bestIndex: bestIdx, bestMI, slicesChecked, timingMs: { scoreMs } };
}

/**
 * Compute brightness and contrast values to match a target slice to a displayed reference.
 *
 * IMPORTANT: CSS filter order matters. In our viewer we use:
 *   filter: brightness(b) contrast(c)
 * which means brightness is applied first, then contrast.
 *
 * For normalized pixels in [0, 1] and b/c in [0, 2]:
 *   x = in * b
 *   out = (x - 0.5) * c + 0.5
 *       = in * (b*c) + 0.5 * (1 - c)
 *
 * This is an affine transform: out = a * in + d
 *   a = b*c
 *   d = 0.5 * (1 - c)
 *
 * Using mean/stddev matching:
 *   std_out = a * std_in
 *   mean_out = a * mean_in + d
 *
 * Solve for a, c, b:
 *   a = std_ref / std_in
 *   c = 1 - 2 * (mean_ref - a * mean_in)
 *   b = a / c
 *
 * Note: We clamp b/c to UI limits; clamping means the match is approximate.
 */
export function computeIntensityMatch(
  refStats: HistogramStats,
  targetStats: HistogramStats
): { brightness: number; contrast: number } {
  const eps = 1e-10;

  if (targetStats.stddev < eps) {
    return { brightness: 100, contrast: 100 };
  }

  // Overall scale needed to match stddev.
  const a = refStats.stddev / targetStats.stddev;

  // Solve contrast first (because it also affects offset).
  // c = 1 - 2*(mean_ref - a*mean_target)
  const c = 1 - 2 * (refStats.mean - a * targetStats.mean);

  if (!Number.isFinite(c) || Math.abs(c) < eps) {
    // Degenerate; fall back to neutral.
    return { brightness: 100, contrast: 100 };
  }

  const b = a / c;

  const contrast = clamp(c * 100, CONTROL_LIMITS.CONTRAST.MIN, CONTROL_LIMITS.CONTRAST.MAX);
  const brightness = clamp(b * 100, CONTROL_LIMITS.BRIGHTNESS.MIN, CONTROL_LIMITS.BRIGHTNESS.MAX);

  return { brightness: Math.round(brightness), contrast: Math.round(contrast) };
}

/**
 * Compute the offset value needed to make a slice index match the current progress.
 *
 * The viewer uses: displayedIndex = round(progress * (count - 1)) + offset
 * We want: displayedIndex = targetSliceIndex
 * So: offset = targetSliceIndex - round(progress * (count - 1))
 */
export function computeSliceOffset(
  targetSliceIndex: number,
  targetSliceCount: number,
  currentProgress: number
): number {
  const baseIndex = Math.round(currentProgress * Math.max(0, targetSliceCount - 1));
  return targetSliceIndex - baseIndex;
}

/**
 * Compute complete panel settings to align a target date to the reference.
 */
export function computeAlignedSettings(
  refStats: HistogramStats,
  targetStats: HistogramStats,
  targetSliceIndex: number,
  targetSliceCount: number,
  currentProgress: number,
  geometry: Pick<
    PanelSettings,
    'zoom' | 'rotation' | 'panX' | 'panY' | 'affine00' | 'affine01' | 'affine10' | 'affine11'
  >
): PanelSettings {
  const { brightness, contrast } = computeIntensityMatch(refStats, targetStats);
  const offset = computeSliceOffset(targetSliceIndex, targetSliceCount, currentProgress);

  return {
    ...DEFAULT_PANEL_SETTINGS,
    offset,
    brightness,
    contrast,
    // Use recovered geometry settings for the target date.
    zoom: geometry.zoom,
    rotation: geometry.rotation,
    panX: geometry.panX,
    panY: geometry.panY,
    affine00: geometry.affine00,
    affine01: geometry.affine01,
    affine10: geometry.affine10,
    affine11: geometry.affine11,
    // Preserve progress
    progress: currentProgress,
  };
}
