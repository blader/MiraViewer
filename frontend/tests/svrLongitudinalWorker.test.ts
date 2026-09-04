import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SvrReconstructionSlice } from '../src/utils/svr/reconstructionCore';
import type { RegisterLongitudinalOptions } from '../src/utils/svr/longitudinalRegistration';
import type { LongitudinalWorkerResponse } from '../src/utils/svr/longitudinalRegistration.worker';
import {
  runLongitudinalDenseReslice,
  runLongitudinalRegistration,
  runLongitudinalEstimate,
  LongitudinalResliceRuntime,
} from '../src/utils/svr/runLongitudinalRegistration';

class MockWorker {
  static instances: MockWorker[] = [];
  onmessage: ((event: MessageEvent<LongitudinalWorkerResponse>) => void) | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;
  postMessage = vi.fn();
  terminate = vi.fn();

  constructor() {
    MockWorker.instances.push(this);
  }
}

function input(): RegisterLongitudinalOptions {
  const slice: SvrReconstructionSlice = {
    pixels: new Float32Array([1, 2, 3, 4]),
    dsRows: 2,
    dsCols: 2,
    ippMm: { x: 0, y: 0, z: 0 },
    rowDir: { x: 1, y: 0, z: 0 },
    colDir: { x: 0, y: 1, z: 0 },
    normalDir: { x: 0, y: 0, z: 1 },
    rowSpacingDsMm: 1,
    colSpacingDsMm: 1,
    sliceThicknessMm: 1,
    spacingBetweenSlicesMm: 1,
  };
  return { referenceSlices: [slice], targetSlices: [slice], referenceSliceIndex: 0 };
}

describe('svr/longitudinal registration worker ownership', () => {
  const denseInput = () => {
    const source = input();
    const { pixels: _pixels, ...referencePlane } = source.referenceSlices[0]!;
    void _pixels;
    return {
      targetSlices: source.targetSlices,
      referencePlane,
      targetToReference: { tx: 0, ty: 0, tz: 0, rx: 0, ry: 0, rz: 0 },
      centerMm: { x: 0, y: 0, z: 0 },
    };
  };
  const complete = (worker: MockWorker) => {
    const result = {
      ok: true as const,
      pixels: new Float32Array(4),
      valid: new Uint8Array(4),
      rows: 2,
      cols: 2,
      coverage: 1,
    };
    worker.onmessage?.({ data: { type: 'done', result } } as MessageEvent<LongitudinalWorkerResponse>);
    return result;
  };

  it('reuses successful reslicing runtimes with fresh inputs, but terminates canceled work before replacement', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('Worker', MockWorker);
    const runtime = new LongitudinalResliceRuntime();
    const first = runLongitudinalDenseReslice(denseInput(), undefined, runtime);
    const worker = MockWorker.instances[0]!;
    await expect(first).resolves.toEqual(complete(worker));
    expect(worker.terminate).not.toHaveBeenCalled();
    expect(worker.onmessage).toBeNull();

    const nextInput = denseInput();
    nextInput.targetSlices[0]!.pixels.fill(9);
    const controller = new AbortController();
    const next = runLongitudinalDenseReslice(nextInput, controller.signal, runtime);
    expect(MockWorker.instances).toHaveLength(1);
    expect(worker.postMessage).toHaveBeenLastCalledWith({ type: 'reslice', options: nextInput }, [
      nextInput.targetSlices[0]!.pixels.buffer,
    ]);
    const lateMessage = worker.onmessage;
    controller.abort();
    await expect(next).resolves.toMatchObject({ ok: false, reason: 'cancelled' });
    expect(worker.terminate).toHaveBeenCalledOnce();
    lateMessage?.({ data: { type: 'done', result: { ok: true } } } as MessageEvent<LongitudinalWorkerResponse>);
    const replacement = runLongitudinalDenseReslice(denseInput(), undefined, runtime);
    expect(MockWorker.instances).toHaveLength(2);
    const fresh = MockWorker.instances[1]!;
    await expect(replacement).resolves.toEqual(complete(fresh));
    runtime.dispose();
    expect(fresh.terminate).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('retains at most one idle worker, expires it, and cannot retain a completion after disposal', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('Worker', MockWorker);
    const runtime = new LongitudinalResliceRuntime();
    const first = runLongitudinalDenseReslice(denseInput(), undefined, runtime);
    const second = runLongitudinalDenseReslice(denseInput(), undefined, runtime);
    const [one, two] = MockWorker.instances;
    await expect(first).resolves.toEqual(complete(one!));
    await expect(second).resolves.toEqual(complete(two!));
    expect(one!.terminate).toHaveBeenCalledOnce();
    expect(two!.terminate).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(two!.terminate).toHaveBeenCalledOnce();
    const pending = runLongitudinalDenseReslice(denseInput(), undefined, runtime);
    const three = MockWorker.instances[2]!;
    runtime.dispose();
    await expect(pending).resolves.toEqual(complete(three));
    expect(three.terminate).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('requests pose evidence without an image and retains the same cancellation owner', async () => {
    vi.stubGlobal('Worker', MockWorker);
    const controller = new AbortController();
    const pending = runLongitudinalEstimate(input(), controller.signal);
    const worker = MockWorker.instances[0]!;
    expect(worker.postMessage.mock.calls[0]![0]).toMatchObject({ type: 'estimate' });
    expect(worker.postMessage.mock.calls[0]![1]).toHaveLength(1);
    controller.abort();
    await expect(pending).resolves.toMatchObject({ ok: false, reason: 'cancelled' });
    expect(worker.terminate).toHaveBeenCalledOnce();
  });

  afterEach(() => {
    MockWorker.instances = [];
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it('transfers each source buffer once and terminates after a worker result', async () => {
    vi.stubGlobal('Worker', MockWorker);
    const pending = runLongitudinalRegistration(input());
    const worker = MockWorker.instances[0]!;
    expect(worker.postMessage).toHaveBeenCalledTimes(1);
    expect(worker.postMessage.mock.calls[0]![1]).toHaveLength(1);

    const result = { ok: false as const, reason: 'insufficient-coverage' as const, message: 'No overlap' };
    worker.onmessage?.({ data: { type: 'done', result } } as MessageEvent<LongitudinalWorkerResponse>);

    await expect(pending).resolves.toEqual(result);
    expect(worker.terminate).toHaveBeenCalledTimes(1);
  });

  it('transfers each explicit acquired-support buffer exactly once alongside its source pixels', async () => {
    vi.stubGlobal('Worker', MockWorker);
    const options = input();
    options.referenceSlices[0]!.valid = new Uint8Array([1, 0, 1, 1]);
    const pending = runLongitudinalRegistration(options);
    const worker = MockWorker.instances[0]!;

    expect(worker.postMessage.mock.calls[0]![1]).toEqual([
      options.referenceSlices[0]!.pixels.buffer,
      options.referenceSlices[0]!.valid.buffer,
    ]);

    const result = { ok: false as const, reason: 'insufficient-coverage' as const, message: 'No overlap' };
    worker.onmessage?.({ data: { type: 'done', result } } as MessageEvent<LongitudinalWorkerResponse>);
    await expect(pending).resolves.toEqual(result);
  });

  it('aborts and terminates an active worker without waiting for its compute loop', async () => {
    vi.stubGlobal('Worker', MockWorker);
    const controller = new AbortController();
    const pending = runLongitudinalRegistration(input(), controller.signal);
    const worker = MockWorker.instances[0]!;

    controller.abort();

    await expect(pending).resolves.toMatchObject({ ok: false, reason: 'cancelled' });
    expect(worker.postMessage).toHaveBeenLastCalledWith({ type: 'abort' });
    expect(worker.terminate).toHaveBeenCalledTimes(1);
  });

  it('returns an honest worker initialization failure without inline production fallback', async () => {
    vi.stubGlobal(
      'Worker',
      class {
        constructor() {
          throw new Error('module workers unavailable');
        }
      },
    );

    await expect(runLongitudinalRegistration(input())).resolves.toMatchObject({
      ok: false,
      reason: 'registration-failed',
      message: expect.stringContaining('module workers unavailable'),
    });
  });

  it('terminates a worker that exceeds its bounded registration deadline', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('Worker', MockWorker);
    const pending = runLongitudinalRegistration(input());
    const worker = MockWorker.instances[0]!;

    await vi.advanceTimersByTimeAsync(120_000);

    await expect(pending).resolves.toMatchObject({
      ok: false,
      reason: 'registration-failed',
      message: expect.stringContaining('120-second'),
    });
    expect(worker.terminate).toHaveBeenCalledTimes(1);
  });

  it('transfers only dense target slices and reslices without rerunning rigid registration', async () => {
    vi.stubGlobal('Worker', MockWorker);
    const source = input();
    const { pixels: _pixels, ...referencePlane } = source.referenceSlices[0]!;
    void _pixels;
    const pending = runLongitudinalDenseReslice({
      targetSlices: source.targetSlices,
      referencePlane,
      targetToReference: { tx: 0, ty: 0, tz: 0, rx: 0, ry: 0, rz: 0 },
      centerMm: { x: 0, y: 0, z: 0 },
    });
    const worker = MockWorker.instances[0]!;

    expect(worker.postMessage.mock.calls[0]![0]).toMatchObject({ type: 'reslice' });
    expect(worker.postMessage.mock.calls[0]![1]).toHaveLength(1);
    const result = { ok: true as const, pixels: new Float32Array(4), rows: 2, cols: 2, coverage: 1 };
    worker.onmessage?.({ data: { type: 'done', result } } as MessageEvent<LongitudinalWorkerResponse>);

    await expect(pending).resolves.toEqual(result);
    expect(worker.terminate).toHaveBeenCalledTimes(1);
  });

  it('transfers native reference support and the undetached dense exclusion exactly once', async () => {
    vi.stubGlobal('Worker', MockWorker);
    const source = input();
    const nativeReference = { ...source.referenceSlices[0]!, valid: new Uint8Array([1, 1, 0, 1]) };
    const exclusion = new Uint8Array([0, 1, 0, 0]);
    const { pixels: _pixels, ...referencePlane } = source.referenceSlices[0]!;
    void _pixels;
    const pending = runLongitudinalDenseReslice({
      targetSlices: source.targetSlices,
      referencePlane,
      nativeReferenceSlices: [nativeReference],
      nativeReferenceSliceIndex: 0,
      referenceExclusionMask: exclusion,
      targetToReference: { tx: 0, ty: 0, tz: 0, rx: 0, ry: 0, rz: 0 },
      centerMm: { x: 0, y: 0, z: 0 },
    });
    const worker = MockWorker.instances[0]!;

    expect(worker.postMessage.mock.calls[0]![1]).toEqual([
      source.targetSlices[0]!.pixels.buffer,
      nativeReference.valid.buffer,
      exclusion.buffer,
    ]);

    const result = { ok: false as const, reason: 'insufficient-coverage' as const, message: 'No overlap' };
    worker.onmessage?.({ data: { type: 'done', result } } as MessageEvent<LongitudinalWorkerResponse>);
    await expect(pending).resolves.toEqual(result);
  });
});
