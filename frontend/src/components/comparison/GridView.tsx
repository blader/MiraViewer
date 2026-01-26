import { useCallback, useState } from 'react';
import type { MouseEvent } from 'react';
import { Loader2 } from 'lucide-react';
import type {
  AlignmentProgress,
  AlignmentReference,
  ExclusionMask,
  PanelSettings,
  SeriesRef,
} from '../../types/api';
import { formatDate } from '../../utils/format';
import { DEFAULT_PANEL_SETTINGS } from '../../utils/constants';
import { getSliceIndex, getEffectiveInstanceIndex, getProgressFromSlice } from '../../utils/math';
import { ImageControls } from '../ImageControls';
import { StepControl } from '../StepControl';
import { DragRectActionOverlay } from '../DragRectActionOverlay';
import { DicomViewer } from '../DicomViewer';

export type GridViewProps = {
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
                  {alignmentProgress.slicesChecked} slices · MI {alignmentProgress.bestMiSoFar.toFixed(3)}
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

          if (!ref) {
            return (
              <div key={date} className="relative flex flex-col rounded-lg overflow-hidden border border-[var(--border-color)] bg-[var(--bg-primary)]">
                <div className="px-3 py-2 text-xs text-[var(--text-secondary)] bg-[var(--bg-secondary)] border-b border-[var(--border-color)]">
                  {formatDate(date)}
                </div>
                <div className="flex-1 flex items-center justify-center text-[var(--text-secondary)]">No series</div>
              </div>
            );
          }

          const idx = getSliceIndex(ref.instance_count, progress, settings.offset);
          const effectiveIdx = getEffectiveInstanceIndex(idx, ref.instance_count, settings.reverseSliceOrder);

          const isHovered = hoveredGridCellDate === date;

          return (
            <div
              key={date}
              data-grid-cell-date={date}
              className="relative flex flex-col rounded-lg overflow-hidden border border-[var(--border-color)] cursor-crosshair"
            >
              {/* Cell controls (shown on hover) */}
              <div
                className={`absolute top-0 left-0 right-0 z-10 transition-opacity ${
                  isHovered ? 'opacity-100 pointer-events-auto' : 'opacity-0 pointer-events-none'
                }`}
              >
                <div className="px-2 py-1 text-xs bg-[var(--bg-secondary)]/90 backdrop-blur border-b border-[var(--border-color)] flex items-center justify-end">
                  <ImageControls
                    settings={settings}
                    instanceIndex={idx}
                    instanceCount={ref.instance_count}
                    onUpdate={(update) => {
                      updatePanelSetting(date, update);
                    }}
                    showSliceControl={false}
                  />
                </div>
              </div>

              {/* Slice selector (shown on hover, bottom-right corner) */}
              <div
                className={`absolute bottom-2 right-2 z-10 transition-opacity ${
                  isHovered ? 'opacity-100 pointer-events-auto' : 'opacity-0 pointer-events-none'
                }`}
                onMouseDown={(e) => e.stopPropagation()}
              >
                <div className="px-2 py-1 rounded bg-[var(--bg-secondary)]/90 backdrop-blur border border-[var(--border-color)]">
                  <StepControl
                    title="Slice offset"
                    value={`${idx + 1}/${ref.instance_count}`}
                    valueWidth="w-16"
                    tabular
                    accent
                    onDecrement={() => {
                      updatePanelSetting(date, { offset: settings.offset - 1 });
                    }}
                    onIncrement={() => {
                      updatePanelSetting(date, { offset: settings.offset + 1 });
                    }}
                  />
                </div>
              </div>

              <div className="flex-1 min-h-0 bg-black relative">
                <DragRectActionOverlay
                  className="absolute inset-0 cursor-crosshair"
                  geometry={{
                    panX: settings.panX,
                    panY: settings.panY,
                    zoom: settings.zoom,
                    rotation: settings.rotation,
                    affine00: settings.affine00,
                    affine01: settings.affine01,
                    affine10: settings.affine10,
                    affine11: settings.affine11,
                  }}
                  disabled={overlayColumns.length < 2 || isAligning}
                  onConfirm={(mask) => {
                    void startAlignAll(
                      {
                        date,
                        seriesUid: ref.series_uid,
                        sliceIndex: effectiveIdx,
                        sliceCount: ref.instance_count,
                        settings,
                      },
                      mask
                    );
                  }}
                  actionTitle={`Align all other dates to ${formatDate(date)}`}
                >
                  <DicomViewer
                    studyId={ref.study_id}
                    seriesUid={ref.series_uid}
                    instanceIndex={idx}
                    instanceCount={ref.instance_count}
                    reverseSliceOrder={settings.reverseSliceOrder}
                    onInstanceChange={(i) => {
                      setProgress(getProgressFromSlice(i, ref.instance_count, settings.offset));
                    }}
                    brightness={settings.brightness}
                    contrast={settings.contrast}
                    zoom={settings.zoom}
                    rotation={settings.rotation}
                    panX={settings.panX}
                    panY={settings.panY}
                    affine00={settings.affine00}
                    affine01={settings.affine01}
                    affine10={settings.affine10}
                    affine11={settings.affine11}
                    onPanChange={(newPanX, newPanY) => {
                      updatePanelSetting(date, { panX: newPanX, panY: newPanY });
                    }}
                  />

                  {/* Date overlay (matches overlay view style) */}
                  <div className="absolute bottom-2 left-2 px-2 py-1 bg-black/70 rounded text-white text-xs font-medium pointer-events-none">
                    {formatDate(date)}
                  </div>
                </DragRectActionOverlay>
              </div>
            </div>
          );
        })}
        {columns.length === 0 && <div className="h-full flex items-center justify-center text-[var(--text-secondary)]">Select dates to view</div>}
      </div>
    </div>
  );
}
