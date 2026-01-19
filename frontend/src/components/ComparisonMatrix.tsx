import { createRef, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { SequenceCombo, SeriesRef } from '../types/api';
import { formatDate } from '../utils/format';
import {
  Brain,
  Layers,
  CalendarDays,
  ChevronLeft,
  ChevronRight,
  LayoutGrid,
  Play,
  Pause,
  HelpCircle,
  Upload,
  Download,
  Trash2,
} from 'lucide-react';
import { DicomViewer, type DicomViewerHandle } from './DicomViewer';
import { ImageControls } from './ImageControls';
import { HelpModal } from './HelpModal';
import { UploadModal } from './UploadModal';
import { ExportModal } from './ExportModal';
import { ClearDataModal } from './ClearDataModal';
import { TooltipTrigger } from './TooltipTrigger';
import { useComparisonData } from '../hooks/useComparisonData';
import { useComparisonFilters } from '../hooks/useComparisonFilters';
import { usePanelSettings } from '../hooks/usePanelSettings';
import { useOverlayNavigation } from '../hooks/useOverlayNavigation';
import { useGridLayout } from '../hooks/useGridLayout';
import { getSequenceTooltip, formatSequenceLabel } from '../utils/clinicalData';
import { useAiAnnotation } from '../hooks/useAiAnnotation';
import { DEFAULT_PANEL_SETTINGS, CONTROL_LIMITS, OVERLAY, AI_ENABLED } from '../utils/constants';
import { getSliceIndex, getProgressFromSlice } from '../utils/math';

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

type PersistedSliceLoopPlaybackSettings = {
  loopStart: number;
  loopEnd: number;
  loopSpeed: 1 | 2 | 4;
};

type PersistedSliceLoopPlaybackCookieV2 = {
  bySeq: Record<string, (PersistedSliceLoopPlaybackSettings & { updatedAt?: number }) | undefined>;
};

const PLAYBACK_STORAGE_KEY_PREFIX = 'miraviewer:slice-loop-playback:v2:';
const PLAYBACK_COOKIE_NAME_V2 = 'miraviewer_slice_loop_playback_v2';

// Legacy global settings (used to seed per-seq settings if present).
const LEGACY_PLAYBACK_STORAGE_KEY = 'miraviewer:slice-loop-playback:v1';
const LEGACY_PLAYBACK_COOKIE_NAME = 'miraviewer_slice_loop_playback_v1';

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

function ensureLoopBounds(start: number, end: number): [number, number] {
  const minGap = 0.01;
  const s = clamp01(start);
  let e = clamp01(end);
  if (e - s < minGap) {
    e = clamp01(s + minGap);
  }
  return [s, e];
}

function makePlaybackStorageKey(seqId: string): string {
  return `${PLAYBACK_STORAGE_KEY_PREFIX}${encodeURIComponent(seqId)}`;
}

function readCookie(name: string): string | null {
  const parts = document.cookie.split(';');
  for (const part of parts) {
    const [k, ...rest] = part.trim().split('=');
    if (k === name) {
      return rest.join('=') || '';
    }
  }
  return null;
}

function writeCookie(name: string, value: string) {
  // Persist for 1 year.
  const maxAge = 60 * 60 * 24 * 365;
  document.cookie = `${name}=${value}; Path=/; Max-Age=${maxAge}; SameSite=Lax`;
}

function parsePersistedPlaybackValue(value: unknown): PersistedSliceLoopPlaybackSettings | null {
  if (!value || typeof value !== 'object') return null;
  const obj = value as Record<string, unknown>;

  const sRaw = obj.loopStart;
  const eRaw = obj.loopEnd;
  if (
    typeof sRaw !== 'number' ||
    !Number.isFinite(sRaw) ||
    typeof eRaw !== 'number' ||
    !Number.isFinite(eRaw)
  ) {
    return null;
  }

  const [loopStart, loopEnd] = ensureLoopBounds(sRaw, eRaw);

  const sp = obj.loopSpeed;
  const loopSpeed: 1 | 2 | 4 = sp === 2 || sp === 4 ? sp : 1;

  return { loopStart, loopEnd, loopSpeed };
}

function parsePersistedPlaybackJson(rawJson: string): PersistedSliceLoopPlaybackSettings | null {
  try {
    return parsePersistedPlaybackValue(JSON.parse(rawJson));
  } catch {
    return null;
  }
}

function readPersistedSliceLoopPlaybackSettingsFromCookieV2(seqId: string): PersistedSliceLoopPlaybackSettings | null {
  try {
    const cookieVal = readCookie(PLAYBACK_COOKIE_NAME_V2);
    if (!cookieVal) return null;

    const decoded = decodeURIComponent(cookieVal);
    const parsed: unknown = JSON.parse(decoded);
    if (!parsed || typeof parsed !== 'object') return null;

    const bySeq = (parsed as Record<string, unknown>).bySeq;
    if (!bySeq || typeof bySeq !== 'object') return null;

    const entry = (bySeq as Record<string, unknown>)[seqId];
    return parsePersistedPlaybackValue(entry);
  } catch {
    return null;
  }
}

function writePersistedSliceLoopPlaybackSettingsToCookieV2(seqId: string, settings: PersistedSliceLoopPlaybackSettings) {
  try {
    const existingVal = readCookie(PLAYBACK_COOKIE_NAME_V2);
    let cookieObj: PersistedSliceLoopPlaybackCookieV2 = { bySeq: {} };

    if (existingVal) {
      try {
        const decoded = decodeURIComponent(existingVal);
        const parsed: unknown = JSON.parse(decoded);
        if (parsed && typeof parsed === 'object') {
          const bySeq = (parsed as Record<string, unknown>).bySeq;
          if (bySeq && typeof bySeq === 'object') {
            cookieObj = { bySeq: bySeq as PersistedSliceLoopPlaybackCookieV2['bySeq'] };
          }
        }
      } catch {
        // Ignore malformed cookie.
      }
    }

    cookieObj.bySeq[seqId] = { ...settings, updatedAt: Date.now() };

    // Prune to keep cookie size reasonable.
    const entries = Object.entries(cookieObj.bySeq)
      .map(([k, v]) => {
        const ts = typeof v?.updatedAt === 'number' && Number.isFinite(v.updatedAt) ? v.updatedAt : 0;
        return [k, ts] as const;
      })
      .sort((a, b) => b[1] - a[1]);

    const MAX_COOKIE_ENTRIES = 25;
    if (entries.length > MAX_COOKIE_ENTRIES) {
      const keep = new Set(entries.slice(0, MAX_COOKIE_ENTRIES).map(([k]) => k));
      for (const key of Object.keys(cookieObj.bySeq)) {
        if (!keep.has(key)) {
          delete cookieObj.bySeq[key];
        }
      }
    }

    writeCookie(PLAYBACK_COOKIE_NAME_V2, encodeURIComponent(JSON.stringify(cookieObj)));
  } catch {
    // Ignore blocked cookies.
  }
}

function readPersistedSliceLoopPlaybackSettingsForSeq(seqId: string): PersistedSliceLoopPlaybackSettings | null {
  // Prefer localStorage (origin-scoped) per sequence.
  try {
    const raw = localStorage.getItem(makePlaybackStorageKey(seqId));
    if (raw) {
      const parsed = parsePersistedPlaybackJson(raw);
      if (parsed) return parsed;
    }
  } catch {
    // ignore
  }

  // Fallback to cookie (shared across ports on the same host).
  const fromCookie = readPersistedSliceLoopPlaybackSettingsFromCookieV2(seqId);
  if (fromCookie) return fromCookie;

  // Legacy global settings (seed per-seq once).
  try {
    const raw = localStorage.getItem(LEGACY_PLAYBACK_STORAGE_KEY);
    if (raw) {
      const parsed = parsePersistedPlaybackJson(raw);
      if (parsed) {
        writePersistedSliceLoopPlaybackSettingsForSeq(seqId, parsed);
        return parsed;
      }
    }
  } catch {
    // ignore
  }

  try {
    const cookieVal = readCookie(LEGACY_PLAYBACK_COOKIE_NAME);
    if (cookieVal) {
      const decoded = decodeURIComponent(cookieVal);
      const parsed = parsePersistedPlaybackJson(decoded);
      if (parsed) {
        writePersistedSliceLoopPlaybackSettingsForSeq(seqId, parsed);
        return parsed;
      }
    }
  } catch {
    // ignore
  }

  return null;
}

function writePersistedSliceLoopPlaybackSettingsForSeq(seqId: string, settings: PersistedSliceLoopPlaybackSettings) {
  const raw = JSON.stringify(settings);

  try {
    localStorage.setItem(makePlaybackStorageKey(seqId), raw);
  } catch {
    // Ignore quota/blocked storage.
  }

  writePersistedSliceLoopPlaybackSettingsToCookieV2(seqId, settings);
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

  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [rightSidebarOpen, setRightSidebarOpen] = useState(true);
  const [helpOpen, setHelpOpen] = useState(false);
  const [uploadModalOpen, setUploadModalOpen] = useState(false);
  const [exportModalOpen, setExportModalOpen] = useState(false);
  const [clearDataModalOpen, setClearDataModalOpen] = useState(false);

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

  // Map of viewer refs so we can snapshot exactly what's visible in a specific cell.
  // We access this in render to assign refs; React warns if we read .current in render,
  // but here we are managing a Map of refs for children, not reading them for display logic.
  // This pattern is acceptable for dynamic refs.
  const viewerRefsRef = useRef(new Map<string, React.RefObject<DicomViewerHandle | null>>());
  const getViewerRef = useCallback((key: string) => {
    const existing = viewerRefsRef.current.get(key);
    if (existing) return existing;
    const created = createRef<DicomViewerHandle>();
    viewerRefsRef.current.set(key, created);
    return created;
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

    const viewerHandle = viewerRefsRef.current.get(viewerKey)?.current || null;
    runNanoBananaAcpAnalysis(target, viewerHandle, seriesContext);
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

  // Keep a ref of the latest progress so autoplay doesn't restart its effect on every tick.
  const progressRef = useRef(progress);
  useEffect(() => {
    progressRef.current = progress;
  }, [progress]);

  const playbackInstanceCount = useMemo(() => {
    const fromOverlay = overlayColumns[overlayDateIndex]?.ref?.instance_count;
    if (typeof fromOverlay === 'number' && fromOverlay > 1) return fromOverlay;

    const anyOverlay = overlayColumns.find(c => c.ref)?.ref?.instance_count;
    if (typeof anyOverlay === 'number' && anyOverlay > 1) return anyOverlay;

    const anyGrid = columns.find(c => c.ref)?.ref?.instance_count;
    if (typeof anyGrid === 'number' && anyGrid > 1) return anyGrid;

    return 1;
  }, [overlayColumns, overlayDateIndex, columns]);

  // Loop playback for slice navigation
  const [loopStart, setLoopStart] = useState(0);
  const [loopEnd, setLoopEnd] = useState(1);
  const [isLooping, setIsLooping] = useState(false);
  const [loopSpeed, setLoopSpeed] = useState<1 | 2 | 4>(1);
  const loopDirectionRef = useRef<1 | -1>(1);
  const rafRef = useRef<number | null>(null);
  const lastTsRef = useRef<number | null>(null);
  const loopStepAccumRef = useRef(0);
  const trackRef = useRef<HTMLDivElement | null>(null);
  const [draggingHandle, setDraggingHandle] = useState<'start' | 'end' | null>(null);

  const playbackHydratedSeqIdRef = useRef<string | null>(null);

  // Hydrate playback settings when the user switches sequence combos.
  // Layout effect prevents a one-frame flash of the previous combo's handles.
  useLayoutEffect(() => {
    if (!selectedSeqId) return;

    const persisted = readPersistedSliceLoopPlaybackSettingsForSeq(selectedSeqId);
    if (persisted) {
      setLoopStart(persisted.loopStart);
      setLoopEnd(persisted.loopEnd);
      setLoopSpeed(persisted.loopSpeed);
    } else {
      setLoopStart(0);
      setLoopEnd(1);
      setLoopSpeed(1);
    }

    playbackHydratedSeqIdRef.current = selectedSeqId;
  }, [selectedSeqId]);

  // Persist per-seq loop window.
  useEffect(() => {
    if (!selectedSeqId) return;
    if (playbackHydratedSeqIdRef.current !== selectedSeqId) return;

    writePersistedSliceLoopPlaybackSettingsForSeq(selectedSeqId, {
      loopStart,
      loopEnd,
      loopSpeed,
    });
  }, [selectedSeqId, loopStart, loopEnd, loopSpeed]);

  // Adjust loop bounds and keep progress inside
  const updateLoop = useCallback(
    (nextStart: number, nextEnd: number) => {
      const [s, e] = ensureLoopBounds(nextStart, nextEnd);
      setLoopStart(s);
      setLoopEnd(e);

      const clamped = clamp01(Math.max(s, Math.min(progressRef.current, e)));
      progressRef.current = clamped;
      setProgressWithClearAi(clamped);
    },
    [setProgressWithClearAi]
  );

  // rAF-driven ping-pong playback (advances by slice-sized steps to avoid overwhelming the UI)
  useEffect(() => {
    if (!isLooping) {
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
      lastTsRef.current = null;
      loopStepAccumRef.current = 0;
      return;
    }

    lastTsRef.current = null;
    loopStepAccumRef.current = 0;

    const baseSlicesPerSecond = 8; // 1x = 8 slices/sec; 2x/4x scale from there.

    const step = (ts: number) => {
      if (lastTsRef.current === null) {
        lastTsRef.current = ts;
        rafRef.current = requestAnimationFrame(step);
        return;
      }

      // Cap dt so tab-switch / hitch doesn't jump too far.
      const dt = Math.min(0.1, (ts - lastTsRef.current) / 1000);
      lastTsRef.current = ts;

      const denom = Math.max(1, playbackInstanceCount - 1);
      const stepProgress = 1 / denom;

      loopStepAccumRef.current += dt * baseSlicesPerSecond * loopSpeed;
      let didAdvance = false;

      while (loopStepAccumRef.current >= 1) {
        loopStepAccumRef.current -= 1;

        let next = progressRef.current + stepProgress * loopDirectionRef.current;

        // Reflect at bounds (ping-pong).
        while (next > loopEnd || next < loopStart) {
          if (next > loopEnd) {
            next = loopEnd - (next - loopEnd);
            loopDirectionRef.current = -1;
          } else if (next < loopStart) {
            next = loopStart + (loopStart - next);
            loopDirectionRef.current = 1;
          }
        }

        next = clamp01(next);
        if (next !== progressRef.current) {
          progressRef.current = next;
          didAdvance = true;
        }
      }

      if (didAdvance) {
        setProgressWithClearAi(progressRef.current);
      }

      rafRef.current = requestAnimationFrame(step);
    };

    rafRef.current = requestAnimationFrame(step);
    return () => {
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
      lastTsRef.current = null;
      loopStepAccumRef.current = 0;
    };
  }, [isLooping, loopStart, loopEnd, loopSpeed, playbackInstanceCount, setProgressWithClearAi]);

  // Stop looping if bounds collapse
  useEffect(() => {
    if (loopEnd - loopStart < 0.005 && isLooping) {
      setIsLooping(false);
    }
  }, [loopStart, loopEnd, isLooping, setIsLooping]);

  // Drag handlers for loop handles
  useEffect(() => {
    if (!draggingHandle) return;

    const handleMove = (e: MouseEvent) => {
      const rect = trackRef.current?.getBoundingClientRect();
      if (!rect) return;
      const pct = clamp01((e.clientX - rect.left) / rect.width);
      if (draggingHandle === 'start') {
        updateLoop(pct, loopEnd);
      } else {
        updateLoop(loopStart, pct);
      }
    };

    const handleUp = () => setDraggingHandle(null);

    window.addEventListener('mousemove', handleMove);
    window.addEventListener('mouseup', handleUp);
    return () => {
      window.removeEventListener('mousemove', handleMove);
      window.removeEventListener('mouseup', handleUp);
    };
  }, [draggingHandle, loopEnd, loopStart, updateLoop]);

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
      <div className="px-4 py-3 bg-[var(--bg-secondary)] border-b border-[var(--border-color)] flex items-center justify-between">
        <div className="flex items-center gap-3">
          <Brain className="w-6 h-6 text-[var(--accent)]" />
          <h1 className="text-lg font-semibold">MiraViewer</h1>
          <span className="text-[10px] text-[var(--text-tertiary)] bg-[var(--bg-tertiary)] px-2 py-0.5 rounded">
            Local storage only — clear site data will erase scans
          </span>
          {selectedSeq && (
            <div className="text-sm text-[var(--text-secondary)] border-l border-[var(--border-color)] pl-3 ml-1">
              {selectedPlane} · {formatSequenceLabel(selectedSeq)}
            </div>
          )}
        </div>
        <div className="flex items-center gap-3">
          {/* Upload button */}
          <button
            onClick={() => setUploadModalOpen(true)}
            className="p-2 rounded-lg hover:bg-[var(--bg-tertiary)] text-[var(--text-secondary)] hover:text-[var(--text-primary)]"
            title="Upload DICOM Archive"
          >
            <Upload className="w-5 h-5" />
          </button>
          <button
            onClick={() => setExportModalOpen(true)}
            className="p-2 rounded-lg hover:bg-[var(--bg-tertiary)] text-[var(--text-secondary)] hover:text-[var(--text-primary)]"
            title="Export backup (ZIP)"
          >
            <Download className="w-5 h-5" />
          </button>

          {/* Clear data */}
          <button
            onClick={() => setClearDataModalOpen(true)}
            className="p-2 rounded-lg hover:bg-[var(--bg-tertiary)] text-red-400 hover:text-red-300"
            title="Clear all local data"
          >
            <Trash2 className="w-5 h-5" />
          </button>

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
              <div 
                className="grid gap-2"
                style={{ 
                  gridTemplateColumns: `repeat(${gridCols}, ${gridCellSize}px)`,
                  gridAutoRows: `${gridCellSize + 32}px`, // +32 for header
                }}
              >
                {/* eslint-disable react-hooks/refs -- Dynamic refs for viewer capture */}
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
                          onAcpAnalyze={
                            AI_ENABLED
                              ? () =>
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
                              : undefined
                          }
                          acpAnalyzeDisabled={!AI_ENABLED || nanoBananaStatus === 'loading'}
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
                            setProgressWithClearAi(getProgressFromSlice(i, ref.instance_count, settings.offset));
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
                      </div>
                    </div>
                  );
                })}
                {/* eslint-enable react-hooks/refs */}
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
                    onAcpAnalyze={
                      AI_ENABLED
                        ? () => {
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
                          }
                        : undefined
                    }
                    acpAnalyzeDisabled={!AI_ENABLED || nanoBananaStatus === 'loading'}
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
                      // eslint-disable-next-line react-hooks/refs -- Dynamic ref for viewer capture
                      ref={getViewerRef('overlay')}
                      // Important: do not key by series/date.
                      // Remounting the viewer forces Cornerstone to re-enable the element,
                      // which causes a visible black flash when toggling dates.
                      studyId={overlayDisplayedRef.study_id}
                      seriesUid={overlayDisplayedRef.series_uid}
                      instanceIndex={overlayDisplayedSliceIndex}
                      instanceCount={overlayDisplayedRef.instance_count}
                      imageUrlOverride={overlayNanoBananaOverrideUrl}
                      onInstanceChange={(i) => {
                        setProgressWithClearAi(
                          getProgressFromSlice(
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

                    {AI_ENABLED && nanoBananaStatus === 'loading' && overlayIsNanoBananaTarget && (
                      <div className="absolute top-3 right-3 max-w-[70%]">
                        <div className="flex items-center gap-2 px-3 py-2 rounded bg-black/60">
                          <div className="w-6 h-6 border-2 border-[var(--accent)] border-t-transparent rounded-full animate-spin" />
                          <div className="text-xs text-white/90 truncate">
                            {nanoBananaProgressText || 'Working…'}
                          </div>
                        </div>
                      </div>
                    )}

                    {AI_ENABLED && nanoBananaStatus === 'ready' && overlayIsNanoBananaTarget && (
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

      {/* Slice navigator with loop + speed controls */}
      <div className="px-4 py-3 bg-[var(--bg-secondary)] border-t border-[var(--border-color)] flex items-center gap-4">
        <div className="flex items-center gap-2">
          <button
            type="button"
            className={`p-2 rounded-md border border-[var(--border-color)] ${isLooping ? 'bg-[var(--accent)] text-white border-[var(--accent)]' : 'bg-[var(--bg-tertiary)] text-[var(--text-secondary)] hover:text-[var(--text-primary)]'}`}
            onClick={() => {
              // Ensure loop window has size before starting
              const minGap = 0.02;
              if (loopEnd - loopStart < minGap) {
                const newEnd = clamp01(loopStart + minGap);
                updateLoop(loopStart, newEnd);
              }
              loopDirectionRef.current = 1;
              setIsLooping(!isLooping);
            }}
            title={isLooping ? 'Pause loop' : 'Play loop'}
          >
            {isLooping ? <Pause className="w-4 h-4" /> : <Play className="w-4 h-4" />}
          </button>
          <div className="flex items-center gap-1 text-[10px] text-[var(--text-secondary)]">
            Speed
            {[1, 2, 4].map(s => (
              <button
                key={s}
                type="button"
                className={`px-2 py-1 rounded border text-[10px] ${loopSpeed === s ? 'bg-[var(--accent)] text-white border-[var(--accent)]' : 'bg-[var(--bg-tertiary)] text-[var(--text-secondary)] hover:text-[var(--text-primary)] border-[var(--border-color)]'}`}
                onClick={() => setLoopSpeed(s as 1 | 2 | 4)}
              >
                {s}x
              </button>
            ))}
          </div>
        </div>

        <div className="text-xs text-[var(--text-secondary)] whitespace-nowrap">Slice</div>

        <div className="relative flex-1 h-8" ref={trackRef}>
          {/* Highlighted loop window */}
          <div
            className="absolute top-1/2 -translate-y-1/2 h-2 rounded bg-[var(--bg-tertiary)] w-full"
            aria-hidden
          />
          <div
            className="absolute top-1/2 -translate-y-1/2 h-2 rounded bg-[var(--accent)] opacity-40"
            style={{
              left: `${loopStart * 100}%`,
              width: `${Math.max(0, loopEnd - loopStart) * 100}%`,
            }}
            aria-hidden
          />

          {/* Main progress slider */}
          <input
            type="range"
            min={0}
            max={CONTROL_LIMITS.SLICE_NAV.MAX_RANGE}
            step={1}
            value={Math.round(progress * CONTROL_LIMITS.SLICE_NAV.MAX_RANGE)}
            onChange={(e) =>
              setProgressWithClearAi(parseInt(e.target.value, 10) / CONTROL_LIMITS.SLICE_NAV.MAX_RANGE)
            }
            className="absolute inset-0 w-full h-8 opacity-0 cursor-pointer"
            aria-label="Slice position"
          />

          {/* Visible thumb for current position */}
          <div
            className="absolute top-1/2 -translate-y-1/2 w-2 h-4 bg-[var(--text-primary)] rounded pointer-events-none"
            style={{ left: `calc(${progress * 100}% - 4px)` }}
            aria-hidden
          />

          {/* Loop handles */}
          {(['start', 'end'] as const).map(handle => {
            const pos = handle === 'start' ? loopStart : loopEnd;
            return (
              <button
                key={handle}
                type="button"
                className="absolute top-1/2 -translate-y-1/2 w-3 h-5 bg-white border border-[var(--accent)] rounded cursor-ew-resize"
                style={{ left: `calc(${pos * 100}% - 6px)` }}
                onMouseDown={(e) => {
                  e.preventDefault();
                  setDraggingHandle(handle);
                }}
                title={handle === 'start' ? 'Loop start' : 'Loop end'}
              />
            );
          })}
        </div>
      </div>
    </div>
  );
}
