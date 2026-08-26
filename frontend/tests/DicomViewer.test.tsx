import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { Profiler } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DicomViewer } from '../src/components/DicomViewer';
import { DEBUG_ALIGNMENT_STORAGE_KEY, subscribeToDebugAlignmentKey } from '../src/utils/debugAlignment';
import {
  recordAlignmentSliceScore,
  resetAlignmentSliceScoreStore,
  type AlignmentSliceScoreMetrics,
} from '../src/utils/alignmentSliceScoreStore';
import { getImageIdForInstance } from '../src/utils/localApi';
import { clearDerivedAlignmentFrames, setDerivedAlignmentFrame } from '../src/utils/derivedAlignmentFrame';
import { buildOutputPlaneGrid } from '../src/utils/outputPlaneGrid';
import { DEFAULT_PANEL_SETTINGS } from '../src/utils/constants';

vi.mock('../src/utils/localApi', () => ({
  getImageIdForInstance: vi.fn().mockResolvedValue('miradb:inst-1'),
  MAX_DERIVED_ALIGNMENT_FRAMES: 12,
}));

vi.mock('cornerstone-core', () => ({
  default: {
    enable: vi.fn(),
    disable: vi.fn(),
    loadImage: vi.fn().mockResolvedValue({}),
    displayImage: vi.fn(),
    getDefaultViewportForImage: vi.fn().mockReturnValue({}),
    resize: vi.fn(),
  },
}));

import cornerstone from 'cornerstone-core';

function createDeferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });

  return { promise, resolve };
}

const LEGACY_SLICE_SCORE: AlignmentSliceScoreMetrics = {
  ssim: 0.4,
  lncc: 0.3,
  zncc: 0.2,
  ngf: 0.8,
  census: 0.1,
  phase: 0.5,
  mi: 0.6,
  nmi: 0.7,
  score: 0.76,
};

function recordViewerSliceScore(overrides: Partial<AlignmentSliceScoreMetrics> = {}) {
  recordAlignmentSliceScore('series', 0, {
    ...LEGACY_SLICE_SCORE,
    ...overrides,
  });
}

function recordProductionViewerSliceScore(overrides: Partial<AlignmentSliceScoreMetrics> = {}) {
  recordViewerSliceScore({
    coverage: 0.92,
    mind: 0.87,
    rawMindDistance: 0.13,
    mindRank: 0.9,
    structuralRank: 0.85,
    appearanceRank: 0.2,
    boundaryRank: 0.8,
    perceptualRank: 0.76,
    mindActive: true,
    structuralActive: true,
    appearanceActive: true,
    boundaryActive: true,
    phaseInput: 'structural-edge-energy',
    finalAffineSelected: 'structure-elastix',
    finalAffineStructuralScore: 0.91,
    finalAffineSeedStructuralScore: 0.74,
    ...overrides,
  });
}

function renderViewer() {
  return render(
    <DicomViewer
      studyId="study"
      seriesUid="series"
      instanceIndex={0}
      instanceCount={1}
      onInstanceChange={() => {}}
      imageUrlOverride="test.png"
    />,
  );
}

// Mock getBoundingClientRect to return non-zero dimensions
beforeEach(() => {
  vi.clearAllMocks();
  act(() => clearDerivedAlignmentFrames());
  localStorage.removeItem(DEBUG_ALIGNMENT_STORAGE_KEY);
  resetAlignmentSliceScoreStore();

  Element.prototype.getBoundingClientRect = vi.fn().mockReturnValue({
    width: 500,
    height: 500,
    top: 0,
    left: 0,
    right: 500,
    bottom: 500,
    x: 0,
    y: 0,
    toJSON: () => ({}),
  });
});

afterEach(() => {
  act(() => clearDerivedAlignmentFrames());
  fireEvent.keyUp(window, { key: 'z' });
  localStorage.removeItem(DEBUG_ALIGNMENT_STORAGE_KEY);
  resetAlignmentSliceScoreStore();
});

describe('DicomViewer', () => {
  it('publishes a debug-key change once when diagnostic subscribers change during notification', () => {
    const removed = vi.fn();
    const stable = vi.fn();
    let unsubscribeChanging = () => {};
    let unsubscribeRemoved = () => {};
    const changing = vi.fn(() => {
      unsubscribeChanging();
      unsubscribeRemoved();
      if (changing.mock.calls.length < 4) unsubscribeChanging = subscribeToDebugAlignmentKey(changing);
    });
    unsubscribeChanging = subscribeToDebugAlignmentKey(changing);
    unsubscribeRemoved = subscribeToDebugAlignmentKey(removed);
    const unsubscribeStable = subscribeToDebugAlignmentKey(stable);

    try {
      fireEvent.keyDown(window, { key: 'z' });

      expect(changing).toHaveBeenCalledOnce();
      expect(removed).not.toHaveBeenCalled();
      expect(stable).toHaveBeenCalledOnce();
    } finally {
      unsubscribeChanging();
      unsubscribeRemoved();
      unsubscribeStable();
    }
  });

  it('shows fixed-precision structural diagnostics only while unmodified Z is held in debug mode', () => {
    localStorage.setItem(DEBUG_ALIGNMENT_STORAGE_KEY, '1');
    recordProductionViewerSliceScore();
    renderViewer();

    expect(screen.queryByText('MIND: 0.870000')).not.toBeInTheDocument();

    fireEvent.keyDown(window, { key: 'x' });
    fireEvent.keyDown(window, { key: 'z', metaKey: true });
    fireEvent.keyDown(window, { key: 'z', ctrlKey: true });
    fireEvent.keyDown(window, { key: 'z', altKey: true });
    expect(screen.queryByText('MIND: 0.870000')).not.toBeInTheDocument();

    fireEvent.keyDown(window, { key: 'z' });
    expect(screen.getByText('MIND: 0.870000')).toBeInTheDocument();
    expect(screen.getByText('MIND rank: 0.9000')).toBeInTheDocument();
    expect(screen.getByText('NGF: 0.800000')).toBeInTheDocument();
    expect(screen.getByText('Boundary rank: 0.8000')).toBeInTheDocument();
    expect(screen.getByText('Structural rank: 0.8500')).toBeInTheDocument();
    expect(screen.getByText('Appearance rank: 0.2000')).toBeInTheDocument();
    expect(screen.getByText('Perceptual rank: 0.7600')).toBeInTheDocument();
    expect(screen.getByText('Phase input: structural edge energy')).toBeInTheDocument();
    expect(screen.getByText('Final affine: structure elastix')).toBeInTheDocument();
    expect(screen.getByText('Final affine structure: 0.910000 (seed 0.740000)')).toBeInTheDocument();

    fireEvent.keyUp(window, { key: 'z' });
    expect(screen.queryByText('MIND: 0.870000')).not.toBeInTheDocument();

    fireEvent.keyDown(window, { key: 'Z' });
    expect(screen.getByText('MIND: 0.870000')).toBeInTheDocument();
    fireEvent(window, new Event('blur'));
    expect(screen.queryByText('MIND: 0.870000')).not.toBeInTheDocument();
  });

  it('does not show alignment diagnostics when debug mode is disabled', () => {
    recordProductionViewerSliceScore();
    renderViewer();

    fireEvent.keyDown(window, { key: 'z' });

    expect(screen.queryByText('MIND: 0.870000')).not.toBeInTheDocument();
    expect(screen.queryByText('SSIM: 0.400000')).not.toBeInTheDocument();
  });

  it('shares one debug keyboard listener across every mounted viewer', () => {
    localStorage.setItem(DEBUG_ALIGNMENT_STORAGE_KEY, '1');
    const addListener = vi.spyOn(window, 'addEventListener');
    const removeListener = vi.spyOn(window, 'removeEventListener');
    const view = render(
      <>
        <DicomViewer
          studyId="study"
          seriesUid="series"
          instanceIndex={0}
          instanceCount={1}
          onInstanceChange={() => {}}
          imageUrlOverride="first.png"
        />
        <DicomViewer
          studyId="study"
          seriesUid="another-series"
          instanceIndex={0}
          instanceCount={1}
          onInstanceChange={() => {}}
          imageUrlOverride="second.png"
        />
      </>,
    );

    expect(addListener.mock.calls.filter(([type]) => type === 'keydown')).toHaveLength(1);
    expect(addListener.mock.calls.filter(([type]) => type === 'keyup')).toHaveLength(1);

    view.unmount();

    expect(removeListener.mock.calls.filter(([type]) => type === 'keydown')).toHaveLength(1);
    expect(removeListener.mock.calls.filter(([type]) => type === 'keyup')).toHaveLength(1);
    addListener.mockRestore();
    removeListener.mockRestore();
  });

  it('ignores diagnostic shortcuts while focus belongs to an input', () => {
    localStorage.setItem(DEBUG_ALIGNMENT_STORAGE_KEY, '1');
    recordProductionViewerSliceScore();
    render(
      <>
        <input aria-label="Clinical notes" />
        <DicomViewer
          studyId="study"
          seriesUid="series"
          instanceIndex={0}
          instanceCount={1}
          onInstanceChange={() => {}}
          imageUrlOverride="test.png"
        />
      </>,
    );

    fireEvent.keyDown(screen.getByRole('textbox', { name: 'Clinical notes' }), { key: 'z' });

    expect(screen.queryByText('MIND: 0.870000')).not.toBeInTheDocument();
  });

  it('shows flat for explicitly inactive rank families and omits absent final-affine rows', () => {
    localStorage.setItem(DEBUG_ALIGNMENT_STORAGE_KEY, '1');
    recordProductionViewerSliceScore({
      mindActive: false,
      structuralActive: false,
      appearanceActive: false,
      boundaryActive: false,
      finalAffineSelected: undefined,
      finalAffineStructuralScore: undefined,
      finalAffineSeedStructuralScore: undefined,
    });
    renderViewer();

    fireEvent.keyDown(window, { key: 'z' });

    expect(screen.getByText('MIND rank: flat')).toBeInTheDocument();
    expect(screen.getByText('Boundary rank: flat')).toBeInTheDocument();
    expect(screen.getByText('Structural rank: flat')).toBeInTheDocument();
    expect(screen.getByText('Appearance rank: flat')).toBeInTheDocument();
    expect(screen.queryByText(/^Final affine:/)).not.toBeInTheDocument();
    expect(screen.queryByText(/^Final affine structure:/)).not.toBeInTheDocument();
  });

  it('shows em dashes instead of ranks when family activity is unknown', () => {
    localStorage.setItem(DEBUG_ALIGNMENT_STORAGE_KEY, '1');
    recordProductionViewerSliceScore({
      mindActive: undefined,
      structuralActive: undefined,
      appearanceActive: undefined,
      boundaryActive: undefined,
    });
    renderViewer();

    fireEvent.keyDown(window, { key: 'z' });

    expect(screen.getByText('MIND rank: —')).toBeInTheDocument();
    expect(screen.getByText('Boundary rank: —')).toBeInTheDocument();
    expect(screen.getByText('Structural rank: —')).toBeInTheDocument();
    expect(screen.getByText('Appearance rank: —')).toBeInTheDocument();
  });

  it('renders zero-valued final-affine scores and humanizes the proposal label', () => {
    localStorage.setItem(DEBUG_ALIGNMENT_STORAGE_KEY, '1');
    recordProductionViewerSliceScore({
      finalAffineSelected: 'intensity-elastix',
      finalAffineStructuralScore: 0,
      finalAffineSeedStructuralScore: 0,
    });
    renderViewer();

    fireEvent.keyDown(window, { key: 'z' });

    expect(screen.getByText('Final affine: intensity elastix')).toBeInTheDocument();
    expect(screen.getByText('Final affine structure: 0.000000 (seed 0.000000)')).toBeInTheDocument();
  });

  it('keeps legacy score labels for records without production coverage', () => {
    localStorage.setItem(DEBUG_ALIGNMENT_STORAGE_KEY, '1');
    recordViewerSliceScore();
    renderViewer();

    fireEvent.keyDown(window, { key: 'z' });

    expect(screen.getByText('SSIM: 0.400000')).toBeInTheDocument();
    expect(screen.getByText('LNCC: 0.300000')).toBeInTheDocument();
    expect(screen.getByText('ZNCC: 0.200000')).toBeInTheDocument();
    expect(screen.getByText('NGF: 0.800000')).toBeInTheDocument();
    expect(screen.getByText('Census: 0.100000')).toBeInTheDocument();
    expect(screen.getByText('Phase: 0.500000')).toBeInTheDocument();
    expect(screen.getByText('MI: 0.600000')).toBeInTheDocument();
    expect(screen.getByText('NMI: 0.700000')).toBeInTheDocument();
    expect(screen.getByText('Score: 0.760000')).toBeInTheDocument();
    expect(screen.queryByText(/^MIND:/)).not.toBeInTheDocument();
    expect(screen.queryByText(/^Final affine:/)).not.toBeInTheDocument();
  });

  it('renders image override via img tag', async () => {
    render(
      <DicomViewer
        studyId="study"
        seriesUid="series"
        instanceIndex={0}
        instanceCount={1}
        onInstanceChange={() => {}}
        imageUrlOverride="test.png"
      />,
    );

    const img = await screen.findByRole('img');
    expect(img).toHaveAttribute('src', 'test.png');
  });

  it('ignores duplicate viewport resize notifications while preserving real image geometry changes', () => {
    const OriginalResizeObserver = globalThis.ResizeObserver;
    let observedElement: Element | undefined;
    let notifyResize: ResizeObserverCallback | undefined;
    class CapturingResizeObserver {
      constructor(callback: ResizeObserverCallback) {
        notifyResize = callback;
      }

      observe(element: Element) {
        observedElement = element;
      }

      unobserve() {}

      disconnect() {}
    }
    globalThis.ResizeObserver = CapturingResizeObserver as unknown as typeof ResizeObserver;
    const onRender = vi.fn();
    let unmount: (() => void) | undefined;

    try {
      ({ unmount } = render(
        <Profiler id="diagnostic-viewer" onRender={onRender}>
          <DicomViewer
            studyId="study"
            seriesUid="series"
            instanceIndex={0}
            instanceCount={1}
            onInstanceChange={() => {}}
            imageUrlOverride="test.png"
            panX={0.25}
            panY={0.5}
          />
        </Profiler>,
      ));

      expect(observedElement).toBeDefined();
      expect(notifyResize).toBeDefined();
      Object.defineProperties(observedElement!, {
        clientWidth: { configurable: true, value: 320 },
        clientHeight: { configurable: true, value: 240 },
      });
      act(() => notifyResize!([], {} as ResizeObserver));
      expect(screen.getByRole('img').parentElement?.style.transform).toContain('translate(80px, 120px)');

      onRender.mockClear();
      for (let index = 0; index < 5; index++) {
        act(() => notifyResize!([], {} as ResizeObserver));
      }
      expect(onRender).not.toHaveBeenCalled();

      Object.defineProperties(observedElement!, {
        clientWidth: { configurable: true, value: 640 },
        clientHeight: { configurable: true, value: 360 },
      });
      act(() => notifyResize!([], {} as ResizeObserver));
      expect(onRender).toHaveBeenCalledOnce();
      expect(screen.getByRole('img').parentElement?.style.transform).toContain('translate(160px, 180px)');
    } finally {
      unmount?.();
      globalThis.ResizeObserver = OriginalResizeObserver;
    }
  });

  it('loads Cornerstone image when no override', async () => {
    render(
      <DicomViewer
        studyId="study"
        seriesUid="series"
        instanceIndex={0}
        instanceCount={1}
        onInstanceChange={() => {}}
      />,
    );

    await waitFor(() => {
      expect(cornerstone.loadImage).toHaveBeenCalled();
    });
  });

  it('labels an upsampled derived plane with its actual acquired and presented dimensions', async () => {
    const outputGrid = buildOutputPlaneGrid(
      {
        rows: 2,
        columns: 2,
        imagePositionPatient: '0\\0\\0',
        imageOrientationPatient: '1\\0\\0\\0\\1\\0',
        pixelSpacing: '1\\1',
        sopInstanceUid: 'reference-sop',
      },
      { mode: 'fixed-256' },
    );
    act(() =>
      setDerivedAlignmentFrame({
        date: '2025-01-01',
        seriesUid: 'series',
        bestSliceIndex: 0,
        nmiScore: 1,
        computedSettings: DEFAULT_PANEL_SETTINGS,
        slicesChecked: 1,
        runId: 'verified-run',
        outcome: 'aligned',
        outputGrid,
        derivedFrame: {
          pixels: new Float32Array(256 * 256),
          rows: 256,
          columns: 256,
          sourceImageId: 'miradb:inst-1',
          outputGrid,
        },
      }),
    );

    let unmountViewer: (() => void) | undefined;
    await act(async () => {
      ({ unmount: unmountViewer } = render(
        <DicomViewer
          studyId="study"
          seriesUid="series"
          instanceIndex={0}
          instanceCount={1}
          onInstanceChange={() => {}}
        />,
      ));
    });

    expect(screen.getByText(/256 × 256 interpolated from 2 × 2 acquisition/i)).toBeInTheDocument();
    await waitFor(() => expect(cornerstone.displayImage).toHaveBeenCalled());
    unmountViewer?.();
  });

  it('uses plain wheel events for slice navigation when zoom is available', async () => {
    const onZoomChange = vi.fn();
    const onInstanceChange = vi.fn();

    render(
      <DicomViewer
        studyId="study"
        seriesUid="series"
        instanceIndex={0}
        instanceCount={3}
        onInstanceChange={onInstanceChange}
        onZoomChange={onZoomChange}
        imageUrlOverride="test.png"
      />,
    );

    const img = await screen.findByRole('img');
    const ev = new WheelEvent('wheel', { deltaY: 100, cancelable: true, bubbles: true });
    img.dispatchEvent(ev);

    expect(ev.defaultPrevented).toBe(true);
    expect(onZoomChange).not.toHaveBeenCalled();
    expect(onInstanceChange).toHaveBeenCalledWith(1);
  });

  it('blocks direct slice and zoom wheel gestures while alignment owns the displayed image', async () => {
    const onZoomChange = vi.fn();
    const onInstanceChange = vi.fn();
    const onPanChange = vi.fn();
    const props = {
      studyId: 'study',
      seriesUid: 'series',
      instanceIndex: 0,
      instanceCount: 3,
      onInstanceChange,
      onZoomChange,
      onPanChange,
      imageUrlOverride: 'test.png',
    };
    const { rerender } = render(<DicomViewer {...props} interactionBlocked />);
    const image = await screen.findByRole('img');

    const blockedSlice = new WheelEvent('wheel', { deltaY: 100, cancelable: true, bubbles: true });
    const blockedZoom = new WheelEvent('wheel', {
      deltaY: -100,
      metaKey: true,
      cancelable: true,
      bubbles: true,
    });
    image.dispatchEvent(blockedSlice);
    image.dispatchEvent(blockedZoom);
    fireEvent.click(image, { clientX: 100, clientY: 100 });
    fireEvent.doubleClick(image);

    expect(onInstanceChange).not.toHaveBeenCalled();
    expect(onZoomChange).not.toHaveBeenCalled();
    expect(onPanChange).not.toHaveBeenCalled();
    expect(blockedSlice.defaultPrevented).toBe(false);

    rerender(<DicomViewer {...props} interactionBlocked={false} />);
    image.dispatchEvent(new WheelEvent('wheel', { deltaY: 100, cancelable: true, bubbles: true }));
    expect(onInstanceChange).toHaveBeenCalledWith(1);
    fireEvent.click(image, { clientX: 100, clientY: 100 });
    fireEvent.doubleClick(image);
    expect(onPanChange).toHaveBeenCalledWith(0, 0);
  });

  it('zooms hovered images on Command+wheel', async () => {
    const onZoomChange = vi.fn();

    render(
      <DicomViewer
        studyId="study"
        seriesUid="series"
        instanceIndex={0}
        instanceCount={3}
        onInstanceChange={() => {}}
        onZoomChange={onZoomChange}
        imageUrlOverride="test.png"
        zoom={1}
      />,
    );

    const img = await screen.findByRole('img');
    const ev = new WheelEvent('wheel', { deltaY: -100, metaKey: true, cancelable: true, bubbles: true });
    img.dispatchEvent(ev);

    expect(ev.defaultPrevented).toBe(true);
    expect(onZoomChange).toHaveBeenCalledTimes(1);
    expect(onZoomChange.mock.calls[0]?.[0]).toBeGreaterThan(1);
  });

  it('keeps previous visual settings until the new Cornerstone image is displayed (async swap)', async () => {
    const deferredImageId = createDeferred<string>();

    vi.mocked(getImageIdForInstance)
      .mockImplementationOnce(async () => 'miradb:old')
      .mockImplementationOnce(() => deferredImageId.promise);

    const { rerender } = render(
      <DicomViewer
        studyId="study"
        seriesUid="series-old"
        instanceIndex={0}
        instanceCount={1}
        onInstanceChange={() => {}}
        brightness={100}
        contrast={100}
        zoom={1}
        rotation={0}
      />,
    );

    await waitFor(() => {
      expect(cornerstone.displayImage).toHaveBeenCalled();
    });

    const content = screen.getByLabelText('Slice 1');
    const wrapper = content.parentElement as HTMLElement;

    expect(wrapper.style.filter).toBe('brightness(1) contrast(1)');
    expect(wrapper.style.transform).toContain('scale(1)');
    expect(wrapper.style.transform).toContain('rotate(0deg)');

    // Swap to a new contentKey + new visual settings, but keep imageId stale by not resolving.
    rerender(
      <DicomViewer
        studyId="study"
        seriesUid="series-new"
        instanceIndex={0}
        instanceCount={1}
        onInstanceChange={() => {}}
        brightness={150}
        contrast={120}
        zoom={2}
        rotation={45}
      />,
    );

    // The previous image should keep the previous filter/transform until the new image loads.
    expect(wrapper.style.filter).toBe('brightness(1) contrast(1)');
    expect(wrapper.style.transform).toContain('scale(1)');
    expect(wrapper.style.transform).toContain('rotate(0deg)');

    // Now allow the new imageId to resolve and be displayed.
    deferredImageId.resolve('miradb:new');

    await waitFor(() => {
      expect(wrapper.style.filter).toBe('brightness(1.5) contrast(1.2)');
      expect(wrapper.style.transform).toContain('scale(2)');
      expect(wrapper.style.transform).toContain('rotate(45deg)');
    });
  });
});
