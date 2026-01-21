import { useState, useEffect, useCallback, useRef } from 'react';
import type { SeriesRef } from '../types/api';
import { readLocalStorageJson, writeLocalStorageJson } from '../utils/persistence';
import { OVERLAY_NAV_STORAGE_KEY } from '../utils/storageKeys';

type PersistedOverlayNav = {
  viewMode?: 'grid' | 'overlay';
  overlayDate?: string;
  playSpeed?: number;
};

function readPersistedOverlayNav(): PersistedOverlayNav {
  const parsed = readLocalStorageJson(OVERLAY_NAV_STORAGE_KEY);
  if (!parsed || typeof parsed !== 'object') return {};

  const obj = parsed as Record<string, unknown>;

  const viewMode = obj.viewMode === 'overlay' ? 'overlay' : obj.viewMode === 'grid' ? 'grid' : undefined;
  const overlayDate = typeof obj.overlayDate === 'string' ? obj.overlayDate : undefined;
  const playSpeed = typeof obj.playSpeed === 'number' && Number.isFinite(obj.playSpeed) ? obj.playSpeed : undefined;

  return { viewMode, overlayDate, playSpeed };
}

function getUtcDateMs(date: string) {
  // Expecting YYYY-MM-DD. Use a UTC timestamp to avoid timezone shifts.
  const parts = date.split('-');
  if (parts.length !== 3) return null;
  const year = Number(parts[0]);
  const month = Number(parts[1]);
  const day = Number(parts[2]);
  if (!Number.isFinite(year) || !Number.isFinite(month) || !Number.isFinite(day)) return null;
  return Date.UTC(year, month - 1, day);
}

export function useOverlayNavigation(
  overlayColumns: { date: string; ref?: SeriesRef }[]
) {
  const persistedRef = useRef<PersistedOverlayNav>(readPersistedOverlayNav());

  const persist = useCallback((update: PersistedOverlayNav) => {
    const next: PersistedOverlayNav = { ...persistedRef.current, ...update };
    persistedRef.current = next;
    writeLocalStorageJson(OVERLAY_NAV_STORAGE_KEY, next);
  }, []);

  const [viewMode, setViewModeState] = useState<'grid' | 'overlay'>(() => {
    return readPersistedOverlayNav().viewMode === 'overlay' ? 'overlay' : 'grid';
  });
  const [overlayDateIndex, setOverlayDateIndexState] = useState(0);
  const [previousOverlayDateIndex, setPreviousOverlayDateIndex] = useState<number | null>(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const [playSpeed, setPlaySpeedState] = useState(() => {
    return readPersistedOverlayNav().playSpeed ?? 1000;
  }); // ms between frames

  // Track spacebar held state for compare feature
  const [spaceHeld, setSpaceHeld] = useState(false);

  const setViewMode = useCallback((next: 'grid' | 'overlay') => {
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

  const setOverlayDateIndex = useCallback(
    (next: number | ((prev: number) => number)) => {
      setOverlayDateIndexState((prev) => {
        const safePrev = Math.max(0, Math.min(maxOverlayIndex, prev));
        const resolved = typeof next === 'function' ? next(safePrev) : next;
        const clamped = Math.max(0, Math.min(maxOverlayIndex, resolved));
        if (clamped !== safePrev) {
          setPreviousOverlayDateIndex(safePrev);
        }
        return clamped;
      });
    },
    [maxOverlayIndex]
  );

  // Read-only, clamped indices (avoid setState in effects when columns shrink).
  const safeOverlayDateIndex = Math.max(0, Math.min(maxOverlayIndex, overlayDateIndex));

  // Hydrate the overlay date from storage (once) after we know which dates are available.
  // If we do restore, skip the first persist pass so we don't overwrite the stored value
  // with the default index (0) for a single render.
  const hydratedOverlayDateRef = useRef(false);
  const skipNextPersistOverlayDateRef = useRef(false);
  useEffect(() => {
    if (hydratedOverlayDateRef.current) return;

    const stored = persistedRef.current.overlayDate;
    if (!stored) {
      hydratedOverlayDateRef.current = true;
      return;
    }

    if (overlayColumns.length === 0) {
      // Wait until we have dates to match against.
      return;
    }

    hydratedOverlayDateRef.current = true;

    const idx = overlayColumns.findIndex((c) => c.date === stored);
    if (idx >= 0 && idx !== safeOverlayDateIndex) {
      skipNextPersistOverlayDateRef.current = true;
      setOverlayDateIndexState(idx);
    }
  }, [overlayColumns, safeOverlayDateIndex]);
  const safePreviousOverlayDateIndex =
    previousOverlayDateIndex === null
      ? null
      : Math.max(0, Math.min(maxOverlayIndex, previousOverlayDateIndex));

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

  const displayedOverlayIndex = spaceHeld ? compareTargetIndex : safeOverlayDateIndex;

  // Persist the currently-selected date (not the displayed compare date).
  useEffect(() => {
    if (skipNextPersistOverlayDateRef.current) {
      skipNextPersistOverlayDateRef.current = false;
      return;
    }

    const date = overlayColumns[safeOverlayDateIndex]?.date;
    if (!date) return;
    persist({ overlayDate: date });
  }, [persist, overlayColumns, safeOverlayDateIndex]);

  // Auto-play effect for overlay mode
  useEffect(() => {
    if (!isPlaying || viewMode !== 'overlay' || overlayColumns.length < 2) return;
    const interval = setInterval(() => {
      setOverlayDateIndex((prev) => (prev + 1) % overlayColumns.length);
    }, playSpeed);
    return () => clearInterval(interval);
  }, [isPlaying, viewMode, overlayColumns.length, playSpeed, setOverlayDateIndex]);
  
  // Keyboard shortcuts for overlay mode
  useEffect(() => {
    if (viewMode !== 'overlay') return;
    const handleKeyDown = (e: KeyboardEvent) => {
      // Ignore if focus is on an input, select, or textarea
      const target = e.target as HTMLElement;
      if (target.tagName === 'INPUT' || target.tagName === 'SELECT' || target.tagName === 'TEXTAREA') {
        return;
      }

      // Number keys 1-9 to select date
      if (e.key >= '1' && e.key <= '9') {
        const idx = parseInt(e.key, 10) - 1;
        if (idx < overlayColumns.length) {
          setOverlayDateIndex(idx);
          setIsPlaying(false);
        }
      }
      // Arrow keys for prev/next
      if (e.key === 'ArrowLeft') {
        setOverlayDateIndex(prev => Math.max(0, prev - 1));
        setIsPlaying(false);
      }
      if (e.key === 'ArrowRight') {
        setOverlayDateIndex(prev => Math.min(overlayColumns.length - 1, prev + 1));
        setIsPlaying(false);
      }
      // Space: hold to show comparison target (history previous; otherwise nearest adjacent date)
      if (e.key === ' ' && !e.repeat) {
        e.preventDefault();
        setIsPlaying(false);
        setSpaceHeld(true);

        // Prevent a focused date button from showing a weird focus/active outline while holding space.
        target.blur();
      }
    };
    
    const handleKeyUp = (e: KeyboardEvent) => {
      if (e.key === ' ') {
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
  }, [viewMode, overlayColumns.length, setOverlayDateIndex]);

  return {
    viewMode,
    setViewMode,
    overlayDateIndex: safeOverlayDateIndex,
    setOverlayDateIndex,
    // Exposed so callers can pre-render/prefetch the compare target and avoid a visible jump
    // when the user holds Space.
    compareTargetIndex,
    displayedOverlayIndex,
    isPlaying,
    setIsPlaying,
    playSpeed,
    setPlaySpeed,
  };
}
