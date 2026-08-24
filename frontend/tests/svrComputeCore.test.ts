import { describe, expect, it } from 'vitest';
import type { VolumeDims } from '../src/utils/svr/trilinear';
import type { SvrReconstructionGrid, SvrReconstructionOptions } from '../src/utils/svr/reconstructionCore';
import { reconstructVolumeFromSlices } from '../src/utils/svr/reconstructionCore';
import type { LoadedSlice } from '../src/utils/svr/rigidRegistration';
import { computeSvrFromLoadedSlices } from '../src/utils/svr/svrComputeCore';
import type { SvrParams } from '../src/types/svr';

// Synthetic-slice helpers mirror tests/svrPhantom.test.ts (its helpers are not
// exported); kept minimal here — point samples, no thickness model.

function idxOf(x: number, y: number, z: number, dims: VolumeDims): number {
  return x + y * dims.nx + z * dims.nx * dims.ny;
}

function makePhantomVolume(dims: VolumeDims): Float32Array {
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

function makeLoadedSliceSeries(params: {
  vol: Float32Array;
  dims: VolumeDims;
  plane: 'axial' | 'coronal' | 'sagittal';
  seriesUid: string;
  rows: number;
  cols: number;
  slicePositions: number[];
  spacingMm: number;
}): LoadedSlice[] {
  const { vol, dims, plane, seriesUid, rows, cols, slicePositions, spacingMm } = params;

  const slices: LoadedSlice[] = [];

  for (const sPos of slicePositions) {
    // Coordinate frame conventions (matches the SVR DICOM convention used in
    // reconstruction): world(r,c) = IPP + colDir*(r*rowSpacing) + rowDir*(c*colSpacing)
    let rowDir = { x: 1, y: 0, z: 0 };
    let colDir = { x: 0, y: 1, z: 0 };
    let normalDir = { x: 0, y: 0, z: 1 };
    let ippMm = { x: 0, y: 0, z: 0 };

    if (plane === 'axial') {
      rowDir = { x: 1, y: 0, z: 0 };
      colDir = { x: 0, y: 1, z: 0 };
      normalDir = { x: 0, y: 0, z: 1 };
      ippMm = { x: 0, y: 0, z: sPos };
    } else if (plane === 'coronal') {
      rowDir = { x: 1, y: 0, z: 0 };
      colDir = { x: 0, y: 0, z: 1 };
      normalDir = { x: 0, y: -1, z: 0 };
      ippMm = { x: 0, y: sPos, z: 0 };
    } else {
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

        // Nearest-voxel sampling keeps the phantom values exactly in {0, 0.6, 1}.
        const xi = Math.round(wx);
        const yi = Math.round(wy);
        const zi = Math.round(wz);
        const inside = xi >= 0 && yi >= 0 && zi >= 0 && xi < dims.nx && yi < dims.ny && zi < dims.nz;
        pixels[rowBase + c] = inside ? (vol[idxOf(xi, yi, zi, dims)] ?? 0) : 0;
      }
    }

    slices.push({
      seriesUid,
      sopInstanceUid: `${seriesUid}-${sPos}`,
      pixels,
      dsRows: rows,
      dsCols: cols,
      srcRows: rows,
      srcCols: cols,
      rowSpacingMm: spacingMm,
      colSpacingMm: spacingMm,
      sliceThicknessMm: null,
      spacingBetweenSlicesMm: null,
      ippMm,
      rowDir,
      colDir,
      normalDir,
      rowSpacingDsMm: spacingMm,
      colSpacingDsMm: spacingMm,
    });
  }

  return slices;
}

function makeAllSlices(): LoadedSlice[] {
  const dims: VolumeDims = { nx: 33, ny: 33, nz: 33 };
  const gt = makePhantomVolume(dims);

  const rows = 33;
  const cols = 33;
  const spacingMm = 1;
  const slicePositions = [6, 10, 14, 18, 22, 26];

  return [
    ...makeLoadedSliceSeries({
      vol: gt,
      dims,
      plane: 'axial',
      seriesUid: 's-ax',
      rows,
      cols,
      slicePositions,
      spacingMm,
    }),
    ...makeLoadedSliceSeries({
      vol: gt,
      dims,
      plane: 'coronal',
      seriesUid: 's-cor',
      rows,
      cols,
      slicePositions,
      spacingMm,
    }),
    ...makeLoadedSliceSeries({
      vol: gt,
      dims,
      plane: 'sagittal',
      seriesUid: 's-sag',
      rows,
      cols,
      slicePositions,
      spacingMm,
    }),
  ];
}

const SERIES_META = [
  { seriesUid: 's-ax', label: 'AX', instanceCount: 6 },
  { seriesUid: 's-cor', label: 'COR', instanceCount: 6 },
  { seriesUid: 's-sag', label: 'SAG', instanceCount: 6 },
];

// Intensity samples chosen so the robust percentile window is exactly [0, 1]:
// 1st percentile of 100 zeros + 100 ones is 0, 99th is 1, so the [0,1]-valued
// phantom pixels pass through normalization bit-identically. This lets the
// test compare the compute phase against a direct solver call exactly.
const IDENTITY_WINDOW_SAMPLES = [...new Array<number>(100).fill(0), ...new Array<number>(100).fill(1)];

const SVR_PARAMS: SvrParams = {
  targetVoxelSizeMm: 1,
  maxVolumeDim: 64,
  sliceDownsampleMode: 'fixed',
  sliceDownsampleMaxSize: 128,
  // 'none' keeps the pipeline deterministic for the equivalence check (no
  // bounds-center shift, no ROI-rigid optimizer).
  seriesRegistrationMode: 'none',
  iterations: 2,
  stepSize: 0.6,
  clampOutput: true,
  psfMode: 'box',
  robustLoss: 'huber',
  robustDelta: 0.1,
  laplacianWeight: 0.02,
  multiResolution: false,
  roi: null,
};

describe('svr/computeCore', () => {
  it('computeSvrFromLoadedSlices matches a direct solver run on the same grid', async () => {
    const allSlices = makeAllSlices();
    // The compute phase mutates pixels in place and empties the array, so the
    // reference run gets its own pristine copy.
    const referenceSlices = makeAllSlices();

    const result = await computeSvrFromLoadedSlices({
      allSlices,
      intensitySamples: [...IDENTITY_WINDOW_SAMPLES],
      intensitySamplesBySeries: new Map(),
      seriesMeta: SERIES_META,
      svrParams: SVR_PARAMS,
      debug: false,
    });

    // Grid selection is deterministic: slices span 0..32mm on every axis,
    // computeBoundsMm pads by 1mm → bounds [-1, 33], extent 34mm at 1mm voxels
    // → ceil(34) + 1 = 35 per axis.
    expect(result.dims).toEqual({ nx: 35, ny: 35, nz: 35 });
    expect(result.originMm).toEqual({ x: -1, y: -1, z: -1 });
    expect(result.voxelSizeMm).toBe(1);
    expect(result.bounds).toEqual({ min: { x: -1, y: -1, z: -1 }, max: { x: 33, y: 33, z: 33 } });
    expect(result.volume.length).toBe(35 * 35 * 35);

    // The compute phase released the slice stack once the solver finished.
    expect(allSlices.length).toBe(0);

    // With an identity normalization window and registration 'none', the
    // compute phase reduces to exactly one solver call — verify bit-identical
    // output against calling the solver directly with the same grid/options.
    const grid: SvrReconstructionGrid = { dims: result.dims, originMm: result.originMm, voxelSizeMm: 1 };
    const options: SvrReconstructionOptions = {
      iterations: 2,
      stepSize: 0.6,
      clampOutput: true,
      psfMode: 'box',
      robustLoss: 'huber',
      robustDelta: 0.1,
      laplacianWeight: 0.02,
    };
    const reference = await reconstructVolumeFromSlices({ slices: referenceSlices, grid, options });

    expect(result.volume).toEqual(reference);
  });

  it('rejects with the SVR cancelled error when the signal is already aborted', async () => {
    const controller = new AbortController();
    controller.abort();

    await expect(
      computeSvrFromLoadedSlices({
        allSlices: makeAllSlices(),
        intensitySamples: [...IDENTITY_WINDOW_SAMPLES],
        intensitySamplesBySeries: new Map(),
        seriesMeta: SERIES_META,
        svrParams: SVR_PARAMS,
        signal: controller.signal,
        debug: false,
      }),
    ).rejects.toThrow('SVR cancelled');
  });

  it('preserves correctly positioned partial-FOV series under the default ROI-rigid mode without an ROI', async () => {
    const slices = makeAllSlices();
    const partial = slices.filter((slice) => slice.seriesUid === 's-ax').slice(0, 3);
    const reference = slices.filter((slice) => slice.seriesUid === 's-cor');
    const original = partial.map((slice) => ({ ...slice.ippMm }));

    await computeSvrFromLoadedSlices({
      allSlices: [...reference, ...partial],
      intensitySamples: [...IDENTITY_WINDOW_SAMPLES],
      intensitySamplesBySeries: new Map(),
      seriesMeta: SERIES_META,
      svrParams: { ...SVR_PARAMS, seriesRegistrationMode: 'roi-rigid', roi: null, iterations: 0 },
      debug: false,
    });

    expect(partial.map((slice) => slice.ippMm)).toEqual(original);
  });
});
