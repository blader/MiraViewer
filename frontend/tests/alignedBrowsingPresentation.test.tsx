import { act, fireEvent, render, renderHook, screen, waitFor } from '@testing-library/react';
import { createRef, type ContextType, type PropsWithChildren, type Ref } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import cornerstone from 'cornerstone-core';
import { DicomViewer, type DicomViewerHandle } from '../src/components/DicomViewer';
import { AlignedBrowsingContext, useAlignedFrame } from '../src/hooks/useAlignedFrame';
import type { AlignmentResult } from '../src/types/api';
import { DEFAULT_PANEL_SETTINGS } from '../src/utils/constants';
import { DEFAULT_ALIGNMENT_ADJUSTMENT } from '../src/utils/alignmentAdjustment';
import {
  clearDerivedAlignmentFrames,
  getDerivedAlignmentFrame,
  setDerivedAlignmentFrame,
  type DerivedAlignmentReference,
} from '../src/utils/derivedAlignmentFrame';
import { buildOutputPlaneGrid } from '../src/utils/outputPlaneGrid';
import { getImageIdForInstance } from '../src/utils/localApi';
import { deferred } from './helpers/deferred';

vi.mock('../src/utils/localApi', () => ({
  getImageIdForInstance: vi.fn(
    async (seriesUid: string, instanceIndex: number) => `miradb:${seriesUid}:${instanceIndex}`,
  ),
  MAX_DERIVED_ALIGNMENT_FRAMES: 32,
}));

vi.mock('cornerstone-core', () => ({
  default: {
    enable: vi.fn(),
    disable: vi.fn(),
    loadImage: vi.fn(async (imageId: string) => ({ imageId })),
    displayImage: vi.fn(),
    getDefaultViewportForImage: vi.fn(() => ({})),
    resize: vi.fn(),
  },
}));

type BrowsingContext = ContextType<typeof AlignedBrowsingContext>;
type PresentationOptions = {
  context: BrowsingContext;
  seriesUid: string;
  instanceIndex: number;
};

function reference(overrides: Partial<DerivedAlignmentReference> = {}): DerivedAlignmentReference {
  return {
    seriesUid: 'reference-series',
    sliceIndex: 40,
    patientKey: 'patient-a',
    sequenceId: 'flair',
    datasetRevision: 9,
    outputMode: 'native',
    ...overrides,
  };
}

function context(overrides: Partial<DerivedAlignmentReference> = {}): NonNullable<BrowsingContext> {
  return { reference: reference(overrides), targetSeriesUids: new Set(['target-series']) };
}

function alignedResult(referenceSliceIndex = 40, bestSliceIndex = 4): AlignmentResult {
  const outputGrid = buildOutputPlaneGrid({
    sopInstanceUid: `reference-sop-${referenceSliceIndex}`,
    frameOfReferenceUid: 'reference-frame-space',
    rows: 2,
    columns: 2,
    imagePositionPatient: `0\\0\\${referenceSliceIndex}`,
    imageOrientationPatient: '1\\0\\0\\0\\1\\0',
    pixelSpacing: '1\\1',
  });
  return {
    date: 'target-date',
    seriesUid: 'target-series',
    bestSliceIndex,
    nmiScore: 0.85,
    computedSettings: {
      ...DEFAULT_PANEL_SETTINGS,
      offset: 3,
      brightness: 111,
      contrast: 89,
      zoom: 1.07,
      rotation: 2,
      panX: 0.03,
      panY: 0.02,
      affine00: 1.04,
      affine01: 0.01,
      affine10: -0.02,
      affine11: 0.98,
    },
    slicesChecked: 48,
    runId: `reslice-${referenceSliceIndex}`,
    registrationId: 'accepted-volume-pose',
    patientKey: 'patient-a',
    sequenceId: 'flair',
    datasetRevision: 9,
    referenceSeriesUid: 'reference-series',
    outputGrid,
    outcome: 'aligned',
    derivedFrame: {
      rows: 2,
      columns: 2,
      pixels: new Float32Array([10, 20, 30, referenceSliceIndex]),
      valid: new Uint8Array(4).fill(1),
      sourceImageId: `miradb:target-sop-${bestSliceIndex}`,
      targetStudyUid: 'target-study',
      targetSopInstanceUid: `target-sop-${bestSliceIndex}`,
      referenceStudyUid: 'reference-study',
      referenceSeriesUid: 'reference-series',
      referenceFrameIndex: referenceSliceIndex,
      referenceSopInstanceUid: `reference-sop-${referenceSliceIndex}`,
      referenceFrameOfReferenceUid: 'reference-frame-space',
      targetFrameOfReferenceUid: 'target-frame-space',
      rigidTransform: [1, 2, 3, 0, 0, 0.05],
      rotationCenterMm: [0, 0, 40],
      nativeSliceSpacingMm: 1,
      outputGrid,
      displayTone: {
        windowCenter: 120,
        windowWidth: 200,
        source: [0.15, 0.4, 0.75],
        reference: [0.2, 0.5, 0.85],
      },
    },
  };
}

function renderPresentation(
  initialProps: PresentationOptions = { context: context(), seriesUid: 'target-series', instanceIndex: 4 },
) {
  let currentContext = initialProps.context;
  const wrapper = ({ children }: PropsWithChildren) => (
    <AlignedBrowsingContext.Provider value={currentContext}>{children}</AlignedBrowsingContext.Provider>
  );
  const hook = renderHook(({ seriesUid, instanceIndex }) => useAlignedFrame(seriesUid, instanceIndex), {
    initialProps,
    wrapper,
  });
  return {
    ...hook,
    rerender(next: PresentationOptions) {
      currentContext = next.context;
      hook.rerender(next);
    },
  };
}

describe('aligned browsing presentation continuity', () => {
  beforeEach(() => clearDerivedAlignmentFrames());
  afterEach(() => act(() => clearDerivedAlignmentFrames()));

  it('keeps manual display corrections on the accepted affine and tone while browsing', () => {
    const accepted = alignedResult();
    setDerivedAlignmentFrame(accepted);
    const adjustment = { ...DEFAULT_ALIGNMENT_ADJUSTMENT, panX: 0.1, rotation: -1, zoom: 1.5, brightness: 12 };
    const adjustedContext = { ...context(), adjustments: new Map([['target-series', adjustment]]) };
    const { result, rerender } = renderPresentation({
      context: adjustedContext,
      seriesUid: 'target-series',
      instanceIndex: 4,
    });
    const pixels = result.current.frame!.pixels;
    expect(result.current.settings).toMatchObject({
      panX: 0.13,
      rotation: 1,
      brightness: 123,
      contrast: 89,
      affine00: 1.04,
      affine01: 0.01,
      affine10: -0.02,
      affine11: 0.98,
    });
    expect(result.current.settings?.zoom).toBeCloseTo(1.605);

    rerender({
      context: { ...adjustedContext, reference: reference({ sliceIndex: 41 }) },
      seriesUid: 'target-series',
      instanceIndex: 5,
    });
    expect(result.current.pending).toBe(true);
    expect(result.current.frame!.pixels).toBe(pixels);
    expect(result.current.settings?.brightness).toBe(123);

    const next = alignedResult(41, 5);
    next.computedSettings = { ...next.computedSettings, brightness: 94, contrast: 117, affine01: 0.05 };
    act(() => setDerivedAlignmentFrame(next));
    expect(result.current.pending).toBe(false);
    expect(result.current.settings).toMatchObject({ brightness: 106, contrast: 117, affine01: 0.05, rotation: 1 });
    expect(next.computedSettings.brightness).toBe(94);
    expect(accepted.computedSettings.panX).toBe(0.03);
  });

  it('holds an accepted plane during a same-reference slice correction and reuses exact pixels on undo', () => {
    setDerivedAlignmentFrame(alignedResult());
    const { result, rerender } = renderPresentation();
    const original = result.current.frame;
    const correctedContext = {
      ...context(),
      adjustments: new Map([['target-series', { ...DEFAULT_ALIGNMENT_ADJUSTMENT, sliceOffset: 1 }]]),
    };
    rerender({ context: correctedContext, seriesUid: 'target-series', instanceIndex: 5 });
    expect(result.current.pending).toBe(true);
    expect(result.current.frame).toBe(original);

    const corrected = { ...alignedResult(40, 5), manualSliceOffset: 1 };
    corrected.derivedFrame = { ...corrected.derivedFrame!, pixels: new Float32Array([12, 24, 36, 48]) };
    act(() => setDerivedAlignmentFrame(corrected));
    expect(result.current.pending).toBe(false);
    expect(result.current.frame?.pixels).toBe(corrected.derivedFrame.pixels);
    expect(result.current.frame?.imageId).not.toBe(original?.imageId);

    rerender({ context: context(), seriesUid: 'target-series', instanceIndex: 4 });
    expect(result.current.pending).toBe(false);
    expect(result.current.frame).toBe(original);
  });

  it('honors an acquired pause even when the exact derived plane is still cached', () => {
    setDerivedAlignmentFrame(alignedResult());
    const { result, rerender } = renderPresentation();
    const accepted = result.current.frame;
    rerender({
      context: { ...context(), targetSeriesUids: new Set(), acquiredSeriesUids: new Set(['target-series']) },
      seriesUid: 'target-series',
      instanceIndex: 4,
    });
    expect(result.current.frame).toBeNull();
    expect(result.current.pending).toBe(false);
    rerender({ context: context(), seriesUid: 'target-series', instanceIndex: 4 });
    expect(result.current.frame).toBe(accepted);
  });

  it('keeps accepted pixels, physical geometry, affine settings, and tone together while the next slice is pending', () => {
    const accepted = alignedResult();
    setDerivedAlignmentFrame(accepted);
    const acceptedFrame = getDerivedAlignmentFrame('target-series', 4)!;
    const { result, rerender } = renderPresentation();
    expect(result.current).toEqual({
      frame: acceptedFrame,
      pending: false,
      settings: accepted.computedSettings,
      status: 'ready',
    });

    rerender({ context: context({ sliceIndex: 41 }), seriesUid: 'target-series', instanceIndex: 5 });

    // A non-null accepted frame prevents the viewer from loading an unregistered
    // native plane with a different physical pose and uncalibrated intensity.
    expect(result.current).toEqual({
      frame: acceptedFrame,
      pending: true,
      settings: accepted.computedSettings,
      status: 'updating',
    });
    expect(result.current.frame?.pixels).toBe(accepted.derivedFrame!.pixels);
    expect(result.current.frame?.rigidTransform).toBe(accepted.derivedFrame!.rigidTransform);
    expect(result.current.frame?.displayTone).toBe(accepted.derivedFrame!.displayTone);
    expect(result.current.frame?.acceptedResult).toBe(accepted);
    expect(result.current.frame?.acceptedResult?.computedSettings).toBe(accepted.computedSettings);
  });

  it('leaves the held presentation pending through rerenders until the current reference plane arrives', () => {
    const accepted = alignedResult();
    setDerivedAlignmentFrame(accepted);
    const acceptedFrame = getDerivedAlignmentFrame('target-series', 4)!;
    const props: PresentationOptions = {
      context: context({ sliceIndex: 41 }),
      seriesUid: 'target-series',
      instanceIndex: 5,
    };
    const { result, rerender } = renderPresentation(props);

    rerender({ ...props, context: context({ sliceIndex: 41 }) });
    expect(result.current).toEqual({
      frame: acceptedFrame,
      pending: true,
      settings: accepted.computedSettings,
      status: 'updating',
    });

    const completed = alignedResult(41, 6);
    act(() => setDerivedAlignmentFrame(completed));

    // The verified physical result wins even if its source index differs from
    // the offset's prediction. There is no intermediate native presentation.
    expect(result.current.pending).toBe(false);
    expect(result.current.frame?.acceptedResult).toBe(completed);
    expect(result.current.frame?.referenceFrameIndex).toBe(41);
    expect(result.current.frame?.instanceIndex).toBe(6);
  });

  it('distinguishes two reference planes that select the same native source slice and reuses both when revisiting', () => {
    const first = alignedResult(40, 4);
    const second = alignedResult(41, 4);
    setDerivedAlignmentFrame(first);
    setDerivedAlignmentFrame(second);
    const { result, rerender } = renderPresentation();

    expect(result.current.pending).toBe(false);
    expect(result.current.frame?.acceptedResult).toBe(first);

    rerender({ context: context({ sliceIndex: 41 }), seriesUid: 'target-series', instanceIndex: 4 });
    expect(result.current.pending).toBe(false);
    expect(result.current.frame?.acceptedResult).toBe(second);

    rerender({ context: context(), seriesUid: 'target-series', instanceIndex: 4 });
    expect(result.current.pending).toBe(false);
    expect(result.current.frame?.acceptedResult).toBe(first);
  });

  it('holds the last visited plane after a quick cached revisit rather than the most recently stored plane', () => {
    const first = alignedResult(40, 4);
    const lastStored = alignedResult(42, 6);
    setDerivedAlignmentFrame(first);
    setDerivedAlignmentFrame(alignedResult(41, 5));
    setDerivedAlignmentFrame(lastStored);
    const { result, rerender } = renderPresentation({
      context: context({ sliceIndex: 41 }),
      seriesUid: 'target-series',
      instanceIndex: 5,
    });

    rerender({ context: context(), seriesUid: 'target-series', instanceIndex: 4 });
    const lastVisited = result.current.frame;
    expect(lastVisited?.acceptedResult).toBe(first);

    // Navigation can arrive before the engine replays a cached result. No new
    // cache write occurs between revisiting plane 40 and requesting uncached 43.
    rerender({ context: context({ sliceIndex: 43 }), seriesUid: 'target-series', instanceIndex: 7 });

    expect(result.current.frame).toBe(lastVisited);
    expect(result.current.frame?.acceptedResult).not.toBe(lastStored);
    expect(result.current.status).toBe('updating');
  });

  it('distinguishes held anatomy from active, paused, and failed work without replacing its pixels or settings', () => {
    const accepted = alignedResult();
    setDerivedAlignmentFrame(accepted);
    const { result, rerender } = renderPresentation();
    const acceptedFrame = result.current.frame;
    const pendingContext = context({ sliceIndex: 41 });

    rerender({ context: pendingContext, seriesUid: 'target-series', instanceIndex: 5 });
    expect(result.current.status).toBe('updating');

    rerender({ context: { ...pendingContext, updating: false }, seriesUid: 'target-series', instanceIndex: 5 });
    expect(result.current).toEqual({
      frame: acceptedFrame,
      pending: true,
      settings: accepted.computedSettings,
      status: 'paused',
    });

    const unavailableContext = {
      ...pendingContext,
      updating: false,
      unavailableSeriesUids: new Set(['target-series']),
    };
    rerender({ context: unavailableContext, seriesUid: 'target-series', instanceIndex: 5 });
    expect(result.current).toEqual({
      frame: acceptedFrame,
      pending: true,
      settings: accepted.computedSettings,
      status: 'unavailable',
    });

    act(() => setDerivedAlignmentFrame(alignedResult(41, 5)));
    expect(result.current.pending).toBe(false);
    expect(result.current.status).toBe('ready');
  });

  it('does not retain a local presentation after its cache is explicitly cleared', () => {
    setDerivedAlignmentFrame(alignedResult());
    const { result, rerender } = renderPresentation();
    rerender({ context: context({ sliceIndex: 41 }), seriesUid: 'target-series', instanceIndex: 5 });
    expect(result.current.frame).not.toBeNull();

    act(() => clearDerivedAlignmentFrames());

    expect(result.current.frame).toBeNull();
    expect(result.current.status).toBe('ready');
  });

  it('never keeps a locally held frame after a replacement registration invalidates its model', () => {
    setDerivedAlignmentFrame(alignedResult());
    const { result, rerender } = renderPresentation();
    const oldFrame = result.current.frame;
    rerender({ context: context({ sliceIndex: 41 }), seriesUid: 'target-series', instanceIndex: 5 });
    const replacement = { ...alignedResult(42, 6), registrationId: 'replacement-volume-pose' };

    act(() => setDerivedAlignmentFrame(replacement));

    expect(result.current.frame).not.toBe(oldFrame);
    expect(result.current.frame?.acceptedResult).toBe(replacement);
    expect(result.current.pending).toBe(true);
  });

  it.each([
    ['no comparison scope', null],
    ['a series outside the visible comparison targets', { ...context(), targetSeriesUids: new Set<string>() }],
  ])('does not hold another slice for %s', (_label, browsingContext) => {
    setDerivedAlignmentFrame(alignedResult());
    const exact = getDerivedAlignmentFrame('target-series', 4);
    const { result, rerender } = renderPresentation({
      context: browsingContext,
      seriesUid: 'target-series',
      instanceIndex: 4,
    });
    expect(result.current).toEqual({ frame: exact, pending: false, status: 'ready' });

    rerender({ context: browsingContext, seriesUid: 'target-series', instanceIndex: 5 });
    expect(result.current).toEqual({ frame: null, pending: false, status: 'ready' });
  });

  it('never holds the reference column using another target column’s registration', () => {
    setDerivedAlignmentFrame(alignedResult());
    const { result } = renderPresentation({
      context: context({ sliceIndex: 41 }),
      seriesUid: 'reference-series',
      instanceIndex: 41,
    });

    expect(result.current).toEqual({ frame: null, pending: false, status: 'ready' });
  });

  it.each([
    ['patient', { patientKey: 'patient-b' }],
    ['sequence', { sequenceId: 't1' }],
    ['dataset revision', { datasetRevision: 10 }],
    ['reference series', { seriesUid: 'other-reference' }],
    ['output mode', { outputMode: 'fixed-256' }],
  ] satisfies Array<[string, Partial<DerivedAlignmentReference>]>)(
    'does not reuse anatomy after the %s changes',
    (_label, changed) => {
      setDerivedAlignmentFrame(alignedResult());
      const { result, rerender } = renderPresentation();
      expect(result.current.frame).not.toBeNull();

      rerender({ context: context(changed), seriesUid: 'target-series', instanceIndex: 4 });

      // Even an exact native-index hit is stale when the verified context changes.
      expect(result.current.frame).toBeNull();
    },
  );

  it('does not borrow a held frame from another target examination', () => {
    setDerivedAlignmentFrame(alignedResult());
    const { result } = renderPresentation({
      context: { ...context({ sliceIndex: 41 }), targetSeriesUids: new Set(['target-series', 'different-target']) },
      seriesUid: 'different-target',
      instanceIndex: 5,
    });

    expect(result.current.frame).toBeNull();
  });
});

describe('DicomViewer aligned browsing', () => {
  beforeEach(() => {
    clearDerivedAlignmentFrames();
    vi.clearAllMocks();
    vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(512);
    vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(512);
  });
  afterEach(async () => {
    await act(async () => clearDerivedAlignmentFrames());
    vi.restoreAllMocks();
  });

  function viewer(browsingContext: BrowsingContext, instanceIndex: number, ref?: Ref<DicomViewerHandle>) {
    return (
      <AlignedBrowsingContext.Provider value={browsingContext}>
        <DicomViewer
          ref={ref}
          studyId="target-study"
          seriesUid="target-series"
          instanceIndex={instanceIndex}
          instanceCount={100}
          onInstanceChange={() => undefined}
          brightness={160}
          contrast={130}
          zoom={2}
          rotation={30}
        />
      </AlignedBrowsingContext.Provider>
    );
  }

  it('renders a manual pan and tone edit immediately without dropping the derived image or affine', async () => {
    setDerivedAlignmentFrame(alignedResult());
    const { rerender } = render(viewer(context(), 4));
    await waitFor(() => expect(cornerstone.displayImage).toHaveBeenCalledOnce());
    const imageElement = vi.mocked(cornerstone.displayImage).mock.calls[0]![0] as HTMLElement;
    const presentation = imageElement.parentElement!;
    const adjustment = { ...DEFAULT_ALIGNMENT_ADJUSTMENT, panX: 0.1, brightness: 12, contrast: -4 };
    rerender(viewer({ ...context(), adjustments: new Map([['target-series', adjustment]]) }, 4));
    expect(presentation.style.filter).toBe('brightness(1.23) contrast(0.85)');
    expect(presentation.style.transform).toContain('translate(66.56px, 10.24px)');
    expect(presentation.style.transform).toContain('matrix(1.04, -0.02, 0.01, 0.98, 0, 0)');
    expect(cornerstone.loadImage).toHaveBeenCalledOnce();
    expect(getImageIdForInstance).not.toHaveBeenCalled();
  });

  it('never loads an unregistered native image between accepted aligned slices or separates pixels from their transform', async () => {
    const accepted = alignedResult();
    setDerivedAlignmentFrame(accepted);
    const acceptedFrame = getDerivedAlignmentFrame('target-series', 4)!;
    const handle = createRef<DicomViewerHandle>();
    const { rerender } = render(viewer(context(), 4, handle));
    await waitFor(() => expect(cornerstone.displayImage).toHaveBeenCalledOnce());

    const imageElement = vi.mocked(cornerstone.displayImage).mock.calls[0]![0] as HTMLElement;
    const presentation = imageElement.parentElement!;
    expect(presentation.style.filter).toBe('brightness(1.11) contrast(0.89)');
    expect(presentation.style.transform).toContain('scale(1.07)');
    expect(presentation.style.transform).toContain('rotate(2deg)');
    expect(presentation.style.transform).toContain('matrix(1.04, -0.02, 0.01, 0.98, 0, 0)');
    expect(imageElement).toHaveAttribute('aria-label', 'Slice 5');
    expect(handle.current?.getDisplayedContentKey()).toBe('target-study:target-series:4');
    const acceptedTransform = presentation.style.transform;

    await act(async () => {
      rerender(viewer(context({ sliceIndex: 41 }), 5, handle));
    });

    expect(getImageIdForInstance).not.toHaveBeenCalled();
    expect(cornerstone.loadImage).toHaveBeenCalledOnce();
    expect(presentation.style.filter).toBe('brightness(1.11) contrast(0.89)');
    expect(presentation.style.transform).toBe(acceptedTransform);
    expect(imageElement).toHaveAttribute('aria-label', 'Slice 5');
    expect(handle.current?.getDisplayedContentKey()).toBe('target-study:target-series:4');
    expect(imageElement.closest('[aria-busy]')).toHaveAttribute('aria-busy', 'true');

    const completed = alignedResult(41, 6);
    completed.computedSettings = { ...completed.computedSettings, brightness: 92, contrast: 118, zoom: 1.03 };
    act(() => setDerivedAlignmentFrame(completed));
    await waitFor(() => expect(cornerstone.displayImage).toHaveBeenCalledTimes(2));

    expect(getImageIdForInstance).not.toHaveBeenCalled();
    expect(vi.mocked(cornerstone.loadImage).mock.calls.map(([imageId]) => imageId)).toEqual([
      acceptedFrame.imageId,
      getDerivedAlignmentFrame('target-series', 6)!.imageId,
    ]);
    expect(presentation.style.filter).toBe('brightness(0.92) contrast(1.18)');
    expect(presentation.style.transform).toContain('scale(1.03)');
    expect(imageElement).toHaveAttribute('aria-label', 'Slice 7');
    expect(handle.current?.getDisplayedContentKey()).toBe('target-study:target-series:6');
    expect(imageElement.closest('[aria-busy="true"]')).toBeNull();
  });

  it('waits for new derived pixels before changing affine or tone even when two reference planes share a native index', async () => {
    setDerivedAlignmentFrame(alignedResult());
    const { rerender } = render(viewer(context(), 4));
    await waitFor(() => expect(cornerstone.displayImage).toHaveBeenCalledOnce());
    const imageElement = vi.mocked(cornerstone.displayImage).mock.calls[0]![0] as HTMLElement;
    const presentation = imageElement.parentElement!;
    const acceptedTransform = presentation.style.transform;
    const next = alignedResult(41, 4);
    next.computedSettings = { ...next.computedSettings, brightness: 80, contrast: 125, rotation: 10, zoom: 1.1 };
    act(() => setDerivedAlignmentFrame(next));
    const nextImageId = getDerivedAlignmentFrame('target-series', 4)!.imageId;
    const pendingImage = deferred<{ imageId: string }>();
    vi.mocked(cornerstone.loadImage).mockReturnValueOnce(pendingImage.promise);

    rerender(viewer(context({ sliceIndex: 41 }), 4));
    await waitFor(() => expect(cornerstone.loadImage).toHaveBeenCalledTimes(2));

    expect(getImageIdForInstance).not.toHaveBeenCalled();
    expect(cornerstone.displayImage).toHaveBeenCalledOnce();
    expect(presentation.style.filter).toBe('brightness(1.11) contrast(0.89)');
    expect(presentation.style.transform).toBe(acceptedTransform);

    await act(async () => pendingImage.resolve({ imageId: nextImageId }));

    expect(cornerstone.displayImage).toHaveBeenCalledTimes(2);
    expect(presentation.style.filter).toBe('brightness(0.8) contrast(1.25)');
    expect(presentation.style.transform).toContain('scale(1.1)');
    expect(presentation.style.transform).toContain('rotate(10deg)');
  });

  it.each(['paused', 'unavailable'] as const)(
    'keeps the accepted image without claiming ongoing work when alignment is %s',
    async (status) => {
      setDerivedAlignmentFrame(alignedResult());
      const handle = createRef<DicomViewerHandle>();
      const { rerender } = render(viewer(context(), 4, handle));
      await waitFor(() => expect(cornerstone.displayImage).toHaveBeenCalledOnce());
      const imageElement = vi.mocked(cornerstone.displayImage).mock.calls[0]![0] as HTMLElement;
      const presentation = imageElement.parentElement!;
      const acceptedTransform = presentation.style.transform;
      const pendingContext = context({ sliceIndex: 41 });
      await act(async () => rerender(viewer(pendingContext, 5, handle)));
      expect(imageElement.closest('[aria-busy]')).toHaveAttribute('aria-busy', 'true');

      await act(async () =>
        rerender(
          viewer(
            {
              ...pendingContext,
              updating: false,
              unavailableSeriesUids: status === 'unavailable' ? new Set(['target-series']) : undefined,
            },
            5,
            handle,
          ),
        ),
      );

      expect(getImageIdForInstance).not.toHaveBeenCalled();
      expect(cornerstone.loadImage).toHaveBeenCalledOnce();
      expect(presentation.style.filter).toBe('brightness(1.11) contrast(0.89)');
      expect(presentation.style.transform).toBe(acceptedTransform);
      expect(imageElement).toHaveAttribute('aria-label', 'Slice 5');
      expect(handle.current?.getDisplayedContentKey()).toBe('target-study:target-series:4');
      expect(imageElement.closest('[aria-busy="true"]')).toBeNull();
      expect(screen.queryByText(/Updating aligned slice/)).not.toBeInTheDocument();
      if (status === 'unavailable') expect(screen.getByText(/Aligned slice unavailable/)).toBeInTheDocument();
    },
  );

  it('ignores Cmd-wheel edits while holding a pending plane but still permits ordinary slice browsing', async () => {
    setDerivedAlignmentFrame(alignedResult());
    const onZoomChange = vi.fn();
    const onInstanceChange = vi.fn();
    render(
      <AlignedBrowsingContext.Provider value={context({ sliceIndex: 41 })}>
        <DicomViewer
          studyId="target-study"
          seriesUid="target-series"
          instanceIndex={5}
          instanceCount={100}
          onInstanceChange={onInstanceChange}
          onZoomChange={onZoomChange}
        />
      </AlignedBrowsingContext.Provider>,
    );
    await waitFor(() => expect(cornerstone.displayImage).toHaveBeenCalledOnce());
    const viewport = screen.getByRole('button', { name: 'Pan MRI slice 6' });
    const modifiedWheel = new WheelEvent('wheel', { deltaY: -100, metaKey: true, cancelable: true, bubbles: true });

    fireEvent(viewport, modifiedWheel);

    expect(modifiedWheel.defaultPrevented).toBe(true);
    expect(onZoomChange).not.toHaveBeenCalled();
    expect(onInstanceChange).not.toHaveBeenCalled();

    fireEvent.wheel(viewport, { deltaY: 1 });

    expect(onInstanceChange).toHaveBeenCalledOnce();
    expect(onInstanceChange).toHaveBeenCalledWith(6);
    expect(onZoomChange).not.toHaveBeenCalled();
    expect(getImageIdForInstance).not.toHaveBeenCalled();
  });

  it('displays legacy reanchored target results when an already-derived scan becomes the reference', async () => {
    const reanchored = alignedResult();
    reanchored.registrationId = undefined;
    reanchored.referenceSeriesUid = 'original-acquired-reference';
    reanchored.derivedFrame = {
      ...reanchored.derivedFrame!,
      referenceSeriesUid: 'original-acquired-reference',
    };
    setDerivedAlignmentFrame(reanchored);
    render(viewer(null, 4));

    await waitFor(() => expect(cornerstone.displayImage).toHaveBeenCalledOnce());

    expect(getImageIdForInstance).not.toHaveBeenCalled();
    expect(cornerstone.loadImage).toHaveBeenCalledWith(getDerivedAlignmentFrame('target-series', 4)!.imageId);
    expect(screen.getByText(/Derived 3D-aligned plane/)).toBeInTheDocument();
  });

  it('returns to native slice browsing when the user explicitly leaves automatic alignment', async () => {
    setDerivedAlignmentFrame(alignedResult());
    const { rerender } = render(viewer(context(), 4));
    await waitFor(() => expect(cornerstone.displayImage).toHaveBeenCalledOnce());

    rerender(viewer(null, 5));

    await waitFor(() => expect(cornerstone.displayImage).toHaveBeenCalledTimes(2));
    expect(getImageIdForInstance).toHaveBeenCalledWith('target-series', 5);
    expect(cornerstone.loadImage).toHaveBeenLastCalledWith('miradb:target-series:5');
    const imageElement = vi.mocked(cornerstone.displayImage).mock.lastCall![0] as HTMLElement;
    expect(imageElement.parentElement!.style.filter).toBe('brightness(1.6) contrast(1.3)');
    expect(imageElement.parentElement!.style.transform).toContain('scale(2)');
  });
});
