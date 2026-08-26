import { Suspense, useMemo, useState, useRef, useSyncExternalStore } from 'react';
import { Crosshair, Link2, ScanLine } from 'lucide-react';
import type { AlignmentReference, ExclusionMask, PanelSettings, SeriesRef } from '../../types/api';
import { formatDate } from '../../utils/format';
import { getSliceIndex, getEffectiveInstanceIndex, getProgressFromSlice } from '../../utils/math';
import { ImageControls, StudyAnnotationControls, VerifiedAlignmentBadge } from '../ImageControls';
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

export function StudySelectionSurface({
  reference,
  presentation,
  startAlignAll,
  onSegment,
  children,
}: {
  reference: {
    date: string;
    series: SeriesRef;
    sliceIndex: number;
    settings: PanelSettings;
    imageSize: { width: number; height: number };
    surfaceRef: React.RefObject<HTMLDivElement | null>;
  };
  presentation: {
    columnCount: number;
    isAligning: boolean;
    isComparing: boolean;
    groundTruthOpen: boolean;
    nativeAnnotationsAvailable: boolean;
  };
  startAlignAll: (reference: AlignmentReference, exclusion: ExclusionMask) => Promise<void>;
  onSegment: (selection: ExclusionMask) => void;
  children: React.ReactNode;
}) {
  const { date, series, sliceIndex, settings, imageSize, surfaceRef } = reference;
  const { columnCount, isAligning, isComparing, groundTruthOpen, nativeAnnotationsAvailable } = presentation;
  const startAlignment = (exclusion: ExclusionMask, alignmentFocus?: 'tumor') => {
    const bounds = surfaceRef.current?.getBoundingClientRect();
    void startAlignAll(
      {
        date,
        seriesUid: series.series_uid,
        sliceIndex,
        sliceCount: series.instance_count,
        patientKey: series.patient_key,
        studyUid: series.study_uid ?? series.study_id,
        frameOfReferenceUid: series.frame_of_reference_uid,
        imageSize,
        viewportSize:
          bounds && bounds.width > 0 && bounds.height > 0 ? { width: bounds.width, height: bounds.height } : undefined,
        settings,
        ...(alignmentFocus ? { alignmentFocus } : {}),
      },
      exclusion,
    );
  };

  return (
    <DragRectActionOverlay
      className="absolute inset-0 cursor-crosshair"
      imageSize={imageSize}
      geometry={settings}
      disabled={isAligning || isComparing || groundTruthOpen}
      actions={[
        {
          key: 'align-all',
          label: 'Align All',
          title: `Align all other dates to ${formatDate(date)}`,
          icon: <Link2 className="w-4 h-4" />,
          variant: 'primary',
          minSizeSpace: 'base',
          disabled: columnCount < 2 || isAligning,
          onConfirm: (masks) => startAlignment(masks.base),
        },
        {
          key: 'align-tumor',
          label: 'Align Tumor',
          title: 'Match tumor across dates; uses pixels inside the selected region',
          icon: <Crosshair className="w-4 h-4" />,
          variant: 'secondary',
          minSizeSpace: 'base',
          disabled: columnCount < 2 || isAligning || isComparing || !nativeAnnotationsAvailable,
          onConfirm: (masks) => startAlignment(masks.base, 'tumor'),
        },
        {
          key: 'segment-tumor',
          label: 'Segment',
          title: 'Segment tumor from this rectangle',
          icon: <ScanLine className="w-4 h-4" />,
          variant: 'secondary',
          minSizeSpace: 'screen',
          disabled: isAligning || isComparing || !nativeAnnotationsAvailable,
          onConfirm: (masks) => onSegment(masks.screen),
        },
      ]}
    >
      {children}
    </DragRectActionOverlay>
  );
}

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
  const displayedImageSize = {
    width: derivedFrame?.columns ?? nativeImageSize.w,
    height: derivedFrame?.rows ?? nativeImageSize.h,
  };
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
          {derivedFrame ? <VerifiedAlignmentBadge /> : null}
        </div>

        <div
          inert={isAligning}
          className="study-controls ml-auto flex min-w-0 items-center gap-2 overflow-x-auto transition-opacity duration-100"
        >
          <StudyAnnotationControls
            showSavedTumor={showSavedTumor}
            tumorToolOpen={tumorToolOpen}
            gtPolygonToolOpen={gtPolygonToolOpen}
            nativeAnnotationsAvailable={nativeAnnotationsAvailable}
            setShowSavedTumor={setShowSavedTumor}
            setTumorToolOpen={setTumorToolOpen}
            setGtPolygonToolOpen={setGtPolygonToolOpen}
          />

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
        <StudySelectionSurface
          reference={{
            date,
            series: refData,
            sliceIndex: effectiveIdx,
            settings,
            imageSize: displayedImageSize,
            surfaceRef: studyCellRef,
          }}
          presentation={{
            columnCount: overlayColumns.length,
            isAligning,
            isComparing: false,
            groundTruthOpen: gtPolygonToolOpen,
            nativeAnnotationsAvailable,
          }}
          startAlignAll={startAlignAll}
          onSegment={(selection) => {
            setTumorToolOpen(true);
            setTumorSeedBoxToStart({
              x0: selection.x,
              y0: selection.y,
              x1: selection.x + selection.width,
              y1: selection.y + selection.height,
            });
          }}
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
        </StudySelectionSurface>
      </div>

      <div className="flex h-12 shrink-0 items-center justify-between gap-3 border-t border-[var(--border-color)] bg-[var(--bg-secondary)] px-3">
        <span className="truncate text-xs text-[var(--text-secondary)]">
          {derivedFrame ? 'Aligned presentation' : 'Acquired image'}
        </span>
        <div inert={isAligning}>
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
    </div>
  );
}
