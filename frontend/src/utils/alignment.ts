import type { ExclusionMask, HistogramStats, PanelSettings } from '../types/api';
import { CONTROL_LIMITS, DEFAULT_PANEL_SETTINGS } from './constants';
import { clamp, nowMs } from './math';
import { computeMutualInformation, type MutualInformationOptions } from './mutualInformation';
import { computeGradientMagnitudeL1Square } from './imageFeatures';
import { computeBlockSimilarity } from './ssim';
import { prepareMindReference, computeMindSimilarity } from './mind';
import {
  preparePhaseCorrelationReference,
  computePhaseCorrelationSimilarity,
  createPhaseCorrelationScratch,
} from './phaseCorrelation';
import { resample2dAreaAverage } from './svr/resample2d';

const POPCOUNT_8 = (() => {
  // 8-bit popcount lookup (used for Census Hamming distance).
  const t = new Uint8Array(256);
  for (let i = 0; i < 256; i++) {
    let v = i;
    let c = 0;
    while (v) {
      v &= v - 1;
      c++;
    }
    t[i] = c;
  }
  return t;
})();

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
  /**
   * Slice-search score. Higher is better.
   *
   * Note: the meaning of this value depends on the selected `scoreMetric`.
   */
  bestMI: number;
  slicesChecked: number;
  /** Optional perf counters for profiling/debugging. */
  timingMs?: {
    /** Time spent computing similarity scores (excludes rendering / warping). */
    scoreMs: number;
  };
}

type SliceScoreDirection = 'start' | 'left' | 'right';

type FindBestMatchingSliceOptions = {
  /** Override the starting index with a better initial guess (e.g. from a coarse seed). */
  startIndexOverride?: number;

  /** Optional search bounds (inclusive). Useful when applying a prior / window constraint. */
  minIndex?: number;
  maxIndex?: number;

  /** Histogram bins for MI/NMI scoring. Lower values are faster but less sensitive. */
  miBins?: number;

  /** How many consecutive decreases are required before stopping a direction. */
  stopDecreaseStreak?: number;

  /**
   * Minimum number of slices to score in *each* direction before early-stop logic is allowed
   * to terminate that direction.
   *
   * This directly addresses “off by ~5 slices” misses when the metric has a noisy dip early.
   */
  minSearchRadius?: number;

  /**
   * Score metric to use for bestIndex selection.
   *
   * Notes:
   * - SSIM tends to correspond best to perceived similarity.
   * - LNCC/ZNCC can be strong baselines for MRI when intensity changes are mostly affine.
   * - NGF focuses on gradient *direction* alignment (edge orientation).
   * - Census is a rank-based local descriptor (robust to monotonic intensity changes).
   * - MIND is a modality-robust self-similarity descriptor commonly used in medical registration.
   * - Phase correlation is FFT-based and is most sensitive to translation agreement.
   */
  scoreMetric?: 'ssim' | 'lncc' | 'zncc' | 'ngf' | 'census' | 'mind' | 'phase';

  /**
   * SSIM / LNCC block config.
   *
   * Note: we use fast block-based approximations (not Gaussian-window SSIM).
   */
  ssimBlockSize?: number;

  /**
   * Downsample size (square) used for the MIND descriptor metric.
   * Default: 64.
   */
  mindSize?: number;

  /**
   * Downsample size (square, power-of-two) used for phase correlation.
   * Default: 64.
   */
  phaseSize?: number;

  /** Optional hook for logging or debugging slice-level scores. */
  onSliceScored?: (
    index: number,
    metrics: {
      /** Block-based SSIM similarity on intensity images (higher is better). */
      ssim: number;
      /** Block-based LNCC similarity on intensity images (higher is better). */
      lncc: number;
      /** Global ZNCC similarity on intensity images (higher is better). */
      zncc: number;
      /** Normalized gradient field similarity (higher is better). */
      ngf: number;
      /** Census similarity (higher is better). */
      census: number;
      /** MIND-like descriptor similarity (higher is better). */
      mind?: number;
      /** Phase correlation similarity (higher is better). */
      phase?: number;
      /** Raw MI/NMI on intensity images (debug-only; can be used for comparison). */
      mi: number;
      nmi: number;
      /** Combined slice-search score used for bestIndex selection. */
      score: number;
      /** Optional MI/NMI on gradient magnitude images (debug-only, when enabled). */
      miGrad?: number;
      nmiGrad?: number;
      /** Pixels used for scoring (after masks). */
      pixelsUsed?: number;
    },
    direction: SliceScoreDirection
  ) => void;

  /**
   * Optional inclusion mask.
   * If provided, only pixels where inclusionMask[idx] != 0 are used for scoring.
   */
  inclusionMask?: Uint8Array;

  /**
   * Optional exclusion rectangle in normalized [0,1] image coordinates.
   * Pixels inside this rect are excluded from scoring (useful for ignoring tumors).
   */
  exclusionRect?: ExclusionMask;

  /** Image width in pixels (required if exclusionRect is provided). */
  imageWidth?: number;
  /** Image height in pixels (required if exclusionRect is provided). */
  imageHeight?: number;

  /**
   * Optional gradient-magnitude scoring (MI/NMI), used for debugging/comparison.
   */
  gradient?: {
    referenceGradPixels: Float32Array;
    weight: number;
  };

  /** Optional yielding to keep UI responsive during heavy 512px scoring. */
  yieldEverySlices?: number;
  yieldFn?: () => Promise<void>;
};

/**
 * Bidirectional search to find the best matching slice.
 *
 * Strategy:
 * - Start at the normalized slice depth (refIndex/refCount mapped into targetCount)
 * - Search outward in both directions
 * - Stop in each direction only after N consecutive score decreases (per-direction)
 *
 * Rationale:
 * - Adjacent slices can be noisy; a single decrease is not sufficient to stop.
 * - We intentionally do NOT early-exit based on bestScore, and we do NOT enforce a minimum
 *   search window. That keeps behavior deterministic and avoids premature termination when
 *   the metric happens to spike early.
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
  const inclusionMask = options?.inclusionMask;
  const imageWidth = options?.imageWidth;
  const imageHeight = options?.imageHeight;

  const squareSize = (() => {
    if (typeof imageWidth === 'number' && typeof imageHeight === 'number' && imageWidth === imageHeight) {
      return imageWidth;
    }

    const s = Math.round(Math.sqrt(referencePixels.length));
    if (s <= 0 || s * s !== referencePixels.length) {
      throw new Error('findBestMatchingSlice: expected square referencePixels (provide imageWidth/imageHeight)');
    }
    return s;
  })();

  const minSearchRadius = Math.max(0, Math.round(options?.minSearchRadius ?? 0));

  const minIndexBound =
    typeof options?.minIndex === 'number' && Number.isFinite(options.minIndex) ? Math.round(options.minIndex) : 0;
  const maxIndexBound =
    typeof options?.maxIndex === 'number' && Number.isFinite(options.maxIndex)
      ? Math.round(options.maxIndex)
      : targetSliceCount - 1;

  let minIndex = clamp(minIndexBound, 0, Math.max(0, targetSliceCount - 1));
  let maxIndex = clamp(maxIndexBound, 0, Math.max(0, targetSliceCount - 1));

  if (minIndex > maxIndex) {
    // Defensive: if the caller provides inverted bounds, fall back to the full range.
    minIndex = 0;
    maxIndex = Math.max(0, targetSliceCount - 1);
  }

  const yieldEverySlices = Math.max(0, Math.round(options?.yieldEverySlices ?? 0));
  const yieldFn = options?.yieldFn;
  let slicesSinceYield = 0;

  let scoreMs = 0;
  const grad = options?.gradient;
  if (grad && grad.referenceGradPixels.length !== referencePixels.length) {
    throw new Error('findBestMatchingSlice: referenceGradPixels size mismatch');
  }

  const scoreMetric = options?.scoreMetric ?? 'ssim';

  const wantDebugMetrics = typeof options?.onSliceScored === 'function';
  const wantBlockSimilarity = wantDebugMetrics || scoreMetric === 'ssim' || scoreMetric === 'lncc' || scoreMetric === 'zncc';
  const wantNgf = wantDebugMetrics || scoreMetric === 'ngf';
  const wantCensus = wantDebugMetrics || scoreMetric === 'census';

  // MIND / phase correlation are more expensive, so we only compute them when selected,
  // OR when debug metrics are enabled (so the in-viewer debug overlay is fully populated).
  const wantMind = wantDebugMetrics || scoreMetric === 'mind';
  const wantPhase = wantDebugMetrics || scoreMetric === 'phase';

  if (inclusionMask && inclusionMask.length !== referencePixels.length) {
    throw new Error(
      `findBestMatchingSlice: inclusionMask length mismatch (mask=${inclusionMask.length}, image=${referencePixels.length})`
    );
  }

  // Precompute exclusion bounds once (shared across all similarity metrics).
  let hasExclusion = false;
  let exclX0 = 0;
  let exclY0 = 0;
  let exclX1 = 0;
  let exclY1 = 0;
  if (exclusionRect && squareSize > 0) {
    exclX0 = Math.floor(exclusionRect.x * squareSize);
    exclY0 = Math.floor(exclusionRect.y * squareSize);
    exclX1 = Math.ceil((exclusionRect.x + exclusionRect.width) * squareSize);
    exclY1 = Math.ceil((exclusionRect.y + exclusionRect.height) * squareSize);
    hasExclusion = exclX1 > exclX0 && exclY1 > exclY0;
  }

  // Optional downsampled metrics.
  //
  // MIND and phase correlation are expensive at 512px. We run them on a smaller grid.
  const downsampleMaskSquare = (mask: Uint8Array, srcSize: number, dstSize: number): Uint8Array => {
    if (dstSize === srcSize) return mask;

    const f = resample2dAreaAverage(mask, srcSize, srcSize, dstSize, dstSize);
    const out = new Uint8Array(dstSize * dstSize);
    for (let i = 0; i < out.length; i++) {
      out[i] = (f[i] ?? 0) >= 0.5 ? 1 : 0;
    }
    return out;
  };

  const mindSizeRequested = Math.max(16, Math.round(options?.mindSize ?? 64));
  const mindSize = Math.min(squareSize, mindSizeRequested);

  const phaseSizeRequested = Math.max(8, Math.round(options?.phaseSize ?? 64));
  const phaseSizeClamped = Math.min(squareSize, phaseSizeRequested);

  // Ensure phase correlation size is power-of-two (FFT requirement).
  const floorPowerOfTwo = (v: number): number => {
    let n = 1;
    while (n * 2 <= v) n *= 2;
    return n;
  };
  const phaseSize = floorPowerOfTwo(phaseSizeClamped);

  const mindPrepared = wantMind
    ? (() => {
        const refMindPixels =
          mindSize === squareSize
            ? referencePixels
            : resample2dAreaAverage(referencePixels, squareSize, squareSize, mindSize, mindSize);

        const mindMask = inclusionMask
          ? mindSize === squareSize
            ? inclusionMask
            : downsampleMaskSquare(inclusionMask, squareSize, mindSize)
          : undefined;

        return prepareMindReference(refMindPixels, {
          inclusionMask: mindMask,
          exclusionRect,
          imageWidth: mindSize,
          imageHeight: mindSize,
          patchRadius: 1,
        });
      })()
    : null;

  const phasePrepared = wantPhase
    ? (() => {
        const refPhasePixels =
          phaseSize === squareSize
            ? referencePixels
            : resample2dAreaAverage(referencePixels, squareSize, squareSize, phaseSize, phaseSize);

        const phaseMask = inclusionMask
          ? phaseSize === squareSize
            ? inclusionMask
            : downsampleMaskSquare(inclusionMask, squareSize, phaseSize)
          : undefined;

        return preparePhaseCorrelationReference(refPhasePixels, {
          inclusionMask: phaseMask,
          exclusionRect,
          imageWidth: phaseSize,
          imageHeight: phaseSize,
          window: true,
        });
      })()
    : null;

  const phaseScratch = wantPhase && phasePrepared ? createPhaseCorrelationScratch(phasePrepared.size) : null;

  // NGF reference: store normalized gradients for the reference slice.
  const refNgf = wantNgf
    ? (() => {
        const nx = new Float32Array(referencePixels.length);
        const ny = new Float32Array(referencePixels.length);
        const eps = 1e-8;

        if (squareSize > 2) {
          for (let y = 1; y < squareSize - 1; y++) {
            const row = y * squareSize;
            for (let x = 1; x < squareSize - 1; x++) {
              const idx = row + x;
              const dx = (referencePixels[idx + 1] ?? 0) - (referencePixels[idx - 1] ?? 0);
              const dy = (referencePixels[idx + squareSize] ?? 0) - (referencePixels[idx - squareSize] ?? 0);
              const denom = Math.sqrt(dx * dx + dy * dy + eps);
              nx[idx] = dx / denom;
              ny[idx] = dy / denom;
            }
          }
        }

        return { nx, ny };
      })()
    : null;

  // Census reference (3x3): store 8-bit codes for the reference slice.
  const refCensus = wantCensus
    ? (() => {
        const codes = new Uint8Array(referencePixels.length);
        if (squareSize > 2) {
          for (let y = 1; y < squareSize - 1; y++) {
            const row = y * squareSize;
            for (let x = 1; x < squareSize - 1; x++) {
              const idx = row + x;
              const c = referencePixels[idx] ?? 0;
              let code = 0;
              // 8 neighbors (clockwise starting top-left)
              if ((referencePixels[idx - squareSize - 1] ?? 0) < c) code |= 1 << 0;
              if ((referencePixels[idx - squareSize] ?? 0) < c) code |= 1 << 1;
              if ((referencePixels[idx - squareSize + 1] ?? 0) < c) code |= 1 << 2;
              if ((referencePixels[idx - 1] ?? 0) < c) code |= 1 << 3;
              if ((referencePixels[idx + 1] ?? 0) < c) code |= 1 << 4;
              if ((referencePixels[idx + squareSize - 1] ?? 0) < c) code |= 1 << 5;
              if ((referencePixels[idx + squareSize] ?? 0) < c) code |= 1 << 6;
              if ((referencePixels[idx + squareSize + 1] ?? 0) < c) code |= 1 << 7;
              codes[idx] = code;
            }
          }
        }
        return codes;
      })()
    : null;

  const computeMetrics = (targetPixels: Float32Array): {
    ssim: number;
    lncc: number;
    zncc: number;
    ngf: number;
    census: number;
    mind?: number;
    phase?: number;
    mi: number;
    nmi: number;
    score: number;
    miGrad?: number;
    nmiGrad?: number;
    pixelsUsed?: number;
  } => {
    const t0 = nowMs();

    // SSIM/LNCC/ZNCC.
    const sim = wantBlockSimilarity
      ? computeBlockSimilarity(referencePixels, targetPixels, {
          blockSize: options?.ssimBlockSize,
          inclusionMask,
          exclusionRect,
          imageWidth,
          imageHeight,
        })
      : { ssim: 0, lncc: 0, zncc: 0, blocksUsed: 0, pixelsUsed: 0 };

    // NGF.
    let ngf = 0;
    let ngfPixelsUsed = 0;
    if (wantNgf && refNgf && squareSize > 2) {
      const eps = 1e-8;
      let sum = 0;
      let used = 0;
      for (let y = 1; y < squareSize - 1; y++) {
        const row = y * squareSize;
        for (let x = 1; x < squareSize - 1; x++) {
          const idx = row + x;
          if (inclusionMask && inclusionMask[idx] === 0) continue;
          if (hasExclusion && x >= exclX0 && x < exclX1 && y >= exclY0 && y < exclY1) continue;

          const dx = (targetPixels[idx + 1] ?? 0) - (targetPixels[idx - 1] ?? 0);
          const dy = (targetPixels[idx + squareSize] ?? 0) - (targetPixels[idx - squareSize] ?? 0);
          const denom = Math.sqrt(dx * dx + dy * dy + eps);
          const nx = dx / denom;
          const ny = dy / denom;

          const dot = (refNgf.nx[idx] ?? 0) * nx + (refNgf.ny[idx] ?? 0) * ny;
          // Use squared dot product so opposite directions aren't treated as dissimilar.
          sum += dot * dot;
          used++;
        }
      }

      ngfPixelsUsed = used;
      ngf = used > 0 ? sum / used : 0;
    }

    // Census (3x3).
    let census = 0;
    let censusPixelsUsed = 0;
    if (wantCensus && refCensus && squareSize > 2) {
      let diffBits = 0;
      let used = 0;

      for (let y = 1; y < squareSize - 1; y++) {
        const row = y * squareSize;
        for (let x = 1; x < squareSize - 1; x++) {
          const idx = row + x;
          if (inclusionMask && inclusionMask[idx] === 0) continue;
          if (hasExclusion && x >= exclX0 && x < exclX1 && y >= exclY0 && y < exclY1) continue;

          const c = targetPixels[idx] ?? 0;
          let code = 0;
          if ((targetPixels[idx - squareSize - 1] ?? 0) < c) code |= 1 << 0;
          if ((targetPixels[idx - squareSize] ?? 0) < c) code |= 1 << 1;
          if ((targetPixels[idx - squareSize + 1] ?? 0) < c) code |= 1 << 2;
          if ((targetPixels[idx - 1] ?? 0) < c) code |= 1 << 3;
          if ((targetPixels[idx + 1] ?? 0) < c) code |= 1 << 4;
          if ((targetPixels[idx + squareSize - 1] ?? 0) < c) code |= 1 << 5;
          if ((targetPixels[idx + squareSize] ?? 0) < c) code |= 1 << 6;
          if ((targetPixels[idx + squareSize + 1] ?? 0) < c) code |= 1 << 7;

          const refCode = refCensus[idx] ?? 0;
          diffBits += POPCOUNT_8[(refCode ^ code) & 0xff] ?? 0;
          used++;
        }
      }

      censusPixelsUsed = used;
      const totalBits = used * 8;
      census = totalBits > 0 ? 1 - diffBits / totalBits : 0;
    }

    // MIND (downsampled).
    let mind: number | undefined;
    let mindPixelsUsed = 0;
    if (wantMind && mindPrepared && mindSize > 0) {
      const targetMindPixels =
        mindSize === squareSize
          ? targetPixels
          : resample2dAreaAverage(targetPixels, squareSize, squareSize, mindSize, mindSize);

      const r = computeMindSimilarity(mindPrepared, targetMindPixels);
      mind = r.mind;
      mindPixelsUsed = r.pixelsUsed;
    }

    // Phase correlation (downsampled FFT).
    let phase: number | undefined;
    let phasePixelsUsed = 0;
    if (wantPhase && phasePrepared && phaseScratch) {
      const targetPhasePixels =
        phasePrepared.size === squareSize
          ? targetPixels
          : resample2dAreaAverage(targetPixels, squareSize, squareSize, phasePrepared.size, phasePrepared.size);

      const r = computePhaseCorrelationSimilarity(phasePrepared, targetPhasePixels, phaseScratch);
      phase = r.phase;
      phasePixelsUsed = r.pixelsUsed;
    }

    // For debug overlays/logs we also compute MI/NMI so we can compare metrics.
    // Avoid this work unless the caller has requested per-slice metrics.
    let mi = 0;
    let nmi = 0;
    let miGrad: number | undefined;
    let nmiGrad: number | undefined;
    let pixelsUsed: number | undefined = sim.pixelsUsed;

    if (wantDebugMetrics) {
      // We compute MI + NMI together from the histogram.
      const miOptions: MutualInformationOptions = {
        bins: MI_BINS,
        inclusionMask,
        exclusionRect,
        imageWidth,
        imageHeight,
      };

      const raw = computeMutualInformation(referencePixels, targetPixels, miOptions);
      mi = raw.mi;
      nmi = raw.nmi;
      pixelsUsed = raw.pixelsUsed;

      if (grad && Number.isFinite(grad.weight) && grad.weight !== 0) {
        const targetGrad = computeGradientMagnitudeL1Square(targetPixels, squareSize);
        const g = computeMutualInformation(grad.referenceGradPixels, targetGrad, miOptions);
        miGrad = g.mi;
        nmiGrad = g.nmi;
      }
    } else {
      // For non-debug runs, still expose a useful pixel count for the selected metric.
      if (scoreMetric === 'ngf') pixelsUsed = ngfPixelsUsed;
      else if (scoreMetric === 'census') pixelsUsed = censusPixelsUsed;
      else if (scoreMetric === 'mind') pixelsUsed = mindPixelsUsed;
      else if (scoreMetric === 'phase') pixelsUsed = phasePixelsUsed;
    }

    // Score used for bestIndex selection.
    const score =
      scoreMetric === 'lncc'
        ? sim.lncc
        : scoreMetric === 'zncc'
        ? sim.zncc
        : scoreMetric === 'ngf'
        ? ngf
        : scoreMetric === 'census'
        ? census
        : scoreMetric === 'mind'
        ? mind ?? 0
        : scoreMetric === 'phase'
        ? phase ?? 0
        : sim.ssim;

    scoreMs += nowMs() - t0;

    return {
      ssim: sim.ssim,
      lncc: sim.lncc,
      zncc: sim.zncc,
      ngf,
      census,
      mind,
      phase,
      mi,
      nmi,
      score,
      miGrad,
      nmiGrad,
      pixelsUsed,
    };
  };

  // Compute starting index from normalized position.
  //
  // Note: when series have different coverage / slice spacing, the normalized mapping can be
  // noticeably off. Callers can override the start index with a better guess (e.g. from a
  // coarse registration seed).
  const startIdx = Math.round((refSliceIndex / Math.max(1, refSliceCount - 1)) * (targetSliceCount - 1));
  const fallbackStart = clamp(startIdx, minIndex, maxIndex);

  const startIndexOverride = options?.startIndexOverride;

  const clampedStart =
    typeof startIndexOverride === 'number' && Number.isFinite(startIndexOverride)
      ? clamp(Math.round(startIndexOverride), minIndex, maxIndex)
      : fallbackStart;

  // Initialize with starting slice
  const startPixels = await getTargetSlicePixels(clampedStart);
  let bestIdx = clampedStart;
  const startMetrics = computeMetrics(startPixels);
  let bestMI = startMetrics.score;
  let slicesChecked = 1;

  options?.onSliceScored?.(clampedStart, startMetrics, 'start');
  onProgress?.(slicesChecked, bestMI);

  // Bidirectional search state
  let leftIdx = clampedStart - 1;
  let rightIdx = clampedStart + 1;

  let leftDone = leftIdx < minIndex;
  let rightDone = rightIdx > maxIndex;

  let leftSteps = 0;
  let rightSteps = 0;

  let leftPrevScore = startMetrics.score;
  let rightPrevScore = startMetrics.score;

  let leftDecreaseStreak = 0;
  let rightDecreaseStreak = 0;

  while (!leftDone || !rightDone) {
    // Search left
    if (!leftDone) {
      const idx = leftIdx;
      if (idx < minIndex) {
        leftDone = true;
      } else {
        const leftPixels = await getTargetSlicePixels(idx);
        const leftMetrics = computeMetrics(leftPixels);
        const leftScore = leftMetrics.score;
        slicesChecked++;
        leftSteps++;

        options?.onSliceScored?.(idx, leftMetrics, 'left');

        if (leftScore > bestMI) {
          bestMI = leftScore;
          bestIdx = idx;
        }

        // Track consecutive decreases in this direction.
        if (leftScore < leftPrevScore) {
          leftDecreaseStreak++;
        } else {
          leftDecreaseStreak = 0;
        }
        leftPrevScore = leftScore;

        leftIdx = idx - 1;
        if (leftIdx < minIndex) {
          leftDone = true;
        } else {
          // Stop only after N consecutive decreases *and* after we have searched far enough.
          if (leftDecreaseStreak >= STOP_DECREASE_STREAK && leftSteps >= minSearchRadius) {
            leftDone = true;
          }
        }

        onProgress?.(slicesChecked, bestMI);

        if (yieldEverySlices > 0 && yieldFn) {
          slicesSinceYield++;
          if (slicesSinceYield >= yieldEverySlices) {
            slicesSinceYield = 0;
            await yieldFn();
          }
        }
      }
    }

    // Search right
    if (!rightDone) {
      const idx = rightIdx;
      if (idx > maxIndex) {
        rightDone = true;
      } else {
        const rightPixels = await getTargetSlicePixels(idx);
        const rightMetrics = computeMetrics(rightPixels);
        const rightScore = rightMetrics.score;
        slicesChecked++;
        rightSteps++;

        options?.onSliceScored?.(idx, rightMetrics, 'right');

        if (rightScore > bestMI) {
          bestMI = rightScore;
          bestIdx = idx;
        }

        if (rightScore < rightPrevScore) {
          rightDecreaseStreak++;
        } else {
          rightDecreaseStreak = 0;
        }
        rightPrevScore = rightScore;

        rightIdx = idx + 1;
        if (rightIdx > maxIndex) {
          rightDone = true;
        } else {
          if (rightDecreaseStreak >= STOP_DECREASE_STREAK && rightSteps >= minSearchRadius) {
            rightDone = true;
          }
        }

        onProgress?.(slicesChecked, bestMI);

        if (yieldEverySlices > 0 && yieldFn) {
          slicesSinceYield++;
          if (slicesSinceYield >= yieldEverySlices) {
            slicesSinceYield = 0;
            await yieldFn();
          }
        }
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
