import type { ReactNode } from 'react';
import { act, fireEvent, render, renderHook, screen } from '@testing-library/react';
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
      data-tumor-alignment-title={actions?.find((action) => action.key === 'align-tumor')?.title}
      data-tumor-alignment-disabled={String(actions?.find((action) => action.key === 'align-tumor')?.disabled ?? false)}
      onDoubleClick={() =>
        actions
          ?.find((action) => action.key === 'align-all')
          ?.onConfirm({
            base: { x: 0.2, y: 0.3, width: 0.4, height: 0.2 },
            screen: { x: 0.2, y: 0.3, width: 0.4, height: 0.2 },
          })
      }
      onContextMenu={(event) => {
        event.preventDefault();
        const action = actions?.find((candidate) => candidate.key === 'align-tumor');
        if (!action || action.disabled) return;
        action.onConfirm({
          base: { x: 0.2, y: 0.3, width: 0.4, height: 0.2 },
          screen: { x: 0.2, y: 0.3, width: 0.4, height: 0.2 },
        });
      }}
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
      <GridView
        comboId="synthetic-sequence"
        columns={[{ date: selectedDate, ref: selectedSeries }]}
        gridCols={1}
        gridCellSize={cellSize}
        panelSettings={new Map()}
        progress={0}
        setProgress={vi.fn()}
        updatePanelSetting={vi.fn()}
        overlayColumns={[{ date: selectedDate, ref: selectedSeries }]}
        isAligning={false}
        alignmentProgress={null}
        abortAlignment={vi.fn()}
        startAlignAll={vi.fn(async () => undefined)}
      />,
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
      <GridView
        comboId="synthetic-sequence"
        columns={examinations}
        gridCols={result.current.cols}
        gridCellSize={result.current.cellSize}
        panelSettings={new Map()}
        progress={0}
        setProgress={vi.fn()}
        updatePanelSetting={vi.fn()}
        overlayColumns={examinations}
        isAligning={false}
        alignmentProgress={null}
        abortAlignment={vi.fn()}
        startAlignAll={vi.fn(async () => undefined)}
      />,
    );

    const scrollSurface = container.firstElementChild as HTMLElement;
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
      <GridCell
        comboId="synthetic-sequence"
        date={selectedDate}
        refData={selectedSeries}
        settings={DEFAULT_PANEL_SETTINGS}
        progress={0}
        setProgress={vi.fn()}
        updatePanelSetting={vi.fn()}
        isHovered
        overlayColumns={[{ date: selectedDate, ref: selectedSeries }]}
        isAligning={false}
        startAlignAll={vi.fn(async () => undefined)}
      />,
    );

    const cell = container.querySelector('[data-grid-cell-date]');
    expect(cell).toHaveAttribute('data-alignment-state', 'acquired');
    expect(container.querySelector('[data-registration-datum="verified"]')).toBeNull();
    expect(screen.getByText('Acquired image')).toBeInTheDocument();

    act(() => setDerivedAlignmentFrame({ ...alignedResult(selectedSeries, selectedDate), outcome: 'ambiguous' }));
    expect(container.querySelector('[data-registration-datum="verified"]')).toBeNull();

    act(() => setDerivedAlignmentFrame(alignedResult(selectedSeries, selectedDate)));
    const datum = screen.getByLabelText('Verified aligned presentation');
    expect(cell).toHaveAttribute('data-alignment-state', 'aligned');
    expect(screen.getByText('Aligned presentation')).toBeInTheDocument();
    expect(container.querySelector('[data-diagnostic-surface="true"]')?.contains(datum)).toBe(false);
    expect(container.innerHTML).not.toContain('backdrop-blur');

    act(() => clearDerivedAlignmentFrames());
    expect(container.querySelector('[data-registration-datum="verified"]')).toBeNull();
  });

  it('makes grid examination geometry and slice controls inert while alignment owns their presentation', () => {
    const props = {
      comboId: 'synthetic-sequence',
      date: selectedDate,
      refData: selectedSeries,
      settings: DEFAULT_PANEL_SETTINGS,
      progress: 0,
      setProgress: vi.fn(),
      updatePanelSetting: vi.fn(),
      isHovered: true,
      overlayColumns: [
        { date: selectedDate, ref: selectedSeries },
        { date: compareDate, ref: compareSeries },
      ],
      isAligning: true,
      startAlignAll: vi.fn(async () => undefined),
    };
    const { container, rerender } = render(<GridCell {...props} />);
    const zoom = container.querySelector<HTMLButtonElement>('[aria-label="Increase Zoom"]');
    const slice = container.querySelector<HTMLButtonElement>('[aria-label="Increase Slice offset"]');

    expect(zoom?.closest('[inert]')).not.toBeNull();
    expect(slice?.closest('[inert]')).not.toBeNull();

    rerender(<GridCell {...props} isAligning={false} />);

    expect(zoom?.closest('[inert]')).toBeNull();
    expect(slice?.closest('[inert]')).toBeNull();
    fireEvent.mouseDown(zoom!);
    fireEvent.mouseUp(zoom!);
    expect(props.updatePanelSetting).toHaveBeenCalledWith(selectedDate, { zoom: 1.01 });
  });

  it('uses displayed derived-plane dimensions for grid exclusion geometry and reference metadata', () => {
    const startAlignAll = vi.fn(async () => undefined);
    const result = alignedResult(selectedSeries, selectedDate);
    result.derivedFrame = {
      ...result.derivedFrame!,
      rows: 96,
      columns: 384,
      pixels: new Float32Array(96 * 384),
    };
    act(() => setDerivedAlignmentFrame(result));
    render(
      <GridCell
        comboId="synthetic-sequence"
        date={selectedDate}
        refData={selectedSeries}
        settings={DEFAULT_PANEL_SETTINGS}
        progress={0}
        setProgress={vi.fn()}
        updatePanelSetting={vi.fn()}
        isHovered
        overlayColumns={[
          { date: selectedDate, ref: selectedSeries },
          { date: compareDate, ref: compareSeries },
        ]}
        isAligning={false}
        startAlignAll={startAlignAll}
      />,
    );
    const overlay = screen.getByTestId('diagnostic-drag-overlay');

    expect(overlay).toHaveAttribute('data-image-width', '384');
    expect(overlay).toHaveAttribute('data-image-height', '96');
    expect(overlay).toHaveAttribute('data-tumor-alignment-disabled', 'true');
    fireEvent.doubleClick(overlay);
    expect(startAlignAll).toHaveBeenCalledWith(
      expect.objectContaining({ imageSize: { width: 384, height: 96 } }),
      expect.objectContaining({ x: 0.2, y: 0.3 }),
    );
  });

  it('offers explicitly disclosed opt-in tumor alignment without changing ordinary grid alignment', () => {
    const startAlignAll = vi.fn(async () => undefined);
    render(
      <GridCell
        comboId="synthetic-sequence"
        date={selectedDate}
        refData={selectedSeries}
        settings={DEFAULT_PANEL_SETTINGS}
        progress={0}
        setProgress={vi.fn()}
        updatePanelSetting={vi.fn()}
        isHovered
        overlayColumns={[
          { date: selectedDate, ref: selectedSeries },
          { date: compareDate, ref: compareSeries },
        ]}
        isAligning={false}
        startAlignAll={startAlignAll}
      />,
    );
    const overlay = screen.getByTestId('diagnostic-drag-overlay');

    expect(overlay).toHaveAttribute(
      'data-tumor-alignment-title',
      'Match tumor across dates; uses pixels inside the selected region',
    );
    expect(overlay).toHaveAttribute('data-tumor-alignment-disabled', 'false');
    fireEvent.contextMenu(overlay);
    expect(startAlignAll).toHaveBeenCalledWith(
      expect.objectContaining({ alignmentFocus: 'tumor', imageSize: { width: 256, height: 128 } }),
      expect.objectContaining({ x: 0.2, y: 0.3 }),
    );

    startAlignAll.mockClear();
    fireEvent.doubleClick(overlay);
    expect(startAlignAll).toHaveBeenCalledWith(
      expect.not.objectContaining({ alignmentFocus: 'tumor' }),
      expect.objectContaining({ x: 0.2, y: 0.3 }),
    );
  });

  it('keeps both overlay image layers mounted while switching the active examination', () => {
    const props = {
      comboId: 'synthetic-sequence',
      overlayColumns: [
        { date: selectedDate, ref: selectedSeries },
        { date: compareDate, ref: compareSeries },
      ],
      overlayViewerSize: 420,
      overlayDisplayedRef: selectedSeries,
      overlayDisplayedDate: selectedDate,
      overlayDisplayedSettings: DEFAULT_PANEL_SETTINGS,
      overlayDisplayedSliceIndex: 0,
      overlayDisplayedEffectiveSliceIndex: 0,
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
      isAligning: false,
      alignmentProgress: null,
      abortAlignment: vi.fn(),
      updatePanelSetting: vi.fn(),
      startAlignAll: vi.fn(async () => undefined),
      setProgress: vi.fn(),
    };

    const { container, rerender } = render(<OverlayView {...props} />);
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

    rerender(
      <OverlayView
        {...props}
        isAligning
        alignmentProgress={{
          phase: 'capturing',
          currentDate: null,
          dateIndex: 0,
          totalDates: 1,
          slicesChecked: 0,
          bestMiSoFar: 0,
        }}
      />,
    );

    expect(container.querySelector('[aria-label="Increase Zoom"]')?.closest('[inert]')).not.toBeNull();
    expect(container.querySelector('[aria-label="Increase Slice offset"]')?.closest('[inert]')).not.toBeNull();
    const cancel = screen.getByRole('button', { name: 'Cancel' });
    expect(cancel.closest('[inert]')).toBeNull();
    fireEvent.click(cancel);
    expect(props.abortAlignment).toHaveBeenCalledOnce();
  });

  it('uses displayed derived-plane dimensions for overlay exclusion geometry and reference metadata', () => {
    const startAlignAll = vi.fn(async () => undefined);
    const result = alignedResult(selectedSeries, selectedDate);
    result.derivedFrame = {
      ...result.derivedFrame!,
      rows: 96,
      columns: 384,
      pixels: new Float32Array(96 * 384),
    };
    act(() => setDerivedAlignmentFrame(result));
    render(
      <OverlayView
        comboId="synthetic-sequence"
        overlayColumns={[
          { date: selectedDate, ref: selectedSeries },
          { date: compareDate, ref: compareSeries },
        ]}
        overlayViewerSize={420}
        overlayDisplayedRef={selectedSeries}
        overlayDisplayedDate={selectedDate}
        overlayDisplayedSettings={DEFAULT_PANEL_SETTINGS}
        overlayDisplayedSliceIndex={0}
        overlayDisplayedEffectiveSliceIndex={0}
        overlaySelectedRef={selectedSeries}
        overlaySelectedDate={selectedDate}
        overlaySelectedSettings={DEFAULT_PANEL_SETTINGS}
        overlaySelectedSliceIndex={0}
        overlayCompareRef={compareSeries}
        overlayCompareDate={compareDate}
        overlayCompareSettings={DEFAULT_PANEL_SETTINGS}
        overlayCompareSliceIndex={0}
        isOverlayComparing={false}
        hasOverlayCompareTarget
        isAligning={false}
        alignmentProgress={null}
        abortAlignment={vi.fn()}
        updatePanelSetting={vi.fn()}
        startAlignAll={startAlignAll}
        setProgress={vi.fn()}
      />,
    );
    const overlay = screen.getByTestId('diagnostic-drag-overlay');

    expect(overlay).toHaveAttribute('data-image-width', '384');
    expect(overlay).toHaveAttribute('data-image-height', '96');
    expect(overlay).toHaveAttribute('data-tumor-alignment-disabled', 'true');
    fireEvent.doubleClick(overlay);
    expect(startAlignAll).toHaveBeenCalledWith(
      expect.objectContaining({ imageSize: { width: 384, height: 96 } }),
      expect.objectContaining({ x: 0.2, y: 0.3 }),
    );
  });

  it('offers explicitly disclosed opt-in tumor alignment from an acquired overlay reference', () => {
    const startAlignAll = vi.fn(async () => undefined);
    render(
      <OverlayView
        comboId="synthetic-sequence"
        overlayColumns={[
          { date: selectedDate, ref: selectedSeries },
          { date: compareDate, ref: compareSeries },
        ]}
        overlayViewerSize={420}
        overlayDisplayedRef={selectedSeries}
        overlayDisplayedDate={selectedDate}
        overlayDisplayedSettings={DEFAULT_PANEL_SETTINGS}
        overlayDisplayedSliceIndex={0}
        overlayDisplayedEffectiveSliceIndex={0}
        overlaySelectedRef={selectedSeries}
        overlaySelectedDate={selectedDate}
        overlaySelectedSettings={DEFAULT_PANEL_SETTINGS}
        overlaySelectedSliceIndex={0}
        overlayCompareRef={compareSeries}
        overlayCompareDate={compareDate}
        overlayCompareSettings={DEFAULT_PANEL_SETTINGS}
        overlayCompareSliceIndex={0}
        isOverlayComparing={false}
        hasOverlayCompareTarget
        isAligning={false}
        alignmentProgress={null}
        abortAlignment={vi.fn()}
        updatePanelSetting={vi.fn()}
        startAlignAll={startAlignAll}
        setProgress={vi.fn()}
      />,
    );
    const overlay = screen.getByTestId('diagnostic-drag-overlay');

    expect(overlay).toHaveAttribute(
      'data-tumor-alignment-title',
      'Match tumor across dates; uses pixels inside the selected region',
    );
    fireEvent.contextMenu(overlay);
    expect(startAlignAll).toHaveBeenCalledWith(
      expect.objectContaining({ alignmentFocus: 'tumor' }),
      expect.objectContaining({ x: 0.2, y: 0.3 }),
    );
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

    expect(screen.getByText('Slice 6 / 11')).toBeInTheDocument();
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
