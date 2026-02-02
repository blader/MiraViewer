import { useCallback, useRef, useState } from 'react';
import type { SvrParams, SvrProgress, SvrResult, SvrSelectedSeries } from '../types/svr';
import { DEFAULT_SVR_PARAMS } from '../types/svr';
import { reconstructVolumeMultiPlane } from '../utils/svr/reconstructVolume';

export type UseSvrReconstructionState = {
  isRunning: boolean;
  progress: SvrProgress | null;
  result: SvrResult | null;
  error: string | null;
};

export type SvrRunOutcome = {
  result: SvrResult | null;
  error: string | null;
  durationMs: number;
};

export function useSvrReconstruction() {
  const [state, setState] = useState<UseSvrReconstructionState>({
    isRunning: false,
    progress: null,
    result: null,
    error: null,
  });

  const abortRef = useRef<AbortController | null>(null);
  const lastProgressUpdateMsRef = useRef(0);

  const cancel = useCallback(() => {
    abortRef.current?.abort();
  }, []);

  const clear = useCallback(() => {
    setState({ isRunning: false, progress: null, result: null, error: null });
  }, []);

  const run = useCallback(async (selectedSeries: SvrSelectedSeries[], params?: Partial<SvrParams>): Promise<SvrRunOutcome> => {
    abortRef.current?.abort();

    const controller = new AbortController();
    abortRef.current = controller;

    const svrParams: SvrParams = { ...DEFAULT_SVR_PARAMS, ...(params || {}) };

    setState({
      isRunning: true,
      progress: { phase: 'idle', current: 0, total: 100, message: 'Starting…' },
      result: null,
      error: null,
    });

    lastProgressUpdateMsRef.current = 0;

    const started = performance.now();

    try {
      const result = await reconstructVolumeMultiPlane({
        selectedSeries,
        svrParams,
        signal: controller.signal,
        onProgress: (p) => {
          const now = Date.now();
          const isFinal = p.current >= p.total;

          // Avoid spamming React renders.
          if (!isFinal && now - lastProgressUpdateMsRef.current < 100) {
            return;
          }
          lastProgressUpdateMsRef.current = now;

          setState((s) => ({
            ...s,
            progress: p,
          }));
        },
      });

      setState({
        isRunning: false,
        progress: { phase: 'finalizing', current: 100, total: 100, message: 'Done' },
        result,
        error: null,
      });

      return {
        result,
        error: null,
        durationMs: performance.now() - started,
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setState({
        isRunning: false,
        progress: null,
        result: null,
        error: msg,
      });

      return {
        result: null,
        error: msg,
        durationMs: performance.now() - started,
      };
    } finally {
      abortRef.current = null;
    }
  }, []);

  return {
    ...state,
    run,
    cancel,
    clear,
  };
}
