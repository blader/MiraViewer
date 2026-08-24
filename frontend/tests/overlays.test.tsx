import { render, fireEvent, screen } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import { HelpModal } from '../src/components/HelpModal';
import { AccessibleDialog } from '../src/components/ui/AccessibleDialog';
describe('HelpModal', () => {
  it('closes when backdrop is clicked', () => {
    const onClose = vi.fn();
    render(<HelpModal onClose={onClose} />);

    // Click backdrop (the root fixed overlay)
    const backdrop = screen.getByRole('dialog', { name: /help/i }).parentElement;
    if (backdrop) {
      fireEvent.click(backdrop);
    }
    expect(onClose).toHaveBeenCalled();
  });

  it('does not close when modal content is clicked', () => {
    const onClose = vi.fn();
    render(<HelpModal onClose={onClose} />);
    // Click on the modal heading itself (inside content)
    fireEvent.click(screen.getByRole('heading', { name: /help/i }));
    expect(onClose).not.toHaveBeenCalled();
  });

  it('exposes modal semantics and closes with Escape', () => {
    const onClose = vi.fn();
    render(<HelpModal onClose={onClose} />);

    const dialog = screen.getByRole('dialog', { name: /help/i });
    expect(dialog).toHaveAttribute('aria-modal', 'true');
    expect(screen.getByRole('button', { name: /close help/i })).toHaveFocus();

    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledOnce();
  });
});

describe('AccessibleDialog', () => {
  it('uses the shared instrument folio without blur and keeps a usable close target', () => {
    render(
      <AccessibleDialog title="Acquisition settings" description="Stored on this device." onClose={vi.fn()}>
        <button type="button">Continue</button>
      </AccessibleDialog>,
    );

    const dialog = screen.getByRole('dialog', { name: 'Acquisition settings' });
    expect(dialog).toHaveClass('instrument-dialog', 'rounded-[4px]');
    expect(dialog.parentElement).toHaveClass('instrument-dialog-backdrop');
    expect(dialog.parentElement?.className).not.toContain('backdrop-blur');
    expect(dialog).toHaveAccessibleDescription('Stored on this device.');
    expect(screen.getByRole('button', { name: 'Close Acquisition settings' })).toHaveClass('min-h-11', 'min-w-11');
  });

  it('traps keyboard focus, isolates the app, and restores the triggering control', () => {
    const appRoot = document.createElement('div');
    appRoot.id = 'root';
    const trigger = document.createElement('button');
    trigger.textContent = 'Open tools';
    appRoot.appendChild(trigger);
    document.body.appendChild(appRoot);
    trigger.focus();

    const { unmount } = render(
      <AccessibleDialog title="Segmentation tools" onClose={vi.fn()}>
        <button type="button">First tool</button>
        <button type="button">Last tool</button>
      </AccessibleDialog>,
    );

    const close = screen.getByRole('button', { name: /close segmentation tools/i });
    const last = screen.getByRole('button', { name: /last tool/i });
    expect(close).toHaveFocus();
    expect(appRoot).toHaveAttribute('inert');
    expect(document.body.style.overflow).toBe('hidden');

    fireEvent.keyDown(document, { key: 'Tab', shiftKey: true });
    expect(last).toHaveFocus();
    fireEvent.keyDown(document, { key: 'Tab' });
    expect(close).toHaveFocus();

    unmount();
    expect(trigger).toHaveFocus();
    expect(appRoot).not.toHaveAttribute('inert');
    expect(document.body.style.overflow).not.toBe('hidden');
    appRoot.remove();
  });
});
