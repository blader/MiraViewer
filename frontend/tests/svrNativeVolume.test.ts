import { describe, expect, it, vi } from 'vitest';
import type { SeriesFrameManifest } from '../src/utils/localApi';
import {
  assembleNativeVolume,
  nativeDecodedCacheBudgetBytes,
  nativePlaneMemoryBytes,
  planNativeVolume,
  retainedSvrVolumeBytes,
} from '../src/utils/svr/nativeVolume';
import { patientToVolumeVoxel, volumeVoxelToPatient } from '../src/utils/svr/volumeGeometry';
import * as memoryPlanning from '../src/utils/svr/svrMemoryPlan';

function stack(
  options: {
    dims?: [number, number, number];
    spacing?: [number, number, number];
    rowDirection?: [number, number, number];
    columnDirection?: [number, number, number];
    origin?: [number, number, number];
    missing?: number[];
  } = {},
): SeriesFrameManifest {
  const dims = options.dims ?? [6, 5, 4],
    spacing = options.spacing ?? [0.7, 1.1, 2];
  const row = options.rowDirection ?? [1, 0, 0],
    col = options.columnDirection ?? [0, 1, 0];
  const normal = [
    row[1] * col[2] - row[2] * col[1],
    row[2] * col[0] - row[0] * col[2],
    row[0] * col[1] - row[1] * col[0],
  ];
  const origin = options.origin ?? [15, -23, 7];
  return {
    seriesUid: 'native-series',
    studyUid: 'study',
    patientKey: 'patient',
    frameOfReferenceUid: 'frame',
    ordering: 'physical',
    geometryReliable: true,
    sliceSpacingMm: spacing[2],
    frames: Array.from({ length: dims[2] }, (_, slice) => ({
      sopInstanceUid: `native-${slice}`,
      seriesInstanceUid: 'native-series',
      studyInstanceUid: 'study',
      frameOfReferenceUid: 'frame',
      instanceNumber: slice + 1,
      rows: dims[1],
      columns: dims[0],
      imageOrientationPatient: [...row, ...col].join('\\'),
      imagePositionPatient: origin.map((value, axis) => value + normal[axis]! * slice * spacing[2]).join('\\'),
      pixelSpacing: `${spacing[1]}\\${spacing[0]}`,
      spacingBetweenSlices: spacing[2],
      sliceThickness: spacing[2],
      windowCenter: -200,
      windowWidth: 400,
    }))
      .filter((_, slice) => !options.missing?.includes(slice))
      .reverse(),
  };
}

describe('native source volume preservation', () => {
  it('permutes/flips source axes without interpolation, preserving signed modality pixels and padding', async () => {
    const manifest = stack({ rowDirection: [-1, 0, 0], columnDirection: [0, 0, -1] });
    const plan = planNativeVolume(manifest, {}, { decodedCacheBytes: 0 });
    const volume = await assembleNativeVolume(plan, async (frame) => {
      const slice = frame.instanceNumber - 1;
      return {
        pixels: Int16Array.from({ length: frame.rows * frame.columns }, (_, index) =>
          slice === 1 && index === 7
            ? -32768
            : -2000 + slice * 1001 + Math.floor(index / frame.columns) * 101 + (index % frame.columns) * 7,
        ),
        slope: 2,
        intercept: 17,
        pixelPaddingValue: -32768,
      };
    });
    expect(volume.dims).toEqual([6, 4, 5]);
    expect(volume.nativeVoxelSizeMm).toEqual([0.7, 2, 1.1]);
    expect(volume.voxelSizeMm).toEqual(volume.nativeVoxelSizeMm);
    expect(plan.overview).toBe(false);
    expect(volume.displayWindow).toEqual([-400, -1]);
    expect(volume.supportedVoxelCount).toBe(6 * 5 * 4 - 1);
    for (let slice = 0; slice < 4; slice++)
      for (let row = 0; row < 5; row++)
        for (let column = 0; column < 6; column++) {
          const patient: [number, number, number] = [15 - column * 0.7, -23 - slice * 2, 7 - row * 1.1];
          const voxel = patientToVolumeVoxel(volume, patient);
          const expected = [5 - column, 3 - slice, 4 - row];
          voxel.forEach((value, axis) => expect(value).toBeCloseTo(expected[axis]!, 9));
          const index = (expected[2]! * volume.dims[1] + expected[1]!) * volume.dims[0] + expected[0]!;
          if (slice === 1 && row === 1 && column === 1) {
            expect(volume.observedSupport![index]).toBe(0);
            expect(volume.data[index]).toBe(0);
          } else {
            expect(volume.observedSupport![index]).toBe(1);
            expect(volume.data[index]).toBe((-2000 + slice * 1001 + row * 101 + column * 7) * 2 + 17);
          }
          volumeVoxelToPatient(volume, expected as [number, number, number]).forEach((value, axis) =>
            expect(value).toBeCloseTo(patient[axis]!, 9),
          );
        }
  });

  it('keeps residual obliquity and accepted rigid coordinates while preserving exact source samples', async () => {
    const c = Math.cos(0.31),
      s = Math.sin(0.31);
    const manifest = stack({ rowDirection: [c, s, 0], columnDirection: [-s, c, 0] });
    const plan = planNativeVolume(
      manifest,
      {},
      { decodedCacheBytes: 0, transform: { rotation: [1, 0, 0, 0, 1, 0, 0, 0, 1], translationMm: [40, 10, -5] } },
    );
    const volume = await assembleNativeVolume(plan, async (frame) => ({
      pixels: Float32Array.from(
        { length: frame.rows * frame.columns },
        (_, index) => (frame.instanceNumber - 1) * 100 + index - 40,
      ),
    }));
    const point = volumeVoxelToPatient(volume, [3, 2, 1]);
    expect(point[0]).toBeCloseTo(55 + c * 3 * 0.7 - s * 2 * 1.1, 9);
    expect(point[1]).toBeCloseTo(-13 + s * 3 * 0.7 + c * 2 * 1.1, 9);
    expect(point[2]).toBeCloseTo(4, 9);
    expect(volume.data[(1 * 5 + 2) * 6 + 3]).toBe(75);
  });

  it('preserves photometric inversion and the exact one-unit DICOM threshold without changing raw samples', async () => {
    const manifest = stack();
    for (const frame of manifest.frames) {
      frame.windowCenter = -200;
      frame.windowWidth = 1;
    }
    const plan = planNativeVolume(manifest, {}, { decodedCacheBytes: 0 });
    const volume = await assembleNativeVolume(plan, async (frame) => ({
      pixels: new Int16Array(frame.rows * frame.columns).fill(-201),
      invert: true,
    }));
    expect(volume.displayWindow).toEqual([-200.5, -200.5]);
    expect(volume.displayInvert).toBe(true);
    expect(volume.data.every((value) => value === -201)).toBe(true);
    await expect(
      assembleNativeVolume(plan, async (frame) => ({
        pixels: new Int16Array(frame.rows * frame.columns).fill(-201),
        invert: frame.instanceNumber === 1,
      })),
    ).rejects.toThrow(/disagree on photometric inversion/);
  });

  it('encloses informative source windows instead of clipping other sections to the middle-frame VOI', async () => {
    const manifest = stack({ dims: [6, 5, 5] });
    for (const frame of manifest.frames) {
      frame.windowCenter = frame.instanceNumber === 1 ? 0 : frame.instanceNumber === 3 ? 656.5 : 500;
      frame.windowWidth = frame.instanceNumber === 1 ? 1 : frame.instanceNumber === 3 ? 1313 : 1000;
      if (frame.instanceNumber === 2) {
        frame.windowCenter = 1871;
        frame.windowWidth = 3742;
      }
    }
    const plan = planNativeVolume(manifest, {}, { decodedCacheBytes: 0 });
    const read = vi.fn(async (frame: SeriesFrameManifest['frames'][number]) => ({
      pixels: Float32Array.from({ length: frame.rows * frame.columns }, (_, index) =>
        frame.instanceNumber === 1 ? 0 : frame.instanceNumber * 100 + index,
      ),
    }));
    const volume = await assembleNativeVolume(plan, read);
    expect(volume.displayWindow).toEqual([0, 3741]);
    expect(volume.intensityRange).toEqual([0, 529]);
    expect(volume.data.slice(0, 30)).toEqual(new Float32Array(30));
    expect(volume.data.slice(60, 90)).toEqual(Float32Array.from({ length: 30 }, (_, index) => 300 + index));
    expect(volume.supportedVoxelCount).toBe(150);
    expect(read).toHaveBeenCalledTimes(5);
    expect(plan.frames[0]!.frame.windowCenter).toBe(0);
    expect(plan.frames[0]!.frame.windowWidth).toBe(1);
  });

  it.each(['single', 'uniform'] as const)('keeps a legal %s informative width-one source window', async (mode) => {
    const manifest = stack({ dims: [6, 5, 5] });
    for (const frame of manifest.frames) {
      frame.windowCenter = 10;
      frame.windowWidth = 1;
    }
    const volume = await assembleNativeVolume(
      planNativeVolume(manifest, {}, { decodedCacheBytes: 0 }),
      async (frame) => ({
        pixels: Float32Array.from({ length: frame.rows * frame.columns }, (_, index) =>
          (mode === 'uniform' || frame.instanceNumber === 3) && index % 2 ? 20 : 0,
        ),
      }),
    );
    expect(volume.displayWindow).toEqual([9.5, 9.5]);
    expect(volume.intensityRange).toEqual([0, 20]);
  });

  it('ignores flat frames, padding-only variation and invalid VOI when enclosing informative windows', async () => {
    const manifest = stack({ dims: [6, 5, 7] });
    for (const frame of manifest.frames) {
      frame.windowCenter = frame.instanceNumber * 100;
      frame.windowWidth = frame.instanceNumber === 3 ? 0 : 200;
      if (frame.instanceNumber === 4 || frame.instanceNumber === 7) {
        frame.windowCenter = 0;
        frame.windowWidth = 20_000;
      }
    }
    const volume = await assembleNativeVolume(
      planNativeVolume(manifest, {}, { decodedCacheBytes: 0 }),
      async (frame) => ({
        pixels: Float32Array.from({ length: frame.rows * frame.columns }, (_, index) => {
          if (frame.instanceNumber === 4) return index === 0 ? -32768 : 0;
          if (frame.instanceNumber === 7) return 9;
          return index;
        }),
        pixelPaddingValue: -32768,
      }),
    );
    // Frames4/7 are flat after excluding padding; frame3 has no valid VOI.
    expect(volume.displayWindow).toEqual([0, 699]);
    expect(volume.supportedVoxelCount).toBe(6 * 5 * 7 - 1);
  });

  it.each(['roi', 'overview'] as const)(
    'chooses VOI from actually loaded %s frames without changing source samples or geometry',
    async (mode) => {
      const manifest = stack({ dims: [12, 12, 9], spacing: [1, 1, 1], origin: [0, 0, 0] });
      for (const frame of manifest.frames) {
        frame.windowCenter = frame.instanceNumber * 100;
        frame.windowWidth = 200;
      }
      const baseOptions = { decodedCacheBytes: 0, nativePlaneBytes: 0 };
      const full = planNativeVolume(manifest, {}, baseOptions);
      const plan =
        mode === 'roi'
          ? planNativeVolume(
              manifest,
              { roi: { mode: 'box', sourcePlane: 'axial', boundsMm: { min: [3, 3, 5], max: [7, 7, 7] } } },
              baseOptions,
            )
          : planNativeVolume(manifest, {}, { ...baseOptions, budgetBytes: Math.floor(full.totalBytes * 0.2) });
      const read = vi.fn(async (frame: SeriesFrameManifest['frames'][number]) => ({
        pixels: Float32Array.from(
          { length: frame.rows * frame.columns },
          (_, index) => frame.instanceNumber * 1000 + index,
        ),
      }));
      const volume = await assembleNativeVolume(plan, read);
      const frames = plan.frames.filter(
        ({ slice }) =>
          slice >= plan.cropMin[2] &&
          slice <= plan.cropMax[2] &&
          (slice - plan.cropMin[2]) % plan.sourceStrides[2] === 0,
      );
      expect(volume.displayWindow).toEqual([
        Math.min(...frames.map(({ frame }) => frame.instanceNumber * 100 - 100)),
        Math.max(...frames.map(({ frame }) => frame.instanceNumber * 100 + 99)),
      ]);
      expect(volume.dims).toEqual(plan.dims);
      expect(volume.originMm).toEqual(plan.originMm);
      expect(volume.voxelSizeMm).toEqual(plan.voxelSizeMm);
      expect(plan.overview).toBe(mode === 'overview');
      if (mode === 'overview') expect(plan.sourceStrides[2]).toBeGreaterThan(1);
      expect(read).toHaveBeenCalledTimes(frames.length);
      for (let z = 0; z < volume.dims[2]; z++)
        for (let y = 0; y < volume.dims[1]; y++)
          for (let x = 0; x < volume.dims[0]; x++) {
            const sourceX = plan.cropMin[0] + x * plan.sourceStrides[0];
            const sourceY = plan.cropMin[1] + y * plan.sourceStrides[1];
            const sourceZ = plan.cropMin[2] + z * plan.sourceStrides[2];
            const index = (z * volume.dims[1] + y) * volume.dims[0] + x;
            expect(volume.data[index]).toBe((sourceZ + 1) * 1000 + sourceY * 12 + sourceX);
            expect(volume.observedSupport![index]).toBe(1);
          }
    },
  );

  it('preserves a common source VOI exactly without deriving a new window from source extrema', async () => {
    const manifest = stack();
    const volume = await assembleNativeVolume(
      planNativeVolume(manifest, {}, { decodedCacheBytes: 0 }),
      async (frame) => ({
        pixels: Float32Array.from({ length: frame.rows * frame.columns }, (_, index) => index - 10),
      }),
    );
    expect(volume.displayWindow).toEqual([-400, -1]);
    expect(volume.intensityRange).toEqual([-10, 19]);
  });

  it('retains the first loaded frame VOI fallback when all loaded frames are flat', async () => {
    const manifest = stack();
    for (const frame of manifest.frames) {
      frame.windowCenter = frame.instanceNumber * 100;
      frame.windowWidth = 200;
    }
    const volume = await assembleNativeVolume(
      planNativeVolume(manifest, {}, { decodedCacheBytes: 0 }),
      async (frame) => ({ pixels: new Float32Array(frame.rows * frame.columns).fill(frame.instanceNumber) }),
    );
    expect(volume.displayWindow).toEqual([0, 199]);
    expect(volume.intensityRange).toEqual([1, 4]);
  });

  it('uses the existing source-range fallback when informative frames have no VOI', async () => {
    const manifest = stack();
    for (const frame of manifest.frames) {
      delete frame.windowCenter;
      delete frame.windowWidth;
    }
    const volume = await assembleNativeVolume(
      planNativeVolume(manifest, {}, { decodedCacheBytes: 0 }),
      async (frame) => ({
        pixels: Float32Array.from({ length: frame.rows * frame.columns }, (_, index) => index - 10),
      }),
    );
    expect(volume.displayWindow).toEqual([-10, 19]);
    expect(volume.intensityRange).toEqual(volume.displayWindow);
  });

  it('budgets the largest exposed native plane and keeps prior raw, display, support and labels resident', async () => {
    const small = stack(),
      larger = stack({ dims: [1024, 512, 2] });
    expect(nativePlaneMemoryBytes([small, larger])).toBe(nativePlaneMemoryBytes([larger]));
    expect(nativePlaneMemoryBytes([larger])).toBeGreaterThan(nativePlaneMemoryBytes([small]));
    expect(nativePlaneMemoryBytes([larger])).toBe(32 * 1024 * 1024 + 1024 * 512 * (25 + 3 * 4));
    const initial = planNativeVolume(small, {}, { decodedCacheBytes: 0 });
    const volume = await assembleNativeVolume(initial, async (frame) => ({
      pixels: new Int16Array(frame.rows * frame.columns).fill(-7),
    }));
    const retained = retainedSvrVolumeBytes(volume);
    expect(retained).toBe(volume.data.length * 16);
    expect(retainedSvrVolumeBytes()).toBe(0);
    const replacement = planNativeVolume(
      small,
      {},
      {
        decodedCacheBytes: 0,
        retainedBytes: retained,
        nativePlaneBytes: nativePlaneMemoryBytes([small, larger]),
      },
    );
    expect(replacement.totalBytes - initial.totalBytes).toBe(
      retained + nativePlaneMemoryBytes([larger]) - nativePlaneMemoryBytes([small]),
    );
  });

  it('reserves measured decoded-cache residency for streaming and a conservative fallback for unavailable telemetry', () => {
    const mib = 1024 * 1024;
    expect(nativeDecodedCacheBudgetBytes()).toBe(256 * mib);
    expect(nativeDecodedCacheBudgetBytes({ maximumSizeInBytes: 64 * mib, cacheSizeInBytes: 16 * mib })).toBe(16 * mib);
    expect(nativeDecodedCacheBudgetBytes({ maximumSizeInBytes: 256 * mib, cacheSizeInBytes: 0 })).toBe(0);
    expect(nativeDecodedCacheBudgetBytes({ maximumSizeInBytes: 64 * mib, cacheSizeInBytes: 80 * mib })).toBe(80 * mib);
    expect(nativeDecodedCacheBudgetBytes({ maximumSizeInBytes: NaN, cacheSizeInBytes: 320 * mib })).toBe(320 * mib);
    expect(nativeDecodedCacheBudgetBytes({ maximumSizeInBytes: -1, cacheSizeInBytes: Infinity })).toBe(256 * mib);
  });

  it('admits native detail around the visually confirmed 313 selection while retaining its accepted overview', () => {
    const manifest = stack({
      dims: [512, 512, 274],
      spacing: [0.4296875, 0.4296875, 0.6],
      origin: [0, 0, 0],
      rowDirection: [0, 1, 0],
      columnDirection: [0, 0, 1],
    });
    const displayedSpacing = [1.2, 0.859375, 0.859375];
    const selectedMin = [61, 88, 77],
      selectedMax = [78, 149, 128];
    const minimum = selectedMin.map((value, axis) => (value - 0.5) * displayedSpacing[axis]!);
    const maximum = selectedMax.map((value, axis) => (value + 0.5) * displayedSpacing[axis]!);
    const side = Math.max(...maximum.map((value, axis) => value - minimum[axis]!)) + 24;
    const center = minimum.map((value, axis) => (value + maximum[axis]!) / 2);
    const cache = { cacheSizeInBytes: 32 * 1024 * 1024, maximumSizeInBytes: 256 * 1024 * 1024 };
    const retainedBytes = 137 * 256 * 256 * 16 + 1024 * 1024 * 7;
    const plan = planNativeVolume(
      manifest,
      {
        roi: {
          mode: 'cube',
          sourcePlane: 'axial',
          boundsMm: {
            min: center.map((value) => value - side / 2) as [number, number, number],
            max: center.map((value) => value + side / 2) as [number, number, number],
          },
        },
      },
      {
        retainedBytes,
        decodedCacheBytes: nativeDecodedCacheBudgetBytes(cache),
        nativePlaneBytes: nativePlaneMemoryBytes([manifest, { frames: [{ rows: 1024, columns: 1024 }] }]),
      },
    );
    expect(plan.totalBytes).toBeLessThanOrEqual(plan.budgetBytes);
    expect(plan.overview).toBe(false);
    expect(plan.voxelSizeMm).toEqual([0.6, 0.4296875, 0.4296875]);
    expect(plan.sourceStrides).toEqual([1, 1, 1]);
    expect(plan.decodedCacheBytes).toBe(cache.cacheSizeInBytes);
    expect(plan.memoryPlan.retainedBytes).toBeGreaterThan(retainedBytes + cache.cacheSizeInBytes);
  });

  it('retains native pitch for a small ROI before budgeting full frame copies', () => {
    const manifest = stack({ dims: [1024, 1024, 221], spacing: [0.25, 0.25, 0.6], origin: [0, 0, 0] });
    const overview = planNativeVolume(manifest, {});
    const detail = planNativeVolume(manifest, {
      roi: { mode: 'cube', sourcePlane: 'axial', boundsMm: { min: [120, 120, 60], max: [130, 130, 70] } },
    });
    expect(overview.overview).toBe(true);
    expect(overview.totalBytes).toBeLessThanOrEqual(overview.budgetBytes);
    expect(detail.sourceStrides).toEqual([1, 1, 1]);
    expect(detail.voxelSizeMm).toEqual([0.25, 0.25, 0.6]);
    expect(detail.dims[0]).toBeLessThan(50);
    expect(detail.dims[1]).toBeLessThan(50);
    expect(detail.dims[2]).toBeLessThan(25);
    expect(detail.totalBytes).toBeLessThanOrEqual(detail.budgetBytes);
    expect(detail.sourceBytes).toBe(1024 * 1024 * 4);
  });

  it('preserves the prior physical-pitch sampling order, including axis ties and corpus geometry', () => {
    const shapes: [number, number, number][] = [
      [13, 11, 7],
      [8, 5, 11],
      [512, 512, 274],
    ];
    const spacings: [number, number, number][] = [
      [1, 1, 1],
      [0.7, 1.1, 2],
      [0.4296875, 0.4296875, 0.6],
    ];
    for (const dims of shapes)
      for (const spacing of spacings)
        for (const fraction of [0.1, 0.3, 0.7]) {
          const limit = Math.floor(dims.reduce((product, size) => product * size, 1) * fraction);
          const expected = [1, 1, 1];
          const counts = () => dims.map((size, axis) => Math.floor((size - 1) / expected[axis]!) + 1);
          // Reference the former greedy schedule only on small, realistic grids.
          while (counts().reduce((product, size) => product * size, 1) > limit) {
            const axis = [0, 1, 2]
              .filter((axis) => counts()[axis]! > 1)
              .sort((a, b) => spacing[a]! * expected[a]! - spacing[b]! * expected[b]!)[0]!;
            expected[axis]!++;
          }
          const plan = planNativeVolume(
            stack({ dims, spacing, origin: [0, 0, 0] }),
            {},
            {
              decodedCacheBytes: 0,
              nativePlaneBytes: 0,
              budgetBytes: dims[0] * dims[1] * 4 + limit * 16,
            },
          );
          expect(plan.sourceStrides).toEqual(expected);
          expect(plan.nativeVoxelSizeMm).toEqual(spacing);
          expect(plan.totalBytes).toBeLessThanOrEqual(plan.budgetBytes);
        }
  });

  it('bounds admission work for an enormous but safely indexed sparse native grid', () => {
    const manifest = stack({ dims: [2, 2, 2], spacing: [1, 1, 1], origin: [0, 0, 0] });
    for (const frame of manifest.frames) frame.spacingBetweenSlices = 1e-14;
    const estimate = vi.spyOn(memoryPlanning, 'estimateSvrPeakMemoryBytes');
    try {
      const plan = planNativeVolume(manifest, {});
      expect(plan.sourceDims).toEqual([2, 2, 100_000_000_000_001]);
      expect(plan.nativeVoxelSizeMm).toEqual([1, 1, 1e-14]);
      expect(plan.sourceStrides[2]).toBeGreaterThan(1_000_000);
      expect(plan.totalBytes).toBeLessThanOrEqual(plan.budgetBytes);
      // At most 53 integer probes per source axis, not one per required stride.
      expect(estimate.mock.calls.length).toBeLessThanOrEqual(165);
    } finally {
      estimate.mockRestore();
    }
  });

  it.each([0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])(
    'rejects unsafe native pixel dimensions (%s)',
    (rows) => {
      const manifest = stack();
      for (const frame of manifest.frames) frame.rows = rows;
      expect(() => planNativeVolume(manifest, {})).toThrow(/invalid native pixel dimensions/);
    },
  );

  it('rejects unsafe source indices and products before memory admission can normalize overflow to zero', () => {
    const manifest = stack({ dims: [2, 2, 2], spacing: [1, 1, 1], origin: [0, 0, 0] });
    for (const frame of manifest.frames) frame.spacingBetweenSlices = 1e-16;
    expect(() => planNativeVolume(manifest, {})).toThrow(/safe native-grid dimensions/);
    const unsafeProduct = stack();
    for (const frame of unsafeProduct.frames) {
      frame.rows = 100_000_000;
      frame.columns = 100_000_000;
    }
    expect(() => planNativeVolume(unsafeProduct, {})).toThrow(/safe native-grid dimensions/);
    expect(() => planNativeVolume(stack(), {}, { retainedBytes: Infinity })).toThrow(/finite.*memory/);
  });

  it('rejects an oversized exact ROI before decoding instead of silently changing native pitch', async () => {
    const manifest = stack({ dims: [101, 101, 101], spacing: [1, 1, 1], origin: [0, 0, 0] });
    const options = { decodedCacheBytes: 0, budgetBytes: 40 * 1024 * 1024 };
    const plan = planNativeVolume(
      manifest,
      { roi: { mode: 'cube', sourcePlane: 'axial', boundsMm: { min: [0, 0, 0], max: [100, 100, 100] } } },
      options,
    );
    const read = vi.fn();
    expect(plan.voxelSizeMm).toEqual([1, 1, 1]);
    expect(plan.totalBytes).toBeGreaterThan(plan.budgetBytes);
    await expect(assembleNativeVolume(plan, read)).rejects.toThrow(/smaller region.*not be silently reduced/);
    expect(read).not.toHaveBeenCalled();
    expect(planNativeVolume(manifest, {}, options).totalBytes).toBeLessThanOrEqual(options.budgetBytes);
  });

  it('keeps absent native slice planes unsupported and decodes only ROI-contributing frames sequentially', async () => {
    const manifest = stack({ dims: [3, 3, 5], spacing: [1, 1, 1], origin: [0, 0, 0], missing: [1, 3] });
    const plan = planNativeVolume(manifest, {}, { decodedCacheBytes: 0 });
    let inFlight = 0;
    const read = vi.fn(async () => {
      expect(inFlight++).toBe(0);
      await Promise.resolve();
      inFlight--;
      return { pixels: new Float32Array(9).fill(-7) };
    });
    const volume = await assembleNativeVolume(plan, read);
    expect(read).toHaveBeenCalledTimes(3);
    expect(volume.supportedVoxelCount).toBe(27);
    for (const slice of [1, 3])
      expect(volume.observedSupport!.slice(slice * 9, (slice + 1) * 9).some(Boolean)).toBe(false);
    expect(volume.intensityRange).toEqual([-7, -6]);
    const roi = planNativeVolume(
      stack({ dims: [3, 3, 30], spacing: [1, 1, 1], origin: [0, 0, 0] }),
      { roi: { mode: 'cube', sourcePlane: 'axial', boundsMm: { min: [0, 0, 13], max: [2, 2, 15] } } },
      { decodedCacheBytes: 0 },
    );
    read.mockClear();
    await assembleNativeVolume(roi, read);
    expect(read).toHaveBeenCalledTimes(5);
  });

  it('rejects inconsistent native geometry and honors cancellation without publishing a volume', async () => {
    const manifest = stack({ spacing: [1, 1, 1], origin: [0, 0, 0] });
    manifest.frames[1]!.imagePositionPatient = '0\\0\\2.4';
    expect(() => planNativeVolume(manifest, {})).toThrow(/coherent regular native grid/);
    const controller = new AbortController();
    const read = vi.fn(async (frame: SeriesFrameManifest['frames'][number]) => {
      controller.abort();
      return { pixels: new Int16Array(frame.rows * frame.columns) };
    });
    await expect(
      assembleNativeVolume(planNativeVolume(stack(), {}), read, { signal: controller.signal }),
    ).rejects.toThrow(/cancelled/i);
    expect(read).toHaveBeenCalledOnce();
  });

  it('cancels an unresolved decode promptly and permits another assembly without publishing the canceled volume', async () => {
    const plan = planNativeVolume(stack(), {}, { decodedCacheBytes: 0 });
    const controller = new AbortController();
    const read = vi.fn(async (frame: SeriesFrameManifest['frames'][number]) => ({
      pixels: new Int16Array(frame.rows * frame.columns).fill(-9),
    }));
    read.mockImplementationOnce(() => new Promise(() => {}));
    const publish = vi.fn();
    const pending = assembleNativeVolume(plan, read, { signal: controller.signal }).then(publish);
    const rejected = expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    expect(read).toHaveBeenCalledOnce();
    controller.abort();
    await rejected;
    const retry = await assembleNativeVolume(plan, read);
    expect(retry.supportedVoxelCount).toBe(120);
    expect(retry.data.every((value) => value === -9)).toBe(true);
    expect(read).toHaveBeenCalledTimes(1 + plan.frames.length);
    expect(publish).not.toHaveBeenCalled();
  });
});
