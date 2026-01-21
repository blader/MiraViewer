import { useState } from 'react';
import { Loader2 } from 'lucide-react';
import type {
  AiSeriesContext,
  AlignmentProgress,
  AlignmentReference,
  ExclusionMask,
  NanoStatus,
  PanelSettings,
  SeriesRef,
} from '../../types/api';
import { formatDate } from '../../utils/format';
import { getProgressFromSlice } from '../../utils/math';
import { AI_ENABLED } from '../../utils/constants';
import { ImageControls } from '../ImageControls';
import { StepControl } from '../StepControl';
import { DragRectActionOverlay } from '../DragRectActionOverlay';
import { DicomViewer, type DicomViewerHandle } from '../DicomViewer';

export type OverlayViewProps = {
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

  registerViewerHandle: (key: string, handle: DicomViewerHandle | null) => void;

  aiSeriesContext: AiSeriesContext;
  handleAiButtonClick: (
    target: { date: string; studyId: string; seriesUid: string; instanceIndex: number },
    viewerKey: string,
    seriesContext: AiSeriesContext
  ) => void;

  isNanoTarget: (date: string, seriesUid: string, instanceIndex: number) => boolean;

  nanoBananaStatus: NanoStatus;
  nanoBananaProgressText?: string | null;
  clearNanoBanana: () => void;

  overlayIsNanoBananaTarget: boolean;
  overlaySelectedNanoBananaOverrideUrl?: string;
  overlayCompareNanoBananaOverrideUrl?: string;
  overlayDisplayedNanoBananaOverrideUrl?: string;
};

export function OverlayView({
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
  registerViewerHandle,
  aiSeriesContext,
  handleAiButtonClick,
  isNanoTarget,
  nanoBananaStatus,
  nanoBananaProgressText,
  clearNanoBanana,
  overlayIsNanoBananaTarget,
  overlaySelectedNanoBananaOverrideUrl,
  overlayCompareNanoBananaOverrideUrl,
  overlayDisplayedNanoBananaOverrideUrl,
}: OverlayViewProps) {
  const [isOverlayViewerHovered, setIsOverlayViewerHovered] = useState(false);

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
            <div className="px-2 py-1 text-xs bg-[var(--bg-secondary)]/90 backdrop-blur border-b border-[var(--border-color)] flex items-center justify-end">
              <ImageControls
                settings={overlayDisplayedSettings}
                instanceIndex={overlayDisplayedSliceIndex}
                instanceCount={overlayDisplayedRef.instance_count}
                onUpdate={(update) => {
                  const isOverlayTarget =
                    nanoBananaStatus !== 'idle' &&
                    isNanoTarget(
                      overlayDisplayedDate,
                      overlayDisplayedRef.series_uid,
                      overlayDisplayedSliceIndex
                    );

                  if (isOverlayTarget) {
                    clearNanoBanana();
                  }

                  updatePanelSetting(overlayDisplayedDate, update);
                }}
                onAcpAnalyze={
                  AI_ENABLED
                    ? () => {
                        handleAiButtonClick(
                          {
                            date: overlayDisplayedDate,
                            studyId: overlayDisplayedRef.study_id,
                            seriesUid: overlayDisplayedRef.series_uid,
                            instanceIndex: overlayDisplayedEffectiveSliceIndex,
                          },
                          'overlay',
                          aiSeriesContext
                        );
                      }
                    : undefined
                }
                acpAnalyzeDisabled={!AI_ENABLED || nanoBananaStatus === 'loading'}
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
                  if (nanoBananaStatus !== 'idle' && overlayIsNanoBananaTarget) {
                    clearNanoBanana();
                  }
                  updatePanelSetting(overlayDisplayedDate, { offset: overlayDisplayedSettings.offset - 1 });
                }}
                onIncrement={() => {
                  if (nanoBananaStatus !== 'idle' && overlayIsNanoBananaTarget) {
                    clearNanoBanana();
                  }
                  updatePanelSetting(overlayDisplayedDate, { offset: overlayDisplayedSettings.offset + 1 });
                }}
              />
            </div>
          </div>

          <DragRectActionOverlay
            className="absolute inset-0 cursor-crosshair"
            geometry={
              overlayDisplayedNanoBananaOverrideUrl
                ? { panX: 0, panY: 0, zoom: 1, rotation: 0, affine00: 1, affine01: 0, affine10: 0, affine11: 1 }
                : {
                    panX: overlayDisplayedSettings.panX,
                    panY: overlayDisplayedSettings.panY,
                    zoom: overlayDisplayedSettings.zoom,
                    rotation: overlayDisplayedSettings.rotation,
                    affine00: overlayDisplayedSettings.affine00,
                    affine01: overlayDisplayedSettings.affine01,
                    affine10: overlayDisplayedSettings.affine10,
                    affine11: overlayDisplayedSettings.affine11,
                  }
            }
            disabled={overlayColumns.length < 2 || isAligning || isOverlayComparing}
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
                <DicomViewer
                  ref={(handle) => registerViewerHandle('overlay', handle)}
                  // Important: do not key by series/date.
                  // Remounting the viewer forces Cornerstone to re-enable the element,
                  // which causes a visible black flash when toggling dates.
                  studyId={overlaySelectedRef.study_id}
                  seriesUid={overlaySelectedRef.series_uid}
                  instanceIndex={overlaySelectedSliceIndex}
                  instanceCount={overlaySelectedRef.instance_count}
                  reverseSliceOrder={overlaySelectedSettings.reverseSliceOrder}
                  imageUrlOverride={overlaySelectedNanoBananaOverrideUrl}
                  onInstanceChange={(i) => {
                    setProgress(
                      getProgressFromSlice(i, overlaySelectedRef.instance_count, overlaySelectedSettings.offset)
                    );
                  }}
                  brightness={overlaySelectedNanoBananaOverrideUrl ? 100 : overlaySelectedSettings.brightness}
                  contrast={overlaySelectedNanoBananaOverrideUrl ? 100 : overlaySelectedSettings.contrast}
                  zoom={overlaySelectedNanoBananaOverrideUrl ? 1 : overlaySelectedSettings.zoom}
                  rotation={overlaySelectedNanoBananaOverrideUrl ? 0 : overlaySelectedSettings.rotation}
                  panX={overlaySelectedNanoBananaOverrideUrl ? 0 : overlaySelectedSettings.panX}
                  panY={overlaySelectedNanoBananaOverrideUrl ? 0 : overlaySelectedSettings.panY}
                  affine00={overlaySelectedNanoBananaOverrideUrl ? 1 : overlaySelectedSettings.affine00}
                  affine01={overlaySelectedNanoBananaOverrideUrl ? 0 : overlaySelectedSettings.affine01}
                  affine10={overlaySelectedNanoBananaOverrideUrl ? 0 : overlaySelectedSettings.affine10}
                  affine11={overlaySelectedNanoBananaOverrideUrl ? 1 : overlaySelectedSettings.affine11}
                  onPanChange={
                    overlaySelectedNanoBananaOverrideUrl || isOverlayComparing
                      ? undefined
                      : (newPanX, newPanY) => {
                          updatePanelSetting(overlaySelectedDate, { panX: newPanX, panY: newPanY });
                        }
                  }
                />
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
                  imageUrlOverride={overlayCompareNanoBananaOverrideUrl}
                  onInstanceChange={(i) => {
                    setProgress(
                      getProgressFromSlice(i, overlayCompareRef.instance_count, overlayCompareSettings.offset)
                    );
                  }}
                  brightness={overlayCompareNanoBananaOverrideUrl ? 100 : overlayCompareSettings.brightness}
                  contrast={overlayCompareNanoBananaOverrideUrl ? 100 : overlayCompareSettings.contrast}
                  zoom={overlayCompareNanoBananaOverrideUrl ? 1 : overlayCompareSettings.zoom}
                  rotation={overlayCompareNanoBananaOverrideUrl ? 0 : overlayCompareSettings.rotation}
                  panX={overlayCompareNanoBananaOverrideUrl ? 0 : overlayCompareSettings.panX}
                  panY={overlayCompareNanoBananaOverrideUrl ? 0 : overlayCompareSettings.panY}
                  affine00={overlayCompareNanoBananaOverrideUrl ? 1 : overlayCompareSettings.affine00}
                  affine01={overlayCompareNanoBananaOverrideUrl ? 0 : overlayCompareSettings.affine01}
                  affine10={overlayCompareNanoBananaOverrideUrl ? 0 : overlayCompareSettings.affine10}
                  affine11={overlayCompareNanoBananaOverrideUrl ? 1 : overlayCompareSettings.affine11}
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

            {AI_ENABLED && nanoBananaStatus === 'loading' && overlayIsNanoBananaTarget && (
              <div className="absolute top-2 right-2 max-w-[70%]">
                <div className="flex items-center gap-2 px-2 py-1 rounded bg-black/60">
                  <div className="w-5 h-5 border-2 border-[var(--accent)] border-t-transparent rounded-full animate-spin" />
                  <div className="text-[10px] text-white/90 truncate">{nanoBananaProgressText || 'Working…'}</div>
                </div>
              </div>
            )}

            {AI_ENABLED && nanoBananaStatus === 'ready' && overlayIsNanoBananaTarget && (
              <button
                type="button"
                onClick={clearNanoBanana}
                className="absolute top-2 right-2 px-2 py-1 rounded bg-black/70 text-white text-[10px] hover:bg-black/80"
                title="Clear AI annotation"
              >
                Clear AI
              </button>
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
