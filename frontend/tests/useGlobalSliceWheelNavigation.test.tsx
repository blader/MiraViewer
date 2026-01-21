import { renderHook } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { useGlobalSliceWheelNavigation } from '../src/hooks/useGlobalSliceWheelNavigation';

describe('useGlobalSliceWheelNavigation', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  afterEach(() => {
    document.body.innerHTML = '';
    vi.restoreAllMocks();
  });

  it('updates progress when wheel originates inside the center pane', () => {
    const centerPane = document.createElement('div');
    const target = document.createElement('div');
    centerPane.appendChild(target);
    document.body.appendChild(centerPane);

    const centerPaneRef = { current: centerPane } as React.RefObject<HTMLElement>;
    const contextRef = { current: { instanceCount: 10, offset: 0 } };
    const progressRef = { current: 0.5 };

    const onSetProgress = vi.fn((next: number) => {
      progressRef.current = next;
    });
    const setProgressRef = { current: onSetProgress };

    renderHook(() =>
      useGlobalSliceWheelNavigation({
        centerPaneRef,
        contextRef,
        progressRef,
        setProgressRef,
      })
    );

    const ev = new WheelEvent('wheel', { deltaY: 1, cancelable: true, bubbles: true });
    target.dispatchEvent(ev);

    expect(onSetProgress).toHaveBeenCalledTimes(1);

    // progress 0.5 with 10 slices => baseIndex round(0.5 * 9) = 5; nextIndex = 6 => 6/9
    expect(onSetProgress.mock.calls[0]?.[0]).toBeCloseTo(6 / 9);
    expect(ev.defaultPrevented).toBe(true);
  });

  it('ignores ctrlKey wheel events (pinch zoom)', () => {
    const centerPane = document.createElement('div');
    const target = document.createElement('div');
    centerPane.appendChild(target);
    document.body.appendChild(centerPane);

    const centerPaneRef = { current: centerPane } as React.RefObject<HTMLElement>;
    const contextRef = { current: { instanceCount: 10, offset: 0 } };
    const progressRef = { current: 0.5 };

    const onSetProgress = vi.fn();
    const setProgressRef = { current: onSetProgress };

    renderHook(() =>
      useGlobalSliceWheelNavigation({
        centerPaneRef,
        contextRef,
        progressRef,
        setProgressRef,
      })
    );

    const ev = new WheelEvent('wheel', { deltaY: 1, ctrlKey: true, cancelable: true, bubbles: true });
    target.dispatchEvent(ev);

    expect(onSetProgress).not.toHaveBeenCalled();
    expect(ev.defaultPrevented).toBe(false);
  });

  it('ignores wheel events already defaultPrevented by nested handlers', () => {
    const centerPane = document.createElement('div');
    const target = document.createElement('div');
    centerPane.appendChild(target);
    document.body.appendChild(centerPane);

    // Nested component handles wheel first.
    target.addEventListener('wheel', (e) => e.preventDefault());

    const centerPaneRef = { current: centerPane } as React.RefObject<HTMLElement>;
    const contextRef = { current: { instanceCount: 10, offset: 0 } };
    const progressRef = { current: 0.5 };

    const onSetProgress = vi.fn();
    const setProgressRef = { current: onSetProgress };

    renderHook(() =>
      useGlobalSliceWheelNavigation({
        centerPaneRef,
        contextRef,
        progressRef,
        setProgressRef,
      })
    );

    const ev = new WheelEvent('wheel', { deltaY: 1, cancelable: true, bubbles: true });
    target.dispatchEvent(ev);

    expect(ev.defaultPrevented).toBe(true);
    expect(onSetProgress).not.toHaveBeenCalled();
  });

  it('ignores wheel events over editable controls', () => {
    const centerPane = document.createElement('div');
    const input = document.createElement('input');
    input.type = 'text';
    centerPane.appendChild(input);
    document.body.appendChild(centerPane);

    const centerPaneRef = { current: centerPane } as React.RefObject<HTMLElement>;
    const contextRef = { current: { instanceCount: 10, offset: 0 } };
    const progressRef = { current: 0.5 };

    const onSetProgress = vi.fn();
    const setProgressRef = { current: onSetProgress };

    renderHook(() =>
      useGlobalSliceWheelNavigation({
        centerPaneRef,
        contextRef,
        progressRef,
        setProgressRef,
      })
    );

    const ev = new WheelEvent('wheel', { deltaY: 1, cancelable: true, bubbles: true });
    input.dispatchEvent(ev);

    expect(onSetProgress).not.toHaveBeenCalled();
    expect(ev.defaultPrevented).toBe(false);
  });

  it('ignores wheel events when a scrollable ancestor would scroll', () => {
    const centerPane = document.createElement('div');
    const scrollable = document.createElement('div');
    const target = document.createElement('div');

    // Create a scrollable ancestor.
    scrollable.style.overflowY = 'auto';
    Object.defineProperty(scrollable, 'scrollHeight', { value: 200 });
    Object.defineProperty(scrollable, 'clientHeight', { value: 50 });
    Object.defineProperty(scrollable, 'scrollTop', { value: 0, writable: true });

    scrollable.appendChild(target);
    centerPane.appendChild(scrollable);
    document.body.appendChild(centerPane);

    // Ensure getComputedStyle reflects our overflowY intent.
    vi.spyOn(window, 'getComputedStyle').mockImplementation((el: Element) => {
      return { overflowY: el === scrollable ? 'auto' : 'visible' } as CSSStyleDeclaration;
    });

    const centerPaneRef = { current: centerPane } as React.RefObject<HTMLElement>;
    const contextRef = { current: { instanceCount: 10, offset: 0 } };
    const progressRef = { current: 0.5 };

    const onSetProgress = vi.fn();
    const setProgressRef = { current: onSetProgress };

    renderHook(() =>
      useGlobalSliceWheelNavigation({
        centerPaneRef,
        contextRef,
        progressRef,
        setProgressRef,
      })
    );

    const ev = new WheelEvent('wheel', { deltaY: 1, cancelable: true, bubbles: true });
    target.dispatchEvent(ev);

    expect(onSetProgress).not.toHaveBeenCalled();
    expect(ev.defaultPrevented).toBe(false);
  });
});
