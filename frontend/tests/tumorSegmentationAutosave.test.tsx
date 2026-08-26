import { useCallback, useState } from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DicomViewerHandle } from '../src/components/DicomViewer';
import { TumorSegmentationOverlay } from '../src/components/TumorSegmentationOverlaySeedGrow';
import { normalizeViewerTransform } from '../src/utils/viewTransform';

const mocks = vi.hoisted(() => ({
  lookup: vi.fn(),
  loadSegmentation: vi.fn(),
  loadGroundTruth: vi.fn(),
  save: vi.fn(),
  grow: vi.fn(),
}));

vi.mock('../src/utils/localApi', () => ({
  getSopInstanceUidForInstanceIndex: mocks.lookup,
  getTumorSegmentationForInstance: mocks.loadSegmentation,
  getTumorGroundTruthForInstance: mocks.loadGroundTruth,
  saveTumorSegmentation: mocks.save,
}));

vi.mock('../src/utils/segmentation/costDistanceGrow2d', () => ({
  computeCostDistanceMap: mocks.grow,
  distThresholdFromSlider: vi.fn(() => 1),
}));

vi.mock('../src/utils/segmentation/marchingSquares', () => ({
  marchingSquaresContour: vi.fn(() => [
    { x: 0, y: 0 },
    { x: 3, y: 0 },
    { x: 3, y: 3 },
    { x: 0, y: 3 },
  ]),
}));

const initialSeed = { x0: 0.25, y0: 0.25, x1: 0.75, y1: 0.75 };
const identityTransform = normalizeViewerTransform(null);

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function makeViewer(seriesUid = 'synthetic-series-a') {
  return {
    current: {
      getDecodedFrame: vi.fn(async () => ({
        pixels: Float32Array.from({ length: 16 }, (_value, index) => index),
        rows: 4,
        cols: 4,
        seriesUid,
        viewportSize: { w: 200, h: 200 },
        rowSpacingMm: 0.5,
        colSpacingMm: 0.5,
      })),
      waitForDisplayedContentKey: vi.fn(() => new Promise<void>(() => undefined)),
    } as unknown as DicomViewerHandle,
  };
}

type HarnessProps = {
  viewerRef: ReturnType<typeof makeViewer>;
  enabled?: boolean;
  comboId?: string;
  dateIso?: string;
  studyId?: string;
  seriesUid?: string;
  effectiveInstanceIndex?: number;
};

function SegmentationHarness({
  viewerRef,
  enabled = true,
  comboId = 'synthetic-sequence-a',
  dateIso = 'synthetic-examination-a',
  studyId = 'synthetic-study-a',
  seriesUid = 'synthetic-series-a',
  effectiveInstanceIndex = 0,
}: HarnessProps) {
  const [open, setOpen] = useState(true);
  const [seedBox, setSeedBox] = useState<typeof initialSeed | null>(initialSeed);
  const consumeSeed = useCallback(() => setSeedBox(null), []);

  if (!open) return null;
  return (
    <TumorSegmentationOverlay
      enabled={enabled}
      onRequestClose={() => setOpen(false)}
      seedBoxToStart={seedBox}
      onSeedBoxToStartConsumed={consumeSeed}
      viewerRef={viewerRef}
      comboId={comboId}
      dateIso={dateIso}
      studyId={studyId}
      seriesUid={seriesUid}
      effectiveInstanceIndex={effectiveInstanceIndex}
      viewerTransform={identityTransform}
    />
  );
}

async function waitForPendingDraft() {
  await waitFor(() => {
    expect(mocks.grow).toHaveBeenCalledTimes(1);
    expect(screen.getByLabelText('Segmented area')).toBeInTheDocument();
  });
  expect(mocks.save).not.toHaveBeenCalled();
}

async function expectSavedOriginalDraft() {
  await waitFor(() => expect(mocks.save).toHaveBeenCalledTimes(1));
  expect(mocks.save.mock.calls[0]?.[0]).toMatchObject({
    studyId: 'synthetic-study-a',
    seriesUid: 'synthetic-series-a',
    sopInstanceUid: 'synthetic-series-a-instance-0',
  });
}

describe('tumor segmentation autosave durability', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
      x: 0,
      y: 0,
      top: 0,
      left: 0,
      right: 200,
      bottom: 200,
      width: 200,
      height: 200,
      toJSON: () => ({}),
    });
    mocks.lookup.mockImplementation(async (seriesUid: string, index: number) => `${seriesUid}-instance-${index}`);
    mocks.loadSegmentation.mockResolvedValue(null);
    mocks.loadGroundTruth.mockResolvedValue(null);
    mocks.save.mockResolvedValue(undefined);
    mocks.grow.mockResolvedValue({
      w: 4,
      h: 4,
      seedPx: { x: 1, y: 1 },
      seedPxs: [{ x: 1, y: 1 }],
      seedBox: { x0: 0, y0: 0, x1: 3, y1: 3 },
      roi: { x0: 0, y0: 0, x1: 3, y1: 3 },
      dist: Float32Array.from({ length: 16 }, (_value, index) => index),
      quantileLut: new Float32Array(256),
      maxFiniteDist: 15,
      stats: { tumor: { mu: 120, sigma: 4 }, bg: { mu: 20, sigma: 2 }, edgeBarrier: 8 },
      weights: {
        edgeCostStrength: 1,
        crossCostStrength: 1,
        tumorCostStrength: 1,
        bgCostStrength: 1,
        bgRejectMarginZ: 1,
        allowDiagonal: true,
      },
      tuning: { surfaceTension: 1, baseStepScale: 15 },
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    localStorage.clear();
  });

  it('persists the pending immutable draft when its component unmounts before the debounce expires', async () => {
    const viewerRef = makeViewer();
    const mounted = render(<SegmentationHarness viewerRef={viewerRef} />);
    await waitForPendingDraft();

    mounted.unmount();

    await waitFor(() => expect(mocks.save).toHaveBeenCalledTimes(1));
    expect(mocks.save).toHaveBeenCalledWith(
      expect.objectContaining({
        comboId: 'synthetic-sequence-a',
        dateIso: 'synthetic-examination-a',
        studyId: 'synthetic-study-a',
        seriesUid: 'synthetic-series-a',
        sopInstanceUid: 'synthetic-series-a-instance-0',
        polygon: expect.objectContaining({ points: expect.any(Array) }),
      }),
    );
  });

  it('flushes a pending draft when the tumor tool is explicitly closed', async () => {
    render(<SegmentationHarness viewerRef={makeViewer()} />);
    await waitForPendingDraft();

    fireEvent.click(screen.getByRole('button', { name: 'Close tumor segmentation tool' }));

    await expectSavedOriginalDraft();
  });

  it('flushes the last acquired draft when the existing overlay is disabled', async () => {
    const viewerRef = makeViewer();
    const mounted = render(<SegmentationHarness viewerRef={viewerRef} />);
    await waitForPendingDraft();

    mounted.rerender(<SegmentationHarness viewerRef={viewerRef} enabled={false} />);

    await expectSavedOriginalDraft();
  });

  it('continues to debounce ordinary same-slice draft edits and saves only the newest polygon', async () => {
    render(<SegmentationHarness viewerRef={makeViewer()} />);
    await waitForPendingDraft();

    fireEvent.change(screen.getByRole('slider', { name: 'Area cap (px)' }), { target: { value: '8' } });
    await waitFor(() => expect(screen.getByLabelText('Segmented area')).toHaveTextContent('2.0 mm²'));

    expect(mocks.save).not.toHaveBeenCalled();
    await waitFor(() => expect(mocks.save).toHaveBeenCalledTimes(1));
    expect(mocks.save.mock.calls[0]?.[0]).toMatchObject({
      seriesUid: 'synthetic-series-a',
      sopInstanceUid: 'synthetic-series-a-instance-0',
      meta: { areaPx: 8, grow2d: { slider: { targetAreaPx: 8 } } },
    });
  });

  it('saves the original acquired slice before its debounce is canceled by navigation', async () => {
    const viewerRef = makeViewer();
    const mounted = render(<SegmentationHarness viewerRef={viewerRef} effectiveInstanceIndex={0} />);
    await waitForPendingDraft();

    await act(async () => {
      mounted.rerender(<SegmentationHarness viewerRef={viewerRef} effectiveInstanceIndex={1} />);
    });

    await expectSavedOriginalDraft();
  });

  it('never reassigns an unfinished annotation to the next patient examination or series', async () => {
    const viewerRef = makeViewer();
    const mounted = render(<SegmentationHarness viewerRef={viewerRef} />);
    await waitForPendingDraft();

    await act(async () => {
      mounted.rerender(
        <SegmentationHarness
          viewerRef={viewerRef}
          comboId="synthetic-sequence-b"
          dateIso="synthetic-examination-b"
          studyId="synthetic-study-b"
          seriesUid="synthetic-series-b"
          effectiveInstanceIndex={2}
        />,
      );
    });

    await waitFor(() => expect(mocks.save).toHaveBeenCalledTimes(1));
    expect(mocks.save.mock.calls[0]?.[0]).toMatchObject({
      comboId: 'synthetic-sequence-a',
      dateIso: 'synthetic-examination-a',
      studyId: 'synthetic-study-a',
      seriesUid: 'synthetic-series-a',
      sopInstanceUid: 'synthetic-series-a-instance-0',
    });
    expect(mocks.save.mock.calls[0]?.[0]).not.toMatchObject({
      studyId: 'synthetic-study-b',
      seriesUid: 'synthetic-series-b',
    });
  });

  it('resolves a missing instance identity against its captured original scope after switching patient', async () => {
    const unresolvedInitialIdentity = deferred<string>();
    mocks.lookup.mockImplementationOnce(() => unresolvedInitialIdentity.promise);
    const viewerRef = makeViewer();
    const mounted = render(<SegmentationHarness viewerRef={viewerRef} />);
    await waitForPendingDraft();

    await act(async () => {
      mounted.rerender(
        <SegmentationHarness
          viewerRef={viewerRef}
          studyId="synthetic-study-b"
          seriesUid="synthetic-series-b"
          effectiveInstanceIndex={3}
        />,
      );
    });

    await expectSavedOriginalDraft();
    expect(mocks.lookup).toHaveBeenCalledWith('synthetic-series-a', 0);
  });

  it('serializes the newest immutable draft behind an in-flight save when the tool closes', async () => {
    const firstSave = deferred<void>();
    mocks.save.mockImplementationOnce(() => firstSave.promise);
    const viewerRef = makeViewer();
    const mounted = render(<SegmentationHarness viewerRef={viewerRef} />);
    await waitForPendingDraft();
    await waitFor(() => expect(mocks.save).toHaveBeenCalledTimes(1));

    fireEvent.change(screen.getByRole('slider', { name: 'Area cap (px)' }), { target: { value: '8' } });
    await waitFor(() => expect(screen.getByLabelText('Segmented area')).toHaveTextContent('2.0 mm²'));

    mounted.unmount();
    expect(mocks.save).toHaveBeenCalledTimes(1);

    await act(async () => {
      firstSave.resolve();
    });

    await waitFor(() => expect(mocks.save).toHaveBeenCalledTimes(2));
    expect(mocks.save.mock.calls[0]?.[0]).toMatchObject({
      seriesUid: 'synthetic-series-a',
      sopInstanceUid: 'synthetic-series-a-instance-0',
      meta: { areaPx: 16 },
    });
    expect(mocks.save.mock.calls[1]?.[0]).toMatchObject({
      seriesUid: 'synthetic-series-a',
      sopInstanceUid: 'synthetic-series-a-instance-0',
      meta: { areaPx: 8 },
    });
  });
});
