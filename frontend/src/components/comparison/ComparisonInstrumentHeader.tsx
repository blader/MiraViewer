import type { Dispatch, ReactNode, RefObject, SetStateAction } from 'react';
import { CalendarDays, Download, HelpCircle, MoreVertical, PanelLeft, Pause, Play, Trash2, Upload } from 'lucide-react';
import type { AlignmentResult, ComparisonData, SequenceCombo, SeriesRef } from '../../types/api';
import { formatPatientName, formatSequenceLabel } from '../../utils/clinicalData';
import { OVERLAY } from '../../utils/constants';
import { clearDerivedAlignmentFrames } from '../../utils/derivedAlignmentFrame';
import { formatDate } from '../../utils/format';

type InstrumentClinicalContext = {
  data: ComparisonData | null;
  hasData: boolean;
  selectedPlane: string | null;
  selectedSequence: SequenceCombo | undefined;
  selectPatient: (patientKey: string) => void | Promise<void>;
};

type InstrumentNavigation = {
  viewMode: 'grid' | 'overlay' | 'svr3d';
  setViewMode: (mode: 'grid' | 'overlay' | 'svr3d') => void;
  overlayColumns: ReadonlyArray<{ date: string; ref?: SeriesRef }>;
  overlayDateIndex: number;
  setOverlayDateIndex: (index: number) => void;
  isPlaying: boolean;
  setIsPlaying: (playing: boolean) => void;
  playSpeed: number;
  setPlaySpeed: (speed: number) => void;
};

type InstrumentActions = {
  isAligning: boolean;
  headerMenuOpen: boolean;
  setHeaderMenuOpen: Dispatch<SetStateAction<boolean>>;
  headerMenuRef: RefObject<HTMLDivElement | null>;
  abortAlignment: () => void;
  openDialog: (dialog: 'help' | 'upload' | 'export' | 'clear') => void;
};

type InstrumentNotices = {
  persistenceError: string | null;
  clearPersistenceError: () => void;
  alignmentError: string | null;
  alignmentResults: AlignmentResult[];
  clearAlignmentState: () => void;
};

export type ComparisonInstrumentHeaderProps = {
  alignmentControls?: ReactNode;
  backgroundAlignment?: boolean;
  clinical: InstrumentClinicalContext;
  navigation: InstrumentNavigation;
  actions: InstrumentActions;
  notices: InstrumentNotices;
  panels: {
    filtersOpen: boolean;
    datesOpen: boolean;
    toggleFilters: () => void;
    toggleDates: () => void;
  };
};

function InstrumentModeNavigation({
  navigation,
  alignmentInProgress,
}: {
  navigation: InstrumentNavigation;
  alignmentInProgress: boolean;
}) {
  return (
    <nav className="instrument-mode-nav" aria-label="Viewing mode">
      <button
        type="button"
        disabled={alignmentInProgress}
        onClick={() => navigation.setViewMode('grid')}
        aria-pressed={navigation.viewMode === 'grid'}
        className="instrument-mode-tab"
        title="Grid view"
      >
        Compare
      </button>
      <button
        type="button"
        disabled={alignmentInProgress}
        onClick={() => navigation.setViewMode('overlay')}
        aria-pressed={navigation.viewMode === 'overlay'}
        className="instrument-mode-tab"
        title="Overlay view - toggle between dates"
      >
        Overlay
      </button>
      <button
        type="button"
        disabled={alignmentInProgress}
        onClick={() => navigation.setViewMode('svr3d')}
        aria-pressed={navigation.viewMode === 'svr3d'}
        className="instrument-mode-tab"
        title="SVR 3D view"
      >
        3D
      </button>
    </nav>
  );
}

function InstrumentPatient({
  clinical,
  actions,
  clearAlignmentState,
}: {
  clinical: InstrumentClinicalContext;
  actions: InstrumentActions;
  clearAlignmentState: () => void;
}) {
  if ((clinical.data?.patients?.length ?? 0) > 1) {
    return (
      <label className="instrument-patient">
        <span className="instrument-patient-label">Patient</span>
        <select
          aria-label="Selected patient"
          disabled={actions.isAligning}
          value={clinical.data?.selected_patient_key ?? ''}
          onChange={(event) => {
            actions.abortAlignment();
            clearDerivedAlignmentFrames();
            clearAlignmentState();
            void clinical.selectPatient(event.target.value);
          }}
          className="instrument-patient-select"
        >
          {clinical.data?.patients?.map((patient) => (
            <option key={patient.key} value={patient.key}>
              {formatPatientName(patient.patient_name) || patient.patient_id || 'Unknown patient'}
            </option>
          ))}
        </select>
      </label>
    );
  }

  if ((clinical.data?.patients?.length ?? 0) !== 1) return null;
  return (
    <div className="instrument-patient" aria-label="Selected patient">
      <span className="instrument-patient-label">Patient</span>
      <span className="instrument-patient-value">
        {formatPatientName(clinical.data?.patients?.[0]?.patient_name) ||
          clinical.data?.patients?.[0]?.patient_id ||
          'Unknown patient'}
      </span>
    </div>
  );
}

function InstrumentApplicationActions({
  clinical,
  actions,
}: {
  clinical: InstrumentClinicalContext;
  actions: InstrumentActions;
}) {
  const { headerMenuRef } = actions;

  return (
    <div className="instrument-actions">
      {clinical.hasData ? (
        <button
          type="button"
          disabled={actions.isAligning}
          onClick={() => {
            actions.setHeaderMenuOpen(false);
            actions.openDialog('upload');
          }}
          className="instrument-header-action"
          aria-label="Import additional scans"
        >
          <Upload className="h-4 w-4" aria-hidden="true" />
          <span>Import</span>
        </button>
      ) : null}
      <button
        type="button"
        disabled={actions.isAligning}
        onClick={() => {
          actions.setHeaderMenuOpen(false);
          actions.openDialog('help');
        }}
        className="instrument-icon-button"
        title="Help & shortcuts"
        aria-label="Help and keyboard shortcuts"
      >
        <HelpCircle className="h-[18px] w-[18px]" aria-hidden="true" />
      </button>

      <div className="relative" ref={headerMenuRef}>
        <button
          type="button"
          disabled={actions.isAligning}
          onClick={() => actions.setHeaderMenuOpen((value) => !value)}
          className="instrument-icon-button"
          title="Menu"
          aria-label="Application menu"
          aria-expanded={actions.headerMenuOpen}
        >
          <MoreVertical className="h-[18px] w-[18px]" aria-hidden="true" />
        </button>

        {actions.headerMenuOpen ? (
          <div className="instrument-menu">
            <button
              type="button"
              disabled={actions.isAligning}
              onClick={() => {
                actions.setHeaderMenuOpen(false);
                actions.openDialog('upload');
              }}
              className="instrument-menu-item"
            >
              <Upload className="h-4 w-4" aria-hidden="true" />
              Import scans
            </button>
            {clinical.hasData ? (
              <button
                type="button"
                disabled={actions.isAligning}
                onClick={() => {
                  actions.setHeaderMenuOpen(false);
                  actions.openDialog('export');
                }}
                className="instrument-menu-item"
              >
                <Download className="h-4 w-4" aria-hidden="true" />
                Export backup (ZIP)
              </button>
            ) : null}
            {clinical.hasData ? (
              <button
                type="button"
                disabled={actions.isAligning}
                onClick={() => {
                  actions.setHeaderMenuOpen(false);
                  actions.openDialog('clear');
                }}
                className="instrument-menu-item"
                data-destructive="true"
              >
                <Trash2 className="h-4 w-4" aria-hidden="true" />
                Delete all local data
              </button>
            ) : null}
          </div>
        ) : null}
      </div>
    </div>
  );
}

function InstrumentNoticeRail({
  notices,
  alignmentInProgress,
  unsuccessfulResults,
}: {
  notices: InstrumentNotices;
  alignmentInProgress: boolean;
  unsuccessfulResults: AlignmentResult[];
}) {
  return (
    <div className="instrument-notice-rail">
      {notices.persistenceError ? (
        <div role="alert" className="instrument-notice" data-severity="error">
          <span>Changes could not be saved: {notices.persistenceError}</span>
          <button type="button" className="instrument-notice-button" onClick={notices.clearPersistenceError}>
            Dismiss
          </button>
        </div>
      ) : null}
      {notices.alignmentError && !alignmentInProgress ? (
        <div role="alert" className="instrument-notice" data-severity="error">
          <span>
            <span className="font-medium">Alignment failed:</span> {notices.alignmentError}
          </span>
          <button type="button" className="instrument-notice-button" onClick={notices.clearAlignmentState}>
            Dismiss
          </button>
        </div>
      ) : null}
      {unsuccessfulResults.length > 0 ? (
        <div role="status" aria-live="polite" className="instrument-notice">
          <span className="font-medium">Some examinations could not be aligned safely.</span>
          <ul className="instrument-notice-details">
            {unsuccessfulResults.map((result) => (
              <li key={`${result.runId ?? 'alignment'}:${result.date}`}>
                {formatDate(result.date)}: {result.message ?? result.outcome?.replaceAll('-', ' ')}
              </li>
            ))}
          </ul>
          <button type="button" className="instrument-notice-button" onClick={notices.clearAlignmentState}>
            Dismiss
          </button>
        </div>
      ) : null}
    </div>
  );
}

function InstrumentContextRail({
  clinical,
  navigation,
  actions,
  notices,
  noticesVisible,
  unsuccessfulResults,
  alignmentControls,
  panels,
}: ComparisonInstrumentHeaderProps & {
  noticesVisible: boolean;
  unsuccessfulResults: AlignmentResult[];
  alignmentControls?: ReactNode;
}) {
  const showStudyFilmstrip = navigation.viewMode === 'overlay' || navigation.viewMode === 'svr3d';

  return (
    <div
      className="instrument-context-rail"
      aria-label="Selected examination and image context"
      data-notices-visible={noticesVisible || undefined}
    >
      {navigation.viewMode !== 'svr3d' ? (
        <button
          type="button"
          className="instrument-context-button"
          aria-label={panels.filtersOpen ? 'Hide scan filters' : 'Show scan filters'}
          aria-expanded={panels.filtersOpen}
          aria-controls="comparison-filters-panel"
          disabled={actions.isAligning}
          onClick={panels.toggleFilters}
        >
          <PanelLeft className="h-4 w-4" aria-hidden="true" />
          Scans
        </button>
      ) : null}
      <div className="instrument-context-summary">
        <span className="instrument-context-value">
          {navigation.viewMode === 'svr3d' ? 'Examinations' : clinical.selectedPlane}
        </span>
        {clinical.selectedSequence && navigation.viewMode !== 'svr3d' ? (
          <>
            <span className="instrument-context-separator" aria-hidden="true">
              ·
            </span>
            <span className="instrument-context-value">{formatSequenceLabel(clinical.selectedSequence)}</span>
          </>
        ) : null}
        {!showStudyFilmstrip ? (
          <>
            <span className="instrument-context-separator" data-secondary="true" aria-hidden="true">
              ·
            </span>
            <span data-secondary="true">{navigation.overlayColumns.length} examinations</span>
          </>
        ) : null}
      </div>

      {alignmentControls}

      {navigation.viewMode === 'overlay' && navigation.overlayColumns.length > 0 ? (
        <div className="instrument-context-playback">
          <button
            type="button"
            onClick={() => navigation.setIsPlaying(!navigation.isPlaying)}
            disabled={actions.isAligning || navigation.overlayColumns.length < 2}
            className="instrument-icon-button disabled:cursor-not-allowed disabled:opacity-50"
            title={navigation.isPlaying ? 'Pause' : 'Play'}
            aria-label={navigation.isPlaying ? 'Pause comparison playback' : 'Start comparison playback'}
          >
            {navigation.isPlaying ? (
              <Pause className="h-4 w-4" aria-hidden="true" />
            ) : (
              <Play className="h-4 w-4" aria-hidden="true" />
            )}
          </button>
          <select
            aria-label="Comparison playback speed"
            value={navigation.playSpeed}
            onChange={(event) => navigation.setPlaySpeed(parseInt(event.target.value, 10))}
            disabled={actions.isAligning || navigation.overlayColumns.length < 2}
            className="disabled:cursor-not-allowed disabled:opacity-50"
          >
            {OVERLAY.PLAY_SPEEDS.map((speed) => (
              <option key={speed.value} value={speed.value}>
                {speed.label}
              </option>
            ))}
          </select>
        </div>
      ) : null}

      {showStudyFilmstrip && navigation.overlayColumns.length > 0 ? (
        <nav className="instrument-study-filmstrip" aria-label="Available examinations">
          {navigation.overlayColumns.map((column, index) => (
            <button
              key={column.date}
              type="button"
              disabled={actions.isAligning}
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => {
                navigation.setOverlayDateIndex(index);
                navigation.setIsPlaying(false);
              }}
              aria-current={index === navigation.overlayDateIndex ? 'true' : undefined}
              className="instrument-study-button"
            >
              {formatDate(column.date)}
            </button>
          ))}
        </nav>
      ) : null}

      {noticesVisible ? (
        <InstrumentNoticeRail
          notices={notices}
          alignmentInProgress={actions.isAligning}
          unsuccessfulResults={unsuccessfulResults}
        />
      ) : null}

      {navigation.viewMode !== 'svr3d' ? (
        <button
          type="button"
          className="instrument-context-button instrument-examinations-toggle"
          aria-label={panels.datesOpen ? 'Hide examination dates' : 'Show examination dates'}
          aria-expanded={panels.datesOpen}
          aria-controls="comparison-dates-panel"
          disabled={actions.isAligning}
          onClick={panels.toggleDates}
        >
          <CalendarDays className="h-4 w-4" aria-hidden="true" />
          <span>Examinations</span>
          <span className="instrument-count">{navigation.overlayColumns.length}</span>
        </button>
      ) : null}
    </div>
  );
}

export function ComparisonInstrumentHeader({
  clinical,
  navigation,
  actions: operationActions,
  notices,
  panels,
  alignmentControls,
  backgroundAlignment = false,
}: ComparisonInstrumentHeaderProps) {
  const actions = backgroundAlignment ? { ...operationActions, isAligning: false } : operationActions;
  const unsuccessfulResults =
    !operationActions.isAligning && !notices.alignmentError
      ? notices.alignmentResults.filter((result) => result.outcome && result.outcome !== 'aligned')
      : [];
  const noticesVisible = Boolean(
    notices.persistenceError ||
    (notices.alignmentError && !operationActions.isAligning) ||
    unsuccessfulResults.length > 0,
  );

  return (
    <header className="instrument-header">
      <div className="instrument-identity-rail">
        <h1 className="instrument-wordmark">
          Mira<span>Viewer</span>
        </h1>

        {clinical.hasData ? (
          <InstrumentModeNavigation navigation={navigation} alignmentInProgress={actions.isAligning} />
        ) : null}
        <InstrumentPatient clinical={clinical} actions={actions} clearAlignmentState={notices.clearAlignmentState} />
        <InstrumentApplicationActions clinical={clinical} actions={actions} />
      </div>

      {clinical.hasData || noticesVisible ? (
        <InstrumentContextRail
          clinical={clinical}
          navigation={navigation}
          actions={actions}
          notices={notices}
          panels={panels}
          noticesVisible={noticesVisible}
          unsuccessfulResults={unsuccessfulResults}
          alignmentControls={alignmentControls}
        />
      ) : null}
    </header>
  );
}
