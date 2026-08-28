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
import { transferSelectionAnnotations } from '../src/utils/svr/annotationTransfer';
import { volumeVoxelToPatient } from '../src/utils/svr/volumeGeometry';

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
    expect(roi.mode).toBe('cube');
    expect(roi.sourceSeriesUid).toBe('series-a');
    // Selection center (11,-18,33), background center (12,-18,33).
    const center = roi.boundsMm.min.map((value, axis) => (value + roi.boundsMm.max[axis]!) / 2);
    expect(center).toEqual([11.5, -18, 33]);
    expect(roi.boundsMm.max.map((value, axis) => value - roi.boundsMm.min[axis]!)).toEqual([27, 27, 27]);
    expect(() => selectionFocusRoi(source, { ...labels, data: new Uint8Array(27) })).toThrow(/mark a region/i);
    expect(() => selectionFocusRoi(source, { ...labels, dims: [1, 3, 9] })).toThrow(/does not match/);
  });

  it('uses a rectangular native-detail crop for the reported elongated overview footprint, without changing pitch', () => {
    const source = volume([137, 256, 256], [1.2, 0.8594, 0.8594], [0, 0, 0]);
    source.nativeVoxelSizeMm = [0.6, 0.4297, 0.4297];
    const at = (x: number, y: number, z: number) => (z * 256 + y) * 137 + x;
    const labels: SvrLabelVolume = {
      data: new Uint8Array(source.data.length),
      dims: source.dims,
      meta: SELECTION_LABEL_META,
    };
    labels.data[at(61, 88, 77)] = 1;
    labels.data[at(78, 149, 128)] = 1;
    const roi = selectionFocusRoi(source, labels, 'native-source');
    expect(roi.mode).toBe('box');
    expect(roi.sourceSeriesUid).toBe('native-source');
    const spans = roi.boundsMm.max.map((value, axis) => value - roi.boundsMm.min[axis]!);
    [25.6, 57.2828, 48.6888].forEach((expected, axis) => expect(spans[axis]).toBeCloseTo(expected, 8));
    const oldCubeSide = 62 * 0.8594 + 24;
    expect(spans.reduce((product, value) => product * value, 1)).toBeLessThan(oldCubeSide ** 3 * 0.16);
    expect(source.voxelSizeMm).toEqual([1.2, 0.8594, 0.8594]);
    expect(source.nativeVoxelSizeMm).toEqual([0.6, 0.4297, 0.4297]);
  });

  it('includes both hard-mark classes outside the native mask with full voxel footprints and a physical halo', () => {
    const source = volume([7, 8, 6], [2, 3, 4], [0, 0, 0]);
    source.nativeVoxelSizeMm = [1, 1.5, 2];
    const at = (x: number, y: number, z: number) => (z * 8 + y) * 7 + x;
    const labels: SvrLabelVolume = {
      data: new Uint8Array(source.data.length),
      dims: source.dims,
      meta: SELECTION_LABEL_META,
      seeds: { foreground: Uint32Array.of(at(1, 2, 1)), background: Uint32Array.of(at(6, 7, 5)) },
    };
    labels.data[at(3, 3, 3)] = 1;
    const before = labels.data.slice();
    const roi = selectionFocusRoi(source, labels);
    expect(roi.mode).toBe('box');
    // Two native voxels = 4 mm halo; overview voxels contribute their entire footprint.
    expect(roi.boundsMm.min).toEqual([-3, 0.5, -2]);
    expect(roi.boundsMm.max).toEqual([17, 26.5, 26]);
    expect(labels.data).toEqual(before);
    expect([...labels.seeds!.foreground]).toEqual([at(1, 2, 1)]);
    expect([...labels.seeds!.background]).toEqual([at(6, 7, 5)]);
  });

  it('keeps the reported oblique native envelope rectangular without the legacy reconstruction margin', () => {
    // The reported overview bounds cover 18 x 62 x 52 cells. Translating that
    // envelope to a smaller fixture preserves its physical spans exactly.
    const source = volume([18, 62, 52], [1.2, 0.8594, 0.8594], [10, -20, 30]);
    source.nativeVoxelSizeMm = [0.6, 0.4297, 0.4297];
    source.direction = [
      0.9907976137717656, -0.1332995108383476, 0.02348039510809774, 0.13535172161109166, 0.9757764192486331,
      -0.17187289226410685, -0.0000010433959452665734, 0.1734693634293185, 0.9848392660481905,
    ];
    const labels: SvrLabelVolume = {
      data: new Uint8Array(source.data.length),
      dims: source.dims,
      meta: SELECTION_LABEL_META,
    };
    // All eight corners bound the worst-case full envelope; this fixture makes
    // no assertion about which interior voxels were selected in the live scan.
    for (const x of [0, 17]) for (const y of [0, 61]) for (const z of [0, 51]) labels.data[(z * 62 + y) * 18 + x] = 1;
    const roi = selectionFocusRoi(source, labels);
    const spans = roi.boundsMm.max.map((value, axis) => value - roi.boundsMm.min[axis]!);
    expect(roi.mode).toBe('box');
    [33.553110314474395, 66.59649028615286, 57.254240927658486].forEach((expected, axis) =>
      expect(spans[axis]).toBeCloseTo(expected, 8),
    );
    const legacy = selectionFocusRoi({ ...source, nativeVoxelSizeMm: undefined }, labels);
    expect(legacy.mode).toBe('cube');
    const legacySpans = legacy.boundsMm.max.map((value, axis) => value - legacy.boundsMm.min[axis]!);
    for (const span of legacySpans) expect(span).toBeCloseTo(86.59649028615286, 8);
    expect(spans.reduce((product, value) => product * value, 1)).toBeLessThan(
      legacySpans.reduce((product, value) => product * value, 1) * 0.2,
    );
    expect(source.nativeVoxelSizeMm).toEqual([0.6, 0.4297, 0.4297]);
  });

  it('bounds actual native voxel footprints in oblique patient space, not the loose rotated grid box', () => {
    const source = volume([6, 7, 5], [2, 1, 3], [10, -20, 30]);
    source.nativeVoxelSizeMm = [0.5, 0.25, 0.75];
    const c = Math.SQRT1_2;
    source.direction = [c, -c, 0, c, c, 0, 0, 0, 1];
    const points = [
      [1, 2, 1],
      [4, 5, 3],
    ] as const;
    const labels: SvrLabelVolume = {
      data: new Uint8Array(source.data.length),
      dims: source.dims,
      meta: SELECTION_LABEL_META,
    };
    for (const [x, y, z] of points) labels.data[(z * 7 + y) * 6 + x] = 1;
    const roi = selectionFocusRoi(source, labels);
    const minimum = [Infinity, Infinity, Infinity],
      maximum = [-Infinity, -Infinity, -Infinity];
    for (const point of points)
      for (const dx of [-0.5, 0.5])
        for (const dy of [-0.5, 0.5])
          for (const dz of [-0.5, 0.5]) {
            const corner = volumeVoxelToPatient(source, [point[0] + dx, point[1] + dy, point[2] + dz]);
            for (let axis = 0; axis < 3; axis++) {
              minimum[axis] = Math.min(minimum[axis]!, corner[axis]!);
              maximum[axis] = Math.max(maximum[axis]!, corner[axis]!);
            }
          }
    for (let axis = 0; axis < 3; axis++) {
      expect(roi.boundsMm.min[axis]).toBeCloseTo(minimum[axis]! - 2, 10);
      expect(roi.boundsMm.max[axis]).toBeCloseTo(maximum[axis]! + 2, 10);
    }
    expect(roi.boundsMm.max[0] - roi.boundsMm.min[0]).toBeCloseTo(6 * c + 4, 10);
    const legacy = selectionFocusRoi({ ...source, nativeVoxelSizeMm: undefined }, labels);
    expect(legacy.mode).toBe('cube');
    expect(legacy.boundsMm.max.map((value, axis) => value - legacy.boundsMm.min[axis]!)).toEqual([
      legacy.boundsMm.max[0] - legacy.boundsMm.min[0],
      legacy.boundsMm.max[0] - legacy.boundsMm.min[0],
      legacy.boundsMm.max[0] - legacy.boundsMm.min[0],
    ]);
  });

  it('rejects invalid native sampling or unowned marks instead of trimming a native crop', () => {
    const source = volume([3, 3, 3], [1, 1, 1], [0, 0, 0]);
    const labels = selection(source);
    source.nativeVoxelSizeMm = [0.5, NaN, 0.5];
    expect(() => selectionFocusRoi(source, labels)).toThrow(/finite positive source sampling/);
    source.nativeVoxelSizeMm = [0.5, 0.5, 0.5];
    labels.seeds!.background = Uint32Array.of(100);
    expect(() => selectionFocusRoi(source, labels)).toThrow(/mark does not belong.*retained/);
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

  it('omits unsupported unmarked labels but rejects lost explicit marks', async () => {
    const source = volume([3, 3, 3], [1, 1, 1], [0, 0, 0]);
    const target = volume([3, 3, 3], [1, 1, 1], [0, 0, 0]);
    const labels = selection(source);
    target.observedSupport![13] = 0;
    let result = await resampleSelectionForRefinement(source, { ...labels, seeds: undefined }, target);
    expect(result.data.some(Boolean)).toBe(false);
    expect(result.seeds!.foreground).toHaveLength(0);
    await expect(resampleSelectionForRefinement(source, labels, target)).rejects.toThrow(/supported MRI sample/);
    target.observedSupport!.fill(1);
    source.data[13] = NaN;
    result = await resampleSelectionForRefinement(source, { ...labels, seeds: undefined }, target);
    expect(result.data.some(Boolean)).toBe(false);
    await expect(resampleSelectionForRefinement(source, labels, target)).rejects.toThrow(/unsupported source evidence/);
  });

  it('keeps unrelated patient-space crops empty and rejects inconsistent geometry', async () => {
    const source = volume([3, 3, 3], [1, 1, 1], [0, 0, 0]),
      labels = selection(source);
    expect(
      (
        await resampleSelectionForRefinement(
          source,
          { ...labels, seeds: undefined },
          volume([3, 3, 3], [1, 1, 1], [50, 50, 50]),
        )
      ).data.some(Boolean),
    ).toBe(false);
    await expect(
      resampleSelectionForRefinement(source, labels, volume([3, 3, 3], [1, 1, 1], [50, 50, 50])),
    ).rejects.toThrow(/outside this region.*contains all marks/);
    await expect(resampleSelectionForRefinement(source, labels, { ...source, voxelSizeMm: [0, 1, 1] })).rejects.toThrow(
      /geometry/,
    );
    await expect(resampleSelectionForRefinement(source, { ...labels, dims: [1, 3, 9] }, source)).rejects.toThrow(
      /geometry/,
    );
    await expect(
      resampleSelectionForRefinement(source, labels, { ...source, direction: [1, 1, 0, 0, 1, 0, 0, 0, 1] }),
    ).rejects.toThrow(/orthonormal.*geometry/);
  });

  it('preserves a one-cell hard inside mark through coarsening instead of silently dropping it', async () => {
    const source = volume([3, 3, 3], [1, 1, 1], [0, 0, 0]);
    const labels = selection(source);
    labels.seeds!.background = Uint32Array.of(0);
    const before = labels.data.slice();
    const target = volume([2, 2, 2], [2, 2, 2], [0, 0, 0]);
    const transferred = await resampleSelectionForRefinement(source, labels, target);
    expect([...transferred.data]).toEqual([0, 0, 0, 0, 0, 0, 0, 1]);
    expect([...transferred.seeds!.foreground]).toEqual([7]);
    expect([...transferred.seeds!.background]).toEqual([0]);
    expect(transferred.reviewState).toBe('draft');
    expect(labels.data).toEqual(before);
    expect([...labels.seeds!.foreground]).toEqual([13]);
  });

  it('rejects opposing marks collapsing into the same coarse target cell', async () => {
    const source = volume([3, 3, 3], [1, 1, 1], [0, 0, 0]);
    const labels = selection(source);
    await expect(
      resampleSelectionForRefinement(source, labels, volume([2, 2, 2], [2, 2, 2], [0, 0, 0])),
    ).rejects.toThrow(/same cell.*finer region/);
    expect(labels.data[13]).toBe(1);
    expect([...labels.seeds!.background]).toEqual([14]);
  });

  it.each([
    ['source', 'inside', 'missing'],
    ['source', 'outside', 'missing'],
    ['source', 'inside', 'nonfinite'],
    ['source', 'outside', 'nonfinite'],
    ['target', 'inside', 'missing'],
    ['target', 'outside', 'missing'],
    ['target', 'inside', 'nonfinite'],
    ['target', 'outside', 'nonfinite'],
  ] as const)('rejects %s %s marks with %s evidence', async (side, kind, evidence) => {
    const source = volume([3, 3, 3], [1, 1, 1], [0, 0, 0]);
    const target = volume([3, 3, 3], [1, 1, 1], [0, 0, 0]);
    const labels = selection(source),
      mark = kind === 'inside' ? 13 : 14;
    const edited = side === 'source' ? source : target;
    if (evidence === 'missing') edited.observedSupport![mark] = 0;
    else edited.data[mark] = NaN;
    await expect(resampleSelectionForRefinement(source, labels, target)).rejects.toThrow(
      /unsupported source evidence|supported MRI sample/,
    );
    expect(labels.data[13]).toBe(1);
    expect(labels.seeds!.foreground).toContain(13);
    expect(labels.seeds!.background).toContain(14);
  });

  it('does not silently discard an outside mark beyond a smaller target crop', async () => {
    const source = volume([3, 3, 3], [1, 1, 1], [0, 0, 0]);
    await expect(
      resampleSelectionForRefinement(source, selection(source), volume([2, 3, 3], [1, 1, 1], [0, 0, 0])),
    ).rejects.toThrow(/outside this region.*contains all marks/);
  });

  it.each(['copy', 'marks'] as const)(
    'honors cancellation during categorical %s without changing source annotations',
    async (phase) => {
      const source = volume([3, 3, 3], [1, 1, 1], [0, 0, 0]);
      const labels = selection(source),
        before = labels.data.slice();
      const geometry = { dims: source.dims, voxelSizeMm: source.voxelSizeMm, originMm: source.originMm };
      const controller = new AbortController();
      let visits = 0;
      await expect(
        transferSelectionAnnotations(geometry, labels, geometry, {
          signal: controller.signal,
          targetSupported: () => {
            if (++visits === (phase === 'copy' ? 2 : source.data.length + 1)) controller.abort();
            return true;
          },
        }),
      ).rejects.toMatchObject({ name: 'AbortError' });
      expect(labels.data).toEqual(before);
      expect(labels.reviewState).toBe('reviewed');
      expect(geometry).not.toHaveProperty('data');
    },
  );

  it('rejects invalid or contradictory source hard marks rather than inferring a class', async () => {
    const source = volume([3, 3, 3], [1, 1, 1], [0, 0, 0]);
    const labels = selection(source);
    labels.seeds!.foreground = Uint32Array.of(100);
    await expect(resampleSelectionForRefinement(source, labels, source)).rejects.toThrow(/inconsistent or unsupported/);
    labels.seeds!.foreground = Uint32Array.of(13);
    labels.seeds!.background = Uint32Array.of(13);
    await expect(resampleSelectionForRefinement(source, labels, source)).rejects.toThrow(/inconsistent or unsupported/);
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
