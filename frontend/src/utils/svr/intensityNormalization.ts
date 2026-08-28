import type { SvrReconstructionSlice } from './reconstructionCore';
import { quantileSorted } from './svrUtils';

/** A single affine intensity domain. Percentiles control display, never erase source observations. */
export function normalizeSvrIntensities(
  slices: readonly Pick<SvrReconstructionSlice, 'pixels' | 'valid'>[],
  samples: readonly number[],
): { displayWindow: [number, number]; robustRangeScale: number } {
  let minimum = 0;
  let maximum = 0;
  for (const slice of slices) {
    for (let index = 0; index < slice.pixels.length; index++) {
      const value = slice.pixels[index]!;
      if ((slice.valid && !slice.valid[index]) || !Number.isFinite(value)) continue;
      minimum = Math.min(minimum, value);
      maximum = Math.max(maximum, value);
    }
  }
  const range = maximum - minimum;
  const inverseRange = range > 0 ? 1 / range : 0;
  const finite = samples.filter(Number.isFinite).sort((a, b) => a - b);
  const lower = finite.length ? quantileSorted(finite, 0.01) : minimum;
  const upper = finite.length ? quantileSorted(finite, 0.998) : maximum;
  const robustRange = finite.length ? quantileSorted(finite, 0.99) - lower : range;
  const robustRangeScale = robustRange > 0 ? Math.min(1, robustRange * inverseRange) : 1;

  for (const slice of slices) {
    for (let index = 0; index < slice.pixels.length; index++) {
      const value = slice.pixels[index]!;
      slice.pixels[index] =
        (slice.valid && !slice.valid[index]) || !Number.isFinite(value) ? 0 : (value - minimum) * inverseRange;
    }
  }

  // A little display headroom avoids presenting bright tissue as a featureless white patch.
  const displayLow = Math.max(0, (lower - minimum) * inverseRange);
  const displayHigh = Math.min(1, (upper - minimum + Math.max(0, upper - lower) * 0.1) * inverseRange);
  return { displayWindow: displayHigh > displayLow ? [displayLow, displayHigh] : [0, 1], robustRangeScale };
}
