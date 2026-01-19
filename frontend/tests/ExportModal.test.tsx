import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
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

vi.mock('../src/services/exportBackup', () => ({
  exportStudiesToZip: vi.fn().mockResolvedValue(new Blob([new Uint8Array([1, 2, 3])], { type: 'application/zip' })),
}));

import { exportStudiesToZip } from '../src/services/exportBackup';

describe('ExportModal', () => {
  it('exports selected studies as a ZIP', async () => {
    const onClose = vi.fn();
    render(<ExportModal onClose={onClose} />);

    await waitFor(() => {
      expect(screen.getByText(/2024-01-01/i)).toBeInTheDocument();
    });

    const exportButton = screen.getByRole('button', { name: /export/i });
    fireEvent.click(exportButton);

    await waitFor(() => {
      expect(exportStudiesToZip).toHaveBeenCalled();
    });
  });
});
