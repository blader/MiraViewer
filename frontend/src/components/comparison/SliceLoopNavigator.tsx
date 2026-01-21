import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Pause, Play } from 'lucide-react';
import { CONTROL_LIMITS } from '../../utils/constants';
import {
  readPersistedSliceLoopPlaybackSettingsForSeq,
  writePersistedSliceLoopPlaybackSettingsForSeq,
} from '../../utils/sliceLoopPlaybackPersistence';

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

function ensureLoopBounds(start: number, end: number): [number, number] {
  const minGap = 0.01;
  const s = clamp01(start);
  let e = clamp01(end);
  if (e - s < minGap) {
    e = clamp01(s + minGap);
  }
  return [s, e];
}

export type SliceLoopNavigatorProps = {
  selectedSeqId: string | null;
  /** Number of slices in the current context (used to compute per-step progress). */
  playbackInstanceCount: number;
  /** Normalized progress (0..1). */
  progress: number;
  /** Shared progress ref used by global wheel navigation + playback loops. */
  progressRef: React.MutableRefObject<number>;
  /** Setter for progress (callers can wrap to clear AI, etc.). */
  setProgress: (nextProgress: number) => void;
};

export function SliceLoopNavigator({
  selectedSeqId,
  playbackInstanceCount,
  progress,
  progressRef,
  setProgress,
}: SliceLoopNavigatorProps) {
  // Loop playback for slice navigation
  const [loopStart, setLoopStart] = useState(0);
  const [loopEnd, setLoopEnd] = useState(1);
  const [isLooping, setIsLooping] = useState(false);
  const [loopSpeed, setLoopSpeed] = useState<1 | 2 | 4>(1);
  const loopDirectionRef = useRef<1 | -1>(1);
  const rafRef = useRef<number | null>(null);
  const lastTsRef = useRef<number | null>(null);
  const loopStepAccumRef = useRef(0);
  const trackRef = useRef<HTMLDivElement | null>(null);
  const [draggingHandle, setDraggingHandle] = useState<'start' | 'end' | null>(null);

  const playbackHydratedSeqIdRef = useRef<string | null>(null);

  // Hydrate playback settings when the user switches sequence combos.
  // Layout effect prevents a one-frame flash of the previous combo's handles.
  useLayoutEffect(() => {
    if (!selectedSeqId) return;

    const persisted = readPersistedSliceLoopPlaybackSettingsForSeq(selectedSeqId);
    if (persisted) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- hydrate per-seq loop UI state on seq change (avoids a one-frame flash).
      setLoopStart(persisted.loopStart);
      setLoopEnd(persisted.loopEnd);
      setLoopSpeed(persisted.loopSpeed);
    } else {
      setLoopStart(0);
      setLoopEnd(1);
      setLoopSpeed(1);
    }

    playbackHydratedSeqIdRef.current = selectedSeqId;
  }, [selectedSeqId]);

  // Persist per-seq loop window.
  useEffect(() => {
    if (!selectedSeqId) return;
    if (playbackHydratedSeqIdRef.current !== selectedSeqId) return;

    writePersistedSliceLoopPlaybackSettingsForSeq(selectedSeqId, {
      loopStart,
      loopEnd,
      loopSpeed,
    });
  }, [selectedSeqId, loopStart, loopEnd, loopSpeed]);

  // Adjust loop bounds and keep progress inside
  const updateLoop = useCallback(
    (nextStart: number, nextEnd: number) => {
      const [s, e] = ensureLoopBounds(nextStart, nextEnd);
      setLoopStart(s);
      setLoopEnd(e);

      const clamped = clamp01(Math.max(s, Math.min(progressRef.current, e)));
      progressRef.current = clamped;
      setProgress(clamped);
    },
    [progressRef, setProgress]
  );

  // rAF-driven ping-pong playback (advances by slice-sized steps to avoid overwhelming the UI)
  useEffect(() => {
    if (!isLooping) {
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
      lastTsRef.current = null;
      loopStepAccumRef.current = 0;
      return;
    }

    lastTsRef.current = null;
    loopStepAccumRef.current = 0;

    const baseSlicesPerSecond = 8; // 1x = 8 slices/sec; 2x/4x scale from there.

    const step = (ts: number) => {
      if (lastTsRef.current === null) {
        lastTsRef.current = ts;
        rafRef.current = requestAnimationFrame(step);
        return;
      }

      // Cap dt so tab-switch / hitch doesn't jump too far.
      const dt = Math.min(0.1, (ts - lastTsRef.current) / 1000);
      lastTsRef.current = ts;

      const denom = Math.max(1, playbackInstanceCount - 1);
      const stepProgress = 1 / denom;

      loopStepAccumRef.current += dt * baseSlicesPerSecond * loopSpeed;
      let didAdvance = false;

      while (loopStepAccumRef.current >= 1) {
        loopStepAccumRef.current -= 1;

        let next = progressRef.current + stepProgress * loopDirectionRef.current;

        // Reflect at bounds (ping-pong).
        while (next > loopEnd || next < loopStart) {
          if (next > loopEnd) {
            next = loopEnd - (next - loopEnd);
            loopDirectionRef.current = -1;
          } else if (next < loopStart) {
            next = loopStart + (loopStart - next);
            loopDirectionRef.current = 1;
          }
        }

        next = clamp01(next);
        if (next !== progressRef.current) {
          progressRef.current = next;
          didAdvance = true;
        }
      }

      if (didAdvance) {
        setProgress(progressRef.current);
      }

      rafRef.current = requestAnimationFrame(step);
    };

    rafRef.current = requestAnimationFrame(step);
    return () => {
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
      lastTsRef.current = null;
      loopStepAccumRef.current = 0;
    };
  }, [isLooping, loopStart, loopEnd, loopSpeed, playbackInstanceCount, progressRef, setProgress]);

  // Stop looping if bounds collapse
  useEffect(() => {
    if (loopEnd - loopStart < 0.005 && isLooping) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- guardrail: stop playback when bounds collapse.
      setIsLooping(false);
    }
  }, [loopStart, loopEnd, isLooping, setIsLooping]);

  // Drag handlers for loop handles
  useEffect(() => {
    if (!draggingHandle) return;

    const handleMove = (e: MouseEvent) => {
      const rect = trackRef.current?.getBoundingClientRect();
      if (!rect) return;
      const pct = clamp01((e.clientX - rect.left) / rect.width);
      if (draggingHandle === 'start') {
        updateLoop(pct, loopEnd);
      } else {
        updateLoop(loopStart, pct);
      }
    };

    const handleUp = () => setDraggingHandle(null);

    window.addEventListener('mousemove', handleMove);
    window.addEventListener('mouseup', handleUp);
    return () => {
      window.removeEventListener('mousemove', handleMove);
      window.removeEventListener('mouseup', handleUp);
    };
  }, [draggingHandle, loopEnd, loopStart, updateLoop]);

  return (
    <div className="px-4 py-3 bg-[var(--bg-secondary)] border-t border-[var(--border-color)] flex items-center gap-4">
      <div className="flex items-center gap-2">
        <button
          type="button"
          className={`p-2 rounded-md border border-[var(--border-color)] ${isLooping ? 'bg-[var(--accent)] text-white border-[var(--accent)]' : 'bg-[var(--bg-tertiary)] text-[var(--text-secondary)] hover:text-[var(--text-primary)]'}`}
          onClick={() => {
            // Ensure loop window has size before starting
            const minGap = 0.02;
            if (loopEnd - loopStart < minGap) {
              const newEnd = clamp01(loopStart + minGap);
              updateLoop(loopStart, newEnd);
            }
            loopDirectionRef.current = 1;
            setIsLooping(!isLooping);
          }}
          title={isLooping ? 'Pause loop' : 'Play loop'}
        >
          {isLooping ? <Pause className="w-4 h-4" /> : <Play className="w-4 h-4" />}
        </button>
        <div className="flex items-center gap-1 text-[10px] text-[var(--text-secondary)]">
          {[1, 2, 4].map((s) => (
            <button
              key={s}
              type="button"
              className={`px-2 py-1 rounded border text-[10px] ${loopSpeed === s ? 'bg-[var(--accent)] text-white border-[var(--accent)]' : 'bg-[var(--bg-tertiary)] text-[var(--text-secondary)] hover:text-[var(--text-primary)] border-[var(--border-color)]'}`}
              onClick={() => setLoopSpeed(s as 1 | 2 | 4)}
            >
              {s}x
            </button>
          ))}
        </div>
      </div>

      <div className="text-xs text-[var(--text-secondary)] whitespace-nowrap">Slice</div>

      <div className="relative flex-1 h-8" ref={trackRef}>
        {/* Highlighted loop window */}
        <div className="absolute top-1/2 -translate-y-1/2 h-2 rounded bg-[var(--bg-tertiary)] w-full" aria-hidden />
        <div
          className="absolute top-1/2 -translate-y-1/2 h-2 rounded bg-[var(--accent)] opacity-40"
          style={{
            left: `${loopStart * 100}%`,
            width: `${Math.max(0, loopEnd - loopStart) * 100}%`,
          }}
          aria-hidden
        />

        {/* Main progress slider */}
        <input
          type="range"
          min={0}
          max={CONTROL_LIMITS.SLICE_NAV.MAX_RANGE}
          step={1}
          value={Math.round(progress * CONTROL_LIMITS.SLICE_NAV.MAX_RANGE)}
          onChange={(e) => setProgress(parseInt(e.target.value, 10) / CONTROL_LIMITS.SLICE_NAV.MAX_RANGE)}
          className="absolute inset-0 w-full h-8 opacity-0 cursor-pointer"
          aria-label="Slice position"
        />

        {/* Visible thumb for current position */}
        <div
          className="absolute top-1/2 -translate-y-1/2 w-2 h-4 bg-[var(--text-primary)] rounded pointer-events-none"
          style={{ left: `calc(${progress * 100}% - 4px)` }}
          aria-hidden
        />

        {/* Loop handles */}
        {(['start', 'end'] as const).map((handle) => {
          const pos = handle === 'start' ? loopStart : loopEnd;
          return (
            <button
              key={handle}
              type="button"
              className="absolute top-1/2 -translate-y-1/2 w-3 h-5 bg-white border border-[var(--accent)] rounded cursor-ew-resize"
              style={{ left: `calc(${pos * 100}% - 6px)` }}
              onMouseDown={(e) => {
                e.preventDefault();
                setDraggingHandle(handle);
              }}
              title={handle === 'start' ? 'Loop start' : 'Loop end'}
            />
          );
        })}
      </div>
    </div>
  );
}
