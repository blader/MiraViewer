/**
 * Centralized storage keys for MiraViewer.
 *
 * All localStorage keys and cookie names used by the application are defined here
 * to make it easy to track what the app persists and to ensure ClearDataModal
 * can reliably clear all stored data.
 */

// ─────────────────────────────────────────────────────────────────────────────
// LocalStorage keys
// ─────────────────────────────────────────────────────────────────────────────

/** Comparison view filters (plane, sequence, enabled dates). */
export const FILTERS_STORAGE_KEY = 'mira-filters-v2';

/** Comparison UI state (sidebar open/closed). */
export const COMPARISON_UI_STORAGE_KEY = 'miraviewer:comparison-ui:v1';

/** Overlay navigation state (view mode, selected date, play speed). */
export const OVERLAY_NAV_STORAGE_KEY = 'miraviewer:overlay-nav:v1';

/** Per-sequence slice loop playback settings (prefix + seqId). */
export const PLAYBACK_STORAGE_KEY_PREFIX = 'miraviewer:slice-loop-playback:v2:';

// ─────────────────────────────────────────────────────────────────────────────
// Cookie names
// ─────────────────────────────────────────────────────────────────────────────

/** Cross-port slice loop playback cookie (v2). */
export const PLAYBACK_COOKIE_NAME_V2 = 'miraviewer_slice_loop_playback_v2';

// ─────────────────────────────────────────────────────────────────────────────
// Legacy keys (kept for cleanup in ClearDataModal)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Legacy v1 playback storage key.
 * @deprecated Users may still have this data - kept so ClearDataModal can remove it.
 */
export const LEGACY_PLAYBACK_STORAGE_KEY = 'miraviewer:slice-loop-playback:v1';

/**
 * Legacy v1 playback cookie name.
 * @deprecated Users may still have this cookie - kept so ClearDataModal can remove it.
 */
export const LEGACY_PLAYBACK_COOKIE_NAME = 'miraviewer_slice_loop_playback_v1';
