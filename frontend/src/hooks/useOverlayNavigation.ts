import { useState, useEffect, useCallback } from 'react';
import type { SeriesRef } from '../types/api';

export function useOverlayNavigation(
  overlayColumns: { date: string; ref?: SeriesRef }[]
) {
  const [viewMode, setViewMode] = useState<'grid' | 'overlay'>('grid');
  const [overlayDateIndex, setOverlayDateIndexState] = useState(0);
  const [previousOverlayDateIndex, setPreviousOverlayDateIndex] = useState<number | null>(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const [playSpeed, setPlaySpeed] = useState(1000); // ms between frames

  // Track spacebar held state for compare feature
  const [spaceHeld, setSpaceHeld] = useState(false);

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

  // The actual displayed index - show history previous when space is held
  const displayedOverlayIndex =
    spaceHeld && safePreviousOverlayDateIndex !== null
      ? safePreviousOverlayDateIndex
      : safeOverlayDateIndex;
  
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
      // Space: hold to show previous date for comparison
      if (e.key === ' ' && !e.repeat) {
        e.preventDefault();
        setIsPlaying(false);
        setSpaceHeld(true);
      }
    };
    
    const handleKeyUp = (e: KeyboardEvent) => {
      if (e.key === ' ') {
        setSpaceHeld(false);
      }
    };
    
    window.addEventListener('keydown', handleKeyDown);
    window.addEventListener('keyup', handleKeyUp);
    return () => {
      window.removeEventListener('keydown', handleKeyDown);
      window.removeEventListener('keyup', handleKeyUp);
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
