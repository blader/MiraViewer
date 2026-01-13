import { useState, useEffect, useCallback } from 'react';
import type { SeriesRef } from '../types/api';

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
  const [viewMode, setViewModeState] = useState<'grid' | 'overlay'>('grid');
  const [overlayDateIndex, setOverlayDateIndexState] = useState(0);
  const [previousOverlayDateIndex, setPreviousOverlayDateIndex] = useState<number | null>(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const [playSpeed, setPlaySpeed] = useState(1000); // ms between frames

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

  const compareTargetIndex =
    safePreviousOverlayDateIndex !== null ? safePreviousOverlayDateIndex : fallbackCompareIndex;

  const displayedOverlayIndex = spaceHeld ? compareTargetIndex : safeOverlayDateIndex;

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
    displayedOverlayIndex,
    isPlaying,
    setIsPlaying,
    playSpeed,
    setPlaySpeed,
  };
}
