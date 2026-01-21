import { useEffect, useRef } from 'react';
import type { AlignmentResult, ComparisonData, PanelSettings } from '../types/api';
import { DEFAULT_PANEL_SETTINGS } from '../utils/constants';

export function useApplyAlignmentResults(opts: {
  isAligning: boolean;
  alignmentResults: AlignmentResult[];
  panelSettings: Map<string, PanelSettings>;
  data: ComparisonData | null;
  selectedSeqId: string | null;
  batchUpdateSettings: (updates: Map<string, PanelSettings>) => void;
}) {
  const { isAligning, alignmentResults, panelSettings, data, selectedSeqId, batchUpdateSettings } = opts;

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
    for (const r of alignmentResults) {
      if (appliedAlignmentDatesRef.current.has(r.date)) continue;

      const existing = panelSettings.get(r.date) || DEFAULT_PANEL_SETTINGS;
      const reverseSliceOrder = !!existing.reverseSliceOrder;

      // If slice order is reversed for this date, adjust the computed offset so the
      // *physical* bestSliceIndex still displays (logical = max - physical).
      let next = r.computedSettings;
      if (reverseSliceOrder && data && selectedSeqId) {
        const seriesRef = data.series_map[selectedSeqId]?.[r.date];
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
      appliedAlignmentDatesRef.current.add(r.date);
    }

    if (pending.size > 0) {
      batchUpdateSettings(pending);
    }
  }, [alignmentResults, batchUpdateSettings, data, panelSettings, selectedSeqId]);
}
