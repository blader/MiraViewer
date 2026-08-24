import { Suspense, useMemo, useState, useRef, useSyncExternalStore } from 'react';
import { Link2, Pencil, ScanLine } from 'lucide-react';
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
      <div className="relative flex min-h-0 flex-col overflow-hidden rounded-[4px] border border-[var(--border-color)] bg-[var(--bg-primary)]">
        <div className="flex min-h-10 items-center border-b border-[var(--border-color)] bg-[var(--bg-secondary)] px-3 font-[family-name:var(--font-mono)] text-xs text-[var(--text-secondary)]">
          {formatDate(date)}
        </div>
        <div className="flex flex-1 items-center justify-center text-sm text-[var(--text-secondary)]">No series</div>
      </div>
    );
  }

  return (
    <div
      data-grid-cell-date={date}
      data-alignment-state={derivedFrame ? 'aligned' : 'acquired'}
      data-controls-visible={isHovered || tumorToolOpen || gtPolygonToolOpen}
      className="study-cell relative flex min-h-0 min-w-0 flex-col overflow-hidden rounded-[4px] border border-[var(--border-color)] bg-[var(--bg-primary)]"
    >
      <div className="flex h-12 shrink-0 items-center gap-3 border-b border-[var(--border-color)] bg-[var(--bg-secondary)] px-3">
        <div className="flex shrink-0 items-center gap-2">
          <span className="font-[family-name:var(--font-mono)] text-xs tabular-nums text-[var(--text-primary)]">
            {formatDate(date)}
          </span>
          {derivedFrame ? (
            <span
              data-registration-datum="verified"
              aria-label="Verified aligned presentation"
              className="flex items-center gap-1.5 text-xs text-[var(--signal-metal)]"
            >
              <span aria-hidden="true" className="h-3 w-px bg-[var(--signal-metal)]" />
              <span className="hidden lg:inline">Aligned</span>
            </span>
          ) : null}
        </div>

        <div className="study-controls ml-auto flex min-w-0 items-center gap-2 overflow-x-auto transition-opacity duration-100">
          <button
            type="button"
            onClick={() => setShowSavedTumor((v) => !v)}
            disabled={tumorToolOpen || !nativeAnnotationsAvailable}
            aria-pressed={showSavedTumor}
            className={`flex min-h-8 shrink-0 items-center gap-1 rounded-[3px] px-1.5 text-xs transition-colors ${
              tumorToolOpen || !nativeAnnotationsAvailable
                ? 'text-[var(--text-tertiary)]'
                : showSavedTumor
                  ? 'bg-[var(--bg-tertiary)] text-[var(--signal-metal)]'
                  : 'text-[var(--text-secondary)] hover:bg-[var(--bg-tertiary)] hover:text-[var(--text-primary)]'
            }`}
            title={
              !nativeAnnotationsAvailable
                ? 'Native annotations are unavailable on a derived alignment plane'
                : tumorToolOpen
                  ? 'Close segmentation tool to view saved tumor overlay'
                  : 'Toggle saved tumor segmentation overlay'
            }
          >
            <ScanLine className="h-3.5 w-3.5" />
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
            className={`flex min-h-8 shrink-0 items-center gap-1 rounded-[3px] px-1.5 text-xs transition-colors ${
              gtPolygonToolOpen
                ? 'bg-[var(--bg-tertiary)] text-[var(--signal-metal)]'
                : 'text-[var(--text-secondary)] hover:bg-[var(--bg-tertiary)] hover:text-[var(--text-primary)]'
            }`}
            title={
              nativeAnnotationsAvailable
                ? 'Ground truth polygon tool (debug)'
                : 'Native annotations are unavailable on a derived alignment plane'
            }
          >
            <Pencil className="h-3.5 w-3.5" />
            GT
          </button>

          <ImageControls
            settings={settings}
            instanceIndex={idx}
            instanceCount={refData.instance_count}
            onUpdate={(update) => updatePanelSetting(date, update)}
            showSliceControl={false}
          />
        </div>
      </div>

      <div ref={studyCellRef} data-diagnostic-surface="true" className="relative min-h-0 flex-1 bg-[var(--bg-primary)]">
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
              icon: <ScanLine className="w-4 h-4" />,
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
        </DragRectActionOverlay>
      </div>

      <div className="flex h-12 shrink-0 items-center justify-between gap-3 border-t border-[var(--border-color)] bg-[var(--bg-secondary)] px-3">
        <span className="truncate text-xs text-[var(--text-secondary)]">
          {derivedFrame ? 'Aligned presentation' : 'Acquired image'}
        </span>
        <StepControl
          title="Slice offset"
          value={`${idx + 1}/${refData.instance_count}`}
          valueWidth="w-16"
          tabular
          accent
          onDecrement={() => updatePanelSetting(date, { offset: settings.offset - 1 })}
          onIncrement={() => updatePanelSetting(date, { offset: settings.offset + 1 })}
        />
      </div>
    </div>
  );
}
