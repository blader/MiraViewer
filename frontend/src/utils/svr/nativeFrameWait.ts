/** Release this consumer's owners without canceling or evicting a shared Cornerstone decode. */
export function waitForNativeFrame<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const cleanup = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
    };
    const fail = (error: unknown) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    };
    const abort = () => fail(new DOMException('Native frame loading cancelled.', 'AbortError'));
    const timer = setTimeout(
      () => fail(new Error('Native frame loading timed out after 30 seconds. Retry opening this source image.')),
      30_000,
    );
    signal?.addEventListener('abort', abort, { once: true });
    // Always handle the original promise, including when already canceled: a
    // late decode failure must not become an unhandled rejection.
    promise.then((value) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(value);
    }, fail);
    if (signal?.aborted) abort();
  });
}
