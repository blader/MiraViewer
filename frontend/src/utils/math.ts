/**
 * Clamp a number to a range.
 */
export function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

/**
 * Clamp and truncate to an integer.
 */
export function clampInt(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, Math.trunc(value)));
}

/**
 * Map a logical slice index (0..N-1) to the physical DICOM instance index.
 *
 * When `reverseSliceOrder` is enabled, logical index 0 maps to the last instance.
 */
export function getEffectiveInstanceIndex(
  instanceIndex: number,
  instanceCount: number,
  reverseSliceOrder: boolean
): number {
  const max = Math.max(0, instanceCount - 1);
  const clamped = clampInt(instanceIndex, 0, max);
  return reverseSliceOrder ? max - clamped : clamped;
}

/**
 * Calculate the slice index from a normalized progress value plus an offset.
 */
export function getSliceIndex(instanceCount: number, progress: number, offset: number): number {
  const max = Math.max(0, instanceCount - 1);
  const base = max > 0 ? Math.round(clamp(progress, 0, 1) * max) : 0;
  return clampInt(base + offset, 0, max);
}

/**
 * Calculate normalized progress from a slice index and offset.
 */
export function getProgressFromSlice(
  instanceIndex: number,
  instanceCount: number,
  offset: number
): number {
  const denom = Math.max(1, instanceCount - 1);
  return clamp((instanceIndex - offset) / denom, 0, 1);
}

/**
 * Normalize rotation degrees to [-180, 180].
 */
export function normalizeRotation(degrees: number): number {
  return (((degrees + 180) % 360) + 360) % 360 - 180;
}
