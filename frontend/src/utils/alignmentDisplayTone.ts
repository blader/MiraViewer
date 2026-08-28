import type { HistogramStats } from '../types/api';

/** Display-only calibration in native intensity units; never modifies source or resliced data. */
export type AlignmentDisplayTone = {
  windowCenter: number;
  windowWidth: number;
  source: [number, number, number];
  reference: [number, number, number];
  /** Calibration anchor only. Browsed planes use their own acquired reference window. */
  referenceWindow?: { windowCenter: number; windowWidth: number };
};

export function createAlignmentDisplayTone(
  reference: HistogramStats,
  moving: HistogramStats,
  window: { windowCenter?: number; windowWidth?: number },
  referenceWindow?: { windowCenter?: number; windowWidth?: number },
): AlignmentDisplayTone | undefined {
  const tone = {
    windowCenter: window.windowCenter!,
    windowWidth: window.windowWidth!,
    source: [moving.p10, moving.p50, moving.p90] as [number, number, number],
    reference: [reference.p10, reference.p50, reference.p90] as [number, number, number],
    ...(referenceWindow && {
      referenceWindow: {
        windowCenter: referenceWindow.windowCenter!,
        windowWidth: referenceWindow.windowWidth!,
      },
    }),
  };
  return validAlignmentDisplayTone(tone) ? tone : undefined;
}

export function validAlignmentDisplayTone(tone: AlignmentDisplayTone): boolean {
  return (
    Number.isFinite(tone.windowCenter) &&
    Number.isFinite(tone.windowWidth) &&
    tone.windowWidth > 0 &&
    (tone.referenceWindow === undefined ||
      (tone.referenceWindow !== null &&
        Number.isFinite(tone.referenceWindow.windowCenter) &&
        Number.isFinite(tone.referenceWindow.windowWidth) &&
        tone.referenceWindow.windowWidth > 0)) &&
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

/** Stable intensity transfer followed by the current reference VOI; never refit while browsing. */
export function applyAlignmentDisplayTone(
  value: number,
  tone: AlignmentDisplayTone,
  outputWindow?: { windowCenter?: number; windowWidth?: number },
): number {
  const normalized = (value - tone.windowCenter) / tone.windowWidth + 0.5;
  let from = 0,
    to = 0;
  // A display window's white endpoint is not corresponding tissue. Extending the
  // last measured slope preserves highlights without inventing a contrast boost.
  // Legacy saved curves retain their original endpoint until recalibrated.
  const lastKnot = tone.referenceWindow ? 2 : 3;
  for (let index = 0; index <= lastKnot; index++) {
    const nextFrom = tone.source[index] ?? 1;
    const nextTo = tone.reference[index] ?? 1;
    if (normalized <= nextFrom || index === lastKnot) {
      let mapped = to + ((nextTo - to) * (normalized - from)) / (nextFrom - from);
      if (
        tone.referenceWindow &&
        Number.isFinite(outputWindow?.windowCenter) &&
        Number.isFinite(outputWindow?.windowWidth) &&
        outputWindow!.windowWidth! > 0
      ) {
        // Undo the calibration window before applying the visible reference's window.
        // Extrapolate before clipping so a wider window can still reveal highlight detail.
        const nativeReference = (mapped - 0.5) * tone.referenceWindow.windowWidth + tone.referenceWindow.windowCenter;
        mapped = (nativeReference - outputWindow!.windowCenter!) / outputWindow!.windowWidth! + 0.5;
      }
      return Math.max(0, Math.min(1, mapped));
    }
    from = nextFrom;
    to = nextTo;
  }
  return 1;
}
