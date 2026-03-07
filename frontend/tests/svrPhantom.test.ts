import { describe, expect, it } from 'vitest';
import type { VolumeDims } from '../src/utils/svr/trilinear';
import { sampleTrilinear } from '../src/utils/svr/trilinear';
import type { SvrReconstructionGrid, SvrReconstructionOptions, SvrReconstructionSlice } from '../src/utils/svr/reconstructionCore';
import { reconstructVolumeFromSlices } from '../src/utils/svr/reconstructionCore';

function idxOf(x: number, y: number, z: number, dims: VolumeDims): number {
  return x + y * dims.nx + z * dims.nx * dims.ny;
}

function makePhantomVolume(dims: VolumeDims): Float32Array {
  // Simple sharp-edged structure: a filled cube + a smaller offset cube.
  const vol = new Float32Array(dims.nx * dims.ny * dims.nz);

  const fillBox = (min: [number, number, number], max: [number, number, number], v: number) => {
    for (let z = min[2]; z <= max[2]; z++) {
      for (let y = min[1]; y <= max[1]; y++) {
        for (let x = min[0]; x <= max[0]; x++) {
          if (x < 0 || y < 0 || z < 0 || x >= dims.nx || y >= dims.ny || z >= dims.nz) continue;
          vol[idxOf(x, y, z, dims)] = v;
        }
      }
    }
  };

  fillBox([10, 10, 10], [20, 20, 20], 1);
  fillBox([22, 12, 14], [27, 16, 18], 0.6);

  return vol;
}

function sampleVolumeAtWorldMm(params: { vol: Float32Array; dims: VolumeDims; x: number; y: number; z: number }): number {
  const { vol, dims, x, y, z } = params;
  return sampleTrilinear(vol, dims, x, y, z);
}

function sampleWithThicknessBox(params: {
  vol: Float32Array;
  dims: VolumeDims;
  world: { x: number; y: number; z: number };
  normal: { x: number; y: number; z: number };
  thicknessMm: number;
}): number {
  const { vol, dims, world, normal, thicknessMm } = params;

  const t = Math.max(0, thicknessMm);
  if (!(t > 0)) {
    return sampleVolumeAtWorldMm({ vol, dims, x: world.x, y: world.y, z: world.z });
  }

  // Deterministic box integration across thickness.
  const n = 7;
  const half = 0.5 * t;
  const step = t / n;

  let sum = 0;
  for (let i = 0; i < n; i++) {
    const off = -half + (i + 0.5) * step;
    sum += sampleVolumeAtWorldMm({
      vol,
      dims,
      x: world.x + normal.x * off,
      y: world.y + normal.y * off,
      z: world.z + normal.z * off,
    });
  }

  return sum / n;
}

function makeSliceSeries(params: {
  vol: Float32Array;
  dims: VolumeDims;
  plane: 'axial' | 'coronal' | 'sagittal';
  rows: number;
  cols: number;
  slicePositions: number[];
  spacingMm: number;
  thicknessMm: number;
}): SvrReconstructionSlice[] {
  const { vol, dims, plane, rows, cols, slicePositions, spacingMm, thicknessMm } = params;

  const slices: SvrReconstructionSlice[] = [];

  for (const sPos of slicePositions) {
    // Coordinate frame conventions:
    // world(r,c) = IPP + colDir*(r*rowSpacing) + rowDir*(c*colSpacing)
    // (matches the SVR DICOM convention used in reconstruction).

    let rowDir = { x: 1, y: 0, z: 0 };
    let colDir = { x: 0, y: 1, z: 0 };
    let normalDir = { x: 0, y: 0, z: 1 };
    let ippMm = { x: 0, y: 0, z: 0 };

    if (plane === 'axial') {
      // z fixed, rows +Y, cols +X
      rowDir = { x: 1, y: 0, z: 0 };
      colDir = { x: 0, y: 1, z: 0 };
      normalDir = { x: 0, y: 0, z: 1 };
      ippMm = { x: 0, y: 0, z: sPos };
    } else if (plane === 'coronal') {
      // y fixed, rows +Z, cols +X, normal -Y
      rowDir = { x: 1, y: 0, z: 0 };
      colDir = { x: 0, y: 0, z: 1 };
      normalDir = { x: 0, y: -1, z: 0 };
      ippMm = { x: 0, y: sPos, z: 0 };
    } else {
      // sagittal: x fixed, rows +Z, cols +Y, normal +X
      rowDir = { x: 0, y: 1, z: 0 };
      colDir = { x: 0, y: 0, z: 1 };
      normalDir = { x: 1, y: 0, z: 0 };
      ippMm = { x: sPos, y: 0, z: 0 };
    }

    const pixels = new Float32Array(rows * cols);

    for (let r = 0; r < rows; r++) {
      const baseX = ippMm.x + colDir.x * (r * spacingMm);
      const baseY = ippMm.y + colDir.y * (r * spacingMm);
      const baseZ = ippMm.z + colDir.z * (r * spacingMm);

      const rowBase = r * cols;

      for (let c = 0; c < cols; c++) {
        const wx = baseX + rowDir.x * (c * spacingMm);
        const wy = baseY + rowDir.y * (c * spacingMm);
        const wz = baseZ + rowDir.z * (c * spacingMm);

        const v = sampleWithThicknessBox({
          vol,
          dims,
          world: { x: wx, y: wy, z: wz },
          normal: normalDir,
          thicknessMm,
        });

        pixels[rowBase + c] = v;
      }
    }

    slices.push({
      pixels,
      dsRows: rows,
      dsCols: cols,
      ippMm,
      rowDir,
      colDir,
      normalDir,
      rowSpacingDsMm: spacingMm,
      colSpacingDsMm: spacingMm,
      sliceThicknessMm: thicknessMm,
      spacingBetweenSlicesMm: null,
    });
  }

  return slices;
}

function mse(a: Float32Array, b: Float32Array): number {
  const n = Math.min(a.length, b.length);
  let sum = 0;
  for (let i = 0; i < n; i++) {
    const d = (a[i] ?? 0) - (b[i] ?? 0);
    sum += d * d;
  }
  return sum / Math.max(1, n);
}

function psnrFromMse(m: number): number {
  // Standard PSNR with MAX=1 (since our phantom is in [0,1]): PSNR = 10 * log10(MAX^2 / MSE).
  const mm = Math.max(1e-12, m);
  return -10 * Math.log10(mm);
}

describe('svr/phantom', () => {
  it('PSF-aware reconstruction reduces error when slices have non-zero thickness', async () => {
    const dims: VolumeDims = { nx: 34, ny: 34, nz: 34 };
    const gt = makePhantomVolume(dims);

    const grid: SvrReconstructionGrid = {
      dims,
      originMm: { x: 0, y: 0, z: 0 },
      voxelSizeMm: 1,
    };

    const rows = 33;
    const cols = 33;
    const spacingMm = 1;
    const thicknessMm = 4;

    const slicePositions = [6, 10, 14, 18, 22, 26];

    const slices: SvrReconstructionSlice[] = [
      ...makeSliceSeries({ vol: gt, dims, plane: 'axial', rows, cols, slicePositions, spacingMm, thicknessMm }),
      ...makeSliceSeries({ vol: gt, dims, plane: 'coronal', rows, cols, slicePositions, spacingMm, thicknessMm }),
      ...makeSliceSeries({ vol: gt, dims, plane: 'sagittal', rows, cols, slicePositions, spacingMm, thicknessMm }),
    ];

    const base: SvrReconstructionOptions = {
      iterations: 3,
      stepSize: 0.6,
      clampOutput: true,
      psfMode: 'none',
      robustLoss: 'none',
      robustDelta: 0.1,
      laplacianWeight: 0,
    };

    const psfAware: SvrReconstructionOptions = {
      ...base,
      psfMode: 'box',
      robustLoss: 'huber',
      laplacianWeight: 0.02,
    };

    const recBase = await reconstructVolumeFromSlices({ slices, grid, options: base });
    const recPsf = await reconstructVolumeFromSlices({ slices, grid, options: psfAware });

    const mseBase = mse(recBase, gt);
    const msePsf = mse(recPsf, gt);

    const psnrBase = psnrFromMse(mseBase);
    const psnrPsf = psnrFromMse(msePsf);

    // The PSF-aware model should do meaningfully better on thick slices.
    expect(msePsf).toBeLessThan(mseBase * 0.9);
    expect(psnrPsf).toBeGreaterThan(psnrBase + 0.2);

    // Sanity bounds (avoid a totally broken solver passing the relative check).
    expect(msePsf).toBeLessThan(0.25);
  });
});
