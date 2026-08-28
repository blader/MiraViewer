import { Suspense, useEffect, useMemo, useState } from 'react';
import type { PanelSettings, SeriesRef } from '../../types/api';
import { formatDate } from '../../utils/format';
import { getEffectiveInstanceIndex, getProgressFromSlice } from '../../utils/math';
import {
  AcquiredImageAction,
  AlignmentBadge,
  ImageControls,
  ResumeAlignmentAction,
  StudyAnnotationControls,
} from '../ImageControls';
import { StudyTools } from './StudyTools';
import { StepControl } from '../StepControl';
import { DicomViewer } from '../DicomViewer';
import { useAlignedFrame } from '../../hooks/useAlignedFrame';
import { GRID_CELL_METADATA_HEIGHT } from '../../utils/constants';
import { GroundTruthPolygonOverlay, TumorSavedSegmentationOverlay } from './LazyStudyOverlays';

export type OverlayViewProps = {
  comboId: string;

  overlayColumns: { date: string; ref?: SeriesRef }[];
  overlayViewerSize: number;

  overlayDisplayedRef: SeriesRef | undefined;
  overlayDisplayedDate: string | undefined;
  overlayDisplayedSettings: PanelSettings;
  overlayDisplayedSliceIndex: number;

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

  onUseAcquired?: (date: string) => void;

  updatePanelSetting: (date: string, update: Partial<PanelSettings>) => void;
  setProgress: (nextProgress: number) => void;
};

type OverlayAnnotationState = {
  showSavedTumor: boolean;
  gtPolygonToolOpen: boolean;
  closeGroundTruth: () => void;
};

type OverlayAnnotationLayersProps = {
  comboId: string;
  date: string;
  series: SeriesRef;
  settings: PanelSettings;
  effectiveSliceIndex: number;
  imageSize: { w: number; h: number };
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
  annotation,
  nativeAnnotationsAvailable,
  isComparing,
}: OverlayAnnotationLayersProps) {
  if (!nativeAnnotationsAvailable || isComparing) return null;

  return (
    <Suspense fallback={null}>
      {annotation.showSavedTumor ? (
        <TumorSavedSegmentationOverlay
          enabled
          seriesUid={series.series_uid}
          effectiveInstanceIndex={effectiveSliceIndex}
          viewerTransform={settings}
          imageSize={imageSize}
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
  isComparing,
  setProgress,
  updatePanelSetting,
}: {
  comboId: string;
  study: OverlaySelectedStudy;
  annotation: OverlayAnnotationState;
  isComparing: boolean;
  setProgress: (progress: number) => void;
  updatePanelSetting: (date: string, update: Partial<PanelSettings>) => void;
}) {
  const { date, series, settings, sliceIndex, effectiveSliceIndex, imageSize, nativeAnnotationsAvailable } = study;

  return (
    <DicomViewer
      studyId={series.study_id}
      seriesUid={series.series_uid}
      instanceIndex={sliceIndex}
      instanceCount={series.instance_count}
      {...settings}
      onInstanceChange={(index) => setProgress(getProgressFromSlice(index, series.instance_count, settings.offset))}
      onPanChange={
        isComparing || (nativeAnnotationsAvailable && annotation.gtPolygonToolOpen)
          ? undefined
          : (panX, panY) => {
              updatePanelSetting(date, { panX, panY });
            }
      }
      onZoomChange={(zoom) => updatePanelSetting(date, { zoom })}
    >
      <OverlayAnnotationLayers
        comboId={comboId}
        date={date}
        series={series}
        settings={settings}
        effectiveSliceIndex={effectiveSliceIndex}
        imageSize={imageSize}
        annotation={annotation}
        nativeAnnotationsAvailable={nativeAnnotationsAvailable}
        isComparing={isComparing}
      />
    </DicomViewer>
  );
}

type OverlayComparePresentation = {
  isComparing: boolean;
  showSavedTumor: boolean;
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
  const { isComparing, showSavedTumor } = presentation;

  return (
    <div className={`absolute inset-0 ${isComparing ? 'opacity-100' : 'opacity-0 pointer-events-none'}`}>
      <DicomViewer
        studyId={series.study_id}
        seriesUid={series.series_uid}
        interactionBlocked={isComparing}
        instanceIndex={sliceIndex}
        instanceCount={series.instance_count}
        {...settings}
        onInstanceChange={(index) => {
          setProgress(getProgressFromSlice(index, series.instance_count, settings.offset));
        }}
        onPanChange={undefined}
        onZoomChange={undefined}
      >
        {nativeAnnotationsAvailable && showSavedTumor && isComparing ? (
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
      </DicomViewer>
    </div>
  );
}

function OverlayStudyFooter({
  presentation,
  instanceIndex,
  instanceCount,
  settings,
  onUpdate,
  onUseAcquired,
}: {
  presentation: { isComparing: boolean; isAligned: boolean };
  instanceIndex: number;
  instanceCount: number;
  settings: PanelSettings;
  onUpdate: (update: Partial<PanelSettings>) => void;
  onUseAcquired?: () => void;
}) {
  return (
    <div className="flex h-12 shrink-0 items-center justify-between gap-3 border-t border-[var(--border-color)] bg-[var(--bg-secondary)] px-3">
      {settings.alignmentPaused && !presentation.isComparing ? (
        <ResumeAlignmentAction onClick={() => onUpdate({ alignmentPaused: false })} />
      ) : presentation.isAligned && !presentation.isComparing && onUseAcquired ? (
        <AcquiredImageAction onClick={onUseAcquired} />
      ) : (
        <span className="truncate text-xs text-[var(--text-secondary)]">
          {presentation.isComparing
            ? 'Comparing examination'
            : presentation.isAligned
              ? 'Aligned presentation'
              : 'Acquired image'}
        </span>
      )}
      <div
        inert={presentation.isComparing}
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
  presentation: {
    isComparing: boolean;
    isAligned: boolean;
    alignmentPending: boolean;
    nativeAnnotationsAvailable: boolean;
  };
  annotation: {
    showSavedTumor: boolean;
    gtPolygonToolOpen: boolean;
    setShowSavedTumor: React.Dispatch<React.SetStateAction<boolean>>;
    setGtPolygonToolOpen: React.Dispatch<React.SetStateAction<boolean>>;
  };
  onUpdate: (update: Partial<PanelSettings>) => void;
}) {
  return (
    <div className="study-heading">
      <div className="study-heading-identity">
        <span className="study-date">{formatDate(date)}</span>
        {presentation.isAligned ? <AlignmentBadge adjusted={Boolean(settings.alignmentAdjustment)} /> : null}
      </div>

      <StudyTools disabled={presentation.isComparing} examinationLabel={formatDate(date)}>
        <StudyAnnotationControls {...annotation} nativeAnnotationsAvailable={presentation.nativeAnnotationsAvailable} />

        <fieldset disabled={presentation.alignmentPending} className="min-w-0 disabled:opacity-40">
          <ImageControls
            settings={settings}
            instanceIndex={instanceIndex}
            instanceCount={instanceCount}
            onUpdate={onUpdate}
            showSliceControl={false}
            isAligned={presentation.isAligned}
          />
        </fieldset>
      </StudyTools>
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
  onUseAcquired,
  updatePanelSetting,
  setProgress,
}: OverlayViewProps) {
  const [showSavedTumor, setShowSavedTumor] = useState(false);
  const [gtPolygonToolOpen, setGtPolygonToolOpen] = useState(false);
  const selectedImageSize = useMemo(
    () => ({ w: overlaySelectedRef?.columns ?? 512, h: overlaySelectedRef?.rows ?? 512 }),
    [overlaySelectedRef?.columns, overlaySelectedRef?.rows],
  );
  const compareImageSize = useMemo(
    () => ({ w: overlayCompareRef?.columns ?? 512, h: overlayCompareRef?.rows ?? 512 }),
    [overlayCompareRef?.columns, overlayCompareRef?.rows],
  );

  // Compare mode is read-only: ensure the outline tool isn't active.
  // We schedule the close to avoid calling setState synchronously inside the effect body.
  useEffect(() => {
    if (!isOverlayComparing) return;

    const t = window.setTimeout(() => {
      setGtPolygonToolOpen(false);
    }, 0);

    return () => window.clearTimeout(t);
  }, [isOverlayComparing]);

  // Note: the tool only operates on the *selected* date when not comparing.
  const selectedEffectiveSliceIndex =
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

  const selectedPresentation = useAlignedFrame(overlaySelectedRef?.series_uid ?? '', selectedEffectiveSliceIndex);
  const comparePresentation = useAlignedFrame(overlayCompareRef?.series_uid ?? '', compareEffectiveSliceIndex);
  const selectedDerivedFrame = selectedPresentation.frame;
  const compareDerivedFrame = comparePresentation.frame;
  const displayedPresentation = isOverlayComparing ? comparePresentation : selectedPresentation;
  const displayedDerivedFrame = displayedPresentation.frame;
  const displayedSliceIndex =
    displayedDerivedFrame && overlayDisplayedRef
      ? getEffectiveInstanceIndex(
          displayedDerivedFrame.instanceIndex,
          overlayDisplayedRef.instance_count,
          overlayDisplayedSettings.reverseSliceOrder,
        )
      : overlayDisplayedSliceIndex;
  const nativeAnnotationsAvailable = displayedDerivedFrame === null;

  return (
    <div className="flex min-h-0 min-w-0 flex-1 items-center justify-center overflow-hidden p-3">
      {overlayColumns.length === 0 ? (
        <div className="text-[var(--text-secondary)]">Select dates to view</div>
      ) : overlayDisplayedRef && overlayDisplayedDate ? (
        <div
          className="study-cell relative flex min-h-0 min-w-0 flex-col overflow-hidden rounded-[4px] border border-[var(--border-color)] bg-[var(--bg-primary)]"
          data-alignment-state={displayedDerivedFrame ? 'aligned' : 'acquired'}
          data-alignment-adjusted={Boolean(overlayDisplayedSettings.alignmentAdjustment) || undefined}
          data-alignment-paused={overlayDisplayedSettings.alignmentPaused || undefined}
          data-alignment-pending={displayedPresentation.pending || undefined}
          style={{ width: overlayViewerSize, height: overlayViewerSize + GRID_CELL_METADATA_HEIGHT }}
        >
          <OverlayStudyHeader
            date={overlayDisplayedDate}
            settings={overlayDisplayedSettings}
            instanceIndex={displayedSliceIndex}
            instanceCount={overlayDisplayedRef.instance_count}
            presentation={{
              isComparing: isOverlayComparing,
              isAligned: Boolean(displayedDerivedFrame),
              alignmentPending: displayedPresentation.pending,
              nativeAnnotationsAvailable,
            }}
            annotation={{
              showSavedTumor,
              gtPolygonToolOpen,
              setShowSavedTumor,
              setGtPolygonToolOpen,
            }}
            onUpdate={(update) => updatePanelSetting(overlayDisplayedDate, update)}
          />

          <div
            data-diagnostic-surface="true"
            className={`relative min-h-0 flex-1 bg-[var(--bg-primary)] ${nativeAnnotationsAvailable && !isOverlayComparing && gtPolygonToolOpen ? 'cursor-crosshair touch-none' : ''}`}
          >
            {/*
            Space compare should feel instant.

            Previously we updated a single viewer's series/settings on Space keydown.
            That can cause a brief visual "jerk" (old image + new transform/settings)
            while the new slice resolves/loads.

            To avoid that, we keep BOTH the selected date and the compare target mounted
            and simply toggle which one is visible.
          */}
            <div className={`absolute inset-0 ${isOverlayComparing ? 'opacity-0 pointer-events-none' : 'opacity-100'}`}>
              {overlaySelectedRef && overlaySelectedDate ? (
                <OverlaySelectedLayer
                  comboId={comboId}
                  study={{
                    date: overlaySelectedDate,
                    series: overlaySelectedRef,
                    settings: overlaySelectedSettings,
                    sliceIndex: overlaySelectedSliceIndex,
                    effectiveSliceIndex: selectedEffectiveSliceIndex,
                    imageSize: selectedImageSize,
                    nativeAnnotationsAvailable: !selectedDerivedFrame,
                  }}
                  annotation={{
                    showSavedTumor,
                    gtPolygonToolOpen,
                    closeGroundTruth: () => setGtPolygonToolOpen(false),
                  }}
                  isComparing={isOverlayComparing}
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
                  showSavedTumor,
                }}
                setProgress={setProgress}
              />
            ) : null}
          </div>

          <OverlayStudyFooter
            onUseAcquired={onUseAcquired ? () => onUseAcquired(overlayDisplayedDate) : undefined}
            presentation={{
              isComparing: isOverlayComparing,
              isAligned: Boolean(displayedDerivedFrame),
            }}
            instanceIndex={displayedSliceIndex}
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
