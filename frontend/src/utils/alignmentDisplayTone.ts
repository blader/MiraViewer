import type { HistogramStats } from '../types/api';

/** Display-only calibration in native intensity units; never modifies source or resliced data. */
export type AlignmentDisplayTone = {
  windowCenter: number;
  windowWidth: number;
  source: [number, number, number];
  reference: [number, number, number];
};

export function createAlignmentDisplayTone(
  reference: HistogramStats,
  moving: HistogramStats,
  window: { windowCenter?: number; windowWidth?: number },
): AlignmentDisplayTone | undefined {
  const tone = {
    windowCenter: window.windowCenter!,
    windowWidth: window.windowWidth!,
    source: [moving.p10, moving.p50, moving.p90] as [number, number, number],
    reference: [reference.p10, reference.p50, reference.p90] as [number, number, number],
  };
  return validAlignmentDisplayTone(tone) ? tone : undefined;
}

export function validAlignmentDisplayTone(tone: AlignmentDisplayTone): boolean {
  return (
    Number.isFinite(tone.windowCenter) &&
    Number.isFinite(tone.windowWidth) &&
    tone.windowWidth > 0 &&
    [tone.source, tone.reference].every(
      (points) =>
        Array.isArray(points) &&
        points.length === 3 &&
        points.every(
          (point, index) =>
            Number.isFinite(point) &&
            point > 0.01 &&
            point < 0.995 &&
            (index === 0 || point - points[index - 1]! > 0.005),
        ),
    )
  );
}

/** Monotone quantile matching with fixed black/white endpoints, avoiding CSS contrast's lifted black. */
export function applyAlignmentDisplayTone(value: number, tone: AlignmentDisplayTone): number {
  const normalized = Math.max(0, Math.min(1, (value - tone.windowCenter) / tone.windowWidth + 0.5));
  let from = 0,
    to = 0;
  for (let index = 0; index <= 3; index++) {
    const nextFrom = tone.source[index] ?? 1;
    const nextTo = tone.reference[index] ?? 1;
    if (normalized <= nextFrom) return to + ((nextTo - to) * (normalized - from)) / (nextFrom - from);
    from = nextFrom;
    to = nextTo;
  }
  return 1;
}
