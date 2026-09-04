import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ComponentProps } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DerivedAlignmentFrame } from '../src/utils/derivedAlignmentFrame';
import type { AlignmentResult } from '../src/types/api';
import type * as DerivedImages from '../src/utils/derivedImagePresentation';
import { DEFAULT_PANEL_SETTINGS } from '../src/utils/constants';
import { deferred } from './helpers/deferred';

const mocks = vi.hoisted(() => ({
  frame: null as DerivedAlignmentFrame | null,
  request: vi.fn(),
  present: vi.fn(),
  lookup: vi.fn(),
}));
vi.mock('../src/utils/sharpSliceDisplay', () => ({ requestSharpSliceDisplay: mocks.request }));
vi.mock('../src/utils/derivedImagePresentation', async (importOriginal) => ({
  ...(await importOriginal<typeof DerivedImages>()),
  createDerivedImagePresentation: mocks.present,
}));
vi.mock('../src/utils/localApi', () => ({ getImageIdForInstance: mocks.lookup }));
vi.mock('../src/hooks/useAlignedFrame', () => ({
  useAlignedFrame: () => ({ frame: mocks.frame, pending: false, status: 'ready', settings: undefined }),
}));
vi.mock('cornerstone-core', () => ({
  default: {
    enable: vi.fn(),
    disable: vi.fn(),
    resize: vi.fn(),
    loadImage: vi.fn(),
    displayImage: vi.fn(),
    getDefaultViewportForImage: vi.fn().mockReturnValue({}),
  },
}));

import cornerstone from 'cornerstone-core';
import { DicomViewer } from '../src/components/DicomViewer';
import { SharpSliceDisplayContext } from '../src/hooks/useSharpSliceDisplay';

const replacement = {
  pixels: Float32Array.from([1, 2.2, 2.8, 4]),
  valid: new Uint8Array(4).fill(1),
  rows: 2,
  columns: 2,
  stats: { method: 'synthetic-test', durationMs: 1, synthesizedPlanes: 1 },
};

function frame(id = 'first', instanceIndex = 0): DerivedAlignmentFrame {
  return {
    imageId: `miraderived:${id}`,
    runId: `synthetic-${id}`,
    seriesUid: 'synthetic-series',
    instanceIndex,
    sourceImageId: 'miradb:synthetic-source',
    pixels: Float32Array.from([1, 2, 3, 4]),
    valid: new Uint8Array(4).fill(1),
    rows: 2,
    columns: 2,
  };
}

function acceptedFrame(content: DerivedAlignmentFrame, runId = content.runId): DerivedAlignmentFrame {
  const acceptedResult: AlignmentResult = {
    date: 'synthetic-date',
    seriesUid: content.seriesUid,
    bestSliceIndex: content.instanceIndex,
    nmiScore: 1,
    computedSettings: DEFAULT_PANEL_SETTINGS,
    slicesChecked: 1,
    outcome: 'aligned',
    runId,
    derivedFrame: content,
  };
  return { ...content, runId, acceptedResult };
}

function image(imageId: string, source = mocks.frame) {
  return {
    imageId,
    rows: 2,
    columns: 2,
    height: 2,
    width: 2,
    windowCenter: 2,
    windowWidth: 4,
    slope: 1,
    intercept: 0,
    derivedSource: source ? new WeakRef(source) : undefined,
    getPixelData: () => Uint16Array.from([1, 2, 3, 4]),
  };
}

function viewer(enabled: boolean, suspended = false, overrides: Partial<ComponentProps<typeof DicomViewer>> = {}) {
  return (
    <SharpSliceDisplayContext value={{ enabled, suspended }}>
      <DicomViewer
        {...DEFAULT_PANEL_SETTINGS}
        studyId="synthetic-study"
        seriesUid="synthetic-series"
        instanceIndex={0}
        instanceCount={10}
        brightness={140}
        contrast={115}
        zoom={1.5}
        rotation={9}
        panX={0.1}
        panY={-0.2}
        affine01={0.05}
        onInstanceChange={vi.fn()}
        {...overrides}
      />
    </SharpSliceDisplayContext>
  );
}

beforeEach(() => {
  mocks.frame = frame();
  mocks.request.mockReset();
  mocks.present
    .mockReset()
    .mockImplementation(async (source: DerivedAlignmentFrame, imageId: string, predicted?: typeof replacement) => ({
      ...image(imageId, source),
      windowCenter: source.displayTone?.windowCenter ?? 2,
      windowWidth: source.displayTone?.windowWidth ?? 4,
      getPixelData: () => Uint16Array.from(predicted?.pixels ?? source.pixels),
    }));
  mocks.lookup.mockReset().mockResolvedValue('miradb:synthetic-native');
  vi.mocked(cornerstone.loadImage)
    .mockReset()
    .mockImplementation(async (id: string) => image(id));
  vi.mocked(cornerstone.displayImage).mockReset();
  vi.mocked(cornerstone.enable).mockClear();
  vi.mocked(cornerstone.disable).mockClear();
  vi.spyOn(Element.prototype, 'clientWidth', 'get').mockReturnValue(400);
  vi.spyOn(Element.prototype, 'clientHeight', 'get').mockReturnValue(200);
  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 0, 400, 200));
});

afterEach(() => vi.restoreAllMocks());

describe('DicomViewer sharp slice display', () => {
  it.each(['pending', 'ready'])(
    'keeps %s sharp work when a new request replays unchanged plane content',
    async (stage) => {
      const content = frame();
      mocks.frame = acceptedFrame(content);
      const job = deferred<typeof replacement>();
      mocks.request.mockReturnValue(job.promise);
      const { rerender } = render(viewer(true));
      const canvas = await screen.findByLabelText('Slice 1');
      await waitFor(() => expect(canvas).toHaveAttribute('data-image-id', content.imageId));
      await waitFor(() => expect(mocks.request).toHaveBeenCalledOnce());
      const signal = mocks.request.mock.calls[0]![1].signal as AbortSignal;
      if (stage === 'ready') {
        await act(async () => job.resolve(replacement));
        await waitFor(() => expect(canvas.getAttribute('data-image-id')).toMatch(/:sharp:/));
      }
      const displayedId = canvas.getAttribute('data-image-id');

      mocks.frame = acceptedFrame(content, 'replayed-display-request');
      rerender(viewer(true, false, { brightness: 150, panX: 0.2 }));
      await act(async () => {});

      expect(mocks.request).toHaveBeenCalledOnce();
      expect(cornerstone.loadImage).toHaveBeenCalledOnce();
      expect(mocks.present).toHaveBeenCalledTimes(stage === 'ready' ? 1 : 0);
      expect(canvas).toHaveAttribute('data-image-id', displayedId);
      expect(canvas.parentElement!.style.filter).toBe('brightness(1.5) contrast(1.15)');
      if (stage === 'pending') {
        expect(signal.aborted).toBe(false);
        await act(async () => job.resolve(replacement));
        await waitFor(() => expect(canvas.getAttribute('data-image-id')).toMatch(/:sharp:/));
        expect(mocks.present).toHaveBeenCalledOnce();
      }
    },
  );

  it('keeps original pixels visible until ready, then switches variants in place without changing geometry or controls', async () => {
    const job = deferred<typeof replacement>();
    mocks.request.mockReturnValue(job.promise);
    const onPanChange = vi.fn();
    const onZoomChange = vi.fn();
    const { rerender } = render(viewer(true, false, { onPanChange, onZoomChange }));
    const content = await screen.findByLabelText('Slice 1');
    await waitFor(() => expect(content).toHaveAttribute('data-image-id', 'miraderived:first'));
    const originalImage = vi.mocked(cornerstone.displayImage).mock.calls.at(-1)![1];
    const wrapper = content.parentElement!;
    const originalStyle = wrapper.getAttribute('style');
    expect(screen.getByRole('status')).toHaveTextContent('Preparing sharp slice… · Original shown');
    expect(onPanChange).not.toHaveBeenCalled();
    expect(onZoomChange).not.toHaveBeenCalled();

    await act(async () => job.resolve(replacement));
    await waitFor(() => expect(content.getAttribute('data-image-id')).toMatch(/^miraderived:first:sharp:/));
    expect(screen.getByRole('status')).toHaveTextContent('Synthesized detail · Experimental');
    expect(screen.getByRole('status')).not.toContainElement(content);
    expect(wrapper).not.toContainElement(screen.getByRole('status'));
    expect(wrapper.getAttribute('style')).toBe(originalStyle);
    expect(cornerstone.enable).toHaveBeenCalledOnce();
    expect(cornerstone.disable).not.toHaveBeenCalled();
    const sourceLoads = vi.mocked(cornerstone.loadImage).mock.calls.length;

    rerender(viewer(false, false, { onPanChange, onZoomChange }));
    await waitFor(() => expect(content).toHaveAttribute('data-image-id', 'miraderived:first'));
    expect(vi.mocked(cornerstone.displayImage).mock.calls.at(-1)![1]).toBe(originalImage);
    expect(cornerstone.loadImage).toHaveBeenCalledTimes(sourceLoads);
    expect(screen.getByLabelText('Slice 1')).toBe(content);
    expect(wrapper.getAttribute('style')).toBe(originalStyle);
    expect(onPanChange).not.toHaveBeenCalled();
    expect(onZoomChange).not.toHaveBeenCalled();
    expect(mocks.frame?.pixels).toEqual(Float32Array.from([1, 2, 3, 4]));
    rerender(viewer(true, false, { onPanChange, onZoomChange }));
    await waitFor(() => expect(content.getAttribute('data-image-id')).toMatch(/^miraderived:first:sharp:/));
    expect(mocks.request).toHaveBeenCalledOnce();
    expect(mocks.present).toHaveBeenCalledOnce();
    expect(cornerstone.loadImage).toHaveBeenCalledTimes(sourceLoads);
  });

  it('holds the displayed variant during pan, including an Original toggle, and commits just one manual endpoint', async () => {
    mocks.request.mockResolvedValue(replacement);
    const onPanChange = vi.fn();
    const { rerender } = render(viewer(true, false, { onPanChange }));
    const content = await screen.findByLabelText('Slice 1');
    await waitFor(() => expect(content.getAttribute('data-image-id')).toMatch(/^miraderived:first:sharp:/));
    const viewport = screen.getByRole('group', { name: 'Pan MRI slice 1' });
    const pointer = { pointerId: 7, isPrimary: true, button: 0 };
    fireEvent.pointerDown(viewport, { ...pointer, clientX: 100, clientY: 100 });
    fireEvent.pointerMove(viewport, { ...pointer, clientX: 180, clientY: 70 });
    const rendersBeforeToggle = vi.mocked(cornerstone.displayImage).mock.calls.length;
    const previewTransform = content.parentElement!.style.transform;
    const translation = previewTransform.match(/^translate\(([-\d.e]+)px, ([-\d.e]+)px\)/)!;
    expect(Number(translation[1])).toBeCloseTo(120, 10);
    expect(Number(translation[2])).toBeCloseTo(-70, 10);

    rerender(viewer(false, false, { onPanChange }));
    await act(async () => {});
    expect(content.getAttribute('data-image-id')).toMatch(/^miraderived:first:sharp:/);
    expect(screen.getByRole('status')).toHaveTextContent('Synthesized detail');
    expect(cornerstone.displayImage).toHaveBeenCalledTimes(rendersBeforeToggle);
    expect(content.parentElement!.style.transform).toBe(previewTransform);
    expect(onPanChange).not.toHaveBeenCalled();

    fireEvent.pointerUp(viewport, { ...pointer, clientX: 180, clientY: 70 });
    expect(onPanChange).toHaveBeenCalledOnce();
    expect(onPanChange.mock.calls[0]![0]).toBeCloseTo(0.3);
    expect(onPanChange.mock.calls[0]![1]).toBeCloseTo(-0.35);
    await waitFor(() => expect(content).toHaveAttribute('data-image-id', 'miraderived:first'));
  });

  it('cancels pending synthesis during a gesture and cannot paint its late completion', async () => {
    const job = deferred<typeof replacement>();
    mocks.request.mockReturnValue(job.promise);
    render(viewer(true, false, { onPanChange: vi.fn() }));
    const content = await screen.findByLabelText('Slice 1');
    await waitFor(() => expect(content).toHaveAttribute('data-image-id', 'miraderived:first'));
    await waitFor(() => expect(mocks.request).toHaveBeenCalledOnce());
    const signal = mocks.request.mock.calls[0]![1].signal;
    fireEvent.pointerDown(screen.getByRole('group', { name: 'Pan MRI slice 1' }), {
      pointerId: 7,
      isPrimary: true,
      button: 0,
      clientX: 100,
      clientY: 100,
    });
    expect(signal.aborted).toBe(true);
    await act(async () => job.resolve(replacement));
    expect(mocks.present).not.toHaveBeenCalled();
    expect(content).toHaveAttribute('data-image-id', 'miraderived:first');
  });

  it('does not freeze original slice browsing or initial display while enhancement is suspended', async () => {
    const { rerender } = render(viewer(true, true));
    const content = await screen.findByLabelText('Slice 1');
    await waitFor(() => expect(content).toHaveAttribute('data-image-id', 'miraderived:first'));
    mocks.frame = frame('second', 1);
    rerender(viewer(true, true, { instanceIndex: 1 }));
    await waitFor(() => expect(content).toHaveAttribute('data-image-id', 'miraderived:second'));
    expect(mocks.request).not.toHaveBeenCalled();
    expect(cornerstone.enable).toHaveBeenCalledOnce();
  });

  it('holds old pixels and tone until a new anatomical source is actually ready', async () => {
    mocks.request.mockResolvedValueOnce(replacement).mockReturnValue(new Promise(() => {}));
    const { rerender } = render(viewer(true));
    const content = await screen.findByLabelText('Slice 1');
    await waitFor(() => expect(content.getAttribute('data-image-id')).toMatch(/^miraderived:first:sharp:/));
    const originalStyle = content.parentElement!.getAttribute('style');
    const nextOriginal = deferred<ReturnType<typeof image>>();
    vi.mocked(cornerstone.loadImage).mockImplementationOnce(() => nextOriginal.promise);
    mocks.frame = frame('second', 1);
    rerender(viewer(true, false, { instanceIndex: 1, brightness: 180, zoom: 2 }));
    await act(async () => {});
    expect(content.getAttribute('data-image-id')).toMatch(/^miraderived:first:sharp:/);
    expect(content.parentElement!.getAttribute('style')).toBe(originalStyle);

    await act(async () => nextOriginal.resolve(image('miraderived:second')));
    await waitFor(() => expect(content).toHaveAttribute('data-image-id', 'miraderived:second'));
    expect(content.parentElement?.style.filter).toBe('brightness(1.8) contrast(1.15)');
    expect(content.parentElement?.style.transform).toContain('scale(2)');
    expect(screen.getByRole('status')).toHaveTextContent('Original shown');
  });

  it('leaves a readable original when enhancement computation or display fails', async () => {
    mocks.request.mockRejectedValueOnce(new Error('Not enough native neighbors'));
    const { rerender } = render(viewer(true));
    const content = await screen.findByLabelText('Slice 1');
    await waitFor(() => expect(content).toHaveAttribute('data-image-id', 'miraderived:first'));
    await waitFor(() =>
      expect(screen.getByRole('status')).toHaveTextContent('Sharp slice unavailable · Original shown'),
    );
    expect(screen.getByRole('status')).toHaveAttribute('title', 'Not enough native neighbors');
    expect(screen.queryByText('Failed to load image')).not.toBeInTheDocument();

    rerender(viewer(false));
    mocks.request.mockResolvedValue(replacement);
    vi.mocked(cornerstone.displayImage).mockImplementation((_element: unknown, source: { imageId: string }) => {
      if (source.imageId.includes(':sharp:')) throw new Error('Synthetic display rejected');
    });
    rerender(viewer(true));
    await waitFor(() => expect(mocks.present).toHaveBeenCalledOnce());
    await waitFor(() =>
      expect(screen.getByRole('status')).toHaveTextContent('Sharp slice unavailable · Original shown'),
    );
    expect(content).toHaveAttribute('data-image-id', 'miraderived:first');
    expect(screen.queryByText('Failed to load image')).not.toBeInTheDocument();
  });

  it.each([
    { enabled: false, reusePixels: false },
    { enabled: true, reusePixels: false },
    { enabled: false, reusePixels: true },
    { enabled: true, reusePixels: true },
  ])(
    'refreshes same-ID content and tone, then restores the current baseline: sharp=$enabled, reuse pixels=$reusePixels',
    async ({ enabled, reusePixels }) => {
      const firstContent = frame();
      const first = acceptedFrame(firstContent);
      mocks.frame = first;
      const cachedPredecessor = image(first.imageId, first);
      vi.mocked(cornerstone.loadImage).mockResolvedValue(cachedPredecessor);
      mocks.request.mockResolvedValue(replacement);
      const { rerender } = render(viewer(enabled));
      const content = await screen.findByLabelText('Slice 1');
      await waitFor(() => expect(cornerstone.displayImage).toHaveBeenCalled());
      if (enabled) await waitFor(() => expect(content.getAttribute('data-image-id')).toMatch(/:sharp:/));
      const previousDisplayedId = content.getAttribute('data-image-id');
      const previousStyle = content.parentElement!.getAttribute('style');
      const currentPixels = reusePixels ? firstContent.pixels : Float32Array.from([7, 8, 9, 10]);
      const current = acceptedFrame({
        ...firstContent,
        pixels: currentPixels,
        displayTone: { windowCenter: 82, windowWidth: 164, source: [0.25, 0.75], reference: [0.25, 0.75] },
      });
      mocks.frame = current;
      rerender(viewer(enabled));

      await waitFor(() =>
        expect(
          mocks.present.mock.calls.some(([source, , prediction]) => source === current && prediction === undefined),
        ).toBe(true),
      );
      const originalCall = mocks.present.mock.calls.findIndex(
        ([source, , prediction]) => source === current && prediction === undefined,
      );
      const currentOriginal = await mocks.present.mock.results[originalCall]!.value;
      expect(currentOriginal.imageId).not.toBe(cachedPredecessor.imageId);
      expect(currentOriginal.getPixelData()).toEqual(Uint16Array.from(currentPixels));
      expect(currentOriginal.windowCenter).toBe(82);
      expect(currentOriginal.windowWidth).toBe(164);

      if (enabled) {
        await waitFor(() => {
          expect(content.getAttribute('data-image-id')).toMatch(/:sharp:/);
          expect(content.getAttribute('data-image-id')).not.toBe(previousDisplayedId);
        });
        rerender(viewer(false));
      }
      await waitFor(() => expect(vi.mocked(cornerstone.displayImage).mock.calls.at(-1)![1]).toBe(currentOriginal));
      expect(content.parentElement!.getAttribute('style')).toBe(previousStyle);
      expect(first.pixels).toEqual(Float32Array.from([1, 2, 3, 4]));
      expect(current.pixels).toBe(currentPixels);
      expect(cornerstone.enable).toHaveBeenCalledOnce();
      expect(cornerstone.disable).not.toHaveBeenCalled();
      expect(mocks.request).toHaveBeenCalledTimes(enabled ? 2 : 0);
    },
  );
});
