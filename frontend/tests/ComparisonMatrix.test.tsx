import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import type * as ReactTypes from 'react';
import { ComparisonMatrix } from '../src/components/ComparisonMatrix';
import * as dicomIngestion from '../src/services/dicomIngestion';
import { DEFAULT_PANEL_SETTINGS } from '../src/utils/constants';
import { COMPARISON_UI_STORAGE_KEY } from '../src/utils/storageKeys';

const { reloadComparisonData, updatePanelSetting } = vi.hoisted(() => ({
  reloadComparisonData: vi.fn(),
  updatePanelSetting: vi.fn(),
}));

vi.mock('../src/hooks/useComparisonData', async () => {
  const { useCallback, useState } = await vi.importActual<typeof ReactTypes>('react');
  return {
    useComparisonData: () => {
      const [loading, setLoading] = useState(false);
      const reload = useCallback(async (patientKey?: string, options?: { background?: boolean }) => {
        reloadComparisonData(patientKey, options);
        if (!options?.background) setLoading(true);
      }, []);
      return {
        data: {
          planes: ['Axial'],
          dates: ['2024-01-01T00:00:00'],
          sequences: [
            { id: 'axial-t1', plane: 'Axial', weight: 'T1', sequence: 'SE', label: 'Axial T1 SE', date_count: 1 },
          ],
          series_map: {
            'axial-t1': {
              '2024-01-01T00:00:00': { study_id: 'study-1', series_uid: 'series-1', instance_count: 1 },
            },
          },
        },
        loading,
        error: null,
        reload,
      };
    },
  };
});

vi.mock('../src/hooks/useComparisonFilters', () => ({
  useComparisonFilters: () => ({
    availablePlanes: ['Axial'],
    selectedPlane: 'Axial',
    selectedSeqId: 'axial-t1',
    enabledDates: new Set(['2024-01-01T00:00:00']),
    enabledDatesKey: '2024-01-01T00:00:00',
    sortedDates: ['2024-01-01T00:00:00'],
    selectPlane: vi.fn(),
    selectSequence: vi.fn(),
    selectAllDates: vi.fn(),
    selectNoDates: vi.fn(),
    toggleDate: vi.fn(),
  }),
}));

vi.mock('../src/hooks/usePanelSettings', () => ({
  usePanelSettings: () => ({
    panelSettings: new Map([['2024-01-01T00:00:00', { ...DEFAULT_PANEL_SETTINGS }]]),
    progress: 0,
    setProgress: vi.fn(),
    updatePanelSetting,
    batchUpdateSettings: vi.fn(),
  }),
}));

vi.mock('../src/hooks/useOverlayNavigation', () => ({
  useOverlayNavigation: () => ({
    viewMode: 'grid',
    setViewMode: vi.fn(),
    overlayDateIndex: 0,
    setOverlayDateIndex: vi.fn(),
    compareTargetIndex: 0,
    displayedOverlayIndex: 0,
    isPlaying: false,
    setIsPlaying: vi.fn(),
    playSpeed: 1000,
    setPlaySpeed: vi.fn(),
  }),
}));

vi.mock('../src/hooks/useGridLayout', () => ({
  useGridLayout: () => ({
    containerRef: vi.fn(),
    cols: 1,
    cellSize: 200,
    gridSize: { width: 600, height: 600 },
  }),
}));

vi.mock('../src/components/DicomViewer', async () => {
  const { useContext } = await vi.importActual<typeof ReactTypes>('react');
  const { SharpSliceDisplayContext } = await import('../src/hooks/useSharpSliceDisplay');
  return {
    DicomViewer: ({ children }: { children?: ReactTypes.ReactNode }) => {
      const display = useContext(SharpSliceDisplayContext);
      return (
        <div data-testid="dicom-viewer" data-sharp-slices={String(display.enabled)}>
          {children}
        </div>
      );
    },
  };
});

describe('ComparisonMatrix', () => {
  beforeEach(() => {
    localStorage.clear();
    reloadComparisonData.mockClear();
    updatePanelSetting.mockClear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('renders header menu actions', () => {
    render(<ComparisonMatrix />);

    const menuButton = screen.getByTitle(/menu/i);
    expect(menuButton).toBeInTheDocument();

    fireEvent.click(menuButton);

    expect(screen.getByText('Import scans')).toBeInTheDocument();
    expect(screen.getByText(/export backup \(zip\)/i)).toBeInTheDocument();
    expect(screen.getByTestId('dicom-viewer')).toBeInTheDocument();
  });

  it('keeps a successful intake result mounted while comparison data refreshes in the background', async () => {
    vi.spyOn(dicomIngestion, 'processFiles').mockResolvedValue({
      total: 1,
      ingested: 1,
      duplicates: 0,
      skipped: 0,
      errors: 0,
      errorSamples: [],
    });
    render(<ComparisonMatrix />);
    fireEvent.click(screen.getByTitle('Menu'));
    fireEvent.click(screen.getByRole('button', { name: 'Import scans' }));

    const dialog = await screen.findByRole('dialog', { name: 'Import scans' });
    const file = new File([new Uint8Array([1])], 'scan.dcm', { type: 'application/dicom' });
    fireEvent.change(within(dialog).getByLabelText('Select DICOM image files'), {
      target: { files: [file] },
    });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Import scans' }));

    await waitFor(() => expect(reloadComparisonData).toHaveBeenCalledWith(undefined, { background: true }));
    expect(screen.getByRole('dialog', { name: 'Import scans' })).toBeInTheDocument();
    expect(within(dialog).getByText('Import complete')).toBeInTheDocument();
    expect(screen.getByTestId('dicom-viewer')).toBeInTheDocument();
    expect(screen.queryByText('Loading comparison data…')).not.toBeInTheDocument();
  });

  it('defaults aligned output to reference resolution and persists an explicitly selected physical preset', () => {
    render(<ComparisonMatrix />);

    const resolution = screen.getByRole('combobox', { name: /alignment output resolution/i });
    expect(resolution).toHaveValue('native');
    expect(screen.getByRole('option', { name: /reference resolution/i })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: /1024.*1024/i })).toBeInTheDocument();

    fireEvent.change(resolution, { target: { value: 'fixed-1024' } });

    expect(resolution).toHaveValue('fixed-1024');
    expect(screen.getByText(/interpolated display pixels do not add acquired mri detail/i)).toBeInTheDocument();
    expect(JSON.parse(localStorage.getItem(COMPARISON_UI_STORAGE_KEY) ?? '{}')).toMatchObject({
      alignmentOutputMode: 'fixed-1024',
    });
  });

  it('discards an unrecognized persisted output preset without changing established sidebar preferences', () => {
    localStorage.setItem(
      COMPARISON_UI_STORAGE_KEY,
      JSON.stringify({ sidebarOpen: true, rightSidebarOpen: false, alignmentOutputMode: 'untrusted-grid' }),
    );

    render(<ComparisonMatrix />);

    expect(screen.getByRole('combobox', { name: /alignment output resolution/i })).toHaveValue('native');
    expect(JSON.parse(localStorage.getItem(COMPARISON_UI_STORAGE_KEY) ?? '{}')).toMatchObject({
      sidebarOpen: true,
      rightSidebarOpen: false,
      alignmentOutputMode: 'native',
    });
  });

  it('makes sharp slices an explicit display-only opt-in and toggles back without changing alignment or panel settings', () => {
    localStorage.setItem(COMPARISON_UI_STORAGE_KEY, JSON.stringify({ automaticAlignment: false }));
    render(<ComparisonMatrix />);
    const sharp = screen.getByRole('button', { name: 'Sharp slices (experimental)' });
    expect(sharp).toHaveAttribute('aria-pressed', 'false');
    expect(sharp).toHaveTextContent('Experimental');
    expect(screen.getByTestId('dicom-viewer')).toHaveAttribute('data-sharp-slices', 'false');

    fireEvent.click(sharp);
    expect(sharp).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByTestId('dicom-viewer')).toHaveAttribute('data-sharp-slices', 'true');
    expect(JSON.parse(localStorage.getItem(COMPARISON_UI_STORAGE_KEY) ?? '{}')).toMatchObject({
      sharpSlices: true,
      automaticAlignment: false,
    });
    fireEvent.click(sharp);
    expect(sharp).toHaveAttribute('aria-pressed', 'false');
    expect(screen.getByTestId('dicom-viewer')).toHaveAttribute('data-sharp-slices', 'false');
    expect(JSON.parse(localStorage.getItem(COMPARISON_UI_STORAGE_KEY) ?? '{}')).toMatchObject({
      sharpSlices: false,
      automaticAlignment: false,
    });
    expect(updatePanelSetting).not.toHaveBeenCalled();
  });

  it.each([
    { stored: true, enabled: 'true' },
    { stored: 'true', enabled: 'false' },
    { stored: 1, enabled: 'false' },
  ])('restores only an explicitly enabled sharp-display preference: $stored', ({ stored, enabled }) => {
    localStorage.setItem(COMPARISON_UI_STORAGE_KEY, JSON.stringify({ sharpSlices: stored }));
    render(<ComparisonMatrix />);
    expect(screen.getByRole('button', { name: 'Sharp slices (experimental)' })).toHaveAttribute(
      'aria-pressed',
      enabled,
    );
    expect(screen.getByTestId('dicom-viewer')).toHaveAttribute('data-sharp-slices', enabled);
  });
});
