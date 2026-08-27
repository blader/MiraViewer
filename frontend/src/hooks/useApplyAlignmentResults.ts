import { useEffect, useRef } from 'react';
import type { AlignmentResult, ComparisonData, PanelSettings } from '../types/api';
import { DEFAULT_PANEL_SETTINGS } from '../utils/constants';
import {
  clearDerivedAlignmentFrame,
  persistDerivedAlignmentFrame,
  setDerivedAlignmentFrame,
} from '../utils/derivedAlignmentFrame';
import { clearPersistedDerivedAlignmentFrames } from '../utils/localApi';
import { outputGridFingerprint } from '../utils/outputPlaneGrid';

export function useApplyAlignmentResults(opts: {
  isAligning: boolean;
  alignmentResults: AlignmentResult[];
  panelSettings: Map<string, PanelSettings>;
  data: ComparisonData | null;
  selectedSeqId: string | null;
  batchUpdateSettings: (updates: Map<string, PanelSettings>, operationId?: string, automatic?: boolean) => void;
  onPersistenceError?: (error: unknown) => void;
  activeRequestKey?: string | null;
}) {
  const {
    isAligning,
    alignmentResults,
    panelSettings,
    data,
    selectedSeqId,
    batchUpdateSettings,
    onPersistenceError,
    activeRequestKey,
  } = opts;

  // A date can be aligned again when an in-flight run is superseded.
  const appliedAlignmentResultsRef = useRef(new Set<string>());
  const pendingPersistenceBySeriesRef = useRef(new Map<string, Promise<void>>());
  const wasAligningRef = useRef(false);

  useEffect(() => {
    if (isAligning && !wasAligningRef.current) {
      appliedAlignmentResultsRef.current.clear();
    }
    wasAligningRef.current = isAligning;
  }, [isAligning]);

  useEffect(() => {
    if (alignmentResults.length === 0) return;

    const queuePersistence = (seriesUid: string, operation: () => Promise<void>) => {
      const pendingPersistence = pendingPersistenceBySeriesRef.current;
      const predecessor = pendingPersistence.get(seriesUid);
      const next = predecessor ? predecessor.then(operation, operation) : operation();
      pendingPersistence.set(seriesUid, next);
      void next.then(
        () => {
          if (pendingPersistence.get(seriesUid) === next) pendingPersistence.delete(seriesUid);
        },
        (error: unknown) => {
          if (pendingPersistence.get(seriesUid) === next) pendingPersistence.delete(seriesUid);
          onPersistenceError?.(error);
        },
      );
    };

    const pending = new Map<string, PanelSettings>();
    let operationId: string | undefined;
    for (const r of alignmentResults) {
      const applicationKey = `${r.runId ?? ''}:${r.date}`;
      if (appliedAlignmentResultsRef.current.has(applicationKey)) continue;
      if (r.requestKey && r.requestKey !== activeRequestKey) continue;

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
      if (
        r.derivedFrame &&
        (!r.runId ||
          r.outcome !== 'aligned' ||
          !data.selected_patient_key ||
          r.patientKey !== data.selected_patient_key ||
          r.sequenceId !== selectedSeqId ||
          data.dataset_revision === undefined ||
          r.datasetRevision !== data.dataset_revision ||
          !r.derivedFrame.targetStudyUid ||
          r.derivedFrame.targetStudyUid !== (seriesRef.study_uid ?? seriesRef.study_id))
      ) {
        continue;
      }
      if (r.referenceSeriesUid === r.seriesUid) continue;
      if (
        !Number.isSafeInteger(r.bestSliceIndex) ||
        r.bestSliceIndex < 0 ||
        r.bestSliceIndex >= seriesRef.instance_count
      )
        continue;
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
      appliedAlignmentResultsRef.current.add(applicationKey);
      const patientKey = data.selected_patient_key;
      const verifiedPatient = patientKey && r.patientKey === patientKey ? patientKey : null;
      if (r.derivedFrame) {
        setDerivedAlignmentFrame(r);
        if (!r.requestKey) {
          queuePersistence(r.seriesUid, async () => {
            if (verifiedPatient) await clearPersistedDerivedAlignmentFrames(verifiedPatient, r.seriesUid);
            await persistDerivedAlignmentFrame(r);
          });
        }
      } else {
        clearDerivedAlignmentFrame(r.seriesUid);
        if (verifiedPatient && !r.requestKey) {
          queuePersistence(r.seriesUid, () => clearPersistedDerivedAlignmentFrames(verifiedPatient, r.seriesUid));
        }
      }
      operationId ??= r.runId;
    }

    if (pending.size > 0) {
      if (activeRequestKey) batchUpdateSettings(pending, operationId, true);
      else batchUpdateSettings(pending, operationId);
    }
  }, [activeRequestKey, alignmentResults, batchUpdateSettings, data, onPersistenceError, panelSettings, selectedSeqId]);
}
