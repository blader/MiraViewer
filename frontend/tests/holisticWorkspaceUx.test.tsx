import { act, fireEvent, render, renderHook, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { StudyTools, StudyToolsWorkspace } from '../src/components/comparison/StudyTools';
import { ImageControls } from '../src/components/ImageControls';
import { SliceLoopNavigator } from '../src/components/comparison/SliceLoopNavigator';
import { useGridLayout } from '../src/hooks/useGridLayout';
import { formatPatientName } from '../src/utils/clinicalData';
import { DEFAULT_PANEL_SETTINGS, GRID_CELL_METADATA_HEIGHT } from '../src/utils/constants';

function ToolsFixture({ disabled = false, showFirst = true }: { disabled?: boolean; showFirst?: boolean }) {
  return (
    <StudyToolsWorkspace>
      <div data-testid="images">
        {showFirst ? (
          <StudyTools examinationLabel="First examination" disabled={disabled}>
            <button type="button">First image control</button>
          </StudyTools>
        ) : null}
        <StudyTools examinationLabel="Second examination" disabled={disabled}>
          <button type="button">Second image control</button>
        </StudyTools>
      </div>
    </StudyToolsWorkspace>
  );
}

describe('image adjustment inspector', () => {
  it('uses one external inspector and keeps adjustments attached to the chosen examination', () => {
    render(<ToolsFixture />);
    const triggers = screen.getAllByRole('button', { name: 'Adjust image' });
    expect(screen.queryByRole('complementary', { name: 'Image adjustments' })).toBeNull();

    fireEvent.click(triggers[0]!);
    const inspector = screen.getByRole('complementary', { name: 'Image adjustments' });
    expect(inspector).toHaveTextContent('First examination');
    expect(screen.getByTestId('images')).not.toContainElement(
      screen.getByRole('button', { name: 'First image control' }),
    );
    expect(triggers[0]).toHaveAttribute('aria-expanded', 'true');

    fireEvent.click(triggers[1]!);
    expect(screen.getAllByRole('complementary', { name: 'Image adjustments' })).toHaveLength(1);
    expect(inspector).toHaveTextContent('Second examination');
    expect(screen.queryByRole('button', { name: 'First image control' })).toBeNull();
    expect(triggers[0]).toHaveAttribute('aria-expanded', 'false');
  });

  it('locks the inspector without changing its layout during hold-to-compare', () => {
    const { rerender } = render(<ToolsFixture />);
    fireEvent.click(screen.getAllByRole('button', { name: 'Adjust image' })[0]!);
    const inspector = screen.getByRole('complementary', { name: 'Image adjustments' });
    const control = screen.getByRole('button', { name: 'First image control' });

    rerender(<ToolsFixture disabled />);
    expect(screen.getByRole('complementary', { name: 'Image adjustments' })).toBe(inspector);
    expect(control.closest('[inert]')).not.toBeNull();
    expect(screen.getByRole('button', { name: 'Close image adjustments' })).toBeDisabled();
    expect(screen.getAllByRole('button', { name: 'Adjust image' })[0]).toHaveAttribute('aria-expanded', 'true');

    rerender(<ToolsFixture />);
    expect(control.closest('[inert]')).toBeNull();
  });

  it('closes on Escape and returns focus to its trigger', () => {
    render(<ToolsFixture />);
    const trigger = screen.getAllByRole('button', { name: 'Adjust image' })[0]!;
    fireEvent.click(trigger);
    const control = screen.getByRole('button', { name: 'First image control' });
    control.focus();
    fireEvent.keyDown(control, { key: 'Escape' });
    expect(screen.queryByRole('complementary', { name: 'Image adjustments' })).toBeNull();
    expect(trigger).toHaveFocus();
  });

  it('removes stale controls when their examination leaves the workspace', () => {
    const { rerender } = render(<ToolsFixture />);
    fireEvent.click(screen.getAllByRole('button', { name: 'Adjust image' })[0]!);
    rerender(<ToolsFixture showFirst={false} />);
    expect(screen.queryByRole('complementary', { name: 'Image adjustments' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'First image control' })).toBeNull();
  });

  it('resets display tone without overwriting geometry, slice offset, or acquisition order', () => {
    const onUpdate = vi.fn();
    render(
      <ImageControls
        settings={{ ...DEFAULT_PANEL_SETTINGS, brightness: 74, contrast: 131, offset: 7, panX: 0.12 }}
        instanceIndex={12}
        instanceCount={96}
        onUpdate={onUpdate}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Reset brightness & contrast' }));
    expect(onUpdate).toHaveBeenCalledExactlyOnceWith({
      brightness: DEFAULT_PANEL_SETTINGS.brightness,
      contrast: DEFAULT_PANEL_SETTINGS.contrast,
    });
  });

  it('fits a full image and both metadata gutters above the compact inspector', () => {
    const { result } = renderHook(() => useGridLayout(4));
    act(() => result.current.containerRef({ clientWidth: 390, clientHeight: 353 } as HTMLDivElement));
    expect(result.current.cols).toBe(1);
    expect(result.current.cellSize).toBe(209);
    expect(result.current.cellSize + GRID_CELL_METADATA_HEIGHT).toBeLessThanOrEqual(353 - 48);
  });
});

function SliceFixture({
  blocked = false,
  sequence = 'exact-slice',
  onSelect,
}: {
  blocked?: boolean;
  sequence?: string;
  onSelect: (progress: number) => void;
}) {
  return (
    <SliceLoopNavigator
      selectedSeqId={sequence}
      playbackInstanceCount={96}
      progress={5 / 95}
      progressRef={{ current: 5 / 95 }}
      setProgress={onSelect}
      interactionBlocked={blocked}
    />
  );
}

describe('direct slice navigation', () => {
  it('commits an exact slice only when the edit is submitted', () => {
    const onSelect = vi.fn();
    render(<SliceFixture onSelect={onSelect} />);
    const input = screen.getByRole('spinbutton', { name: 'Go to slice' });
    // setup.ts replaces native blur with a no-op; restore its event for this keyboard contract.
    const blur = vi.spyOn(input, 'blur').mockImplementation(() => fireEvent.blur(input));
    input.focus();
    fireEvent.change(input, { target: { value: '79' } });
    expect(onSelect).not.toHaveBeenCalled();
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(blur).toHaveBeenCalledOnce();
    expect(onSelect).toHaveBeenCalledExactlyOnceWith(78 / 95);
    blur.mockRestore();
  });

  it('cancels edits with Escape and rejects invalid or out-of-range slices', () => {
    const onSelect = vi.fn();
    render(<SliceFixture onSelect={onSelect} />);
    const input = screen.getByRole('spinbutton', { name: 'Go to slice' });
    fireEvent.change(input, { target: { value: '79' } });
    fireEvent.keyDown(input, { key: 'Escape' });
    expect(input).toHaveValue(6);
    for (const value of ['0', '97', '2.5', '']) {
      fireEvent.change(input, { target: { value } });
      fireEvent.blur(input);
    }
    expect(onSelect).not.toHaveBeenCalled();
    expect(input).toHaveValue(6);
  });

  it('does not commit a pending edit while a dialog blocks navigation, and drops drafts across sequences', () => {
    const onSelect = vi.fn();
    const { rerender } = render(<SliceFixture onSelect={onSelect} />);
    const input = screen.getByRole('spinbutton', { name: 'Go to slice' });
    fireEvent.change(input, { target: { value: '79' } });
    rerender(<SliceFixture onSelect={onSelect} blocked />);
    expect(input).toBeDisabled();
    fireEvent.blur(input);
    expect(onSelect).not.toHaveBeenCalled();
    rerender(<SliceFixture onSelect={onSelect} sequence="different-sequence" />);
    expect(screen.getByRole('spinbutton', { name: 'Go to slice' })).toHaveValue(6);
  });
});

describe('patient display names', () => {
  it('keeps every available name representation without changing case or component order', () => {
    expect(formatPatientName('Family^Given^^Dr^Jr')).toBe('Family Given Dr Jr');
    expect(formatPatientName('Family^Given=家族^名前')).toBe('Family Given / 家族 名前');
    expect(formatPatientName('  Existing display name  ')).toBe('Existing display name');
    expect(formatPatientName(null)).toBe('');
  });
});
