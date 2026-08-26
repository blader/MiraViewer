import { useCallback, useEffect, useEffectEvent, useMemo, useReducer, useRef, useState } from 'react';
import { X } from 'lucide-react';
import type { NormalizedPoint, TumorGrow2dMeta, TumorPolygon, TumorThreshold, ViewerTransform } from '../db/schema';
import type { DicomViewerHandle } from './DicomViewer';
import {
  getSopInstanceUidForInstanceIndex,
  getTumorGroundTruthForInstance,
  getTumorSegmentationForInstance,
  saveTumorSegmentation,
} from '../utils/localApi';
import { normalizeModalityPixelsToGrayscale } from '../utils/segmentation/segmentTumor';
import { segmentationAreaMm2 } from '../utils/segmentation/physicalMeasurements';
import {
  computeCostDistanceMap,
  distThresholdFromSlider,
  type CostDistanceGrow2dResult,
  type CostDistanceGrow2dTuning,
} from '../utils/segmentation/costDistanceGrow2d';
import { marchingSquaresContour } from '../utils/segmentation/marchingSquares';
import {
  normalizeViewerTransform,
  imagePointToViewerPoint,
  imagePolygonToViewerPolygon,
  polygonToSvgPath,
  remapPointBetweenViewerTransforms,
  remapPolygonBetweenViewerTransforms,
  viewerPointToImagePoint,
  viewerPolygonToImagePolygon,
} from '../utils/viewTransform';
import { clamp, clamp01 } from '../utils/math';

const GROW2D_UI_STORAGE_KEY_PREFIX = 'miraviewer:tumor-grow2d-ui-v1';
const LEGACY_GROW2D_TUNING_STORAGE_KEY = 'miraviewer:tumor-grow2d-tuning-v1';

function getGrow2dUiStorageKey(params: { comboId: string; dateIso: string }): string {
  return `${GROW2D_UI_STORAGE_KEY_PREFIX}:${params.dateIso}:${params.comboId}`;
}

type Grow2dTuningUi = Pick<Required<CostDistanceGrow2dTuning>, 'surfaceTension'>;

type Grow2dUiSettings = {
  tuning: Grow2dTuningUi;
  targetAreaPx: number;
};

const LOCKED_BASE_STEP_SCALE = 15;

const DEFAULT_GROW2D_TUNING: Grow2dTuningUi = {
  surfaceTension: 1.0,
};

function normalizeGrow2dTuning(raw: unknown): Grow2dTuningUi {
  const obj = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};

  const surfaceTensionRaw = obj.surfaceTension;
  const surfaceTension =
    typeof surfaceTensionRaw === 'number' && Number.isFinite(surfaceTensionRaw)
      ? surfaceTensionRaw
      : DEFAULT_GROW2D_TUNING.surfaceTension;

  return {
    surfaceTension: clamp(surfaceTension, 0, 10),
  };
}

function normalizeGrow2dUiSettings(raw: unknown, maxTargetAreaPx: number): Grow2dUiSettings {
  const obj = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};

  const tuning = normalizeGrow2dTuning(obj.tuning);

  const aRaw = obj.targetAreaPx;
  const a = typeof aRaw === 'number' && Number.isFinite(aRaw) ? Math.round(aRaw) : 800;

  return { tuning, targetAreaPx: Math.max(1, Math.min(maxTargetAreaPx, a)) };
}

function loadGrow2dUiSettings(params: { storageKey: string; maxTargetAreaPx: number }): Grow2dUiSettings {
  const defaultOut: Grow2dUiSettings = {
    tuning: { ...DEFAULT_GROW2D_TUNING },
    targetAreaPx: Math.max(1, Math.min(params.maxTargetAreaPx, 800)),
  };

  if (typeof localStorage === 'undefined') return defaultOut;

  try {
    const raw = localStorage.getItem(params.storageKey);
    if (raw) {
      const parsed: unknown = JSON.parse(raw);

      // Support a legacy shape where the storage value is directly the tuning object.
      const pObj = parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : null;
      if (pObj && !('tuning' in pObj) && !('targetAreaPx' in pObj)) {
        return { ...defaultOut, tuning: normalizeGrow2dTuning(parsed) };
      }

      return normalizeGrow2dUiSettings(parsed, params.maxTargetAreaPx);
    }
  } catch {
    // Fall through to legacy/defaults.
  }

  // Legacy fallback: global tuning key (pre per-date/sequence storage).
  try {
    const raw = localStorage.getItem(LEGACY_GROW2D_TUNING_STORAGE_KEY);
    if (raw) {
      return { ...defaultOut, tuning: normalizeGrow2dTuning(JSON.parse(raw)) };
    }
  } catch {
    // Ignore quota / privacy-mode errors.
  }

  return defaultOut;
}

export type TumorSegmentationOverlayProps = {
  enabled: boolean;
  onRequestClose: () => void;

  /** Optional external seed box to (re)start the grow from (normalized screen coords). */
  seedBoxToStart?: NormalizedRoi | null;
  onSeedBoxToStartConsumed?: () => void;

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

type Capture = {
  gray: Uint8Array;
  w: number;
  h: number;
  viewTransform: ViewerTransform;
  viewportSize: { w: number; h: number };
  imageSize: { w: number; h: number };
};

type NormalizedRoi = { x0: number; y0: number; x1: number; y1: number };

type PersistedTumorAnnotations = {
  sopInstanceUid: string | null;
  savedPolygon: TumorPolygon | null;
  savedImageSize: { w: number; h: number } | null;
  savedPolygonViewTransform: ViewerTransform | null;
  savedSeed: NormalizedPoint | null;
  savedGrow2d: TumorGrow2dMeta | null;
  groundTruthPolygon: TumorPolygon | null;
  groundTruthImageSize: { w: number; h: number } | null;
  groundTruthPolygonViewTransform: ViewerTransform | null;
};

function updatePersistedTumorAnnotations(
  current: PersistedTumorAnnotations,
  update: Partial<PersistedTumorAnnotations>,
): PersistedTumorAnnotations {
  return { ...current, ...update };
}

function pointsToSvgPath(points: NormalizedPoint[]): string {
  if (points.length === 0) return '';
  const d = [`M ${points[0].x.toFixed(4)} ${points[0].y.toFixed(4)}`];
  for (let i = 1; i < points.length; i++) {
    d.push(`L ${points[i].x.toFixed(4)} ${points[i].y.toFixed(4)}`);
  }
  d.push('Z');
  return d.join(' ');
}

function toGrow2dMeta(params: {
  grow: CostDistanceGrow2dResult;
  targetAreaPx: number;
  maxTargetAreaPx: number;
}): TumorGrow2dMeta {
  const { grow, targetAreaPx, maxTargetAreaPx } = params;

  const maxA = Math.max(1, Math.round(maxTargetAreaPx));
  const a = Math.max(1, Math.min(maxA, Math.round(targetAreaPx)));

  return {
    kind: 'cost-distance',
    slider: {
      value01: clamp01(a / maxA),
      targetAreaPx: a,
      maxTargetAreaPx: maxA,
    },
    roi: { ...grow.roi },
    captureSize: { w: grow.w, h: grow.h },
    stats: {
      tumorMu: grow.stats.tumor.mu,
      tumorSigma: grow.stats.tumor.sigma,
      bgMu: grow.stats.bg?.mu,
      bgSigma: grow.stats.bg?.sigma,
      edgeBarrier: grow.stats.edgeBarrier,
    },
    weights: {
      edgeCostStrength: grow.weights.edgeCostStrength,
      crossCostStrength: grow.weights.crossCostStrength,
      tumorCostStrength: grow.weights.tumorCostStrength,
      bgCostStrength: grow.weights.bgCostStrength,
      bgRejectMarginZ: grow.weights.bgRejectMarginZ,
      allowDiagonal: grow.weights.allowDiagonal,
    },
    tuning: {
      ...grow.tuning,
    },
    dist: {
      maxFiniteDist: grow.maxFiniteDist,
    },
  };
}

function useTumorSegmentationEditor({
  enabled,
  seedBoxToStart,
  onSeedBoxToStartConsumed,
  viewerRef,
  comboId,
  dateIso,
  studyId,
  seriesUid,
  effectiveInstanceIndex,
  viewerTransform,
}: TumorSegmentationOverlayProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);

  // Keep the latest viewer transform in a ref so we can snapshot it during capture.
  const viewerTransformRef = useRef(viewerTransform);
  useEffect(() => {
    viewerTransformRef.current = viewerTransform;
  }, [viewerTransform]);

  const [containerSize, setContainerSize] = useState<{ w: number; h: number }>({ w: 0, h: 0 });
  const viewSize = useMemo(() => ({ w: containerSize.w, h: containerSize.h }), [containerSize.h, containerSize.w]);
  const viewSizeRef = useRef(viewSize);
  useEffect(() => {
    viewSizeRef.current = viewSize;
  }, [viewSize]);

  const [busy, setBusy] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const capturedRef = useRef<Capture | null>(null);
  const [captureVersion, setCaptureVersion] = useState(0);

  const growRef = useRef<CostDistanceGrow2dResult | null>(null);
  const [growVersion, setGrowVersion] = useState(0);

  // Cap for the area-target slider. This controls how far the user can expand the grow.
  // NOTE: Keeping this too large makes the range input feel overly sensitive.
  const MAX_TARGET_AREA_PX = 10_000;

  const grow2dUiStorageKey = getGrow2dUiStorageKey({ comboId, dateIso });
  const [grow2dUiStorageKeyForState, setGrow2dUiStorageKeyForState] = useState(grow2dUiStorageKey);

  const [grow2dUi, setGrow2dUi] = useState<Grow2dUiSettings>(() =>
    loadGrow2dUiSettings({ storageKey: grow2dUiStorageKey, maxTargetAreaPx: MAX_TARGET_AREA_PX }),
  );

  const grow2dTuning = grow2dUi.tuning;
  const targetAreaPx = grow2dUi.targetAreaPx;

  const setGrow2dTuning = useCallback((updater: Grow2dTuningUi | ((prev: Grow2dTuningUi) => Grow2dTuningUi)) => {
    setGrow2dUi((s) => ({
      ...s,
      tuning: typeof updater === 'function' ? (updater as (p: Grow2dTuningUi) => Grow2dTuningUi)(s.tuning) : updater,
    }));
  }, []);

  const setTargetAreaPx = useCallback(
    (updater: number | ((prev: number) => number)) => {
      setGrow2dUi((s) => {
        const nextRaw = typeof updater === 'function' ? (updater as (p: number) => number)(s.targetAreaPx) : updater;
        const next = Math.max(1, Math.min(MAX_TARGET_AREA_PX, Math.round(nextRaw)));
        return { ...s, targetAreaPx: next };
      });
    },
    [MAX_TARGET_AREA_PX],
  );

  // Load per-sequence/date slider settings.
  useEffect(() => {
    const loaded = loadGrow2dUiSettings({ storageKey: grow2dUiStorageKey, maxTargetAreaPx: MAX_TARGET_AREA_PX });
    setGrow2dUi(loaded);
    setGrow2dUiStorageKeyForState(grow2dUiStorageKey);
  }, [MAX_TARGET_AREA_PX, grow2dUiStorageKey]);

  // Persist per-sequence/date slider settings.
  useEffect(() => {
    if (grow2dUiStorageKeyForState !== grow2dUiStorageKey) return;
    if (typeof localStorage === 'undefined') return;
    try {
      localStorage.setItem(
        grow2dUiStorageKey,
        JSON.stringify({
          v: 1,
          tuning: grow2dUi.tuning,
          targetAreaPx: Math.round(grow2dUi.targetAreaPx),
        }),
      );
    } catch {
      // Ignore quota / privacy-mode errors.
    }
  }, [grow2dUi, grow2dUiStorageKey, grow2dUiStorageKeyForState]);

  // Precomputed mapping: N pixels -> distance threshold for selecting dist<=T.
  // Built once per seed grow so the slider isn't overly sensitive (especially at small areas).
  const areaThresholdsRef = useRef<Float32Array | null>(null);

  // Segmentation starts from a user-drawn seed box (no single-click anchor).
  // Use a single seed at the box centroid.
  const SEED_COUNT = 1;

  const [draftSeed, setDraftSeed] = useState<NormalizedPoint | null>(null);
  const draftSeedRef = useRef<NormalizedPoint | null>(null);
  useEffect(() => {
    draftSeedRef.current = draftSeed;
  }, [draftSeed]);

  const [draftSeedViewTransform, setDraftSeedViewTransform] = useState<ViewerTransform | null>(null);
  const draftSeedViewTransformRef = useRef<ViewerTransform | null>(null);
  useEffect(() => {
    draftSeedViewTransformRef.current = draftSeedViewTransform;
  }, [draftSeedViewTransform]);

  const [draftPolygon, setDraftPolygon] = useState<TumorPolygon | null>(null);
  const [draftPolygonViewTransform, setDraftPolygonViewTransform] = useState<ViewerTransform | null>(null);
  const [draftAreaPx, setDraftAreaPx] = useState<number | null>(null);
  const [pixelAreaMm2, setPixelAreaMm2] = useState<number | null>(null);

  const [persistedAnnotations, updatePersistedAnnotations] = useReducer(updatePersistedTumorAnnotations, {
    sopInstanceUid: null,
    savedPolygon: null,
    savedImageSize: null,
    savedPolygonViewTransform: null,
    savedSeed: null,
    savedGrow2d: null,
    groundTruthPolygon: null,
    groundTruthImageSize: null,
    groundTruthPolygonViewTransform: null,
  });
  const {
    sopInstanceUid,
    savedPolygon,
    savedImageSize,
    savedPolygonViewTransform,
    savedSeed,
    savedGrow2d,
    groundTruthPolygon,
    groundTruthImageSize,
    groundTruthPolygonViewTransform,
  } = persistedAnnotations;

  // Keep per-slice saved seed + viewTransform in refs so slice-change auto-start can avoid stale state.
  const savedDataSliceKeyRef = useRef<string | null>(null);
  const savedSeedRef = useRef<NormalizedPoint | null>(null);
  const savedViewTransformRef = useRef<ViewerTransform | null>(null);

  const abortRef = useRef<AbortController | null>(null);
  const sliceGenerationRef = useRef(0);

  const startGrowRef = useRef<((params: { seedBox: NormalizedRoi }) => Promise<void>) | null>(null);
  const autoStartSliceKeyRef = useRef<string | null>(null);

  const debugEnabled = typeof localStorage !== 'undefined' && localStorage.getItem('miraviewer:debug-grow2d') === '1';

  // Track container size (used for hit-testing + UI placement).
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

  // Load saved segmentation + GT when enabled or slice changes.
  // IMPORTANT: clear any draft/captured state immediately so we don't render stale overlays while loading.
  useEffect(() => {
    if (!enabled) return;

    const sliceKey = `${seriesUid}:${effectiveInstanceIndex}`;
    sliceGenerationRef.current++;
    savedDataSliceKeyRef.current = sliceKey;
    savedSeedRef.current = null;
    savedViewTransformRef.current = normalizeViewerTransform(null);

    setError(null);
    setBusy(false);
    setSaving(false);

    // Cancel any in-flight grow.
    abortRef.current?.abort();
    abortRef.current = null;

    capturedRef.current = null;
    setCaptureVersion((v) => v + 1);

    growRef.current = null;
    setGrowVersion((v) => v + 1);

    areaThresholdsRef.current = null;

    // Keep the seed anchor across slice changes so the tool stays "live" as the user scrolls.
    // We only clear the draft segmentation + capture/grow state, which are slice-specific.
    setDraftPolygon(null);
    setDraftPolygonViewTransform(null);
    setDraftAreaPx(null);
    setPixelAreaMm2(null);

    // Clear per-slice saved/GT state until the async load completes.
    updatePersistedAnnotations({
      sopInstanceUid: null,
      savedPolygon: null,
      savedImageSize: null,
      savedPolygonViewTransform: normalizeViewerTransform(null),
      savedSeed: null,
      savedGrow2d: null,
      groundTruthPolygon: null,
      groundTruthImageSize: null,
      groundTruthPolygonViewTransform: normalizeViewerTransform(null),
    });

    // Also clear refs so slice-change auto-start can't use stale saved state.
    savedSeedRef.current = null;
    savedViewTransformRef.current = normalizeViewerTransform(null);

    let cancelled = false;
    (async () => {
      try {
        const sop = await getSopInstanceUidForInstanceIndex(seriesUid, effectiveInstanceIndex);
        if (cancelled) return;

        updatePersistedAnnotations({ sopInstanceUid: sop });

        const [row, gt] = await Promise.all([
          getTumorSegmentationForInstance(seriesUid, sop),
          getTumorGroundTruthForInstance(seriesUid, sop),
        ]);

        if (cancelled) return;

        const fallbackView = normalizeViewerTransform(null);

        const savedView = row?.meta?.viewTransform ?? fallbackView;
        const canonicalImageSize =
          row?.meta?.coordinateSpace === 'image-normalized' ? (row.meta.imageSize ?? null) : null;
        const currentViewport = viewSizeRef.current;
        const savedSeed =
          row?.seed && canonicalImageSize && currentViewport.w > 0 && currentViewport.h > 0
            ? imagePointToViewerPoint(row.seed, currentViewport, canonicalImageSize, viewerTransformRef.current)
            : (row?.seed ?? null);

        updatePersistedAnnotations({
          savedPolygon: row?.polygon ?? null,
          savedImageSize: canonicalImageSize,
          savedPolygonViewTransform: savedView,
          savedSeed,
          savedGrow2d: (row?.meta?.grow2d as TumorGrow2dMeta | undefined) ?? null,
          groundTruthPolygon: gt?.polygon ?? null,
          groundTruthImageSize: gt?.coordinateSpace === 'image-normalized' ? (gt.imageSize ?? null) : null,
          groundTruthPolygonViewTransform: gt?.viewTransform ?? fallbackView,
        });

        // Update refs for slice-change auto-start.
        if (savedDataSliceKeyRef.current === sliceKey) {
          savedSeedRef.current = savedSeed;
          savedViewTransformRef.current = canonicalImageSize ? viewerTransformRef.current : savedView;
        }
      } catch (e) {
        console.error(e);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [enabled, effectiveInstanceIndex, seriesUid]);

  // If we have a saved grow2d row and no per-sequence/date slider settings yet, seed the settings from it.
  useEffect(() => {
    if (!enabled) return;
    if (draftSeed) return;

    if (typeof localStorage !== 'undefined') {
      try {
        if (localStorage.getItem(grow2dUiStorageKey)) return;
      } catch {
        // Ignore quota / privacy-mode errors.
      }
    }

    const s = savedGrow2d?.slider;
    const savedTuning = savedGrow2d?.tuning;

    if (savedTuning) {
      setGrow2dTuning(normalizeGrow2dTuning(savedTuning));
    }

    if (!s) return;

    const a =
      typeof s.targetAreaPx === 'number' && Number.isFinite(s.targetAreaPx)
        ? Math.round(s.targetAreaPx)
        : typeof s.value01 === 'number' && Number.isFinite(s.value01)
          ? Math.round(clamp01(s.value01) * MAX_TARGET_AREA_PX)
          : null;

    if (a != null) {
      setTargetAreaPx(Math.max(1, Math.min(MAX_TARGET_AREA_PX, a)));
    }
  }, [MAX_TARGET_AREA_PX, draftSeed, enabled, grow2dUiStorageKey, savedGrow2d, setGrow2dTuning, setTargetAreaPx]);

  const computeDraftPolygonFromGrow = useCallback(
    (overrideTargetAreaPx?: number) => {
      const cap = capturedRef.current;
      const grow = growRef.current;
      if (!cap || !grow) return;

      const thresholds = areaThresholdsRef.current;

      const aRaw =
        typeof overrideTargetAreaPx === 'number' && Number.isFinite(overrideTargetAreaPx)
          ? overrideTargetAreaPx
          : targetAreaPx;
      const a = Math.max(1, Math.min(MAX_TARGET_AREA_PX, Math.round(aRaw)));

      const T = (() => {
        if (thresholds && thresholds.length > 0) {
          const idx = Math.min(a, thresholds.length) - 1;
          return thresholds[idx] ?? thresholds[thresholds.length - 1] ?? 0;
        }

        // Fallback: quantile LUT (coarser, but better than nothing).
        const s = clamp01(a / MAX_TARGET_AREA_PX);
        return distThresholdFromSlider({ quantileLut: grow.quantileLut, slider01: s, gamma: 1 });
      })();

      const mask = (() => {
        const out = new Uint8Array(grow.w * grow.h);
        const { x0, y0, x1, y1 } = grow.roi;

        let area = 0;

        for (let y = y0; y <= y1; y++) {
          const row = y * grow.w;
          for (let x = x0; x <= x1; x++) {
            const i = row + x;
            const d = grow.dist[i] ?? Number.POSITIVE_INFINITY;
            if (d <= T) {
              out[i] = 1;
              area++;
            }
          }
        }

        return { out, area };
      })();

      if (mask.area <= 0) {
        setDraftPolygon(null);
        setDraftPolygonViewTransform(null);
        setDraftAreaPx(0);
        return;
      }

      const contourPx = marchingSquaresContour(mask.out, grow.w, grow.h, grow.roi);
      if (contourPx.length < 3) {
        setDraftPolygon(null);
        setDraftPolygonViewTransform(null);
        setDraftAreaPx(mask.area);
        return;
      }

      const points = contourPx.map((p) =>
        imagePointToViewerPoint(
          { x: p.x / Math.max(1, grow.w - 1), y: p.y / Math.max(1, grow.h - 1) },
          cap.viewportSize,
          cap.imageSize,
          cap.viewTransform,
        ),
      );

      setDraftPolygon({ points });
      setDraftPolygonViewTransform(cap.viewTransform);
      setDraftAreaPx(mask.area);

      if (debugEnabled) {
        console.log('[TumorSeedGrow] draft polygon updated', {
          targetAreaPx: a,
          T,
          points: points.length,
          area: mask.area,
        });
      }
    },
    [MAX_TARGET_AREA_PX, debugEnabled, targetAreaPx],
  );

  const updateDraftPolygon = useEffectEvent(() => computeDraftPolygonFromGrow());

  // Update draft polygon when slider changes (throttled to animation frames).
  const rafRef = useRef<number | null>(null);
  useEffect(() => {
    if (!enabled) return;
    if (!growRef.current || !capturedRef.current || !draftSeed) return;

    if (rafRef.current != null) {
      cancelAnimationFrame(rafRef.current);
    }

    rafRef.current = requestAnimationFrame(() => {
      rafRef.current = null;
      updateDraftPolygon();
    });

    return () => {
      if (rafRef.current != null) {
        cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
      }
    };
  }, [draftSeed, enabled, targetAreaPx, growVersion]);

  const startGrow = useCallback(
    async (params: { seedBox: NormalizedRoi }) => {
      const v = viewerRef.current;
      if (!v) {
        setError('Viewer not ready');
        return;
      }

      setError(null);
      setBusy(true);

      // Abort any in-flight grow and replace its controller.
      abortRef.current?.abort();
      const ac = new AbortController();
      abortRef.current = ac;

      try {
        const viewTransformAtCapture = { ...viewerTransformRef.current };

        const anchor: NormalizedPoint = {
          x: (params.seedBox.x0 + params.seedBox.x1) * 0.5,
          y: (params.seedBox.y0 + params.seedBox.y1) * 0.5,
        };

        if (debugEnabled) {
          console.log('[TumorSeedGrow] decoding native frame for grow', {
            anchor,
            seedBox: params.seedBox,
            viewTransformAtCapture,
          });
        }

        const decoded = await v.getDecodedFrame();
        if (ac.signal.aborted) return;
        if (decoded.seriesUid !== seriesUid) {
          throw new Error('The displayed image changed before segmentation could start');
        }
        const viewportSize =
          decoded.viewportSize.w > 0 && decoded.viewportSize.h > 0 ? decoded.viewportSize : viewSizeRef.current;
        if (viewportSize.w <= 0 || viewportSize.h <= 0) {
          throw new Error('Viewer dimensions are unavailable for image-space segmentation');
        }

        const cap: Capture = {
          gray: normalizeModalityPixelsToGrayscale(decoded.pixels),
          w: decoded.cols,
          h: decoded.rows,
          viewTransform: viewTransformAtCapture,
          viewportSize,
          imageSize: { w: decoded.cols, h: decoded.rows },
        };
        setPixelAreaMm2(segmentationAreaMm2(1, decoded.rowSpacingMm, decoded.colSpacingMm));
        capturedRef.current = cap;
        setCaptureVersion((x) => x + 1);

        setDraftSeed(anchor);
        setDraftSeedViewTransform(viewTransformAtCapture);

        const imageAnchor = viewerPointToImagePoint(anchor, cap.viewportSize, cap.imageSize, cap.viewTransform);
        const seedPx = { x: imageAnchor.x * (cap.w - 1), y: imageAnchor.y * (cap.h - 1) };

        const grow = await computeCostDistanceMap({
          gray: cap.gray,
          w: cap.w,
          h: cap.h,
          seedPx,
          seedCount: SEED_COUNT,
          tuning: { ...grow2dTuning, baseStepScale: LOCKED_BASE_STEP_SCALE },
          yieldEvery: 20000,
          yieldToUi: () => new Promise<void>((resolve) => window.setTimeout(resolve, 0)),
          signal: ac.signal,
        });

        growRef.current = grow;

        // Precompute area→threshold mapping so the slider stays well-behaved at small sizes.
        areaThresholdsRef.current = (() => {
          const { x0, y0, x1, y1 } = grow.roi;
          const roiW = Math.max(1, x1 - x0 + 1);
          const roiH = Math.max(1, y1 - y0 + 1);

          const tmp = new Float32Array(roiW * roiH);
          let n = 0;

          for (let y = y0; y <= y1; y++) {
            const row = y * grow.w;
            for (let x = x0; x <= x1; x++) {
              const d = grow.dist[row + x] ?? Number.POSITIVE_INFINITY;
              if (!Number.isFinite(d)) continue;
              tmp[n++] = d;
            }
          }

          if (n <= 0) return new Float32Array([0]);

          const finite = tmp.subarray(0, n);
          finite.sort();

          const outN = Math.min(MAX_TARGET_AREA_PX, finite.length);
          return finite.slice(0, outN);
        })();

        setGrowVersion((x) => x + 1);

        // Start with the persisted value (clamped to the available threshold LUT for this grow).
        const thresholds = areaThresholdsRef.current;
        const maxA = Math.max(1, Math.min(MAX_TARGET_AREA_PX, thresholds?.length ?? MAX_TARGET_AREA_PX));
        const initialTargetAreaPx = Math.max(1, Math.min(maxA, Math.round(targetAreaPx)));
        setTargetAreaPx(initialTargetAreaPx);

        // Compute an initial draft immediately (avoid relying on async state timing).
        computeDraftPolygonFromGrow(initialTargetAreaPx);
      } catch (e) {
        // When restarting quickly (or navigating slices), we may intentionally abort the previous grow.
        if (ac.signal.aborted) return;

        console.error('[TumorSeedGrow] Seed segmentation failed', e);
        setError(e instanceof Error ? e.message : 'Segmentation failed');
      } finally {
        // Only clear busy if we're still the most recent grow.
        const isCurrentGrow = abortRef.current === ac;
        if (isCurrentGrow) abortRef.current = null;
        setBusy((current) => (isCurrentGrow ? false : current));
      }
    },
    [
      SEED_COUNT,
      computeDraftPolygonFromGrow,
      debugEnabled,
      grow2dTuning,
      seriesUid,
      viewerRef,
      setTargetAreaPx,
      targetAreaPx,
    ],
  );

  // Keep a ref so slice-change auto-start can call the latest startGrow without pulling its deps.
  useEffect(() => {
    startGrowRef.current = startGrow;
  }, [startGrow]);

  const recomputeGrowFromCurrent = useCallback(async () => {
    const cap = capturedRef.current;
    const anchor = draftSeedRef.current;

    if (!cap || !anchor) return;

    setError(null);
    setBusy(true);

    // Abort any in-flight grow and replace its controller.
    abortRef.current?.abort();
    const ac = new AbortController();
    abortRef.current = ac;

    try {
      const imageAnchor = viewerPointToImagePoint(anchor, cap.viewportSize, cap.imageSize, cap.viewTransform);
      const seedPx = { x: imageAnchor.x * (cap.w - 1), y: imageAnchor.y * (cap.h - 1) };

      const grow = await computeCostDistanceMap({
        gray: cap.gray,
        w: cap.w,
        h: cap.h,
        seedPx,
        seedCount: SEED_COUNT,
        tuning: { ...grow2dTuning, baseStepScale: LOCKED_BASE_STEP_SCALE },
        yieldEvery: 20000,
        yieldToUi: () => new Promise<void>((resolve) => window.setTimeout(resolve, 0)),
        signal: ac.signal,
      });

      if (ac.signal.aborted) return;

      growRef.current = grow;

      // Precompute area→threshold mapping so the slider stays well-behaved at small sizes.
      areaThresholdsRef.current = (() => {
        const { x0, y0, x1, y1 } = grow.roi;
        const roiW = Math.max(1, x1 - x0 + 1);
        const roiH = Math.max(1, y1 - y0 + 1);

        const tmp = new Float32Array(roiW * roiH);
        let n = 0;

        for (let y = y0; y <= y1; y++) {
          const row = y * grow.w;
          for (let x = x0; x <= x1; x++) {
            const d = grow.dist[row + x] ?? Number.POSITIVE_INFINITY;
            if (!Number.isFinite(d)) continue;
            tmp[n++] = d;
          }
        }

        if (n <= 0) return new Float32Array([0]);

        const finite = tmp.subarray(0, n);
        finite.sort();

        const outN = Math.min(MAX_TARGET_AREA_PX, finite.length);
        return finite.slice(0, outN);
      })();

      const thresholds = areaThresholdsRef.current;
      const maxA = Math.max(1, Math.min(MAX_TARGET_AREA_PX, thresholds?.length ?? MAX_TARGET_AREA_PX));
      const aClamped = Math.max(1, Math.min(maxA, Math.round(targetAreaPx)));
      if (aClamped !== targetAreaPx) setTargetAreaPx(aClamped);

      setGrowVersion((x) => x + 1);

      // Compute an updated draft immediately.
      computeDraftPolygonFromGrow(aClamped);

      if (debugEnabled) {
        console.log('[TumorSeedGrow] grow recomputed', { tuning: grow2dTuning });
      }
    } catch (e) {
      if (ac.signal.aborted) return;
      console.error('[TumorSeedGrow] Recompute failed', e);
      setError(e instanceof Error ? e.message : 'Segmentation failed');
    } finally {
      const isCurrentGrow = abortRef.current === ac;
      if (isCurrentGrow) abortRef.current = null;
      setBusy((current) => (isCurrentGrow ? false : current));
    }
  }, [
    MAX_TARGET_AREA_PX,
    SEED_COUNT,
    computeDraftPolygonFromGrow,
    debugEnabled,
    grow2dTuning,
    setTargetAreaPx,
    targetAreaPx,
  ]);

  const tuningRecomputeTimerRef = useRef<number | null>(null);

  useEffect(() => {
    if (!enabled) return;
    if (!draftSeed) return;
    if (!capturedRef.current) return;

    const cur = growRef.current?.tuning;
    if (!cur) return;

    const diff = (a: number, b: number) => Math.abs(a - b) > 1e-6;

    const changed = diff(cur.surfaceTension, grow2dTuning.surfaceTension);

    if (!changed) return;

    if (tuningRecomputeTimerRef.current !== null) {
      window.clearTimeout(tuningRecomputeTimerRef.current);
    }

    tuningRecomputeTimerRef.current = window.setTimeout(() => {
      tuningRecomputeTimerRef.current = null;
      void recomputeGrowFromCurrent();
    }, 150);

    return () => {
      if (tuningRecomputeTimerRef.current !== null) {
        window.clearTimeout(tuningRecomputeTimerRef.current);
        tuningRecomputeTimerRef.current = null;
      }
    };
  }, [draftSeed, enabled, grow2dTuning, growVersion, recomputeGrowFromCurrent]);

  const consumeSeedBox = useEffectEvent(() => onSeedBoxToStartConsumed?.());

  // Support starting the grow from an external seed box (e.g. via the shared drag-rect overlay).
  useEffect(() => {
    if (!enabled) return;
    const box = seedBoxToStart;
    if (!box) return;

    consumeSeedBox();
    void startGrow({ seedBox: box });
  }, [enabled, seedBoxToStart, startGrow]);

  // When browsing slices, keep tumor mode "live":
  // - If we have a seed (carried from the previous slice) or a saved seed for this slice,
  //   automatically recompute the grow so the user immediately sees a segmentation preview.
  useEffect(() => {
    if (!enabled) {
      autoStartSliceKeyRef.current = null;
      return;
    }

    // Avoid fighting an explicit start request.
    if (seedBoxToStart) return;

    const sliceKey = `${seriesUid}:${effectiveInstanceIndex}`;

    const v = viewerRef.current;
    const start = startGrowRef.current;
    if (!v || !start) return;

    const size = viewSizeRef.current;
    const curView = viewerTransformRef.current;

    const savedSeedForSlice = savedDataSliceKeyRef.current === sliceKey ? savedSeedRef.current : null;
    const savedFrom = savedViewTransformRef.current ?? curView;

    const carriedSeed = draftSeedRef.current;
    const carriedFrom = draftSeedViewTransformRef.current ?? curView;

    const { anchor, source } = (() => {
      if (savedSeedForSlice) {
        const a =
          size.w > 0 && size.h > 0
            ? remapPointBetweenViewerTransforms(savedSeedForSlice, size, savedFrom, curView)
            : savedSeedForSlice;
        return { anchor: a, source: 'saved' as const };
      }
      if (carriedSeed) {
        const a =
          size.w > 0 && size.h > 0
            ? remapPointBetweenViewerTransforms(carriedSeed, size, carriedFrom, curView)
            : carriedSeed;
        return { anchor: a, source: 'carried' as const };
      }
      return { anchor: null, source: null };
    })();

    if (!anchor || !source) return;

    const token = `${sliceKey}:${source}`;
    if (autoStartSliceKeyRef.current === token) return;
    autoStartSliceKeyRef.current = token;

    void (async () => {
      const myToken = token;
      const contentKey = `${studyId}:${seriesUid}:${effectiveInstanceIndex}`;

      try {
        await v.waitForDisplayedContentKey(contentKey, 2500);
      } catch (e) {
        if (debugEnabled) {
          console.warn('[TumorSeedGrow] waitForDisplayedContentKey timed out; capturing anyway', {
            contentKey,
            error: e,
          });
        }
      }

      // If the user scrolled again (or the seed source changed), do not run a stale auto-start.
      if (autoStartSliceKeyRef.current !== myToken) return;

      const ax = clamp01(anchor.x);
      const ay = clamp01(anchor.y);
      await start({ seedBox: { x0: ax, y0: ay, x1: ax, y1: ay } });
    })();
  }, [
    debugEnabled,
    draftSeed,
    effectiveInstanceIndex,
    enabled,
    savedSeed,
    seedBoxToStart,
    seriesUid,
    studyId,
    viewerRef,
  ]);

  const seedBoxPath = useMemo(() => {
    // Depend on capture/grow versions so we recompute when the underlying refs update.
    const _version = captureVersion + growVersion;
    void _version;

    const cap = capturedRef.current;
    const grow = growRef.current;
    if (!draftSeed || !cap || !grow) return '';

    const w = Math.max(1, grow.w - 1);
    const h = Math.max(1, grow.h - 1);

    // Seed sampling box (in capture coords) remapped to the current viewer transform.
    const corners: NormalizedPoint[] = [
      { x: grow.seedBox.x0 / w, y: grow.seedBox.y0 / h },
      { x: grow.seedBox.x1 / w, y: grow.seedBox.y0 / h },
      { x: grow.seedBox.x1 / w, y: grow.seedBox.y1 / h },
      { x: grow.seedBox.x0 / w, y: grow.seedBox.y1 / h },
    ].map((p) => imagePointToViewerPoint(p, viewSize, cap.imageSize, viewerTransform));

    return pointsToSvgPath(corners);
  }, [captureVersion, draftSeed, growVersion, viewSize, viewerTransform]);

  const seedClusterDisplay = useMemo(() => {
    // Depend on capture/grow versions so we recompute when the underlying refs update.
    const _version = captureVersion + growVersion;
    void _version;

    const cap = capturedRef.current;
    const grow = growRef.current;
    if (!draftSeed || !cap || !grow) return null;

    const w = Math.max(1, grow.w - 1);
    const h = Math.max(1, grow.h - 1);

    const pts = grow.seedPxs.map((sp) => ({ x: sp.x / w, y: sp.y / h }));
    return pts.map((p) => imagePointToViewerPoint(p, viewSize, cap.imageSize, viewerTransform));
  }, [captureVersion, draftSeed, growVersion, viewSize, viewerTransform]);

  const draftPolygonDisplay = useMemo(() => {
    if (!draftPolygon) return null;
    if (viewSize.w <= 0 || viewSize.h <= 0) return draftPolygon;

    const from = draftPolygonViewTransform ?? viewerTransform;
    return remapPolygonBetweenViewerTransforms(draftPolygon, viewSize, from, viewerTransform);
  }, [draftPolygon, draftPolygonViewTransform, viewSize, viewerTransform]);

  const savedPolygonDisplay = useMemo(() => {
    if (!savedPolygon) return null;
    if (viewSize.w <= 0 || viewSize.h <= 0) return savedPolygon;

    if (savedImageSize) {
      return imagePolygonToViewerPolygon(savedPolygon, viewSize, savedImageSize, viewerTransform);
    }

    const from = savedPolygonViewTransform ?? viewerTransform;
    return remapPolygonBetweenViewerTransforms(savedPolygon, viewSize, from, viewerTransform);
  }, [savedImageSize, savedPolygon, savedPolygonViewTransform, viewSize, viewerTransform]);

  const groundTruthPolygonDisplay = useMemo(() => {
    if (!groundTruthPolygon) return null;
    if (viewSize.w <= 0 || viewSize.h <= 0) return groundTruthPolygon;

    if (groundTruthImageSize) {
      return imagePolygonToViewerPolygon(groundTruthPolygon, viewSize, groundTruthImageSize, viewerTransform);
    }

    const from = groundTruthPolygonViewTransform ?? viewerTransform;
    return remapPolygonBetweenViewerTransforms(groundTruthPolygon, viewSize, from, viewerTransform);
  }, [groundTruthImageSize, groundTruthPolygon, groundTruthPolygonViewTransform, viewSize, viewerTransform]);

  const draftPath = useMemo(
    () => (draftPolygonDisplay ? polygonToSvgPath(draftPolygonDisplay) : ''),
    [draftPolygonDisplay],
  );
  const savedPath = useMemo(
    () => (savedPolygonDisplay ? polygonToSvgPath(savedPolygonDisplay) : ''),
    [savedPolygonDisplay],
  );
  const groundTruthPath = useMemo(
    () => (groundTruthPolygonDisplay ? polygonToSvgPath(groundTruthPolygonDisplay) : ''),
    [groundTruthPolygonDisplay],
  );

  const AUTO_SAVE_DEBOUNCE_MS = 350;
  const autoSaveTimerRef = useRef<number | null>(null);
  const autoSaveInFlightRef = useRef(false);
  const mountedRef = useRef(true);

  type AutoSaveContext = {
    enabled: boolean;
    busy: boolean;
    comboId: string;
    dateIso: string;
    studyId: string;
    seriesUid: string;
    effectiveInstanceIndex: number;
    sopInstanceUid: string | null;
    viewSize: { w: number; h: number };
    draftSeed: NormalizedPoint | null;
    draftPolygon: TumorPolygon | null;
    draftPolygonViewTransform: ViewerTransform | null;
    draftAreaPx: number | null;
    targetAreaPx: number;
  };

  type AutoSaveSnapshot = {
    context: AutoSaveContext;
    grow: CostDistanceGrow2dResult;
    capture: Capture;
    generation: number;
  };

  const pendingAutoSaveRef = useRef<AutoSaveSnapshot | null>(null);
  const queuedAutoSavesRef = useRef<AutoSaveSnapshot[]>([]);

  const autoSaveCtxRef = useRef<AutoSaveContext>({
    enabled,
    busy,
    comboId,
    dateIso,
    studyId,
    seriesUid,
    effectiveInstanceIndex,
    sopInstanceUid,
    viewSize,
    draftSeed,
    draftPolygon,
    draftPolygonViewTransform,
    draftAreaPx,
    targetAreaPx,
  });

  useEffect(() => {
    autoSaveCtxRef.current = {
      enabled,
      busy,
      comboId,
      dateIso,
      studyId,
      seriesUid,
      effectiveInstanceIndex,
      sopInstanceUid,
      viewSize,
      draftSeed,
      draftPolygon,
      draftPolygonViewTransform,
      draftAreaPx,
      targetAreaPx,
    };
  }, [
    enabled,
    busy,
    comboId,
    dateIso,
    studyId,
    seriesUid,
    effectiveInstanceIndex,
    sopInstanceUid,
    viewSize,
    draftSeed,
    draftPolygon,
    draftPolygonViewTransform,
    draftAreaPx,
    targetAreaPx,
  ]);

  const flushAutoSave = useCallback(
    (snapshot: AutoSaveSnapshot) => {
      if (autoSaveInFlightRef.current) {
        const queuedIndex = queuedAutoSavesRef.current.findIndex(
          ({ context }) =>
            context.comboId === snapshot.context.comboId &&
            context.dateIso === snapshot.context.dateIso &&
            context.studyId === snapshot.context.studyId &&
            context.seriesUid === snapshot.context.seriesUid &&
            context.effectiveInstanceIndex === snapshot.context.effectiveInstanceIndex,
        );
        if (queuedIndex < 0) queuedAutoSavesRef.current.push(snapshot);
        else queuedAutoSavesRef.current[queuedIndex] = snapshot;
        return;
      }

      const ctx = snapshot.context;
      if (!ctx.enabled) return;
      if (ctx.busy) return;

      const grow = snapshot.grow;
      const cap = snapshot.capture;
      const polygon = ctx.draftPolygon;
      const seed = ctx.draftSeed;
      if (!polygon || !seed) return;

      const isCurrentSnapshot = () => {
        const current = autoSaveCtxRef.current;
        return (
          mountedRef.current &&
          current.enabled &&
          sliceGenerationRef.current === snapshot.generation &&
          current.comboId === ctx.comboId &&
          current.dateIso === ctx.dateIso &&
          current.studyId === ctx.studyId &&
          current.seriesUid === ctx.seriesUid &&
          current.effectiveInstanceIndex === ctx.effectiveInstanceIndex
        );
      };

      autoSaveInFlightRef.current = true;
      if (isCurrentSnapshot()) setSaving(true);

      void (async () => {
        try {
          const sop =
            ctx.sopInstanceUid ?? (await getSopInstanceUidForInstanceIndex(ctx.seriesUid, ctx.effectiveInstanceIndex));

          const view =
            ctx.draftPolygonViewTransform ??
            cap.viewTransform ??
            ({ ...viewerTransformRef.current } as ViewerTransform);

          const viewportSize =
            ctx.viewSize.w > 0 && ctx.viewSize.h > 0
              ? { w: Math.round(ctx.viewSize.w), h: Math.round(ctx.viewSize.h) }
              : undefined;

          // Keep threshold field conservative: store the seed-tumor intensity anchor.
          const clamp8 = (v: number) => Math.max(0, Math.min(255, Math.round(v)));
          const anchor = clamp8(grow.stats.tumor.mu);
          const threshold: TumorThreshold = { low: anchor, high: anchor, anchor, tolerance: 0 };

          const grow2d = toGrow2dMeta({
            grow,
            targetAreaPx: ctx.targetAreaPx,
            maxTargetAreaPx: MAX_TARGET_AREA_PX,
          });

          const canonicalPolygon = viewerPolygonToImagePolygon(polygon, ctx.viewSize, cap.imageSize, view);
          const canonicalSeed = viewerPointToImagePoint(seed, ctx.viewSize, cap.imageSize, view);

          await saveTumorSegmentation({
            comboId: ctx.comboId,
            dateIso: ctx.dateIso,
            studyId: ctx.studyId,
            seriesUid: ctx.seriesUid,
            sopInstanceUid: sop,
            polygon: canonicalPolygon,
            threshold,
            seed: canonicalSeed,
            meta: {
              areaPx: ctx.draftAreaPx ?? undefined,
              coordinateSpace: 'image-normalized',
              imageSize: cap.imageSize,
              viewTransform: view,
              viewportSize,
              grow2d,
            },
            algorithmVersion: 'v12-seedbox-areacap10000-costgrow2d-directional-v6-tensionq-step15',
          });

          if (!isCurrentSnapshot()) return;
          updatePersistedAnnotations({
            sopInstanceUid: sop,
            savedPolygon: canonicalPolygon,
            savedImageSize: cap.imageSize,
            savedPolygonViewTransform: view,
            savedSeed: seed,
            savedGrow2d: grow2d,
          });
        } catch (err) {
          if (!isCurrentSnapshot()) return;
          console.error(err);
          setError(err instanceof Error ? err.message : 'Save failed');
        }
      })().finally(() => {
        autoSaveInFlightRef.current = false;
        if (isCurrentSnapshot()) setSaving(false);

        const next = queuedAutoSavesRef.current.shift();
        if (next) window.setTimeout(() => flushAutoSave(next), 0);
      });
    },
    [MAX_TARGET_AREA_PX],
  );

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    return () => {
      const pending = pendingAutoSaveRef.current;
      if (!pending) return;
      pendingAutoSaveRef.current = null;
      if (autoSaveTimerRef.current !== null) {
        window.clearTimeout(autoSaveTimerRef.current);
        autoSaveTimerRef.current = null;
      }
      flushAutoSave(pending);
    };
  }, [comboId, dateIso, effectiveInstanceIndex, enabled, flushAutoSave, seriesUid, studyId]);

  useEffect(() => {
    const ctx = autoSaveCtxRef.current;
    if (!ctx.enabled) return;
    if (ctx.busy) return;
    if (!ctx.draftSeed || !ctx.draftPolygon) return;
    const grow = growRef.current;
    const capture = capturedRef.current;
    if (!grow || !capture) return;

    const snapshot: AutoSaveSnapshot = {
      context: {
        ...ctx,
        viewSize: { ...ctx.viewSize },
        draftSeed: { ...ctx.draftSeed },
        draftPolygon: { points: ctx.draftPolygon.points.map((point) => ({ ...point })) },
        draftPolygonViewTransform: ctx.draftPolygonViewTransform ? { ...ctx.draftPolygonViewTransform } : null,
      },
      grow,
      capture: {
        ...capture,
        viewTransform: { ...capture.viewTransform },
        viewportSize: { ...capture.viewportSize },
        imageSize: { ...capture.imageSize },
      },
      generation: sliceGenerationRef.current,
    };
    pendingAutoSaveRef.current = snapshot;

    if (autoSaveTimerRef.current !== null) {
      window.clearTimeout(autoSaveTimerRef.current);
    }

    autoSaveTimerRef.current = window.setTimeout(() => {
      autoSaveTimerRef.current = null;
      if (pendingAutoSaveRef.current !== snapshot) return;
      pendingAutoSaveRef.current = null;
      flushAutoSave(snapshot);
    }, AUTO_SAVE_DEBOUNCE_MS);

    return () => {
      if (autoSaveTimerRef.current !== null) {
        window.clearTimeout(autoSaveTimerRef.current);
        autoSaveTimerRef.current = null;
      }
    };
  }, [draftAreaPx, draftPolygon, draftSeed, enabled, flushAutoSave, targetAreaPx, busy]);

  return {
    containerRef,
    containerSize,
    grow2dTuning,
    setGrow2dTuning,
    targetAreaPx,
    setTargetAreaPx,
    pixelAreaMm2,
    saving,
    draftAreaPx,
    busy,
    error,
    draftSeed,
    debugEnabled,
    seedBoxPath,
    seedClusterDisplay,
    groundTruthPath,
    savedPath,
    draftPath,
    maxTargetAreaPx: MAX_TARGET_AREA_PX,
  };
}

export function TumorSegmentationOverlay(props: TumorSegmentationOverlayProps) {
  const {
    containerRef,
    containerSize,
    grow2dTuning,
    setGrow2dTuning,
    targetAreaPx,
    setTargetAreaPx,
    pixelAreaMm2,
    saving,
    draftAreaPx,
    busy,
    error,
    draftSeed,
    debugEnabled,
    seedBoxPath,
    seedClusterDisplay,
    groundTruthPath,
    savedPath,
    draftPath,
    maxTargetAreaPx: MAX_TARGET_AREA_PX,
  } = useTumorSegmentationEditor(props);

  if (!props.enabled) return null;
  const { onRequestClose } = props;

  const panel = (() => {
    if (containerSize.w <= 0 || containerSize.h <= 0) return null;

    const sliderHeight = 200;

    const aClamped = Math.max(1, Math.min(MAX_TARGET_AREA_PX, Math.round(targetAreaPx)));

    return (
      <div
        className="absolute z-20 flex items-end justify-center gap-0 pointer-events-auto"
        style={{ right: 8, top: '50%', transform: 'translateY(-50%)' }}
        data-tumor-ui="true"
      >
        {/* tension */}
        <div
          className="flex flex-col items-center gap-1 select-none"
          title="Surface tension: discourages thin peninsulas/leaks near strong edges"
        >
          <div className="whitespace-nowrap rounded-[4px] border border-[var(--border-color)] bg-[var(--bg-secondary)] px-1.5 py-0.5 text-xs tabular-nums text-[var(--text-primary)]">
            tension {grow2dTuning.surfaceTension.toFixed(2)}
          </div>
          <div className="relative flex items-center justify-center" style={{ width: 18, height: sliderHeight }}>
            <input
              type="range"
              min={0}
              max={10}
              step={0.05}
              value={grow2dTuning.surfaceTension}
              onChange={(e) =>
                setGrow2dTuning((t) => ({
                  ...t,
                  surfaceTension: parseFloat(e.target.value),
                }))
              }
              className="tumor-vert-slider absolute"
              style={{
                width: sliderHeight,
                left: '50%',
                top: '50%',
                transform: 'translate(-50%, -50%) rotate(-90deg)',
                transformOrigin: 'center',
              }}
              aria-label="Surface tension"
            />
          </div>
        </div>

        {/* capPx */}
        <div
          className="flex flex-col items-center gap-1 select-none"
          title={`Target area: ${aClamped} pixels${pixelAreaMm2 !== null ? ` (${(aClamped * pixelAreaMm2).toFixed(1)} mm²)` : ''}.${saving ? ' Saving…' : ''}`}
        >
          <div className="whitespace-nowrap rounded-[4px] border border-[var(--border-color)] bg-[var(--bg-secondary)] px-1.5 py-0.5 text-xs tabular-nums text-[var(--text-primary)]">
            capPx {aClamped}
          </div>
          <div className="relative flex items-center justify-center" style={{ width: 18, height: sliderHeight }}>
            <input
              type="range"
              min={1}
              max={MAX_TARGET_AREA_PX}
              step={1}
              value={targetAreaPx}
              onChange={(e) => setTargetAreaPx(parseInt(e.target.value, 10))}
              className="tumor-vert-slider absolute"
              style={{
                width: sliderHeight,
                left: '50%',
                top: '50%',
                transform: 'translate(-50%, -50%) rotate(-90deg)',
                transformOrigin: 'center',
              }}
              title={`Target ${targetAreaPx} px${draftAreaPx != null ? ` · area ${draftAreaPx} px${pixelAreaMm2 !== null ? ` (${(draftAreaPx * pixelAreaMm2).toFixed(1)} mm²)` : ''}` : ''}${saving ? ' · saving…' : ''}`}
              aria-label="Area cap (px)"
            />
          </div>
        </div>
      </div>
    );
  })();

  return (
    <div ref={containerRef} className="absolute inset-0 pointer-events-none" onContextMenu={(e) => e.preventDefault()}>
      {/* UI chrome */}
      <div className="absolute top-12 left-2 z-20 flex items-center gap-2 pointer-events-auto" data-tumor-ui="true">
        <div className="flex items-center gap-2 rounded-[4px] border border-[var(--border-color)] bg-[var(--bg-secondary)] px-2 py-1 text-xs text-[var(--text-primary)]">
          Tumor
          {draftAreaPx !== null ? (
            <span className="tabular-nums text-[var(--text-secondary)]" aria-label="Segmented area">
              {pixelAreaMm2 !== null
                ? `${(draftAreaPx * pixelAreaMm2).toFixed(1)} mm²`
                : `${draftAreaPx.toLocaleString()} px`}
            </span>
          ) : null}
          {busy ? <span className="text-[var(--text-secondary)]">…</span> : null}
        </div>

        <button
          type="button"
          onClick={onRequestClose}
          aria-label="Close tumor segmentation tool"
          className="inline-flex min-h-9 min-w-9 items-center justify-center rounded-[4px] border border-[var(--border-color)] bg-[var(--bg-secondary)] text-[var(--text-secondary)] transition-colors hover:text-[var(--text-primary)]"
          title="Close tumor tool"
        >
          <X className="w-4 h-4" />
        </button>
      </div>

      {/* Error / status */}
      {error ? (
        <div
          className="absolute bottom-2 left-2 right-2 z-20 rounded-[4px] border-l-2 border-l-[var(--danger)] bg-[var(--bg-secondary)] px-2 py-1 text-xs text-[var(--danger)]"
          data-tumor-ui="true"
        >
          {error}
        </div>
      ) : !draftSeed ? (
        <div
          className="absolute bottom-2 left-2 right-2 z-20 rounded-[4px] border border-[var(--border-color)] bg-[var(--bg-secondary)] px-2 py-1 text-xs text-[var(--text-secondary)]"
          data-tumor-ui="true"
        >
          Drag a rectangle on the image, then click Segment. Drag the slider to grow/shrink.
        </div>
      ) : null}

      {panel}

      {/* Seed sampling box + markers */}
      {debugEnabled && seedBoxPath ? (
        <svg className="absolute inset-0 pointer-events-none" viewBox="0 0 1 1" preserveAspectRatio="none" aria-hidden>
          <path
            d={seedBoxPath}
            fill="rgba(236, 72, 153, 0.03)"
            stroke="rgba(236, 72, 153, 0.35)"
            strokeWidth={2}
            vectorEffect="non-scaling-stroke"
            strokeDasharray="6 4"
          />
        </svg>
      ) : null}
      {seedClusterDisplay && seedClusterDisplay.length > 0 ? (
        <svg className="absolute inset-0 pointer-events-none" viewBox="0 0 1 1" preserveAspectRatio="none" aria-hidden>
          {seedClusterDisplay.map((p, i) => (
            <circle key={i} cx={p.x} cy={p.y} r={0.006} fill="rgba(236, 72, 153, 0.45)" />
          ))}
        </svg>
      ) : null}

      {/* Ground truth polygon */}
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
