import type { Series } from '../types/api';
import { formatSeriesDescription } from '../utils/api';
import { Layers, Image as ImageIcon } from 'lucide-react';

interface SeriesListProps {
  series: Series[];
  selectedSeriesUid: string | null;
  onSelectSeries: (seriesUid: string) => void;
}

export function SeriesList({ series, selectedSeriesUid, onSelectSeries }: SeriesListProps) {
  if (series.length === 0) {
    return (
      <div className="h-full flex items-center justify-center text-[var(--text-secondary)] text-sm">
        No series available
      </div>
    );
  }

  return (
    <div className="h-full overflow-y-auto">
      <div className="p-4 border-b border-[var(--border-color)] sticky top-0 bg-[var(--bg-secondary)] z-10">
        <h2 className="text-sm font-semibold text-[var(--text-secondary)] uppercase tracking-wider flex items-center gap-2">
          <Layers className="w-4 h-4" />
          Series ({series.length})
        </h2>
      </div>

      <div className="p-2 space-y-1">
        {series.map((s) => {
          const isSelected = s.series_uid === selectedSeriesUid;
          return (
            <button
              key={s.series_uid}
              onClick={() => onSelectSeries(s.series_uid)}
              className={`w-full text-left px-3 py-2.5 rounded-lg transition-all duration-150 ${
                isSelected
                  ? 'bg-[var(--accent)] text-white'
                  : 'hover:bg-[var(--bg-tertiary)] text-[var(--text-primary)]'
              }`}
            >
              <div className="flex items-start gap-2">
                <div className={`p-1.5 rounded ${isSelected ? 'bg-blue-600' : 'bg-[var(--bg-tertiary)]'}`}>
                  <ImageIcon className="w-3.5 h-3.5" />
                </div>
                <div className="flex-1 min-w-0">
                  <div className="text-sm font-medium truncate">
                    {formatSeriesDescription(s.series_description)}
                  </div>
                  <div className={`text-xs ${isSelected ? 'text-blue-100' : 'text-[var(--text-secondary)]'}`}>
                    #{s.series_number} · {s.instance_count} slices
                  </div>
                </div>
              </div>
            </button>
          );
        })}
      </div>
    </div>
  );
}
