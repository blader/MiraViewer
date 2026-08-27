import { describe, expect, it, vi } from 'vitest';
import type { VolumeDims } from '../src/utils/svr/trilinear';
import type { SvrReconstructionGrid, SvrReconstructionOptions } from '../src/utils/svr/reconstructionCore';
import { buildObservedSupportFromSlices, reconstructVolumeFromSlices } from '../src/utils/svr/reconstructionCore';
import type { LoadedSlice } from '../src/utils/svr/rigidRegistration';
import { computeSvrFromLoadedSlices } from '../src/utils/svr/svrComputeCore';
import { SVR_MEMORY_BUDGET_BYTES } from '../src/utils/svr/svrMemoryPlan';
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

const RECONSTRUCTION_OPTIONS: SvrReconstructionOptions = Object.freeze({
  iterations: 0,
  stepSize: 0,
  clampOutput: true,
  psfMode: 'none',
  robustLoss: 'none',
  robustDelta: 0.1,
  laplacianWeight: 0,
});

function axialSliceGeometry() {
  return {
    dsRows: 1,
    dsCols: 1,
    ippMm: { x: 0, y: 0, z: 0 },
    rowDir: { x: 1, y: 0, z: 0 },
    colDir: { x: 0, y: 1, z: 0 },
    normalDir: { x: 0, y: 0, z: 1 },
    rowSpacingDsMm: 1,
    colSpacingDsMm: 1,
    sliceThicknessMm: 1,
    spacingBetweenSlicesMm: 1,
  };
}

function computeSyntheticSvr(
  allSlices: LoadedSlice[],
  svrParams: SvrParams,
  options: Partial<Parameters<typeof computeSvrFromLoadedSlices>[0]> = {},
) {
  return computeSvrFromLoadedSlices({
    allSlices,
    intensitySamples: [...IDENTITY_WINDOW_SAMPLES],
    svrParams,
    debug: false,
    ...options,
  });
}

function privateDiagnostics(displaceCoronal = false) {
  const allSlices = makeAllSlices();
  const byOriginalUid = new Map([
    ['s-ax', 'PRIVATE_SERIES_AXIAL_123'],
    ['s-cor', 'PRIVATE_SERIES_CORONAL_456'],
    ['s-sag', 'PRIVATE_SERIES_SAGITTAL_789_PRIVATE_PATIENT_NAME_PRIVATE_STUDY_987'],
  ]);
  for (const slice of allSlices) {
    const originalUid = slice.seriesUid;
    slice.seriesUid = byOriginalUid.get(originalUid)!;
    slice.sopInstanceUid = `PRIVATE_SOP_${slice.sopInstanceUid}`;
    slice.frameOfReferenceUid = 'PRIVATE_FRAME_ABC';
    if (displaceCoronal && originalUid === 's-cor') slice.ippMm.x += 40;
  }
  const spies = [
    vi.spyOn(console, 'info').mockImplementation(() => {}),
    vi.spyOn(console, 'warn').mockImplementation(() => {}),
    vi.spyOn(console, 'log').mockImplementation(() => {}),
  ];
  const progress: string[] = [];
  return { allSlices, spies, progress };
}

describe('svr/computeCore', () => {
  it('reconstructs valid zero and negative observations while rejecting explicitly invalid positive pixels', async () => {
    const occupancy = new Uint8Array(4);
    const volume = await reconstructVolumeFromSlices({
      slices: [
        {
          ...axialSliceGeometry(),
          pixels: new Float32Array([-2, 0, 5, 999]),
          valid: new Uint8Array([1, 1, 1, 0]),
          dsRows: 2,
          dsCols: 2,
        },
      ],
      grid: { dims: { nx: 2, ny: 2, nz: 1 }, originMm: { x: 0, y: 0, z: 0 }, voxelSizeMm: 1 },
      occupancy,
      options: { ...RECONSTRUCTION_OPTIONS, clampOutput: false },
    });

    expect(Array.from(occupancy)).toEqual([1, 1, 1, 0]);
    expect(Array.from(volume)).toEqual([-2, 0, 5, 0]);
  });

  it('preserves a supported intensity of 100 instead of averaging it with unsupported padding into 50', async () => {
    const source = {
      ...axialSliceGeometry(),
      sliceThicknessMm: null,
      spacingBetweenSlicesMm: null,
    };
    const observedSupport = new Uint8Array(1);

    const volume = await reconstructVolumeFromSlices({
      slices: [
        { ...source, pixels: new Float32Array([100]), valid: new Uint8Array([1]) },
        { ...source, pixels: new Float32Array([0]), valid: new Uint8Array([0]) },
      ],
      grid: { dims: { nx: 1, ny: 1, nz: 1 }, originMm: { x: 0, y: 0, z: 0 }, voxelSizeMm: 1 },
      occupancy: observedSupport,
      options: { ...RECONSTRUCTION_OPTIONS, clampOutput: false },
    });

    expect(Array.from(observedSupport)).toEqual([1]);
    expect(Array.from(volume)).toEqual([100]);
  });

  it('weights a 25%-acquired footprint one quarter as strongly as fully acquired anatomy', async () => {
    const source = {
      ...axialSliceGeometry(),
      sliceThicknessMm: null,
      spacingBetweenSlicesMm: null,
      validScale: 255,
    };
    const observedSupport = new Uint8Array(1);

    const volume = await reconstructVolumeFromSlices({
      slices: [
        { ...source, pixels: new Float32Array([100]), valid: new Uint8Array([255]) },
        { ...source, pixels: new Float32Array([0]), valid: new Uint8Array([64]) },
      ],
      grid: { dims: { nx: 1, ny: 1, nz: 1 }, originMm: { x: 0, y: 0, z: 0 }, voxelSizeMm: 1 },
      occupancy: observedSupport,
      options: { ...RECONSTRUCTION_OPTIONS, iterations: 2, stepSize: 0.6, clampOutput: false },
    });

    expect(observedSupport[0]).toBe(1);
    expect(volume[0]).toBeCloseTo(100 / (1 + 64 / 255), 5);
  });

  it.each(['none', 'huber', 'tukey'] as const)(
    'matches the independently computed fractional-support residual for %s robust loss',
    async (robustLoss) => {
      const observations = [0.9, 0.1];
      const weights = [1, 64 / 255];
      const initial = (observations[0]! * weights[0]! + observations[1]! * weights[1]!) / (weights[0]! + weights[1]!);
      const delta = 0.2;
      let weightedResidual = 0;
      let residualWeight = 0;
      for (let index = 0; index < observations.length; index++) {
        const residual = observations[index]! - initial;
        const absoluteResidual = Math.abs(residual);
        const robustWeight =
          robustLoss === 'none'
            ? 1
            : robustLoss === 'huber'
              ? absoluteResidual <= delta
                ? 1
                : delta / absoluteResidual
              : absoluteResidual >= delta
                ? 0
                : (1 - (absoluteResidual / delta) ** 2) ** 2;
        weightedResidual += robustWeight * weights[index]! * residual;
        residualWeight += robustWeight * weights[index]!;
      }
      const expected = initial + 0.6 * (weightedResidual / residualWeight);

      const volume = await reconstructVolumeFromSlices({
        slices: observations.map((observation, index) => ({
          ...axialSliceGeometry(),
          pixels: new Float32Array([observation]),
          valid: new Uint8Array([index === 0 ? 255 : 64]),
          validScale: 255,
        })),
        grid: { dims: { nx: 1, ny: 1, nz: 1 }, originMm: { x: 0, y: 0, z: 0 }, voxelSizeMm: 1 },
        occupancy: new Uint8Array(1),
        options: {
          ...RECONSTRUCTION_OPTIONS,
          iterations: 1,
          stepSize: 0.6,
          robustLoss,
          robustDelta: delta,
          clampOutput: false,
        },
      });

      expect(volume[0]).toBeCloseTo(expected, 6);
    },
  );

  it('does not reinterpret inter-slice spacing as acquired slice thickness', async () => {
    const dims = { nx: 1, ny: 1, nz: 15 };
    const observedSupport = new Uint8Array(15);

    await reconstructVolumeFromSlices({
      slices: [
        {
          ...axialSliceGeometry(),
          pixels: new Float32Array([1]),
          valid: new Uint8Array([1]),
          ippMm: { x: 0, y: 0, z: 7 },
          sliceThicknessMm: null,
          spacingBetweenSlicesMm: 8,
        },
      ],
      grid: { dims, originMm: { x: 0, y: 0, z: 0 }, voxelSizeMm: 1 },
      occupancy: observedSupport,
      options: { ...RECONSTRUCTION_OPTIONS, psfMode: 'box' },
    });

    expect(observedSupport[7]).toBe(1);
    expect(observedSupport.reduce((count, supported) => count + supported, 0)).toBe(1);
  });

  it('integrates the complete coarse in-plane pixel footprint instead of inventing unsupported gaps', async () => {
    const dims = { nx: 11, ny: 11, nz: 1 };
    const observedSupport = new Uint8Array(dims.nx * dims.ny);

    const volume = await reconstructVolumeFromSlices({
      slices: [
        {
          ...axialSliceGeometry(),
          pixels: new Float32Array([0.75]),
          valid: new Uint8Array([1]),
          ippMm: { x: 5, y: 5, z: 0 },
          rowSpacingDsMm: 4,
          colSpacingDsMm: 4,
        },
      ],
      grid: { dims, originMm: { x: 0, y: 0, z: 0 }, voxelSizeMm: 1 },
      occupancy: observedSupport,
      options: {
        ...RECONSTRUCTION_OPTIONS,
        iterations: 2,
        stepSize: 0.6,
        psfMode: 'box',
        laplacianWeight: 0.02,
      },
    });

    expect(observedSupport.reduce((count, supported) => count + supported, 0)).toBe(25);
    for (let y = 3; y <= 7; y++) {
      for (let x = 3; x <= 7; x++) {
        const index = x + y * dims.nx;
        expect(observedSupport[index]).toBe(1);
        expect(volume[index]).toBeCloseTo(0.75, 5);
      }
    }
  });

  it('builds multiresolution support identically to direct matched observation backprojection', async () => {
    const slices = makeAllSlices().slice(0, 4);
    for (const slice of slices) {
      slice.valid = new Uint8Array(slice.pixels.length).fill(1);
      slice.valid[0] = 0;
      slice.sliceThicknessMm = 3;
    }
    const grid: SvrReconstructionGrid = {
      dims: { nx: 37, ny: 37, nz: 37 },
      originMm: { x: -0.35, y: -0.45, z: -0.55 },
      voxelSizeMm: 1,
    };
    const expectedSupport = new Uint8Array(37 * 37 * 37);

    await reconstructVolumeFromSlices({
      slices,
      grid,
      occupancy: expectedSupport,
      options: { ...RECONSTRUCTION_OPTIONS, psfMode: 'gaussian' },
    });

    let observedCount = -1;
    const observedSupport = await buildObservedSupportFromSlices({
      slices,
      grid,
      psfMode: 'gaussian',
      onObservedSupport: (count) => {
        observedCount = count;
      },
    });

    expect(observedSupport).toEqual(expectedSupport);
    expect(observedCount).toBe(expectedSupport.reduce((count, supported) => count + supported, 0));
  });

  it('computeSvrFromLoadedSlices matches a direct solver run on the same grid', async () => {
    const allSlices = makeAllSlices();
    // The compute phase mutates pixels in place and empties the array, so the
    // reference run gets its own pristine copy.
    const referenceSlices = makeAllSlices();

    const result = await computeSvrFromLoadedSlices({
      allSlices,
      intensitySamples: [...IDENTITY_WINDOW_SAMPLES],
      svrParams: SVR_PARAMS,
      debug: false,
    });

    // DICOM IPP denotes a pixel center. A 33-pixel, 1 mm acquisition spans
    // the complete physical footprint [-0.5, 32.5] on each axis.
    expect(result.dims).toEqual({ nx: 34, ny: 34, nz: 34 });
    expect(result.originMm).toEqual({ x: -0.5, y: -0.5, z: -0.5 });
    expect(result.voxelSizeMm).toBe(1);
    expect(result.bounds).toEqual({ min: { x: -0.5, y: -0.5, z: -0.5 }, max: { x: 32.5, y: 32.5, z: 32.5 } });
    expect(result.volume.length).toBe(34 * 34 * 34);
    expect(result.observedSupport).toHaveLength(result.volume.length);
    expect(result.supportedVoxelCount).toBe(result.observedSupport.reduce((total, supported) => total + supported, 0));
    expect(result.acquiredOrientationCount).toBe(3);
    expect(result.effectiveResolutionMm).toEqual([1, 1, 1]);
    expect(result.sliceProfileSource).toBe('unknown');
    expect(result.reconstructionFingerprint).toMatch(/^[a-f0-9]{16}$/);

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
      regularizationEdgeScale: 0.04,
    };
    const reference = await reconstructVolumeFromSlices({ slices: referenceSlices, grid, options });

    expect(result.volume).toEqual(reference);
  });

  it('rejects decoded-frame cache residency before allocating an otherwise admissible output volume', async () => {
    const allSlices = makeAllSlices();

    await expect(
      computeSyntheticSvr(
        allSlices,
        { ...SVR_PARAMS, iterations: 0 },
        { residentCacheBytes: SVR_MEMORY_BUDGET_BYTES - 1_000 },
      ),
    ).rejects.toThrow(/cache.*budget|budget.*cache/i);

    expect(allSlices).toHaveLength(18);
  });

  it('rejects ROI-rigid registration scratch before starting an otherwise admissible reconstruction', async () => {
    const roi: NonNullable<SvrParams['roi']> = {
      mode: 'cube',
      sourcePlane: 'axial',
      sourceSeriesUid: 's-ax',
      boundsMm: { min: [0, 0, 0], max: [32, 32, 32] },
    };
    const residentCacheBytes = SVR_MEMORY_BUDGET_BYTES - 1_000_000;
    const withoutRegistration = await computeSyntheticSvr(
      makeAllSlices(),
      { ...SVR_PARAMS, iterations: 0, seriesRegistrationMode: 'none', roi },
      { residentCacheBytes },
    );
    const allSlices = makeAllSlices();
    const progress: string[] = [];

    expect(withoutRegistration.volume.length).toBeGreaterThan(0);
    await expect(
      computeSyntheticSvr(
        allSlices,
        { ...SVR_PARAMS, iterations: 0, seriesRegistrationMode: 'roi-rigid', roi },
        { residentCacheBytes, onProgress: (event) => progress.push(event.message) },
      ),
    ).rejects.toThrow(/registration.*budget|budget.*registration/i);

    expect(progress).not.toContain('ROI rigid alignment…');
    expect(allSlices).toHaveLength(18);
  });

  it('rejects distinct nonempty patient coordinate frames before fusion', async () => {
    const allSlices = makeAllSlices();
    for (const slice of allSlices) {
      slice.frameOfReferenceUid = slice.seriesUid === 's-ax' ? 'frame-one' : 'frame-two';
    }

    await expect(computeSyntheticSvr(allSlices, SVR_PARAMS)).rejects.toThrow(/frame.*reference|coordinate frame/i);
    expect(allSlices).toHaveLength(18);
  });

  it('allows legacy slices without a frame UID when all declared coordinate frames agree', async () => {
    const allSlices = makeAllSlices();
    allSlices[0]!.frameOfReferenceUid = 'shared-frame';
    allSlices[1]!.frameOfReferenceUid = 'shared-frame';

    const result = await computeSyntheticSvr(allSlices, { ...SVR_PARAMS, iterations: 0 });

    expect(result.supportedVoxelCount).toBeGreaterThan(0);
  });

  it('reports anisotropic acquired evidence and never confuses slice cadence with profile provenance', async () => {
    const slice = makeAllSlices()[0]!;
    slice.pixels = new Float32Array([0, 1, 1, 0]);
    slice.valid = new Uint8Array([1, 1, 1, 1]);
    slice.dsRows = 2;
    slice.dsCols = 2;
    slice.ippMm = { x: 0, y: 0, z: 0 };
    slice.rowSpacingDsMm = 0.5;
    slice.colSpacingDsMm = 1;
    slice.sliceThicknessMm = 3;
    slice.spacingBetweenSlicesMm = 8;

    const result = await computeSyntheticSvr([slice], { ...SVR_PARAMS, targetVoxelSizeMm: 0.5, iterations: 0 });

    expect(result.acquiredOrientationCount).toBe(1);
    expect(result.sliceProfileSource).toBe('declared');
    expect(result.effectiveResolutionMm).toEqual([1, 0.5, 8]);
  });

  it('distinguishes mixed slice-profile provenance and opposite normals from independent orientations', async () => {
    const slices = makeAllSlices()
      .filter((slice) => slice.seriesUid === 's-ax')
      .slice(0, 2);
    slices[0]!.sliceThicknessMm = 3;
    slices[1]!.sliceThicknessMm = null;
    slices[1]!.normalDir = { x: 0, y: 0, z: -1 };

    const result = await computeSyntheticSvr(slices, { ...SVR_PARAMS, iterations: 0 });

    expect(result.acquiredOrientationCount).toBe(1);
    expect(result.sliceProfileSource).toBe('mixed');
  });

  it('binds reconstructed annotation identity to source SOPs and accepted solver settings', async () => {
    const reconstruct = (slices: LoadedSlice[], iterations: number) =>
      computeSyntheticSvr(slices, { ...SVR_PARAMS, iterations });

    const first = await reconstruct(makeAllSlices(), 0);
    const identical = await reconstruct(makeAllSlices(), 0);
    const changedSettings = await reconstruct(makeAllSlices(), 1);
    const changedSources = makeAllSlices();
    changedSources[0]!.sopInstanceUid = 'different-source-instance';
    const changedIdentity = await reconstruct(changedSources, 0);

    expect(identical.reconstructionFingerprint).toBe(first.reconstructionFingerprint);
    expect(changedSettings.reconstructionFingerprint).not.toBe(first.reconstructionFingerprint);
    expect(changedIdentity.reconstructionFingerprint).not.toBe(first.reconstructionFingerprint);
    expect(changedIdentity.reconstructionFingerprint).not.toContain('different-source-instance');
  });

  it('keeps exactly one observed voxel supported and never diffuses it into six unsupported neighbors', async () => {
    const dims = { nx: 5, ny: 5, nz: 5 };
    const occupancy = new Uint8Array(dims.nx * dims.ny * dims.nz);
    const centerIndex = idxOf(2, 2, 2, dims);

    const volume = await reconstructVolumeFromSlices({
      slices: [
        {
          ...axialSliceGeometry(),
          pixels: new Float32Array([1]),
          valid: new Uint8Array([1]),
          ippMm: { x: 2, y: 2, z: 2 },
        },
      ],
      grid: { dims, originMm: { x: 0, y: 0, z: 0 }, voxelSizeMm: 1 },
      occupancy,
      options: { ...RECONSTRUCTION_OPTIONS, iterations: 2, stepSize: 0.6, laplacianWeight: 0.2 },
    });

    expect(occupancy[centerIndex]).toBe(1);
    expect(volume[centerIndex]).toBeCloseTo(1);
    for (let index = 0; index < volume.length; index++) {
      if (index === centerIndex) continue;
      expect(occupancy[index]).toBe(0);
      expect(volume[index]).toBe(0);
    }
  });

  it('returns acquired support and excludes padded pixels from production reconstruction', async () => {
    const allSlices = makeAllSlices();
    for (const slice of allSlices) {
      slice.valid = new Uint8Array(slice.pixels.length).fill(1);
      slice.valid[0] = 0;
      slice.pixels[0] = 1;
    }

    const result = await computeSyntheticSvr(allSlices, {
      ...SVR_PARAMS,
      multiResolution: true,
      multiResolutionFactor: 2,
      multiResolutionCoarseIterations: 1,
    });

    expect(result.observedSupport).toHaveLength(result.volume.length);
    expect(result.observedSupport.some((value) => value > 0)).toBe(true);
    expect(result.observedSupport.some((value) => value === 0)).toBe(true);
    expect(result.supportedVoxelCount).toBe(result.observedSupport.reduce((total, supported) => total + supported, 0));
    for (let index = 0; index < result.volume.length; index++) {
      if (!result.observedSupport[index]) expect(result.volume[index]).toBe(0);
    }
  });

  it('preserves supported anatomical intensity when multiresolution interpolation crosses empty coarse voxels', async () => {
    const allSlices = makeAllSlices();
    for (const slice of allSlices) {
      slice.pixels.fill(0.75);
      slice.valid = new Uint8Array(slice.pixels.length).fill(1);
    }

    const result = await computeSyntheticSvr(allSlices, {
      ...SVR_PARAMS,
      iterations: 1,
      stepSize: 0,
      robustLoss: 'none',
      laplacianWeight: 0,
      multiResolution: true,
      multiResolutionFactor: 2,
      multiResolutionCoarseIterations: 1,
    });

    let supportedVoxels = 0;
    let unsupportedNonzeroVoxels = 0;
    let maximumSupportedError = 0;
    for (let index = 0; index < result.volume.length; index++) {
      if (!result.observedSupport[index]) {
        if (result.volume[index] !== 0) unsupportedNonzeroVoxels++;
        continue;
      }
      supportedVoxels++;
      // The preserved affine source range is [0, 0.75], so a constant observation is normalized to 1.
      maximumSupportedError = Math.max(maximumSupportedError, Math.abs(result.volume[index]! - 1));
    }
    expect(supportedVoxels).toBeGreaterThan(0);
    expect(maximumSupportedError).toBeLessThan(1e-5);
    expect(unsupportedNonzeroVoxels).toBe(0);
  });

  it('preserves production support through physical ROI cropping and refinement', async () => {
    const allSlices = makeAllSlices();
    for (const slice of allSlices) {
      slice.valid = new Uint8Array(slice.pixels.length).fill(1);
      slice.valid[11 * slice.dsCols + 11] = 0;
    }

    const result = await computeSyntheticSvr(allSlices, {
      ...SVR_PARAMS,
      roi: {
        mode: 'cube',
        sourcePlane: 'axial',
        sourceSeriesUid: 's-ax',
        boundsMm: { min: [9, 9, 9], max: [21, 21, 21] },
      },
    });

    expect(result.supportedVoxelCount).toBeGreaterThan(0);
    expect(result.supportedVoxelCount).toBeLessThan(result.volume.length);
    for (let index = 0; index < result.volume.length; index++) {
      if (!result.observedSupport[index]) expect(result.volume[index]).toBe(0);
    }
  });

  it('encloses the complete rotated pixel footprint and declared through-plane profile', async () => {
    const rootHalf = Math.SQRT1_2;
    const slice = makeAllSlices()[0]!;
    slice.pixels = new Float32Array([0, 1, 1, 0]);
    slice.valid = new Uint8Array([1, 1, 1, 1]);
    slice.dsRows = 2;
    slice.dsCols = 2;
    slice.rowSpacingDsMm = 10;
    slice.colSpacingDsMm = 10;
    slice.ippMm = { x: 0, y: 0, z: 0 };
    slice.rowDir = { x: rootHalf, y: rootHalf, z: 0 };
    slice.colDir = { x: -rootHalf, y: rootHalf, z: 0 };
    slice.normalDir = { x: 0, y: 0, z: 1 };
    slice.sliceThicknessMm = 6;
    slice.spacingBetweenSlicesMm = 20;

    const result = await computeSyntheticSvr([slice], { ...SVR_PARAMS, iterations: 0 });

    expect(result.bounds.min.x).toBeCloseTo(-10 * Math.SQRT2, 6);
    expect(result.bounds.max.x).toBeCloseTo(10 * Math.SQRT2, 6);
    expect(result.bounds.min.y).toBeCloseTo(-5 * Math.SQRT2, 6);
    expect(result.bounds.max.y).toBeCloseTo(15 * Math.SQRT2, 6);
    expect(result.bounds.min.z).toBeCloseTo(-3, 6);
    expect(result.bounds.max.z).toBeCloseTo(3, 6);
  });

  it('rejects with the SVR cancelled error when the signal is already aborted', async () => {
    const controller = new AbortController();
    controller.abort();

    await expect(
      computeSvrFromLoadedSlices({
        allSlices: makeAllSlices(),
        intensitySamples: [...IDENTITY_WINDOW_SAMPLES],
        svrParams: SVR_PARAMS,
        signal: controller.signal,
        debug: false,
      }),
    ).rejects.toThrow('SVR cancelled');
  });

  it('observes cancellation at a reconstruction yield before accepting another acquired slice', async () => {
    const controller = new AbortController();
    let yields = 0;

    await expect(
      reconstructVolumeFromSlices({
        slices: [
          { ...axialSliceGeometry(), pixels: new Float32Array([0.25]) },
          { ...axialSliceGeometry(), pixels: new Float32Array([0.75]) },
        ],
        grid: { dims: { nx: 1, ny: 1, nz: 1 }, originMm: { x: 0, y: 0, z: 0 }, voxelSizeMm: 1 },
        options: { ...RECONSTRUCTION_OPTIONS, iterations: 1 },
        hooks: {
          signal: controller.signal,
          yieldToMain: async () => {
            yields++;
            controller.abort();
          },
        },
      }),
    ).rejects.toThrow('SVR cancelled');

    expect(yields).toBe(1);
  });

  it('preserves correctly positioned partial-FOV series under the default ROI-rigid mode without an ROI', async () => {
    const slices = makeAllSlices();
    const partial = slices.filter((slice) => slice.seriesUid === 's-ax').slice(0, 3);
    const reference = slices.filter((slice) => slice.seriesUid === 's-cor');
    const original = partial.map((slice) => ({ ...slice.ippMm }));

    await computeSyntheticSvr([...reference, ...partial], {
      ...SVR_PARAMS,
      seriesRegistrationMode: 'roi-rigid',
      roi: null,
      iterations: 0,
    });

    expect(partial.map((slice) => slice.ippMm)).toEqual(original);
  });

  it('redacts source, patient, frame, and study identities from coarse-registration diagnostics', async () => {
    const { allSlices, spies, progress } = privateDiagnostics(true);

    try {
      await computeSyntheticSvr(
        allSlices,
        { ...SVR_PARAMS, iterations: 0, seriesRegistrationMode: 'bounds-center' },
        { onProgress: (event) => progress.push(event.message), debug: true },
      );

      const diagnostics = JSON.stringify({ calls: spies.flatMap((spy) => spy.mock.calls), progress });
      expect(diagnostics).toContain('referenceSource');
      expect(diagnostics).toContain('sourceCount');
      expect(diagnostics).not.toMatch(/PRIVATE_(?:SERIES|SOP|FRAME|PATIENT|STUDY)/);
    } finally {
      for (const spy of spies) spy.mockRestore();
    }
  });

  it('redacts source identity from ROI registration plans, skipped-series warnings, and progress', async () => {
    const { allSlices, spies, progress } = privateDiagnostics();

    try {
      await computeSyntheticSvr(
        allSlices,
        {
          ...SVR_PARAMS,
          iterations: 0,
          seriesRegistrationMode: 'roi-rigid',
          roi: {
            mode: 'cube',
            sourcePlane: 'axial',
            sourceSeriesUid: 'PRIVATE_SERIES_AXIAL_123',
            boundsMm: { min: [10, 10, 10], max: [14, 14, 14] },
          },
        },
        { onProgress: (event) => progress.push(event.message), debug: true },
      );

      const diagnostics = JSON.stringify({ calls: spies.flatMap((spy) => spy.mock.calls), progress });
      expect(diagnostics).toContain('registration.roi-rigid.plan');
      expect(diagnostics).toContain('too few samples');
      expect(diagnostics).toContain('sourceCount');
      expect(diagnostics).not.toMatch(/PRIVATE_(?:SERIES|SOP|FRAME|PATIENT|STUDY)/);
    } finally {
      for (const spy of spies) spy.mockRestore();
    }
  });
});
