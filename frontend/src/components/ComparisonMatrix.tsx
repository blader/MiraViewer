import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { AlignmentReference, ExclusionMask, SequenceCombo, SeriesRef } from '../types/api';
import { formatDate } from '../utils/format';
import { usePersistedState } from '../hooks/usePersistedState';
import { Play, Pause, Upload, Download, Trash2, MoreVertical, HelpCircle } from 'lucide-react';
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
  if (gridSize.width <= 0 || gridSize.height <= 0) return 300;

  // Keep image geometry inside the measured pane, including its external caption rails.
  const maxSize = Math.min(Math.max(0, gridSize.width - 48), Math.max(0, gridSize.height - 120));
  return Math.max(1, maxSize);
}

type PersistedComparisonUiState = {
  sidebarOpen: boolean;
  rightSidebarOpen: boolean;
  alignmentOutputMode: OutputGridMode;
};

const DEFAULT_COMPARISON_UI_STATE: PersistedComparisonUiState = {
  sidebarOpen: true,
  rightSidebarOpen: false,
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
    (value: boolean | ((previous: boolean) => boolean)) => {
      const nextOpen = typeof value === 'function' ? value(uiState.sidebarOpen) : value;
      setUiState({
        ...uiState,
        sidebarOpen: nextOpen,
        rightSidebarOpen: nextOpen && window.innerWidth < 1440 ? false : uiState.rightSidebarOpen,
      });
    },
    [setUiState, uiState],
  );
  const setRightSidebarOpen = useCallback(
    (value: boolean | ((previous: boolean) => boolean)) => {
      const nextOpen = typeof value === 'function' ? value(uiState.rightSidebarOpen) : value;
      setUiState({
        ...uiState,
        sidebarOpen: nextOpen && window.innerWidth < 1440 ? false : uiState.sidebarOpen,
        rightSidebarOpen: nextOpen,
      });
    },
    [setUiState, uiState],
  );
  const compactNavigationInitialized = useRef(false);

  useEffect(() => {
    const closeCompactNavigation = () => {
      if (window.innerWidth > 760 || (!uiState.sidebarOpen && !uiState.rightSidebarOpen)) return;
      setUiState({ ...uiState, sidebarOpen: false, rightSidebarOpen: false });
    };

    if (!compactNavigationInitialized.current) {
      compactNavigationInitialized.current = true;
      closeCompactNavigation();
    }

    window.addEventListener('resize', closeCompactNavigation);
    return () => window.removeEventListener('resize', closeCompactNavigation);
  }, [setUiState, uiState]);

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

  const {
    isAligning,
    progress: alignmentProgress,
    results: alignmentResults,
    error: alignmentError,
    clearState: clearAlignmentState,
    alignAllDates,
    abort: abortAlignment,
  } = useAutoAlign();

  const {
    panelSettings,
    progress,
    setProgress,
    updatePanelSetting,
    batchUpdateSettings,
    persistenceError,
    clearPersistenceError,
    reportPersistenceError,
  } = usePanelSettings(selectedSeqId, enabledDatesKey, data?.selected_patient_key ?? null, isAligning);

  const interactionBlocked = helpOpen || uploadModalOpen || exportModalOpen || clearDataModalOpen || isAligning;

  useEffect(() => {
    if (interactionBlocked || headerMenuOpen || (!sidebarOpen && !rightSidebarOpen)) return;

    const closeDrawerOnEscape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || window.innerWidth >= 1440) return;
      const closeFilters = sidebarOpen && window.innerWidth <= 1024;
      if (!closeFilters && !rightSidebarOpen) return;
      setUiState({
        ...uiState,
        sidebarOpen: closeFilters ? false : sidebarOpen,
        rightSidebarOpen: false,
      });
    };

    window.addEventListener('keydown', closeDrawerOnEscape);
    return () => window.removeEventListener('keydown', closeDrawerOnEscape);
  }, [headerMenuOpen, interactionBlocked, rightSidebarOpen, setUiState, sidebarOpen, uiState]);

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
    if (!data || !selectedSeqId) return [] as { date: string; ref: SeriesRef }[];
    const map = data.series_map[selectedSeqId] || {};
    // Sort by date descending (newest first) to match sidebar
    const selectedDates = [...enabledDates].sort((a, b) => b.localeCompare(a));
    return selectedDates.flatMap((date) => {
      const ref = map[date];
      return ref ? [{ date, ref }] : [];
    });
  }, [data, selectedSeqId, enabledDates]);

  // For overlay mode: columns sorted oldest to newest (earliest left, latest right)
  // Sort by date ascending (oldest first)
  const overlayColumns = useMemo(() => [...columns].reverse(), [columns]);

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
      <div className="instrument-shell instrument-loading" role="status" aria-live="polite">
        <div className="instrument-loading-inner">
          <p className="instrument-eyebrow">MiraViewer</p>
          <p>Loading saved scans…</p>
        </div>
      </div>
    );
  }

  const hasData = data && selectedPlane && selectedSeqId;

  if (error) {
    return (
      <div className="instrument-shell instrument-loading" role="alert">
        <div className="instrument-loading-inner">{error}</div>
      </div>
    );
  }

  const selectedSequence = data?.sequences.find((sequence) => sequence.id === selectedSeqId);
  const activeExaminationDate = overlayDisplayedDate ?? columns.find((column) => column.ref)?.date ?? null;
  const showStudyFilmstrip = viewMode === 'overlay' || viewMode === 'svr3d';
  const unsuccessfulAlignmentResults =
    !isAligning && !alignmentError
      ? alignmentResults.filter((result) => result.outcome && result.outcome !== 'aligned')
      : [];
  const hasInstrumentNotices = Boolean(
    persistenceError || (alignmentError && !isAligning) || unsuccessfulAlignmentResults.length > 0,
  );

  return (
    <div className="instrument-shell flex flex-col">
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

      <header className="instrument-header">
        <div className="instrument-identity-rail">
          <h1 className="instrument-wordmark">
            Mira<span>Viewer</span>
          </h1>

          {hasData ? (
            <nav className="instrument-mode-nav" aria-label="Viewing mode">
              <button
                type="button"
                disabled={isAligning}
                onClick={() => setViewMode('grid')}
                aria-pressed={viewMode === 'grid'}
                className="instrument-mode-tab"
                title="Grid view"
              >
                Compare
              </button>
              <button
                type="button"
                disabled={isAligning}
                onClick={() => setViewMode('overlay')}
                aria-pressed={viewMode === 'overlay'}
                className="instrument-mode-tab"
                title="Overlay view - toggle between dates"
              >
                Overlay
              </button>
              <button
                type="button"
                disabled={isAligning}
                onClick={() => setViewMode('svr3d')}
                aria-pressed={viewMode === 'svr3d'}
                className="instrument-mode-tab"
                title="SVR 3D view"
              >
                3D
              </button>
            </nav>
          ) : null}

          {(data?.patients?.length ?? 0) > 1 ? (
            <label className="instrument-patient">
              <span className="instrument-patient-label">Patient</span>
              <select
                aria-label="Selected patient"
                disabled={isAligning}
                value={data?.selected_patient_key ?? ''}
                onChange={(event) => {
                  abortAlignment();
                  clearDerivedAlignmentFrames();
                  clearAlignmentState();
                  void selectPatient(event.target.value);
                }}
                className="instrument-patient-select"
              >
                {data?.patients?.map((patient) => (
                  <option key={patient.key} value={patient.key}>
                    {patient.patient_name || patient.patient_id || 'Unknown patient'}
                  </option>
                ))}
              </select>
            </label>
          ) : (data?.patients?.length ?? 0) === 1 ? (
            <div className="instrument-patient" aria-label="Selected patient">
              <span className="instrument-patient-label">Patient</span>
              <span className="instrument-patient-value">
                {data?.patients?.[0]?.patient_name || data?.patients?.[0]?.patient_id || 'Unknown patient'}
              </span>
            </div>
          ) : null}

          <div className="instrument-actions">
            {hasData ? (
              <button
                type="button"
                disabled={isAligning}
                onClick={() => {
                  setHeaderMenuOpen(false);
                  setUploadModalOpen(true);
                }}
                className="instrument-header-action"
                aria-label="Import additional scans"
              >
                <Upload className="h-4 w-4" aria-hidden="true" />
                <span>Import</span>
              </button>
            ) : null}
            <button
              type="button"
              disabled={isAligning}
              onClick={() => {
                setHeaderMenuOpen(false);
                setHelpOpen(true);
              }}
              className="instrument-icon-button"
              title="Help & shortcuts"
              aria-label="Help and keyboard shortcuts"
            >
              <HelpCircle className="h-[18px] w-[18px]" aria-hidden="true" />
            </button>

            <div className="relative" ref={headerMenuRef}>
              <button
                type="button"
                disabled={isAligning}
                onClick={() => setHeaderMenuOpen((value) => !value)}
                className="instrument-icon-button"
                title="Menu"
                aria-label="Application menu"
                aria-expanded={headerMenuOpen}
              >
                <MoreVertical className="h-[18px] w-[18px]" aria-hidden="true" />
              </button>

              {headerMenuOpen ? (
                <div className="instrument-menu">
                  <button
                    type="button"
                    disabled={isAligning}
                    onClick={() => {
                      setHeaderMenuOpen(false);
                      setUploadModalOpen(true);
                    }}
                    className="instrument-menu-item"
                  >
                    <Upload className="h-4 w-4" aria-hidden="true" />
                    Import scans
                  </button>
                  {hasData ? (
                    <button
                      type="button"
                      disabled={isAligning}
                      onClick={() => {
                        setHeaderMenuOpen(false);
                        setExportModalOpen(true);
                      }}
                      className="instrument-menu-item"
                    >
                      <Download className="h-4 w-4" aria-hidden="true" />
                      Export backup (ZIP)
                    </button>
                  ) : null}
                  {hasData ? (
                    <button
                      type="button"
                      disabled={isAligning}
                      onClick={() => {
                        setHeaderMenuOpen(false);
                        setClearDataModalOpen(true);
                      }}
                      className="instrument-menu-item"
                      data-destructive="true"
                    >
                      <Trash2 className="h-4 w-4" aria-hidden="true" />
                      Delete all local data
                    </button>
                  ) : null}
                </div>
              ) : null}
            </div>
          </div>
        </div>

        {hasData || hasInstrumentNotices ? (
          <div
            className="instrument-context-rail"
            aria-label="Selected examination and image context"
            data-notices-visible={hasInstrumentNotices || undefined}
          >
            <div className="instrument-context-summary">
              <span className="instrument-context-value">{selectedPlane}</span>
              {selectedSequence ? (
                <>
                  <span className="instrument-context-separator" aria-hidden="true">
                    ·
                  </span>
                  <span className="instrument-context-value">{formatSequenceLabel(selectedSequence)}</span>
                </>
              ) : null}
              {activeExaminationDate && !showStudyFilmstrip ? (
                <>
                  <span className="instrument-context-separator" data-secondary="true" aria-hidden="true">
                    ·
                  </span>
                  <span data-secondary="true">{formatDate(activeExaminationDate)}</span>
                </>
              ) : null}
            </div>

            {viewMode === 'overlay' && overlayColumns.length > 0 ? (
              <div className="instrument-context-playback">
                <button
                  type="button"
                  onClick={() => setIsPlaying(!isPlaying)}
                  disabled={isAligning || overlayColumns.length < 2}
                  className="instrument-icon-button disabled:cursor-not-allowed disabled:opacity-50"
                  title={isPlaying ? 'Pause' : 'Play'}
                  aria-label={isPlaying ? 'Pause comparison playback' : 'Start comparison playback'}
                >
                  {isPlaying ? (
                    <Pause className="h-4 w-4" aria-hidden="true" />
                  ) : (
                    <Play className="h-4 w-4" aria-hidden="true" />
                  )}
                </button>
                <select
                  aria-label="Comparison playback speed"
                  value={playSpeed}
                  onChange={(event) => setPlaySpeed(parseInt(event.target.value, 10))}
                  disabled={isAligning || overlayColumns.length < 2}
                  className="disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {OVERLAY.PLAY_SPEEDS.map((speed) => (
                    <option key={speed.value} value={speed.value}>
                      {speed.label}
                    </option>
                  ))}
                </select>
              </div>
            ) : null}

            {showStudyFilmstrip && overlayColumns.length > 0 ? (
              <nav className="instrument-study-filmstrip" aria-label="Available examinations">
                {overlayColumns.map((column, index) => (
                  <button
                    key={column.date}
                    type="button"
                    disabled={isAligning}
                    onMouseDown={(event) => event.preventDefault()}
                    onClick={() => {
                      setOverlayDateIndex(index);
                      setIsPlaying(false);
                    }}
                    aria-current={index === overlayDateIndex ? 'true' : undefined}
                    className="instrument-study-button"
                  >
                    {formatDate(column.date)}
                  </button>
                ))}
              </nav>
            ) : null}

            {hasInstrumentNotices ? (
              <div className="instrument-notice-rail">
                {persistenceError ? (
                  <div role="alert" className="instrument-notice" data-severity="error">
                    <span>Changes could not be saved: {persistenceError}</span>
                    <button type="button" className="instrument-notice-button" onClick={clearPersistenceError}>
                      Dismiss
                    </button>
                  </div>
                ) : null}
                {alignmentError && !isAligning ? (
                  <div role="alert" className="instrument-notice" data-severity="error">
                    <span>
                      <span className="font-medium">Alignment failed:</span> {alignmentError}
                    </span>
                    <button type="button" className="instrument-notice-button" onClick={clearAlignmentState}>
                      Dismiss
                    </button>
                  </div>
                ) : null}
                {unsuccessfulAlignmentResults.length > 0 ? (
                  <div role="status" aria-live="polite" className="instrument-notice">
                    <span className="font-medium">Some examinations could not be aligned safely.</span>
                    <ul className="instrument-notice-details">
                      {unsuccessfulAlignmentResults.map((result) => (
                        <li key={`${result.runId ?? 'alignment'}:${result.date}`}>
                          {formatDate(result.date)}: {result.message ?? result.outcome?.replaceAll('-', ' ')}
                        </li>
                      ))}
                    </ul>
                    <button type="button" className="instrument-notice-button" onClick={clearAlignmentState}>
                      Dismiss
                    </button>
                  </div>
                ) : null}
              </div>
            ) : null}
          </div>
        ) : null}
      </header>

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
        <div ref={setCenterPaneRef} className="instrument-stage relative flex min-w-0 flex-1 flex-col overflow-hidden">
          {!hasData ? (
            <div className="instrument-empty">
              <div className="instrument-empty-inner">
                <p className="instrument-eyebrow">Private imaging workspace</p>
                <h2 className="instrument-empty-heading">Bring your scans into Mira.</h2>
                <p className="instrument-empty-copy">
                  Import your MRI examinations to view and compare acquired images over time.
                </p>
                <button type="button" onClick={() => setUploadModalOpen(true)} className="instrument-primary-button">
                  <Upload className="h-4 w-4" aria-hidden="true" />
                  Import scans
                </button>
                <p className="instrument-empty-disclosure">Your images stay on this device.</p>
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

        {hasData && viewMode !== 'svr3d' ? (
          <ComparisonDatesSidebar
            open={rightSidebarOpen}
            onToggleOpen={() => setRightSidebarOpen((v) => !v)}
            sortedDates={sortedDates}
            enabledDates={enabledDates}
            datesWithDataForSequence={datesWithDataForSequence}
            onSelectAllDates={selectAllDates}
            onSelectNoDates={selectNoDates}
            onToggleDate={toggleDate}
            alignmentInProgress={isAligning}
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
