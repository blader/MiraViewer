import { useState, useEffect, useCallback, useRef } from 'react';
import type { SeriesRef } from '../types/api';
import { readLocalStorageJson, writeLocalStorageJson } from '../utils/persistence';
import { OVERLAY_NAV_STORAGE_KEY } from '../utils/storageKeys';

type PersistedOverlayNav = {
  viewMode?: 'grid' | 'overlay' | 'svr3d';
  overlayDate?: string;
  overlayStudyUid?: string;
  playSpeed?: number;
};

function readPersistedOverlayNav(): PersistedOverlayNav {
  const parsed = readLocalStorageJson(OVERLAY_NAV_STORAGE_KEY);
  if (!parsed || typeof parsed !== 'object') return {};

  const obj = parsed as Record<string, unknown>;

  const viewMode =
    obj.viewMode === 'overlay'
      ? 'overlay'
      : obj.viewMode === 'grid'
        ? 'grid'
        : obj.viewMode === 'svr3d'
          ? 'svr3d'
          : undefined;
  const overlayDate = typeof obj.overlayDate === 'string' ? obj.overlayDate : undefined;
  const overlayStudyUid = typeof obj.overlayStudyUid === 'string' ? obj.overlayStudyUid : undefined;
  const playSpeed = typeof obj.playSpeed === 'number' && Number.isFinite(obj.playSpeed) ? obj.playSpeed : undefined;

  return { viewMode, overlayDate, overlayStudyUid, playSpeed };
}

function getUtcDateMs(date: string) {
  const timestamp = date.split('#', 1)[0];
  if (!timestamp) return null;
  const utcTimestamp =
    timestamp.includes('T') && !/(?:Z|[+-]\d{2}:\d{2})$/i.test(timestamp) ? `${timestamp}Z` : timestamp;
  const milliseconds = Date.parse(utcTimestamp);
  return Number.isFinite(milliseconds) ? milliseconds : null;
}

export function useOverlayNavigation(
  overlayColumns: { date: string; ref?: SeriesRef }[],
  options: { interactionBlocked?: boolean } = {},
) {
  const { interactionBlocked = false } = options;
  const [initialPersistedNav] = useState(readPersistedOverlayNav);
  const persistedRef = useRef<PersistedOverlayNav>(initialPersistedNav);

  const persist = useCallback((update: PersistedOverlayNav) => {
    const next: PersistedOverlayNav = { ...persistedRef.current, ...update };
    persistedRef.current = next;
    writeLocalStorageJson(OVERLAY_NAV_STORAGE_KEY, next);
  }, []);

  const [viewMode, setViewModeState] = useState<'grid' | 'overlay' | 'svr3d'>(initialPersistedNav.viewMode ?? 'grid');
  const [overlayDateNavigation, setOverlayDateNavigation] = useState<{
    selected: string | null;
    previous: string | null;
  }>({
    selected: initialPersistedNav.overlayStudyUid ?? initialPersistedNav.overlayDate ?? null,
    previous: null,
  });
  const [isPlaying, setIsPlaying] = useState(false);
  const [playSpeed, setPlaySpeedState] = useState(initialPersistedNav.playSpeed ?? 1000); // ms between frames

  // Track spacebar held state for compare feature
  const [spaceHeld, setSpaceHeld] = useState(false);

  useEffect(() => {
    if (!interactionBlocked) return;
    const timer = window.setTimeout(() => {
      setSpaceHeld(false);
      setIsPlaying(false);
    }, 0);
    return () => window.clearTimeout(timer);
  }, [interactionBlocked]);

  const setViewMode = useCallback((next: 'grid' | 'overlay' | 'svr3d') => {
    setViewModeState(next);

    // Avoid getting stuck in compare mode if the user releases Space while not in overlay mode.
    if (next !== 'overlay') {
      setSpaceHeld(false);
      setIsPlaying(false);
    }
  }, []);

  // Persist view mode and play speed so we can resume after a hard refresh.
  useEffect(() => {
    persist({ viewMode });
  }, [persist, viewMode]);

  const setPlaySpeed = useCallback((ms: number) => {
    setPlaySpeedState(ms);
  }, []);

  useEffect(() => {
    persist({ playSpeed });
  }, [persist, playSpeed]);

  const maxOverlayIndex = Math.max(0, overlayColumns.length - 1);
  const indexOfExamination = (identity: string | null) =>
    overlayColumns.findIndex(
      (column) => (column.ref?.study_id ?? column.date) === identity || column.date === identity,
    );
  const selectedIndex = indexOfExamination(overlayDateNavigation.selected);
  const safeOverlayDateIndex = Math.max(0, selectedIndex);

  const setOverlayDateIndex = useCallback(
    (next: number | ((prev: number) => number)) => {
      setOverlayDateNavigation((previous) => {
        const safePrev = Math.max(
          0,
          overlayColumns.findIndex(
            (column) =>
              (column.ref?.study_id ?? column.date) === previous.selected || column.date === previous.selected,
          ),
        );
        const resolved = typeof next === 'function' ? next(safePrev) : next;
        const clamped = Math.max(0, Math.min(maxOverlayIndex, resolved));
        const column = overlayColumns[clamped];
        if (!column) return previous;
        const current = column.ref?.study_id ?? column.date;
        return current === previous.selected ? previous : { selected: current, previous: previous.selected };
      });
    },
    [maxOverlayIndex, overlayColumns],
  );

  // Bind the first available examination and upgrade date-only preferences once.
  // This guarded state adjustment avoids an effect-render cycle and keeps IDs
  // authoritative before children receive callbacks for the new list.
  const selectedColumn = overlayColumns[safeOverlayDateIndex];
  const selectedIdentity = selectedColumn?.ref?.study_id ?? selectedColumn?.date;
  if (
    selectedIdentity &&
    (overlayDateNavigation.selected === null || selectedIndex >= 0) &&
    selectedIdentity !== overlayDateNavigation.selected
  ) {
    setOverlayDateNavigation({ ...overlayDateNavigation, selected: selectedIdentity });
  }
  const previousIndex = indexOfExamination(overlayDateNavigation.previous);
  const safePreviousOverlayDateIndex = previousIndex < 0 ? null : previousIndex;

  // Space-hold compare behavior:
  // - Prefer the actual navigation history (previousOverlayDateIndex)
  // - If there is no history yet, fall back to the closest adjacent date (when available)
  const fallbackCompareIndex = (() => {
    if (overlayColumns.length < 2) return safeOverlayDateIndex;

    const currentDate = overlayColumns[safeOverlayDateIndex]?.date;
    if (!currentDate) return safeOverlayDateIndex;

    const left = safeOverlayDateIndex > 0 ? safeOverlayDateIndex - 1 : null;
    const right = safeOverlayDateIndex < overlayColumns.length - 1 ? safeOverlayDateIndex + 1 : null;

    if (left === null) return right ?? safeOverlayDateIndex;
    if (right === null) return left;

    const currentMs = getUtcDateMs(currentDate);
    const leftMs = getUtcDateMs(overlayColumns[left]?.date ?? '');
    const rightMs = getUtcDateMs(overlayColumns[right]?.date ?? '');

    // If parsing fails, default to the older adjacent index.
    if (currentMs === null || leftMs === null || rightMs === null) return left;

    const leftDiff = Math.abs(currentMs - leftMs);
    const rightDiff = Math.abs(currentMs - rightMs);
    return rightDiff < leftDiff ? right : left;
  })();

  // Prefer navigation history, but only if it points to a *different* index.
  //
  // When the set of overlay columns changes (dates enabled/disabled), indices can collapse and
  // the clamped previous index may end up equal to the current index. In that case we should
  // fall back to the closest adjacent date so Space-compare still works.
  const compareTargetIndex =
    safePreviousOverlayDateIndex !== null && safePreviousOverlayDateIndex !== safeOverlayDateIndex
      ? safePreviousOverlayDateIndex
      : fallbackCompareIndex;

  const displayedOverlayIndex = spaceHeld && !interactionBlocked ? compareTargetIndex : safeOverlayDateIndex;

  // Persist the currently-selected date (not the displayed compare date).
  useEffect(() => {
    const column = overlayColumns[safeOverlayDateIndex];
    if (!column || selectedIndex < 0) return;
    persist({ overlayDate: column.date, overlayStudyUid: column.ref?.study_id });
  }, [persist, overlayColumns, safeOverlayDateIndex, selectedIndex]);

  // Auto-play effect for overlay mode
  useEffect(() => {
    if (interactionBlocked || !isPlaying || viewMode !== 'overlay' || overlayColumns.length < 2) return;
    const interval = setInterval(() => {
      setOverlayDateIndex((prev) => (prev + 1) % overlayColumns.length);
    }, playSpeed);
    return () => clearInterval(interval);
  }, [interactionBlocked, isPlaying, viewMode, overlayColumns.length, playSpeed, setOverlayDateIndex]);

  // Keyboard shortcuts for overlay mode
  useEffect(() => {
    if (interactionBlocked || viewMode !== 'overlay') return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.altKey || e.ctrlKey || e.metaKey) return;
      const target = e.target instanceof Element ? e.target : document.body;
      const owner = target.closest(
        'input, select, textarea, button, a[href], summary, [contenteditable=""], [contenteditable="true"], [role="button"], [role="link"], [role="tab"], [role="slider"], [role="checkbox"], [role="combobox"], [role="menuitem"]',
      );
      if (
        (owner && !owner.matches('[data-overlay-navigation="date"]')) ||
        target.closest('dialog, [role="dialog"], [aria-modal="true"]')
      )
        return;

      // Number keys 1-9 to select date
      if (e.key >= '1' && e.key <= '9') {
        const idx = parseInt(e.key, 10) - 1;
        if (idx < overlayColumns.length) {
          e.preventDefault();
          setOverlayDateIndex(idx);
          setIsPlaying(false);
        }
      }
      // Arrow keys for prev/next
      if (e.key === 'ArrowLeft') {
        e.preventDefault();
        setOverlayDateIndex((prev) => Math.max(0, prev - 1));
        setIsPlaying(false);
      }
      if (e.key === 'ArrowRight') {
        e.preventDefault();
        setOverlayDateIndex((prev) => Math.min(overlayColumns.length - 1, prev + 1));
        setIsPlaying(false);
      }
      // Space: hold to show comparison target (history previous; otherwise nearest adjacent date)
      if (e.key === ' ') {
        e.preventDefault();
        if (!e.repeat) {
          setIsPlaying(false);
          setSpaceHeld(true);
        }
      }
    };

    const handleKeyUp = (e: KeyboardEvent) => {
      if (e.key === ' ') {
        if (spaceHeld && e.target instanceof Element && e.target.closest('[data-overlay-navigation="date"]'))
          e.preventDefault();
        setSpaceHeld(false);
      }
    };

    const handleBlur = () => {
      setSpaceHeld(false);
    };

    window.addEventListener('keydown', handleKeyDown);
    window.addEventListener('keyup', handleKeyUp);
    window.addEventListener('blur', handleBlur);
    return () => {
      window.removeEventListener('keydown', handleKeyDown);
      window.removeEventListener('keyup', handleKeyUp);
      window.removeEventListener('blur', handleBlur);
    };
  }, [interactionBlocked, viewMode, overlayColumns.length, setOverlayDateIndex, spaceHeld]);

  return {
    viewMode,
    setViewMode,
    overlayDateIndex: safeOverlayDateIndex,
    selectionFallback: selectedIndex < 0 && overlayDateNavigation.selected !== null && overlayColumns.length > 0,
    setOverlayDateIndex,
    // Exposed so callers can pre-render/prefetch the compare target and avoid a visible jump
    // when the user holds Space.
    compareTargetIndex,
    displayedOverlayIndex,
    isPlaying: interactionBlocked ? false : isPlaying,
    setIsPlaying,
    playSpeed,
    setPlaySpeed,
  };
}
