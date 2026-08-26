import { describe, expect, it } from 'vitest';
import {
  reconstructVolumeFromSlices,
  type SvrReconstructionOptions,
  type SvrReconstructionSlice,
} from '../src/utils/svr/reconstructionCore';

const PHYSICAL_OPTIONS: SvrReconstructionOptions = {
  iterations: 2,
  stepSize: 0.6,
  clampOutput: true,
  psfMode: 'box',
  robustLoss: 'none',
  robustDelta: 0.1,
  laplacianWeight: 0.02,
};

function analyticAnatomy(x: number, y: number, z: number): number {
  return 0.12 + x * 0.013 + y * 0.009 + z * 0.007;
}

/** Independent analytic acquisition geometry; no production projection helpers. */
function analyticSlice(plane: 'axial' | 'coronal' | 'sagittal', position: number): SvrReconstructionSlice {
  const rows = 24;
  const columns = 24;
  const pixels = new Float32Array(rows * columns);
  for (let row = 0; row < rows; row++) {
    for (let column = 0; column < columns; column++) {
      const x = plane === 'sagittal' ? position : column;
      const y = plane === 'axial' ? row : plane === 'coronal' ? position : column;
      const z = plane === 'axial' ? position : row;
      pixels[row * columns + column] = analyticAnatomy(x, y, z);
    }
  }

  const axial = plane === 'axial';
  const coronal = plane === 'coronal';
  return {
    pixels,
    valid: new Uint8Array(pixels.length).fill(1),
    dsRows: rows,
    dsCols: columns,
    ippMm: axial ? { x: 0, y: 0, z: position } : coronal ? { x: 0, y: position, z: 0 } : { x: position, y: 0, z: 0 },
    rowDir: plane === 'sagittal' ? { x: 0, y: 1, z: 0 } : { x: 1, y: 0, z: 0 },
    colDir: axial ? { x: 0, y: 1, z: 0 } : { x: 0, y: 0, z: 1 },
    normalDir: axial ? { x: 0, y: 0, z: 1 } : coronal ? { x: 0, y: -1, z: 0 } : { x: 1, y: 0, z: 0 },
    rowSpacingDsMm: 1,
    colSpacingDsMm: 1,
    sliceThicknessMm: 2,
    spacingBetweenSlicesMm: 4,
  };
}

describe('svr/independent physical fidelity phantoms', () => {
  it('keeps the measured slab gap unsupported instead of filling it from slice-center spacing', async () => {
    const source = {
      pixels: new Float32Array([0.8]),
      valid: new Uint8Array([1]),
      dsRows: 1,
      dsCols: 1,
      rowDir: { x: 1, y: 0, z: 0 },
      colDir: { x: 0, y: 1, z: 0 },
      normalDir: { x: 0, y: 0, z: 1 },
      rowSpacingDsMm: 1,
      colSpacingDsMm: 1,
      sliceThicknessMm: 2,
      spacingBetweenSlicesMm: 8,
    };
    const occupancy = new Uint8Array(17);

    const volume = await reconstructVolumeFromSlices({
      slices: [
        { ...source, ippMm: { x: 0, y: 0, z: 4 } },
        { ...source, ippMm: { x: 0, y: 0, z: 12 } },
      ],
      grid: { dims: { nx: 1, ny: 1, nz: 17 }, originMm: { x: 0, y: 0, z: 0 }, voxelSizeMm: 1 },
      occupancy,
      options: PHYSICAL_OPTIONS,
    });

    expect(Array.from(occupancy).reduce((count, supported) => count + supported, 0)).toBe(6);
    for (let z = 6; z <= 10; z++) {
      expect(occupancy[z]).toBe(0);
      expect(volume[z]).toBe(0);
    }
  });

  it('limits anisotropic 45-degree source support to its physically rotated footprint', async () => {
    const rootHalf = Math.SQRT1_2;
    const dims = { nx: 21, ny: 21, nz: 1 };
    const occupancy = new Uint8Array(dims.nx * dims.ny);

    const volume = await reconstructVolumeFromSlices({
      slices: [
        {
          pixels: new Float32Array([0.7]),
          valid: new Uint8Array([1]),
          dsRows: 1,
          dsCols: 1,
          ippMm: { x: 10, y: 10, z: 0 },
          rowDir: { x: rootHalf, y: rootHalf, z: 0 },
          colDir: { x: -rootHalf, y: rootHalf, z: 0 },
          normalDir: { x: 0, y: 0, z: 1 },
          rowSpacingDsMm: 4,
          colSpacingDsMm: 2,
          sliceThicknessMm: 1,
          spacingBetweenSlicesMm: 1,
        },
      ],
      grid: { dims, originMm: { x: 0, y: 0, z: 0 }, voxelSizeMm: 1 },
      occupancy,
      options: PHYSICAL_OPTIONS,
    });

    let supported = 0;
    for (let y = 0; y < dims.ny; y++) {
      for (let x = 0; x < dims.nx; x++) {
        const index = x + y * dims.nx;
        if (!occupancy[index]) {
          expect(volume[index]).toBe(0);
          continue;
        }
        supported++;
        const alongColumns = (x - 10 + (y - 10)) * rootHalf;
        const alongRows = (-(x - 10) + (y - 10)) * rootHalf;
        expect(Math.abs(alongColumns)).toBeLessThanOrEqual(1 + Math.SQRT2);
        expect(Math.abs(alongRows)).toBeLessThanOrEqual(2 + Math.SQRT2);
        expect(volume[index]).toBeCloseTo(0.7, 5);
      }
    }

    expect(supported).toBeGreaterThan(8);
    expect(occupancy[0]).toBe(0);
  });

  it('predicts an independently held-out axial plane from supported orthogonal acquisitions', async () => {
    const dims = { nx: 24, ny: 24, nz: 24 };
    const occupancy = new Uint8Array(dims.nx * dims.ny * dims.nz);
    const positions = [4, 8, 12, 16, 20];
    const slices = [
      ...positions.filter((position) => position !== 8).map((position) => analyticSlice('axial', position)),
      ...positions.map((position) => analyticSlice('coronal', position)),
      ...positions.map((position) => analyticSlice('sagittal', position)),
    ];

    const volume = await reconstructVolumeFromSlices({
      slices,
      grid: { dims, originMm: { x: 0, y: 0, z: 0 }, voxelSizeMm: 1 },
      occupancy,
      options: PHYSICAL_OPTIONS,
    });

    let squaredError = 0;
    let supportedSamples = 0;
    const heldOutZ = 8;
    for (let y = 3; y <= 20; y++) {
      for (const x of positions) {
        const index = x + y * dims.nx + heldOutZ * dims.nx * dims.ny;
        if (!occupancy[index]) continue;
        const difference = volume[index]! - analyticAnatomy(x, y, heldOutZ);
        squaredError += difference * difference;
        supportedSamples++;
      }
    }

    expect(supportedSamples).toBeGreaterThanOrEqual(80);
    expect(Math.sqrt(squaredError / supportedSamples)).toBeLessThan(0.025);
  });
});
