import { render, screen, fireEvent } from '@testing-library/react';
import { beforeEach, describe, it, expect, vi } from 'vitest';
import { ComparisonMatrix } from '../src/components/ComparisonMatrix';
import { DEFAULT_PANEL_SETTINGS } from '../src/utils/constants';
import { COMPARISON_UI_STORAGE_KEY } from '../src/utils/storageKeys';

vi.mock('../src/hooks/useComparisonData', () => ({
  useComparisonData: () => ({
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
    loading: false,
    error: null,
    reload: vi.fn(),
  }),
}));

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
    updatePanelSetting: vi.fn(),
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

vi.mock('../src/components/DicomViewer', () => ({
  DicomViewer: () => <div data-testid="dicom-viewer" />,
}));

describe('ComparisonMatrix', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('renders header menu actions', () => {
    render(<ComparisonMatrix />);

    const menuButton = screen.getByTitle(/menu/i);
    expect(menuButton).toBeInTheDocument();

    fireEvent.click(menuButton);

    expect(screen.getByText(/import \(dicom zip\)/i)).toBeInTheDocument();
    expect(screen.getByText(/export backup \(zip\)/i)).toBeInTheDocument();
    expect(screen.getByTestId('dicom-viewer')).toBeInTheDocument();
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
});
