import { render, fireEvent, screen } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { TooltipTrigger } from '../src/components/TooltipTrigger';
import { HelpModal } from '../src/components/HelpModal';

describe('TooltipTrigger', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    const tooltip = document.getElementById('mira-tooltip');
    if (tooltip) tooltip.remove();
  });

  it('shows tooltip on hover after delay and hides on leave', () => {
    render(
      <TooltipTrigger content="Hello tooltip">
        <div>Hover me</div>
      </TooltipTrigger>
    );

    const target = screen.getByText('Hover me');
    fireEvent.mouseEnter(target, { clientX: 10, clientY: 10 });
    vi.advanceTimersByTime(160);

    const tooltip = document.getElementById('mira-tooltip');
    expect(tooltip).toBeTruthy();
    expect(tooltip?.textContent).toContain('Hello tooltip');

    fireEvent.mouseLeave(target);
    expect(tooltip?.classList.contains('opacity-0')).toBe(true);
  });
});

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
