import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { AlignmentReference, ExclusionMask, SequenceCombo, SeriesRef } from '../types/api';
import { formatDate } from '../utils/format';
import { usePersistedState } from '../hooks/usePersistedState';
import {
  Brain,
  Layers,
  LayoutGrid,
  Play,
  Pause,
  Upload,
  Download,
  Trash2,
  MoreVertical,
  HelpCircle,
  Box,
} from 'lucide-react';
import { HelpModal } from './HelpModal';
import { UploadModal } from './UploadModal';
import { ExportModal } from './ExportModal';
import { ClearDataModal } from './ClearDataModal';
import { SliceLoopNavigator } from './comparison/SliceLoopNavigator';
import { GridView } from './comparison/GridView';
import { OverlayView } from './comparison/OverlayView';
import { ComparisonFiltersSidebar } from './comparison/ComparisonFiltersSidebar';
import { ComparisonDatesSidebar } from './comparison/ComparisonDatesSidebar';
import { useComparisonData } from '../hooks/useComparisonData';
import { useComparisonFilters } from '../hooks/useComparisonFilters';
import { usePanelSettings } from '../hooks/usePanelSettings';
import { useOverlayNavigation } from '../hooks/useOverlayNavigation';
import { useGridLayout } from '../hooks/useGridLayout';
import { useAutoAlign } from '../hooks/useAutoAlign';
import { useApplyAlignmentResults } from '../hooks/useApplyAlignmentResults';
import { useGlobalSliceWheelNavigation } from '../hooks/useGlobalSliceWheelNavigation';
import { formatSequenceLabel } from '../utils/clinicalData';
import { DEFAULT_PANEL_SETTINGS, OVERLAY } from '../utils/constants';
import { getEffectiveInstanceIndex, getSliceIndex } from '../utils/math';
import { COMPARISON_UI_STORAGE_KEY } from '../utils/storageKeys';
import { clearDerivedAlignmentFrames, hydrateDerivedAlignmentFrames } from '../utils/derivedAlignmentFrame';
import { isOutputGridMode, type OutputGridMode } from '../utils/outputPlaneGrid';

const Svr3DView = lazy(() => import('./Svr3DView').then((module) => ({ default: module.Svr3DView })));

function getOverlayViewerSize(gridSize: { width: number; height: number }) {
  // Fill available space while leaving room for the top strip.
  const maxSize = Math.min(Math.max(0, gridSize.width - 48), Math.max(0, gridSize.height - 120));
  return Math.max(300, maxSize);
}

type PersistedComparisonUiState = {
  sidebarOpen: boolean;
  rightSidebarOpen: boolean;
  alignmentOutputMode: OutputGridMode;
};

const DEFAULT_COMPARISON_UI_STATE: PersistedComparisonUiState = {
  sidebarOpen: true,
  rightSidebarOpen: true,
  alignmentOutputMode: 'native',
};

function validateComparisonUiState(raw: unknown): PersistedComparisonUiState | null {
  if (!raw || typeof raw !== 'object') return null;
  const obj = raw as Record<string, unknown>;
  return {
    sidebarOpen: typeof obj.sidebarOpen === 'boolean' ? obj.sidebarOpen : DEFAULT_COMPARISON_UI_STATE.sidebarOpen,
    rightSidebarOpen:
      typeof obj.rightSidebarOpen === 'boolean' ? obj.rightSidebarOpen : DEFAULT_COMPARISON_UI_STATE.rightSidebarOpen,
    alignmentOutputMode: isOutputGridMode(obj.alignmentOutputMode)
      ? obj.alignmentOutputMode
      : DEFAULT_COMPARISON_UI_STATE.alignmentOutputMode,
  };
}

export function ComparisonMatrix() {
  const { data, loading, error, reload, selectPatient } = useComparisonData();
  const {
    availablePlanes,
    selectedPlane,
    selectedSeqId,
    enabledDates,
    enabledDatesKey,
    sortedDates,
    selectPlane,
    selectSequence,
    selectAllDates,
    selectNoDates,
    toggleDate,
  } = useComparisonFilters(data);

  const [uiState, setUiState] = usePersistedState(
    COMPARISON_UI_STORAGE_KEY,
    DEFAULT_COMPARISON_UI_STATE,
    validateComparisonUiState,
  );
  const { sidebarOpen, rightSidebarOpen, alignmentOutputMode } = uiState;
  const setSidebarOpen = useCallback(
    (v: boolean | ((prev: boolean) => boolean)) =>
      setUiState({
        ...uiState,
        sidebarOpen: typeof v === 'function' ? v(uiState.sidebarOpen) : v,
      }),
    [setUiState, uiState],
  );
  const setRightSidebarOpen = useCallback(
    (v: boolean | ((prev: boolean) => boolean)) =>
      setUiState({
        ...uiState,
        rightSidebarOpen: typeof v === 'function' ? v(uiState.rightSidebarOpen) : v,
      }),
    [setUiState, uiState],
  );

  const [helpOpen, setHelpOpen] = useState(false);
  const [uploadModalOpen, setUploadModalOpen] = useState(false);
  const [exportModalOpen, setExportModalOpen] = useState(false);
  const [clearDataModalOpen, setClearDataModalOpen] = useState(false);

  const [headerMenuOpen, setHeaderMenuOpen] = useState(false);
  const headerMenuRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!headerMenuOpen) return;

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setHeaderMenuOpen(false);
      }
    };

    const onPointerDown = (e: MouseEvent) => {
      const el = headerMenuRef.current;
      if (!el) return;
      if (e.target instanceof Node && el.contains(e.target)) return;
      setHeaderMenuOpen(false);
    };

    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('mousedown', onPointerDown);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('mousedown', onPointerDown);
    };
  }, [headerMenuOpen]);

  // Custom hooks
  const {
    panelSettings,
    progress,
    setProgress,
    updatePanelSetting,
    batchUpdateSettings,
    persistenceError,
    clearPersistenceError,
    reportPersistenceError,
  } = usePanelSettings(selectedSeqId, enabledDatesKey);

  // Alignment hooks
  const {
    isAligning,
    progress: alignmentProgress,
    results: alignmentResults,
    error: alignmentError,
    clearState: clearAlignmentState,
    alignAllDates,
    abort: abortAlignment,
  } = useAutoAlign();

  const interactionBlocked = helpOpen || uploadModalOpen || exportModalOpen || clearDataModalOpen || isAligning;

  useApplyAlignmentResults({
    isAligning,
    alignmentResults,
    panelSettings,
    data,
    selectedSeqId,
    batchUpdateSettings,
    onPersistenceError: reportPersistenceError,
  });

  const visibleSequenceSeries = useMemo(
    () =>
      new Set(
        Object.values(selectedSeqId && data ? (data.series_map[selectedSeqId] ?? {}) : {}).map(
          (series) => series.series_uid,
        ),
      ),
    [data, selectedSeqId],
  );

  useEffect(() => {
    clearDerivedAlignmentFrames();
    const patientKey = data?.selected_patient_key;
    const datasetRevision = data?.dataset_revision;
    if (!patientKey || datasetRevision === undefined || !selectedSeqId) return;
    let active = true;
    hydrateDerivedAlignmentFrames(patientKey, datasetRevision, selectedSeqId, visibleSequenceSeries).catch(
      (error: unknown) => {
        if (active) reportPersistenceError(error);
      },
    );
    return () => {
      active = false;
      clearDerivedAlignmentFrames();
    };
  }, [data, reportPersistenceError, selectedSeqId, visibleSequenceSeries]);

  const sequencesForPlane = useMemo(() => {
    if (!data || !selectedPlane) return [] as SequenceCombo[];

    const planeKey = (plane: string | null) => (plane && plane.trim() ? plane : 'Other');

    return data.sequences
      .filter((s) => planeKey(s.plane) === selectedPlane)
      .sort((a, b) => formatSequenceLabel(b).localeCompare(formatSequenceLabel(a))); // reverse alpha
  }, [data, selectedPlane]);

  // Track which sequences have data for the enabled dates
  const sequencesWithDataForDates = useMemo(() => {
    if (!data || enabledDates.size === 0) return new Set<string>();
    const hasData = new Set<string>();
    for (const seq of data.sequences) {
      const seqMap = data.series_map[seq.id] || {};
      for (const date of enabledDates) {
        if (seqMap[date]) {
          hasData.add(seq.id);
          break;
        }
      }
    }
    return hasData;
  }, [data, enabledDates]);

  // Track which dates have data for the selected sequence
  const datesWithDataForSequence = useMemo(() => {
    if (!data || !selectedSeqId) return new Set<string>();
    const seqMap = data.series_map[selectedSeqId] || {};
    return new Set(Object.keys(seqMap));
  }, [data, selectedSeqId]);

  const columns = useMemo(() => {
    if (!data || !selectedSeqId) return [] as { date: string; ref?: SeriesRef }[];
    const map = data.series_map[selectedSeqId] || {};
    // Sort by date descending (newest first) to match sidebar
    const selectedDates = [...enabledDates].sort((a, b) => b.localeCompare(a));
    return selectedDates.map((date) => ({ date, ref: map[date] }));
  }, [data, selectedSeqId, enabledDates]);

  // For overlay mode: columns sorted oldest to newest (earliest left, latest right)
  // Sort by date ascending (oldest first)
  const overlayColumns = useMemo(() => [...columns].reverse().filter((column) => column.ref), [columns]);

  // Hooks for layout and navigation
  const {
    containerRef: gridLayoutContainerRef,
    cols: gridCols,
    cellSize: gridCellSize,
    gridSize,
  } = useGridLayout(columns.length);

  // `useGridLayout` returns a callback ref, but we also need the actual DOM node
  // for wheel + hover logic.
  const centerPaneRef = useRef<HTMLDivElement | null>(null);
  const setCenterPaneRef = useCallback(
    (node: HTMLDivElement | null) => {
      centerPaneRef.current = node;
      gridLayoutContainerRef(node);
    },
    [gridLayoutContainerRef],
  );
  const {
    viewMode,
    setViewMode,
    overlayDateIndex,
    setOverlayDateIndex,
    compareTargetIndex,
    displayedOverlayIndex,
    isPlaying,
    setIsPlaying,
    playSpeed,
    setPlaySpeed,
  } = useOverlayNavigation(overlayColumns, { interactionBlocked });

  const positionAt = (index: number) => {
    const col = overlayColumns[index];
    const ref = col?.ref;
    const date = col?.date;
    const settings = date ? panelSettings.get(date) || DEFAULT_PANEL_SETTINGS : DEFAULT_PANEL_SETTINGS;
    const sliceIndex = ref ? getSliceIndex(ref.instance_count, progress, settings.offset) : 0;
    const effectiveSliceIndex = ref
      ? getEffectiveInstanceIndex(sliceIndex, ref.instance_count, settings.reverseSliceOrder)
      : 0;
    return { ref, date, settings, sliceIndex, effectiveSliceIndex };
  };

  const displayed = positionAt(displayedOverlayIndex);
  const selected = positionAt(overlayDateIndex);
  const compare = positionAt(compareTargetIndex);

  const {
    ref: overlayDisplayedRef,
    date: overlayDisplayedDate,
    settings: overlayDisplayedSettings,
    sliceIndex: overlayDisplayedSliceIndex,
    effectiveSliceIndex: overlayDisplayedEffectiveSliceIndex,
  } = displayed;
  const {
    ref: overlaySelectedRef,
    date: overlaySelectedDate,
    settings: overlaySelectedSettings,
    sliceIndex: overlaySelectedSliceIndex,
  } = selected;
  const {
    ref: overlayCompareRef,
    date: overlayCompareDate,
    settings: overlayCompareSettings,
    sliceIndex: overlayCompareSliceIndex,
  } = compare;

  const isOverlayComparing = displayedOverlayIndex !== overlayDateIndex;
  const hasOverlayCompareTarget = overlayColumns.length > 1 && compareTargetIndex !== overlayDateIndex;

  const overlayViewerSize = getOverlayViewerSize(gridSize);

  // Seed SVR 3D ROI preview slice:
  // - Prefer the currently displayed overlay slice when available.
  // - Otherwise fall back to the newest enabled date in the grid.
  const svr3dSeed = useMemo(() => {
    if (overlayDisplayedDate && overlayDisplayedRef) {
      return {
        defaultDateIso: overlayDisplayedDate,
        fallbackRoiSeriesUid: overlayDisplayedRef.series_uid,
        fallbackRoiSliceIndex: overlayDisplayedEffectiveSliceIndex,
      };
    }

    const first = columns.find((c) => c.ref);
    if (!first?.ref) {
      return {
        defaultDateIso: null,
        fallbackRoiSeriesUid: null,
        fallbackRoiSliceIndex: null,
      };
    }

    const settings = panelSettings.get(first.date) || DEFAULT_PANEL_SETTINGS;
    const sliceIndex = getSliceIndex(first.ref.instance_count, progress, settings.offset);
    const effectiveIndex = getEffectiveInstanceIndex(sliceIndex, first.ref.instance_count, settings.reverseSliceOrder);

    return {
      defaultDateIso: first.date,
      fallbackRoiSeriesUid: first.ref.series_uid,
      fallbackRoiSliceIndex: effectiveIndex,
    };
  }, [
    columns,
    overlayDisplayedDate,
    overlayDisplayedEffectiveSliceIndex,
    overlayDisplayedRef,
    panelSettings,
    progress,
  ]);

  const startAlignAll = useCallback(
    async (reference: AlignmentReference, exclusionMask: ExclusionMask) => {
      if (isAligning) {
        abortAlignment();
        return;
      }

      if (!data || !selectedSeqId) return;

      const seriesMap = data.series_map[selectedSeqId] || {};

      // Get all dates except the reference date.
      const targetDates = overlayColumns.filter((col) => col.ref && col.date !== reference.date).map((col) => col.date);
      if (targetDates.length === 0) return;

      try {
        const finalReference: AlignmentReference = {
          ...reference,
          exclusionMask,
          patientKey: data.selected_patient_key ?? reference.patientKey,
          sequenceId: selectedSeqId,
          datasetRevision: data.dataset_revision,
        };
        const results = await alignAllDates(finalReference, targetDates, seriesMap, progress, {
          outputMode: alignmentOutputMode,
        });

        // Results are applied incrementally via an effect so the UI updates per-date.
        const aligned = results.filter((result) => result.outcome === 'aligned');
        if (aligned.length > 0) {
          console.log(
            `[Alignment] Aligned ${aligned.length} of ${results.length} examinations. Average NMI: ${(
              aligned.reduce((sum, result) => sum + result.nmiScore, 0) / aligned.length
            ).toFixed(3)}`,
          );
        }
      } catch (err) {
        console.error('[Alignment] Failed:', err);
      }
    },
    [abortAlignment, alignAllDates, alignmentOutputMode, data, isAligning, overlayColumns, progress, selectedSeqId],
  );

  // Keep a ref of the latest progress so autoplay doesn't restart its effect on every tick.
  const progressRef = useRef(progress);
  useEffect(() => {
    progressRef.current = progress;
  }, [progress]);

  // Global wheel slice navigation (works anywhere in the center pane, not just when hovering an image).
  //
  // Notes:
  // - We intentionally do NOT run this when the wheel event is over a scrollable container
  //   (e.g. the sidebars), so normal scrolling still works.
  // - Individual DicomViewer instances handle wheel events over images (zoom) and call preventDefault.
  //   We skip them here via `e.defaultPrevented`.
  const wheelNavContextRef = useRef<{ instanceCount: number; offset: number } | null>(null);
  useEffect(() => {
    if (viewMode === 'svr3d') {
      // The SVR 3D view uses mousewheel for zoom; don't hijack wheel events for slice navigation.
      wheelNavContextRef.current = null;
      return;
    }

    let instanceCount = 1;
    let offset = DEFAULT_PANEL_SETTINGS.offset;

    if (viewMode === 'overlay' && overlaySelectedRef && overlaySelectedDate) {
      instanceCount = overlaySelectedRef.instance_count;
      offset = overlaySelectedSettings.offset;
    } else {
      const primaryGrid = columns.find((c) => c.ref);
      if (primaryGrid?.ref) {
        instanceCount = primaryGrid.ref.instance_count;
        offset = (panelSettings.get(primaryGrid.date) || DEFAULT_PANEL_SETTINGS).offset;
      } else {
        const anyOverlay = overlayColumns.find((c) => c.ref);
        if (anyOverlay?.ref) {
          instanceCount = anyOverlay.ref.instance_count;
          offset = (panelSettings.get(anyOverlay.date) || DEFAULT_PANEL_SETTINGS).offset;
        }
      }
    }

    wheelNavContextRef.current = instanceCount > 1 ? { instanceCount, offset } : null;
  }, [
    viewMode,
    overlaySelectedRef,
    overlaySelectedDate,
    overlaySelectedSettings.offset,
    columns,
    overlayColumns,
    panelSettings,
  ]);

  const setProgressRef = useRef(setProgress);
  useEffect(() => {
    setProgressRef.current = setProgress;
  }, [setProgress]);

  useGlobalSliceWheelNavigation({
    centerPaneRef,
    contextRef: wheelNavContextRef,
    interactionBlocked,
    progressRef,
    setProgressRef,
  });

  const playbackInstanceCount = useMemo(() => {
    const fromOverlay = overlayColumns[overlayDateIndex]?.ref?.instance_count;
    if (typeof fromOverlay === 'number' && fromOverlay > 1) return fromOverlay;

    const anyOverlay = overlayColumns.find((c) => c.ref)?.ref?.instance_count;
    if (typeof anyOverlay === 'number' && anyOverlay > 1) return anyOverlay;

    const anyGrid = columns.find((c) => c.ref)?.ref?.instance_count;
    if (typeof anyGrid === 'number' && anyGrid > 1) return anyGrid;

    return 1;
  }, [overlayColumns, overlayDateIndex, columns]);

  if (loading) {
    return (
      <div className="h-screen flex items-center justify-center bg-[var(--bg-primary)]">
        <div className="flex flex-col items-center gap-4">
          <Brain className="w-8 h-8 text-[var(--accent)] animate-pulse" />
          <p className="text-[var(--text-secondary)]">Loading comparison data…</p>
        </div>
      </div>
    );
  }

  const hasData = data && selectedPlane && selectedSeqId;

  if (error) {
    return <div className="h-screen flex items-center justify-center text-[var(--text-secondary)]">{error}</div>;
  }

  return (
    <div className="h-screen flex flex-col">
      {/* Help Modal */}
      {helpOpen && <HelpModal onClose={() => setHelpOpen(false)} />}

      {/* Upload Modal */}
      {uploadModalOpen && (
        <UploadModal
          onClose={() => setUploadModalOpen(false)}
          onUploadComplete={() => reload(undefined, { background: true })}
        />
      )}
      {exportModalOpen && <ExportModal onClose={() => setExportModalOpen(false)} />}
      {clearDataModalOpen && (
        <ClearDataModal onClose={() => setClearDataModalOpen(false)} onReset={() => window.location.reload()} />
      )}

      {/* Header */}
      <div className="px-4 py-3 bg-[var(--bg-secondary)] border-b border-[var(--border-color)]">
        <div className="flex flex-wrap items-center gap-3">
          <div className="flex items-center gap-3 shrink-0">
            <Brain className="w-6 h-6 text-[var(--accent)]" />
            <h1 className="text-lg font-semibold">MiraViewer</h1>

            {/* View mode toggle (left side) */}
            {hasData ? (
              <div className="flex items-center bg-[var(--bg-primary)] rounded-lg border border-[var(--border-color)]">
                <button
                  onClick={() => setViewMode('grid')}
                  aria-pressed={viewMode === 'grid'}
                  className={`px-3 py-1.5 text-xs rounded-l-lg transition-colors flex items-center gap-1.5 ${viewMode === 'grid' ? 'bg-[var(--accent)] text-white' : 'text-[var(--text-secondary)] hover:text-[var(--text-primary)]'}`}
                  title="Grid view"
                >
                  <LayoutGrid className="w-3.5 h-3.5" />
                  Grid
                </button>
                <button
                  onClick={() => setViewMode('overlay')}
                  aria-pressed={viewMode === 'overlay'}
                  className={`px-3 py-1.5 text-xs transition-colors flex items-center gap-1.5 ${viewMode === 'overlay' ? 'bg-[var(--accent)] text-white' : 'text-[var(--text-secondary)] hover:text-[var(--text-primary)]'}`}
                  title="Overlay view - toggle between dates"
                >
                  <Layers className="w-3.5 h-3.5" />
                  Overlay
                </button>
                <button
                  onClick={() => setViewMode('svr3d')}
                  aria-pressed={viewMode === 'svr3d'}
                  className={`px-3 py-1.5 text-xs rounded-r-lg transition-colors flex items-center gap-1.5 ${viewMode === 'svr3d' ? 'bg-[var(--accent)] text-white' : 'text-[var(--text-secondary)] hover:text-[var(--text-primary)]'}`}
                  title="SVR 3D view"
                >
                  <Box className="w-3.5 h-3.5" />
                  3D
                </button>
              </div>
            ) : null}
          </div>

          {(data?.patients?.length ?? 0) > 1 ? (
            <label className="flex min-w-0 items-center gap-2 text-xs text-[var(--text-secondary)]">
              <span className="shrink-0">Patient</span>
              <select
                aria-label="Selected patient"
                value={data?.selected_patient_key ?? ''}
                onChange={(event) => {
                  abortAlignment();
                  clearDerivedAlignmentFrames();
                  clearAlignmentState();
                  void selectPatient(event.target.value);
                }}
                className="max-w-52 rounded-md border border-[var(--border-color)] bg-[var(--bg-primary)] px-2 py-1.5 text-[var(--text-primary)]"
              >
                {data?.patients?.map((patient) => (
                  <option key={patient.key} value={patient.key}>
                    {patient.patient_name || patient.patient_id || 'Unknown patient'}
                  </option>
                ))}
              </select>
            </label>
          ) : (data?.patients?.length ?? 0) === 1 ? (
            <div className="min-w-0 text-xs text-[var(--text-secondary)]" aria-label="Selected patient">
              <span className="mr-2">Patient</span>
              <span className="font-medium text-[var(--text-primary)]">
                {data?.patients?.[0]?.patient_name || data?.patients?.[0]?.patient_id || 'Unknown patient'}
              </span>
            </div>
          ) : null}

          {/* Overlay playback/date controls (inline with header) */}
          <div className="flex items-center gap-4 flex-1 min-w-0">
            {viewMode === 'overlay' && overlayColumns.length > 0 && (
              <>
                <button
                  type="button"
                  onClick={() => setIsPlaying(!isPlaying)}
                  disabled={overlayColumns.length < 2}
                  className={`p-2 rounded-lg transition-colors focus:outline-none ${
                    overlayColumns.length < 2
                      ? 'bg-[var(--bg-primary)] text-[var(--text-tertiary)] cursor-not-allowed'
                      : isPlaying
                        ? 'bg-[var(--accent)] text-white'
                        : 'bg-[var(--bg-primary)] text-[var(--text-secondary)] hover:text-[var(--text-primary)]'
                  }`}
                  title={isPlaying ? 'Pause' : 'Play'}
                  aria-label={isPlaying ? 'Pause comparison playback' : 'Start comparison playback'}
                >
                  {isPlaying ? <Pause className="w-4 h-4" /> : <Play className="w-4 h-4" />}
                </button>

                <div className="flex items-center gap-2 shrink-0">
                  <span className="text-xs text-[var(--text-secondary)]">Speed:</span>
                  <select
                    aria-label="Comparison playback speed"
                    value={playSpeed}
                    onChange={(e) => setPlaySpeed(parseInt(e.target.value, 10))}
                    disabled={overlayColumns.length < 2}
                    className={`px-2 py-1 text-xs bg-[var(--bg-primary)] border border-[var(--border-color)] rounded text-[var(--text-primary)] ${
                      overlayColumns.length < 2 ? 'opacity-50 cursor-not-allowed' : ''
                    }`}
                  >
                    {OVERLAY.PLAY_SPEEDS.map((s) => (
                      <option key={s.value} value={s.value}>
                        {s.label}
                      </option>
                    ))}
                  </select>
                </div>

                <div className="w-px h-6 bg-[var(--border-color)] shrink-0" />

                <div className="flex items-center gap-1 flex-1 overflow-x-auto min-w-0 translate-y-1 pb-1">
                  {overlayColumns.map((col, idx) => (
                    <button
                      key={col.date}
                      type="button"
                      onMouseDown={(e) => e.preventDefault()}
                      onClick={() => {
                        setOverlayDateIndex(idx);
                        setIsPlaying(false);
                      }}
                      aria-current={idx === overlayDateIndex ? 'true' : undefined}
                      className={`px-3 py-1.5 rounded-lg text-sm whitespace-nowrap transition-colors flex items-center gap-2 focus:outline-none ${
                        idx === overlayDateIndex
                          ? 'bg-[var(--accent)] text-white'
                          : 'bg-[var(--bg-primary)] text-[var(--text-secondary)] hover:text-[var(--text-primary)]'
                      }`}
                    >
                      <span className="w-5 h-5 rounded bg-black/20 flex items-center justify-center text-xs font-mono">
                        {idx + 1}
                      </span>
                      {formatDate(col.date)}
                    </button>
                  ))}
                </div>
              </>
            )}
          </div>

          <div className="flex items-center gap-3 shrink-0">
            <button
              type="button"
              onClick={() => {
                setHeaderMenuOpen(false);
                setHelpOpen(true);
              }}
              className="p-2 rounded-lg hover:bg-[var(--bg-tertiary)] text-[var(--text-secondary)] hover:text-[var(--text-primary)]"
              title="Help & shortcuts"
              aria-label="Help and keyboard shortcuts"
            >
              <HelpCircle className="w-5 h-5" />
            </button>

            {/* Header menu (Import/Export/Delete) */}
            <div className="relative" ref={headerMenuRef}>
              <button
                type="button"
                onClick={() => setHeaderMenuOpen((v) => !v)}
                className="p-2 rounded-lg hover:bg-[var(--bg-tertiary)] text-[var(--text-secondary)] hover:text-[var(--text-primary)]"
                title="Menu"
                aria-label="Application menu"
                aria-expanded={headerMenuOpen}
              >
                <MoreVertical className="w-5 h-5" />
              </button>

              {headerMenuOpen && (
                <div className="absolute right-0 mt-2 w-56 rounded-lg border border-[var(--border-color)] bg-[var(--bg-secondary)] shadow-xl overflow-hidden z-50">
                  <button
                    type="button"
                    onClick={() => {
                      setHeaderMenuOpen(false);
                      setUploadModalOpen(true);
                    }}
                    className="w-full px-3 py-2 text-left text-sm flex items-center gap-2 hover:bg-[var(--bg-tertiary)] text-[var(--text-primary)]"
                  >
                    <Upload className="w-4 h-4" />
                    Import scans
                  </button>
                  {hasData ? (
                    <button
                      type="button"
                      onClick={() => {
                        setHeaderMenuOpen(false);
                        setExportModalOpen(true);
                      }}
                      className="w-full px-3 py-2 text-left text-sm flex items-center gap-2 hover:bg-[var(--bg-tertiary)] text-[var(--text-primary)]"
                    >
                      <Download className="w-4 h-4" />
                      Export backup (ZIP)
                    </button>
                  ) : null}
                  {hasData ? (
                    <button
                      type="button"
                      onClick={() => {
                        setHeaderMenuOpen(false);
                        setClearDataModalOpen(true);
                      }}
                      className="w-full px-3 py-2 text-left text-sm flex items-center gap-2 hover:bg-[var(--bg-tertiary)] text-red-400"
                    >
                      <Trash2 className="w-4 h-4" />
                      Delete all local data
                    </button>
                  ) : null}
                </div>
              )}
            </div>
          </div>
        </div>
      </div>

      {/* Main area with sidebar */}
      <div className="flex-1 flex overflow-hidden relative">
        {hasData && viewMode !== 'svr3d' ? (
          <ComparisonFiltersSidebar
            open={sidebarOpen}
            onToggleOpen={() => setSidebarOpen((v) => !v)}
            availablePlanes={availablePlanes}
            selectedPlane={selectedPlane}
            onSelectPlane={selectPlane}
            sequencesForPlane={sequencesForPlane}
            sequencesWithDataForDates={sequencesWithDataForDates}
            selectedSeqId={selectedSeqId}
            onSelectSequence={selectSequence}
            alignmentOutputMode={alignmentOutputMode}
            onAlignmentOutputModeChange={(mode) => setUiState({ ...uiState, alignmentOutputMode: mode })}
            alignmentInProgress={isAligning}
          />
        ) : null}

        {/* Main content area - Grid / Overlay / SVR 3D */}
        <div ref={setCenterPaneRef} className="flex-1 overflow-hidden bg-black flex flex-col relative">
          {persistenceError ? (
            <div
              role="alert"
              className="absolute top-2 left-2 right-2 z-50 flex items-center justify-between gap-3 rounded-lg border border-red-500/30 bg-red-950/90 px-3 py-2 text-sm text-red-100"
            >
              <span>Changes could not be saved: {persistenceError}</span>
              <button
                type="button"
                className="rounded border border-red-500/30 px-2 py-1"
                onClick={clearPersistenceError}
              >
                Dismiss
              </button>
            </div>
          ) : null}
          {alignmentError && !isAligning ? (
            <div
              role="alert"
              className="absolute top-2 left-2 right-2 z-50 flex items-center justify-between gap-3 px-3 py-2 rounded-lg bg-red-950/80 border border-red-500/30 text-red-100 text-sm"
            >
              <div className="min-w-0 truncate">
                <span className="font-medium">Alignment failed:</span> {alignmentError}
              </div>
              <button
                type="button"
                className="shrink-0 px-2 py-1 rounded bg-red-500/20 hover:bg-red-500/30 border border-red-500/30"
                onClick={() => clearAlignmentState()}
              >
                Dismiss
              </button>
            </div>
          ) : null}
          {!isAligning &&
          !alignmentError &&
          alignmentResults.some((result) => result.outcome && result.outcome !== 'aligned') ? (
            <div
              role="status"
              aria-live="polite"
              className="absolute top-2 left-2 right-2 z-40 rounded-lg border border-amber-300/35 bg-amber-950/90 px-3 py-2 text-sm text-amber-50"
            >
              <div className="flex items-start justify-between gap-3">
                <div>
                  <p className="font-medium">Some examinations could not be aligned safely.</p>
                  <ul className="mt-1 space-y-1 text-xs text-amber-100">
                    {alignmentResults
                      .filter((result) => result.outcome && result.outcome !== 'aligned')
                      .map((result) => (
                        <li key={`${result.runId ?? 'alignment'}:${result.date}`}>
                          {formatDate(result.date)}: {result.message ?? result.outcome?.replaceAll('-', ' ')}
                        </li>
                      ))}
                  </ul>
                </div>
                <button
                  type="button"
                  className="shrink-0 rounded border border-amber-300/30 px-2 py-1"
                  onClick={clearAlignmentState}
                >
                  Dismiss
                </button>
              </div>
            </div>
          ) : null}
          {!hasData ? (
            /* Empty state */
            <div className="flex-1 flex flex-col items-center justify-center gap-8 text-center p-8 max-w-2xl mx-auto">
              <div className="p-6 rounded-full bg-[var(--bg-secondary)] border border-[var(--border-color)]">
                <Brain className="w-20 h-20 text-[var(--accent)]" />
              </div>

              <div className="space-y-4">
                <h2 className="text-3xl font-bold text-[var(--text-primary)] tracking-tight">Welcome to MiraViewer</h2>
                <p className="text-lg text-[var(--text-secondary)] leading-relaxed">
                  Import your MRI scans to visualize and compare them over time.
                </p>
                <div className="flex items-center justify-center gap-2 text-sm text-[var(--text-tertiary)] bg-[var(--bg-secondary)] py-2 px-4 rounded-full border border-[var(--border-color)] w-fit mx-auto">
                  <span className="text-emerald-500">🔒</span>
                  <span>Your data is stored locally in your browser and never leaves your device.</span>
                </div>
              </div>

              <div className="flex flex-col gap-3 w-full max-w-sm">
                <button
                  onClick={() => setUploadModalOpen(true)}
                  className="flex items-center justify-center gap-2 px-8 py-3.5 rounded-xl bg-[var(--accent)] text-white font-medium hover:bg-[var(--accent-hover)] transition-all shadow-lg hover:shadow-xl hover:-translate-y-0.5"
                >
                  <Upload className="w-5 h-5" />
                  Import scans
                </button>
              </div>
            </div>
          ) : viewMode === 'grid' ? (
            <GridView
              comboId={selectedSeqId}
              columns={columns}
              gridCols={gridCols}
              gridCellSize={gridCellSize}
              panelSettings={panelSettings}
              progress={progress}
              setProgress={setProgress}
              updatePanelSetting={updatePanelSetting}
              overlayColumns={overlayColumns}
              isAligning={isAligning}
              alignmentProgress={alignmentProgress}
              abortAlignment={abortAlignment}
              startAlignAll={startAlignAll}
            />
          ) : viewMode === 'overlay' ? (
            <OverlayView
              comboId={selectedSeqId}
              overlayColumns={overlayColumns}
              overlayViewerSize={overlayViewerSize}
              overlayDisplayedRef={overlayDisplayedRef}
              overlayDisplayedDate={overlayDisplayedDate}
              overlayDisplayedSettings={overlayDisplayedSettings}
              overlayDisplayedSliceIndex={overlayDisplayedSliceIndex}
              overlayDisplayedEffectiveSliceIndex={overlayDisplayedEffectiveSliceIndex}
              overlaySelectedRef={overlaySelectedRef}
              overlaySelectedDate={overlaySelectedDate}
              overlaySelectedSettings={overlaySelectedSettings}
              overlaySelectedSliceIndex={overlaySelectedSliceIndex}
              overlayCompareRef={overlayCompareRef}
              overlayCompareDate={overlayCompareDate}
              overlayCompareSettings={overlayCompareSettings}
              overlayCompareSliceIndex={overlayCompareSliceIndex}
              isOverlayComparing={isOverlayComparing}
              hasOverlayCompareTarget={hasOverlayCompareTarget}
              isAligning={isAligning}
              alignmentProgress={alignmentProgress}
              abortAlignment={abortAlignment}
              updatePanelSetting={updatePanelSetting}
              startAlignAll={startAlignAll}
              setProgress={setProgress}
            />
          ) : (
            <Suspense
              fallback={
                <div className="flex h-full items-center justify-center text-sm text-[var(--text-secondary)]">
                  Loading 3D reconstruction…
                </div>
              }
            >
              <Svr3DView
                key={data.selected_patient_key ?? 'selected-patient'}
                data={data}
                defaultDateIso={svr3dSeed.defaultDateIso}
                defaultSeqId={selectedSeqId}
                fallbackRoiSeriesUid={svr3dSeed.fallbackRoiSeriesUid}
                fallbackRoiSliceIndex={svr3dSeed.fallbackRoiSliceIndex}
              />
            </Suspense>
          )}
        </div>

        {hasData ? (
          <ComparisonDatesSidebar
            open={rightSidebarOpen}
            onToggleOpen={() => setRightSidebarOpen((v) => !v)}
            sortedDates={sortedDates}
            enabledDates={enabledDates}
            datesWithDataForSequence={datesWithDataForSequence}
            onSelectAllDates={selectAllDates}
            onSelectNoDates={selectNoDates}
            onToggleDate={toggleDate}
          />
        ) : null}
      </div>

      {/* Slice navigator with loop + speed controls */}
      {hasData && viewMode !== 'svr3d' ? (
        <SliceLoopNavigator
          interactionBlocked={interactionBlocked}
          selectedSeqId={selectedSeqId}
          playbackInstanceCount={playbackInstanceCount}
          progress={progress}
          progressRef={progressRef}
          setProgress={setProgress}
        />
      ) : null}
    </div>
  );
}
