import { useCallback, useState } from 'react';
import type { FocusEvent, MouseEvent } from 'react';
import { Loader2 } from 'lucide-react';
import { GridCell } from './GridCell';
import type { AlignmentProgress, AlignmentReference, ExclusionMask, PanelSettings, SeriesRef } from '../../types/api';
import { formatDate } from '../../utils/format';
import { DEFAULT_PANEL_SETTINGS, GRID_CELL_METADATA_HEIGHT } from '../../utils/constants';

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

  const updateHoveredCellFromEvent = useCallback((e: MouseEvent<HTMLDivElement> | FocusEvent<HTMLDivElement>) => {
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
  const stackedStudies = gridCols === 1 && columns.length > 1;

  return (
    <div
      className={`relative flex min-h-0 min-w-0 flex-1 justify-center ${
        stackedStudies ? 'items-start overflow-y-auto overflow-x-hidden py-6' : 'items-center overflow-hidden'
      }`}
    >
      {isAligning && alignmentProgress && (
        <div className="absolute left-1/2 top-3 z-20 max-w-[calc(100%-2rem)] -translate-x-1/2">
          <div
            role="status"
            aria-live="polite"
            className="flex items-center gap-3 rounded-[5px] border border-[var(--border-color)] bg-[var(--bg-secondary)] px-4 py-3"
          >
            <Loader2 className="h-4 w-4 shrink-0 animate-spin text-[var(--signal-metal)]" />
            <div className="min-w-0">
              <div className="text-sm font-medium text-[var(--text-primary)]">
                {alignmentProgress.phase === 'capturing'
                  ? 'Preparing reference…'
                  : alignmentProgress.currentDate
                    ? `Aligning ${formatDate(alignmentProgress.currentDate)} (${alignmentProgress.dateIndex + 1}/${alignmentProgress.totalDates})`
                    : 'Aligning…'}
              </div>
              {alignmentProgress.phase !== 'capturing' && alignmentProgress.slicesChecked ? (
                <div className="font-[family-name:var(--font-mono)] text-xs text-[var(--text-secondary)]">
                  {alignmentProgress.slicesChecked} slices · Score {alignmentProgress.bestMiSoFar.toFixed(3)}
                </div>
              ) : null}
            </div>
            <button
              type="button"
              onClick={abortAlignment}
              className="min-h-9 shrink-0 rounded-[3px] border border-[var(--border-color)] px-2.5 text-xs text-[var(--text-secondary)] transition-colors hover:text-[var(--text-primary)]"
              title="Cancel alignment"
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      <div
        className={`grid max-w-full gap-2 ${stackedStudies ? 'max-h-none' : 'max-h-full'}`}
        style={{
          gridTemplateColumns: `repeat(${gridCols}, ${gridCellSize}px)`,
          gridAutoRows: `${gridCellSize + GRID_CELL_METADATA_HEIGHT}px`,
        }}
        onMouseOver={onMouseOverGrid}
        onMouseMove={onMouseMoveGrid}
        onMouseLeave={onMouseLeaveGrid}
        onFocus={updateHoveredCellFromEvent}
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
        {columns.length === 0 && (
          <div className="h-full flex items-center justify-center text-[var(--text-secondary)]">
            Select dates to view
          </div>
        )}
      </div>
    </div>
  );
}
