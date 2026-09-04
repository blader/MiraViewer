import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { ComponentProps } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DicomViewer } from '../src/components/DicomViewer';

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

type ViewerProps = ComponentProps<typeof DicomViewer>;
const primaryPointer = { pointerId: 7, isPrimary: true, pointerType: 'mouse', button: 0 };
const identityTransform = 'scale(1) rotate(0deg) matrix(1, 0, 0, 1, 0, 0)';

function renderViewer(overrides: Partial<ViewerProps> = {}) {
  const onPanChange = vi.fn();
  const props = {
    studyId: 'study-a',
    seriesUid: 'series-a',
    instanceIndex: 1,
    instanceCount: 5,
    onInstanceChange: vi.fn(),
    imageUrlOverride: 'slice.png',
    panX: 0.125,
    panY: -0.25,
    onPanChange,
    ...overrides,
  };
  const view = render(<DicomViewer {...props} />);
  const viewport = screen.getByRole('group', { name: 'Pan MRI slice 2' });
  const image = screen.getByRole('img', { name: 'Slice 2' });
  fireEvent.load(image);

  const capturedPointers = new Set<number>();
  const setPointerCapture = vi.fn((id: number) => capturedPointers.add(id));
  const releasePointerCapture = vi.fn((id: number) => capturedPointers.delete(id));
  Object.assign(viewport, {
    setPointerCapture,
    hasPointerCapture: (id: number) => capturedPointers.has(id),
    releasePointerCapture,
  });

  return { ...view, props, viewport, image, onPanChange, setPointerCapture, releasePointerCapture };
}

function startPan(viewport: HTMLElement) {
  fireEvent.pointerDown(viewport, { ...primaryPointer, clientX: 100, clientY: 100 });
  fireEvent.pointerMove(viewport, { ...primaryPointer, clientX: 180, clientY: 70 });
}

beforeEach(() => {
  vi.spyOn(Element.prototype, 'clientWidth', 'get').mockReturnValue(400);
  vi.spyOn(Element.prototype, 'clientHeight', 'get').mockReturnValue(200);
  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockReturnValue(new DOMRect(40, 60, 400, 200));
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('DicomViewer drag to pan', () => {
  it.each([
    { pointerType: 'mouse', transform: {}, suffix: identityTransform },
    {
      pointerType: 'touch',
      transform: { zoom: 3, rotation: 90, affine00: 1.5, affine01: 0.25, affine10: 0.5, affine11: 0.75 },
      suffix: 'scale(3) rotate(90deg) matrix(1.5, 0.5, 0.25, 0.75, 0, 0)',
    },
    {
      pointerType: 'pen',
      transform: { zoom: 0.5, rotation: -37, affine00: 0.8, affine01: -0.5, affine10: 0.25, affine11: 1.2 },
      suffix: 'scale(0.5) rotate(-37deg) matrix(0.8, 0.25, -0.5, 1.2, 0, 0)',
    },
  ])(
    'previews a primary $pointerType drag in screen axes and saves the release endpoint once',
    ({ pointerType, transform, suffix }) => {
      const { viewport, image, props, onPanChange, setPointerCapture, releasePointerCapture, rerender } =
        renderViewer(transform);
      const pointer = { ...primaryPointer, pointerType };
      expect(viewport).toHaveStyle({ cursor: 'grab' });
      expect(viewport).toHaveAttribute('tabindex', '0');
      expect(viewport).toHaveClass('touch-none');
      expect(image.parentElement).toHaveStyle({ transform: `translate(50px, -50px) ${suffix}` });

      fireEvent.pointerDown(viewport, { ...pointer, clientX: 100, clientY: 100 });
      expect(setPointerCapture).toHaveBeenCalledExactlyOnceWith(7);
      expect(viewport).toHaveFocus();
      expect(viewport).toHaveStyle({ cursor: 'grabbing' });

      fireEvent.pointerMove(viewport, { ...pointer, clientX: 140, clientY: 90 });
      fireEvent.pointerMove(viewport, { ...pointer, clientX: 180, clientY: 70 });
      // Starting translation (50, -50) plus screen movement (80, -30), regardless of image transform.
      expect(image.parentElement).toHaveStyle({ transform: `translate(130px, -80px) ${suffix}` });
      expect(onPanChange).not.toHaveBeenCalled();
      expect(releasePointerCapture).not.toHaveBeenCalled();

      fireEvent.pointerUp(viewport, { ...pointer, clientX: 220, clientY: 120 });
      expect(onPanChange).toHaveBeenCalledOnce();
      expect(onPanChange.mock.calls[0][0]).toBeCloseTo(0.425);
      expect(onPanChange.mock.calls[0][1]).toBeCloseTo(-0.15);
      expect(releasePointerCapture).toHaveBeenCalledExactlyOnceWith(7);
      expect(viewport).toHaveStyle({ cursor: 'grab' });

      rerender(<DicomViewer {...props} panX={0.425} panY={-0.15} />);
      expect(image.parentElement).toHaveStyle({ transform: `translate(170px, -30px) ${suffix}` });
      fireEvent.pointerUp(viewport, { ...pointer, clientX: 250, clientY: 160 });
      expect(onPanChange).toHaveBeenCalledOnce();
    },
  );

  it('does not recenter on a click or a press and release without movement', () => {
    const { viewport, image, onPanChange, releasePointerCapture } = renderViewer();
    fireEvent.click(viewport, { clientX: 350, clientY: 80 });
    fireEvent.pointerDown(viewport, { ...primaryPointer, clientX: 350, clientY: 80 });
    fireEvent.pointerUp(viewport, { ...primaryPointer, clientX: 350, clientY: 80 });
    fireEvent.click(viewport, { clientX: 350, clientY: 80 });

    expect(onPanChange).not.toHaveBeenCalled();
    expect(image.parentElement).toHaveStyle({ transform: `translate(50px, -50px) ${identityTransform}` });
    expect(viewport).toHaveStyle({ cursor: 'grab' });
    expect(releasePointerCapture).toHaveBeenCalledExactlyOnceWith(7);
  });

  it('moves saved annotations with the live image preview without persisting intermediate positions', () => {
    const { viewport, props, onPanChange, rerender } = renderViewer({
      children: <span data-testid="saved-annotation">Saved mask</span>,
    });
    const annotationLayer = screen.getByTestId('saved-annotation').parentElement!;
    const expectAnnotationTranslation = (x: number, y: number) => {
      const translation = annotationLayer.style.transform.match(/^translate\(([-\d.e]+)px, ([-\d.e]+)px\)$/);
      expect(translation).not.toBeNull();
      expect(Number(translation![1])).toBeCloseTo(x, 10);
      expect(Number(translation![2])).toBeCloseTo(y, 10);
    };
    expectAnnotationTranslation(0, 0);
    expect(annotationLayer).toHaveClass('pointer-events-none');
    expect(viewport).not.toContainElement(annotationLayer);

    startPan(viewport);
    expectAnnotationTranslation(80, -30);
    expect(onPanChange).not.toHaveBeenCalled();

    fireEvent.pointerUp(viewport, { ...primaryPointer, clientX: 180, clientY: 70 });
    expect(onPanChange).toHaveBeenCalledOnce();
    rerender(<DicomViewer {...props} panX={0.325} panY={-0.4} />);
    expectAnnotationTranslation(0, 0);

    startPan(viewport);
    expectAnnotationTranslation(80, -30);
    fireEvent.pointerCancel(viewport, primaryPointer);
    expectAnnotationTranslation(0, 0);
    expect(onPanChange).toHaveBeenCalledOnce();
  });

  it.each(['double-click', 'Enter'])('resets pan with %s and discards any active drag', (action) => {
    const { viewport, onPanChange, releasePointerCapture } = renderViewer();
    startPan(viewport);

    if (action === 'double-click') fireEvent.doubleClick(viewport);
    else fireEvent.keyDown(viewport, { key: action });

    expect(onPanChange).toHaveBeenCalledExactlyOnceWith(0, 0);
    expect(releasePointerCapture).toHaveBeenCalledExactlyOnceWith(7);
    expect(viewport).toHaveStyle({ cursor: 'grab' });
    fireEvent.pointerUp(viewport, { ...primaryPointer, clientX: 220, clientY: 120 });
    expect(onPanChange).toHaveBeenCalledOnce();
  });

  it('leaves Space available for hold-to-compare without resetting pan', () => {
    const { viewport, image, onPanChange } = renderViewer();
    const compareShortcut = vi.fn();
    window.addEventListener('keydown', compareShortcut);
    try {
      const event = new KeyboardEvent('keydown', { key: ' ', bubbles: true, cancelable: true });
      fireEvent(viewport, event);
      expect(compareShortcut).toHaveBeenCalledOnce();
      expect(event.defaultPrevented).toBe(false);
      expect(onPanChange).not.toHaveBeenCalled();
      expect(image.parentElement).toHaveStyle({ transform: `translate(50px, -50px) ${identityTransform}` });
    } finally {
      window.removeEventListener('keydown', compareShortcut);
    }
  });

  it.each([
    { name: 'right mouse button', modifiers: { button: 2 } },
    { name: 'middle mouse button', modifiers: { button: 1 } },
    { name: 'secondary touch', modifiers: { isPrimary: false, pointerType: 'touch' } },
  ])('ignores the $name', ({ modifiers }) => {
    const { viewport, image, onPanChange, setPointerCapture } = renderViewer();
    const pointer = { ...primaryPointer, ...modifiers };
    fireEvent.pointerDown(viewport, { ...pointer, clientX: 100, clientY: 100 });
    fireEvent.pointerMove(viewport, { ...pointer, clientX: 180, clientY: 70 });
    fireEvent.pointerUp(viewport, { ...pointer, clientX: 220, clientY: 120 });

    expect(setPointerCapture).not.toHaveBeenCalled();
    expect(onPanChange).not.toHaveBeenCalled();
    expect(viewport).toHaveStyle({ cursor: 'grab' });
    expect(image.parentElement).toHaveStyle({ transform: `translate(50px, -50px) ${identityTransform}` });
  });

  it('does not let another pointer move, finish, cancel, or replace an active drag', () => {
    const { viewport, image, onPanChange, setPointerCapture, releasePointerCapture } = renderViewer();
    startPan(viewport);
    const otherPointer = { ...primaryPointer, pointerId: 8, clientX: 350, clientY: 190 };
    fireEvent.pointerDown(viewport, otherPointer);
    fireEvent.pointerMove(viewport, otherPointer);
    fireEvent.pointerUp(viewport, otherPointer);
    fireEvent.pointerCancel(viewport, otherPointer);
    fireEvent.lostPointerCapture(viewport, otherPointer);

    expect(setPointerCapture).toHaveBeenCalledExactlyOnceWith(7);
    expect(releasePointerCapture).not.toHaveBeenCalled();
    expect(onPanChange).not.toHaveBeenCalled();
    expect(viewport).toHaveStyle({ cursor: 'grabbing' });
    expect(image.parentElement).toHaveStyle({ transform: `translate(130px, -80px) ${identityTransform}` });

    fireEvent.pointerUp(viewport, { ...primaryPointer, clientX: 220, clientY: 120 });
    expect(onPanChange).toHaveBeenCalledOnce();
    expect(onPanChange.mock.calls[0][0]).toBeCloseTo(0.425);
    expect(onPanChange.mock.calls[0][1]).toBeCloseTo(-0.15);
  });

  it.each(['pointer cancel', 'lost pointer capture', 'Escape', 'window blur'])(
    'discards the preview without saving on %s',
    (reason) => {
      const { viewport, image, onPanChange, releasePointerCapture } = renderViewer();
      startPan(viewport);
      if (reason === 'pointer cancel') fireEvent.pointerCancel(viewport, primaryPointer);
      else if (reason === 'lost pointer capture') fireEvent.lostPointerCapture(viewport, primaryPointer);
      else if (reason === 'Escape') fireEvent.keyDown(viewport, { key: 'Escape' });
      else fireEvent(window, new Event('blur'));

      expect(onPanChange).not.toHaveBeenCalled();
      expect(releasePointerCapture).toHaveBeenCalledExactlyOnceWith(7);
      expect(viewport).toHaveStyle({ cursor: 'grab' });
      expect(image.parentElement).toHaveStyle({ transform: `translate(50px, -50px) ${identityTransform}` });
      fireEvent.pointerUp(viewport, { ...primaryPointer, clientX: 220, clientY: 120 });
      expect(onPanChange).not.toHaveBeenCalled();
    },
  );

  it.each<[string, Partial<ViewerProps>, number, number]>([
    ['study owner changes', { studyId: 'study-b' }, 50, -50],
    ['series owner changes', { seriesUid: 'series-b' }, 50, -50],
    ['slice changes', { instanceIndex: 3 }, 50, -50],
    ['effective slice reverses', { reverseSliceOrder: true }, 50, -50],
    ['displayed image changes', { imageUrlOverride: 'next-slice.png' }, 50, -50],
    ['starting horizontal pan changes', { panX: 0.25 }, 100, -50],
    ['starting vertical pan changes', { panY: 0.125 }, 50, 25],
    ['another tool blocks interaction', { interactionBlocked: true }, 50, -50],
    ['pan callback is removed', { onPanChange: undefined }, 50, -50],
  ])('cancels a stale gesture when %s', (_reason, changes, expectedX, expectedY) => {
    const { viewport, props, onPanChange, releasePointerCapture, rerender } = renderViewer();
    startPan(viewport);
    const nextOnPanChange = vi.fn();
    const nextProps = { ...props, onPanChange: nextOnPanChange, ...changes };
    rerender(<DicomViewer {...nextProps} />);

    expect(releasePointerCapture).toHaveBeenCalledExactlyOnceWith(7);
    expect(viewport).not.toHaveStyle({ cursor: 'grabbing' });
    expect(screen.getByRole('img').parentElement).toHaveStyle({
      transform: `translate(${expectedX}px, ${expectedY}px) ${identityTransform}`,
    });

    // Re-enabling pan must not revive the old pointer or route its release to the new owner.
    rerender(<DicomViewer {...nextProps} interactionBlocked={false} onPanChange={nextOnPanChange} />);
    fireEvent.pointerMove(viewport, { ...primaryPointer, clientX: 350, clientY: 190 });
    fireEvent.pointerUp(viewport, { ...primaryPointer, clientX: 350, clientY: 190 });
    expect(onPanChange).not.toHaveBeenCalled();
    expect(nextOnPanChange).not.toHaveBeenCalled();
  });

  it.each<Partial<ViewerProps>>([{ interactionBlocked: true }, { onPanChange: undefined }])(
    'does not start or reset pan when unavailable: %j',
    (props) => {
      const { viewport, image, onPanChange, setPointerCapture } = renderViewer(props);
      startPan(viewport);
      fireEvent.pointerUp(viewport, { ...primaryPointer, clientX: 220, clientY: 120 });
      fireEvent.doubleClick(viewport);
      fireEvent.keyDown(viewport, { key: 'Enter' });

      expect(setPointerCapture).not.toHaveBeenCalled();
      expect(onPanChange).not.toHaveBeenCalled();
      expect(viewport).toHaveAttribute('tabindex', '-1');
      expect(viewport).not.toHaveClass('touch-none');
      expect(image.parentElement).toHaveStyle({ transform: `translate(50px, -50px) ${identityTransform}` });
    },
  );

  it('lets a nested recovery control own Enter instead of resetting the pan', () => {
    const { image, onPanChange } = renderViewer();
    fireEvent.error(image);
    const retry = screen.getByRole('button', { name: 'Retry image' });
    const event = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true });
    fireEvent(retry, event);
    expect(event.defaultPrevented).toBe(false);
    expect(onPanChange).not.toHaveBeenCalled();
    expect(retry.closest('[aria-disabled="true"]')).toBeNull();
    fireEvent.click(retry);
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('releases pointer capture without saving when the viewer unmounts', () => {
    const { viewport, onPanChange, releasePointerCapture, unmount } = renderViewer();
    startPan(viewport);
    unmount();

    expect(onPanChange).not.toHaveBeenCalled();
    expect(releasePointerCapture).toHaveBeenCalledExactlyOnceWith(7);
  });
});
