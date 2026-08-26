import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getImageIdForInstance: vi.fn(),
  loadImage: vi.fn(),
}));

vi.mock('../src/utils/localApi', () => ({
  getImageIdForInstance: mocks.getImageIdForInstance,
}));

vi.mock('cornerstone-core', () => ({
  default: {
    loadImage: mocks.loadImage,
  },
}));

import { renderSliceToPixels } from '../src/utils/cornerstoneSliceCapture';

function pendingPromise<T>(): Promise<T> {
  return new Promise<T>(() => undefined);
}

describe('renderSliceToPixels cancellation and timeouts', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  test('rejects promptly when lookup is aborted', async () => {
    mocks.getImageIdForInstance.mockReturnValue(pendingPromise<string>());
    const controller = new AbortController();
    const capture = renderSliceToPixels('series', 7, 128, {
      signal: controller.signal,
    });

    controller.abort();

    const outcome = await Promise.race([
      capture.then(
        () => 'resolved',
        (error: unknown) => error,
      ),
      new Promise<'still-pending'>((resolve) => window.setTimeout(() => resolve('still-pending'), 0)),
    ]);
    expect(outcome).toBeInstanceOf(Error);
    expect((outcome as Error).message).toMatch(/lookup.*cancelled/i);
    expect(mocks.loadImage).not.toHaveBeenCalled();
  });

  test('bounds a stalled image-id lookup', async () => {
    vi.useFakeTimers();
    mocks.getImageIdForInstance.mockReturnValue(pendingPromise<string>());
    let outcome: unknown = 'still-pending';
    void renderSliceToPixels('series', 7).then(
      () => {
        outcome = 'resolved';
      },
      (error: unknown) => {
        outcome = error;
      },
    );

    await vi.advanceTimersByTimeAsync(10_000);

    expect(outcome).toBeInstanceOf(Error);
    expect((outcome as Error).message).toMatch(/lookup.*timed out/i);
    expect(mocks.loadImage).not.toHaveBeenCalled();
  });

  test('rejects promptly when image loading is aborted', async () => {
    mocks.getImageIdForInstance.mockResolvedValue('miradb:instance');
    mocks.loadImage.mockReturnValue(pendingPromise());
    const controller = new AbortController();
    const capture = renderSliceToPixels('series', 7, 128, {
      signal: controller.signal,
    });
    await vi.waitFor(() => expect(mocks.loadImage).toHaveBeenCalledTimes(1));

    controller.abort();

    const outcome = await Promise.race([
      capture.then(
        () => 'resolved',
        (error: unknown) => error,
      ),
      new Promise<'still-pending'>((resolve) => window.setTimeout(() => resolve('still-pending'), 0)),
    ]);
    expect(outcome).toBeInstanceOf(Error);
    expect((outcome as Error).message).toMatch(/load.*cancelled/i);
  });

  test('bounds a stalled Cornerstone image load', async () => {
    vi.useFakeTimers();
    mocks.getImageIdForInstance.mockResolvedValue('miradb:instance');
    mocks.loadImage.mockReturnValue(pendingPromise());
    let outcome: unknown = 'still-pending';
    void renderSliceToPixels('series', 7).then(
      () => {
        outcome = 'resolved';
      },
      (error: unknown) => {
        outcome = error;
      },
    );
    await Promise.resolve();

    await vi.advanceTimersByTimeAsync(30_000);

    expect(outcome).toBeInstanceOf(Error);
    expect((outcome as Error).message).toMatch(/load.*timed out/i);
  });

  test('reads modality-scaled source pixels without rendering or quantizing the display', async () => {
    mocks.getImageIdForInstance.mockResolvedValue('miradb:instance');
    mocks.loadImage.mockResolvedValue({
      imageId: 'wadouri:decoded-instance',
      rows: 2,
      columns: 2,
      slope: 2,
      intercept: -100,
      getPixelData: () => new Uint16Array([100, 512, 1000, 4095]),
    });

    const result = await renderSliceToPixels('series', 0, 2);

    expect(Array.from(result.pixels)).toEqual([100, 924, 1900, 8090]);
    expect(result.imageId).toBe('miradb:instance');
    expect(result.timingMs.capture).toBeGreaterThanOrEqual(0);
  });

  test('carries stored-domain padding support through registration capture', async () => {
    mocks.getImageIdForInstance.mockResolvedValue('miradb:instance');
    mocks.loadImage.mockResolvedValue({
      imageId: 'miradb:instance',
      rows: 2,
      columns: 2,
      slope: 2,
      intercept: 1000,
      pixelPaddingValue: -2000,
      getPixelData: () => Int16Array.from([-2000, 100, 200, -2000]),
    });

    const result = await renderSliceToPixels('series', 0, 2);

    expect(Array.from(result.pixels)).toEqual([0, 1200, 1400, 0]);
    expect(Array.from(result.validity ?? [])).toEqual([0, 1, 1, 0]);
  });
});
