import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { BarChart3, Copy, Download, Eye, EyeOff, RotateCcw, Save, Sparkles, Wand2, X } from 'lucide-react';
import { propagateTumorAcrossSeries } from '../utils/tumorPropagation';
import type { NormalizedPoint, TumorPolygon, TumorThreshold, ViewerTransform } from '../db/schema';
import type { DicomViewerHandle } from './DicomViewer';
import {
  getAllTumorGroundTruth,
  getSopInstanceUidForInstanceIndex,
  getTumorGroundTruthForInstance,
  getTumorSegmentationForInstance,
  saveTumorSegmentation,
} from '../utils/localApi';
import {
  decodeCapturedPngToGrayscale,
  estimateThresholdFromSeedPoints,
  segmentTumorFromGrayscale,
  type SegmentTumorOptions,
} from '../utils/segmentation/segmentTumor';
import { runGtBenchmark } from '../utils/segmentation/gtBenchmark';
import { exportTumorHarnessDatasetAndDownload } from '../utils/segmentation/harness/exportTumorHarnessDataset';
import { computeMaskMetrics, type MaskMetrics } from '../utils/segmentation/maskMetrics';
import {
  computePolygonBoundaryMetrics,
  type PolygonBoundaryMetrics,
} from '../utils/segmentation/polygonBoundaryMetrics';
import { rasterizePolygonToMask } from '../utils/segmentation/rasterizePolygon';
import {
  normalizeViewerTransform,
  remapPolygonBetweenViewerTransforms,
  remapPointsBetweenViewerTransforms,
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

function polygonBounds01(p: TumorPolygon): { minX: number; minY: number; maxX: number; maxY: number } {
  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;

  for (const pt of p.points) {
    if (pt.x < minX) minX = pt.x;
    if (pt.y < minY) minY = pt.y;
    if (pt.x > maxX) maxX = pt.x;
    if (pt.y > maxY) maxY = pt.y;
  }

  return {
    minX: clamp01(minX),
    minY: clamp01(minY),
    maxX: clamp01(maxX),
    maxY: clamp01(maxY),
  };
}

function pointsBounds01(points: NormalizedPoint[]): { minX: number; minY: number; maxX: number; maxY: number } {
  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;

  for (const pt of points) {
    if (pt.x < minX) minX = pt.x;
    if (pt.y < minY) minY = pt.y;
    if (pt.x > maxX) maxX = pt.x;
    if (pt.y > maxY) maxY = pt.y;
  }

  return {
    minX: clamp01(minX),
    minY: clamp01(minY),
    maxX: clamp01(maxX),
    maxY: clamp01(maxY),
  };
}

export type TumorSegmentationOverlayProps = {
  enabled: boolean;
  onRequestClose: () => void;

  viewerRef: React.RefObject<DicomViewerHandle | null>;

  comboId: string;
  dateIso: string;
  studyId: string;
  seriesUid: string;
  /** Instance index in effective slice ordering (i.e. after reverseSliceOrder mapping). */
  effectiveInstanceIndex: number;

  /** Current viewer transform (pan/zoom/rotation/affine). */
  viewerTransform: ViewerTransform;
};

export function TumorSegmentationOverlay({
  enabled,
  onRequestClose,
  viewerRef,
  comboId,
  dateIso,
  studyId,
  seriesUid,
  effectiveInstanceIndex,
  viewerTransform,
}: TumorSegmentationOverlayProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);

  // Keep the latest viewer transform in a ref so we can snapshot it at specific lifecycle moments
  // (e.g. when capturing a PNG) without re-running those effects on every pan/zoom/rotation change.
  const viewerTransformRef = useRef(viewerTransform);
  useEffect(() => {
    viewerTransformRef.current = viewerTransform;
  }, [viewerTransform]);

  const [paintPoints, setPaintPoints] = useState<NormalizedPoint[]>([]);
  const [paintPointsViewTransform, setPaintPointsViewTransform] = useState<ViewerTransform | null>(null);
  const [isPainting, setIsPainting] = useState(false);

  const [draftThreshold, setDraftThreshold] = useState<TumorThreshold | null>(null);
  const [draftPolygon, setDraftPolygon] = useState<TumorPolygon | null>(null);
  const [draftPolygonViewTransform, setDraftPolygonViewTransform] = useState<ViewerTransform | null>(null);
  const [draftSeed, setDraftSeed] = useState<NormalizedPoint | null>(null);

  const [savedPolygon, setSavedPolygon] = useState<TumorPolygon | null>(null);
  const [savedPolygonViewTransform, setSavedPolygonViewTransform] = useState<ViewerTransform | null>(null);
  const [savedSeed, setSavedSeed] = useState<NormalizedPoint | null>(null);
  const [savedThreshold, setSavedThreshold] = useState<TumorThreshold | null>(null);

  const [groundTruthPolygon, setGroundTruthPolygon] = useState<TumorPolygon | null>(null);
  const [groundTruthPolygonViewTransform, setGroundTruthPolygonViewTransform] = useState<ViewerTransform | null>(null);

  const [tunedOptions, setTunedOptions] = useState<SegmentTumorOptions | null>(null);

  const [gtMetrics, setGtMetrics] = useState<MaskMetrics | null>(null);
  const [gtBoundaryMetrics, setGtBoundaryMetrics] = useState<PolygonBoundaryMetrics | null>(null);

  const [diffOverlayEnabled, setDiffOverlayEnabled] = useState(true);
  const diffCanvasRef = useRef<HTMLCanvasElement | null>(null);

  const [autoTuneStatus, setAutoTuneStatus] = useState<{ running: boolean; message?: string }>(
    () => ({ running: false })
  );
  const [gtBenchmarkStatus, setGtBenchmarkStatus] = useState<{ running: boolean; message?: string }>(
    () => ({ running: false })
  );
  const [harnessExportStatus, setHarnessExportStatus] = useState<{ running: boolean; message?: string }>(
    () => ({ running: false })
  );
  const [autoTuneLastStats, setAutoTuneLastStats] = useState<
    | {
        evals: {
          stage1TolSweep: number;
          stage2ParamTune: number;
          stage3TolRefine: number;
          stage4PolyTune: number;
          total: number;
        };
        ms: {
          stage1TolSweep: number;
          stage2ParamTune: number;
          stage3TolRefine: number;
          stage4PolyTune: number;
          total: number;
        };
      }
    | null
  >(null);
  const [autoTuneLastBest, setAutoTuneLastBest] = useState<
    | {
        anchor: number;
        tol: number;
        opts: SegmentTumorOptions | undefined;
        metrics: MaskMetrics;
        boundary: PolygonBoundaryMetrics;
        paintLeakPx: number;
        paintDistMeanPx: number;
        paintDistP95Px: number;
        paintDistMaxPx: number;
      }
    | null
  >(null);

  const [containerSize, setContainerSize] = useState<{ w: number; h: number }>({ w: 0, h: 0 });

  // Cache the grayscale pixels captured after the user paints so threshold tuning doesn't
  // re-capture PNGs (which can be slow/flaky and was causing "Error 5"-style crashes).
  const capturedRef = useRef<{ gray: Uint8Array; w: number; h: number; viewTransform: ViewerTransform } | null>(null);
  const [captureVersion, setCaptureVersion] = useState(0);

  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false); // Track busy state in ref for use in effects
  const [error, setError] = useState<string | null>(null);

  // Tolerance slider: anchor stays fixed, tolerance changes.
  // This makes the segmentation area monotonic with slider movement.
  const [thresholdAnchor, setThresholdAnchor] = useState<number | null>(null);
  const [thresholdTolerance, setThresholdTolerance] = useState(24);

  const effectiveThresholdFromSlider: TumorThreshold = useMemo(() => {
    const anchor = Math.max(0, Math.min(255, Math.round(thresholdAnchor ?? 128)));
    const tolerance = Math.max(0, Math.min(127, Math.round(thresholdTolerance)));
    return {
      low: Math.max(0, anchor - tolerance),
      high: Math.min(255, anchor + tolerance),
      anchor,
      tolerance,
    };
  }, [thresholdAnchor, thresholdTolerance]);

  const computeDraftFromCurrentCapture = useCallback(
    (threshold: TumorThreshold, overrideOpts?: SegmentTumorOptions) => {
      const opts = overrideOpts ?? tunedOptions ?? undefined;

      console.log('[TumorOverlay] computeDraftFromCurrentCapture START', {
        threshold,
        paintPointsCount: paintPoints.length,
        opts,
      });
      const t0 = performance.now();

      const cap = capturedRef.current;
      if (!cap) {
        console.error('[TumorOverlay] No captured image available');
        throw new Error('No captured image available');
      }

      console.log('[TumorOverlay] Captured image:', { w: cap.w, h: cap.h, grayLength: cap.gray.length });

      try {
        const result = segmentTumorFromGrayscale(cap.gray, cap.w, cap.h, paintPoints, threshold, opts);
        console.log('[TumorOverlay] Segmentation result:', { pointsCount: result.polygon.points.length, area: result.meta.areaPx });
        setDraftPolygon(result.polygon);
        setDraftPolygonViewTransform(cap.viewTransform);
        setDraftThreshold(threshold);
        setDraftSeed(result.seed);
        const elapsed = performance.now() - t0;
        console.log('[TumorOverlay] computeDraftFromCurrentCapture DONE', { elapsed: elapsed.toFixed(1) + 'ms' });
      } catch (err) {
        console.error('[TumorOverlay] Segmentation failed:', err);
        throw err;
      }
    },
    [paintPoints, tunedOptions]
  );

  // Load existing saved segmentation when enabled or when slice changes.
  useEffect(() => {
    if (!enabled) return;

    let cancelled = false;
    (async () => {
      try {
        setError(null);
        const sop = await getSopInstanceUidForInstanceIndex(seriesUid, effectiveInstanceIndex);

        const [row, gt] = await Promise.all([
          getTumorSegmentationForInstance(seriesUid, sop),
          getTumorGroundTruthForInstance(seriesUid, sop),
        ]);

        if (cancelled) return;

        const fallbackView = normalizeViewerTransform(null);

        setSavedPolygon(row?.polygon ?? null);
        setSavedPolygonViewTransform(row?.meta?.viewTransform ?? fallbackView);
        setSavedSeed(row?.seed ?? null);
        setSavedThreshold(row?.threshold ?? null);

        setGroundTruthPolygon(gt?.polygon ?? null);
        setGroundTruthPolygonViewTransform(gt?.viewTransform ?? fallbackView);
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
    setPaintPoints([]);
    setPaintPointsViewTransform(null);
    setDraftPolygon(null);
    setDraftPolygonViewTransform(null);
    setDraftThreshold(null);
    setDraftSeed(null);
    setError(null);
    setGroundTruthPolygon(null);
    setGroundTruthPolygonViewTransform(null);
    capturedRef.current = null;
    setCaptureVersion((v) => v + 1);
    setGtMetrics(null);
    setGtBoundaryMetrics(null);
  }, [enabled]);

  // Track container size (used for brush sizing + UI placement).
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

  const onPointerDown = useCallback(
    (e: React.PointerEvent) => {
      if (!enabled) return;
      if (!e.isPrimary) return;
      if (e.button !== 0) return;

      didPaintRef.current = false;

      // Avoid starting a paint gesture on overlay buttons.
      const target = e.target as HTMLElement | null;
      if (target?.closest('[data-tumor-ui="true"]')) return;

      const p = getLocalNormPoint(e);
      if (!p) return;

      setError(null);
      setPaintPointsViewTransform({ ...viewerTransformRef.current });
      setPaintPoints([p]);
      setDraftPolygon(null);
      setDraftPolygonViewTransform(null);
      setDraftThreshold(null);
      setDraftSeed(null);
      setIsPainting(true);
      capturedRef.current = null;
      setCaptureVersion((v) => v + 1);
      setGtMetrics(null);
      setGtBoundaryMetrics(null);

      try {
        containerRef.current?.setPointerCapture(e.pointerId);
      } catch {
        // ignore
      }
    },
    [enabled, getLocalNormPoint]
  );

  const didPaintRef = useRef(false);

  const onPointerMove = useCallback(
    (e: React.PointerEvent) => {
      if (!enabled) return;
      if (!isPainting) return;
      const p = getLocalNormPoint(e);
      if (!p) return;
      setPaintPoints((prev) => {
        const last = prev[prev.length - 1];
        if (last && Math.hypot(last.x - p.x, last.y - p.y) < 0.002) {
          return prev;
        }
        didPaintRef.current = true;
        return [...prev, p];
      });
    },
    [enabled, getLocalNormPoint, isPainting]
  );

  // Prevent the underlying viewer from interpreting a paint drag as a click.
  const onClickCapture = useCallback((e: React.MouseEvent) => {
    if (!didPaintRef.current) return;
    didPaintRef.current = false;
    e.preventDefault();
    e.stopPropagation();
  }, []);

  const onPointerUp = useCallback(
    async (e: React.PointerEvent) => {
      if (!enabled) return;
      if (!isPainting) return;

      try {
        containerRef.current?.releasePointerCapture(e.pointerId);
      } catch {
        // ignore
      }

      setIsPainting(false);

      // Ignore click-only gestures.
      if (paintPoints.length < 4) {
        setError('Click and drag to paint over the tumor region');
        return;
      }

      // Compute initial segmentation.
      busyRef.current = true;
      setBusy(true);
      try {
        console.log('[TumorOverlay] Starting initial segmentation after paint');
        const v = viewerRef.current;
        if (!v) throw new Error('Viewer not ready');

        const png = await v.captureVisiblePng({ maxSize: 512 }); // Higher resolution for smoother polygons
        console.log('[TumorOverlay] PNG captured, decoding...');
        const decoded = await decodeCapturedPngToGrayscale(png);
        console.log('[TumorOverlay] Decoded grayscale:', { w: decoded.width, h: decoded.height });
        capturedRef.current = {
          gray: decoded.gray,
          w: decoded.width,
          h: decoded.height,
          viewTransform: { ...viewerTransformRef.current },
        };
        setCaptureVersion((v) => v + 1);

        const initialThreshold = estimateThresholdFromSeedPoints(
          decoded.gray,
          decoded.width,
          decoded.height,
          paintPoints
        );
        console.log('[TumorOverlay] Initial threshold:', initialThreshold);

        // Initialize tolerance-mode slider state.
        const anchor =
          typeof initialThreshold.anchor === 'number'
            ? initialThreshold.anchor
            : Math.round((initialThreshold.low + initialThreshold.high) / 2);
        const tolerance =
          typeof initialThreshold.tolerance === 'number'
            ? initialThreshold.tolerance
            : Math.round((initialThreshold.high - initialThreshold.low) / 2);

        setThresholdAnchor(anchor);
        setThresholdTolerance(tolerance);

        // Use the threshold derived from (anchor, tolerance) so the slider starts "in sync".
        const thresholdForSeg: TumorThreshold = {
          low: Math.max(0, Math.min(255, Math.round(anchor - tolerance))),
          high: Math.max(0, Math.min(255, Math.round(anchor + tolerance))),
          anchor,
          tolerance,
        };

        computeDraftFromCurrentCapture(thresholdForSeg);

        console.log('[TumorOverlay] Initial segmentation complete');
      } catch (err) {
        console.error('[TumorOverlay] Initial segmentation error:', err);
        setError(err instanceof Error ? err.message : 'Segmentation failed');
      } finally {
        busyRef.current = false;
        setBusy(false);
      }
    },
    [computeDraftFromCurrentCapture, enabled, isPainting, paintPoints, viewerRef]
  );

  // Live update segmentation when threshold changes (debounced).
  //
  // Important: we reuse the grayscale pixels captured after painting, instead of re-capturing
  // PNGs on every slider move (which can be slow/flaky and was causing crashes).
  useEffect(() => {
    if (!enabled) return;
    if (!draftPolygon) return;
    if (!draftThreshold) return;
    if (paintPoints.length < 4) return;
    if (!capturedRef.current) return;

    if (draftThreshold.low === effectiveThresholdFromSlider.low && draftThreshold.high === effectiveThresholdFromSlider.high) {
      return;
    }

    // Don't trigger new segmentation while one is in progress.
    if (busyRef.current) {
      console.log('[TumorOverlay] Skipping threshold update - busy');
      return;
    }

    // Debounce slider changes to avoid firing too frequently.
    const timeout = window.setTimeout(() => {
      // Double-check busy state at execution time.
      if (busyRef.current) {
        console.log('[TumorOverlay] Skipping threshold update at exec time - busy');
        return;
      }

      busyRef.current = true;
      setBusy(true);

      // Use requestAnimationFrame to give UI a chance to update.
      requestAnimationFrame(() => {
        try {
          console.log('[TumorOverlay] Running threshold-triggered segmentation');
          computeDraftFromCurrentCapture(effectiveThresholdFromSlider);
        } catch (err) {
          console.error('[TumorOverlay] Threshold segmentation error:', err);
          setError(err instanceof Error ? err.message : 'Segmentation failed');
        } finally {
          busyRef.current = false;
          setBusy(false);
        }
      });
    }, 150); // Increased debounce to 150ms

    return () => window.clearTimeout(timeout);
  }, [draftPolygon, draftThreshold, effectiveThresholdFromSlider, enabled, paintPoints.length, computeDraftFromCurrentCapture]);

  const viewSize = useMemo(() => ({ w: containerSize.w, h: containerSize.h }), [containerSize.h, containerSize.w]);

  const paintPointsDisplay = useMemo(() => {
    if (paintPoints.length === 0) return [];
    const from = paintPointsViewTransform ?? viewerTransform;
    return viewSize.w > 0 && viewSize.h > 0
      ? remapPointsBetweenViewerTransforms(paintPoints, viewSize, from, viewerTransform)
      : paintPoints;
  }, [paintPoints, paintPointsViewTransform, viewSize, viewerTransform]);

  const draftPolygonDisplay = useMemo(() => {
    if (!draftPolygon) return null;
    const from = draftPolygonViewTransform ?? viewerTransform;
    return viewSize.w > 0 && viewSize.h > 0
      ? remapPolygonBetweenViewerTransforms(draftPolygon, viewSize, from, viewerTransform)
      : draftPolygon;
  }, [draftPolygon, draftPolygonViewTransform, viewSize, viewerTransform]);

  const savedPolygonDisplay = useMemo(() => {
    if (!savedPolygon) return null;
    const from = savedPolygonViewTransform ?? viewerTransform;
    return viewSize.w > 0 && viewSize.h > 0
      ? remapPolygonBetweenViewerTransforms(savedPolygon, viewSize, from, viewerTransform)
      : savedPolygon;
  }, [savedPolygon, savedPolygonViewTransform, viewSize, viewerTransform]);

  const groundTruthPolygonDisplay = useMemo(() => {
    if (!groundTruthPolygon) return null;
    const from = groundTruthPolygonViewTransform ?? viewerTransform;
    return viewSize.w > 0 && viewSize.h > 0
      ? remapPolygonBetweenViewerTransforms(groundTruthPolygon, viewSize, from, viewerTransform)
      : groundTruthPolygon;
  }, [groundTruthPolygon, groundTruthPolygonViewTransform, viewSize, viewerTransform]);

  const draftPath = useMemo(() => {
    if (!draftPolygonDisplay) return '';
    return polygonToSvgPath(draftPolygonDisplay);
  }, [draftPolygonDisplay]);

  const savedPath = useMemo(() => {
    if (!savedPolygonDisplay) return '';
    return polygonToSvgPath(savedPolygonDisplay);
  }, [savedPolygonDisplay]);

  const groundTruthPath = useMemo(() => {
    if (!groundTruthPolygonDisplay) return '';
    return polygonToSvgPath(groundTruthPolygonDisplay);
  }, [groundTruthPolygonDisplay]);

  const [propStatus, setPropStatus] = useState<{ running: boolean; saved: number; message?: string }>(
    { running: false, saved: 0 }
  );

  const onSave = useCallback(async () => {
    if (!draftPolygon || !draftThreshold || !draftSeed) return;

    setBusy(true);
    setError(null);
    try {
      const sop = await getSopInstanceUidForInstanceIndex(seriesUid, effectiveInstanceIndex);

      const view =
        draftPolygonViewTransform ??
        capturedRef.current?.viewTransform ??
        ({ ...viewerTransformRef.current } as ViewerTransform);

      const viewportSize =
        viewSize.w > 0 && viewSize.h > 0
          ? { w: Math.round(viewSize.w), h: Math.round(viewSize.h) }
          : undefined;

      await saveTumorSegmentation({
        comboId,
        dateIso,
        studyId,
        seriesUid,
        sopInstanceUid: sop,
        polygon: draftPolygon,
        threshold: draftThreshold,
        seed: draftSeed,
        meta: { viewTransform: view, viewportSize },
      });

      setSavedPolygon(draftPolygon);
      setSavedPolygonViewTransform(view);
      setSavedSeed(draftSeed);
      setSavedThreshold(draftThreshold);
    } catch (err) {
      console.error(err);
      setError(err instanceof Error ? err.message : 'Save failed');
    } finally {
      setBusy(false);
    }
  }, [
    comboId,
    dateIso,
    draftPolygon,
    draftPolygonViewTransform,
    draftSeed,
    draftThreshold,
    effectiveInstanceIndex,
    seriesUid,
    studyId,
    viewSize,
  ]);

  const onPropagateSeries = useCallback(async () => {
    if (!savedSeed || !savedThreshold) return;

    if (viewSize.w <= 0 || viewSize.h <= 0) {
      setPropStatus({ running: false, saved: 0, message: 'Viewer size not ready (try again).' });
      return;
    }

    setPropStatus({ running: true, saved: 0, message: 'Propagating…' });
    try {
      const result = await propagateTumorAcrossSeries({
        comboId,
        dateIso,
        studyId,
        seriesUid,
        viewportSize: viewSize,
        startEffectiveIndex: effectiveInstanceIndex,
        seed: savedSeed,
        seedViewTransform: savedPolygonViewTransform ?? { ...viewerTransformRef.current },
        threshold: savedThreshold,
        stop: {
          minAreaPx: 80,
          maxMissesInARow: 3,
        },
        onProgress: ({ direction, index, saved }) => {
          setPropStatus({
            running: true,
            saved,
            message: `Propagating ${direction} (slice ${index + 1})…`,
          });
        },
      });

      setPropStatus({
        running: false,
        saved: result.saved,
        message: `Propagation complete (saved ${result.saved} slices).`,
      });
    } catch (err) {
      console.error(err);
      setPropStatus({ running: false, saved: 0, message: err instanceof Error ? err.message : 'Propagation failed' });
    }
  }, [comboId, dateIso, effectiveInstanceIndex, savedPolygonViewTransform, savedSeed, savedThreshold, seriesUid, studyId, viewSize]);

  const clearDiffOverlay = useCallback(() => {
    const canvas = diffCanvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
  }, []);

  const drawDiffOverlay = useCallback(
    (predMask: Uint8Array, gtMask: Uint8Array, w: number, h: number) => {
      const canvas = diffCanvasRef.current;
      if (!canvas) return;

      if (canvas.width !== w || canvas.height !== h) {
        canvas.width = w;
        canvas.height = h;
      }

      const ctx = canvas.getContext('2d');
      if (!ctx) return;

      const rgba = new Uint8ClampedArray(w * h * 4);

      // FN (miss): red. FP (over-seg): magenta.
      for (let i = 0; i < predMask.length; i++) {
        const p = predMask[i] ? 1 : 0;
        const g = gtMask[i] ? 1 : 0;

        const o = i * 4;
        if (g && !p) {
          rgba[o] = 255;
          rgba[o + 1] = 0;
          rgba[o + 2] = 0;
          rgba[o + 3] = 150;
        } else if (!g && p) {
          rgba[o] = 255;
          rgba[o + 1] = 0;
          rgba[o + 2] = 255;
          rgba[o + 3] = 110;
        }
      }

      const img =
        typeof ImageData !== 'undefined'
          ? new ImageData(rgba, w, h)
          : (() => {
              const id = ctx.createImageData(w, h);
              id.data.set(rgba);
              return id;
            })();

      ctx.putImageData(img, 0, 0);
    },
    []
  );

  useEffect(() => {
    if (!enabled) return;

    const cap = capturedRef.current;
    const gtRaw = groundTruthPolygon;
    const predRaw = draftPolygon ?? savedPolygon;

    if (!cap || !gtRaw || !predRaw) {
      setGtMetrics(null);
      setGtBoundaryMetrics(null);
      clearDiffOverlay();
      return;
    }

    const size = { w: cap.w, h: cap.h };
    const evalView = cap.viewTransform;

    const predFrom = draftPolygon
      ? draftPolygonViewTransform ?? evalView
      : savedPolygonViewTransform ?? evalView;

    const gtFrom = groundTruthPolygonViewTransform ?? evalView;

    try {
      // Metrics are computed in the capture/eval view so they stay stable as the user pans/zooms.
      const gtEval = remapPolygonBetweenViewerTransforms(gtRaw, size, gtFrom, evalView);
      const predEval = remapPolygonBetweenViewerTransforms(predRaw, size, predFrom, evalView);

      const gtMaskEval = rasterizePolygonToMask(gtEval, cap.w, cap.h);
      const predMaskEval = rasterizePolygonToMask(predEval, cap.w, cap.h);

      const metrics = computeMaskMetrics(predMaskEval, gtMaskEval);
      const boundary = computePolygonBoundaryMetrics(predEval, gtEval, cap.w, cap.h);

      setGtMetrics(metrics);
      setGtBoundaryMetrics(boundary);

      // Diff overlay is drawn in the *current* viewer transform so it stays visually aligned.
      if (diffOverlayEnabled) {
        const gtDisplay = remapPolygonBetweenViewerTransforms(gtRaw, size, gtFrom, viewerTransform);
        const predDisplay = remapPolygonBetweenViewerTransforms(predRaw, size, predFrom, viewerTransform);

        const gtMaskDisplay = rasterizePolygonToMask(gtDisplay, cap.w, cap.h);
        const predMaskDisplay = rasterizePolygonToMask(predDisplay, cap.w, cap.h);

        drawDiffOverlay(predMaskDisplay, gtMaskDisplay, cap.w, cap.h);
      } else {
        clearDiffOverlay();
      }
    } catch (e) {
      console.error('[TumorOverlay] GT evaluation failed:', e);
      setGtMetrics(null);
      setGtBoundaryMetrics(null);
      clearDiffOverlay();
    }
  }, [
    captureVersion,
    clearDiffOverlay,
    diffOverlayEnabled,
    drawDiffOverlay,
    draftPolygon,
    draftPolygonViewTransform,
    enabled,
    groundTruthPolygon,
    groundTruthPolygonViewTransform,
    savedPolygon,
    savedPolygonViewTransform,
    viewerTransform,
  ]);

  const onCopyGtReport = useCallback(async () => {
    const effectiveThreshold = (() => {
      const t = effectiveThresholdFromSlider;
      if (!t) return null;

      // The slider threshold is symmetric (anchor ± tolerance), but the segmentation can apply
      // asymmetric scaling (toleranceLowScale/toleranceHighScale) via tunedOptions.
      const tol = t.tolerance ?? Math.round((t.high - t.low) / 2);

      // NOTE: These defaults must match `segmentTumorFromGrayscale` (segmentTumor.ts). Otherwise
      // the report can be misleading: the UI slider shows a symmetric range, but segmentation may
      // apply asymmetric scaling even when the user hasn't explicitly tuned it.
      const lowScale = tunedOptions?.toleranceLowScale ?? 1;
      const highScale = tunedOptions?.toleranceHighScale ?? 1;

      const clamp8 = (v: number) => Math.max(0, Math.min(255, Math.round(v)));

      const anchorRaw =
        typeof t.anchor === 'number' && Number.isFinite(t.anchor) ? t.anchor : Math.round((t.low + t.high) * 0.5);
      const anchor = clamp8(anchorRaw);

      return {
        anchor,
        tolerance: tol,
        toleranceLowScale: lowScale,
        toleranceHighScale: highScale,
        low: clamp8(anchor - tol * lowScale),
        high: clamp8(anchor + tol * highScale),
      };
    })();

    const report = {
      comboId,
      dateIso,
      seriesUid,
      effectiveInstanceIndex,
      capture: capturedRef.current ? { w: capturedRef.current.w, h: capturedRef.current.h } : null,
      threshold: effectiveThresholdFromSlider,
      effectiveThreshold,
      tunedOptions,
      paintPointsCount: paintPoints.length,
      draftPolygonPoints: draftPolygon?.points.length ?? 0,
      savedPolygonPoints: savedPolygon?.points.length ?? 0,
      gtPolygonPoints: groundTruthPolygon?.points.length ?? 0,
      metrics: gtMetrics,
      boundaryMetrics: gtBoundaryMetrics,
      autoTuneLastStats,
      autoTuneLastBest,
      note: 'Auto-tune uses a recall guardrail, then prioritizes staying near paint + reducing FP + boundary overshoot. Metrics are vs GT when available. FN=miss (red), FP=over-seg (magenta).',
    };

    const text = JSON.stringify(report, null, 2);

    try {
      await navigator.clipboard.writeText(text);
    } catch (e) {
      console.warn('[TumorOverlay] Failed to write to clipboard; logging report instead', e);
      console.log('[TumorOverlay] GT report:', report);
      setError('Failed to copy; report was logged to console.');
    }
  }, [
    autoTuneLastBest,
    autoTuneLastStats,
    comboId,
    dateIso,
    effectiveInstanceIndex,
    effectiveThresholdFromSlider,
    draftPolygon,
    groundTruthPolygon,
    gtMetrics,
    gtBoundaryMetrics,
    paintPoints,
    savedPolygon,
    seriesUid,
    tunedOptions,
  ]);

  const onCopyGtBenchmark = useCallback(async () => {
    if (busyRef.current || gtBenchmarkStatus.running) return;

    const prevBusy = busyRef.current;
    busyRef.current = true;
    setBusy(true);
    setError(null);
    setGtBenchmarkStatus({ running: true, message: 'Benchmark: loading GT rows…' });

    try {
      const gtRows = await getAllTumorGroundTruth();
      const cases = gtRows
        .filter((r) => (r.polygon?.points?.length ?? 0) >= 3)
        .map((r) => ({
          id: r.id,
          comboId: r.comboId,
          dateIso: r.dateIso,
          seriesUid: r.seriesUid,
          sopInstanceUid: r.sopInstanceUid,
          gtPolygon: r.polygon,
          gtViewTransform: r.viewTransform,
          gtViewportSize: r.viewportSize,
        }));

      if (cases.length === 0) {
        throw new Error('No ground truth polygons found in IndexedDB.');
      }

      const v2Off: SegmentTumorOptions = {
        bgModel: { enabled: false },
        geodesic: { enabled: false },
      };

      const v2Bg: SegmentTumorOptions = {
        bgModel: { enabled: true },
        geodesic: { enabled: false },
      };

      const v2BgGeo: SegmentTumorOptions = {
        bgModel: { enabled: true },
        geodesic: { enabled: true },
      };

      const configs = [
        { name: 'baseline', opts: v2Off },
        { name: 'v2:bg', opts: v2Bg },
        { name: 'v2:bg+geo', opts: v2BgGeo },
        ...(tunedOptions
          ? [
              { name: 'tuned', opts: { ...tunedOptions, ...v2Off } },
              { name: 'tuned+v2:bg', opts: { ...tunedOptions, ...v2Bg } },
              { name: 'tuned+v2:bg+geo', opts: { ...tunedOptions, ...v2BgGeo } },
            ]
          : []),
      ];

      const report = await runGtBenchmark({
        cases,
        configs,
        maxEvalDim: 256,
        paintPointsPerCase: 24,
        yieldEveryCases: 1,
        onProgress: (p) => setGtBenchmarkStatus({ running: true, message: p.message }),
      });

      const wrapped = {
        comboId,
        dateIso,
        tunedOptions,
        report,
        note: 'Benchmark uses deterministic auto-generated paint points derived from GT polygons. baseline forces v2 features off so results are comparable even if localStorage segmentation flags are set. v2:* enables brush-only background model and/or geodesic edge-aware gating.',
      };

      const text = JSON.stringify(wrapped, null, 2);

      try {
        await navigator.clipboard.writeText(text);
        setGtBenchmarkStatus({ running: false, message: `Benchmark copied (${cases.length} cases).` });
      } catch (e) {
        console.warn('[TumorOverlay] Failed to write benchmark to clipboard; logging instead', e);
        console.log('[TumorOverlay] GT benchmark report:', wrapped);
        setGtBenchmarkStatus({ running: false, message: 'Benchmark done (logged to console).' });
        setError('Failed to copy; benchmark report was logged to console.');
      }
    } catch (e) {
      console.error('[TumorOverlay] GT benchmark failed:', e);
      setGtBenchmarkStatus({ running: false, message: 'Benchmark failed (see console).' });
      setError(e instanceof Error ? e.message : 'GT benchmark failed');
    } finally {
      busyRef.current = prevBusy;
      setBusy(false);
    }
  }, [comboId, dateIso, gtBenchmarkStatus.running, tunedOptions]);

  const onExportHarnessDataset = useCallback(async () => {
    if (busyRef.current || harnessExportStatus.running) return;

    const prevBusy = busyRef.current;
    busyRef.current = true;
    setBusy(true);
    setError(null);
    setHarnessExportStatus({ running: true, message: 'Export: loading ground truth rows…' });

    try {
      const gtRows = await getAllTumorGroundTruth();

      const startSopInstanceUid = await getSopInstanceUidForInstanceIndex(seriesUid, effectiveInstanceIndex);

      await exportTumorHarnessDatasetAndDownload({
        maxEvalDim: 256,
        gtRows,
        paintPointsPerCase: 24,
        propagationScenario:
          paintPoints.length >= 4 && viewSize.w > 0 && viewSize.h > 0
            ? {
                comboId,
                dateIso,
                studyId,
                seriesUid,
                startEffectiveIndex: effectiveInstanceIndex,
                startSopInstanceUid,
                paintPointsViewer01: paintPoints,
                paintPointsViewTransform: paintPointsViewTransform,
                viewportSize: viewSize,
                threshold: effectiveThresholdFromSlider,
                stop: { minAreaPx: 80, maxMissesInARow: 3 },
                marginSlices: 2,
              }
            : undefined,
        onProgress: (message) => setHarnessExportStatus({ running: true, message }),
      });

      setHarnessExportStatus({ running: false, message: 'Export complete (downloaded zip).' });
    } catch (e) {
      console.error('[TumorOverlay] Harness export failed:', e);
      setHarnessExportStatus({ running: false, message: 'Export failed (see console).' });
      setError(e instanceof Error ? e.message : 'Export failed');
    } finally {
      busyRef.current = prevBusy;
      setBusy(false);
    }
  }, [
    comboId,
    dateIso,
    effectiveInstanceIndex,
    effectiveThresholdFromSlider,
    harnessExportStatus.running,
    paintPoints,
    paintPointsViewTransform,
    seriesUid,
    studyId,
    viewSize,
  ]);

  const onResetTuning = useCallback(() => {
    // Force a recompute with default options so the UI reflects the reset immediately.
    try {
      if (capturedRef.current && paintPoints.length >= 4) {
        computeDraftFromCurrentCapture(effectiveThresholdFromSlider, {});
      }
    } catch (e) {
      console.error('[TumorOverlay] Failed to recompute after tuning reset:', e);
    }

    setTunedOptions(null);
  }, [computeDraftFromCurrentCapture, effectiveThresholdFromSlider, paintPoints]);

  const onAutoTune = useCallback(async () => {
    if (busyRef.current || autoTuneStatus.running) return;

    const cap = capturedRef.current;
    if (!cap) {
      setError('Paint first (we need a captured image to evaluate against GT).');
      return;
    }

    if (paintPoints.length < 4) {
      setError('Paint first (not enough paint points to run segmentation).');
      return;
    }

    if (!groundTruthPolygon) {
      setError('No ground truth polygon found for this slice. Use the GT tool to draw + save one.');
      return;
    }

    const anchor = Math.round(
      thresholdAnchor ??
        (draftThreshold?.anchor ??
          (draftThreshold ? (draftThreshold.low + draftThreshold.high) / 2 : 128))
    );
    const baseTol = Math.max(0, Math.min(127, Math.round(thresholdTolerance)));

    // Auto-tune can be expensive (many candidates). Use a downsampled grid for mask metrics.
    // Polygons are in normalized coords, so rasterizing at lower res is a good approximation.
    const evalW = Math.max(128, Math.round(cap.w / 2));
    const evalH = Math.max(128, Math.round(cap.h / 2));

    const gtFrom = groundTruthPolygonViewTransform ?? cap.viewTransform;

    // Auto-tune evaluates candidates in the captured-image coordinate system (cap.viewTransform).
    // If the GT polygon was drawn under a different viewer transform, re-project it into cap space.
    const gtPolyEval = remapPolygonBetweenViewerTransforms(
      groundTruthPolygon,
      { w: evalW, h: evalH },
      gtFrom,
      cap.viewTransform
    );
    const gtMask = rasterizePolygonToMask(gtPolyEval, evalW, evalH);

    const gtPolyCap = remapPolygonBetweenViewerTransforms(
      groundTruthPolygon,
      { w: cap.w, h: cap.h },
      gtFrom,
      cap.viewTransform
    );

    // Heuristic: penalize candidates whose predicted polygon drifts far outside the user's painted bbox.
    // This correlates strongly with "leaky" segmentations (low precision) and matches what feels wrong in the UI.
    const paintBounds = pointsBounds01(paintPoints);

    // Additional heuristic: measure how far predicted pixels are from the painted stroke itself.
    // This catches the common failure mode where the polygon stays within the paint bbox but still
    // "fills" large same-intensity regions far from the actual stroke.
    const paintDistEval = (() => {
      const out = new Int32Array(evalW * evalH);
      out.fill(-1);

      const qx = new Int32Array(evalW * evalH);
      const qy = new Int32Array(evalW * evalH);
      let qh = 0;
      let qt = 0;

      const push = (x: number, y: number, d: number) => {
        const i = y * evalW + x;
        if (out[i] !== -1) return;
        out[i] = d;
        qx[qt] = x;
        qy[qt] = y;
        qt++;
      };

      for (const p of paintPoints) {
        const x = Math.max(0, Math.min(evalW - 1, Math.round(p.x * (evalW - 1))));
        const y = Math.max(0, Math.min(evalH - 1, Math.round(p.y * (evalH - 1))));
        push(x, y, 0);
      }

      // Fallback: if somehow we have no seeds, treat everything as far away.
      if (qt === 0) {
        out.fill(999999);
        return out;
      }

      while (qh < qt) {
        const x = qx[qh]!;
        const y = qy[qh]!;
        qh++;

        const base = out[y * evalW + x]!;
        const nd = base + 1;

        if (x > 0) push(x - 1, y, nd);
        if (x < evalW - 1) push(x + 1, y, nd);
        if (y > 0) push(x, y - 1, nd);
        if (y < evalH - 1) push(x, y + 1, nd);
      }

      return out;
    })();

    const mkThreshold = (thAnchor: number, tol: number): TumorThreshold => {
      const a = Math.max(0, Math.min(255, Math.round(thAnchor)));
      const t = Math.max(0, Math.min(127, Math.round(tol)));
      return {
        low: Math.max(0, Math.min(255, a - t)),
        high: Math.max(0, Math.min(255, a + t)),
        anchor: a,
        tolerance: t,
      };
    };

    type Candidate = {
      anchor: number;
      tol: number;
      opts: SegmentTumorOptions | undefined;
      metrics: MaskMetrics;
      boundary: PolygonBoundaryMetrics;
      /** Max outward expansion beyond the painted bbox (pixels). Lower is better. */
      paintLeakPx: number;
      /** Mean Manhattan distance (in eval pixels) from predicted pixels to the painted stroke. Lower is better. */
      paintDistMeanPx: number;
      /** 95th percentile Manhattan distance (eval px) from predicted pixels to the painted stroke. Lower is better. */
      paintDistP95Px: number;
      /** Maximum Manhattan distance (eval px) from predicted pixels to the painted stroke. Lower is better. */
      paintDistMaxPx: number;
    };

    const isBetter = (a: Candidate, b: Candidate) => {
      // IMPORTANT: use near-tie thresholds so we don't choose a meaningfully worse boundary
      // just to gain ~0.0001 of overlap metric.
      const EPS_F2 = 0.003;
      const EPS_RECALL = 0.003;
      const EPS_DICE = 0.003;
      const EPS_BND_MEAN = 0.25; // px
      const EPS_BND_MAX = 0.75; // px

      // Paint-leak/dist thresholds:
      // - Keep them fairly small so auto-tune actively searches for candidates that stay near the paint.
      // - We still allow a little slack because paint points are noisy (pointer sampling + brush width).
      const EPS_PAINT_LEAK = 4; // px (full-res)
      const EPS_PAINT_DIST_MEAN = 0.35; // eval px
      const EPS_PAINT_DIST_P95 = 0.75; // eval px
      const EPS_PAINT_DIST_MAX = 1.5; // eval px

      // When FP is extremely close (near-tie), prefer fewer FN to avoid under-segmentation.
      // NOTE: This is at eval resolution, so values are smaller than full-res.
      const EPS_FP_TIE = 3;

      // Guardrail: keep recall above a minimum, then aggressively optimize precision / boundary fit.
      //
      // Why:
      // - In the UI, users can usually fix small FN by painting a bit more.
      // - Huge FP (low precision) is much harder to correct and often corresponds to "escaping" the paint bbox.
      const MIN_RECALL = 0.97;
      const aMeetsRecall = a.metrics.recall >= MIN_RECALL;
      const bMeetsRecall = b.metrics.recall >= MIN_RECALL;

      if (aMeetsRecall && !bMeetsRecall) return true;
      if (bMeetsRecall && !aMeetsRecall) return false;

      if (aMeetsRecall && bMeetsRecall) {
        // Within the acceptable-recall region, prioritize:
        // 1) staying near the paint (prevents "fill" leaks)
        // 2) fewer false positives (precision)
        // 3) then boundary fit
        // 4) then overlap
        if (a.paintLeakPx < b.paintLeakPx - EPS_PAINT_LEAK) return true;
        if (b.paintLeakPx < a.paintLeakPx - EPS_PAINT_LEAK) return false;

        // Use a tail metric first: mean can hide a small-but-important leak far from paint.
        if (a.paintDistP95Px < b.paintDistP95Px - EPS_PAINT_DIST_P95) return true;
        if (b.paintDistP95Px < a.paintDistP95Px - EPS_PAINT_DIST_P95) return false;

        if (a.paintDistMaxPx < b.paintDistMaxPx - EPS_PAINT_DIST_MAX) return true;
        if (b.paintDistMaxPx < a.paintDistMaxPx - EPS_PAINT_DIST_MAX) return false;

        if (a.paintDistMeanPx < b.paintDistMeanPx - EPS_PAINT_DIST_MEAN) return true;
        if (b.paintDistMeanPx < a.paintDistMeanPx - EPS_PAINT_DIST_MEAN) return false;

        if (Math.abs(a.metrics.fp - b.metrics.fp) <= EPS_FP_TIE) {
          if (a.metrics.fn !== b.metrics.fn) return a.metrics.fn < b.metrics.fn;
        }

        if (a.metrics.fp !== b.metrics.fp) return a.metrics.fp < b.metrics.fp;

        // Reduce outward leakage / overshoot.
        if (a.boundary.meanPredToGtPx < b.boundary.meanPredToGtPx - EPS_BND_MEAN) return true;
        if (b.boundary.meanPredToGtPx < a.boundary.meanPredToGtPx - EPS_BND_MEAN) return false;

        if (a.metrics.fn !== b.metrics.fn) return a.metrics.fn < b.metrics.fn;

        if (a.boundary.maxPredToGtPx < b.boundary.maxPredToGtPx - EPS_BND_MAX) return true;
        if (b.boundary.maxPredToGtPx < a.boundary.maxPredToGtPx - EPS_BND_MAX) return false;

        if (a.boundary.meanSymPx < b.boundary.meanSymPx - EPS_BND_MEAN) return true;
        if (b.boundary.meanSymPx < a.boundary.meanSymPx - EPS_BND_MEAN) return false;

        if (a.metrics.dice > b.metrics.dice + EPS_DICE) return true;
        if (b.metrics.dice > a.metrics.dice + EPS_DICE) return false;

        return a.metrics.iou > b.metrics.iou;
      }

      // Below the recall guardrail, keep optimizing for recall-weighted overlap.
      if (a.metrics.f2 > b.metrics.f2 + EPS_F2) return true;
      if (b.metrics.f2 > a.metrics.f2 + EPS_F2) return false;

      if (a.metrics.recall > b.metrics.recall + EPS_RECALL) return true;
      if (b.metrics.recall > a.metrics.recall + EPS_RECALL) return false;

      if (a.metrics.fn !== b.metrics.fn) return a.metrics.fn < b.metrics.fn;

      if (a.boundary.meanPredToGtPx < b.boundary.meanPredToGtPx - EPS_BND_MEAN) return true;
      if (b.boundary.meanPredToGtPx < a.boundary.meanPredToGtPx - EPS_BND_MEAN) return false;

      if (a.metrics.fp !== b.metrics.fp) return a.metrics.fp < b.metrics.fp;

      if (a.boundary.maxPredToGtPx < b.boundary.maxPredToGtPx - EPS_BND_MAX) return true;
      if (b.boundary.maxPredToGtPx < a.boundary.maxPredToGtPx - EPS_BND_MAX) return false;

      if (a.metrics.dice > b.metrics.dice + EPS_DICE) return true;
      if (b.metrics.dice > a.metrics.dice + EPS_DICE) return false;

      return a.metrics.iou > b.metrics.iou;
    };

    const paintDistMaxPossible = evalW + evalH;
    const paintDistHist = new Int32Array(paintDistMaxPossible + 1);

    const evalCandidate = (
      thAnchor: number,
      tol: number,
      opts: SegmentTumorOptions | undefined
    ): Candidate | null => {
      const threshold = mkThreshold(thAnchor, tol);
      try {
        const res = segmentTumorFromGrayscale(cap.gray, cap.w, cap.h, paintPoints, threshold, opts);
        const predMask = rasterizePolygonToMask(res.polygon, evalW, evalH);

        // Compute overlap metrics and paint-distance metrics in a single pass.
        let tp = 0;
        let fp = 0;
        let fn = 0;
        let tn = 0;

        paintDistHist.fill(0);
        let predCount = 0;
        let sumPaintDist = 0;
        let paintDistMaxPx = 0;

        for (let i = 0; i < predMask.length; i++) {
          const p = predMask[i] ? 1 : 0;
          const g = gtMask[i] ? 1 : 0;

          if (p) {
            predCount++;

            const dRaw = paintDistEval[i] ?? 0;
            const d = Math.max(0, Math.min(paintDistMaxPossible, dRaw));

            sumPaintDist += d;
            paintDistHist[d] = (paintDistHist[d] ?? 0) + 1;
            if (d > paintDistMaxPx) paintDistMaxPx = d;
          }

          if (p && g) tp++;
          else if (p && !g) fp++;
          else if (!p && g) fn++;
          else tn++;
        }

        const safeDiv = (num: number, den: number) => (den > 0 ? num / den : 0);
        const precision = safeDiv(tp, tp + fp);
        const recall = safeDiv(tp, tp + fn);
        const dice = safeDiv(2 * tp, 2 * tp + fp + fn);
        const iou = safeDiv(tp, tp + fp + fn);

        const beta2 = 4;
        const f2 = safeDiv((1 + beta2) * precision * recall, beta2 * precision + recall);

        const metrics: MaskMetrics = { tp, fp, fn, tn, precision, recall, dice, iou, f2 };

        const paintDistMeanPx = predCount > 0 ? sumPaintDist / predCount : Number.POSITIVE_INFINITY;

        // Tail distance metric: approximate via histogram to avoid storing per-pixel distances.
        let paintDistP95Px = Number.POSITIVE_INFINITY;
        if (predCount > 0) {
          const target = Math.ceil(predCount * 0.95);
          let cum = 0;
          for (let d = 0; d < paintDistHist.length; d++) {
            cum += paintDistHist[d] ?? 0;
            if (cum >= target) {
              paintDistP95Px = d;
              break;
            }
          }
        }

        const boundary = computePolygonBoundaryMetrics(res.polygon, gtPolyCap, cap.w, cap.h);

        const predBounds = polygonBounds01(res.polygon);
        const leakLeftPx = predBounds.minX < paintBounds.minX ? (paintBounds.minX - predBounds.minX) * cap.w : 0;
        const leakRightPx = predBounds.maxX > paintBounds.maxX ? (predBounds.maxX - paintBounds.maxX) * cap.w : 0;
        const leakTopPx = predBounds.minY < paintBounds.minY ? (paintBounds.minY - predBounds.minY) * cap.h : 0;
        const leakBottomPx = predBounds.maxY > paintBounds.maxY ? (predBounds.maxY - paintBounds.maxY) * cap.h : 0;
        const paintLeakPx = Math.max(leakLeftPx, leakRightPx, leakTopPx, leakBottomPx);

        return {
          anchor: thAnchor,
          tol: threshold.tolerance ?? tol,
          opts,
          metrics,
          boundary,
          paintLeakPx,
          paintDistMeanPx,
          paintDistP95Px,
          paintDistMaxPx,
        };
      } catch {
        return null;
      }
    };

    const yieldToUi = () => new Promise<void>((resolve) => window.setTimeout(resolve, 0));

    const stats = {
      evals: {
        stage1TolSweep: 0,
        stage2ParamTune: 0,
        stage3TolRefine: 0,
        stage4PolyTune: 0,
        total: 0,
      },
      ms: {
        stage1TolSweep: 0,
        stage2ParamTune: 0,
        stage3TolRefine: 0,
        stage4PolyTune: 0,
        total: 0,
      },
    };

    busyRef.current = true;
    setBusy(true);
    setError(null);

    try {
      const baselineOpts = tunedOptions ?? undefined;

      // Stage 1: sweep (anchor, tolerance) around the current estimate.
      setAutoTuneStatus({ running: true, message: 'Auto-tune: sweeping anchor+tolerance…' });

      let best: Candidate | null = null;

      const anchorCandidates: number[] = [];
      // Include both parities. Otherwise, when `anchor` is odd we'd only test odd anchors (and vice versa),
      // which can miss materially better solutions (e.g. true best anchor at anchor±7).
      for (let a = anchor - 12; a <= anchor + 12; a += 2) {
        anchorCandidates.push(Math.max(0, Math.min(255, a)));
      }
      for (let a = anchor - 11; a <= anchor + 11; a += 2) {
        anchorCandidates.push(Math.max(0, Math.min(255, a)));
      }
      const uniqAnchor = Array.from(new Set(anchorCandidates)).sort((a, b) => a - b);

      const tolCandidates: number[] = [];
      for (let t = baseTol - 30; t <= baseTol + 30; t += 2) {
        tolCandidates.push(Math.max(0, Math.min(127, t)));
      }
      // Ensure unique + deterministic.
      const uniqTol = Array.from(new Set(tolCandidates)).sort((a, b) => a - b);

      const stage1Total = uniqAnchor.length * uniqTol.length;
      let stage1Done = 0;

      const stage1Start = performance.now();
      for (const a of uniqAnchor) {
        for (const tol of uniqTol) {
          const cand = evalCandidate(a, tol, baselineOpts);
          stats.evals.stage1TolSweep++;
          stats.evals.total++;
          stage1Done++;

          if (cand && (!best || isBetter(cand, best))) best = cand;

          if (stage1Done % 60 === 0) {
            setAutoTuneStatus({
              running: true,
              message: `Auto-tune: sweeping anchor+tolerance… (${stage1Done}/${stage1Total})`,
            });
            await yieldToUi();
          }
        }
      }
      stats.ms.stage1TolSweep = performance.now() - stage1Start;

      if (!best) {
        throw new Error('Auto-tune failed: no valid segmentations produced.');
      }

      // Stage 2: parameter tuning.
      //
      // IMPORTANT: Full grid search is combinatorially expensive and can freeze the UI.
      // We use a small, deterministic coordinate-descent search instead.
      //
      // Key quality improvement: couple tolerance with parameter updates by evaluating a small
      // local tolerance window per candidate.
      setAutoTuneStatus({ running: true, message: 'Auto-tune: tuning parameters…' });

      const stage2Start = performance.now();
      const optsKey = (o: SegmentTumorOptions | undefined) => JSON.stringify(o ?? null);
      const stage2StartOptsKey = optsKey(best.opts);

      // Bias the search toward tighter distance gating.
      // This matters a lot for FLAIR-like cases where leakage can explode FP.
      const baseMins = [2, 4, 8];
      const paintFactors = [0.25, 0.35, 0.6];
      const widthFactors = [0.05, 0.1, 0.2];

      const maxDistTriples: Array<{ baseMin: number; paintScaleFactor: number; thresholdWidthFactor: number }> = [];
      for (const baseMin of baseMins) {
        for (const paintScaleFactor of paintFactors) {
          for (const thresholdWidthFactor of widthFactors) {
            maxDistTriples.push({ baseMin, paintScaleFactor, thresholdWidthFactor });
          }
        }
      }

      const openIters = [0, 1];
      const closeIters = [0, 1, 2];
      const adaptiveFlags = [false, true];

      // Asymmetric tolerance can reduce leakage when only one side is problematic.
      const tolLowScales = [0.6, 0.8, 1, 1.25];
      const tolHighScales = [0.6, 0.8, 1, 1.25];

      // Include mild values near 1.0 so we can get "just a bit" tighter without increasing FN.
      const distTolScaleMins = [1, 0.85, 0.7, 0.55, 0.4, 0.25];

      // Include a gentle edge penalty; 0.35/0.65 were sometimes too coarse.
      const edgePenaltyStrengths = [0, 0.15, 0.35, 0.55];

      // When options change, the best tolerance can move a lot. Use wider offsets so parameter tuning
      // can "pull" the search toward a different tolerance regime.
      const tolOffsets = [-16, -8, 0, 8, 16];
      const uniqTolAround = (center: number) => {
        const out: number[] = [];
        for (const off of tolOffsets) {
          out.push(Math.max(0, Math.min(127, Math.round(center + off))));
        }
        return Array.from(new Set(out)).sort((a, b) => a - b);
      };

      // If Stage 1 found a good (anchor,tol) using baselineOpts, Stage 2 can still need to "jump"
      // to a different anchor once maxDist/morph/asymmetry changes.
      const anchorOffsets = [-12, 0, 12];
      const uniqAnchorAround = (center: number) => {
        const out: number[] = [];
        for (const off of anchorOffsets) {
          out.push(Math.max(0, Math.min(255, Math.round(center + off))));
        }
        return Array.from(new Set(out)).sort((a, b) => a - b);
      };

      // One pass is usually enough once we allow anchor to move; keep it fast.
      const PASSES = 1;
      const totalUpperBound =
        PASSES *
        (maxDistTriples.length +
          openIters.length +
          closeIters.length +
          adaptiveFlags.length +
          tolLowScales.length +
          tolHighScales.length +
          distTolScaleMins.length +
          edgePenaltyStrengths.length) *
        tolOffsets.length *
        anchorOffsets.length;

      let idx = 0;
      const maybeYield = async () => {
        if (idx % 32 === 0) {
          setAutoTuneStatus({
            running: true,
            message: `Auto-tune: tuning parameters… (${idx}/${totalUpperBound})`,
          });
          await yieldToUi();
        }
      };

      const tryUpdate = async (opts: SegmentTumorOptions | undefined) => {
        if (!best) return;

        const centerTol = best.tol;
        const tols = uniqTolAround(centerTol);

        const centerAnchor = best.anchor;
        const anchors = uniqAnchorAround(centerAnchor);

        let localBest: Candidate | null = null;
        for (const anchorCand of anchors) {
          for (const tol of tols) {
            const cand = evalCandidate(anchorCand, tol, opts);
            stats.evals.stage2ParamTune++;
            stats.evals.total++;
            idx++;

            if (cand && (!localBest || isBetter(cand, localBest))) localBest = cand;
            await maybeYield();
          }
        }

        if (localBest && isBetter(localBest, best)) best = localBest;
      };

      for (let pass = 0; pass < PASSES; pass++) {
        // 2a) Tune the distance gate triple.
        for (const t of maxDistTriples) {
          await tryUpdate({ ...(best.opts ?? {}), maxDistToPaint: t });
        }

        // 2b) Tune morphology.
        for (const morphologicalOpenIterations of openIters) {
          await tryUpdate({ ...(best.opts ?? {}), morphologicalOpenIterations });
        }
        for (const morphologicalCloseIterations of closeIters) {
          await tryUpdate({ ...(best.opts ?? {}), morphologicalCloseIterations });
        }

        // 2c) Tune adaptive flag (edge penalty is disabled for adaptive candidates).
        for (const adaptiveEnabled of adaptiveFlags) {
          await tryUpdate({
            ...(best.opts ?? {}),
            adaptiveEnabled,
            edgePenaltyStrength: adaptiveEnabled ? 0 : (best.opts?.edgePenaltyStrength ?? 0),
          });
        }

        // 2d) Tune asymmetric tolerance.
        for (const toleranceLowScale of tolLowScales) {
          await tryUpdate({ ...(best.opts ?? {}), toleranceLowScale });
        }
        for (const toleranceHighScale of tolHighScales) {
          await tryUpdate({ ...(best.opts ?? {}), toleranceHighScale });
        }

        // 2e) Tune soft distance penalty.
        for (const distanceToleranceScaleMin of distTolScaleMins) {
          await tryUpdate({ ...(best.opts ?? {}), distanceToleranceScaleMin });
        }

        // 2f) Tune edge penalty (only relevant when adaptive is off).
        if (best.opts?.adaptiveEnabled !== true) {
          for (const edgePenaltyStrength of edgePenaltyStrengths) {
            await tryUpdate({ ...(best.opts ?? {}), edgePenaltyStrength });
          }
        }
      }
      stats.ms.stage2ParamTune = performance.now() - stage2Start;

      // Stage 3: refine anchor + tolerance around the best.
      //
      // Why:
      // - Stage 1 chooses (anchor,tol) using baselineOpts.
      // - Stage 2 may change opts materially (distance gating / morphology / asymmetry), which can shift
      //   the best (anchor,tol) pair.
      // - Anchor/tolerance interact, so do a small local 2D search (instead of independent 1D passes).
      setAutoTuneStatus({ running: true, message: 'Auto-tune: refining threshold…' });

      const stage3Start = performance.now();
      const stage2EndOptsKey = optsKey(best.opts);
      const tolRefineRadius = stage2EndOptsKey === stage2StartOptsKey ? 8 : 20;
      const anchorRefineRadius = stage2EndOptsKey === stage2StartOptsKey ? 4 : 10;

      const tolStep = tolRefineRadius > 12 ? 2 : 1;
      const anchorStep = anchorRefineRadius > 6 ? 2 : 1;

      for (let a = best.anchor - anchorRefineRadius; a <= best.anchor + anchorRefineRadius; a += anchorStep) {
        const anchorCand = Math.max(0, Math.min(255, a));

        for (let t = best.tol - tolRefineRadius; t <= best.tol + tolRefineRadius; t += tolStep) {
          const tol = Math.max(0, Math.min(127, t));
          const cand = evalCandidate(anchorCand, tol, best.opts);
          stats.evals.stage3TolRefine++;
          stats.evals.total++;

          if (cand && isBetter(cand, best)) best = cand;
        }
      }

      stats.ms.stage3TolRefine = performance.now() - stage3Start;

      // Stage 4: tune display-side smoothing/simplification.
      setAutoTuneStatus({ running: true, message: 'Auto-tune: tuning polygon smoothing…' });

      const stage4Start = performance.now();
      const smoothingCandidates = [0, 1, 2];
      const epsCandidates = [0.0003, 0.0005, 0.0008, 0.0012, 0.0018, 0.0024];

      for (const smoothingIterations of smoothingCandidates) {
        for (const simplifyEpsilon of epsCandidates) {
          const opts: SegmentTumorOptions = {
            ...(best.opts ?? {}),
            smoothingIterations,
            simplifyEpsilon,
          };
          const cand = evalCandidate(best.anchor, best.tol, opts);
          stats.evals.stage4PolyTune++;
          stats.evals.total++;

          if (cand && isBetter(cand, best)) best = cand;
        }
      }
      stats.ms.stage4PolyTune = performance.now() - stage4Start;

      stats.ms.total = performance.now() - stage1Start;
      setAutoTuneLastStats(stats);
      setAutoTuneLastBest({
        anchor: best.anchor,
        tol: best.tol,
        opts: best.opts,
        metrics: best.metrics,
        boundary: best.boundary,
        paintLeakPx: best.paintLeakPx,
        paintDistMeanPx: best.paintDistMeanPx,
        paintDistP95Px: best.paintDistP95Px,
        paintDistMaxPx: best.paintDistMaxPx,
      });

      setAutoTuneStatus({
        running: false,
        message: `Auto-tune done (F2 ${best.metrics.f2.toFixed(3)}, recall ${best.metrics.recall.toFixed(3)}).`,
      });

      console.log('[TumorOverlay] Auto-tune BEST', {
        anchor: best.anchor,
        tol: best.tol,
        opts: best.opts,
        metrics: best.metrics,
        boundary: best.boundary,
        paintLeakPx: best.paintLeakPx,
        paintDistMeanPx: best.paintDistMeanPx,
        paintDistP95Px: best.paintDistP95Px,
        paintDistMaxPx: best.paintDistMaxPx,
      });
      console.log('[TumorOverlay] Auto-tune STATS', stats);

      setTunedOptions(best.opts ?? null);
      setThresholdAnchor(best.anchor);
      setThresholdTolerance(best.tol);

      computeDraftFromCurrentCapture(mkThreshold(best.anchor, best.tol), best.opts);
    } catch (e) {
      console.error('[TumorOverlay] Auto-tune failed:', e);
      setAutoTuneStatus({ running: false, message: 'Auto-tune failed (see console).' });
      setError(e instanceof Error ? e.message : 'Auto-tune failed');
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }, [
    autoTuneStatus.running,
    computeDraftFromCurrentCapture,
    draftThreshold,
    groundTruthPolygon,
    groundTruthPolygonViewTransform,
    paintPoints,
    thresholdAnchor,
    thresholdTolerance,
    tunedOptions,
  ]);

  if (!enabled) return null;

  return (
    <div
      ref={containerRef}
      className="absolute inset-0"
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onClickCapture={onClickCapture}
    >
      {/* UI chrome */}
      {/*
        Position below the viewer's top hover controls (Tumor/GT buttons + ImageControls).
        Otherwise it visually overlaps the control bar in GridView/OverlayView.
      */}
      <div className="absolute top-12 left-2 z-20 flex items-center gap-2" data-tumor-ui="true">
        <div className="px-2 py-1 rounded bg-black/70 border border-white/10 text-white text-xs flex items-center gap-2">
          <Sparkles className="w-3.5 h-3.5 text-[var(--accent)]" />
          Tumor
          {busy ? <span className="text-white/70">…</span> : null}
        </div>

        <button
          type="button"
          onClick={onRequestClose}
          className="p-1 rounded bg-black/70 border border-white/10 text-white/80 hover:text-white"
          title="Close tumor tool"
        >
          <X className="w-4 h-4" />
        </button>
      </div>

      {/* Threshold + save controls (only after painting / draft segmentation exists) */}
      {draftPolygon && containerSize.w > 0 && containerSize.h > 0
        ? (() => {
            // Anchor threshold controls next to the *user-painted area*, not the draft polygon.
            // The polygon can change substantially as the threshold moves, but the painted region
            // is the user's mental anchor for where they were working.
            const bbox = paintPointsDisplay.length
              ? pointsBounds01(paintPointsDisplay)
              : polygonBounds01(draftPolygonDisplay ?? draftPolygon);

            // Place the control panel next to the painted region, preferring the right side.
            const panelWidth = 176;
            const sliderHeight = Math.max(
              120,
              Math.min(260, Math.round((bbox.maxY - bbox.minY) * containerSize.h))
            );

            const gtSectionHeight = groundTruthPolygon ? 175 : 0;
            const panelHeight = sliderHeight + 78 + gtSectionHeight;

            const minXpx = bbox.minX * containerSize.w;
            const maxXpx = bbox.maxX * containerSize.w;
            const minYpx = bbox.minY * containerSize.h;

            let left = maxXpx + 12;
            if (left + panelWidth > containerSize.w - 8) {
              left = minXpx - panelWidth - 12;
            }
            left = Math.max(8, Math.min(containerSize.w - panelWidth - 8, left));

            let top = minYpx;
            top = Math.max(8, Math.min(containerSize.h - panelHeight - 8, top));

            return (
              <div
                className="absolute z-20 rounded-lg bg-black/70 border border-white/10 shadow-xl px-2 py-2 flex flex-col items-center gap-2"
                style={{ left, top, width: panelWidth }}
                data-tumor-ui="true"
              >
                {/* Vertical threshold slider */}
                <div
                  className="relative flex items-center justify-center"
                  style={{ width: 28, height: sliderHeight }}
                >
                  <input
                    type="range"
                    min={0}
                    max={127}
                    step={1}
                    value={thresholdTolerance}
                    onChange={(e) => setThresholdTolerance(parseInt(e.target.value, 10))}
                    className="absolute"
                    style={{
                      width: sliderHeight,
                      transform: 'rotate(-90deg)',
                      transformOrigin: 'center',
                    }}
                    aria-label="Tolerance"
                  />
                </div>

                <div className="text-[10px] text-white/70 tabular-nums">
                  {effectiveThresholdFromSlider.low}–{effectiveThresholdFromSlider.high}
                </div>

                <button
                  type="button"
                  onClick={() => void onSave()}
                  disabled={busy || !draftPolygon || !draftThreshold}
                  className={`w-full px-2 py-1 rounded text-xs flex items-center justify-center gap-1.5 border ${
                    busy || !draftPolygon || !draftThreshold
                      ? 'bg-[var(--bg-tertiary)] text-[var(--text-tertiary)] border-[var(--border-color)]'
                      : 'bg-[var(--accent)] text-white border-[var(--accent)] hover:bg-[var(--accent-hover)]'
                  }`}
                  title="Save tumor polygon"
                >
                  <Save className="w-3.5 h-3.5" />
                  Save
                </button>

                {savedSeed && savedThreshold ? (
                  <button
                    type="button"
                    onClick={() => void onPropagateSeries()}
                    disabled={busy || propStatus.running}
                    className={`w-full px-2 py-1 rounded text-xs border ${
                      busy || propStatus.running
                        ? 'bg-[var(--bg-tertiary)] text-[var(--text-tertiary)] border-[var(--border-color)]'
                        : 'bg-[var(--bg-primary)] text-[var(--text-secondary)] border-[var(--border-color)] hover:text-[var(--text-primary)]'
                    }`}
                    title="Propagate segmentation across slices in this series"
                  >
                    Propagate
                  </button>
                ) : null}

                {groundTruthPolygon ? (
                  <div className="w-full pt-2 mt-1 border-t border-white/10 flex flex-col gap-1">
                    <div className="w-full flex items-center justify-between">
                      <div className="text-[10px] text-white/70">
                        GT Eval
                        {tunedOptions ? <span className="ml-1 text-cyan-200/80">(tuned)</span> : null}
                      </div>

                      <button
                        type="button"
                        onClick={() => setDiffOverlayEnabled((v) => !v)}
                        className="p-1 rounded border border-white/10 bg-black/50 text-white/80 hover:text-white"
                        title={diffOverlayEnabled ? 'Hide diff overlay' : 'Show diff overlay'}
                      >
                        {diffOverlayEnabled ? <EyeOff className="w-3.5 h-3.5" /> : <Eye className="w-3.5 h-3.5" />}
                      </button>
                    </div>

                    {gtMetrics ? (
                      <div className="w-full text-[10px] text-white/80 tabular-nums">
                        <div className="flex justify-between">
                          <span className="text-white/70">F2</span>
                          <span>{gtMetrics.f2.toFixed(3)}</span>
                        </div>
                        <div className="flex justify-between">
                          <span className="text-white/70">Recall</span>
                          <span>{gtMetrics.recall.toFixed(3)}</span>
                        </div>
                        <div className="flex justify-between">
                          <span className="text-white/70">Prec</span>
                          <span>{gtMetrics.precision.toFixed(3)}</span>
                        </div>
                        <div className="flex justify-between">
                          <span className="text-white/70">IoU</span>
                          <span>{gtMetrics.iou.toFixed(3)}</span>
                        </div>
                        <div className="flex justify-between">
                          <span className="text-white/70">Dice</span>
                          <span>{gtMetrics.dice.toFixed(3)}</span>
                        </div>

                        {gtBoundaryMetrics ? (
                          <>
                            <div className="flex justify-between">
                              <span className="text-white/70">Bnd out μ</span>
                              <span>{gtBoundaryMetrics.meanPredToGtPx.toFixed(2)} px</span>
                            </div>
                            <div className="flex justify-between">
                              <span className="text-white/70">Bnd in μ</span>
                              <span>{gtBoundaryMetrics.meanGtToPredPx.toFixed(2)} px</span>
                            </div>
                            <div className="flex justify-between">
                              <span className="text-white/70">Bnd μ</span>
                              <span>{gtBoundaryMetrics.meanSymPx.toFixed(2)} px</span>
                            </div>
                            <div className="flex justify-between">
                              <span className="text-white/70">Bnd max</span>
                              <span>{gtBoundaryMetrics.maxSymPx.toFixed(1)} px</span>
                            </div>
                          </>
                        ) : null}

                        <div className="flex justify-between">
                          <span className="text-white/70">FN</span>
                          <span className="text-red-200">{gtMetrics.fn}</span>
                        </div>
                        <div className="flex justify-between">
                          <span className="text-white/70">FP</span>
                          <span className="text-fuchsia-200">{gtMetrics.fp}</span>
                        </div>
                      </div>
                    ) : (
                      <div className="text-[10px] text-white/60">Paint + segment to evaluate vs GT.</div>
                    )}

                    <div className="w-full flex items-center gap-1 pt-1">
                      <button
                        type="button"
                        onClick={() => void onAutoTune()}
                        disabled={busy || autoTuneStatus.running}
                        className={`flex-1 px-2 py-1 rounded text-[11px] border flex items-center justify-center gap-1 ${
                          busy || autoTuneStatus.running
                            ? 'bg-[var(--bg-tertiary)] text-[var(--text-tertiary)] border-[var(--border-color)]'
                            : 'bg-cyan-500/80 text-white border-cyan-300/30 hover:bg-cyan-500'
                        }`}
                        title="Auto-tune segmentation parameters vs ground truth"
                      >
                        <Wand2 className="w-3.5 h-3.5" />
                        Auto
                      </button>

                      <button
                        type="button"
                        onClick={() => void onCopyGtBenchmark()}
                        disabled={busy || gtBenchmarkStatus.running}
                        className={`px-2 py-1 rounded text-[11px] border ${
                          busy || gtBenchmarkStatus.running
                            ? 'bg-[var(--bg-tertiary)] text-[var(--text-tertiary)] border-[var(--border-color)]'
                            : 'bg-[var(--bg-primary)] text-[var(--text-secondary)] border-[var(--border-color)] hover:text-[var(--text-primary)]'
                        }`}
                        title="Run GT benchmark across all saved GT polygons (copies JSON)"
                      >
                        <BarChart3 className="w-3.5 h-3.5" />
                      </button>

                      {import.meta.env.DEV ? (
                        <button
                          type="button"
                          onClick={() => void onExportHarnessDataset()}
                          disabled={busy || harnessExportStatus.running}
                          className={`px-2 py-1 rounded text-[11px] border ${
                            busy || harnessExportStatus.running
                              ? 'bg-[var(--bg-tertiary)] text-[var(--text-tertiary)] border-[var(--border-color)]'
                              : 'bg-[var(--bg-primary)] text-[var(--text-secondary)] border-[var(--border-color)] hover:text-[var(--text-primary)]'
                          }`}
                          title="Export tumor harness dataset (zip)"
                        >
                          <Download className="w-3.5 h-3.5" />
                        </button>
                      ) : null}

                      <button
                        type="button"
                        onClick={() => void onCopyGtReport()}
                        disabled={busy}
                        className={`px-2 py-1 rounded text-[11px] border ${
                          busy
                            ? 'bg-[var(--bg-tertiary)] text-[var(--text-tertiary)] border-[var(--border-color)]'
                            : 'bg-[var(--bg-primary)] text-[var(--text-secondary)] border-[var(--border-color)] hover:text-[var(--text-primary)]'
                        }`}
                        title="Copy GT debug report (metrics + params)"
                      >
                        <Copy className="w-3.5 h-3.5" />
                      </button>

                      <button
                        type="button"
                        onClick={onResetTuning}
                        disabled={busy || !tunedOptions}
                        className={`px-2 py-1 rounded text-[11px] border ${
                          busy || !tunedOptions
                            ? 'bg-[var(--bg-tertiary)] text-[var(--text-tertiary)] border-[var(--border-color)]'
                            : 'bg-[var(--bg-primary)] text-[var(--text-secondary)] border-[var(--border-color)] hover:text-[var(--text-primary)]'
                        }`}
                        title="Reset tuned parameters"
                      >
                        <RotateCcw className="w-3.5 h-3.5" />
                      </button>
                    </div>

                    {autoTuneStatus.message ? (
                      <div className="text-[10px] text-white/60 pt-0.5">{autoTuneStatus.message}</div>
                    ) : null}
                    {gtBenchmarkStatus.message ? (
                      <div className="text-[10px] text-white/60 pt-0.5">{gtBenchmarkStatus.message}</div>
                    ) : null}
                    {harnessExportStatus.message ? (
                      <div className="text-[10px] text-white/60 pt-0.5">{harnessExportStatus.message}</div>
                    ) : null}
                  </div>
                ) : null}
              </div>
            );
          })()
        : null}

      {/* Error / status */}
      {error ? (
        <div className="absolute bottom-2 left-2 right-2 z-20 px-2 py-1 rounded bg-red-900/60 border border-red-400/30 text-red-100 text-xs" data-tumor-ui="true">
          {error}
        </div>
      ) : propStatus.message ? (
        <div className="absolute bottom-2 left-2 right-2 z-20 px-2 py-1 rounded bg-black/70 border border-white/10 text-white/80 text-xs" data-tumor-ui="true">
          {propStatus.message}
        </div>
      ) : !draftPolygon ? (
        <div className="absolute bottom-2 left-2 right-2 z-20 px-2 py-1 rounded bg-black/60 border border-white/10 text-white/80 text-xs" data-tumor-ui="true">
          Click and drag to paint the tumor region.
        </div>
      ) : null}

      {/* GT diff overlay (FN red, FP magenta) */}
      {groundTruthPolygon && diffOverlayEnabled ? (
        <canvas
          ref={diffCanvasRef}
          className="absolute inset-0 pointer-events-none"
          style={{ width: '100%', height: '100%', opacity: 0.75 }}
          aria-hidden
        />
      ) : null}

      {/* Paint stroke preview (transparent pink brush) */}
      {paintPointsDisplay.length > 1 ? (
        <svg className="absolute inset-0 pointer-events-none" viewBox="0 0 1 1" preserveAspectRatio="none" aria-hidden>
          <polyline
            points={paintPointsDisplay.map((p) => `${p.x.toFixed(4)},${p.y.toFixed(4)}`).join(' ')}
            fill="none"
            stroke="rgba(236, 72, 153, 0.55)"
            strokeWidth={Math.max(2, Math.round(Math.min(containerSize.w, containerSize.h) * 0.02))}
            strokeLinecap="round"
            strokeLinejoin="round"
            vectorEffect="non-scaling-stroke"
          />
        </svg>
      ) : null}

      {/* Ground truth polygon (debug) */}
      {groundTruthPath ? (
        <svg className="absolute inset-0 pointer-events-none" viewBox="0 0 1 1" preserveAspectRatio="none" aria-hidden>
          <path
            d={groundTruthPath}
            fill="rgba(34, 211, 238, 0.06)"
            stroke="rgba(34, 211, 238, 0.90)"
            strokeWidth={2}
            vectorEffect="non-scaling-stroke"
          />
        </svg>
      ) : null}

      {/* Saved polygon */}
      {savedPath ? (
        <svg className="absolute inset-0 pointer-events-none" viewBox="0 0 1 1" preserveAspectRatio="none" aria-hidden>
          <path
            d={savedPath}
            fill="rgba(16, 185, 129, 0.12)"
            stroke="rgba(16, 185, 129, 0.85)"
            strokeWidth={2}
            vectorEffect="non-scaling-stroke"
          />
        </svg>
      ) : null}

      {/* Draft polygon (overlays saved) */}
      {draftPath ? (
        <svg className="absolute inset-0 pointer-events-none" viewBox="0 0 1 1" preserveAspectRatio="none" aria-hidden>
          <path
            d={draftPath}
            fill="rgba(236, 72, 153, 0.10)"
            stroke="rgba(236, 72, 153, 0.9)"
            strokeWidth={2}
            vectorEffect="non-scaling-stroke"
          />
        </svg>
      ) : null}
    </div>
  );
}
