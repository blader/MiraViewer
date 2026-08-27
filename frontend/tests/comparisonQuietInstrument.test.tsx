import type { ReactNode } from 'react';
import { act, fireEvent, render as renderWithoutWorkspace, renderHook, screen } from '@testing-library/react';
import { StudyToolsWorkspace } from '../src/components/comparison/StudyTools';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AlignmentResult, SeriesRef } from '../src/types/api';
import { ComparisonDatesSidebar } from '../src/components/comparison/ComparisonDatesSidebar';
import { ComparisonFiltersSidebar } from '../src/components/comparison/ComparisonFiltersSidebar';
import { GridCell } from '../src/components/comparison/GridCell';
import { GridView } from '../src/components/comparison/GridView';
import { OverlayView } from '../src/components/comparison/OverlayView';
import { SliceLoopNavigator } from '../src/components/comparison/SliceLoopNavigator';
import { DEFAULT_PANEL_SETTINGS, GRID_CELL_METADATA_HEIGHT } from '../src/utils/constants';
import { clearDerivedAlignmentFrames, setDerivedAlignmentFrame } from '../src/utils/derivedAlignmentFrame';
import { useGridLayout } from '../src/hooks/useGridLayout';

vi.mock('../src/components/DicomViewer', () => ({
  DicomViewer: ({
    seriesUid,
    interactionBlocked,
    onInstanceChange,
    onZoomChange,
  }: {
    seriesUid: string;
    interactionBlocked?: boolean;
    onInstanceChange?: (index: number) => void;
    onZoomChange?: (zoom: number) => void;
  }) => (
    <div
      data-testid={`diagnostic-image-${seriesUid}`}
      onWheel={(event) => {
        if (interactionBlocked) return;
        if (event.metaKey || event.ctrlKey) {
          onZoomChange?.(1.5);
          return;
        }
        onInstanceChange?.(1);
      }}
    />
  ),
}));

vi.mock('../src/components/DragRectActionOverlay', () => ({
  DragRectActionOverlay: ({
    children,
    imageSize,
    actions,
  }: {
    children: ReactNode;
    imageSize?: { width: number; height: number };
    actions?: Array<{
      key: string;
      title?: string;
      disabled?: boolean;
      onConfirm: (masks: {
        base: { x: number; y: number; width: number; height: number };
        screen: { x: number; y: number; width: number; height: number };
      }) => void;
    }>;
  }) => (
    <div
      data-testid="diagnostic-drag-overlay"
      data-image-width={imageSize?.width}
      data-image-height={imageSize?.height}
      data-actions={actions?.map((action) => action.key).join(',')}
      data-segment-disabled={String(actions?.find((action) => action.key === 'segment-tumor')?.disabled ?? false)}
    >
      {children}
    </div>
  ),
}));

vi.mock('../src/components/comparison/LazyStudyOverlays', () => ({
  GroundTruthPolygonOverlay: () => null,
  TumorSavedSegmentationOverlay: () => null,
  TumorSegmentationOverlay: () => null,
}));

const selectedDate = '2025-01-01T00:00:00.000Z';
function render(ui: ReactNode) {
  return renderWithoutWorkspace(ui, { wrapper: StudyToolsWorkspace });
}
const compareDate = '2025-02-01T00:00:00.000Z';
const selectedSeries: SeriesRef = {
  study_id: 'synthetic-selected-study',
  series_uid: 'synthetic-selected-series',
  instance_count: 11,
  rows: 128,
  columns: 256,
};
const compareSeries: SeriesRef = {
  ...selectedSeries,
  study_id: 'synthetic-comparison-study',
  series_uid: 'synthetic-comparison-series',
};

function alignedResult(series: SeriesRef, date: string): AlignmentResult {
  return {
    date,
    seriesUid: series.series_uid,
    bestSliceIndex: 0,
    nmiScore: 1,
    computedSettings: DEFAULT_PANEL_SETTINGS,
    slicesChecked: 1,
    runId: 'verified-synthetic-alignment',
    outcome: 'aligned',
    derivedFrame: {
      pixels: new Float32Array([1, 2, 3, 4]),
      rows: 2,
      columns: 2,
      sourceImageId: 'miradb:verified-synthetic-source',
    },
  };
}

function comparisonProps() {
  return {
    comboId: 'synthetic-sequence',
    updatePanelSetting: vi.fn(),
    setProgress: vi.fn(),
  };
}

function gridCellProps() {
  return {
    ...comparisonProps(),
    date: selectedDate,
    refData: selectedSeries,
    settings: DEFAULT_PANEL_SETTINGS,
    progress: 0,
  };
}

function gridViewProps(columns: Array<{ date: string; ref: SeriesRef }>, gridCols: number, gridCellSize: number) {
  return {
    ...comparisonProps(),
    columns,
    gridCols,
    gridCellSize,
    panelSettings: new Map(),
    progress: 0,
  };
}

function overlayProps() {
  return {
    ...comparisonProps(),
    overlayColumns: [
      { date: selectedDate, ref: selectedSeries },
      { date: compareDate, ref: compareSeries },
    ],
    overlayViewerSize: 420,
    overlayDisplayedRef: selectedSeries,
    overlayDisplayedDate: selectedDate,
    overlayDisplayedSettings: DEFAULT_PANEL_SETTINGS,
    overlayDisplayedSliceIndex: 0,
    overlaySelectedRef: selectedSeries,
    overlaySelectedDate: selectedDate,
    overlaySelectedSettings: DEFAULT_PANEL_SETTINGS,
    overlaySelectedSliceIndex: 0,
    overlayCompareRef: compareSeries,
    overlayCompareDate: compareDate,
    overlayCompareSettings: DEFAULT_PANEL_SETTINGS,
    overlayCompareSliceIndex: 0,
    isOverlayComparing: false,
    hasOverlayCompareTarget: true,
  };
}

afterEach(() => {
  act(() => clearDerivedAlignmentFrames());
});

describe('Quiet Instrument comparison surfaces', () => {
  it('budgets examination gutters once while maximizing square diagnostic images inside the available viewport', () => {
    const viewportWidth = 880;
    const viewportHeight = 680;
    const examinationCount = 3;
    const { result } = renderHook(() => useGridLayout(examinationCount));

    act(() => {
      result.current.containerRef({ clientWidth: viewportWidth, clientHeight: viewportHeight } as HTMLDivElement);
    });

    const { cols, cellSize } = result.current;
    const rows = Math.ceil(examinationCount / cols);
    expect(cols).toBe(3);
    expect(cellSize).toBe(272);
    expect(cols * cellSize + (cols - 1) * 8).toBeLessThanOrEqual(viewportWidth - 48);
    expect(rows * (cellSize + GRID_CELL_METADATA_HEIGHT) + (rows - 1) * 8).toBeLessThanOrEqual(viewportHeight - 48);

    const { container } = render(
      <GridView {...gridViewProps([{ date: selectedDate, ref: selectedSeries }], 1, cellSize)} />,
    );

    expect(container.querySelector<HTMLElement>('[style*="grid-auto-rows"]')?.style.gridAutoRows).toBe(
      `${cellSize + GRID_CELL_METADATA_HEIGHT}px`,
    );
  });

  it('shows one dominant square diagnostic image per row on narrow screens without discarding examinations', () => {
    const viewportWidth = 390;
    const viewportHeight = 620;
    const thirdDate = '2025-03-01T00:00:00.000Z';
    const thirdSeries: SeriesRef = {
      ...selectedSeries,
      study_id: 'synthetic-third-study',
      series_uid: 'synthetic-third-series',
    };
    const examinations = [
      { date: selectedDate, ref: selectedSeries },
      { date: compareDate, ref: compareSeries },
      { date: thirdDate, ref: thirdSeries },
    ];
    const { result } = renderHook(() => useGridLayout(examinations.length));

    act(() => {
      result.current.containerRef({ clientWidth: viewportWidth, clientHeight: viewportHeight } as HTMLDivElement);
    });

    expect(result.current.cols).toBe(1);
    expect(result.current.cellSize).toBe(342);
    expect(result.current.cellSize).toBeGreaterThan(viewportWidth * 0.8);

    const { container } = render(
      <GridView {...gridViewProps(examinations, result.current.cols, result.current.cellSize)} />,
    );

    const scrollSurface = container.querySelector('.study-workspace')?.firstElementChild as HTMLElement;
    const imageGrid = container.querySelector<HTMLElement>('[style*="grid-auto-rows"]');
    expect(scrollSurface.className).toContain('overflow-y-auto');
    expect(imageGrid?.style.gridTemplateColumns).toBe('repeat(1, 342px)');
    expect(imageGrid?.style.gridAutoRows).toBe(`${342 + GRID_CELL_METADATA_HEIGHT}px`);
    expect(
      Array.from(container.querySelectorAll('[data-grid-cell-date]'), (cell) =>
        cell.getAttribute('data-grid-cell-date'),
      ),
    ).toEqual([selectedDate, compareDate, thirdDate]);
    expect(screen.getByTestId(`diagnostic-image-${selectedSeries.series_uid}`)).toBeInTheDocument();
    expect(screen.getByTestId(`diagnostic-image-${compareSeries.series_uid}`)).toBeInTheDocument();
    expect(screen.getByTestId(`diagnostic-image-${thirdSeries.series_uid}`)).toBeInTheDocument();
  });

  it('keeps compact examination chronology tied to distinct canonical study identities', () => {
    const sameDayStudy = '2025-01-01T12:30:00.000Z';
    const onToggleDate = vi.fn();
    const { container } = render(
      <ComparisonDatesSidebar
        open
        onToggleOpen={vi.fn()}
        sortedDates={[selectedDate, sameDayStudy]}
        enabledDates={new Set([selectedDate])}
        datesWithDataForSequence={new Set([selectedDate, sameDayStudy])}
        onSelectAllDates={vi.fn()}
        onSelectNoDates={vi.fn()}
        onToggleDate={onToggleDate}
      />,
    );

    const studyRows = Array.from(container.querySelectorAll<HTMLButtonElement>('[data-study-state]'));
    expect(studyRows).toHaveLength(2);
    expect(studyRows[0]).toHaveAttribute('aria-pressed', 'true');
    expect(studyRows[0]).toHaveAttribute('data-study-state', 'selected');
    expect(studyRows[0]?.className).not.toContain('bg-[var(--accent)]');

    fireEvent.click(studyRows[1]!);
    expect(onToggleDate).toHaveBeenCalledWith(sameDayStudy);
    expect(screen.getByRole('complementary', { name: 'Examination dates' }).className).toContain('w-48');
  });

  it('prevents unavailable examinations from being selected while allowing previously selected ones to be removed', () => {
    const onToggleDate = vi.fn();
    const props = {
      open: true,
      onToggleOpen: vi.fn(),
      sortedDates: [selectedDate, compareDate],
      enabledDates: new Set([selectedDate]),
      datesWithDataForSequence: new Set([selectedDate]),
      onSelectAllDates: vi.fn(),
      onSelectNoDates: vi.fn(),
      onToggleDate,
    };

    const { container, rerender } = render(<ComparisonDatesSidebar {...props} />);
    const unavailableRow = container.querySelectorAll<HTMLButtonElement>('[data-study-state]')[1]!;

    expect(unavailableRow).toBeDisabled();
    fireEvent.click(unavailableRow);
    expect(onToggleDate).not.toHaveBeenCalled();

    rerender(<ComparisonDatesSidebar {...props} enabledDates={new Set([selectedDate, compareDate])} />);
    const selectedUnavailableRow = container.querySelectorAll<HTMLButtonElement>('[data-study-state]')[1]!;

    expect(selectedUnavailableRow).not.toBeDisabled();
    fireEvent.click(selectedUnavailableRow);
    expect(onToggleDate).toHaveBeenCalledWith(compareDate);
  });

  it('retains accessible filters and interpolation disclosure without animated width changes', () => {
    const { container } = render(
      <ComparisonFiltersSidebar
        open
        onToggleOpen={vi.fn()}
        availablePlanes={['Axial']}
        selectedPlane="Axial"
        onSelectPlane={vi.fn()}
        sequencesForPlane={[
          { id: 'unknown', plane: 'Axial', weight: null, sequence: null, label: 'Unknown', date_count: 1 },
        ]}
        sequencesWithDataForDates={new Set(['unknown'])}
        selectedSeqId="unknown"
        onSelectSequence={vi.fn()}
        alignmentOutputMode="fixed-512"
        onAlignmentOutputModeChange={vi.fn()}
      />,
    );

    const filters = screen.getByRole('complementary', { name: 'Scan filters' });
    expect(filters.className).toContain('w-52');
    expect(filters.className).not.toContain('transition-all');
    expect(screen.getByRole('button', { name: 'Unclassified' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByText('Interpolated display pixels do not add acquired MRI detail.')).toBeInTheDocument();
    expect(container.innerHTML).not.toContain('backdrop-blur');
  });

  it('shows a registration datum only for an existing validated derived frame and never over anatomy', () => {
    const { container } = render(
      <GridCell {...gridCellProps()} overlayColumns={[{ date: selectedDate, ref: selectedSeries }]} />,
    );

    const cell = container.querySelector('[data-grid-cell-date]');
    expect(cell).toHaveAttribute('data-alignment-state', 'acquired');
    expect(container.querySelector('[data-registration-datum="verified"]')).toBeNull();
    expect(screen.getByTitle('Acquired image')).toHaveTextContent('Acquired');

    act(() => setDerivedAlignmentFrame({ ...alignedResult(selectedSeries, selectedDate), outcome: 'ambiguous' }));
    expect(container.querySelector('[data-registration-datum="verified"]')).toBeNull();

    act(() => setDerivedAlignmentFrame(alignedResult(selectedSeries, selectedDate)));
    const datum = screen.getByLabelText('Verified aligned presentation');
    expect(cell).toHaveAttribute('data-alignment-state', 'aligned');
    expect(screen.getByTitle('Aligned presentation')).toHaveTextContent('Aligned');
    expect(container.querySelector('[data-diagnostic-surface="true"]')?.contains(datum)).toBe(false);
    expect(container.innerHTML).not.toContain('backdrop-blur');

    act(() => clearDerivedAlignmentFrames());
    expect(container.querySelector('[data-registration-datum="verified"]')).toBeNull();
  });

  it('keeps grid geometry and slice controls interactive when a validated alignment arrives', () => {
    const props = gridCellProps();
    const { container } = render(<GridCell {...props} />);
    fireEvent.click(screen.getByRole('button', { name: 'Adjust image' }));
    const zoom = container.querySelector<HTMLButtonElement>('[aria-label="Increase Zoom"]');
    const slice = container.querySelector<HTMLButtonElement>('[aria-label="Increase Slice offset"]');
    expect(zoom).not.toBeNull();
    expect(slice).not.toBeNull();
    act(() => setDerivedAlignmentFrame(alignedResult(selectedSeries, selectedDate)));

    expect(screen.getByRole('button', { name: 'Increase Zoom' })).toBe(zoom);
    expect(screen.getByRole('button', { name: 'Increase Slice offset' })).toBe(slice);
    expect(zoom?.closest('[inert]')).toBeNull();
    expect(slice?.closest('[inert]')).toBeNull();
    fireEvent.mouseDown(zoom!);
    fireEvent.mouseUp(zoom!);
    expect(props.updatePanelSetting).toHaveBeenCalledWith(selectedDate, { zoom: 1.01 });
  });

  it('uses displayed derived-plane dimensions and prevents native segmentation on resliced grid images', () => {
    const result = alignedResult(selectedSeries, selectedDate);
    result.derivedFrame = {
      ...result.derivedFrame!,
      rows: 96,
      columns: 384,
      pixels: new Float32Array(96 * 384),
    };
    act(() => setDerivedAlignmentFrame(result));
    render(<GridCell {...gridCellProps()} />);
    const overlay = screen.getByTestId('diagnostic-drag-overlay');

    expect(overlay).toHaveAttribute('data-image-width', '384');
    expect(overlay).toHaveAttribute('data-image-height', '96');
    expect(overlay).toHaveAttribute('data-segment-disabled', 'true');
    expect(overlay).toHaveAttribute('data-actions', 'segment-tumor');
  });

  it('reserves grid selections for segmentation, without separate alignment actions', () => {
    render(<GridCell {...gridCellProps()} />);
    const overlay = screen.getByTestId('diagnostic-drag-overlay');
    expect(overlay).toHaveAttribute('data-actions', 'segment-tumor');
    expect(overlay).toHaveAttribute('data-segment-disabled', 'false');
  });

  it('keeps both overlay image layers mounted while switching the active examination', () => {
    const props = overlayProps();

    const { container, rerender } = render(<OverlayView {...props} />);
    fireEvent.click(screen.getByRole('button', { name: 'Adjust image' }));
    const overlayCell = container.querySelector<HTMLElement>('.study-cell');
    expect(overlayCell?.style.width).toBe('420px');
    expect(overlayCell?.style.height).toBe(`${420 + GRID_CELL_METADATA_HEIGHT}px`);
    expect(screen.getByTestId(`diagnostic-image-${selectedSeries.series_uid}`)).toBeInTheDocument();
    expect(screen.getByTestId(`diagnostic-image-${compareSeries.series_uid}`)).toBeInTheDocument();

    fireEvent.wheel(screen.getByTestId(`diagnostic-image-${selectedSeries.series_uid}`), {
      deltaY: -100,
      metaKey: true,
    });
    expect(props.updatePanelSetting).toHaveBeenCalledWith(selectedDate, { zoom: 1.5 });
    props.updatePanelSetting.mockClear();

    rerender(
      <OverlayView
        {...props}
        isOverlayComparing
        overlayDisplayedRef={compareSeries}
        overlayDisplayedDate={compareDate}
      />,
    );

    expect(screen.getByTestId(`diagnostic-image-${selectedSeries.series_uid}`)).toBeInTheDocument();
    expect(screen.getByTestId(`diagnostic-image-${compareSeries.series_uid}`)).toBeInTheDocument();
    expect(screen.getByText('Comparing examination')).toBeInTheDocument();

    fireEvent.wheel(screen.getByTestId(`diagnostic-image-${compareSeries.series_uid}`), {
      deltaY: -100,
      metaKey: true,
    });
    fireEvent.wheel(screen.getByTestId(`diagnostic-image-${compareSeries.series_uid}`), { deltaY: 100 });

    expect(props.updatePanelSetting).not.toHaveBeenCalled();
    expect(props.setProgress).not.toHaveBeenCalled();
    expect(container.innerHTML).not.toContain('backdrop-blur');

    expect(container.querySelector('[aria-label="Increase Zoom"]')?.closest('[inert]')).not.toBeNull();
    expect(container.querySelector('[aria-label="Increase Slice offset"]')?.closest('[inert]')).not.toBeNull();
    expect(screen.getByRole('button', { name: 'Adjust image' })).toBeDisabled();

    rerender(<OverlayView {...props} />);
    expect(container.querySelector('[aria-label="Increase Zoom"]')?.closest('[inert]')).toBeNull();
    expect(container.querySelector('[aria-label="Increase Slice offset"]')?.closest('[inert]')).toBeNull();
    expect(screen.getByRole('button', { name: 'Adjust image' })).toBeEnabled();
  });

  it('uses displayed derived-plane dimensions and prevents native segmentation on resliced overlay images', () => {
    const result = alignedResult(selectedSeries, selectedDate);
    result.derivedFrame = {
      ...result.derivedFrame!,
      rows: 96,
      columns: 384,
      pixels: new Float32Array(96 * 384),
    };
    act(() => setDerivedAlignmentFrame(result));
    render(<OverlayView {...overlayProps()} />);
    const overlay = screen.getByTestId('diagnostic-drag-overlay');

    expect(overlay).toHaveAttribute('data-image-width', '384');
    expect(overlay).toHaveAttribute('data-image-height', '96');
    expect(overlay).toHaveAttribute('data-segment-disabled', 'true');
    expect(overlay).toHaveAttribute('data-actions', 'segment-tumor');
  });

  it('reserves overlay selections for segmentation, without separate alignment actions', () => {
    render(<OverlayView {...overlayProps()} />);
    const overlay = screen.getByTestId('diagnostic-drag-overlay');
    expect(overlay).toHaveAttribute('data-actions', 'segment-tumor');
    expect(overlay).toHaveAttribute('data-segment-disabled', 'false');
  });

  it('reports only the actual selected slice and exposes its precise accessible value', () => {
    const { container, rerender } = render(
      <SliceLoopNavigator
        selectedSeqId="synthetic-position"
        playbackInstanceCount={11}
        progress={0.5}
        progressRef={{ current: 0.5 }}
        setProgress={vi.fn()}
      />,
    );

    expect(screen.getByRole('spinbutton', { name: 'Go to slice' })).toHaveValue(6);
    expect(screen.getByRole('slider', { name: 'Slice position' })).toHaveAttribute('aria-valuetext', 'Slice 6 of 11');
    expect(container.querySelector('[data-registration-datum="slice-position"]')).toBeInTheDocument();

    rerender(
      <SliceLoopNavigator
        selectedSeqId={null}
        playbackInstanceCount={0}
        progress={0}
        progressRef={{ current: 0 }}
        setProgress={vi.fn()}
      />,
    );

    expect(screen.getByText('No slices')).toBeInTheDocument();
    expect(screen.getByRole('slider', { name: 'Slice position' })).toHaveAttribute(
      'aria-valuetext',
      'No slices available',
    );
    expect(screen.getByRole('slider', { name: 'Slice position' })).toBeDisabled();
    expect(container.querySelector('[data-registration-datum="slice-position"]')).toBeNull();
  });
});
