import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SvrVolume } from '../src/types/svr';
import {
  enhanceVolume2x,
  extractHighOrderPatchFeatures,
  SR_HIGH_ORDER_FEATURES,
} from '../src/utils/svr/superResolution';
import { runSuperResolution } from '../src/utils/svr/superResolutionWorker';
import { physicalVolumeBounds, volumeVoxelToPatient } from '../src/utils/svr/volumeGeometry';
import type { SvrEnhancedVolume, SvrSuperResolutionWorkerResponse } from '../src/utils/svr/superResolutionTypes';

function phantom(phase = 0.31): SvrVolume {
  const dims: [number, number, number] = [32, 32, 32];
  const volume: SvrVolume = {
    data: Float32Array.from({ length: 32 ** 3 }, (_, index) => {
      const x = index % 32,
        y = Math.floor(index / 32) % 32,
        z = Math.floor(index / (32 * 32));
      return (
        -120 +
        73 * Math.sin((x + phase) * 0.53) +
        37 * Math.cos((y - phase) * 0.37) +
        51 * Math.sin((z + 0.5 * phase) * 0.47) +
        21 * Math.sin((x + y + z) * 0.19)
      );
    }),
    dims,
    voxelSizeMm: [0.6, 0.4296875, 0.4296875],
    originMm: [12, -23, 8],
    direction: [Math.cos(0.3), -Math.sin(0.3), 0, Math.sin(0.3), Math.cos(0.3), 0, 0, 0, 1],
    observedSupport: new Uint8Array(32 ** 3).fill(1),
    intensityRange: [-320, 80],
    displayWindow: [-80, -20],
    displayInvert: true,
    boundsMm: { min: [0, 0, 0], max: [1, 1, 1] },
  };
  volume.boundsMm = physicalVolumeBounds(volume);
  return volume;
}

function partition(x: number, y: number, z: number) {
  const block = (Math.floor(z / 16) * 2 + Math.floor(y / 16)) * 2 + Math.floor(x / 16);
  return block % 5;
}

function children(
  volume: { data: ArrayLike<number>; dims: SvrVolume['dims'] },
  x: number,
  y: number,
  z: number,
): number[] {
  return Array.from(
    { length: 8 },
    (_, child) =>
      volume.data[
        ((2 * z + (child >> 2)) * volume.dims[1] + 2 * y + ((child >> 1) & 1)) * volume.dims[0] + 2 * x + (child & 1)
      ]!,
  );
}

function interpolationBaseline(volume: SvrVolume, x: number, y: number, z: number): number[] {
  const values = Array.from({ length: 8 }, (_, child) => {
    const point = [x + (child & 1 ? 0.25 : -0.25), y + (child & 2 ? 0.25 : -0.25), z + (child & 4 ? 0.25 : -0.25)];
    const base = point.map(Math.floor),
      t = point.map((value, axis) => value - base[axis]!);
    let value = 0;
    for (let iz = 0; iz < 2; iz++)
      for (let iy = 0; iy < 2; iy++)
        for (let ix = 0; ix < 2; ix++) {
          const px = Math.max(0, Math.min(volume.dims[0] - 1, base[0]! + ix));
          const py = Math.max(0, Math.min(volume.dims[1] - 1, base[1]! + iy));
          const pz = Math.max(0, Math.min(volume.dims[2] - 1, base[2]! + iz));
          value +=
            volume.data[(pz * volume.dims[1] + py) * volume.dims[0] + px]! *
            (ix ? t[0]! : 1 - t[0]!) *
            (iy ? t[1]! : 1 - t[1]!) *
            (iz ? t[2]! : 1 - t[2]!);
        }
    return value;
  });
  const mean = values.reduce((sum, value) => sum + value, 0) / 8;
  return values.map((value) => value + volume.data[(z * volume.dims[1] + y) * volume.dims[0] + x]! - mean);
}

async function evaluateFineOracle(field: (x: number, y: number, z: number) => number) {
  const input = phantom();
  const truth = Float32Array.from({ length: 64 ** 3 }, (_, index) =>
    field(
      ((index % 64) + 0.5) / 2 - 0.5,
      ((Math.floor(index / 64) % 64) + 0.5) / 2 - 0.5,
      (Math.floor(index / 4096) + 0.5) / 2 - 0.5,
    ),
  );
  for (let z = 0; z < 32; z++)
    for (let y = 0; y < 32; y++)
      for (let x = 0; x < 32; x++)
        input.data[(z * 32 + y) * 32 + x] =
          children({ data: truth, dims: [64, 64, 64] }, x, y, z).reduce((sum, value) => sum + value, 0) / 8;
  const result = await enhanceVolume2x(input);
  let baselineMse = 0,
    enhancedMse = 0,
    count = 0;
  for (let z = 2; z < 30; z++)
    for (let y = 2; y < 30; y++)
      for (let x = 2; x < 30; x++) {
        const known = children({ data: truth, dims: [64, 64, 64] }, x, y, z),
          baseline = interpolationBaseline(input, x, y, z),
          enhanced = children(result, x, y, z);
        for (let child = 0; child < 8; child++) {
          baselineMse += (baseline[child]! - known[child]!) ** 2;
          enhancedMse += (enhanced[child]! - known[child]!) ** 2;
          count++;
        }
      }
  let measuredSourceMeanMaxError = 0;
  for (let z = 0; z < 32; z++)
    for (let y = 0; y < 32; y++)
      for (let x = 0; x < 32; x++) {
        const mean = children(result, x, y, z).reduce((sum, value) => sum + value, 0) / 8;
        measuredSourceMeanMaxError = Math.max(
          measuredSourceMeanMaxError,
          Math.abs(mean - input.data[(z * 32 + y) * 32 + x]!),
        );
      }
  return {
    samples: count,
    ...result.stats,
    fineBaselineMse: baselineMse / count,
    fineEnhancedMse: enhancedMse / count,
    allOutputFinite: result.data.every(Number.isFinite),
    measuredSourceMeanMaxError,
  };
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('within-volume learned 2x detail', () => {
  it('annihilates all constant, gradient and quadratic terms instead of learning a scale-specific sharpening gain', () => {
    const data = Float32Array.from({ length: 9 ** 3 }, (_, index) => {
      const x = index % 9,
        y = Math.floor(index / 9) % 9,
        z = Math.floor(index / 81);
      return (
        100 +
        2 * x -
        3 * y +
        4 * z +
        0.5 * x * x -
        0.25 * y * y +
        1.5 * z * z +
        0.125 * x * y +
        0.375 * x * z -
        0.5 * y * z
      );
    });
    const features = new Float64Array(SR_HIGH_ORDER_FEATURES),
      descriptor = new Float64Array(6);
    const scale = extractHighOrderPatchFeatures({ data, dims: [9, 9, 9] }, 4, 4, 4, features, descriptor);
    expect(scale).toBeGreaterThan(0);
    expect(descriptor.some((value) => Math.abs(value) > 0.01)).toBe(true);
    expect(Math.max(...features.map(Math.abs))).toBeLessThan(1e-12);
  });
  it.each([0.31, 1.17])(
    'learns detail that improves spatially held-out texture over its interpolation baseline (%s)',
    async (phase) => {
      const input = phantom(phase);
      const before = input.data.slice();
      const result = await enhanceVolume2x(input);
      expect(result.stats.trainingSamples).toBeGreaterThanOrEqual(128);
      expect(result.stats.calibrationSamples).toBeGreaterThanOrEqual(32);
      expect(result.stats.heldOutSamples).toBeGreaterThanOrEqual(32);
      expect(result.stats.trainingBlocks).toBeGreaterThanOrEqual(2);
      expect(result.stats.calibrationBlocks).toBeGreaterThanOrEqual(2);
      expect(result.stats.heldOutBlocks).toBeGreaterThanOrEqual(2);
      expect(result.stats.baselineMse).toBeGreaterThan(0);
      expect(result.stats.enhancedMse).toBeLessThan(result.stats.baselineMse);
      expect(result.stats.modelStrength).toBeGreaterThanOrEqual(0.25);
      expect(result.stats.modelStrength).toBeLessThanOrEqual(1);
      expect(result.stats.consistencyMaxError).toBeLessThan(0.00001);
      expect(input.data).toEqual(before);
      expect(result.data).not.toBe(input.data);
      if (process.env.SVR_SR_DIAGNOSTICS) console.info('SR held-out texture', { phase, ...result.stats });
    },
  );

  it.each([0.31, 1.17])(
    'improves an independent known fine-grid oracle, not only the downsampled validation proxy (%s)',
    async (phase) => {
      const metrics = await evaluateFineOracle(
        (x, y, z) =>
          -120 +
          73 * Math.sin((x + phase) * 0.53) +
          37 * Math.cos((y - phase) * 0.37) +
          51 * Math.sin((z + 0.5 * phase) * 0.47) +
          21 * Math.sin((x + y + z) * 0.19),
      );
      expect(metrics.fineEnhancedMse).toBeLessThan(metrics.fineBaselineMse);
      if (process.env.SVR_SR_DIAGNOSTICS)
        console.info('SR known fine-grid oracle', {
          phase,
          samples: metrics.samples,
          baselineMse: metrics.fineBaselineMse,
          enhancedMse: metrics.fineEnhancedMse,
          durationMs: metrics.durationMs,
        });
    },
  );

  it('really learns from training targets and reports a harmful learned prior instead of disguising it as validated detail', async () => {
    const input = phantom(),
      contaminatedTraining = phantom();
    for (let z = 0; z < 32; z++)
      for (let y = 0; y < 32; y++)
        for (let x = 0; x < 32; x++)
          if (partition(x, y, z) > 1) contaminatedTraining.data[(z * 32 + y) * 32 + x] += x % 2 ? 40 : -40;
    const a = await enhanceVolume2x(input),
      b = await enhanceVolume2x(contaminatedTraining);
    expect(b.stats.enhancedMse).toBeGreaterThan(b.stats.baselineMse);
    expect(b.stats.modelStrength).toBeGreaterThanOrEqual(0.25);
    let inferredDifference = 0;
    for (let z = 2; z < 30; z++)
      for (let y = 2; y < 30; y++)
        for (let x = 2; x < 30; x++)
          if (
            partition(x, y, z) === 1 &&
            x % 16 > 2 &&
            x % 16 < 13 &&
            y % 16 > 2 &&
            y % 16 < 13 &&
            z % 16 > 2 &&
            z % 16 < 13
          ) {
            expect(contaminatedTraining.data[(z * 32 + y) * 32 + x]).toBe(input.data[(z * 32 + y) * 32 + x]);
            const originalModel = children(a, x, y, z),
              alteredModel = children(b, x, y, z);
            inferredDifference += originalModel.reduce(
              (sum, value, child) => sum + Math.abs(value - alteredModel[child]!),
              0,
            );
          }
    expect(inferredDifference).toBeGreaterThan(1);
  });

  it.each([
    {
      name: 'smooth asymmetric blobs',
      field: (x: number, y: number, z: number) =>
        -130 +
        180 * Math.exp(-((x - 17.2) ** 2 / 50 + (y - 15.4) ** 2 / 38 + (z - 13.7) ** 2 / 30)) -
        70 * Math.exp(-((x - 9.3) ** 2 / 32 + (y - 10.8) ** 2 / 40 + (z - 19.1) ** 2 / 26)) +
        10 * Math.sin(0.11 * x + 0.07 * y + 0.13 * z),
    },
    {
      name: 'oblique soft edge',
      field: (x: number, y: number, z: number) =>
        -200 +
        180 / (1 + Math.exp(-(x + 0.35 * y - 0.18 * z - 18.4) / 1.4)) +
        12 * Math.sin(0.17 * x + 0.13 * y + 0.19 * z),
    },
    {
      name: 'spatially varying chirp',
      field: (x: number, y: number, z: number) =>
        -130 +
        80 * Math.sin(0.1 * x + 0.009 * x * x + 0.1 * z) +
        30 * Math.cos(0.29 * y - 0.0015 * y * y) +
        10 * Math.sin(0.27 * (x + y)),
    },
  ])('checks a disjoint known fine-grid family: $name', async ({ name, field }) => {
    const metrics = await evaluateFineOracle(field);
    if (process.env.SVR_SR_DIAGNOSTICS) console.info('SR disjoint fine-grid family', { name, ...metrics });
    expect(metrics.fineEnhancedMse).toBeLessThan(metrics.fineBaselineMse);
    expect(metrics.consistencyMaxError).toBeLessThan(0.00001);
  });

  it('improves sharp oblique edge intensities while preserving finite values and every source-cell mean', async () => {
    const metrics = await evaluateFineOracle(
      (x, y, z) =>
        -200 +
        180 / (1 + Math.exp(-(x + 0.35 * y - 0.18 * z - 18.4) / 0.15)) +
        12 * Math.sin(0.17 * x + 0.13 * y + 0.19 * z),
    );
    if (process.env.SVR_SR_DIAGNOSTICS) console.info('SR sharp oblique fine-grid edge', metrics);
    // The oracle uses exact 2³ fine-grid means, not analytic values at native centers.
    // Lower voxel MSE does not promise uniformly better derivatives: this sharp edge
    // can have greater weak-axis third-difference error than ordinary trilinear interpolation.
    expect(metrics.fineEnhancedMse).toBeLessThan(metrics.fineBaselineMse);
    expect(metrics.allOutputFinite).toBe(true);
    expect(metrics.measuredSourceMeanMaxError).toBeLessThan(0.00001);
    expect(metrics.consistencyMaxError).toBeLessThan(0.00001);
  });

  it('cannot recover a fine-grid pattern that has two opposite explanations with exactly the same source data', async () => {
    const input = phantom();
    input.data = input.data.map((value) => Math.round(value) + 0);
    const result = await enhanceVolume2x(input);
    let firstMse = 0,
      oppositeMse = 0,
      count = 0;
    for (let z = 2; z < 30; z += 3)
      for (let y = 2; y < 30; y += 3)
        for (let x = 2; x < 30; x += 3) {
          const center = input.data[(z * 32 + y) * 32 + x]!;
          const first = Array.from({ length: 8 }, (_, child) => center + (child & 1 ? 32 : -32));
          const opposite = Array.from({ length: 8 }, (_, child) => center - (child & 1 ? 32 : -32));
          expect(first.reduce((sum, value) => sum + value, 0) / 8).toBe(center);
          expect(opposite.reduce((sum, value) => sum + value, 0) / 8).toBe(center);
          const inferred = children(result, x, y, z);
          for (let child = 0; child < 8; child++) {
            firstMse += (inferred[child]! - first[child]!) ** 2;
            oppositeMse += (inferred[child]! - opposite[child]!) ** 2;
            count++;
          }
        }
    expect(Math.max(firstMse, oppositeMse) / count).toBeGreaterThanOrEqual(32 ** 2);
    expect(result.stats.consistencyMaxError).toBeLessThan(0.00001);
  });

  it('preserves source-cell means, raw signed units, categorical validity and the full oblique physical field of view', async () => {
    const input = phantom();
    const unsupported = (16 * 32 + 16) * 32 + 16;
    input.observedSupport![unsupported] = 0;
    input.data[unsupported] = NaN;
    const before = {
      data: input.data.slice(),
      support: input.observedSupport!.slice(),
      geometry: JSON.stringify({ ...input, data: null, observedSupport: null }),
    };
    const result = await enhanceVolume2x(input);
    expect(result.dims).toEqual([64, 64, 64]);
    expect(result.voxelSizeMm).toEqual(input.voxelSizeMm.map((pitch) => pitch / 2));
    expect(result.direction).toEqual(input.direction);
    expect(result.originMm).toEqual(volumeVoxelToPatient(input, [-0.25, -0.25, -0.25]));
    expect(result.boundsMm).toEqual(input.boundsMm);
    const bounds = physicalVolumeBounds(result);
    for (const side of ['min', 'max'] as const)
      bounds[side].forEach((value, axis) => expect(value).toBeCloseTo(input.boundsMm[side][axis]!, 10));
    expect(result.displayWindow).toEqual(input.displayWindow);
    expect(result.intensityRange).toEqual(input.intensityRange);
    expect(result.displayInvert).toBe(true);
    for (let index = 0; index < input.data.length; index += 113) {
      if (!input.observedSupport![index]) continue;
      const values = children(result, index % 32, Math.floor(index / 32) % 32, Math.floor(index / 1024));
      expect(values.reduce((sum, value) => sum + value, 0) / 8).toBeCloseTo(input.data[index]!, 5);
    }
    expect(children(result, 16, 16, 16)).toEqual(Array(8).fill(0));
    expect(children({ data: result.observedSupport, dims: result.dims }, 16, 16, 16)).toEqual(Array(8).fill(0));
    expect(input.data).toEqual(before.data);
    expect(input.observedSupport).toEqual(before.support);
    expect(JSON.stringify({ ...input, data: null, observedSupport: null })).toBe(before.geometry);
  });

  it('withheld native targets cannot alter fitting or calibration even when their subvoxel texture changes', async () => {
    const input = phantom(),
      changed = phantom();
    for (let z = 0; z < 32; z++)
      for (let y = 0; y < 32; y++)
        for (let x = 0; x < 32; x++)
          if (partition(x, y, z) === 1) changed.data[(z * 32 + y) * 32 + x] += x % 2 ? 12 : -12;
    const a = await enhanceVolume2x(input),
      b = await enhanceVolume2x(changed);
    expect(b.stats.trainingSamples).toBe(a.stats.trainingSamples);
    expect(b.stats.calibrationSamples).toBe(a.stats.calibrationSamples);
    expect(b.stats.modelStrength).toBe(a.stats.modelStrength);
    expect(b.stats.enhancedMse).not.toBe(a.stats.enhancedMse);
    let checked = 0;
    for (let z = 2; z < 30; z++)
      for (let y = 2; y < 30; y++)
        for (let x = 2; x < 30; x++)
          if (
            partition(x, y, z) > 1 &&
            x % 16 > 2 &&
            x % 16 < 13 &&
            y % 16 > 2 &&
            y % 16 < 13 &&
            z % 16 > 2 &&
            z % 16 < 13
          ) {
            expect(children(b, x, y, z)).toEqual(children(a, x, y, z));
            checked++;
          }
    expect(checked).toBeGreaterThan(100);
  });

  it('is deterministic and independent of display window/inversion', async () => {
    const input = phantom();
    const a = await enhanceVolume2x(input);
    const b = await enhanceVolume2x({ ...input, displayInvert: false, displayWindow: [-300, 30] });
    expect(b.data).toEqual(a.data);
    expect({ ...b.stats, durationMs: 0 }).toEqual({ ...a.stats, durationMs: 0 });
  });

  it('rejects degenerate, malformed and oversized regions without altering source evidence', async () => {
    const input = phantom();
    await expect(enhanceVolume2x({ ...input, dims: [128, 128, 129] })).rejects.toThrow(/memory budget/);
    await expect(enhanceVolume2x({ ...input, voxelSizeMm: [0, 1, 1] })).rejects.toThrow(/geometry/);
    await expect(enhanceVolume2x({ ...input, data: new Float32Array(input.data.length).fill(17) })).rejects.toThrow(
      /too little.*context/,
    );
    const corrupted = input.data.slice();
    corrupted[77] = Infinity;
    await expect(enhanceVolume2x({ ...input, data: corrupted })).rejects.toThrow(/finite acquired/);
  });

  it('cancels before allocation and at a cooperative training boundary', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(enhanceVolume2x(phantom(), { signal: controller.signal })).rejects.toMatchObject({
      name: 'AbortError',
    });
    const during = new AbortController();
    await expect(
      enhanceVolume2x(phantom(), {
        signal: during.signal,
        onProgress: (progress) => {
          if (progress.phase === 'training') during.abort();
        },
      }),
    ).rejects.toMatchObject({ name: 'AbortError' });
  });
});

class MockWorker {
  static instances: MockWorker[] = [];
  onmessage: ((event: MessageEvent<SvrSuperResolutionWorkerResponse>) => void) | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;
  onmessageerror: (() => void) | null = null;
  messages: { volume: SvrVolume; transfer: ArrayBuffer[] }[] = [];
  terminate = vi.fn();
  constructor() {
    MockWorker.instances.push(this);
  }
  postMessage(volume: SvrVolume, transfer: ArrayBuffer[]) {
    this.messages.push({ volume, transfer });
  }
}

function workerResult(input: SvrVolume): SvrEnhancedVolume {
  return {
    ...input,
    data: new Float32Array(input.data.length * 8),
    observedSupport: new Uint8Array(input.data.length * 8).fill(1),
    dims: input.dims.map((size) => size * 2) as SvrVolume['dims'],
    voxelSizeMm: input.voxelSizeMm.map((pitch) => pitch / 2) as SvrVolume['voxelSizeMm'],
    originMm: volumeVoxelToPatient(input, [-0.25, -0.25, -0.25]),
    stats: {
      method: 'Protocol fixture',
      trainingSamples: 256,
      calibrationSamples: 128,
      heldOutSamples: 128,
      trainingBlocks: 4,
      calibrationBlocks: 2,
      heldOutBlocks: 2,
      baselineMse: 2,
      enhancedMse: 1,
      consistencyMaxError: 0,
      durationMs: 10,
      modelStrength: 1,
    },
  };
}

describe('super-resolution worker ownership', () => {
  beforeEach(() => {
    MockWorker.instances = [];
    vi.stubGlobal('Worker', MockWorker);
  });

  it('transfers only dedicated copies and terminates on successful completion', async () => {
    const input = phantom(),
      before = input.data.slice();
    const pending = runSuperResolution(input);
    const worker = MockWorker.instances[0]!;
    expect(worker.messages[0]!.transfer).not.toContain(input.data.buffer);
    expect(worker.messages[0]!.transfer).not.toContain(input.observedSupport!.buffer);
    expect(worker.messages[0]!.volume.data).toEqual(input.data);
    expect(worker.messages[0]!.volume.data.buffer).not.toBe(input.data.buffer);
    const result = workerResult(input);
    worker.onmessage!({ data: { type: 'done', result } } as MessageEvent<SvrSuperResolutionWorkerResponse>);
    await expect(pending).resolves.toBe(result);
    expect(worker.terminate).toHaveBeenCalledOnce();
    expect(input.data.byteLength).toBe(before.byteLength);
    expect(input.data).toEqual(before);
  });

  it('terminates promptly on cancellation, ignores late completion and permits a retry', async () => {
    const controller = new AbortController(),
      input = phantom();
    const publish = vi.fn();
    const pending = runSuperResolution(input, { signal: controller.signal }).then(publish);
    const worker = MockWorker.instances[0]!,
      late = worker.onmessage!;
    const rejected = expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    controller.abort();
    await rejected;
    expect(worker.terminate).toHaveBeenCalledOnce();
    const result = workerResult(input);
    late({ data: { type: 'done', result } } as MessageEvent<SvrSuperResolutionWorkerResponse>);
    expect(publish).not.toHaveBeenCalled();
    const retry = runSuperResolution(input);
    MockWorker.instances[1]!.onmessage!({
      data: { type: 'done', result },
    } as MessageEvent<SvrSuperResolutionWorkerResponse>);
    await expect(retry).resolves.toBe(result);
  });

  it.each([null, undefined, {}, { type: 'unexpected' }, { type: 'done' }, { type: 'done', result: null }])(
    'settles and terminates on malformed worker envelope %j',
    async (message) => {
      vi.useFakeTimers();
      const pending = runSuperResolution(phantom());
      const rejected = expect(pending).rejects.toThrow(/unreadable/);
      const worker = MockWorker.instances[0]!;
      expect(() =>
        worker.onmessage!({ data: message } as unknown as MessageEvent<SvrSuperResolutionWorkerResponse>),
      ).not.toThrow();
      await rejected;
      expect(worker.terminate).toHaveBeenCalledOnce();
      expect(vi.getTimerCount()).toBe(0);
    },
  );

  it.each([
    null,
    { phase: 'wrong', current: 0, total: 1, message: 'Wrong phase' },
    { phase: 'training', current: NaN, total: 1, message: 'Invalid fraction' },
    { phase: 'training', current: 1, total: 0, message: 'Zero denominator' },
    { phase: 'training', current: 2, total: 1, message: 'Out of range' },
  ])('rejects invalid progress before calling the UI %j', async (progress) => {
    vi.useFakeTimers();
    const onProgress = vi.fn(),
      pending = runSuperResolution(phantom(), { onProgress });
    const rejected = expect(pending).rejects.toThrow(/invalid progress/);
    const worker = MockWorker.instances[0]!;
    expect(() =>
      worker.onmessage!({
        data: { type: 'progress', progress },
      } as unknown as MessageEvent<SvrSuperResolutionWorkerResponse>),
    ).not.toThrow();
    await rejected;
    expect(onProgress).not.toHaveBeenCalled();
    expect(worker.terminate).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('turns a throwing progress consumer into one prompt rejection instead of leaking an active worker', async () => {
    vi.useFakeTimers();
    const pending = runSuperResolution(phantom(), {
      onProgress: () => {
        throw new Error('Progress consumer failed');
      },
    });
    const rejected = expect(pending).rejects.toThrow('Progress consumer failed');
    const worker = MockWorker.instances[0]!;
    expect(() =>
      worker.onmessage!({
        data: { type: 'progress', progress: { phase: 'training', current: 1, total: 2, message: 'Training' } },
      } as MessageEvent<SvrSuperResolutionWorkerResponse>),
    ).not.toThrow();
    await rejected;
    expect(worker.terminate).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(['dimensions', 'support', 'origin', 'stats'] as const)(
    'rejects malformed completed %s before publishing to the viewer',
    async (field) => {
      vi.useFakeTimers();
      const input = phantom(),
        result = workerResult(input),
        pending = runSuperResolution(input);
      if (field === 'dimensions') result.dims[0]++;
      if (field === 'support') result.observedSupport = new Uint8Array(1);
      if (field === 'origin') result.originMm[0] += 1;
      if (field === 'stats') result.stats.enhancedMse = NaN;
      const rejected = expect(pending).rejects.toThrow(/unreadable result/);
      MockWorker.instances[0]!.onmessage!({
        data: { type: 'done', result },
      } as MessageEvent<SvrSuperResolutionWorkerResponse>);
      await rejected;
      expect(MockWorker.instances[0]!.terminate).toHaveBeenCalledOnce();
      expect(vi.getTimerCount()).toBe(0);
    },
  );

  it.each(['dimensions', 'support', 'type'] as const)(
    'rejects invalid source %s before constructing a worker or copying pixels',
    async (field) => {
      const input = phantom();
      if (field === 'dimensions') input.dims[0]++;
      if (field === 'support') input.observedSupport = new Uint8Array(input.data.length + 1);
      if (field === 'type') input.data = new Float64Array(input.data.length) as unknown as Float32Array;
      const copyData = vi.spyOn(input.data, 'slice'),
        copySupport = vi.spyOn(input.observedSupport!, 'slice');
      await expect(runSuperResolution(input)).rejects.toThrow(/matching source dimensions and support/);
      expect(MockWorker.instances).toHaveLength(0);
      expect(copyData).not.toHaveBeenCalled();
      expect(copySupport).not.toHaveBeenCalled();
    },
  );

  it('cleans up failed transfers and browser worker faults without touching source data', async () => {
    vi.useFakeTimers();
    const input = phantom();
    vi.spyOn(MockWorker.prototype, 'postMessage').mockImplementationOnce(() => {
      throw new DOMException('Cannot clone input', 'DataCloneError');
    });
    await expect(runSuperResolution(input)).rejects.toThrow('Cannot clone input');
    expect(MockWorker.instances[0]!.terminate).toHaveBeenCalledOnce();
    const pending = runSuperResolution(input),
      rejected = expect(pending).rejects.toThrow(/unreadable data/);
    MockWorker.instances[1]!.onmessageerror!();
    await rejected;
    expect(MockWorker.instances[1]!.terminate).toHaveBeenCalledOnce();
    expect(input.data.byteLength).toBe(32 ** 3 * 4);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('has a bounded timeout and reports missing worker support without running on the UI thread', async () => {
    vi.stubGlobal('Worker', undefined);
    await expect(runSuperResolution(phantom())).rejects.toThrow(/worker support/);
    vi.stubGlobal('Worker', MockWorker);
    vi.useFakeTimers();
    const pending = runSuperResolution(phantom());
    const rejected = expect(pending).rejects.toThrow(/three-minute limit/);
    await vi.advanceTimersByTimeAsync(180_000);
    await rejected;
    expect(MockWorker.instances[0]!.terminate).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });
});
