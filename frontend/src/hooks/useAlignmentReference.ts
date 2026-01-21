import { useState, useCallback, useRef, useEffect } from 'react';
import type { AlignmentReference, PanelSettings } from '../types/api';
import { readLocalStorageJson, removeLocalStorageItem, writeLocalStorageJson } from '../utils/persistence';

const REFERENCE_STORAGE_KEY_PREFIX = 'miraviewer:alignment-ref:';

/**
 * Deserialize AlignmentReference from storage.
 */
function deserializeReference(parsed: unknown): AlignmentReference | null {
  if (!parsed || typeof parsed !== 'object') return null;

  const obj = parsed as Record<string, unknown>;

  const date = obj.date;
  const seriesUid = obj.seriesUid;
  const sliceIndex = obj.sliceIndex;
  const sliceCount = obj.sliceCount;
  const settings = obj.settings;

  if (typeof date !== 'string' || typeof seriesUid !== 'string') return null;
  if (typeof sliceIndex !== 'number' || !Number.isFinite(sliceIndex)) return null;
  if (typeof sliceCount !== 'number' || !Number.isFinite(sliceCount)) return null;
  if (!settings || typeof settings !== 'object') return null;

  return {
    date,
    seriesUid,
    sliceIndex,
    sliceCount,
    settings: settings as PanelSettings,
  };
}

/**
 * Hook to manage the alignment reference state.
 *
 * The reference captures the currently displayed image (with all settings applied)
 * and stores metadata needed to align other dates to it.
 */
export function useAlignmentReference(selectedSeqId: string | null) {
  const [reference, setReference] = useState<AlignmentReference | null>(null);
  const [isCapturing, setIsCapturing] = useState(false);
  const prevSeqIdRef = useRef<string | null>(null);

  // Load reference from localStorage when sequence changes
  useEffect(() => {
    if (!selectedSeqId) {
      setReference(null);
      return;
    }

    if (selectedSeqId === prevSeqIdRef.current) {
      return;
    }
    prevSeqIdRef.current = selectedSeqId;

    const stored = readLocalStorageJson(REFERENCE_STORAGE_KEY_PREFIX + selectedSeqId);
    if (stored) {
      const ref = deserializeReference(stored);
      setReference(ref);
    } else {
      setReference(null);
    }
  }, [selectedSeqId]);

  // Save reference to localStorage when it changes
  useEffect(() => {
    if (!selectedSeqId) return;

    if (reference) {
      writeLocalStorageJson(REFERENCE_STORAGE_KEY_PREFIX + selectedSeqId, reference);
    } else {
      removeLocalStorageItem(REFERENCE_STORAGE_KEY_PREFIX + selectedSeqId);
    }
  }, [reference, selectedSeqId]);

  /**
   * Set the current slice metadata + viewer settings as the alignment reference.
   */
  const captureReference = useCallback(
    async (
      date: string,
      seriesUid: string,
      sliceIndex: number,
      sliceCount: number,
      settings: PanelSettings
    ): Promise<AlignmentReference> => {
      setIsCapturing(true);
      try {
        const ref: AlignmentReference = {
          date,
          seriesUid,
          sliceIndex,
          sliceCount,
          settings,
        };

        setReference(ref);
        return ref;
      } finally {
        setIsCapturing(false);
      }
    },
    []
  );

  /**
   * Clear the current reference.
   */
  const clearReference = useCallback(() => {
    setReference(null);
  }, []);

  /**
   * Check if a given date is the reference date.
   */
  const isReferenceDate = useCallback(
    (date: string): boolean => {
      return reference?.date === date;
    },
    [reference]
  );

  return {
    reference,
    isCapturing,
    captureReference,
    clearReference,
    isReferenceDate,
  };
}
