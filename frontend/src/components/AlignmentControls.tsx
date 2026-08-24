import { Crosshair, Link2, X, Loader2 } from 'lucide-react';
import type { AlignmentProgress } from '../types/api';
import { formatDate } from '../utils/format';

interface AlignmentControlsProps {
  // Reference state
  hasReference: boolean;
  isReferenceDate: boolean;
  isCapturing: boolean;
  onSetReference: () => void;
  onClearReference: () => void;

  // Alignment state
  isAligning: boolean;
  progress: AlignmentProgress | null;
  onAutoAlign: () => void;
  onAbortAlign: () => void;

  // UI state
  disabled?: boolean;
}

export function AlignmentControls({
  hasReference,
  isReferenceDate,
  isCapturing,
  onSetReference,
  onClearReference,
  isAligning,
  progress,
  onAutoAlign,
  onAbortAlign,
  disabled = false,
}: AlignmentControlsProps) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <button
        type="button"
        onClick={isReferenceDate ? onClearReference : onSetReference}
        disabled={disabled || isCapturing || isAligning}
        aria-pressed={isReferenceDate}
        className={`flex min-h-9 items-center gap-1.5 rounded-[4px] border px-2.5 text-xs font-medium transition-colors ${
          isReferenceDate
            ? 'border-[var(--signal-metal)] bg-[var(--bg-tertiary)] text-[var(--text-primary)]'
            : disabled || isCapturing || isAligning
              ? 'border-[var(--border-color)] text-[var(--text-tertiary)]'
              : 'border-[var(--border-color)] text-[var(--text-secondary)] hover:bg-[var(--bg-tertiary)] hover:text-[var(--text-primary)]'
        }`}
        title={isReferenceDate ? 'Clear alignment reference' : 'Set current view as alignment reference'}
      >
        {isCapturing ? <Loader2 className="w-3 h-3 animate-spin" /> : <Crosshair className="w-3 h-3" />}
        {isReferenceDate ? 'Reference' : 'Set reference'}
      </button>

      <button
        type="button"
        onClick={isAligning ? onAbortAlign : onAutoAlign}
        disabled={disabled || !hasReference || isCapturing}
        className={`flex min-h-9 items-center gap-1.5 rounded-[4px] border px-2.5 text-xs font-medium transition-colors ${
          isAligning
            ? 'border-[var(--warning)] text-[var(--warning)] hover:bg-[var(--bg-tertiary)]'
            : !hasReference || disabled || isCapturing
              ? 'border-[var(--border-color)] text-[var(--text-tertiary)]'
              : 'border-[var(--border-color)] text-[var(--text-secondary)] hover:bg-[var(--bg-tertiary)] hover:text-[var(--text-primary)]'
        }`}
        title={
          isAligning
            ? 'Cancel alignment'
            : !hasReference
              ? 'Set a reference first'
              : 'Auto-align all dates to reference'
        }
      >
        {isAligning ? (
          <>
            <X className="w-3 h-3" />
            Cancel
          </>
        ) : (
          <>
            <Link2 className="w-3 h-3" />
            Align All
          </>
        )}
      </button>

      {isAligning && progress && (
        <div role="status" aria-live="polite" className="flex items-center gap-2 text-xs text-[var(--text-secondary)]">
          <Loader2 className="h-3.5 w-3.5 animate-spin text-[var(--signal-metal)]" />
          <span>
            {progress.currentDate
              ? `${formatDate(progress.currentDate)} (${progress.dateIndex + 1}/${progress.totalDates})`
              : 'Starting...'}
          </span>
          {progress.slicesChecked > 0 && (
            <span className="text-[var(--text-tertiary)]">
              {progress.slicesChecked} slices · Score {progress.bestMiSoFar.toFixed(3)}
            </span>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * Reference indicator badge for date buttons.
 */
export function ReferenceIndicator({ className = '' }: { className?: string }) {
  return (
    <span
      aria-label="Alignment reference"
      className={`inline-flex h-5 min-w-5 items-center justify-center rounded-[2px] border border-[var(--signal-metal)] px-1 font-[family-name:var(--font-mono)] text-xs text-[var(--signal-metal)] ${className}`}
      title="Alignment reference"
    >
      R
    </span>
  );
}
