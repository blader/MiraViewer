import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Pencil, Save, Trash2, Undo2, X } from 'lucide-react';
import type { NormalizedPoint, TumorPolygon, ViewerTransform } from '../db/schema';
import {
  deleteTumorGroundTruth,
  getSopInstanceUidForInstanceIndex,
  getTumorGroundTruthForInstance,
  saveTumorGroundTruth,
} from '../utils/localApi';
import {
  normalizeViewerTransform,
  remapPointBetweenViewerTransforms,
  remapPointsBetweenViewerTransforms,
  remapPolygonBetweenViewerTransforms,
} from '../utils/viewTransform';

function clamp01(v: number) {
  return Math.max(0, Math.min(1, v));
}

function polygonToSvgPath(p: TumorPolygon): string {
  if (!p.points.length) return '';

  const d = [`M ${p.points[0].x.toFixed(4)} ${p.points[0].y.toFixed(4)}`];
  for (let i = 1; i < p.points.length; i++) {
    d.push(`L ${p.points[i].x.toFixed(4)} ${p.points[i].y.toFixed(4)}`);
  }
  d.push('Z');
  return d.join(' ');
}

export type GroundTruthPolygonOverlayProps = {
  enabled: boolean;
  onRequestClose: () => void;

  comboId: string;
  dateIso: string;
  studyId: string;
  seriesUid: string;
  /** Instance index in effective slice ordering (i.e. after reverseSliceOrder mapping). */
  effectiveInstanceIndex: number;

  /** Current viewer transform (pan/zoom/rotation/affine). */
  viewerTransform: ViewerTransform;
};

export function GroundTruthPolygonOverlay({
  enabled,
  onRequestClose,
  comboId,
  dateIso,
  studyId,
  seriesUid,
  effectiveInstanceIndex,
  viewerTransform,
}: GroundTruthPolygonOverlayProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [containerSize, setContainerSize] = useState<{ w: number; h: number }>({ w: 0, h: 0 });

  // Keep the latest viewer transform in a ref so we can snapshot it at specific lifecycle moments
  // (e.g. when enabling or when loading a saved polygon) without re-running those effects on every
  // pan/zoom/rotation change.
  const viewerTransformRef = useRef(viewerTransform);
  useEffect(() => {
    viewerTransformRef.current = viewerTransform;
  }, [viewerTransform]);

  const [draftPoints, setDraftPoints] = useState<NormalizedPoint[]>([]);
  const [isClosed, setIsClosed] = useState(false);
  const [draftViewTransform, setDraftViewTransform] = useState<ViewerTransform | null>(null);

  const [savedPolygon, setSavedPolygon] = useState<TumorPolygon | null>(null);
  const [savedViewTransform, setSavedViewTransform] = useState<ViewerTransform | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Load existing saved polygon when enabled or when slice changes.
  useEffect(() => {
    if (!enabled) return;

    let cancelled = false;
    (async () => {
      try {
        setError(null);
        const sop = await getSopInstanceUidForInstanceIndex(seriesUid, effectiveInstanceIndex);
        const row = await getTumorGroundTruthForInstance(seriesUid, sop);
        if (cancelled) return;
        setSavedPolygon(row?.polygon ?? null);
        setSavedViewTransform(row?.viewTransform ?? normalizeViewerTransform(null));
      } catch (e) {
        console.error(e);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [enabled, seriesUid, effectiveInstanceIndex]);

  // Reset draft state when turning on.
  useEffect(() => {
    if (!enabled) return;
    setDraftPoints([]);
    setIsClosed(false);
    setDraftViewTransform({ ...viewerTransformRef.current });
    setError(null);
  }, [enabled]);

  // Track container size (used for hit-testing / close threshold).
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

  const getLocalNormPoint = useCallback((e: PointerEvent | React.PointerEvent): NormalizedPoint | null => {
    const el = containerRef.current;
    if (!el) return null;
    const r = el.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) return null;
    const x = ((e as PointerEvent).clientX - r.left) / r.width;
    const y = ((e as PointerEvent).clientY - r.top) / r.height;
    return { x: clamp01(x), y: clamp01(y) };
  }, []);

  const closeRadiusPx = 12;

  const isNearFirstPoint = useCallback(
    (p: NormalizedPoint, first: NormalizedPoint) => {
      if (containerSize.w <= 0 || containerSize.h <= 0) return false;
      const dx = (p.x - first.x) * containerSize.w;
      const dy = (p.y - first.y) * containerSize.h;
      return Math.hypot(dx, dy) <= closeRadiusPx;
    },
    [containerSize.h, containerSize.w]
  );

  const didClickRef = useRef(false);

  const onPointerDown = useCallback(
    (e: React.PointerEvent) => {
      if (!enabled) return;
      if (!e.isPrimary) return;
      if (e.button !== 0) return;

      // Avoid starting a polygon click on overlay buttons.
      const target = e.target as HTMLElement | null;
      if (target?.closest('[data-gt-ui="true"]')) return;

      const pCurrent = getLocalNormPoint(e);
      if (!pCurrent) return;

      didClickRef.current = true;
      setError(null);

      // If already closed, require the user to Clear before starting over.
      if (isClosed) return;

      // Keep draft points in a stable "creation" view transform so the polygon can be re-projected
      // when the user pans/zooms/rotates.
      let baseView = draftViewTransform;
      if (!baseView) {
        baseView = { ...viewerTransform };
        setDraftViewTransform(baseView);
      }

      const size = { w: containerSize.w, h: containerSize.h };
      const pDraft =
        size.w > 0 && size.h > 0
          ? remapPointBetweenViewerTransforms(pCurrent, size, viewerTransform, baseView)
          : pCurrent;

      setDraftPoints((prev) => {
        if (prev.length >= 3) {
          const firstDraft = prev[0]!;
          const firstCurrent =
            size.w > 0 && size.h > 0
              ? remapPointBetweenViewerTransforms(firstDraft, size, baseView!, viewerTransform)
              : firstDraft;

          if (isNearFirstPoint(pCurrent, firstCurrent)) {
            // Close polygon by clicking near the first point.
            setIsClosed(true);
            return prev;
          }
        }

        // Avoid adding duplicate points (in draft/view space).
        const last = prev[prev.length - 1];
        if (last && Math.hypot(last.x - pDraft.x, last.y - pDraft.y) < 0.0015) {
          return prev;
        }

        return [...prev, pDraft];
      });
    },
    [
      containerSize.h,
      containerSize.w,
      didClickRef,
      draftViewTransform,
      enabled,
      getLocalNormPoint,
      isClosed,
      isNearFirstPoint,
      viewerTransform,
    ]
  );

  const onClickCapture = useCallback((e: React.MouseEvent) => {
    if (!didClickRef.current) return;
    didClickRef.current = false;
    e.preventDefault();
    e.stopPropagation();
  }, []);

  const onUndo = useCallback(() => {
    setError(null);
    setIsClosed(false);
    setDraftPoints((prev) => prev.slice(0, -1));
  }, []);

  const onClear = useCallback(() => {
    setError(null);
    setIsClosed(false);
    setDraftPoints([]);
    setDraftViewTransform({ ...viewerTransform });
  }, [viewerTransform]);

  const onSave = useCallback(async () => {
    if (!enabled) return;
    if (!isClosed || draftPoints.length < 3) {
      setError('Close the polygon (click the first point) before saving');
      return;
    }

    setBusy(true);
    setError(null);

    try {
      const sop = await getSopInstanceUidForInstanceIndex(seriesUid, effectiveInstanceIndex);

      const view = draftViewTransform ?? { ...viewerTransform };

      const viewportSize =
        containerSize.w > 0 && containerSize.h > 0
          ? { w: Math.round(containerSize.w), h: Math.round(containerSize.h) }
          : undefined;

      await saveTumorGroundTruth({
        comboId,
        dateIso,
        studyId,
        seriesUid,
        sopInstanceUid: sop,
        polygon: { points: draftPoints },
        viewTransform: view,
        viewportSize,
      });

      setSavedPolygon({ points: draftPoints });
      setSavedViewTransform(view);
    } catch (err) {
      console.error(err);
      setError(err instanceof Error ? err.message : 'Save failed');
    } finally {
      setBusy(false);
    }
  }, [comboId, containerSize.h, containerSize.w, dateIso, draftPoints, draftViewTransform, effectiveInstanceIndex, enabled, isClosed, seriesUid, studyId, viewerTransform]);

  const onDelete = useCallback(async () => {
    if (!enabled) return;

    setBusy(true);
    setError(null);

    try {
      const sop = await getSopInstanceUidForInstanceIndex(seriesUid, effectiveInstanceIndex);
      await deleteTumorGroundTruth(seriesUid, sop);
      setSavedPolygon(null);
      setSavedViewTransform(null);

      // Also clear draft so there is no confusion about what's saved.
      setDraftPoints([]);
      setIsClosed(false);
    } catch (err) {
      console.error(err);
      setError(err instanceof Error ? err.message : 'Delete failed');
    } finally {
      setBusy(false);
    }
  }, [effectiveInstanceIndex, enabled, seriesUid]);

  // Keyboard shortcuts.
  useEffect(() => {
    if (!enabled) return;

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        // If the user is mid-draw, Esc cancels the draft. Otherwise it closes the tool.
        if (draftPoints.length > 0 && !isClosed) {
          onClear();
          e.preventDefault();
          e.stopPropagation();
          return;
        }

        onRequestClose();
        e.preventDefault();
        e.stopPropagation();
        return;
      }

      if (e.key === 'Enter') {
        if (!isClosed && draftPoints.length >= 3) {
          setIsClosed(true);
          e.preventDefault();
          e.stopPropagation();
        }
        return;
      }

      if (e.key === 'Backspace' || e.key === 'Delete' || (e.key.toLowerCase() === 'z' && (e.metaKey || e.ctrlKey))) {
        if (draftPoints.length > 0) {
          onUndo();
          e.preventDefault();
          e.stopPropagation();
        }
      }
    };

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [draftPoints.length, enabled, isClosed, onClear, onRequestClose, onUndo]);

  const viewSize = useMemo(() => ({ w: containerSize.w, h: containerSize.h }), [containerSize.h, containerSize.w]);

  const savedPath = useMemo(() => {
    if (!savedPolygon) return '';

    const from = savedViewTransform ?? viewerTransform;
    const displayPoly =
      viewSize.w > 0 && viewSize.h > 0
        ? remapPolygonBetweenViewerTransforms(savedPolygon, viewSize, from, viewerTransform)
        : savedPolygon;

    return polygonToSvgPath(displayPoly);
  }, [savedPolygon, savedViewTransform, viewSize, viewerTransform]);

  const draftPointsDisplay = useMemo(() => {
    if (draftPoints.length === 0) return [];

    const from = draftViewTransform ?? viewerTransform;
    return viewSize.w > 0 && viewSize.h > 0
      ? remapPointsBetweenViewerTransforms(draftPoints, viewSize, from, viewerTransform)
      : draftPoints;
  }, [draftPoints, draftViewTransform, viewSize, viewerTransform]);

  const draftPath = useMemo(() => {
    if (!isClosed || draftPointsDisplay.length < 3) return '';
    return polygonToSvgPath({ points: draftPointsDisplay });
  }, [draftPointsDisplay, isClosed]);

  if (!enabled) return null;

  const canUndo = draftPoints.length > 0 && !busy;
  const canClear = (draftPoints.length > 0 || isClosed) && !busy;
  const canSave = isClosed && draftPoints.length >= 3 && !busy;

  return (
    <div
      ref={containerRef}
      className="absolute inset-0"
      onPointerDown={onPointerDown}
      onClickCapture={onClickCapture}
      onContextMenu={(e) => {
        // Prevent the browser context menu while drawing.
        if (!enabled) return;
        e.preventDefault();
        e.stopPropagation();
      }}
    >
      {/* UI chrome */}
      {/*
        Position below the viewer's top hover controls (Tumor/GT buttons + ImageControls).
        Otherwise it visually overlaps the control bar in GridView/OverlayView.
      */}
      <div className="absolute top-12 left-2 z-20 flex items-center gap-2" data-gt-ui="true">
        <div className="px-2 py-1 rounded bg-black/70 border border-white/10 text-white text-xs flex items-center gap-2">
          <Pencil className="w-3.5 h-3.5 text-cyan-300" />
          GT Polygon
          {busy ? <span className="text-white/70">…</span> : null}
        </div>

        <button
          type="button"
          onClick={onRequestClose}
          className="p-1 rounded bg-black/70 border border-white/10 text-white/80 hover:text-white"
          title="Close ground truth tool"
        >
          <X className="w-4 h-4" />
        </button>
      </div>

      <div className="absolute top-12 right-2 z-20 flex items-center gap-2" data-gt-ui="true">
        <button
          type="button"
          onClick={onUndo}
          disabled={!canUndo}
          className={`p-1.5 rounded border ${
            canUndo
              ? 'bg-black/70 border-white/10 text-white/90 hover:text-white'
              : 'bg-black/40 border-white/10 text-white/40'
          }`}
          title="Undo last point (Backspace)"
        >
          <Undo2 className="w-4 h-4" />
        </button>

        <button
          type="button"
          onClick={onClear}
          disabled={!canClear}
          className={`px-2 py-1.5 rounded border text-xs ${
            canClear
              ? 'bg-black/70 border-white/10 text-white/90 hover:text-white'
              : 'bg-black/40 border-white/10 text-white/40'
          }`}
          title="Clear draft polygon"
        >
          Clear
        </button>

        <button
          type="button"
          onClick={() => void onSave()}
          disabled={!canSave}
          className={`px-2 py-1.5 rounded border text-xs flex items-center gap-1.5 ${
            canSave
              ? 'bg-cyan-500/80 border-cyan-300/30 text-white hover:bg-cyan-500'
              : 'bg-black/40 border-white/10 text-white/40'
          }`}
          title="Save ground truth polygon"
        >
          <Save className="w-4 h-4" />
          Save
        </button>

        {savedPolygon ? (
          <button
            type="button"
            onClick={() => void onDelete()}
            disabled={busy}
            className={`p-1.5 rounded border ${
              busy
                ? 'bg-black/40 border-white/10 text-white/40'
                : 'bg-red-500/20 border-red-300/20 text-red-200 hover:bg-red-500/30'
            }`}
            title="Delete saved ground truth"
          >
            <Trash2 className="w-4 h-4" />
          </button>
        ) : null}
      </div>

      {/* Error / status */}
      {error ? (
        <div
          className="absolute bottom-2 left-2 right-2 z-20 px-2 py-1 rounded bg-red-900/60 border border-red-400/30 text-red-100 text-xs"
          data-gt-ui="true"
        >
          {error}
        </div>
      ) : !isClosed ? (
        <div
          className="absolute bottom-2 left-2 right-2 z-20 px-2 py-1 rounded bg-black/60 border border-white/10 text-white/80 text-xs"
          data-gt-ui="true"
        >
          Click to add points. Click the first point (or press Enter) to close.
        </div>
      ) : (
        <div
          className="absolute bottom-2 left-2 right-2 z-20 px-2 py-1 rounded bg-black/60 border border-white/10 text-white/80 text-xs"
          data-gt-ui="true"
        >
          Polygon closed. Save to persist.
        </div>
      )}

      {/* Saved polygon */}
      {savedPath ? (
        <svg className="absolute inset-0 pointer-events-none" viewBox="0 0 1 1" preserveAspectRatio="none" aria-hidden>
          <path
            d={savedPath}
            fill="rgba(34, 211, 238, 0.10)"
            stroke="rgba(34, 211, 238, 0.90)"
            strokeWidth={2}
            vectorEffect="non-scaling-stroke"
          />
        </svg>
      ) : null}

      {/* Draft polyline (during drawing) */}
      {!isClosed && draftPointsDisplay.length > 0 ? (
        <svg className="absolute inset-0 pointer-events-none" viewBox="0 0 1 1" preserveAspectRatio="none" aria-hidden>
          <polyline
            points={draftPointsDisplay.map((p) => `${p.x.toFixed(4)},${p.y.toFixed(4)}`).join(' ')}
            fill="none"
            stroke="rgba(245, 158, 11, 0.95)"
            strokeWidth={2}
            vectorEffect="non-scaling-stroke"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      ) : null}

      {/* Draft closed polygon */}
      {draftPath ? (
        <svg className="absolute inset-0 pointer-events-none" viewBox="0 0 1 1" preserveAspectRatio="none" aria-hidden>
          <path
            d={draftPath}
            fill="rgba(245, 158, 11, 0.08)"
            stroke="rgba(245, 158, 11, 0.95)"
            strokeWidth={2}
            vectorEffect="non-scaling-stroke"
          />
        </svg>
      ) : null}

      {/* Vertex handles */}
      {draftPointsDisplay.length > 0 ? (
        <svg className="absolute inset-0 pointer-events-none" viewBox="0 0 1 1" preserveAspectRatio="none" aria-hidden>
          {draftPointsDisplay.map((p, idx) => (
            <circle
              key={idx}
              cx={p.x}
              cy={p.y}
              r={0.005}
              fill={idx === 0 ? 'rgba(34, 211, 238, 0.9)' : 'rgba(245, 158, 11, 0.9)'}
              stroke="rgba(0, 0, 0, 0.35)"
              strokeWidth={1}
              vectorEffect="non-scaling-stroke"
            />
          ))}
        </svg>
      ) : null}
    </div>
  );
}
