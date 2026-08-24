import { useEffect, useRef } from 'react';
import type { AlignmentResult, ComparisonData, PanelSettings } from '../types/api';
import { DEFAULT_PANEL_SETTINGS } from '../utils/constants';
import { persistDerivedAlignmentFrame, setDerivedAlignmentFrame } from '../utils/derivedAlignmentFrame';
import { outputGridFingerprint } from '../utils/outputPlaneGrid';

export function useApplyAlignmentResults(opts: {
  isAligning: boolean;
  alignmentResults: AlignmentResult[];
  panelSettings: Map<string, PanelSettings>;
  data: ComparisonData | null;
  selectedSeqId: string | null;
  batchUpdateSettings: (updates: Map<string, PanelSettings>, operationId?: string) => void;
  onPersistenceError?: (error: unknown) => void;
}) {
  const { isAligning, alignmentResults, panelSettings, data, selectedSeqId, batchUpdateSettings, onPersistenceError } =
    opts;

  // Track which dates we've already applied so we can update incrementally as each finishes.
  const appliedAlignmentDatesRef = useRef(new Set<string>());
  const wasAligningRef = useRef(false);

  useEffect(() => {
    if (isAligning && !wasAligningRef.current) {
      appliedAlignmentDatesRef.current.clear();
    }
    wasAligningRef.current = isAligning;
  }, [isAligning]);

  useEffect(() => {
    if (alignmentResults.length === 0) return;

    const pending = new Map<string, PanelSettings>();
    let operationId: string | undefined;
    for (const r of alignmentResults) {
      if (appliedAlignmentDatesRef.current.has(r.date)) continue;

      // The live dataset, selected patient, and current sequence are the only application authority.
      // An async result produced before a patient switch, re-import, or sequence change is stale.
      if (!data || !selectedSeqId) continue;
      if (r.outcome && r.outcome !== 'aligned') continue;
      if (r.sequenceId && r.sequenceId !== selectedSeqId) continue;
      if (r.patientKey && data.selected_patient_key && r.patientKey !== data.selected_patient_key) continue;
      if (
        r.datasetRevision !== undefined &&
        data.dataset_revision !== undefined &&
        r.datasetRevision !== data.dataset_revision
      ) {
        continue;
      }

      const seriesRef = data.series_map[selectedSeqId]?.[r.date];
      if (!seriesRef || seriesRef.series_uid !== r.seriesUid) continue;
      if (r.patientKey && seriesRef.patient_key && r.patientKey !== seriesRef.patient_key) continue;
      if (r.derivedFrame && (r.outputGrid || r.derivedFrame.outputGrid)) {
        const derivedGrid = r.derivedFrame.outputGrid;
        if (!r.outputGrid || !derivedGrid) continue;
        if (
          r.derivedFrame.rows !== derivedGrid.rows ||
          r.derivedFrame.columns !== derivedGrid.columns ||
          r.derivedFrame.pixels.length !== derivedGrid.rows * derivedGrid.columns ||
          (r.derivedFrame.valid && r.derivedFrame.valid.length !== r.derivedFrame.pixels.length) ||
          (r.derivedFrame.referenceSopInstanceUid &&
            derivedGrid.referenceSopInstanceUid &&
            r.derivedFrame.referenceSopInstanceUid !== derivedGrid.referenceSopInstanceUid)
        ) {
          continue;
        }
        try {
          if (outputGridFingerprint(r.outputGrid) !== outputGridFingerprint(derivedGrid)) continue;
        } catch {
          continue;
        }
      }

      const existing = panelSettings.get(r.date) || DEFAULT_PANEL_SETTINGS;
      const reverseSliceOrder = !!existing.reverseSliceOrder;

      // If slice order is reversed for this date, adjust the computed offset so the
      // *physical* bestSliceIndex still displays (logical = max - physical).
      let next = r.computedSettings;
      if (reverseSliceOrder) {
        const instanceCount = seriesRef?.instance_count;
        if (typeof instanceCount === 'number' && instanceCount > 0) {
          const max = instanceCount - 1;
          const desiredLogicalIndex = max - r.bestSliceIndex;
          const delta = desiredLogicalIndex - r.bestSliceIndex;
          next = { ...next, offset: next.offset + delta };
        }
      }

      // Always preserve the user's per-date slice order preference.
      pending.set(r.date, { ...next, reverseSliceOrder });
      if (r.derivedFrame) {
        setDerivedAlignmentFrame(r);
        persistDerivedAlignmentFrame(r).catch((error: unknown) => {
          onPersistenceError?.(error);
        });
      }
      operationId ??= r.runId;
      appliedAlignmentDatesRef.current.add(r.date);
    }

    if (pending.size > 0) {
      batchUpdateSettings(pending, operationId);
    }
  }, [alignmentResults, batchUpdateSettings, data, onPersistenceError, panelSettings, selectedSeqId]);
}
