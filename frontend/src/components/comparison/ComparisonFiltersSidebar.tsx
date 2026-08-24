import { ChevronLeft, ChevronRight } from 'lucide-react';
import type { SequenceCombo } from '../../types/api';
import { formatSequenceLabel } from '../../utils/clinicalData';
import type { OutputGridMode } from '../../utils/outputPlaneGrid';

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

  alignmentOutputMode: OutputGridMode;
  onAlignmentOutputModeChange: (mode: OutputGridMode) => void;
  alignmentInProgress?: boolean;
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
  alignmentOutputMode,
  onAlignmentOutputModeChange,
  alignmentInProgress = false,
}: ComparisonFiltersSidebarProps) {
  return (
    <>
      <div
        id="comparison-filters-panel"
        role="complementary"
        aria-label="Scan filters"
        data-open={open}
        data-side="left"
        inert={!open}
        className={`comparison-sidebar shrink-0 overflow-hidden border-r border-[var(--border-color)] bg-[var(--bg-secondary)] ${
          open ? 'w-52' : 'w-0'
        }`}
      >
        <div className="comparison-sidebar-content h-full w-52 space-y-8 overflow-y-auto px-4 py-6">
          <div>
            <div className="mb-3 text-xs font-medium uppercase tracking-[0.12em] text-[var(--text-tertiary)]">
              Imaging plane
            </div>
            <div className="space-y-1 border-l border-[var(--border-color)]">
              {availablePlanes.map((p) => (
                <button
                  key={p}
                  type="button"
                  aria-pressed={selectedPlane === p}
                  onClick={() => onSelectPlane(p)}
                  className={`min-h-10 w-full truncate border-l-2 px-3 text-left text-[13px] transition-colors ${
                    selectedPlane === p
                      ? 'border-[var(--signal-metal)] bg-[var(--bg-tertiary)] text-[var(--text-primary)]'
                      : 'border-transparent text-[var(--text-secondary)] hover:bg-[var(--bg-tertiary)] hover:text-[var(--text-primary)]'
                  }`}
                >
                  {p}
                </button>
              ))}
            </div>
          </div>

          <div>
            <div className="mb-3 text-xs font-medium uppercase tracking-[0.12em] text-[var(--text-tertiary)]">
              Sequence
            </div>
            <div className="space-y-1 border-l border-[var(--border-color)]">
              {sequencesForPlane.map((seq) => {
                const hasData = sequencesWithDataForDates.has(seq.id);
                const isSelected = selectedSeqId === seq.id;

                return (
                  <button
                    key={seq.id}
                    type="button"
                    aria-pressed={isSelected}
                    onClick={() => onSelectSequence(seq.id)}
                    className={`min-h-10 w-full cursor-pointer truncate border-l-2 px-3 text-left text-[13px] transition-colors ${
                      isSelected
                        ? hasData
                          ? 'border-[var(--signal-metal)] bg-[var(--bg-tertiary)] text-[var(--text-primary)]'
                          : 'border-[var(--signal-metal)] text-[var(--text-secondary)]'
                        : hasData
                          ? 'border-transparent text-[var(--text-secondary)] hover:bg-[var(--bg-tertiary)] hover:text-[var(--text-primary)]'
                          : 'border-transparent text-[var(--text-tertiary)]'
                    }`}
                  >
                    {formatSequenceLabel(seq) === 'Unknown' ? 'Unclassified' : formatSequenceLabel(seq)}
                  </button>
                );
              })}
            </div>
          </div>

          <div className="border-t border-[var(--border-color)] pt-6">
            <label
              htmlFor="alignment-output-resolution"
              className="mb-3 block text-xs font-medium uppercase tracking-[0.12em] text-[var(--text-tertiary)]"
            >
              Aligned output
            </label>
            <select
              id="alignment-output-resolution"
              aria-label="Alignment output resolution"
              value={alignmentOutputMode}
              disabled={alignmentInProgress}
              onChange={(event) => onAlignmentOutputModeChange(event.target.value as OutputGridMode)}
              className="min-h-10 w-full rounded-[4px] border border-[var(--border-color)] bg-[var(--bg-primary)] px-2 py-2 text-xs text-[var(--text-primary)] disabled:cursor-not-allowed disabled:opacity-60"
            >
              <option value="native">Reference resolution</option>
              <option value="fixed-256">256 × 256 pixels</option>
              <option value="fixed-512">512 × 512 pixels</option>
              <option value="fixed-1024">1024 × 1024 pixels</option>
              <option value="longest-edge">Preserve aspect ratio · 512 px</option>
              <option value="isotropic">Equal physical pixel spacing</option>
            </select>
            {alignmentOutputMode !== 'native' ? (
              <p className="mt-3 text-xs leading-relaxed text-[var(--text-secondary)]">
                Interpolated display pixels do not add acquired MRI detail.
              </p>
            ) : null}
          </div>
        </div>
      </div>

      <button
        type="button"
        onClick={onToggleOpen}
        aria-label={open ? 'Hide scan filters' : 'Show scan filters'}
        aria-expanded={open}
        aria-controls="comparison-filters-panel"
        className="absolute left-2 top-1/2 z-40 inline-flex min-h-9 min-w-9 -translate-y-1/2 items-center justify-center rounded-[4px] border border-[var(--border-color)] bg-[var(--bg-secondary)] text-[var(--text-secondary)] transition-colors hover:text-[var(--text-primary)]"
        title={open ? 'Hide filters' : 'Show filters'}
      >
        {open ? <ChevronLeft className="w-4 h-4" /> : <ChevronRight className="w-4 h-4" />}
      </button>
    </>
  );
}
