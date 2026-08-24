import { Suspense, useMemo, useState, useRef, useSyncExternalStore } from 'react';
import { Link2, Pencil, Sparkles } from 'lucide-react';
import type { AlignmentReference, ExclusionMask, PanelSettings, SeriesRef } from '../../types/api';
import { formatDate } from '../../utils/format';
import { getSliceIndex, getEffectiveInstanceIndex, getProgressFromSlice } from '../../utils/math';
import { ImageControls } from '../ImageControls';
import { StepControl } from '../StepControl';
import { DragRectActionOverlay } from '../DragRectActionOverlay';
import { DicomViewer, type DicomViewerHandle } from '../DicomViewer';
import { getDerivedAlignmentFrame, subscribeToDerivedAlignmentFrames } from '../../utils/derivedAlignmentFrame';
import {
  GroundTruthPolygonOverlay,
  TumorSavedSegmentationOverlay,
  TumorSegmentationOverlay,
} from './LazyStudyOverlays';

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

type NormalizedRoi = { x0: number; y0: number; x1: number; y1: number };

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
  const [showSavedTumor, setShowSavedTumor] = useState(false);
  const [tumorToolOpen, setTumorToolOpen] = useState(false);
  const [tumorSeedBoxToStart, setTumorSeedBoxToStart] = useState<NormalizedRoi | null>(null);
  const [gtPolygonToolOpen, setGtPolygonToolOpen] = useState(false);
  const tumorViewerRef = useRef<DicomViewerHandle | null>(null);
  const studyCellRef = useRef<HTMLDivElement | null>(null);
  const nativeImageSize = useMemo(
    () => ({ w: refData?.columns ?? 512, h: refData?.rows ?? 512 }),
    [refData?.columns, refData?.rows],
  );
  const idx = refData ? getSliceIndex(refData.instance_count, progress, settings.offset) : 0;
  const effectiveIdx = refData ? getEffectiveInstanceIndex(idx, refData.instance_count, settings.reverseSliceOrder) : 0;
  const derivedFrame = useSyncExternalStore(subscribeToDerivedAlignmentFrames, () =>
    refData ? getDerivedAlignmentFrame(refData.series_uid, effectiveIdx) : null,
  );
  const nativeAnnotationsAvailable = derivedFrame === null;

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

  return (
    <div
      ref={studyCellRef}
      data-grid-cell-date={date}
      data-controls-visible={isHovered || tumorToolOpen || gtPolygonToolOpen}
      className="study-cell relative flex flex-col rounded-lg overflow-hidden border border-[var(--border-color)] cursor-crosshair"
    >
      {/* Cell controls (shown on hover) */}
      <div className="study-controls absolute top-0 left-0 right-0 z-10 transition-opacity">
        <div className="px-2 py-1 text-xs bg-[var(--bg-secondary)]/90 backdrop-blur border-b border-[var(--border-color)] flex items-center justify-between">
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => setShowSavedTumor((v) => !v)}
              disabled={tumorToolOpen || !nativeAnnotationsAvailable}
              aria-pressed={showSavedTumor}
              className={`px-2 py-1 rounded border text-xs flex items-center gap-1.5 ${
                tumorToolOpen || !nativeAnnotationsAvailable
                  ? 'bg-[var(--bg-tertiary)] text-[var(--text-tertiary)] border-[var(--border-color)]'
                  : showSavedTumor
                    ? 'bg-[var(--accent)] text-white border-[var(--accent)]'
                    : 'bg-[var(--bg-primary)] text-[var(--text-secondary)] border-[var(--border-color)] hover:text-[var(--text-primary)]'
              }`}
              title={
                !nativeAnnotationsAvailable
                  ? 'Native annotations are unavailable on a derived alignment plane'
                  : tumorToolOpen
                    ? 'Close segmentation tool to view saved tumor overlay'
                    : 'Toggle saved tumor segmentation overlay'
              }
            >
              <Sparkles className="w-3.5 h-3.5" />
              Tumor
            </button>

            <button
              type="button"
              aria-pressed={gtPolygonToolOpen}
              disabled={!nativeAnnotationsAvailable}
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
              title={
                nativeAnnotationsAvailable
                  ? 'Ground truth polygon tool (debug)'
                  : 'Native annotations are unavailable on a derived alignment plane'
              }
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
        className="study-controls absolute bottom-2 right-2 z-10 transition-opacity"
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
          imageSize={{ width: refData.columns ?? 512, height: refData.rows ?? 512 }}
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
          disabled={isAligning || gtPolygonToolOpen}
          actions={[
            {
              key: 'align-all',
              label: 'Align All',
              title: `Align all other dates to ${formatDate(date)}`,
              icon: <Link2 className="w-4 h-4" />,
              variant: 'primary',
              minSizeSpace: 'base',
              disabled: overlayColumns.length < 2 || isAligning,
              onConfirm: (masks) => {
                const bounds = studyCellRef.current?.getBoundingClientRect();
                void startAlignAll(
                  {
                    date,
                    seriesUid: refData.series_uid,
                    sliceIndex: effectiveIdx,
                    sliceCount: refData.instance_count,
                    patientKey: refData.patient_key,
                    studyUid: refData.study_uid ?? refData.study_id,
                    frameOfReferenceUid: refData.frame_of_reference_uid,
                    imageSize: { width: refData.columns ?? 512, height: refData.rows ?? 512 },
                    viewportSize:
                      bounds && bounds.width > 0 && bounds.height > 0
                        ? { width: bounds.width, height: bounds.height }
                        : undefined,
                    settings,
                  },
                  masks.base,
                );
              },
            },
            {
              key: 'segment-tumor',
              label: 'Segment',
              title: 'Segment tumor from this rectangle',
              icon: <Sparkles className="w-4 h-4" />,
              variant: 'secondary',
              minSizeSpace: 'screen',
              disabled: isAligning || !nativeAnnotationsAvailable,
              onConfirm: (masks) => {
                setTumorToolOpen(true);
                setTumorSeedBoxToStart({
                  x0: masks.screen.x,
                  y0: masks.screen.y,
                  x1: masks.screen.x + masks.screen.width,
                  y1: masks.screen.y + masks.screen.height,
                });
              },
            },
          ]}
        >
          <DicomViewer
            ref={tumorViewerRef}
            studyId={refData.study_id}
            seriesUid={refData.series_uid}
            interactionBlocked={isAligning}
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
            onZoomChange={(newZoom) => {
              updatePanelSetting(date, { zoom: newZoom });
            }}
          />

          <Suspense fallback={null}>
            {nativeAnnotationsAvailable && showSavedTumor && !tumorToolOpen ? (
              <TumorSavedSegmentationOverlay
                enabled
                seriesUid={refData.series_uid}
                effectiveInstanceIndex={effectiveIdx}
                viewerTransform={settings}
                imageSize={nativeImageSize}
              />
            ) : null}

            {nativeAnnotationsAvailable && tumorToolOpen ? (
              <TumorSegmentationOverlay
                enabled
                onRequestClose={() => {
                  setTumorToolOpen(false);
                  setTumorSeedBoxToStart(null);
                }}
                seedBoxToStart={tumorSeedBoxToStart}
                onSeedBoxToStartConsumed={() => setTumorSeedBoxToStart(null)}
                viewerRef={tumorViewerRef}
                comboId={comboId}
                dateIso={date}
                studyId={refData.study_id}
                seriesUid={refData.series_uid}
                effectiveInstanceIndex={effectiveIdx}
                viewerTransform={settings}
              />
            ) : null}

            {nativeAnnotationsAvailable && gtPolygonToolOpen ? (
              <GroundTruthPolygonOverlay
                enabled
                onRequestClose={() => setGtPolygonToolOpen(false)}
                comboId={comboId}
                dateIso={date}
                studyId={refData.study_id}
                seriesUid={refData.series_uid}
                effectiveInstanceIndex={effectiveIdx}
                viewerTransform={settings}
                imageSize={nativeImageSize}
              />
            ) : null}
          </Suspense>

          {/* Date overlay (matches overlay view style) */}
          <div className="absolute bottom-2 left-2 px-2 py-1 bg-black/70 rounded text-white text-xs font-medium pointer-events-none">
            {formatDate(date)}
          </div>
        </DragRectActionOverlay>
      </div>
    </div>
  );
}
