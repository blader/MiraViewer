import {
  registerAndResliceLongitudinal,
  resliceDenseLongitudinalPlane,
  longitudinalRegistrationFailure,
  type DenseLongitudinalResliceOptions,
  type DenseLongitudinalResliceResult,
  type LongitudinalRegistrationFailure,
  type LongitudinalRegistrationResult,
  type RegisterLongitudinalOptions,
} from './longitudinalRegistration';

export type LongitudinalWorkerOptions = Omit<RegisterLongitudinalOptions, 'signal'>;

export type LongitudinalWorkerRequest =
  | { type: 'run'; options: LongitudinalWorkerOptions }
  | { type: 'reslice'; options: Omit<DenseLongitudinalResliceOptions, 'signal'> }
  | { type: 'abort' };

export type LongitudinalWorkerResponse = {
  type: 'done';
  result: LongitudinalRegistrationResult | DenseLongitudinalResliceResult | LongitudinalRegistrationFailure;
};

let activeController: AbortController | null = null;

self.onmessage = async (event: MessageEvent<LongitudinalWorkerRequest>) => {
  if (event.data.type === 'abort') {
    activeController?.abort();
    return;
  }

  activeController?.abort();
  const controller = new AbortController();
  activeController = controller;

  try {
    const result =
      event.data.type === 'reslice'
        ? resliceDenseLongitudinalPlane({ ...event.data.options, signal: controller.signal })
        : await registerAndResliceLongitudinal({ ...event.data.options, signal: controller.signal });
    if (activeController !== controller) return;
    const message: LongitudinalWorkerResponse = { type: 'done', result };
    if (result.ok) {
      self.postMessage(message, { transfer: [result.pixels.buffer, result.valid.buffer] });
    } else {
      self.postMessage(message);
    }
  } catch (error) {
    if (activeController !== controller) return;
    const result = longitudinalRegistrationFailure(
      controller.signal.aborted ? 'cancelled' : 'registration-failed',
      controller.signal.aborted
        ? 'Longitudinal registration cancelled'
        : error instanceof Error
          ? error.message
          : String(error),
    );
    self.postMessage({ type: 'done', result } satisfies LongitudinalWorkerResponse);
  } finally {
    if (activeController === controller) activeController = null;
  }
};
