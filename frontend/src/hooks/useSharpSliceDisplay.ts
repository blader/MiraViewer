import { createContext, useLayoutEffect, useState } from 'react';
import type { DerivedAlignmentFrame } from '../utils/derivedAlignmentFrame';
import {
  createDerivedImagePresentation,
  sameDerivedAlignmentContent,
  type DerivedImagePresentation,
} from '../utils/derivedImagePresentation';
import { requestSharpSliceDisplay } from '../utils/sharpSliceDisplay';

export const SharpSliceDisplayContext = createContext({ enabled: false, suspended: false });

export type SharpSliceDisplay = {
  sourceKey: string | null;
  image?: DerivedImagePresentation;
  status: 'original' | 'loading' | 'ready' | 'unavailable' | 'error';
  message?: string;
};

type StoredDisplay = {
  source: DerivedAlignmentFrame | null;
  status: 'loading' | 'ready' | 'error';
  image?: DerivedImagePresentation;
  message?: string;
};

/** Own only the current display replacement; registration and acquired pixels remain untouched. */
export function useSharpSliceDisplay(
  source: DerivedAlignmentFrame | null,
  { enabled, suspended }: { enabled: boolean; suspended: boolean },
): SharpSliceDisplay {
  const [stored, setStored] = useState<StoredDisplay>({ source, status: 'loading' });
  // Keep both pending and settled work across exact replays; a new payload under
  // the same image ID must still discard the predecessor's prediction.
  const matches = sameDerivedAlignmentContent(stored.source, source);
  if (!matches || (!enabled && stored.status === 'error')) setStored({ source, status: 'loading' });
  const current = matches ? stored : undefined;
  const activeSource = current?.source ?? null;
  const settled = Boolean(current && current.status !== 'loading');

  useLayoutEffect(() => {
    if (!activeSource || !enabled || suspended || settled) return;
    const controller = new AbortController();
    const { signal } = controller;
    // Start after layout, and cancel before a changed source or gesture can accept a late completion.
    void Promise.resolve()
      .then(() => {
        signal.throwIfAborted();
        return requestSharpSliceDisplay(activeSource, {
          signal,
          onProgress: (message) => {
            if (!signal.aborted) setStored({ source: activeSource, status: 'loading', message });
          },
        });
      })
      .then((result) => {
        signal.throwIfAborted();
        // Cornerstone caches rendered pixels by string ID, even when a source object is replaced.
        const imageId = `${activeSource.imageId}:sharp:${crypto.randomUUID()}`;
        return createDerivedImagePresentation(activeSource, imageId, result, signal);
      })
      .then((image) => {
        signal.throwIfAborted();
        setStored({ source: activeSource, status: 'ready', image });
      })
      .catch((error: unknown) => {
        if (!signal.aborted) {
          setStored({
            source: activeSource,
            status: 'error',
            message: error instanceof Error ? error.message : 'Sharp slice enhancement is unavailable',
          });
        }
      });
    return () => controller.abort();
  }, [activeSource, enabled, suspended, settled]);

  return {
    sourceKey: enabled ? (source?.imageId ?? null) : null,
    image: enabled && source ? current?.image : undefined,
    status: !enabled ? 'original' : !source ? 'unavailable' : (current?.status ?? 'loading'),
    message: suspended && !settled ? 'Enhancement paused' : current?.message,
  };
}
