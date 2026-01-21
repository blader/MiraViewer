/**
 * Debug alignment utilities.
 *
 * Enable verbose alignment logging by setting:
 *   localStorage.setItem('miraviewer:debug-alignment', '1')
 */

export const DEBUG_ALIGNMENT_STORAGE_KEY = 'miraviewer:debug-alignment';

export function isDebugAlignmentEnabled(): boolean {
  return typeof window !== 'undefined' && window.localStorage.getItem(DEBUG_ALIGNMENT_STORAGE_KEY) === '1';
}

export function debugAlignmentLog(step: string, details: Record<string, unknown>, enabled: boolean): void {
  if (!enabled) return;
  console.log(`[alignment] ${step}`, details);
}
