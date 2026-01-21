import { ChevronLeft, ChevronRight, Layers } from 'lucide-react';
import type { SequenceCombo } from '../../types/api';
import { getSequenceTooltip, formatSequenceLabel } from '../../utils/clinicalData';
import { TooltipTrigger } from '../TooltipTrigger';

type ComparisonFiltersSidebarProps = {
  open: boolean;
  onToggleOpen: () => void;

  availablePlanes: string[];
  selectedPlane: string | null;
  onSelectPlane: (plane: string) => void;

  sequencesForPlane: SequenceCombo[];
  sequencesWithDataForDates: Set<string>;
  selectedSeqId: string | null;
  onSelectSequence: (seqId: string) => void;
};

export function ComparisonFiltersSidebar({
  open,
  onToggleOpen,
  availablePlanes,
  selectedPlane,
  onSelectPlane,
  sequencesForPlane,
  sequencesWithDataForDates,
  selectedSeqId,
  onSelectSequence,
}: ComparisonFiltersSidebarProps) {
  return (
    <>
      <div
        className={`flex-shrink-0 bg-[var(--bg-secondary)] border-r border-[var(--border-color)] transition-all duration-200 ease-in-out overflow-hidden ${
          open ? 'w-64' : 'w-0'
        }`}
      >
        <div className="w-64 h-full overflow-y-auto p-4 space-y-6">
          {/* Plane selector */}
          <div>
            <div className="text-xs uppercase font-semibold text-[var(--text-secondary)] mb-3 flex items-center gap-2">
              <Layers className="w-4 h-4" />Plane
            </div>
            <div className="grid grid-cols-2 gap-1">
              {availablePlanes.map((p) => (
                <button
                  key={p}
                  onClick={() => onSelectPlane(p)}
                  className={`text-left px-2 py-1.5 rounded-lg text-sm transition-colors truncate ${
                    selectedPlane === p
                      ? 'bg-[var(--accent)] text-white'
                      : 'hover:bg-[var(--bg-tertiary)] text-[var(--text-primary)]'
                  }`}
                >
                  {p}
                </button>
              ))}
            </div>
          </div>

          {/* Sequence selector */}
          <div>
            <div className="text-xs uppercase font-semibold text-[var(--text-secondary)] mb-3">Sequence</div>
            <div className="grid grid-cols-2 gap-1">
              {sequencesForPlane.map((seq) => {
                const hasData = sequencesWithDataForDates.has(seq.id);
                const isSelected = selectedSeqId === seq.id;
                const tooltipText =
                  getSequenceTooltip(seq.weight, seq.sequence) +
                  (hasData ? '' : '\n\n⚠️ No data for selected dates');

                return (
                  <TooltipTrigger
                    key={seq.id}
                    content={tooltipText}
                    onClick={() => onSelectSequence(seq.id)}
                    className={`text-left px-2 py-1.5 rounded-lg text-sm transition-colors truncate cursor-pointer ${
                      isSelected
                        ? hasData
                          ? 'bg-[var(--accent)] text-white'
                          : 'bg-[var(--accent)] text-white opacity-50'
                        : hasData
                        ? 'hover:bg-[var(--bg-tertiary)] text-[var(--text-primary)]'
                        : 'text-[var(--text-tertiary)] opacity-50'
                    }`}
                  >
                    {formatSequenceLabel(seq)}
                  </TooltipTrigger>
                );
              })}
            </div>
          </div>
        </div>
      </div>

      {/* Left sidebar toggle (compact) */}
      <button
        onClick={onToggleOpen}
        className="absolute left-2 top-1/2 -translate-y-1/2 z-20 p-1 rounded-full bg-[var(--bg-tertiary)] border border-[var(--border-color)] text-[var(--text-secondary)] hover:bg-[var(--border-color)]"
        title={open ? 'Hide filters' : 'Show filters'}
      >
        {open ? <ChevronLeft className="w-4 h-4" /> : <ChevronRight className="w-4 h-4" />}
      </button>
    </>
  );
}
