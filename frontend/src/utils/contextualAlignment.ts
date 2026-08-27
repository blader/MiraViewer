import type { ExclusionMask } from '../types/api';
import {
  createPerceptualScoringScratch,
  normalizePerceptualSource,
  preparePerceptualReference,
  scoreAlignedCandidate,
} from './perceptualSliceSimilarity';
import { resample2dAreaAverageWithValidity } from './svr/resample2d';

export type AlignmentContextPlane = {
  pixels: Float32Array;
  valid?: Uint8Array;
  rows: number;
  cols: number;
};

function validatePlane(plane: AlignmentContextPlane): void {
  if (
    !Number.isSafeInteger(plane.rows) ||
    !Number.isSafeInteger(plane.cols) ||
    plane.rows < 2 ||
    plane.cols < 2 ||
    plane.pixels.length !== plane.rows * plane.cols ||
    (plane.valid && plane.valid.length !== plane.pixels.length)
  ) {
    throw new Error('Alignment context requires matching image dimensions and acquired support');
  }
}

/** Select sustained, spatially coherent anatomy, not a bright lesion or the browsing cursor. */
export function selectInformativeAlignmentPlane(planes: readonly AlignmentContextPlane[]): number | null {
  const size = 64;
  const quality = planes.map((plane) => {
    validatePlane(plane);
    const scaled = resample2dAreaAverageWithValidity(
      plane.pixels,
      plane.valid ?? new Uint8Array(plane.pixels.length).fill(1),
      plane.rows,
      plane.cols,
      size,
      size,
    );
    const pixels = normalizePerceptualSource(scaled.pixels, size, { validity: scaled.validity });
    const smooth = new Float32Array(pixels.length);
    let sum = 0,
      squares = 0,
      lowSum = 0,
      lowSquares = 0,
      count = 0,
      foreground = 0;
    for (let row = 1; row < size - 1; row++) {
      for (let col = 1; col < size - 1; col++) {
        const index = row * size + col;
        if (scaled.validity[index]! < 0.99) continue;
        let local = 0,
          support = 0;
        for (let dy = -1; dy <= 1; dy++)
          for (let dx = -1; dx <= 1; dx++) {
            const neighbor = index + dy * size + dx;
            if (scaled.validity[neighbor]! < 0.99) continue;
            local += pixels[neighbor]!;
            support++;
          }
        if (support !== 9) continue;
        smooth[index] = local / 9;
        const value = pixels[index]!;
        sum += value;
        squares += value * value;
        lowSum += smooth[index]!;
        lowSquares += smooth[index]! ** 2;
        count++;
        if (value > 0.08) foreground++;
      }
    }
    if (count < (size * size) / 4 || foreground < size * size * 0.05) return 0;
    const variance = squares / count - (sum / count) ** 2;
    if (variance < 1e-5) return 0;
    // Uncorrelated noise loses most of its variance under a local average;
    // anatomical boundaries survive. Brightness and contrast do not affect this ratio.
    const coherentVariance = lowSquares / count - (lowSum / count) ** 2;
    const coherence = Math.max(0, Math.min(1, (coherentVariance / variance - 0.25) / 0.65));
    let gradient = 0;
    for (let row = 2; row < size - 2; row++)
      for (let col = 2; col < size - 2; col++) {
        const index = row * size + col;
        if (scaled.validity[index]! < 0.99) continue;
        gradient +=
          (smooth[index + 1]! - smooth[index - 1]!) ** 2 + (smooth[index + size]! - smooth[index - size]!) ** 2;
      }
    return (coherence * Math.sqrt(gradient / count) * foreground) / count;
  });
  let selected: number | null = null;
  let best = 1e-4;
  for (let index = 0; index < planes.length; index++) {
    const neighborhood = quality.slice(Math.max(0, index - 1), Math.min(quality.length, index + 2));
    // A single detailed/noisy outlier between blank frames cannot choose a slab.
    const score = Math.min(
      quality[index]!,
      [...neighborhood].sort((a, b) => a - b)[Math.floor((neighborhood.length - 1) / 2)]!,
    );
    if (
      score > best ||
      (score === best &&
        selected !== null &&
        Math.abs(index - (planes.length - 1) / 2) < Math.abs(selected - (planes.length - 1) / 2))
    ) {
      best = score;
      selected = index;
    }
  }
  return selected;
}

/** Fixed reference evidence shared by every rigid hypothesis, including its neighbors. */
export function prepareAlignmentContext(
  planes: readonly AlignmentContextPlane[],
  exclusionRect?: ExclusionMask,
  size = 64,
) {
  if (!Number.isSafeInteger(size) || size < 8) throw new Error('Alignment context requires a valid scoring size');
  const normalize = (plane: AlignmentContextPlane) => {
    validatePlane(plane);
    const scaled = resample2dAreaAverageWithValidity(
      plane.pixels,
      plane.valid ?? new Uint8Array(plane.pixels.length).fill(1),
      plane.rows,
      plane.cols,
      size,
      size,
    );
    const pixels = normalizePerceptualSource(scaled.pixels, size, {
      exclusionRect,
      validity: scaled.validity,
    });
    return { pixels, validity: scaled.validity };
  };
  const references = planes.map((plane) => {
    const normalized = normalize(plane);
    return preparePerceptualReference(normalized.pixels, size, {
      scales: [size],
      exclusionRect,
      validity: normalized.validity,
    });
  });
  const scratch = createPerceptualScoringScratch();

  return {
    planeCount: references.length,
    score(candidateAt: (index: number) => AlignmentContextPlane, minimumCoverage = 0.55) {
      let score = 0;
      let coverage = 1;
      for (let index = 0; index < references.length; index++) {
        const normalized = normalize(candidateAt(index));
        // The scorer expects intensity premultiplied by fractional acquired support.
        for (let pixel = 0; pixel < normalized.pixels.length; pixel++) {
          normalized.pixels[pixel] *= normalized.validity[pixel]!;
        }
        const components = scoreAlignedCandidate(
          references[index]!,
          normalized.pixels,
          normalized.validity,
          size,
          scratch,
        );
        coverage = Math.min(coverage, components.coverage);
        if (coverage < minimumCoverage) return { score: Number.NEGATIVE_INFINITY, coverage };
        const component = components.perScale[0]!;
        // Bounded local structure dominates; extreme lesion intensities cannot dominate a
        // global intensity covariance. Every reference plane keeps the same denominator.
        score += 0.4 * (component.mind + component.ngf) + 0.1 * (component.lncc + component.contrastStructure);
      }
      return { score: references.length ? score / references.length : Number.NEGATIVE_INFINITY, coverage };
    },
  };
}
