/**
 * Debug alignment utilities.
 *
 * Enable verbose alignment logging by setting:
 *   localStorage.setItem('miraviewer:debug-alignment', '1')
 */

export const DEBUG_ALIGNMENT_STORAGE_KEY = 'miraviewer:debug-alignment';

const debugKeyListeners = new Set<() => void>();
let debugKeyHeld = false;

function publishDebugKey(held: boolean): void {
  if (debugKeyHeld === held) return;
  debugKeyHeld = held;
  for (const listener of [...debugKeyListeners]) {
    if (debugKeyListeners.has(listener)) listener();
  }
}

function onDebugKeyDown(event: KeyboardEvent): void {
  if (event.key.toLowerCase() !== 'z' || event.metaKey || event.ctrlKey || event.altKey) return;
  const target = event.target;
  if (
    target instanceof HTMLElement &&
    (target.isContentEditable || target.closest('input, textarea, select, [role="dialog"], [aria-modal="true"]'))
  ) {
    return;
  }
  publishDebugKey(true);
}

function onDebugKeyUp(event: KeyboardEvent): void {
  if (event.key.toLowerCase() === 'z') publishDebugKey(false);
}

function onDebugWindowBlur(): void {
  publishDebugKey(false);
}

/** Mount at most one diagnostic keyboard scope regardless of the number of displayed panels. */
export function subscribeToDebugAlignmentKey(listener: () => void): () => void {
  if (typeof window === 'undefined') return () => undefined;
  if (debugKeyListeners.size === 0) {
    window.addEventListener('keydown', onDebugKeyDown);
    window.addEventListener('keyup', onDebugKeyUp);
    window.addEventListener('blur', onDebugWindowBlur);
  }
  debugKeyListeners.add(listener);
  return () => {
    debugKeyListeners.delete(listener);
    if (debugKeyListeners.size === 0) {
      window.removeEventListener('keydown', onDebugKeyDown);
      window.removeEventListener('keyup', onDebugKeyUp);
      window.removeEventListener('blur', onDebugWindowBlur);
      debugKeyHeld = false;
    }
  };
}

export function isDebugAlignmentKeyHeld(): boolean {
  return debugKeyHeld;
}

export function isDebugAlignmentEnabled(): boolean {
  return typeof window !== 'undefined' && window.localStorage.getItem(DEBUG_ALIGNMENT_STORAGE_KEY) === '1';
}

export function debugAlignmentLog(step: string, details: Record<string, unknown>, enabled: boolean): void {
  if (!enabled) return;
  console.log(`[alignment] ${step}`, details);
}
