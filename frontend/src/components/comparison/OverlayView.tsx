import { Suspense, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { Link2, Loader2, Pencil, ScanLine } from 'lucide-react';
import type { AlignmentProgress, AlignmentReference, ExclusionMask, PanelSettings, SeriesRef } from '../../types/api';
import { formatDate } from '../../utils/format';
import { getEffectiveInstanceIndex, getProgressFromSlice } from '../../utils/math';
import { ImageControls } from '../ImageControls';
import { StepControl } from '../StepControl';
import { DragRectActionOverlay } from '../DragRectActionOverlay';
import { DicomViewer, type DicomViewerHandle } from '../DicomViewer';
import { getDerivedAlignmentFrame, subscribeToDerivedAlignmentFrames } from '../../utils/derivedAlignmentFrame';
import { GRID_CELL_METADATA_HEIGHT } from '../../utils/constants';
import {
  GroundTruthPolygonOverlay,
  TumorSavedSegmentationOverlay,
  TumorSegmentationOverlay,
} from './LazyStudyOverlays';

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
          <div className="flex h-12 shrink-0 items-center gap-3 border-b border-[var(--border-color)] bg-[var(--bg-secondary)] px-3">
            <div className="flex shrink-0 items-center gap-2">
              <span className="font-[family-name:var(--font-mono)] text-xs tabular-nums text-[var(--text-primary)]">
                {formatDate(overlayDisplayedDate)}
              </span>
              {displayedDerivedFrame ? (
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

            <div
              inert={isOverlayComparing}
              className={`ml-auto flex min-w-0 items-center gap-2 overflow-x-auto transition-opacity duration-100 ${
                isOverlayComparing ? 'pointer-events-none opacity-40' : 'study-controls'
              }`}
            >
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
                settings={overlayDisplayedSettings}
                instanceIndex={overlayDisplayedSliceIndex}
                instanceCount={overlayDisplayedRef.instance_count}
                onUpdate={(update) => updatePanelSetting(overlayDisplayedDate, update)}
                showSliceControl={false}
              />
            </div>
          </div>

          <div
            ref={overlayCellRef}
            data-diagnostic-surface="true"
            className="relative min-h-0 flex-1 bg-[var(--bg-primary)]"
          >
            <DragRectActionOverlay
              className="absolute inset-0 cursor-crosshair"
              imageSize={{ width: overlayDisplayedRef.columns ?? 512, height: overlayDisplayedRef.rows ?? 512 }}
              geometry={{
                panX: overlayDisplayedSettings.panX,
                panY: overlayDisplayedSettings.panY,
                zoom: overlayDisplayedSettings.zoom,
                rotation: overlayDisplayedSettings.rotation,
                affine00: overlayDisplayedSettings.affine00,
                affine01: overlayDisplayedSettings.affine01,
                affine10: overlayDisplayedSettings.affine10,
                affine11: overlayDisplayedSettings.affine11,
              }}
              disabled={isAligning || isOverlayComparing || gtPolygonToolOpen}
              actions={[
                {
                  key: 'align-all',
                  label: 'Align All',
                  title: `Align all other dates to ${formatDate(overlayDisplayedDate)}`,
                  icon: <Link2 className="w-4 h-4" />,
                  variant: 'primary',
                  minSizeSpace: 'base',
                  disabled: overlayColumns.length < 2 || isAligning,
                  onConfirm: (masks) => {
                    const bounds = overlayCellRef.current?.getBoundingClientRect();
                    void startAlignAll(
                      {
                        date: overlayDisplayedDate,
                        seriesUid: overlayDisplayedRef.series_uid,
                        sliceIndex: overlayDisplayedEffectiveSliceIndex,
                        sliceCount: overlayDisplayedRef.instance_count,
                        patientKey: overlayDisplayedRef.patient_key,
                        studyUid: overlayDisplayedRef.study_uid ?? overlayDisplayedRef.study_id,
                        frameOfReferenceUid: overlayDisplayedRef.frame_of_reference_uid,
                        imageSize: {
                          width: overlayDisplayedRef.columns ?? 512,
                          height: overlayDisplayedRef.rows ?? 512,
                        },
                        viewportSize:
                          bounds && bounds.width > 0 && bounds.height > 0
                            ? { width: bounds.width, height: bounds.height }
                            : undefined,
                        settings: overlayDisplayedSettings,
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
                  disabled: isAligning || isOverlayComparing || !nativeAnnotationsAvailable,
                  onConfirm: (masks) => {
                    setTumorToolOpen(true);
                    setTumorSeedBoxToStart({
                      x0: masks.screen.x,
                      y0: masks.screen.y,
                      x1: masks.screen.x + masks.screen.width,
                      y1: masks.screen.y + masks.screen.height,
                    });
                    setGtPolygonToolOpen(false);
                  },
                },
              ]}
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
                  <>
                    <DicomViewer
                      ref={tumorViewerRef}
                      // Important: do not key by series/date.
                      // Remounting the viewer forces Cornerstone to re-enable the element,
                      // which causes a visible black flash when toggling dates.
                      studyId={overlaySelectedRef.study_id}
                      seriesUid={overlaySelectedRef.series_uid}
                      interactionBlocked={isAligning}
                      instanceIndex={overlaySelectedSliceIndex}
                      instanceCount={overlaySelectedRef.instance_count}
                      reverseSliceOrder={overlaySelectedSettings.reverseSliceOrder}
                      onInstanceChange={(i) => {
                        setProgress(
                          getProgressFromSlice(i, overlaySelectedRef.instance_count, overlaySelectedSettings.offset),
                        );
                      }}
                      brightness={overlaySelectedSettings.brightness}
                      contrast={overlaySelectedSettings.contrast}
                      zoom={overlaySelectedSettings.zoom}
                      rotation={overlaySelectedSettings.rotation}
                      panX={overlaySelectedSettings.panX}
                      panY={overlaySelectedSettings.panY}
                      affine00={overlaySelectedSettings.affine00}
                      affine01={overlaySelectedSettings.affine01}
                      affine10={overlaySelectedSettings.affine10}
                      affine11={overlaySelectedSettings.affine11}
                      onPanChange={
                        isOverlayComparing
                          ? undefined
                          : (newPanX, newPanY) => {
                              updatePanelSetting(overlaySelectedDate, { panX: newPanX, panY: newPanY });
                            }
                      }
                      onZoomChange={(newZoom) => {
                        updatePanelSetting(overlaySelectedDate, { zoom: newZoom });
                      }}
                    />

                    <Suspense fallback={null}>
                      {!selectedDerivedFrame && showSavedTumor && !tumorToolOpen && !isOverlayComparing ? (
                        <TumorSavedSegmentationOverlay
                          enabled
                          seriesUid={overlaySelectedRef.series_uid}
                          effectiveInstanceIndex={tumorEffectiveSliceIndex}
                          viewerTransform={overlaySelectedSettings}
                          imageSize={selectedImageSize}
                        />
                      ) : null}

                      {!selectedDerivedFrame && tumorToolOpen && !isOverlayComparing ? (
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
                          dateIso={overlaySelectedDate}
                          studyId={overlaySelectedRef.study_id}
                          seriesUid={overlaySelectedRef.series_uid}
                          effectiveInstanceIndex={tumorEffectiveSliceIndex}
                          viewerTransform={overlaySelectedSettings}
                        />
                      ) : null}

                      {!selectedDerivedFrame && gtPolygonToolOpen && !isOverlayComparing ? (
                        <GroundTruthPolygonOverlay
                          enabled
                          onRequestClose={() => setGtPolygonToolOpen(false)}
                          comboId={comboId}
                          dateIso={overlaySelectedDate}
                          studyId={overlaySelectedRef.study_id}
                          seriesUid={overlaySelectedRef.series_uid}
                          effectiveInstanceIndex={tumorEffectiveSliceIndex}
                          viewerTransform={overlaySelectedSettings}
                          imageSize={selectedImageSize}
                        />
                      ) : null}
                    </Suspense>
                  </>
                ) : null}
              </div>

              {hasOverlayCompareTarget && overlayCompareRef && overlayCompareDate ? (
                <div
                  className={`absolute inset-0 ${isOverlayComparing ? 'opacity-100' : 'opacity-0 pointer-events-none'}`}
                >
                  <DicomViewer
                    studyId={overlayCompareRef.study_id}
                    seriesUid={overlayCompareRef.series_uid}
                    interactionBlocked={isAligning}
                    instanceIndex={overlayCompareSliceIndex}
                    instanceCount={overlayCompareRef.instance_count}
                    reverseSliceOrder={overlayCompareSettings.reverseSliceOrder}
                    onInstanceChange={(i) => {
                      setProgress(
                        getProgressFromSlice(i, overlayCompareRef.instance_count, overlayCompareSettings.offset),
                      );
                    }}
                    brightness={overlayCompareSettings.brightness}
                    contrast={overlayCompareSettings.contrast}
                    zoom={overlayCompareSettings.zoom}
                    rotation={overlayCompareSettings.rotation}
                    panX={overlayCompareSettings.panX}
                    panY={overlayCompareSettings.panY}
                    affine00={overlayCompareSettings.affine00}
                    affine01={overlayCompareSettings.affine01}
                    affine10={overlayCompareSettings.affine10}
                    affine11={overlayCompareSettings.affine11}
                    // Compare mode is read-only for geometry edits.
                    onPanChange={undefined}
                    onZoomChange={(newZoom) => {
                      updatePanelSetting(overlayCompareDate, { zoom: newZoom });
                    }}
                  />

                  {!compareDerivedFrame && showSavedTumor && !tumorToolOpen && isOverlayComparing ? (
                    <Suspense fallback={null}>
                      <TumorSavedSegmentationOverlay
                        enabled
                        seriesUid={overlayCompareRef.series_uid}
                        effectiveInstanceIndex={compareEffectiveSliceIndex}
                        viewerTransform={overlayCompareSettings}
                        imageSize={compareImageSize}
                      />
                    </Suspense>
                  ) : null}
                </div>
              ) : null}

              {isAligning && alignmentProgress && (
                <div className="absolute inset-0 flex items-center justify-center bg-black/40">
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
            </DragRectActionOverlay>
          </div>

          <div className="flex h-12 shrink-0 items-center justify-between gap-3 border-t border-[var(--border-color)] bg-[var(--bg-secondary)] px-3">
            <span className="truncate text-xs text-[var(--text-secondary)]">
              {isOverlayComparing
                ? 'Comparing examination'
                : displayedDerivedFrame
                  ? 'Aligned presentation'
                  : 'Acquired image'}
            </span>
            <div inert={isOverlayComparing} className={isOverlayComparing ? 'pointer-events-none opacity-40' : ''}>
              <StepControl
                title="Slice offset"
                value={`${overlayDisplayedSliceIndex + 1}/${overlayDisplayedRef.instance_count}`}
                valueWidth="w-16"
                tabular
                accent
                onDecrement={() =>
                  updatePanelSetting(overlayDisplayedDate, { offset: overlayDisplayedSettings.offset - 1 })
                }
                onIncrement={() =>
                  updatePanelSetting(overlayDisplayedDate, { offset: overlayDisplayedSettings.offset + 1 })
                }
              />
            </div>
          </div>
        </div>
      ) : (
        <div className="text-[var(--text-secondary)]">No data</div>
      )}
    </div>
  );
}
