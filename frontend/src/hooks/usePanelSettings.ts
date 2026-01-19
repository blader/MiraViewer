import { useState, useRef, useEffect, useCallback, useMemo } from 'react';
import type { PanelSettings, PanelSettingsPartial } from '../types/api';
import { getPanelSettings, savePanelSettings } from '../utils/localApi';
import { DEFAULT_PANEL_SETTINGS } from '../utils/constants';

function normalizePanelSettingsPartial(s: PanelSettingsPartial | undefined): PanelSettings {
  return {
    offset: typeof s?.offset === 'number' ? s.offset : DEFAULT_PANEL_SETTINGS.offset,
    zoom: typeof s?.zoom === 'number' ? s.zoom : DEFAULT_PANEL_SETTINGS.zoom,
    rotation: typeof s?.rotation === 'number' ? s.rotation : DEFAULT_PANEL_SETTINGS.rotation,
    brightness: typeof s?.brightness === 'number' ? s.brightness : DEFAULT_PANEL_SETTINGS.brightness,
    contrast: typeof s?.contrast === 'number' ? s.contrast : DEFAULT_PANEL_SETTINGS.contrast,
    panX: typeof s?.panX === 'number' ? s.panX : DEFAULT_PANEL_SETTINGS.panX,
    panY: typeof s?.panY === 'number' ? s.panY : DEFAULT_PANEL_SETTINGS.panY,
    progress: typeof s?.progress === 'number' ? s.progress : DEFAULT_PANEL_SETTINGS.progress,
  };
}

type PanelSettingsHistoryEntry = {
  date: string;
  before: PanelSettings;
  after: PanelSettings;
  /**
   * Optional batch identifier.
   * If present, undo/redo will apply all contiguous entries with the same batchId
   * as a single user-visible operation.
   */
  batchId?: string;
};

const MAX_HISTORY = 200;

export function usePanelSettings(selectedSeqId: string | null, enabledDatesKey: string) {
  // Per-panel settings: Map<date, PanelSettings>
  const [panelSettings, setPanelSettings] = useState<Map<string, PanelSettings>>(new Map());
  const [activePanel, setActivePanel] = useState<string | null>(null); // date of panel being adjusted
  const [progress, setProgress] = useState(0); // 0..1 normalized

  // Keep activePanel usable even if enabled dates change.
  // enabledDatesKey is already sorted ascending (ISO), so newest is the last entry.
  const effectiveActivePanel = useMemo(() => {
    const dates = enabledDatesKey.split(',').filter(Boolean);
    if (dates.length === 0) return null;
    if (activePanel && dates.includes(activePanel)) return activePanel;
    return dates[dates.length - 1] || null;
  }, [enabledDatesKey, activePanel]);
  
  // Refs for persistence
  const panelSettingsRef = useRef(panelSettings);
  const selectedSeqIdRef = useRef(selectedSeqId);
  const prevSeqIdRef = useRef<string | null>(null);
  const prevDatesRef = useRef<Set<string>>(new Set());

  // Undo/redo stacks for panel settings changes (pan/zoom/rotation/etc).
  // Stored in refs to avoid re-rendering on every adjustment.
  const undoStackRef = useRef<PanelSettingsHistoryEntry[]>([]);
  const redoStackRef = useRef<PanelSettingsHistoryEntry[]>([]);

  // Keep refs up to date
  useEffect(() => {
    panelSettingsRef.current = panelSettings;
    selectedSeqIdRef.current = selectedSeqId;
  }, [panelSettings, selectedSeqId]);

  // Clear undo/redo when the sequence changes (different settings universe).
  useEffect(() => {
    undoStackRef.current.length = 0;
    redoStackRef.current.length = 0;
  }, [selectedSeqId]);

  const applyPanelSettings = useCallback((date: string, settings: PanelSettings) => {
    const seqId = selectedSeqIdRef.current;
    if (!seqId) return;

    setPanelSettings((prev) => {
      const next = new Map(prev);
      next.set(date, settings);
      return next;
    });

    // Persist to local storage (fire-and-forget)
    savePanelSettings(seqId, date, settings).catch(() => {});
  }, []);

  const undoLastPanelSetting = useCallback(() => {
    const entry = undoStackRef.current.pop();
    if (!entry) return;

    const batchId = entry.batchId;

    // Batch undo: pop all contiguous entries with the same batchId.
    if (batchId) {
      const batch: PanelSettingsHistoryEntry[] = [entry];
      while (
        undoStackRef.current.length > 0 &&
        undoStackRef.current[undoStackRef.current.length - 1]?.batchId === batchId
      ) {
        const next = undoStackRef.current.pop();
        if (!next) break;
        batch.push(next);
      }

      for (const e of batch) {
        redoStackRef.current.push(e);
        applyPanelSettings(e.date, e.before);
      }

      return;
    }

    redoStackRef.current.push(entry);
    applyPanelSettings(entry.date, entry.before);
  }, [applyPanelSettings]);

  const redoLastPanelSetting = useCallback(() => {
    const entry = redoStackRef.current.pop();
    if (!entry) return;

    const batchId = entry.batchId;

    // Batch redo: pop all contiguous entries with the same batchId.
    if (batchId) {
      const batch: PanelSettingsHistoryEntry[] = [entry];
      while (
        redoStackRef.current.length > 0 &&
        redoStackRef.current[redoStackRef.current.length - 1]?.batchId === batchId
      ) {
        const next = redoStackRef.current.pop();
        if (!next) break;
        batch.push(next);
      }

      for (const e of batch) {
        undoStackRef.current.push(e);
        applyPanelSettings(e.date, e.after);
      }

      return;
    }

    undoStackRef.current.push(entry);
    applyPanelSettings(entry.date, entry.after);
  }, [applyPanelSettings]);

  // Keyboard shortcuts: Cmd/Ctrl+Z undo, Cmd/Ctrl+Shift+Z (or Ctrl+Y) redo.
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      const tagName = target?.tagName;
      if (tagName === 'INPUT' || tagName === 'SELECT' || tagName === 'TEXTAREA') {
        return;
      }

      const key = e.key.toLowerCase();
      const mod = e.metaKey || e.ctrlKey;
      if (!mod) return;

      const isUndo = key === 'z' && !e.shiftKey;
      const isRedo = (key === 'z' && e.shiftKey) || key === 'y';

      if (isUndo) {
        if (undoStackRef.current.length === 0) return;
        e.preventDefault();
        undoLastPanelSetting();
      }

      if (isRedo) {
        if (redoStackRef.current.length === 0) return;
        e.preventDefault();
        redoLastPanelSetting();
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [undoLastPanelSetting, redoLastPanelSetting]);

  // Load panel settings from local storage when sequence or dates change
  useEffect(() => {
    if (!selectedSeqId) return;
    const currentDates = new Set(enabledDatesKey.split(',').filter(Boolean));
    if (currentDates.size === 0) return;
    
    // Determine if sequence changed or which dates are new
    const seqChanged = selectedSeqId !== prevSeqIdRef.current;
    const newDates = seqChanged 
      ? currentDates 
      : new Set([...currentDates].filter(d => !prevDatesRef.current.has(d)));
    
    // Update refs
    prevSeqIdRef.current = selectedSeqId;
    prevDatesRef.current = currentDates;
    
    // If no new dates to fetch, nothing to do (keep all settings in memory)
    if (newDates.size === 0) {
      return;
    }
    
    let cancelled = false;
    (async () => {
      try {
        const stored = await getPanelSettings(selectedSeqId);
        if (cancelled) return;
        
        setPanelSettings(prev => {
          const next = new Map<string, PanelSettings>();

          // Keep existing settings for dates that are still enabled (unless seq changed)
          if (!seqChanged) {
            for (const [date, settings] of prev) {
              if (currentDates.has(date)) {
                next.set(date, settings);
              }
            }
          }

          // Hydrate all stored settings (not just enabled dates) so toggling dates later preserves saved values.
          for (const [date, s] of Object.entries(stored)) {
            next.set(date, normalizePanelSettingsPartial(s));
          }

          // Ensure enabled dates not present in storage still get defaults.
          for (const date of currentDates) {
            if (!next.has(date)) {
              next.set(date, { ...DEFAULT_PANEL_SETTINGS });
            }
          }

          return next;
        });
        
        // Set initial active panel if none or if seq changed
        if (seqChanged) {
          const sortedDates = [...currentDates].sort((a, b) => b.localeCompare(a));
          const initial = sortedDates[0];
          if (initial) {
            setActivePanel(initial);
            const s = stored[initial] || {};
            if (typeof s.progress === 'number') {
              setProgress(Math.max(0, Math.min(1, s.progress)));
            }
          }
        }
      } catch {
        if (cancelled) return;
        // Fallback: add defaults for new dates only
        setPanelSettings(prev => {
          const next = new Map(prev);
          for (const date of newDates) {
            if (!next.has(date)) {
              next.set(date, { ...DEFAULT_PANEL_SETTINGS });
            }
          }
          return next;
        });
      }
    })();
    return () => { cancelled = true; };
  }, [selectedSeqId, enabledDatesKey]);

  // Update a panel's settings
  const updatePanelSetting = useCallback((date: string, update: Partial<PanelSettings>) => {
    if (!selectedSeqId) return;

    const updateKeys = Object.keys(update);
    const shouldRecordHistory = updateKeys.some((k) => k !== 'progress');

    setPanelSettings((prev) => {
      const current = prev.get(date) || { ...DEFAULT_PANEL_SETTINGS };
      const updated = { ...current, ...update };

      // Avoid pushing no-ops into history (e.g., clamped buttons).
      const updatedAny = updated as unknown as Record<string, unknown>;
      const currentAny = current as unknown as Record<string, unknown>;
      const isMeaningfulChange = updateKeys.some((k) => updatedAny[k] !== currentAny[k]);

      if (shouldRecordHistory && isMeaningfulChange) {
        undoStackRef.current.push({
          date,
          before: { ...current },
          after: { ...updated },
        });

        // New action invalidates redo stack.
        redoStackRef.current.length = 0;

        // Cap memory.
        if (undoStackRef.current.length > MAX_HISTORY) {
          undoStackRef.current.shift();
        }
      }

      // Persist to local storage (fire-and-forget)
      savePanelSettings(selectedSeqId, date, updated).catch(() => {});

      const next = new Map(prev);
      next.set(date, updated);
      return next;
    });
  }, [selectedSeqId]);

  // Batch update multiple panels at once (for alignment results).
  // The undo stack groups all entries with the same batchId so Cmd/Ctrl+Z reverts the whole batch.
  const batchUpdateSettings = useCallback((updates: Map<string, PanelSettings>) => {
    if (!selectedSeqId || updates.size === 0) return;

    const batchId = `batch:${Date.now().toString(36)}:${Math.random().toString(36).slice(2, 8)}`;

    const historyEntries: PanelSettingsHistoryEntry[] = [];

    setPanelSettings((prev) => {
      const next = new Map(prev);

      for (const [date, newSettings] of updates) {
        const current = prev.get(date) || { ...DEFAULT_PANEL_SETTINGS };
        const updated = { ...current, ...newSettings };

        historyEntries.push({
          date,
          before: { ...current },
          after: { ...updated },
          batchId,
        });

        next.set(date, updated);

        // Persist (fire-and-forget)
        savePanelSettings(selectedSeqId, date, updated).catch(() => {});
      }

      return next;
    });

    if (historyEntries.length > 0) {
      for (const entry of historyEntries) {
        undoStackRef.current.push(entry);
      }

      // New action invalidates redo stack.
      redoStackRef.current.length = 0;

      // Cap memory.
      while (undoStackRef.current.length > MAX_HISTORY) {
        undoStackRef.current.shift();
      }
    }
  }, [selectedSeqId]);

  // Debounced persistence of progress for the active panel
  useEffect(() => {
    if (!selectedSeqId || !effectiveActivePanel) return;
    const handle = setTimeout(() => {
      updatePanelSetting(effectiveActivePanel, { progress });
    }, 200);
    return () => clearTimeout(handle);
  }, [progress, effectiveActivePanel, selectedSeqId, updatePanelSetting]);

  // Persist all panel settings periodically and on page unload
  useEffect(() => {
    const saveAll = () => {
      const seqId = selectedSeqIdRef.current;
      const settings = panelSettingsRef.current;
      if (!seqId || settings.size === 0) return;
      for (const [date, s] of settings) {
        savePanelSettings(seqId, date, s).catch(() => {});
      }
    };
    
    // Save on beforeunload
    const handleUnload = () => saveAll();
    window.addEventListener('beforeunload', handleUnload);
    
    // Also save periodically (every 10 seconds)
    const interval = setInterval(saveAll, 10000);
    
    return () => {
      window.removeEventListener('beforeunload', handleUnload);
      clearInterval(interval);
    };
  }, []);

  return {
    panelSettings,
    activePanel: effectiveActivePanel,
    setActivePanel,
    progress,
    setProgress,
    updatePanelSetting,
    batchUpdateSettings,
  };
}
