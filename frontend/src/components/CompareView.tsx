import { useState, useEffect } from 'react';
import type { Study, Series } from '../types/api';
import { DicomViewer } from './DicomViewer';
import { formatDate } from '../utils/api';
import { Link2, Link2Off, ChevronDown } from 'lucide-react';

/** Build a display name from parsed metadata, falling back to description */
function formatSeriesName(series: Series): string {
  const parts: string[] = [];
  
  if (series.plane) parts.push(series.plane);
  if (series.weight) parts.push(series.weight);
  if (series.sequence_type) parts.push(series.sequence_type);
  
  if (parts.length > 0) {
    return parts.join(' ');
  }
  
  return series.series_description || 'Unknown';
}

interface CompareViewProps {
  studies: Study[];
  leftStudyId: string;
  rightStudyId: string;
  onClose: () => void;
}

export function CompareView({ studies, leftStudyId, rightStudyId, onClose }: CompareViewProps) {
  const leftStudy = studies.find((s) => s.study_id === leftStudyId);
  const rightStudy = studies.find((s) => s.study_id === rightStudyId);

  const [leftSeriesUid, setLeftSeriesUid] = useState<string | null>(null);
  const [rightSeriesUid, setRightSeriesUid] = useState<string | null>(null);
  const [leftInstanceIndex, setLeftInstanceIndex] = useState(0);
  const [rightInstanceIndex, setRightInstanceIndex] = useState(0);
  const [syncScroll, setSyncScroll] = useState(true);

  // Initialize series selection
  useEffect(() => {
    if (leftStudy?.series[0]) {
      setLeftSeriesUid(leftStudy.series[0].series_uid);
    }
    if (rightStudy?.series[0]) {
      setRightSeriesUid(rightStudy.series[0].series_uid);
    }
  }, [leftStudy, rightStudy]);

  const leftSeries = leftStudy?.series.find((s) => s.series_uid === leftSeriesUid);
  const rightSeries = rightStudy?.series.find((s) => s.series_uid === rightSeriesUid);

  // Sync scroll handlers
  const handleLeftInstanceChange = (index: number) => {
    setLeftInstanceIndex(index);
    if (syncScroll && rightSeries) {
      const ratio = index / ((leftSeries?.instance_count || 1) - 1);
      const rightIndex = Math.round(ratio * ((rightSeries.instance_count || 1) - 1));
      setRightInstanceIndex(rightIndex);
    }
  };

  const handleRightInstanceChange = (index: number) => {
    setRightInstanceIndex(index);
    if (syncScroll && leftSeries) {
      const ratio = index / ((rightSeries?.instance_count || 1) - 1);
      const leftIndex = Math.round(ratio * ((leftSeries.instance_count || 1) - 1));
      setLeftInstanceIndex(leftIndex);
    }
  };

  if (!leftStudy || !rightStudy) {
    return <div className="text-[var(--text-secondary)]">Studies not found</div>;
  }

  return (
    <div className="h-full flex flex-col">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 bg-[var(--bg-secondary)] border-b border-[var(--border-color)]">
        <div className="flex items-center gap-4">
          <h2 className="text-lg font-semibold">Compare Scans</h2>
          <button
            onClick={() => setSyncScroll(!syncScroll)}
            className={`flex items-center gap-2 px-3 py-1.5 rounded-lg text-sm transition-colors ${
              syncScroll
                ? 'bg-[var(--accent)] text-white'
                : 'bg-[var(--bg-tertiary)] text-[var(--text-secondary)]'
            }`}
          >
            {syncScroll ? <Link2 className="w-4 h-4" /> : <Link2Off className="w-4 h-4" />}
            {syncScroll ? 'Synced' : 'Independent'}
          </button>
        </div>
        <button
          onClick={onClose}
          className="px-4 py-1.5 rounded-lg bg-[var(--bg-tertiary)] hover:bg-[var(--border-color)] text-[var(--text-primary)] text-sm transition-colors"
        >
          Exit Compare
        </button>
      </div>

      {/* Compare panels */}
      <div className="flex-1 flex">
        {/* Left panel */}
        <div className="flex-1 flex flex-col border-r border-[var(--border-color)]">
          <div className="px-4 py-2 bg-[var(--bg-tertiary)] border-b border-[var(--border-color)]">
            <div className="flex items-center justify-between">
              <div>
                <div className="text-sm font-medium">{formatDate(leftStudy.study_date)}</div>
                <div className="text-xs text-[var(--text-secondary)]">{leftStudy.scan_type}</div>
              </div>
              <SeriesDropdown
                series={leftStudy.series}
                selectedUid={leftSeriesUid}
                onSelect={(uid) => {
                  setLeftSeriesUid(uid);
                  setLeftInstanceIndex(0);
                }}
              />
            </div>
          </div>
          {leftSeries && leftSeriesUid && (
            <div className="flex-1">
              <DicomViewer
                studyId={leftStudyId}
                seriesUid={leftSeriesUid}
                instanceIndex={leftInstanceIndex}
                instanceCount={leftSeries.instance_count}
                onInstanceChange={handleLeftInstanceChange}
              />
            </div>
          )}
        </div>

        {/* Right panel */}
        <div className="flex-1 flex flex-col">
          <div className="px-4 py-2 bg-[var(--bg-tertiary)] border-b border-[var(--border-color)]">
            <div className="flex items-center justify-between">
              <div>
                <div className="text-sm font-medium">{formatDate(rightStudy.study_date)}</div>
                <div className="text-xs text-[var(--text-secondary)]">{rightStudy.scan_type}</div>
              </div>
              <SeriesDropdown
                series={rightStudy.series}
                selectedUid={rightSeriesUid}
                onSelect={(uid) => {
                  setRightSeriesUid(uid);
                  setRightInstanceIndex(0);
                }}
              />
            </div>
          </div>
          {rightSeries && rightSeriesUid && (
            <div className="flex-1">
              <DicomViewer
                studyId={rightStudyId}
                seriesUid={rightSeriesUid}
                instanceIndex={rightInstanceIndex}
                instanceCount={rightSeries.instance_count}
                onInstanceChange={handleRightInstanceChange}
              />
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

interface SeriesDropdownProps {
  series: Series[];
  selectedUid: string | null;
  onSelect: (uid: string) => void;
}

function SeriesDropdown({ series, selectedUid, onSelect }: SeriesDropdownProps) {
  const [isOpen, setIsOpen] = useState(false);
  const selected = series.find((s) => s.series_uid === selectedUid);

  return (
    <div className="relative">
      <button
        onClick={() => setIsOpen(!isOpen)}
        className="flex items-center gap-2 px-3 py-1.5 rounded bg-[var(--bg-secondary)] hover:bg-[var(--border-color)] text-sm transition-colors"
      >
        <span className="max-w-[200px] truncate">
          {selected ? formatSeriesName(selected) : 'Select series'}
        </span>
        <ChevronDown className={`w-4 h-4 transition-transform ${isOpen ? 'rotate-180' : ''}`} />
      </button>

      {isOpen && (
        <>
          <div className="fixed inset-0 z-10" onClick={() => setIsOpen(false)} />
          <div className="absolute right-0 top-full mt-1 w-64 max-h-64 overflow-y-auto bg-[var(--bg-secondary)] border border-[var(--border-color)] rounded-lg shadow-xl z-20">
            {series.map((s) => (
              <button
                key={s.series_uid}
                onClick={() => {
                  onSelect(s.series_uid);
                  setIsOpen(false);
                }}
                className={`w-full text-left px-3 py-2 text-sm hover:bg-[var(--bg-tertiary)] transition-colors ${
                  s.series_uid === selectedUid ? 'bg-[var(--bg-tertiary)]' : ''
                }`}
              >
              <div className="truncate">{formatSeriesName(s)}</div>
                <div className="text-xs text-[var(--text-secondary)]">
                  {s.instance_count} slices
                </div>
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
