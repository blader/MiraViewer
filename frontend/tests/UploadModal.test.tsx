import { render, fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import JSZip from 'jszip';
import { UploadModal } from '../src/components/UploadModal';
import * as archiveSafety from '../src/services/archiveSafety';
import * as exportBackup from '../src/services/exportBackup';
import type { ProcessFilesResult } from '../src/services/dicomIngestion';

vi.mock('../src/services/dicomIngestion', () => ({
  isDicomCandidate: vi.fn((name: string) => !name.endsWith('.json')),
  processDicomFile: vi.fn().mockResolvedValue({ status: 'ingested', fileName: 'scan.dcm', sopInstanceUid: 'sop-uid' }),
  processFiles: vi.fn().mockResolvedValue({
    total: 1,
    ingested: 1,
    duplicates: 0,
    skipped: 0,
    errors: 0,
    errorSamples: [],
  }),
}));

import { processDicomFile, processFiles } from '../src/services/dicomIngestion';

const originalDirectoryDescriptor = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'webkitdirectory');

function makeSummary(overrides: Partial<ProcessFilesResult> & { cancelled?: boolean } = {}): ProcessFilesResult {
  return {
    total: 1,
    ingested: 1,
    duplicates: 0,
    skipped: 0,
    errors: 0,
    errorSamples: [],
    ...overrides,
  };
}

function imageFile(name = 'scan.dcm'): File {
  return new File([new Uint8Array([1, 2, 3])], name, { type: 'application/dicom' });
}

function selectFiles(files: File[], label = 'Select DICOM image files'): void {
  fireEvent.change(screen.getByLabelText(label), { target: { files } });
}

async function archiveFile(files: Record<string, string | Uint8Array>, name = 'scans.zip'): Promise<File> {
  const archive = new JSZip();
  for (const [path, data] of Object.entries(files)) archive.file(path, data);
  return new File([await archive.generateAsync({ type: 'blob' })], name, { type: 'application/zip' });
}

async function corruptArchiveMember(archive: File, memberName: string): Promise<File> {
  const bytes = new Uint8Array(await archive.arrayBuffer());
  const view = new DataView(bytes.buffer);
  for (let offset = 0; offset + 30 < bytes.length; offset += 1) {
    if (view.getUint32(offset, true) !== 0x04034b50) continue;
    const nameLength = view.getUint16(offset + 26, true);
    const extraLength = view.getUint16(offset + 28, true);
    const name = new TextDecoder().decode(bytes.subarray(offset + 30, offset + 30 + nameLength));
    if (name !== memberName) continue;
    bytes[offset + 30 + nameLength + extraLength]! ^= 0xff;
    return new File([bytes], archive.name, { type: archive.type });
  }
  throw new Error('Synthetic archive did not contain the expected member.');
}

function backupManifest(imageBytes = 3) {
  return {
    format: 'miraviewer-complete-snapshot',
    version: 2,
    exportedAt: '2026-01-01T00:00:00Z',
    studyIds: ['study-1'],
    records: {
      studies: [{ studyInstanceUid: 'study-1' }],
      series: [{}],
      instances: [{ file: { path: 'images/scan.dcm', byteLength: imageBytes } }],
      panelSettings: [{}],
      tumorSegmentations: [{}],
      tumorGroundTruth: [],
      volumeSegmentations: [{ file: { path: 'labels/seg.bin', byteLength: 2 } }],
      derivedAlignmentFrames: [{ file: { path: 'frames/frame.bin', byteLength: 2 } }],
      appState: [],
      models: [{ file: { path: 'models/model.onnx', byteLength: 2 } }],
      localStorage: {},
    },
  };
}

describe('UploadModal', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(processFiles).mockImplementation(async (files, onProgress) => {
      const images: File[] = [];
      if (Array.isArray(files)) images.push(...files);
      else for await (const file of files) images.push(file);
      onProgress?.(images.length, images.length);
      return makeSummary({ total: images.length, ingested: images.length });
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    if (originalDirectoryDescriptor) {
      Object.defineProperty(HTMLInputElement.prototype, 'webkitdirectory', originalDirectoryDescriptor);
    } else {
      delete (HTMLInputElement.prototype as HTMLInputElement & { webkitdirectory?: boolean }).webkitdirectory;
    }
  });

  it('presents a private, keyboard-accessible intake console without excluding extensionless images', () => {
    render(<UploadModal onClose={vi.fn()} />);

    const dialog = screen.getByRole('dialog', { name: 'Import scans' });
    expect(dialog).toHaveClass('rounded-[4px]');
    expect(screen.getByRole('heading', { name: 'Import scans' })).toBeInTheDocument();
    expect(screen.getAllByRole('heading')).toHaveLength(1);
    expect(screen.getByText(/processed locally · never uploaded/i)).toBeInTheDocument();
    expect(screen.getAllByText(/processed locally · never uploaded/i)).toHaveLength(1);
    expect(dialog.querySelector('canvas, img, video')).toBeNull();
    const dropTarget = screen.getByRole('button', { name: /drop local dicom files or an acquisition folder/i });
    expect(dropTarget).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Choose files' })).toHaveFocus();
    expect(screen.getByRole('button', { name: 'Choose files' })).toBeEnabled();
    expect(screen.getByRole('button', { name: /choose backup/i })).toBeEnabled();
    expect(screen.getByLabelText('Select DICOM image files')).not.toHaveAttribute('accept');
    expect(screen.getByRole('button', { name: 'Close Import scans' })).toHaveClass('min-h-11', 'min-w-11');
  });

  it('ingests extensionless selected images, passes the operation signal, and retains completion', async () => {
    const onClose = vi.fn();
    const onUploadComplete = vi.fn();
    render(<UploadModal onClose={onClose} onUploadComplete={onUploadComplete} />);

    const file = imageFile('IM0001');
    selectFiles([file]);
    expect(screen.getByRole('region', { name: 'Selected acquisition' })).toHaveTextContent('IM0001');
    fireEvent.click(screen.getByRole('button', { name: 'Import scans' }));

    await waitFor(() => expect(processFiles).toHaveBeenCalled());
    expect(processFiles).toHaveBeenCalledWith(
      [file],
      expect.any(Function),
      expect.objectContaining({ signal: expect.any(AbortSignal), total: 1 }),
    );
    expect(onUploadComplete).toHaveBeenCalled();
    expect(screen.getByText('Import complete')).toBeInTheDocument();
    expect(screen.getByText('1 image saved to this device.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /drop local dicom files or an acquisition folder/i })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Choose files' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Done' })).toBeInTheDocument();
    expect(onClose).not.toHaveBeenCalled();
  });

  it('routes ZIP images through the same cancellable bounded ingestion pipeline', async () => {
    const onClose = vi.fn();
    const onUploadComplete = vi.fn();
    const admitArchive = vi.spyOn(archiveSafety, 'loadSafeArchive');
    render(<UploadModal onClose={onClose} onUploadComplete={onUploadComplete} />);

    const zipFile = await archiveFile({ 'nested/a.dcm': new Uint8Array([1]), 'b.dcm': new Uint8Array([2]) });
    selectFiles([zipFile]);
    await waitFor(() => expect(screen.getByRole('button', { name: 'Import scans' })).toBeEnabled());
    fireEvent.click(screen.getByRole('button', { name: 'Import scans' }));

    await waitFor(() => expect(processFiles).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(onUploadComplete).toHaveBeenCalled());
    expect(admitArchive).toHaveBeenCalledWith(
      zipFile,
      expect.objectContaining({ signal: expect.any(AbortSignal), deferStorageCheck: true }),
    );
    expect(processDicomFile).not.toHaveBeenCalled();
    expect(screen.getByText('2 images saved to this device.')).toBeInTheDocument();
  });

  it('continues past a CRC-corrupted ZIP member and commits later valid images', async () => {
    const onUploadComplete = vi.fn();
    render(<UploadModal onClose={vi.fn()} onUploadComplete={onUploadComplete} />);
    const validArchive = await archiveFile({
      'first.dcm': new Uint8Array([1]),
      'broken.dcm': new Uint8Array([2]),
      'last.dcm': new Uint8Array([3]),
    });
    selectFiles([await corruptArchiveMember(validArchive, 'broken.dcm')]);
    await waitFor(() => expect(screen.getByRole('button', { name: 'Import scans' })).toBeEnabled());
    fireEvent.click(screen.getByRole('button', { name: 'Import scans' }));

    await waitFor(() => expect(screen.getByText('Import completed with issues')).toBeInTheDocument());
    expect(screen.getByText('2 images saved to this device.')).toBeInTheDocument();
    expect(screen.getByText('Corrupted archive images excluded: 1')).toBeInTheDocument();
    expect(processFiles).toHaveBeenCalledTimes(1);
    expect(onUploadComplete).toHaveBeenCalledTimes(1);
  });

  it('never labels an entirely corrupted image archive as a successful import', async () => {
    render(<UploadModal onClose={vi.fn()} />);
    const archive = await archiveFile({ 'broken.dcm': new Uint8Array([2]) });
    selectFiles([await corruptArchiveMember(archive, 'broken.dcm')]);
    await waitFor(() => expect(screen.getByRole('button', { name: 'Import scans' })).toBeEnabled());
    fireEvent.click(screen.getByRole('button', { name: 'Import scans' }));

    await waitFor(() => expect(screen.getByText('No scans were imported')).toBeInTheDocument());
    expect(screen.getByText('Corrupted archive images excluded: 1')).toBeInTheDocument();
    expect(screen.queryByText('Import complete')).not.toBeInTheDocument();
    expect(screen.getByRole('alert')).toHaveTextContent(/no displayable dicom images were imported/i);
  });

  it('cancels an ordinary import, retains committed images, and refreshes once', async () => {
    const onUploadComplete = vi.fn();
    vi.mocked(processFiles).mockImplementation(
      (_files, _onProgress, options) =>
        new Promise((resolve) => {
          options?.signal?.addEventListener('abort', () => {
            resolve(makeSummary({ total: 3, ingested: 1, cancelled: true }));
          });
        }),
    );
    render(<UploadModal onClose={vi.fn()} onUploadComplete={onUploadComplete} />);
    selectFiles([imageFile('a.dcm'), imageFile('b.dcm'), imageFile('c.dcm')]);
    fireEvent.click(screen.getByRole('button', { name: 'Import scans' }));

    await waitFor(() => expect(screen.getByRole('button', { name: 'Choose files' })).toBeDisabled());
    fireEvent.click(screen.getByRole('button', { name: 'Cancel import' }));

    await waitFor(() => expect(screen.getByText('Import canceled')).toBeInTheDocument());
    expect(screen.getByText('1 image saved to this device.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /drop local dicom files or an acquisition folder/i })).toBeNull();
    expect(screen.getByRole('button', { name: 'Choose files' })).toBeEnabled();
    expect(onUploadComplete).toHaveBeenCalledTimes(1);
    expect(processFiles).toHaveBeenCalledTimes(1);
  });

  it.each(['dialog-close', 'escape'] as const)(
    'cancels the active operation through %s without dismissing committed results',
    async (interaction) => {
      vi.mocked(processFiles).mockImplementation(
        (_files, _progress, options) =>
          new Promise((resolve) => {
            options?.signal?.addEventListener('abort', () => {
              resolve(makeSummary({ total: 2, ingested: 1, cancelled: true }));
            });
          }),
      );
      const onClose = vi.fn();
      render(<UploadModal onClose={onClose} />);
      selectFiles([imageFile('a.dcm'), imageFile('b.dcm')]);
      fireEvent.click(screen.getByRole('button', { name: 'Import scans' }));
      await waitFor(() => expect(screen.getByRole('button', { name: 'Cancel import' })).toBeInTheDocument());

      if (interaction === 'escape') fireEvent.keyDown(document, { key: 'Escape' });
      else fireEvent.click(screen.getByRole('button', { name: 'Close Import scans' }));

      await waitFor(() => expect(screen.getByText('Import canceled')).toBeInTheDocument());
      expect(screen.getByText('1 image saved to this device.')).toBeInTheDocument();
      expect(onClose).not.toHaveBeenCalled();
    },
  );

  it('recovers committed progress when a source fails after a durable batch', async () => {
    const onUploadComplete = vi.fn();
    vi.mocked(processFiles).mockImplementation(async (_files, onProgress) => {
      onProgress?.(1, 2, { ingested: 1, duplicates: 0, skipped: 0, errors: 0 });
      throw new Error('The acquisition source became unavailable.');
    });
    render(<UploadModal onClose={vi.fn()} onUploadComplete={onUploadComplete} />);
    selectFiles([imageFile('a.dcm'), imageFile('b.dcm')]);
    fireEvent.click(screen.getByRole('button', { name: 'Import scans' }));

    await waitFor(() => expect(screen.getByText('Import completed with issues')).toBeInTheDocument());
    expect(screen.getByText('1 image saved to this device.')).toBeInTheDocument();
    expect(screen.getByRole('alert')).toHaveTextContent(/some images were saved before this import stopped/i);
    expect(onUploadComplete).toHaveBeenCalledTimes(1);
  });

  it('prevents source replacement and overlapping writes while an import owns the dialog', async () => {
    let finishImport!: (summary: ProcessFilesResult) => void;
    vi.mocked(processFiles).mockImplementation(
      () =>
        new Promise((resolve) => {
          finishImport = resolve;
        }),
    );
    render(<UploadModal onClose={vi.fn()} />);
    selectFiles([imageFile('original.dcm')]);
    fireEvent.click(screen.getByRole('button', { name: 'Import scans' }));
    await waitFor(() => expect(processFiles).toHaveBeenCalledTimes(1));

    selectFiles([imageFile('replacement.dcm')]);
    expect(screen.getByText('original.dcm')).toBeInTheDocument();
    expect(screen.queryByText('replacement.dcm')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Choose backup / ZIP' })).toBeDisabled();
    expect(processFiles).toHaveBeenCalledTimes(1);

    finishImport(makeSummary());
    await waitFor(() => expect(screen.getByText('Import complete')).toBeInTheDocument());
  });

  it('reports all-duplicate acquisitions without reloading unchanged comparison data', async () => {
    const onUploadComplete = vi.fn();
    vi.mocked(processFiles).mockResolvedValue(makeSummary({ total: 2, ingested: 0, duplicates: 2 }));
    render(<UploadModal onClose={vi.fn()} onUploadComplete={onUploadComplete} />);
    selectFiles([imageFile('a.dcm'), imageFile('b.dcm')]);
    fireEvent.click(screen.getByRole('button', { name: 'Import scans' }));

    await waitFor(() => expect(screen.getByText('No new scans needed')).toBeInTheDocument());
    expect(screen.getByText('2 images were already stored.')).toBeInTheDocument();
    expect(onUploadComplete).not.toHaveBeenCalled();
  });

  it('keeps partial-import errors and committed counts visible', async () => {
    vi.mocked(processFiles).mockResolvedValue(
      makeSummary({ total: 3, ingested: 2, errors: 1, errorSamples: ['One image could not be decoded.'] }),
    );
    render(<UploadModal onClose={vi.fn()} />);
    selectFiles([imageFile('a.dcm'), imageFile('b.dcm'), imageFile('c.dcm')]);
    fireEvent.click(screen.getByRole('button', { name: 'Import scans' }));

    await waitFor(() => expect(screen.getByText('Import completed with issues')).toBeInTheDocument());
    expect(screen.getByText('2 images saved to this device.')).toBeInTheDocument();
    expect(screen.getByText(/1 could not be imported/i)).toBeInTheDocument();
    expect(screen.getByText(/review 1 import issue/i)).toBeInTheDocument();
  });

  it('explicitly identifies excluded scouts, non-displayables, and unsupported enhanced images', async () => {
    vi.mocked(processFiles).mockResolvedValue(
      makeSummary({
        total: 10,
        ingested: 2,
        skipped: 7,
        errors: 1,
        skipReasons: { 'excluded-localizer-orientation': 6, 'non-displayable': 1 },
        errorReasons: { 'unsupported-multiframe': 1 },
        errorSamples: ['An enhanced multiframe image is unsupported.'],
      }),
    );
    render(<UploadModal onClose={vi.fn()} />);
    selectFiles([imageFile('acquisition.dcm')]);
    fireEvent.click(screen.getByRole('button', { name: 'Import scans' }));

    await waitFor(() => expect(screen.getByText('Import completed with issues')).toBeInTheDocument());
    expect(screen.getByText('Scout/localizer images excluded: 6')).toBeInTheDocument();
    expect(screen.getByText('Objects without displayable images: 1')).toBeInTheDocument();
    expect(screen.getByText('Enhanced multiframe images not supported: 1')).toBeInTheDocument();
  });

  it('marks valid scout exclusions as an attention-worthy acquisition result', async () => {
    vi.mocked(processFiles).mockResolvedValue(
      makeSummary({
        total: 9,
        ingested: 3,
        skipped: 6,
        skipReasons: { 'excluded-localizer-orientation': 6 },
      }),
    );
    render(<UploadModal onClose={vi.fn()} />);
    selectFiles([imageFile('acquisition.dcm')]);
    fireEvent.click(screen.getByRole('button', { name: 'Import scans' }));

    await waitFor(() => expect(screen.getByText('Import completed with exclusions')).toBeInTheDocument());
    expect(screen.getByText('Scout/localizer images excluded: 6')).toBeInTheDocument();
    expect(screen.getByText('3 images saved to this device.')).toBeInTheDocument();
  });

  it('explicitly distinguishes untagged incompatible acquisitions from scout and localizer images', async () => {
    vi.mocked(processFiles).mockResolvedValue(
      makeSummary({
        total: 35_898,
        ingested: 35_790,
        skipped: 108,
        skipReasons: {
          'excluded-incompatible-series-orientation': 102,
          'excluded-localizer-orientation': 6,
        },
      }),
    );
    render(<UploadModal onClose={vi.fn()} />);
    selectFiles([imageFile('acquisition.dcm')]);
    fireEvent.click(screen.getByRole('button', { name: 'Import scans' }));

    await waitFor(() => expect(screen.getByText('Import completed with exclusions')).toBeInTheDocument());
    expect(screen.getByText('Images excluded: incompatible acquisition orientation: 102')).toBeInTheDocument();
    expect(screen.getByText('Scout/localizer images excluded: 6')).toBeInTheDocument();
    expect(screen.queryByText('Import completed with issues')).not.toBeInTheDocument();
  });

  it('exposes truthful accessible progress while an image operation is active', async () => {
    let finishImport!: (summary: ProcessFilesResult) => void;
    vi.mocked(processFiles).mockImplementation(
      (_files, onProgress) =>
        new Promise((resolve) => {
          onProgress?.(1, 3);
          finishImport = resolve;
        }),
    );
    render(<UploadModal onClose={vi.fn()} />);
    selectFiles([imageFile('a.dcm'), imageFile('b.dcm'), imageFile('c.dcm')]);
    fireEvent.click(screen.getByRole('button', { name: 'Import scans' }));

    const progressbar = screen.getByRole('progressbar', { name: 'Importing acquisition images' });
    expect(progressbar).toHaveAttribute('aria-valuemax', '3');
    await waitFor(() => expect(progressbar).toHaveAttribute('aria-valuenow', '1'));

    finishImport(makeSummary({ total: 3, ingested: 3 }));
    await waitFor(() => expect(screen.getByText('Import complete')).toBeInTheDocument());
  });

  it('retains saved-image results when a background comparison refresh fails', async () => {
    render(
      <UploadModal
        onClose={vi.fn()}
        onUploadComplete={vi.fn().mockRejectedValue(new Error('Database connection temporarily unavailable.'))}
      />,
    );
    selectFiles([imageFile()]);
    fireEvent.click(screen.getByRole('button', { name: 'Import scans' }));

    await waitFor(() => expect(screen.getByText('Import complete')).toBeInTheDocument());
    expect(screen.getByText('1 image saved to this device.')).toBeInTheDocument();
    await waitFor(() =>
      expect(screen.getByRole('alert')).toHaveTextContent(/images were saved.*viewer could not refresh/i),
    );
  });

  it('admits dropped local files and rejects external links without starting import', async () => {
    render(<UploadModal onClose={vi.fn()} />);
    const dropTarget = screen.getByRole('button', { name: /drop local dicom files/i });
    const localFile = imageFile('dropped.dcm');

    fireEvent.drop(dropTarget, {
      dataTransfer: { files: [localFile], items: [{ kind: 'file' }] },
    });
    await waitFor(() => expect(screen.getByText('dropped.dcm')).toBeInTheDocument());

    fireEvent.drop(dropTarget, {
      dataTransfer: { files: [], items: [{ kind: 'string', type: 'text/uri-list' }] },
    });
    expect(screen.getByRole('alert')).toHaveTextContent(/external links are not supported/i);
    expect(processFiles).not.toHaveBeenCalled();
  });

  it('rejects mixed ZIP and individual-image selection before durable work', () => {
    render(<UploadModal onClose={vi.fn()} />);
    selectFiles([imageFile('a.dcm'), imageFile('backup.zip')]);

    expect(screen.getByRole('alert')).toHaveTextContent(/import a zip archive separately/i);
    expect(processFiles).not.toHaveBeenCalled();
  });

  it('progressively reviews nested native folders and imports through a lazy iterator', async () => {
    const ignoredGetFile = vi.fn();
    const nested = {
      kind: 'directory',
      name: 'nested',
      async *entries() {
        yield ['IM0001', { kind: 'file', getFile: async () => imageFile('IM0001') }] as [string, unknown];
        yield ['notes.json', { kind: 'file', getFile: ignoredGetFile }] as [string, unknown];
      },
    };
    const root = {
      kind: 'directory',
      name: 'MR acquisition',
      async *entries() {
        yield ['nested', nested] as [string, unknown];
      },
    };
    vi.stubGlobal('showDirectoryPicker', vi.fn().mockResolvedValue(root));
    render(<UploadModal onClose={vi.fn()} />);

    fireEvent.click(screen.getByRole('button', { name: 'Choose folder' }));
    await waitFor(() => expect(screen.getByText('MR acquisition')).toBeInTheDocument());
    expect(screen.getByText(/1 non-image sidecars will be ignored/i)).toBeInTheDocument();
    expect(ignoredGetFile).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Import scans' }));

    await waitFor(() => expect(processFiles).toHaveBeenCalledTimes(1));
    const actualSource = vi.mocked(processFiles).mock.calls[0]![0];
    expect(Array.isArray(actualSource)).toBe(false);
    await waitFor(() => expect(screen.getByText('Import complete')).toBeInTheDocument());
  });

  it('supports the webkitdirectory folder fallback without a native directory picker', () => {
    Object.defineProperty(HTMLInputElement.prototype, 'webkitdirectory', {
      configurable: true,
      value: false,
    });
    render(<UploadModal onClose={vi.fn()} />);
    const folderInput = screen.getByLabelText('Select an acquisition folder') as HTMLInputElement;
    const click = vi.spyOn(folderInput, 'click').mockImplementation(() => {});

    fireEvent.click(screen.getByRole('button', { name: 'Choose folder' }));
    expect(click).toHaveBeenCalledTimes(1);
    expect(folderInput).toHaveAttribute('webkitdirectory');

    const file = imageFile('IM0002');
    Object.defineProperty(file, 'webkitRelativePath', { value: 'StudyFolder/series/IM0002' });
    fireEvent.change(folderInput, { target: { files: [file] } });
    expect(screen.getByText('StudyFolder')).toBeInTheDocument();
  });

  it('cancels native folder discovery before any image write begins', async () => {
    let finishFile!: (file: File) => void;
    const root = {
      kind: 'directory',
      name: 'Slow folder',
      async *entries() {
        yield [
          'slow.dcm',
          {
            kind: 'file',
            getFile: () =>
              new Promise<File>((resolve) => {
                finishFile = resolve;
              }),
          },
        ] as [string, unknown];
      },
    };
    vi.stubGlobal('showDirectoryPicker', vi.fn().mockResolvedValue(root));
    render(<UploadModal onClose={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Choose folder' }));

    await waitFor(() => expect(screen.getByRole('button', { name: 'Cancel import' })).toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: 'Cancel import' }));
    finishFile(imageFile());

    await waitFor(() => expect(screen.getByText('Import canceled')).toBeInTheDocument());
    expect(processFiles).not.toHaveBeenCalled();
  });

  it('requires explicit complete-backup consent and previews saved artifacts before restoring', async () => {
    const manifest = backupManifest();
    const restore = vi.spyOn(exportBackup, 'restoreSnapshot').mockResolvedValue(makeSummary());
    render(<UploadModal onClose={vi.fn()} />);
    const backup = await archiveFile({ 'export.json': JSON.stringify(manifest) }, 'full-backup.zip');
    selectFiles([backup], 'Select a complete backup or image archive');

    await waitFor(() => expect(screen.getByText('COMPLETE BACKUP')).toBeInTheDocument());
    expect(screen.getByText('2D annotations')).toBeInTheDocument();
    expect(screen.getByText('3D segmentations')).toBeInTheDocument();
    expect(screen.getByText('Aligned images')).toBeInTheDocument();
    expect(screen.getByText('Local AI models')).toBeInTheDocument();
    const restoreButton = screen.getByRole('button', { name: 'Restore complete backup' });
    expect(restoreButton).toBeDisabled();
    expect(restore).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('checkbox', { name: /restore saved work and can update the selected patient/i }));
    expect(restoreButton).toBeEnabled();
    fireEvent.click(restoreButton);

    await waitFor(() => expect(restore).toHaveBeenCalledTimes(1));
    expect(restore).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ format: 'miraviewer-complete-snapshot' }),
      expect.any(Function),
      expect.objectContaining({ signal: expect.any(AbortSignal), onCommitStart: expect.any(Function) }),
    );
    await waitFor(() => expect(screen.getByText('Complete backup restored')).toBeInTheDocument());
  });

  it('discloses oversized complete backups before consent and prevents unsafe restore', async () => {
    const restore = vi.spyOn(exportBackup, 'restoreSnapshot');
    render(<UploadModal onClose={vi.fn()} />);
    const backup = await archiveFile(
      { 'export.json': JSON.stringify(backupManifest(512 * 1024 * 1024 + 1)) },
      'large-backup.zip',
    );
    selectFiles([backup], 'Select a complete backup or image archive');

    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent(/512 mib safe restore limit/i));
    const consent = screen.getByRole('checkbox', { name: /restore saved work/i });
    fireEvent.click(consent);
    expect(screen.getByRole('button', { name: 'Restore complete backup' })).toBeDisabled();
    expect(restore).not.toHaveBeenCalled();
  });

  it('disables cancellation once a complete-backup commit becomes indivisible', async () => {
    let completeRestore!: (result: ProcessFilesResult) => void;
    vi.spyOn(exportBackup, 'restoreSnapshot').mockImplementation(
      (_zip, _manifest, _progress, options) =>
        new Promise((resolve) => {
          options?.onCommitStart?.();
          completeRestore = resolve;
        }),
    );
    const onClose = vi.fn();
    render(<UploadModal onClose={onClose} />);
    selectFiles(
      [await archiveFile({ 'export.json': JSON.stringify(backupManifest()) }, 'complete.zip')],
      'Select a complete backup or image archive',
    );
    await waitFor(() => expect(screen.getByRole('checkbox', { name: /restore saved work/i })).toBeInTheDocument());
    fireEvent.click(screen.getByRole('checkbox', { name: /restore saved work/i }));
    fireEvent.click(screen.getByRole('button', { name: 'Restore complete backup' }));

    await waitFor(() => expect(screen.getByRole('button', { name: 'Finishing safely' })).toBeDisabled());
    expect(screen.getByRole('button', { name: 'Close Import scans' })).toBeDisabled();
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onClose).not.toHaveBeenCalled();

    completeRestore(makeSummary());
    await waitFor(() => expect(screen.getByText('Complete backup restored')).toBeInTheDocument());
  });

  it('aborts the owned operation when the intake console unmounts', async () => {
    let signal: AbortSignal | undefined;
    vi.mocked(processFiles).mockImplementation(
      (_files, _progress, options) =>
        new Promise((resolve) => {
          signal = options?.signal;
          signal?.addEventListener('abort', () => resolve(makeSummary({ ingested: 0, cancelled: true })));
        }),
    );
    const view = render(<UploadModal onClose={vi.fn()} />);
    selectFiles([imageFile()]);
    fireEvent.click(screen.getByRole('button', { name: 'Import scans' }));
    await waitFor(() => expect(signal).toBeDefined());

    view.unmount();
    expect(signal?.aborted).toBe(true);
  });
});
