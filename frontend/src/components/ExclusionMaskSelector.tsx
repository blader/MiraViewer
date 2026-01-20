import { useState, useRef, useCallback, useEffect, useLayoutEffect } from 'react';
import { X, MousePointer, Square, RefreshCcw } from 'lucide-react';
import cornerstone from 'cornerstone-core';
import { getImageIdForInstance } from '../utils/localApi';
import type { ExclusionMask } from '../types/api';

interface ExclusionMaskSelectorProps {
  /** Series UID of the reference image. */
  seriesUid: string;
  /** Instance index of the reference slice. */
  instanceIndex: number;
  /** Called when user confirms (with optional mask) or cancels. */
  onConfirm: (mask: ExclusionMask | null) => void;
  /** Called when user cancels. */
  onCancel: () => void;
}

/**
 * Modal that displays the reference image and lets the user draw a rectangle
 * to exclude from MI/NMI similarity calculations during alignment.
 */
export function ExclusionMaskSelector({
  seriesUid,
  instanceIndex,
  onConfirm,
  onCancel,
}: ExclusionMaskSelectorProps) {
  const [imageLoaded, setImageLoaded] = useState(false);
  const [rect, setRect] = useState<ExclusionMask | null>(null);
  const [isDrawing, setIsDrawing] = useState(false);
  const [drawStart, setDrawStart] = useState<{ x: number; y: number } | null>(null);

  const containerRef = useRef<HTMLDivElement>(null);
  const cornerstoneRef = useRef<HTMLDivElement>(null);

  // Enable Cornerstone on the element and load the image.
  useLayoutEffect(() => {
    const el = cornerstoneRef.current;
    if (!el) return;

    let cancelled = false;
    cornerstone.enable(el);

    (async () => {
      try {
        const imageId = await getImageIdForInstance(seriesUid, instanceIndex);
        if (cancelled) return;

        const image = await cornerstone.loadImage(imageId);
        if (cancelled) return;

        const viewport = cornerstone.getDefaultViewportForImage(el, image);
        cornerstone.displayImage(el, image, viewport);
        setImageLoaded(true);
      } catch (e) {
        console.error('[ExclusionMaskSelector] Failed to load image:', e);
      }
    })();

    return () => {
      cancelled = true;
      try {
        cornerstone.disable(el);
      } catch {
        // ignore
      }
    };
  }, [seriesUid, instanceIndex]);

  // Convert mouse position to normalized [0,1] coordinates relative to the Cornerstone canvas.
  const getNormalizedPosition = useCallback(
    (clientX: number, clientY: number): { x: number; y: number } | null => {
      const el = cornerstoneRef.current;
      if (!el) return null;

      const elRect = el.getBoundingClientRect();
      const x = (clientX - elRect.left) / elRect.width;
      const y = (clientY - elRect.top) / elRect.height;

      return {
        x: Math.max(0, Math.min(1, x)),
        y: Math.max(0, Math.min(1, y)),
      };
    },
    []
  );

  const handleMouseDown = useCallback(
    (e: React.MouseEvent) => {
      if (!imageLoaded) return;

      const pos = getNormalizedPosition(e.clientX, e.clientY);
      if (!pos) return;

      setIsDrawing(true);
      setDrawStart(pos);
      setRect(null);
    },
    [getNormalizedPosition, imageLoaded]
  );

  const handleMouseMove = useCallback(
    (e: React.MouseEvent) => {
      if (!isDrawing || !drawStart) return;

      const pos = getNormalizedPosition(e.clientX, e.clientY);
      if (!pos) return;

      // Calculate the rectangle from start to current position.
      const x = Math.min(drawStart.x, pos.x);
      const y = Math.min(drawStart.y, pos.y);
      const width = Math.abs(pos.x - drawStart.x);
      const height = Math.abs(pos.y - drawStart.y);

      if (width > 0.01 && height > 0.01) {
        setRect({ x, y, width, height });
      }
    },
    [isDrawing, drawStart, getNormalizedPosition]
  );

  const handleMouseUp = useCallback(() => {
    setIsDrawing(false);
    setDrawStart(null);
  }, []);

  const handleClear = useCallback(() => {
    setRect(null);
  }, []);

  const handleConfirm = useCallback(() => {
    onConfirm(rect);
  }, [onConfirm, rect]);

  // Keyboard handling.
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onCancel();
      } else if (e.key === 'Enter') {
        handleConfirm();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [onCancel, handleConfirm]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70"
      onClick={onCancel}
    >
      <div
        className="bg-[var(--bg-secondary)] border border-[var(--border-color)] rounded-xl shadow-2xl max-w-3xl w-full mx-4 overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-[var(--border-color)]">
          <div>
            <h2 className="text-lg font-semibold">Exclude Region from Alignment</h2>
            <p className="text-sm text-[var(--text-secondary)] mt-0.5">
              Optionally draw a rectangle around an area (e.g., tumor) to ignore during alignment.
            </p>
          </div>
          <button
            onClick={onCancel}
            className="p-1 rounded hover:bg-[var(--bg-tertiary)] text-[var(--text-secondary)]"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Image area */}
        <div
          ref={containerRef}
          className="relative bg-black aspect-square max-h-[60vh] mx-auto cursor-crosshair select-none overflow-hidden"
          onMouseDown={handleMouseDown}
          onMouseMove={handleMouseMove}
          onMouseUp={handleMouseUp}
          onMouseLeave={handleMouseUp}
        >
          {/* Cornerstone rendering element */}
          <div
            ref={cornerstoneRef}
            className="w-full h-full"
          />

          {!imageLoaded && (
            <div className="absolute inset-0 flex items-center justify-center">
              <div className="w-8 h-8 border-2 border-[var(--accent)] border-t-transparent rounded-full animate-spin" />
            </div>
          )}

          {/* Draw rectangle overlay */}
          {rect && (
            <div
              className="absolute border-2 border-red-500 bg-red-500/20 pointer-events-none"
              style={{
                left: `${rect.x * 100}%`,
                top: `${rect.y * 100}%`,
                width: `${rect.width * 100}%`,
                height: `${rect.height * 100}%`,
              }}
            >
              <div className="absolute -top-6 left-0 text-xs text-red-400 bg-black/60 px-1 rounded whitespace-nowrap">
                Excluded region
              </div>
            </div>
          )}

          {/* Drawing cursor feedback */}
          {isDrawing && drawStart && !rect && (
            <div
              className="absolute w-2 h-2 bg-red-500 rounded-full -translate-x-1 -translate-y-1 pointer-events-none"
              style={{
                left: `${drawStart.x * 100}%`,
                top: `${drawStart.y * 100}%`,
              }}
            />
          )}
        </div>

        {/* Instructions */}
        <div className="px-5 py-3 border-t border-[var(--border-color)] text-sm text-[var(--text-secondary)] flex items-center gap-2">
          <MousePointer className="w-4 h-4" />
          <span>Click and drag to draw exclusion rectangle</span>
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between px-5 py-4 border-t border-[var(--border-color)] bg-[var(--bg-tertiary)]">
          <div className="flex items-center gap-2">
            {rect && (
              <button
                onClick={handleClear}
                className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm hover:bg-[var(--bg-secondary)] text-[var(--text-secondary)]"
              >
                <RefreshCcw className="w-4 h-4" />
                Clear
              </button>
            )}
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={onCancel}
              className="px-4 py-2 rounded-lg text-sm hover:bg-[var(--bg-secondary)] text-[var(--text-secondary)]"
            >
              Cancel
            </button>
            <button
              onClick={handleConfirm}
              className="flex items-center gap-1.5 px-4 py-2 rounded-lg text-sm bg-[var(--accent)] text-white hover:bg-[var(--accent-hover)]"
            >
              {rect ? (
                <>
                  <Square className="w-4 h-4" />
                  Align with Exclusion
                </>
              ) : (
                'Skip & Align All'
              )}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
