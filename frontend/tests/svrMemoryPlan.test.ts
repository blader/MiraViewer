import { describe, expect, it } from 'vitest';
import {
  estimateSvrPeakMemoryBytes,
  estimateSvrRegistrationBytes,
  SVR_MEMORY_BUDGET_BYTES,
} from '../src/utils/svr/svrMemoryPlan';

describe('svr/shared memory admission', () => {
  it('counts source frames, solver scratch, acquired support, and GPU presentation once', () => {
    const plan = estimateSvrPeakMemoryBytes({ voxelCount: 100, sourceBytes: 500, iterations: 3 });

    expect(plan).toEqual({
      sourceBytes: 500,
      solverBytes: 1_200,
      supportBytes: 100,
      displayBytes: 500,
      retainedBytes: 0,
      labelBytes: 0,
      registrationBytes: 0,
      modelTensorBytes: 0,
      totalBytes: 2_300,
    });
  });

  it('removes refinement scratch only when reconstruction has no iterations', () => {
    const coarse = estimateSvrPeakMemoryBytes({ voxelCount: 10, sourceBytes: 0, iterations: 0 });
    const refined = estimateSvrPeakMemoryBytes({ voxelCount: 10, sourceBytes: 0, iterations: 1 });

    expect(coarse.solverBytes).toBe(80);
    expect(refined.solverBytes).toBe(120);
    expect(SVR_MEMORY_BUDGET_BYTES).toBe(512 * 1024 * 1024);
  });

  it('rejects a formerly admitted reconstruction when its displayed prior result remains resident', () => {
    const voxelCount = 256 ** 3;
    const sourceBytes = 150 * 1024 * 1024;
    const previousVolumeSupportDisplayAndLabelsBytes = voxelCount * 9;

    const withoutRetainedResult = estimateSvrPeakMemoryBytes({ voxelCount, sourceBytes, iterations: 1 });
    const withRetainedResult = estimateSvrPeakMemoryBytes({
      voxelCount,
      sourceBytes,
      iterations: 1,
      retainedBytes: previousVolumeSupportDisplayAndLabelsBytes,
    });

    expect(withoutRetainedResult.totalBytes).toBe(438 * 1024 * 1024);
    expect(withoutRetainedResult.totalBytes).toBeLessThan(SVR_MEMORY_BUDGET_BYTES);
    expect(withRetainedResult.totalBytes).toBe(582 * 1024 * 1024);
    expect(withRetainedResult.totalBytes).toBeGreaterThan(SVR_MEMORY_BUDGET_BYTES);
  });

  it('rejects a formerly admitted reconstruction when its independent decoded-frame cache remains resident', () => {
    const voxelCount = 256 ** 3;
    const sourceBytes = 150 * 1024 * 1024;
    const residentCacheBytes = 80 * 1024 * 1024;
    const withoutCache = estimateSvrPeakMemoryBytes({ voxelCount, sourceBytes, iterations: 1 });
    const withCache = estimateSvrPeakMemoryBytes({
      voxelCount,
      sourceBytes,
      iterations: 1,
      retainedBytes: residentCacheBytes,
    });

    expect(withoutCache.totalBytes).toBe(438 * 1024 * 1024);
    expect(withCache.totalBytes).toBe(518 * 1024 * 1024);
    expect(withoutCache.totalBytes).toBeLessThan(SVR_MEMORY_BUDGET_BYTES);
    expect(withCache.totalBytes).toBeGreaterThan(SVR_MEMORY_BUDGET_BYTES);
  });

  it('bounds registration volumes and sample vectors to the exact simultaneous score-grid owners', () => {
    const maximumSampleBytes = 2 * 40_000 * 5 * Float32Array.BYTES_PER_ELEMENT;

    expect(estimateSvrRegistrationBytes(100)).toBe(100 * 14 + maximumSampleBytes);
    expect(estimateSvrRegistrationBytes(320 ** 3)).toBe(160 ** 3 * 14 + maximumSampleBytes);
    expect(estimateSvrRegistrationBytes(320 ** 3, 256)).toBe(256 ** 3 * 14 + maximumSampleBytes);
    expect(estimateSvrRegistrationBytes(-1)).toBe(0);
    expect(estimateSvrRegistrationBytes(Number.NaN)).toBe(0);
  });

  it('rejects a formerly admitted reconstruction when ROI-rigid score volumes remain unaccounted', () => {
    const voxelCount = 256 ** 3;
    const sourceBytes = 170 * 1024 * 1024;
    const withoutRegistration = estimateSvrPeakMemoryBytes({ voxelCount, sourceBytes, iterations: 1 });
    const withRegistration = estimateSvrPeakMemoryBytes({
      voxelCount,
      sourceBytes,
      iterations: 1,
      registrationBytes: estimateSvrRegistrationBytes(voxelCount),
    });

    expect(withoutRegistration.totalBytes).toBe(458 * 1024 * 1024);
    expect(withoutRegistration.totalBytes).toBeLessThan(SVR_MEMORY_BUDGET_BYTES);
    expect(withRegistration.registrationBytes).toBe(160 ** 3 * 14 + 1_600_000);
    expect(withRegistration.totalBytes).toBeGreaterThan(SVR_MEMORY_BUDGET_BYTES);
  });

  it('counts only the accepted Float32 volume during inference, never released reconstruction scratch', () => {
    const inference = estimateSvrPeakMemoryBytes({
      voxelCount: 100,
      sourceBytes: 0,
      iterations: 4,
      phase: 'inference',
      labelBytes: 200,
      modelTensorBytes: 2_000,
    });

    expect(inference.solverBytes).toBe(400);
    expect(inference.labelBytes).toBe(200);
    expect(inference.modelTensorBytes).toBe(2_000);
    expect(inference.totalBytes).toBe(3_200);
  });

  it('blocks inference when existing and replacement label buffers overlap beyond the budget', () => {
    const voxelCount = 257 ** 3;
    const modelTensorBytes = voxelCount * (Float32Array.BYTES_PER_ELEMENT + 4 * Float32Array.BYTES_PER_ELEMENT);
    const withoutExistingLabels = estimateSvrPeakMemoryBytes({
      voxelCount,
      sourceBytes: 0,
      iterations: 0,
      phase: 'inference',
      labelBytes: voxelCount,
      modelTensorBytes,
    });
    const withExistingAndReplacementLabels = estimateSvrPeakMemoryBytes({
      voxelCount,
      sourceBytes: 0,
      iterations: 0,
      phase: 'inference',
      labelBytes: 2 * voxelCount,
      modelTensorBytes,
    });

    expect(withoutExistingLabels.totalBytes).toBeLessThan(SVR_MEMORY_BUDGET_BYTES);
    expect(withExistingAndReplacementLabels.totalBytes).toBeGreaterThan(SVR_MEMORY_BUDGET_BYTES);
  });

  it('counts every independent registration and presentation owner exactly once', () => {
    const plan = estimateSvrPeakMemoryBytes({
      voxelCount: 10,
      sourceBytes: 20,
      iterations: 1,
      retainedBytes: 30,
      labelBytes: 40,
      registrationBytes: 50,
      modelTensorBytes: 60,
    });

    expect(plan).toEqual({
      sourceBytes: 20,
      solverBytes: 120,
      supportBytes: 10,
      displayBytes: 50,
      retainedBytes: 30,
      labelBytes: 40,
      registrationBytes: 50,
      modelTensorBytes: 60,
      totalBytes: 380,
    });
  });

  it('rounds optional ownership upward and rejects negative or nonfinite estimates', () => {
    const plan = estimateSvrPeakMemoryBytes({
      voxelCount: 0,
      sourceBytes: 0,
      iterations: 0,
      retainedBytes: 1.25,
      labelBytes: -100,
      registrationBytes: Number.NaN,
      modelTensorBytes: Number.POSITIVE_INFINITY,
    });

    expect(plan.retainedBytes).toBe(2);
    expect(plan.labelBytes).toBe(0);
    expect(plan.registrationBytes).toBe(0);
    expect(plan.modelTensorBytes).toBe(0);
    expect(plan.totalBytes).toBe(2);
  });
});
