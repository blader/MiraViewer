import { useCallback, useEffect, useRef, useState } from 'react';
import { Link2, X } from 'lucide-react';
import type { ExclusionMask, PanelSettings } from '../types/api';

type Point = { x: number; y: number };

type RectPx = { x: number; y: number; width: number; height: number };

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function invert2x2(a00: number, a01: number, a10: number, a11: number): { i00: number; i01: number; i10: number; i11: number } | null {
  const det = a00 * a11 - a01 * a10;
  if (!Number.isFinite(det) || Math.abs(det) < 1e-10) return null;
  const invDet = 1 / det;
  return {
    i00: a11 * invDet,
    i01: -a01 * invDet,
    i10: -a10 * invDet,
    i11: a00 * invDet,
  };
}

function screenToBasePoint(
  p: Point,
  size: { width: number; height: number },
  geometry: Pick<PanelSettings, 'panX' | 'panY' | 'zoom' | 'rotation' | 'affine00' | 'affine01' | 'affine10' | 'affine11'>
): Point {
  const w = size.width;
  const h = size.height;

  const cx = w / 2;
  const cy = h / 2;

  const panXPx = geometry.panX * w;
  const panYPx = geometry.panY * h;

  // pRel is in display space relative to center.
  let x = p.x - cx;
  let y = p.y - cy;

  // Undo pan.
  x -= panXPx;
  y -= panYPx;

  // Undo scale.
  const s = geometry.zoom;
  if (Number.isFinite(s) && Math.abs(s) > 1e-8) {
    x /= s;
    y /= s;
  }

  // Undo rotation.
  const theta = (geometry.rotation * Math.PI) / 180;
  if (Number.isFinite(theta) && theta !== 0) {
    const c = Math.cos(-theta);
    const sn = Math.sin(-theta);
    const xr = c * x - sn * y;
    const yr = sn * x + c * y;
    x = xr;
    y = yr;
  }

  // Undo affine residual.
  const invA = invert2x2(geometry.affine00, geometry.affine01, geometry.affine10, geometry.affine11);
  if (invA) {
    const xa = invA.i00 * x + invA.i01 * y;
    const ya = invA.i10 * x + invA.i11 * y;
    x = xa;
    y = ya;
  }

  return { x: x + cx, y: y + cy };
}

function rectFromPoints(a: Point, b: Point): RectPx {
  const x0 = Math.min(a.x, b.x);
  const y0 = Math.min(a.y, b.y);
  const x1 = Math.max(a.x, b.x);
  const y1 = Math.max(a.y, b.y);
  return { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
}

function computeMaskFromScreenRect(
  rect: RectPx,
  size: { width: number; height: number },
  geometry: Pick<PanelSettings, 'panX' | 'panY' | 'zoom' | 'rotation' | 'affine00' | 'affine01' | 'affine10' | 'affine11'>
): ExclusionMask {
  const w = size.width;
  const h = size.height;

  // Map all four corners to base space, then take an axis-aligned bounding box.
  const corners: Point[] = [
    { x: rect.x, y: rect.y },
    { x: rect.x + rect.width, y: rect.y },
    { x: rect.x, y: rect.y + rect.height },
    { x: rect.x + rect.width, y: rect.y + rect.height },
  ];

  const baseCorners = corners.map((p) => screenToBasePoint(p, size, geometry));

  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;

  for (const p of baseCorners) {
    if (p.x < minX) minX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.x > maxX) maxX = p.x;
    if (p.y > maxY) maxY = p.y;
  }

  minX = clamp(minX, 0, w);
  minY = clamp(minY, 0, h);
  maxX = clamp(maxX, 0, w);
  maxY = clamp(maxY, 0, h);

  const x = w > 0 ? clamp(minX / w, 0, 1) : 0;
  const y = h > 0 ? clamp(minY / h, 0, 1) : 0;
  const width = w > 0 ? clamp((maxX - minX) / w, 0, 1) : 0;
  const height = h > 0 ? clamp((maxY - minY) / h, 0, 1) : 0;

  return { x, y, width, height };
}

export interface DragRectActionOverlayProps {
  /**
   * Geometry used to interpret the drawn rectangle.
   *
   * This should match the *displayed* geometry (pan/zoom/rotation/affine) for the viewer.
   */
  geometry: Pick<PanelSettings, 'panX' | 'panY' | 'zoom' | 'rotation' | 'affine00' | 'affine01' | 'affine10' | 'affine11'>;
  /** Called when user clicks the in-rect action button. */
  onConfirm: (mask: ExclusionMask) => void;
  /** Optional hook fired once when a drag begins (after threshold). */
  onDragBegin?: () => void;
  /** Disable interaction (still renders children). */
  disabled?: boolean;
  /** Action button label (default: Align All). */
  actionLabel?: string;
  /** Optional title text shown in the button tooltip. */
  actionTitle?: string;
  /**
   * Minimum drag distance in CSS pixels before we treat the gesture as a rectangle draw.
   * (Default: 4)
   */
  dragThresholdPx?: number;
  /**
   * Minimum rectangle size in normalized units before enabling action.
   * (Default: 0.01)
   */
  minMaskSize?: number;
  className?: string;
  children: React.ReactNode;
}

export function DragRectActionOverlay({
  geometry,
  onConfirm,
  onDragBegin,
  disabled = false,
  actionLabel = 'Align All',
  actionTitle,
  dragThresholdPx = 4,
  minMaskSize = 0.01,
  className,
  children,
}: DragRectActionOverlayProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);

  const [drag, setDrag] = useState<{
    pointerId: number;
    start: Point;
    current: Point;
    didExceedThreshold: boolean;
  } | null>(null);

  const [selection, setSelection] = useState<{ rect: RectPx; mask: ExclusionMask } | null>(null);

  const didDragRef = useRef(false);

  const getLocalPoint = useCallback((e: PointerEvent | React.PointerEvent): Point | null => {
    const el = containerRef.current;
    if (!el) return null;
    const r = el.getBoundingClientRect();
    const x = (e as PointerEvent).clientX - r.left;
    const y = (e as PointerEvent).clientY - r.top;
    return { x: clamp(x, 0, r.width), y: clamp(y, 0, r.height) };
  }, []);

  const currentRect = drag && drag.didExceedThreshold ? rectFromPoints(drag.start, drag.current) : null;

  const onPointerDownCapture = useCallback(
    (e: React.PointerEvent) => {
      if (disabled) return;
      if (!e.isPrimary) return;
      if (e.button !== 0) return;

      // Ignore pointer downs that originate on the action/close buttons.
      const target = e.target as HTMLElement | null;
      if (target?.closest('[data-drag-rect-action-button="true"]')) return;

      const p = getLocalPoint(e);
      if (!p) return;

      didDragRef.current = false;

      setDrag({
        pointerId: e.pointerId,
        start: p,
        current: p,
        didExceedThreshold: false,
      });
    },
    [disabled, getLocalPoint]
  );

  const onPointerMoveCapture = useCallback(
    (e: React.PointerEvent) => {
      if (!drag) return;
      if (e.pointerId !== drag.pointerId) return;

      const p = getLocalPoint(e);
      if (!p) return;

      const dx = p.x - drag.start.x;
      const dy = p.y - drag.start.y;
      const dist = Math.hypot(dx, dy);

      if (!drag.didExceedThreshold && dist >= dragThresholdPx) {
        didDragRef.current = true;
        onDragBegin?.();

        // Ensure we keep receiving move/up even if pointer leaves the element.
        try {
          containerRef.current?.setPointerCapture(e.pointerId);
        } catch {
          // ignore
        }

        // Clear any previous selection once we actually start a new drag.
        setSelection(null);
        setDrag((prev) => (prev ? { ...prev, current: p, didExceedThreshold: true } : prev));
        return;
      }

      setDrag((prev) => (prev ? { ...prev, current: p } : prev));
    },
    [drag, dragThresholdPx, getLocalPoint, onDragBegin]
  );

  const onPointerUpCapture = useCallback(
    (e: React.PointerEvent) => {
      if (!drag) return;
      if (e.pointerId !== drag.pointerId) return;

      try {
        containerRef.current?.releasePointerCapture(e.pointerId);
      } catch {
        // ignore
      }

      const p = getLocalPoint(e);
      const finalPoint = p ?? drag.current;

      if (drag.didExceedThreshold) {
        const rect = rectFromPoints(drag.start, finalPoint);

        const el = containerRef.current;
        const r = el?.getBoundingClientRect();
        const size = { width: r?.width ?? 0, height: r?.height ?? 0 };

        const mask = computeMaskFromScreenRect(rect, size, geometry);
        setSelection({ rect, mask });
      }

      setDrag(null);
    },
    [drag, geometry, getLocalPoint]
  );

  const onPointerCancelCapture = useCallback(
    (e: React.PointerEvent) => {
      if (!drag) return;
      if (e.pointerId !== drag.pointerId) return;
      setDrag(null);
    },
    [drag]
  );

  // Suppress viewer clicks when the user just drew a rectangle.
  const onClickCapture = useCallback((e: React.MouseEvent) => {
    if (!didDragRef.current) return;
    didDragRef.current = false;
    e.preventDefault();
    e.stopPropagation();
  }, []);

  const clearSelection = useCallback(() => {
    setSelection(null);
  }, []);

  useEffect(() => {
    if (!selection) return;

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        clearSelection();
      }
    };

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [clearSelection, selection]);

  const effectiveRect = selection?.rect ?? currentRect;
  const effectiveMask = selection?.mask;

  const actionEnabled =
    !!selection &&
    !!effectiveMask &&
    effectiveMask.width >= minMaskSize &&
    effectiveMask.height >= minMaskSize &&
    !disabled;

  return (
    <div
      ref={containerRef}
      className={className}
      onPointerDownCapture={onPointerDownCapture}
      onPointerMoveCapture={onPointerMoveCapture}
      onPointerUpCapture={onPointerUpCapture}
      onPointerCancelCapture={onPointerCancelCapture}
      onClickCapture={onClickCapture}
    >
      {children}

      {effectiveRect && effectiveRect.width > 0 && effectiveRect.height > 0 && (
        <div className="absolute inset-0 pointer-events-none">
          <div
            className="absolute border-2 border-[var(--accent)] bg-[var(--accent)]/15 rounded-sm"
            style={{
              left: effectiveRect.x,
              top: effectiveRect.y,
              width: effectiveRect.width,
              height: effectiveRect.height,
            }}
          />

          {selection && (
            <>
              {/* Close button */}
              <button
                type="button"
                data-drag-rect-action-button="true"
                onPointerDown={(e) => e.stopPropagation()}
                onClick={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  clearSelection();
                }}
                className="absolute pointer-events-auto p-1 rounded bg-black/70 text-white/90 hover:bg-black/80"
                style={{ left: effectiveRect.x + 6, top: effectiveRect.y + 6 }}
                title="Clear selection"
              >
                <X className="w-4 h-4" />
              </button>

              {/* Action button */}
              <button
                type="button"
                data-drag-rect-action-button="true"
                onPointerDown={(e) => e.stopPropagation()}
                onClick={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  if (!effectiveMask) return;
                  onConfirm(effectiveMask);
                  clearSelection();
                }}
                disabled={!actionEnabled}
                className={`absolute pointer-events-auto px-3 py-2 rounded-lg text-sm font-medium flex items-center gap-2 shadow-xl transition-colors ${
                  actionEnabled
                    ? 'bg-[var(--accent)] text-white hover:bg-[var(--accent-hover)]'
                    : 'bg-[var(--bg-tertiary)] text-[var(--text-tertiary)]'
                }`}
                style={{ left: effectiveRect.x + 40, top: effectiveRect.y + 6 }}
                title={actionTitle}
              >
                <Link2 className="w-4 h-4" />
                {actionLabel}
              </button>
            </>
          )}
        </div>
      )}
    </div>
  );
}
