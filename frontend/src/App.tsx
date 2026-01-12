import { useState, useEffect } from 'react';
import { useStudies, useStudy, useKeyboardNavigation } from './hooks/useStudies';
import { Timeline } from './components/Timeline';
import { SeriesList } from './components/SeriesList';
import { DicomViewer } from './components/DicomViewer';
import { WindowControls } from './components/WindowControls';
import { CompareView } from './components/CompareView';
import { formatDate } from './utils/api';
import { Brain, GitCompare, Loader2, AlertCircle, Keyboard } from 'lucide-react';

function App() {
  const { studies, loading, error } = useStudies();
  const [selectedStudyId, setSelectedStudyId] = useState<string | null>(null);
  const [selectedSeriesUid, setSelectedSeriesUid] = useState<string | null>(null);
  const [instanceIndex, setInstanceIndex] = useState(0);
  const [windowCenter, setWindowCenter] = useState<number | undefined>(undefined);
  const [windowWidth, setWindowWidth] = useState<number | undefined>(undefined);
  const [useCustomWindow, setUseCustomWindow] = useState(false);

  // Compare mode state
  const [compareMode, setCompareMode] = useState(false);
  const [compareStudyId, setCompareStudyId] = useState<string | null>(null);

  // Get detailed study info
  const { study } = useStudy(selectedStudyId);

  // Auto-select first study and series
  useEffect(() => {
    if (studies.length > 0 && !selectedStudyId) {
      setSelectedStudyId(studies[0].study_id);
    }
  }, [studies, selectedStudyId]);

  useEffect(() => {
    if (study?.series[0] && !selectedSeriesUid) {
      setSelectedSeriesUid(study.series[0].series_uid);
    }
  }, [study, selectedSeriesUid]);

  // Reset instance index when series changes
  useEffect(() => {
    setInstanceIndex(0);
  }, [selectedSeriesUid]);

  // Get current series
  const currentSeries = study?.series.find((s) => s.series_uid === selectedSeriesUid);
  const instanceCount = currentSeries?.instance_count || 0;

  // Keyboard navigation
  useKeyboardNavigation(instanceIndex, instanceCount, setInstanceIndex, !compareMode);

  // Handle study selection
  const handleStudySelect = (studyId: string) => {
    setSelectedStudyId(studyId);
    setSelectedSeriesUid(null);
    setInstanceIndex(0);
  };

  // Handle series selection
  const handleSeriesSelect = (seriesUid: string) => {
    setSelectedSeriesUid(seriesUid);
    setInstanceIndex(0);
  };

  // Handle compare mode
  const handleCompareSelect = (studyId: string) => {
    if (studyId !== selectedStudyId) {
      setCompareStudyId(studyId);
    }
  };

  // Reset window values
  const handleWindowReset = () => {
    setUseCustomWindow(false);
    setWindowCenter(undefined);
    setWindowWidth(undefined);
  };

  // Loading state
  if (loading) {
    return (
      <div className="h-screen flex items-center justify-center bg-[var(--bg-primary)]">
        <div className="flex flex-col items-center gap-4">
          <Loader2 className="w-8 h-8 text-[var(--accent)] animate-spin" />
          <p className="text-[var(--text-secondary)]">Loading studies...</p>
        </div>
      </div>
    );
  }

  // Error state
  if (error) {
    return (
      <div className="h-screen flex items-center justify-center bg-[var(--bg-primary)]">
        <div className="flex flex-col items-center gap-4 max-w-md text-center">
          <AlertCircle className="w-12 h-12 text-red-500" />
          <h2 className="text-xl font-semibold">Failed to Load</h2>
          <p className="text-[var(--text-secondary)]">{error}</p>
          <p className="text-sm text-[var(--text-secondary)]">
            Make sure the backend server is running on port 8000
          </p>
        </div>
      </div>
    );
  }

  // Empty state
  if (studies.length === 0) {
    return (
      <div className="h-screen flex items-center justify-center bg-[var(--bg-primary)]">
        <div className="flex flex-col items-center gap-4">
          <Brain className="w-12 h-12 text-[var(--text-secondary)]" />
          <p className="text-[var(--text-secondary)]">No studies found</p>
        </div>
      </div>
    );
  }

  // Compare view
  if (compareMode && compareStudyId && selectedStudyId) {
    return (
      <CompareView
        studies={studies}
        leftStudyId={selectedStudyId}
        rightStudyId={compareStudyId}
        onClose={() => {
          setCompareMode(false);
          setCompareStudyId(null);
        }}
      />
    );
  }

  return (
    <div className="h-screen flex flex-col">
      {/* Header */}
      <header className="flex items-center justify-between px-4 py-3 bg-[var(--bg-secondary)] border-b border-[var(--border-color)]">
        <div className="flex items-center gap-3">
          <div className="flex items-center gap-2">
            <Brain className="w-6 h-6 text-[var(--accent)]" />
            <h1 className="text-lg font-semibold">MiraViewer</h1>
          </div>
          {study && (
            <div className="text-sm text-[var(--text-secondary)] border-l border-[var(--border-color)] pl-3 ml-2">
              {formatDate(study.study_date)} · {study.scan_type}
            </div>
          )}
        </div>
        <div className="flex items-center gap-2">
          <div className="flex items-center gap-1 text-xs text-[var(--text-secondary)] mr-4">
            <Keyboard className="w-3.5 h-3.5" />
            <span>↑↓ Navigate slices</span>
          </div>
          <button
            onClick={() => setCompareMode(!compareMode)}
            className={`flex items-center gap-2 px-3 py-1.5 rounded-lg text-sm transition-colors ${
              compareMode
                ? 'bg-[var(--accent)] text-white'
                : 'bg-[var(--bg-tertiary)] hover:bg-[var(--border-color)] text-[var(--text-primary)]'
            }`}
          >
            <GitCompare className="w-4 h-4" />
            {compareMode ? 'Select scan to compare' : 'Compare'}
          </button>
        </div>
      </header>

      {/* Main content */}
      <div className="flex-1 flex overflow-hidden">
        {/* Left sidebar - Timeline */}
        <aside className="w-64 bg-[var(--bg-secondary)] border-r border-[var(--border-color)] flex-shrink-0">
          <Timeline
            studies={studies}
            selectedStudyId={selectedStudyId}
            onSelectStudy={handleStudySelect}
            compareMode={compareMode}
            onCompareSelect={handleCompareSelect}
          />
        </aside>

        {/* Series list */}
        <aside className="w-56 bg-[var(--bg-secondary)] border-r border-[var(--border-color)] flex-shrink-0">
          <SeriesList
            series={study?.series || []}
            selectedSeriesUid={selectedSeriesUid}
            onSelectSeries={handleSeriesSelect}
          />
        </aside>

        {/* Main viewer */}
        <main className="flex-1 min-w-0">
          {selectedStudyId && selectedSeriesUid && currentSeries ? (
            <DicomViewer
              studyId={selectedStudyId}
              seriesUid={selectedSeriesUid}
              instanceIndex={instanceIndex}
              instanceCount={instanceCount}
              onInstanceChange={setInstanceIndex}
              windowCenter={useCustomWindow ? windowCenter : undefined}
              windowWidth={useCustomWindow ? windowWidth : undefined}
            />
          ) : (
            <div className="h-full flex items-center justify-center bg-black text-[var(--text-secondary)]">
              Select a series to view
            </div>
          )}
        </main>

        {/* Right sidebar - Controls */}
        <aside className="w-56 bg-[var(--bg-secondary)] border-l border-[var(--border-color)] flex-shrink-0">
          <WindowControls
            windowCenter={windowCenter ?? 40}
            windowWidth={windowWidth ?? 80}
            onWindowCenterChange={(v) => {
              setWindowCenter(v);
              setUseCustomWindow(true);
            }}
            onWindowWidthChange={(v) => {
              setWindowWidth(v);
              setUseCustomWindow(true);
            }}
            onReset={handleWindowReset}
          />

          {/* Keyboard shortcuts help */}
          <div className="p-4 border-t border-[var(--border-color)]">
            <h3 className="text-sm font-semibold text-[var(--text-secondary)] uppercase tracking-wider mb-3">
              Shortcuts
            </h3>
            <div className="space-y-2 text-xs text-[var(--text-secondary)]">
              <div className="flex justify-between">
                <span>Previous/Next slice</span>
                <span className="text-[var(--text-primary)]">↑ ↓</span>
              </div>
              <div className="flex justify-between">
                <span>First/Last slice</span>
                <span className="text-[var(--text-primary)]">Home/End</span>
              </div>
              <div className="flex justify-between">
                <span>Jump 10 slices</span>
                <span className="text-[var(--text-primary)]">PgUp/PgDn</span>
              </div>
              <div className="flex justify-between">
                <span>Scroll on image</span>
                <span className="text-[var(--text-primary)]">Mouse wheel</span>
              </div>
            </div>
          </div>
        </aside>
      </div>
    </div>
  );
}

export default App;
