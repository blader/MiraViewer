import { readFileSync } from 'node:fs';
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { ComparisonFiltersSidebar } from '../src/components/comparison/ComparisonFiltersSidebar';
import { SliceLoopNavigator } from '../src/components/comparison/SliceLoopNavigator';

const stylesheet = readFileSync('src/index.css', 'utf8');

function token(name: string): string {
  const match = stylesheet.match(new RegExp(`--${name}:\\s*(#[0-9a-f]{6})`, 'i'));
  if (!match?.[1]) throw new Error(`Missing design token ${name}`);
  return match[1];
}

function luminance(hex: string): number {
  const channels = [1, 3, 5].map((offset) => {
    const value = Number.parseInt(hex.slice(offset, offset + 2), 16) / 255;
    return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  });
  return channels[0]! * 0.2126 + channels[1]! * 0.7152 + channels[2]! * 0.0722;
}

function contrastRatio(foreground: string, background: string): number {
  const lightness = [luminance(foreground), luminance(background)].sort((a, b) => b - a);
  return (lightness[0]! + 0.05) / (lightness[1]! + 0.05);
}

describe('comparison accessibility', () => {
  it('keeps unclassified imported scans visible and marks collapsed filters inert', () => {
    const onSelectSequence = vi.fn();
    const props = {
      open: false,
      onToggleOpen: vi.fn(),
      availablePlanes: ['Axial'],
      selectedPlane: 'Axial',
      onSelectPlane: vi.fn(),
      sequencesForPlane: [
        {
          id: 'unclassified',
          plane: 'Axial',
          weight: null,
          sequence: null,
          label: 'Unknown',
          date_count: 1,
        },
      ],
      sequencesWithDataForDates: new Set(['unclassified']),
      selectedSeqId: 'unclassified',
      onSelectSequence,
    };

    const { rerender } = render(<ComparisonFiltersSidebar {...props} />);
    expect(screen.getByRole('complementary', { name: /scan filters/i })).toHaveAttribute('inert');
    expect(screen.getByRole('complementary', { name: /scan filters/i })).toHaveAttribute(
      'id',
      'comparison-filters-panel',
    );

    rerender(<ComparisonFiltersSidebar {...props} open />);
    const unclassified = screen.getByRole('button', { name: 'Unclassified' });
    expect(unclassified).toHaveAttribute('aria-pressed', 'true');
    fireEvent.click(unclassified);
    expect(onSelectSequence).toHaveBeenCalledWith('unclassified');
  });

  it('exposes named slice controls and adjusts loop handles from the keyboard', () => {
    const progressRef = { current: 0.5 };
    const setProgress = vi.fn();
    render(
      <SliceLoopNavigator
        selectedSeqId="keyboard-test"
        playbackInstanceCount={11}
        progress={0.5}
        progressRef={progressRef}
        setProgress={setProgress}
      />,
    );

    expect(screen.getByRole('button', { name: /play slices/i })).toHaveAttribute('aria-pressed', 'false');
    expect(screen.getByRole('button', { name: /playback speed 1 times/i })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('slider', { name: /slice position/i })).toBeInTheDocument();

    const start = screen.getByRole('slider', { name: /loop start position/i });
    fireEvent.keyDown(start, { key: 'ArrowRight' });
    expect(start).toHaveAttribute('aria-valuenow', '10');
    expect(setProgress).toHaveBeenCalledWith(0.5);
  });

  it('keeps clinical controls legible and respects reduced motion and touch interaction', () => {
    expect(contrastRatio(token('text-secondary'), token('bg-secondary'))).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio(token('text-tertiary'), token('bg-secondary'))).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio('#ffffff', token('accent'))).toBeGreaterThanOrEqual(4.5);

    expect(stylesheet).toMatch(/@media\s*\(prefers-reduced-motion:\s*reduce\)/);
    expect(stylesheet).toMatch(/@media\s*\(pointer:\s*coarse\)/);
    expect(stylesheet).toMatch(/\.study-tools-trigger\[aria-expanded=['"]true['"]\]/);
    expect(stylesheet).toMatch(/\.svr-generation-layout\[data-generation-open=['"]true['"]\]/);
    expect(stylesheet).toMatch(/\.svr-volume-layout\[data-controls-open=['"]true['"]\]/);
  });

  it('immediately cancels active slice playback and disables navigation while interaction is blocked', () => {
    const requestFrame = vi.fn(() => 17);
    const cancelFrame = vi.fn();
    vi.stubGlobal('requestAnimationFrame', requestFrame);
    vi.stubGlobal('cancelAnimationFrame', cancelFrame);

    try {
      const progressRef = { current: 0.5 };
      const props = {
        selectedSeqId: 'blocked-playback',
        playbackInstanceCount: 11,
        progress: 0.5,
        progressRef,
        setProgress: vi.fn(),
      };
      const { rerender } = render(<SliceLoopNavigator {...props} />);

      fireEvent.click(screen.getByRole('button', { name: 'Play slices' }));
      expect(requestFrame).toHaveBeenCalledOnce();
      expect(screen.getByRole('button', { name: 'Pause slice playback' })).toHaveAttribute('aria-pressed', 'true');

      rerender(<SliceLoopNavigator {...props} interactionBlocked />);

      expect(cancelFrame).toHaveBeenCalledWith(17);
      expect(screen.getByRole('button', { name: 'Play slices' })).toBeDisabled();
      expect(screen.getByRole('button', { name: 'Playback speed 2 times' })).toBeDisabled();
      expect(screen.getByRole('slider', { name: 'Slice position' })).toBeDisabled();
      expect(screen.getByRole('slider', { name: 'Loop start position' })).toBeDisabled();
      expect(screen.getByRole('slider', { name: 'Loop end position' })).toBeDisabled();
      expect(props.setProgress).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
