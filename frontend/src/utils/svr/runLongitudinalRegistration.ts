import {
  registerAndResliceLongitudinal,
  resliceDenseLongitudinalPlane,
  type DenseLongitudinalResliceOptions,
  type DenseLongitudinalResliceResult,
  type LongitudinalRegistrationFailure,
  type LongitudinalRegistrationResult,
  type RegisterLongitudinalOptions,
} from './longitudinalRegistration';
import type {
  LongitudinalWorkerOptions,
  LongitudinalWorkerRequest,
  LongitudinalWorkerResponse,
} from './longitudinalRegistration.worker';

const LONGITUDINAL_REGISTRATION_TIMEOUT_MS = 120_000;
type LongitudinalWorkerResult = LongitudinalWorkerResponse['result'];
type LongitudinalWorkerInput =
  | { type: 'run'; options: RegisterLongitudinalOptions }
  | { type: 'reslice'; options: DenseLongitudinalResliceOptions };

function cancellation(): LongitudinalRegistrationFailure {
  return { ok: false, reason: 'cancelled', message: 'Longitudinal registration cancelled' };
}

function failed(message: string): LongitudinalRegistrationFailure {
  return { ok: false, reason: 'registration-failed', message };
}

async function runLongitudinalWorker(
  request: LongitudinalWorkerInput,
  signal?: AbortSignal,
): Promise<LongitudinalWorkerResult> {
  const input = request.options;
  const effectiveSignal = signal ?? input.signal;
  if (effectiveSignal?.aborted) return cancellation();

  if (typeof Worker === 'undefined') {
    // Vitest/jsdom deliberately exercises the identical pure compute function.
    // Production never silently moves volume registration back onto the UI thread.
    if (import.meta.env.MODE === 'test') {
      return request.type === 'reslice'
        ? resliceDenseLongitudinalPlane({ ...request.options, signal: effectiveSignal })
        : registerAndResliceLongitudinal({ ...request.options, signal: effectiveSignal });
    }
    return failed('Longitudinal registration requires Web Worker support');
  }

  let worker: Worker;
  try {
    worker = new Worker(new URL('./longitudinalRegistration.worker.ts', import.meta.url), { type: 'module' });
  } catch (error) {
    return failed(
      `Longitudinal registration worker could not start: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  return new Promise((resolve) => {
    let settled = false;

    const settle = (result: LongitudinalWorkerResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      effectiveSignal?.removeEventListener('abort', onAbort);
      worker.onmessage = null;
      worker.onerror = null;
      worker.terminate();
      resolve(result);
    };

    const onAbort = (): void => {
      try {
        worker.postMessage({ type: 'abort' } satisfies LongitudinalWorkerRequest);
      } catch {
        // Termination below remains authoritative even if the worker failed.
      }
      settle(cancellation());
    };

    const timer = setTimeout(() => {
      settle(
        failed(`Longitudinal registration exceeded its ${LONGITUDINAL_REGISTRATION_TIMEOUT_MS / 1000}-second limit`),
      );
    }, LONGITUDINAL_REGISTRATION_TIMEOUT_MS);

    worker.onmessage = (event: MessageEvent<LongitudinalWorkerResponse>) => {
      if (event.data?.type !== 'done') {
        settle(failed('Longitudinal registration worker returned an invalid response'));
        return;
      }
      settle(event.data.result);
    };

    worker.onerror = (event: ErrorEvent) => {
      settle(failed(event.message || 'Longitudinal registration worker failed'));
    };

    effectiveSignal?.addEventListener('abort', onAbort, { once: true });
    if (effectiveSignal?.aborted) {
      onAbort();
      return;
    }

    const { signal: _inputSignal, ...options } = input;
    void _inputSignal;
    const transfer: Transferable[] = [];
    const seen = new Set<ArrayBuffer>();
    const sourceSlices =
      request.type === 'run'
        ? [...request.options.referenceSlices, ...request.options.targetSlices]
        : request.options.targetSlices;
    for (const slice of sourceSlices) {
      const buffer = slice.pixels.buffer as ArrayBuffer;
      if (!seen.has(buffer)) {
        seen.add(buffer);
        transfer.push(buffer);
      }
    }
    if (request.type === 'run' && request.options.referenceExclusionMask) {
      const buffer = request.options.referenceExclusionMask.buffer as ArrayBuffer;
      if (!seen.has(buffer)) transfer.push(buffer);
    }

    try {
      const message: LongitudinalWorkerRequest =
        request.type === 'run'
          ? { type: 'run', options: options as LongitudinalWorkerOptions }
          : { type: 'reslice', options: options as Omit<DenseLongitudinalResliceOptions, 'signal'> };
      worker.postMessage(message, transfer);
    } catch (error) {
      settle(
        failed(
          `Longitudinal registration worker rejected its input: ${error instanceof Error ? error.message : String(error)}`,
        ),
      );
    }
  });
}

/** A worker owns the transferred coarse stacks; every terminal path reclaims it. */
export async function runLongitudinalRegistration(
  input: RegisterLongitudinalOptions,
  signal?: AbortSignal,
): Promise<LongitudinalRegistrationResult | LongitudinalRegistrationFailure> {
  return (await runLongitudinalWorker({ type: 'run', options: input }, signal)) as
    | LongitudinalRegistrationResult
    | LongitudinalRegistrationFailure;
}

/** Reslice native acquired anatomy in its own bounded worker without repeating registration. */
export async function runLongitudinalDenseReslice(
  input: DenseLongitudinalResliceOptions,
  signal?: AbortSignal,
): Promise<DenseLongitudinalResliceResult | LongitudinalRegistrationFailure> {
  return (await runLongitudinalWorker({ type: 'reslice', options: input }, signal)) as
    | DenseLongitudinalResliceResult
    | LongitudinalRegistrationFailure;
}
