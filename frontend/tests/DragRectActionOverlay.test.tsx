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
      </DragRectActionOverlay>
    );

    const overlay = container.firstElementChild as HTMLElement;
    fireEvent.pointerDown(overlay, { pointerId: 1, button: 0, isPrimary: true, clientX: 50, clientY: 50 });
    fireEvent.pointerMove(overlay, { pointerId: 1, isPrimary: true, clientX: 200, clientY: 200 });
    fireEvent.pointerUp(overlay, { pointerId: 1, button: 0, isPrimary: true, clientX: 200, clientY: 200 });

    fireEvent.click(screen.getByRole('button', { name: 'Align All' }));

    expect(onConfirm).toHaveBeenCalledTimes(1);
  });
});
