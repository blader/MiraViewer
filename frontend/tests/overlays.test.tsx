import { render, fireEvent, screen } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import { HelpModal } from '../src/components/HelpModal';
describe('HelpModal', () => {
  it('closes when backdrop is clicked', () => {
    const onClose = vi.fn();
    render(<HelpModal onClose={onClose} />);

    // Click backdrop (the root fixed overlay)
    const backdrop = screen.getByRole('heading', { name: /help/i }).closest('div')?.parentElement
      ?.parentElement;
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
});
