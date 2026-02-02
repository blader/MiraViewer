import { useState, useRef } from 'react';
import { Pencil, Sparkles } from 'lucide-react';
import type { AlignmentReference, ExclusionMask, PanelSettings, SeriesRef } from '../../types/api';
import { formatDate } from '../../utils/format';
import { getSliceIndex, getEffectiveInstanceIndex, getProgressFromSlice } from '../../utils/math';
import { ImageControls } from '../ImageControls';
import { StepControl } from '../StepControl';
import { DragRectActionOverlay } from '../DragRectActionOverlay';
import { DicomViewer, type DicomViewerHandle } from '../DicomViewer';
import { GroundTruthPolygonOverlay } from '../GroundTruthPolygonOverlay';
import { TumorSegmentationOverlay } from '../TumorSegmentationOverlay';

export type GridCellProps = {
  comboId: string;
  date: string;
  refData: SeriesRef | undefined;
  settings: PanelSettings;
  progress: number;
  setProgress: (next: number) => void;
  updatePanelSetting: (date: string, update: Partial<PanelSettings>) => void;

  isHovered: boolean;

  overlayColumns: { date: string; ref?: SeriesRef }[];
  isAligning: boolean;

  startAlignAll: (reference: AlignmentReference, exclusion: ExclusionMask) => Promise<void>;
};

export function GridCell({
  comboId,
  date,
  refData,
  settings,
  progress,
  setProgress,
  updatePanelSetting,
  isHovered,
  overlayColumns,
  isAligning,
  startAlignAll,
}: GridCellProps) {
  const [tumorToolOpen, setTumorToolOpen] = useState(false);
  const [gtPolygonToolOpen, setGtPolygonToolOpen] = useState(false);
  const tumorViewerRef = useRef<DicomViewerHandle | null>(null);

  if (!refData) {
    return (
      <div className="relative flex flex-col rounded-lg overflow-hidden border border-[var(--border-color)] bg-[var(--bg-primary)]">
        <div className="px-3 py-2 text-xs text-[var(--text-secondary)] bg-[var(--bg-secondary)] border-b border-[var(--border-color)]">
          {formatDate(date)}
        </div>
        <div className="flex-1 flex items-center justify-center text-[var(--text-secondary)]">No series</div>
      </div>
    );
  }

  const idx = getSliceIndex(refData.instance_count, progress, settings.offset);
  const effectiveIdx = getEffectiveInstanceIndex(idx, refData.instance_count, settings.reverseSliceOrder);

  return (
    <div
      data-grid-cell-date={date}
      className="relative flex flex-col rounded-lg overflow-hidden border border-[var(--border-color)] cursor-crosshair"
    >
      {/* Cell controls (shown on hover) */}
      <div
        className={`absolute top-0 left-0 right-0 z-10 transition-opacity ${
          isHovered ? 'opacity-100 pointer-events-auto' : 'opacity-0 pointer-events-none'
        }`}
      >
        <div className="px-2 py-1 text-xs bg-[var(--bg-secondary)]/90 backdrop-blur border-b border-[var(--border-color)] flex items-center justify-between">
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => {
                setTumorToolOpen((v) => {
                  const next = !v;
                  if (next) setGtPolygonToolOpen(false);
                  return next;
                });
              }}
              className={`px-2 py-1 rounded border text-xs flex items-center gap-1.5 ${
                tumorToolOpen
                  ? 'bg-[var(--accent)] text-white border-[var(--accent)]'
                  : 'bg-[var(--bg-primary)] text-[var(--text-secondary)] border-[var(--border-color)] hover:text-[var(--text-primary)]'
              }`}
              title="Tumor segmentation tool"
            >
              <Sparkles className="w-3.5 h-3.5" />
              Tumor
            </button>

            <button
              type="button"
              onClick={() => {
                setGtPolygonToolOpen((v) => {
                  const next = !v;
                  if (next) setTumorToolOpen(false);
                  return next;
                });
              }}
              className={`px-2 py-1 rounded border text-xs flex items-center gap-1.5 ${
                gtPolygonToolOpen
                  ? 'bg-[var(--accent)] text-white border-[var(--accent)]'
                  : 'bg-[var(--bg-primary)] text-[var(--text-secondary)] border-[var(--border-color)] hover:text-[var(--text-primary)]'
              }`}
              title="Ground truth polygon tool (debug)"
            >
              <Pencil className="w-3.5 h-3.5" />
              GT
            </button>
          </div>

          <ImageControls
            settings={settings}
            instanceIndex={idx}
            instanceCount={refData.instance_count}
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
            value={`${idx + 1}/${refData.instance_count}`}
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
          disabled={overlayColumns.length < 2 || isAligning || tumorToolOpen || gtPolygonToolOpen}
          onConfirm={(mask) => {
            void startAlignAll(
              {
                date,
                seriesUid: refData.series_uid,
                sliceIndex: effectiveIdx,
                sliceCount: refData.instance_count,
                settings,
              },
              mask
            );
          }}
          actionTitle={`Align all other dates to ${formatDate(date)}`}
        >
          <DicomViewer
            ref={tumorViewerRef}
            studyId={refData.study_id}
            seriesUid={refData.series_uid}
            instanceIndex={idx}
            instanceCount={refData.instance_count}
            reverseSliceOrder={settings.reverseSliceOrder}
            onInstanceChange={(i) => {
              setProgress(getProgressFromSlice(i, refData.instance_count, settings.offset));
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

          <TumorSegmentationOverlay
            enabled={tumorToolOpen}
            onRequestClose={() => setTumorToolOpen(false)}
            viewerRef={tumorViewerRef}
            comboId={comboId}
            dateIso={date}
            studyId={refData.study_id}
            seriesUid={refData.series_uid}
            effectiveInstanceIndex={effectiveIdx}
            viewerTransform={settings}
          />

          <GroundTruthPolygonOverlay
            enabled={gtPolygonToolOpen}
            onRequestClose={() => setGtPolygonToolOpen(false)}
            comboId={comboId}
            dateIso={date}
            studyId={refData.study_id}
            seriesUid={refData.series_uid}
            effectiveInstanceIndex={effectiveIdx}
            viewerTransform={settings}
          />

          {/* Date overlay (matches overlay view style) */}
          <div className="absolute bottom-2 left-2 px-2 py-1 bg-black/70 rounded text-white text-xs font-medium pointer-events-none">
            {formatDate(date)}
          </div>
        </DragRectActionOverlay>
      </div>
    </div>
  );
}
