import { Suspense, useMemo, useState } from 'react';
import type { PanelSettings, SeriesRef } from '../../types/api';
import { formatDate } from '../../utils/format';
import { getSliceIndex, getEffectiveInstanceIndex, getProgressFromSlice } from '../../utils/math';
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
import { GroundTruthPolygonOverlay, TumorSavedSegmentationOverlay } from './LazyStudyOverlays';

export type GridCellProps = {
  comboId: string;
  date: string;
  refData: SeriesRef | undefined;
  settings: PanelSettings;
  progress: number;
  setProgress: (next: number) => void;
  updatePanelSetting: (date: string, update: Partial<PanelSettings>) => void;

  onUseAcquired?: (date: string) => void;
};

export function GridCell({
  comboId,
  date,
  refData,
  settings,
  progress,
  setProgress,
  updatePanelSetting,
  onUseAcquired,
}: GridCellProps) {
  const [showSavedTumor, setShowSavedTumor] = useState(false);
  const [gtPolygonToolOpen, setGtPolygonToolOpen] = useState(false);
  const nativeImageSize = useMemo(
    () => ({ w: refData?.columns ?? 512, h: refData?.rows ?? 512 }),
    [refData?.columns, refData?.rows],
  );
  const idx = refData ? getSliceIndex(refData.instance_count, progress, settings.offset) : 0;
  const effectiveIdx = refData ? getEffectiveInstanceIndex(idx, refData.instance_count, settings.reverseSliceOrder) : 0;
  const { frame: derivedFrame, pending: alignmentPending } = useAlignedFrame(refData?.series_uid ?? '', effectiveIdx);
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
      data-alignment-adjusted={Boolean(settings.alignmentAdjustment) || undefined}
      data-alignment-paused={settings.alignmentPaused || undefined}
      data-alignment-pending={alignmentPending || undefined}
      className="study-cell relative flex min-h-0 min-w-0 flex-col overflow-hidden rounded-[4px] border border-[var(--border-color)] bg-[var(--bg-primary)]"
    >
      <div className="study-heading">
        <div className="study-heading-identity">
          <span className="study-date">{formatDate(date)}</span>
          {derivedFrame ? <AlignmentBadge adjusted={Boolean(settings.alignmentAdjustment)} /> : null}
        </div>

        <StudyTools examinationLabel={formatDate(date)}>
          <StudyAnnotationControls
            showSavedTumor={showSavedTumor}
            gtPolygonToolOpen={gtPolygonToolOpen}
            nativeAnnotationsAvailable={nativeAnnotationsAvailable}
            setShowSavedTumor={setShowSavedTumor}
            setGtPolygonToolOpen={setGtPolygonToolOpen}
          />

          <fieldset disabled={alignmentPending} className="min-w-0 disabled:opacity-40">
            <ImageControls
              settings={settings}
              instanceIndex={idx}
              instanceCount={refData.instance_count}
              onUpdate={(update) => updatePanelSetting(date, update)}
              showSliceControl={false}
              isAligned={Boolean(derivedFrame)}
            />
          </fieldset>
        </StudyTools>
      </div>

      <div
        data-diagnostic-surface="true"
        className={`relative min-h-0 flex-1 bg-[var(--bg-primary)] ${nativeAnnotationsAvailable && gtPolygonToolOpen ? 'cursor-crosshair touch-none' : ''}`}
      >
        <DicomViewer
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
          onPanChange={
            nativeAnnotationsAvailable && gtPolygonToolOpen
              ? undefined
              : (newPanX, newPanY) => {
                  updatePanelSetting(date, { panX: newPanX, panY: newPanY });
                }
          }
          onZoomChange={(newZoom) => {
            updatePanelSetting(date, { zoom: newZoom });
          }}
        >
          <Suspense fallback={null}>
            {nativeAnnotationsAvailable && showSavedTumor ? (
              <TumorSavedSegmentationOverlay
                enabled
                seriesUid={refData.series_uid}
                effectiveInstanceIndex={effectiveIdx}
                viewerTransform={settings}
                imageSize={nativeImageSize}
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
        </DicomViewer>
      </div>

      <div className="flex h-12 shrink-0 items-center justify-between gap-1 border-t border-[var(--border-color)] bg-[var(--bg-secondary)] px-2">
        {settings.alignmentPaused ? (
          <ResumeAlignmentAction onClick={() => updatePanelSetting(date, { alignmentPaused: false })} />
        ) : derivedFrame && onUseAcquired ? (
          <AcquiredImageAction onClick={() => onUseAcquired(date)} />
        ) : (
          <span
            className="truncate text-xs text-[var(--text-secondary)]"
            title={derivedFrame ? 'Aligned presentation' : 'Acquired image'}
          >
            {derivedFrame ? 'Aligned' : 'Acquired'}
          </span>
        )}
        <div>
          <StepControl
            title="Slice offset"
            value={`${(derivedFrame ? getEffectiveInstanceIndex(derivedFrame.instanceIndex, refData.instance_count, settings.reverseSliceOrder) : idx) + 1}/${refData.instance_count}`}
            valueWidth="w-14"
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
