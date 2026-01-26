import { render, fireEvent, screen, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import JSZip from 'jszip';
import { UploadModal } from '../src/components/UploadModal';

vi.mock('../src/services/dicomIngestion', () => ({
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

describe('UploadModal', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('ingests selected DICOM files and calls onUploadComplete', async () => {
    const onClose = vi.fn();
    const onUploadComplete = vi.fn();
    const { container } = render(<UploadModal onClose={onClose} onUploadComplete={onUploadComplete} />);

    const input = container.querySelector('input[type="file"]') as HTMLInputElement;
    const file = new File([new Uint8Array([1])], 'scan.dcm', { type: 'application/dicom' });
    fireEvent.change(input, { target: { files: [file] } });

    const importButton = screen.getByRole('button', { name: /^import$/i });
    fireEvent.click(importButton);

    await waitFor(() => expect(processFiles).toHaveBeenCalled());
    expect(onUploadComplete).toHaveBeenCalled();
  });

  it('handles ZIP imports by expanding and ingesting entries', async () => {
    const onClose = vi.fn();
    const onUploadComplete = vi.fn();
    const { container } = render(<UploadModal onClose={onClose} onUploadComplete={onUploadComplete} />);

    const zip = new JSZip();
    zip.file('a.dcm', new Uint8Array([1]));
    zip.file('b.dcm', new Uint8Array([2]));
    const blob = await zip.generateAsync({ type: 'blob' });
    const zipFile = new File([blob], 'scans.zip', { type: 'application/zip' });

    const input = container.querySelector('input[type="file"]') as HTMLInputElement;
    fireEvent.change(input, { target: { files: [zipFile] } });

    const importButton = screen.getByRole('button', { name: /^import$/i });
    fireEvent.click(importButton);

    await waitFor(() => expect(processDicomFile).toHaveBeenCalled());
    await waitFor(() => expect(onUploadComplete).toHaveBeenCalled());
  });
});
