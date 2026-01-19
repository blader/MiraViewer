import type { HistogramStats, PanelSettings } from '../types/api';
import { CONTROL_LIMITS, DEFAULT_PANEL_SETTINGS } from './constants';
import { clamp } from './math';

/**
 * Compute Normalized Cross-Correlation (NCC) between two grayscale images.
 * Both images must have the same dimensions.
 * Returns a value in range [-1, 1], where 1 is perfect correlation.
 *
 * NCC is invariant to linear brightness/contrast changes, making it ideal
 * for matching MRI slices that may have different intensity distributions.
 *
 * Formula: NCC = Σ((a - μa)(b - μb)) / (n * σa * σb)
 */
export function computeNCC(
  imageA: Float32Array,
  imageB: Float32Array,
  statsA?: { mean: number; stddev: number },
  statsB?: { mean: number; stddev: number }
): number {
  const n = imageA.length;
  if (n !== imageB.length || n === 0) {
    return 0;
  }

  // Compute means if not provided
  let meanA: number;
  let meanB: number;
  if (statsA) {
    meanA = statsA.mean;
  } else {
    let sumA = 0;
    for (let i = 0; i < n; i++) sumA += imageA[i];
    meanA = sumA / n;
  }
  if (statsB) {
    meanB = statsB.mean;
  } else {
    let sumB = 0;
    for (let i = 0; i < n; i++) sumB += imageB[i];
    meanB = sumB / n;
  }

  // Compute cross-correlation and stddevs in one pass
  let crossSum = 0;
  let sumSqA = 0;
  let sumSqB = 0;
  for (let i = 0; i < n; i++) {
    const diffA = imageA[i] - meanA;
    const diffB = imageB[i] - meanB;
    crossSum += diffA * diffB;
    sumSqA += diffA * diffA;
    sumSqB += diffB * diffB;
  }

  const stddevA = statsA?.stddev ?? Math.sqrt(sumSqA / n);
  const stddevB = statsB?.stddev ?? Math.sqrt(sumSqB / n);

  // Avoid division by zero
  if (stddevA < 1e-10 || stddevB < 1e-10) {
    return 0;
  }

  const ncc = crossSum / (n * stddevA * stddevB);
  return clamp(ncc, -1, 1);
}

/**
 * Result of the bidirectional slice search.
 */
export interface SliceSearchResult {
  bestIndex: number;
  bestNCC: number;
  slicesChecked: number;
}

/**
 * Bidirectional search to find the best matching slice.
 *
 * Strategy:
 * - Start at the normalized slice depth (refIndex/refCount mapped into targetCount)
 * - Search outward in both directions
 * - Stop in each direction only after 3 consecutive NCC decreases (per-direction)
 *
 * Rationale:
 * - NCC can be noisy across adjacent slices, so a single decrease is not sufficient to stop.
 * - We intentionally do NOT early-exit based on bestNCC, and we do NOT enforce a minimum
 *   search window. That keeps behavior deterministic and avoids premature termination when
 *   NCC happens to spike early.
 */
export async function findBestMatchingSlice(
  referencePixels: Float32Array,
  referenceStats: { mean: number; stddev: number },
  getTargetSlicePixels: (index: number) => Promise<Float32Array>,
  refSliceIndex: number,
  refSliceCount: number,
  targetSliceCount: number,
  onProgress?: (slicesChecked: number, bestNccSoFar: number) => void,
  startIndexOverride?: number
): Promise<SliceSearchResult> {
  if (targetSliceCount === 0) {
    return { bestIndex: 0, bestNCC: 0, slicesChecked: 0 };
  }

  const STOP_DECREASE_STREAK = 3; // require 3 consecutive decreases

  // Compute starting index from normalized position.
  //
  // Note: when series have different coverage / slice spacing, the normalized mapping can be
  // noticeably off. Callers can override the start index with a better guess (e.g. from a
  // coarse registration seed).
  const startIdx = Math.round((refSliceIndex / Math.max(1, refSliceCount - 1)) * (targetSliceCount - 1));
  const fallbackStart = clamp(startIdx, 0, targetSliceCount - 1);

  const clampedStart =
    typeof startIndexOverride === 'number' && Number.isFinite(startIndexOverride)
      ? clamp(Math.round(startIndexOverride), 0, targetSliceCount - 1)
      : fallbackStart;


  // Initialize with starting slice
  const startPixels = await getTargetSlicePixels(clampedStart);
  let bestIdx = clampedStart;
  let bestNCC = computeNCC(referencePixels, startPixels, referenceStats);
  let slicesChecked = 1;

  onProgress?.(slicesChecked, bestNCC);


  // Bidirectional search state
  let leftIdx = clampedStart - 1;
  let rightIdx = clampedStart + 1;

  let leftDone = leftIdx < 0;
  let rightDone = rightIdx >= targetSliceCount;

  let leftPrevNCC = bestNCC;
  let rightPrevNCC = bestNCC;

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
        const leftNCC = computeNCC(referencePixels, leftPixels, referenceStats);
        slicesChecked++;

        if (leftNCC > bestNCC) {
          bestNCC = leftNCC;
          bestIdx = idx;
        }

        // Track consecutive decreases in this direction.
        if (leftNCC < leftPrevNCC) {
          leftDecreaseStreak++;
        } else {
          leftDecreaseStreak = 0;
        }
        leftPrevNCC = leftNCC;

        leftIdx = idx - 1;
        if (leftIdx < 0) {
          leftDone = true;
        } else {
          // Stop only after N consecutive decreases.
          if (leftDecreaseStreak >= STOP_DECREASE_STREAK) {
            leftDone = true;
          }
        }

        onProgress?.(slicesChecked, bestNCC);

      }
    }

    // Search right
    if (!rightDone) {
      const idx = rightIdx;
      if (idx >= targetSliceCount) {
        rightDone = true;
      } else {
        const rightPixels = await getTargetSlicePixels(idx);
        const rightNCC = computeNCC(referencePixels, rightPixels, referenceStats);
        slicesChecked++;

        if (rightNCC > bestNCC) {
          bestNCC = rightNCC;
          bestIdx = idx;
        }

        if (rightNCC < rightPrevNCC) {
          rightDecreaseStreak++;
        } else {
          rightDecreaseStreak = 0;
        }
        rightPrevNCC = rightNCC;

        rightIdx = idx + 1;
        if (rightIdx >= targetSliceCount) {
          rightDone = true;
        } else {
          if (rightDecreaseStreak >= STOP_DECREASE_STREAK) {
            rightDone = true;
          }
        }

        onProgress?.(slicesChecked, bestNCC);

      }
    }
  }

  return { bestIndex: bestIdx, bestNCC, slicesChecked };
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
