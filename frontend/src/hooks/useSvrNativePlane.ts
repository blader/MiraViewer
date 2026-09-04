import { useEffect, useMemo, useRef, useState } from 'react';
import type { SvrVolume } from '../types/svr';
import {
  makeNativePlaneData,
  NativeFrameCache,
  NativeFrameOwnershipError,
  type NativePlaneData,
} from '../utils/svr/nativePlane';

export function useSvrNativePlane({
  volume,
  sourceIndex,
  frameIndex,
}: {
  volume: SvrVolume | null;
  sourceIndex: number;
  frameIndex: number;
}) {
  const cacheRef = useRef<NativeFrameCache | null>(null);
  const source = volume?.sourceProvenance?.sources[sourceIndex];
  const frame = source?.frames[frameIndex];
  const request = useMemo(() => ({ volume, source, frame, frameIndex }), [volume, source, frame, frameIndex]);
  const [loaded, setLoaded] = useState<{
    request: typeof request;
    plane: NativePlaneData | null;
    error: string | null;
  } | null>(null);
  if (loaded && (loaded.request.volume !== volume || loaded.request.source !== source || !frame)) setLoaded(null);
  useEffect(() => {
    const { volume, source, frame, frameIndex } = request;
    if (cacheRef.current?.volume !== volume) {
      cacheRef.current?.dispose();
      cacheRef.current = null;
    }
    if (!volume || !source || !frame) return;
    const cache = (cacheRef.current ??= new NativeFrameCache(volume));
    cache.retain(source, frameIndex);
    let active = true;
    void cache
      .load(source, frameIndex)
      .then((image) => {
        if (!active) return;
        setLoaded({
          request,
          plane: makeNativePlaneData(volume, source, frameIndex, image),
          error: null,
        });
        for (const neighbor of [frameIndex - 1, frameIndex + 1])
          if (source.frames[neighbor]) void cache.load(source, neighbor, { prefetch: true }).catch(() => undefined);
      })
      .catch((error: unknown) => {
        if (active)
          setLoaded((previous) => ({
            request,
            plane:
              !(error instanceof NativeFrameOwnershipError) &&
              previous?.request.volume === volume &&
              previous.request.source === source
                ? previous.plane
                : null,
            error: error instanceof Error ? error.message : String(error),
          }));
      });
    return () => {
      active = false;
    };
  }, [request]);
  useEffect(
    () => () => {
      cacheRef.current?.dispose();
      cacheRef.current = null;
    },
    [],
  );
  const current = loaded?.request === request ? loaded : null;
  // A pending same-source request keeps the last complete image paired with its actual geometry.
  const plane = frame && loaded?.request.volume === volume && loaded.request.source === source ? loaded.plane : null;
  return { plane, loading: Boolean(frame && !current), error: current?.error ?? null };
}
