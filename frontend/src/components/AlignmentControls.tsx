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
    <div className="flex items-center gap-2">
      {/* Set Reference Button */}
      <button
        type="button"
        onClick={isReferenceDate ? onClearReference : onSetReference}
        disabled={disabled || isCapturing || isAligning}
        className={`px-2 py-1 rounded-md text-[10px] font-medium flex items-center gap-1 transition-colors ${
          isReferenceDate
            ? 'bg-[var(--accent)] text-white'
            : disabled || isCapturing || isAligning
            ? 'bg-[var(--bg-tertiary)] text-[var(--text-tertiary)]'
            : 'bg-[var(--bg-tertiary)] hover:bg-[var(--border-color)] text-[var(--text-secondary)] hover:text-[var(--text-primary)]'
        }`}
        title={
          isReferenceDate
            ? 'Clear alignment reference'
            : 'Set current view as alignment reference'
        }
      >
        {isCapturing ? (
          <Loader2 className="w-3 h-3 animate-spin" />
        ) : (
          <Crosshair className="w-3 h-3" />
        )}
        {isReferenceDate ? 'Reference ✓' : 'Set Ref'}
      </button>

      {/* Auto-Align Button */}
      <button
        type="button"
        onClick={isAligning ? onAbortAlign : onAutoAlign}
        disabled={disabled || !hasReference || isCapturing}
        className={`px-2 py-1 rounded-md text-[10px] font-medium flex items-center gap-1 transition-colors ${
          isAligning
            ? 'bg-amber-600 text-white hover:bg-amber-700'
            : !hasReference || disabled || isCapturing
            ? 'bg-[var(--bg-tertiary)] text-[var(--text-tertiary)]'
            : 'bg-[var(--bg-tertiary)] hover:bg-[var(--border-color)] text-[var(--text-secondary)] hover:text-[var(--text-primary)]'
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

      {/* Progress indicator */}
      {isAligning && progress && (
        <div className="flex items-center gap-2 text-[10px] text-[var(--text-secondary)]">
          <Loader2 className="w-3 h-3 animate-spin text-[var(--accent)]" />
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
      className={`inline-flex items-center justify-center w-4 h-4 rounded-full bg-[var(--accent)] text-white text-[8px] font-bold ${className}`}
      title="Alignment reference"
    >
      R
    </span>
  );
}
