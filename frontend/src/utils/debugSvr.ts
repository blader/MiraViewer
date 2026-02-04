/**
 * Debug SVR utilities.
 *
 * Defaults:
 * - In DEV builds, SVR debug logging is enabled by default.
 * - In production builds, it is opt-in.
 *
 * You can always override via localStorage:
 *   localStorage.setItem('miraviewer:debug-svr', '1') // force on
 *   localStorage.setItem('miraviewer:debug-svr', '0') // force off
 */

export const DEBUG_SVR_STORAGE_KEY = 'miraviewer:debug-svr';

export function isDebugSvrEnabled(): boolean {
  if (typeof window === 'undefined') return false;

  try {
    const v = window.localStorage.getItem(DEBUG_SVR_STORAGE_KEY);
    if (v === '1') return true;
    if (v === '0') return false;

    // If the key is unset, default to on in dev builds so SVR work is visible without setup.
    return !!import.meta.env.DEV;
  } catch {
    return false;
  }
}

export function debugSvrLog(step: string, details: Record<string, unknown>, enabled: boolean): void {
  if (!enabled) return;
  console.log(`[svr] ${step}`, details);
}
