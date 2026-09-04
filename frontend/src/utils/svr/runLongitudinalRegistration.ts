import {
  registerAndResliceLongitudinal,
  estimateLongitudinalRegistration,
  resliceDenseLongitudinalPlane,
  type DenseLongitudinalResliceOptions,
  type DenseLongitudinalResliceResult,
  type LongitudinalRegistrationFailure,
  type LongitudinalRegistrationResult,
  type LongitudinalRegistrationEstimate,
  type RegisterLongitudinalOptions,
} from './longitudinalRegistration';
import type {
  LongitudinalWorkerOptions,
  LongitudinalWorkerRequest,
  LongitudinalWorkerResponse,
} from './longitudinalRegistration.worker';

const LONGITUDINAL_REGISTRATION_TIMEOUT_MS = 120_000;

/** One idle runtime, not a source-pixel cache. Active work belongs to its abort signal. */
export class LongitudinalResliceRuntime {
  private idle: Worker | undefined;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private disposed = false;

  take(): Worker | undefined {
    clearTimeout(this.timer);
    this.timer = undefined;
    const worker = this.idle;
    this.idle = undefined;
    return worker;
  }

  retain(worker: Worker): void {
    this.take()?.terminate();
    if (this.disposed) {
      worker.terminate();
      return;
    }
    this.idle = worker;
    this.timer = setTimeout(() => this.take()?.terminate(), 30_000);
  }

  dispose(): void {
    this.disposed = true;
    this.take()?.terminate();
  }
}

type LongitudinalWorkerResult = LongitudinalWorkerResponse['result'];
type LongitudinalWorkerInput =
  | { type: 'run' | 'estimate'; options: RegisterLongitudinalOptions }
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
  runtime?: LongitudinalResliceRuntime,
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
        : request.type === 'estimate'
          ? estimateLongitudinalRegistration({ ...request.options, signal: effectiveSignal })
          : registerAndResliceLongitudinal({ ...request.options, signal: effectiveSignal });
    }
    return failed('Longitudinal registration requires Web Worker support');
  }

  let worker: Worker;
  try {
    worker =
      runtime?.take() ??
      new Worker(new URL('./longitudinalRegistration.worker.ts', import.meta.url), { type: 'module' });
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
      if (runtime && result?.ok) runtime.retain(worker);
      else worker.terminate();
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
    const sourceSlices =
      request.type !== 'reslice'
        ? [...request.options.referenceSlices, ...request.options.targetSlices]
        : [...request.options.targetSlices, ...(request.options.nativeReferenceSlices ?? [])];
    const transfer = new Set<ArrayBuffer>();
    for (const slice of sourceSlices) {
      transfer.add(slice.pixels.buffer as ArrayBuffer);
      if (slice.valid) transfer.add(slice.valid.buffer as ArrayBuffer);
    }
    if (request.options.referenceExclusionMask) {
      transfer.add(request.options.referenceExclusionMask.buffer as ArrayBuffer);
    }

    try {
      const message: LongitudinalWorkerRequest =
        request.type !== 'reslice'
          ? { type: request.type, options: options as LongitudinalWorkerOptions }
          : { type: 'reslice', options: options as Omit<DenseLongitudinalResliceOptions, 'signal'> };
      worker.postMessage(message, Array.from(transfer));
    } catch (error) {
      settle(
        failed(
          `Longitudinal registration worker rejected its input: ${error instanceof Error ? error.message : String(error)}`,
        ),
      );
    }
  });
}

/** Test-only historical image-producing oracle for the retained pose/pixel parity benchmark. */
export async function runLongitudinalRegistration(
  input: RegisterLongitudinalOptions,
  signal?: AbortSignal,
): Promise<LongitudinalRegistrationResult | LongitudinalRegistrationFailure> {
  if (import.meta.env.MODE !== 'test' && import.meta.env.MODE !== 'browser-test')
    return failed('The historical image-producing registration oracle is test-only.');
  return (await runLongitudinalWorker({ type: 'run', options: input }, signal)) as
    | LongitudinalRegistrationResult
    | LongitudinalRegistrationFailure;
}

/** Coarse application work owns pose evidence only; the native pass publishes pixels. */
export async function runLongitudinalEstimate(
  input: RegisterLongitudinalOptions,
  signal?: AbortSignal,
): Promise<LongitudinalRegistrationEstimate | LongitudinalRegistrationFailure> {
  return (await runLongitudinalWorker({ type: 'estimate', options: input }, signal)) as
    | LongitudinalRegistrationEstimate
    | LongitudinalRegistrationFailure;
}

/** Reslice native acquired anatomy in its own bounded worker without repeating registration. */
export async function runLongitudinalDenseReslice(
  input: DenseLongitudinalResliceOptions,
  signal?: AbortSignal,
  runtime?: LongitudinalResliceRuntime,
): Promise<DenseLongitudinalResliceResult | LongitudinalRegistrationFailure> {
  return (await runLongitudinalWorker({ type: 'reslice', options: input }, signal, runtime)) as
    | DenseLongitudinalResliceResult
    | LongitudinalRegistrationFailure;
}
