import { useEffect, useMemo } from 'react';
import type { ComparisonData, SequenceCombo } from '../types/api';
import { formatSequenceLabel } from '../utils/clinicalData';
import { clearDerivedAlignmentFrames, hydrateDerivedAlignmentFrames } from '../utils/derivedAlignmentFrame';

type ComparisonSequenceAvailabilityOptions = {
  data: ComparisonData | null;
  selectedPlane: string | null;
  selectedSeqId: string | null;
  enabledDates: Set<string>;
  onPersistenceError: (error: unknown) => void;
};

export function useComparisonSequenceAvailability({
  data,
  selectedPlane,
  selectedSeqId,
  enabledDates,
  onPersistenceError,
}: ComparisonSequenceAvailabilityOptions) {
  const visibleSequenceSeries = useMemo(() => {
    const seriesUids = new Set<string>();
    const seriesByDate = selectedSeqId && data ? (data.series_map[selectedSeqId] ?? {}) : {};
    for (const series of Object.values(seriesByDate)) seriesUids.add(series.series_uid);
    return seriesUids;
  }, [data, selectedSeqId]);

  useEffect(() => {
    clearDerivedAlignmentFrames();
    const patientKey = data?.selected_patient_key;
    const datasetRevision = data?.dataset_revision;
    if (!patientKey || datasetRevision === undefined || !selectedSeqId) return;

    let active = true;
    hydrateDerivedAlignmentFrames(patientKey, datasetRevision, selectedSeqId, visibleSequenceSeries).catch(
      (error: unknown) => {
        if (active) onPersistenceError(error);
      },
    );
    return () => {
      active = false;
      clearDerivedAlignmentFrames();
    };
  }, [data, onPersistenceError, selectedSeqId, visibleSequenceSeries]);

  const sequencesForPlane = useMemo(() => {
    if (!data || !selectedPlane) return [] as SequenceCombo[];

    const planeKey = (plane: string | null) => (plane && plane.trim() ? plane : 'Other');
    return data.sequences
      .filter((sequence) => planeKey(sequence.plane) === selectedPlane)
      .sort((first, second) => formatSequenceLabel(second).localeCompare(formatSequenceLabel(first)));
  }, [data, selectedPlane]);

  const sequencesWithDataForDates = useMemo(() => {
    if (!data || enabledDates.size === 0) return new Set<string>();

    const available = new Set<string>();
    for (const sequence of data.sequences) {
      const seriesByDate = data.series_map[sequence.id] || {};
      for (const date of enabledDates) {
        if (seriesByDate[date]) {
          available.add(sequence.id);
          break;
        }
      }
    }
    return available;
  }, [data, enabledDates]);

  const datesWithDataForSequence = useMemo(() => {
    if (!data || !selectedSeqId) return new Set<string>();
    return new Set(Object.keys(data.series_map[selectedSeqId] || {}));
  }, [data, selectedSeqId]);

  return { sequencesForPlane, sequencesWithDataForDates, datesWithDataForSequence };
}
