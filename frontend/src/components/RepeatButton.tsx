import { useRef, useCallback, useEffect } from 'react';

/** Button that repeats action while held, with acceleration */
export interface RepeatButtonProps {
  onAction: () => void;
  className?: string;
  title?: string;
  children: React.ReactNode;
  onClick?: (e: React.MouseEvent) => void;
}

export function RepeatButton({ onAction, className, title, children, onClick }: RepeatButtonProps) {
  const repeatTimeoutRef = useRef<number | null>(null);
  const initialDelayTimeoutRef = useRef<number | null>(null);
  const countRef = useRef(0);
  const onActionRef = useRef(onAction);

  // Keep ref up to date with latest onAction
  useEffect(() => {
    onActionRef.current = onAction;
  }, [onAction]);

  const stop = useCallback(() => {
    if (repeatTimeoutRef.current) {
      clearTimeout(repeatTimeoutRef.current);
      repeatTimeoutRef.current = null;
    }
    if (initialDelayTimeoutRef.current) {
      clearTimeout(initialDelayTimeoutRef.current);
      initialDelayTimeoutRef.current = null;
    }
    countRef.current = 0;
  }, []);

  const start = useCallback(() => {
    // Fire immediately on press
    onActionRef.current();
    countRef.current = 1;

    // Start repeating after initial delay
    initialDelayTimeoutRef.current = window.setTimeout(() => {
      // Start with slow interval, speed up over time
      const tick = () => {
        onActionRef.current();
        countRef.current++;

        // Calculate next interval based on count (accelerate)
        // Starts at 150ms, goes down to 30ms
        const nextInterval = Math.max(30, 150 - countRef.current * 10);

        if (repeatTimeoutRef.current) clearTimeout(repeatTimeoutRef.current);
        repeatTimeoutRef.current = window.setTimeout(tick, nextInterval);
      };
      tick();
    }, 300); // Initial delay before repeat starts
  }, []);
  
  useEffect(() => {
    return stop;
  }, [stop]);
  
  return (
    <button
      className={className}
      title={title}
      onMouseDown={(e) => {
        e.preventDefault();
        start();
      }}
      onMouseUp={stop}
      onMouseLeave={stop}
      onClick={onClick}
    >
      {children}
    </button>
  );
}
