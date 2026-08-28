import { createContext, useContext, useState, useSyncExternalStore } from 'react';
import type { AlignmentAdjustment } from '../types/api';
import { applyAlignmentAdjustment } from '../utils/alignmentAdjustment';
import {
  getDerivedAlignmentFrame,
  getDerivedAlignmentFrameForReference,
  subscribeToDerivedAlignmentFrames,
  type DerivedAlignmentReference,
} from '../utils/derivedAlignmentFrame';

/** The live comparison owns which scan pair and physical plane may be presented. */
export const AlignedBrowsingContext = createContext<{
  reference: DerivedAlignmentReference | null;
  targetSeriesUids: ReadonlySet<string>;
  adjustments?: ReadonlyMap<string, AlignmentAdjustment>;
  acquiredSeriesUids?: ReadonlySet<string>;
  updating?: boolean;
  unavailableSeriesUids?: ReadonlySet<string>;
} | null>(null);

export function useAlignedFrame(seriesUid: string, instanceIndex: number) {
  const browsing = useContext(AlignedBrowsingContext);
  const adjustment = browsing?.adjustments?.get(seriesUid);
  const acquired = browsing?.acquiredSeriesUids?.has(seriesUid);
  const reference =
    browsing?.targetSeriesUids.has(seriesUid) && browsing.reference && !acquired
      ? { ...browsing.reference, manualSliceOffset: adjustment?.sliceOffset ?? 0 }
      : null;
  const available = useSyncExternalStore(
    subscribeToDerivedAlignmentFrames,
    () =>
      acquired
        ? null
        : reference
          ? getDerivedAlignmentFrameForReference(seriesUid, reference, true)
          : getDerivedAlignmentFrame(seriesUid, instanceIndex),
    () => null,
  );
  const scope = reference
    ? JSON.stringify([
        seriesUid,
        reference.patientKey,
        reference.sequenceId,
        reference.datasetRevision,
        reference.seriesUid,
        reference.outputMode ?? 'native',
      ])
    : null;
  const [held, setHeld] = useState({ scope, frame: available });
  const frame =
    reference &&
    available &&
    (available.referenceFrameIndex !== reference.sliceIndex ||
      (available.manualSliceOffset ?? 0) !== reference.manualSliceOffset) &&
    held.scope === scope &&
    held.frame?.registrationId === available.registrationId
      ? held.frame
      : available;
  // A cached revisit need not be the cache's most recently produced plane. Hold
  // this viewer's last accepted presentation, never an unrelated cached neighbor.
  if (held.scope !== scope || held.frame !== frame) setHeld({ scope, frame });
  const pending = Boolean(
    reference &&
    frame &&
    (frame.referenceFrameIndex !== reference.sliceIndex ||
      (frame.manualSliceOffset ?? 0) !== reference.manualSliceOffset),
  );
  const status = !pending
    ? 'ready'
    : browsing?.unavailableSeriesUids?.has(seriesUid)
      ? 'unavailable'
      : browsing?.updating === false
        ? 'paused'
        : 'updating';
  return {
    frame,
    pending,
    status,
    // Keep pixels and their accepted display transform together, including while
    // an uncached neighboring plane is loading. Corrections remain independently
    // editable and never suppress the accepted affine or calibrated display tone.
    settings:
      reference && frame?.acceptedResult
        ? adjustment
          ? applyAlignmentAdjustment(frame.acceptedResult.computedSettings, adjustment)
          : frame.acceptedResult.computedSettings
        : undefined,
  };
}
