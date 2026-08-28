import { describe, expect, it } from 'vitest';
import type { SvrVolume } from '../src/types/svr';
import {
  composePatientTransforms,
  inverseTransformPoint,
  patientToVolumeVoxel,
  physicalVolumeBounds,
  snapshotPatientTransform,
  transformPoint,
  volumeVoxelToPatient,
} from '../src/utils/svr/volumeGeometry';
import { resampleSelectionForRefinement, selectionFocusRoi } from '../src/utils/svr/refineRegion';
import { SELECTION_LABEL_META } from '../src/utils/segmentation/selectionEditing';

const source: SvrVolume = {
  data: new Float32Array(27).fill(-2),
  observedSupport: new Uint8Array(27).fill(1),
  dims: [3, 3, 3],
  voxelSizeMm: [1, 2, 3],
  direction: [0, -1, 0, 1, 0, 0, 0, 0, 1],
  originMm: [10, 20, 30],
  boundsMm: { min: [5, 19.5, 28.5], max: [11, 22.5, 37.5] },
};

describe('accepted patient-space volume geometry', () => {
  it('maps oriented anisotropic voxel centers and physical footprint corners in both directions', () => {
    expect(volumeVoxelToPatient(source, [1, 1, 1])).toEqual([8, 21, 33]);
    expect(patientToVolumeVoxel(source, [8, 21, 33])).toEqual([1, 1, 1]);
    expect(physicalVolumeBounds(source)).toEqual(source.boundsMm);
    const point = [0.25, 1.7, -0.1] as const;
    patientToVolumeVoxel(source, volumeVoxelToPatient(source, point)).forEach((value, axis) =>
      expect(value).toBeCloseTo(point[axis]!, 10),
    );
  });

  it('composes absolute rigid transforms without confusing rotation centers and crop offsets', () => {
    const inner = { rotation: source.direction!, translationMm: [5, -3, 2] as const };
    const outer = { rotation: [1, 0, 0, 0, 0, -1, 0, 1, 0] as const, translationMm: [-1, 2, 4] as const };
    const point = [1, 2, 3] as const;
    expect(transformPoint(inner, point)).toEqual([3, -2, 5]);
    expect(inverseTransformPoint(inner, [3, -2, 5])).toEqual(point);
    expect(transformPoint(composePatientTransforms(outer, inner), point)).toEqual(
      transformPoint(outer, transformPoint(inner, point)),
    );
  });

  it('detaches accepted pose snapshots and rejects scaling, reflection, shear and nonfinite translations', () => {
    const rotation: [number, number, number, number, number, number, number, number, number] = [
      1, 0, 0, 0, 1, 0, 0, 0, 1,
    ];
    const translationMm: [number, number, number] = [7, -3, 2];
    const snapshot = snapshotPatientTransform({ rotation, translationMm });
    rotation[0] = 2;
    translationMm[0] = 99;
    expect(snapshot.rotation).toEqual([1, 0, 0, 0, 1, 0, 0, 0, 1]);
    expect(snapshot.translationMm).toEqual([7, -3, 2]);
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot.rotation)).toBe(true);
    expect(Object.isFrozen(snapshot.translationMm)).toBe(true);
    for (const invalid of [
      { rotation, translationMm },
      { rotation: [-1, 0, 0, 0, 1, 0, 0, 0, 1] as const, translationMm },
      { rotation: [1, 0.1, 0, 0, 1, 0, 0, 0, 1] as const, translationMm },
      { rotation: snapshot.rotation, translationMm: [Infinity, 0, 0] as const },
    ])
      expect(() => snapshotPatientTransform(invalid)).toThrow(/finite rigid patient-space transform/);
  });

  it('places focus regions and transferred marks in patient space, not raw grid-axis coordinates', async () => {
    const labels = {
      data: Uint8Array.from({ length: 27 }, (_, index) => (index === 13 ? 1 : 0)),
      dims: source.dims,
      meta: SELECTION_LABEL_META,
      seeds: { foreground: Uint32Array.of(13), background: Uint32Array.of(14) },
    };
    const roi = selectionFocusRoi(source, labels);
    expect(roi.boundsMm.min.map((value, axis) => (value + roi.boundsMm.max[axis]!) / 2)).toEqual([8, 21.5, 33]);
    const target: SvrVolume = {
      ...source,
      direction: undefined,
      dims: [9, 5, 5],
      voxelSizeMm: [0.5, 0.5, 1.5],
      originMm: [6, 20, 30],
      data: new Float32Array(225).fill(-2),
      observedSupport: new Uint8Array(225).fill(1),
    };
    const transferred = await resampleSelectionForRefinement(source, labels, target);
    expect(transferred.data[(2 * 5 + 2) * 9 + 4]).toBe(1);
    expect(transferred.seeds!.foreground).toContain((2 * 5 + 2) * 9 + 4);
    expect(transferred.seeds!.background).toContain((2 * 5 + 4) * 9 + 4);
    expect(transferred.data[(2 * 5 + 4) * 9 + 4]).toBe(0);
    expect(transferred.reviewState).toBe('draft');
  });
});
