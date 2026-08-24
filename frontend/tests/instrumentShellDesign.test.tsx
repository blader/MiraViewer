import { readFileSync } from 'node:fs';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ComparisonMatrix } from '../src/components/ComparisonMatrix';

const examinations = ['2025-01-01T00:00:00', '2025-02-01T00:00:00'];
const { measuredPane } = vi.hoisted(() => ({ measuredPane: { width: 800, height: 600 } }));

vi.mock('../src/hooks/useComparisonData', () => ({
  useComparisonData: () => ({
    data: {
      planes: ['Axial'],
      dates: examinations,
      patients: [{ key: 'synthetic-patient', patient_name: 'Synthetic Patient', study_count: 2 }],
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
    isAligning: false,
    progress: null,
    results: [],
    error: null,
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

  it('preserves actual reconstruction examination selection without occupying a global date sidebar', async () => {
    render(<ComparisonMatrix />);

    expect(screen.getByLabelText('Selected patient')).toHaveTextContent('Synthetic Patient');
    expect(screen.getByRole('complementary', { name: 'Examination dates' })).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: '3D' }));

    expect(screen.queryByRole('complementary', { name: 'Examination dates' })).not.toBeInTheDocument();
    expect(await screen.findByTestId('reconstruction-examination')).toHaveTextContent(examinations[0]!);

    const chronology = screen.getByRole('navigation', { name: 'Available examinations' });
    const secondStudy = within(chronology).getByRole('button', { name: /Feb 1, 2025/i });
    fireEvent.click(secondStudy);

    expect(secondStudy).toHaveAttribute('aria-current', 'true');
    expect(screen.getByTestId('reconstruction-examination')).toHaveTextContent(examinations[1]!);
    expect(screen.getByLabelText('Selected patient')).toHaveTextContent('Synthetic Patient');
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
