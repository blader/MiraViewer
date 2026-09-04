/** Bound observation of an async image operation; underlying non-cancellable decoders may still settle later. */
export const IMAGE_ID_LOOKUP_TIMEOUT_MS = 10_000;
export const IMAGE_LOAD_TIMEOUT_MS = 30_000;

export function waitForBoundedOperation<T>(
  promise: Promise<T>,
  options: { signal?: AbortSignal; timeoutMs: number; label: string },
): Promise<T> {
  const { signal, timeoutMs, label } = options;
  if (signal?.aborted) return Promise.reject(new Error(`${label} cancelled`));

  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const cleanup = () => {
      window.clearTimeout(timer);
      signal?.removeEventListener('abort', handleAbort);
    };
    const rejectOnce = (error: Error) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    };
    const handleAbort = () => rejectOnce(new Error(`${label} cancelled`));
    const timer = window.setTimeout(
      () => rejectOnce(new Error(`${label} timed out after ${Math.round(timeoutMs / 1000)}s`)),
      timeoutMs,
    );

    signal?.addEventListener('abort', handleAbort, { once: true });
    promise.then(
      (value) => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve(value);
      },
      (error) => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(error);
      },
    );
  });
}
