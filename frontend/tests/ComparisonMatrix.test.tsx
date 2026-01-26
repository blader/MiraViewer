import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import { ComparisonMatrix } from '../src/components/ComparisonMatrix';
import { DEFAULT_PANEL_SETTINGS } from '../src/utils/constants';

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
  it('renders header menu actions', () => {
    render(<ComparisonMatrix />);

    const menuButton = screen.getByTitle(/menu/i);
    expect(menuButton).toBeInTheDocument();

    fireEvent.click(menuButton);

    expect(screen.getByText(/import \(dicom zip\)/i)).toBeInTheDocument();
    expect(screen.getByText(/export backup \(zip\)/i)).toBeInTheDocument();
    expect(screen.getByTestId('dicom-viewer')).toBeInTheDocument();
  });
});
