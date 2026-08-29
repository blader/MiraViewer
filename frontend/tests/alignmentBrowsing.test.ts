import { describe, expect, it } from 'vitest';
import type { HistogramStats } from '../src/types/api';
import { freezeAlignmentFallbackTone, replayAlignmentFallbackTone } from '../src/utils/alignmentBrowsing';
import { CONTROL_LIMITS } from '../src/utils/constants';

const controls = (brightness: number, contrast: number) => ({ brightness, contrast });
const stats = (mean: number, stddev: number): HistogramStats => ({
  mean,
  stddev,
  min: 0,
  max: 1,
  p10: 0.1,
  p50: mean,
  p90: 0.9,
});
const display = (value: number, settings: ReturnType<typeof controls>) =>
  Math.max(0, Math.min(1, (((value * settings.brightness) / 100 - 0.5) * settings.contrast) / 100 + 0.5));

describe('frozen alignment fallback tone', () => {
  it('preserves the accepted brightness/contrast exactly when reference controls are unchanged', () => {
    const reference = controls(123.5, 91.25);
    const accepted = controls(89.25, 147.5);
    const tone = freezeAlignmentFallbackTone(reference, accepted);
    expect(replayAlignmentFallbackTone(tone, { ...reference })).toEqual(accepted);
    expect(replayAlignmentFallbackTone(tone, reference)).not.toBe(accepted);
  });

  it('composes the frozen linear tissue mapping with changed reference controls and exact undo', () => {
    const reference = controls(100, 100),
      accepted = controls(80, 125);
    const tone = freezeAlignmentFallbackTone(reference, accepted);
    const before = { ...tone };
    const changed = controls(80, 80);
    const replayed = replayAlignmentFallbackTone(tone, changed);
    expect(tone.gain).toBe(1);
    expect(tone.bias).toBe(-0.125);
    expect(replayed).toEqual(controls(67, 96));
    for (const sample of [0, 0.2, 0.5, 0.9, 1]) {
      // Independent CSS brightness-then-contrast composition. One-percent
      // controls round the analytic brightness 66.666... to67; no tissue is refit.
      expect(Math.abs(display(sample, replayed) - display(sample - 0.125, changed))).toBeLessThanOrEqual(0.0033);
    }
    expect(replayAlignmentFallbackTone(tone, reference)).toEqual(accepted);
    expect(replayAlignmentFallbackTone(tone, changed)).toEqual(replayed);
    expect(tone).toEqual(before);
  });

  it.each([controls(0, 100), controls(100, 0), controls(0, 0)])(
    'restores a finite calibration after an initially flat reference (%j) using uncontrolled source statistics',
    (reference) => {
      const accepted = { ...reference };
      const unadjusted = { reference: stats(0.45, 0.2), moving: stats(0.4, 0.25) };
      const tone = freezeAlignmentFallbackTone(reference, accepted, unadjusted);
      expect(tone.gain).toBeCloseTo(0.8, 12);
      expect(tone.bias).toBeCloseTo(0.13, 12);
      const restored = replayAlignmentFallbackTone(tone, controls(100, 100));
      expect(restored).toEqual(controls(108, 74));
      // Rounding brightness108.108... to108 changes output gain from0.8 to0.7992.
      for (const sample of [0, 0.1, 0.5, 1])
        expect(Math.abs(display(sample, restored) - (0.8 * sample + 0.13))).toBeLessThanOrEqual(0.00081);
      expect(replayAlignmentFallbackTone(tone, reference)).toEqual(accepted);
    },
  );

  it('renders a later zero-contrast reference as constant half-gray instead of restoring moving anatomy', () => {
    const tone = freezeAlignmentFallbackTone(controls(100, 100), controls(80, 100));
    const flat = replayAlignmentFallbackTone(tone, controls(100, 0));
    expect(flat).toEqual(controls(100, 0));
    expect([0, 0.2, 0.8, 1].map((value) => display(value, flat))).toEqual([0.5, 0.5, 0.5, 0.5]);
    expect(replayAlignmentFallbackTone(tone, controls(100, 100))).toEqual(controls(80, 100));
  });

  it('keeps the bounded degenerate fallback when nonzero gain cannot be represented at zero contrast', () => {
    const tone = freezeAlignmentFallbackTone(controls(50, 100), controls(100, 50));
    expect(tone.gain).toBe(1);
    expect(tone.bias).toBe(0.5);
    // Required x+0.5 has positive slope but CSS contrast0 can only produce constant0.5.
    expect(replayAlignmentFallbackTone(tone, controls(100, 100))).toEqual(controls(100, 100));
  });

  it.each([
    [controls(100, 100), controls(200, 100), controls(150, 100), controls(200, 100)],
    [controls(100, 100), controls(100, 200), controls(100, 200), controls(100, 200)],
    [controls(25, 100), controls(100, 50), controls(100, 100), controls(0, 0)],
  ])('clamps unrepresentable composed controls without NaN (%j ->%j)', (initial, accepted, next, expected) => {
    expect(replayAlignmentFallbackTone(freezeAlignmentFallbackTone(initial, accepted), next)).toEqual(expected);
  });

  it('stays finite and inside control bounds across valid endpoint and zero combinations', () => {
    const values = [0, 1, 100, 199, 200];
    const unadjusted = { reference: stats(0.45, 0.2), moving: stats(0.4, 0.25) };
    for (const brightness of values)
      for (const contrast of values) {
        const tone = freezeAlignmentFallbackTone(controls(brightness, contrast), controls(199, 1), unadjusted);
        for (const nextBrightness of values)
          for (const nextContrast of values) {
            const result = replayAlignmentFallbackTone(tone, controls(nextBrightness, nextContrast));
            expect(Number.isFinite(result.brightness) && Number.isFinite(result.contrast)).toBe(true);
            expect(result.brightness).toBeGreaterThanOrEqual(CONTROL_LIMITS.BRIGHTNESS.MIN);
            expect(result.brightness).toBeLessThanOrEqual(CONTROL_LIMITS.BRIGHTNESS.MAX);
            expect(result.contrast).toBeGreaterThanOrEqual(CONTROL_LIMITS.CONTRAST.MIN);
            expect(result.contrast).toBeLessThanOrEqual(CONTROL_LIMITS.CONTRAST.MAX);
          }
      }
  });

  it('uses finite conservative coefficients when an uncontrolled source has no intensity variance', () => {
    const tone = freezeAlignmentFallbackTone(controls(0, 0), controls(100, 0), {
      reference: stats(0.4, 0),
      moving: stats(0.4, 0),
    });
    expect(tone.gain).toBe(1);
    expect(tone.bias).toBe(0);
    expect(replayAlignmentFallbackTone(tone, controls(100, 100))).toEqual(controls(100, 100));
  });

  it('retains only numeric coefficients, never input statistics objects or typed image buffers', () => {
    const unadjusted = {
      reference: { ...stats(0.45, 0.2), pixels: new Float32Array([0.1, 0.4, 0.7]) },
      moving: { ...stats(0.4, 0.25), pixels: new Float32Array([0, 0.4, 0.8]), valid: new Uint8Array([1, 1, 1]) },
    };
    const reference = controls(0, 100),
      accepted = controls(0, 100);
    const tone = freezeAlignmentFallbackTone(reference, accepted, unadjusted);
    const restored = replayAlignmentFallbackTone(tone, controls(100, 100));
    expect(
      Reflect.ownKeys(tone).every(
        (key) => typeof Reflect.get(tone, key) === 'number' && Number.isFinite(Reflect.get(tone, key)),
      ),
    ).toBe(true);
    unadjusted.reference.mean = 0.9;
    unadjusted.reference.stddev = 0;
    unadjusted.reference.pixels.fill(0);
    unadjusted.moving.mean = 0;
    reference.brightness = 200;
    accepted.contrast = 1;
    expect(replayAlignmentFallbackTone(tone, controls(100, 100))).toEqual(restored);
    expect(replayAlignmentFallbackTone(tone, controls(0, 100))).toEqual(controls(0, 100));
  });
});
