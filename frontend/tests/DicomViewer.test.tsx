import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DicomViewer } from '../src/components/DicomViewer';
import { DEBUG_ALIGNMENT_STORAGE_KEY } from '../src/utils/debugAlignment';
import {
  recordAlignmentSliceScore,
  resetAlignmentSliceScoreStore,
  type AlignmentSliceScoreMetrics,
} from '../src/utils/alignmentSliceScoreStore';
import { getImageIdForInstance } from '../src/utils/localApi';

vi.mock('../src/utils/localApi', () => ({
  getImageIdForInstance: vi.fn().mockResolvedValue('miradb:inst-1'),
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
  localStorage.removeItem(DEBUG_ALIGNMENT_STORAGE_KEY);
  resetAlignmentSliceScoreStore({
    referenceSeriesUid: 'reference-series',
    referenceSliceIndex: 10,
  });

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
  fireEvent.keyUp(window, { key: 'z' });
  localStorage.removeItem(DEBUG_ALIGNMENT_STORAGE_KEY);
  resetAlignmentSliceScoreStore({
    referenceSeriesUid: 'reference-series',
    referenceSliceIndex: 10,
  });
});

describe('DicomViewer', () => {
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
      />
    );

    const img = await screen.findByRole('img');
    expect(img).toHaveAttribute('src', 'test.png');
  });

  it('loads Cornerstone image when no override', async () => {
    render(
      <DicomViewer
        studyId="study"
        seriesUid="series"
        instanceIndex={0}
        instanceCount={1}
        onInstanceChange={() => {}}
      />
    );

    await waitFor(() => {
      expect(cornerstone.loadImage).toHaveBeenCalled();
    });
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
      />
    );

    const img = await screen.findByRole('img');
    const ev = new WheelEvent('wheel', { deltaY: 100, cancelable: true, bubbles: true });
    img.dispatchEvent(ev);

    expect(ev.defaultPrevented).toBe(true);
    expect(onZoomChange).not.toHaveBeenCalled();
    expect(onInstanceChange).toHaveBeenCalledWith(1);
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
      />
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
      />
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
      />
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
