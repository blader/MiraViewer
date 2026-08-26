import type { ExclusionMask } from '../types/api';
import type { WarpTransform } from './alignmentTransform';
import {
  buildSoftForegroundSupportSquare,
  computeGradientMagnitudeL1Square,
  erodeFractionalSupportSquare,
} from './imageFeatures';
import {
  computeMindDescriptor2D,
  createMindDescriptorScratch,
  scoreMindDescriptorAgreement,
  type MindDescriptor2D,
  type MindDescriptorScratch,
} from './mindDescriptor';
import { resample2dAreaAverage, resample2dAreaAverageWithValidity } from './svr/resample2d';
import { warpGrayscaleAffineWithValidity } from './warpAffine';

const HISTOGRAM_BINS = 1024;
const CHANNEL_RANGE_EPSILON = 1e-6;
const LOCAL_RADIUS = 2;
const LOCAL_KERNEL = [1, 4, 6, 4, 1] as const;

export type PerceptualScaleComponents = {
  size: number;
  /** Fixed-denominator contrast/structure SSIM, mapped to [0, 1]. */
  contrastStructure: number;
  /** Signed fixed-denominator CS value before [0,1] mapping. */
  rawContrastStructure?: number;
  /** Fixed-denominator local normalized cross-correlation, mapped to [0, 1]. */
  lncc: number;
  /** Signed fixed-denominator LNCC value before [0,1] mapping. */
  rawLncc?: number;
  /** Fixed-denominator normalized-gradient-field agreement in [0, 1]. */
  ngf: number;
  /** Signed boundary evidence: -1 disagreement, 0 flat/neutral, +1 agreement. */
  rawNgf?: number;
  /** Fixed-denominator MIND descriptor agreement in [0, 1]. */
  mind: number;
  /** Observed mean MIND descriptor distance in [0, 1]; lower is better. */
  rawMindDistance?: number;
  /** Lower-quartile diagnostic of pooled local CS/LNCC/NGF agreement; excludes MIND. */
  lowerQuartile: number;
};

export type PerceptualComponents = {
  coverage: number;
  perScale: PerceptualScaleComponents[];
};

type PreparedPerceptualScale = {
  size: number;
  reference: Float32Array;
  weights: Float32Array;
  gradientX: Float32Array;
  gradientY: Float32Array;
  mind: MindDescriptor2D;
  totalWeight: number;
};

export type PreparedPerceptualReference = {
  sourceSize: number;
  scales: PreparedPerceptualScale[];
};

export type PerceptualScoringScratch = { descriptorBySize: Map<number, MindDescriptorScratch> };

export function createPerceptualScoringScratch(): PerceptualScoringScratch {
  return { descriptorBySize: new Map() };
}

export type PreparePerceptualReferenceOptions = {
  scales?: number[];
  exclusionRect?: ExclusionMask;
  validity?: Float32Array | Uint8Array;
};

export type NormalizePerceptualSourceOptions = {
  /** Source-space region omitted only from the robust intensity-basis histogram. */
  exclusionRect?: ExclusionMask;
  /** Explicit acquired-pixel support, independent of modality intensity and display values. */
  validity?: Float32Array | Uint8Array;
  // The stable anatomy owns the intensity basis, but explicit tumor focus must
  // not clip the lesion itself to that healthy tissue's 98th percentile.
  preserveExcludedIntensity?: boolean;
};

export type PerceptualCandidate = {
  index: number;
  components: PerceptualComponents;
};

export type RankedPerceptualCandidate<T extends PerceptualCandidate> = T & {
  mindRank: number;
  appearanceRank: number;
  boundaryRank: number;
  structuralRank: number;
  perceptualRank: number;
  mindActive: boolean;
  appearanceActive: boolean;
  boundaryActive: boolean;
  structuralActive: boolean;
};

function assertSquare(pixels: Float32Array, size: number, label: string): void {
  if (!Number.isInteger(size) || size <= 0 || pixels.length !== size * size) {
    throw new Error(`${label}: expected ${size}x${size} pixels, got ${pixels.length}`);
  }
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, Number.isFinite(value) ? value : 0));
}

function quantileFromHistogram(
  histogram: Uint32Array,
  count: number,
  min: number,
  max: number,
  quantile: number,
): number {
  const target = Math.max(0, Math.min(count - 1, Math.floor((count - 1) * quantile)));
  let cumulative = 0;
  for (let bin = 0; bin < histogram.length; bin++) {
    cumulative += histogram[bin] ?? 0;
    if (cumulative > target) {
      const t = histogram.length > 1 ? bin / (histogram.length - 1) : 0;
      return min + t * (max - min);
    }
  }
  return max;
}

/**
 * Normalize one rendered slice in its own source space before any geometric warp.
 *
 * A fixed-bin foreground histogram makes the operation linear-time and keeps additive/multiplicative
 * display-window changes from dominating structural comparison. Exact zero remains background.
 */
export function normalizePerceptualSource(
  pixels: Float32Array,
  size: number,
  options: NormalizePerceptualSourceOptions = {},
): Float32Array {
  assertSquare(pixels, size, 'normalizePerceptualSource');

  const validity = options.validity;
  if (validity && validity.length !== pixels.length) {
    throw new Error('normalizePerceptualSource: validity does not match source image dimensions');
  }
  const exclusion = options.exclusionRect;
  const exclusionX0 = exclusion ? Math.max(0, Math.floor(exclusion.x * size)) : 0;
  const exclusionY0 = exclusion ? Math.max(0, Math.floor(exclusion.y * size)) : 0;
  const exclusionX1 = exclusion ? Math.min(size, Math.ceil((exclusion.x + exclusion.width) * size)) : 0;
  const exclusionY1 = exclusion ? Math.min(size, Math.ceil((exclusion.y + exclusion.height) * size)) : 0;
  const includedInBasis = (index: number) => {
    if (validity && (!(validity[index]! > 0) || !Number.isFinite(validity[index]))) return false;
    if (!exclusion) return true;
    const x = index % size;
    const y = Math.floor(index / size);
    return x < exclusionX0 || x >= exclusionX1 || y < exclusionY0 || y >= exclusionY1;
  };

  let minimum = Number.POSITIVE_INFINITY;
  let maximum = Number.NEGATIVE_INFINITY;
  for (let i = 0; i < pixels.length; i++) {
    if (!includedInBasis(i)) continue;
    const value = pixels[i] ?? 0;
    if (!Number.isFinite(value)) continue;
    minimum = Math.min(minimum, value);
    maximum = Math.max(maximum, value);
  }
  if (!Number.isFinite(minimum) || !Number.isFinite(maximum) || !(maximum > minimum)) {
    // An exclusion that removes the entire usable foreground is an intentionally empty basis.
    // Re-admitting the excluded pixels here would let the pathology define normalization.
    return new Float32Array(pixels.length);
  }

  // Signed pixel buffers and modality intercepts can put the entire image below zero.
  // Translate its native background before robust foreground estimation; display windows never enter.
  const background = minimum;
  const shiftedMaximum = maximum - background;

  // Rendered MRI backgrounds are normally exactly zero. The tiny relative floor keeps interpolation
  // noise around that background out of the source-space intensity basis.
  const foregroundFloor = background + Math.max(1e-6, shiftedMaximum * 0.002);
  let minimumForeground = Number.POSITIVE_INFINITY;
  let maximumForeground = Number.NEGATIVE_INFINITY;
  let foregroundCount = 0;
  for (let i = 0; i < pixels.length; i++) {
    if (!includedInBasis(i)) continue;
    const value = pixels[i] ?? 0;
    if (!Number.isFinite(value) || value <= foregroundFloor) continue;
    minimumForeground = Math.min(minimumForeground, value);
    maximumForeground = Math.max(maximumForeground, value);
    foregroundCount++;
  }
  if (foregroundCount === 0) return new Float32Array(pixels.length);

  const histogram = new Uint32Array(HISTOGRAM_BINS);
  const histogramRange = maximumForeground - minimumForeground;
  if (histogramRange > 1e-12) {
    const scale = (HISTOGRAM_BINS - 1) / histogramRange;
    for (let i = 0; i < pixels.length; i++) {
      if (!includedInBasis(i)) continue;
      const value = pixels[i] ?? 0;
      if (!Number.isFinite(value) || value <= foregroundFloor) continue;
      const bin = Math.max(0, Math.min(HISTOGRAM_BINS - 1, Math.round((value - minimumForeground) * scale)));
      histogram[bin]++;
    }
  } else {
    histogram[0] = foregroundCount;
  }

  const low = quantileFromHistogram(histogram, foregroundCount, minimumForeground, maximumForeground, 0.02);
  const high = quantileFromHistogram(histogram, foregroundCount, minimumForeground, maximumForeground, 0.98);
  const robustRange = high - low;
  const output = new Float32Array(pixels.length);

  for (let i = 0; i < pixels.length; i++) {
    const value = pixels[i] ?? 0;
    if ((validity && !(validity[i]! > 0)) || !Number.isFinite(value) || value <= foregroundFloor) continue;
    const normalized = robustRange > 1e-8 ? (value - low) / robustRange : 1;
    const preserveExcluded = options.preserveExcludedIntensity && exclusion && !includedInBasis(i);
    // Keep low-valued foreground distinct from the zero-valued canvas used by warps.
    output[i] = preserveExcluded ? Math.max(0, 0.05 + 0.95 * normalized) : 0.05 + 0.95 * clamp01(normalized);
  }
  return output;
}

function computeCentralGradients(pixels: Float32Array, size: number): { x: Float32Array; y: Float32Array } {
  const x = new Float32Array(pixels.length);
  const y = new Float32Array(pixels.length);
  for (let row = 1; row < size - 1; row++) {
    const rowOffset = row * size;
    for (let column = 1; column < size - 1; column++) {
      const index = rowOffset + column;
      x[index] = ((pixels[index + 1] ?? 0) - (pixels[index - 1] ?? 0)) * 0.5;
      y[index] = ((pixels[index + size] ?? 0) - (pixels[index - size] ?? 0)) * 0.5;
    }
  }
  return { x, y };
}

function localVarianceSquare(pixels: Float32Array, size: number): Float32Array {
  const output = new Float32Array(pixels.length);
  for (let y = LOCAL_RADIUS; y < size - LOCAL_RADIUS; y++) {
    for (let x = LOCAL_RADIUS; x < size - LOCAL_RADIUS; x++) {
      let sum = 0;
      let sumSquares = 0;
      let total = 0;
      for (let dy = -LOCAL_RADIUS; dy <= LOCAL_RADIUS; dy++) {
        const kernelY = LOCAL_KERNEL[dy + LOCAL_RADIUS] ?? 0;
        const row = (y + dy) * size;
        for (let dx = -LOCAL_RADIUS; dx <= LOCAL_RADIUS; dx++) {
          const weight = kernelY * (LOCAL_KERNEL[dx + LOCAL_RADIUS] ?? 0);
          const value = pixels[row + x + dx] ?? 0;
          sum += weight * value;
          sumSquares += weight * value * value;
          total += weight;
        }
      }
      const mean = sum / Math.max(1, total);
      output[y * size + x] = Math.max(0, sumSquares / Math.max(1, total) - mean * mean);
    }
  }
  return output;
}

function buildAnatomicalDomain(support: Float32Array, size: number, safeBorder: number): Uint8Array {
  const foreground = new Uint8Array(support.length);
  let foregroundCount = 0;
  for (let y = safeBorder; y < size - safeBorder; y++) {
    for (let x = safeBorder; x < size - safeBorder; x++) {
      const index = y * size + x;
      if ((support[index] ?? 0) <= 0.05) continue;
      foreground[index] = 1;
      foregroundCount++;
    }
  }
  if (foregroundCount === 0) return foreground;

  // Preserve dark internal anatomy without turning the entire rectangular canvas into ROI:
  // flood the complement from the outer canvas, then fill only enclosed holes.
  const outside = new Uint8Array(support.length);
  const queue = new Int32Array(support.length);
  let head = 0;
  let tail = 0;
  const enqueueOutside = (index: number) => {
    if (index < 0 || index >= outside.length || outside[index] !== 0 || foreground[index] !== 0) return;
    outside[index] = 1;
    queue[tail++] = index;
  };
  for (let x = 0; x < size; x++) {
    enqueueOutside(x);
    enqueueOutside((size - 1) * size + x);
  }
  for (let y = 1; y < size - 1; y++) {
    enqueueOutside(y * size);
    enqueueOutside(y * size + size - 1);
  }
  while (head < tail) {
    const index = queue[head++] ?? 0;
    const x = index % size;
    const y = Math.floor(index / size);
    if (x > 0) enqueueOutside(index - 1);
    if (x + 1 < size) enqueueOutside(index + 1);
    if (y > 0) enqueueOutside(index - size);
    if (y + 1 < size) enqueueOutside(index + size);
  }

  const filled = new Uint8Array(support.length);
  for (let y = safeBorder; y < size - safeBorder; y++) {
    for (let x = safeBorder; x < size - safeBorder; x++) {
      const index = y * size + x;
      if (foreground[index] !== 0 || outside[index] === 0) filled[index] = 1;
    }
  }

  // A modest shape-following dilation retains the anatomical boundary and nearby flat tissue,
  // while the outer canvas remains connected to the flood and therefore excluded.
  const dilationRadius = Math.max(LOCAL_RADIUS, Math.round(size * 0.02));
  const horizontal = new Uint8Array(support.length);
  for (let y = safeBorder; y < size - safeBorder; y++) {
    const row = y * size;
    for (let x = safeBorder; x < size - safeBorder; x++) {
      for (let dx = -dilationRadius; dx <= dilationRadius; dx++) {
        const sampleX = x + dx;
        if (sampleX < safeBorder || sampleX >= size - safeBorder) continue;
        if (filled[row + sampleX] !== 0) {
          horizontal[row + x] = 1;
          break;
        }
      }
    }
  }
  const domain = new Uint8Array(support.length);
  for (let y = safeBorder; y < size - safeBorder; y++) {
    for (let x = safeBorder; x < size - safeBorder; x++) {
      for (let dy = -dilationRadius; dy <= dilationRadius; dy++) {
        const sampleY = y + dy;
        if (sampleY < safeBorder || sampleY >= size - safeBorder) continue;
        if (horizontal[sampleY * size + x] !== 0) {
          domain[y * size + x] = 1;
          break;
        }
      }
    }
  }
  return domain;
}

function buildReferenceWeights(
  reference: Float32Array,
  size: number,
  exclusionRect: ExclusionMask | undefined,
  safeBorder: number,
  validity?: Float32Array,
): Float32Array {
  const support = buildSoftForegroundSupportSquare(reference, size);
  const gradients = computeGradientMagnitudeL1Square(reference, size);
  const variance = localVarianceSquare(reference, size);
  const weights = new Float32Array(reference.length);
  const anatomicalDomain = buildAnatomicalDomain(support, size, safeBorder);

  let exclusionX0 = 0;
  let exclusionY0 = 0;
  let exclusionX1 = 0;
  let exclusionY1 = 0;
  if (exclusionRect) {
    exclusionX0 = Math.floor(exclusionRect.x * size) - safeBorder;
    exclusionY0 = Math.floor(exclusionRect.y * size) - safeBorder;
    exclusionX1 = Math.ceil((exclusionRect.x + exclusionRect.width) * size) + safeBorder;
    exclusionY1 = Math.ceil((exclusionRect.y + exclusionRect.height) * size) + safeBorder;
  }

  for (let y = safeBorder; y < size - safeBorder; y++) {
    for (let x = safeBorder; x < size - safeBorder; x++) {
      if (anatomicalDomain[y * size + x] === 0) continue;
      if (exclusionRect && x >= exclusionX0 && x < exclusionX1 && y >= exclusionY0 && y < exclusionY1) continue;
      const index = y * size + x;
      const structuralSignal = Math.min(
        1,
        3 * (gradients[index] ?? 0) + 5 * Math.sqrt(Math.max(0, variance[index] ?? 0)),
      );
      // The floor gives target-only boundaries a cost. Foreground and reference structure remain dominant.
      weights[index] =
        Math.min(1.5, 0.1 + 0.45 * (support[index] ?? 0) + 0.95 * structuralSignal) *
        (validity ? clamp01(validity[index] ?? 0) : 1);
    }
  }
  return weights;
}

export function preparePerceptualReference(
  normalizedReference: Float32Array,
  size: number,
  options: PreparePerceptualReferenceOptions = {},
): PreparedPerceptualReference {
  assertSquare(normalizedReference, size, 'preparePerceptualReference');
  if (options.validity && options.validity.length !== normalizedReference.length) {
    throw new Error('preparePerceptualReference: validity does not match reference image dimensions');
  }
  const requestedScales = options.scales ?? [256, 128, 64];
  const uniqueScales = new Set<number>();
  for (const requestedScale of requestedScales) {
    const roundedScale = Math.round(requestedScale);
    if (roundedScale > 0 && roundedScale <= size) uniqueScales.add(roundedScale);
  }
  const scaleSizes = [...uniqueScales].sort((a, b) => b - a);
  if (scaleSizes.length === 0) scaleSizes.push(size);

  const scales = scaleSizes.map((scaleSize): PreparedPerceptualScale => {
    const scaled = options.validity
      ? scaleSize === size
        ? { pixels: Float32Array.from(normalizedReference), validity: Float32Array.from(options.validity) }
        : resample2dAreaAverageWithValidity(normalizedReference, options.validity, size, size, scaleSize, scaleSize)
      : {
          pixels:
            scaleSize === size
              ? Float32Array.from(normalizedReference)
              : resample2dAreaAverage(normalizedReference, size, size, scaleSize, scaleSize),
          validity: undefined,
        };
    const reference = scaled.pixels;
    const mind = computeMindDescriptor2D(reference, scaleSize);
    const safeBorder = Math.max(LOCAL_RADIUS + 1, mind.footprintRadius);
    const descriptorValidity = scaled.validity
      ? erodeFractionalSupportSquare(scaled.validity, scaleSize, safeBorder)
      : undefined;
    const weights = buildReferenceWeights(reference, scaleSize, options.exclusionRect, safeBorder, descriptorValidity);
    const gradients = computeCentralGradients(reference, scaleSize);
    let totalWeight = 0;
    for (let i = 0; i < weights.length; i++) totalWeight += weights[i] ?? 0;
    return {
      size: scaleSize,
      reference,
      weights,
      gradientX: gradients.x,
      gradientY: gradients.y,
      mind,
      totalWeight,
    };
  });

  return { sourceSize: size, scales };
}

function weightedLowerQuartile(histogram: Float64Array, totalWeight: number): number {
  if (!(totalWeight > 0)) return 0;
  const threshold = totalWeight * 0.25;
  let cumulative = 0;
  for (let index = 0; index < histogram.length; index++) {
    cumulative += histogram[index] ?? 0;
    if (cumulative >= threshold) return index / Math.max(1, histogram.length - 1);
  }
  return 1;
}

function scoreScale(
  prepared: PreparedPerceptualScale,
  candidate: Float32Array,
  validity: Float32Array,
  scratch?: PerceptualScoringScratch,
): { coverageNumerator: number; components: PerceptualScaleComponents } {
  const {
    size,
    reference,
    weights,
    gradientX: referenceGradientX,
    gradientY: referenceGradientY,
    mind: referenceMind,
    totalWeight,
  } = prepared;
  let descriptorScratch = scratch?.descriptorBySize.get(size);
  if (scratch && !descriptorScratch) {
    descriptorScratch = createMindDescriptorScratch(size);
    scratch.descriptorBySize.set(size, descriptorScratch);
  }
  const candidateMind = computeMindDescriptor2D(candidate, size, descriptorScratch);
  const mindAgreement = scoreMindDescriptorAgreement(referenceMind, candidateMind, weights, validity);
  const candidateGradients = computeCentralGradients(candidate, size);
  let coverageNumerator = 0;
  let csSum = 0;
  let lnccSum = 0;
  let ngfSum = 0;
  const localHistogram = new Float64Array(64);

  for (let i = 0; i < weights.length; i++) coverageNumerator += (weights[i] ?? 0) * clamp01(validity[i] ?? 0);

  const c2 = 0.03 * 0.03;
  const varianceEpsilon = 1e-10;
  const gradientEpsilonSquared = 0.01 * 0.01;

  for (let y = LOCAL_RADIUS; y < size - LOCAL_RADIUS; y++) {
    for (let x = LOCAL_RADIUS; x < size - LOCAL_RADIUS; x++) {
      const center = y * size + x;
      const centerWeight = weights[center] ?? 0;
      if (!(centerWeight > 0)) continue;

      let referenceSupport = 0;
      let observedSupport = 0;
      let sumReference = 0;
      let sumCandidate = 0;
      let sumReferenceSquares = 0;
      let sumCandidateSquares = 0;
      let sumProduct = 0;

      for (let dy = -LOCAL_RADIUS; dy <= LOCAL_RADIUS; dy++) {
        const kernelY = LOCAL_KERNEL[dy + LOCAL_RADIUS] ?? 0;
        const row = (y + dy) * size;
        for (let dx = -LOCAL_RADIUS; dx <= LOCAL_RADIUS; dx++) {
          const index = row + x + dx;
          const referenceWeight = (weights[index] ?? 0) * kernelY * (LOCAL_KERNEL[dx + LOCAL_RADIUS] ?? 0);
          if (!(referenceWeight > 0)) continue;
          referenceSupport += referenceWeight;
          const sampleWeight = referenceWeight * clamp01(validity[index] ?? 0);
          if (!(sampleWeight > 0)) continue;
          observedSupport += sampleWeight;
          const referenceValue = reference[index] ?? 0;
          const candidateValue = candidate[index] ?? 0;
          sumReference += sampleWeight * referenceValue;
          sumCandidate += sampleWeight * candidateValue;
          sumReferenceSquares += sampleWeight * referenceValue * referenceValue;
          sumCandidateSquares += sampleWeight * candidateValue * candidateValue;
          sumProduct += sampleWeight * referenceValue * candidateValue;
        }
      }

      const localCoverage = referenceSupport > 0 ? clamp01(observedSupport / referenceSupport) : 0;
      let mappedCs = 0;
      let mappedLncc = 0;
      if (observedSupport > 1e-8) {
        const inverseSupport = 1 / observedSupport;
        const meanReference = sumReference * inverseSupport;
        const meanCandidate = sumCandidate * inverseSupport;
        const varianceReference = Math.max(0, sumReferenceSquares * inverseSupport - meanReference * meanReference);
        const varianceCandidate = Math.max(0, sumCandidateSquares * inverseSupport - meanCandidate * meanCandidate);
        const covariance = sumProduct * inverseSupport - meanReference * meanCandidate;
        const rawCs = (2 * covariance + c2) / Math.max(c2, varianceReference + varianceCandidate + c2);
        mappedCs = clamp01((rawCs + 1) * 0.5);

        const lnccDenominator = Math.sqrt(varianceReference * varianceCandidate);
        let rawLncc = 0;
        if (lnccDenominator > varianceEpsilon) {
          rawLncc = covariance / lnccDenominator;
        } else if (
          varianceReference <= varianceEpsilon &&
          varianceCandidate <= varianceEpsilon &&
          Math.abs(meanReference - meanCandidate) <= 1e-4
        ) {
          rawLncc = 1;
        }
        mappedLncc = clamp01((rawLncc + 1) * 0.5);
      }

      const stencilValidity = Math.min(
        clamp01(validity[center] ?? 0),
        clamp01(validity[center - 1] ?? 0),
        clamp01(validity[center + 1] ?? 0),
        clamp01(validity[center - size] ?? 0),
        clamp01(validity[center + size] ?? 0),
      );
      const referenceDx = referenceGradientX[center] ?? 0;
      const referenceDy = referenceGradientY[center] ?? 0;
      const candidateDx = candidateGradients.x[center] ?? 0;
      const candidateDy = candidateGradients.y[center] ?? 0;
      const referenceMagnitudeSquared = referenceDx * referenceDx + referenceDy * referenceDy;
      const candidateMagnitudeSquared = candidateDx * candidateDx + candidateDy * candidateDy;
      const dot = referenceDx * candidateDx + referenceDy * candidateDy;
      const ngfDenominator =
        (referenceMagnitudeSquared + gradientEpsilonSquared) * (candidateMagnitudeSquared + gradientEpsilonSquared);
      const ngfAgreement = clamp01((dot * dot) / Math.max(1e-12, ngfDenominator));
      // Flat/flat regions are neutral rather than perfect boundary evidence. The union gate turns
      // on for either a reference or target edge, so target-only boundaries become disagreements.
      const unionGradientGate = clamp01(
        (referenceMagnitudeSquared + candidateMagnitudeSquared) / (4 * gradientEpsilonSquared),
      );
      const mappedNgf = clamp01(0.5 + 0.5 * unionGradientGate * (2 * ngfAgreement - 1));

      const csContribution = localCoverage * mappedCs;
      const lnccContribution = localCoverage * mappedLncc;
      const ngfContribution = stencilValidity * mappedNgf;
      csSum += centerWeight * csContribution;
      lnccSum += centerWeight * lnccContribution;
      ngfSum += centerWeight * ngfContribution;

      const localCombined = clamp01((csContribution + lnccContribution + ngfContribution) / 3);
      const histogramIndex = Math.min(localHistogram.length - 1, Math.floor(localCombined * localHistogram.length));
      localHistogram[histogramIndex] += centerWeight;
    }
  }

  const inverseTotalWeight = totalWeight > 0 ? 1 / totalWeight : 0;
  const contrastStructure = clamp01(csSum * inverseTotalWeight);
  const lncc = clamp01(lnccSum * inverseTotalWeight);
  const ngf = clamp01(ngfSum * inverseTotalWeight);
  return {
    coverageNumerator,
    components: {
      size,
      contrastStructure,
      rawContrastStructure: 2 * contrastStructure - 1,
      lncc,
      rawLncc: 2 * lncc - 1,
      ngf,
      rawNgf: 2 * ngf - 1,
      mind: clamp01(mindAgreement.score),
      rawMindDistance: mindAgreement.meanDistance,
      lowerQuartile: weightedLowerQuartile(localHistogram, totalWeight),
    },
  };
}

export function scoreAlignedCandidate(
  preparedReference: PreparedPerceptualReference,
  normalizedAlignedCandidate: Float32Array,
  validity: Float32Array,
  alignedSize: number,
  scratch?: PerceptualScoringScratch,
): PerceptualComponents {
  assertSquare(normalizedAlignedCandidate, alignedSize, 'scoreAlignedCandidate candidate');
  assertSquare(validity, alignedSize, 'scoreAlignedCandidate validity');

  const perScale: PerceptualScaleComponents[] = [];
  let weightedCoverageNumerator = 0;
  let totalReferenceWeight = 0;
  for (const preparedScale of preparedReference.scales) {
    const premultipliedCandidate =
      preparedScale.size === alignedSize
        ? normalizedAlignedCandidate
        : resample2dAreaAverage(
            normalizedAlignedCandidate,
            alignedSize,
            alignedSize,
            preparedScale.size,
            preparedScale.size,
          );
    const scaleValidity =
      preparedScale.size === alignedSize
        ? validity
        : resample2dAreaAverage(validity, alignedSize, alignedSize, preparedScale.size, preparedScale.size);
    // The zero-padded bilinear warp stores intensity premultiplied by fractional geometric support.
    // Recover conditional intensity after resampling, then use validity exactly once in local moments.
    const candidate = new Float32Array(premultipliedCandidate.length);
    for (let index = 0; index < candidate.length; index++) {
      const sampleValidity = clamp01(scaleValidity[index] ?? 0);
      candidate[index] = sampleValidity > 1e-6 ? (premultipliedCandidate[index] ?? 0) / sampleValidity : 0;
    }
    const result = scoreScale(preparedScale, candidate, scaleValidity, scratch);
    perScale.push(result.components);
    weightedCoverageNumerator += result.coverageNumerator;
    totalReferenceWeight += preparedScale.totalWeight;
  }

  return {
    coverage: totalReferenceWeight > 0 ? clamp01(weightedCoverageNumerator / totalReferenceWeight) : 0,
    perScale,
  };
}

/** Compose acquired-pixel support with geometric support without double-weighting intensity. */
export function warpPerceptualCandidateWithValidity(
  normalized: Float32Array,
  size: number,
  warp: WarpTransform,
  acquiredValidity?: Float32Array,
): { pixels: Float32Array; validity: Float32Array } {
  if (!acquiredValidity) return warpGrayscaleAffineWithValidity(normalized, size, warp);
  assertSquare(acquiredValidity, size, 'warpPerceptualCandidateWithValidity validity');
  const premultiplied = Float32Array.from(normalized, (value, index) => value * clamp01(acquiredValidity[index] ?? 0));
  return {
    pixels: warpGrayscaleAffineWithValidity(premultiplied, size, warp).pixels,
    validity: warpGrayscaleAffineWithValidity(acquiredValidity, size, warp).pixels,
  };
}

function midranks(values: readonly number[]): number[] | null {
  if (values.length === 0) return null;
  let minimum = Number.POSITIVE_INFINITY;
  let maximum = Number.NEGATIVE_INFINITY;
  for (const value of values) {
    const finiteValue = Number.isFinite(value) ? value : 0;
    minimum = Math.min(minimum, finiteValue);
    maximum = Math.max(maximum, finiteValue);
  }
  if (!(maximum - minimum > CHANNEL_RANGE_EPSILON)) return null;

  const order = values.map((value, index) => ({ value: Number.isFinite(value) ? value : 0, index }));
  order.sort((a, b) => a.value - b.value || a.index - b.index);
  const ranks = new Array<number>(values.length).fill(0);
  let start = 0;
  while (start < order.length) {
    let end = start + 1;
    while (end < order.length && Math.abs((order[end]?.value ?? 0) - (order[start]?.value ?? 0)) <= 1e-12) end++;
    const percentileMidrank = (start + end) / (2 * order.length);
    for (let position = start; position < end; position++) ranks[order[position]?.index ?? 0] = percentileMidrank;
    start = end;
  }
  return ranks;
}

function average(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  let sum = 0;
  for (const value of values) sum += value;
  return sum / values.length;
}

function fusePerceptualRanks(structuralRank: number | null, appearanceRank: number | null, priorRank: number): number {
  if (structuralRank != null && appearanceRank != null) {
    return 0.8 * structuralRank + 0.2 * appearanceRank;
  }
  return structuralRank ?? appearanceRank ?? priorRank;
}

export function choosePerceptualWinner<T extends { index: number; perceptualRank: number }>(
  candidates: readonly T[],
  seedIndex: number,
): T {
  if (candidates.length === 0) {
    throw new Error('Align All produced no fine slice candidates');
  }
  return [...candidates].sort(
    (a, b) =>
      b.perceptualRank - a.perceptualRank ||
      Math.abs(a.index - seedIndex) - Math.abs(b.index - seedIndex) ||
      a.index - b.index,
  )[0];
}

/**
 * Fuse raw metric channels only after the candidate universe is fixed. MIND and NGF are balanced
 * structural families, CS/LNCC share one appearance family, and flat channels are omitted rather
 * than manufacturing certainty.
 */
export function rankFixedCandidateSet<T extends PerceptualCandidate>(
  candidates: readonly T[],
  seedIndex: number,
): Array<RankedPerceptualCandidate<T>> {
  if (candidates.length === 0) return [];
  const mindByCandidate = candidates.map(() => [] as number[]);
  const appearanceByCandidate = candidates.map(() => [] as number[]);
  const boundaryByCandidate = candidates.map(() => [] as number[]);
  const scaleKeys = [
    ...new Set(candidates.flatMap((candidate) => candidate.components.perScale.map((scale) => scale.size))),
  ];

  for (const size of scaleKeys) {
    const mindRanks = midranks(
      candidates.map((candidate) => candidate.components.perScale.find((scale) => scale.size === size)?.mind ?? 0),
    );
    if (mindRanks) {
      for (let index = 0; index < candidates.length; index++) {
        mindByCandidate[index]?.push(mindRanks[index] ?? 0);
      }
    }
    for (const metric of ['contrastStructure', 'lncc'] as const) {
      const ranks = midranks(
        candidates.map(
          (candidate) => candidate.components.perScale.find((scale) => scale.size === size)?.[metric] ?? 0,
        ),
      );
      if (ranks)
        for (let index = 0; index < candidates.length; index++) appearanceByCandidate[index]?.push(ranks[index] ?? 0);
    }
    const ranks = midranks(
      candidates.map((candidate) => candidate.components.perScale.find((scale) => scale.size === size)?.ngf ?? 0),
    );
    if (ranks)
      for (let index = 0; index < candidates.length; index++) boundaryByCandidate[index]?.push(ranks[index] ?? 0);
  }

  const mindRanks = mindByCandidate.map(average);
  const appearanceRanks = appearanceByCandidate.map(average);
  const boundaryRanks = boundaryByCandidate.map(average);
  const structuralRanks = candidates.map((_, index) =>
    average([mindRanks[index], boundaryRanks[index]].filter((value): value is number => value !== null)),
  );
  const hasAnyMetricFamily =
    structuralRanks.some((value) => value !== null) || appearanceRanks.some((value) => value !== null);
  const priorRanks = hasAnyMetricFamily
    ? null
    : (midranks(candidates.map((candidate) => -Math.abs(candidate.index - seedIndex))) ?? candidates.map(() => 0.5));

  return candidates.map((candidate, index) => {
    const mindRank = mindRanks[index];
    const appearanceRank = appearanceRanks[index];
    const boundaryRank = boundaryRanks[index];
    const structuralRank = structuralRanks[index];
    const perceptualRank = fusePerceptualRanks(structuralRank, appearanceRank, priorRanks?.[index] ?? 0.5);
    return {
      ...candidate,
      mindRank: mindRank ?? perceptualRank,
      appearanceRank: appearanceRank ?? perceptualRank,
      boundaryRank: boundaryRank ?? perceptualRank,
      structuralRank: structuralRank ?? perceptualRank,
      perceptualRank,
      mindActive: mindRank !== null,
      appearanceActive: appearanceRank !== null,
      boundaryActive: boundaryRank !== null,
      structuralActive: structuralRank !== null,
    };
  });
}
