import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { SliceLoopNavigator } from '../src/components/comparison/SliceLoopNavigator';

describe('slice-loop pointer interaction', () => {
  it('moves touch and pen loop handles while preserving the selected slice', () => {
    const progressRef = { current: 0.5 };
    const setProgress = vi.fn();
    render(
      <SliceLoopNavigator
        selectedSeqId="touch-loop-test"
        playbackInstanceCount={11}
        progress={0.5}
        progressRef={progressRef}
        setProgress={setProgress}
      />,
    );

    const start = screen.getByRole('slider', { name: 'Loop start position' });
    const track = start.parentElement;
    if (!track) throw new Error('Slice-loop track is unavailable');
    vi.spyOn(track, 'getBoundingClientRect').mockReturnValue({
      x: 100,
      y: 0,
      left: 100,
      top: 0,
      right: 300,
      bottom: 40,
      width: 200,
      height: 40,
      toJSON: () => ({}),
    });

    fireEvent.pointerDown(start, { pointerId: 7, pointerType: 'touch', button: 0, clientX: 100 });
    fireEvent.pointerMove(window, { pointerId: 7, pointerType: 'touch', clientX: 160 });

    expect(start).toHaveAttribute('aria-valuenow', '30');
    expect(setProgress).toHaveBeenLastCalledWith(0.5);

    fireEvent.pointerUp(window, { pointerId: 7, pointerType: 'touch' });
    fireEvent.pointerMove(window, { pointerId: 7, pointerType: 'touch', clientX: 220 });
    expect(start).toHaveAttribute('aria-valuenow', '30');

    const end = screen.getByRole('slider', { name: 'Loop end position' });
    fireEvent.pointerDown(end, { pointerId: 9, pointerType: 'pen', button: 0, clientX: 300 });
    fireEvent.pointerMove(window, { pointerId: 9, pointerType: 'pen', clientX: 240 });

    expect(end).toHaveAttribute('aria-valuenow', '70');
    expect(setProgress).toHaveBeenLastCalledWith(0.5);

    fireEvent.pointerCancel(window, { pointerId: 9, pointerType: 'pen' });
    fireEvent.pointerMove(window, { pointerId: 9, pointerType: 'pen', clientX: 200 });
    expect(end).toHaveAttribute('aria-valuenow', '70');
  });

  it('ignores secondary pointers and prevents drag navigation while blocked', () => {
    const setProgress = vi.fn();
    const progressRef = { current: 0.5 };
    render(
      <SliceLoopNavigator
        selectedSeqId="blocked-touch-loop-test"
        playbackInstanceCount={11}
        progress={0.5}
        progressRef={progressRef}
        setProgress={setProgress}
        interactionBlocked
      />,
    );

    const start = screen.getByRole('slider', { name: 'Loop start position' });
    fireEvent.pointerDown(start, { pointerId: 3, pointerType: 'touch', button: 0, clientX: 30 });
    fireEvent.pointerMove(window, { pointerId: 3, pointerType: 'touch', clientX: 100 });

    expect(start).toHaveAttribute('aria-valuenow', '0');
    expect(setProgress).not.toHaveBeenCalled();
  });
});
