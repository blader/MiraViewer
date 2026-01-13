import { useCallback, useEffect, useMemo, useState } from 'react';
import type { ComparisonData } from '../types/api';

const FILTERS_STORAGE_KEY = 'mira-filters-v2';

type FiltersState = {
  plane: string | null;
  seqId: string | null;
  // null = not set (use default selection). [] = explicitly none selected.
  enabledDates: string[] | null;
};

function pickDefaultPlane(data: ComparisonData): string | null {
  return data.planes.includes('Axial') ? 'Axial' : (data.planes[0] || null);
}

function pickDefaultSequence(data: ComparisonData, plane: string): string | null {
  const seq = data.sequences.find((s) => s.plane === plane) || data.sequences[0];
  return seq ? seq.id : null;
}

/** Try to find a matching sequence in the new plane based on weight/sequence type */
function findMatchingSequence(data: ComparisonData, newPlane: string, currentSeqId: string | null): string | null {
  if (!currentSeqId) return pickDefaultSequence(data, newPlane);

  const currentSeq = data.sequences.find((s) => s.id === currentSeqId);
  if (!currentSeq) return pickDefaultSequence(data, newPlane);

  // Try to find a sequence in the new plane with same weight and sequence type
  const exactMatch = data.sequences.find(
    (s) => s.plane === newPlane && s.weight === currentSeq.weight && s.sequence === currentSeq.sequence
  );
  if (exactMatch) return exactMatch.id;

  // Try matching just the weight
  const weightMatch = data.sequences.find((s) => s.plane === newPlane && s.weight === currentSeq.weight);
  if (weightMatch) return weightMatch.id;

  return pickDefaultSequence(data, newPlane);
}

function loadStoredFilters(): FiltersState {
  try {
    const restored = JSON.parse(localStorage.getItem(FILTERS_STORAGE_KEY) || 'null') as unknown;
    if (restored && typeof restored === 'object') {
      const r = restored as { plane?: unknown; seqId?: unknown; enabledDates?: unknown };
      return {
        plane: typeof r.plane === 'string' ? r.plane : null,
        seqId: typeof r.seqId === 'string' ? r.seqId : null,
        enabledDates: Array.isArray(r.enabledDates)
          ? r.enabledDates.filter((d): d is string => typeof d === 'string')
          : null,
      };
    }
  } catch {
    // Ignore corrupted localStorage state.
  }

  return { plane: null, seqId: null, enabledDates: null };
}

export function useComparisonFilters(data: ComparisonData | null) {
  const [filters, setFilters] = useState<FiltersState>(() => loadStoredFilters());

  const sortedDates = useMemo(() => {
    if (!data) return [] as string[];
    return [...data.dates].sort((a, b) => b.localeCompare(a));
  }, [data]);

  const selectedPlane = useMemo(() => {
    if (!data) return null;
    const defaultPlane = pickDefaultPlane(data);
    return filters.plane && data.planes.includes(filters.plane) ? filters.plane : defaultPlane;
  }, [data, filters.plane]);

  const selectedSeqId = useMemo(() => {
    if (!data || !selectedPlane) return null;
    const seqIdsForPlane = new Set(data.sequences.filter((s) => s.plane === selectedPlane).map((s) => s.id));
    return filters.seqId && seqIdsForPlane.has(filters.seqId)
      ? filters.seqId
      : pickDefaultSequence(data, selectedPlane);
  }, [data, selectedPlane, filters.seqId]);

  const enabledDates = useMemo(() => {
    if (!data) return new Set<string>();
    const ds = [...data.dates].sort();

    if (filters.enabledDates === null) {
      // Default: show last 4 dates (newest).
      return new Set(ds.slice(-4));
    }

    const allDates = new Set(data.dates);
    const valid = filters.enabledDates.filter((d) => allDates.has(d));

    // If something was saved but none of it matches the current dataset, fall back to default.
    if (valid.length === 0 && filters.enabledDates.length > 0) {
      return new Set(ds.slice(-4));
    }

    // Note: [] is a valid explicit selection ("None").
    return new Set(valid);
  }, [data, filters.enabledDates]);

  const enabledDatesKey = useMemo(() => Array.from(enabledDates).sort().join(','), [enabledDates]);

  // Persist filters to localStorage (always write validated values)
  useEffect(() => {
    if (!data || !selectedPlane || !selectedSeqId) return;
    const payload = {
      plane: selectedPlane,
      seqId: selectedSeqId,
      enabledDates: enabledDatesKey.split(',').filter(Boolean),
    };
    try {
      localStorage.setItem(FILTERS_STORAGE_KEY, JSON.stringify(payload));
    } catch {
      // Ignore quota / privacy mode errors.
    }
  }, [data, selectedPlane, selectedSeqId, enabledDatesKey]);

  const selectPlane = useCallback(
    (plane: string) => {
      if (!data) return;
      setFilters((prev) => ({
        ...prev,
        plane,
        seqId: findMatchingSequence(data, plane, selectedSeqId),
      }));
    },
    [data, selectedSeqId]
  );

  const selectSequence = useCallback((seqId: string) => {
    setFilters((prev) => ({ ...prev, seqId }));
  }, []);

  const selectAllDates = useCallback(() => {
    if (!data) return;
    setFilters((prev) => ({ ...prev, enabledDates: [...sortedDates] }));
  }, [data, sortedDates]);

  const selectNoDates = useCallback(() => {
    setFilters((prev) => ({ ...prev, enabledDates: [] }));
  }, []);

  const toggleDate = useCallback(
    (dateIso: string) => {
      setFilters((prev) => {
        // If dates were never explicitly set, treat the current derived set as the baseline
        // (i.e. the default last-4 selection).
        const baseDates = prev.enabledDates === null ? Array.from(enabledDates) : prev.enabledDates;
        const next = new Set(baseDates);
        if (next.has(dateIso)) next.delete(dateIso);
        else next.add(dateIso);
        return { ...prev, enabledDates: Array.from(next).sort() };
      });
    },
    [enabledDates]
  );

  return {
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
  };
}
