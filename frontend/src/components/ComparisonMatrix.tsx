import { createRef, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { SequenceCombo, SeriesRef } from '../types/api';
import { formatDate } from '../utils/format';
import { Brain, Layers, CalendarDays, ChevronLeft, ChevronRight, LayoutGrid, Play, Pause, HelpCircle } from 'lucide-react';
import { DicomViewer, type DicomViewerHandle } from './DicomViewer';
import { ImageControls } from './ImageControls';
import { HelpModal } from './HelpModal';
import { TooltipTrigger } from './TooltipTrigger';
import { useComparisonData } from '../hooks/useComparisonData';
import { useComparisonFilters } from '../hooks/useComparisonFilters';
import { usePanelSettings } from '../hooks/usePanelSettings';
import { useOverlayNavigation } from '../hooks/useOverlayNavigation';
import { useGridLayout } from '../hooks/useGridLayout';
import { getSequenceTooltip, formatSequenceLabel } from '../utils/clinicalData';
import { runAcpAnnotateClient } from '../utils/aiClient';
import { blobToBase64Data } from '../utils/base64';
import { DEFAULT_PANEL_SETTINGS, CONTROL_LIMITS, OVERLAY } from '../utils/constants';

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value));
}

function clampInt(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, Math.trunc(value)));
}

function getSliceIndex(instanceCount: number, progress: number, offset: number) {
  const max = Math.max(0, instanceCount - 1);
  const base = max > 0 ? Math.round(clamp(progress, 0, 1) * max) : 0;
  return clampInt(base + offset, 0, max);
}

function getProgressFromSliceIndex(instanceIndex: number, instanceCount: number, offset: number) {
  const denom = Math.max(1, instanceCount - 1);
  return clamp((instanceIndex - offset) / denom, 0, 1);
}

function getOverlayViewerSize(gridSize: { width: number; height: number }) {
  // Fill available space while leaving room for the top strip.
  const maxSize = Math.min(Math.max(0, gridSize.width - 48), Math.max(0, gridSize.height - 120));
  return Math.max(300, maxSize);
}


export function ComparisonMatrix() {
  const { data, loading, error } = useComparisonData();
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

  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [rightSidebarOpen, setRightSidebarOpen] = useState(true);
  const [helpOpen, setHelpOpen] = useState(false);

  const [nanoBananaStatus, setNanoBananaStatus] = useState<'idle' | 'loading' | 'ready' | 'error'>('idle');
  const [nanoBananaProgressText, setNanoBananaProgressText] = useState<string | null>(null);
  const [nanoBananaImageUrl, setNanoBananaImageUrl] = useState<string | null>(null);
  const [nanoBananaPrompt, setNanoBananaPrompt] = useState<string | null>(null);
  const [nanoBananaError, setNanoBananaError] = useState<string | null>(null);
  const [nanoBananaTarget, setNanoBananaTarget] = useState<{
    date: string;
    studyId: string;
    seriesUid: string;
    instanceIndex: number;
  } | null>(null);
  const isNanoTarget = useCallback(
    (date?: string | null, seriesUid?: string | null, instanceIndex?: number | null) =>
      !!nanoBananaTarget &&
      nanoBananaTarget.date === date &&
      nanoBananaTarget.seriesUid === seriesUid &&
      nanoBananaTarget.instanceIndex === instanceIndex,
    [nanoBananaTarget]
  );

  // Prompt panel is shown/hidden via the AI button; it doesn't affect layout.
  const [aiPromptOpen, setAiPromptOpen] = useState(false);

  const nanoBananaRequestIdRef = useRef(0);

  // Map of viewer refs so we can snapshot exactly what's visible in a specific cell.
  const viewerRefsRef = useRef(new Map<string, React.RefObject<DicomViewerHandle | null>>());
  const getViewerRef = (key: string) => {
    const existing = viewerRefsRef.current.get(key);
    if (existing) return existing;
    const created = createRef<DicomViewerHandle>();
    viewerRefsRef.current.set(key, created);
    return created;
  };

  const clearNanoBanana = useCallback(() => {
    // Cancel any in-flight requests so they don't set state / leak object URLs after close.
    nanoBananaRequestIdRef.current += 1;

    setAiPromptOpen(false);
    setNanoBananaStatus('idle');
    setNanoBananaProgressText(null);
    setNanoBananaError(null);
    setNanoBananaTarget(null);
    setNanoBananaPrompt(null);
    setNanoBananaImageUrl((prev) => {
      if (prev) URL.revokeObjectURL(prev);
      return null;
    });
  }, []);

  const runNanoBananaAcpAnalysis = async (
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
    const requestId = nanoBananaRequestIdRef.current + 1;
    nanoBananaRequestIdRef.current = requestId;

    const setProgress = (text: string | null) => {
      if (nanoBananaRequestIdRef.current !== requestId) {
        return;
      }
      setNanoBananaProgressText(text);
    };

    setAiPromptOpen(false);
    setNanoBananaStatus('loading');
    setProgress('Capturing viewport…');
    setNanoBananaError(null);
    setNanoBananaTarget(target);
    setNanoBananaPrompt(null);
    setNanoBananaImageUrl((prev) => {
      if (prev) URL.revokeObjectURL(prev);
      return null;
    });

    try {
      const viewerHandle = viewerRefsRef.current.get(viewerKey)?.current;
      if (!viewerHandle) {
        throw new Error('AI capture unavailable (viewer not mounted)');
      }

      // Capture exactly what's visible in the viewer (zoom/rotation/pan + brightness/contrast + crop).
      const captureBlob = await viewerHandle.captureVisiblePng({ maxSize: 512 });

      // If the request was cleared/cancelled or a new request started while we were waiting, discard.
      if (nanoBananaRequestIdRef.current !== requestId) {
        return;
      }

      setProgress('Encoding image…');
      const captureBase64 = await blobToBase64Data(captureBlob);

      if (nanoBananaRequestIdRef.current !== requestId) {
        return;
      }

      setProgress('Preparing prompts…');
      const result = await runAcpAnnotateClient({
        imageBase64: captureBase64,
        imageMimeType: captureBlob.type || 'image/png',
        seriesContext,
        onProgress: (text) => setProgress(text),
      });

      // If the request was cleared/cancelled or a new request started while we were waiting, discard.
      if (nanoBananaRequestIdRef.current !== requestId) {
        return;
      }

      setProgress('Finalizing…');
      const url = URL.createObjectURL(result.blob);
      setNanoBananaImageUrl(url);
      setNanoBananaPrompt(result.nanoBananaPrompt);
      setNanoBananaStatus('ready');
      setProgress(null);
    } catch (e) {
      if (nanoBananaRequestIdRef.current !== requestId) {
        return;
      }
      const message = e instanceof Error ? e.message : String(e);
      setNanoBananaError(message);
      setNanoBananaStatus('error');
      setProgress(null);
    }
  };

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
      setAiPromptOpen((prev) => !prev);
      return;
    }

    setAiPromptOpen(false);
    runNanoBananaAcpAnalysis(target, viewerKey, seriesContext);
  };

  // Cleanup on unmount.
  useEffect(() => {
    return () => {
      clearNanoBanana();
    };
  }, [clearNanoBanana]);

  // Custom hooks
  const { panelSettings, progress, setProgress, updatePanelSetting } = usePanelSettings(selectedSeqId, enabledDatesKey);

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
    containerRef: gridContainerRef,
    cols: gridCols,
    cellSize: gridCellSize,
    gridSize,
  } = useGridLayout(columns.length);
  const {
    viewMode,
    setViewMode,
    overlayDateIndex,
    setOverlayDateIndex,
    displayedOverlayIndex,
    isPlaying,
    setIsPlaying,
    playSpeed,
    setPlaySpeed,
  } = useOverlayNavigation(overlayColumns);

  const setProgressWithClearAi = useCallback(
    (nextProgress: number) => {
      if (nanoBananaStatus !== 'idle') {
        clearNanoBanana();
      }
      setProgress(nextProgress);
    },
    [nanoBananaStatus, clearNanoBanana, setProgress]
  );

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

  if (error || !data || !selectedPlane || !selectedSeqId) {
    return (
      <div className="h-screen flex items-center justify-center text-[var(--text-secondary)]">
        {error || 'No data available'}
      </div>
    );
  }

  const selectedSeq = data.sequences.find(s => s.id === selectedSeqId);

  const aiSeriesContext = {
    plane: selectedSeq?.plane ?? selectedPlane,
    weight: selectedSeq?.weight,
    sequence: selectedSeq?.sequence,
    label: selectedSeq ? formatSequenceLabel(selectedSeq) : selectedPlane,
  };

  const overlayControlCol = overlayColumns[overlayDateIndex];
  const overlayControlRef = overlayControlCol?.ref;
  const overlayControlDate = overlayControlCol?.date;
  const overlayControlSettings = overlayControlDate
    ? panelSettings.get(overlayControlDate) || DEFAULT_PANEL_SETTINGS
    : DEFAULT_PANEL_SETTINGS;
  const overlayControlSliceIndex = overlayControlRef
    ? getSliceIndex(overlayControlRef.instance_count, progress, overlayControlSettings.offset)
    : 0;

  const overlayDisplayedCol = overlayColumns[displayedOverlayIndex];
  const overlayDisplayedRef = overlayDisplayedCol?.ref;
  const overlayDisplayedDate = overlayDisplayedCol?.date;
  const overlayDisplayedSettings = overlayDisplayedDate
    ? panelSettings.get(overlayDisplayedDate) || DEFAULT_PANEL_SETTINGS
    : DEFAULT_PANEL_SETTINGS;
  const overlayDisplayedSliceIndex = overlayDisplayedRef
    ? getSliceIndex(overlayDisplayedRef.instance_count, progress, overlayDisplayedSettings.offset)
    : 0;

  const overlayIsNanoBananaTarget =
    !!nanoBananaTarget &&
    !!overlayDisplayedRef &&
    !!overlayDisplayedDate &&
    nanoBananaTarget.date === overlayDisplayedDate &&
    nanoBananaTarget.seriesUid === overlayDisplayedRef.series_uid &&
    nanoBananaTarget.instanceIndex === overlayDisplayedSliceIndex;

  const overlayNanoBananaOverrideUrl =
    nanoBananaStatus === 'ready' && nanoBananaImageUrl && overlayIsNanoBananaTarget
      ? nanoBananaImageUrl
      : undefined;

  const overlayViewerSize = getOverlayViewerSize(gridSize);

  return (
    <div className="h-screen flex flex-col">
      {/* Help Modal */}
      {helpOpen && <HelpModal onClose={() => setHelpOpen(false)} />}


      {/* Header */}
      <div className="px-4 py-3 bg-[var(--bg-secondary)] border-b border-[var(--border-color)] flex items-center justify-between">
        <div className="flex items-center gap-3">
          <Brain className="w-6 h-6 text-[var(--accent)]" />
          <h1 className="text-lg font-semibold">MiraViewer</h1>
          {selectedSeq && (
            <div className="text-sm text-[var(--text-secondary)] border-l border-[var(--border-color)] pl-3 ml-1">
              {selectedPlane} · {formatSequenceLabel(selectedSeq)}
            </div>
          )}
        </div>
        <div className="flex items-center gap-3">
          {/* View mode toggle */}
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
          
          {/* Help button */}
          <button
            onClick={() => setHelpOpen(true)}
            className="p-2 rounded-lg hover:bg-[var(--bg-tertiary)] text-[var(--text-secondary)] hover:text-[var(--text-primary)]"
            title="Help & keyboard shortcuts"
          >
            <HelpCircle className="w-5 h-5" />
          </button>
        </div>
      </div>

      {/* Main area with sidebar */}
      <div className="flex-1 flex overflow-hidden relative">
        {/* Collapsible sidebar */}
        <div
          className={`flex-shrink-0 bg-[var(--bg-secondary)] border-r border-[var(--border-color)] transition-all duration-200 ease-in-out overflow-hidden ${sidebarOpen ? 'w-64' : 'w-0'}`}
        >
          <div className="w-64 h-full overflow-y-auto p-4 space-y-6">
            {/* Plane selector */}
            <div>
              <div className="text-xs uppercase font-semibold text-[var(--text-secondary)] mb-3 flex items-center gap-2">
                <Layers className="w-4 h-4" />Plane
              </div>
              <div className="grid grid-cols-2 gap-1">
                {availablePlanes.map(p => (
                  <button
                    key={p}
                    onClick={() => selectPlane(p)}
                    className={`text-left px-2 py-1.5 rounded-lg text-sm transition-colors truncate ${selectedPlane === p ? 'bg-[var(--accent)] text-white' : 'hover:bg-[var(--bg-tertiary)] text-[var(--text-primary)]'}`}
                  >
                    {p}
                  </button>
                ))}
              </div>
            </div>

            {/* Sequence selector */}
            <div>
              <div className="text-xs uppercase font-semibold text-[var(--text-secondary)] mb-3">Sequence</div>
              <div className="grid grid-cols-2 gap-1">
                {sequencesForPlane.map(seq => {
                  const hasData = sequencesWithDataForDates.has(seq.id);
                  const isSelected = selectedSeqId === seq.id;
                  const tooltipText = getSequenceTooltip(seq.weight, seq.sequence) + (hasData ? '' : '\n\n⚠️ No data for selected dates');
                  return (
                    <TooltipTrigger
                      key={seq.id}
                      content={tooltipText}
                      onClick={() => selectSequence(seq.id)}
                      className={`text-left px-2 py-1.5 rounded-lg text-sm transition-colors truncate cursor-pointer ${isSelected ? (hasData ? 'bg-[var(--accent)] text-white' : 'bg-[var(--accent)] text-white opacity-50') : hasData ? 'hover:bg-[var(--bg-tertiary)] text-[var(--text-primary)]' : 'text-[var(--text-tertiary)] opacity-50'}`}
                    >
                      {formatSequenceLabel(seq)}
                    </TooltipTrigger>
                  );
                })}
              </div>
            </div>

          </div>
        </div>

        {/* Left sidebar toggle (compact) */}
        <button
          onClick={() => setSidebarOpen(!sidebarOpen)}
          className="absolute left-2 top-1/2 -translate-y-1/2 z-20 p-1 rounded-full bg-[var(--bg-tertiary)] border border-[var(--border-color)] text-[var(--text-secondary)] hover:bg-[var(--border-color)]"
          title={sidebarOpen ? 'Hide filters' : 'Show filters'}
        >
          {sidebarOpen ? <ChevronLeft className="w-4 h-4" /> : <ChevronRight className="w-4 h-4" />}
        </button>

        {/* Main content area - Grid or Overlay */}
        <div ref={gridContainerRef} className="flex-1 overflow-hidden bg-black flex flex-col relative">
          {viewMode === 'grid' ? (
            /* Grid View */
            <div className="flex-1 flex items-center justify-center">
              <div 
                className="grid gap-2"
                style={{ 
                  gridTemplateColumns: `repeat(${gridCols}, ${gridCellSize}px)`,
                  gridAutoRows: `${gridCellSize + 32}px`, // +32 for header
                }}
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
                  const viewerKey = `grid:${date}`;

                  const isNanoBananaTarget = isNanoTarget(date, ref.series_uid, idx);

                  const nanoBananaOverrideUrl =
                    nanoBananaStatus === 'ready' && nanoBananaImageUrl && isNanoBananaTarget
                      ? nanoBananaImageUrl
                      : undefined;

                  return (
                    <div 
                      key={date} 
                      className="relative flex flex-col rounded-lg overflow-hidden border border-[var(--border-color)]"
                    >
                      {/* Header with controls */}
                      <div className="px-2 py-1 text-xs bg-[var(--bg-secondary)] border-b border-[var(--border-color)] flex justify-between items-center">
                        <span className="text-[var(--text-secondary)] truncate">{formatDate(date)}</span>
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
                          onAcpAnalyze={() =>
                            handleAiButtonClick(
                              {
                                date,
                                studyId: ref.study_id,
                                seriesUid: ref.series_uid,
                                instanceIndex: idx,
                              },
                              viewerKey,
                              aiSeriesContext
                            )
                          }
                          acpAnalyzeDisabled={nanoBananaStatus === 'loading'}
                        />
                      </div>
                      <div className="flex-1 min-h-0 bg-black relative">
                        <DicomViewer
                          ref={getViewerRef(viewerKey)}
                          studyId={ref.study_id}
                          seriesUid={ref.series_uid}
                          instanceIndex={idx}
                          instanceCount={ref.instance_count}
                          imageUrlOverride={nanoBananaOverrideUrl}
                          onInstanceChange={(i) => {
                            // When scrolling on a panel, update the global progress.
                            setProgressWithClearAi(getProgressFromSliceIndex(i, ref.instance_count, settings.offset));
                          }}
                          brightness={nanoBananaOverrideUrl ? 100 : settings.brightness}
                          contrast={nanoBananaOverrideUrl ? 100 : settings.contrast}
                          zoom={nanoBananaOverrideUrl ? 1 : settings.zoom}
                          rotation={nanoBananaOverrideUrl ? 0 : settings.rotation}
                          panX={nanoBananaOverrideUrl ? 0 : settings.panX}
                          panY={nanoBananaOverrideUrl ? 0 : settings.panY}
                          onPanChange={
                            nanoBananaOverrideUrl
                              ? undefined
                              : (newPanX, newPanY) => {
                                  updatePanelSetting(date, { panX: newPanX, panY: newPanY });
                                }
                          }
                        />

                        {nanoBananaStatus === 'loading' && isNanoBananaTarget && (
                          <div className="absolute top-2 right-2 max-w-[70%]">
                            <div className="flex items-center gap-2 px-2 py-1 rounded bg-black/60">
                              <div className="w-5 h-5 border-2 border-[var(--accent)] border-t-transparent rounded-full animate-spin" />
                              <div className="text-[10px] text-white/90 truncate">
                                {nanoBananaProgressText || 'Working…'}
                              </div>
                            </div>
                          </div>
                        )}

                        {nanoBananaStatus === 'ready' && isNanoBananaTarget && (
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
            <div className="flex-1 flex flex-col">
              {/* Date selector strip */}
              <div className="flex-shrink-0 px-4 py-2 bg-[var(--bg-secondary)] border-b border-[var(--border-color)] flex items-center gap-4">
                {/* Play/Pause button */}
                <button
                  onClick={() => setIsPlaying(!isPlaying)}
                  className={`p-2 rounded-lg transition-colors focus:outline-none ${isPlaying ? 'bg-[var(--accent)] text-white' : 'bg-[var(--bg-primary)] text-[var(--text-secondary)] hover:text-[var(--text-primary)]'}`}
                  title={isPlaying ? 'Pause' : 'Play'}
                >
                  {isPlaying ? <Pause className="w-4 h-4" /> : <Play className="w-4 h-4" />}
                </button>
                
                {/* Speed control */}
                <div className="flex items-center gap-2">
                  <span className="text-xs text-[var(--text-secondary)]">Speed:</span>
                  <select
                    value={playSpeed}
                    onChange={(e) => setPlaySpeed(parseInt(e.target.value, 10))}
                    className="px-2 py-1 text-xs bg-[var(--bg-primary)] border border-[var(--border-color)] rounded text-[var(--text-primary)]"
                  >
                    {OVERLAY.PLAY_SPEEDS.map(s => (
                      <option key={s.value} value={s.value}>{s.label}</option>
                    ))}
                  </select>
                </div>
                
                <div className="w-px h-6 bg-[var(--border-color)]" />
                
              {/* Date buttons */}
              <div className="flex items-center gap-1 flex-1 overflow-x-auto">
                {overlayColumns.map((col, idx) => (
                  <button
                    key={col.date}
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={() => {
                      setOverlayDateIndex(idx);
                      setIsPlaying(false);
                    }}
                    className={`px-3 py-1.5 rounded-lg text-sm whitespace-nowrap transition-colors flex items-center gap-2 focus:outline-none ${idx === overlayDateIndex ? 'bg-[var(--accent)] text-white' : 'bg-[var(--bg-primary)] text-[var(--text-secondary)] hover:text-[var(--text-primary)]'}`}
                  >
                    <span className="w-5 h-5 rounded bg-black/20 flex items-center justify-center text-xs font-mono">
                      {idx + 1}
                    </span>
                    {formatDate(col.date)}
                  </button>
                ))}
              </div>
              
              {/* Image adjustment controls for current date */}
              {overlayControlRef && overlayControlDate && (
                <div className="flex items-center flex-shrink-0 bg-[var(--bg-primary)] rounded-lg px-2 py-1">
                  <ImageControls
                    settings={overlayControlSettings}
                    instanceIndex={overlayControlSliceIndex}
                    instanceCount={overlayControlRef.instance_count}
                    onUpdate={(update) => {
                      const isOverlayTarget =
                        nanoBananaStatus !== 'idle' &&
                        isNanoTarget(overlayControlDate, overlayControlRef.series_uid, overlayControlSliceIndex);

                      if (isOverlayTarget) {
                        clearNanoBanana();
                      }

                      updatePanelSetting(overlayControlDate, update);
                    }}
                    onAcpAnalyze={() => {
                      if (!overlayDisplayedRef || !overlayDisplayedDate) return;
                      handleAiButtonClick(
                        {
                          date: overlayDisplayedDate,
                          studyId: overlayDisplayedRef.study_id,
                          seriesUid: overlayDisplayedRef.series_uid,
                          instanceIndex: overlayDisplayedSliceIndex,
                        },
                        'overlay',
                        aiSeriesContext
                      );
                    }}
                    acpAnalyzeDisabled={nanoBananaStatus === 'loading'}
                  />
                </div>
              )}
              </div>
              
              {/* Single large viewer */}
              <div className="flex-1 flex items-center justify-center p-4">
                {overlayColumns.length === 0 ? (
                  <div className="text-[var(--text-secondary)]">Select dates to view</div>
                ) : overlayDisplayedRef && overlayDisplayedDate ? (
                  <div
                    className="relative rounded-lg overflow-hidden border border-[var(--border-color)]"
                    style={{ width: overlayViewerSize, height: overlayViewerSize }}
                  >
                    <DicomViewer
                      ref={getViewerRef('overlay')}
                      key={`${overlayDisplayedRef.study_id}-${overlayDisplayedRef.series_uid}`}
                      studyId={overlayDisplayedRef.study_id}
                      seriesUid={overlayDisplayedRef.series_uid}
                      instanceIndex={overlayDisplayedSliceIndex}
                      instanceCount={overlayDisplayedRef.instance_count}
                      imageUrlOverride={overlayNanoBananaOverrideUrl}
                      onInstanceChange={(i) => {
                        setProgressWithClearAi(
                          getProgressFromSliceIndex(
                            i,
                            overlayDisplayedRef.instance_count,
                            overlayDisplayedSettings.offset
                          )
                        );
                      }}
                      brightness={overlayNanoBananaOverrideUrl ? 100 : overlayDisplayedSettings.brightness}
                      contrast={overlayNanoBananaOverrideUrl ? 100 : overlayDisplayedSettings.contrast}
                      zoom={overlayNanoBananaOverrideUrl ? 1 : overlayDisplayedSettings.zoom}
                      rotation={overlayNanoBananaOverrideUrl ? 0 : overlayDisplayedSettings.rotation}
                      panX={overlayNanoBananaOverrideUrl ? 0 : overlayDisplayedSettings.panX}
                      panY={overlayNanoBananaOverrideUrl ? 0 : overlayDisplayedSettings.panY}
                      onPanChange={
                        overlayNanoBananaOverrideUrl
                          ? undefined
                          : (newPanX, newPanY) => {
                              updatePanelSetting(overlayDisplayedDate, { panX: newPanX, panY: newPanY });
                            }
                      }
                    />

                    {nanoBananaStatus === 'loading' && overlayIsNanoBananaTarget && (
                      <div className="absolute top-3 right-3 max-w-[70%]">
                        <div className="flex items-center gap-2 px-3 py-2 rounded bg-black/60">
                          <div className="w-6 h-6 border-2 border-[var(--accent)] border-t-transparent rounded-full animate-spin" />
                          <div className="text-xs text-white/90 truncate">
                            {nanoBananaProgressText || 'Working…'}
                          </div>
                        </div>
                      </div>
                    )}

                    {nanoBananaStatus === 'ready' && overlayIsNanoBananaTarget && (
                      <button
                        type="button"
                        onClick={clearNanoBanana}
                        className="absolute top-3 right-3 px-3 py-1.5 rounded bg-black/70 text-white text-xs hover:bg-black/80"
                        title="Clear AI annotation"
                      >
                        Clear AI
                      </button>
                    )}

                    {/* Date overlay */}
                    <div className="absolute bottom-4 left-4 px-3 py-2 bg-black/70 rounded-lg text-white text-sm font-medium">
                      {formatDate(overlayDisplayedDate)}
                    </div>
                  </div>
                ) : (
                  <div className="text-[var(--text-secondary)]">No data</div>
                )}
              </div>
            </div>
          )}

          {/* AI prompt panel (shown on AI button click; does not affect layout) */}
          {aiPromptOpen && nanoBananaStatus === 'ready' && nanoBananaPrompt && (
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
                <div className="mt-2 text-[10px] text-[var(--text-tertiary)]">
                  Not persisted — temporary and clears when you navigate slices.
                </div>
              </div>
            </div>
          )}

          {/* AI error panel */}
          {nanoBananaStatus === 'error' && nanoBananaError && (
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
              </div>
            </div>
          )}
        </div>

        {/* Right sidebar toggle (compact) */}
        <button
          onClick={() => setRightSidebarOpen(!rightSidebarOpen)}
          className="absolute right-2 top-1/2 -translate-y-1/2 z-20 p-1 rounded-full bg-[var(--bg-tertiary)] border border-[var(--border-color)] text-[var(--text-secondary)] hover:bg-[var(--border-color)]"
          title={rightSidebarOpen ? 'Hide dates' : 'Show dates'}
        >
          {rightSidebarOpen ? <ChevronRight className="w-4 h-4" /> : <ChevronLeft className="w-4 h-4" />}
        </button>

        {/* Right sidebar - Dates */}
        <div
          className={`flex-shrink-0 bg-[var(--bg-secondary)] border-l border-[var(--border-color)] transition-all duration-200 ease-in-out overflow-hidden ${rightSidebarOpen ? 'w-56' : 'w-0'}`}
        >
          <div className="w-56 h-full overflow-y-auto p-4">
            <div className="text-xs uppercase font-semibold text-[var(--text-secondary)] mb-3 flex items-center justify-between">
              <div className="flex items-center gap-2">
                <CalendarDays className="w-4 h-4" />Dates
              </div>
              <div className="flex gap-1">
                <button
                  onClick={selectAllDates}
                  className="px-1.5 py-0.5 text-[10px] rounded bg-[var(--bg-tertiary)] hover:bg-[var(--border-color)] text-[var(--text-secondary)]"
                  title="Select all dates"
                >
                  All
                </button>
                <button
                  onClick={selectNoDates}
                  className="px-1.5 py-0.5 text-[10px] rounded bg-[var(--bg-tertiary)] hover:bg-[var(--border-color)] text-[var(--text-secondary)]"
                  title="Deselect all dates"
                >
                  None
                </button>
              </div>
            </div>
            <div className="space-y-1">
              {sortedDates.map(d => {
                const enabled = enabledDates.has(d);
                const hasData = datesWithDataForSequence.has(d);
                return (
                  <button
                    key={d}
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={() => toggleDate(d)}
                    className={`w-full text-left px-3 py-2 rounded-lg text-sm transition-colors flex items-center gap-2 focus:outline-none ${enabled ? (hasData ? 'bg-[var(--accent)] text-white' : 'bg-[var(--accent)] text-white opacity-50') : hasData ? 'hover:bg-[var(--bg-tertiary)] text-[var(--text-primary)]' : 'text-[var(--text-tertiary)] opacity-50'}`}
                    title={hasData ? undefined : 'No data for selected sequence'}
                  >
                    <span className={`w-4 h-4 rounded border flex items-center justify-center text-xs ${enabled ? 'bg-white text-[var(--accent)] border-white' : 'border-[var(--border-color)]'}`}>
                      {enabled && '✓'}
                    </span>
                    {formatDate(d)}
                  </button>
                );
              })}
            </div>
          </div>
        </div>
      </div>

      {/* Slice navigator */}
      <div className="px-4 py-3 bg-[var(--bg-secondary)] border-t border-[var(--border-color)] flex items-center gap-4">
        <div className="text-xs text-[var(--text-secondary)] whitespace-nowrap">Slice</div>
        <input
          type="range"
          min={0}
          max={CONTROL_LIMITS.SLICE_NAV.MAX_RANGE}
          step={1}
          value={Math.round(progress * CONTROL_LIMITS.SLICE_NAV.MAX_RANGE)}
          onChange={(e) =>
            setProgressWithClearAi(parseInt(e.target.value, 10) / CONTROL_LIMITS.SLICE_NAV.MAX_RANGE)
          }
          className="flex-1"
        />
      </div>
    </div>
  );
}
