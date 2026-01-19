import { useRef, useState } from 'react';
import { Upload, X, Loader2, AlertCircle, CheckCircle, FileArchive } from 'lucide-react';
import JSZip from 'jszip';
import { processDicomFile, processFiles } from '../services/dicomIngestion';

interface UploadModalProps {
  onClose: () => void;
  onUploadComplete?: () => void;
}

export function UploadModal({ onClose, onUploadComplete }: UploadModalProps) {
  const [files, setFiles] = useState<File[]>([]);
  const [zipFile, setZipFile] = useState<File | null>(null);
  const [status, setStatus] = useState<'idle' | 'uploading' | 'success' | 'error'>('idle');
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [progress, setProgress] = useState<{ current: number; total: number; label?: string } | null>(null);
  const [importSummary, setImportSummary] = useState<{
    total: number;
    ingested: number;
    duplicates: number;
    skipped: number;
    errors: number;
    errorSamples: string[];
  } | null>(null);

  const fileInputRef = useRef<HTMLInputElement>(null);

  const openFilesPicker = () => {
    const input = fileInputRef.current;
    if (!input) return;
    input.value = '';
    input.click();
  };

  type DirectoryHandle = {
    kind?: 'directory';
    name?: string;
    entries: () => AsyncIterable<[string, unknown]>;
  };

  type FileHandle = {
    kind?: 'file';
    name?: string;
    getFile: () => Promise<File>;
  };

  const isAbortError = (err: unknown): boolean => {
    const anyErr = err as { name?: unknown };
    return anyErr?.name === 'AbortError';
  };

  const toErrorMessage = (err: unknown): string => {
    return err instanceof Error ? err.message : String(err);
  };

  async function collectFilesFromDir(handle: DirectoryHandle): Promise<File[]> {
    const out: File[] = [];

    for await (const [, entry] of handle.entries()) {
      const entryAny = entry as { kind?: string };
      if (entryAny.kind === 'file') {
        const file = await (entry as FileHandle).getFile();
        out.push(file);
      } else if (entryAny.kind === 'directory') {
        out.push(...(await collectFilesFromDir(entry as DirectoryHandle)));
      }
    }

    return out;
  }

  const openFolderPicker = async () => {
    // Prefer the File System Access API.
    // This avoids the Chromium/Firefox folder-upload confirmation prompt
    // ("Only do this if you trust the site") triggered by <input webkitdirectory>.
    const picker = (window as unknown as { showDirectoryPicker?: () => Promise<DirectoryHandle> }).showDirectoryPicker;

    if (!picker) {
      setErrorMessage('Folder import is not supported in this browser. Please select files or upload a ZIP.');
      return;
    }

    try {
      const dir = await picker();
      const collected = await collectFilesFromDir(dir);

      if (collected.length === 0) {
        setErrorMessage('The selected folder contained no files.');
        return;
      }

      setZipFile(null);
      setFiles(collected);
      setStatus('idle');
      setErrorMessage(null);
      setImportSummary(null);
    } catch (err) {
      if (isAbortError(err)) {
        // User cancelled the picker.
        return;
      }
      setErrorMessage(`Failed to select folder: ${toErrorMessage(err)}`);
    }
  };

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (!e.target.files) return;

    const selected = Array.from(e.target.files);
    if (selected.length === 0) {
      // If folder selection returns 0 files (often caused by accept filtering),
      // surface a helpful hint instead of silently doing nothing.
      setStatus('idle');
      setZipFile(null);
      setFiles([]);
      setImportSummary(null);
      setErrorMessage(
        'No files were selected. If you chose a folder containing DICOMs without extensions, try again using “Select folder”.'
      );
      return;
    }

    const zip = selected.length === 1 && selected[0].name.toLowerCase().endsWith('.zip')
      ? selected[0]
      : null;

    setZipFile(zip);
    setFiles(zip ? [] : selected);
    setStatus('idle');
    setErrorMessage(null);
    setImportSummary(null);
  };

  const handleUpload = async () => {
    if (files.length === 0 && !zipFile) return;

    setStatus('uploading');
    setErrorMessage(null);
    setImportSummary(null);
    setProgress({ current: 0, total: 1, label: 'Preparing…' });

    try {
      let summary: {
        total: number;
        ingested: number;
        duplicates: number;
        skipped: number;
        errors: number;
        errorSamples: string[];
      };

      if (zipFile) {
        // Expand ZIP in browser and ingest file-by-file.
        const zip = await JSZip.loadAsync(zipFile);
        const entries = Object.values(zip.files).filter((f) => !f.dir);
        const total = entries.length;

        let current = 0;
        let ingested = 0;
        let duplicates = 0;
        let skipped = 0;
        let errors = 0;
        const errorSamples: string[] = [];

        for (const entry of entries) {
          const blob = await entry.async('blob');

          // Preserve the full entry path for progress labels, but use only the
          // filename for ingestion heuristics (extension checks, etc.).
          const baseName = entry.name.split('/').pop() || entry.name;
          const file = new File([blob], baseName, { type: blob.type || 'application/dicom' });

          const r = await processDicomFile(file);
          if (r.status === 'ingested') ingested += 1;
          else if (r.status === 'duplicate') duplicates += 1;
          else if (r.status === 'skipped') skipped += 1;
          else {
            errors += 1;
            if (errorSamples.length < 3) {
              errorSamples.push(`${r.fileName}: ${r.message}`);
            }
          }

          current += 1;
          setProgress({ current, total: Math.max(total, 1), label: entry.name });
        }

        summary = { total, ingested, duplicates, skipped, errors, errorSamples };
      } else {
        const res = await processFiles(files, (current, total) => {
          setProgress({ current, total });
        });
        summary = res;
      }

      setImportSummary(summary);

      // Treat "0 ingested" as a user-visible error *only* if nothing was recognized.
      // If everything was already imported (duplicates), that's a successful no-op.
      if (summary.ingested === 0 && summary.duplicates === 0) {
        const parts = [
          'No displayable DICOM images were imported.',
          `Processed: ${summary.total}.`,
          summary.skipped ? `Skipped: ${summary.skipped}.` : null,
          summary.errors ? `Errors: ${summary.errors}.` : null,
          summary.errorSamples.length ? `Examples: ${summary.errorSamples.join(' | ')}` : null,
        ].filter(Boolean);

        setStatus('error');
        setErrorMessage(parts.join(' '));
        return;
      }

      setStatus('success');
      if (onUploadComplete) {
        onUploadComplete();
      }
      // Close after a short delay so user sees success
      setTimeout(() => {
        onClose();
      }, 2000);
    } catch (err) {
      setStatus('error');
      setErrorMessage(err instanceof Error ? err.message : 'Upload failed');
    }
  };

  const hasSelection = files.length > 0 || !!zipFile;
  const totalSizeMb = zipFile
    ? zipFile.size / (1024 * 1024)
    : files.reduce((acc, f) => acc + f.size, 0) / (1024 * 1024);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm">
      <div className="w-[480px] bg-[var(--bg-secondary)] border border-[var(--border-color)] rounded-xl shadow-2xl overflow-hidden animate-in fade-in zoom-in-95 duration-200">
        <div className="flex items-center justify-between px-4 py-3 border-b border-[var(--border-color)]">
          <h3 className="text-sm font-semibold text-[var(--text-primary)] flex items-center gap-2">
            <Upload className="w-4 h-4" />
            Upload DICOM Archive
          </h3>
          <button
            onClick={onClose}
            className="p-1 rounded-lg text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-tertiary)]"
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
              <h4 className="text-[var(--text-primary)] font-medium mb-1">Upload Successful</h4>
              <p className="text-sm text-[var(--text-secondary)]">
                {importSummary
                  ? importSummary.ingested > 0
                    ? `Imported ${importSummary.ingested} new images into local storage.`
                    : importSummary.duplicates > 0
                      ? 'No new images were imported (all duplicates).'
                      : 'Imported into local storage.'
                  : 'Imported into local storage.'}
              </p>
              {importSummary && (importSummary.duplicates > 0 || importSummary.skipped > 0 || importSummary.errors > 0) && (
                <p className="text-xs text-[var(--text-tertiary)] mt-1">
                  {importSummary.duplicates > 0 ? `Duplicates ${importSummary.duplicates}. ` : ''}
                  {importSummary.skipped > 0 ? `Skipped ${importSummary.skipped}. ` : ''}
                  {importSummary.errors > 0 ? `Errors ${importSummary.errors}.` : ''}
                </p>
              )}
            </div>
          ) : (
            <>
              <div
                onClick={() => {
                  // Default: prefer folder import, but fall back to file picker in browsers
                  // that don't support the File System Access API.
                  const picker = (window as unknown as { showDirectoryPicker?: () => Promise<unknown> }).showDirectoryPicker;
                  if (picker) {
                    void openFolderPicker();
                  } else {
                    openFilesPicker();
                  }
                }}
                className={`border-2 border-dashed rounded-lg p-8 flex flex-col items-center justify-center cursor-pointer transition-colors ${
                  hasSelection
                    ? 'border-[var(--accent)] bg-[var(--accent)]/5'
                    : 'border-[var(--border-color)] hover:border-[var(--text-secondary)] hover:bg-[var(--bg-tertiary)]'
                }`}
              >
                <input
                  ref={fileInputRef}
                  type="file"
                  accept=".dcm,.dicom,.ima,.zip"
                  multiple
                  onClick={(e) => e.stopPropagation()}
                  onChange={handleFileChange}
                  className="hidden"
                />
                
                {hasSelection ? (
                  <>
                    <div className="w-10 h-10 rounded-full bg-[var(--accent)]/20 text-[var(--accent)] flex items-center justify-center mb-3">
                      <FileArchive className="w-5 h-5" /> 
                    </div>
                    <p className="text-sm font-medium text-[var(--text-primary)] text-center break-all">
                      {zipFile ? zipFile.name : `${files.length} files selected`}
                    </p>
                    <p className="text-xs text-[var(--text-secondary)] mt-1">
                      {totalSizeMb.toFixed(2)} MB
                    </p>
                  </>
                ) : (
                  <>
                    <Upload className="w-8 h-8 text-[var(--text-tertiary)] mb-3" />
                    <p className="text-sm text-[var(--text-primary)] font-medium">Click to select files or folder</p>
                    <p className="text-xs text-[var(--text-secondary)] mt-1">DICOM files (.dcm/.dicom/.ima) or a .zip</p>
                  </>
                )}
              </div>
              <div className="mt-3 flex items-center justify-center gap-2">
                <button
                  type="button"
                  onClick={openFilesPicker}
                  className="px-3 py-1.5 text-xs rounded-lg border border-[var(--border-color)] bg-[var(--bg-secondary)] text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-tertiary)]"
                >
                  Select files / ZIP
                </button>
                <button
                  type="button"
                  onClick={() => void openFolderPicker()}
                  className="px-3 py-1.5 text-xs rounded-lg border border-[var(--border-color)] bg-[var(--bg-secondary)] text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-tertiary)]"
                >
                  Select folder
                </button>
              </div>
              {status === 'uploading' && progress && (
                <div className="mt-4 flex items-center gap-2 text-[var(--text-secondary)] text-sm">
                  <Loader2 className="w-4 h-4 animate-spin" />
                  {progress.label
                    ? `${progress.current}/${progress.total} · ${progress.label}`
                    : `${progress.current}/${progress.total}`}
                </div>
              )}

              {errorMessage && (
                <div className="mt-4 flex items-center gap-2 text-red-400 text-sm bg-red-400/10 px-3 py-2 rounded-lg">
                  <AlertCircle className="w-4 h-4 shrink-0" />
                  {errorMessage}
                </div>
              )}

              <div className="mt-6 flex justify-end gap-2">
                <button
                  onClick={onClose}
                  disabled={status === 'uploading'}
                  className="px-4 py-2 text-sm text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-tertiary)] rounded-lg transition-colors"
                >
                  Cancel
                </button>
                <button
                  onClick={handleUpload}
                  disabled={!hasSelection || status === 'uploading'}
                  className="px-4 py-2 text-sm bg-[var(--accent)] text-white hover:bg-[var(--accent)]/90 rounded-lg transition-colors disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-2"
                >
                  {status === 'uploading' ? (
                    <>
                      <Loader2 className="w-4 h-4 animate-spin" />
                      Uploading...
                    </>
                  ) : (
                    'Upload'
                  )}
                </button>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
