import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createAlignmentScoringRunner, scoreFinalAffineInWorker } from '../src/utils/alignmentScoringRunner';
import type { AlignmentScoringConfiguration } from '../src/utils/alignmentScoringEngine';

const config: AlignmentScoringConfiguration = {
  referenceFinePixels: new Float32Array(64).fill(0.5),
  referenceCoarsePixels: new Float32Array(64).fill(0.5),
  fineSize: 8,
  coarseSize: 8,
  fineScales: [8],
  coarseScales: [8],
  phaseFftSize: 16,
  phaseMaxCorrectionPx: 2,
};

type WorkerMessage = {
  kind: string;
  requestId: number;
  input?: {
    movingPixels: Float32Array;
    movingValidity?: Float32Array;
    normalizedReference?: Float32Array;
    referenceValidity?: Float32Array;
  };
  config?: AlignmentScoringConfiguration;
  pixels?: Float32Array;
  validity?: Float32Array;
};

class FakeScoringWorker {
  static instances: FakeScoringWorker[] = [];
  static mode: 'ready' | 'initialize-error' | 'initialize-throw' | 'candidate-throw' | 'no-response' = 'ready';

  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;
  terminate = vi.fn();
  postMessage = vi.fn((message: WorkerMessage, _transfer?: Transferable[]) => {
    void _transfer;
    if (
      FakeScoringWorker.mode === 'initialize-throw' ||
      (FakeScoringWorker.mode === 'candidate-throw' && message.kind !== 'initialize')
    ) {
      throw new Error('transfer refused');
    }
    if (FakeScoringWorker.mode === 'no-response') return;
    queueMicrotask(() => {
      if (FakeScoringWorker.mode === 'initialize-error' && message.kind === 'initialize') {
        this.onmessage?.({
          data: { kind: 'error', requestId: message.requestId, message: 'invalid reference' },
        } as MessageEvent);
        return;
      }
      const response =
        message.kind === 'initialize'
          ? { kind: 'ready', requestId: message.requestId }
          : message.kind === 'final' || message.kind === 'final-only'
            ? {
                kind: 'final-result',
                requestId: message.requestId,
                result: { proposals: [], selected: { kind: 'seed-only' } },
              }
            : { kind: 'result', requestId: message.requestId, result: { components: { coverage: 1, perScale: [] } } };
      this.onmessage?.({ data: response } as MessageEvent);
    });
  });

  constructor() {
    FakeScoringWorker.instances.push(this);
  }
}

describe('bounded alignment scoring worker lifecycle', () => {
  const finalInput = () => ({
    normalizedReference: new Float32Array(64).fill(0.25),
    referenceValidity: new Float32Array(64).fill(1),
    movingPixels: new Float32Array(64).fill(0.75),
    movingValidity: new Float32Array(64).fill(1),
    size: 8,
    scales: [8],
    winningWarp: { A: { m00: 1, m01: 0, m10: 0, m11: 1 }, translateX: 0, translateY: 0 },
    optimizerProposals: [],
  });
  beforeEach(() => {
    FakeScoringWorker.instances = [];
    FakeScoringWorker.mode = 'ready';
    vi.stubGlobal('Worker', FakeScoringWorker);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('ranks a physical final-only request without initializing coarse state or detaching UI buffers', async () => {
    const input = finalInput();
    await scoreFinalAffineInWorker(input, new AbortController().signal);
    const worker = FakeScoringWorker.instances[0]!;
    expect(worker.postMessage).toHaveBeenCalledOnce();
    const [message, transfer] = worker.postMessage.mock.calls[0]!;
    expect(message.kind).toBe('final-only');
    expect(transfer).toHaveLength(4);
    for (const field of ['normalizedReference', 'referenceValidity', 'movingPixels', 'movingValidity'] as const) {
      expect(message.input![field]).not.toBe(input[field]);
      expect(Array.from(message.input![field]!)).toEqual(Array.from(input[field]));
    }
    expect(worker.terminate).toHaveBeenCalledOnce();
  });

  it.each(['abort', 'timeout'] as const)('terminates final ranking on %s and rejects late replies', async (reason) => {
    vi.useFakeTimers();
    FakeScoringWorker.mode = 'no-response';
    const controller = new AbortController();
    const pending = scoreFinalAffineInWorker(finalInput(), controller.signal);
    const rejected = expect(pending).rejects.toThrow(reason === 'abort' ? 'cancelled' : 'deadline');
    const worker = FakeScoringWorker.instances[0]!;
    if (reason === 'abort') controller.abort();
    else await vi.advanceTimersByTimeAsync(30_000);
    await rejected;
    worker.onmessage?.({ data: { kind: 'final-result', requestId: 1, result: { selected: {} } } } as MessageEvent);
    expect(worker.terminate).toHaveBeenCalledOnce();
  });

  it('reports worker entry without settling the request or extending its deadline', async () => {
    vi.useFakeTimers();
    FakeScoringWorker.mode = 'no-response';
    const onStarted = vi.fn();
    const pending = scoreFinalAffineInWorker(finalInput(), new AbortController().signal, onStarted);
    const rejected = expect(pending).rejects.toThrow('deadline');
    await vi.advanceTimersByTimeAsync(29_000);
    FakeScoringWorker.instances[0]!.onmessage?.({
      data: { kind: 'started', requestId: 1 },
    } as MessageEvent);
    expect(onStarted).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(1_000);
    await rejected;
  });

  it('terminates an initialized worker when its run is aborted', async () => {
    const controller = new AbortController();
    await createAlignmentScoringRunner(config, controller.signal);
    const worker = FakeScoringWorker.instances[0]!;

    controller.abort();

    expect(worker.terminate).toHaveBeenCalledTimes(1);
  });

  it('reclaims the worker after a synchronous initialization transfer failure', async () => {
    FakeScoringWorker.mode = 'initialize-throw';

    await expect(createAlignmentScoringRunner(config, new AbortController().signal)).rejects.toThrow(
      'transfer refused',
    );

    expect(FakeScoringWorker.instances[0]!.terminate).toHaveBeenCalledTimes(1);
  });

  it('reclaims the worker when reference initialization returns an error', async () => {
    FakeScoringWorker.mode = 'initialize-error';

    await expect(createAlignmentScoringRunner(config, new AbortController().signal)).rejects.toThrow(
      'invalid reference',
    );

    expect(FakeScoringWorker.instances[0]!.terminate).toHaveBeenCalledTimes(1);
  });

  it('reclaims the worker after a synchronous candidate transfer failure', async () => {
    const runner = await createAlignmentScoringRunner(config, new AbortController().signal);
    FakeScoringWorker.mode = 'candidate-throw';

    await expect(
      runner.scoreCoarse(new Float32Array(64), {
        A: { m00: 1, m01: 0, m10: 0, m11: 1 },
        translatePx: { x: 0, y: 0 },
        gridSize: 8,
      }),
    ).rejects.toThrow('transfer refused');

    expect(FakeScoringWorker.instances[0]!.terminate).toHaveBeenCalledTimes(1);
  });

  it('moves final affine comparison into the existing worker without transferring display pixels', async () => {
    const runner = await createAlignmentScoringRunner(config, new AbortController().signal);
    const movingPixels = new Float32Array(64).fill(0.75);
    const movingValidity = new Float32Array(64).fill(1);
    movingValidity[0] = 0;

    await runner.scoreFinal({
      movingPixels,
      movingValidity,
      winningWarp: { A: { m00: 1, m01: 0, m10: 0, m11: 1 }, translateX: 0, translateY: 0 },
      optimizerProposals: [],
    });

    const message = FakeScoringWorker.instances[0]!.postMessage.mock.calls[1]![0];
    expect(message.kind).toBe('final');
    expect(message.input!.movingPixels).not.toBe(movingPixels);
    expect(message.input!.movingValidity).not.toBe(movingValidity);
    expect(message.input!.movingValidity?.[0]).toBe(0);
    expect(movingPixels[0]).toBe(0.75);
    expect(movingValidity[0]).toBe(0);
    expect(FakeScoringWorker.instances[0]!.postMessage.mock.calls[1]![1]).toHaveLength(2);
    runner.close();
  });

  it('transfers reference and candidate acquired-validity masks through the same bounded scoring worker', async () => {
    const referenceFineValidity = new Float32Array(64).fill(1);
    const referenceCoarseValidity = new Float32Array(64).fill(1);
    referenceFineValidity[0] = 0;
    referenceCoarseValidity[1] = 0;
    const runner = await createAlignmentScoringRunner(
      { ...config, referenceFineValidity, referenceCoarseValidity },
      new AbortController().signal,
    );
    const worker = FakeScoringWorker.instances[0]!;
    const initialization = worker.postMessage.mock.calls[0]!;

    expect(initialization[0].config?.referenceFineValidity?.[0]).toBe(0);
    expect(initialization[0].config?.referenceCoarseValidity?.[1]).toBe(0);
    expect(initialization[1]).toHaveLength(4);

    const pixels = new Float32Array(64).fill(0.25);
    const validity = new Float32Array(64).fill(1);
    validity[2] = 0;
    const seed = { A: { m00: 1, m01: 0, m10: 0, m11: 1 }, translatePx: { x: 0, y: 0 }, gridSize: 8 };
    await runner.scoreCoarse(pixels, seed, validity);

    const coarse = worker.postMessage.mock.calls[1]!;
    expect(coarse[0].validity?.[2]).toBe(0);
    expect(coarse[1]).toEqual([pixels.buffer, validity.buffer]);
    runner.close();
  });

  it('terminates an unresponsive worker at the bounded initialization deadline', async () => {
    vi.useFakeTimers();
    FakeScoringWorker.mode = 'no-response';
    const pending = createAlignmentScoringRunner(config, new AbortController().signal);
    const assertion = expect(pending).rejects.toThrow('30-second candidate deadline');

    await vi.advanceTimersByTimeAsync(30_000);
    await assertion;

    expect(FakeScoringWorker.instances[0]!.terminate).toHaveBeenCalledTimes(1);
  });
});
