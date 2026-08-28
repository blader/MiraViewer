import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ComparisonMatrix } from '../src/components/ComparisonMatrix';

const { sparseDataset, alignmentState, panelState } = vi.hoisted(() => {
  const examinations = ['2035-01-01T12:00:00', '2035-02-01T12:00:00', '2035-03-01T12:00:00', '2035-04-01T12:00:00'];
  const series = (plane: string, index: number) => ({
    study_id: `synthetic-study-${index}`,
    series_uid: `synthetic-${plane.toLowerCase()}-${index}`,
    instance_count: 12,
    rows: 512,
    columns: 512,
  });

  return {
    sparseDataset: {
      planes: ['Axial', 'Coronal', 'Sagittal'],
      dates: examinations,
      sequences: [
        { id: 'axial-t2', plane: 'Axial', weight: 'T2', sequence: 'FLAIR', label: 'Axial T2', date_count: 4 },
        { id: 'coronal-t2', plane: 'Coronal', weight: 'T2', sequence: 'FLAIR', label: 'Coronal T2', date_count: 1 },
        {
          id: 'sagittal-t2',
          plane: 'Sagittal',
          weight: 'T2',
          sequence: 'FLAIR',
          label: 'Sagittal T2',
          date_count: 1,
        },
      ],
      series_map: {
        'axial-t2': Object.fromEntries(examinations.map((date, index) => [date, series('Axial', index)])),
        'coronal-t2': { [examinations[1]!]: series('Coronal', 1) },
        'sagittal-t2': { [examinations[2]!]: series('Sagittal', 2) },
      },
      patients: [
        { key: 'synthetic-patient', patient_id: 'synthetic', patient_name: 'Synthetic Patient', study_count: 4 },
      ],
      selected_patient_key: 'synthetic-patient',
    },
    alignmentState: {
      isAligning: false,
      progress: null,
      results: [],
      error: null,
      clearState: vi.fn(),
      alignAllDates: vi.fn(),
      abort: vi.fn(),
    },
    panelState: {
      panelSettings: new Map(),
      progress: 0,
      setProgress: vi.fn(),
      updatePanelSetting: vi.fn(),
      batchUpdateSettings: vi.fn(),
      persistenceError: null,
      clearPersistenceError: vi.fn(),
      reportPersistenceError: vi.fn(),
    },
  };
});

vi.mock('../src/hooks/useComparisonData', () => ({
  useComparisonData: () => ({
    data: sparseDataset,
    loading: false,
    error: null,
    reload: vi.fn(),
    selectPatient: vi.fn(),
  }),
}));

vi.mock('../src/hooks/usePanelSettings', () => ({ usePanelSettings: () => panelState }));
vi.mock('../src/hooks/useAutoAlign', () => ({ useAutoAlign: () => alignmentState }));
vi.mock('../src/hooks/useApplyAlignmentResults', () => ({ useApplyAlignmentResults: vi.fn() }));
vi.mock('../src/hooks/useGlobalSliceWheelNavigation', () => ({ useGlobalSliceWheelNavigation: vi.fn() }));
vi.mock('../src/components/DicomViewer', () => ({
  DicomViewer: ({ seriesUid, children }: { seriesUid: string; children?: ReactNode }) => (
    <div data-testid="acquired-diagnostic-image" data-series-uid={seriesUid}>
      {children}
    </div>
  ),
}));

beforeEach(() => {
  localStorage.clear();
  vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(1024);
  vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(800);
});

afterEach(() => {
  vi.restoreAllMocks();
});

function diagnosticImageSize(container: HTMLElement): number {
  const grid = container.querySelector<HTMLElement>('[style*="grid-template-columns"]');
  return Number(grid?.style.gridTemplateColumns.match(/(\d+)px/)?.[1] ?? 0);
}

describe('sparse imaging-plane comparisons', () => {
  it('devotes the available viewport only to acquired series while preserving chronology and explicit date selection', async () => {
    const { container } = render(<ComparisonMatrix />);

    await waitFor(() => expect(screen.getAllByTestId('acquired-diagnostic-image')).toHaveLength(4));
    const axialImageSize = diagnosticImageSize(container);
    expect(axialImageSize).toBeGreaterThan(0);
    expect(screen.queryAllByText('No series')).toHaveLength(0);

    fireEvent.click(screen.getByRole('button', { name: 'Coronal' }));

    expect(screen.getAllByTestId('acquired-diagnostic-image')).toHaveLength(1);
    expect(screen.getByTestId('acquired-diagnostic-image')).toHaveAttribute('data-series-uid', 'synthetic-coronal-1');
    expect(screen.queryAllByText('No series')).toHaveLength(0);
    expect(diagnosticImageSize(container)).toBeGreaterThan(axialImageSize * 2);

    const chronology = Array.from(container.querySelectorAll<HTMLButtonElement>('[data-study-state]'));
    expect(chronology).toHaveLength(4);
    expect(chronology.every((row) => row.getAttribute('aria-pressed') === 'true')).toBe(true);
    expect(chronology.filter((row) => row.title === 'No data for selected sequence')).toHaveLength(3);

    fireEvent.click(screen.getByRole('button', { name: 'Sagittal' }));

    expect(screen.getAllByTestId('acquired-diagnostic-image')).toHaveLength(1);
    expect(screen.getByTestId('acquired-diagnostic-image')).toHaveAttribute('data-series-uid', 'synthetic-sagittal-2');
    expect(screen.queryAllByText('No series')).toHaveLength(0);
    expect(diagnosticImageSize(container)).toBeGreaterThan(axialImageSize * 2);

    fireEvent.click(screen.getByRole('button', { name: 'Axial' }));

    expect(screen.getAllByTestId('acquired-diagnostic-image')).toHaveLength(4);
    expect(screen.queryAllByText('No series')).toHaveLength(0);
    expect(diagnosticImageSize(container)).toBe(axialImageSize);

    fireEvent.click(screen.getByTitle('Deselect all dates'));

    expect(screen.queryByTestId('acquired-diagnostic-image')).not.toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Choose examinations to compare.' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Choose examinations' }));
    expect(screen.getByRole('button', { name: 'Hide examination dates' })).toHaveAttribute('aria-expanded', 'true');
    expect(screen.queryAllByText('No series')).toHaveLength(0);
  });
});
