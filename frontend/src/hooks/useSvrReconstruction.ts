import { useCallback, useEffect, useRef, useState } from 'react';
import type { SvrLabelVolume, SvrParams, SvrProgress, SvrResult, SvrSelectedSeries, SvrVolume } from '../types/svr';
import { DEFAULT_SVR_PARAMS } from '../types/svr';
import { reconstructVolumeMultiPlane } from '../utils/svr/reconstructVolume';
import { resampleSelectionForRefinement } from '../utils/svr/refineRegion';
import { retainedSvrVolumeBytes } from '../utils/svr/nativeVolume';
import { retainedDerivedAlignmentBytes } from '../utils/derivedAlignmentFrame';

export type UseSvrReconstructionState = {
  status: 'idle' | 'running' | 'canceling' | 'ready' | 'canceled' | 'failed';
  isRunning: boolean;
  progress: SvrProgress | null;
  result: SvrResult | null;
  resultIdentity: string | null;
  error: string | null;
};

export type SvrRunOutcome = {
  result: SvrResult | null;
  error: string | null;
  durationMs: number;
};

export function useSvrReconstruction() {
  const [state, setState] = useState<UseSvrReconstructionState>({
    status: 'idle',
    isRunning: false,
    progress: null,
    result: null,
    resultIdentity: null,
    error: null,
  });

  const abortRef = useRef<AbortController | null>(null);
  const runIdRef = useRef(0);
  const lastProgressUpdateMsRef = useRef(0);
  const acceptedResultRef = useRef<SvrResult | null>(null);

  useEffect(
    () => () => {
      runIdRef.current++;
      abortRef.current?.abort();
      abortRef.current = null;
      acceptedResultRef.current = null;
    },
    [],
  );

  const cancel = useCallback(() => {
    const controller = abortRef.current;
    if (!controller) return;

    setState((current) => ({
      ...current,
      status: 'canceling',
      progress: current.progress
        ? { ...current.progress, message: 'Canceling reconstruction…' }
        : { phase: 'idle', current: 0, total: 100, message: 'Canceling reconstruction…' },
    }));
    controller.abort();
  }, []);

  const clear = useCallback(() => {
    runIdRef.current++;
    abortRef.current?.abort();
    abortRef.current = null;
    acceptedResultRef.current = null;
    setState({ status: 'idle', isRunning: false, progress: null, result: null, resultIdentity: null, error: null });
  }, []);

  const run = useCallback(
    async (
      selectedSeries: SvrSelectedSeries[],
      params?: Partial<SvrParams>,
      identity?: string,
      selectionToRefine?: { volume: SvrVolume; labels: SvrLabelVolume; retainedBytes?: number | (() => number) },
    ): Promise<SvrRunOutcome> => {
      abortRef.current?.abort();

      const controller = new AbortController();
      const runId = ++runIdRef.current;
      abortRef.current = controller;
      const operationIdentity =
        identity ??
        selectedSeries
          .map((series) => series.seriesUid)
          .sort((left, right) => left.localeCompare(right))
          .join('|');

      const svrParams: SvrParams = { ...DEFAULT_SVR_PARAMS, ...(params || {}) };

      setState((current) => ({
        ...current,
        status: 'running',
        isRunning: true,
        progress: { phase: 'idle', current: 0, total: 100, message: 'Starting…' },
        error: null,
      }));

      lastProgressUpdateMsRef.current = 0;

      const started = performance.now();

      try {
        // Release reproducible idle-worker storage before counting live editing
        // buffers. Rejection leaves the accepted volume and its edits in place.
        const additionalRetainedBytes =
          typeof selectionToRefine?.retainedBytes === 'function'
            ? selectionToRefine.retainedBytes()
            : (selectionToRefine?.retainedBytes ?? 0);
        if (!Number.isSafeInteger(additionalRetainedBytes) || additionalRetainedBytes < 0)
          throw new Error('Refinement requires a valid retained-memory estimate. Original data is unchanged.');
        const accepted = acceptedResultRef.current;
        // The retained volume reserves one live CPU mask. A previously transferred
        // mask can survive independently after editing replaces its backing buffer.
        const retainedMasks = new Map<SvrVolume, Set<ArrayBufferLike>>();
        for (const [volume, mask] of [
          [accepted?.volume, accepted?.initialSelection?.data],
          [selectionToRefine?.volume, selectionToRefine?.labels.data],
        ] as const) {
          if (!volume) continue;
          const buffers = retainedMasks.get(volume) ?? new Set<ArrayBufferLike>();
          if (mask) buffers.add(mask.buffer);
          retainedMasks.set(volume, buffers);
        }
        const reconstruction = await reconstructVolumeMultiPlane({
          selectedSeries,
          svrParams,
          acceptedProvenance: selectionToRefine?.volume.sourceProvenance,
          retainedBytes:
            [...retainedMasks].reduce(
              (bytes, [volume, buffers]) =>
                bytes +
                retainedSvrVolumeBytes(volume) +
                Math.max(0, [...buffers].reduce((sum, buffer) => sum + buffer.byteLength, 0) - volume.data.length),
              additionalRetainedBytes,
            ) + (selectionToRefine ? retainedDerivedAlignmentBytes() : 0),
          signal: controller.signal,
          onProgress: (p) => {
            if (runIdRef.current !== runId || controller.signal.aborted) return;
            const now = Date.now();
            const isFinal = p.current >= p.total;

            // Avoid spamming React renders.
            if (!isFinal && now - lastProgressUpdateMsRef.current < 100) {
              return;
            }
            lastProgressUpdateMsRef.current = now;

            setState((current) => {
              const previous = current.progress
                ? (current.progress.current / Math.max(1, current.progress.total)) * 100
                : 0;
              const next = (p.current / Math.max(1, p.total)) * 100;

              return {
                ...current,
                progress: {
                  ...p,
                  current: Math.min(100, Math.max(previous, next)),
                  total: 100,
                },
              };
            });
          },
        });

        const result =
          selectionToRefine && !controller.signal.aborted && runIdRef.current === runId
            ? {
                ...reconstruction,
                initialSelection: await resampleSelectionForRefinement(
                  selectionToRefine.volume,
                  selectionToRefine.labels,
                  reconstruction.volume,
                  controller.signal,
                ),
              }
            : reconstruction;

        if (runIdRef.current !== runId || controller.signal.aborted) {
          return {
            result: null,
            error: 'Reconstruction was canceled.',
            durationMs: performance.now() - started,
          };
        }

        acceptedResultRef.current = result;
        setState({
          status: 'ready',
          isRunning: false,
          progress: null,
          result,
          resultIdentity: operationIdentity,
          error: null,
        });

        return {
          result,
          error: null,
          durationMs: performance.now() - started,
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (runIdRef.current === runId) {
          setState((current) => ({
            ...current,
            status: controller.signal.aborted ? 'canceled' : 'failed',
            isRunning: false,
            progress: null,
            error: controller.signal.aborted ? null : msg,
          }));
        }

        return {
          result: null,
          error: msg,
          durationMs: performance.now() - started,
        };
      } finally {
        if (abortRef.current === controller) abortRef.current = null;
      }
    },
    [],
  );

  return {
    ...state,
    run,
    cancel,
    clear,
  };
}
