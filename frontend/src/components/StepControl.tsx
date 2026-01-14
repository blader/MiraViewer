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
    ? 'p-0.5 rounded hover:bg-[var(--bg-tertiary)] text-[var(--accent)] opacity-80 hover:opacity-100'
    : 'p-0.5 rounded hover:bg-[var(--bg-tertiary)] text-[var(--text-secondary)]';

  const valueClass = [
    'text-[var(--text-primary)] text-[10px] text-center font-mono',
    valueWidth,
    tabular ? 'tabular-nums' : '',
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <div className="flex items-center gap-0.5" title={title}>
      {label && <span className="text-[var(--text-secondary)] text-[10px]">{label}</span>}
      <RepeatButton onAction={onDecrement} className={chevronClass}>
        <ChevronLeft className="w-3 h-3" />
      </RepeatButton>
      <span className={valueClass}>{value}</span>
      <RepeatButton onAction={onIncrement} className={chevronClass}>
        <ChevronRight className="w-3 h-3" />
      </RepeatButton>
    </div>
  );
}
