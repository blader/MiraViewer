import { describe, expect, it } from 'vitest';
import {
  buildOutputPlaneGrid,
  isOutputGridMode,
  outputGridFingerprint,
  outputGridPixelToWorld,
  validateOutputPlaneGrid,
  type OutputGridMode,
} from '../src/utils/outputPlaneGrid';
import { resliceStackToReferencePlane } from '../src/utils/svr/longitudinalRegistration';
import type { SvrReconstructionSlice } from '../src/utils/svr/reconstructionCore';

const reference = {
  sopInstanceUid: 'reference-frame',
  frameOfReferenceUid: 'reference-space',
  rows: 640,
  columns: 512,
  imagePositionPatient: '10\\20\\30',
  imageOrientationPatient: '1\\0\\0\\0\\1\\0',
  pixelSpacing: '0.4\\0.8',
};

describe('authoritative physical output-plane geometry', () => {
  it('uses one authoritative resolution-mode validator for persisted preferences and physical grids', () => {
    expect(isOutputGridMode('native')).toBe(true);
    expect(isOutputGridMode('fixed-1024')).toBe(true);
    expect(isOutputGridMode('fixed-4096')).toBe(false);
    expect(isOutputGridMode(undefined)).toBe(false);
  });

  it.each([
    ['native', 640, 512, 0.4, 0.8],
    ['fixed-256', 256, 256, 1, 1.6],
    ['fixed-512', 512, 512, 0.5, 0.8],
    ['fixed-1024', 1024, 1024, 0.25, 0.4],
    ['longest-edge', 512, 410, 0.5, 409.6 / 410],
    ['isotropic', 320, 512, 0.8, 0.8],
  ] as const)(
    'preserves the acquired physical field of view for %s',
    (mode, rows, columns, rowSpacing, columnSpacing) => {
      const grid = buildOutputPlaneGrid(reference, { mode: mode as OutputGridMode });

      expect(grid).toMatchObject({ rows, columns, frameOfReferenceUid: 'reference-space' });
      expect(grid.rowSpacingMm).toBeCloseTo(rowSpacing, 10);
      expect(grid.columnSpacingMm).toBeCloseTo(columnSpacing, 10);
      expect(grid.fieldOfViewMm).toEqual([256, 409.6]);
      expect(grid.rows * grid.rowSpacingMm).toBeCloseTo(256, 10);
      expect(grid.columns * grid.columnSpacingMm).toBeCloseTo(409.6, 10);
      expect(() => validateOutputPlaneGrid(grid)).not.toThrow();
    },
  );

  it('preserves pixel-center origins independently along anisotropic DICOM axes', () => {
    const downsampled = buildOutputPlaneGrid(reference, { mode: 'longest-edge' });
    expect(downsampled.originMm[0]).toBeCloseTo(10.09951219512195, 10);
    expect(downsampled.originMm[1]).toBeCloseTo(20.05, 10);

    const upsampled = buildOutputPlaneGrid(reference, { mode: 'fixed-1024' });
    expect(upsampled.originMm[0]).toBeCloseTo(9.8, 10);
    expect(upsampled.originMm[1]).toBeCloseTo(19.925, 10);
    const point = outputGridPixelToWorld(upsampled, 1, 1);
    expect(point.x).toBeCloseTo(10.2, 10);
    expect(point.y).toBeCloseTo(20.175, 10);
    expect(point.z).toBe(30);
  });

  it('keeps isotropic requests field-of-view preserving when exact pixel counts must round', () => {
    const grid = buildOutputPlaneGrid(reference, { mode: 'isotropic', isotropicSpacingMm: 0.5 });

    expect(grid).toMatchObject({ rows: 512, columns: 819 });
    expect(grid.rowSpacingMm).toBe(0.5);
    expect(grid.columnSpacingMm).toBeCloseTo(0.5001221001221001, 10);
    expect(grid.fieldOfViewMm).toEqual([256, 409.6]);
  });

  it('applies centered origin offsets along the actual oblique DICOM direction vectors', () => {
    const angle = (18 * Math.PI) / 180;
    const cosine = Math.cos(angle);
    const sine = Math.sin(angle);
    const source = {
      ...reference,
      imageOrientationPatient: `${cosine}\\0\\${sine}\\0\\1\\0`,
    };
    const grid = buildOutputPlaneGrid(source, { mode: 'fixed-1024' });

    expect(grid.originMm[0]).toBeCloseTo(10 - 0.2 * cosine, 10);
    expect(grid.originMm[1]).toBeCloseTo(20 - 0.075, 10);
    expect(grid.originMm[2]).toBeCloseTo(30 - 0.2 * sine, 10);
    const middle = outputGridPixelToWorld(grid, (grid.rows - 1) / 2, (grid.columns - 1) / 2);
    const native = buildOutputPlaneGrid(source);
    const nativeMiddle = outputGridPixelToWorld(native, (native.rows - 1) / 2, (native.columns - 1) / 2);
    expect(middle.x).toBeCloseTo(nativeMiddle.x, 9);
    expect(middle.y).toBeCloseTo(nativeMiddle.y, 9);
    expect(middle.z).toBeCloseTo(nativeMiddle.z, 9);
  });

  it('rejects over-budget, invalid-spacing, inconsistent-axis, and fabricated-field grids', () => {
    expect(() => buildOutputPlaneGrid(reference, { mode: 'isotropic', isotropicSpacingMm: 0.1 })).toThrow(
      'pixel budget',
    );
    expect(() => buildOutputPlaneGrid(reference, { mode: 'isotropic', isotropicSpacingMm: 0 })).toThrow('positive');
    expect(() => buildOutputPlaneGrid(reference, { maxPixels: Number.NaN })).toThrow('pixel budget');

    const grid = buildOutputPlaneGrid(reference);
    expect(() => validateOutputPlaneGrid({ ...grid, normalDirection: [1, 0, 0] })).toThrow('axes');
    expect(() => validateOutputPlaneGrid({ ...grid, fieldOfViewMm: [250, 409.6] })).toThrow('field of view');
    expect(() => validateOutputPlaneGrid({ ...grid, mode: 'fixed-1024' })).toThrow('resolution mode');
  });

  it('fingerprints complete validated geometry regardless of object insertion order', () => {
    const grid = buildOutputPlaneGrid(reference);
    const reordered = { mode: grid.mode, ...grid };

    expect(outputGridFingerprint(reordered)).toBe(outputGridFingerprint(grid));
    expect(outputGridFingerprint({ ...grid, frameOfReferenceUid: 'another-frame' })).not.toBe(
      outputGridFingerprint(grid),
    );
    expect(() => outputGridFingerprint({ ...grid, rows: -1 })).toThrow('pixel budget');
  });

  it.each(['fixed-256', 'fixed-1024'] as const)(
    'retains the complete acquired pixel footprint at every edge of a %s reslice',
    (mode) => {
      const source = {
        ...reference,
        rows: 4,
        columns: 6,
        imagePositionPatient: '0\\0\\0',
        pixelSpacing: '1\\1',
      };
      const slices: SvrReconstructionSlice[] = [0, 1].map((depth) => ({
        pixels: Float32Array.from({ length: 24 }, (_, index) => index + 1),
        valid: new Uint8Array(24).fill(1),
        dsRows: 4,
        dsCols: 6,
        ippMm: { x: 0, y: 0, z: depth },
        rowDir: { x: 1, y: 0, z: 0 },
        colDir: { x: 0, y: 1, z: 0 },
        normalDir: { x: 0, y: 0, z: 1 },
        rowSpacingDsMm: 1,
        colSpacingDsMm: 1,
        sliceThicknessMm: 1,
        spacingBetweenSlicesMm: 1,
      }));
      const outputGrid = buildOutputPlaneGrid(source, { mode });
      const result = resliceStackToReferencePlane({
        targetSlices: slices,
        referenceSlice: slices[0]!,
        outputGrid,
      });

      expect(result.coverage).toBe(1);
      expect(result.valid[0]).toBe(1);
      expect(result.valid[result.valid.length - 1]).toBe(1);
      expect(result.pixels[0]).toBe(1);
      expect(result.pixels[result.pixels.length - 1]).toBe(24);
    },
  );
});
