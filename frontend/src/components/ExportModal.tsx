import { useEffect, useMemo, useState } from 'react';
import { Download, X, Loader2, CheckCircle, AlertCircle, Archive } from 'lucide-react';
import { getStudies } from '../utils/localApi';
import { exportStudiesToZip, type ExportProgress } from '../services/exportBackup';

type StudyItem = {
  study_id: string;
  study_date: string;
  scan_type: string;
  series_count: number;
  total_instances: number;
};

interface ExportModalProps {
  onClose: () => void;
}

function formatDateShort(isoOrYmd: string): string {
  if (!isoOrYmd) return 'Unknown date';
  if (isoOrYmd.length === 8) {
    return `${isoOrYmd.slice(0, 4)}-${isoOrYmd.slice(4, 6)}-${isoOrYmd.slice(6, 8)}`;
  }
  return isoOrYmd.split('T')[0];
}

export function ExportModal({ onClose }: ExportModalProps) {
  const [studies, setStudies] = useState<StudyItem[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [status, setStatus] = useState<'idle' | 'exporting' | 'success' | 'error'>('idle');
  const [progress, setProgress] = useState<ExportProgress | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const all = await getStudies();
        if (cancelled) return;
        setStudies(all);
        setSelected(new Set(all.map(s => s.study_id)));
      } catch (e) {
        if (cancelled) return;
        setErrorMessage(e instanceof Error ? e.message : 'Failed to load studies');
      }
    })();
    return () => { cancelled = true; };
  }, []);

  const selectedCount = selected.size;
  const totalCount = studies.length;
  const canExport = selectedCount > 0 && status !== 'exporting';

  const handleToggle = (id: string) => {
    setSelected(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const handleExport = async () => {
    if (!canExport) return;
    setStatus('exporting');
    setErrorMessage(null);
    setProgress({ stage: 'collecting', current: 0, total: 1 });
    try {
      const studyIds = Array.from(selected);
      const blob = await exportStudiesToZip(studyIds, setProgress);
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `miraviewer_backup_${new Date().toISOString().slice(0, 10)}.zip`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
      setStatus('success');
      setTimeout(() => onClose(), 1500);
    } catch (e) {
      setStatus('error');
      setErrorMessage(e instanceof Error ? e.message : 'Export failed');
    }
  };

  const progressLabel = useMemo(() => {
    if (!progress) return '';
    if (progress.stage === 'collecting') {
      return `Collecting files (${progress.current}/${progress.total}) ${progress.detail || ''}`.trim();
    }
    if (progress.stage === 'zipping') {
      return `Compressing (${progress.current}%)`;
    }
    return 'Finalizing…';
  }, [progress]);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm">
      <div className="w-[520px] bg-[var(--bg-secondary)] border border-[var(--border-color)] rounded-xl shadow-2xl overflow-hidden animate-in fade-in zoom-in-95 duration-200">
        <div className="flex items-center justify-between px-4 py-3 border-b border-[var(--border-color)]">
          <h3 className="text-sm font-semibold text-[var(--text-primary)] flex items-center gap-2">
            <Archive className="w-4 h-4" />
            Export Backup (ZIP)
          </h3>
          <button
            onClick={onClose}
            className="p-1 rounded-lg text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-tertiary)]"
            disabled={status === 'exporting'}
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="p-6">
          {status === 'success' ? (
            <div className="flex flex-col items-center justify-center py-4 text-center">
              <div className="w-12 h-12 rounded-full bg-green-500/20 text-green-500 flex items-center justify-center mb-3">
                <CheckCircle className="w-6 h-6" />
              </div>
              <h4 className="text-[var(--text-primary)] font-medium mb-1">Export complete</h4>
              <p className="text-sm text-[var(--text-secondary)]">Your ZIP download should begin shortly.</p>
            </div>
          ) : (
            <>
              <div className="text-xs text-[var(--text-secondary)] mb-3">
                This creates a ZIP backup of selected studies, including DICOM files and metadata.
              </div>

              <div className="max-h-64 overflow-auto border border-[var(--border-color)] rounded-lg divide-y divide-[var(--border-color)]">
                {studies.length === 0 ? (
                  <div className="p-4 text-sm text-[var(--text-secondary)]">No studies found.</div>
                ) : (
                  studies.map(study => {
                    const checked = selected.has(study.study_id);
                    return (
                      <label key={study.study_id} className="flex items-start gap-3 p-3 text-sm cursor-pointer hover:bg-[var(--bg-tertiary)]">
                        <input
                          type="checkbox"
                          checked={checked}
                          onChange={() => handleToggle(study.study_id)}
                        />
                        <div className="flex-1">
                          <div className="text-[var(--text-primary)] font-medium">
                            {formatDateShort(study.study_date)} · {study.scan_type || 'Study'}
                          </div>
                          <div className="text-[var(--text-secondary)] text-xs">
                            {study.series_count} series · {study.total_instances} instances
                          </div>
                        </div>
                      </label>
                    );
                  })
                )}
              </div>

              {status === 'exporting' && (
                <div className="mt-4 flex items-center gap-2 text-[var(--text-secondary)] text-sm">
                  <Loader2 className="w-4 h-4 animate-spin" />
                  {progressLabel || 'Exporting...'}
                </div>
              )}

              {errorMessage && (
                <div className="mt-4 flex items-center gap-2 text-red-400 text-sm bg-red-400/10 px-3 py-2 rounded-lg">
                  <AlertCircle className="w-4 h-4 shrink-0" />
                  {errorMessage}
                </div>
              )}

              <div className="mt-6 flex justify-between items-center">
                <div className="text-xs text-[var(--text-secondary)]">
                  {selectedCount}/{totalCount} selected
                </div>
                <div className="flex gap-2">
                  <button
                    onClick={onClose}
                    disabled={status === 'exporting'}
                    className="px-4 py-2 text-sm text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-tertiary)] rounded-lg transition-colors"
                  >
                    Cancel
                  </button>
                  <button
                    onClick={handleExport}
                    disabled={!canExport}
                    className="px-4 py-2 text-sm bg-[var(--accent)] text-white hover:bg-[var(--accent)]/90 rounded-lg transition-colors disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-2"
                  >
                    {status === 'exporting' ? (
                      <>
                        <Loader2 className="w-4 h-4 animate-spin" />
                        Exporting…
                      </>
                    ) : (
                      <>
                        <Download className="w-4 h-4" />
                        Export
                      </>
                    )}
                  </button>
                </div>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
