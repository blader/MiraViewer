import { readFileSync } from 'node:fs';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ComparisonMatrix } from '../src/components/ComparisonMatrix';

const examinations = ['2025-01-01T00:00:00', '2025-02-01T00:00:00'];
const { measuredPane, alignmentPresentation } = vi.hoisted(() => ({
  measuredPane: { width: 800, height: 600 },
  alignmentPresentation: {
    isAligning: false,
    multiplePatients: false,
    error: null as string | null,
    results: [] as Array<{ date: string; outcome: 'aligned' | 'failed'; message?: string; runId?: string }>,
  },
}));

vi.mock('../src/hooks/useComparisonData', () => ({
  useComparisonData: () => ({
    data: {
      planes: ['Axial'],
      dates: examinations,
      patients: [
        { key: 'synthetic-patient', patient_name: 'Synthetic Patient', study_count: 2 },
        ...(alignmentPresentation.multiplePatients
          ? [{ key: 'second-synthetic-patient', patient_name: 'Second Synthetic Patient', study_count: 1 }]
          : []),
      ],
      selected_patient_key: 'synthetic-patient',
      sequences: [{ id: 'synthetic-sequence', plane: 'Axial', weight: 'T1', sequence: 'SE', label: 'T1' }],
      series_map: {
        'synthetic-sequence': {
          [examinations[0]!]: { study_id: 'first-study', series_uid: 'first-series', instance_count: 4 },
          [examinations[1]!]: { study_id: 'second-study', series_uid: 'second-series', instance_count: 4 },
        },
      },
    },
    loading: false,
    error: null,
    reload: vi.fn(),
    selectPatient: vi.fn(),
  }),
}));

vi.mock('../src/hooks/useComparisonFilters', () => ({
  useComparisonFilters: () => ({
    availablePlanes: ['Axial'],
    selectedPlane: 'Axial',
    selectedSeqId: 'synthetic-sequence',
    enabledDates: new Set(examinations),
    enabledDatesKey: examinations.join(','),
    sortedDates: examinations,
    selectPlane: vi.fn(),
    selectSequence: vi.fn(),
    selectAllDates: vi.fn(),
    selectNoDates: vi.fn(),
    toggleDate: vi.fn(),
  }),
}));

vi.mock('../src/hooks/usePanelSettings', () => ({
  usePanelSettings: () => ({
    panelSettings: new Map(),
    progress: 0,
    setProgress: vi.fn(),
    updatePanelSetting: vi.fn(),
    batchUpdateSettings: vi.fn(),
    persistenceError: null,
    clearPersistenceError: vi.fn(),
    reportPersistenceError: vi.fn(),
  }),
}));

vi.mock('../src/hooks/useGridLayout', () => ({
  useGridLayout: () => ({
    containerRef: vi.fn(),
    cols: 2,
    cellSize: 200,
    gridSize: measuredPane,
  }),
}));

vi.mock('../src/hooks/useAutoAlign', () => ({
  useAutoAlign: () => ({
    isAligning: alignmentPresentation.isAligning,
    progress: alignmentPresentation.isAligning
      ? { phase: 'capturing', currentDate: null, dateIndex: 0, totalDates: 1, slicesChecked: 0, bestMiSoFar: 0 }
      : null,
    results: alignmentPresentation.results,
    error: alignmentPresentation.error,
    clearState: vi.fn(),
    alignAllDates: vi.fn(),
    abort: vi.fn(),
  }),
}));

vi.mock('../src/hooks/useApplyAlignmentResults', () => ({ useApplyAlignmentResults: vi.fn() }));
vi.mock('../src/hooks/useGlobalSliceWheelNavigation', () => ({ useGlobalSliceWheelNavigation: vi.fn() }));
vi.mock('../src/components/comparison/GridView', () => ({ GridView: () => <div>Acquired comparison images</div> }));
vi.mock('../src/components/comparison/OverlayView', () => ({
  OverlayView: ({ overlayViewerSize }: { overlayViewerSize: number }) => (
    <div data-testid="overlay-viewer-size">{overlayViewerSize}</div>
  ),
}));
vi.mock('../src/components/Svr3DView', () => ({
  Svr3DView: ({ defaultDateIso }: { defaultDateIso: string | null }) => (
    <div data-testid="reconstruction-examination">{defaultDateIso}</div>
  ),
}));

const stylesheet = readFileSync('src/index.css', 'utf8');

describe('Quiet Instrument visual system', () => {
  beforeEach(() => {
    localStorage.clear();
    measuredPane.width = 800;
    measuredPane.height = 600;
    alignmentPresentation.isAligning = false;
    alignmentPresentation.multiplePatients = false;
    alignmentPresentation.error = null;
    alignmentPresentation.results = [];
  });

  it('keeps one clinical palette with distinct action, evidence, warning, and focus semantics', () => {
    const expectedTokens = {
      'bg-primary': '#111210',
      'bg-secondary': '#181a18',
      'bg-tertiary': '#20221f',
      'border-color': '#353831',
      'text-primary': '#efede7',
      'text-secondary': '#a6a59b',
      'text-tertiary': '#92938a',
      accent: '#75633c',
      'accent-hover': '#87744a',
      'signal-metal': '#c7b58c',
      evidence: '#8fbab2',
      warning: '#d1a566',
      danger: '#d89b93',
      'focus-ring': '#c7b58c',
    };

    for (const [name, value] of Object.entries(expectedTokens)) {
      expect(stylesheet).toMatch(new RegExp(`--${name}:\\s*${value}`, 'i'));
    }
  });

  it('derives acquisition surfaces from the shared palette and keeps the receiving field quiet', () => {
    const intakePalette = stylesheet.match(/\.intake-console\s*\{([^}]+)\}/)?.[1];

    expect(intakePalette).toBeDefined();
    expect(intakePalette).toContain('--intake-chamber: var(--bg-primary)');
    expect(intakePalette).toContain('--intake-panel: var(--bg-secondary)');
    expect(intakePalette).toContain('--intake-raised: var(--bg-tertiary)');
    expect(intakePalette).toContain('--intake-line: var(--border-color)');
    expect(intakePalette).toContain('--intake-instrument: var(--signal-metal)');
    expect(stylesheet.match(/\.intake-drop-target\s*\{([^}]+)\}/)?.[1]).not.toContain('dashed');
  });

  it('keeps every acquisition source visible on compact screens without shrinking 44px touch targets', () => {
    const compactIntake = stylesheet.slice(stylesheet.indexOf('@media (max-width: 560px)'));

    expect(compactIntake).toMatch(
      /\.intake-source-actions\s*\{\s*grid-template-columns:\s*repeat\(2, minmax\(0, 1fr\)\)/,
    );
    expect(compactIntake).toMatch(/\.intake-backup-button\s*\{\s*grid-column:\s*1\s*\/\s*-1/);
    expect(compactIntake).toMatch(/\.intake-drop-target\s*\{\s*min-height:\s*6\.5rem/);
    expect(stylesheet).toMatch(/\.intake-source-button,\s*\.intake-button\s*\{[^}]*min-height:\s*44px/s);
  });

  it('uses offline-native typography, visible focus, and responsive drawer rather than layout animation', () => {
    expect(stylesheet).toMatch(/--font-display:\s*Optima/i);
    expect(stylesheet).toMatch(/--font-interface:\s*'Avenir Next'/i);
    expect(stylesheet).toMatch(/--font-mono:\s*'SFMono-Regular'/i);
    expect(stylesheet).toMatch(/outline:\s*2px solid var\(--focus-ring\)/);
    expect(stylesheet).toMatch(/@media\s*\(max-width:\s*1024px\)/);
    expect(stylesheet).not.toMatch(/https?:\/\//);
    expect(stylesheet).not.toMatch(/transition:\s*all/i);
  });

  it('keeps detailed accessible alignment notices outside the unchanged diagnostic stage across retries', () => {
    alignmentPresentation.results = [
      {
        date: examinations[0]!,
        outcome: 'failed',
        message: 'The selected examination has insufficient acquired support',
        runId: 'previous-run',
      },
      {
        date: examinations[1]!,
        outcome: 'failed',
        message: 'The registration worker timed out',
        runId: 'previous-run',
      },
    ];

    const { container, rerender } = render(<ComparisonMatrix />);
    const contextRail = screen.getByLabelText('Selected examination and image context');
    const diagnosticStage = container.querySelector('.instrument-stage');
    const diagnosticImages = screen.getByText('Acquired comparison images');
    const warning = screen
      .getByText('Some examinations could not be aligned safely.')
      .closest<HTMLElement>('[role="status"]')!;

    expect(contextRail).toHaveAttribute('data-notices-visible', 'true');
    expect(contextRail).toContainElement(warning);
    expect(diagnosticStage).not.toContainElement(warning);
    expect(within(warning).getAllByRole('listitem')).toHaveLength(2);
    expect(warning).toHaveTextContent('The selected examination has insufficient acquired support');
    expect(warning).toHaveTextContent('The registration worker timed out');
    expect(Array.from(diagnosticStage?.children ?? [])).toEqual([diagnosticImages]);

    alignmentPresentation.results = [];
    alignmentPresentation.isAligning = true;
    rerender(<ComparisonMatrix />);

    expect(contextRail).not.toHaveAttribute('data-notices-visible');
    expect(screen.queryByText('Some examinations could not be aligned safely.')).not.toBeInTheDocument();
    expect(Array.from(diagnosticStage?.children ?? [])).toEqual([diagnosticImages]);

    alignmentPresentation.isAligning = false;
    alignmentPresentation.error = 'Unable to initialize the registration worker';
    rerender(<ComparisonMatrix />);

    const fatalError = screen.getByRole('alert');
    expect(contextRail).toHaveAttribute('data-notices-visible', 'true');
    expect(contextRail).toContainElement(fatalError);
    expect(diagnosticStage).not.toContainElement(fatalError);
    expect(fatalError).toHaveTextContent('Unable to initialize the registration worker');
    expect(within(fatalError).getByRole('button', { name: 'Dismiss' })).toBeEnabled();
    expect(Array.from(diagnosticStage?.children ?? [])).toEqual([diagnosticImages]);
  });

  it('keeps notice details horizontally accessible inside a stable compact context rail', () => {
    const noticeRail = stylesheet.match(/\.instrument-notice-rail\s*\{([^}]+)\}/)?.[1];
    const notice = stylesheet.match(/\.instrument-notice\s*\{([^}]+)\}/)?.[1];
    const details = stylesheet.match(/\.instrument-notice-details\s*\{([^}]+)\}/)?.[1];

    expect(noticeRail).toMatch(/overflow-x:\s*auto/);
    expect(noticeRail).toMatch(/min-width:\s*0/);
    expect(notice).toMatch(/white-space:\s*nowrap/);
    expect(notice).toMatch(/flex:\s*0\s+0\s+auto/);
    expect(details).toMatch(/display:\s*flex/);

    const compactContext = stylesheet.slice(stylesheet.indexOf('@media (max-width: 760px)'));
    expect(compactContext).toMatch(
      /\.instrument-context-rail\[data-notices-visible=['"]true['"]\]\s+\.instrument-context-summary\s*>\s*:not\(:first-child\)\s*\{\s*display:\s*none/,
    );
    expect(compactContext).toMatch(
      /\.instrument-context-rail\[data-notices-visible=['"]true['"]\]\s+\.instrument-context-playback,\s*\.instrument-context-rail\[data-notices-visible=['"]true['"]\]\s+\.instrument-study-filmstrip\s*\{\s*display:\s*none/,
    );
  });

  it('keeps patient, examination, filter, mode, drawer, and modal entry points usable during background alignment', () => {
    alignmentPresentation.isAligning = true;
    alignmentPresentation.multiplePatients = true;
    const { rerender } = render(<ComparisonMatrix />);

    expect(screen.getByRole('button', { name: 'Compare' })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Overlay' })).toBeEnabled();
    expect(screen.getByRole('button', { name: '3D' })).toBeEnabled();
    expect(screen.getByRole('combobox', { name: 'Selected patient' })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Import additional scans' })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Help and keyboard shortcuts' })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Application menu' })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Hide scan filters' })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Show examination dates' })).toBeEnabled();

    const filters = screen.getByRole('complementary', { name: 'Scan filters' });
    expect(within(filters).getByRole('button', { name: 'Axial' })).toBeEnabled();
    expect(within(filters).getByRole('button', { name: /T1/i })).toBeEnabled();
    expect(screen.getByRole('combobox', { name: 'Alignment output resolution' })).toBeEnabled();

    const dates = screen.getByRole('complementary', { name: 'Examination dates' });
    expect(within(dates).getByRole('button', { name: 'All' })).toBeEnabled();
    expect(within(dates).getByRole('button', { name: 'None' })).toBeEnabled();
    for (const examination of within(dates).getAllByRole('button', { name: /2025/i })) {
      expect(examination).toBeEnabled();
    }

    alignmentPresentation.isAligning = false;
    rerender(<ComparisonMatrix />);

    expect(screen.getByRole('button', { name: 'Overlay' })).toBeEnabled();
    expect(screen.getByRole('combobox', { name: 'Selected patient' })).toBeEnabled();
    expect(within(filters).getByRole('button', { name: 'Axial' })).toBeEnabled();
    expect(within(dates).getByRole('button', { name: 'All' })).toBeEnabled();
  });

  it('leaves overlay examination navigation and playback usable during background alignment', () => {
    const { rerender } = render(<ComparisonMatrix />);
    fireEvent.click(screen.getByRole('button', { name: 'Overlay' }));

    alignmentPresentation.isAligning = true;
    rerender(<ComparisonMatrix />);

    expect(screen.getByRole('button', { name: 'Start comparison playback' })).toBeEnabled();
    expect(screen.getByRole('combobox', { name: 'Comparison playback speed' })).toBeEnabled();
    const chronology = screen.getByRole('navigation', { name: 'Available examinations' });
    for (const examination of within(chronology).getAllByRole('button')) {
      expect(examination).toBeEnabled();
    }

    alignmentPresentation.isAligning = false;
    rerender(<ComparisonMatrix />);

    expect(screen.getByRole('button', { name: 'Start comparison playback' })).toBeEnabled();
    expect(within(chronology).getAllByRole('button')[0]).toBeEnabled();
  });

  it('opens the newest enabled grid examination for reconstruction and preserves later study selection', async () => {
    render(<ComparisonMatrix />);

    expect(screen.getByLabelText('Selected patient')).toHaveTextContent('Synthetic Patient');
    expect(screen.getByRole('complementary', { name: 'Examination dates' })).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: '3D' }));

    expect(screen.queryByRole('complementary', { name: 'Examination dates' })).not.toBeInTheDocument();
    expect(await screen.findByTestId('reconstruction-examination')).toHaveTextContent(examinations[1]!);

    const chronology = screen.getByRole('navigation', { name: 'Available examinations' });
    const firstStudy = within(chronology).getByRole('button', { name: /Jan 1, 2025/i });
    fireEvent.click(firstStudy);

    expect(firstStudy).toHaveAttribute('aria-current', 'true');
    expect(screen.getByTestId('reconstruction-examination')).toHaveTextContent(examinations[0]!);
    expect(screen.getByLabelText('Selected patient')).toHaveTextContent('Synthetic Patient');
  });

  it('preserves an explicitly selected older overlay examination when opening reconstruction', async () => {
    render(<ComparisonMatrix />);
    fireEvent.click(screen.getByRole('button', { name: 'Overlay' }));

    const chronology = screen.getByRole('navigation', { name: 'Available examinations' });
    fireEvent.click(within(chronology).getByRole('button', { name: /Feb 1, 2025/i }));
    const selectedStudy = within(chronology).getByRole('button', { name: /Jan 1, 2025/i });
    fireEvent.click(selectedStudy);
    expect(selectedStudy).toHaveAttribute('aria-current', 'true');

    fireEvent.click(screen.getByRole('button', { name: '3D' }));

    expect(await screen.findByTestId('reconstruction-examination')).toHaveTextContent(examinations[0]!);
  });

  it('preserves the selected examination across workspace refresh and restores the newest after returning to the grid', async () => {
    const { rerender } = render(<ComparisonMatrix />);
    fireEvent.click(screen.getByRole('button', { name: '3D' }));
    expect(await screen.findByTestId('reconstruction-examination')).toHaveTextContent(examinations[1]!);

    rerender(<ComparisonMatrix />);
    expect(screen.getByTestId('reconstruction-examination')).toHaveTextContent(examinations[1]!);

    const chronology = screen.getByRole('navigation', { name: 'Available examinations' });
    fireEvent.click(within(chronology).getByRole('button', { name: /Jan 1, 2025/i }));
    rerender(<ComparisonMatrix />);
    expect(screen.getByTestId('reconstruction-examination')).toHaveTextContent(examinations[0]!);

    fireEvent.click(screen.getByRole('button', { name: 'Compare' }));
    fireEvent.click(screen.getByRole('button', { name: '3D' }));
    expect(await screen.findByTestId('reconstruction-examination')).toHaveTextContent(examinations[1]!);
  });

  it('keeps only one substantial navigation surface open and closes a contextual drawer with Escape', () => {
    const originalWidth = Object.getOwnPropertyDescriptor(window, 'innerWidth');
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1280 });

    try {
      render(<ComparisonMatrix />);

      expect(screen.getByRole('button', { name: 'Hide scan filters' })).toHaveAttribute('aria-expanded', 'true');
      fireEvent.click(screen.getByRole('button', { name: 'Show examination dates' }));

      expect(screen.getByRole('button', { name: 'Show scan filters' })).toHaveAttribute('aria-expanded', 'false');
      expect(screen.getByRole('button', { name: 'Hide examination dates' })).toHaveAttribute('aria-expanded', 'true');

      fireEvent.keyDown(window, { key: 'Escape' });

      expect(screen.getByRole('button', { name: 'Show examination dates' })).toHaveAttribute('aria-expanded', 'false');
    } finally {
      if (originalWidth) Object.defineProperty(window, 'innerWidth', originalWidth);
    }
  });

  it('fits an overlay image inside a measured 320px viewport without inventing a 300px minimum', () => {
    measuredPane.width = 320;
    measuredPane.height = 500;
    render(<ComparisonMatrix />);

    fireEvent.click(screen.getByRole('button', { name: 'Overlay' }));

    expect(screen.getByTestId('overlay-viewer-size')).toHaveTextContent('272');
  });

  it('initially keeps compact navigation closed while preserving patient identity and accessible reopening', () => {
    const originalWidth = Object.getOwnPropertyDescriptor(window, 'innerWidth');
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 390 });

    try {
      render(<ComparisonMatrix />);

      expect(screen.getByLabelText('Selected patient')).toHaveTextContent('Synthetic Patient');
      expect(screen.getByRole('button', { name: 'Show scan filters' })).toHaveAttribute('aria-expanded', 'false');

      fireEvent.click(screen.getByRole('button', { name: 'Show scan filters' }));
      expect(screen.getByRole('button', { name: 'Hide scan filters' })).toHaveAttribute('aria-expanded', 'true');
    } finally {
      if (originalWidth) Object.defineProperty(window, 'innerWidth', originalWidth);
    }
  });
});
