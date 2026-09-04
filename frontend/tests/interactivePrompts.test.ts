import { describe, expect, it } from 'vitest';
import { collectTrackingPrompts, planTrackingPrompts } from '../src/utils/segmentation/interactivePrompts';
import { SLICE_AXES } from '../src/utils/segmentation/selectionEditing';
import { voxelIndex } from '../src/utils/segmentation/voxelGeometry';
import type { SvrDirection, SvrRoiPlane, SvrSelectionSeeds, SvrVolume } from '../src/types/svr';
import type { NativeSourceGrid } from '../src/utils/svr/nativeSourceContext';
import { physicalVolumeBounds } from '../src/utils/svr/volumeGeometry';

const source = (): Pick<SvrVolume, 'data' | 'observedSupport' | 'dims' | 'voxelSizeMm'> => ({
  data: new Float32Array(8 * 7 * 6).fill(17),
  observedSupport: new Uint8Array(8 * 7 * 6).fill(1),
  dims: [8, 7, 6],
  voxelSizeMm: [1, 1, 2],
});
const seeds = (inside: number[], outside: number[] = []) => ({
  foreground: Uint32Array.from(inside),
  background: Uint32Array.from(outside),
});
const index = (x: number, y: number, z: number) => voxelIndex({ x, y, z }, [8, 7, 6]);

describe('literal source-plane prompts', () => {
  it('reduces disconnected marks to actual center voxels and preserves every input byte', () => {
    const volume = source();
    const marks = seeds([index(1, 2, 3), index(2, 2, 3), index(3, 2, 3), index(6, 5, 3)], [index(6, 1, 3)]);
    const before = {
      volume: { ...volume, data: volume.data.slice(), observedSupport: volume.observedSupport!.slice() },
      marks: { foreground: marks.foreground.slice(), background: marks.background.slice() },
    };
    expect(collectTrackingPrompts(volume, 'axial', marks)).toEqual([
      {
        index: 3,
        points: [
          [2, 2],
          [6, 5],
          [6, 1],
        ],
        labels: [1, 1, 0],
      },
    ]);
    expect(volume).toEqual(before.volume);
    expect(marks).toEqual(before.marks);
  });

  it('never projects another section or creates a positive prompt for a negative-only section', () => {
    expect(collectTrackingPrompts(source(), 'axial', seeds([index(2, 3, 1)], [index(2, 3, 4)]))).toEqual([
      { index: 1, points: [[2, 3]], labels: [1] },
      { index: 4, points: [[2, 3]], labels: [0] },
    ]);
  });

  it.each([
    ['axial', 4, [2, 3]],
    ['coronal', 3, [2, 4]],
    ['sagittal', 2, [3, 4]],
  ] as const)('uses increasing native axes in %s, not display row flips', (plane, frame, point) => {
    expect(collectTrackingPrompts(source(), plane, seeds([index(2, 3, 4)]))).toEqual([
      { index: frame, points: [point], labels: [1] },
    ]);
  });

  it('keeps a medoid on the actual marked U shape rather than its unmarked centroid', () => {
    const marked = [
      index(1, 1, 2),
      index(1, 2, 2),
      index(1, 3, 2),
      index(2, 3, 2),
      index(3, 3, 2),
      index(3, 2, 2),
      index(3, 1, 2),
    ];
    const result = collectTrackingPrompts(source(), 'axial', seeds(marked));
    expect(result[0]!.points).toHaveLength(1);
    const [x, y] = result[0]!.points[0]!;
    expect(marked).toContain(index(x, y, 2));
    expect([x, y]).not.toEqual([2, 2]);
  });

  it('preserves component order while ignoring duplicate and reordered samples within a stroke', () => {
    const marked = [index(2, 2, 1), index(3, 2, 1), index(6, 5, 1)];
    expect(collectTrackingPrompts(source(), 'axial', seeds([marked[1]!, marked[0]!, marked[2]!, ...marked]))).toEqual(
      collectTrackingPrompts(source(), 'axial', seeds(marked)),
    );
    expect(collectTrackingPrompts(source(), 'axial', seeds([...marked].reverse()))[0]!.points).toEqual([
      [6, 5],
      [2, 2],
    ]);
  });

  it('does not connect adjacent flat indices across a row boundary', () => {
    expect(collectTrackingPrompts(source(), 'axial', seeds([index(7, 1, 2), index(0, 2, 2)]))[0]!.points).toEqual([
      [7, 1],
      [0, 2],
    ]);
  });

  it('uses physical distance when selecting a marked center on an anisotropic section', () => {
    const volume = source();
    const marks = seeds([index(2, 2, 1), index(4, 2, 1), index(3, 3, 1)]);
    expect(collectTrackingPrompts(volume, 'axial', marks)[0]!.points).toEqual([[3, 3]]);
    volume.voxelSizeMm = [1, 4, 2];
    expect(collectTrackingPrompts(volume, 'axial', marks)[0]!.points).toEqual([[2, 2]]);
  });

  it('rejects unavailable source marks and conflicting labels', () => {
    const volume = source();
    const point = index(2, 2, 2);
    volume.observedSupport![point] = 0;
    expect(() => collectTrackingPrompts(volume, 'axial', seeds([point]))).toThrow(/acquired source/);
    volume.observedSupport![point] = 1;
    volume.data[point] = NaN;
    expect(() => collectTrackingPrompts(volume, 'axial', seeds([point]))).toThrow(/acquired source/);
    volume.data[point] = 17;
    expect(() => collectTrackingPrompts(volume, 'axial', seeds([point], [point]))).toThrow(/both inside and outside/);
    expect(() => collectTrackingPrompts(volume, 'axial', seeds([volume.data.length]))).toThrow(/acquired source/);
  });
});

describe('editing-owned native prompt plans', () => {
  const native: NativeSourceGrid = { dims: [64, 64, 64], voxelSizeMm: [1, 1, 1], originMm: [0, 0, 0] };
  function editing(overrides: Partial<NativeSourceGrid> = {}): SvrVolume {
    const values = source();
    const geometry: NativeSourceGrid = {
      dims: values.dims,
      voxelSizeMm: [2, 2, 2],
      originMm: [1, 3, 5],
      ...overrides,
    };
    return { ...values, ...geometry, boundsMm: physicalVolumeBounds(geometry) };
  }
  function square(plane: SvrRoiPlane, section: number) {
    const axes = SLICE_AXES[plane];
    return Array.from({ length: 9 }, (_, i) => {
      const point = { x: 0, y: 0, z: 0 };
      point[axes.column] = 1 + (i % 3);
      point[axes.row] = 1 + Math.floor(i / 3);
      point[axes.slice] = section;
      return index(point.x, point.y, point.z);
    });
  }
  function marked(
    inside: number[],
    outside: number[] = [],
    plane: SvrRoiPlane = 'axial',
    slice = 2,
  ): SvrSelectionSeeds {
    return { ...seeds(inside, outside), lastStroke: { plane, slice } };
  }

  it.each([
    ['axial', 11, [5, 8]],
    ['coronal', 8, [5, 11]],
    ['sagittal', 5, [8, 11]],
  ] as const)('keeps a coarse 3x3 brush as one exact %s prompt with anisotropic phase', (plane, frame, point) => {
    const volume = editing({ voxelSizeMm: [2, 3, 4], originMm: [1, 2, 3] });
    const marks = marked(square(plane, 2), [], plane);
    const before = {
      volume: { ...volume, data: volume.data.slice(), observedSupport: volume.observedSupport!.slice() },
      marks: { ...marks, foreground: marks.foreground.slice(), background: marks.background.slice() },
      native: JSON.stringify(native),
    };
    expect(planTrackingPrompts(volume, native, marks)).toEqual({
      stroke: { plane, slice: frame },
      frames: [{ index: frame, points: [point], labels: [1] }],
      conditioningFrames: 1,
      maximumFramePrompts: 1,
      literalMarkCount: 9,
    });
    expect(volume).toEqual(before.volume);
    expect(marks).toEqual(before.marks);
    expect(JSON.stringify(native)).toBe(before.native);
  });

  it('keeps separate positive/negative components and bounds the busiest frame, not all frames together', () => {
    const marks = marked(
      [...square('axial', 1), index(6, 5, 1), index(2, 2, 4)],
      [index(6, 1, 1), index(1, 5, 4), index(2, 5, 4), index(5, 5, 5)],
      'axial',
      4,
    );
    const result = planTrackingPrompts(editing(), native, marks);
    expect(result).toEqual({
      stroke: { plane: 'axial', slice: 13 },
      frames: [
        {
          index: 7,
          points: [
            [5, 7],
            [13, 13],
            [13, 5],
          ],
          labels: [1, 1, 0],
        },
        {
          index: 13,
          points: [
            [5, 7],
            [3, 13],
          ],
          labels: [1, 0],
        },
        { index: 15, points: [[11, 13]], labels: [0] },
      ],
      conditioningFrames: 3,
      maximumFramePrompts: 3,
      literalMarkCount: 15,
    });
    expect(result.frames.reduce((sum, frame) => sum + frame.points.length, 0)).toBe(6);
    expect(marks.foreground).toHaveLength(11);
    expect(marks.background).toHaveLength(4);
  });

  it.each([1, -1] as const)('maps signed axis permutations (%s) and sorts by actual native frame', (sign) => {
    const direction: SvrDirection = [0, 0, 1, sign, 0, 0, 0, sign, 0];
    const volume = editing({
      voxelSizeMm: [2, 3, 4],
      originMm: sign === 1 ? [5, 2, 3] : [5, 40, 40],
      direction,
    });
    const marks = marked(square('coronal', 1), [index(6, 4, 4)], 'coronal', 2);
    expect(planTrackingPrompts(volume, native, marks)).toEqual({
      stroke: { plane: 'axial', slice: sign === 1 ? 9 : 34 },
      frames:
        sign === 1
          ? [
              { index: 6, points: [[13, 6]], labels: [1] },
              { index: 15, points: [[21, 14]], labels: [0] },
            ]
          : [
              { index: 28, points: [[21, 28]], labels: [0] },
              { index: 37, points: [[13, 36]], labels: [1] },
            ],
      conditioningFrames: 2,
      maximumFramePrompts: 1,
      literalMarkCount: 10,
    });
  });

  it('resolves centroid ties by the owning editing index before a native-axis reversal', () => {
    const volume = editing({
      voxelSizeMm: [1, 1, 2],
      originMm: [7, 0, 0],
      direction: [-1, 0, 0, 0, 1, 0, 0, 0, 1],
    });
    for (const points of [
      [index(2, 2, 1), index(3, 2, 1)],
      [index(3, 2, 1), index(2, 2, 1)],
    ]) {
      const marks = marked(points, [], 'axial', 1);
      // The painted x=2 wins intentionally, although painted x=3 has the lower native index.
      expect(planTrackingPrompts(volume, native, marks).frames).toEqual([{ index: 2, points: [[5, 2]], labels: [1] }]);
      expect(Array.from(marks.foreground)).toEqual(points);
    }
  });

  it('regroups earlier orthogonal marks on their own sections of the current tracking orientation', () => {
    const marks = marked(square('axial', 2), [index(6, 2, 4)], 'coronal', 2);
    expect(planTrackingPrompts(editing(), native, marks)).toEqual({
      stroke: { plane: 'coronal', slice: 7 },
      frames: [
        { index: 5, points: [[5, 9]], labels: [1] },
        {
          index: 7,
          points: [
            [5, 9],
            [13, 13],
          ],
          labels: [1, 0],
        },
        { index: 9, points: [[5, 9]], labels: [1] },
      ],
      conditioningFrames: 3,
      maximumFramePrompts: 2,
      literalMarkCount: 10,
    });
  });

  it.each(['missing plane', 'fractional phase', 'conflict', 'unsupported', 'nonfinite', 'out of grid'])(
    'rejects %s even when the chosen representative alone would not expose an invalid literal mark',
    (failure) => {
      const volume = editing();
      const marks = marked([index(1, 2, 2), index(2, 2, 2), index(3, 2, 2)]);
      if (failure === 'missing plane') delete marks.lastStroke;
      if (failure === 'fractional phase') volume.originMm[0] += 1e-8;
      if (failure === 'conflict') marks.background = Uint32Array.of(index(3, 2, 2), index(4, 2, 2), index(5, 2, 2));
      if (failure === 'unsupported') volume.observedSupport![index(1, 2, 2)] = 0;
      if (failure === 'nonfinite') volume.data[index(1, 2, 2)] = NaN;
      if (failure === 'out of grid') marks.foreground = Uint32Array.from([...marks.foreground, volume.data.length]);
      expect(() => planTrackingPrompts(volume, native, marks)).toThrow();
    },
  );
});
