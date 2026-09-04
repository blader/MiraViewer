import { useCallback, useEffect, useEffectEvent, useLayoutEffect, useRef, useState } from 'react';
import { Pause, Play } from 'lucide-react';
import { CONTROL_LIMITS } from '../../utils/constants';
import { clamp01, getEffectiveInstanceIndex, getProgressFromSlice, getSliceIndex } from '../../utils/math';
import {
  readPersistedSliceLoopPlaybackSettingsForSeq,
  writePersistedSliceLoopPlaybackSettingsForSeq,
} from '../../utils/sliceLoopPlaybackPersistence';

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
  reference?: { label: string; offset: number; reverseSliceOrder: boolean };
  /** Normalized progress (0..1). */
  progress: number;
  /** Shared progress ref used by global wheel navigation + playback loops. */
  progressRef: React.MutableRefObject<number>;
  /** Setter for progress. */
  setProgress: (nextProgress: number) => void;
  /** Modal dialogs and active registration own navigation until they complete. */
  interactionBlocked?: boolean;
};

type LoopRangeHandlesProps = {
  loopStart: number;
  loopEnd: number;
  playbackInstanceCount: number;
  interactionBlocked: boolean;
  draggingPointerIdRef: React.MutableRefObject<number | null>;
  setDraggingHandle: (handle: 'start' | 'end') => void;
  updateLoop: (nextStart: number, nextEnd: number) => void;
};

function LoopRangeHandles({
  loopStart,
  loopEnd,
  playbackInstanceCount,
  interactionBlocked,
  draggingPointerIdRef,
  setDraggingHandle,
  updateLoop,
}: LoopRangeHandlesProps) {
  return (['start', 'end'] as const).map((handle) => {
    const pos = handle === 'start' ? loopStart : loopEnd;

    return (
      <button
        key={handle}
        type="button"
        role="slider"
        aria-label={handle === 'start' ? 'Loop start position' : 'Loop end position'}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(pos * 100)}
        disabled={interactionBlocked}
        className="absolute top-1/2 inline-flex min-h-8 min-w-6 -translate-x-1/2 -translate-y-1/2 touch-none cursor-ew-resize items-center justify-center rounded-[2px] bg-transparent [@media(pointer:coarse)]:min-h-11 [@media(pointer:coarse)]:min-w-11"
        style={{ left: `${pos * 100}%` }}
        onPointerDown={(event) => {
          if (interactionBlocked || (event.button !== undefined && event.button !== 0)) return;
          event.preventDefault();
          draggingPointerIdRef.current = event.pointerId ?? null;
          setDraggingHandle(handle);
        }}
        onKeyDown={(event) => {
          const direction =
            event.key === 'ArrowLeft' || event.key === 'ArrowDown'
              ? -1
              : event.key === 'ArrowRight' || event.key === 'ArrowUp'
                ? 1
                : 0;
          if (direction === 0) return;
          event.preventDefault();
          const step = direction / Math.max(1, playbackInstanceCount - 1);
          if (handle === 'start') updateLoop(loopStart + step, loopEnd);
          else updateLoop(loopStart, loopEnd + step);
        }}
        title={handle === 'start' ? 'Loop start' : 'Loop end'}
      >
        <span
          aria-hidden="true"
          className="h-6 w-2 rounded-[2px] border border-[var(--signal-metal)] bg-[var(--bg-secondary)]"
        />
      </button>
    );
  });
}

function SliceNumberField({
  value,
  count,
  minimum = 1,
  maximum = count,
  disabled,
  onSelect,
  onStartEditing,
}: {
  value: number;
  count: number;
  minimum?: number;
  maximum?: number;
  disabled: boolean;
  onSelect: (slice: number) => void;
  onStartEditing: () => void;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  return (
    <>
      <span>Slice</span>
      <input
        type="number"
        min={minimum}
        max={maximum}
        step={1}
        inputMode="numeric"
        className="slice-number-input"
        aria-label="Go to slice"
        title={`Enter an acquired slice from ${minimum} to ${maximum}, then press Enter. The current alignment offset limits the available range.`}
        disabled={disabled}
        value={draft ?? value}
        onFocus={(event) => {
          onStartEditing();
          event.currentTarget.select();
        }}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={() => {
          if (!disabled && draft !== null && draft.trim() !== '') {
            const slice = Number(draft);
            if (Number.isInteger(slice) && slice >= minimum && slice <= maximum) onSelect(slice);
          }
          setDraft(null);
        }}
        onKeyDown={(event) => {
          if (event.key === 'Enter') {
            event.preventDefault();
            event.currentTarget.blur();
          } else if (event.key === 'Escape') {
            event.preventDefault();
            event.stopPropagation();
            setDraft(null);
          }
        }}
      />
      <span>/ {count}</span>
    </>
  );
}

export function SliceLoopNavigator({
  selectedSeqId,
  playbackInstanceCount,
  reference,
  progress,
  progressRef,
  setProgress,
  interactionBlocked = false,
}: SliceLoopNavigatorProps) {
  const referenceOffset = reference?.offset ?? 0;
  const reverseSliceOrder = reference?.reverseSliceOrder ?? false;
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
  const draggingPointerIdRef = useRef<number | null>(null);

  const playbackHydratedSeqIdRef = useRef<string | null>(null);

  useEffect(() => {
    if (!interactionBlocked) return;
    const timer = window.setTimeout(() => setIsLooping(false), 0);
    return () => window.clearTimeout(timer);
  }, [interactionBlocked]);

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
    [progressRef, setProgress],
  );

  const moveDraggedHandle = useEffectEvent((event: PointerEvent) => {
    if (draggingPointerIdRef.current !== null && event.pointerId !== draggingPointerIdRef.current) return;
    const rect = trackRef.current?.getBoundingClientRect();
    if (!rect || rect.width <= 0) return;
    const position = clamp01((event.clientX - rect.left) / rect.width);
    if (draggingHandle === 'start') updateLoop(position, loopEnd);
    else if (draggingHandle === 'end') updateLoop(loopStart, position);
  });

  // rAF-driven ping-pong playback (advances by slice-sized steps to avoid overwhelming the UI)
  useEffect(() => {
    if (!isLooping || interactionBlocked) {
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

      const firstSlice = getSliceIndex(playbackInstanceCount, loopStart, referenceOffset);
      const lastSlice = getSliceIndex(playbackInstanceCount, loopEnd, referenceOffset);
      if (lastSlice <= firstSlice) {
        rafRef.current = requestAnimationFrame(step);
        return;
      }

      loopStepAccumRef.current += dt * baseSlicesPerSecond * loopSpeed;
      let didAdvance = false;

      while (loopStepAccumRef.current >= 1) {
        loopStepAccumRef.current -= 1;

        let nextSlice =
          getSliceIndex(playbackInstanceCount, progressRef.current, referenceOffset) + loopDirectionRef.current;

        // Reflect at bounds (ping-pong).
        while (nextSlice > lastSlice || nextSlice < firstSlice) {
          if (nextSlice > lastSlice) {
            nextSlice = lastSlice - (nextSlice - lastSlice);
            loopDirectionRef.current = -1;
          } else if (nextSlice < firstSlice) {
            nextSlice = firstSlice + (firstSlice - nextSlice);
            loopDirectionRef.current = 1;
          }
        }

        const next = getProgressFromSlice(nextSlice, playbackInstanceCount, referenceOffset);
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
  }, [
    interactionBlocked,
    isLooping,
    loopStart,
    loopEnd,
    loopSpeed,
    playbackInstanceCount,
    referenceOffset,
    progressRef,
    setProgress,
  ]);

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

    const handleMove = (event: PointerEvent) => moveDraggedHandle(event);

    const handleUp = (e: PointerEvent) => {
      if (draggingPointerIdRef.current !== null && e.pointerId !== draggingPointerIdRef.current) return;
      draggingPointerIdRef.current = null;
      setDraggingHandle(null);
    };

    window.addEventListener('pointermove', handleMove);
    window.addEventListener('pointerup', handleUp);
    window.addEventListener('pointercancel', handleUp);
    return () => {
      window.removeEventListener('pointermove', handleMove);
      window.removeEventListener('pointerup', handleUp);
      window.removeEventListener('pointercancel', handleUp);
    };
  }, [draggingHandle]);

  const acquiredSlice = (position: number) =>
    getEffectiveInstanceIndex(
      getSliceIndex(playbackInstanceCount, position, referenceOffset),
      playbackInstanceCount,
      reverseSliceOrder,
    ) + 1;
  const currentSlice = playbackInstanceCount > 0 ? acquiredSlice(progress) : null;
  const minimumSlice = Math.min(acquiredSlice(0), acquiredSlice(1));
  const maximumSlice = Math.max(acquiredSlice(0), acquiredSlice(1));

  return (
    <div className="flex min-h-14 flex-wrap items-center gap-x-3 gap-y-1 border-t border-[var(--border-color)] bg-[var(--bg-secondary)] px-4 py-2 sm:flex-nowrap sm:gap-5">
      <div className="flex shrink-0 items-center gap-1">
        <button
          type="button"
          aria-label={isLooping && !interactionBlocked ? 'Pause slice playback' : 'Play slices'}
          aria-pressed={isLooping && !interactionBlocked}
          disabled={interactionBlocked || currentSlice === null || minimumSlice === maximumSlice}
          className={`inline-flex min-h-9 min-w-9 items-center justify-center rounded-[4px] border disabled:cursor-not-allowed disabled:opacity-50 ${isLooping && !interactionBlocked ? 'border-[var(--signal-metal)] bg-[var(--bg-tertiary)] text-[var(--signal-metal)]' : 'border-[var(--border-color)] text-[var(--text-secondary)] hover:text-[var(--text-primary)]'}`}
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
        <div className="flex items-center text-xs text-[var(--text-secondary)]">
          {[1, 2, 4].map((s) => (
            <button
              key={s}
              type="button"
              aria-label={`Playback speed ${s} times`}
              aria-pressed={loopSpeed === s}
              disabled={interactionBlocked || currentSlice === null}
              className={`min-h-9 min-w-8 rounded-[3px] px-1 font-[family-name:var(--font-mono)] text-xs disabled:cursor-not-allowed disabled:opacity-50 ${loopSpeed === s ? 'text-[var(--signal-metal)]' : 'text-[var(--text-secondary)] hover:text-[var(--text-primary)]'}`}
              onClick={() => setLoopSpeed(s as 1 | 2 | 4)}
            >
              {s}x
            </button>
          ))}
        </div>
      </div>

      <div className="slice-number-control min-w-0 max-w-full flex-wrap whitespace-nowrap font-[family-name:var(--font-mono)] text-xs tabular-nums text-[var(--text-secondary)]">
        {reference && (
          <span
            className="basis-full max-w-full truncate text-[10px] text-[var(--text-tertiary)]"
            title={`Acquired slice numbers for ${reference.label}${reverseSliceOrder ? ', reversed display order' : ''}`}
          >
            Reference: {reference.label}
          </span>
        )}
        {currentSlice === null ? (
          'No slices'
        ) : (
          <SliceNumberField
            key={selectedSeqId}
            value={currentSlice}
            count={playbackInstanceCount}
            minimum={minimumSlice}
            maximum={maximumSlice}
            disabled={interactionBlocked}
            onStartEditing={() => setIsLooping(false)}
            onSelect={(slice) =>
              setProgress(
                getProgressFromSlice(
                  getEffectiveInstanceIndex(slice - 1, playbackInstanceCount, reverseSliceOrder),
                  playbackInstanceCount,
                  referenceOffset,
                ),
              )
            }
          />
        )}
      </div>

      <div
        className="relative order-3 h-11 min-w-12 basis-full sm:order-none sm:h-9 sm:flex-1 sm:basis-auto"
        ref={trackRef}
      >
        <div className="absolute top-1/2 h-px w-full -translate-y-1/2 bg-[var(--border-color)]" aria-hidden />
        <div
          className="absolute top-1/2 h-px -translate-y-1/2 bg-[var(--signal-metal)] opacity-70"
          style={{
            left: `${loopStart * 100}%`,
            width: `${Math.max(0, loopEnd - loopStart) * 100}%`,
          }}
          aria-hidden
        />

        <input
          type="range"
          min={0}
          max={CONTROL_LIMITS.SLICE_NAV.MAX_RANGE}
          step={1}
          disabled={interactionBlocked || currentSlice === null}
          value={Math.round(progress * CONTROL_LIMITS.SLICE_NAV.MAX_RANGE)}
          onChange={(e) => setProgress(parseInt(e.target.value, 10) / CONTROL_LIMITS.SLICE_NAV.MAX_RANGE)}
          className="slice-position-input absolute inset-0 h-9 w-full cursor-pointer opacity-0"
          aria-label="Slice position"
          aria-valuetext={
            currentSlice === null ? 'No slices available' : `Slice ${currentSlice} of ${playbackInstanceCount}`
          }
        />

        {currentSlice !== null ? (
          <div
            data-registration-datum="slice-position"
            className="slice-position-thumb pointer-events-none absolute top-1/2 h-5 w-[3px] -translate-y-1/2 rounded-[1px] bg-[var(--signal-metal)]"
            style={{ left: `calc(${clamp01(progress) * 100}% - 1.5px)` }}
            aria-hidden
          />
        ) : null}

        {currentSlice !== null ? (
          <LoopRangeHandles
            loopStart={loopStart}
            loopEnd={loopEnd}
            playbackInstanceCount={playbackInstanceCount}
            interactionBlocked={interactionBlocked}
            draggingPointerIdRef={draggingPointerIdRef}
            setDraggingHandle={setDraggingHandle}
            updateLoop={updateLoop}
          />
        ) : null}
      </div>
    </div>
  );
}
