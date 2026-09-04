import { act, render, screen, waitFor, fireEvent } from '@testing-library/react';
import { beforeEach, describe, it, expect, vi } from 'vitest';
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
}));

import { exportStudiesToZip } from '../src/services/exportBackup';

describe('ExportModal', () => {
  beforeEach(() => {
    vi.mocked(exportStudiesToZip)
      .mockReset()
      .mockResolvedValue(new Blob([new Uint8Array([1, 2, 3])], { type: 'application/zip' }));
  });
  it('exports selected studies as a ZIP', async () => {
    const onClose = vi.fn();
    render(<ExportModal onClose={onClose} />);

    await waitFor(() => {
      expect(screen.getByText(/2024-01-01/i)).toBeInTheDocument();
    });

    expect(screen.getByText('COMPLETE BACKUP')).toBeInTheDocument();
    expect(screen.getByText('EXAMINATIONS')).toBeInTheDocument();
    expect(screen.getByText('2/2 selected')).toBeInTheDocument();
    expect(screen.getByText(/current restore limit is 512 MiB/)).toBeVisible();
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
      new Error('The selection exceeds the 512 MiB safe restore limit.'),
    );
    render(<ExportModal onClose={vi.fn()} />);
    await waitFor(() => expect(screen.getByText('2/2 selected')).toBeVisible());
    fireEvent.click(screen.getByRole('button', { name: 'Export', exact: true }));
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('512 MiB safe restore limit'));
    fireEvent.click(screen.getAllByRole('checkbox')[1]!);
    fireEvent.click(screen.getByRole('button', { name: 'Export', exact: true }));
    await waitFor(() => expect(screen.getByText('Export complete')).toBeVisible());
    expect(vi.mocked(exportStudiesToZip).mock.lastCall![0]).toEqual(['study-1']);
  });
});
