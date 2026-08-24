import { beforeEach, describe, expect, test, vi } from 'vitest';
import type * as ItkWasm from 'itk-wasm';

const mocks = vi.hoisted(() => ({
  defaultParameterMap: vi.fn(),
  getDefaultWebWorker: vi.fn(),
  runPipeline: vi.fn(),
}));

vi.mock('@itk-wasm/elastix', () => ({
  defaultParameterMap: mocks.defaultParameterMap,
  getDefaultWebWorker: mocks.getDefaultWebWorker,
  setPipelinesBaseUrl: vi.fn(),
  getPipelinesBaseUrl: vi.fn(() => '/pipelines'),
}));

vi.mock('itk-wasm', async (importOriginal) => {
  const actual = await importOriginal<typeof ItkWasm>();
  return {
    ...actual,
    runPipeline: mocks.runPipeline,
    setPipelinesBaseUrl: vi.fn(),
    getPipelinesBaseUrl: vi.fn(() => '/pipelines'),
  };
});

import { registerRigid2DWithElastix } from '../src/utils/elastixRegistration';
import { warpGrayscaleAffine } from '../src/utils/warpAffine';

function createDeferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

describe('registerRigid2DWithElastix', () => {
  beforeEach(() => {
    mocks.defaultParameterMap.mockReset();
    mocks.getDefaultWebWorker.mockReset();
    mocks.runPipeline.mockReset();
  });

  test('requests a three-resolution rigid map and returns a canonical moving-to-fixed transform', async () => {
    const size = 4;
    const pixels = Float32Array.from({ length: size * size }, (_, index) => index / (size * size));
    const worker = { terminate: vi.fn() } as unknown as Worker;

    mocks.defaultParameterMap.mockResolvedValue({
      parameterMap: { Transform: ['EulerTransform'], NumberOfResolutions: ['3'] },
    });
    mocks.runPipeline.mockResolvedValue({
      webWorker: worker,
      returnValue: 0,
      stdout: '',
      stderr: '',
      outputs: [
        { data: { data: pixels } },
        { data: [] },
        {
          data: [
            {
              Transform: ['EulerTransform'],
              TransformParameters: ['0', '0', '0'],
              CenterOfRotationPoint: ['1.5', '1.5'],
            },
          ],
        },
      ],
    });

    const result = await registerRigid2DWithElastix(pixels, pixels, size, { webWorker: worker });

    expect(mocks.defaultParameterMap).toHaveBeenCalledWith('rigid', {
      numberOfResolutions: 3,
      webWorker: worker,
    });
    expect(result.movingToFixed.A.m00).toBeCloseTo(1, 10);
    expect(result.movingToFixed.A.m01).toBeCloseTo(0, 10);
    expect(result.movingToFixed.A.m10).toBeCloseTo(0, 10);
    expect(result.movingToFixed.A.m11).toBeCloseTo(1, 10);
    expect(result.movingToFixed.b.x).toBeCloseTo(0, 10);
    expect(result.movingToFixed.b.y).toBeCloseTo(0, 10);
  });

  test('calibrates anisotropic ITK images in millimeters and converts a physical transform back to viewer pixels', async () => {
    const size = 16;
    const pixels = Float32Array.from({ length: size * size }, (_, index) => ((index * 13) % 251) / 250);
    const resampled = warpGrayscaleAffine(pixels, size, {
      A: { m00: 1, m01: 0, m10: 0, m11: 1 },
      translateX: 2,
      translateY: 2,
    });
    const worker = { terminate: vi.fn() } as unknown as Worker;
    mocks.defaultParameterMap.mockResolvedValue({ parameterMap: { Transform: ['EulerTransform'] } });
    mocks.runPipeline.mockResolvedValue({
      webWorker: worker,
      returnValue: 0,
      stdout: '',
      stderr: '',
      outputs: [
        { data: { data: resampled } },
        { data: [] },
        {
          data: [
            {
              Transform: ['EulerTransform'],
              TransformParameters: ['0', '2', '1'],
              CenterOfRotationPoint: ['7.5', '3.75'],
            },
          ],
        },
      ],
    });

    const result = await registerRigid2DWithElastix(pixels, pixels, size, {
      webWorker: worker,
      fixedPixelSpacing: [0.5, 1],
      movingPixelSpacing: [0.5, 1],
    });

    const pipelineInputs = mocks.runPipeline.mock.calls[0]![3] as Array<{ data?: { spacing?: number[] } }>;
    expect(pipelineInputs[1]?.data?.spacing).toEqual([1, 0.5]);
    expect(pipelineInputs[2]?.data?.spacing).toEqual([1, 0.5]);
    expect(result.movingToFixed.b.x).toBeCloseTo(2, 8);
    expect(result.movingToFixed.b.y).toBeCloseTo(2, 8);
  });

  test('rejects nonpositive physical pixel spacing before invoking the image registration worker', async () => {
    const pixels = new Float32Array(16);
    const worker = { terminate: vi.fn() } as unknown as Worker;

    await expect(
      registerRigid2DWithElastix(pixels, pixels, 4, {
        webWorker: worker,
        fixedPixelSpacing: [0, 1],
      }),
    ).rejects.toThrow(/pixel spacing/i);
    expect(mocks.runPipeline).not.toHaveBeenCalled();
  });

  test('terminates the active worker and rejects promptly when registration is aborted', async () => {
    const size = 4;
    const pixels = new Float32Array(size * size);
    const worker = { terminate: vi.fn() } as unknown as Worker;
    const controller = new AbortController();
    mocks.defaultParameterMap.mockResolvedValue({
      parameterMap: { Transform: ['EulerTransform'], NumberOfResolutions: ['3'] },
    });
    mocks.runPipeline.mockImplementation(() => new Promise(() => undefined));

    const registration = registerRigid2DWithElastix(pixels, pixels, size, {
      webWorker: worker,
      signal: controller.signal,
    });
    await vi.waitFor(() => expect(mocks.runPipeline).toHaveBeenCalled());
    controller.abort();

    await expect(registration).rejects.toThrow(/cancelled/i);
    expect(worker.terminate).toHaveBeenCalledTimes(1);
  });

  test('aborts while a fresh parameter map is still loading', async () => {
    const pixels = new Float32Array(16);
    const worker = { terminate: vi.fn() } as unknown as Worker;
    const controller = new AbortController();
    mocks.defaultParameterMap.mockImplementation(() => new Promise(() => undefined));

    const registration = registerRigid2DWithElastix(pixels, pixels, 4, {
      webWorker: worker,
      numberOfResolutions: 2,
      signal: controller.signal,
    });
    await vi.waitFor(() => expect(mocks.defaultParameterMap).toHaveBeenCalled());
    controller.abort();

    await expect(registration).rejects.toThrow(/cancelled/i);
    expect(worker.terminate).toHaveBeenCalledTimes(1);
    expect(mocks.runPipeline).not.toHaveBeenCalled();
  });

  test('aborts promptly while the default worker is still initializing', async () => {
    const pixels = new Float32Array(16);
    const controller = new AbortController();
    mocks.getDefaultWebWorker.mockImplementation(() => new Promise(() => undefined));

    const registration = registerRigid2DWithElastix(pixels, pixels, 4, {
      signal: controller.signal,
    });
    await vi.waitFor(() => expect(mocks.getDefaultWebWorker).toHaveBeenCalled());
    controller.abort();

    await expect(registration).rejects.toThrow(/cancelled/i);
    expect(mocks.runPipeline).not.toHaveBeenCalled();
  });

  test('terminates a worker that resolves after initialization timed out', async () => {
    vi.useFakeTimers();
    try {
      const pixels = new Float32Array(16);
      const lateWorker = { terminate: vi.fn() } as unknown as Worker;
      const workerInitialization = createDeferred<Worker>();
      mocks.getDefaultWebWorker.mockReturnValue(workerInitialization.promise);

      const registration = registerRigid2DWithElastix(pixels, pixels, 4);
      const rejection = expect(registration).rejects.toThrow(/worker initialization timed out/i);
      await Promise.resolve();
      await vi.advanceTimersByTimeAsync(30_000);
      await rejection;

      workerInitialization.resolve(lateWorker);
      await Promise.resolve();
      await Promise.resolve();

      expect(lateWorker.terminate).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  test('invalidates a worker when parameter-map loading times out', async () => {
    vi.useFakeTimers();
    try {
      const pixels = new Float32Array(16);
      const worker = { terminate: vi.fn() } as unknown as Worker;
      mocks.defaultParameterMap.mockImplementation(() => new Promise(() => undefined));

      const registration = registerRigid2DWithElastix(pixels, pixels, 4, {
        webWorker: worker,
        numberOfResolutions: 4,
      });
      const rejection = expect(registration).rejects.toThrow(/timed out/i);
      await Promise.resolve();
      await vi.advanceTimersByTimeAsync(60_000);

      await rejection;
      expect(worker.terminate).toHaveBeenCalledTimes(1);
      expect(mocks.runPipeline).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  test('does not let an old initialization failure clear a newer cached retry', async () => {
    const pixels = new Float32Array(16);
    const oldInitialization = createDeferred<Worker>();
    const retryInitialization = createDeferred<Worker>();
    const unexpectedThirdInitialization = createDeferred<Worker>();
    const retryWorker = { terminate: vi.fn() } as unknown as Worker;
    const unexpectedThirdWorker = { terminate: vi.fn() } as unknown as Worker;
    const oldController = new AbortController();
    const retryController = new AbortController();
    const sharedRetryController = new AbortController();
    mocks.getDefaultWebWorker
      .mockReturnValueOnce(oldInitialization.promise)
      .mockReturnValueOnce(retryInitialization.promise)
      .mockReturnValueOnce(unexpectedThirdInitialization.promise);

    const oldRegistration = registerRigid2DWithElastix(pixels, pixels, 4, {
      signal: oldController.signal,
    });
    await vi.waitFor(() => expect(mocks.getDefaultWebWorker).toHaveBeenCalledTimes(1));
    oldController.abort();
    await expect(oldRegistration).rejects.toThrow(/cancelled/i);

    const retryRegistration = registerRigid2DWithElastix(pixels, pixels, 4, {
      numberOfResolutions: 11,
      signal: retryController.signal,
    });
    await vi.waitFor(() => expect(mocks.getDefaultWebWorker).toHaveBeenCalledTimes(2));

    oldInitialization.reject(new Error('old initialization failed'));
    await new Promise((resolve) => window.setTimeout(resolve, 0));
    const sharedRetryRegistration = registerRigid2DWithElastix(pixels, pixels, 4, {
      numberOfResolutions: 12,
      signal: sharedRetryController.signal,
    });
    await new Promise((resolve) => window.setTimeout(resolve, 0));
    const initializationCallCount = mocks.getDefaultWebWorker.mock.calls.length;

    retryController.abort();
    sharedRetryController.abort();
    await expect(retryRegistration).rejects.toThrow(/cancelled/i);
    await expect(sharedRetryRegistration).rejects.toThrow(/cancelled/i);
    retryInitialization.resolve(retryWorker);
    unexpectedThirdInitialization.resolve(unexpectedThirdWorker);
    await Promise.resolve();

    expect(initializationCallCount).toBe(2);
  });

  test('terminates and evicts an internally acquired worker when the pipeline returns the wrong pixel count', async () => {
    const size = 4;
    const pixels = Float32Array.from({ length: size * size }, (_, index) => index / (size * size));
    const malformedWorker = { terminate: vi.fn() } as unknown as Worker;
    const retryWorker = { terminate: vi.fn() } as unknown as Worker;
    mocks.getDefaultWebWorker.mockResolvedValueOnce(malformedWorker).mockResolvedValueOnce(retryWorker);
    mocks.defaultParameterMap.mockResolvedValue({
      parameterMap: { Transform: ['EulerTransform'], NumberOfResolutions: ['43'] },
    });
    const transformOutput = {
      data: [
        {
          Transform: ['EulerTransform'],
          TransformParameters: ['0', '0', '0'],
          CenterOfRotationPoint: ['1.5', '1.5'],
        },
      ],
    };
    mocks.runPipeline
      .mockResolvedValueOnce({
        webWorker: malformedWorker,
        returnValue: 0,
        stdout: '',
        stderr: '',
        outputs: [{ data: { data: pixels.subarray(0, pixels.length - 1) } }, { data: [] }, transformOutput],
      })
      .mockResolvedValueOnce({
        webWorker: retryWorker,
        returnValue: 0,
        stdout: '',
        stderr: '',
        outputs: [{ data: { data: pixels } }, { data: [] }, transformOutput],
      });

    await expect(registerRigid2DWithElastix(pixels, pixels, size, { numberOfResolutions: 43 })).rejects.toThrow(
      /resampled image data.*expected 16 pixels.*got 15/i,
    );
    const retried = await registerRigid2DWithElastix(pixels, pixels, size, { numberOfResolutions: 43 });

    expect(malformedWorker.terminate).toHaveBeenCalledTimes(1);
    expect(mocks.getDefaultWebWorker).toHaveBeenCalledTimes(2);
    expect(mocks.runPipeline.mock.calls[1]?.[4]).toMatchObject({ webWorker: retryWorker });
    expect(retried.webWorker).toBe(retryWorker);

    // Leave the module-level worker cache isolated for the next test.
    mocks.runPipeline.mockRejectedValueOnce(new Error('test cleanup'));
    await expect(
      registerRigid2DWithElastix(pixels, pixels, size, {
        numberOfResolutions: 43,
        webWorker: retryWorker,
      }),
    ).rejects.toThrow('test cleanup');
  });

  test('terminates and evicts an internally acquired worker after an ordinary pipeline failure', async () => {
    const size = 4;
    const pixels = Float32Array.from({ length: size * size }, (_, index) => index / (size * size));
    const failedWorker = { terminate: vi.fn() } as unknown as Worker;
    const retryWorker = { terminate: vi.fn() } as unknown as Worker;
    mocks.getDefaultWebWorker.mockResolvedValueOnce(failedWorker).mockResolvedValueOnce(retryWorker);
    mocks.defaultParameterMap.mockResolvedValue({
      parameterMap: { Transform: ['EulerTransform'], NumberOfResolutions: ['37'] },
    });
    mocks.runPipeline.mockRejectedValueOnce(new Error('ordinary pipeline failure')).mockResolvedValueOnce({
      webWorker: retryWorker,
      returnValue: 0,
      stdout: '',
      stderr: '',
      outputs: [
        { data: { data: pixels } },
        { data: [] },
        {
          data: [
            {
              Transform: ['EulerTransform'],
              TransformParameters: ['0', '0', '0'],
              CenterOfRotationPoint: ['1.5', '1.5'],
            },
          ],
        },
      ],
    });

    await expect(registerRigid2DWithElastix(pixels, pixels, size, { numberOfResolutions: 37 })).rejects.toThrow(
      'ordinary pipeline failure',
    );
    const retried = await registerRigid2DWithElastix(pixels, pixels, size, {
      numberOfResolutions: 37,
    });

    expect(failedWorker.terminate).toHaveBeenCalledTimes(1);
    expect(mocks.getDefaultWebWorker).toHaveBeenCalledTimes(2);
    expect(mocks.runPipeline.mock.calls[1]?.[4]).toMatchObject({ webWorker: retryWorker });
    expect(retried.webWorker).toBe(retryWorker);
  });

  test('terminates both owned workers when result validation fails after the pipeline swaps workers', async () => {
    const pixels = new Float32Array(16);
    const suppliedWorker = { terminate: vi.fn() } as unknown as Worker;
    const returnedWorker = { terminate: vi.fn() } as unknown as Worker;
    mocks.defaultParameterMap.mockResolvedValue({
      parameterMap: { Transform: ['EulerTransform'], NumberOfResolutions: ['41'] },
    });
    mocks.runPipeline.mockResolvedValue({
      webWorker: returnedWorker,
      returnValue: 0,
      stdout: '',
      stderr: '',
      outputs: [{ data: {} }, { data: [] }, { data: [] }],
    });

    await expect(
      registerRigid2DWithElastix(pixels, pixels, 4, {
        numberOfResolutions: 41,
        webWorker: suppliedWorker,
      }),
    ).rejects.toThrow(/no resampled image data/i);

    expect(suppliedWorker.terminate).toHaveBeenCalledTimes(1);
    expect(returnedWorker.terminate).toHaveBeenCalledTimes(1);
  });
});
