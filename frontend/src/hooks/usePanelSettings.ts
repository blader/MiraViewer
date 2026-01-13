import { useState, useRef, useEffect, useCallback, useMemo } from 'react';
import type { PanelSettings } from '../types/api';
import { fetchPanelSettings, savePanelSettings } from '../utils/api';
import { DEFAULT_PANEL_SETTINGS } from '../utils/constants';

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

  // Keep refs up to date
  useEffect(() => {
    panelSettingsRef.current = panelSettings;
    selectedSeqIdRef.current = selectedSeqId;
  }, [panelSettings, selectedSeqId]);

  // Load panel settings from backend when sequence or dates change
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
        const server = await fetchPanelSettings(selectedSeqId);
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
          
          // Add settings for new dates (or all dates if seq changed)
          for (const date of newDates) {
            if (!next.has(date)) {
              const s = server[date] || {};
              next.set(date, {
                offset: typeof s.offset === 'number' ? s.offset : DEFAULT_PANEL_SETTINGS.offset,
                zoom: typeof s.zoom === 'number' ? s.zoom : DEFAULT_PANEL_SETTINGS.zoom,
                rotation: typeof s.rotation === 'number' ? s.rotation : DEFAULT_PANEL_SETTINGS.rotation,
                brightness: typeof s.brightness === 'number' ? s.brightness : DEFAULT_PANEL_SETTINGS.brightness,
                contrast: typeof s.contrast === 'number' ? s.contrast : DEFAULT_PANEL_SETTINGS.contrast,
                panX: typeof s.panX === 'number' ? s.panX : DEFAULT_PANEL_SETTINGS.panX,
                panY: typeof s.panY === 'number' ? s.panY : DEFAULT_PANEL_SETTINGS.panY,
                progress: typeof s.progress === 'number' ? s.progress : DEFAULT_PANEL_SETTINGS.progress,
              });
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
            const s = server[initial] || {};
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
    setPanelSettings(prev => {
      const current = prev.get(date) || { ...DEFAULT_PANEL_SETTINGS };
      const updated = { ...current, ...update };
      // Persist to backend (fire-and-forget)
      savePanelSettings(selectedSeqId, date, updated).catch(() => {});
      const next = new Map(prev);
      next.set(date, updated);
      return next;
    });
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
    updatePanelSetting
  };
}
