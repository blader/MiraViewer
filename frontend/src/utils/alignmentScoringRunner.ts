import {
  AlignmentScoringEngine,
  type AlignmentFinalScoringInput,
  type AlignmentScoredCandidate,
  type AlignmentScoringConfiguration,
} from './alignmentScoringEngine';
import type { GridSeedTransform } from './alignmentTransform';
import type { PhaseCorrection } from './phaseCorrelation';
import { selectFinalAffineProposal, type FinalAffineSelection } from './structuralAffineSelection';

export type AlignmentScoringRunner = {
  scoreCoarse: (
    pixels: Float32Array,
    seed: GridSeedTransform,
    validity?: Float32Array,
  ) => Promise<AlignmentScoredCandidate>;
  scoreFine: (
    pixels: Float32Array,
    seed: GridSeedTransform,
    phase: PhaseCorrection,
    validity?: Float32Array,
  ) => Promise<AlignmentScoredCandidate>;
  scoreFinal: (input: AlignmentFinalScoringInput) => Promise<FinalAffineSelection>;
  close: () => void;
};

type WorkerResponse =
  | { kind: 'ready'; requestId: number }
  | { kind: 'started'; requestId: number }
  | { kind: 'result'; requestId: number; result: AlignmentScoredCandidate }
  | { kind: 'final-result'; requestId: number; result: FinalAffineSelection }
  | { kind: 'error'; requestId: number; message: string };

function createScoringWorker(signal: AbortSignal, onStarted?: () => void) {
  if (signal.aborted) throw new Error('Alignment scoring worker cancelled');
  if (typeof Worker !== 'function') {
    throw new Error(
      'Auto-alignment requires module worker support; CPU-heavy image analysis cannot run on the UI thread',
    );
  }

  let worker: Worker;
  try {
    worker = new Worker(new URL('./alignmentScoring.worker.ts', import.meta.url), { type: 'module' });
  } catch (error) {
    throw new Error(
      `Alignment scoring worker could not start: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  let nextRequestId = 0;
  let closed = false;
  let active:
    | {
        requestId: number;
        resolve: (response: WorkerResponse) => void;
        reject: (error: Error) => void;
        timer: ReturnType<typeof setTimeout>;
      }
    | undefined;

  const close = () => {
    if (closed) return;
    closed = true;
    signal.removeEventListener('abort', close);
    worker.terminate();
    if (active) {
      clearTimeout(active.timer);
      active.reject(new Error('Alignment scoring worker cancelled'));
      active = undefined;
    }
  };
  signal.addEventListener('abort', close, { once: true });

  worker.onmessage = (event: MessageEvent<WorkerResponse>) => {
    const pending = active;
    if (!pending || event.data.requestId !== pending.requestId) return;
    if (event.data.kind === 'started') {
      onStarted?.();
      return;
    }
    clearTimeout(pending.timer);
    active = undefined;
    if (event.data.kind === 'error') pending.reject(new Error(event.data.message));
    else pending.resolve(event.data);
  };
  worker.onerror = (event) => {
    const pending = active;
    if (!pending) return;
    clearTimeout(pending.timer);
    active = undefined;
    pending.reject(new Error(`Alignment scoring worker failed: ${event.message}`));
    close();
  };

  const request = async (message: Record<string, unknown>, transfer: Transferable[] = []) => {
    if (closed || signal.aborted) throw new Error('Alignment scoring worker cancelled');
    if (active) throw new Error('Alignment scoring requests must remain serial and bounded');
    const requestId = ++nextRequestId;
    return await new Promise<WorkerResponse>((resolve, reject) => {
      const timer = setTimeout(() => {
        active = undefined;
        reject(new Error('Alignment scoring worker exceeded its 30-second candidate deadline'));
        close();
      }, 30_000);
      active = { requestId, resolve, reject, timer };
      try {
        worker.postMessage({ ...message, requestId }, transfer);
      } catch (error) {
        clearTimeout(timer);
        active = undefined;
        reject(
          new Error(
            `Alignment scoring worker rejected its request: ${error instanceof Error ? error.message : String(error)}`,
          ),
        );
        close();
      }
    });
  };

  return { request, close };
}

/** One worker per run; only deterministic unit/integration tests are allowed an in-process engine. */
export async function createAlignmentScoringRunner(
  config: AlignmentScoringConfiguration,
  signal: AbortSignal,
): Promise<AlignmentScoringRunner> {
  if (typeof Worker !== 'function' && import.meta.env.MODE === 'test') {
    const engine = new AlignmentScoringEngine(config);
    return {
      scoreCoarse: async (pixels, seed, validity) => engine.scoreCoarse(pixels, seed, validity),
      scoreFine: async (pixels, seed, phase, validity) => engine.scoreFine(pixels, seed, phase, validity),
      scoreFinal: async (input) => engine.scoreFinal(input),
      close: () => undefined,
    };
  }
  const { request, close } = createScoringWorker(signal);

  const referenceConfig = { ...config };
  const referenceTransfers: Transferable[] = [];
  for (const field of [
    'referenceFinePixels',
    'referenceCoarsePixels',
    'referenceFineValidity',
    'referenceCoarseValidity',
  ] as const) {
    const source = config[field];
    if (!source) continue;
    const copy = Float32Array.from(source);
    referenceConfig[field] = copy;
    referenceTransfers.push(copy.buffer);
  }
  try {
    await request({ kind: 'initialize', config: referenceConfig }, referenceTransfers);
  } catch (error) {
    close();
    throw error;
  }

  const scoreCandidate = async (
    kind: 'coarse' | 'fine',
    pixels: Float32Array,
    seed: GridSeedTransform,
    validity?: Float32Array,
    phase?: PhaseCorrection,
  ) => {
    const response = await request(
      { kind, pixels, seed, ...(phase ? { phase } : {}), ...(validity ? { validity } : {}) },
      [pixels.buffer, ...(validity ? [validity.buffer] : [])],
    );
    if (response.kind !== 'result') throw new Error(`Alignment scoring worker returned an invalid ${kind} result`);
    return response.result;
  };

  return {
    scoreCoarse: (pixels, seed, validity) => scoreCandidate('coarse', pixels, seed, validity),
    scoreFine: (pixels, seed, phase, validity) => scoreCandidate('fine', pixels, seed, validity, phase),
    scoreFinal: async (input) => {
      // The selected native pixels remain needed for display statistics after worker scoring.
      const movingPixels = Float32Array.from(input.movingPixels);
      const movingValidity = input.movingValidity ? Float32Array.from(input.movingValidity) : undefined;
      const response = await request(
        {
          kind: 'final',
          input: { ...input, movingPixels, ...(movingValidity ? { movingValidity } : {}) },
        },
        movingValidity ? [movingPixels.buffer, movingValidity.buffer] : [movingPixels.buffer],
      );
      if (response.kind !== 'final-result')
        throw new Error('Alignment scoring worker returned an invalid final result');
      return response.result;
    },
    close,
  };
}

/** Rank a physical-route refinement without constructing unused coarse/FFT reference state. */
export async function scoreFinalAffineInWorker(
  input: Parameters<typeof selectFinalAffineProposal>[0],
  signal: AbortSignal,
  onStarted?: () => void,
): Promise<FinalAffineSelection> {
  if (signal.aborted) throw new Error('Alignment scoring worker cancelled');
  if (typeof Worker !== 'function' && import.meta.env.MODE === 'test') return selectFinalAffineProposal(input);
  const { request, close } = createScoringWorker(signal, onStarted);
  try {
    // The UI still owns the accepted plane and its display calibration. Transfer
    // private copies so cancellation or worker disposal cannot detach them.
    const copied = {
      ...input,
      normalizedReference: Float32Array.from(input.normalizedReference),
      movingPixels: Float32Array.from(input.movingPixels),
      referenceValidity: input.referenceValidity ? Float32Array.from(input.referenceValidity) : undefined,
      movingValidity: input.movingValidity ? Float32Array.from(input.movingValidity) : undefined,
    };
    const response = await request({ kind: 'final-only', input: copied }, [
      copied.normalizedReference.buffer,
      copied.movingPixels.buffer,
      ...(copied.referenceValidity ? [copied.referenceValidity.buffer] : []),
      ...(copied.movingValidity ? [copied.movingValidity.buffer] : []),
    ]);
    if (response.kind !== 'final-result') throw new Error('Alignment scoring worker returned an invalid final result');
    return response.result;
  } finally {
    close();
  }
}
