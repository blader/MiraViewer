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

    expect(container.querySelector('[data-selection-outline="true"]')).toHaveClass('bg-transparent');
    expect(screen.getByRole('button', { name: 'Clear selection' })).toHaveClass('min-h-11', 'min-w-11');
    expect(screen.getByRole('button', { name: 'Align All' })).toHaveClass('min-h-11');
    fireEvent.click(screen.getByRole('button', { name: 'Align All' }));

    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  it.each([
    { side: 'right', start: 180, end: 300 },
    { side: 'left', start: 335, end: 465 },
  ])('keeps all controls outside the selected anatomy on its $side side', ({ side, start, end }) => {
    const { container } = render(
      <DragRectActionOverlay
        className="relative"
        geometry={DEFAULT_PANEL_SETTINGS}
        actions={[
          { key: 'align-all', label: 'Align All', onConfirm: vi.fn() },
          { key: 'align-tumor', label: 'Align Tumor', onConfirm: vi.fn() },
          { key: 'segment', label: 'Segment', onConfirm: vi.fn() },
        ]}
      >
        <div>Viewer</div>
      </DragRectActionOverlay>,
    );

    const overlay = container.firstElementChild as HTMLElement;
    fireEvent.pointerDown(overlay, { pointerId: 7, button: 0, isPrimary: true, clientX: start, clientY: 160 });
    fireEvent.pointerMove(overlay, { pointerId: 7, isPrimary: true, clientX: end, clientY: 290 });
    fireEvent.pointerUp(overlay, { pointerId: 7, button: 0, isPrimary: true, clientX: end, clientY: 290 });

    for (const label of ['Clear selection', 'Align All', 'Align Tumor', 'Segment']) {
      const button = screen.getByRole('button', { name: label });
      const left = Number.parseFloat(button.style.left);
      const right = left + (label === 'Clear selection' ? 44 : Number.parseFloat(button.style.maxWidth));

      expect(side === 'right' ? left >= end : right <= start).toBe(true);
      expect(left).toBeGreaterThanOrEqual(0);
      expect(right).toBeLessThanOrEqual(500);
    }
  });

  it('keeps every compact action reachable when a selection ends near the lower-right viewport edge', () => {
    Element.prototype.getBoundingClientRect = vi.fn().mockReturnValue({
      width: 180,
      height: 150,
      top: 0,
      left: 0,
      right: 180,
      bottom: 150,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    });
    const onTumorAlignment = vi.fn();
    const { container } = render(
      <DragRectActionOverlay
        className="relative"
        geometry={DEFAULT_PANEL_SETTINGS}
        actions={[
          { key: 'align-all', label: 'Align All', onConfirm: vi.fn() },
          {
            key: 'align-tumor',
            label: 'Align Tumor',
            title: 'Match tumor across dates; uses pixels inside the selected region',
            onConfirm: onTumorAlignment,
          },
          { key: 'segment', label: 'Segment', onConfirm: vi.fn() },
        ]}
      >
        <div>Viewer</div>
      </DragRectActionOverlay>,
    );

    const overlay = container.firstElementChild as HTMLElement;
    fireEvent.pointerDown(overlay, { pointerId: 8, button: 0, isPrimary: true, clientX: 151, clientY: 117 });
    fireEvent.pointerMove(overlay, { pointerId: 8, isPrimary: true, clientX: 176, clientY: 144 });
    fireEvent.pointerUp(overlay, { pointerId: 8, button: 0, isPrimary: true, clientX: 176, clientY: 144 });

    const actionButtons = ['Align All', 'Align Tumor', 'Segment'].map((label) =>
      screen.getByRole('button', { name: label }),
    );
    for (const button of actionButtons) {
      expect(button).toBeEnabled();
      expect(Number.parseFloat(button.style.left) + Number.parseFloat(button.style.maxWidth)).toBeLessThanOrEqual(180);
      expect(Number.parseFloat(button.style.top) + 44).toBeLessThanOrEqual(150);
    }
    const close = screen.getByRole('button', { name: 'Clear selection' });
    expect(Number.parseFloat(close.style.left) + 44).toBeLessThanOrEqual(180);
    expect(Number.parseFloat(close.style.top) + 44).toBeLessThanOrEqual(150);
    expect(actionButtons[1]).toHaveAttribute(
      'title',
      'Match tumor across dates; uses pixels inside the selected region',
    );
    fireEvent.click(actionButtons[1]!);
    expect(onTumorAlignment).toHaveBeenCalledOnce();
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

  it('clips both exclusion-mask endpoints when a selection begins outside letterboxed image content', () => {
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
    fireEvent.pointerDown(overlay, { pointerId: 4, button: 0, isPrimary: true, clientX: 100, clientY: 100 });
    fireEvent.pointerMove(overlay, { pointerId: 4, isPrimary: true, clientX: 350, clientY: 250 });
    fireEvent.pointerUp(overlay, { pointerId: 4, button: 0, isPrimary: true, clientX: 350, clientY: 250 });
    fireEvent.click(screen.getByRole('button', { name: 'Align' }));

    expect(onConfirm).toHaveBeenCalledWith({
      base: { x: 0, y: 0.2, width: expect.closeTo(0.2, 10), height: 0.3 },
      screen: { x: 0.1, y: 0.2, width: 0.25, height: 0.3 },
    });
  });
});
