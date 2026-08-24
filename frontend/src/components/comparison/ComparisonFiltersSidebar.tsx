import { ChevronLeft, ChevronRight, Layers } from 'lucide-react';
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
        className={`comparison-sidebar flex-shrink-0 bg-[var(--bg-secondary)] border-r border-[var(--border-color)] transition-all duration-200 ease-in-out overflow-hidden ${
          open ? 'w-64' : 'w-0'
        }`}
      >
        <div className="comparison-sidebar-content w-64 h-full overflow-y-auto p-4 space-y-6">
          {/* Plane selector */}
          <div>
            <div className="text-xs uppercase font-semibold text-[var(--text-secondary)] mb-3 flex items-center gap-2">
              <Layers className="w-4 h-4" />
              Plane
            </div>
            <div className="grid grid-cols-2 gap-1">
              {availablePlanes.map((p) => (
                <button
                  key={p}
                  type="button"
                  aria-pressed={selectedPlane === p}
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

                return (
                  <button
                    key={seq.id}
                    type="button"
                    aria-pressed={isSelected}
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
                    {formatSequenceLabel(seq) === 'Unknown' ? 'Unclassified' : formatSequenceLabel(seq)}
                  </button>
                );
              })}
            </div>
          </div>

          <div className="border-t border-[var(--border-color)] pt-5">
            <label
              htmlFor="alignment-output-resolution"
              className="mb-2 block text-xs uppercase font-semibold text-[var(--text-secondary)]"
            >
              Aligned output
            </label>
            <select
              id="alignment-output-resolution"
              aria-label="Alignment output resolution"
              value={alignmentOutputMode}
              disabled={alignmentInProgress}
              onChange={(event) => onAlignmentOutputModeChange(event.target.value as OutputGridMode)}
              className="w-full rounded-lg border border-[var(--border-color)] bg-[var(--bg-primary)] px-2 py-2 text-xs text-[var(--text-primary)] disabled:cursor-not-allowed disabled:opacity-60"
            >
              <option value="native">Reference resolution</option>
              <option value="fixed-256">256 × 256 pixels</option>
              <option value="fixed-512">512 × 512 pixels</option>
              <option value="fixed-1024">1024 × 1024 pixels</option>
              <option value="longest-edge">Preserve aspect ratio · 512 px</option>
              <option value="isotropic">Equal physical pixel spacing</option>
            </select>
            {alignmentOutputMode !== 'native' ? (
              <p className="mt-2 text-[11px] leading-relaxed text-[var(--text-tertiary)]">
                Interpolated display pixels do not add acquired MRI detail.
              </p>
            ) : null}
          </div>
        </div>
      </div>

      {/* Left sidebar toggle (compact) */}
      <button
        type="button"
        onClick={onToggleOpen}
        aria-label={open ? 'Hide scan filters' : 'Show scan filters'}
        aria-expanded={open}
        aria-controls="comparison-filters-panel"
        className="absolute left-2 top-1/2 -translate-y-1/2 z-40 min-h-9 min-w-9 inline-flex items-center justify-center rounded-full bg-[var(--bg-tertiary)] border border-[var(--border-color)] text-[var(--text-secondary)] hover:bg-[var(--border-color)]"
        title={open ? 'Hide filters' : 'Show filters'}
      >
        {open ? <ChevronLeft className="w-4 h-4" /> : <ChevronRight className="w-4 h-4" />}
      </button>
    </>
  );
}
