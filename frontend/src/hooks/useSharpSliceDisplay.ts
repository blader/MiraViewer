import { createContext, useLayoutEffect, useState } from 'react';
import type { DerivedAlignmentFrame } from '../utils/derivedAlignmentFrame';
import { createDerivedImagePresentation, type DerivedImagePresentation } from '../utils/derivedImagePresentation';
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
  // A rerun can reuse an image ID. Source-object identity prevents reusing its predecessor's prediction.
  if (stored.source !== source || (!enabled && stored.status === 'error')) setStored({ source, status: 'loading' });
  const current = stored.source === source ? stored : undefined;
  const settled = Boolean(current && current.status !== 'loading');

  useLayoutEffect(() => {
    if (!source || !enabled || suspended || settled) return;
    const controller = new AbortController();
    const { signal } = controller;
    // Start after layout, and cancel before a changed source or gesture can accept a late completion.
    void Promise.resolve()
      .then(() => {
        signal.throwIfAborted();
        return requestSharpSliceDisplay(source, {
          signal,
          onProgress: (message) => {
            if (!signal.aborted) setStored({ source, status: 'loading', message });
          },
        });
      })
      .then((result) => {
        signal.throwIfAborted();
        // Cornerstone caches rendered pixels by string ID, even when a source object is replaced.
        const imageId = `${source.imageId}:sharp:${crypto.randomUUID()}`;
        return createDerivedImagePresentation(source, imageId, result, signal);
      })
      .then((image) => {
        signal.throwIfAborted();
        setStored({ source, status: 'ready', image });
      })
      .catch((error: unknown) => {
        if (!signal.aborted) {
          setStored({
            source,
            status: 'error',
            message: error instanceof Error ? error.message : 'Sharp slice enhancement is unavailable',
          });
        }
      });
    return () => controller.abort();
  }, [source, enabled, suspended, settled]);

  return {
    sourceKey: enabled ? (source?.imageId ?? null) : null,
    image: enabled && source ? current?.image : undefined,
    status: !enabled ? 'original' : !source ? 'unavailable' : (current?.status ?? 'loading'),
    message: suspended && !settled ? 'Enhancement paused' : current?.message,
  };
}
