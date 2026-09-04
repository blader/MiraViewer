import { useState, useRef, useEffect, useEffectEvent, useLayoutEffect, useCallback, useMemo } from 'react';
import type { PanelSettings, PanelSettingsPartial, SeriesRef } from '../types/api';
import { getPanelSettingsSnapshot, savePanelSettings } from '../utils/localApi';
import type { LegacyPanelSettings, VerifiedPanelSettingsSource } from '../db/panelSettings';
import { DatasetReplacedError, subscribeDatasetMutations } from '../db/db';
import { DEFAULT_PANEL_SETTINGS } from '../utils/constants';
import {
  adjustAlignment,
  alignmentDisplayBaseline,
  applyAlignmentAdjustment,
  normalizeAlignmentAdjustment,
  normalizeAlignmentBaseline,
  removeAlignmentAdjustment,
} from '../utils/alignmentAdjustment';
import { getSliceIndex } from '../utils/math';

function normalizePanelSettingsPartial(s: PanelSettingsPartial | undefined): PanelSettings {
  const out = { ...DEFAULT_PANEL_SETTINGS } as Record<string, unknown>;
  if (!s) return out as unknown as PanelSettings;

  for (const [k, def] of Object.entries(DEFAULT_PANEL_SETTINGS) as [keyof PanelSettings, unknown][]) {
    const v = (s as Record<string, unknown>)[k];
    if (typeof v === typeof def && v !== null && (typeof v !== 'number' || Number.isFinite(v))) out[k] = v;
  }
  out.alignmentAdjustment = normalizeAlignmentAdjustment(s.alignmentAdjustment);
  out.alignmentBaseline = normalizeAlignmentBaseline(s.alignmentBaseline);
  out.alignmentPaused = s.alignmentPaused === true;
  return out as unknown as PanelSettings;
}

function changedSettings(before: PanelSettings, after: PanelSettings): Partial<PanelSettings> {
  const changes: Record<string, unknown> = {};
  for (const key of Object.keys({ ...before, ...after }) as (keyof PanelSettings)[]) {
    if (key === 'progress' || key === 'alignmentBaseline') continue;
    const changed =
      key === 'alignmentPaused'
        ? !!before.alignmentPaused !== !!after.alignmentPaused
        : JSON.stringify(before[key]) !== JSON.stringify(after[key]);
    if (changed) changes[key] = after[key];
  }
  return changes as Partial<PanelSettings>;
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
type SettingsOwner = {
  patientKey: string | null;
  sequenceId: string;
  datasetToken: string;
  sourcesKey: string;
  loadAttempt: number;
  // null is an ephemeral browsing owner after a failed read, never a writer.
  verifiedSources: Record<string, VerifiedPanelSettingsSource> | null;
};

export function usePanelSettings(
  selectedSeqId: string | null,
  enabledDatesKey: string,
  patientKey: string | null = null,
  interactionBlocked = false,
  seriesByDate?: Record<string, SeriesRef>,
  datasetToken?: string,
) {
  // Per-panel settings: Map<date, PanelSettings>
  const [panelSettings, setPanelSettings] = useState<Map<string, PanelSettings>>(new Map());
  const [activePanel, setActivePanel] = useState<string | null>(null); // date of panel being adjusted
  const [progress, setProgress] = useState(0); // 0..1 normalized
  const [persistenceFailure, setPersistenceFailure] = useState<{
    patientKey: string | null;
    sequenceId: string | null;
    message: string;
  } | null>(null);
  const persistenceError =
    persistenceFailure?.patientKey === patientKey && persistenceFailure.sequenceId === selectedSeqId
      ? persistenceFailure.message
      : null;
  const [legacySettings, setLegacySettings] = useState<LegacyPanelSettings[]>([]);
  const [settingsOwner, setSettingsOwner] = useState<SettingsOwner | null>(null);
  const currentOwnerRef = useRef<SettingsOwner | null>(null);
  const replacementVersionRef = useRef(0);
  const [replacement, setReplacement] = useState<{ token?: string; version: number } | null>(null);
  const [loadAttempt, setLoadAttempt] = useState(0);
  const sourcesKey = useMemo(
    () =>
      JSON.stringify(
        Object.entries(seriesByDate ?? {})
          .map(([date, source]) => [date, source.study_id, source.series_uid])
          .sort(([a], [b]) => a!.localeCompare(b!)),
      ),
    [seriesByDate],
  );
  const settingsBelongToPatient =
    settingsOwner !== null &&
    settingsOwner.patientKey === patientKey &&
    settingsOwner.sequenceId === selectedSeqId &&
    settingsOwner.sourcesKey === sourcesKey &&
    (datasetToken === undefined || settingsOwner.datasetToken === datasetToken);
  const browsingReady =
    settingsBelongToPatient &&
    enabledDatesKey
      .split(',')
      .filter(Boolean)
      .every((date) => panelSettings.has(date));
  const settingsReady = browsingReady && settingsOwner?.verifiedSources !== null;
  const canEdit = useCallback(
    () => browsingReady && currentOwnerRef.current === settingsOwner,
    [browsingReady, settingsOwner],
  );
  const canWrite = useCallback(
    () => settingsReady && currentOwnerRef.current === settingsOwner,
    [settingsReady, settingsOwner],
  );
  useLayoutEffect(() => {
    if (!settingsBelongToPatient) currentOwnerRef.current = null;
  }, [settingsBelongToPatient]);

  const retireWriter = useCallback(() => {
    const token = datasetToken ?? currentOwnerRef.current?.datasetToken;
    currentOwnerRef.current = null;
    setSettingsOwner(null);
    setReplacement({ token, version: ++replacementVersionRef.current });
    setPersistenceFailure({
      patientKey,
      sequenceId: selectedSeqId,
      message: 'Saved scans changed. Reload their viewer settings.',
    });
  }, [datasetToken, patientKey, selectedSeqId]);

  useEffect(
    () =>
      subscribeDatasetMutations((seriesUid) => {
        if (seriesUid !== undefined) return; // Additive imports do not replace saved settings.
        retireWriter();
      }),
    [retireWriter],
  );

  const retryLoad = useCallback(() => {
    setReplacement(null);
    setLoadAttempt((attempt) => attempt + 1);
  }, []);

  const reportPersistenceFailure = useCallback(
    (error: unknown) => {
      if (error instanceof DatasetReplacedError) {
        retireWriter();
        return;
      }
      setPersistenceFailure({
        patientKey,
        sequenceId: selectedSeqId,
        message: error instanceof Error ? error.message : 'Viewer settings could not be saved locally',
      });
    },
    [patientKey, selectedSeqId, retireWriter],
  );

  const persist = useCallback(
    (date: string, settings: PanelSettings) => {
      const source = canWrite() ? settingsOwner?.verifiedSources?.[date] : undefined;
      // A date with no selected acquisition is display-only, never a legacy row.
      if (source) void savePanelSettings(source, settings).catch(reportPersistenceFailure);
    },
    [canWrite, settingsOwner, reportPersistenceFailure],
  );

  // Keep activePanel usable even if enabled dates change.
  // enabledDatesKey is already sorted ascending (ISO), so newest is the last entry.
  const effectiveActivePanel = useMemo(() => {
    const dates = enabledDatesKey.split(',').filter((date) => date && seriesByDate?.[date]);
    if (dates.length === 0) return null;
    if (activePanel && dates.includes(activePanel)) return activePanel;
    return dates[dates.length - 1] || null;
  }, [enabledDatesKey, activePanel, seriesByDate]);

  // Refs for persistence
  const panelSettingsRef = useRef(panelSettings);
  const selectedSeqIdRef = useRef(selectedSeqId);
  const prevDatesRef = useRef<Set<string>>(new Set());
  // The latest uncorrected presentation is disposable computation. Manual intent
  // lives with persisted panel settings and is never replaced by an async result.
  const baselineSettingsRef = useRef(new Map<string, PanelSettings>());
  const pendingBaselineDatesRef = useRef(new Set<string>());

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
  }, [patientKey, selectedSeqId, datasetToken, sourcesKey, replacement]);

  const applyPanelSettings = useCallback(
    (date: string, saved: PanelSettings, opposite: PanelSettings) => {
      const seqId = selectedSeqIdRef.current;
      if (!seqId || !canEdit()) return;

      const current = panelSettingsRef.current.get(date) ?? DEFAULT_PANEL_SETTINGS;
      const changes = changedSettings(opposite, saved);
      const reverseSliceOrder = changes.reverseSliceOrder ?? current.reverseSliceOrder;
      let settings = { ...current, ...changes, progress: current.progress };
      const intentChanged = 'alignmentAdjustment' in changes;
      const modeChanged = !!saved.alignmentPaused !== !!opposite.alignmentPaused;
      if (modeChanged && saved.alignmentPaused) {
        // An acquired presentation is a complete mode transition, including fields
        // that happened to equal native defaults when the action was first made.
        settings = {
          ...saved,
          alignmentBaseline: alignmentDisplayBaseline(
            baselineSettingsRef.current.get(date) ?? removeAlignmentAdjustment(current),
          ),
          offset: current.offset,
          reverseSliceOrder,
          progress: current.progress,
        };
      } else if (!settings.alignmentPaused && (intentChanged || modeChanged)) {
        const baseline = baselineSettingsRef.current.get(date) ?? removeAlignmentAdjustment(current);
        settings = {
          ...applyAlignmentAdjustment(baseline, saved.alignmentAdjustment),
          offset: current.offset,
          reverseSliceOrder,
          progress: current.progress,
          alignmentPaused: false,
        };
      }
      if (intentChanged && !settings.alignmentPaused) {
        settings.offset =
          current.offset +
          ((saved.alignmentAdjustment?.sliceOffset ?? 0) - (current.alignmentAdjustment?.sliceOffset ?? 0)) *
            (reverseSliceOrder ? -1 : 1);
      }
      if (reverseSliceOrder !== current.reverseSliceOrder) {
        const count = seriesByDate?.[date]?.instance_count;
        const logical = count ? getSliceIndex(count, progress, current.offset) : null;
        settings.offset =
          logical !== null && count
            ? current.offset + count - 1 - 2 * logical
            : current.offset + saved.offset - opposite.offset;
      }

      const next = new Map(panelSettingsRef.current);
      next.set(date, settings);
      panelSettingsRef.current = next;
      setPanelSettings(next);

      // Persist to local storage (fire-and-forget)
      pendingBaselineDatesRef.current.delete(date);
      persist(date, settings);
    },
    [progress, seriesByDate, canEdit, persist],
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
        applyPanelSettings(e.date, e.before, e.after);
      }

      return;
    }

    redoStackRef.current.push(entry);
    applyPanelSettings(entry.date, entry.before, entry.after);
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
        applyPanelSettings(e.date, e.after, e.before);
      }

      return;
    }

    undoStackRef.current.push(entry);
    applyPanelSettings(entry.date, entry.after, entry.before);
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
  const readStoredSettings = useEffectEvent((sequenceId: string, ownerPatient: string | null) =>
    getPanelSettingsSnapshot(sequenceId, ownerPatient, seriesByDate),
  );
  useEffect(() => {
    if (!selectedSeqId) return;
    // Wait for the parent to load the replacement catalog. In particular, do not
    // hydrate defaults from a just-deleted database using the old visible dates.
    if (replacement && (datasetToken === undefined || datasetToken === replacement.token)) return;
    const currentDates = new Set(enabledDatesKey.split(',').filter(Boolean));
    if (currentDates.size === 0) return;

    // Determine if the settings owner changed or which dates are new.
    const scopeChanged = !settingsBelongToPatient;
    const retrying = settingsOwner?.loadAttempt !== loadAttempt;
    const newDates =
      scopeChanged || retrying ? currentDates : new Set([...currentDates].filter((d) => !prevDatesRef.current.has(d)));

    // If no new dates to fetch, nothing to do (keep all settings in memory)
    if (newDates.size === 0) {
      return;
    }

    let cancelled = false;
    const replacementVersion = replacementVersionRef.current;
    const publishOwner = (verifiedSources: SettingsOwner['verifiedSources'], ownerToken: string) => {
      const owner = {
        patientKey,
        sequenceId: selectedSeqId,
        datasetToken: ownerToken,
        sourcesKey,
        loadAttempt,
        verifiedSources,
      };
      currentOwnerRef.current = owner;
      setSettingsOwner(owner);
    };
    (async () => {
      try {
        const snapshot = await readStoredSettings(selectedSeqId, patientKey);
        if (cancelled || replacementVersion !== replacementVersionRef.current) return;
        if (datasetToken !== undefined && snapshot.datasetToken !== datasetToken) {
          throw new DatasetReplacedError();
        }
        const stored = snapshot.settings;

        const replaceSettings = scopeChanged || retrying;
        const next = new Map<string, PanelSettings>(replaceSettings ? [] : panelSettingsRef.current);
        const previousBaselines = baselineSettingsRef.current;
        if (replaceSettings) {
          baselineSettingsRef.current = new Map();
          pendingBaselineDatesRef.current.clear();
        }
        // A catalog addition or date collision does not replace an unchanged
        // acquisition's current presentation. Carry it by the verified source,
        // never by a display date that may now name a different examination.
        if (
          !retrying &&
          settingsOwner?.patientKey === patientKey &&
          settingsOwner.sequenceId === selectedSeqId &&
          settingsOwner.datasetToken === snapshot.datasetToken
        ) {
          const previousDates = new Map(
            Object.entries(settingsOwner.verifiedSources ?? {}).map(([date, source]) => [
              source.seriesUid,
              { date, studyUid: source.studyUid },
            ]),
          );
          for (const [date, source] of Object.entries(snapshot.verifiedSources)) {
            const previous = previousDates.get(source.seriesUid);
            if (!previous || previous.studyUid !== source.studyUid) continue;
            const settings = panelSettingsRef.current.get(previous.date);
            if (settings) next.set(date, settings);
            const baseline = previousBaselines.get(previous.date);
            if (baseline) baselineSettingsRef.current.set(date, baseline);
          }
        }
        // Hydrate hidden dates too; their corrections survive hide/show without a second authority.
        for (const [date, saved] of Object.entries(stored)) {
          if (!next.has(date)) next.set(date, normalizePanelSettingsPartial(saved));
        }
        for (const date of currentDates) {
          if (!next.has(date)) next.set(date, { ...DEFAULT_PANEL_SETTINGS });
        }
        for (const [date, settings] of next) {
          if (!baselineSettingsRef.current.has(date)) {
            baselineSettingsRef.current.set(date, removeAlignmentAdjustment(settings));
          }
        }
        panelSettingsRef.current = next;
        setPanelSettings(next);
        setPersistenceFailure(null);
        setLegacySettings(snapshot.legacySettings ?? []);
        prevDatesRef.current = currentDates;
        publishOwner(snapshot.verifiedSources, snapshot.datasetToken);

        // A new acquisition/catalog changes source-bound settings, not the shared
        // browsing position. Only a patient/sequence or saved-work replacement
        // hydrates progress; this also preserves position through date collisions.
        const restoreProgress =
          !settingsOwner?.verifiedSources ||
          settingsOwner.patientKey !== patientKey ||
          settingsOwner.sequenceId !== selectedSeqId ||
          settingsOwner.datasetToken !== snapshot.datasetToken;
        if (restoreProgress) {
          const sortedDates = [...currentDates]
            .filter((date) => snapshot.verifiedSources[date])
            .sort((a, b) => b.localeCompare(a));
          const initial = sortedDates[0];
          if (initial) {
            setActivePanel(initial);
            const s = stored[initial] || {};
            setProgress(
              typeof s.progress === 'number' && Number.isFinite(s.progress) ? Math.max(0, Math.min(1, s.progress)) : 0,
            );
          }
        }
      } catch (error) {
        if (cancelled || replacementVersion !== replacementVersionRef.current) return;
        reportPersistenceFailure(error);
        if (error instanceof DatasetReplacedError) return;
        // Absence is a successful read of no row. A failed read grants no write
        // authority, but browsing and temporary adjustments remain available.
        const next = new Map<string, PanelSettings>(scopeChanged ? [] : panelSettingsRef.current);
        for (const date of currentDates) if (!next.has(date)) next.set(date, { ...DEFAULT_PANEL_SETTINGS });
        if (scopeChanged) {
          baselineSettingsRef.current.clear();
          pendingBaselineDatesRef.current.clear();
          setProgress(0);
        }
        panelSettingsRef.current = next;
        setPanelSettings(next);
        setLegacySettings([]);
        prevDatesRef.current = currentDates;
        publishOwner(null, datasetToken ?? '');
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [
    patientKey,
    selectedSeqId,
    enabledDatesKey,
    reportPersistenceFailure,
    settingsBelongToPatient,
    datasetToken,
    replacement,
    loadAttempt,
    sourcesKey,
    settingsOwner,
  ]);

  // Update a panel's settings
  const updatePanelSetting = useCallback(
    (date: string, update: Partial<PanelSettings>) => {
      if (!selectedSeqId || !canEdit() || !panelSettingsRef.current.has(date)) return;

      const updateKeys = Object.keys(update);
      const shouldRecordHistory = updateKeys.some((k) => k !== 'progress');

      const current = panelSettingsRef.current.get(date) || { ...DEFAULT_PANEL_SETTINGS };
      const baseline = baselineSettingsRef.current.get(date) ?? removeAlignmentAdjustment(current);
      baselineSettingsRef.current.set(date, baseline);
      let updated = { ...current, ...update };
      if (update.alignmentPaused !== undefined && update.alignmentPaused !== !!current.alignmentPaused) {
        // Entering acquired mode changes presentation only. Keep the linked correction
        // so Resume (or undo) can restore it without reconstructing manual intent.
        updated.alignmentAdjustment = current.alignmentAdjustment;
        updated.alignmentBaseline = alignmentDisplayBaseline(baseline);
        if (!update.alignmentPaused) {
          updated = {
            ...applyAlignmentAdjustment(baseline, current.alignmentAdjustment),
            offset: current.offset,
            reverseSliceOrder: current.reverseSliceOrder,
            progress: current.progress,
            alignmentPaused: false,
          };
        }
      } else if ('alignmentAdjustment' in update) {
        const adjustment = normalizeAlignmentAdjustment(update.alignmentAdjustment);
        updated = current.alignmentPaused
          ? { ...updated, alignmentAdjustment: adjustment }
          : {
              ...applyAlignmentAdjustment(baseline, adjustment),
              offset:
                current.offset +
                ((adjustment?.sliceOffset ?? 0) - (current.alignmentAdjustment?.sliceOffset ?? 0)) *
                  (current.reverseSliceOrder ? -1 : 1),
              reverseSliceOrder: current.reverseSliceOrder,
              progress: current.progress,
              alignmentPaused: false,
            };
      } else if (!current.alignmentPaused) {
        updated.alignmentAdjustment = adjustAlignment(current, update, baseline);
        updated.alignmentBaseline = updated.alignmentAdjustment ? alignmentDisplayBaseline(baseline) : undefined;
      }

      // Avoid pushing no-ops into history (e.g., clamped buttons).
      const isMeaningfulChange = Object.keys(changedSettings(current, updated)).length > 0;

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

      const next = new Map(panelSettingsRef.current);
      next.set(date, updated);
      panelSettingsRef.current = next;
      setPanelSettings(next);

      // Persist to local storage (fire-and-forget)
      pendingBaselineDatesRef.current.delete(date);
      persist(date, updated);
    },
    [selectedSeqId, canEdit, persist],
  );

  // Batch update multiple panels at once (for alignment results).
  // The undo stack groups all entries with the same batchId so Cmd/Ctrl+Z reverts the whole batch.
  const batchUpdateSettings = useCallback(
    (updates: Map<string, PanelSettings>, operationId?: string, automatic = false) => {
      if (!selectedSeqId || !canEdit() || updates.size === 0) return;

      const batchId = operationId ?? `batch:${Date.now().toString(36)}:${Math.random().toString(36).slice(2, 8)}`;

      const historyEntries: PanelSettingsHistoryEntry[] = [];

      for (const [date, newSettings] of updates) {
        const current = panelSettingsRef.current.get(date) || { ...DEFAULT_PANEL_SETTINGS };
        if (automatic && current.alignmentPaused) continue;
        baselineSettingsRef.current.set(date, {
          ...newSettings,
          alignmentAdjustment: undefined,
          alignmentPaused: false,
        });
        historyEntries.push({
          date,
          before: { ...current },
          after: {
            ...applyAlignmentAdjustment(newSettings, current.alignmentAdjustment),
            alignmentPaused: current.alignmentPaused,
          },
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
          pendingBaselineDatesRef.current.delete(date);
          persist(date, after);
        }
      } else {
        for (const { date } of historyEntries) pendingBaselineDatesRef.current.add(date);
      }
    },
    [selectedSeqId, canEdit, persist],
  );

  // Debounced persistence of progress for the active panel
  useEffect(() => {
    if (
      !settingsReady ||
      !selectedSeqId ||
      !effectiveActivePanel ||
      panelSettingsRef.current.get(effectiveActivePanel)?.progress === progress
    )
      return;
    const handle = setTimeout(() => {
      updatePanelSetting(effectiveActivePanel, { progress });
    }, 200);
    return () => clearTimeout(handle);
  }, [progress, effectiveActivePanel, selectedSeqId, settingsReady, updatePanelSetting]);

  // Edits save immediately. Flush only changed automatic baselines and pending
  // progress so a reload retains the unclipped baseline underlying manual intent.
  useEffect(() => {
    const handleUnload = () => {
      if (!selectedSeqId || !canWrite()) return;
      const pending = new Set(pendingBaselineDatesRef.current);
      if (effectiveActivePanel && panelSettingsRef.current.get(effectiveActivePanel)?.progress !== progress) {
        pending.add(effectiveActivePanel);
      }
      for (const date of pending) {
        const settings = panelSettingsRef.current.get(date);
        if (!settings) continue;
        persist(date, date === effectiveActivePanel ? { ...settings, progress } : settings);
      }
    };
    window.addEventListener('beforeunload', handleUnload);
    return () => window.removeEventListener('beforeunload', handleUnload);
  }, [effectiveActivePanel, progress, selectedSeqId, canWrite, persist]);

  const scopedPanelSettings = useMemo(
    () => (settingsBelongToPatient ? panelSettings : new Map<string, PanelSettings>()),
    [panelSettings, settingsBelongToPatient],
  );

  const assignLegacySettings = useCallback(
    async (id: string, date: string) => {
      const legacy = legacySettings.find((entry) => entry.id === id && entry.eligibleDates.includes(date));
      const source = settingsOwner?.verifiedSources?.[date];
      if (!legacy || !source || !selectedSeqId || !canWrite()) return;
      const settings = normalizePanelSettingsPartial(legacy.settings);
      const before = panelSettingsRef.current.get(date) ?? DEFAULT_PANEL_SETTINGS;
      undoStackRef.current.push({ date, before, after: settings });
      if (undoStackRef.current.length > MAX_HISTORY) undoStackRef.current.shift();
      redoStackRef.current.length = 0;
      baselineSettingsRef.current.set(date, removeAlignmentAdjustment(settings));
      const next = new Map(panelSettingsRef.current).set(date, settings);
      panelSettingsRef.current = next;
      setPanelSettings(next);
      // Retain the explicit assignment in this owner so subsequent saves carry
      // its migration provenance without rereading the row on every gesture.
      const assignedSource = Object.freeze({ ...source, legacyOrigin: Object.freeze({ ...legacy.origin }) });
      settingsOwner!.verifiedSources![date] = assignedSource;
      try {
        await savePanelSettings(assignedSource, settings);
        if (canWrite()) setLegacySettings((entries) => entries.filter((entry) => entry.id !== id));
      } catch (error) {
        reportPersistenceFailure(error);
      }
    },
    [legacySettings, selectedSeqId, canWrite, settingsOwner, reportPersistenceFailure],
  );

  return {
    panelSettings: scopedPanelSettings,
    settingsReady,
    manuallyAdjustedDates: new Set(
      [...scopedPanelSettings].flatMap(([date, settings]) => (settings.alignmentAdjustment ? [date] : [])),
    ),
    activePanel: settingsBelongToPatient ? effectiveActivePanel : null,
    setActivePanel,
    progress: settingsBelongToPatient ? progress : 0,
    setProgress,
    updatePanelSetting,
    batchUpdateSettings,
    persistenceError,
    retryLoad,
    legacySettings: settingsBelongToPatient ? legacySettings : [],
    assignLegacySettings,
    reportPersistenceError: reportPersistenceFailure,
    clearPersistenceError: () => setPersistenceFailure(null),
  };
}
