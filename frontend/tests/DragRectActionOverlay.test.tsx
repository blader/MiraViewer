import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DragRectActionOverlay } from '../src/components/DragRectActionOverlay';
import { DEFAULT_PANEL_SETTINGS } from '../src/utils/constants';

describe('DragRectActionOverlay', () => {
  beforeEach(() => {
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

  it('runs an action on the first click after drawing a rectangle', () => {
    const onConfirm = vi.fn();

    const { container } = render(
      <DragRectActionOverlay
        className="relative"
        geometry={DEFAULT_PANEL_SETTINGS}
        actions={[
          {
            key: 'align-all',
            label: 'Align All',
            onConfirm,
          },
        ]}
      >
        <div>Viewer</div>
      </DragRectActionOverlay>,
    );

    const overlay = container.firstElementChild as HTMLElement;
    fireEvent.pointerDown(overlay, { pointerId: 1, button: 0, isPrimary: true, clientX: 50, clientY: 50 });
    fireEvent.pointerMove(overlay, { pointerId: 1, isPrimary: true, clientX: 200, clientY: 200 });
    fireEvent.pointerUp(overlay, { pointerId: 1, button: 0, isPrimary: true, clientX: 200, clientY: 200 });

    fireEvent.click(screen.getByRole('button', { name: 'Align All' }));

    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  it('stores exclusion masks in image coordinates when the viewport contains horizontal letterboxing', () => {
    Element.prototype.getBoundingClientRect = vi.fn().mockReturnValue({
      width: 1000,
      height: 500,
      top: 0,
      left: 0,
      right: 1000,
      bottom: 500,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    });

    const onConfirm = vi.fn();
    const { container } = render(
      <DragRectActionOverlay
        className="relative"
        geometry={DEFAULT_PANEL_SETTINGS}
        imageSize={{ width: 512, height: 512 }}
        actions={[{ key: 'align', label: 'Align', onConfirm }]}
      >
        <div>Viewer</div>
      </DragRectActionOverlay>,
    );

    const overlay = container.firstElementChild as HTMLElement;
    fireEvent.pointerDown(overlay, { pointerId: 3, button: 0, isPrimary: true, clientX: 300, clientY: 100 });
    fireEvent.pointerMove(overlay, { pointerId: 3, isPrimary: true, clientX: 400, clientY: 250 });
    fireEvent.pointerUp(overlay, { pointerId: 3, button: 0, isPrimary: true, clientX: 400, clientY: 250 });
    fireEvent.click(screen.getByRole('button', { name: 'Align' }));

    expect(onConfirm).toHaveBeenCalledWith({
      base: { x: 0.1, y: 0.2, width: expect.closeTo(0.2, 10), height: 0.3 },
      screen: { x: 0.3, y: 0.2, width: 0.1, height: 0.3 },
    });
  });
});
