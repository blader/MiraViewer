import { render, fireEvent, screen } from '@testing-library/react';
import { useState } from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { StepControl } from '../src/components/StepControl';
import { AlignmentBadge, ImageControls, StudyAnnotationControls } from '../src/components/ImageControls';
import { AutomaticAlignmentStatus } from '../src/components/comparison/AutomaticAlignmentStatus';
import { RepeatButton } from '../src/components/RepeatButton';
import { DEFAULT_PANEL_SETTINGS } from '../src/utils/constants';
import type { AlignmentAdjustment, PanelSettings } from '../src/types/api';
import { DEFAULT_ALIGNMENT_ADJUSTMENT } from '../src/utils/alignmentAdjustment';

const alignmentAdjustment: AlignmentAdjustment = {
  sliceOffset: 2,
  panX: 0.03,
  panY: -0.01,
  zoom: 1.1,
  rotation: 4,
  brightness: 15,
  contrast: -8,
};

function renderImageControls(settings: Partial<PanelSettings>, { instanceIndex = 3, isAligned = false } = {}) {
  const onUpdate = vi.fn();
  render(
    <ImageControls
      settings={{ ...DEFAULT_PANEL_SETTINGS, ...settings }}
      instanceIndex={instanceIndex}
      instanceCount={10}
      onUpdate={onUpdate}
      isAligned={isAligned}
    />,
  );
  return onUpdate;
}

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
      <ImageControls settings={DEFAULT_PANEL_SETTINGS} instanceIndex={0} instanceCount={10} onUpdate={onUpdate} />,
    );

    const buttons = screen.getAllByRole('button');
    // Click a few buttons; at least one should update settings
    fireEvent.mouseDown(buttons[0]);
    fireEvent.mouseUp(buttons[0]);
    expect(onUpdate).toHaveBeenCalled();
  });

  it('keeps native tone reset independent of geometry and does not offer nonexistent corrections', () => {
    const onUpdate = renderImageControls({ brightness: 140, contrast: 125, rotation: 5 });

    fireEvent.click(screen.getByRole('button', { name: 'Reset brightness & contrast' }));

    expect(onUpdate).toHaveBeenCalledExactlyOnceWith({ brightness: 100, contrast: 100 });
    expect(screen.queryByRole('button', { name: 'Reset adjustments' })).not.toBeInTheDocument();
  });

  it('resets corrected tone to matching without discarding geometry, slice correction, or linkage', () => {
    const onUpdate = renderImageControls({ brightness: 135, contrast: 102, alignmentAdjustment });

    fireEvent.click(screen.getByRole('button', { name: 'Reset brightness & contrast' }));

    expect(onUpdate).toHaveBeenCalledExactlyOnceWith({
      alignmentAdjustment: { ...alignmentAdjustment, brightness: 0, contrast: 0 },
    });
    expect(alignmentAdjustment).toMatchObject({ brightness: 15, contrast: -8 });
  });

  it('requests an adjustment reset without replacing the latest automatic baseline or slice-order preference', () => {
    const onUpdate = renderImageControls({ reverseSliceOrder: true, affine00: 1.08, alignmentAdjustment });

    fireEvent.click(screen.getByRole('button', { name: 'Reset adjustments' }));

    expect(onUpdate).toHaveBeenCalledExactlyOnceWith({ alignmentAdjustment: undefined });
  });

  it('resets an unadjusted aligned panel to its matched baseline instead of absolute native tone', () => {
    const onUpdate = renderImageControls({ brightness: 137, contrast: 91 }, { isAligned: true });

    fireEvent.click(screen.getByRole('button', { name: 'Reset brightness & contrast' }));

    expect(onUpdate).toHaveBeenCalledExactlyOnceWith({ alignmentAdjustment: DEFAULT_ALIGNMENT_ADJUSTMENT });
    expect(screen.queryByRole('button', { name: 'Reset adjustments' })).not.toBeInTheDocument();
  });

  it('resets acquired tone without mutating saved corrections or resuming alignment', () => {
    const onUpdate = renderImageControls({ brightness: 137, contrast: 91, alignmentPaused: true, alignmentAdjustment });

    expect(screen.queryByRole('button', { name: 'Reset adjustments' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Reset brightness & contrast' }));

    expect(onUpdate).toHaveBeenCalledExactlyOnceWith({ brightness: 100, contrast: 100 });
    expect(alignmentAdjustment).toMatchObject({ brightness: 15, contrast: -8 });
  });

  it.each([
    { reversed: false, instanceIndex: 3, offset: 5, nextOffset: 8 },
    { reversed: true, instanceIndex: 6, offset: 8, nextOffset: 5 },
  ])('keeps the physical slice stable when reversing corrected slice navigation: $reversed', (testCase) => {
    const onUpdate = renderImageControls(
      { offset: testCase.offset, reverseSliceOrder: testCase.reversed, alignmentAdjustment },
      { instanceIndex: testCase.instanceIndex },
    );

    fireEvent.click(screen.getByRole('button', { name: 'Reverse slice order' }));

    expect(onUpdate).toHaveBeenCalledExactlyOnceWith({
      reverseSliceOrder: !testCase.reversed,
      offset: testCase.nextOffset,
    });
  });
});

describe('alignment adjustment status', () => {
  it('distinguishes a corrected aligned presentation from a verified automatic result', () => {
    const { rerender, container } = render(<AlignmentBadge />);
    expect(screen.getByLabelText('Verified aligned presentation')).toBeInTheDocument();
    expect(container.querySelector('[data-registration-datum="verified"]')).not.toBeNull();

    rerender(<AlignmentBadge adjusted />);

    expect(screen.getByLabelText('Aligned with manual adjustments')).toHaveTextContent('Adjusted');
    expect(screen.queryByLabelText('Verified aligned presentation')).not.toBeInTheDocument();
    expect(container.querySelector('[data-registration-datum="verified"]')).toBeNull();
    expect(container.querySelector('[data-registration-datum="adjusted"]')).not.toBeNull();
  });

  it('reports linked adjustments and explains that refitting keeps them', () => {
    const onRealign = vi.fn();
    render(
      <AutomaticAlignmentStatus
        enabled
        busy={false}
        aligned={2}
        targets={2}
        manual
        onToggle={vi.fn()}
        onRealign={onRealign}
      />,
    );

    expect(screen.getByRole('status')).toHaveTextContent('Aligned with adjustments');
    const realign = screen.getByRole('button', { name: 'Realign visible scans' });
    expect(realign).toHaveAttribute('title', expect.stringContaining('keeping your adjustments'));
    fireEvent.click(realign);
    expect(onRealign).toHaveBeenCalledOnce();
  });

  it('keeps an explicit global pause visible when adjusted examinations exist', () => {
    render(
      <AutomaticAlignmentStatus
        enabled={false}
        busy={false}
        aligned={2}
        targets={2}
        manual
        onToggle={vi.fn()}
        onRealign={vi.fn()}
      />,
    );

    expect(screen.getByRole('status')).toHaveTextContent('Alignment paused');
    expect(screen.getByRole('button', { name: 'Resume automatic alignment' })).toBeInTheDocument();
  });
});

function AnnotationControls({ nativeAnnotationsAvailable = true }: { nativeAnnotationsAvailable?: boolean }) {
  const [showSavedTumor, setShowSavedTumor] = useState(false);
  const [gtPolygonToolOpen, setGtPolygonToolOpen] = useState(false);
  return (
    <StudyAnnotationControls
      showSavedTumor={showSavedTumor}
      gtPolygonToolOpen={gtPolygonToolOpen}
      nativeAnnotationsAvailable={nativeAnnotationsAvailable}
      setShowSavedTumor={setShowSavedTumor}
      setGtPolygonToolOpen={setGtPolygonToolOpen}
    />
  );
}

describe('StudyAnnotationControls', () => {
  it('keeps manual Outline and saved overlays available without a 2D Segment entry', () => {
    render(<AnnotationControls />);
    const outline = screen.getByRole('button', { name: 'Outline' });
    const saved = screen.getByRole('button', { name: 'Saved tumor' });
    expect(screen.queryByRole('button', { name: 'Segment' })).not.toBeInTheDocument();
    expect(outline).toHaveAttribute('aria-pressed', 'false');
    expect(saved).toHaveAttribute('aria-pressed', 'false');

    fireEvent.click(outline);
    expect(outline).toHaveAttribute('aria-pressed', 'true');
    expect(saved).toBeEnabled();

    fireEvent.click(saved);
    expect(saved).toHaveAttribute('aria-pressed', 'true');
    expect(outline).toHaveAttribute('aria-pressed', 'true');

    fireEvent.click(outline);
    expect(outline).toHaveAttribute('aria-pressed', 'false');
    expect(saved).toHaveAttribute('aria-pressed', 'true');
    fireEvent.click(saved);
    expect(saved).toHaveAttribute('aria-pressed', 'false');
  });

  it('disables native annotation tools on derived images', () => {
    render(<AnnotationControls nativeAnnotationsAvailable={false} />);
    expect(screen.queryByRole('button', { name: 'Segment' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Outline' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Saved tumor' })).toBeDisabled();
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
      </RepeatButton>,
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
