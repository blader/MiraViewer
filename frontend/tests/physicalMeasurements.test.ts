import { describe, expect, it } from 'vitest';
import { segmentationAreaMm2, segmentationVolumeMm3 } from '../src/utils/segmentation/physicalMeasurements';

describe('physical segmentation measurements', () => {
  it('computes 2D area from native anisotropic DICOM pixel spacing', () => {
    expect(segmentationAreaMm2(20, 0.5, 0.8)).toBeCloseTo(8);
    expect(segmentationAreaMm2(0, 0.5, 0.8)).toBe(0);
  });

  it('does not invent clinical calibration when spacing is missing or invalid', () => {
    expect(segmentationAreaMm2(20, undefined, 0.8)).toBeNull();
    expect(segmentationAreaMm2(20, 0.5, 0)).toBeNull();
    expect(segmentationAreaMm2(20, Number.NaN, 0.8)).toBeNull();
  });

  it('computes 3D volume from all three voxel dimensions', () => {
    expect(segmentationVolumeMm3(20, [0.5, 0.8, 2])).toBeCloseTo(16);
    expect(segmentationVolumeMm3(0, [0.5, 0.8, 2])).toBe(0);
    expect(segmentationVolumeMm3(20, [0.5, 0, 2])).toBeNull();
  });
});
