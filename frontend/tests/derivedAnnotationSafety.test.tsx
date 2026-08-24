import type { ReactNode } from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AlignmentResult, SeriesRef } from '../src/types/api';
import { DEFAULT_PANEL_SETTINGS } from '../src/utils/constants';
import { clearDerivedAlignmentFrames, setDerivedAlignmentFrame } from '../src/utils/derivedAlignmentFrame';

vi.mock('../src/components/DicomViewer', () => ({
  DicomViewer: () => <div data-testid="displayed-dicom-frame" />,
}));

vi.mock('../src/components/DragRectActionOverlay', () => ({
  DragRectActionOverlay: ({
    children,
    actions,
  }: {
    children: ReactNode;
    actions: Array<{ key: string; disabled?: boolean }>;
  }) => (
    <div>
      <button
        type="button"
        data-testid="segment-action"
        disabled={actions.find((action) => action.key === 'segment-tumor')?.disabled}
      >
        Segment action
      </button>
      {children}
    </div>
  ),
}));

vi.mock('../src/components/TumorSavedSegmentationOverlay', () => ({
  TumorSavedSegmentationOverlay: () => <div data-testid="native-saved-annotation" />,
}));

vi.mock('../src/components/TumorSegmentationOverlaySeedGrow', () => ({
  TumorSegmentationOverlay: () => <div data-testid="native-segmentation-tool" />,
}));

vi.mock('../src/components/GroundTruthPolygonOverlay', () => ({
  GroundTruthPolygonOverlay: () => <div data-testid="native-ground-truth" />,
}));

import { GridCell } from '../src/components/comparison/GridCell';
import { OverlayView } from '../src/components/comparison/OverlayView';

const series: SeriesRef = {
  study_id: 'synthetic-study',
  series_uid: 'synthetic-series',
  instance_count: 3,
  rows: 128,
  columns: 256,
};

function derivedResult(seriesUid = series.series_uid): AlignmentResult {
  return {
    date: '2025-01-01T00:00:00.000Z',
    seriesUid,
    bestSliceIndex: 0,
    nmiScore: 1,
    computedSettings: DEFAULT_PANEL_SETTINGS,
    slicesChecked: 1,
    runId: 'synthetic-alignment',
    outcome: 'aligned',
    derivedFrame: {
      pixels: new Float32Array([1, 2, 3, 4]),
      rows: 2,
      columns: 2,
      sourceImageId: 'miradb:synthetic-source',
    },
  };
}

afterEach(() => {
  act(() => clearDerivedAlignmentFrames());
});

describe('native annotation coordinate-space safety', () => {
  it('removes saved grid annotations and disables native tools when an oblique derived frame appears', async () => {
    render(
      <GridCell
        comboId="synthetic-combo"
        date="2025-01-01T00:00:00.000Z"
        refData={series}
        settings={DEFAULT_PANEL_SETTINGS}
        progress={0}
        setProgress={vi.fn()}
        updatePanelSetting={vi.fn()}
        isHovered
        overlayColumns={[{ date: '2025-01-01T00:00:00.000Z', ref: series }]}
        isAligning={false}
        startAlignAll={vi.fn(async () => undefined)}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Tumor' }));
    expect(await screen.findByTestId('native-saved-annotation')).toBeInTheDocument();

    act(() => setDerivedAlignmentFrame(derivedResult()));

    expect(screen.queryByTestId('native-saved-annotation')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Tumor' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'GT' })).toBeDisabled();
    expect(screen.getByTestId('segment-action')).toBeDisabled();

    act(() => clearDerivedAlignmentFrames());
    expect(await screen.findByTestId('native-saved-annotation')).toBeInTheDocument();
  });

  it('suppresses saved annotations in overlay mode when its selected frame becomes derived', async () => {
    render(
      <OverlayView
        comboId="synthetic-combo"
        overlayColumns={[{ date: '2025-01-01T00:00:00.000Z', ref: series }]}
        overlayViewerSize={400}
        overlayDisplayedRef={series}
        overlayDisplayedDate="2025-01-01T00:00:00.000Z"
        overlayDisplayedSettings={DEFAULT_PANEL_SETTINGS}
        overlayDisplayedSliceIndex={0}
        overlayDisplayedEffectiveSliceIndex={0}
        overlaySelectedRef={series}
        overlaySelectedDate="2025-01-01T00:00:00.000Z"
        overlaySelectedSettings={DEFAULT_PANEL_SETTINGS}
        overlaySelectedSliceIndex={0}
        overlayCompareRef={undefined}
        overlayCompareDate={undefined}
        overlayCompareSettings={DEFAULT_PANEL_SETTINGS}
        overlayCompareSliceIndex={0}
        isOverlayComparing={false}
        hasOverlayCompareTarget={false}
        isAligning={false}
        alignmentProgress={null}
        abortAlignment={vi.fn()}
        updatePanelSetting={vi.fn()}
        startAlignAll={vi.fn(async () => undefined)}
        setProgress={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Tumor' }));
    expect(await screen.findByTestId('native-saved-annotation')).toBeInTheDocument();

    act(() => setDerivedAlignmentFrame(derivedResult()));

    expect(screen.queryByTestId('native-saved-annotation')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Tumor' })).toBeDisabled();
    expect(screen.getByTestId('segment-action')).toBeDisabled();
  });
});
