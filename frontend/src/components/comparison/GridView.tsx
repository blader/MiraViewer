import { AlignmentProgressCard, GridCell } from './GridCell';
import type { AlignmentProgress, AlignmentReference, ExclusionMask, PanelSettings, SeriesRef } from '../../types/api';
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
  const stackedStudies = gridCols === 1 && columns.length > 1;

  return (
    <div
      className={`relative flex min-h-0 min-w-0 flex-1 justify-center ${
        stackedStudies ? 'items-start overflow-y-auto overflow-x-hidden py-6' : 'items-center overflow-hidden'
      }`}
    >
      {isAligning && alignmentProgress && (
        <div className="absolute left-1/2 top-3 z-20 max-w-[calc(100%-2rem)] -translate-x-1/2">
          <AlignmentProgressCard progress={alignmentProgress} onAbort={abortAlignment} />
        </div>
      )}

      <div
        className={`grid max-w-full gap-2 ${stackedStudies ? 'max-h-none' : 'max-h-full'}`}
        style={{
          gridTemplateColumns: `repeat(${gridCols}, ${gridCellSize}px)`,
          gridAutoRows: `${gridCellSize + GRID_CELL_METADATA_HEIGHT}px`,
        }}
      >
        {columns.map(({ date, ref }) => {
          const settings = panelSettings.get(date) || DEFAULT_PANEL_SETTINGS;

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
