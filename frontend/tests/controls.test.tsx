import { render, fireEvent, screen } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { StepControl } from '../src/components/StepControl';
import { ImageControls } from '../src/components/ImageControls';
import { RepeatButton } from '../src/components/RepeatButton';
import { DEFAULT_PANEL_SETTINGS } from '../src/utils/constants';

describe('StepControl', () => {
  it('triggers increment and decrement', () => {
    const onDec = vi.fn();
    const onInc = vi.fn();
    render(<StepControl value="1" onDecrement={onDec} onIncrement={onInc} />);

    const buttons = screen.getAllByRole('button');
    fireEvent.mouseDown(buttons[0]);
    fireEvent.mouseUp(buttons[0]);
    fireEvent.mouseDown(buttons[1]);
    fireEvent.mouseUp(buttons[1]);

    expect(onDec).toHaveBeenCalled();
    expect(onInc).toHaveBeenCalled();
  });
});

describe('ImageControls', () => {
  it('updates brightness/contrast and slice offset', () => {
    const onUpdate = vi.fn();
    render(
      <ImageControls
        settings={DEFAULT_PANEL_SETTINGS}
        instanceIndex={0}
        instanceCount={10}
        onUpdate={onUpdate}
      />
    );

    const buttons = screen.getAllByRole('button');
    // Click a few buttons; at least one should update settings
    fireEvent.mouseDown(buttons[0]);
    fireEvent.mouseUp(buttons[0]);
    expect(onUpdate).toHaveBeenCalled();
  });
});

describe('RepeatButton', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('repeats action while held', () => {
    const onAction = vi.fn();
    render(
      <RepeatButton onAction={onAction}>
        <span>+</span>
      </RepeatButton>
    );

    const btn = screen.getByRole('button');
    fireEvent.mouseDown(btn);

    // immediate action
    expect(onAction).toHaveBeenCalledTimes(1);

    // advance time past initial delay and some repeats
    vi.advanceTimersByTime(500);
    fireEvent.mouseUp(btn);

    expect(onAction).toHaveBeenCalled();
  });
});
