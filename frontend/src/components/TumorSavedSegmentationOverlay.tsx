import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { TumorPolygon, ViewerTransform } from '../db/schema';
import { getSopInstanceUidForInstanceIndex, getTumorSegmentationForInstance } from '../utils/localApi';
import {
  imagePolygonToViewerPolygon,
  normalizeViewerTransform,
  polygonToSvgPath,
  remapPolygonBetweenViewerTransforms,
  restoreImagePolygon,
} from '../utils/viewTransform';

export type TumorSavedSegmentationOverlayProps = {
  enabled: boolean;

  seriesUid: string;
  /** Instance index in effective slice ordering (i.e. after reverseSliceOrder mapping). */
  effectiveInstanceIndex: number;

  /** Current viewer transform (pan/zoom/rotation/affine). */
  viewerTransform: ViewerTransform;
  imageSize?: { w: number; h: number };

  /** Optional override for styling. */
  color?: {
    fill: string;
    stroke: string;
  };
};

export function TumorSavedSegmentationOverlay({
  enabled,
  seriesUid,
  effectiveInstanceIndex,
  viewerTransform,
  imageSize,
  color,
}: TumorSavedSegmentationOverlayProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [containerSize, setContainerSize] = useState<{ w: number; h: number }>({ w: 0, h: 0 });

  const [savedPolygon, setSavedPolygon] = useState<TumorPolygon | null>(null);
  const [savedImageSize, setSavedImageSize] = useState<{ w: number; h: number } | null>(null);
  const [savedViewTransform, setSavedViewTransform] = useState<ViewerTransform | null>(null);
  const [coordinateWarning, setCoordinateWarning] = useState<string | null>(null);

  // Track container size (needed to correctly re-project polygon points).
  useEffect(() => {
    if (!enabled) return;
    const el = containerRef.current;
    if (!el) return;

    const update = () => {
      const r = el.getBoundingClientRect();
      setContainerSize({ w: r.width, h: r.height });
    };

    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, [enabled]);

  // Load saved segmentation when enabled or when slice changes.
  useEffect(() => {
    if (!enabled) return;

    let cancelled = false;
    (async () => {
      try {
        setCoordinateWarning(null);
        const sop = await getSopInstanceUidForInstanceIndex(seriesUid, effectiveInstanceIndex);
        const row = await getTumorSegmentationForInstance(seriesUid, sop);
        if (cancelled) return;

        const savedTransform = row?.meta?.viewTransform ?? normalizeViewerTransform(null);
        const restored = row ? restoreImagePolygon(row.polygon, row.meta ?? {}, imageSize) : null;
        if (restored && 'error' in restored) {
          setSavedPolygon(null);
          setSavedImageSize(null);
          setCoordinateWarning(
            `Saved tumor annotation cannot be displayed safely: its ${restored.error}. The stored annotation is preserved.`,
          );
          return;
        }
        setSavedPolygon(restored?.polygon ?? null);
        setSavedImageSize(restored?.imageSize ?? null);
        setSavedViewTransform(savedTransform);
      } catch (e) {
        console.error(e);
        if (cancelled) return;
        setSavedPolygon(null);
        setSavedImageSize(null);
        setSavedViewTransform(normalizeViewerTransform(null));
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [enabled, seriesUid, effectiveInstanceIndex, imageSize]);

  const viewSize = useMemo(() => ({ w: containerSize.w, h: containerSize.h }), [containerSize.h, containerSize.w]);

  const savedPolygonDisplay = useMemo(() => {
    if (!enabled) return null;
    if (!savedPolygon) return null;

    if (viewSize.w <= 0 || viewSize.h <= 0) return savedPolygon;

    if (savedImageSize) {
      return imagePolygonToViewerPolygon(savedPolygon, viewSize, savedImageSize, viewerTransform);
    }

    const from = savedViewTransform ?? normalizeViewerTransform(null);
    return remapPolygonBetweenViewerTransforms(savedPolygon, viewSize, from, viewerTransform);
  }, [enabled, savedImageSize, savedPolygon, savedViewTransform, viewSize, viewerTransform]);

  const path = useMemo(() => (savedPolygonDisplay ? polygonToSvgPath(savedPolygonDisplay) : ''), [savedPolygonDisplay]);

  const palette = useMemo(() => {
    return (
      color ?? {
        fill: 'rgba(16, 185, 129, 0.10)',
        stroke: 'rgba(16, 185, 129, 0.85)',
      }
    );
  }, [color]);

  const styleForPath = useCallback(() => {
    return {
      fill: palette.fill,
      stroke: palette.stroke,
      strokeWidth: 2,
      vectorEffect: 'non-scaling-stroke' as const,
    };
  }, [palette.fill, palette.stroke]);

  if (!enabled) return null;

  return (
    <div
      ref={containerRef}
      className="absolute inset-0 pointer-events-none"
      aria-hidden={coordinateWarning ? undefined : true}
    >
      {coordinateWarning ? (
        <div
          role="alert"
          className="absolute bottom-2 left-2 right-2 z-20 rounded-[4px] border-l-2 border-l-[var(--warning)] bg-[var(--bg-secondary)] px-2 py-1 text-xs text-[var(--warning)]"
        >
          {coordinateWarning}
        </div>
      ) : null}
      {path ? (
        <svg className="absolute inset-0 pointer-events-none" viewBox="0 0 1 1" preserveAspectRatio="none" aria-hidden>
          <path d={path} {...styleForPath()} />
        </svg>
      ) : null}
    </div>
  );
}
