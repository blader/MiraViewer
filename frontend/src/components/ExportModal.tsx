import { useEffect, useMemo, useRef, useState } from 'react';
import { Download, Loader2, CheckCircle, AlertCircle } from 'lucide-react';
import { getStudies } from '../utils/localApi';
import { exportStudiesToZip, exportStudiesToFile, type ExportProgress } from '../services/exportBackup';
import { MAX_ENTRY_BYTES } from '../services/archiveSafety';
import { AccessibleDialog } from './ui/AccessibleDialog';
import { formatBytes } from '../utils/format';

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
  const [status, setStatus] = useState<'idle' | 'exporting' | 'finishing' | 'success' | 'error'>('idle');
  const [progress, setProgress] = useState<ExportProgress | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const exportRef = useRef<AbortController | null>(null);
  const committingRef = useRef(false);
  const closeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const all = await getStudies();
        if (cancelled) return;
        setStudies(all);
        setSelected(new Set(all.map((s) => s.study_id)));
      } catch (e) {
        if (cancelled) return;
        setErrorMessage(e instanceof Error ? e.message : 'Failed to load studies');
      }
    })();
    return () => {
      cancelled = true;
      if (!committingRef.current) exportRef.current?.abort();
      exportRef.current = null;
      if (closeTimerRef.current !== null) clearTimeout(closeTimerRef.current);
    };
  }, []);

  const selectedCount = selected.size;
  const totalCount = studies.length;
  const busy = status === 'exporting' || status === 'finishing';
  const canExport = selectedCount > 0 && !busy;
  const picker = (
    window as Window & {
      showSaveFilePicker?: (options: {
        suggestedName: string;
        types: { description: string; accept: Record<string, string[]> }[];
      }) => Promise<FileSystemFileHandle>;
    }
  ).showSaveFilePicker;

  const handleToggle = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const handleExport = async (direct = false) => {
    if (!canExport || exportRef.current) return;
    const controller = new AbortController();
    exportRef.current = controller;
    setStatus('exporting');
    setErrorMessage(null);
    setProgress({ stage: 'checking', current: 0, total: 1 });
    try {
      const studyIds = Array.from(selected);
      const filename = `miraviewer_backup_${new Date().toISOString().slice(0, 10)}.zip`;
      const onProgress = (next: ExportProgress) => {
        if (exportRef.current === controller && !controller.signal.aborted) setProgress(next);
      };
      if (direct && picker) {
        const handle = await picker.call(window, {
          suggestedName: filename,
          types: [{ description: 'ZIP backup', accept: { 'application/zip': ['.zip'] } }],
        });
        if (controller.signal.aborted) return;
        const sink = await handle.createWritable();
        if (controller.signal.aborted) {
          await sink.abort();
          return;
        }
        await exportStudiesToFile(studyIds, sink, onProgress, {
          signal: controller.signal,
          onCommitStart: () => {
            committingRef.current = true;
            setStatus('finishing');
          },
        });
      } else {
        const blob = await exportStudiesToZip(studyIds, onProgress, { signal: controller.signal });
        if (exportRef.current !== controller || controller.signal.aborted) return;
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        a.remove();
        URL.revokeObjectURL(url);
      }
      if (exportRef.current !== controller || controller.signal.aborted) return;
      setStatus('success');
      closeTimerRef.current = setTimeout(onClose, 1500);
    } catch (e) {
      if (exportRef.current !== controller || controller.signal.aborted) return;
      if ((e as { name?: string })?.name === 'AbortError') {
        setStatus('idle');
        return;
      }
      setStatus('error');
      setErrorMessage(e instanceof Error ? e.message : 'Export failed');
    } finally {
      committingRef.current = false;
      if (exportRef.current === controller) exportRef.current = null;
    }
  };

  const close = () => {
    if (committingRef.current) return;
    exportRef.current?.abort();
    exportRef.current = null;
    if (closeTimerRef.current !== null) clearTimeout(closeTimerRef.current);
    onClose();
  };

  const progressLabel = useMemo(() => {
    if (!progress) return '';
    if (progress.stage === 'checking') return 'Checking backup size…';
    if (progress.stage === 'collecting') {
      return `Collecting files (${progress.current}/${progress.total}) ${progress.detail || ''}`.trim();
    }
    if (progress.stage === 'zipping') {
      return `Packaging (${progress.current}%)`;
    }
    return 'Finalizing…';
  }, [progress]);

  return (
    <AccessibleDialog
      title="Export Backup (ZIP)"
      description="Create a complete local backup of the selected patient's imaging and saved work."
      onClose={close}
      closeDisabled={status === 'finishing'}
      closeOnEscape={status !== 'finishing'}
    >
      <div className="overflow-y-auto px-5 py-6 sm:px-7">
        {status === 'success' ? (
          <div className="flex items-start gap-3 py-4" role="status">
            <CheckCircle className="mt-0.5 h-5 w-5 shrink-0 text-[var(--evidence)]" aria-hidden="true" />
            <div>
              <h4 className="mb-1 font-medium text-[var(--text-primary)]">Export complete</h4>
              <p className="text-sm text-[var(--text-secondary)]">Your backup is ready on this device.</p>
            </div>
          </div>
        ) : (
          <>
            <p className="mb-2 font-[family-name:var(--font-mono)] text-[0.68rem] tracking-[0.13em] text-[var(--signal-metal)]">
              COMPLETE BACKUP
            </p>
            <div className="mb-5 text-[0.82rem] leading-relaxed text-[var(--text-secondary)]">
              The archive includes selected scans, annotations, ground truth, viewer settings, 3D selections and shared
              local models.
              <p className="mt-2">
                Each individual file can be up to {formatBytes(MAX_ENTRY_BYTES)}. Larger complete backups are supported
                when the browser has enough storage to restore them.
              </p>
              {picker && (
                <p className="mt-2">For large backups, Save directly writes to your chosen file as it runs.</p>
              )}
            </div>

            <div className="mb-2 flex items-center justify-between gap-3">
              <span className="font-[family-name:var(--font-mono)] text-[0.68rem] tracking-[0.11em] text-[var(--text-secondary)]">
                EXAMINATIONS
              </span>
              <span className="text-xs tabular-nums text-[var(--text-secondary)]">
                {selectedCount}/{totalCount} selected
              </span>
            </div>
            <div className="max-h-64 divide-y divide-[var(--border-color)] overflow-auto rounded-[3px] border border-[var(--border-color)]">
              {studies.length === 0 ? (
                <div className="p-4 text-sm text-[var(--text-secondary)]">No studies found.</div>
              ) : (
                studies.map((study) => {
                  const checked = selected.has(study.study_id);
                  return (
                    <label
                      key={study.study_id}
                      className="flex min-h-14 cursor-pointer items-start gap-3 px-3 py-3 text-sm transition-colors hover:bg-[var(--bg-tertiary)]"
                    >
                      <input
                        type="checkbox"
                        checked={checked}
                        disabled={busy}
                        onChange={() => handleToggle(study.study_id)}
                        className="mt-1 accent-[var(--signal-metal)]"
                      />
                      <div className="flex-1">
                        <div className="font-medium tabular-nums text-[var(--text-primary)]">
                          {formatDateShort(study.study_date)} · {study.scan_type || 'Study'}
                        </div>
                        <div className="mt-1 text-xs text-[var(--text-secondary)]">
                          {study.series_count} series · {study.total_instances} instances
                        </div>
                      </div>
                    </label>
                  );
                })
              )}
            </div>

            {busy && (
              <div className="mt-4 flex items-center gap-2 text-sm text-[var(--text-secondary)]" role="status">
                <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
                {progressLabel || 'Exporting...'}
              </div>
            )}

            {errorMessage && (
              <div
                className="mt-4 flex items-center gap-2 rounded-[3px] border border-[var(--danger)] px-3 py-2 text-sm text-[var(--danger)]"
                role="alert"
              >
                <AlertCircle className="h-4 w-4 shrink-0" aria-hidden="true" />
                {errorMessage}
              </div>
            )}

            <div className="mt-6 flex items-center justify-between gap-4 border-t border-[var(--border-color)] pt-5">
              <div className="text-xs text-[var(--text-secondary)]">Stored on this device</div>
              <div className="flex flex-wrap justify-end gap-2">
                <button
                  type="button"
                  onClick={close}
                  disabled={status === 'finishing'}
                  className="min-h-11 rounded-[3px] px-4 py-2 text-sm text-[var(--text-secondary)] transition-colors hover:bg-[var(--bg-tertiary)] hover:text-[var(--text-primary)] disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {status === 'finishing' ? 'Finishing…' : status === 'exporting' ? 'Cancel export' : 'Cancel'}
                </button>
                {picker && (
                  <button
                    type="button"
                    onClick={() => void handleExport(true)}
                    disabled={!canExport}
                    className="min-h-11 rounded-[3px] border border-[var(--border-color)] px-4 py-2 text-sm text-[var(--text-primary)] disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    Save directly…
                  </button>
                )}
                <button
                  type="button"
                  onClick={() => void handleExport()}
                  disabled={!canExport}
                  className="flex min-h-11 items-center gap-2 rounded-[3px] bg-[var(--accent)] px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-[var(--accent-hover)] disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {busy ? (
                    <>
                      <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
                      Exporting…
                    </>
                  ) : (
                    <>
                      <Download className="h-4 w-4" aria-hidden="true" />
                      Export
                    </>
                  )}
                </button>
              </div>
            </div>
          </>
        )}
      </div>
    </AccessibleDialog>
  );
}
