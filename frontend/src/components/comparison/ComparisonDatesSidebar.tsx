import { Check, X } from 'lucide-react';
import { useState } from 'react';
import { formatDate } from '../../utils/format';
import type { SeriesRef } from '../../types/api';
import type { LegacyPanelSettings } from '../../utils/localApi';

type ComparisonDatesSidebarProps = {
  open: boolean;
  onToggleOpen: () => void;

  sortedDates: string[];
  enabledDates: Set<string>;
  datesWithDataForSequence: Set<string>;

  onSelectAllDates: () => void;
  onSelectNoDates: () => void;
  onToggleDate: (date: string) => void;
  acquisitions?: {
    candidates: Record<string, SeriesRef[]>;
    selected: Record<string, SeriesRef>;
    onSelect: (date: string, seriesUid: string) => Promise<void>;
    legacy: LegacyPanelSettings[];
    onAssignLegacy: (id: string, date: string) => Promise<void>;
  };
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
  acquisitions,
}: ComparisonDatesSidebarProps) {
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const choose = async (date: string, uid: string) => {
    if (!acquisitions || pending) return;
    setPending(date);
    setError(null);
    try {
      await acquisitions.onSelect(date, uid);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'The acquisition could not be selected. Try again.');
    } finally {
      setPending(null);
    }
  };
  return (
    <aside
      id="comparison-dates-panel"
      aria-label="Examination dates"
      data-open={open}
      data-side="right"
      inert={!open}
      className={`comparison-sidebar shrink-0 overflow-hidden border-l border-[var(--border-color)] bg-[var(--bg-secondary)] ${
        open ? 'w-48' : 'w-0'
      }`}
    >
      <div className="comparison-sidebar-content h-full w-48 overflow-y-auto px-4 py-6">
        <div className="comparison-sidebar-heading">
          <h2>Examinations</h2>
          <button
            type="button"
            className="instrument-icon-button"
            aria-label="Close examination dates"
            onClick={onToggleOpen}
          >
            <X className="h-4 w-4" aria-hidden="true" />
          </button>
        </div>
        <div className="mb-4 flex items-center justify-between gap-2">
          <span className="text-xs text-[var(--text-secondary)]">{enabledDates.size} selected</span>
          <div className="flex items-center gap-1">
            <button
              type="button"
              onClick={onSelectAllDates}
              className="min-h-8 rounded-[3px] px-1.5 text-xs text-[var(--text-secondary)] transition-colors hover:text-[var(--text-primary)]"
              title="Select all dates"
            >
              All
            </button>
            <button
              type="button"
              onClick={onSelectNoDates}
              className="min-h-8 rounded-[3px] px-1.5 text-xs text-[var(--text-secondary)] transition-colors hover:text-[var(--text-primary)]"
              title="Deselect all dates"
            >
              None
            </button>
          </div>
        </div>
        <div className="space-y-1 border-l border-[var(--border-color)]">
          {error && (
            <p role="alert" className="px-2 text-xs">
              {error}
            </p>
          )}
          {sortedDates.map((d) => {
            const enabled = enabledDates.has(d);
            const hasData = datesWithDataForSequence.has(d);

            return (
              <div key={d}>
                <button
                  type="button"
                  onClick={() => onToggleDate(d)}
                  disabled={!hasData && !enabled}
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
                    {enabled && <Check className="h-3 w-3" />}
                  </span>
                  <span className="examination-row-date">{formatDate(d)}</span>
                </button>
                {(acquisitions?.candidates[d]?.length ?? 0) > 1 && (
                  <label className="block px-2 pb-3 text-xs text-[var(--text-secondary)]">
                    Acquisition
                    <select
                      aria-label={`Acquisition for ${formatDate(d)}`}
                      className="mt-1 block w-full min-h-9 rounded border border-[var(--border-color)] bg-[var(--bg-secondary)] p-1"
                      value={acquisitions?.selected[d]?.series_uid ?? ''}
                      disabled={pending !== null}
                      onChange={(event) => void choose(d, event.target.value)}
                    >
                      {acquisitions?.candidates[d]?.map((source) => (
                        <option key={source.series_uid} value={source.series_uid}>
                          {source.series_number ? `#${source.series_number} ` : ''}
                          {source.series_description || 'Unnamed series'} · {source.instance_count} images
                        </option>
                      ))}
                    </select>
                  </label>
                )}
                {acquisitions?.legacy
                  .filter((entry) => entry.eligibleDates.includes(d))
                  .map((entry) => (
                    <div className="px-2 pb-3 text-xs text-[var(--text-secondary)]" key={entry.id}>
                      <p>Unassigned settings from {formatDate(entry.origin.dateIso)}. The original will be kept.</p>
                      <button
                        type="button"
                        className="instrument-notice-button min-h-9"
                        disabled={pending !== null}
                        onClick={() => void acquisitions.onAssignLegacy(entry.id, d)}
                      >
                        Use saved settings for this acquisition
                      </button>
                    </div>
                  ))}
              </div>
            );
          })}
        </div>
      </div>
    </aside>
  );
}
