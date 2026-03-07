import { useCallback, useState } from 'react';
import type { MouseEvent } from 'react';
import { Loader2 } from 'lucide-react';
import { GridCell } from './GridCell';
import type {
  AlignmentProgress,
  AlignmentReference,
  ExclusionMask,
  PanelSettings,
  SeriesRef,
} from '../../types/api';
import { formatDate } from '../../utils/format';
import { DEFAULT_PANEL_SETTINGS } from '../../utils/constants';

export type GridViewProps = {
  comboId: string;

  columns: { date: string; ref?: SeriesRef }[];
  gridCols: number;
  gridCellSize: number;
  panelSettings: Map<string, PanelSettings>;
  progress: number;
  setProgress: (next: number) => void;
  updatePanelSetting: (date: string, update: Partial<PanelSettings>) => void;
  overlayColumns: { date: string; ref?: SeriesRef }[];
  isAligning: boolean;
  alignmentProgress: AlignmentProgress | null;
  abortAlignment: () => void;
  startAlignAll: (reference: AlignmentReference, exclusion: ExclusionMask) => Promise<void>;
};

export function GridView({
  comboId,
  columns,
  gridCols,
  gridCellSize,
  panelSettings,
  progress,
  setProgress,
  updatePanelSetting,
  overlayColumns,
  isAligning,
  alignmentProgress,
  abortAlignment,
  startAlignAll,
}: GridViewProps) {
  const [hoveredGridCellDate, setHoveredGridCellDate] = useState<string | null>(null);

  const updateHoveredCellFromEvent = useCallback((e: MouseEvent<HTMLDivElement>) => {
    const target = e.target;
    if (!(target instanceof Element)) return;

    const cell = target.closest('[data-grid-cell-date]');
    const next = cell?.getAttribute('data-grid-cell-date') ?? null;
    setHoveredGridCellDate((prev) => (prev === next ? prev : next));
  }, []);

  // We listen to both:
  // - onMouseOver: fires immediately when entering a cell (no movement required)
  // - onMouseMove: keeps hover stable when elements are added/removed under the cursor
  const onMouseMoveGrid = updateHoveredCellFromEvent;
  const onMouseOverGrid = updateHoveredCellFromEvent;

  const onMouseLeaveGrid = useCallback(() => setHoveredGridCellDate(null), []);

  return (
    <div className="flex-1 flex items-center justify-center">
      {isAligning && alignmentProgress && (
        <div className="absolute top-3 left-1/2 -translate-x-1/2 z-20">
          <div className="flex items-center gap-3 px-4 py-3 rounded-xl bg-black/70 border border-white/10 shadow-xl">
            <Loader2 className="w-5 h-5 animate-spin text-[var(--accent)]" />
            <div className="min-w-0">
              <div className="text-sm font-medium text-white">
                {alignmentProgress.phase === 'capturing'
                  ? 'Preparing reference…'
                  : alignmentProgress.currentDate
                  ? `Aligning ${formatDate(alignmentProgress.currentDate)} (${alignmentProgress.dateIndex + 1}/${alignmentProgress.totalDates})`
                  : 'Aligning…'}
              </div>
              {alignmentProgress.phase !== 'capturing' && alignmentProgress.slicesChecked ? (
                <div className="text-xs text-white/70">
                  {alignmentProgress.slicesChecked} slices · Score {alignmentProgress.bestMiSoFar.toFixed(3)}
                </div>
              ) : null}
            </div>
            <button
              type="button"
              onClick={abortAlignment}
              className="shrink-0 px-2 py-1 rounded bg-white/10 hover:bg-white/20 text-white text-xs"
              title="Cancel alignment"
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      <div
        className="grid gap-2"
        style={{
          gridTemplateColumns: `repeat(${gridCols}, ${gridCellSize}px)`,
          gridAutoRows: `${gridCellSize}px`,
        }}
        onMouseOver={onMouseOverGrid}
        onMouseMove={onMouseMoveGrid}
        onMouseLeave={onMouseLeaveGrid}
      >
        {columns.map(({ date, ref }) => {
          const settings = panelSettings.get(date) || DEFAULT_PANEL_SETTINGS;
          const isHovered = hoveredGridCellDate === date;

          return (
            <GridCell
              key={date}
              comboId={comboId}
              date={date}
              refData={ref}
              settings={settings}
              progress={progress}
              setProgress={setProgress}
              updatePanelSetting={updatePanelSetting}
              isHovered={isHovered}
              overlayColumns={overlayColumns}
              isAligning={isAligning}
              startAlignAll={startAlignAll}
            />
          );
        })}
        {columns.length === 0 && <div className="h-full flex items-center justify-center text-[var(--text-secondary)]">Select dates to view</div>}
      </div>
    </div>
  );
}
