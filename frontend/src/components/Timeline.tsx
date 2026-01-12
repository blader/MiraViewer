import type { Study } from '../types/api';
import { formatDate } from '../utils/api';
import { Calendar, Brain, ChevronRight } from 'lucide-react';

interface TimelineProps {
  studies: Study[];
  selectedStudyId: string | null;
  onSelectStudy: (studyId: string) => void;
  compareMode?: boolean;
  onCompareSelect?: (studyId: string) => void;
}

export function Timeline({
  studies,
  selectedStudyId,
  onSelectStudy,
  compareMode,
  onCompareSelect,
}: TimelineProps) {
  // Group studies by year
  const studiesByYear = studies.reduce((acc, study) => {
    const year = study.study_date ? new Date(study.study_date).getFullYear() : 'Unknown';
    if (!acc[year]) acc[year] = [];
    acc[year].push(study);
    return acc;
  }, {} as Record<string | number, Study[]>);

  const years = Object.keys(studiesByYear).sort((a, b) => Number(b) - Number(a));

  return (
    <div className="h-full overflow-y-auto">
      <div className="p-4 border-b border-[var(--border-color)] sticky top-0 bg-[var(--bg-secondary)] z-10">
        <h2 className="text-sm font-semibold text-[var(--text-secondary)] uppercase tracking-wider flex items-center gap-2">
          <Calendar className="w-4 h-4" />
          Scan Timeline
        </h2>
      </div>

      <div className="p-2">
        {years.map((year) => (
          <div key={year} className="mb-4">
            <div className="text-xs font-medium text-[var(--text-secondary)] px-2 py-1 mb-1">
              {year}
            </div>
            <div className="space-y-1">
              {studiesByYear[year].map((study) => {
                const isSelected = study.study_id === selectedStudyId;
                return (
                  <button
                    key={study.study_id}
                    onClick={() => {
                      if (compareMode && onCompareSelect) {
                        onCompareSelect(study.study_id);
                      } else {
                        onSelectStudy(study.study_id);
                      }
                    }}
                    className={`w-full text-left px-3 py-2.5 rounded-lg transition-all duration-150 group ${
                      isSelected
                        ? 'bg-[var(--accent)] text-white'
                        : 'hover:bg-[var(--bg-tertiary)] text-[var(--text-primary)]'
                    }`}
                  >
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-2 min-w-0">
                        <Brain className={`w-4 h-4 flex-shrink-0 ${isSelected ? 'text-white' : 'text-[var(--accent)]'}`} />
                        <div className="truncate">
                          <div className="text-sm font-medium truncate">
                            {formatDate(study.study_date)}
                          </div>
                          <div className={`text-xs truncate ${isSelected ? 'text-blue-100' : 'text-[var(--text-secondary)]'}`}>
                            {study.series_count} series · {study.total_instances} images
                          </div>
                        </div>
                      </div>
                      <ChevronRight className={`w-4 h-4 flex-shrink-0 opacity-0 group-hover:opacity-100 transition-opacity ${isSelected ? 'opacity-100' : ''}`} />
                    </div>
                    <div className={`text-xs mt-1 truncate ${isSelected ? 'text-blue-100' : 'text-[var(--text-secondary)]'}`}>
                      {study.scan_type}
                    </div>
                  </button>
                );
              })}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
