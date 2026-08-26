import { ChevronLeft, ChevronRight } from 'lucide-react';
import { RepeatButton } from './RepeatButton';

interface StepControlProps {
  /** Optional label shown before the control (e.g. "B" for brightness). */
  label?: string;
  /** Current display value. */
  value: string;
  /** Width class for the value display (e.g. "w-6", "w-8"). */
  valueWidth?: string;
  /** Callback when decrement is triggered. */
  onDecrement: () => void;
  /** Callback when increment is triggered. */
  onIncrement: () => void;
  /** Tooltip title for the control group. */
  title?: string;
  /** Use accent color for chevrons (e.g. for primary controls). */
  accent?: boolean;
  /** Use tabular-nums for monospace digits. */
  tabular?: boolean;
}

export function StepControl({
  label,
  value,
  valueWidth = 'w-6',
  onDecrement,
  onIncrement,
  title,
  accent = false,
  tabular = false,
}: StepControlProps) {
  const chevronClass = accent
    ? 'inline-flex min-h-7 min-w-7 items-center justify-center rounded-[3px] p-1 text-[var(--signal-metal)] transition-colors hover:bg-[var(--bg-tertiary)]'
    : 'inline-flex min-h-7 min-w-7 items-center justify-center rounded-[3px] p-1 text-[var(--text-secondary)] transition-colors hover:bg-[var(--bg-tertiary)] hover:text-[var(--text-primary)]';

  const valueClass = [
    'text-center font-[family-name:var(--font-mono)] text-xs text-[var(--text-primary)]',
    valueWidth,
    tabular ? 'tabular-nums' : '',
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <div className="flex shrink-0 items-center gap-0.5" title={title}>
      {label && <span className="text-xs text-[var(--text-secondary)]">{label}</span>}
      <RepeatButton
        onAction={onDecrement}
        className={chevronClass}
        aria-label={`Decrease ${title ?? label ?? 'value'}`}
      >
        <ChevronLeft className="w-3 h-3" />
      </RepeatButton>
      <span className={valueClass}>{value}</span>
      <RepeatButton
        onAction={onIncrement}
        className={chevronClass}
        aria-label={`Increase ${title ?? label ?? 'value'}`}
      >
        <ChevronRight className="w-3 h-3" />
      </RepeatButton>
    </div>
  );
}
