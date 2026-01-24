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
  MoreVertical,
  HelpCircle,
} from 'lucide-react';
import type { DicomViewerHandle } from './DicomViewer';
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
import { useAiAnnotation } from '../hooks/useAiAnnotation';
import { DEFAULT_PANEL_SETTINGS, OVERLAY, AI_ENABLED } from '../utils/constants';
import { getEffectiveInstanceIndex, getSliceIndex } from '../utils/math';
import { COMPARISON_UI_STORAGE_KEY } from '../utils/storageKeys';

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
            <div className="flex-1 flex flex-col items-center justify-center gap-8 text-center p-8 max-w-2xl mx-auto">
              <div className="p-6 rounded-full bg-[var(--bg-secondary)] border border-[var(--border-color)]">
                <Brain className="w-20 h-20 text-[var(--accent)]" />
              </div>
              
              <div className="space-y-4">
                <h2 className="text-3xl font-bold text-[var(--text-primary)] tracking-tight">
                  Welcome to MiraViewer
                </h2>
                <p className="text-lg text-[var(--text-secondary)] leading-relaxed">
                  Upload your MRI scans to visualize and compare them over time.
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
                  Load DICOM Files
                </button>
              </div>
            </div>
          ) : viewMode === 'grid' ? (
            <GridView
              columns={columns}
              gridCols={gridCols}
              gridCellSize={gridCellSize}
              panelSettings={panelSettings}
              progress={progress}
              setProgress={setProgressWithClearAi}
              updatePanelSetting={updatePanelSetting}
              overlayColumns={overlayColumns}
              isAligning={isAligning}
              alignmentProgress={alignmentProgress}
              abortAlignment={abortAlignment}
              startAlignAll={startAlignAll}
              registerViewerHandle={registerViewerHandle}
              aiSeriesContext={aiSeriesContext}
              nanoBananaStatus={nanoBananaStatus}
              nanoBananaProgressText={nanoBananaProgressText}
              nanoBananaImageUrl={nanoBananaImageUrl}
              clearNanoBanana={clearNanoBanana}
              handleAiButtonClick={handleAiButtonClick}
              isNanoTarget={isNanoTarget}
            />
          ) : (
            <OverlayView
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
              setProgress={setProgressWithClearAi}
              registerViewerHandle={registerViewerHandle}
              aiSeriesContext={aiSeriesContext}
              handleAiButtonClick={handleAiButtonClick}
              isNanoTarget={isNanoTarget}
              nanoBananaStatus={nanoBananaStatus}
              nanoBananaProgressText={nanoBananaProgressText}
              clearNanoBanana={clearNanoBanana}
              overlayIsNanoBananaTarget={overlayIsNanoBananaTarget}
              overlaySelectedNanoBananaOverrideUrl={overlaySelectedNanoBananaOverrideUrl}
              overlayCompareNanoBananaOverrideUrl={overlayCompareNanoBananaOverrideUrl}
              overlayDisplayedNanoBananaOverrideUrl={overlayDisplayedNanoBananaOverrideUrl}
            />
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
