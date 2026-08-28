import { afterEach, describe, expect, it, vi } from 'vitest';
import { waitForNativeFrame } from '../src/utils/svr/nativeFrameWait';

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('bounded native-frame consumer lifetime', () => {
  it.each(['resolve', 'reject'] as const)('cleans its timer and abort listener on decode %s', async (outcome) => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const remove = vi.spyOn(controller.signal, 'removeEventListener');
    const result = waitForNativeFrame(
      outcome === 'resolve' ? Promise.resolve(17) : Promise.reject(new Error('Bad frame')),
      controller.signal,
    );
    if (outcome === 'resolve') await expect(result).resolves.toBe(17);
    else await expect(result).rejects.toThrow('Bad frame');
    expect(vi.getTimerCount()).toBe(0);
    expect(remove).toHaveBeenCalledWith('abort', expect.any(Function));
  });

  it('rejects a stalled frame on abort without advancing time or waiting for the decoder', async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const result = waitForNativeFrame(new Promise<never>(() => {}), controller.signal);
    const rejected = expect(result).rejects.toMatchObject({ name: 'AbortError' });
    controller.abort();
    await rejected;
    expect(vi.getTimerCount()).toBe(0);
    await expect(waitForNativeFrame(Promise.resolve('retry'))).resolves.toBe('retry');
    expect(vi.getTimerCount()).toBe(0);
  });

  it('times out after 30 seconds and removes its abort listener', async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const remove = vi.spyOn(controller.signal, 'removeEventListener');
    const result = waitForNativeFrame(new Promise<never>(() => {}), controller.signal);
    let completed = false;
    void result.then(
      () => {
        completed = true;
      },
      () => {
        completed = true;
      },
    );
    const rejected = expect(result).rejects.toThrow(/timed out after 30 seconds.*Retry/);
    await vi.advanceTimersByTimeAsync(29_999);
    expect(completed).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await rejected;
    expect(completed).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
    expect(remove).toHaveBeenCalledWith('abort', expect.any(Function));
  });

  it.each(['resolve', 'reject'] as const)(
    'ignores late decode %s after cancellation, including pre-aborted calls',
    async (outcome) => {
      vi.useFakeTimers();
      const controller = new AbortController();
      controller.abort();
      let settle!: (value: number | Error) => void;
      const original = new Promise<number>((resolve, reject) => {
        settle = outcome === 'resolve' ? (value) => resolve(value as number) : reject;
      });
      const publish = vi.fn();
      const result = waitForNativeFrame(original, controller.signal).then(publish);
      await expect(result).rejects.toMatchObject({ name: 'AbortError' });
      settle(outcome === 'resolve' ? 42 : new Error('Late decoder failure'));
      await Promise.resolve();
      expect(publish).not.toHaveBeenCalled();
      expect(vi.getTimerCount()).toBe(0);
    },
  );
});
