import { useEffect } from 'react';
import type { RefObject } from 'react';

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
