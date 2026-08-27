import { useState, useRef, useEffect, useCallback, useMemo } from 'react';
import type { PanelSettings, PanelSettingsPartial } from '../types/api';
import { getPanelSettings, savePanelSettings } from '../utils/localApi';
import { DEFAULT_PANEL_SETTINGS } from '../utils/constants';

function normalizePanelSettingsPartial(s: PanelSettingsPartial | undefined): PanelSettings {
  const out = { ...DEFAULT_PANEL_SETTINGS } as Record<string, unknown>;
  if (!s) return out as unknown as PanelSettings;

  for (const [k, def] of Object.entries(DEFAULT_PANEL_SETTINGS) as [keyof PanelSettings, unknown][]) {
    const v = (s as Record<string, unknown>)[k];
    if (typeof v === typeof def && v !== null) out[k] = v;
  }
  return out as unknown as PanelSettings;
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

export function usePanelSettings(
  selectedSeqId: string | null,
  enabledDatesKey: string,
  patientKey: string | null = null,
  interactionBlocked = false,
) {
  // Per-panel settings: Map<date, PanelSettings>
  const [panelSettings, setPanelSettings] = useState<Map<string, PanelSettings>>(new Map());
  const [activePanel, setActivePanel] = useState<string | null>(null); // date of panel being adjusted
  const [progress, setProgress] = useState(0); // 0..1 normalized
  const [persistenceError, setPersistenceError] = useState<string | null>(null);
  const [settingsOwner, setSettingsOwner] = useState({ patientKey, sequenceId: null as string | null });
  const settingsBelongToPatient = settingsOwner.patientKey === patientKey && settingsOwner.sequenceId === selectedSeqId;
  const [manuallyAdjustedDates, setManuallyAdjustedDates] = useState<Set<string>>(() => new Set());
  const clearManualAdjustments = useCallback(() => setManuallyAdjustedDates(new Set()), []);
  const holdAlignment = useCallback(
    (date: string) => setManuallyAdjustedDates((dates) => new Set(dates).add(date)),
    [],
  );

  const reportPersistenceFailure = useCallback((error: unknown) => {
    setPersistenceError(error instanceof Error ? error.message : 'Viewer settings could not be saved locally');
  }, []);

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

  // Clear undo/redo when the patient or sequence changes (different settings universe).
  useEffect(() => {
    undoStackRef.current.length = 0;
    redoStackRef.current.length = 0;
  }, [patientKey, selectedSeqId]);

  const applyPanelSettings = useCallback(
    (date: string, settings: PanelSettings) => {
      const seqId = selectedSeqIdRef.current;
      if (!seqId || !settingsBelongToPatient) return;

      const next = new Map(panelSettingsRef.current);
      next.set(date, settings);
      panelSettingsRef.current = next;
      setPanelSettings(next);
      setManuallyAdjustedDates((dates) => new Set(dates).add(date));

      // Persist to local storage (fire-and-forget)
      savePanelSettings(seqId, date, settings, patientKey).catch(reportPersistenceFailure);
    },
    [patientKey, reportPersistenceFailure, settingsBelongToPatient],
  );

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
    if (interactionBlocked) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      const target = e.target instanceof HTMLElement ? e.target : document.activeElement;
      if (
        e.defaultPrevented ||
        (target instanceof HTMLElement &&
          (target.isContentEditable ||
            target.closest(
              'input, select, textarea, [contenteditable=""], [contenteditable="true"], [role="dialog"], [aria-modal="true"]',
            )))
      ) {
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
  }, [interactionBlocked, redoLastPanelSetting, undoLastPanelSetting]);

  // Load panel settings from local storage when the patient, sequence, or dates change.
  useEffect(() => {
    if (!selectedSeqId) return;
    const currentDates = new Set(enabledDatesKey.split(',').filter(Boolean));
    if (currentDates.size === 0) return;

    // Determine if the settings owner changed or which dates are new.
    const scopeChanged = !settingsBelongToPatient;
    const newDates = scopeChanged
      ? currentDates
      : new Set([...currentDates].filter((d) => !prevDatesRef.current.has(d)));

    // Update refs
    prevDatesRef.current = currentDates;

    // If no new dates to fetch, nothing to do (keep all settings in memory)
    if (newDates.size === 0) {
      return;
    }

    let cancelled = false;
    (async () => {
      try {
        const stored = await getPanelSettings(selectedSeqId, patientKey);
        if (cancelled) return;

        setPanelSettings((prev) => {
          // Keep existing settings only when the same patient and sequence still own them.
          const next = new Map<string, PanelSettings>(scopeChanged ? [] : prev);

          // Hydrate all stored settings (not just enabled dates) so toggling dates later preserves saved values.
          for (const [date, s] of Object.entries(stored)) {
            if (!next.has(date)) next.set(date, normalizePanelSettingsPartial(s));
          }

          // Ensure enabled dates not present in storage still get defaults.
          for (const date of currentDates) {
            if (!next.has(date)) {
              next.set(date, { ...DEFAULT_PANEL_SETTINGS });
            }
          }

          return next;
        });
        setSettingsOwner({ patientKey, sequenceId: selectedSeqId });
        if (scopeChanged) setManuallyAdjustedDates(new Set());
        setPersistenceError(null);

        // Restore slice position only from settings belonging to the current owner.
        if (scopeChanged) {
          const sortedDates = [...currentDates].sort((a, b) => b.localeCompare(a));
          const initial = sortedDates[0];
          if (initial) {
            setActivePanel(initial);
            const s = stored[initial] || {};
            setProgress(typeof s.progress === 'number' ? Math.max(0, Math.min(1, s.progress)) : 0);
          }
        }
      } catch (error) {
        if (cancelled) return;
        reportPersistenceFailure(error);
        // A failed patient-scoped read must never inherit another patient's settings.
        setPanelSettings((prev) => {
          const next = new Map<string, PanelSettings>(scopeChanged ? [] : prev);
          for (const date of newDates) {
            if (!next.has(date)) {
              next.set(date, { ...DEFAULT_PANEL_SETTINGS });
            }
          }
          return next;
        });
        if (scopeChanged) setProgress(0);
        setSettingsOwner({ patientKey, sequenceId: selectedSeqId });
        if (scopeChanged) setManuallyAdjustedDates(new Set());
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [patientKey, selectedSeqId, enabledDatesKey, reportPersistenceFailure, settingsBelongToPatient]);

  // Update a panel's settings
  const updatePanelSetting = useCallback(
    (date: string, update: Partial<PanelSettings>) => {
      if (!selectedSeqId || !settingsBelongToPatient) return;

      const updateKeys = Object.keys(update);
      const shouldRecordHistory = updateKeys.some((k) => k !== 'progress');

      const current = panelSettingsRef.current.get(date) || { ...DEFAULT_PANEL_SETTINGS };
      const updated = { ...current, ...update };

      // Avoid pushing no-ops into history (e.g., clamped buttons).
      const updatedAny = updated as unknown as Record<string, unknown>;
      const currentAny = current as unknown as Record<string, unknown>;
      const isMeaningfulChange = updateKeys.some((k) => updatedAny[k] !== currentAny[k]);

      if (shouldRecordHistory && isMeaningfulChange) {
        setManuallyAdjustedDates((dates) => new Set(dates).add(date));
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

      const next = new Map(panelSettingsRef.current);
      next.set(date, updated);
      panelSettingsRef.current = next;
      setPanelSettings(next);

      // Persist to local storage (fire-and-forget)
      savePanelSettings(selectedSeqId, date, updated, patientKey).catch(reportPersistenceFailure);
    },
    [patientKey, selectedSeqId, reportPersistenceFailure, settingsBelongToPatient],
  );

  // Batch update multiple panels at once (for alignment results).
  // The undo stack groups all entries with the same batchId so Cmd/Ctrl+Z reverts the whole batch.
  const batchUpdateSettings = useCallback(
    (updates: Map<string, PanelSettings>, operationId?: string, automatic = false) => {
      if (!selectedSeqId || !settingsBelongToPatient || updates.size === 0) return;

      const batchId = operationId ?? `batch:${Date.now().toString(36)}:${Math.random().toString(36).slice(2, 8)}`;

      const historyEntries: PanelSettingsHistoryEntry[] = [];

      for (const [date, newSettings] of updates) {
        const current = panelSettingsRef.current.get(date) || { ...DEFAULT_PANEL_SETTINGS };
        historyEntries.push({
          date,
          before: { ...current },
          after: { ...current, ...newSettings },
          batchId,
        });
      }

      if (!automatic) {
        undoStackRef.current.push(...historyEntries);
        redoStackRef.current.length = 0;
        while (undoStackRef.current.length > MAX_HISTORY) undoStackRef.current.shift();
      }

      const next = new Map(panelSettingsRef.current);
      for (const { date, after } of historyEntries) next.set(date, after);
      panelSettingsRef.current = next;
      setPanelSettings(next);

      if (!automatic) {
        for (const { date, after } of historyEntries) {
          savePanelSettings(selectedSeqId, date, after, patientKey).catch(reportPersistenceFailure);
        }
      }
    },
    [patientKey, selectedSeqId, reportPersistenceFailure, settingsBelongToPatient],
  );

  // Debounced persistence of progress for the active panel
  useEffect(() => {
    if (!settingsBelongToPatient || !selectedSeqId || !effectiveActivePanel) return;
    const handle = setTimeout(() => {
      updatePanelSetting(effectiveActivePanel, { progress });
    }, 200);
    return () => clearTimeout(handle);
  }, [progress, effectiveActivePanel, selectedSeqId, settingsBelongToPatient, updatePanelSetting]);

  // Flush all in-memory settings on page unload (debounced progress writes may not have fired).
  useEffect(() => {
    const handleUnload = () => {
      const seqId = selectedSeqIdRef.current;
      const settings = panelSettingsRef.current;
      if (!settingsBelongToPatient || !seqId || settings.size === 0) return;
      for (const [date, s] of settings) {
        savePanelSettings(seqId, date, s, patientKey).catch(reportPersistenceFailure);
      }
    };
    window.addEventListener('beforeunload', handleUnload);
    return () => window.removeEventListener('beforeunload', handleUnload);
  }, [patientKey, reportPersistenceFailure, settingsBelongToPatient]);

  const scopedPanelSettings = useMemo(
    () => (settingsBelongToPatient ? panelSettings : new Map<string, PanelSettings>()),
    [panelSettings, settingsBelongToPatient],
  );

  return {
    panelSettings: scopedPanelSettings,
    settingsReady: settingsBelongToPatient,
    manuallyAdjustedDates,
    holdAlignment,
    clearManualAdjustments,
    activePanel: settingsBelongToPatient ? effectiveActivePanel : null,
    setActivePanel,
    progress: settingsBelongToPatient ? progress : 0,
    setProgress,
    updatePanelSetting,
    batchUpdateSettings,
    persistenceError: settingsBelongToPatient ? persistenceError : null,
    reportPersistenceError: reportPersistenceFailure,
    clearPersistenceError: () => setPersistenceError(null),
  };
}
