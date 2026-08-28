import { describe, expect, it } from 'vitest';
import { DEFAULT_SVR_PARAMS, type SvrPatientTransform, type SvrRoi } from '../src/types/svr';
import type { SeriesFrameManifest } from '../src/utils/localApi';
import { filterSvrManifestFramesForRoi, getSvrSourceCropWindow } from '../src/utils/svr/sliceRoiCrop';
import { computeSvrFromLoadedSlices } from '../src/utils/svr/svrComputeCore';
import type { LoadedSlice } from '../src/utils/svr/rigidRegistration';
import { transformPoint } from '../src/utils/svr/volumeGeometry';

const parameters = {
  ...DEFAULT_SVR_PARAMS,
  targetVoxelSizeMm: 1,
  maxVolumeDim: 32,
  iterations: 0,
  psfMode: 'none' as const,
  multiResolution: false,
};

describe('accepted source transforms across regional reconstruction', () => {
  it('inverse-maps ROI admission and native cropping through the accepted rigid fit', () => {
    const manifest: SeriesFrameManifest = {
      seriesUid: 'source',
      studyUid: 'study',
      patientKey: 'patient',
      frameOfReferenceUid: 'frame',
      ordering: 'physical',
      geometryReliable: true,
      frames: Array.from({ length: 10 }, (_, z) => ({
        sopInstanceUid: `source-${z}`,
        seriesInstanceUid: 'source',
        studyInstanceUid: 'study',
        instanceNumber: z,
        rows: 16,
        columns: 16,
        imagePositionPatient: `0\\0\\${z}`,
        imageOrientationPatient: '1\\0\\0\\0\\1\\0',
        pixelSpacing: '1\\1',
        sliceThickness: 1,
      })),
    };
    const transform: SvrPatientTransform = { rotation: [0, 0, 1, 0, 1, 0, -1, 0, 0], translationMm: [100, 50, 20] };
    const roi: SvrRoi = { mode: 'cube', sourcePlane: 'axial', boundsMm: { min: [103, 53, 13], max: [105, 55, 15] } };
    const params = { ...parameters, seriesRegistrationMode: 'none' as const };
    expect(filterSvrManifestFramesForRoi(manifest, roi, params).frames).toHaveLength(0);
    const admitted = filterSvrManifestFramesForRoi(manifest, roi, params, transform);
    expect(admitted.frames.map((frame) => frame.instanceNumber)).toEqual([2, 3, 4, 5, 6]);
    const crop = getSvrSourceCropWindow(admitted.frames[2]!, roi, params, transform);
    expect(crop.rowStart).toBeLessThanOrEqual(3);
    expect(crop.rowStart + crop.rows - 1).toBeGreaterThanOrEqual(5);
    expect(crop.columnStart).toBeLessThanOrEqual(5);
    expect(crop.columnStart + crop.columns - 1).toBeGreaterThanOrEqual(7);
    expect(crop.rows * crop.columns).toBeLessThan(16 * 16);
    expect(transformPoint(transform, [6, 4, 4])).toEqual([104, 54, 14]);
  });

  it('records the real bounds-center mutation and reuses it exactly for a differently cropped region', async () => {
    const slices = (): LoadedSlice[] =>
      ['fixed', 'moving'].map((seriesUid, index) => ({
        seriesUid,
        sopInstanceUid: `${seriesUid}-frame`,
        pixels: new Float32Array(25).fill(0.7),
        valid: new Uint8Array(25).fill(1),
        dsRows: 5,
        dsCols: 5,
        srcRows: 5,
        srcCols: 5,
        rowSpacingMm: 1,
        colSpacingMm: 1,
        rowSpacingDsMm: 1,
        colSpacingDsMm: 1,
        ippMm: index ? { x: 14, y: 17, z: 32 } : { x: 10, y: 20, z: 30 },
        rowDir: { x: 1, y: 0, z: 0 },
        colDir: { x: 0, y: 1, z: 0 },
        normalDir: { x: 0, y: 0, z: 1 },
        sliceThicknessMm: 1,
        spacingBetweenSlicesMm: 1,
      }));
    const original = await computeSvrFromLoadedSlices({
      allSlices: slices(),
      intensitySamples: [0.7],
      svrParams: { ...parameters, seriesRegistrationMode: 'bounds-center' },
      debug: false,
    });
    expect(original.sourceTransforms.fixed).toEqual({
      rotation: [1, 0, 0, 0, 1, 0, 0, 0, 1],
      translationMm: [0, 0, 0],
    });
    expect(original.sourceTransforms.moving).toEqual({
      rotation: [1, 0, 0, 0, 1, 0, 0, 0, 1],
      translationMm: [-4, 3, -2],
    });
    const native = slices();
    const refined = await computeSvrFromLoadedSlices({
      allSlices: native,
      intensitySamples: [0.7],
      svrParams: {
        ...parameters,
        seriesRegistrationMode: 'roi-rigid',
        roi: {
          mode: 'cube',
          sourcePlane: 'axial',
          sourceSeriesUid: 'fixed',
          boundsMm: { min: [11, 21, 29.7], max: [13, 23, 30.3] },
        },
      },
      acceptedSourceTransforms: original.sourceTransforms,
      debug: false,
    });
    expect(refined.sourceTransforms).toEqual(original.sourceTransforms);
    expect(refined.originMm).toEqual({ x: 11, y: 21, z: 29.7 });
    expect(refined.supportedVoxelCount).toBeGreaterThan(0);
    expect(refined.volume.every(Number.isFinite)).toBe(true);
  });
});
