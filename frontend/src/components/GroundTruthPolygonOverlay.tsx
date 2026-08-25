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
  imagePolygonToViewerPolygon,
  remapPointBetweenViewerTransforms,
  remapPointsBetweenViewerTransforms,
  polygonToSvgPath,
  remapPolygonBetweenViewerTransforms,
  restoreImagePolygon,
  viewerPolygonToImagePolygon,
} from '../utils/viewTransform';
import { clamp01 } from '../utils/math';

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
  imageSize?: { w: number; h: number };
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
  imageSize,
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
  const [savedImageSize, setSavedImageSize] = useState<{ w: number; h: number } | null>(null);
  const [savedViewTransform, setSavedViewTransform] = useState<ViewerTransform | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const sliceGenerationRef = useRef(0);

  // Load existing saved polygon when enabled or when slice changes.
  useEffect(() => {
    if (!enabled) return;
    const generation = ++sliceGenerationRef.current;

    let cancelled = false;
    (async () => {
      try {
        setError(null);
        const sop = await getSopInstanceUidForInstanceIndex(seriesUid, effectiveInstanceIndex);
        const row = await getTumorGroundTruthForInstance(seriesUid, sop);
        if (cancelled || generation !== sliceGenerationRef.current) return;
        const restored = row ? restoreImagePolygon(row.polygon, row, imageSize) : null;
        if (restored && 'error' in restored) {
          setSavedPolygon(null);
          setSavedImageSize(null);
          setError(
            `Saved ground-truth annotation cannot be displayed safely: its ${restored.error}. The stored annotation is preserved.`,
          );
          return;
        }
        setSavedPolygon(restored?.polygon ?? null);
        setSavedImageSize(restored?.imageSize ?? null);
        setSavedViewTransform(row?.viewTransform ?? normalizeViewerTransform(null));
      } catch (e) {
        console.error(e);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [enabled, seriesUid, effectiveInstanceIndex, imageSize]);

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
    [containerSize.h, containerSize.w],
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
    ],
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
    const generation = sliceGenerationRef.current;

    try {
      const sop = await getSopInstanceUidForInstanceIndex(seriesUid, effectiveInstanceIndex);

      const view = draftViewTransform ?? { ...viewerTransform };

      const viewportSize =
        containerSize.w > 0 && containerSize.h > 0
          ? { w: Math.round(containerSize.w), h: Math.round(containerSize.h) }
          : undefined;
      const polygon = { points: draftPoints };
      const canCanonicalize = imageSize && viewportSize;
      const saved = canCanonicalize ? viewerPolygonToImagePolygon(polygon, viewportSize, imageSize, view) : polygon;

      await saveTumorGroundTruth({
        comboId,
        dateIso,
        studyId,
        seriesUid,
        sopInstanceUid: sop,
        polygon: saved,
        coordinateSpace: canCanonicalize ? 'image-normalized' : 'viewer-normalized',
        imageSize,
        viewTransform: view,
        viewportSize,
      });

      if (generation !== sliceGenerationRef.current) return;
      setSavedPolygon(saved);
      setSavedImageSize(canCanonicalize ? imageSize : null);
      setSavedViewTransform(view);
    } catch (err) {
      if (generation !== sliceGenerationRef.current) return;
      console.error(err);
      setError(err instanceof Error ? err.message : 'Save failed');
    } finally {
      if (generation === sliceGenerationRef.current) setBusy(false);
    }
  }, [
    comboId,
    containerSize.h,
    containerSize.w,
    dateIso,
    draftPoints,
    draftViewTransform,
    effectiveInstanceIndex,
    enabled,
    imageSize,
    isClosed,
    seriesUid,
    studyId,
    viewerTransform,
  ]);

  const onDelete = useCallback(async () => {
    if (!enabled) return;

    setBusy(true);
    setError(null);
    const generation = sliceGenerationRef.current;

    try {
      const sop = await getSopInstanceUidForInstanceIndex(seriesUid, effectiveInstanceIndex);
      await deleteTumorGroundTruth(seriesUid, sop);
      if (generation !== sliceGenerationRef.current) return;
      setSavedPolygon(null);
      setSavedImageSize(null);
      setSavedViewTransform(null);

      // Also clear draft so there is no confusion about what's saved.
      setDraftPoints([]);
      setIsClosed(false);
    } catch (err) {
      if (generation !== sliceGenerationRef.current) return;
      console.error(err);
      setError(err instanceof Error ? err.message : 'Delete failed');
    } finally {
      if (generation === sliceGenerationRef.current) setBusy(false);
    }
  }, [effectiveInstanceIndex, enabled, seriesUid]);

  // Keyboard shortcuts.
  useEffect(() => {
    if (!enabled) return;

    const onKeyDown = (e: KeyboardEvent) => {
      const target = e.target instanceof HTMLElement ? e.target : document.activeElement;
      if (
        e.defaultPrevented ||
        (target instanceof HTMLElement &&
          (target.isContentEditable ||
            target.closest(
              'input, select, textarea, [contenteditable=""], [contenteditable="true"], [role="dialog"], [aria-modal="true"]',
            )))
      ) {
        return;
      }

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

    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, [draftPoints.length, enabled, isClosed, onClear, onRequestClose, onUndo]);

  const viewSize = useMemo(() => ({ w: containerSize.w, h: containerSize.h }), [containerSize.h, containerSize.w]);

  const savedPath = useMemo(() => {
    if (!savedPolygon) return '';

    const displayPoly =
      viewSize.w > 0 && viewSize.h > 0
        ? savedImageSize
          ? imagePolygonToViewerPolygon(savedPolygon, viewSize, savedImageSize, viewerTransform)
          : remapPolygonBetweenViewerTransforms(
              savedPolygon,
              viewSize,
              savedViewTransform ?? viewerTransform,
              viewerTransform,
            )
        : savedPolygon;

    return polygonToSvgPath(displayPoly);
  }, [savedImageSize, savedPolygon, savedViewTransform, viewSize, viewerTransform]);

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
        <div className="flex items-center gap-2 rounded-[4px] border border-[var(--border-color)] bg-[var(--bg-secondary)] px-2 py-1 text-xs text-[var(--text-primary)]">
          <Pencil className="h-3.5 w-3.5 text-[var(--signal-metal)]" />
          GT Polygon
          {busy ? <span className="text-[var(--text-secondary)]">…</span> : null}
        </div>

        <button
          type="button"
          onClick={onRequestClose}
          aria-label="Close ground-truth polygon tool"
          className="inline-flex min-h-9 min-w-9 items-center justify-center rounded-[4px] border border-[var(--border-color)] bg-[var(--bg-secondary)] text-[var(--text-secondary)] transition-colors hover:text-[var(--text-primary)]"
          title="Close ground truth tool"
        >
          <X className="w-4 h-4" />
        </button>
      </div>

      <div className="absolute top-12 right-2 z-20 flex items-center gap-2" data-gt-ui="true">
        <button
          type="button"
          onClick={onUndo}
          aria-label="Undo last polygon point"
          disabled={!canUndo}
          className={`inline-flex min-h-9 min-w-9 items-center justify-center rounded-[4px] border border-[var(--border-color)] bg-[var(--bg-secondary)] ${
            canUndo
              ? 'text-[var(--text-secondary)] hover:text-[var(--text-primary)]'
              : 'text-[var(--text-tertiary)] opacity-50'
          }`}
          title="Undo last point (Backspace)"
        >
          <Undo2 className="w-4 h-4" />
        </button>

        <button
          type="button"
          onClick={onClear}
          disabled={!canClear}
          className={`min-h-9 rounded-[4px] border border-[var(--border-color)] bg-[var(--bg-secondary)] px-2 py-1.5 text-xs ${
            canClear
              ? 'text-[var(--text-secondary)] hover:text-[var(--text-primary)]'
              : 'text-[var(--text-tertiary)] opacity-50'
          }`}
          title="Clear draft polygon"
        >
          Clear
        </button>

        <button
          type="button"
          onClick={() => void onSave()}
          disabled={!canSave}
          className={`flex min-h-9 items-center gap-1.5 rounded-[4px] border px-2 py-1.5 text-xs ${
            canSave
              ? 'border-[var(--accent)] bg-[var(--accent)] text-white hover:bg-[var(--accent-hover)]'
              : 'border-[var(--border-color)] bg-[var(--bg-secondary)] text-[var(--text-tertiary)] opacity-50'
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
            aria-label="Delete saved ground-truth polygon"
            disabled={busy}
            className={`inline-flex min-h-9 min-w-9 items-center justify-center rounded-[4px] border border-[var(--border-color)] bg-[var(--bg-secondary)] ${
              busy ? 'text-[var(--text-tertiary)] opacity-50' : 'text-[var(--danger)] hover:bg-[var(--bg-tertiary)]'
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
          role="alert"
          className="absolute bottom-2 left-2 right-2 z-20 rounded-[4px] border-l-2 border-l-[var(--danger)] bg-[var(--bg-secondary)] px-2 py-1 text-xs text-[var(--danger)]"
          data-gt-ui="true"
        >
          {error}
        </div>
      ) : !isClosed ? (
        <div
          className="absolute bottom-2 left-2 right-2 z-20 rounded-[4px] border border-[var(--border-color)] bg-[var(--bg-secondary)] px-2 py-1 text-xs text-[var(--text-secondary)]"
          data-gt-ui="true"
        >
          Click to add points. Click the first point (or press Enter) to close.
        </div>
      ) : (
        <div
          className="absolute bottom-2 left-2 right-2 z-20 rounded-[4px] border border-[var(--border-color)] bg-[var(--bg-secondary)] px-2 py-1 text-xs text-[var(--text-secondary)]"
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
