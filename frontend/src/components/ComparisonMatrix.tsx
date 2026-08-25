import { lazy, Suspense, useCallback } from 'react';
import type { AlignmentProgress, AlignmentReference, ComparisonData, ExclusionMask, PanelSettings } from '../types/api';
import { Upload } from 'lucide-react';
import { HelpModal } from './HelpModal';
import { UploadModal } from './UploadModal';
import { ExportModal } from './ExportModal';
import { ClearDataModal } from './ClearDataModal';
import { SliceLoopNavigator } from './comparison/SliceLoopNavigator';
import { GridView } from './comparison/GridView';
import { OverlayView } from './comparison/OverlayView';
import { ComparisonFiltersSidebar } from './comparison/ComparisonFiltersSidebar';
import { ComparisonDatesSidebar } from './comparison/ComparisonDatesSidebar';
import { ComparisonInstrumentHeader } from './comparison/ComparisonInstrumentHeader';
import { useComparisonData } from '../hooks/useComparisonData';
import { useComparisonFilters } from '../hooks/useComparisonFilters';
import { useComparisonInstrumentUi } from '../hooks/useComparisonInstrumentUi';
import { useComparisonSequenceAvailability } from '../hooks/useComparisonSequenceAvailability';
import { useComparisonWorkspaceNavigation } from '../hooks/useComparisonWorkspaceNavigation';
import { usePanelSettings } from '../hooks/usePanelSettings';
import { useAutoAlign } from '../hooks/useAutoAlign';
import { useApplyAlignmentResults } from '../hooks/useApplyAlignmentResults';
const Svr3DView = lazy(() => import('./Svr3DView').then((module) => ({ default: module.Svr3DView })));

type ComparisonStageProps = {
  data: ComparisonData | null;
  selectedSeqId: string | null;
  hasData: boolean;
  navigation: ReturnType<typeof useComparisonWorkspaceNavigation>;
  panel: {
    settings: Map<string, PanelSettings>;
    progress: number;
    setProgress: (progress: number) => void;
    updateSetting: (date: string, update: Partial<PanelSettings>) => void;
  };
  alignment: {
    active: boolean;
    progress: AlignmentProgress | null;
    abort: () => void;
    start: (reference: AlignmentReference, exclusionMask: ExclusionMask) => Promise<void>;
  };
  onOpenUpload: () => void;
};

function ComparisonStage({
  data,
  selectedSeqId,
  hasData,
  navigation,
  panel,
  alignment,
  onOpenUpload,
}: ComparisonStageProps) {
  const { setCenterPaneRef } = navigation;

  return (
    <div ref={setCenterPaneRef} className="instrument-stage relative flex min-w-0 flex-1 flex-col overflow-hidden">
      {!hasData || !data || !selectedSeqId ? (
        <div className="instrument-empty">
          <div className="instrument-empty-inner">
            <p className="instrument-eyebrow">Private imaging workspace</p>
            <h2 className="instrument-empty-heading">Bring your scans into Mira.</h2>
            <p className="instrument-empty-copy">
              Import your MRI examinations to view and compare acquired images over time.
            </p>
            <button type="button" onClick={onOpenUpload} className="instrument-primary-button">
              <Upload className="h-4 w-4" aria-hidden="true" />
              Import scans
            </button>
            <p className="instrument-empty-disclosure">Your images stay on this device.</p>
          </div>
        </div>
      ) : navigation.viewMode === 'grid' ? (
        <GridView
          comboId={selectedSeqId}
          columns={navigation.columns}
          gridCols={navigation.gridCols}
          gridCellSize={navigation.gridCellSize}
          panelSettings={panel.settings}
          progress={panel.progress}
          setProgress={panel.setProgress}
          updatePanelSetting={panel.updateSetting}
          overlayColumns={navigation.overlayColumns}
          isAligning={alignment.active}
          alignmentProgress={alignment.progress}
          abortAlignment={alignment.abort}
          startAlignAll={alignment.start}
        />
      ) : navigation.viewMode === 'overlay' ? (
        <OverlayView
          comboId={selectedSeqId}
          overlayColumns={navigation.overlayColumns}
          overlayViewerSize={navigation.overlayViewerSize}
          overlayDisplayedRef={navigation.overlayDisplayedRef}
          overlayDisplayedDate={navigation.overlayDisplayedDate}
          overlayDisplayedSettings={navigation.overlayDisplayedSettings}
          overlayDisplayedSliceIndex={navigation.overlayDisplayedSliceIndex}
          overlayDisplayedEffectiveSliceIndex={navigation.overlayDisplayedEffectiveSliceIndex}
          overlaySelectedRef={navigation.overlaySelectedRef}
          overlaySelectedDate={navigation.overlaySelectedDate}
          overlaySelectedSettings={navigation.overlaySelectedSettings}
          overlaySelectedSliceIndex={navigation.overlaySelectedSliceIndex}
          overlayCompareRef={navigation.overlayCompareRef}
          overlayCompareDate={navigation.overlayCompareDate}
          overlayCompareSettings={navigation.overlayCompareSettings}
          overlayCompareSliceIndex={navigation.overlayCompareSliceIndex}
          isOverlayComparing={navigation.isOverlayComparing}
          hasOverlayCompareTarget={navigation.hasOverlayCompareTarget}
          isAligning={alignment.active}
          alignmentProgress={alignment.progress}
          abortAlignment={alignment.abort}
          updatePanelSetting={panel.updateSetting}
          startAlignAll={alignment.start}
          setProgress={panel.setProgress}
        />
      ) : (
        <Suspense
          fallback={
            <div className="flex h-full items-center justify-center text-sm text-[var(--text-secondary)]">
              Loading 3D reconstruction…
            </div>
          }
        >
          <Svr3DView
            key={data.selected_patient_key ?? 'selected-patient'}
            data={data}
            defaultDateIso={navigation.svr3dSeed.defaultDateIso}
            defaultSeqId={selectedSeqId}
            fallbackRoiSeriesUid={navigation.svr3dSeed.fallbackRoiSeriesUid}
            fallbackRoiSliceIndex={navigation.svr3dSeed.fallbackRoiSliceIndex}
          />
        </Suspense>
      )}
    </div>
  );
}

export function ComparisonMatrix() {
  const { data, loading, error, reload, selectPatient } = useComparisonData();
  const {
    availablePlanes,
    selectedPlane,
    selectedSeqId,
    enabledDates,
    enabledDatesKey,
    sortedDates,
    selectPlane,
    selectSequence,
    selectAllDates,
    selectNoDates,
    toggleDate,
  } = useComparisonFilters(data);

  const {
    isAligning,
    progress: alignmentProgress,
    results: alignmentResults,
    error: alignmentError,
    clearState: clearAlignmentState,
    alignAllDates,
    abort: abortAlignment,
  } = useAutoAlign();

  const {
    uiState,
    setUiState,
    sidebarOpen,
    rightSidebarOpen,
    alignmentOutputMode,
    setSidebarOpen,
    setRightSidebarOpen,
    activeDialog,
    setActiveDialog,
    headerMenuOpen,
    setHeaderMenuOpen,
    headerMenuRef,
    interactionBlocked,
  } = useComparisonInstrumentUi(isAligning);

  const {
    panelSettings,
    progress,
    setProgress,
    updatePanelSetting,
    batchUpdateSettings,
    persistenceError,
    clearPersistenceError,
    reportPersistenceError,
  } = usePanelSettings(selectedSeqId, enabledDatesKey, data?.selected_patient_key ?? null, isAligning);

  useApplyAlignmentResults({
    isAligning,
    alignmentResults,
    panelSettings,
    data,
    selectedSeqId,
    batchUpdateSettings,
    onPersistenceError: reportPersistenceError,
  });

  const { sequencesForPlane, sequencesWithDataForDates, datesWithDataForSequence } = useComparisonSequenceAvailability({
    data,
    selectedPlane,
    selectedSeqId,
    enabledDates,
    onPersistenceError: reportPersistenceError,
  });

  const workspaceNavigation = useComparisonWorkspaceNavigation({
    data,
    selectedSeqId,
    enabledDates,
    panelSettings,
    progress,
    setProgress,
    interactionBlocked,
  });
  const {
    columns,
    overlayColumns,
    viewMode,
    setViewMode,
    overlayDateIndex,
    setOverlayDateIndex,
    isPlaying,
    setIsPlaying,
    playSpeed,
    setPlaySpeed,
    overlayDisplayedDate,
    progressRef,
    playbackInstanceCount,
  } = workspaceNavigation;

  const startAlignAll = useCallback(
    async (reference: AlignmentReference, exclusionMask: ExclusionMask) => {
      if (isAligning) {
        abortAlignment();
        return;
      }

      if (!data || !selectedSeqId) return;

      const seriesMap = data.series_map[selectedSeqId] || {};

      // Get all dates except the reference date.
      const targetDates: string[] = [];
      for (const column of overlayColumns) {
        if (column.ref && column.date !== reference.date) targetDates.push(column.date);
      }
      if (targetDates.length === 0) return;

      try {
        const finalReference: AlignmentReference = {
          ...reference,
          exclusionMask,
          patientKey: data.selected_patient_key ?? reference.patientKey,
          sequenceId: selectedSeqId,
          datasetRevision: data.dataset_revision,
        };
        const results = await alignAllDates(finalReference, targetDates, seriesMap, progress, {
          outputMode: alignmentOutputMode,
        });

        // Results are applied incrementally via an effect so the UI updates per-date.
        const aligned = results.filter((result) => result.outcome === 'aligned');
        if (aligned.length > 0) {
          console.log(
            `[Alignment] Aligned ${aligned.length} of ${results.length} examinations. Average NMI: ${(
              aligned.reduce((sum, result) => sum + result.nmiScore, 0) / aligned.length
            ).toFixed(3)}`,
          );
        }
      } catch (err) {
        console.error('[Alignment] Failed:', err);
      }
    },
    [abortAlignment, alignAllDates, alignmentOutputMode, data, isAligning, overlayColumns, progress, selectedSeqId],
  );

  if (loading) {
    return (
      <div className="instrument-shell instrument-loading" role="status" aria-live="polite">
        <div className="instrument-loading-inner">
          <p className="instrument-eyebrow">MiraViewer</p>
          <p>Loading saved scans…</p>
        </div>
      </div>
    );
  }

  const hasData = data && selectedPlane && selectedSeqId;

  if (error) {
    return (
      <div className="instrument-shell instrument-loading" role="alert">
        <div className="instrument-loading-inner">{error}</div>
      </div>
    );
  }

  const selectedSequence = data?.sequences.find((sequence) => sequence.id === selectedSeqId);
  const activeExaminationDate = overlayDisplayedDate ?? columns.find((column) => column.ref)?.date ?? null;

  return (
    <div className="instrument-shell flex flex-col">
      {/* Help Modal */}
      {activeDialog === 'help' && <HelpModal onClose={() => setActiveDialog(null)} />}

      {/* Upload Modal */}
      {activeDialog === 'upload' && (
        <UploadModal
          onClose={() => setActiveDialog(null)}
          onUploadComplete={() => reload(undefined, { background: true })}
        />
      )}
      {activeDialog === 'export' && <ExportModal onClose={() => setActiveDialog(null)} />}
      {activeDialog === 'clear' && (
        <ClearDataModal onClose={() => setActiveDialog(null)} onReset={() => window.location.reload()} />
      )}

      <ComparisonInstrumentHeader
        clinical={{
          data,
          hasData: Boolean(hasData),
          selectedPlane,
          selectedSequence,
          activeExaminationDate,
          selectPatient,
        }}
        navigation={{
          viewMode,
          setViewMode,
          overlayColumns,
          overlayDateIndex,
          setOverlayDateIndex,
          isPlaying,
          setIsPlaying,
          playSpeed,
          setPlaySpeed,
        }}
        actions={{
          isAligning,
          headerMenuOpen,
          setHeaderMenuOpen,
          headerMenuRef,
          abortAlignment,
          openDialog: setActiveDialog,
        }}
        notices={{ persistenceError, clearPersistenceError, alignmentError, alignmentResults, clearAlignmentState }}
      />

      {/* Main area with sidebar */}
      <div className="flex-1 flex overflow-hidden relative">
        {hasData && viewMode !== 'svr3d' ? (
          <ComparisonFiltersSidebar
            open={sidebarOpen}
            onToggleOpen={() => setSidebarOpen((v) => !v)}
            availablePlanes={availablePlanes}
            selectedPlane={selectedPlane}
            onSelectPlane={selectPlane}
            sequencesForPlane={sequencesForPlane}
            sequencesWithDataForDates={sequencesWithDataForDates}
            selectedSeqId={selectedSeqId}
            onSelectSequence={selectSequence}
            alignmentOutputMode={alignmentOutputMode}
            onAlignmentOutputModeChange={(mode) => setUiState({ ...uiState, alignmentOutputMode: mode })}
            alignmentInProgress={isAligning}
          />
        ) : null}

        <ComparisonStage
          data={data}
          selectedSeqId={selectedSeqId}
          hasData={Boolean(hasData)}
          navigation={workspaceNavigation}
          panel={{ settings: panelSettings, progress, setProgress, updateSetting: updatePanelSetting }}
          alignment={{ active: isAligning, progress: alignmentProgress, abort: abortAlignment, start: startAlignAll }}
          onOpenUpload={() => setActiveDialog('upload')}
        />

        {hasData && viewMode !== 'svr3d' ? (
          <ComparisonDatesSidebar
            open={rightSidebarOpen}
            onToggleOpen={() => setRightSidebarOpen((v) => !v)}
            sortedDates={sortedDates}
            enabledDates={enabledDates}
            datesWithDataForSequence={datesWithDataForSequence}
            onSelectAllDates={selectAllDates}
            onSelectNoDates={selectNoDates}
            onToggleDate={toggleDate}
            alignmentInProgress={isAligning}
          />
        ) : null}
      </div>

      {/* Slice navigator with loop + speed controls */}
      {hasData && viewMode !== 'svr3d' ? (
        <SliceLoopNavigator
          interactionBlocked={interactionBlocked}
          selectedSeqId={selectedSeqId}
          playbackInstanceCount={playbackInstanceCount}
          progress={progress}
          progressRef={progressRef}
          setProgress={setProgress}
        />
      ) : null}
    </div>
  );
}
