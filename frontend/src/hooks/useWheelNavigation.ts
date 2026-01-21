import { useEffect } from 'react';
import type { RefObject } from 'react';

/**
 * Per-viewer wheel slice navigation.
 *
 * This attaches a non-passive wheel listener to the provided element and calls
 * `preventDefault()` so the page doesn't scroll while the user is scrolling slices.
 *
 * Note: The app also installs a catch-all wheel listener via `useGlobalSliceWheelNavigation`.
 * That listener checks `e.defaultPrevented`, so it won't double-apply when a DicomViewer handled
 * the wheel event.
 */
export function useWheelNavigation(
  ref: RefObject<HTMLElement | null>,
  instanceIndex: number,
  maxIndex: number,
  setInstanceIndex: (index: number) => void,
  enabled: boolean = true
) {
  useEffect(() => {
    const element = ref.current;
    if (!element) return;

    const handleWheel = (e: WheelEvent) => {
      if (!enabled || maxIndex <= 0) return;

      e.preventDefault();
      const delta = Math.sign(e.deltaY);
      const nextIndex = Math.max(0, Math.min(maxIndex - 1, instanceIndex + delta));
      if (nextIndex !== instanceIndex) {
        setInstanceIndex(nextIndex);
      }
    };

    element.addEventListener('wheel', handleWheel, { passive: false });
    return () => {
      element.removeEventListener('wheel', handleWheel);
    };
  }, [ref, enabled, maxIndex, instanceIndex, setInstanceIndex]);
}
