import { useCallback, useEffect, useRef, useState } from 'react';
import type { SvrParams, SvrProgress, SvrResult, SvrSelectedSeries } from '../types/svr';
import { DEFAULT_SVR_PARAMS } from '../types/svr';
import { reconstructVolumeMultiPlane } from '../utils/svr/reconstructVolume';

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

  useEffect(
    () => () => {
      runIdRef.current++;
      abortRef.current?.abort();
      abortRef.current = null;
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
    setState({ status: 'idle', isRunning: false, progress: null, result: null, resultIdentity: null, error: null });
  }, []);

  const run = useCallback(
    async (
      selectedSeries: SvrSelectedSeries[],
      params?: Partial<SvrParams>,
      identity?: string,
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
        const result = await reconstructVolumeMultiPlane({
          selectedSeries,
          svrParams,
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

        if (runIdRef.current !== runId || controller.signal.aborted) {
          return {
            result: null,
            error: 'Reconstruction was canceled.',
            durationMs: performance.now() - started,
          };
        }

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
