import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { TumorPolygon, ViewerTransform } from '../db/schema';
import { getSopInstanceUidForInstanceIndex, getTumorSegmentationForInstance } from '../utils/localApi';
import { normalizeViewerTransform, remapPolygonBetweenViewerTransforms } from '../utils/viewTransform';

function polygonToSvgPath(p: TumorPolygon): string {
  const pts = p.points ?? [];
  if (pts.length === 0) return '';

  const d = [`M ${pts[0]!.x.toFixed(4)} ${pts[0]!.y.toFixed(4)}`];
  for (let i = 1; i < pts.length; i++) {
    d.push(`L ${pts[i]!.x.toFixed(4)} ${pts[i]!.y.toFixed(4)}`);
  }
  d.push('Z');
  return d.join(' ');
}

export type TumorSavedSegmentationOverlayProps = {
  enabled: boolean;

  seriesUid: string;
  /** Instance index in effective slice ordering (i.e. after reverseSliceOrder mapping). */
  effectiveInstanceIndex: number;

  /** Current viewer transform (pan/zoom/rotation/affine). */
  viewerTransform: ViewerTransform;

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
  color,
}: TumorSavedSegmentationOverlayProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [containerSize, setContainerSize] = useState<{ w: number; h: number }>({ w: 0, h: 0 });

  const [savedPolygon, setSavedPolygon] = useState<TumorPolygon | null>(null);
  const [savedViewTransform, setSavedViewTransform] = useState<ViewerTransform | null>(null);

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
        const sop = await getSopInstanceUidForInstanceIndex(seriesUid, effectiveInstanceIndex);
        const row = await getTumorSegmentationForInstance(seriesUid, sop);
        if (cancelled) return;

        setSavedPolygon(row?.polygon ?? null);
        setSavedViewTransform(row?.meta?.viewTransform ?? normalizeViewerTransform(null));
      } catch (e) {
        console.error(e);
        if (cancelled) return;
        setSavedPolygon(null);
        setSavedViewTransform(normalizeViewerTransform(null));
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [enabled, seriesUid, effectiveInstanceIndex]);

  const viewSize = useMemo(() => ({ w: containerSize.w, h: containerSize.h }), [containerSize.h, containerSize.w]);

  const savedPolygonDisplay = useMemo(() => {
    if (!enabled) return null;
    if (!savedPolygon) return null;

    if (viewSize.w <= 0 || viewSize.h <= 0) return savedPolygon;

    const from = savedViewTransform ?? normalizeViewerTransform(null);
    return remapPolygonBetweenViewerTransforms(savedPolygon, viewSize, from, viewerTransform);
  }, [enabled, savedPolygon, savedViewTransform, viewSize, viewerTransform]);

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
    <div ref={containerRef} className="absolute inset-0 pointer-events-none" aria-hidden>
      {path ? (
        <svg className="absolute inset-0 pointer-events-none" viewBox="0 0 1 1" preserveAspectRatio="none" aria-hidden>
          <path d={path} {...styleForPath()} />
        </svg>
      ) : null}
    </div>
  );
}
