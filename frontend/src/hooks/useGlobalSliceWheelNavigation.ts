import { useEffect } from 'react';
import type { MutableRefObject, RefObject } from 'react';
import { getProgressFromSlice, getSliceIndex } from '../utils/math';
import { hasEditableAncestor, hasScrollableAncestor } from '../utils/dom';

export type GlobalSliceWheelNavContext = {
  instanceCount: number;
  offset: number;
};

/**
 * Global wheel slice navigation for the center pane.
 *
 * This is a catch-all: it listens on `window` and only reacts to wheel events whose targets
 * are inside `centerPaneRef`.
 *
 * It is designed to coexist with per-viewer wheel handlers (e.g. DicomViewer zoom):
 * - If a nested component handled the wheel event, it calls `preventDefault()`.
 * - This global handler checks `e.defaultPrevented` and bails out to avoid double-applying.
 *
 * It also avoids hijacking normal scrolling by bailing out when:
 * - the event came from editable elements, or
 * - the wheel would scroll a nested overflow container (sidebars/modals), or
 * - the event looks like a pinch-zoom gesture (`ctrlKey`).
 */
export function useGlobalSliceWheelNavigation(opts: {
  centerPaneRef: RefObject<HTMLElement | null>;
  contextRef: MutableRefObject<GlobalSliceWheelNavContext | null>;
  progressRef: MutableRefObject<number>;
  setProgressRef: MutableRefObject<(nextProgress: number) => void>;
}) {
  const { centerPaneRef, contextRef, progressRef, setProgressRef } = opts;

  useEffect(() => {
    const handleWheel = (e: WheelEvent) => {
      // If a nested component (e.g. a DicomViewer) handled it already, don't double-apply.
      if (e.defaultPrevented) return;

      // Trackpad pinch-zoom sends ctrlKey wheel events; don't hijack those.
      if (e.ctrlKey) return;

      // Only slice-scroll when the wheel event originated inside the center pane.
      const centerPane = centerPaneRef.current;
      if (!centerPane) return;
      if (!(e.target instanceof Node) || !centerPane.contains(e.target)) return;

      if (!Number.isFinite(e.deltaY) || e.deltaY === 0) return;

      // Don't slice when the user is interacting with text inputs or editable content.
      if (hasEditableAncestor(e.target)) return;

      // Don't slice when the wheel should scroll an overflow container (modals, panels, etc).
      //
      // Important: We intentionally stop the search at the center pane so the document/body
      // scrolling doesn't disable slice-wheel navigation.
      if (hasScrollableAncestor(e.target, e.deltaY, centerPane)) return;

      const ctx = contextRef.current;
      if (!ctx) return;

      const delta = Math.sign(e.deltaY);
      if (delta === 0) return;

      const currentProgress = progressRef.current;
      const currentIndex = getSliceIndex(ctx.instanceCount, currentProgress, ctx.offset);
      const nextIndex = Math.max(0, Math.min(ctx.instanceCount - 1, currentIndex + delta));
      if (nextIndex === currentIndex) return;

      const nextProgress = getProgressFromSlice(nextIndex, ctx.instanceCount, ctx.offset);
      if (nextProgress === currentProgress) return;

      e.preventDefault();
      progressRef.current = nextProgress;
      setProgressRef.current(nextProgress);
    };

    window.addEventListener('wheel', handleWheel, { passive: false });
    return () => window.removeEventListener('wheel', handleWheel);
  }, [centerPaneRef, contextRef, progressRef, setProgressRef]);
}
