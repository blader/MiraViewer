import type { ReactNode } from 'react';
import { act, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { GridCell } from '../src/components/comparison/GridCell';
import { OverlayView, type OverlayViewProps } from '../src/components/comparison/OverlayView';
import { StudyToolsWorkspace } from '../src/components/comparison/StudyTools';
import { AlignedBrowsingContext } from '../src/hooks/useAlignedFrame';
import type { AlignmentAdjustment, AlignmentResult, PanelSettings, SeriesRef } from '../src/types/api';
import { CONTROL_LIMITS, DEFAULT_PANEL_SETTINGS } from '../src/utils/constants';
import { clearDerivedAlignmentFrames, setDerivedAlignmentFrame } from '../src/utils/derivedAlignmentFrame';
import { getProgressFromSlice } from '../src/utils/math';
import { buildOutputPlaneGrid } from '../src/utils/outputPlaneGrid';
import { DEFAULT_ALIGNMENT_ADJUSTMENT } from '../src/utils/alignmentAdjustment';

vi.mock('../src/components/DicomViewer', () => ({
  DicomViewer: ({ children }: { children?: ReactNode }) => <div data-testid="displayed-dicom-frame">{children}</div>,
}));

const date = '2026-01-08T09:10:00.000Z';
const series: SeriesRef = {
  study_id: 'target-study',
  series_uid: 'target-series',
  instance_count: 20,
  rows: 2,
  columns: 2,
};
const settings = { ...DEFAULT_PANEL_SETTINGS, offset: 3 };
const alignmentAdjustment: AlignmentAdjustment = {
  sliceOffset: 0,
  panX: 0.04,
  panY: -0.02,
  zoom: 1.05,
  rotation: 3,
  brightness: 10,
  contrast: -5,
};
const reference = {
  seriesUid: 'reference-series',
  sliceIndex: 5,
  patientKey: 'test-patient',
  sequenceId: 'test-sequence',
  datasetRevision: 1,
};

function acceptedPlane(referenceIndex: number, targetIndex: number): AlignmentResult {
  const outputGrid = buildOutputPlaneGrid({
    sopInstanceUid: `reference-${referenceIndex}`,
    rows: 2,
    columns: 2,
    imagePositionPatient: `0\\0\\${referenceIndex}`,
    imageOrientationPatient: '1\\0\\0\\0\\1\\0',
    pixelSpacing: '1\\1',
  });
  return {
    date,
    seriesUid: series.series_uid,
    bestSliceIndex: targetIndex,
    nmiScore: 1,
    computedSettings: settings,
    slicesChecked: 1,
    runId: `run-${referenceIndex}`,
    registrationId: 'accepted-registration',
    patientKey: reference.patientKey,
    sequenceId: reference.sequenceId,
    datasetRevision: reference.datasetRevision,
    referenceSeriesUid: reference.seriesUid,
    outcome: 'aligned',
    outputGrid,
    derivedFrame: {
      pixels: new Float32Array([1, 2, 3, 4]),
      rows: 2,
      columns: 2,
      sourceImageId: `miradb:target-${targetIndex}`,
      referenceSeriesUid: reference.seriesUid,
      referenceFrameIndex: referenceIndex,
      referenceSopInstanceUid: `reference-${referenceIndex}`,
      outputGrid,
    },
  };
}

function Workspace({ children }: { children: ReactNode }) {
  return (
    <AlignedBrowsingContext.Provider value={{ reference, targetSeriesUids: new Set([series.series_uid]) }}>
      <StudyToolsWorkspace>{children}</StudyToolsWorkspace>
    </AlignedBrowsingContext.Provider>
  );
}

function overlayProps(overrides: Partial<OverlayViewProps> = {}): OverlayViewProps {
  return {
    comboId: reference.sequenceId,
    overlayColumns: [{ date, ref: series }],
    overlayViewerSize: 400,
    overlayDisplayedRef: series,
    overlayDisplayedDate: date,
    overlayDisplayedSettings: settings,
    overlayDisplayedSliceIndex: 11,
    overlaySelectedRef: series,
    overlaySelectedDate: date,
    overlaySelectedSettings: settings,
    overlaySelectedSliceIndex: 11,
    overlayCompareRef: undefined,
    overlayCompareDate: undefined,
    overlayCompareSettings: DEFAULT_PANEL_SETTINGS,
    overlayCompareSliceIndex: 0,
    isOverlayComparing: false,
    hasOverlayCompareTarget: false,
    onUseAcquired: vi.fn(),
    updatePanelSetting: vi.fn(),
    setProgress: vi.fn(),
    ...overrides,
  };
}

function renderPanel(
  mode: 'Grid' | 'Overlay',
  panelSettings: PanelSettings,
  updatePanelSetting: OverlayViewProps['updatePanelSetting'],
) {
  return render(
    mode === 'Grid' ? (
      <GridCell
        comboId={reference.sequenceId}
        date={date}
        refData={series}
        settings={panelSettings}
        progress={0.5}
        setProgress={vi.fn()}
        updatePanelSetting={updatePanelSetting}
      />
    ) : (
      <OverlayView
        {...overlayProps({
          overlayDisplayedSettings: panelSettings,
          overlaySelectedSettings: panelSettings,
          updatePanelSetting,
        })}
      />
    ),
    { wrapper: Workspace },
  );
}

afterEach(() => act(() => clearDerivedAlignmentFrames()));

describe('controls for a held aligned plane', () => {
  it.each(['Grid', 'Overlay'] as const)(
    '%s disables image edits until the requested plane arrives, but keeps acquired escape usable',
    async (mode) => {
      const user = userEvent.setup();
      const updatePanelSetting = vi.fn();
      const onUseAcquired = vi.fn();
      setDerivedAlignmentFrame(acceptedPlane(3, 7));
      const { container } = render(
        mode === 'Grid' ? (
          <GridCell
            comboId={reference.sequenceId}
            date={date}
            refData={series}
            settings={settings}
            progress={getProgressFromSlice(11, series.instance_count, settings.offset)}
            setProgress={vi.fn()}
            updatePanelSetting={updatePanelSetting}
            onUseAcquired={onUseAcquired}
          />
        ) : (
          <OverlayView {...overlayProps({ updatePanelSetting, onUseAcquired })} />
        ),
        { wrapper: Workspace },
      );

      expect(container.querySelector('[data-alignment-pending="true"]')).not.toBeNull();
      expect(screen.getByText('8/20')).toBeInTheDocument();
      await user.click(screen.getByRole('button', { name: 'Adjust image' }));
      const fieldset = container.querySelector('fieldset');
      expect(fieldset).not.toBeNull();
      for (const button of within(fieldset!).getAllByRole('button')) expect(button).toBeDisabled();
      await user.click(screen.getByRole('button', { name: 'Increase Brightness' }));
      await user.click(screen.getByRole('button', { name: 'Reset brightness & contrast' }));
      expect(updatePanelSetting).not.toHaveBeenCalled();

      expect(screen.getByRole('button', { name: 'Close image adjustments' })).toBeEnabled();
      const acquired = screen.getByRole('button', { name: 'View acquired image' });
      expect(acquired).toBeEnabled();
      await user.click(acquired);
      expect(onUseAcquired).toHaveBeenCalledExactlyOnceWith(date);

      act(() => setDerivedAlignmentFrame(acceptedPlane(5, 9)));
      expect(container.querySelector('[data-alignment-pending="true"]')).toBeNull();
      expect(screen.getByText('10/20')).toBeInTheDocument();
      for (const button of within(fieldset!).getAllByRole('button')) expect(button).toBeEnabled();
      await user.click(screen.getByRole('button', { name: 'Increase Brightness' }));
      expect(updatePanelSetting).toHaveBeenCalledExactlyOnceWith(date, {
        brightness: settings.brightness + CONTROL_LIMITS.BRIGHTNESS.STEP,
      });
    },
  );

  it.each([
    { comparing: false, reversed: false, label: '8/20' },
    { comparing: false, reversed: true, label: '13/20' },
    { comparing: true, reversed: false, label: '8/20' },
    { comparing: true, reversed: true, label: '13/20' },
  ])(
    'Overlay reports the actual held source index (compare=$comparing, reverse=$reversed)',
    async ({ comparing, reversed, label }) => {
      const user = userEvent.setup();
      const updatePanelSetting = vi.fn();
      const displayedSettings = { ...settings, reverseSliceOrder: reversed };
      const otherSeries = { ...series, series_uid: 'other-series' };
      setDerivedAlignmentFrame(acceptedPlane(3, 7));
      render(
        <OverlayView
          {...overlayProps({
            overlayDisplayedSettings: displayedSettings,
            overlaySelectedRef: comparing ? otherSeries : series,
            overlaySelectedSettings: comparing ? DEFAULT_PANEL_SETTINGS : displayedSettings,
            overlayCompareRef: comparing ? series : undefined,
            overlayCompareDate: comparing ? date : undefined,
            overlayCompareSettings: displayedSettings,
            overlayCompareSliceIndex: 11,
            isOverlayComparing: comparing,
            hasOverlayCompareTarget: comparing,
            updatePanelSetting,
          })}
        />,
        { wrapper: Workspace },
      );

      expect(screen.getByText(label)).toBeInTheDocument();
      expect(screen.queryByText('12/20')).not.toBeInTheDocument();
      if (!comparing) {
        await user.click(screen.getByRole('button', { name: 'Increase Slice offset' }));
        expect(updatePanelSetting).toHaveBeenCalledExactlyOnceWith(date, { offset: settings.offset + 1 });
      }
    },
  );

  it('keeps native slice numbering and controls when no accepted frame exists', async () => {
    const user = userEvent.setup();
    const { container } = render(<OverlayView {...overlayProps()} />, { wrapper: Workspace });
    expect(screen.getByText('12/20')).toBeInTheDocument();
    expect(container.querySelector('[data-alignment-pending="true"]')).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Adjust image' }));
    expect(screen.getByRole('button', { name: 'Increase Brightness' })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Outline' })).toBeEnabled();
    expect(screen.queryByRole('button', { name: 'View acquired image' })).not.toBeInTheDocument();
  });

  it.each(['Grid', 'Overlay'] as const)(
    '%s keeps an adjusted aligned panel linked and exposes a per-panel reset',
    async (mode) => {
      const user = userEvent.setup();
      const updatePanelSetting = vi.fn();
      const adjustedSettings = { ...settings, alignmentAdjustment };
      setDerivedAlignmentFrame(acceptedPlane(5, 9));
      const { container } = renderPanel(mode, adjustedSettings, updatePanelSetting);

      expect(container.querySelector('[data-alignment-state="aligned"]')).not.toBeNull();
      expect(container.querySelector('[data-alignment-adjusted="true"]')).not.toBeNull();
      expect(screen.getByLabelText('Aligned with manual adjustments')).toHaveTextContent('Adjusted');
      expect(screen.queryByLabelText('Verified aligned presentation')).not.toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'Resume alignment' })).not.toBeInTheDocument();

      await user.click(screen.getByRole('button', { name: 'Adjust image' }));
      expect(screen.getByRole('button', { name: 'Outline' })).toBeDisabled();
      expect(screen.getByRole('button', { name: 'Saved tumor' })).toBeDisabled();
      await user.click(screen.getByRole('button', { name: 'Reset adjustments' }));
      expect(updatePanelSetting).toHaveBeenCalledExactlyOnceWith(date, { alignmentAdjustment: undefined });
    },
  );

  it.each(['Grid', 'Overlay'] as const)(
    '%s resets an already matched, unadjusted panel to automatic tone',
    async (mode) => {
      const user = userEvent.setup();
      const updatePanelSetting = vi.fn();
      const matchedSettings = { ...settings, brightness: 137, contrast: 91 };
      setDerivedAlignmentFrame({ ...acceptedPlane(5, 9), computedSettings: matchedSettings });
      renderPanel(mode, matchedSettings, updatePanelSetting);

      await user.click(screen.getByRole('button', { name: 'Adjust image' }));
      await user.click(screen.getByRole('button', { name: 'Reset brightness & contrast' }));

      expect(updatePanelSetting).toHaveBeenCalledExactlyOnceWith(date, {
        alignmentAdjustment: DEFAULT_ALIGNMENT_ADJUSTMENT,
      });
      expect(screen.queryByRole('button', { name: 'Reset adjustments' })).not.toBeInTheDocument();
    },
  );

  it.each(['Grid', 'Overlay'] as const)(
    '%s exposes an explicit acquired-image pause and resumes without discarding saved corrections',
    async (mode) => {
      const user = userEvent.setup();
      const updatePanelSetting = vi.fn();
      const pausedSettings = { ...settings, alignmentPaused: true, alignmentAdjustment };
      const { container } = renderPanel(mode, pausedSettings, updatePanelSetting);

      expect(container.querySelector('[data-alignment-state="acquired"]')).not.toBeNull();
      expect(container.querySelector('[data-alignment-paused="true"]')).not.toBeNull();
      expect(screen.queryByLabelText('Aligned with manual adjustments')).not.toBeInTheDocument();
      expect(screen.queryByLabelText('Verified aligned presentation')).not.toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'View acquired image' })).not.toBeInTheDocument();
      await user.click(screen.getByRole('button', { name: 'Resume alignment' }));
      expect(updatePanelSetting).toHaveBeenCalledExactlyOnceWith(date, { alignmentPaused: false });

      await user.click(screen.getByRole('button', { name: 'Adjust image' }));
      expect(screen.getByRole('button', { name: 'Outline' })).toBeEnabled();
      expect(screen.getByRole('button', { name: 'Saved tumor' })).toBeEnabled();
      expect(screen.queryByRole('button', { name: 'Reset adjustments' })).not.toBeInTheDocument();
      updatePanelSetting.mockClear();
      await user.click(screen.getByRole('button', { name: 'Reset brightness & contrast' }));
      expect(updatePanelSetting).toHaveBeenCalledExactlyOnceWith(date, { brightness: 100, contrast: 100 });
      expect(alignmentAdjustment).toMatchObject({ brightness: 10, contrast: -5 });
    },
  );

  it('does not offer a resume action for the read-only held comparison date', () => {
    const pausedSettings = { ...settings, alignmentPaused: true, alignmentAdjustment };
    render(
      <OverlayView
        {...overlayProps({
          overlayDisplayedSettings: pausedSettings,
          overlayCompareSettings: pausedSettings,
          overlaySelectedRef: { ...series, series_uid: 'other-series' },
          overlayCompareRef: series,
          overlayCompareDate: date,
          hasOverlayCompareTarget: true,
          isOverlayComparing: true,
        })}
      />,
      { wrapper: Workspace },
    );

    expect(screen.getByText('Comparing examination')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Resume alignment' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Adjust image' })).toBeDisabled();
  });

  it('blocks resetting adjustments while a different aligned plane is pending', async () => {
    const user = userEvent.setup();
    const updatePanelSetting = vi.fn();
    setDerivedAlignmentFrame(acceptedPlane(3, 7));
    renderPanel('Grid', { ...settings, alignmentAdjustment }, updatePanelSetting);

    await user.click(screen.getByRole('button', { name: 'Adjust image' }));
    const reset = screen.getByRole('button', { name: 'Reset adjustments' });
    expect(reset).toBeDisabled();
    await user.click(reset);
    expect(updatePanelSetting).not.toHaveBeenCalled();
  });
});
