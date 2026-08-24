import { useEffect, useRef, useState } from 'react';
import type { ChangeEvent, DragEvent } from 'react';
import { AlertCircle, ArchiveRestore, CheckCircle2, Files, FolderOpen, Loader2 } from 'lucide-react';
import { getStorageHealth, subscribeStorageHealth } from '../db/db';
import { loadSafeArchive, readArchiveEntry } from '../services/archiveSafety';
import type { SafeArchive } from '../services/archiveSafety';
import { isDicomCandidate, processFiles } from '../services/dicomIngestion';
import type { ProcessFilesProgress, ProcessFilesResult } from '../services/dicomIngestion';
import {
  getSnapshotRestoreBytes,
  MAX_SNAPSHOT_RESTORE_BYTES,
  readSnapshotManifest,
  restoreSnapshot,
} from '../services/exportBackup';
import { yieldToMain } from '../utils/svr/svrUtils';
import { AccessibleDialog } from './ui/AccessibleDialog';

interface UploadModalProps {
  onClose: () => void;
  onUploadComplete?: () => void | Promise<void>;
}

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

type SnapshotManifest = NonNullable<Awaited<ReturnType<typeof readSnapshotManifest>>>;
type ImportSummary = ProcessFilesResult & { archiveIntegrityErrors?: number; integrityWarnings?: string[] };
type IntakePhase =
  | 'idle'
  | 'discovering'
  | 'preparing'
  | 'reviewing'
  | 'importing'
  | 'restoring'
  | 'canceling'
  | 'finishing'
  | 'complete'
  | 'partial'
  | 'canceled'
  | 'failed';

type IntakeSource = {
  kind: 'files' | 'folder' | 'image-archive' | 'complete-backup';
  label: string;
  imageCount: number;
  totalBytes: number;
  restoreBytes?: number;
  ignoredCount: number;
  files?: File[];
  directory?: DirectoryHandle;
  archive?: SafeArchive;
  manifest?: SnapshotManifest;
};

type IntakeProgress = {
  current: number;
  total: number;
  label: string;
};

type IntakeOperation = {
  controller: AbortController;
  committing: boolean;
  committed?: ProcessFilesProgress;
  total?: number;
  pendingProgress?: IntakeProgress;
  progressTimer?: number;
};

const MAX_DIRECTORY_DEPTH = 48;
const MAX_DIRECTORY_FILES = 100_000;
const PROGRESS_INTERVAL_MS = 120;

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException
    ? error.name === 'AbortError'
    : (error as { name?: string })?.name === 'AbortError';
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw new DOMException('Import canceled', 'AbortError');
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = bytes / 1024;
  let index = 0;
  while (value >= 1024 && index < units.length - 1) {
    value /= 1024;
    index += 1;
  }
  return `${value.toFixed(value >= 100 ? 0 : value >= 10 ? 1 : 2)} ${units[index]}`;
}

async function* iterateDirectory(
  root: DirectoryHandle,
  signal: AbortSignal,
  onIgnored?: () => void,
): AsyncGenerator<File> {
  const pending: Array<{ directory: DirectoryHandle; depth: number }> = [{ directory: root, depth: 0 }];
  let visited = 0;

  while (pending.length > 0) {
    throwIfAborted(signal);
    const current = pending.pop()!;
    for await (const [name, entry] of current.directory.entries()) {
      throwIfAborted(signal);
      if (++visited > MAX_DIRECTORY_FILES) {
        throw new Error('This folder contains more than 100,000 entries. Choose a smaller acquisition folder.');
      }
      if (visited % 64 === 0) {
        await yieldToMain();
        throwIfAborted(signal);
      }

      const handle = entry as { kind?: string };
      if (handle.kind === 'directory') {
        if (current.depth >= MAX_DIRECTORY_DEPTH) {
          throw new Error('This folder exceeds the supported nesting depth. Choose a shallower acquisition folder.');
        }
        pending.push({ directory: entry as DirectoryHandle, depth: current.depth + 1 });
      } else if (handle.kind === 'file') {
        if (!isDicomCandidate(name)) {
          onIgnored?.();
          continue;
        }
        const file = await (entry as FileHandle).getFile();
        throwIfAborted(signal);
        yield file;
      }
    }
  }
}

export function UploadModal({ onClose, onUploadComplete }: UploadModalProps) {
  const [phase, setPhase] = useState<IntakePhase>('idle');
  const [source, setSource] = useState<IntakeSource | null>(null);
  const [progress, setProgress] = useState<IntakeProgress | null>(null);
  const [summary, setSummary] = useState<ImportSummary | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [restoreConfirmed, setRestoreConfirmed] = useState(false);
  const [dragActive, setDragActive] = useState(false);
  const [storageHealth, setStorageHealth] = useState(getStorageHealth);

  const fileInputRef = useRef<HTMLInputElement>(null);
  const backupInputRef = useRef<HTMLInputElement>(null);
  const folderInputRef = useRef<HTMLInputElement | null>(null);
  const operationRef = useRef<IntakeOperation | null>(null);

  useEffect(() => subscribeStorageHealth(setStorageHealth), []);

  useEffect(
    () => () => {
      const operation = operationRef.current;
      operation?.controller.abort();
      if (operation?.progressTimer !== undefined) window.clearTimeout(operation.progressTimer);
      operationRef.current = null;
    },
    [],
  );

  const busy =
    phase === 'discovering' ||
    phase === 'preparing' ||
    phase === 'importing' ||
    phase === 'restoring' ||
    phase === 'canceling' ||
    phase === 'finishing';

  const beginOperation = (nextPhase: IntakePhase): IntakeOperation | null => {
    if (operationRef.current) return null;
    const operation = { controller: new AbortController(), committing: false };
    operationRef.current = operation;
    setPhase(nextPhase);
    setErrorMessage(null);
    setSummary(null);
    return operation;
  };

  const publishProgress = (operation: IntakeOperation, next: IntakeProgress, immediate = false): void => {
    if (operationRef.current !== operation) return;
    operation.pendingProgress = next;
    if (!immediate && operation.progressTimer !== undefined) return;
    if (operation.progressTimer !== undefined) window.clearTimeout(operation.progressTimer);
    setProgress(next);
    operation.pendingProgress = undefined;
    operation.progressTimer = window.setTimeout(() => {
      operation.progressTimer = undefined;
      if (operation.pendingProgress) publishProgress(operation, operation.pendingProgress, true);
    }, PROGRESS_INTERVAL_MS);
  };

  const endOperation = (operation: IntakeOperation): void => {
    if (operationRef.current !== operation) return;
    operationRef.current = null;
    if (operation.progressTimer !== undefined) window.clearTimeout(operation.progressTimer);
  };

  const reportFailure = (operation: IntakeOperation, error: unknown): void => {
    if (operationRef.current !== operation) return;
    const canceled = isAbortError(error) || operation.controller.signal.aborted;
    if (operation.committed && operation.committed.ingested > 0) {
      const { ingested, duplicates, skipped, errors } = operation.committed;
      setSummary({
        total: operation.total ?? ingested + duplicates + skipped + errors,
        ingested,
        duplicates,
        skipped,
        errors: errors + (canceled ? 0 : 1),
        errorSamples: [],
        cancelled: canceled,
      });
      setPhase(canceled ? 'canceled' : 'partial');
      setErrorMessage(
        canceled ? null : 'Some images were saved before this import stopped. Review or retry the source.',
      );
      endOperation(operation);
      void onUploadComplete?.();
      return;
    }
    if (canceled) {
      setPhase('canceled');
      setErrorMessage(null);
    } else {
      setPhase('failed');
      setErrorMessage(error instanceof Error ? error.message : 'The selected acquisition could not be imported.');
    }
    endOperation(operation);
  };

  const reviewFiles = (selected: File[], folderLabel?: string): void => {
    if (operationRef.current) return;
    if (selected.length === 0) {
      setSource(null);
      setPhase('failed');
      setErrorMessage('No files were selected. Choose DICOM images, an acquisition folder, or a ZIP archive.');
      return;
    }

    const archives = selected.filter((file) => file.name.toLowerCase().endsWith('.zip'));
    if (archives.length > 0 && selected.length !== 1) {
      setSource(null);
      setPhase('failed');
      setErrorMessage('Import a ZIP archive separately from individual DICOM files.');
      return;
    }
    if (archives.length === 1) {
      void reviewArchive(archives[0]!);
      return;
    }

    let totalBytes = 0;
    let ignoredCount = 0;
    const candidates: File[] = [];
    for (const file of selected) {
      if (isDicomCandidate(file.name)) {
        candidates.push(file);
        totalBytes += file.size;
      } else {
        ignoredCount += 1;
      }
    }
    if (candidates.length === 0) {
      setSource(null);
      setPhase('failed');
      setErrorMessage('The selected source contains no files that could be DICOM images.');
      return;
    }

    setSource({
      kind: folderLabel ? 'folder' : 'files',
      label: folderLabel ?? (candidates.length === 1 ? candidates[0]!.name : `${candidates.length} selected files`),
      imageCount: candidates.length,
      totalBytes,
      ignoredCount,
      files: candidates,
    });
    setSummary(null);
    setProgress(null);
    setRestoreConfirmed(false);
    setErrorMessage(null);
    setPhase('reviewing');
  };

  const reviewArchive = async (file: File): Promise<void> => {
    const operation = beginOperation('preparing');
    if (!operation) return;
    setSource(null);
    setRestoreConfirmed(false);
    publishProgress(operation, { current: 0, total: 0, label: 'Inspecting archive safely' }, true);
    try {
      const archive = await loadSafeArchive(file, {
        signal: operation.controller.signal,
        deferStorageCheck: true,
        onProgress: (current, total) => {
          publishProgress(operation, { current, total, label: 'Inspecting archive safely' });
        },
      });
      throwIfAborted(operation.controller.signal);
      const manifest = await readSnapshotManifest(archive.zip, { signal: operation.controller.signal });
      throwIfAborted(operation.controller.signal);
      if (operationRef.current !== operation) return;
      const entries = archive.entries.filter((entry) => isDicomCandidate(entry.name));
      if (!manifest && entries.length === 0) {
        throw new Error('This archive contains no files that could be DICOM images.');
      }
      const restoreBytes = manifest ? getSnapshotRestoreBytes(manifest) : undefined;
      setSource({
        kind: manifest ? 'complete-backup' : 'image-archive',
        label: file.name,
        imageCount: manifest?.records.instances.length ?? entries.length,
        totalBytes: file.size,
        restoreBytes,
        ignoredCount: manifest ? 0 : archive.entries.length - entries.length,
        archive,
        manifest: manifest ?? undefined,
      });
      setProgress(null);
      setPhase('reviewing');
      endOperation(operation);
    } catch (error) {
      reportFailure(operation, error);
    }
  };

  const reviewDirectory = async (directory: DirectoryHandle): Promise<void> => {
    const operation = beginOperation('discovering');
    if (!operation) return;
    setSource(null);
    setRestoreConfirmed(false);
    publishProgress(operation, { current: 0, total: 0, label: 'Discovering acquisition images' }, true);
    let imageCount = 0;
    let totalBytes = 0;
    let ignoredCount = 0;

    try {
      for await (const file of iterateDirectory(directory, operation.controller.signal, () => {
        ignoredCount += 1;
      })) {
        imageCount += 1;
        totalBytes += file.size;
        publishProgress(operation, { current: imageCount, total: 0, label: 'Discovering acquisition images' });
      }
      throwIfAborted(operation.controller.signal);
      if (imageCount === 0) throw new Error('The selected folder contains no files that could be DICOM images.');
      if (operationRef.current !== operation) return;
      setSource({
        kind: 'folder',
        label: directory.name || 'Selected acquisition folder',
        imageCount,
        totalBytes,
        ignoredCount,
        directory,
      });
      setProgress(null);
      setPhase('reviewing');
      endOperation(operation);
    } catch (error) {
      reportFailure(operation, error);
    }
  };

  const openInput = (input: HTMLInputElement | null): void => {
    if (!input || busy || operationRef.current) return;
    input.value = '';
    input.click();
  };

  const openFolderPicker = async (): Promise<void> => {
    if (busy || operationRef.current) return;
    const picker = (window as Window & { showDirectoryPicker?: () => Promise<DirectoryHandle> }).showDirectoryPicker;
    if (!picker) {
      openInput(folderInputRef.current);
      return;
    }
    try {
      const directory = await picker();
      await reviewDirectory(directory);
    } catch (error) {
      if (!isAbortError(error)) {
        setPhase('failed');
        setErrorMessage('The folder could not be opened. Grant browser access or choose individual DICOM files.');
      }
    }
  };

  const handleFilesChange = (event: ChangeEvent<HTMLInputElement>, fromFolder = false): void => {
    if (busy || operationRef.current || !event.target.files) return;
    const selected = Array.from(event.target.files);
    const relativePath = (selected[0] as (File & { webkitRelativePath?: string }) | undefined)?.webkitRelativePath;
    reviewFiles(selected, fromFolder ? relativePath?.split('/')[0] || 'Selected acquisition folder' : undefined);
  };

  const handleDrop = async (event: DragEvent<HTMLButtonElement>): Promise<void> => {
    event.preventDefault();
    setDragActive(false);
    if (busy || operationRef.current) return;
    const items = Array.from(event.dataTransfer.items ?? []);
    if (items.some((item) => item.kind !== 'file')) {
      setPhase('failed');
      setErrorMessage('Only local DICOM files and folders can be imported. External links are not supported.');
      return;
    }

    if (items.length === 1) {
      const getHandle = (items[0] as DataTransferItem & { getAsFileSystemHandle?: () => Promise<unknown> })
        .getAsFileSystemHandle;
      if (getHandle) {
        try {
          const handle = (await getHandle.call(items[0])) as { kind?: string };
          if (handle?.kind === 'directory') {
            await reviewDirectory(handle as DirectoryHandle);
            return;
          }
        } catch (error) {
          if (!isAbortError(error)) {
            setPhase('failed');
            setErrorMessage('The dropped folder could not be opened. Use Choose folder instead.');
          }
          return;
        }
      }
    }

    const dropped = Array.from(event.dataTransfer.files);
    if (dropped.length === 0) {
      setPhase('failed');
      setErrorMessage('This browser could not open the dropped folder. Use Choose folder or Choose files instead.');
      return;
    }
    reviewFiles(dropped);
  };

  const handleUpload = async (): Promise<void> => {
    if (!source || (source.kind === 'complete-backup' && !restoreConfirmed)) return;
    const operation = beginOperation(source.kind === 'complete-backup' ? 'restoring' : 'importing');
    if (!operation) return;
    operation.total = source.imageCount;
    publishProgress(
      operation,
      {
        current: 0,
        total: source.imageCount,
        label: source.kind === 'complete-backup' ? 'Verifying backup' : 'Preparing scans',
      },
      true,
    );

    try {
      let result: ImportSummary;
      if (source.kind === 'complete-backup') {
        result = await restoreSnapshot(
          source.archive!.zip,
          source.manifest!,
          (current, total) => {
            publishProgress(operation, { current, total, label: 'Verifying complete backup' });
          },
          {
            signal: operation.controller.signal,
            onCommitStart: () => {
              if (operationRef.current !== operation) return;
              operation.committing = true;
              setPhase('finishing');
              publishProgress(
                operation,
                { current: source.imageCount, total: source.imageCount, label: 'Finishing safely' },
                true,
              );
            },
          },
        );
      } else {
        const signal = operation.controller.signal;
        let archiveIntegrityErrors = 0;
        const archiveErrorSamples: string[] = [];
        const sourceFiles =
          source.kind === 'image-archive'
            ? (async function* () {
                for (const entry of source.archive!.entries) {
                  throwIfAborted(signal);
                  if (!isDicomCandidate(entry.name)) continue;
                  try {
                    const blob = await readArchiveEntry(entry, { signal });
                    throwIfAborted(signal);
                    // Use only the filename for ingestion heuristics; folder paths remain local to the archive.
                    const baseName = entry.name.split('/').pop() || entry.name;
                    yield new File([blob], baseName, { type: blob.type || 'application/dicom' });
                  } catch (error) {
                    if (isAbortError(error) || signal.aborted) throw error;
                    archiveIntegrityErrors += 1;
                    if (archiveErrorSamples.length < 3) {
                      archiveErrorSamples.push('An archive image failed its integrity check or could not be decoded.');
                    }
                  }
                }
              })()
            : source.directory
              ? iterateDirectory(source.directory, signal)
              : source.files!;
        result = await processFiles(
          sourceFiles,
          (current, total, detail) => {
            if (detail) operation.committed = detail;
            publishProgress(operation, { current, total, label: 'Saving images to this device' });
          },
          { signal, total: source.imageCount },
        );
        if (source.ignoredCount > 0 || archiveIntegrityErrors > 0) {
          result = {
            ...result,
            total: Math.max(result.total, source.imageCount) + source.ignoredCount,
            skipped: result.skipped + source.ignoredCount,
            errors: result.errors + archiveIntegrityErrors,
            errorSamples: [...result.errorSamples, ...archiveErrorSamples].slice(0, 3),
            ...(source.ignoredCount > 0
              ? {
                  skipReasons: {
                    ...result.skipReasons,
                    'non-dicom-file': (result.skipReasons?.['non-dicom-file'] ?? 0) + source.ignoredCount,
                  },
                }
              : {}),
            ...(archiveIntegrityErrors > 0 ? { archiveIntegrityErrors } : {}),
          };
        }
      }

      if (operationRef.current !== operation) return;
      setSummary(result);
      if (result.cancelled || (operation.controller.signal.aborted && !operation.committing)) {
        setPhase('canceled');
      } else if (result.ingested === 0 && result.duplicates === 0) {
        setPhase('failed');
        setErrorMessage(
          'No displayable DICOM images were imported. Choose another acquisition or review the issues below.',
        );
      } else if (
        result.errors > 0 ||
        (result.skipReasons?.['excluded-localizer-orientation'] ?? 0) > 0 ||
        (result.skipReasons?.['excluded-incompatible-series-orientation'] ?? 0) > 0
      ) {
        setPhase('partial');
      } else {
        setPhase('complete');
      }
      if (result.ingested > 0) {
        try {
          await onUploadComplete?.();
        } catch {
          if (operationRef.current === operation) {
            setErrorMessage(
              'Images were saved, but the viewer could not refresh. Close and reopen the app to see them.',
            );
          }
        }
      }
      endOperation(operation);
    } catch (error) {
      reportFailure(operation, error);
    }
  };

  const cancelOperation = (): void => {
    const operation = operationRef.current;
    if (!operation || operation.committing) return;
    operation.controller.abort();
    setPhase('canceling');
  };

  const availableBytes =
    typeof storageHealth.quota === 'number' && typeof storageHealth.usage === 'number'
      ? Math.max(0, storageHealth.quota - storageHealth.usage)
      : null;
  const terminal = phase === 'complete' || phase === 'partial' || phase === 'canceled' || phase === 'failed';
  const backupExceedsLimit =
    source?.kind === 'complete-backup' &&
    typeof source.restoreBytes === 'number' &&
    source.restoreBytes > MAX_SNAPSHOT_RESTORE_BYTES;
  const folderSupported =
    typeof (window as Window & { showDirectoryPicker?: unknown }).showDirectoryPicker === 'function' ||
    (typeof HTMLInputElement !== 'undefined' && 'webkitdirectory' in HTMLInputElement.prototype);

  return (
    <AccessibleDialog
      title="Import scans"
      description="Choose images from this device or restore a complete MiraViewer backup."
      onClose={() => {
        if (busy) cancelOperation();
        else onClose();
      }}
      closeOnBackdrop={!busy}
      closeOnEscape={phase !== 'finishing'}
      closeDisabled={phase === 'finishing'}
      className="intake-console flex max-h-[min(92vh,54rem)] w-full max-w-[48rem] flex-col overflow-hidden rounded-[4px] border"
    >
      <div className="intake-privacy-rail" aria-label="Privacy and device storage">
        <span className="intake-privacy-label">
          <span className="h-1.5 w-1.5 rounded-full bg-[var(--evidence)]" aria-hidden="true" />
          Processed locally · never uploaded
        </span>
        <span className="intake-storage-label">
          {availableBytes === null ? 'Storage capacity unavailable' : `${formatBytes(availableBytes)} available`}
        </span>
      </div>

      <div className="intake-content overflow-y-auto">
        <div className="intake-intro">
          <span className="intake-eyebrow">ACQUISITION</span>
          <h3>Bring scans into Mira</h3>
          <p>Your images stay on this device. Folders, extensionless DICOM files, and ZIP archives are supported.</p>
        </div>

        {storageHealth.checked && !storageHealth.persisted && (
          <div className="intake-notice intake-notice-warning" role="status">
            <AlertCircle className="h-4 w-4 shrink-0" aria-hidden="true" />
            Browser storage may be temporary. Export a backup to protect important scans and annotations.
          </div>
        )}

        <input
          ref={fileInputRef}
          type="file"
          multiple
          onChange={(event) => handleFilesChange(event)}
          className="hidden"
          aria-label="Select DICOM image files"
        />
        <input
          ref={backupInputRef}
          type="file"
          accept=".zip,application/zip"
          onChange={(event) => handleFilesChange(event)}
          className="hidden"
          aria-label="Select a complete backup or image archive"
        />
        <input
          ref={(input) => {
            folderInputRef.current = input;
            input?.setAttribute('webkitdirectory', '');
          }}
          type="file"
          multiple
          onChange={(event) => handleFilesChange(event, true)}
          className="hidden"
          aria-label="Select an acquisition folder"
        />

        {!terminal && (
          <button
            type="button"
            data-dialog-autofocus
            disabled={busy}
            onClick={() => openInput(fileInputRef.current)}
            onDragEnter={(event) => {
              event.preventDefault();
              if (!busy) setDragActive(true);
            }}
            onDragOver={(event) => {
              event.preventDefault();
              if (!busy) event.dataTransfer.dropEffect = 'copy';
            }}
            onDragLeave={() => setDragActive(false)}
            onDrop={(event) => void handleDrop(event)}
            className="intake-drop-target"
            data-active={dragActive || undefined}
            aria-label="Drop local DICOM files or an acquisition folder, or choose files"
          >
            <span className="intake-scan-icon">
              <FolderOpen className="h-5 w-5" aria-hidden="true" />
            </span>
            <span className="intake-drop-title">Drop a folder or imaging files</span>
            <span className="intake-drop-help">or choose a local source below</span>
          </button>
        )}

        {phase !== 'complete' && (
          <div className="intake-source-actions" aria-label="Choose an imaging source">
            <button
              type="button"
              onClick={() => void openFolderPicker()}
              disabled={!folderSupported || busy}
              className="intake-source-button"
              title={
                folderSupported ? undefined : 'Folder selection is unavailable in this browser; choose files instead.'
              }
            >
              <FolderOpen className="h-4 w-4" aria-hidden="true" />
              Choose folder
            </button>
            <button
              type="button"
              onClick={() => openInput(fileInputRef.current)}
              disabled={busy}
              className="intake-source-button"
            >
              <Files className="h-4 w-4" aria-hidden="true" />
              Choose files
            </button>
            <button
              type="button"
              onClick={() => openInput(backupInputRef.current)}
              disabled={busy}
              className="intake-source-button intake-backup-button"
            >
              <ArchiveRestore className="h-4 w-4" aria-hidden="true" />
              Choose backup / ZIP
            </button>
          </div>
        )}

        {source && (
          <section className="intake-manifest" aria-label="Selected acquisition">
            <div className="intake-manifest-heading">
              <span className="intake-eyebrow">
                {source.kind === 'complete-backup' ? 'COMPLETE BACKUP' : 'ACQUISITION MANIFEST'}
              </span>
              <span className="text-[0.7rem] text-[var(--text-secondary)]">
                {source.kind === 'complete-backup'
                  ? 'Backup archive'
                  : source.kind === 'image-archive'
                    ? 'Image archive'
                    : source.kind === 'folder'
                      ? 'Local folder'
                      : 'Local files'}
              </span>
            </div>
            <div className="intake-manifest-grid">
              <div className="intake-manifest-source">
                <span>Source</span>
                <strong title={source.label}>{source.label}</strong>
              </div>
              <div>
                <span>Images</span>
                <strong>{source.imageCount.toLocaleString()}</strong>
              </div>
              <div>
                <span>
                  {source.kind === 'image-archive' || source.kind === 'complete-backup' ? 'Archive size' : 'Size'}
                </span>
                <strong>{formatBytes(source.totalBytes)}</strong>
              </div>
            </div>
            {source.ignoredCount > 0 && (
              <p className="intake-manifest-note">
                {source.ignoredCount.toLocaleString()} non-image sidecars will be ignored.
              </p>
            )}

            {source.manifest && (
              <div className="intake-backup-review">
                <p>This backup also restores saved work and may update the active patient.</p>
                <p>
                  Restore size: {formatBytes(source.restoreBytes ?? 0)} · complete backup safety limit:{' '}
                  {formatBytes(MAX_SNAPSHOT_RESTORE_BYTES)}
                </p>
                {backupExceedsLimit && (
                  <div className="intake-notice intake-notice-error" role="alert">
                    This complete backup exceeds the 512 MiB safe restore limit. Import the original DICOM files
                    instead.
                  </div>
                )}
                <ul>
                  {[
                    ['Examinations', source.manifest.records.studies.length],
                    ['Series', source.manifest.records.series.length],
                    ['Viewer settings', source.manifest.records.panelSettings.length],
                    [
                      '2D annotations',
                      source.manifest.records.tumorSegmentations.length +
                        source.manifest.records.tumorGroundTruth.length,
                    ],
                    ['3D segmentations', source.manifest.records.volumeSegmentations.length],
                    ['Aligned images', source.manifest.records.derivedAlignmentFrames?.length ?? 0],
                    ['Local AI models', source.manifest.records.models.length],
                  ]
                    .filter(([, count]) => Number(count) > 0)
                    .map(([label, count]) => (
                      <li key={label}>
                        {label} <strong>{Number(count).toLocaleString()}</strong>
                      </li>
                    ))}
                </ul>
                <label className="intake-confirmation">
                  <input
                    type="checkbox"
                    checked={restoreConfirmed}
                    disabled={busy}
                    onChange={(event) => setRestoreConfirmed(event.target.checked)}
                  />
                  I understand this will restore saved work and can update the selected patient.
                </label>
              </div>
            )}
          </section>
        )}

        {busy && progress && (
          <section className="intake-progress" aria-label="Import progress">
            <div className="intake-progress-copy">
              <span className="flex items-center gap-2">
                <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
                {phase === 'canceling' ? 'Canceling safely' : progress.label}
              </span>
              <span>
                {progress.total > 0
                  ? `${progress.current.toLocaleString()} / ${progress.total.toLocaleString()}`
                  : `${progress.current.toLocaleString()} discovered`}
              </span>
            </div>
            <div
              className="intake-progress-track"
              role="progressbar"
              aria-label={phase === 'discovering' ? 'Discovering acquisition images' : 'Importing acquisition images'}
              aria-valuemin={0}
              aria-valuemax={progress.total > 0 ? progress.total : undefined}
              aria-valuenow={progress.total > 0 ? Math.min(progress.current, progress.total) : undefined}
            >
              <span
                className="intake-progress-fill"
                data-indeterminate={progress.total === 0 || undefined}
                style={
                  progress.total > 0
                    ? { width: `${Math.min(100, (progress.current / progress.total) * 100)}%` }
                    : undefined
                }
              />
            </div>
            <p className="sr-only" aria-live="polite" aria-atomic="true">
              {phase === 'canceling'
                ? 'Canceling import safely.'
                : progress.total > 0
                  ? `${progress.current} of ${progress.total} images processed.`
                  : `${progress.current} images discovered.`}
            </p>
          </section>
        )}

        {terminal && (summary || phase === 'canceled') && (
          <section
            className={`intake-result ${phase === 'partial' || phase === 'canceled' ? 'intake-result-attention' : ''}`}
            aria-live="polite"
            aria-atomic="true"
          >
            {phase === 'complete' ? (
              <CheckCircle2 className="h-5 w-5 shrink-0" aria-hidden="true" />
            ) : (
              <AlertCircle className="h-5 w-5 shrink-0" aria-hidden="true" />
            )}
            <div>
              <h4>
                {phase === 'canceled'
                  ? 'Import canceled'
                  : phase === 'failed'
                    ? 'No scans were imported'
                    : phase === 'partial'
                      ? summary?.errors
                        ? 'Import completed with issues'
                        : 'Import completed with exclusions'
                      : summary?.ingested === 0 && (summary?.duplicates ?? 0) > 0
                        ? 'No new scans needed'
                        : source?.kind === 'complete-backup'
                          ? 'Complete backup restored'
                          : 'Import complete'}
              </h4>
              <p>
                {summary
                  ? summary.ingested > 0
                    ? `${summary.ingested.toLocaleString()} image${summary.ingested === 1 ? '' : 's'} saved to this device.`
                    : summary.duplicates > 0
                      ? `${summary.duplicates.toLocaleString()} image${summary.duplicates === 1 ? ' was' : 's were'} already stored.`
                      : 'No new images were saved.'
                  : 'No additional images will be imported.'}
              </p>
              {summary && (summary.duplicates > 0 || summary.skipped > 0 || summary.errors > 0) && (
                <p className="intake-result-detail">
                  {[
                    summary.duplicates ? `${summary.duplicates.toLocaleString()} already stored` : null,
                    summary.skipped ? `${summary.skipped.toLocaleString()} excluded` : null,
                    summary.errors ? `${summary.errors.toLocaleString()} could not be imported` : null,
                  ]
                    .filter(Boolean)
                    .join(' · ')}
                </p>
              )}
              {summary && (
                <ul className="intake-outcome-reasons">
                  {[
                    ['Scout/localizer images excluded', summary.skipReasons?.['excluded-localizer-orientation'] ?? 0],
                    [
                      'Images excluded: incompatible acquisition orientation',
                      summary.skipReasons?.['excluded-incompatible-series-orientation'] ?? 0,
                    ],
                    ['Objects without displayable images', summary.skipReasons?.['non-displayable'] ?? 0],
                    ['Secondary Capture images excluded', summary.skipReasons?.['secondary-capture'] ?? 0],
                    ['Images missing required DICOM identifiers', summary.skipReasons?.['missing-uids'] ?? 0],
                    ['Non-image sidecars excluded', summary.skipReasons?.['non-dicom-file'] ?? 0],
                    ['Enhanced multiframe images not supported', summary.errorReasons?.['unsupported-multiframe'] ?? 0],
                    ['Corrupted archive images excluded', summary.archiveIntegrityErrors ?? 0],
                  ]
                    .filter(([, count]) => Number(count) > 0)
                    .map(([label, count]) => (
                      <li key={label}>
                        {label}: {Number(count).toLocaleString()}
                      </li>
                    ))}
                </ul>
              )}
              {summary?.integrityWarnings?.map((warning) => (
                <p key={warning}>{warning}</p>
              ))}
            </div>
          </section>
        )}

        {errorMessage && (
          <div className="intake-notice intake-notice-error" role="alert">
            <AlertCircle className="h-4 w-4 shrink-0" aria-hidden="true" />
            <span>{errorMessage}</span>
          </div>
        )}

        {summary && summary.errorSamples.length > 0 && (
          <details className="intake-issue-details">
            <summary>
              Review {summary.errors.toLocaleString()} import issue{summary.errors === 1 ? '' : 's'}
            </summary>
            <ul>
              {summary.errorSamples.map((message, index) => (
                <li key={`${index}-${message}`}>{message}</li>
              ))}
            </ul>
          </details>
        )}
      </div>

      <div className="intake-footer">
        <span className="intake-footer-private">Your scans remain on this device</span>
        <div className="intake-footer-actions">
          <button
            type="button"
            onClick={busy ? cancelOperation : onClose}
            disabled={phase === 'finishing' || phase === 'canceling'}
            className="intake-button intake-button-secondary"
          >
            {busy ? (phase === 'finishing' ? 'Finishing safely' : 'Cancel import') : terminal ? 'Done' : 'Cancel'}
          </button>
          {!terminal && (
            <button
              type="button"
              onClick={() => void handleUpload()}
              disabled={
                !source || busy || backupExceedsLimit || (source.kind === 'complete-backup' && !restoreConfirmed)
              }
              className="intake-button intake-button-primary"
            >
              {busy ? (
                <>
                  <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
                  {phase === 'finishing' ? 'Finishing' : phase === 'restoring' ? 'Restoring' : 'Importing'}
                </>
              ) : source?.kind === 'complete-backup' ? (
                'Restore complete backup'
              ) : (
                'Import scans'
              )}
            </button>
          )}
        </div>
      </div>
    </AccessibleDialog>
  );
}
