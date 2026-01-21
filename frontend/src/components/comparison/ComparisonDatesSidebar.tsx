import { CalendarDays, ChevronLeft, ChevronRight } from 'lucide-react';
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
}: ComparisonDatesSidebarProps) {
  return (
    <>
      {/* Right sidebar toggle (compact) */}
      <button
        onClick={onToggleOpen}
        className="absolute right-2 top-1/2 -translate-y-1/2 z-20 p-1 rounded-full bg-[var(--bg-tertiary)] border border-[var(--border-color)] text-[var(--text-secondary)] hover:bg-[var(--border-color)]"
        title={open ? 'Hide dates' : 'Show dates'}
      >
        {open ? <ChevronRight className="w-4 h-4" /> : <ChevronLeft className="w-4 h-4" />}
      </button>

      {/* Right sidebar - Dates */}
      <div
        className={`flex-shrink-0 bg-[var(--bg-secondary)] border-l border-[var(--border-color)] transition-all duration-200 ease-in-out overflow-hidden ${
          open ? 'w-56' : 'w-0'
        }`}
      >
        <div className="w-56 h-full overflow-y-auto p-4">
          <div className="text-xs uppercase font-semibold text-[var(--text-secondary)] mb-3 flex items-center justify-between">
            <div className="flex items-center gap-2">
              <CalendarDays className="w-4 h-4" />Dates
            </div>
            <div className="flex gap-1">
              <button
                onClick={onSelectAllDates}
                className="px-1.5 py-0.5 text-[10px] rounded bg-[var(--bg-tertiary)] hover:bg-[var(--border-color)] text-[var(--text-secondary)]"
                title="Select all dates"
              >
                All
              </button>
              <button
                onClick={onSelectNoDates}
                className="px-1.5 py-0.5 text-[10px] rounded bg-[var(--bg-tertiary)] hover:bg-[var(--border-color)] text-[var(--text-secondary)]"
                title="Deselect all dates"
              >
                None
              </button>
            </div>
          </div>
          <div className="space-y-1">
            {sortedDates.map((d) => {
              const enabled = enabledDates.has(d);
              const hasData = datesWithDataForSequence.has(d);

              return (
                <button
                  key={d}
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => onToggleDate(d)}
                  className={`w-full text-left px-3 py-2 rounded-lg text-sm transition-colors flex items-center gap-2 focus:outline-none ${
                    enabled
                      ? hasData
                        ? 'bg-[var(--accent)] text-white'
                        : 'bg-[var(--accent)] text-white opacity-50'
                      : hasData
                      ? 'hover:bg-[var(--bg-tertiary)] text-[var(--text-primary)]'
                      : 'text-[var(--text-tertiary)] opacity-50'
                  }`}
                  title={hasData ? undefined : 'No data for selected sequence'}
                >
                  <span
                    className={`w-4 h-4 rounded border flex items-center justify-center text-xs ${
                      enabled
                        ? 'bg-white text-[var(--accent)] border-white'
                        : 'border-[var(--border-color)]'
                    }`}
                  >
                    {enabled && '✓'}
                  </span>
                  {formatDate(d)}
                </button>
              );
            })}
          </div>
        </div>
      </div>
    </>
  );
}
