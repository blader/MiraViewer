import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { SvrLabelVolume, SvrVolume } from '../types/svr';
import { SeededVolumeWorker } from '../utils/segmentation/seededVolumeWorker';
import {
  applySelectionPatch,
  selectionPatch,
  SELECTION_LABEL_META,
  type SelectionPatch,
} from '../utils/segmentation/selectionEditing';

type LabelDescription = Pick<SvrLabelVolume, 'meta' | 'reviewState' | 'seeds'>;
type Edit = { mask: SelectionPatch; before: LabelDescription; after: LabelDescription };
type History = { volume: SvrVolume; labels: SvrLabelVolume | null; undo: Edit[]; redo: Edit[] };
type SelectionStatus = { running: boolean; progress?: number; error?: string; boundaryCount?: number };
const IDLE_STATUS: SelectionStatus = { running: false };
const initial = (volume: SvrVolume, labels: SvrLabelVolume | null): History => ({ volume, labels, undo: [], redo: [] });
const description = (labels: SvrLabelVolume | null): LabelDescription => ({
  meta: labels?.meta ?? SELECTION_LABEL_META,
  reviewState: labels?.reviewState,
  seeds: labels?.seeds,
});
const editBytes = (edit: Edit) =>
  edit.mask.indices.byteLength +
  edit.mask.before.byteLength +
  edit.mask.after.byteLength +
  (edit.before.seeds?.foreground.byteLength ?? 0) +
  (edit.before.seeds?.background.byteLength ?? 0) +
  (edit.after.seeds?.foreground.byteLength ?? 0) +
  (edit.after.seeds?.background.byteLength ?? 0);

function marksFrom(labels: SvrLabelVolume | null, volume: SvrVolume) {
  const marks = new Map<number, 1 | 2>();
  for (const [indices, kind] of [
    [labels?.seeds?.foreground, 1],
    [labels?.seeds?.background, 2],
  ] as const) {
    for (const index of indices ?? []) {
      if (
        index < volume.data.length &&
        Number.isFinite(volume.data[index]) &&
        (!volume.observedSupport || volume.observedSupport[index])
      )
        marks.set(index, kind);
    }
  }
  return marks;
}

export function useSvrSelection(
  volume: SvrVolume,
  labels: SvrLabelVolume | null,
  onChange: (labels: SvrLabelVolume | null, patch?: SelectionPatch, previousData?: Uint8Array) => void,
) {
  const [history, setHistory] = useState(() => initial(volume, labels));
  const state = history.volume === volume && history.labels === labels ? history : initial(volume, labels);
  const [ownedStatus, setOwnedStatus] = useState(() => ({ volume, labels, status: IDLE_STATUS }));
  const status = ownedStatus.volume === volume && ownedStatus.labels === labels ? ownedStatus.status : IDLE_STATUS;
  const runner = useRef<SeededVolumeWorker | null>(null);
  const request = useRef<AbortController | null>(null);
  const published = useRef<SvrLabelVolume | null>(null);
  const currentLabels = useRef(labels);
  const marks = useMemo(() => marksFrom(labels, volume), [labels, volume]);
  const setStatus = useCallback(
    (update: SelectionStatus | ((current: SelectionStatus) => SelectionStatus)) => {
      const owner = currentLabels.current;
      setOwnedStatus((previous) => {
        const current = previous.volume === volume && previous.labels === owner ? previous.status : IDLE_STATUS;
        return { volume, labels: owner, status: typeof update === 'function' ? update(current) : update };
      });
    },
    [volume],
  );

  useEffect(() => {
    currentLabels.current = labels;
    if (labels !== published.current) {
      request.current?.abort();
      request.current = null;
    }
  }, [labels, volume]);
  useEffect(
    () => () => {
      request.current?.abort();
      runner.current?.dispose();
      runner.current = null;
    },
    [volume],
  );

  const publish = useCallback(
    (next: SvrLabelVolume | null, patch?: SelectionPatch) => {
      const previous = currentLabels.current;
      const previousData = previous?.data;
      published.current = next;
      currentLabels.current = next;
      setHistory((current) => ({
        ...(current.volume === volume && current.labels === previous ? current : initial(volume, previous)),
        labels: next,
      }));
      onChange(next, patch, previousData);
    },
    [onChange, volume],
  );
  const cancel = useCallback(() => {
    request.current?.abort();
    request.current = null;
    setStatus({ running: false });
  }, [setStatus]);
  const record = useCallback(
    (data: Uint8Array, after: LabelDescription, candidates?: Uint32Array) => {
      const previous = currentLabels.current;
      const edit: Edit = {
        mask: selectionPatch(previous?.data ?? new Uint8Array(volume.data.length), data, candidates),
        before: description(previous),
        after,
      };
      setHistory((current) => {
        const prior = current.volume === volume && current.labels === previous ? current : initial(volume, previous);
        const undo = [...prior.undo, edit];
        let bytes = undo.reduce((sum, entry) => sum + editBytes(entry), 0);
        while (undo.length && (undo.length > 20 || bytes > 32 * 1024 * 1024)) bytes -= editBytes(undo.shift()!);
        return { volume, labels: previous, undo, redo: [] };
      });
      publish({ data, dims: volume.dims, ...after }, edit.mask);
    },
    [publish, volume],
  );

  const stroke = useCallback(
    (indices: Uint32Array, kind: 'include' | 'exclude') => {
      const supported = Uint32Array.from(indices).filter(
        (index) =>
          index < volume.data.length &&
          Number.isFinite(volume.data[index]) &&
          (!volume.observedSupport || volume.observedSupport[index]),
      );
      if (!supported.length) {
        setStatus((current) => ({
          ...current,
          error: 'This stroke contains no acquired MRI tissue. Move the brush inside the observed image.',
        }));
        return;
      }
      cancel();
      const previous = currentLabels.current;
      const next = previous?.data.slice() ?? new Uint8Array(volume.data.length);
      const relabel = previous?.meta.some((entry) => entry.id !== 1 || entry.name !== 'Selected tissue') ?? false;
      if (relabel) for (let index = 0; index < next.length; index++) if (next[index]) next[index] = 1;
      const nextMarks = marksFrom(previous, volume);
      for (const index of supported) {
        next[index] = kind === 'include' ? 1 : 0;
        nextMarks.set(index, kind === 'include' ? 1 : 2);
      }
      const foreground: number[] = [],
        background: number[] = [];
      for (const [index, value] of nextMarks) (value === 1 ? foreground : background).push(index);
      record(
        next,
        {
          meta: SELECTION_LABEL_META,
          reviewState: 'draft',
          seeds: { foreground: Uint32Array.from(foreground), background: Uint32Array.from(background) },
        },
        relabel ? undefined : supported,
      );
    },
    [cancel, record, setStatus, volume],
  );

  const grow = useCallback(async () => {
    cancel();
    const seeds = currentLabels.current?.seeds;
    if (!seeds?.foreground.length || !seeds.background.length) {
      setStatus({ running: false, error: 'Mark tissue to include, then mark nearby tissue to exclude.' });
      return;
    }
    const controller = new AbortController();
    request.current = controller;
    runner.current ??= new SeededVolumeWorker();
    setStatus({ running: true, progress: 0 });
    try {
      const result = await runner.current.run(
        {
          volume: volume.data,
          observedSupport: volume.observedSupport,
          dims: volume.dims,
          voxelSizeMm: volume.voxelSizeMm,
          ...seeds,
        },
        {
          signal: controller.signal,
          onProgress: (processed, total) => {
            if (!controller.signal.aborted) setStatus({ running: true, progress: processed / total });
          },
        },
      );
      if (controller.signal.aborted || request.current !== controller) return;
      const next = new Uint8Array(volume.data.length);
      for (const index of result.indices)
        if (index < next.length && (!volume.observedSupport || volume.observedSupport[index])) next[index] = 1;
      record(next, { meta: SELECTION_LABEL_META, reviewState: 'draft', seeds });
      setStatus({ running: false, boundaryCount: result.boundaryCount });
    } catch (error) {
      if (!controller.signal.aborted)
        setStatus({ running: false, error: error instanceof Error ? error.message : String(error) });
    } finally {
      if (request.current === controller) request.current = null;
    }
  }, [cancel, record, setStatus, volume]);

  const travel = useCallback(
    (direction: 'undo' | 'redo') => {
      const edit = state[direction].at(-1);
      if (!edit) return;
      cancel();
      const restoring = direction === 'undo';
      const opposite = restoring ? 'redo' : 'undo';
      setHistory({ ...state, [direction]: state[direction].slice(0, -1), [opposite]: [...state[opposite], edit] });
      const patch = restoring ? { ...edit.mask, before: edit.mask.after, after: edit.mask.before } : edit.mask;
      publish(
        {
          data: applySelectionPatch(
            currentLabels.current?.data ?? new Uint8Array(volume.data.length),
            edit.mask,
            direction,
          ),
          dims: volume.dims,
          ...(restoring ? edit.before : edit.after),
        },
        patch,
      );
    },
    [cancel, publish, state, volume],
  );
  const clear = useCallback(() => {
    cancel();
    record(new Uint8Array(volume.data.length), { meta: SELECTION_LABEL_META, reviewState: 'draft' });
  }, [cancel, record, volume]);
  const accept = useCallback(() => {
    if (currentLabels.current?.data.some(Boolean) && !status.running)
      publish({ ...currentLabels.current, reviewState: 'reviewed' });
  }, [publish, status.running]);
  let included = 0,
    excluded = 0;
  for (const mark of marks.values()) {
    if (mark === 1) included++;
    else excluded++;
  }
  return {
    marks,
    included,
    excluded,
    canUndo: state.undo.length > 0,
    canRedo: state.redo.length > 0,
    status,
    stroke,
    grow,
    cancel,
    travel,
    clear,
    accept,
  };
}
