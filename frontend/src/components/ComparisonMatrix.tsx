import { useEffect, useMemo, useState, useRef, useCallback } from 'react';
import type { ComparisonData, SequenceCombo, SeriesRef } from '../types/api';
import { fetchComparisonData, formatDate } from '../utils/api';
import { Brain, Layers, CalendarDays, ChevronLeft, ChevronRight, RotateCw } from 'lucide-react';
import { DicomViewer } from './DicomViewer';

import type { PanelSettings } from '../types/api';
import { fetchPanelSettings as apiFetchPanelSettings, savePanelSettings as apiSavePanelSettings } from '../utils/api';

const DEFAULT_PANEL_SETTINGS: PanelSettings = { offset: 0, zoom: 1, rotation: 0, progress: 0 };

function useComparison() {
  const [data, setData] = useState<ComparisonData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let mounted = true;
    (async () => {
      try {
        setLoading(true);
        const d = await fetchComparisonData();
        if (mounted) setData(d);
      } catch (e) {
        if (mounted) setError(e instanceof Error ? e.message : 'Failed to load comparison data');
      } finally {
        if (mounted) setLoading(false);
      }
    })();
    return () => { mounted = false; };
  }, []);

  return { data, loading, error };
}

function pickDefaultSequence(data: ComparisonData, plane: string): string | null {
  const seq = data.sequences.find(s => s.plane === plane) || data.sequences[0];
  return seq ? seq.id : null;
}

/** Format sequence label without plane (just weight + sequence) */
function formatSequenceLabel(seq: SequenceCombo): string {
  const parts: string[] = [];
  if (seq.weight) parts.push(seq.weight);
  if (seq.sequence) parts.push(seq.sequence);
  return parts.length > 0 ? parts.join(' ') : 'Unknown';
}

export function ComparisonMatrix() {
  const { data, loading, error } = useComparison();
  const [selectedPlane, setSelectedPlane] = useState<string | null>(null);
  const [selectedSeqId, setSelectedSeqId] = useState<string | null>(null);
  const [enabledDates, setEnabledDates] = useState<Set<string>>(new Set());
  const [progress, setProgress] = useState(0); // 0..1 normalized
  const [brightness, setBrightness] = useState(100);
  const [contrast, setContrast] = useState(100);
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [rightSidebarOpen, setRightSidebarOpen] = useState(true);
  const [gridSize, setGridSize] = useState({ width: 0, height: 0 });
  const gridContainerRef = useRef<HTMLDivElement>(null);
  
  // Per-panel settings: Map<date, PanelSettings>
  const [panelSettings, setPanelSettings] = useState<Map<string, PanelSettings>>(new Map());
  const [activePanel, setActivePanel] = useState<string | null>(null); // date of panel being adjusted
  
  // Load panel settings from backend when sequence or dates change
  useEffect(() => {
    if (!selectedSeqId) return;
    (async () => {
      try {
        const server = await apiFetchPanelSettings(selectedSeqId);
        const newSettings = new Map<string, PanelSettings>();
        enabledDates.forEach(date => {
          const s = server[date] || { ...DEFAULT_PANEL_SETTINGS };
          newSettings.set(date, { ...DEFAULT_PANEL_SETTINGS, ...s });
        });
        setPanelSettings(newSettings);
        // Set initial active panel and progress to newest enabled date
        const dates = Array.from(enabledDates).sort((a, b) => b.localeCompare(a));
        const initial = dates[0];
        if (initial) {
          setActivePanel(initial);
          const ps = newSettings.get(initial);
          if (ps && typeof ps.progress === 'number') {
            setProgress(Math.max(0, Math.min(1, ps.progress)));
          }
        }
      } catch (e) {
        // Fallback to defaults on error
        const newSettings = new Map<string, PanelSettings>();
        enabledDates.forEach(date => newSettings.set(date, { ...DEFAULT_PANEL_SETTINGS }));
        setPanelSettings(newSettings);
      }
    })();
  }, [selectedSeqId, enabledDates]);
  
  // If activePanel becomes disabled, move it to newest enabled
  useEffect(() => {
    if (!activePanel || enabledDates.has(activePanel)) return;
    const dates = Array.from(enabledDates).sort((a, b) => b.localeCompare(a));
    setActivePanel(dates[0] || null);
  }, [enabledDates, activePanel]);

  // Persist filters to localStorage
  useEffect(() => {
    if (!data || !selectedPlane || !selectedSeqId) return;
    const key = 'mira-filters-v2';
    const payload = {
      plane: selectedPlane,
      seqId: selectedSeqId,
      enabledDates: Array.from(enabledDates),
    };
    try { localStorage.setItem(key, JSON.stringify(payload)); } catch {}
  }, [data, selectedPlane, selectedSeqId, enabledDates]);

  // Debounced persistence of progress for the active panel
  useEffect(() => {
    if (!selectedSeqId || !activePanel) return;
    const handle = setTimeout(() => {
      const s = panelSettings.get(activePanel) || DEFAULT_PANEL_SETTINGS;
      updatePanelSetting(activePanel, { progress });
    }, 200);
    return () => clearTimeout(handle);
  }, [progress, activePanel, selectedSeqId]);
  
  // Update a panel's settings
  const updatePanelSetting = useCallback((date: string, update: Partial<PanelSettings>) => {
    if (!selectedSeqId) return;
    setPanelSettings(prev => {
      const current = prev.get(date) || { ...DEFAULT_PANEL_SETTINGS };
      const updated = { ...current, ...update };
      // Persist to backend (fire-and-forget)
      apiSavePanelSettings(selectedSeqId, date, updated).catch(() => {});
      const next = new Map(prev);
      next.set(date, updated);
      return next;
    });
  }, [selectedSeqId]);
  
  // Track grid container size
  useEffect(() => {
    const node = gridContainerRef.current;
    if (!node) return;
    
    const updateSize = () => {
      setGridSize({ width: node.clientWidth, height: node.clientHeight });
    };
    
    // Use setTimeout to ensure layout is complete after render
    const timeoutId = setTimeout(updateSize, 0);
    
    const observer = new ResizeObserver(updateSize);
    observer.observe(node);
    
    return () => {
      clearTimeout(timeoutId);
      observer.disconnect();
    };
  }); // Run on every render to catch when ref becomes available

  // Initialize defaults when data loads (with localStorage restore)
  useEffect(() => {
    if (!data) return;
    const key = 'mira-filters-v2';
    let restored = null as null | { plane?: string; seqId?: string; enabledDates?: string[] };
    try { restored = JSON.parse(localStorage.getItem(key) || 'null'); } catch {}

    const defaultPlane = data.planes.includes('Axial') ? 'Axial' : data.planes[0];
    let plane = restored?.plane && data.planes.includes(restored.plane) ? restored.plane : defaultPlane;

    // Validate seqId belongs to data and plane
    const seqIdsForPlane = new Set(
      data.sequences.filter(s => s.plane === plane).map(s => s.id)
    );
    let seqId = restored?.seqId && seqIdsForPlane.has(restored.seqId)
      ? restored.seqId
      : pickDefaultSequence(data, plane);

    // Dates: intersect with available
    const allDates = new Set(data.dates);
    let datesArr = (restored?.enabledDates || []).filter(d => allDates.has(d));
    if (datesArr.length === 0) {
      const ds = [...data.dates].sort();
      datesArr = ds.slice(-4);
    }

    setSelectedPlane(plane);
    setSelectedSeqId(seqId);
    setEnabledDates(new Set(datesArr));
  }, [data]);

  const sequencesForPlane = useMemo(() => {
    if (!data || !selectedPlane) return [] as SequenceCombo[];
    return data.sequences
      .filter(s => s.plane === selectedPlane)
      .sort((a, b) => formatSequenceLabel(b).localeCompare(formatSequenceLabel(a))); // reverse alpha
  }, [data, selectedPlane]);

  // Dates sorted newest first
  const sortedDates = useMemo(() => {
    if (!data) return [] as string[];
    return [...data.dates].sort((a, b) => b.localeCompare(a));
  }, [data]);

  const columns = useMemo(() => {
    if (!data || !selectedSeqId) return [] as { date: string; ref?: SeriesRef }[];
    const map = data.series_map[selectedSeqId] || {};
    // Sort by date descending (newest first) to match sidebar
    const selectedDates = [...enabledDates].sort((a, b) => b.localeCompare(a));
    return selectedDates.map(date => ({ date, ref: map[date] }));
  }, [data, selectedSeqId, enabledDates]);

  // Compute optimal grid dimensions for square cells
  const gridLayout = useMemo(() => {
    const n = columns.length;
    if (n === 0) return { cols: 1, cellSize: 300 };
    
    const { width, height } = gridSize;
    if (width === 0 || height === 0) return { cols: Math.min(n, 4), cellSize: 300 };
    
    const gap = 8; // gap-2 = 8px
    const headerHeight = 32; // approximate header height per cell

    // Reserve margins so grid isn't hugging edges
    const marginH = 24; // px on left+right total reserve is 2*marginH
    const marginV = 24; // px on top+bottom total reserve is 2*marginV
    
    const availableWidth = Math.max(0, width - 2 * marginH);
    const availableHeight = Math.max(0, height - 2 * marginV);
    
    // Try different column counts and find the one that maximizes cell size
    let bestCols = 1;
    let bestCellSize = 0;
    
    for (let cols = 1; cols <= n; cols++) {
      const rows = Math.ceil(n / cols);
      
      // Calculate max cell size for this configuration
      // Total width needed: cols * cellSize + (cols - 1) * gap <= availableWidth
      const maxCellWidth = (availableWidth - (cols - 1) * gap) / cols;
      
      // Total height needed: rows * (cellSize + headerHeight) + (rows - 1) * gap <= availableHeight
      const maxCellHeight = (availableHeight - rows * headerHeight - (rows - 1) * gap) / rows;
      
      // Cell is square, so take the minimum
      const cellSize = Math.min(maxCellWidth, maxCellHeight);
      
      if (cellSize > bestCellSize) {
        bestCellSize = cellSize;
        bestCols = cols;
      }
    }
    
    // Floor it but allow large sizes, only enforce a small minimum for edge cases
    const minCellSize = 100;
    const maxCellSize = Math.min(availableWidth, availableHeight - headerHeight); // Don't exceed viewport
    const finalSize = Math.floor(Math.max(Math.min(bestCellSize, maxCellSize), minCellSize));
    
    return { cols: bestCols, cellSize: finalSize };
  }, [columns.length, gridSize]);

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

  return (
    <div className="h-screen flex flex-col">
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
        <div className="flex items-center gap-3 text-xs text-[var(--text-secondary)]">
          <span>Scroll to navigate slices</span>
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
              <div className="space-y-1">
                {data.planes.map(p => (
                  <button
                    key={p}
                    onClick={() => { setSelectedPlane(p); setSelectedSeqId(pickDefaultSequence(data, p)); }}
                    className={`w-full text-left px-3 py-2 rounded-lg text-sm transition-colors ${selectedPlane === p ? 'bg-[var(--accent)] text-white' : 'hover:bg-[var(--bg-tertiary)] text-[var(--text-primary)]'}`}
                  >{p}</button>
                ))}
              </div>
            </div>

            {/* Sequence selector */}
            <div>
              <div className="text-xs uppercase font-semibold text-[var(--text-secondary)] mb-3">Sequence</div>
              <div className="grid grid-cols-2 gap-1">
                {sequencesForPlane.map(seq => (
                  <button
                    key={seq.id}
                    onClick={() => setSelectedSeqId(seq.id)}
                    className={`text-left px-2 py-1.5 rounded-lg text-sm transition-colors truncate ${selectedSeqId === seq.id ? 'bg-[var(--accent)] text-white' : 'hover:bg-[var(--bg-tertiary)] text-[var(--text-primary)]'}`}
                    title={formatSequenceLabel(seq)}
                  >
                    {formatSequenceLabel(seq)}
                  </button>
                ))}
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

        {/* Grid */}
        <div ref={gridContainerRef} className="flex-1 overflow-hidden bg-black flex items-center justify-center">
          <div 
            className="grid gap-2"
            style={{ 
              gridTemplateColumns: `repeat(${gridLayout.cols}, ${gridLayout.cellSize}px)`,
              gridAutoRows: `${gridLayout.cellSize + 32}px`, // +32 for header
            }}
          >
            {columns.map(({ date, ref }) => {
              const settings = panelSettings.get(date) || DEFAULT_PANEL_SETTINGS;
              const isActive = activePanel === date;
              
              if (!ref) {
                return (
                  <div key={date} className="relative flex flex-col rounded-lg overflow-hidden border border-[var(--border-color)] bg-[var(--bg-primary)]">
                    <div className="px-3 py-2 text-xs text-[var(--text-secondary)] bg-[var(--bg-secondary)] border-b border-[var(--border-color)]">{formatDate(date)}</div>
                    <div className="flex-1 flex items-center justify-center text-[var(--text-secondary)]">No series</div>
                  </div>
                );
              }
              
              // Calculate slice index with offset
              const baseIdx = ref.instance_count > 1 ? Math.round(progress * (ref.instance_count - 1)) : 0;
              const idx = Math.max(0, Math.min(ref.instance_count - 1, baseIdx + settings.offset));
              
              return (
                <div 
                  key={date} 
                  className={`relative flex flex-col rounded-lg overflow-hidden border-2 transition-colors ${isActive ? 'border-[var(--accent)]' : 'border-[var(--border-color)]'}`}
                  onClick={() => {
                    if (isActive) {
                      setActivePanel(null);
                    } else {
                      setActivePanel(date);
                      const ps = panelSettings.get(date);
                      if (ps && typeof ps.progress === 'number') {
                        setProgress(Math.max(0, Math.min(1, ps.progress)));
                      }
                    }
                  }}
                >
                  {/* Header with controls */}
                  <div className="px-2 py-1.5 text-xs bg-[var(--bg-secondary)] border-b border-[var(--border-color)] flex justify-between items-center gap-1">
                    <span className="text-[var(--text-secondary)] truncate">{formatDate(date)}</span>
                    <div className="flex items-center gap-1">
                      {/* Offset controls */}
                      <button
                        onClick={(e) => { e.stopPropagation(); updatePanelSetting(date, { offset: settings.offset - 1 }); }}
                        className="p-0.5 rounded hover:bg-[var(--bg-tertiary)] text-[var(--text-secondary)]"
                        title="Shift slice -1"
                      >
                        <ChevronLeft className="w-3 h-3" />
                      </button>
                      <span className="text-[var(--text-tertiary)] text-[10px] w-8 text-center" title={`Offset: ${settings.offset}`}>
                        {idx + 1}/{ref.instance_count}
                      </span>
                      <button
                        onClick={(e) => { e.stopPropagation(); updatePanelSetting(date, { offset: settings.offset + 1 }); }}
                        className="p-0.5 rounded hover:bg-[var(--bg-tertiary)] text-[var(--text-secondary)]"
                        title="Shift slice +1"
                      >
                        <ChevronRight className="w-3 h-3" />
                      </button>
                      <div className="w-px h-3 bg-[var(--border-color)] mx-0.5" />
                      {/* Zoom input */}
                      <div className="flex items-center gap-0.5">
                        <input
                          type="number"
                          min={10}
                          max={1000}
                          step={1}
                          value={Math.round(settings.zoom * 100)}
                          onChange={(e) => { updatePanelSetting(date, { zoom: Math.max(0.1, Math.min(10, parseInt(e.target.value, 10) / 100 || 1)) }); }}
                          onClick={(e) => e.stopPropagation()}
                          className="w-12 px-1 py-0.5 text-[10px] text-center bg-[var(--bg-primary)] border border-[var(--border-color)] rounded text-[var(--text-primary)]"
                          title="Zoom %"
                        />
                        <span className="text-[var(--text-tertiary)] text-[10px]">%</span>
                      </div>
                      {/* Rotation input */}
                      <div className="flex items-center gap-0.5">
                        <input
                          type="number"
                          min={-360}
                          max={360}
                          step={1}
                          value={settings.rotation}
                          onChange={(e) => { updatePanelSetting(date, { rotation: ((parseInt(e.target.value, 10) || 0) % 360 + 360) % 360 }); }}
                          onClick={(e) => e.stopPropagation()}
                          className="w-10 px-1 py-0.5 text-[10px] text-center bg-[var(--bg-primary)] border border-[var(--border-color)] rounded text-[var(--text-primary)]"
                          title="Rotation °"
                        />
                        <span className="text-[var(--text-tertiary)] text-[10px]">°</span>
                      </div>
                      {/* Reset */}
                      {(settings.offset !== 0 || settings.zoom !== 1 || settings.rotation !== 0) && (
                        <button
                          onClick={(e) => { e.stopPropagation(); updatePanelSetting(date, { offset: 0, zoom: 1, rotation: 0 }); }}
                          className="p-0.5 rounded hover:bg-[var(--bg-tertiary)] text-[var(--accent)] text-[10px]"
                          title="Reset"
                        >
                          ✕
                        </button>
                      )}
                    </div>
                  </div>
                  <div className="flex-1 min-h-0 bg-black">
                    <DicomViewer
                      studyId={ref.study_id}
                      seriesUid={ref.series_uid}
                      instanceIndex={idx}
                      instanceCount={ref.instance_count}
                      onInstanceChange={(i) => {
                        // When scrolling on a panel, update the global progress
                        const denom = Math.max(1, ref.instance_count - 1);
                        // Adjust for offset: new progress = (i - settings.offset) / denom
                        const newProgress = Math.max(0, Math.min(1, (i - settings.offset) / denom));
                        setProgress(newProgress);
                      }}
                      brightness={brightness}
                      contrast={contrast}
                      zoom={settings.zoom}
                      rotation={settings.rotation}
                    />
                  </div>
                </div>
              );
            })}
            {columns.length === 0 && (
              <div className="h-full flex items-center justify-center text-[var(--text-secondary)]">Select dates to view</div>
            )}
          </div>
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
            <div className="text-xs uppercase font-semibold text-[var(--text-secondary)] mb-3 flex items-center gap-2">
              <CalendarDays className="w-4 h-4" />Dates
            </div>
            <div className="space-y-1">
              {sortedDates.map(d => {
                const enabled = enabledDates.has(d);
                return (
                  <button
                    key={d}
                    onClick={() => {
                      const next = new Set(enabledDates);
                      if (enabled) next.delete(d); else next.add(d);
                      setEnabledDates(next);
                    }}
                    className={`w-full text-left px-3 py-2 rounded-lg text-sm transition-colors flex items-center gap-2 ${enabled ? 'bg-[var(--accent)] text-white' : 'hover:bg-[var(--bg-tertiary)] text-[var(--text-primary)]'}`}
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
          max={1000}
          step={1}
          value={Math.round(progress * 1000)}
          onChange={(e) => setProgress(parseInt(e.target.value, 10) / 1000)}
          className="flex-1"
        />
        <div className="flex items-center gap-4">
          <div className="flex items-center gap-2 text-xs text-[var(--text-secondary)]">
            <span>Brightness</span>
            <input type="range" min={0} max={200} value={brightness} onChange={(e)=>setBrightness(parseInt(e.target.value,10))} className="w-24" />
          </div>
          <div className="flex items-center gap-2 text-xs text-[var(--text-secondary)]">
            <span>Contrast</span>
            <input type="range" min={0} max={200} value={contrast} onChange={(e)=>setContrast(parseInt(e.target.value,10))} className="w-24" />
          </div>
        </div>
      </div>
    </div>
  );
}

// Persist filters to localStorage whenever they change
// This must be outside the component to avoid re-definition? We'll keep inside using another effect above.
