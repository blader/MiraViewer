import { fireEvent, render, screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { state, selectPatient, abortAlignment, clearAlignmentState, clearPersistenceError } = vi.hoisted(() => ({
  state: {
    patients: [
      { key: 'synthetic-a', patient_id: 'A', patient_name: 'Synthetic Alpha', study_count: 1 },
      { key: 'synthetic-b', patient_id: 'B', patient_name: 'Synthetic Beta', study_count: 1 },
    ],
    results: [] as Array<{
      date: string;
      outcome: 'aligned' | 'ambiguous' | 'failed';
      message?: string;
      runId?: string;
    }>,
    alignmentError: null as string | null,
    persistenceError: null as string | null,
    panelSettings: new Map(),
  },
  selectPatient: vi.fn(async () => undefined),
  abortAlignment: vi.fn(),
  clearAlignmentState: vi.fn(),
  clearPersistenceError: vi.fn(),
}));

vi.mock('../src/hooks/useComparisonData', () => ({
  useComparisonData: () => ({
    data: {
      planes: [],
      dates: [],
      sequences: [],
      series_map: {},
      selected_patient_key: 'synthetic-a',
      patients: state.patients,
    },
    loading: false,
    error: null,
    reload: vi.fn(),
    selectPatient,
  }),
}));

vi.mock('../src/hooks/useAutoAlign', () => ({
  useAutoAlign: () => ({
    isAligning: false,
    progress: null,
    results: state.results,
    error: state.alignmentError,
    clearState: clearAlignmentState,
    alignAllDates: vi.fn(),
    abort: abortAlignment,
  }),
}));

vi.mock('../src/hooks/usePanelSettings', () => ({
  usePanelSettings: () => ({
    panelSettings: state.panelSettings,
    progress: 0,
    setProgress: vi.fn(),
    updatePanelSetting: vi.fn(),
    batchUpdateSettings: vi.fn(),
    persistenceError: state.persistenceError,
    clearPersistenceError,
  }),
}));

vi.mock('../src/components/UploadModal', () => ({ UploadModal: () => null }));
vi.mock('../src/components/ExportModal', () => ({ ExportModal: () => null }));
vi.mock('../src/components/ClearDataModal', () => ({ ClearDataModal: () => null }));

import { ComparisonMatrix } from '../src/components/ComparisonMatrix';

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  state.patients = [
    { key: 'synthetic-a', patient_id: 'A', patient_name: 'Synthetic Alpha', study_count: 1 },
    { key: 'synthetic-b', patient_id: 'B', patient_name: 'Synthetic Beta', study_count: 1 },
  ];
  state.results = [];
  state.alignmentError = null;
  state.persistenceError = null;
  state.panelSettings.clear();
});

describe('patient selection safety', () => {
  it('names the selector and cancels alignment before switching patient scope', () => {
    render(<ComparisonMatrix />);

    const selector = screen.getByRole('combobox', { name: 'Selected patient' });
    expect(selector).toHaveValue('synthetic-a');
    expect(screen.getByRole('option', { name: 'Synthetic Beta' })).toHaveValue('synthetic-b');

    fireEvent.change(selector, { target: { value: 'synthetic-b' } });

    expect(abortAlignment).toHaveBeenCalledOnce();
    expect(clearAlignmentState).toHaveBeenCalledOnce();
    expect(selectPatient).toHaveBeenCalledWith('synthetic-b');
    expect(abortAlignment.mock.invocationCallOrder[0]).toBeLessThan(selectPatient.mock.invocationCallOrder[0]!);
    expect(clearAlignmentState.mock.invocationCallOrder[0]).toBeLessThan(selectPatient.mock.invocationCallOrder[0]!);
  });

  it('keeps a single loaded patient visibly identified without offering a meaningless selector', () => {
    state.patients = [state.patients[0]!];
    render(<ComparisonMatrix />);

    expect(screen.getByLabelText('Selected patient')).toHaveTextContent('Synthetic Alpha');
    expect(screen.queryByRole('combobox', { name: 'Selected patient' })).not.toBeInTheDocument();
  });

  it('announces ambiguous and failed terminal alignment outcomes with their actionable messages', () => {
    state.results = [
      {
        date: '2025-01-01T00:00:00.000Z',
        outcome: 'ambiguous',
        message: 'Two slices match equally well',
        runId: 'synthetic-run',
      },
      {
        date: '2025-02-01T00:00:00.000Z',
        outcome: 'failed',
        message: 'Registration worker timed out',
        runId: 'synthetic-run',
      },
      { date: '2025-03-01T00:00:00.000Z', outcome: 'aligned', runId: 'synthetic-run' },
    ];
    render(<ComparisonMatrix />);

    const status = screen.getByRole('status');
    expect(status).toHaveAttribute('aria-live', 'polite');
    expect(status).toHaveTextContent('Some examinations could not be aligned safely.');
    expect(status).toHaveTextContent('Two slices match equally well');
    expect(status).toHaveTextContent('Registration worker timed out');
    expect(within(status).getAllByRole('listitem')).toHaveLength(2);

    fireEvent.click(within(status).getByRole('button', { name: 'Dismiss' }));
    expect(clearAlignmentState).toHaveBeenCalledOnce();
  });

  it('surfaces fatal alignment failures through an accessible alert', () => {
    state.alignmentError = 'Unable to initialize the registration worker';
    render(<ComparisonMatrix />);

    expect(screen.getByRole('alert')).toHaveTextContent(
      'Alignment failed: Unable to initialize the registration worker',
    );
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }));
    expect(clearAlignmentState).toHaveBeenCalledOnce();
  });

  it('announces durable viewer-setting failures instead of losing changes silently', () => {
    state.persistenceError = 'IndexedDB quota exceeded';
    render(<ComparisonMatrix />);

    expect(screen.getByRole('alert')).toHaveTextContent('Changes could not be saved: IndexedDB quota exceeded');
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }));
    expect(clearPersistenceError).toHaveBeenCalledOnce();
  });
});
