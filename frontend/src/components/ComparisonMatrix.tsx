import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { AlignmentReference, ExclusionMask, SequenceCombo, SeriesRef } from '../types/api';
import { formatDate } from '../utils/format';
import { readLocalStorageJson, writeLocalStorageJson } from '../utils/persistence';
import {
  Brain,
  Layers,
  LayoutGrid,
  Play,
  Pause,
  Upload,
  Download,
  Trash2,
  Loader2,
  MoreVertical,
  HelpCircle,
} from 'lucide-react';
import { DicomViewer, type DicomViewerHandle } from './DicomViewer';
import { ImageControls } from './ImageControls';
import { StepControl } from './StepControl';
import { HelpModal } from './HelpModal';
import { UploadModal } from './UploadModal';
import { ExportModal } from './ExportModal';
import { ClearDataModal } from './ClearDataModal';
import { DragRectActionOverlay } from './DragRectActionOverlay';
import { SliceLoopNavigator } from './comparison/SliceLoopNavigator';
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
import { useAiAnnotation } from '../hooks/useAiAnnotation';
import { DEFAULT_PANEL_SETTINGS, OVERLAY, AI_ENABLED } from '../utils/constants';
import { getEffectiveInstanceIndex, getSliceIndex, getProgressFromSlice } from '../utils/math';

function getOverlayViewerSize(gridSize: { width: number; height: number }) {
  // Fill available space while leaving room for the top strip.
  const maxSize = Math.min(Math.max(0, gridSize.width - 48), Math.max(0, gridSize.height - 120));
  return Math.max(300, maxSize);
}

function formatMs(ms: number): string {
  if (!Number.isFinite(ms)) return '';
  if (ms < 1000) return `${Math.round(ms)} ms`;
  return `${(ms / 1000).toFixed(2)} s`;
}

type PersistedComparisonUiState = {
  sidebarOpen?: boolean;
  rightSidebarOpen?: boolean;
};

const COMPARISON_UI_STORAGE_KEY = 'miraviewer:comparison-ui:v1';

function readPersistedComparisonUiState(): PersistedComparisonUiState {
  const parsed = readLocalStorageJson(COMPARISON_UI_STORAGE_KEY);
  if (!parsed || typeof parsed !== 'object') return {};

  const obj = parsed as Record<string, unknown>;
  return {
    sidebarOpen: typeof obj.sidebarOpen === 'boolean' ? obj.sidebarOpen : undefined,
    rightSidebarOpen: typeof obj.rightSidebarOpen === 'boolean' ? obj.rightSidebarOpen : undefined,
  };
}

export function ComparisonMatrix() {
  const { data, loading, error, reload } = useComparisonData();
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

  const uiPersistedRef = useRef<PersistedComparisonUiState>(readPersistedComparisonUiState());

  const persistUi = useCallback((update: PersistedComparisonUiState) => {
    const next: PersistedComparisonUiState = { ...uiPersistedRef.current, ...update };
    uiPersistedRef.current = next;
    writeLocalStorageJson(COMPARISON_UI_STORAGE_KEY, next);
  }, []);

  const [sidebarOpen, setSidebarOpen] = useState(() => {
    const persisted = readPersistedComparisonUiState();
    return typeof persisted.sidebarOpen === 'boolean' ? persisted.sidebarOpen : true;
  });
  const [rightSidebarOpen, setRightSidebarOpen] = useState(() => {
    const persisted = readPersistedComparisonUiState();
    return typeof persisted.rightSidebarOpen === 'boolean' ? persisted.rightSidebarOpen : true;
  });

  // Persist the user's layout preferences so a hard refresh resumes where they left off.
  useEffect(() => {
    persistUi({ sidebarOpen });
  }, [persistUi, sidebarOpen]);
  useEffect(() => {
    persistUi({ rightSidebarOpen });
  }, [persistUi, rightSidebarOpen]);

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
    status: nanoBananaStatus,
    progressText: nanoBananaProgressText,
    imageUrl: nanoBananaImageUrl,
    prompt: nanoBananaPrompt,
    error: nanoBananaError,
    timings: nanoBananaTimings,
    target: nanoBananaTarget,
    isPromptOpen: aiPromptOpen,
    setIsPromptOpen: setAiPromptOpen,
    togglePrompt: toggleAiPrompt,
    runAnalysis: runNanoBananaAcpAnalysis,
    clear: clearNanoBanana,
    isTarget: isNanoTarget,
  } = useAiAnnotation();

  // Viewer handles (keyed by panel) so AI flows can optionally access the live viewer.
  // We use callback refs so we never need to read ref values during render.
  const viewerHandlesRef = useRef(new Map<string, DicomViewerHandle | null>());

  const registerViewerHandle = useCallback((key: string, handle: DicomViewerHandle | null) => {
    viewerHandlesRef.current.set(key, handle);
  }, []);

  const handleAiButtonClick = (
    target: {
      date: string;
      studyId: string;
      seriesUid: string;
      instanceIndex: number;
    },
    viewerKey: string,
    seriesContext: {
      plane?: string | null;
      weight?: string | null;
      sequence?: string | null;
      label?: string | null;
    }
  ) => {
    if (!AI_ENABLED) return;
    const canReuseExisting =
      nanoBananaStatus === 'ready' &&
      !!nanoBananaImageUrl &&
      !!nanoBananaPrompt &&
      nanoBananaTarget?.date === target.date &&
      nanoBananaTarget?.seriesUid === target.seriesUid &&
      nanoBananaTarget?.instanceIndex === target.instanceIndex;

    // If the AI result is for the currently-displayed slice, clicking AI should just toggle the prompt.
    // Regenerate only if AI was cleared or the slice changed.
    if (canReuseExisting) {
      toggleAiPrompt();
      return;
    }

    const viewerHandle = viewerHandlesRef.current.get(viewerKey) || null;
    runNanoBananaAcpAnalysis(target, viewerHandle, seriesContext);
  };

  // Cleanup on unmount.
  useEffect(() => {
    return () => {
      clearNanoBanana();
    };
  }, [clearNanoBanana]);

  // Custom hooks
  const { panelSettings, progress, setProgress, updatePanelSetting, batchUpdateSettings } = usePanelSettings(selectedSeqId, enabledDatesKey);

  // Alignment hooks
  const {
    isAligning,
    progress: alignmentProgress,
    results: alignmentResults,
    alignAllDates,
    abort: abortAlignment,
  } = useAutoAlign();

  // Hover state for showing per-cell controls (avoid relying on CSS group-hover).
  const [hoveredGridCellDate, setHoveredGridCellDate] = useState<string | null>(null);
  const [isOverlayViewerHovered, setIsOverlayViewerHovered] = useState(false);

  useApplyAlignmentResults({
    isAligning,
    alignmentResults,
    panelSettings,
    data,
    selectedSeqId,
    batchUpdateSettings,
  });



  const sequencesForPlane = useMemo(() => {
    if (!data || !selectedPlane) return [] as SequenceCombo[];

    const planeKey = (plane: string | null) => (plane && plane.trim() ? plane : 'Other');

    return data.sequences
      .filter(s => planeKey(s.plane) === selectedPlane)
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
    return selectedDates.map(date => ({ date, ref: map[date] }));
  }, [data, selectedSeqId, enabledDates]);

  
  // For overlay mode: columns sorted oldest to newest (earliest left, latest right)
  const overlayColumns = useMemo(() => {
    if (!data || !selectedSeqId) return [] as { date: string; ref?: SeriesRef }[];
    const map = data.series_map[selectedSeqId] || {};
    // Sort by date ascending (oldest first)
    const selectedDates = [...enabledDates].sort((a, b) => a.localeCompare(b));
    return selectedDates.map(date => ({ date, ref: map[date] })).filter(c => c.ref);
  }, [data, selectedSeqId, enabledDates]);

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
    [gridLayoutContainerRef]
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
  } = useOverlayNavigation(overlayColumns);


  const overlayDisplayedCol = overlayColumns[displayedOverlayIndex];
  const overlayDisplayedRef = overlayDisplayedCol?.ref;
  const overlayDisplayedDate = overlayDisplayedCol?.date;
  const overlayDisplayedSettings = overlayDisplayedDate
    ? panelSettings.get(overlayDisplayedDate) || DEFAULT_PANEL_SETTINGS
    : DEFAULT_PANEL_SETTINGS;
  const overlayDisplayedSliceIndex = overlayDisplayedRef
    ? getSliceIndex(overlayDisplayedRef.instance_count, progress, overlayDisplayedSettings.offset)
    : 0;
  const overlayDisplayedEffectiveSliceIndex = overlayDisplayedRef
    ? getEffectiveInstanceIndex(
        overlayDisplayedSliceIndex,
        overlayDisplayedRef.instance_count,
        overlayDisplayedSettings.reverseSliceOrder
      )
    : 0;

  // Selected overlay date (the one highlighted in the strip).
  const overlaySelectedCol = overlayColumns[overlayDateIndex];
  const overlaySelectedRef = overlaySelectedCol?.ref;
  const overlaySelectedDate = overlaySelectedCol?.date;
  const overlaySelectedSettings = overlaySelectedDate
    ? panelSettings.get(overlaySelectedDate) || DEFAULT_PANEL_SETTINGS
    : DEFAULT_PANEL_SETTINGS;
  const overlaySelectedSliceIndex = overlaySelectedRef
    ? getSliceIndex(overlaySelectedRef.instance_count, progress, overlaySelectedSettings.offset)
    : 0;
  const overlaySelectedEffectiveSliceIndex = overlaySelectedRef
    ? getEffectiveInstanceIndex(
        overlaySelectedSliceIndex,
        overlaySelectedRef.instance_count,
        overlaySelectedSettings.reverseSliceOrder
      )
    : 0;

  // Space-hold compare target.
  const overlayCompareCol = overlayColumns[compareTargetIndex];
  const overlayCompareRef = overlayCompareCol?.ref;
  const overlayCompareDate = overlayCompareCol?.date;
  const overlayCompareSettings = overlayCompareDate
    ? panelSettings.get(overlayCompareDate) || DEFAULT_PANEL_SETTINGS
    : DEFAULT_PANEL_SETTINGS;
  const overlayCompareSliceIndex = overlayCompareRef
    ? getSliceIndex(overlayCompareRef.instance_count, progress, overlayCompareSettings.offset)
    : 0;
  const overlayCompareEffectiveSliceIndex = overlayCompareRef
    ? getEffectiveInstanceIndex(
        overlayCompareSliceIndex,
        overlayCompareRef.instance_count,
        overlayCompareSettings.reverseSliceOrder
      )
    : 0;

  const isOverlayComparing = displayedOverlayIndex !== overlayDateIndex;
  const hasOverlayCompareTarget = overlayColumns.length > 1 && compareTargetIndex !== overlayDateIndex;

  const overlayIsNanoBananaTarget =
    !!nanoBananaTarget &&
    !!overlayDisplayedRef &&
    !!overlayDisplayedDate &&
    nanoBananaTarget.date === overlayDisplayedDate &&
    nanoBananaTarget.seriesUid === overlayDisplayedRef.series_uid &&
    nanoBananaTarget.instanceIndex === overlayDisplayedEffectiveSliceIndex;

  const overlaySelectedIsNanoBananaTarget =
    !!overlaySelectedRef &&
    !!overlaySelectedDate &&
    isNanoTarget(overlaySelectedDate, overlaySelectedRef.series_uid, overlaySelectedEffectiveSliceIndex);

  const overlayCompareIsNanoBananaTarget =
    !!overlayCompareRef &&
    !!overlayCompareDate &&
    isNanoTarget(overlayCompareDate, overlayCompareRef.series_uid, overlayCompareEffectiveSliceIndex);

  const overlaySelectedNanoBananaOverrideUrl =
    nanoBananaStatus === 'ready' && nanoBananaImageUrl && overlaySelectedIsNanoBananaTarget
      ? nanoBananaImageUrl
      : undefined;

  const overlayCompareNanoBananaOverrideUrl =
    nanoBananaStatus === 'ready' && nanoBananaImageUrl && overlayCompareIsNanoBananaTarget
      ? nanoBananaImageUrl
      : undefined;

  const overlayDisplayedNanoBananaOverrideUrl =
    nanoBananaStatus === 'ready' && nanoBananaImageUrl && overlayIsNanoBananaTarget
      ? nanoBananaImageUrl
      : undefined;

  const overlayViewerSize = getOverlayViewerSize(gridSize);

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
        const finalReference: AlignmentReference = { ...reference, exclusionMask };
        const results = await alignAllDates(finalReference, targetDates, seriesMap, progress);

        // Results are applied incrementally via an effect so the UI updates per-date.
        console.log(
          `[Alignment] Aligned ${results.length} dates. Average NMI: ${(
            results.reduce((sum, r) => sum + r.nmiScore, 0) / results.length
          ).toFixed(3)}`
        );
      } catch (err) {
        console.error('[Alignment] Failed:', err);
      }
    },
    [abortAlignment, alignAllDates, data, isAligning, overlayColumns, progress, selectedSeqId]
  );

  const setProgressWithClearAi = useCallback(
    (nextProgress: number) => {
      if (nanoBananaStatus !== 'idle') {
        clearNanoBanana();
      }
      setProgress(nextProgress);
    },
    [nanoBananaStatus, clearNanoBanana, setProgress]
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
  // - Individual DicomViewer instances still handle wheel events directly; those events call
  //   preventDefault, and we skip them here via `e.defaultPrevented`.
  const wheelNavContextRef = useRef<{ instanceCount: number; offset: number } | null>(null);
  useEffect(() => {
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
  }, [viewMode, overlaySelectedRef, overlaySelectedDate, overlaySelectedSettings.offset, columns, overlayColumns, panelSettings]);

  const setProgressWithClearAiRef = useRef(setProgressWithClearAi);
  useEffect(() => {
    setProgressWithClearAiRef.current = setProgressWithClearAi;
  }, [setProgressWithClearAi]);

  useGlobalSliceWheelNavigation({
    centerPaneRef,
    contextRef: wheelNavContextRef,
    progressRef,
    setProgressRef: setProgressWithClearAiRef,
  });

  const playbackInstanceCount = useMemo(() => {
    const fromOverlay = overlayColumns[overlayDateIndex]?.ref?.instance_count;
    if (typeof fromOverlay === 'number' && fromOverlay > 1) return fromOverlay;

    const anyOverlay = overlayColumns.find(c => c.ref)?.ref?.instance_count;
    if (typeof anyOverlay === 'number' && anyOverlay > 1) return anyOverlay;

    const anyGrid = columns.find(c => c.ref)?.ref?.instance_count;
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
    return (
      <div className="h-screen flex items-center justify-center text-[var(--text-secondary)]">
        {error}
      </div>
    );
  }

  const selectedSeq = hasData ? data.sequences.find(s => s.id === selectedSeqId) : undefined;

  const aiSeriesContext = hasData
    ? {
        plane: selectedSeq?.plane ?? selectedPlane,
        weight: selectedSeq?.weight,
        sequence: selectedSeq?.sequence,
        label: selectedSeq ? formatSequenceLabel(selectedSeq) : selectedPlane,
      }
    : { plane: null, weight: null, sequence: null, label: null };


  return (
    <div className="h-screen flex flex-col">
      {/* Help Modal */}
      {helpOpen && <HelpModal onClose={() => setHelpOpen(false)} />}
      
      {/* Upload Modal */}
      {uploadModalOpen && (
        <UploadModal
          onClose={() => setUploadModalOpen(false)}
          onUploadComplete={() => {
            reload();
          }}
        />
      )}
      {exportModalOpen && <ExportModal onClose={() => setExportModalOpen(false)} />}
      {clearDataModalOpen && (
        <ClearDataModal
          onClose={() => setClearDataModalOpen(false)}
          onReset={() => window.location.reload()}
        />
      )}


      {/* Header */}
      <div className="px-4 py-3 bg-[var(--bg-secondary)] border-b border-[var(--border-color)]">
        <div className="flex items-center gap-3">
          <div className="flex items-center gap-3 shrink-0">
            <Brain className="w-6 h-6 text-[var(--accent)]" />
            <h1 className="text-lg font-semibold">MiraViewer</h1>

            {/* View mode toggle (left side) */}
            <div className="flex items-center bg-[var(--bg-primary)] rounded-lg border border-[var(--border-color)]">
              <button
                onClick={() => setViewMode('grid')}
                className={`px-3 py-1.5 text-xs rounded-l-lg transition-colors flex items-center gap-1.5 ${viewMode === 'grid' ? 'bg-[var(--accent)] text-white' : 'text-[var(--text-secondary)] hover:text-[var(--text-primary)]'}`}
                title="Grid view"
              >
                <LayoutGrid className="w-3.5 h-3.5" />
                Grid
              </button>
              <button
                onClick={() => setViewMode('overlay')}
                className={`px-3 py-1.5 text-xs rounded-r-lg transition-colors flex items-center gap-1.5 ${viewMode === 'overlay' ? 'bg-[var(--accent)] text-white' : 'text-[var(--text-secondary)] hover:text-[var(--text-primary)]'}`}
                title="Overlay view - toggle between dates"
              >
                <Layers className="w-3.5 h-3.5" />
                Overlay
              </button>
            </div>
          </div>

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
                >
                  {isPlaying ? <Pause className="w-4 h-4" /> : <Play className="w-4 h-4" />}
                </button>

                <div className="flex items-center gap-2 shrink-0">
                  <span className="text-xs text-[var(--text-secondary)]">Speed:</span>
                  <select
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
                    Import (DICOM ZIP)
                  </button>
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
                </div>
              )}
            </div>
          </div>
        </div>
      </div>

      {/* Main area with sidebar */}
      <div className="flex-1 flex overflow-hidden relative">
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
        />

        {/* Main content area - Grid or Overlay */}
        <div ref={setCenterPaneRef} className="flex-1 overflow-hidden bg-black flex flex-col relative">
          {!hasData ? (
            /* Empty state */
            <div className="flex-1 flex flex-col items-center justify-center gap-6 text-center p-8">
              <Brain className="w-16 h-16 text-[var(--accent)] opacity-50" />
              <div>
                <h2 className="text-xl font-semibold text-[var(--text-primary)] mb-2">No scans loaded</h2>
                <p className="text-[var(--text-secondary)] max-w-md">
                  Upload a folder of DICOM files or a ZIP archive to get started.
                </p>
              </div>
              <button
                onClick={() => setUploadModalOpen(true)}
                className="flex items-center gap-2 px-4 py-2 rounded-lg bg-[var(--accent)] text-white hover:bg-[var(--accent-hover)] transition-colors"
              >
                <Upload className="w-5 h-5" />
                Upload DICOM Files
              </button>
            </div>
          ) : viewMode === 'grid' ? (
            /* Grid View */
            <div className="flex-1 flex items-center justify-center">
              {/* Alignment progress overlay (grid view) */}
              {isAligning && alignmentProgress && (
                <div className="absolute top-3 left-1/2 -translate-x-1/2 z-20">
                  <div className="flex items-center gap-3 px-4 py-3 rounded-xl bg-black/70 border border-white/10 shadow-xl">
                    <Loader2 className="w-5 h-5 animate-spin text-[var(--accent)]" />
                    <div className="min-w-0">
                      <div className="text-sm font-medium text-white">
                        {alignmentProgress.phase === 'capturing'
                          ? 'Preparing reference…'
                          : alignmentProgress.currentDate
                          ? `Aligning ${formatDate(alignmentProgress.currentDate)} (${alignmentProgress.dateIndex + 1}/${
                              alignmentProgress.totalDates
                            })`
                          : 'Aligning…'}
                      </div>
                      {alignmentProgress.phase !== 'capturing' && alignmentProgress.slicesChecked ? (
                        <div className="text-xs text-white/70">
                          {alignmentProgress.slicesChecked} slices · MI {alignmentProgress.bestMiSoFar.toFixed(3)}
                        </div>
                      ) : null}
                    </div>
                    <button
                      type="button"
                      onClick={abortAlignment}
                      className="shrink-0 px-2 py-1 rounded bg-white/10 hover:bg-white/20 text-white text-xs"
                      title="Cancel alignment"
                    >
                      Cancel
                    </button>
                  </div>
                </div>
              )}

              <div
                className="grid gap-2"
                style={{
                  gridTemplateColumns: `repeat(${gridCols}, ${gridCellSize}px)`,
                  gridAutoRows: `${gridCellSize}px`, // square cells; controls are overlaid on hover
                }}
                onMouseMove={(e) => {
                  const target = e.target as HTMLElement | null;
                  const cell = target?.closest?.('[data-grid-cell-date]') as HTMLElement | null;
                  const next = cell?.getAttribute('data-grid-cell-date') ?? null;
                  setHoveredGridCellDate((prev) => (prev === next ? prev : next));
                }}
                onMouseLeave={() => setHoveredGridCellDate(null)}
              >
                {columns.map(({ date, ref }) => {
                  const settings = panelSettings.get(date) || DEFAULT_PANEL_SETTINGS;
                  
                  if (!ref) {
                    return (
                      <div key={date} className="relative flex flex-col rounded-lg overflow-hidden border border-[var(--border-color)] bg-[var(--bg-primary)]">
                        <div className="px-3 py-2 text-xs text-[var(--text-secondary)] bg-[var(--bg-secondary)] border-b border-[var(--border-color)]">{formatDate(date)}</div>
                        <div className="flex-1 flex items-center justify-center text-[var(--text-secondary)]">No series</div>
                      </div>
                    );
                  }
                  
                  const idx = getSliceIndex(ref.instance_count, progress, settings.offset);
                  const effectiveIdx = getEffectiveInstanceIndex(idx, ref.instance_count, settings.reverseSliceOrder);
                  const viewerKey = `grid:${date}`;

                  const isNanoBananaTarget = isNanoTarget(date, ref.series_uid, effectiveIdx);

                  const nanoBananaOverrideUrl =
                    nanoBananaStatus === 'ready' && nanoBananaImageUrl && isNanoBananaTarget
                      ? nanoBananaImageUrl
                      : undefined;

                  const isHovered = hoveredGridCellDate === date;

                  return (
                    <div
                      key={date}
                      data-grid-cell-date={date}
                      className="relative flex flex-col rounded-lg overflow-hidden border border-[var(--border-color)] cursor-crosshair"
                    >
                      {/* Cell controls (shown on hover) */}
                      <div
                        className={`absolute top-0 left-0 right-0 z-10 transition-opacity ${
                          isHovered ? 'opacity-100 pointer-events-auto' : 'opacity-0 pointer-events-none'
                        }`}
                      >
                        <div className="px-2 py-1 text-xs bg-[var(--bg-secondary)]/90 backdrop-blur border-b border-[var(--border-color)] flex items-center justify-end">
                          <ImageControls
                            settings={settings}
                            instanceIndex={idx}
                            instanceCount={ref.instance_count}
                            onUpdate={(update) => {
                              if (nanoBananaStatus !== 'idle' && isNanoBananaTarget) {
                                clearNanoBanana();
                              }
                              updatePanelSetting(date, update);
                            }}
                            onAcpAnalyze={
                              AI_ENABLED
                                ? () =>
                                    handleAiButtonClick(
                                      {
                                        date,
                                        studyId: ref.study_id,
                                        seriesUid: ref.series_uid,
                                        instanceIndex: effectiveIdx,
                                      },
                                      viewerKey,
                                      aiSeriesContext
                                    )
                                : undefined
                            }
                            acpAnalyzeDisabled={!AI_ENABLED || nanoBananaStatus === 'loading'}
                            showSliceControl={false}
                          />
                        </div>
                      </div>
                      {/* Slice selector (shown on hover, bottom-right corner) */}
                      <div
                        className={`absolute bottom-2 right-2 z-10 transition-opacity ${
                          isHovered ? 'opacity-100 pointer-events-auto' : 'opacity-0 pointer-events-none'
                        }`}
                        onMouseDown={(e) => e.stopPropagation()}
                      >
                        <div className="px-2 py-1 rounded bg-[var(--bg-secondary)]/90 backdrop-blur border border-[var(--border-color)]">
                          <StepControl
                            title="Slice offset"
                            value={`${idx + 1}/${ref.instance_count}`}
                            valueWidth="w-16"
                            tabular
                            accent
                            onDecrement={() => {
                              if (nanoBananaStatus !== 'idle' && isNanoBananaTarget) {
                                clearNanoBanana();
                              }
                              updatePanelSetting(date, { offset: settings.offset - 1 });
                            }}
                            onIncrement={() => {
                              if (nanoBananaStatus !== 'idle' && isNanoBananaTarget) {
                                clearNanoBanana();
                              }
                              updatePanelSetting(date, { offset: settings.offset + 1 });
                            }}
                          />
                        </div>
                      </div>
                      <div className="flex-1 min-h-0 bg-black relative">
                        <DragRectActionOverlay
                          className="absolute inset-0 cursor-crosshair"
                          geometry={
                            nanoBananaOverrideUrl
                              ? { panX: 0, panY: 0, zoom: 1, rotation: 0, affine00: 1, affine01: 0, affine10: 0, affine11: 1 }
                              : {
                                  panX: settings.panX,
                                  panY: settings.panY,
                                  zoom: settings.zoom,
                                  rotation: settings.rotation,
                                  affine00: settings.affine00,
                                  affine01: settings.affine01,
                                  affine10: settings.affine10,
                                  affine11: settings.affine11,
                                }
                          }
                          disabled={overlayColumns.length < 2 || isAligning}
                          onConfirm={(mask) => {
                            void startAlignAll(
                              {
                                date,
                                seriesUid: ref.series_uid,
                                sliceIndex: effectiveIdx,
                                sliceCount: ref.instance_count,
                                settings,
                              },
                              mask
                            );
                          }}
                          actionTitle={`Align all other dates to ${formatDate(date)}`}
                        >
                          <DicomViewer
                            ref={(handle) => registerViewerHandle(viewerKey, handle)}
                            studyId={ref.study_id}
                            seriesUid={ref.series_uid}
                            instanceIndex={idx}
                            instanceCount={ref.instance_count}
                            reverseSliceOrder={settings.reverseSliceOrder}
                            imageUrlOverride={nanoBananaOverrideUrl}
                            onInstanceChange={(i) => {
                              // When scrolling on a panel, update the global progress.
                              setProgressWithClearAi(getProgressFromSlice(i, ref.instance_count, settings.offset));
                            }}
                            brightness={nanoBananaOverrideUrl ? 100 : settings.brightness}
                            contrast={nanoBananaOverrideUrl ? 100 : settings.contrast}
                            zoom={nanoBananaOverrideUrl ? 1 : settings.zoom}
                            rotation={nanoBananaOverrideUrl ? 0 : settings.rotation}
                            panX={nanoBananaOverrideUrl ? 0 : settings.panX}
                            panY={nanoBananaOverrideUrl ? 0 : settings.panY}
                            affine00={nanoBananaOverrideUrl ? 1 : settings.affine00}
                            affine01={nanoBananaOverrideUrl ? 0 : settings.affine01}
                            affine10={nanoBananaOverrideUrl ? 0 : settings.affine10}
                            affine11={nanoBananaOverrideUrl ? 1 : settings.affine11}
                            onPanChange={
                              nanoBananaOverrideUrl
                                ? undefined
                                : (newPanX, newPanY) => {
                                    updatePanelSetting(date, { panX: newPanX, panY: newPanY });
                                  }
                            }
                          />

                          {AI_ENABLED && nanoBananaStatus === 'loading' && isNanoBananaTarget && (
                            <div className="absolute top-2 right-2 max-w-[70%]">
                              <div className="flex items-center gap-2 px-2 py-1 rounded bg-black/60">
                                <div className="w-5 h-5 border-2 border-[var(--accent)] border-t-transparent rounded-full animate-spin" />
                                <div className="text-[10px] text-white/90 truncate">
                                  {nanoBananaProgressText || 'Working…'}
                                </div>
                              </div>
                            </div>
                          )}

                          {AI_ENABLED && nanoBananaStatus === 'ready' && isNanoBananaTarget && (
                            <button
                              type="button"
                              onClick={clearNanoBanana}
                              className="absolute top-2 right-2 px-2 py-1 rounded bg-black/70 text-white text-[10px] hover:bg-black/80"
                              title="Clear AI annotation"
                            >
                              Clear AI
                            </button>
                          )}

                          {/* Date overlay (matches overlay view style) */}
                          <div className="absolute bottom-2 left-2 px-2 py-1 bg-black/70 rounded text-white text-xs font-medium pointer-events-none">
                            {formatDate(date)}
                          </div>
                        </DragRectActionOverlay>
                      </div>
                    </div>
                  );
                })}
                {columns.length === 0 && (
                  <div className="h-full flex items-center justify-center text-[var(--text-secondary)]">Select dates to view</div>
                )}
              </div>
            </div>
          ) : (
            /* Overlay View */
            <div className="flex-1 flex items-center justify-center p-4">
              {overlayColumns.length === 0 ? (
                <div className="text-[var(--text-secondary)]">Select dates to view</div>
              ) : overlayDisplayedRef && overlayDisplayedDate ? (
                <div
                  className="relative rounded-lg overflow-hidden border border-[var(--border-color)] cursor-crosshair"
                  style={{ width: overlayViewerSize, height: overlayViewerSize }}
                  onMouseEnter={() => setIsOverlayViewerHovered(true)}
                  onMouseLeave={() => setIsOverlayViewerHovered(false)}
                >
                  {/* Cell controls (shown on hover, matches grid cell style) */}
                  <div
                    className={`absolute top-0 left-0 right-0 z-10 transition-opacity ${
                      isOverlayComparing
                        ? 'opacity-70 pointer-events-none'
                        : isOverlayViewerHovered
                        ? 'opacity-100 pointer-events-auto'
                        : 'opacity-0 pointer-events-none'
                    }`}
                  >
                    <div className="px-2 py-1 text-xs bg-[var(--bg-secondary)]/90 backdrop-blur border-b border-[var(--border-color)] flex items-center justify-end">
                      <ImageControls
                        settings={overlayDisplayedSettings}
                        instanceIndex={overlayDisplayedSliceIndex}
                        instanceCount={overlayDisplayedRef.instance_count}
                        onUpdate={(update) => {
                          const isOverlayTarget =
                            nanoBananaStatus !== 'idle' &&
                            isNanoTarget(overlayDisplayedDate, overlayDisplayedRef.series_uid, overlayDisplayedSliceIndex);

                          if (isOverlayTarget) {
                            clearNanoBanana();
                          }

                          updatePanelSetting(overlayDisplayedDate, update);
                        }}
                        onAcpAnalyze={
                          AI_ENABLED
                            ? () => {
                                handleAiButtonClick(
                                  {
                                    date: overlayDisplayedDate,
                                    studyId: overlayDisplayedRef.study_id,
                                    seriesUid: overlayDisplayedRef.series_uid,
                                    instanceIndex: overlayDisplayedEffectiveSliceIndex,
                                  },
                                  'overlay',
                                  aiSeriesContext
                                );
                              }
                            : undefined
                        }
                        acpAnalyzeDisabled={!AI_ENABLED || nanoBananaStatus === 'loading'}
                        showSliceControl={false}
                      />
                    </div>
                  </div>

                  {/* Slice selector (shown on hover, bottom-right corner, matches grid cell style) */}
                  <div
                    className={`absolute bottom-2 right-2 z-10 transition-opacity ${
                      isOverlayComparing
                        ? 'opacity-70 pointer-events-none'
                        : isOverlayViewerHovered
                        ? 'opacity-100 pointer-events-auto'
                        : 'opacity-0 pointer-events-none'
                    }`}
                  >
                    <div className="px-2 py-1 rounded bg-[var(--bg-secondary)]/90 backdrop-blur border border-[var(--border-color)]">
                      <StepControl
                        title="Slice offset"
                        value={`${overlayDisplayedSliceIndex + 1}/${overlayDisplayedRef.instance_count}`}
                        valueWidth="w-16"
                        tabular
                        accent
                        onDecrement={() => {
                          if (nanoBananaStatus !== 'idle' && overlayIsNanoBananaTarget) {
                            clearNanoBanana();
                          }
                          updatePanelSetting(overlayDisplayedDate, { offset: overlayDisplayedSettings.offset - 1 });
                        }}
                        onIncrement={() => {
                          if (nanoBananaStatus !== 'idle' && overlayIsNanoBananaTarget) {
                            clearNanoBanana();
                          }
                          updatePanelSetting(overlayDisplayedDate, { offset: overlayDisplayedSettings.offset + 1 });
                        }}
                      />
                    </div>
                  </div>

                  <DragRectActionOverlay
                    className="absolute inset-0 cursor-crosshair"
                    geometry={
                      overlayDisplayedNanoBananaOverrideUrl
                        ? { panX: 0, panY: 0, zoom: 1, rotation: 0, affine00: 1, affine01: 0, affine10: 0, affine11: 1 }
                        : {
                            panX: overlayDisplayedSettings.panX,
                            panY: overlayDisplayedSettings.panY,
                            zoom: overlayDisplayedSettings.zoom,
                            rotation: overlayDisplayedSettings.rotation,
                            affine00: overlayDisplayedSettings.affine00,
                            affine01: overlayDisplayedSettings.affine01,
                            affine10: overlayDisplayedSettings.affine10,
                            affine11: overlayDisplayedSettings.affine11,
                          }
                    }
                    disabled={overlayColumns.length < 2 || isAligning || isOverlayComparing}
                    onConfirm={(mask) => {
                      void startAlignAll(
                        {
                          date: overlayDisplayedDate,
                          seriesUid: overlayDisplayedRef.series_uid,
                          sliceIndex: overlayDisplayedEffectiveSliceIndex,
                          sliceCount: overlayDisplayedRef.instance_count,
                          settings: overlayDisplayedSettings,
                        },
                        mask
                      );
                    }}
                    actionTitle={`Align all other dates to ${formatDate(overlayDisplayedDate)}`}
                  >
                    {/*
                    Space compare should feel instant.

                    Previously we updated a single viewer's series/settings on Space keydown.
                    That can cause a brief visual "jerk" (old image + new transform/settings)
                    while the new slice resolves/loads.

                    To avoid that, we keep BOTH the selected date and the compare target mounted
                    and simply toggle which one is visible.
                  */}
                  <div
                    className={`absolute inset-0 ${
                      isOverlayComparing ? 'opacity-0 pointer-events-none' : 'opacity-100'
                    }`}
                  >
                    {overlaySelectedRef && overlaySelectedDate ? (
                      <DicomViewer
                        ref={(handle) => registerViewerHandle('overlay', handle)}
                        // Important: do not key by series/date.
                        // Remounting the viewer forces Cornerstone to re-enable the element,
                        // which causes a visible black flash when toggling dates.
                        studyId={overlaySelectedRef.study_id}
                        seriesUid={overlaySelectedRef.series_uid}
                        instanceIndex={overlaySelectedSliceIndex}
                        instanceCount={overlaySelectedRef.instance_count}
                        reverseSliceOrder={overlaySelectedSettings.reverseSliceOrder}
                        imageUrlOverride={overlaySelectedNanoBananaOverrideUrl}
                        onInstanceChange={(i) => {
                          setProgressWithClearAi(
                            getProgressFromSlice(
                              i,
                              overlaySelectedRef.instance_count,
                              overlaySelectedSettings.offset
                            )
                          );
                        }}
                        brightness={
                          overlaySelectedNanoBananaOverrideUrl ? 100 : overlaySelectedSettings.brightness
                        }
                        contrast={
                          overlaySelectedNanoBananaOverrideUrl ? 100 : overlaySelectedSettings.contrast
                        }
                        zoom={overlaySelectedNanoBananaOverrideUrl ? 1 : overlaySelectedSettings.zoom}
                        rotation={
                          overlaySelectedNanoBananaOverrideUrl ? 0 : overlaySelectedSettings.rotation
                        }
                        panX={overlaySelectedNanoBananaOverrideUrl ? 0 : overlaySelectedSettings.panX}
                        panY={overlaySelectedNanoBananaOverrideUrl ? 0 : overlaySelectedSettings.panY}
                        affine00={overlaySelectedNanoBananaOverrideUrl ? 1 : overlaySelectedSettings.affine00}
                        affine01={overlaySelectedNanoBananaOverrideUrl ? 0 : overlaySelectedSettings.affine01}
                        affine10={overlaySelectedNanoBananaOverrideUrl ? 0 : overlaySelectedSettings.affine10}
                        affine11={overlaySelectedNanoBananaOverrideUrl ? 1 : overlaySelectedSettings.affine11}
                        onPanChange={
                          overlaySelectedNanoBananaOverrideUrl || isOverlayComparing
                            ? undefined
                            : (newPanX, newPanY) => {
                                updatePanelSetting(overlaySelectedDate, { panX: newPanX, panY: newPanY });
                              }
                        }
                      />
                    ) : null}
                  </div>

                  {hasOverlayCompareTarget && overlayCompareRef && overlayCompareDate ? (
                    <div
                      className={`absolute inset-0 ${
                        isOverlayComparing ? 'opacity-100' : 'opacity-0 pointer-events-none'
                      }`}
                    >
                      <DicomViewer
                        studyId={overlayCompareRef.study_id}
                        seriesUid={overlayCompareRef.series_uid}
                        instanceIndex={overlayCompareSliceIndex}
                        instanceCount={overlayCompareRef.instance_count}
                        reverseSliceOrder={overlayCompareSettings.reverseSliceOrder}
                        imageUrlOverride={overlayCompareNanoBananaOverrideUrl}
                        onInstanceChange={(i) => {
                          setProgressWithClearAi(
                            getProgressFromSlice(
                              i,
                              overlayCompareRef.instance_count,
                              overlayCompareSettings.offset
                            )
                          );
                        }}
                        brightness={
                          overlayCompareNanoBananaOverrideUrl ? 100 : overlayCompareSettings.brightness
                        }
                        contrast={
                          overlayCompareNanoBananaOverrideUrl ? 100 : overlayCompareSettings.contrast
                        }
                        zoom={overlayCompareNanoBananaOverrideUrl ? 1 : overlayCompareSettings.zoom}
                        rotation={
                          overlayCompareNanoBananaOverrideUrl ? 0 : overlayCompareSettings.rotation
                        }
                        panX={overlayCompareNanoBananaOverrideUrl ? 0 : overlayCompareSettings.panX}
                        panY={overlayCompareNanoBananaOverrideUrl ? 0 : overlayCompareSettings.panY}
                        affine00={overlayCompareNanoBananaOverrideUrl ? 1 : overlayCompareSettings.affine00}
                        affine01={overlayCompareNanoBananaOverrideUrl ? 0 : overlayCompareSettings.affine01}
                        affine10={overlayCompareNanoBananaOverrideUrl ? 0 : overlayCompareSettings.affine10}
                        affine11={overlayCompareNanoBananaOverrideUrl ? 1 : overlayCompareSettings.affine11}
                        // Compare mode is read-only for geometry edits.
                        onPanChange={undefined}
                      />
                    </div>
                  ) : null}

                  {isAligning && alignmentProgress && (
                    <div className="absolute inset-0 flex items-center justify-center bg-black/40">
                      <div className="flex items-center gap-3 px-4 py-3 rounded-xl bg-black/70 border border-white/10 shadow-xl">
                        <Loader2 className="w-5 h-5 animate-spin text-[var(--accent)]" />
                        <div className="min-w-0">
                          <div className="text-sm font-medium text-white">
                            {alignmentProgress.phase === 'capturing'
                              ? 'Preparing reference…'
                              : alignmentProgress.currentDate
                              ? `Aligning ${formatDate(alignmentProgress.currentDate)} (${alignmentProgress.dateIndex + 1}/${
                                  alignmentProgress.totalDates
                                })`
                              : 'Aligning…'}
                          </div>
                          {alignmentProgress.phase !== 'capturing' && alignmentProgress.slicesChecked ? (
                            <div className="text-xs text-white/70">
                              {alignmentProgress.slicesChecked} slices · MI {alignmentProgress.bestMiSoFar.toFixed(3)}
                            </div>
                          ) : null}
                        </div>
                        <button
                          type="button"
                          onClick={abortAlignment}
                          className="shrink-0 px-2 py-1 rounded bg-white/10 hover:bg-white/20 text-white text-xs"
                          title="Cancel alignment"
                        >
                          Cancel
                        </button>
                      </div>
                    </div>
                  )}

                  {AI_ENABLED && nanoBananaStatus === 'loading' && overlayIsNanoBananaTarget && (
                    <div className="absolute top-2 right-2 max-w-[70%]">
                      <div className="flex items-center gap-2 px-2 py-1 rounded bg-black/60">
                        <div className="w-5 h-5 border-2 border-[var(--accent)] border-t-transparent rounded-full animate-spin" />
                        <div className="text-[10px] text-white/90 truncate">
                          {nanoBananaProgressText || 'Working…'}
                        </div>
                      </div>
                    </div>
                  )}

                  {AI_ENABLED && nanoBananaStatus === 'ready' && overlayIsNanoBananaTarget && (
                    <button
                      type="button"
                      onClick={clearNanoBanana}
                      className="absolute top-2 right-2 px-2 py-1 rounded bg-black/70 text-white text-[10px] hover:bg-black/80"
                      title="Clear AI annotation"
                    >
                      Clear AI
                    </button>
                  )}

                  {/* Date overlay (matches grid cell style) */}
                  <div className="absolute bottom-2 left-2 px-2 py-1 bg-black/70 rounded text-white text-xs font-medium pointer-events-none">
                    {formatDate(overlayDisplayedDate)}
                  </div>
                </DragRectActionOverlay>
              </div>
              ) : (
                <div className="text-[var(--text-secondary)]">No data</div>
              )}
            </div>
          )}

          {/* AI prompt panel (shown on AI button click; does not affect layout) */}
          {AI_ENABLED && aiPromptOpen && nanoBananaStatus === 'ready' && nanoBananaPrompt && (
            <div className="absolute bottom-3 right-3 z-30 w-[420px] max-w-[calc(100%-24px)] rounded-xl border border-[var(--border-color)] bg-[var(--bg-secondary)] shadow-2xl">
              <div className="flex items-center justify-between gap-2 px-3 py-2 border-b border-[var(--border-color)]">
                <div className="min-w-0">
                  <div className="text-xs font-semibold text-[var(--text-primary)] truncate">AI prompt</div>
                  {nanoBananaTarget && (
                    <div className="text-[10px] text-[var(--text-tertiary)] truncate">
                      {formatDate(nanoBananaTarget.date)} · slice {nanoBananaTarget.instanceIndex + 1}
                    </div>
                  )}
                </div>
                <div className="flex items-center gap-1">
                  <button
                    type="button"
                    onClick={() => setAiPromptOpen(false)}
                    className="px-2 py-1 rounded text-[10px] bg-[var(--bg-tertiary)] hover:bg-[var(--border-color)] text-[var(--text-secondary)]"
                    title="Close"
                  >
                    Close
                  </button>
                </div>
              </div>
              <div className="px-3 py-3 max-h-[60vh] overflow-auto">
                <pre className="text-xs text-[var(--text-secondary)] whitespace-pre-wrap">{nanoBananaPrompt}</pre>

                {nanoBananaTimings.length > 0 && (
                  <div className="mt-3 pt-3 border-t border-[var(--border-color)]">
                    <div className="text-[10px] font-semibold text-[var(--text-primary)]">Timing breakdown</div>
                    <div className="mt-1 space-y-1">
                      {nanoBananaTimings.map((t, i) => (
                        <div key={`${t.name}-${i}`} className="flex items-start justify-between gap-2 text-[10px]">
                          <div className="min-w-0 text-[var(--text-secondary)] truncate">{t.name}</div>
                          <div className="flex items-start gap-2 shrink-0">
                            <div className="text-[var(--text-primary)] tabular-nums">{formatMs(t.ms)}</div>
                            {t.detail && (
                              <div className="text-[var(--text-tertiary)] max-w-[180px] truncate" title={t.detail}>
                                {t.detail}
                              </div>
                            )}
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                <div className="mt-2 text-[10px] text-[var(--text-tertiary)]">
                  Not persisted — temporary and clears when you navigate slices.
                </div>
              </div>
            </div>
          )}

          {/* AI error panel */}
          {AI_ENABLED && nanoBananaStatus === 'error' && nanoBananaError && (
            <div className="absolute bottom-3 right-3 z-30 w-[420px] max-w-[calc(100%-24px)] rounded-xl border border-[var(--border-color)] bg-[var(--bg-secondary)] shadow-2xl">
              <div className="flex items-center justify-between gap-2 px-3 py-2 border-b border-[var(--border-color)]">
                <div className="text-xs font-semibold text-red-400">AI annotation failed</div>
                <button
                  type="button"
                  onClick={clearNanoBanana}
                  className="px-2 py-1 rounded text-[10px] bg-[var(--bg-tertiary)] hover:bg-[var(--border-color)] text-[var(--text-secondary)]"
                  title="Dismiss"
                >
                  Dismiss
                </button>
              </div>
              <div className="px-3 py-3 max-h-[50vh] overflow-auto">
                <pre className="text-xs text-[var(--text-secondary)] whitespace-pre-wrap">{nanoBananaError}</pre>

                {nanoBananaTimings.length > 0 && (
                  <div className="mt-3 pt-3 border-t border-[var(--border-color)]">
                    <div className="text-[10px] font-semibold text-[var(--text-primary)]">Timing breakdown</div>
                    <div className="mt-1 space-y-1">
                      {nanoBananaTimings.map((t, i) => (
                        <div key={`${t.name}-${i}`} className="flex items-start justify-between gap-2 text-[10px]">
                          <div className="min-w-0 text-[var(--text-secondary)] truncate">{t.name}</div>
                          <div className="flex items-start gap-2 shrink-0">
                            <div className="text-[var(--text-primary)] tabular-nums">{formatMs(t.ms)}</div>
                            {t.detail && (
                              <div className="text-[var(--text-tertiary)] max-w-[180px] truncate" title={t.detail}>
                                {t.detail}
                              </div>
                            )}
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            </div>
          )}
        </div>

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
      </div>

      {/* Slice navigator with loop + speed controls */}
      <SliceLoopNavigator
        selectedSeqId={selectedSeqId}
        playbackInstanceCount={playbackInstanceCount}
        progress={progress}
        progressRef={progressRef}
        setProgress={setProgressWithClearAi}
      />
    </div>
  );
}
