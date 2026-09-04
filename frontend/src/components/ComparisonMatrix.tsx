import { lazy, Suspense } from 'react';
import type { ComparisonData } from '../types/api';
import { CalendarDays, Upload } from 'lucide-react';
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
import { StudyToolsWorkspace } from './comparison/StudyTools';
import { useComparisonData } from '../hooks/useComparisonData';
import { useComparisonFilters } from '../hooks/useComparisonFilters';
import { useComparisonInstrumentUi } from '../hooks/useComparisonInstrumentUi';
import { useComparisonSequenceAvailability } from '../hooks/useComparisonSequenceAvailability';
import { useComparisonWorkspaceNavigation } from '../hooks/useComparisonWorkspaceNavigation';
import { usePanelSettings } from '../hooks/usePanelSettings';
import { useComparisonAlignment } from '../hooks/useComparisonAlignment';
import { AlignedBrowsingContext } from '../hooks/useAlignedFrame';
import { SharpSliceDisplayContext } from '../hooks/useSharpSliceDisplay';
import { AutomaticAlignmentStatus } from './comparison/AutomaticAlignmentStatus';
import { formatDate } from '../utils/format';
import { selectAcquisition } from '../utils/localApi';
const Svr3DView = lazy(() => import('./Svr3DView').then((module) => ({ default: module.Svr3DView })));

type ComparisonStageProps = {
  data: ComparisonData | null;
  selectedSeqId: string | null;
  hasData: boolean;
  navigation: ReturnType<typeof useComparisonWorkspaceNavigation>;
  panel: Pick<
    ReturnType<typeof usePanelSettings>,
    'panelSettings' | 'progress' | 'setProgress' | 'updatePanelSetting' | 'settingsReady'
  >;
  onUseAcquired: (date: string) => void;
  onOpenUpload: () => void;
  onOpenExaminations: () => void;
};

function ComparisonStage({
  data,
  selectedSeqId,
  hasData,
  navigation,
  panel,
  onUseAcquired,
  onOpenUpload,
  onOpenExaminations,
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
            <p className="instrument-empty-disclosure">
              Folders, DICOM files, and ZIP archives. Your images stay on this device.
            </p>
          </div>
        </div>
      ) : navigation.viewMode !== 'svr3d' && navigation.columns.length === 0 ? (
        <div className="instrument-empty">
          <div className="instrument-empty-inner">
            <p className="instrument-eyebrow">Your scans are still here</p>
            <h2 className="instrument-empty-heading">Choose examinations to compare.</h2>
            <p className="instrument-empty-copy">
              No examinations match the current selection. Choose dates or change the imaging sequence to continue.
            </p>
            <button type="button" className="instrument-primary-button" onClick={onOpenExaminations}>
              <CalendarDays className="h-4 w-4" aria-hidden="true" />
              Choose examinations
            </button>
          </div>
        </div>
      ) : navigation.viewMode === 'grid' ? (
        <GridView comboId={selectedSeqId} {...navigation} {...panel} onUseAcquired={onUseAcquired} />
      ) : navigation.viewMode === 'overlay' ? (
        <OverlayView comboId={selectedSeqId} {...navigation} {...panel} onUseAcquired={onUseAcquired} />
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
            {...navigation.svr3dSeed}
            defaultSeqId={selectedSeqId}
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
  } = useComparisonInstrumentUi();

  const panel = usePanelSettings(
    data ? selectedSeqId : null,
    enabledDatesKey,
    data?.selected_patient_key ?? null,
    interactionBlocked,
    selectedSeqId ? data?.series_map[selectedSeqId] : undefined,
    data?.dataset_token,
  );
  const {
    panelSettings,
    progress,
    setProgress,
    updatePanelSetting,
    persistenceError,
    clearPersistenceError,
    reportPersistenceError,
  } = panel;

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
    overlayColumns,
    viewMode,
    setViewMode,
    overlayDateIndex,
    setOverlayDateIndex,
    isPlaying,
    setIsPlaying,
    playSpeed,
    setPlaySpeed,
    progressRef,
    playbackInstanceCount,
  } = workspaceNavigation;

  const alignment = useComparisonAlignment({
    data,
    sequenceId: selectedSeqId,
    columns: workspaceNavigation.columns,
    presentedDates:
      viewMode === 'overlay'
        ? [workspaceNavigation.overlaySelectedDate, workspaceNavigation.overlayCompareDate].filter(
            (date): date is string => !!date,
          )
        : undefined,
    panel,
    viewportSize: viewMode === 'overlay' ? workspaceNavigation.overlayViewerSize : workspaceNavigation.gridCellSize,
    outputMode: alignmentOutputMode,
    enabled: uiState.automaticAlignment && !interactionBlocked && !isPlaying && viewMode !== 'svr3d',
  });
  const {
    isAligning,
    results: visibleResults,
    error: alignmentError,
    clearState: clearAlignmentState,
    abort: abortAlignment,
    useAcquiredImage,
  } = alignment;

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
        <div className="instrument-loading-inner">
          <p>{error}</p>
          <button type="button" className="instrument-context-button" onClick={() => void reload()}>
            Retry loading scans
          </button>
        </div>
      </div>
    );
  }

  const selectedSequence = data?.sequences.find((sequence) => sequence.id === selectedSeqId);

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
        displayControls={
          hasData && viewMode !== 'svr3d' ? (
            <button
              type="button"
              className="instrument-context-button shrink-0"
              style={{ color: uiState.sharpSlices ? 'var(--signal-metal)' : undefined }}
              aria-pressed={uiState.sharpSlices}
              aria-label="Sharp slices (experimental)"
              title="Experimental synthesized detail between acquired slices. Toggle off to compare the original aligned image; alignment and measurements always use original MRI data."
              onClick={() => setUiState({ ...uiState, sharpSlices: !uiState.sharpSlices })}
            >
              Sharp slices
              <span className="text-[10px] text-[var(--text-tertiary)]">Experimental</span>
            </button>
          ) : null
        }
        alignmentControls={
          workspaceNavigation.columns.length > 1 && viewMode !== 'svr3d' ? (
            <AutomaticAlignmentStatus
              enabled={uiState.automaticAlignment}
              busy={isAligning}
              aligned={visibleResults.filter((result) => result.outcome === 'aligned').length}
              targets={alignment.targetCount}
              manual={alignment.hasManualAdjustments}
              onToggle={() => setUiState({ ...uiState, automaticAlignment: !uiState.automaticAlignment })}
              onRealign={() => {
                alignment.realign();
                setUiState({ ...uiState, automaticAlignment: true });
              }}
            />
          ) : null
        }
        clinical={{
          data,
          hasData: Boolean(hasData),
          selectedPlane,
          selectedSequence,
          selectPatient,
        }}
        navigation={{
          selectionFallback: workspaceNavigation.selectionFallback,
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
        notices={{
          persistenceError,
          clearPersistenceError,
          settingsReady: panel.settingsReady,
          retrySettings: () => {
            void reload().then(panel.retryLoad);
          },
          alignmentError,
          alignmentResults: visibleResults,
          clearAlignmentState,
        }}
        panels={{
          filtersOpen: sidebarOpen,
          datesOpen: rightSidebarOpen,
          toggleFilters: () => setSidebarOpen((value) => !value),
          toggleDates: () => setRightSidebarOpen((value) => !value),
        }}
      />

      {/* Main area with sidebar */}
      {(panel.legacySettings?.length ?? 0) > 0 && (
        <div className="instrument-notice px-4 py-2" role="status">
          <span>Some older image settings need an examination and acquisition.</span>
          <button type="button" className="instrument-notice-button" onClick={() => setRightSidebarOpen(true)}>
            Review saved settings
          </button>
        </div>
      )}
      <StudyToolsWorkspace>
        <div className="comparison-workspace min-h-0 min-w-0 flex-1 flex overflow-hidden relative">
          {hasData && viewMode !== 'svr3d' && (sidebarOpen || rightSidebarOpen) ? (
            <button
              type="button"
              tabIndex={-1}
              aria-label="Close navigation panels"
              className="comparison-drawer-dismiss"
              data-filters-open={sidebarOpen}
              data-dates-open={rightSidebarOpen}
              onClick={() => setUiState({ ...uiState, sidebarOpen: false, rightSidebarOpen: false })}
            />
          ) : null}
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
            />
          ) : null}

          <AlignedBrowsingContext value={alignment.browsing}>
            <SharpSliceDisplayContext
              value={{ enabled: uiState.sharpSlices, suspended: interactionBlocked || isPlaying || isAligning }}
            >
              <ComparisonStage
                data={data}
                selectedSeqId={selectedSeqId}
                hasData={Boolean(hasData)}
                navigation={workspaceNavigation}
                panel={{ panelSettings, progress, setProgress, updatePanelSetting, settingsReady: panel.settingsReady }}
                onUseAcquired={useAcquiredImage}
                onOpenUpload={() => setActiveDialog('upload')}
                onOpenExaminations={() => setRightSidebarOpen(true)}
              />
            </SharpSliceDisplayContext>
          </AlignedBrowsingContext>

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
              acquisitions={
                selectedSeqId && data
                  ? {
                      candidates: data.series_candidates?.[selectedSeqId] ?? {},
                      selected: data.series_map[selectedSeqId] ?? {},
                      onSelect: async (date, uid) => {
                        const study = data.series_map[selectedSeqId]?.[date]?.study_id;
                        if (!study) return;
                        abortAlignment();
                        await selectAcquisition(study, selectedSeqId, uid);
                        clearAlignmentState();
                        await reload(undefined, { background: true });
                      },
                      legacy: panel.legacySettings ?? [],
                      onAssignLegacy: panel.assignLegacySettings,
                    }
                  : undefined
              }
            />
          ) : null}
        </div>
      </StudyToolsWorkspace>

      {/* Slice navigator with loop + speed controls */}
      {hasData && viewMode !== 'svr3d' ? (
        <SliceLoopNavigator
          interactionBlocked={interactionBlocked}
          selectedSeqId={selectedSeqId}
          playbackInstanceCount={playbackInstanceCount}
          reference={
            workspaceNavigation.navigationReference
              ? {
                  label: formatDate(workspaceNavigation.navigationReference.date),
                  offset: workspaceNavigation.navigationReference.offset,
                  reverseSliceOrder: workspaceNavigation.navigationReference.reverseSliceOrder,
                }
              : undefined
          }
          progress={progress}
          progressRef={progressRef}
          setProgress={setProgress}
        />
      ) : null}
    </div>
  );
}
