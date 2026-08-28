import type { AlignmentAdjustment, AlignmentDisplayBaseline, PanelSettings } from '../types/api';
import { CONTROL_LIMITS } from './constants';
import { clamp, normalizeRotation } from './math';

export const DEFAULT_ALIGNMENT_ADJUSTMENT: AlignmentAdjustment = {
  sliceOffset: 0,
  panX: 0,
  panY: 0,
  rotation: 0,
  zoom: 1,
  brightness: 0,
  contrast: 0,
};

const DISPLAY_FIELDS = [
  'zoom',
  'rotation',
  'panX',
  'panY',
  'brightness',
  'contrast',
  'affine00',
  'affine01',
  'affine10',
  'affine11',
] as const;

export function alignmentDisplayBaseline(settings: PanelSettings): AlignmentDisplayBaseline {
  return Object.fromEntries(DISPLAY_FIELDS.map((key) => [key, settings[key]])) as AlignmentDisplayBaseline;
}

export function normalizeAlignmentBaseline(value: unknown): AlignmentDisplayBaseline | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const source = value as Record<string, unknown>;
  if (DISPLAY_FIELDS.some((key) => typeof source[key] !== 'number' || !Number.isFinite(source[key]))) return undefined;
  if ((source.zoom as number) <= 0) return undefined;
  return Object.fromEntries(DISPLAY_FIELDS.map((key) => [key, source[key]])) as AlignmentDisplayBaseline;
}

/** Missing, old, or malformed stored corrections must never poison a presentation. */
export function normalizeAlignmentAdjustment(value: unknown): AlignmentAdjustment | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const source = value as Record<string, unknown>;
  const result = { ...DEFAULT_ALIGNMENT_ADJUSTMENT };
  for (const key of Object.keys(result) as (keyof AlignmentAdjustment)[]) {
    const candidate = source[key];
    if (typeof candidate !== 'number' || !Number.isFinite(candidate)) continue;
    if (key === 'zoom' && candidate <= 0) continue;
    result[key] = candidate;
  }
  result.sliceOffset = Math.round(clamp(result.sliceOffset, -100_000, 100_000));
  result.rotation = normalizeRotation(result.rotation);
  return Object.keys(result).some(
    (key) =>
      Math.abs(
        result[key as keyof AlignmentAdjustment] - DEFAULT_ALIGNMENT_ADJUSTMENT[key as keyof AlignmentAdjustment],
      ) > 1e-9,
  )
    ? result
    : undefined;
}

/** Slice displacement is applied by the native resampler, not a second time in CSS or the footer. */
export function applyAlignmentAdjustment(
  baseline: PanelSettings,
  adjustment: AlignmentAdjustment | undefined,
): PanelSettings {
  const delta = adjustment ?? DEFAULT_ALIGNMENT_ADJUSTMENT;
  return {
    ...baseline,
    zoom: clamp(baseline.zoom * delta.zoom, CONTROL_LIMITS.ZOOM.MIN, CONTROL_LIMITS.ZOOM.MAX),
    rotation: normalizeRotation(baseline.rotation + delta.rotation),
    panX: clamp(baseline.panX + delta.panX, -1, 1),
    panY: clamp(baseline.panY + delta.panY, -1, 1),
    brightness: clamp(baseline.brightness + delta.brightness, 0, 200),
    contrast: clamp(baseline.contrast + delta.contrast, 0, 200),
    alignmentAdjustment: adjustment,
    alignmentBaseline: adjustment ? alignmentDisplayBaseline(baseline) : undefined,
  };
}

/** Restore the saved base until a fresh automatic result supplies an exact, unclamped one. */
export function removeAlignmentAdjustment(settings: PanelSettings): PanelSettings {
  const delta = settings.alignmentAdjustment ?? DEFAULT_ALIGNMENT_ADJUSTMENT;
  return {
    ...settings,
    zoom: settings.zoom / delta.zoom,
    rotation: normalizeRotation(settings.rotation - delta.rotation),
    panX: settings.panX - delta.panX,
    panY: settings.panY - delta.panY,
    brightness: settings.brightness - delta.brightness,
    contrast: settings.contrast - delta.contrast,
    ...normalizeAlignmentBaseline(settings.alignmentBaseline),
    alignmentAdjustment: undefined,
    alignmentBaseline: undefined,
    alignmentPaused: false,
  };
}

/** Record only the gesture's difference, keeping every other correction and the automatic affine. */
export function adjustAlignment(
  current: PanelSettings,
  update: Partial<PanelSettings>,
  baseline: PanelSettings,
): AlignmentAdjustment | undefined {
  const delta = { ...(current.alignmentAdjustment ?? DEFAULT_ALIGNMENT_ADJUSTMENT) };
  for (const key of ['panX', 'panY', 'rotation', 'brightness', 'contrast'] as const) {
    if (typeof update[key] !== 'number' || !Number.isFinite(update[key]) || update[key] === current[key]) continue;
    const difference = update[key]! - baseline[key];
    delta[key] = key === 'rotation' ? normalizeRotation(difference) : difference;
  }
  if (
    typeof update.zoom === 'number' &&
    Number.isFinite(update.zoom) &&
    update.zoom > 0 &&
    baseline.zoom > 0 &&
    update.zoom !== current.zoom
  ) {
    delta.zoom = update.zoom / baseline.zoom;
  }
  // Reverse-order controls also adjust the logical offset to keep the same physical
  // slice. That bookkeeping must not become an anatomical displacement.
  if (
    typeof update.offset === 'number' &&
    Number.isFinite(update.offset) &&
    (update.reverseSliceOrder === undefined || update.reverseSliceOrder === current.reverseSliceOrder)
  ) {
    delta.sliceOffset += (update.offset - current.offset) * (current.reverseSliceOrder ? -1 : 1);
  }
  return normalizeAlignmentAdjustment(delta);
}
