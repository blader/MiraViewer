import { act, render, screen, waitFor, fireEvent } from '@testing-library/react';
import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import { ExportModal } from '../src/components/ExportModal';

vi.mock('../src/utils/localApi', () => ({
  getStudies: vi.fn().mockResolvedValue([
    {
      study_id: 'study-1',
      study_date: '20240101',
      scan_type: 'MR',
      series_count: 2,
      total_instances: 10,
    },
    {
      study_id: 'study-2',
      study_date: '20240202',
      scan_type: 'MR',
      series_count: 1,
      total_instances: 5,
    },
  ]),
}));

vi.mock(import('../src/services/exportBackup'), async (importOriginal) => ({
  ...(await importOriginal()),
  exportStudiesToZip: vi.fn(),
  exportStudiesToFile: vi.fn(),
}));

import { exportStudiesToZip, exportStudiesToFile } from '../src/services/exportBackup';

describe('ExportModal', () => {
  beforeEach(() => {
    vi.mocked(exportStudiesToZip)
      .mockReset()
      .mockResolvedValue(new Blob([new Uint8Array([1, 2, 3])], { type: 'application/zip' }));
    vi.mocked(exportStudiesToFile).mockReset().mockResolvedValue(undefined);
  });
  afterEach(() => vi.unstubAllGlobals());
  it('exports selected studies as a ZIP', async () => {
    const onClose = vi.fn();
    render(<ExportModal onClose={onClose} />);

    await waitFor(() => {
      expect(screen.getByText(/2024-01-01/i)).toBeInTheDocument();
    });

    expect(screen.getByText('COMPLETE BACKUP')).toBeInTheDocument();
    expect(screen.getByText('EXAMINATIONS')).toBeInTheDocument();
    expect(screen.getByText('2/2 selected')).toBeInTheDocument();
    expect(screen.getByText(/each individual file can be up to 512 MiB/i)).toBeVisible();
    const exportButton = screen.getByRole('button', { name: /^export$/i });
    expect(exportButton).toHaveClass('min-h-11');
    fireEvent.click(exportButton);

    await waitFor(() => {
      expect(screen.getByText('Export complete')).toBeVisible();
    });
    expect(exportStudiesToZip).toHaveBeenCalledWith(['study-1', 'study-2'], expect.any(Function), {
      signal: expect.any(AbortSignal),
    });
  });

  it('cancels an active export on close and ignores its late completion', async () => {
    let finish!: (blob: Blob) => void;
    vi.mocked(exportStudiesToZip).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const onClose = vi.fn();
    const createUrl = vi.spyOn(URL, 'createObjectURL');
    const view = render(<ExportModal onClose={onClose} />);
    try {
      await waitFor(() => expect(screen.getByText('2/2 selected')).toBeVisible());
      fireEvent.click(screen.getByRole('button', { name: 'Export', exact: true }));
      const signal = vi.mocked(exportStudiesToZip).mock.lastCall![2]!.signal!;
      expect(screen.getByText('Checking backup size…')).toBeVisible();
      for (const checkbox of screen.getAllByRole('checkbox')) expect(checkbox).toBeDisabled();
      fireEvent.click(screen.getByRole('button', { name: 'Cancel export', exact: true }));
      expect(signal.aborted).toBe(true);
      expect(onClose).toHaveBeenCalledTimes(1);
      view.unmount();
      await act(async () => finish(new Blob(['late synthetic result'])));
      expect(createUrl).not.toHaveBeenCalled();
      expect(onClose).toHaveBeenCalledTimes(1);
    } finally {
      createUrl.mockRestore();
    }
  });

  it('keeps the capacity error and examination choices available for a smaller retry', async () => {
    vi.mocked(exportStudiesToZip).mockRejectedValueOnce(
      new Error('A backup file exceeds the 512 MiB per-file restore limit.'),
    );
    render(<ExportModal onClose={vi.fn()} />);
    await waitFor(() => expect(screen.getByText('2/2 selected')).toBeVisible());
    fireEvent.click(screen.getByRole('button', { name: 'Export', exact: true }));
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('512 MiB per-file restore limit'));
    fireEvent.click(screen.getAllByRole('checkbox')[1]!);
    fireEvent.click(screen.getByRole('button', { name: 'Export', exact: true }));
    await waitFor(() => expect(screen.getByText('Export complete')).toBeVisible());
    expect(vi.mocked(exportStudiesToZip).mock.lastCall![0]).toEqual(['study-1']);
  });

  it('streams to the chosen file and makes final file publication noninterruptible', async () => {
    const sink = { write: vi.fn(), close: vi.fn(), abort: vi.fn() };
    const picker = vi.fn().mockResolvedValue({ createWritable: vi.fn().mockResolvedValue(sink) });
    vi.stubGlobal('showSaveFilePicker', picker);
    let finish!: () => void;
    vi.mocked(exportStudiesToFile).mockImplementation((_studies, _sink, _progress, options) => {
      options?.onCommitStart?.();
      return new Promise((resolve) => {
        finish = resolve;
      });
    });
    const onClose = vi.fn();
    render(<ExportModal onClose={onClose} />);
    await waitFor(() => expect(screen.getByText('2/2 selected')).toBeVisible());
    fireEvent.click(screen.getByRole('button', { name: 'Save directly…' }));
    await waitFor(() => expect(exportStudiesToFile).toHaveBeenCalledOnce());
    expect(exportStudiesToFile).toHaveBeenCalledWith(
      ['study-1', 'study-2'],
      sink,
      expect.any(Function),
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(screen.getByRole('button', { name: 'Close Export Backup (ZIP)' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Finishing…' })).toBeDisabled();
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onClose).not.toHaveBeenCalled();
    expect(vi.mocked(exportStudiesToFile).mock.lastCall![3]!.signal!.aborted).toBe(false);
    await act(async () => finish());
    expect(screen.getByText('Export complete')).toBeVisible();
    expect(exportStudiesToZip).not.toHaveBeenCalled();
  });

  it('treats a canceled save picker as an unstarted export', async () => {
    vi.stubGlobal('showSaveFilePicker', vi.fn().mockRejectedValue(new DOMException('Canceled', 'AbortError')));
    render(<ExportModal onClose={vi.fn()} />);
    await waitFor(() => expect(screen.getByText('2/2 selected')).toBeVisible());
    fireEvent.click(screen.getByRole('button', { name: 'Save directly…' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Save directly…' })).toBeEnabled());
    expect(screen.queryByRole('alert')).toBeNull();
    expect(exportStudiesToFile).not.toHaveBeenCalled();
    expect(exportStudiesToZip).not.toHaveBeenCalled();
  });
});
