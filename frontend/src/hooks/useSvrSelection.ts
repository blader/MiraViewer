import { useCallback, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { SvrLabelVolume, SvrSelectionPlane, SvrVolume } from '../types/svr';
import { retainMarkedComponents } from '../utils/segmentation/seedConnectedSelection';
import type { SelectionProposer } from '../utils/segmentation/selectionProposal';
import { InteractiveSelectionMemoryError } from '../utils/segmentation/interactiveAdmission';
import {
  applySelectionPatch,
  combineSelectionPatches,
  selectionPatch,
  selectionPlaneContainsMarks,
  isSelectionCoverageValid,
  SELECTION_LABEL_META,
  type SelectionPatch,
} from '../utils/segmentation/selectionEditing';

type LabelDescription = Pick<
  SvrLabelVolume,
  'meta' | 'reviewState' | 'seeds' | 'clippedNativeVoxels' | 'contextLimited'
>;
type Edit = { mask: SelectionPatch; before: LabelDescription; after: LabelDescription };
type History = {
  volume: SvrVolume;
  labels: SvrLabelVolume | null;
  undo: Edit[];
  redo: Edit[];
  completedProposal: Pick<SelectionStatus, 'boundaryCount' | 'contextLimited'> | null;
};
type SelectionStatus = {
  running: boolean;
  progress?: number;
  error?: string;
  memoryError?: InteractiveSelectionMemoryError;
  boundaryCount?: number;
  contextLimited?: boolean;
};
const IDLE_STATUS: SelectionStatus = { running: false };
const initial = (volume: SvrVolume, labels: SvrLabelVolume | null): History => ({
  volume,
  labels,
  undo: [],
  redo: [],
  completedProposal: null,
});
const description = (labels: SvrLabelVolume | null): LabelDescription => ({
  meta: labels?.meta ?? SELECTION_LABEL_META,
  reviewState: labels?.reviewState,
  seeds: labels?.seeds,
  ...(labels?.clippedNativeVoxels !== undefined ? { clippedNativeVoxels: labels.clippedNativeVoxels } : {}),
  ...(labels?.contextLimited !== undefined ? { contextLimited: labels.contextLimited } : {}),
});
const editBytes = (edit: Edit) =>
  edit.mask.indices.byteLength +
  edit.mask.before.byteLength +
  edit.mask.after.byteLength +
  (edit.before.seeds?.foreground.byteLength ?? 0) +
  (edit.before.seeds?.background.byteLength ?? 0) +
  (edit.after.seeds?.foreground.byteLength ?? 0) +
  (edit.after.seeds?.background.byteLength ?? 0);

const supportsMark = (volume: SvrVolume, index: number) =>
  index < volume.data.length &&
  Number.isFinite(volume.data[index]) &&
  (!volume.observedSupport || volume.observedSupport[index]);

function marksFrom(labels: SvrLabelVolume | null, volume: SvrVolume) {
  const marks = new Map<number, 1 | 2>();
  for (const [indices, kind] of [
    [labels?.seeds?.foreground, 1],
    [labels?.seeds?.background, 2],
  ] as const) {
    for (const index of indices ?? []) {
      if (supportsMark(volume, index)) marks.set(index, kind);
    }
  }
  return marks;
}

function retainedEditingBytes(history: History): number {
  // Editing history and marks stay resident while region detail is prepared.
  // Count backing buffers once: seed snapshots often share storage with history.
  const buffers = new Set<ArrayBufferLike>();
  const addSeeds = (seeds: SvrLabelVolume['seeds']) => {
    if (seeds) {
      buffers.add(seeds.foreground.buffer);
      buffers.add(seeds.background.buffer);
    }
  };
  addSeeds(history.labels?.seeds);
  for (const edit of [...history.undo, ...history.redo]) {
    for (const array of [edit.mask.indices, edit.mask.before, edit.mask.after]) buffers.add(array.buffer);
    addSeeds(edit.before.seeds);
    addSeeds(edit.after.seeds);
  }
  return [...buffers].reduce((bytes, buffer) => bytes + buffer.byteLength, 0);
}

export function useSvrSelection(
  volume: SvrVolume,
  labels: SvrLabelVolume | null,
  onChange: (labels: SvrLabelVolume | null, patch?: SelectionPatch, previousData?: Uint8Array) => void,
  automatic = false,
  proposeSelection?: SelectionProposer,
) {
  const [history, setHistory] = useState(() => initial(volume, labels));
  // Actions share a synchronous authority; React projects it after the current batch.
  const historyRef = useRef(history);
  const state = history.volume === volume && history.labels === labels ? history : initial(volume, labels);
  const [ownedStatus, setOwnedStatus] = useState(() => ({ volume, labels, status: IDLE_STATUS }));
  if (ownedStatus.volume !== volume || ownedStatus.labels !== labels)
    setOwnedStatus({ volume, labels, status: IDLE_STATUS });
  const status = ownedStatus.volume === volume && ownedStatus.labels === labels ? ownedStatus.status : IDLE_STATUS;
  const request = useRef<AbortController | null>(null);
  const pendingStroke = useRef<ReturnType<typeof setTimeout> | null>(null);
  const marks = useMemo(() => marksFrom(labels, volume), [labels, volume]);
  const setStatus = useCallback((update: SelectionStatus | ((current: SelectionStatus) => SelectionStatus)) => {
    const owner = historyRef.current;
    setOwnedStatus((previous) => {
      const current =
        previous.volume === owner.volume && previous.labels === owner.labels ? previous.status : IDLE_STATUS;
      return {
        volume: owner.volume,
        labels: owner.labels,
        status: typeof update === 'function' ? update(current) : update,
      };
    });
  }, []);

  const stop = useCallback(() => {
    if (pendingStroke.current !== null) clearTimeout(pendingStroke.current);
    pendingStroke.current = null;
    request.current?.abort();
    request.current = null;
  }, []);
  const cancel = useCallback(() => {
    stop();
    setStatus(IDLE_STATUS);
  }, [setStatus, stop]);

  // Automatic work is initiated only by a stroke. Reopening, hydration, undo,
  // navigation, and a settings change cannot silently recompute saved tissue.
  useLayoutEffect(() => {
    if ((!automatic || !proposeSelection) && (request.current || pendingStroke.current !== null)) cancel();
  }, [automatic, cancel, proposeSelection]);

  // Hydrated labels become interactive in this commit. Synchronize the action
  // authority before paint so an immediate confirm/mark cannot use the old grid.
  useLayoutEffect(() => {
    if (historyRef.current.volume !== volume || historyRef.current.labels !== labels) {
      stop();
      historyRef.current = initial(volume, labels);
      setHistory(historyRef.current);
    }
  }, [labels, stop, volume]);
  useLayoutEffect(() => {
    setStatus(IDLE_STATUS);
    return stop;
  }, [proposeSelection, setStatus, stop, volume]);

  const publish = useCallback(
    (next: History, patch?: SelectionPatch) => {
      const previous = historyRef.current;
      if (previous.volume !== volume) return;
      historyRef.current = next;
      setHistory(next);
      if (next.completedProposal) setStatus({ running: false, ...next.completedProposal });
      onChange(next.labels, patch, previous.labels?.data);
    },
    [onChange, setStatus, volume],
  );
  const record = useCallback(
    (
      data: Uint8Array,
      after: LabelDescription,
      candidates?: Uint32Array,
      strokeEdit?: Edit,
      completedProposal: History['completedProposal'] = null,
    ) => {
      const prior = historyRef.current;
      if (prior.volume !== volume) return;
      const previous = prior.labels;
      const edit: Edit = {
        mask: selectionPatch(previous?.data ?? new Uint8Array(volume.data.length), data, candidates),
        before: description(previous),
        after,
      };
      const coalesce = strokeEdit && prior.undo.at(-1) === strokeEdit;
      const entry = coalesce
        ? { ...edit, before: strokeEdit.before, mask: combineSelectionPatches(strokeEdit.mask, edit.mask) }
        : edit;
      const undo = [...(coalesce ? prior.undo.slice(0, -1) : prior.undo), entry];
      let bytes = undo.reduce((sum, item) => sum + editBytes(item), 0);
      while (undo.length && (undo.length > 20 || bytes > 32 * 1024 * 1024)) bytes -= editBytes(undo.shift()!);
      publish({ volume, labels: { data, dims: volume.dims, ...after }, undo, redo: [], completedProposal }, edit.mask);
      return edit;
    },
    [publish, volume],
  );

  const grow = useCallback(
    async (strokeEdit?: Edit) => {
      if (historyRef.current.volume !== volume) return;
      cancel();
      if (historyRef.current.completedProposal) {
        historyRef.current = { ...historyRef.current, completedProposal: null };
        setHistory(historyRef.current);
      }
      const seeds = historyRef.current.labels?.seeds;
      if (!seeds?.foreground.length) {
        setStatus({ running: false, error: 'Mark inside the tissue you want to select before suggesting a boundary.' });
        return;
      }
      if (!proposeSelection) {
        setStatus({
          running: false,
          error: 'Auto-fill requires an original native source grid. Brush-only editing is available.',
        });
        return;
      }
      const controller = new AbortController();
      request.current = controller;
      const isCurrent = () =>
        !controller.signal.aborted && request.current === controller && historyRef.current.volume === volume;
      const onProgress = (progress: number) => {
        if (isCurrent() && Number.isFinite(progress))
          setStatus({ running: true, progress: Math.min(1, Math.max(0, progress)) });
      };
      setStatus({ running: true, progress: 0 });
      try {
        const result = await proposeSelection({
          volume,
          seeds,
          retainedBytes: retainedEditingBytes(historyRef.current),
          signal: controller.signal,
          onProgress,
        });
        if (!isCurrent()) return;
        const clippedNativeVoxels = result.clippedNativeVoxels;
        if (!isSelectionCoverageValid(clippedNativeVoxels))
          throw new Error('The boundary suggestion has invalid viewing-region coverage. Your marks are unchanged.');
        const contextLimited = result.contextLimited;
        if (typeof contextLimited !== 'boolean')
          throw new Error('The boundary suggestion has invalid source-context coverage. Your marks are unchanged.');
        const next = new Uint8Array(volume.data.length);
        if (!(result.data instanceof Uint8Array) || result.data.length !== next.length)
          throw new Error('The boundary suggestion does not match the editing volume. Your marks are unchanged.');
        for (let index = 0; index < next.length; index++) {
          if (result.data[index]! > 1)
            throw new Error('The boundary suggestion is not a binary selection. Your marks are unchanged.');
          if (result.data[index] && supportsMark(volume, index)) next[index] = 1;
        }
        // The solver proposes unmarked tissue; explicit user edits remain the authority.
        for (const index of seeds.foreground) if (supportsMark(volume, index)) next[index] = 1;
        for (const index of seeds.background) if (index < next.length) next[index] = 0;
        // Filter only this unpublished copy, after unsupported tissue and Remove
        // marks have severed any connections they cannot legitimately provide.
        await retainMarkedComponents(next, volume.dims, seeds.foreground, controller.signal);
        if (!isCurrent()) return;
        record(
          next,
          {
            meta: SELECTION_LABEL_META,
            reviewState: 'draft',
            seeds,
            contextLimited,
            ...(clippedNativeVoxels ? { clippedNativeVoxels } : {}),
          },
          undefined,
          strokeEdit,
          {
            boundaryCount: result.boundaryCount,
            contextLimited,
          },
        );
      } catch (error) {
        if (isCurrent())
          setStatus({
            running: false,
            error: error instanceof Error ? error.message : String(error),
            ...(error instanceof InteractiveSelectionMemoryError ? { memoryError: error } : {}),
          });
      } finally {
        if (request.current === controller) request.current = null;
      }
    },
    [cancel, proposeSelection, record, setStatus, volume],
  );

  const stroke = useCallback(
    (indices: Uint32Array, kind: 'include' | 'exclude', plane?: SvrSelectionPlane) => {
      if (historyRef.current.volume !== volume) return;
      const supported = indices.filter((index) => supportsMark(volume, index));
      if (!supported.length) {
        setStatus((current) => ({
          ...current,
          error: 'This stroke contains no acquired MRI tissue. Move the brush inside the observed image.',
          memoryError: undefined,
        }));
        return;
      }
      if (plane && !selectionPlaneContainsMarks(plane, supported, volume.dims)) {
        setStatus((current) => ({
          ...current,
          error: 'The stroke plane does not match its marked MRI voxels.',
          memoryError: undefined,
        }));
        return;
      }
      cancel();
      const previous = historyRef.current.labels;
      const value = kind === 'include' ? 1 : 0;
      const relabel = previous?.meta.some((entry) => entry.id !== 1 || entry.name !== 'Selected tissue') ?? false;
      const changesMask = relabel || supported.some((index) => (previous?.data[index] ?? 0) !== value);
      // Retain completion only when the whole stroke agrees with the settled mask.
      // Unfinished work stays incomplete even when brush-down has canceled its request.
      const completedProposal = changesMask ? null : historyRef.current.completedProposal;
      // Mask identity also owns completed display enhancement; marks alone must not replace it.
      const next =
        previous && !changesMask ? previous.data : (previous?.data.slice() ?? new Uint8Array(volume.data.length));
      if (relabel) for (let index = 0; index < next.length; index++) if (next[index]) next[index] = 1;
      const nextMarks = marksFrom(previous, volume);
      for (const index of supported) {
        if (changesMask) next[index] = value;
        nextMarks.set(index, kind === 'include' ? 1 : 2);
      }
      const foreground: number[] = [],
        background: number[] = [];
      for (const [index, value] of nextMarks) (value === 1 ? foreground : background).push(index);
      const edit = record(
        next,
        {
          ...description(previous),
          meta: SELECTION_LABEL_META,
          reviewState: 'draft',
          seeds: {
            foreground: Uint32Array.from(foreground),
            background: Uint32Array.from(background),
            ...(plane ? { lastStroke: { ...plane } } : {}),
          },
        },
        relabel ? undefined : supported,
        undefined,
        completedProposal,
      );
      if (edit && automatic && proposeSelection && foreground.length && !completedProposal) {
        setStatus({ running: true });
        pendingStroke.current = setTimeout(() => {
          pendingStroke.current = null;
          void grow(edit);
        }, 350);
      }
    },
    [automatic, cancel, grow, proposeSelection, record, setStatus, volume],
  );

  const travel = useCallback(
    (direction: 'undo' | 'redo') => {
      const current = historyRef.current;
      if (current.volume !== volume) return;
      const edit = current[direction].at(-1);
      if (!edit) return;
      cancel();
      const restoring = direction === 'undo';
      const opposite = restoring ? 'redo' : 'undo';
      const patch = restoring ? { ...edit.mask, before: edit.mask.after, after: edit.mask.before } : edit.mask;
      publish(
        {
          ...current,
          completedProposal: null,
          [direction]: current[direction].slice(0, -1),
          [opposite]: [...current[opposite], edit],
          labels: {
            data: applySelectionPatch(current.labels?.data ?? new Uint8Array(volume.data.length), edit.mask, direction),
            dims: volume.dims,
            ...(restoring ? edit.before : edit.after),
          },
        },
        patch,
      );
    },
    [cancel, publish, volume],
  );
  const clear = useCallback(() => {
    if (historyRef.current.volume !== volume) return;
    cancel();
    record(new Uint8Array(volume.data.length), { meta: SELECTION_LABEL_META, reviewState: 'draft' });
  }, [cancel, record, volume]);
  const accept = useCallback(() => {
    const current = historyRef.current;
    if (current.labels?.data.some(Boolean) && !request.current && pendingStroke.current === null)
      publish({ ...current, labels: { ...current.labels, reviewState: 'reviewed' } });
  }, [publish]);
  let included = 0,
    excluded = 0;
  for (const mark of marks.values()) {
    if (mark === 1) included++;
    else excluded++;
  }
  const retainedBytes = retainedEditingBytes(state);
  const getRetainedBytes = useCallback(() => retainedEditingBytes(historyRef.current), []);
  const prepareHeavyOperation = useCallback(() => {
    cancel();
    return retainedEditingBytes(historyRef.current);
  }, [cancel]);
  return {
    marks,
    included,
    excluded,
    canUndo: state.undo.length > 0,
    canRedo: state.redo.length > 0,
    status,
    retainedBytes,
    getRetainedBytes,
    prepareHeavyOperation,
    stroke,
    grow,
    cancel,
    travel,
    clear,
    accept,
  };
}
