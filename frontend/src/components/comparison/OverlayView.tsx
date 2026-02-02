import { useEffect, useRef, useState } from 'react';
import { Loader2, Pencil, Sparkles } from 'lucide-react';
import type {
  AlignmentProgress,
  AlignmentReference,
  ExclusionMask,
  PanelSettings,
  SeriesRef,
} from '../../types/api';
import { formatDate } from '../../utils/format';
import { getEffectiveInstanceIndex, getProgressFromSlice } from '../../utils/math';
import { ImageControls } from '../ImageControls';
import { StepControl } from '../StepControl';
import { DragRectActionOverlay } from '../DragRectActionOverlay';
import { DicomViewer, type DicomViewerHandle } from '../DicomViewer';
import { GroundTruthPolygonOverlay } from '../GroundTruthPolygonOverlay';
import { TumorSegmentationOverlay } from '../TumorSegmentationOverlay';

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
  const [tumorToolOpen, setTumorToolOpen] = useState(false);
  const [gtPolygonToolOpen, setGtPolygonToolOpen] = useState(false);
  const tumorViewerRef = useRef<DicomViewerHandle | null>(null);

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
          overlaySelectedSettings.reverseSliceOrder
        )
      : 0;

  return (
    <div className="flex-1 flex items-center justify-center p-4">
      {overlayColumns.length === 0 ? (
        <div className="text-[var(--text-secondary)]">Select dates to view</div>
      ) : overlayDisplayedRef && overlayDisplayedDate ? (
        <div
          className="relative rounded-lg overflow-hidden border border-[var(--border-color)] cursor-crosshair"
          style={{ width: overlayViewerSize, height: overlayViewerSize }}
          onMouseEnter={() => setIsOverlayViewerHovered(true)}
          onMouseLeave={() => setIsOverlayViewerHovered(false)}
        >
          {/* Cell controls (shown on hover, matches grid cell style) */}
          <div
            className={`absolute top-0 left-0 right-0 z-10 transition-opacity ${
              isOverlayComparing
                ? 'opacity-70 pointer-events-none'
                : isOverlayViewerHovered
                ? 'opacity-100 pointer-events-auto'
                : 'opacity-0 pointer-events-none'
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
                settings={overlayDisplayedSettings}
                instanceIndex={overlayDisplayedSliceIndex}
                instanceCount={overlayDisplayedRef.instance_count}
                onUpdate={(update) => {
                  updatePanelSetting(overlayDisplayedDate, update);
                }}
                showSliceControl={false}
              />
            </div>
          </div>

          {/* Slice selector (shown on hover, bottom-right corner, matches grid cell style) */}
          <div
            className={`absolute bottom-2 right-2 z-10 transition-opacity ${
              isOverlayComparing
                ? 'opacity-70 pointer-events-none'
                : isOverlayViewerHovered
                ? 'opacity-100 pointer-events-auto'
                : 'opacity-0 pointer-events-none'
            }`}
          >
            <div className="px-2 py-1 rounded bg-[var(--bg-secondary)]/90 backdrop-blur border border-[var(--border-color)]">
              <StepControl
                title="Slice offset"
                value={`${overlayDisplayedSliceIndex + 1}/${overlayDisplayedRef.instance_count}`}
                valueWidth="w-16"
                tabular
                accent
                onDecrement={() => {
                  updatePanelSetting(overlayDisplayedDate, { offset: overlayDisplayedSettings.offset - 1 });
                }}
                onIncrement={() => {
                  updatePanelSetting(overlayDisplayedDate, { offset: overlayDisplayedSettings.offset + 1 });
                }}
              />
            </div>
          </div>

          <DragRectActionOverlay
            className="absolute inset-0 cursor-crosshair"
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
            disabled={overlayColumns.length < 2 || isAligning || isOverlayComparing || tumorToolOpen || gtPolygonToolOpen}
            onConfirm={(mask) => {
              void startAlignAll(
                {
                  date: overlayDisplayedDate,
                  seriesUid: overlayDisplayedRef.series_uid,
                  sliceIndex: overlayDisplayedEffectiveSliceIndex,
                  sliceCount: overlayDisplayedRef.instance_count,
                  settings: overlayDisplayedSettings,
                },
                mask
              );
            }}
            actionTitle={`Align all other dates to ${formatDate(overlayDisplayedDate)}`}
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
                  instanceIndex={overlaySelectedSliceIndex}
                  instanceCount={overlaySelectedRef.instance_count}
                  reverseSliceOrder={overlaySelectedSettings.reverseSliceOrder}
                  onInstanceChange={(i) => {
                    setProgress(
                      getProgressFromSlice(i, overlaySelectedRef.instance_count, overlaySelectedSettings.offset)
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
                />

                  <TumorSegmentationOverlay
                    enabled={tumorToolOpen && !isOverlayComparing}
                    onRequestClose={() => setTumorToolOpen(false)}
                    viewerRef={tumorViewerRef}
                    comboId={comboId}
                    dateIso={overlaySelectedDate}
                    studyId={overlaySelectedRef.study_id}
                    seriesUid={overlaySelectedRef.series_uid}
                    effectiveInstanceIndex={tumorEffectiveSliceIndex}
                    viewerTransform={overlaySelectedSettings}
                  />

                  <GroundTruthPolygonOverlay
                    enabled={gtPolygonToolOpen && !isOverlayComparing}
                    onRequestClose={() => setGtPolygonToolOpen(false)}
                    comboId={comboId}
                    dateIso={overlaySelectedDate}
                    studyId={overlaySelectedRef.study_id}
                    seriesUid={overlaySelectedRef.series_uid}
                    effectiveInstanceIndex={tumorEffectiveSliceIndex}
                    viewerTransform={overlaySelectedSettings}
                  />
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
                  instanceIndex={overlayCompareSliceIndex}
                  instanceCount={overlayCompareRef.instance_count}
                  reverseSliceOrder={overlayCompareSettings.reverseSliceOrder}
                  onInstanceChange={(i) => {
                    setProgress(
                      getProgressFromSlice(i, overlayCompareRef.instance_count, overlayCompareSettings.offset)
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
                />
              </div>
            ) : null}

            {isAligning && alignmentProgress && (
              <div className="absolute inset-0 flex items-center justify-center bg-black/40">
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
                        {alignmentProgress.slicesChecked} slices · Score {alignmentProgress.bestMiSoFar.toFixed(3)}
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

            {/* Date overlay (matches grid cell style) */}
            <div className="absolute bottom-2 left-2 px-2 py-1 bg-black/70 rounded text-white text-xs font-medium pointer-events-none">
              {formatDate(overlayDisplayedDate)}
            </div>
          </DragRectActionOverlay>
        </div>
      ) : (
        <div className="text-[var(--text-secondary)]">No data</div>
      )}
    </div>
  );
}
