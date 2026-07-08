import type { HistogramStats, PanelSettings } from '../types/api';
import { CONTROL_LIMITS, DEFAULT_PANEL_SETTINGS } from './constants';
import { clamp } from './math';

export type BoundedSliceCandidate<T> = {
  index: number;
  value: T;
};

export async function collectBoundedSliceCandidates<T>(params: {
  minIndex: number;
  maxIndex: number;
  startIndex: number;
  scoreSlice: (index: number) => Promise<T>;
  onScored?: (candidate: BoundedSliceCandidate<T>, scoredCount: number) => void;
  yieldEvery?: number;
  yieldFn?: () => Promise<void>;
}): Promise<Array<BoundedSliceCandidate<T>>> {
  const minIndex = Math.round(params.minIndex);
  const maxIndex = Math.round(params.maxIndex);
  if (!Number.isFinite(minIndex) || !Number.isFinite(maxIndex) || minIndex > maxIndex) {
    throw new Error(`collectBoundedSliceCandidates: minIndex must be <= maxIndex (${minIndex} > ${maxIndex})`);
  }

  const startIndex = clamp(Math.round(params.startIndex), minIndex, maxIndex);
  const yieldEvery = Math.max(0, Math.round(params.yieldEvery ?? 0));
  const candidates: Array<BoundedSliceCandidate<T>> = [];
  let scoredCount = 0;

  const scoreIndex = async (index: number) => {
    const candidate = { index, value: await params.scoreSlice(index) };
    candidates.push(candidate);
    scoredCount++;
    params.onScored?.(candidate, scoredCount);
    if (yieldEvery > 0 && params.yieldFn && scoredCount % yieldEvery === 0) {
      await params.yieldFn();
    }
  };

  await scoreIndex(startIndex);
  for (let distance = 1; startIndex - distance >= minIndex || startIndex + distance <= maxIndex; distance++) {
    const left = startIndex - distance;
    if (left >= minIndex) await scoreIndex(left);
    const right = startIndex + distance;
    if (right <= maxIndex) await scoreIndex(right);
  }

  candidates.sort((a, b) => a.index - b.index);
  return candidates;
}

export type SliceShortlistCandidate = {
  index: number;
  score: number;
};

export function selectFineSliceShortlist(
  candidates: readonly SliceShortlistCandidate[],
  seedIndex: number,
  options?: { peakCount?: number; suppressionRadius?: number }
): {
  peakIndices: number[];
  peakSelections: Array<{ index: number; reason: 'local-peak' | 'fallback-fill' }>;
  fineIndices: number[];
} {
  if (candidates.length === 0) return { peakIndices: [], peakSelections: [], fineIndices: [] };

  const byIndex = [...candidates].sort((a, b) => a.index - b.index);
  for (let i = 0; i < byIndex.length; i++) {
    const candidate = byIndex[i];
    if (!Number.isInteger(candidate.index)) {
      throw new Error(`selectFineSliceShortlist: candidate index must be an integer (${candidate.index})`);
    }
    if (!Number.isFinite(candidate.score)) {
      throw new Error(`selectFineSliceShortlist: candidate ${candidate.index} must have a finite score`);
    }
    if (i > 0 && byIndex[i - 1].index === candidate.index) {
      throw new Error(`selectFineSliceShortlist: duplicate index ${candidate.index}`);
    }
  }
  const candidateIndices = new Set(byIndex.map((candidate) => candidate.index));
  const peakCount = Math.max(1, Math.round(options?.peakCount ?? 5));
  const suppressionRadius = Math.max(0, Math.round(options?.suppressionRadius ?? 2));
  const tieOrder = (a: SliceShortlistCandidate, b: SliceShortlistCandidate) =>
    b.score - a.score || Math.abs(a.index - seedIndex) - Math.abs(b.index - seedIndex) || a.index - b.index;

  const localPeaks: SliceShortlistCandidate[] = [];
  let cursor = 0;
  while (cursor < byIndex.length) {
    const plateauStart = cursor;
    const score = byIndex[cursor].score;
    while (
      cursor + 1 < byIndex.length &&
      byIndex[cursor + 1].index === byIndex[cursor].index + 1 &&
      byIndex[cursor + 1].score === score
    ) {
      cursor++;
    }
    const plateauEnd = cursor;
    const hasAdjacentLeft =
      plateauStart > 0 && byIndex[plateauStart - 1].index === byIndex[plateauStart].index - 1;
    const hasAdjacentRight =
      plateauEnd + 1 < byIndex.length && byIndex[plateauEnd + 1].index === byIndex[plateauEnd].index + 1;
    const leftScore = hasAdjacentLeft ? byIndex[plateauStart - 1].score : Number.NEGATIVE_INFINITY;
    const rightScore = hasAdjacentRight ? byIndex[plateauEnd + 1].score : Number.NEGATIVE_INFINITY;
    let representative = byIndex[plateauStart];
    for (let i = plateauStart + 1; i <= plateauEnd; i++) {
      const candidate = byIndex[i];
      if (
        Math.abs(candidate.index - seedIndex) < Math.abs(representative.index - seedIndex) ||
        (Math.abs(candidate.index - seedIndex) === Math.abs(representative.index - seedIndex) &&
          candidate.index < representative.index)
      ) {
        representative = candidate;
      }
    }
    if (score >= leftScore && score >= rightScore) localPeaks.push(representative);
    cursor++;
  }

  const selected: SliceShortlistCandidate[] = [];
  const selectionReasons = new Map<number, 'local-peak' | 'fallback-fill'>();
  const trySelect = (candidate: SliceShortlistCandidate, reason: 'local-peak' | 'fallback-fill') => {
    if (selected.some((existing) => Math.abs(existing.index - candidate.index) <= suppressionRadius)) return;
    selected.push(candidate);
    selectionReasons.set(candidate.index, reason);
  };

  for (const candidate of localPeaks.sort(tieOrder)) {
    if (selected.length >= peakCount) break;
    trySelect(candidate, 'local-peak');
  }
  if (selected.length < peakCount) {
    for (const candidate of [...byIndex].sort(tieOrder)) {
      if (selected.length >= peakCount) break;
      trySelect(candidate, 'fallback-fill');
    }
  }

  const peakIndices = selected.map((candidate) => candidate.index);
  const fineSet = new Set<number>();
  for (const index of peakIndices) {
    for (const neighbor of [index - 1, index, index + 1]) {
      if (candidateIndices.has(neighbor)) fineSet.add(neighbor);
    }
  }

  return {
    peakIndices,
    peakSelections: peakIndices.map((index) => ({ index, reason: selectionReasons.get(index) ?? 'fallback-fill' })),
    fineIndices: [...fineSet].sort((a, b) => a - b),
  };
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
