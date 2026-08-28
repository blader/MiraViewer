import { useEffect, useRef, useState } from 'react';
import type { SvrVolume } from '../types/svr';
import { makeNativePlaneData, NativeFrameCache, type NativePlaneData } from '../utils/svr/nativePlane';

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
  const [loaded, setLoaded] = useState<{
    volume: SvrVolume;
    sourceIndex: number;
    frameIndex: number;
    plane: NativePlaneData | null;
    error: string | null;
  } | null>(null);
  if (loaded && loaded.volume !== volume) setLoaded(null);
  const source = volume?.sourceProvenance?.sources[sourceIndex];
  const frame = source?.frames[frameIndex];
  useEffect(() => {
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
          volume,
          sourceIndex,
          frameIndex,
          plane: makeNativePlaneData(volume, source, frameIndex, image),
          error: null,
        });
        for (const neighbor of [frameIndex - 1, frameIndex + 1])
          if (source.frames[neighbor]) void cache.load(source, neighbor).catch(() => undefined);
      })
      .catch((error: unknown) => {
        if (active)
          setLoaded({
            volume,
            sourceIndex,
            frameIndex,
            plane: null,
            error: error instanceof Error ? error.message : String(error),
          });
      });
    return () => {
      active = false;
    };
  }, [volume, source, frame, sourceIndex, frameIndex]);
  useEffect(
    () => () => {
      cacheRef.current?.dispose();
      cacheRef.current = null;
    },
    [],
  );
  const current =
    loaded?.volume === volume && loaded.sourceIndex === sourceIndex && loaded.frameIndex === frameIndex ? loaded : null;
  return { plane: current?.plane ?? null, loading: Boolean(frame && !current), error: current?.error ?? null };
}
