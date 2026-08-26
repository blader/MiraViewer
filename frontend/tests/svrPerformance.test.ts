import { describe, expect, it } from 'vitest';
import {
  applyRigidToPoint,
  mat3FromEulerXYZ,
  scoreNcc,
  type RigidParams,
  type SeriesSamples,
} from '../src/utils/svr/rigidRegistration';
import { reconstructVolumeFromSlices, type SvrReconstructionSlice } from '../src/utils/svr/reconstructionCore';
import { sampleTrilinear, type VolumeDims } from '../src/utils/svr/trilinear';
import { v3 } from '../src/utils/svr/vec3';

const SAMPLE_COUNT = 40_000;

function median(values: readonly number[]): number {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.floor(sorted.length / 2)] ?? 0;
}

function makeSingleSamplePsfSlices(size: number, slicesPerOrientation?: number): SvrReconstructionSlice[] {
  const slices: SvrReconstructionSlice[] = [];
  const positions = slicesPerOrientation
    ? Array.from({ length: slicesPerOrientation }, (_, index) => 2 + (index * (size - 4)) / (slicesPerOrientation - 1))
    : Array.from({ length: Math.ceil((size - 3) / 3) }, (_, index) => 2 + index * 3);
  for (const plane of ['axial', 'coronal', 'sagittal'] as const) {
    for (const position of positions) {
      const pixels = new Float32Array(size * size);
      for (let row = 0; row < size; row++) {
        for (let column = 0; column < size; column++) {
          const x = plane === 'sagittal' ? position : column;
          const y = plane === 'axial' ? row : plane === 'coronal' ? position : column;
          const z = plane === 'axial' ? position : row;
          const sourceBias = plane === 'axial' ? 0.012 : plane === 'coronal' ? -0.01 : 0;
          pixels[row * size + column] = 0.2 + (0.6 * (x + 2 * y + 3 * z)) / (6 * (size - 1)) + sourceBias;
        }
      }

      const axial = plane === 'axial';
      const coronal = plane === 'coronal';
      slices.push({
        pixels,
        valid: new Uint8Array(pixels.length).fill(255),
        validScale: 255,
        dsRows: size,
        dsCols: size,
        ippMm: axial ? v3(0, 0, position) : coronal ? v3(0, position, 0) : v3(position, 0, 0),
        rowDir: plane === 'sagittal' ? v3(0, 1, 0) : v3(1, 0, 0),
        colDir: axial ? v3(0, 1, 0) : v3(0, 0, 1),
        normalDir: axial ? v3(0, 0, 1) : coronal ? v3(0, -1, 0) : v3(1, 0, 0),
        rowSpacingDsMm: 1,
        colSpacingDsMm: 1,
        sliceThicknessMm: 0.8,
        spacingBetweenSlicesMm: 3,
      });
    }
  }
  return slices;
}

/** Independent copy of the allocation-heavy scorer replaced by scalar transforms. */
function scoreWithTemporaryVectors(params: {
  samples: SeriesSamples;
  volume: Float32Array;
  support: Uint8Array;
  dims: VolumeDims;
  rigid: RigidParams;
}): number {
  const { samples, volume, support, dims, rigid } = params;
  const rotation = mat3FromEulerXYZ(rigid.rx, rigid.ry, rigid.rz);
  const center = v3(32, 32, 32);
  const translation = v3(rigid.tx, rigid.ty, rigid.tz);
  let sumA = 0;
  let sumB = 0;
  let sumAA = 0;
  let sumBB = 0;
  let sumAB = 0;
  let used = 0;

  for (let index = 0; index < samples.count; index++) {
    const intensity = samples.obs[index] ?? 0;
    const point = applyRigidToPoint(
      v3(samples.pos[index * 3] ?? 0, samples.pos[index * 3 + 1] ?? 0, samples.pos[index * 3 + 2] ?? 0),
      center,
      rotation,
      translation,
    );
    if (
      point.x < 0 ||
      point.y < 0 ||
      point.z < 0 ||
      point.x > dims.nx - 1 ||
      point.y > dims.ny - 1 ||
      point.z > dims.nz - 1 ||
      sampleTrilinear(support, dims, point.x, point.y, point.z) < 0.5
    ) {
      continue;
    }

    const predicted = sampleTrilinear(volume, dims, point.x, point.y, point.z);
    sumA += intensity;
    sumB += predicted;
    sumAA += intensity * intensity;
    sumBB += predicted * predicted;
    sumAB += intensity * predicted;
    used++;
  }

  const inverseCount = 1 / used;
  const covariance = sumAB - sumA * sumB * inverseCount;
  const varianceA = sumAA - sumA * sumA * inverseCount;
  const varianceB = sumBB - sumB * sumB * inverseCount;
  return (covariance / Math.sqrt(varianceA * varianceB)) * (used / samples.count);
}

describe('svr/registration performance', () => {
  it('preserves the former 40,000-sample rigid score while eliminating per-sample vectors', () => {
    const dims = { nx: 64, ny: 64, nz: 64 };
    const volume = new Float32Array(dims.nx * dims.ny * dims.nz);
    const support = new Uint8Array(volume.length).fill(1);

    for (let z = 0; z < dims.nz; z++) {
      for (let y = 0; y < dims.ny; y++) {
        for (let x = 0; x < dims.nx; x++) {
          volume[x + y * dims.nx + z * dims.nx * dims.ny] =
            Math.sin(x * 0.19 + y * 0.03) + Math.cos(y * 0.13 - z * 0.07) + Math.sin(z * 0.11);
        }
      }
    }

    const observations = new Float32Array(SAMPLE_COUNT);
    const positions = new Float32Array(SAMPLE_COUNT * 3);
    for (let index = 0; index < SAMPLE_COUNT; index++) {
      const x = 4 + (index % 55);
      const y = 4 + (Math.floor(index / 55) % 55);
      const z = 4 + (Math.floor(index / (55 * 55)) % 55);
      observations[index] = sampleTrilinear(volume, dims, x + 0.25, y - 0.15, z + 0.1);
      positions[index * 3] = x;
      positions[index * 3 + 1] = y;
      positions[index * 3 + 2] = z;
    }

    const samples = { obs: observations, pos: positions, count: SAMPLE_COUNT };
    const rigid = { tx: 0.25, ty: -0.15, tz: 0.1, rx: 0.01, ry: -0.008, rz: 0.004 };
    const optimized = () =>
      scoreNcc({
        samples,
        refVolume: volume,
        occupancy: support,
        dims,
        originMm: v3(0, 0, 0),
        voxelSizeMm: 1,
        centerMm: v3(32, 32, 32),
        rigid,
      }).ncc;
    const former = () => scoreWithTemporaryVectors({ samples, volume, support, dims, rigid });

    expect(optimized()).toBeCloseTo(former(), 12);

    const optimizedTimes: number[] = [];
    const formerTimes: number[] = [];
    for (let iteration = 0; iteration < 25; iteration++) {
      const optimizedStart = performance.now();
      optimized();
      optimizedTimes.push(performance.now() - optimizedStart);

      const formerStart = performance.now();
      former();
      formerTimes.push(performance.now() - formerStart);
    }

    const optimizedMedianMilliseconds = median(optimizedTimes);
    const formerMedianMilliseconds = median(formerTimes);
    expect(optimizedMedianMilliseconds).toBeGreaterThanOrEqual(0);
    expect(formerMedianMilliseconds).toBeGreaterThanOrEqual(0);

    if (process.env.MIRAVIEWER_SVR_BENCHMARK === '1') {
      console.info(
        '[svr-benchmark]',
        JSON.stringify({
          sampleCount: SAMPLE_COUNT,
          repetitions: optimizedTimes.length,
          optimizedMedianMilliseconds: Number(optimizedMedianMilliseconds.toFixed(3)),
          formerMedianMilliseconds: Number(formerMedianMilliseconds.toFixed(3)),
          speedup: Number((formerMedianMilliseconds / Math.max(0.001, optimizedMedianMilliseconds)).toFixed(2)),
        }),
      );
    }
  });

  it('reconstructs representative three-orientation thin-slice MRI without inventing anatomy', async () => {
    const largeBenchmark = process.env.MIRAVIEWER_SVR_BENCHMARK_LARGE === '1';
    const size = largeBenchmark ? 128 : 64;
    const dims = { nx: size, ny: size, nz: size };
    const slices = makeSingleSamplePsfSlices(size, largeBenchmark ? 234 : undefined);
    const timings: number[] = [];
    let supportedVoxels = 0;
    let unsupportedNonzeroVoxels = 0;

    for (let iteration = 0; iteration < (largeBenchmark ? 2 : 6); iteration++) {
      const support = new Uint8Array(size ** 3);
      const started = performance.now();
      const volume = await reconstructVolumeFromSlices({
        slices,
        grid: { dims, originMm: v3(0, 0, 0), voxelSizeMm: 1 },
        occupancy: support,
        options: {
          iterations: 2,
          stepSize: 0.6,
          clampOutput: true,
          psfMode: 'gaussian',
          robustLoss: 'huber',
          robustDelta: 0.1,
          laplacianWeight: 0.02,
        },
      });
      if (iteration > 0) timings.push(performance.now() - started);

      if (iteration === 0) {
        for (let index = 0; index < volume.length; index++) {
          if (support[index]) supportedVoxels++;
          else if (volume[index] !== 0) unsupportedNonzeroVoxels++;
        }
      }
    }

    expect(supportedVoxels).toBeGreaterThan(0);
    expect(supportedVoxels).toBeLessThan(size ** 3);
    expect(unsupportedNonzeroVoxels).toBe(0);

    if (process.env.MIRAVIEWER_SVR_BENCHMARK === '1') {
      console.info(
        '[svr-solver-benchmark]',
        JSON.stringify({
          orientations: 3,
          slices: slices.length,
          observations: slices.length * size ** 2,
          iterations: 2,
          outputVoxels: size ** 3,
          supportedVoxels,
          repetitions: timings.length,
          medianMilliseconds: Number(median(timings).toFixed(3)),
        }),
      );
    }
  }, 30_000);
});
