import { createContext, useContext } from 'react';
import type { SvrLabelVolume, SvrVolume } from '../types/svr';
import type { EnhancementSourceLoader } from '../utils/svr/superResolutionRegion';
import type { SelectionProposer } from '../utils/segmentation/selectionProposal';
export type SvrHeavyOperation =
  | 'reconstruction'
  | 'refinement'
  | 'enhancement'
  | 'custom-model'
  | 'model-files'
  | 'selection';
export type SvrRetainedViewerSnapshot = {
  volume: SvrVolume | null;
  labels: SvrLabelVolume | null;
  retainedBytes: number;
};
type ImagingOwner = (kind: SvrHeavyOperation) => Partial<SvrRetainedViewerSnapshot>;

/** One preparation boundary. Owners stop competing work before reporting retained data. */
export function createSvrImagingOperations() {
  const owners = new Map<'viewer' | 'editor' | 'selection-runtime', ImagingOwner>();
  return {
    register(key: 'viewer' | 'editor' | 'selection-runtime', owner: ImagingOwner) {
      owners.set(key, owner);
      return () => {
        if (owners.get(key) === owner) owners.delete(key);
      };
    },
    prepare(
      kind: SvrHeavyOperation,
      caller: { signal?: AbortSignal; retainedBytes?: number } = {},
    ): SvrRetainedViewerSnapshot {
      caller.signal?.throwIfAborted();
      // A proposal can retain an earlier editor snapshot while React publishes a
      // newer one. Count the larger editing owner, plus every other live owner.
      const editingFloor = caller.retainedBytes ?? 0;
      if (!Number.isSafeInteger(editingFloor) || editingFloor < 0)
        throw new Error('Imaging requires a valid retained-memory estimate. Your saved work is unchanged.');
      const snapshot: SvrRetainedViewerSnapshot = { volume: null, labels: null, retainedBytes: editingFloor };
      for (const [key, owner] of owners) {
        const current = owner(kind);
        const bytes = current.retainedBytes ?? 0;
        if (!Number.isSafeInteger(bytes) || bytes < 0)
          throw new Error('Imaging requires a valid retained-memory estimate. Your saved work is unchanged.');
        if (current.volume !== undefined) snapshot.volume = current.volume;
        if (current.labels !== undefined) snapshot.labels = current.labels;
        snapshot.retainedBytes += key === 'editor' ? Math.max(0, bytes - editingFloor) : bytes;
      }
      if (!Number.isSafeInteger(snapshot.retainedBytes))
        throw new Error('Imaging requires a valid retained-memory estimate; the combined byte count is unsafe.');
      return snapshot;
    },
  };
}
export type SvrImagingOperations = ReturnType<typeof createSvrImagingOperations>;

/** Binary MRI buffers are shared imaging state, not recursively inspectable view props. */
export const SvrImagingContext = createContext<{
  volume: SvrVolume | null;
  labels?: SvrLabelVolume | null;
  initialSelection?: SvrLabelVolume;
  busy?: boolean;
  refineRegion?: (labels: SvrLabelVolume) => void;
  loadEnhancementSource?: EnhancementSourceLoader;
  proposeSelection?: SelectionProposer;
  operations: SvrImagingOperations;
} | null>(null);

export function useSvrImaging() {
  const imaging = useContext(SvrImagingContext);
  if (!imaging) throw new Error('The SVR viewer requires its imaging workspace.');
  return imaging;
}
