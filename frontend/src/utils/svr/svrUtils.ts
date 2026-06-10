/**
 * Shared utility functions for SVR (Slice-to-Volume Reconstruction).
 *
 * These utilities are used across multiple SVR modules to avoid duplication
 * and ensure consistent behavior.
 */

import type { VolumeDims } from './trilinear';

export { clamp01 } from '../math';

/**
 * Throws if the provided AbortSignal has been aborted.
 * Used throughout async SVR operations to support cancellation.
 */
export function assertNotAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw new Error('SVR cancelled');
  }
}

/**
 * Yields control back to the main thread to prevent UI blocking.
 * Should be called periodically during long-running SVR computations.
 *
 * Prefer scheduler.yield (Chrome 129+): purpose-built to let input/rendering run and then
 * resume with high priority. Fall back to a MessageChannel macrotask, which — unlike
 * setTimeout(0) — is exempt from the browser's nested-timer ~4ms clamp; a reconstruction
 * yielding thousands of times in a chain would otherwise pay seconds of pure timer
 * latency, which is why callers historically yielded only every N slices. Plain setTimeout
 * remains as the last resort for environments without MessageChannel.
 */
export function yieldToMain(): Promise<void> {
  const sched = (globalThis as { scheduler?: { yield?: () => Promise<void> } }).scheduler;
  if (typeof sched?.yield === 'function') {
    return sched.yield();
  }

  if (typeof MessageChannel !== 'undefined') {
    return new Promise((resolve) => {
      const ch = new MessageChannel();
      ch.port1.onmessage = () => {
        ch.port1.close();
        resolve();
      };
      ch.port2.postMessage(null);
    });
  }

  return new Promise((resolve) => setTimeout(resolve, 0));
}

/**
 * Checks if a voxel coordinate is within the support of trilinear interpolation.
 *
 * For trilinear sampling/splatting, we need both the floor and ceil of each
 * coordinate to be valid indices:
 * - floor >= 0
 * - ceil < dim
 *
 * This is equivalent to: 0 <= coord < dim - 1
 *
 * @param dims - Volume dimensions
 * @param x - X coordinate in voxel space
 * @param y - Y coordinate in voxel space
 * @param z - Z coordinate in voxel space
 * @returns true if the coordinate is within valid trilinear interpolation bounds
 */
export function withinTrilinearSupport(dims: VolumeDims, x: number, y: number, z: number): boolean {
  return x >= 0 && y >= 0 && z >= 0 && x < dims.nx - 1 && y < dims.ny - 1 && z < dims.nz - 1;
}

/**
 * Clamps a number's absolute value to a maximum.
 * Returns 0 for non-finite inputs.
 *
 * @param x - Value to clamp
 * @param maxAbs - Maximum absolute value allowed
 */
export function clampAbs(x: number, maxAbs: number): number {
  if (!Number.isFinite(x)) return 0;
  if (!Number.isFinite(maxAbs) || maxAbs <= 0) return 0;
  return x < -maxAbs ? -maxAbs : x > maxAbs ? maxAbs : x;
}

/**
 * Formats a byte count as a human-readable MiB string.
 */
export function formatMiB(bytes: number): string {
  return `${Math.round(bytes / (1024 * 1024))}MiB`;
}

/**
 * Computes a quantile value from a pre-sorted array.
 *
 * @param sorted - Array of numbers, already sorted ascending
 * @param q - Quantile in [0, 1] (e.g., 0.5 for median)
 * @returns Interpolated quantile value
 */
export function quantileSorted(sorted: number[], q: number): number {
  const n = sorted.length;
  if (n === 0) return 0;

  const qq = q < 0 ? 0 : q > 1 ? 1 : q;
  const idx = qq * (n - 1);
  const i0 = Math.floor(idx);
  const i1 = Math.min(n - 1, i0 + 1);
  const t = idx - i0;
  const a = sorted[i0] ?? 0;
  const b = sorted[i1] ?? a;
  return a + (b - a) * t;
}
