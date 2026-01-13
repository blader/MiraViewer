import { useEffect, useMemo, useState, useRef, useCallback } from 'react';
import type { ComparisonData, SequenceCombo, SeriesRef } from '../types/api';
import { fetchComparisonData, formatDate } from '../utils/api';
import { Brain, Layers, CalendarDays, ChevronLeft, ChevronRight, LayoutGrid, Play, Pause } from 'lucide-react';
import { DicomViewer } from './DicomViewer';

// Tooltip - uses direct DOM manipulation for instant mouse tracking
const TOOLTIP_ID = 'mira-tooltip';

function getOrCreateTooltipElement(): HTMLDivElement {
  let el = document.getElementById(TOOLTIP_ID) as HTMLDivElement | null;
  if (!el) {
    el = document.createElement('div');
    el.id = TOOLTIP_ID;
    el.className = 'fixed z-50 pointer-events-none opacity-0 transition-opacity duration-150';
    el.style.maxWidth = '420px';
    el.style.maxHeight = '80vh';
    el.style.overflow = 'hidden';
    el.innerHTML = `
      <div class="bg-[var(--bg-primary)] border border-[var(--border-color)] rounded-xl shadow-2xl px-5 py-4 max-h-[80vh] overflow-y-auto">
        <p class="text-[var(--text-primary)] text-sm leading-6 whitespace-pre-wrap"></p>
      </div>
    `;
    document.body.appendChild(el);
  }
  return el;
}

function showTooltip(content: string, x: number, y: number) {
  const el = getOrCreateTooltipElement();
  const p = el.querySelector('p')!;
  p.textContent = content;
  // Position tooltip, keeping it within viewport
  const tooltipWidth = 420;
  const tooltipHeight = Math.min(el.scrollHeight, window.innerHeight * 0.8);
  el.style.left = `${Math.min(x + 8, window.innerWidth - tooltipWidth - 20)}px`;
  el.style.top = `${Math.min(y + 8, window.innerHeight - tooltipHeight - 20)}px`;
  el.classList.remove('opacity-0');
  el.classList.add('opacity-100');
}

function updateTooltipPosition(x: number, y: number) {
  const el = document.getElementById(TOOLTIP_ID);
  if (el && el.classList.contains('opacity-100')) {
    const tooltipWidth = 420;
    const tooltipHeight = Math.min(el.scrollHeight, window.innerHeight * 0.8);
    el.style.left = `${Math.min(x + 8, window.innerWidth - tooltipWidth - 20)}px`;
    el.style.top = `${Math.min(y + 8, window.innerHeight - tooltipHeight - 20)}px`;
  }
}

function hideTooltip() {
  const el = document.getElementById(TOOLTIP_ID);
  if (el) {
    el.classList.remove('opacity-100');
    el.classList.add('opacity-0');
  }
}

interface TooltipTriggerProps {
  content: string;
  children: React.ReactNode;
  className?: string;
  onClick?: () => void;
}

function TooltipTrigger({ content, children, className, onClick }: TooltipTriggerProps) {
  const timeoutRef = useRef<number | null>(null);
  
  const handleMouseEnter = useCallback((e: React.MouseEvent) => {
    if (timeoutRef.current) clearTimeout(timeoutRef.current);
    timeoutRef.current = window.setTimeout(() => {
      showTooltip(content, e.clientX, e.clientY);
    }, 150);
  }, [content]);
  
  const handleMouseMove = useCallback((e: React.MouseEvent) => {
    updateTooltipPosition(e.clientX, e.clientY);
  }, []);
  
  const handleMouseLeave = useCallback(() => {
    if (timeoutRef.current) clearTimeout(timeoutRef.current);
    hideTooltip();
  }, []);
  
  useEffect(() => {
    return () => {
      if (timeoutRef.current) clearTimeout(timeoutRef.current);
      hideTooltip();
    };
  }, []);
  
  return (
    <div
      className={className}
      onMouseEnter={handleMouseEnter}
      onMouseMove={handleMouseMove}
      onMouseLeave={handleMouseLeave}
      onClick={onClick}
    >
      {children}
    </div>
  );
}

import type { PanelSettings } from '../types/api';
import { fetchPanelSettings as apiFetchPanelSettings, savePanelSettings as apiSavePanelSettings } from '../utils/api';

/** Button that repeats action while held, with acceleration */
interface RepeatButtonProps {
  onAction: () => void;
  className?: string;
  title?: string;
  children: React.ReactNode;
  onClick?: (e: React.MouseEvent) => void;
}

function RepeatButton({ onAction, className, title, children, onClick }: RepeatButtonProps) {
  const intervalRef = useRef<number | null>(null);
  const timeoutRef = useRef<number | null>(null);
  const countRef = useRef(0);
  
  const stop = useCallback(() => {
    if (intervalRef.current) {
      clearInterval(intervalRef.current);
      intervalRef.current = null;
    }
    if (timeoutRef.current) {
      clearTimeout(timeoutRef.current);
      timeoutRef.current = null;
    }
    countRef.current = 0;
  }, []);
  
  const start = useCallback(() => {
    // Fire immediately on press
    onAction();
    countRef.current = 1;
    
    // Start repeating after initial delay
    timeoutRef.current = window.setTimeout(() => {
      // Start with slow interval, speed up over time
      const tick = () => {
        onAction();
        countRef.current++;
        
        // Calculate next interval based on count (accelerate)
        // Starts at 150ms, goes down to 30ms
        const nextInterval = Math.max(30, 150 - countRef.current * 10);
        
        if (intervalRef.current) clearInterval(intervalRef.current);
        intervalRef.current = window.setTimeout(tick, nextInterval);
      };
      tick();
    }, 300); // Initial delay before repeat starts
  }, [onAction]);
  
  useEffect(() => {
    return stop;
  }, [stop]);
  
  return (
    <button
      className={className}
      title={title}
      onMouseDown={(e) => {
        e.preventDefault();
        start();
      }}
      onMouseUp={stop}
      onMouseLeave={stop}
      onClick={onClick}
    >
      {children}
    </button>
  );
}

const DEFAULT_PANEL_SETTINGS: PanelSettings = { offset: 0, zoom: 1, rotation: 0, brightness: 100, contrast: 100, panX: 0, panY: 0, progress: 0 };

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

/** Try to find a matching sequence in the new plane based on weight/sequence type */
function findMatchingSequence(data: ComparisonData, newPlane: string, currentSeqId: string | null): string | null {
  if (!currentSeqId) return pickDefaultSequence(data, newPlane);
  
  const currentSeq = data.sequences.find(s => s.id === currentSeqId);
  if (!currentSeq) return pickDefaultSequence(data, newPlane);
  
  // Try to find a sequence in the new plane with same weight and sequence type
  const exactMatch = data.sequences.find(
    s => s.plane === newPlane && s.weight === currentSeq.weight && s.sequence === currentSeq.sequence
  );
  if (exactMatch) return exactMatch.id;
  
  // Try matching just the weight
  const weightMatch = data.sequences.find(
    s => s.plane === newPlane && s.weight === currentSeq.weight
  );
  if (weightMatch) return weightMatch.id;
  
  // Fall back to default
  return pickDefaultSequence(data, newPlane);
}

/** Format sequence label without plane (just weight + sequence) */
function formatSequenceLabel(seq: SequenceCombo): string {
  const parts: string[] = [];
  if (seq.weight) parts.push(seq.weight);
  if (seq.sequence) parts.push(seq.sequence);
  return parts.length > 0 ? parts.join(' ') : 'Unknown';
}

/** Get tooltip for sequence/weight combination focused on tumor progression */
function getSequenceTooltip(weight: string | null, sequence: string | null): string {
  const key = `${weight || ''}-${sequence || ''}`.toLowerCase();
  
  // T1-weighted sequences
  if (key.includes('t1') && key.includes('gre')) {
    return `T1 GRE (Gradient Echo)

How to read: Fat and protein-rich fluid appear bright. Water appears dark. Provides sharp anatomical detail.

In craniopharyngioma: Cysts with bright signal contain the characteristic "machine oil" fluid (cholesterol, protein, keratin). Mixed bright/dark areas indicate complex cyst contents. Dark spots are often calcium.

Tracking progression:
• Measure and compare cyst dimensions across dates
• Look for new cysts or compartments forming
• Monitor signal intensity changes - brightening may indicate increased protein content or hemorrhage
• Check if solid components are growing`;
  }
  if (key.includes('t1') && key.includes('se')) {
    return `T1 SE (Spin Echo)

How to read: Classic anatomical sequence. Bright = fat, protein, blood products. Dark = water, calcium, air. Gray/white matter contrast is excellent.

In craniopharyngioma: Look for the typical heterogeneous (patchy) appearance with multiple cysts of varying brightness. Very bright cysts = high protein or old blood. Dark spots = calcium deposits (present in 90%+ of cases).

Tracking progression:
• Compare overall tumor size and shape
• Track individual cyst sizes - measure the largest diameter
• Note changes in cyst signal intensity
• Check pituitary stalk and optic chiasm position relative to prior scans`;
  }
  if (key.includes('t1') && !sequence) {
    return `T1-Weighted Imaging

How to read: Basic anatomical scan. Bright = fat, protein-rich fluid. Dark = water, CSF. Good gray-white matter differentiation.

In craniopharyngioma: The tumor typically appears heterogeneous with multiple cysts. Bright cysts contain "machine oil" fluid rich in cholesterol and keratin - this is nearly unique to adamantinomatous craniopharyngioma.

Tracking progression:
• Measure total tumor extent in all dimensions
• Count and measure individual cysts
• Compare position relative to optic chiasm, pituitary, hypothalamus
• Check ventricle size - enlargement suggests developing hydrocephalus`;
  }
  
  // T2-weighted sequences
  if (key.includes('t2') && key.includes('flair')) {
    return `T2 FLAIR

How to read: Like T2 but CSF signal is suppressed (dark). This makes abnormalities near fluid spaces much easier to see. Bright signal in brain tissue = edema or gliosis.

In craniopharyngioma: Cysts appear variable (bright to dark depending on protein content). Look for bright signal in adjacent brain tissue - this indicates edema or irritation from the tumor.

Tracking progression:
• Compare FLAIR signal in hypothalamus and surrounding brain
• New or increasing bright signal suggests tumor growth or invasion
• Monitor tumor margin clarity - blurring may indicate infiltration
• Check for new areas of brain edema`;
  }
  if (key.includes('t2') && key.includes('se')) {
    return `T2 SE (Spin Echo)

How to read: Water and fluid appear bright. Excellent for seeing cystic structures. CSF is very bright. Calcium appears dark.

In craniopharyngioma: Most cysts appear bright, but intensity varies with protein concentration. Very bright = watery; less bright = thicker "machine oil." Look for dark spots within cysts (calcium) and internal septations (walls between cyst chambers).

Tracking progression:
• Measure cyst sizes - rapid growth needs attention
• Count cyst compartments - new septations indicate complexity
• Assess optic chiasm: is it more stretched or displaced than before?
• Check third ventricle size - compression causes hydrocephalus`;
  }
  if (key.includes('t2') && key.includes('ssfse')) {
    return `T2 SSFSE (Fast Spin Echo)

How to read: Quick T2 sequence showing fluid as bright. Less detailed than standard T2 but good for overall cyst assessment.

In craniopharyngioma: Shows cyst architecture - number, size, and arrangement of chambers. Variable signal between cysts reflects different protein concentrations.

Tracking progression:
• Quick comparison of overall cyst dimensions
• Identify new cyst formation
• Check ventricle size for hydrocephalus
• Use standard T2 for detailed measurements`;
  }
  
  // Diffusion sequences
  if (key.includes('dwi')) {
    return `DWI (Diffusion-Weighted Imaging)

How to read: Measures water molecule movement. Restricted diffusion (bright signal) = water is trapped. Normal cyst fluid shows free diffusion (dark on DWI).

In craniopharyngioma: Cysts typically appear DARK (no restriction) - this helps distinguish from abscesses and epidermoid cysts which appear bright. Bright DWI signal in a cyst is unusual and may indicate very thick contents or infection.

Tracking progression:
• Cysts should remain dark on DWI across scans
• New bright signal is a red flag - investigate for infection or hemorrhage
• Useful for characterizing new cystic areas
• Compare with ADC map for confirmation`;
  }
  if (key.includes('dti')) {
    return `DTI (Diffusion Tensor Imaging)

How to read: Maps white matter fiber tracts. Color-coded by direction: red = left-right, green = front-back, blue = up-down. Shows whether nerve fibers are intact or disrupted.

In craniopharyngioma: Key tracts to identify are the optic tracts (vision), fornix (memory), and hypothalamic connections. Tracts may be displaced (pushed aside) or invaded by tumor.

Tracking progression:
• Compare tract position - new displacement suggests growth
• Assess tract integrity - thinning or gaps indicate damage
• Track optic tract appearance relative to visual symptoms
• Look for tract recovery or worsening over time`;
  }
  if (key.includes('asl')) {
    return `ASL (Arterial Spin Labeling)

How to read: Shows blood flow without contrast dye. High flow = bright signal. Cysts (no blood flow) appear dark. Solid vascular tissue appears bright.

In craniopharyngioma: Solid tumor components typically show low to moderate blood flow (less than meningiomas). Cystic areas show no flow.

Tracking progression:
• Compare blood flow in solid components across scans
• Increasing flow suggests active tumor growth
• New flow in previously cystic areas may indicate solid recurrence
• Useful for monitoring without contrast`;
  }
  
  // Susceptibility sequences  
  if (key.includes('swi') || key.includes('swan')) {
    return `SWI/SWAN (Susceptibility-Weighted)

How to read: Extremely sensitive to calcium, iron, and blood products - these appear as dark (black) areas. More sensitive than CT for detecting small calcifications.

In craniopharyngioma: Calcifications are the hallmark finding (>90% of cases). They appear as dark spots or clusters, often at cyst periphery. Old hemorrhage also appears dark.

Tracking progression:
• Calcification patterns are typically stable - use as reference landmarks
• New dark areas suggest fresh hemorrhage into cysts
• Compare calcification distribution
• Helps distinguish tumor from blood products`;
  }
  if (key.includes('gre') && !key.includes('t1')) {
    return `GRE (Gradient Echo)

How to read: Sensitive to magnetic field disturbances from calcium and blood. These cause dark "blooming" artifacts that appear larger than actual size.

In craniopharyngioma: Calcifications appear as dark blooming spots. Hemosiderin (old blood) also appears dark. Less sensitive than SWI but still useful.

Tracking progression:
• Calcification patterns are stable - good baseline reference
• New blooming suggests hemorrhage
• Compare with prior scans to identify changes
• Cross-reference with SWI for detailed assessment`;
  }
  
  return `${formatSequenceLabel({ weight, sequence } as SequenceCombo)}

MRI scan sequence for brain imaging. Different sequences highlight different tissue properties and are useful for various aspects of diagnosis and monitoring.`;
}

export function ComparisonMatrix() {
  const { data, loading, error } = useComparison();
  const [selectedPlane, setSelectedPlane] = useState<string | null>(null);
  const [selectedSeqId, setSelectedSeqId] = useState<string | null>(null);
  const [enabledDates, setEnabledDates] = useState<Set<string>>(new Set());
  const [progress, setProgress] = useState(0); // 0..1 normalized
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [rightSidebarOpen, setRightSidebarOpen] = useState(true);
  const [gridSize, setGridSize] = useState({ width: 0, height: 0 });
  const gridContainerRef = useRef<HTMLDivElement>(null);
  
  // Per-panel settings: Map<date, PanelSettings>
  const [panelSettings, setPanelSettings] = useState<Map<string, PanelSettings>>(new Map());
  const [activePanel, setActivePanel] = useState<string | null>(null); // date of panel being adjusted
  
  // Overlay mode state
  const [viewMode, setViewMode] = useState<'grid' | 'overlay'>('grid');
  const [overlayDateIndex, setOverlayDateIndex] = useState(0);
  const [isPlaying, setIsPlaying] = useState(false);
  const [playSpeed, setPlaySpeed] = useState(1000); // ms between frames
  
  // Stable stringified version of enabledDates to prevent effect re-runs on Set reference changes
  const enabledDatesKey = useMemo(() => Array.from(enabledDates).sort().join(','), [enabledDates]);
  
  // Load panel settings from backend when sequence or dates change
  useEffect(() => {
    if (!selectedSeqId) return;
    const currentDates = enabledDatesKey.split(',').filter(Boolean);
    if (currentDates.length === 0) return;
    
    let cancelled = false;
    (async () => {
      try {
        const server = await apiFetchPanelSettings(selectedSeqId);
        if (cancelled) return;
        const newSettings = new Map<string, PanelSettings>();
        currentDates.forEach(date => {
          const s = server[date] || {};
          // Merge with defaults, ensuring no undefined values overwrite defaults
          newSettings.set(date, {
            offset: typeof s.offset === 'number' ? s.offset : DEFAULT_PANEL_SETTINGS.offset,
            zoom: typeof s.zoom === 'number' ? s.zoom : DEFAULT_PANEL_SETTINGS.zoom,
            rotation: typeof s.rotation === 'number' ? s.rotation : DEFAULT_PANEL_SETTINGS.rotation,
            brightness: typeof s.brightness === 'number' ? s.brightness : DEFAULT_PANEL_SETTINGS.brightness,
            contrast: typeof s.contrast === 'number' ? s.contrast : DEFAULT_PANEL_SETTINGS.contrast,
            panX: typeof s.panX === 'number' ? s.panX : DEFAULT_PANEL_SETTINGS.panX,
            panY: typeof s.panY === 'number' ? s.panY : DEFAULT_PANEL_SETTINGS.panY,
            progress: typeof s.progress === 'number' ? s.progress : DEFAULT_PANEL_SETTINGS.progress,
          });
        });
        setPanelSettings(newSettings);
        // Set initial active panel and progress to newest enabled date
        const sortedDates = [...currentDates].sort((a, b) => b.localeCompare(a));
        const initial = sortedDates[0];
        if (initial) {
          setActivePanel(initial);
          const ps = newSettings.get(initial);
          if (ps && typeof ps.progress === 'number') {
            setProgress(Math.max(0, Math.min(1, ps.progress)));
          }
        }
      } catch (e) {
        if (cancelled) return;
        // Fallback to defaults on error
        const newSettings = new Map<string, PanelSettings>();
        currentDates.forEach(date => newSettings.set(date, { ...DEFAULT_PANEL_SETTINGS }));
        setPanelSettings(newSettings);
      }
    })();
    return () => { cancelled = true; };
  }, [selectedSeqId, enabledDatesKey]);
  
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
  
  // For overlay mode: columns sorted newest to oldest
  const overlayColumns = useMemo(() => {
    if (!data || !selectedSeqId) return [] as { date: string; ref?: SeriesRef }[];
    const map = data.series_map[selectedSeqId] || {};
    // Sort by date descending (newest first)
    const selectedDates = [...enabledDates].sort((a, b) => b.localeCompare(a));
    return selectedDates.map(date => ({ date, ref: map[date] })).filter(c => c.ref);
  }, [data, selectedSeqId, enabledDates]);
  
  // Keep overlayDateIndex in bounds when columns change
  useEffect(() => {
    if (overlayDateIndex >= overlayColumns.length) {
      setOverlayDateIndex(Math.max(0, overlayColumns.length - 1));
    }
  }, [overlayColumns.length, overlayDateIndex]);
  
  // Auto-play effect for overlay mode
  useEffect(() => {
    if (!isPlaying || viewMode !== 'overlay' || overlayColumns.length < 2) return;
    const interval = setInterval(() => {
      setOverlayDateIndex(prev => (prev + 1) % overlayColumns.length);
    }, playSpeed);
    return () => clearInterval(interval);
  }, [isPlaying, viewMode, overlayColumns.length, playSpeed]);
  
  // Keyboard shortcuts for overlay mode
  useEffect(() => {
    if (viewMode !== 'overlay') return;
    const handleKeyDown = (e: KeyboardEvent) => {
      // Ignore if focus is on an input, select, or textarea
      const target = e.target as HTMLElement;
      if (target.tagName === 'INPUT' || target.tagName === 'SELECT' || target.tagName === 'TEXTAREA') {
        return;
      }
      
      // Number keys 1-9 to select date
      if (e.key >= '1' && e.key <= '9') {
        const idx = parseInt(e.key, 10) - 1;
        if (idx < overlayColumns.length) {
          setOverlayDateIndex(idx);
          setIsPlaying(false);
        }
      }
      // Arrow keys for prev/next
      if (e.key === 'ArrowLeft') {
        setOverlayDateIndex(prev => Math.max(0, prev - 1));
        setIsPlaying(false);
      }
      if (e.key === 'ArrowRight') {
        setOverlayDateIndex(prev => Math.min(overlayColumns.length - 1, prev + 1));
        setIsPlaying(false);
      }
      // Space to toggle play/pause
      if (e.key === ' ') {
        e.preventDefault();
        setIsPlaying(prev => !prev);
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [viewMode, overlayColumns.length]);

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
                    onClick={() => { setSelectedPlane(p); setSelectedSeqId(findMatchingSequence(data, p, selectedSeqId)); }}
                    className={`w-full text-left px-3 py-2 rounded-lg text-sm transition-colors ${selectedPlane === p ? 'bg-[var(--accent)] text-white' : 'hover:bg-[var(--bg-tertiary)] text-[var(--text-primary)]'}`}
                  >{p}</button>
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
                      onClick={() => setSelectedSeqId(seq.id)}
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
        <div ref={gridContainerRef} className="flex-1 overflow-hidden bg-black flex flex-col">
          {viewMode === 'grid' ? (
            /* Grid View */
            <div className="flex-1 flex items-center justify-center">
              <div 
                className="grid gap-2"
                style={{ 
                  gridTemplateColumns: `repeat(${gridLayout.cols}, ${gridLayout.cellSize}px)`,
                  gridAutoRows: `${gridLayout.cellSize + 32}px`, // +32 for header
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
                  
                  // Calculate slice index with offset
                  const baseIdx = ref.instance_count > 1 ? Math.round(progress * (ref.instance_count - 1)) : 0;
                  const idx = Math.max(0, Math.min(ref.instance_count - 1, baseIdx + settings.offset));
                  
                  return (
                    <div 
                      key={date} 
                      className="relative flex flex-col rounded-lg overflow-hidden border border-[var(--border-color)]"
                    >
                      {/* Header with controls */}
                      <div className="px-2 py-1 text-xs bg-[var(--bg-secondary)] border-b border-[var(--border-color)] flex justify-between items-center">
                        <span className="text-[var(--text-secondary)] truncate">{formatDate(date)}</span>
                        <div className="flex items-center">
                          {/* Slice offset */}
                          <button
                            onClick={(e) => { e.stopPropagation(); updatePanelSetting(date, { offset: settings.offset - 1 }); }}
                            className="p-0.5 rounded hover:bg-[var(--bg-tertiary)] text-[var(--text-secondary)]"
                          >
                            <ChevronLeft className="w-3 h-3" />
                          </button>
                          <span className="text-[var(--text-primary)] text-[10px] w-8 text-center font-mono">
                            {idx + 1}/{ref.instance_count}
                          </span>
                          <button
                            onClick={(e) => { e.stopPropagation(); updatePanelSetting(date, { offset: settings.offset + 1 }); }}
                            className="p-0.5 rounded hover:bg-[var(--bg-tertiary)] text-[var(--text-secondary)]"
                          >
                          <ChevronRight className="w-3 h-3" />
                          </button>
                          
                          <div className="w-px h-3 bg-[var(--border-color)] mx-1" />
                          
                          {/* Zoom */}
                          <button
                            onClick={(e) => { e.stopPropagation(); updatePanelSetting(date, { zoom: Math.max(0.1, settings.zoom - 0.01) }); }}
                            className="p-0.5 rounded hover:bg-[var(--bg-tertiary)] text-[var(--text-secondary)]"
                          >
                            <ChevronLeft className="w-3 h-3" />
                          </button>
                          <span className="text-[var(--text-primary)] text-[10px] w-8 text-center font-mono">
                            {Math.round(settings.zoom * 100)}%
                          </span>
                          <button
                            onClick={(e) => { e.stopPropagation(); updatePanelSetting(date, { zoom: Math.min(10, settings.zoom + 0.01) }); }}
                            className="p-0.5 rounded hover:bg-[var(--bg-tertiary)] text-[var(--text-secondary)]"
                          >
                            <ChevronRight className="w-3 h-3" />
                          </button>
                          
                          {/* Rotation */}
                          <button
                            onClick={(e) => { 
                              e.stopPropagation(); 
                              let val = settings.rotation - 1;
                              val = ((val + 180) % 360 + 360) % 360 - 180;
                              updatePanelSetting(date, { rotation: val }); 
                            }}
                            className="p-0.5 rounded hover:bg-[var(--bg-tertiary)] text-[var(--text-secondary)]"
                          >
                            <ChevronLeft className="w-3 h-3" />
                          </button>
                          <span className="text-[var(--text-primary)] text-[10px] w-7 text-center font-mono">
                            {settings.rotation}°
                          </span>
                          <button
                            onClick={(e) => { 
                              e.stopPropagation(); 
                              let val = settings.rotation + 1;
                              val = ((val + 180) % 360 + 360) % 360 - 180;
                              updatePanelSetting(date, { rotation: val }); 
                            }}
                            className="p-0.5 rounded hover:bg-[var(--bg-tertiary)] text-[var(--text-secondary)]"
                          >
                            <ChevronRight className="w-3 h-3" />
                          </button>
                          
                          <div className="w-px h-3 bg-[var(--border-color)] mx-1" />
                          
                          {/* Brightness */}
                          <span className="text-[var(--text-secondary)] text-[10px]">B</span>
                          <button
                            onClick={(e) => { e.stopPropagation(); updatePanelSetting(date, { brightness: Math.max(0, settings.brightness - 1) }); }}
                            className="p-0.5 rounded hover:bg-[var(--bg-tertiary)] text-[var(--text-secondary)]"
                          >
                            <ChevronLeft className="w-3 h-3" />
                          </button>
                          <span className="text-[var(--text-primary)] text-[10px] w-6 text-center font-mono">
                            {settings.brightness}
                          </span>
                          <button
                            onClick={(e) => { e.stopPropagation(); updatePanelSetting(date, { brightness: Math.min(200, settings.brightness + 1) }); }}
                            className="p-0.5 rounded hover:bg-[var(--bg-tertiary)] text-[var(--text-secondary)]"
                          >
                            <ChevronRight className="w-3 h-3" />
                          </button>
                          
                          {/* Contrast */}
                          <span className="text-[var(--text-secondary)] text-[10px] ml-1">C</span>
                          <button
                            onClick={(e) => { e.stopPropagation(); updatePanelSetting(date, { contrast: Math.max(0, settings.contrast - 1) }); }}
                            className="p-0.5 rounded hover:bg-[var(--bg-tertiary)] text-[var(--text-secondary)]"
                          >
                            <ChevronLeft className="w-3 h-3" />
                          </button>
                          <span className="text-[var(--text-primary)] text-[10px] w-6 text-center font-mono">
                            {settings.contrast}
                          </span>
                          <button
                            onClick={(e) => { e.stopPropagation(); updatePanelSetting(date, { contrast: Math.min(200, settings.contrast + 1) }); }}
                            className="p-0.5 rounded hover:bg-[var(--bg-tertiary)] text-[var(--text-secondary)]"
                          >
                            <ChevronRight className="w-3 h-3" />
                          </button>
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
                          brightness={settings.brightness}
                          contrast={settings.contrast}
                          zoom={settings.zoom}
                          rotation={settings.rotation}
                          panX={settings.panX}
                          panY={settings.panY}
                          onPanChange={(newPanX, newPanY) => {
                            updatePanelSetting(date, { panX: newPanX, panY: newPanY });
                          }}
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
          ) : (
            /* Overlay View */
            <div className="flex-1 flex flex-col">
              {/* Date selector strip */}
              <div className="flex-shrink-0 px-4 py-2 bg-[var(--bg-secondary)] border-b border-[var(--border-color)] flex items-center gap-3">
                {/* Play/Pause button */}
                <button
                  onClick={() => setIsPlaying(!isPlaying)}
                  className={`p-2 rounded-lg transition-colors ${isPlaying ? 'bg-[var(--accent)] text-white' : 'bg-[var(--bg-primary)] text-[var(--text-secondary)] hover:text-[var(--text-primary)]'}`}
                  title={isPlaying ? 'Pause (Space)' : 'Play (Space)'}
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
                    <option value={2000}>0.5x</option>
                    <option value={1000}>1x</option>
                    <option value={500}>2x</option>
                    <option value={250}>4x</option>
                  </select>
                </div>
                
                <div className="w-px h-6 bg-[var(--border-color)]" />
                
                {/* Date buttons */}
                <div className="flex items-center gap-1 flex-1 overflow-x-auto">
                  {overlayColumns.map((col, idx) => (
                    <button
                      key={col.date}
                      onClick={() => { setOverlayDateIndex(idx); setIsPlaying(false); }}
                      className={`px-3 py-1.5 rounded-lg text-sm whitespace-nowrap transition-colors flex items-center gap-2 ${idx === overlayDateIndex ? 'bg-[var(--accent)] text-white' : 'bg-[var(--bg-primary)] text-[var(--text-secondary)] hover:text-[var(--text-primary)]'}`}
                    >
                      <span className="w-5 h-5 rounded bg-black/20 flex items-center justify-center text-xs font-mono">
                        {idx + 1}
                      </span>
                      {formatDate(col.date)}
                    </button>
                  ))}
                </div>
                
                {/* Image adjustment controls for current date */}
                {overlayColumns.length > 0 && (() => {
                  const currentCol = overlayColumns[overlayDateIndex];
                  if (!currentCol?.ref) return null;
                  const currentDate = currentCol.date;
                  const settings = panelSettings.get(currentDate) || DEFAULT_PANEL_SETTINGS;
                  const ref = currentCol.ref;
                  const baseIdx = ref.instance_count > 1 ? Math.round(progress * (ref.instance_count - 1)) : 0;
                  const idx = Math.max(0, Math.min(ref.instance_count - 1, baseIdx + settings.offset));
                  
                  return (
                    <>
                      <div className="w-px h-6 bg-[var(--border-color)]" />
                      
                      {/* Slice offset */}
                      <div className="flex items-center" title="Slice">
                        <button
                          onClick={() => updatePanelSetting(currentDate, { offset: settings.offset - 1 })}
                          className="p-1 rounded hover:bg-[var(--bg-tertiary)] text-[var(--text-secondary)]"
                        >
                          <ChevronLeft className="w-3.5 h-3.5" />
                        </button>
                        <span className="text-xs text-[var(--text-primary)] w-12 text-center font-mono">
                          {idx + 1}/{ref.instance_count}
                        </span>
                        <button
                          onClick={() => updatePanelSetting(currentDate, { offset: settings.offset + 1 })}
                          className="p-1 rounded hover:bg-[var(--bg-tertiary)] text-[var(--text-secondary)]"
                        >
                          <ChevronRight className="w-3.5 h-3.5" />
                        </button>
                      </div>
                      
                      <div className="w-px h-5 bg-[var(--border-color)]" />
                      
                      {/* Zoom */}
                      <div className="flex items-center" title="Zoom">
                        <button
                          onClick={() => updatePanelSetting(currentDate, { zoom: Math.max(0.1, settings.zoom - 0.01) })}
                          className="p-1 rounded hover:bg-[var(--bg-tertiary)] text-[var(--text-secondary)]"
                        >
                          <ChevronLeft className="w-3.5 h-3.5" />
                        </button>
                        <span className="text-xs text-[var(--text-primary)] w-10 text-center font-mono">
                          {Math.round(settings.zoom * 100)}%
                        </span>
                        <button
                          onClick={() => updatePanelSetting(currentDate, { zoom: Math.min(10, settings.zoom + 0.01) })}
                          className="p-1 rounded hover:bg-[var(--bg-tertiary)] text-[var(--text-secondary)]"
                        >
                          <ChevronRight className="w-3.5 h-3.5" />
                        </button>
                      </div>
                      
                      {/* Rotation */}
                      <div className="flex items-center" title="Rotation">
                        <button
                          onClick={() => {
                            let val = settings.rotation - 1;
                            val = ((val + 180) % 360 + 360) % 360 - 180;
                            updatePanelSetting(currentDate, { rotation: val });
                          }}
                          className="p-1 rounded hover:bg-[var(--bg-tertiary)] text-[var(--text-secondary)]"
                        >
                          <ChevronLeft className="w-3.5 h-3.5" />
                        </button>
                        <span className="text-xs text-[var(--text-primary)] w-8 text-center font-mono">
                          {settings.rotation}°
                        </span>
                        <button
                          onClick={() => {
                            let val = settings.rotation + 1;
                            val = ((val + 180) % 360 + 360) % 360 - 180;
                            updatePanelSetting(currentDate, { rotation: val });
                          }}
                          className="p-1 rounded hover:bg-[var(--bg-tertiary)] text-[var(--text-secondary)]"
                        >
                          <ChevronRight className="w-3.5 h-3.5" />
                        </button>
                      </div>
                      
                      <div className="w-px h-5 bg-[var(--border-color)]" />
                      
                      {/* Brightness */}
                      <div className="flex items-center" title="Brightness">
                        <span className="text-xs text-[var(--text-secondary)] mr-1">B</span>
                        <button
                          onClick={() => updatePanelSetting(currentDate, { brightness: Math.max(0, settings.brightness - 1) })}
                          className="p-1 rounded hover:bg-[var(--bg-tertiary)] text-[var(--text-secondary)]"
                        >
                          <ChevronLeft className="w-3.5 h-3.5" />
                        </button>
                        <span className="text-xs text-[var(--text-primary)] w-7 text-center font-mono">
                          {settings.brightness}
                        </span>
                        <button
                          onClick={() => updatePanelSetting(currentDate, { brightness: Math.min(200, settings.brightness + 1) })}
                          className="p-1 rounded hover:bg-[var(--bg-tertiary)] text-[var(--text-secondary)]"
                        >
                          <ChevronRight className="w-3.5 h-3.5" />
                        </button>
                      </div>
                      
                      {/* Contrast */}
                      <div className="flex items-center" title="Contrast">
                        <span className="text-xs text-[var(--text-secondary)] mr-1">C</span>
                        <button
                          onClick={() => updatePanelSetting(currentDate, { contrast: Math.max(0, settings.contrast - 1) })}
                          className="p-1 rounded hover:bg-[var(--bg-tertiary)] text-[var(--text-secondary)]"
                        >
                          <ChevronLeft className="w-3.5 h-3.5" />
                        </button>
                        <span className="text-xs text-[var(--text-primary)] w-7 text-center font-mono">
                          {settings.contrast}
                        </span>
                        <button
                          onClick={() => updatePanelSetting(currentDate, { contrast: Math.min(200, settings.contrast + 1) })}
                          className="p-1 rounded hover:bg-[var(--bg-tertiary)] text-[var(--text-secondary)]"
                        >
                          <ChevronRight className="w-3.5 h-3.5" />
                        </button>
                      </div>
                    </>
                  );
                })()}
              </div>
              
              {/* Single large viewer */}
              <div className="flex-1 flex items-center justify-center p-4">
                {overlayColumns.length === 0 ? (
                  <div className="text-[var(--text-secondary)]">Select dates to view</div>
                ) : (() => {
                  const currentCol = overlayColumns[overlayDateIndex];
                  if (!currentCol?.ref) return <div className="text-[var(--text-secondary)]">No data</div>;
                  
                  const ref = currentCol.ref;
                  const settings = panelSettings.get(currentCol.date) || DEFAULT_PANEL_SETTINGS;
                  const baseIdx = ref.instance_count > 1 ? Math.round(progress * (ref.instance_count - 1)) : 0;
                  const idx = Math.max(0, Math.min(ref.instance_count - 1, baseIdx + settings.offset));
                  
                  // Calculate size to fill available space while maintaining aspect ratio
                  const maxSize = Math.min(gridSize.width - 48, gridSize.height - 120);
                  const viewerSize = Math.max(300, maxSize);
                  
                  return (
                    <div 
                      className="relative rounded-lg overflow-hidden border border-[var(--border-color)]"
                      style={{ width: viewerSize, height: viewerSize }}
                    >
                      <DicomViewer
                        studyId={ref.study_id}
                        seriesUid={ref.series_uid}
                        instanceIndex={idx}
                        instanceCount={ref.instance_count}
                        onInstanceChange={(i) => {
                          const denom = Math.max(1, ref.instance_count - 1);
                          const newProgress = Math.max(0, Math.min(1, (i - settings.offset) / denom));
                          setProgress(newProgress);
                        }}
                        brightness={settings.brightness}
                        contrast={settings.contrast}
                        zoom={settings.zoom}
                        rotation={settings.rotation}
                        panX={settings.panX}
                        panY={settings.panY}
                        onPanChange={(newPanX, newPanY) => {
                          updatePanelSetting(currentCol.date, { panX: newPanX, panY: newPanY });
                        }}
                      />
                      {/* Date overlay */}
                      <div className="absolute bottom-4 left-4 px-3 py-2 bg-black/70 rounded-lg text-white text-sm font-medium">
                        {formatDate(currentCol.date)}
                      </div>
                    </div>
                  );
                })()}
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
            <div className="text-xs uppercase font-semibold text-[var(--text-secondary)] mb-3 flex items-center gap-2">
              <CalendarDays className="w-4 h-4" />Dates
            </div>
            <div className="space-y-1">
              {sortedDates.map(d => {
                const enabled = enabledDates.has(d);
                const hasData = datesWithDataForSequence.has(d);
                return (
                  <button
                    key={d}
                    onClick={() => {
                      const next = new Set(enabledDates);
                      if (enabled) next.delete(d); else next.add(d);
                      setEnabledDates(next);
                    }}
                    className={`w-full text-left px-3 py-2 rounded-lg text-sm transition-colors flex items-center gap-2 ${enabled ? (hasData ? 'bg-[var(--accent)] text-white' : 'bg-[var(--accent)] text-white opacity-50') : hasData ? 'hover:bg-[var(--bg-tertiary)] text-[var(--text-primary)]' : 'text-[var(--text-tertiary)] opacity-50'}`}
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
          max={1000}
          step={1}
          value={Math.round(progress * 1000)}
          onChange={(e) => setProgress(parseInt(e.target.value, 10) / 1000)}
          className="flex-1"
        />
      </div>
    </div>
  );
}

// Persist filters to localStorage whenever they change
// This must be outside the component to avoid re-definition? We'll keep inside using another effect above.
