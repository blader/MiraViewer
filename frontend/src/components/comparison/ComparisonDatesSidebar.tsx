import { ChevronLeft, ChevronRight } from 'lucide-react';
import { formatDate } from '../../utils/format';

type ComparisonDatesSidebarProps = {
  open: boolean;
  onToggleOpen: () => void;

  sortedDates: string[];
  enabledDates: Set<string>;
  datesWithDataForSequence: Set<string>;

  onSelectAllDates: () => void;
  onSelectNoDates: () => void;
  onToggleDate: (date: string) => void;
  alignmentInProgress?: boolean;
};

export function ComparisonDatesSidebar({
  open,
  onToggleOpen,
  sortedDates,
  enabledDates,
  datesWithDataForSequence,
  onSelectAllDates,
  onSelectNoDates,
  onToggleDate,
  alignmentInProgress = false,
}: ComparisonDatesSidebarProps) {
  return (
    <>
      <button
        type="button"
        disabled={alignmentInProgress}
        onClick={onToggleOpen}
        aria-label={open ? 'Hide examination dates' : 'Show examination dates'}
        aria-expanded={open}
        aria-controls="comparison-dates-panel"
        className="absolute right-2 top-1/2 z-40 inline-flex min-h-9 min-w-9 -translate-y-1/2 items-center justify-center rounded-[4px] border border-[var(--border-color)] bg-[var(--bg-secondary)] text-[var(--text-secondary)] transition-colors hover:text-[var(--text-primary)]"
        title={open ? 'Hide dates' : 'Show dates'}
      >
        {open ? <ChevronRight className="w-4 h-4" /> : <ChevronLeft className="w-4 h-4" />}
      </button>

      <div
        id="comparison-dates-panel"
        role="complementary"
        aria-label="Examination dates"
        data-open={open}
        data-side="right"
        inert={!open}
        className={`comparison-sidebar shrink-0 overflow-hidden border-l border-[var(--border-color)] bg-[var(--bg-secondary)] ${
          open ? 'w-48' : 'w-0'
        }`}
      >
        <div className="comparison-sidebar-content h-full w-48 overflow-y-auto px-4 py-6">
          <div className="mb-4 flex items-center justify-between gap-2">
            <span className="text-xs font-medium uppercase tracking-[0.12em] text-[var(--text-tertiary)]">
              Examinations
            </span>
            <div className="flex items-center gap-1">
              <button
                type="button"
                disabled={alignmentInProgress}
                onClick={onSelectAllDates}
                className="min-h-8 rounded-[3px] px-1.5 text-xs text-[var(--text-secondary)] transition-colors hover:text-[var(--text-primary)]"
                title="Select all dates"
              >
                All
              </button>
              <button
                type="button"
                disabled={alignmentInProgress}
                onClick={onSelectNoDates}
                className="min-h-8 rounded-[3px] px-1.5 text-xs text-[var(--text-secondary)] transition-colors hover:text-[var(--text-primary)]"
                title="Deselect all dates"
              >
                None
              </button>
            </div>
          </div>
          <div className="space-y-1 border-l border-[var(--border-color)]">
            {sortedDates.map((d) => {
              const enabled = enabledDates.has(d);
              const hasData = datesWithDataForSequence.has(d);

              return (
                <button
                  key={d}
                  type="button"
                  onClick={() => onToggleDate(d)}
                  disabled={alignmentInProgress || (!hasData && !enabled)}
                  aria-pressed={enabled}
                  data-study-state={enabled ? 'selected' : 'available'}
                  className={`relative flex min-h-11 w-full items-center gap-2 border-l-2 px-3 text-left text-[13px] transition-colors ${
                    enabled
                      ? hasData
                        ? 'border-[var(--signal-metal)] bg-[var(--bg-tertiary)] text-[var(--text-primary)]'
                        : 'border-[var(--signal-metal)] text-[var(--text-secondary)]'
                      : hasData
                        ? 'border-transparent text-[var(--text-secondary)] hover:bg-[var(--bg-tertiary)] hover:text-[var(--text-primary)]'
                        : 'border-transparent text-[var(--text-tertiary)]'
                  }`}
                  title={hasData ? undefined : 'No data for selected sequence'}
                >
                  <span
                    aria-hidden="true"
                    className={`flex h-4 w-4 shrink-0 items-center justify-center rounded-[2px] border text-xs ${
                      enabled
                        ? 'border-[var(--signal-metal)] text-[var(--signal-metal)]'
                        : 'border-[var(--border-color)]'
                    }`}
                  >
                    {enabled && '✓'}
                  </span>
                  <span className="font-[family-name:var(--font-mono)] tabular-nums">{formatDate(d)}</span>
                </button>
              );
            })}
          </div>
        </div>
      </div>
    </>
  );
}
