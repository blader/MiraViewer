import { useCallback, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { SvrLabelVolume, SvrVolume } from '../types/svr';
import { cropEnhancementSource, type EnhancementSourceLoader } from '../utils/svr/superResolutionRegion';
import { runSuperResolution } from '../utils/svr/superResolutionWorker';
import type { SvrEnhancedVolume } from '../utils/svr/superResolutionTypes';
import { clamp } from '../utils/math';

type Scope = { volume: SvrVolume | null; data: Uint8Array | undefined };
type EnhancementState = {
  scope: Scope | null;
  running: boolean;
  progress: number;
  message: string;
  result: SvrEnhancedVolume | null;
  source: SvrVolume | null;
  error: string | null;
  enabled: boolean;
  strength: number;
};
const EMPTY: EnhancementState = {
  scope: null,
  running: false,
  progress: 0,
  message: '',
  result: null,
  source: null,
  error: null,
  enabled: false,
  strength: 1,
};

/** One transient display result. MRI, saved labels and their measurement grid remain the sole authorities. */
export function useSvrEnhancement({
  volume,
  labels,
  loadSource,
  blocked = false,
}: {
  volume: SvrVolume | null;
  labels: SvrLabelVolume | null;
  loadSource?: EnhancementSourceLoader;
  blocked?: boolean;
}) {
  const scope = useMemo(() => ({ volume, data: labels?.data, blocked }), [volume, labels?.data, blocked]);
  const liveScope = useRef(scope);
  const operation = useRef<AbortController | null>(null);
  const [stored, setStored] = useState<EnhancementState>(EMPTY);
  // A new examination/selection owns a new display layer. Release stale buffers,
  // rather than merely hiding them and undercounting them in the next admission.
  if (stored.scope !== null && stored.scope !== scope) setStored(EMPTY);
  const state = stored.scope === scope ? stored : EMPTY;
  useLayoutEffect(() => {
    liveScope.current = scope;
    return () => {
      operation.current?.abort();
      operation.current = null;
    };
  }, [scope]);

  const cancel = useCallback(() => {
    operation.current?.abort();
    operation.current = null;
    setStored((current) => ({
      ...current,
      running: false,
      progress: 0,
      message: 'Enhancement canceled. Original data is unchanged.',
    }));
  }, []);
  const clear = useCallback(() => {
    operation.current?.abort();
    operation.current = null;
    setStored(EMPTY);
  }, []);
  const run = useCallback(
    async (prepareMemory: number | (() => number) = 0) => {
      if (!volume || !labels || blocked) return false;
      operation.current?.abort();
      const controller = new AbortController();
      operation.current = controller;
      const current = () =>
        operation.current === controller && liveScope.current === scope && !controller.signal.aborted;
      setStored({ ...EMPTY, scope, running: true, message: 'Loading original detail around your selection…' });
      let lastUpdate = 0;
      const progress = (fraction: number, message: string) => {
        if (!current()) return false;
        const now = performance.now();
        if (now - lastUpdate < 80 && fraction < 1) return;
        lastUpdate = now;
        setStored((previous) => ({
          ...previous,
          progress: Math.max(previous.progress, clamp(fraction, 0, 1)),
          message,
        }));
      };
      try {
        // The selection owner can release its idle worker's reproducible MRI copy
        // before reporting the marks/history that genuinely remain resident.
        const additionalRetainedBytes = typeof prepareMemory === 'function' ? prepareMemory() : prepareMemory;
        if (!Number.isSafeInteger(additionalRetainedBytes) || additionalRetainedBytes < 0)
          throw new Error('Enhancement requires a valid retained-memory estimate. Original data is unchanged.');
        const options = {
          signal: controller.signal,
          // A previous enhanced GPU allocation can survive until React commits this run's loading state.
          retainedBytes: (state.result ? state.result.data.length * 10 : 0) + additionalRetainedBytes,
          onProgress: (p: { current: number; total: number; message: string }) =>
            progress((p.current / Math.max(1, p.total)) * 0.2, p.message),
        };
        const source = loadSource
          ? await loadSource(labels, options)
          : await cropEnhancementSource(volume, labels, options);
        if (!current()) return;
        const result = await runSuperResolution(source, {
          signal: controller.signal,
          onProgress: (p) => {
            const ranges = {
              preparing: [0, 0.15],
              training: [0.15, 0.35],
              validating: [0.35, 0.4],
              enhancing: [0.4, 1],
            } as const;
            const [start, end] = ranges[p.phase];
            progress(0.2 + 0.8 * (start + ((end - start) * p.current) / Math.max(1, p.total)), p.message);
          },
        });
        if (!current()) return false;
        setStored({ ...EMPTY, scope, result, source, enabled: true, progress: 1, message: 'Enhanced region ready' });
        return true;
      } catch (error) {
        if (!current()) return false;
        setStored({ ...EMPTY, scope, error: error instanceof Error ? error.message : String(error) });
        return false;
      } finally {
        if (operation.current === controller) operation.current = null;
      }
    },
    [blocked, labels, loadSource, scope, state.result, volume],
  );

  const setEnabled = useCallback(
    (enabled: boolean) => {
      setStored((current) => (current.scope === scope && current.result ? { ...current, enabled } : current));
    },
    [scope],
  );
  const setStrength = useCallback(
    (strength: number) => {
      if (!Number.isFinite(strength)) return;
      setStored((current) => (current.scope === scope ? { ...current, strength: clamp(strength, 0, 1) } : current));
    },
    [scope],
  );
  const failDisplay = useCallback(
    (result: SvrEnhancedVolume, error: unknown) => {
      setStored((current) =>
        current.scope === scope && current.result === result
          ? { ...EMPTY, scope, error: error instanceof Error ? error.message : String(error) }
          : current,
      );
    },
    [scope],
  );

  return { ...state, run, cancel, clear, setEnabled, setStrength, failDisplay };
}
