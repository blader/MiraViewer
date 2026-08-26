import { Suspense, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import type { AlignmentProgress, AlignmentReference, ExclusionMask, PanelSettings, SeriesRef } from '../../types/api';
import { formatDate } from '../../utils/format';
import { getEffectiveInstanceIndex, getProgressFromSlice } from '../../utils/math';
import { ImageControls, StudyAnnotationControls, VerifiedAlignmentBadge } from '../ImageControls';
import { StepControl } from '../StepControl';
import { DicomViewer, type DicomViewerHandle } from '../DicomViewer';
import { getDerivedAlignmentFrame, subscribeToDerivedAlignmentFrames } from '../../utils/derivedAlignmentFrame';
import { GRID_CELL_METADATA_HEIGHT } from '../../utils/constants';
import {
  GroundTruthPolygonOverlay,
  TumorSavedSegmentationOverlay,
  TumorSegmentationOverlay,
} from './LazyStudyOverlays';
import { AlignmentProgressCard, StudySelectionSurface } from './GridCell';

export type OverlayViewProps = {
  comboId: string;

  overlayColumns: { date: string; ref?: SeriesRef }[];
  overlayViewerSize: number;

  overlayDisplayedRef: SeriesRef | undefined;
  overlayDisplayedDate: string | undefined;
  overlayDisplayedSettings: PanelSettings;
  overlayDisplayedSliceIndex: number;
  overlayDisplayedEffectiveSliceIndex: number;

  overlaySelectedRef: SeriesRef | undefined;
  overlaySelectedDate: string | undefined;
  overlaySelectedSettings: PanelSettings;
  overlaySelectedSliceIndex: number;

  overlayCompareRef: SeriesRef | undefined;
  overlayCompareDate: string | undefined;
  overlayCompareSettings: PanelSettings;
  overlayCompareSliceIndex: number;

  isOverlayComparing: boolean;
  hasOverlayCompareTarget: boolean;

  isAligning: boolean;
  alignmentProgress: AlignmentProgress | null;
  abortAlignment: () => void;

  updatePanelSetting: (date: string, update: Partial<PanelSettings>) => void;
  startAlignAll: (reference: AlignmentReference, exclusionMask: ExclusionMask) => Promise<void>;
  setProgress: (nextProgress: number) => void;
};

type NormalizedRoi = { x0: number; y0: number; x1: number; y1: number };

type OverlayAnnotationState = {
  showSavedTumor: boolean;
  tumorToolOpen: boolean;
  gtPolygonToolOpen: boolean;
  tumorSeedBoxToStart: NormalizedRoi | null;
  closeTumor: () => void;
  consumeTumorSeed: () => void;
  closeGroundTruth: () => void;
};

type OverlayAnnotationLayersProps = {
  comboId: string;
  date: string;
  series: SeriesRef;
  settings: PanelSettings;
  effectiveSliceIndex: number;
  imageSize: { w: number; h: number };
  viewerRef: React.RefObject<DicomViewerHandle | null>;
  annotation: OverlayAnnotationState;
  nativeAnnotationsAvailable: boolean;
  isComparing: boolean;
};

function OverlayAnnotationLayers({
  comboId,
  date,
  series,
  settings,
  effectiveSliceIndex,
  imageSize,
  viewerRef,
  annotation,
  nativeAnnotationsAvailable,
  isComparing,
}: OverlayAnnotationLayersProps) {
  if (!nativeAnnotationsAvailable || isComparing) return null;

  return (
    <Suspense fallback={null}>
      {annotation.showSavedTumor && !annotation.tumorToolOpen ? (
        <TumorSavedSegmentationOverlay
          enabled
          seriesUid={series.series_uid}
          effectiveInstanceIndex={effectiveSliceIndex}
          viewerTransform={settings}
          imageSize={imageSize}
        />
      ) : null}

      {annotation.tumorToolOpen ? (
        <TumorSegmentationOverlay
          enabled
          onRequestClose={annotation.closeTumor}
          seedBoxToStart={annotation.tumorSeedBoxToStart}
          onSeedBoxToStartConsumed={annotation.consumeTumorSeed}
          viewerRef={viewerRef}
          comboId={comboId}
          dateIso={date}
          studyId={series.study_id}
          seriesUid={series.series_uid}
          effectiveInstanceIndex={effectiveSliceIndex}
          viewerTransform={settings}
        />
      ) : null}

      {annotation.gtPolygonToolOpen ? (
        <GroundTruthPolygonOverlay
          enabled
          onRequestClose={annotation.closeGroundTruth}
          comboId={comboId}
          dateIso={date}
          studyId={series.study_id}
          seriesUid={series.series_uid}
          effectiveInstanceIndex={effectiveSliceIndex}
          viewerTransform={settings}
          imageSize={imageSize}
        />
      ) : null}
    </Suspense>
  );
}

type OverlayCompareStudy = {
  series: SeriesRef;
  settings: PanelSettings;
  sliceIndex: number;
  effectiveSliceIndex: number;
  imageSize: { w: number; h: number };
  nativeAnnotationsAvailable: boolean;
};

type OverlaySelectedStudy = OverlayCompareStudy & { date: string };

function OverlaySelectedLayer({
  comboId,
  study,
  annotation,
  viewerRef,
  presentation,
  setProgress,
  updatePanelSetting,
}: {
  comboId: string;
  study: OverlaySelectedStudy;
  annotation: OverlayAnnotationState;
  viewerRef: React.RefObject<DicomViewerHandle | null>;
  presentation: Pick<OverlayComparePresentation, 'isComparing' | 'isAligning'>;
  setProgress: (progress: number) => void;
  updatePanelSetting: (date: string, update: Partial<PanelSettings>) => void;
}) {
  const { date, series, settings, sliceIndex, effectiveSliceIndex, imageSize, nativeAnnotationsAvailable } = study;
  const { isComparing, isAligning } = presentation;

  return (
    <>
      <DicomViewer
        ref={viewerRef}
        studyId={series.study_id}
        seriesUid={series.series_uid}
        interactionBlocked={isAligning}
        instanceIndex={sliceIndex}
        instanceCount={series.instance_count}
        {...settings}
        onInstanceChange={(index) => setProgress(getProgressFromSlice(index, series.instance_count, settings.offset))}
        onPanChange={
          isComparing
            ? undefined
            : (panX, panY) => {
                updatePanelSetting(date, { panX, panY });
              }
        }
        onZoomChange={(zoom) => updatePanelSetting(date, { zoom })}
      />

      <OverlayAnnotationLayers
        comboId={comboId}
        date={date}
        series={series}
        settings={settings}
        effectiveSliceIndex={effectiveSliceIndex}
        imageSize={imageSize}
        viewerRef={viewerRef}
        annotation={annotation}
        nativeAnnotationsAvailable={nativeAnnotationsAvailable}
        isComparing={isComparing}
      />
    </>
  );
}

type OverlayComparePresentation = {
  isComparing: boolean;
  isAligning: boolean;
  showSavedTumor: boolean;
  tumorToolOpen: boolean;
};

function OverlayComparisonLayer({
  study,
  presentation,
  setProgress,
}: {
  study: OverlayCompareStudy;
  presentation: OverlayComparePresentation;
  setProgress: (progress: number) => void;
}) {
  const { series, settings, sliceIndex, effectiveSliceIndex, imageSize, nativeAnnotationsAvailable } = study;
  const { isComparing, isAligning, showSavedTumor, tumorToolOpen } = presentation;

  return (
    <div className={`absolute inset-0 ${isComparing ? 'opacity-100' : 'opacity-0 pointer-events-none'}`}>
      <DicomViewer
        studyId={series.study_id}
        seriesUid={series.series_uid}
        interactionBlocked={isAligning || isComparing}
        instanceIndex={sliceIndex}
        instanceCount={series.instance_count}
        {...settings}
        onInstanceChange={(index) => {
          setProgress(getProgressFromSlice(index, series.instance_count, settings.offset));
        }}
        onPanChange={undefined}
        onZoomChange={undefined}
      />

      {nativeAnnotationsAvailable && showSavedTumor && !tumorToolOpen && isComparing ? (
        <Suspense fallback={null}>
          <TumorSavedSegmentationOverlay
            enabled
            seriesUid={series.series_uid}
            effectiveInstanceIndex={effectiveSliceIndex}
            viewerTransform={settings}
            imageSize={imageSize}
          />
        </Suspense>
      ) : null}
    </div>
  );
}

function OverlayStudyFooter({
  presentation,
  instanceIndex,
  instanceCount,
  settings,
  onUpdate,
}: {
  presentation: { isComparing: boolean; isAligning: boolean; isAligned: boolean };
  instanceIndex: number;
  instanceCount: number;
  settings: PanelSettings;
  onUpdate: (update: Partial<PanelSettings>) => void;
}) {
  return (
    <div className="flex h-12 shrink-0 items-center justify-between gap-3 border-t border-[var(--border-color)] bg-[var(--bg-secondary)] px-3">
      <span className="truncate text-xs text-[var(--text-secondary)]">
        {presentation.isComparing
          ? 'Comparing examination'
          : presentation.isAligned
            ? 'Aligned presentation'
            : 'Acquired image'}
      </span>
      <div
        inert={presentation.isComparing || presentation.isAligning}
        className={presentation.isComparing ? 'pointer-events-none opacity-40' : ''}
      >
        <StepControl
          title="Slice offset"
          value={`${instanceIndex + 1}/${instanceCount}`}
          valueWidth="w-16"
          tabular
          accent
          onDecrement={() => onUpdate({ offset: settings.offset - 1 })}
          onIncrement={() => onUpdate({ offset: settings.offset + 1 })}
        />
      </div>
    </div>
  );
}

function OverlayStudyHeader({
  date,
  settings,
  instanceIndex,
  instanceCount,
  presentation,
  annotation,
  onUpdate,
}: {
  date: string;
  settings: PanelSettings;
  instanceIndex: number;
  instanceCount: number;
  presentation: { isComparing: boolean; isAligning: boolean; isAligned: boolean; nativeAnnotationsAvailable: boolean };
  annotation: {
    showSavedTumor: boolean;
    tumorToolOpen: boolean;
    gtPolygonToolOpen: boolean;
    setShowSavedTumor: React.Dispatch<React.SetStateAction<boolean>>;
    setTumorToolOpen: React.Dispatch<React.SetStateAction<boolean>>;
    setGtPolygonToolOpen: React.Dispatch<React.SetStateAction<boolean>>;
  };
  onUpdate: (update: Partial<PanelSettings>) => void;
}) {
  return (
    <div className="flex h-12 shrink-0 items-center gap-3 border-b border-[var(--border-color)] bg-[var(--bg-secondary)] px-3">
      <div className="flex shrink-0 items-center gap-2">
        <span className="font-[family-name:var(--font-mono)] text-xs tabular-nums text-[var(--text-primary)]">
          {formatDate(date)}
        </span>
        {presentation.isAligned ? <VerifiedAlignmentBadge /> : null}
      </div>

      <div
        inert={presentation.isComparing || presentation.isAligning}
        className={`ml-auto flex min-w-0 items-center gap-2 overflow-x-auto transition-opacity duration-100 ${
          presentation.isComparing ? 'pointer-events-none opacity-40' : 'study-controls'
        }`}
      >
        <StudyAnnotationControls {...annotation} nativeAnnotationsAvailable={presentation.nativeAnnotationsAvailable} />

        <ImageControls
          settings={settings}
          instanceIndex={instanceIndex}
          instanceCount={instanceCount}
          onUpdate={onUpdate}
          showSliceControl={false}
        />
      </div>
    </div>
  );
}

export function OverlayView({
  comboId,
  overlayColumns,
  overlayViewerSize,
  overlayDisplayedRef,
  overlayDisplayedDate,
  overlayDisplayedSettings,
  overlayDisplayedSliceIndex,
  overlayDisplayedEffectiveSliceIndex,
  overlaySelectedRef,
  overlaySelectedDate,
  overlaySelectedSettings,
  overlaySelectedSliceIndex,
  overlayCompareRef,
  overlayCompareDate,
  overlayCompareSettings,
  overlayCompareSliceIndex,
  isOverlayComparing,
  hasOverlayCompareTarget,
  isAligning,
  alignmentProgress,
  abortAlignment,
  updatePanelSetting,
  startAlignAll,
  setProgress,
}: OverlayViewProps) {
  const [isOverlayViewerHovered, setIsOverlayViewerHovered] = useState(false);
  const [showSavedTumor, setShowSavedTumor] = useState(false);
  const [tumorToolOpen, setTumorToolOpen] = useState(false);
  const [tumorSeedBoxToStart, setTumorSeedBoxToStart] = useState<NormalizedRoi | null>(null);
  const [gtPolygonToolOpen, setGtPolygonToolOpen] = useState(false);
  const tumorViewerRef = useRef<DicomViewerHandle | null>(null);
  const overlayCellRef = useRef<HTMLDivElement | null>(null);
  const selectedImageSize = useMemo(
    () => ({ w: overlaySelectedRef?.columns ?? 512, h: overlaySelectedRef?.rows ?? 512 }),
    [overlaySelectedRef?.columns, overlaySelectedRef?.rows],
  );
  const compareImageSize = useMemo(
    () => ({ w: overlayCompareRef?.columns ?? 512, h: overlayCompareRef?.rows ?? 512 }),
    [overlayCompareRef?.columns, overlayCompareRef?.rows],
  );

  // Compare mode is read-only: ensure the tumor tool isn't active.
  // We schedule the close to avoid calling setState synchronously inside the effect body.
  useEffect(() => {
    if (!isOverlayComparing) return;

    const t = window.setTimeout(() => {
      setTumorToolOpen(false);
      setGtPolygonToolOpen(false);
    }, 0);

    return () => window.clearTimeout(t);
  }, [isOverlayComparing]);

  // Note: the tool only operates on the *selected* date when not comparing.
  const tumorEffectiveSliceIndex =
    overlaySelectedRef && overlaySelectedDate
      ? getEffectiveInstanceIndex(
          overlaySelectedSliceIndex,
          overlaySelectedRef.instance_count,
          overlaySelectedSettings.reverseSliceOrder,
        )
      : 0;

  const compareEffectiveSliceIndex =
    overlayCompareRef && overlayCompareDate
      ? getEffectiveInstanceIndex(
          overlayCompareSliceIndex,
          overlayCompareRef.instance_count,
          overlayCompareSettings.reverseSliceOrder,
        )
      : 0;

  const selectedDerivedFrame = useSyncExternalStore(subscribeToDerivedAlignmentFrames, () =>
    overlaySelectedRef ? getDerivedAlignmentFrame(overlaySelectedRef.series_uid, tumorEffectiveSliceIndex) : null,
  );
  const compareDerivedFrame = useSyncExternalStore(subscribeToDerivedAlignmentFrames, () =>
    overlayCompareRef ? getDerivedAlignmentFrame(overlayCompareRef.series_uid, compareEffectiveSliceIndex) : null,
  );
  const displayedDerivedFrame = isOverlayComparing ? compareDerivedFrame : selectedDerivedFrame;
  const displayedImageSize = {
    width: displayedDerivedFrame?.columns ?? overlayDisplayedRef?.columns ?? 512,
    height: displayedDerivedFrame?.rows ?? overlayDisplayedRef?.rows ?? 512,
  };
  const nativeAnnotationsAvailable = displayedDerivedFrame === null;

  return (
    <div className="flex min-h-0 min-w-0 flex-1 items-center justify-center overflow-hidden p-3">
      {overlayColumns.length === 0 ? (
        <div className="text-[var(--text-secondary)]">Select dates to view</div>
      ) : overlayDisplayedRef && overlayDisplayedDate ? (
        <div
          className="study-cell relative flex min-h-0 min-w-0 flex-col overflow-hidden rounded-[4px] border border-[var(--border-color)] bg-[var(--bg-primary)]"
          data-controls-visible={(isOverlayViewerHovered || tumorToolOpen || gtPolygonToolOpen) && !isOverlayComparing}
          data-alignment-state={displayedDerivedFrame ? 'aligned' : 'acquired'}
          style={{ width: overlayViewerSize, height: overlayViewerSize + GRID_CELL_METADATA_HEIGHT }}
          onMouseEnter={() => setIsOverlayViewerHovered(true)}
          onMouseLeave={() => setIsOverlayViewerHovered(false)}
        >
          <OverlayStudyHeader
            date={overlayDisplayedDate}
            settings={overlayDisplayedSettings}
            instanceIndex={overlayDisplayedSliceIndex}
            instanceCount={overlayDisplayedRef.instance_count}
            presentation={{
              isComparing: isOverlayComparing,
              isAligning,
              isAligned: Boolean(displayedDerivedFrame),
              nativeAnnotationsAvailable,
            }}
            annotation={{
              showSavedTumor,
              tumorToolOpen,
              gtPolygonToolOpen,
              setShowSavedTumor,
              setTumorToolOpen,
              setGtPolygonToolOpen,
            }}
            onUpdate={(update) => updatePanelSetting(overlayDisplayedDate, update)}
          />

          <div
            ref={overlayCellRef}
            data-diagnostic-surface="true"
            className="relative min-h-0 flex-1 bg-[var(--bg-primary)]"
          >
            <StudySelectionSurface
              reference={{
                date: overlayDisplayedDate,
                series: overlayDisplayedRef,
                sliceIndex: overlayDisplayedEffectiveSliceIndex,
                settings: overlayDisplayedSettings,
                imageSize: displayedImageSize,
                surfaceRef: overlayCellRef,
              }}
              presentation={{
                columnCount: overlayColumns.length,
                isAligning,
                isComparing: isOverlayComparing,
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
                setGtPolygonToolOpen(false);
              }}
            >
              {/*
            Space compare should feel instant.

            Previously we updated a single viewer's series/settings on Space keydown.
            That can cause a brief visual "jerk" (old image + new transform/settings)
            while the new slice resolves/loads.

            To avoid that, we keep BOTH the selected date and the compare target mounted
            and simply toggle which one is visible.
          */}
              <div
                className={`absolute inset-0 ${isOverlayComparing ? 'opacity-0 pointer-events-none' : 'opacity-100'}`}
              >
                {overlaySelectedRef && overlaySelectedDate ? (
                  <OverlaySelectedLayer
                    comboId={comboId}
                    study={{
                      date: overlaySelectedDate,
                      series: overlaySelectedRef,
                      settings: overlaySelectedSettings,
                      sliceIndex: overlaySelectedSliceIndex,
                      effectiveSliceIndex: tumorEffectiveSliceIndex,
                      imageSize: selectedImageSize,
                      nativeAnnotationsAvailable: !selectedDerivedFrame,
                    }}
                    annotation={{
                      showSavedTumor,
                      tumorToolOpen,
                      gtPolygonToolOpen,
                      tumorSeedBoxToStart,
                      closeTumor: () => {
                        setTumorToolOpen(false);
                        setTumorSeedBoxToStart(null);
                      },
                      consumeTumorSeed: () => setTumorSeedBoxToStart(null),
                      closeGroundTruth: () => setGtPolygonToolOpen(false),
                    }}
                    viewerRef={tumorViewerRef}
                    presentation={{ isComparing: isOverlayComparing, isAligning }}
                    setProgress={setProgress}
                    updatePanelSetting={updatePanelSetting}
                  />
                ) : null}
              </div>

              {hasOverlayCompareTarget && overlayCompareRef && overlayCompareDate ? (
                <OverlayComparisonLayer
                  study={{
                    series: overlayCompareRef,
                    settings: overlayCompareSettings,
                    sliceIndex: overlayCompareSliceIndex,
                    effectiveSliceIndex: compareEffectiveSliceIndex,
                    imageSize: compareImageSize,
                    nativeAnnotationsAvailable: !compareDerivedFrame,
                  }}
                  presentation={{
                    isComparing: isOverlayComparing,
                    isAligning,
                    showSavedTumor,
                    tumorToolOpen,
                  }}
                  setProgress={setProgress}
                />
              ) : null}

              {isAligning && alignmentProgress ? (
                <div className="absolute inset-0 flex items-center justify-center bg-black/40">
                  <AlignmentProgressCard progress={alignmentProgress} onAbort={abortAlignment} />
                </div>
              ) : null}
            </StudySelectionSurface>
          </div>

          <OverlayStudyFooter
            presentation={{
              isComparing: isOverlayComparing,
              isAligning,
              isAligned: Boolean(displayedDerivedFrame),
            }}
            instanceIndex={overlayDisplayedSliceIndex}
            instanceCount={overlayDisplayedRef.instance_count}
            settings={overlayDisplayedSettings}
            onUpdate={(update) => updatePanelSetting(overlayDisplayedDate, update)}
          />
        </div>
      ) : (
        <div className="text-[var(--text-secondary)]">No data</div>
      )}
    </div>
  );
}
