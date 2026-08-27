import { describe, expect, it } from 'vitest';
import type { SvrLabelVolume, SvrVolume } from '../src/types/svr';
import { DEFAULT_SVR_PARAMS } from '../src/types/svr';
import {
  REGION_DETAIL_SPACING_MM,
  regionalRefinementParameters,
  resampleSelectionForRefinement,
  selectionFocusRoi,
} from '../src/utils/svr/refineRegion';
import { SELECTION_LABEL_META } from '../src/utils/segmentation/selectionEditing';

const volume = (
  dims: [number, number, number],
  spacing: [number, number, number],
  origin: [number, number, number],
): SvrVolume => ({
  data: new Float32Array(dims[0] * dims[1] * dims[2]).fill(0.6),
  observedSupport: new Uint8Array(dims[0] * dims[1] * dims[2]).fill(1),
  dims,
  voxelSizeMm: spacing,
  originMm: origin,
  boundsMm: {
    min: origin,
    max: origin.map((value, axis) => value + (dims[axis]! - 1) * spacing[axis]!) as [number, number, number],
  },
});
const selection = (source: SvrVolume): SvrLabelVolume => ({
  data: Uint8Array.from(source.data, (_, index) => (index === 13 ? 1 : 0)),
  dims: source.dims,
  meta: SELECTION_LABEL_META,
  reviewState: 'reviewed',
  seeds: { foreground: Uint32Array.of(13), background: Uint32Array.of(14) },
});

describe('source-backed regional detail and annotation transfer', () => {
  it('refines the accepted solver settings without introducing registration into native geometry', () => {
    const source = volume([3, 3, 3], [1, 1, 1], [0, 0, 0]);
    const roi = selectionFocusRoi(source, selection(source), 'preview');
    const accepted = { ...DEFAULT_SVR_PARAMS, iterations: 7, robustDelta: 0.03 };
    const refined = regionalRefinementParameters(accepted, roi);
    expect(refined).toEqual({ ...accepted, roi, targetVoxelSizeMm: 0.5, seriesRegistrationMode: 'none' });
    expect(accepted.seriesRegistrationMode).toBe('roi-rigid');
    expect(accepted.roi).toBeUndefined();
  });

  it.each(['bounds-center', 'roi-rigid'] as const)('retains existing %s registration and its reference', (mode) => {
    const source = volume([3, 3, 3], [1, 1, 1], [0, 0, 0]);
    const oldRoi = selectionFocusRoi(source, selection(source), 'accepted-reference');
    const newRoi = { ...oldRoi, sourceSeriesUid: 'different-preview' };
    const accepted = { ...DEFAULT_SVR_PARAMS, seriesRegistrationMode: mode, roi: oldRoi };
    const refined = regionalRefinementParameters(accepted, newRoi);
    expect(refined.seriesRegistrationMode).toBe(mode);
    expect(refined.roi?.sourceSeriesUid).toBe('accepted-reference');
    expect(refined.roi?.boundsMm).toBe(newRoi.boundsMm);
    expect(newRoi.sourceSeriesUid).toBe('different-preview');
    expect(accepted.roi).toBe(oldRoi);
  });

  it('retains implicit source selection for a whole-volume bounds-center registration', () => {
    const source = volume([3, 3, 3], [1, 1, 1], [0, 0, 0]);
    const roi = selectionFocusRoi(source, selection(source), 'different-preview');
    const refined = regionalRefinementParameters(
      { ...DEFAULT_SVR_PARAMS, seriesRegistrationMode: 'bounds-center' },
      roi,
    );
    expect(refined.seriesRegistrationMode).toBe('bounds-center');
    expect(refined.roi?.sourceSeriesUid).toBeUndefined();
  });

  it('encloses the selected physical footprint and exclusion marks with context on every axis', () => {
    const source = volume([3, 3, 3], [1, 2, 3], [10, -20, 30]);
    const labels = selection(source);
    const roi = selectionFocusRoi(source, labels, 'series-a');
    expect(roi.sourceSeriesUid).toBe('series-a');
    // Selection center (11,-18,33), background center (12,-18,33).
    const center = roi.boundsMm.min.map((value, axis) => (value + roi.boundsMm.max[axis]!) / 2);
    expect(center).toEqual([11.5, -18, 33]);
    expect(roi.boundsMm.max.map((value, axis) => value - roi.boundsMm.min[axis]!)).toEqual([27, 27, 27]);
    expect(() => selectionFocusRoi(source, { ...labels, data: new Uint8Array(27) })).toThrow(/mark a region/i);
    expect(() => selectionFocusRoi(source, { ...labels, dims: [1, 3, 9] })).toThrow(/does not match/);
  });

  it('maps annotations through patient millimeters, retains both mark classes, and downgrades review', async () => {
    const source = volume([3, 3, 3], [1, 2, 3], [10, -20, 30]);
    const target = volume([5, 5, 5], [0.5, 1, 1.5], [10, -20, 30]);
    const labels = selection(source),
      original = labels.data.slice();
    const result = await resampleSelectionForRefinement(source, labels, target);
    expect(result.dims).toEqual([5, 5, 5]);
    expect(result.reviewState).toBe('draft');
    const center = (2 * 5 + 2) * 5 + 2,
      excluded = (2 * 5 + 2) * 5 + 4;
    expect(result.data[center]).toBe(1);
    expect(result.seeds!.foreground).toContain(center);
    expect(result.seeds!.background).toContain(excluded);
    expect(result.data[excluded]).toBe(0);
    expect(labels.reviewState).toBe('reviewed');
    expect(labels.data).toEqual(original);
  });

  it('does not transfer labels or seeds into missing or nonfinite source/target evidence', async () => {
    const source = volume([3, 3, 3], [1, 1, 1], [0, 0, 0]);
    const target = volume([3, 3, 3], [1, 1, 1], [0, 0, 0]);
    const labels = selection(source);
    target.observedSupport![13] = 0;
    let result = await resampleSelectionForRefinement(source, labels, target);
    expect(result.data.some(Boolean)).toBe(false);
    expect(result.seeds!.foreground).toHaveLength(0);
    target.observedSupport!.fill(1);
    source.data[13] = NaN;
    result = await resampleSelectionForRefinement(source, labels, target);
    expect(result.data.some(Boolean)).toBe(false);
  });

  it('keeps unrelated patient-space crops empty and rejects inconsistent geometry', async () => {
    const source = volume([3, 3, 3], [1, 1, 1], [0, 0, 0]),
      labels = selection(source);
    expect(
      (await resampleSelectionForRefinement(source, labels, volume([3, 3, 3], [1, 1, 1], [50, 50, 50]))).data.some(
        Boolean,
      ),
    ).toBe(false);
    await expect(resampleSelectionForRefinement(source, labels, { ...source, voxelSizeMm: [0, 1, 1] })).rejects.toThrow(
      /geometry/,
    );
    await expect(resampleSelectionForRefinement(source, { ...labels, dims: [1, 3, 9] }, source)).rejects.toThrow(
      /geometry/,
    );
  });

  it('honors cancellation and never treats a finer grid as measured acquired resolution', async () => {
    const source = volume([3, 3, 3], [1.5, 1.5, 1.5], [0, 0, 0]);
    const signal = new AbortController();
    signal.abort();
    await expect(
      resampleSelectionForRefinement(source, selection(source), source, signal.signal),
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(REGION_DETAIL_SPACING_MM).toBe(0.5);
    expect(source.voxelSizeMm).toEqual([1.5, 1.5, 1.5]);
  });
});
