import { describe, expect, it } from 'vitest';
import { collectTrackingPrompts } from '../src/utils/segmentation/interactivePrompts';
import { voxelIndex } from '../src/utils/segmentation/seededVolume';
import type { SvrVolume } from '../src/types/svr';

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
