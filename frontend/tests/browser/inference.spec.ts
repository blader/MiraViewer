import { expect, test } from '@playwright/test';
import { writeFile } from 'node:fs/promises';
import type {} from './probes';
import { attachReceipt } from './evidence';

test('128-cube custom inference admits real 20 MiB weights and records renderer memory high-water', async ({
  page,
}, info) => {
  const cdp = await page.context().newCDPSession(page);
  const traceEvents: Array<{
    name?: string;
    pid?: number;
    tid?: number;
    ts?: number;
    args?: { name?: string; dumps?: { process_totals?: Record<string, string> } };
  }> = [];
  const workers: { closed: boolean }[] = [];
  const samplingErrors: string[] = [];
  const samples: { dumpGuid: string; success: boolean }[] = [];
  let pending: Promise<void> | undefined;
  const sample = () => {
    if (pending) return pending;
    pending = cdp
      .send('Tracing.requestMemoryDump', { levelOfDetail: 'light', deterministic: false })
      .then((result) => {
        samples.push(result);
      })
      .catch((error) => {
        samplingErrors.push(String(error));
      })
      .finally(() => {
        pending = undefined;
      });
    return pending;
  };
  page.on('worker', (worker) => {
    const record = { closed: false };
    workers.push(record);
    worker.on('close', () => {
      record.closed = true;
    });
    void worker
      .evaluate(() => performance.mark('custom-model-calibration:worker'))
      .catch((error) => samplingErrors.push(String(error)));
  });
  await page.goto('/tests/browser/probes.html');
  await page.waitForFunction(() => Boolean(window.miraProbes));
  cdp.on('Tracing.dataCollected', ({ value }) => traceEvents.push(...value));
  await cdp.send('Tracing.start', {
    categories: 'disabled-by-default-memory-infra,blink.user_timing',
    transferMode: 'ReportEvents',
  });
  await sample();
  const timer = setInterval(() => {
    void sample();
  }, 100);
  let result: Awaited<ReturnType<typeof window.miraProbes.measureCustomModel>> | undefined;
  try {
    result = await page.evaluate(() => window.miraProbes.measureCustomModel(false, true));
    await expect.poll(() => workers.length > 0 && workers.every((worker) => worker.closed)).toBe(true);
    expect(result.error).toBeNull();
    expect(result.size).toBe(128);
    expect(result.modelBytes).toBeGreaterThanOrEqual(20 * 1024 ** 2);
    expect(result.outputCount).toBe(128 ** 3);
    expect(result.mismatches).toBe(0);
    expect(result.sourceUnchanged).toBe(true);
  } finally {
    clearInterval(timer);
    await pending;
    await sample();
    const complete = new Promise<void>((resolve) => cdp.once('Tracing.tracingComplete', () => resolve()));
    await cdp.send('Tracing.end');
    await complete;
    const tracePath = info.outputPath('custom-model-memory-trace.json');
    await writeFile(tracePath, JSON.stringify({ traceEvents }));
    const workerPids = [
      ...new Set(
        traceEvents.filter((event) => event.name === 'custom-model-calibration:worker').map((event) => event.pid),
      ),
    ];
    const memory = traceEvents
      .filter((event) => workerPids.includes(event.pid) && event.args?.dumps?.process_totals)
      .map((event) => ({
        pid: event.pid,
        timestampMicroseconds: event.ts,
        bytes: Object.fromEntries(
          Object.entries(event.args!.dumps!.process_totals!)
            .filter(([key, value]) => key.endsWith('_bytes') && /^[0-9a-f]+$/i.test(value))
            .map(([key, value]) => [key, Number.parseInt(value, 16)]),
        ),
      }));
    await attachReceipt(info, 'custom-model-calibration-receipt', {
      ...(await (await page.request.get('/browser-build.json')).json()),
      browser: page.context().browser()!.version(),
      result,
      workers,
      workerPids,
      memory,
      samples,
      samplingErrors,
      scope:
        'Synthetic pointwise label oracle with a data-dependent 20 MiB Gather initializer, actual ORT/WASM worker. 100-ms requested Chromium memory dumps measure the whole worker-host renderer, including its page; they are sampled process high-water, not isolated worker allocation, guaranteed instantaneous peak or arbitrary-model admission proof. Tracing overhead is included.',
    });
    await cdp.detach();
    expect(workerPids).toHaveLength(1);
    expect(memory.some((sample) => sample.bytes.private_footprint_bytes! > 0)).toBe(true);
  }
});

test('custom-model workers execute a real oracle, stop during a slow graph, and recover locally', async ({
  page,
}, info) => {
  const workers: { url: string; closed: boolean }[] = [];
  page.on('worker', (worker) => {
    const observation = { url: worker.url(), closed: false };
    workers.push(observation);
    worker.on('close', () => {
      observation.closed = true;
    });
  });
  await page.goto('/tests/browser/probes.html');
  await page.waitForFunction(() => Boolean(window.miraProbes));
  const runs = [];
  try {
    for (const cancel of [false, true, false]) {
      const result = await page.evaluate((cancel) => window.miraProbes.measureCustomModel(cancel), cancel);
      runs.push(result);
      await expect.poll(() => workers.every((worker) => worker.closed)).toBe(true);
      expect(result.sourceUnchanged).toBe(true);
      expect(result.animationCallbacks).toBeGreaterThan(0);
      if (cancel) {
        expect(result.inferenceStartedAt).not.toBeNull();
        expect(result.cancelAt! - result.inferenceStartedAt!).toBeGreaterThanOrEqual(90);
        expect(result.error?.name).toBe('AbortError');
        expect(result.cancelToReturnMs).toBeLessThan(1000);
        expect(result.outputCount).toBe(0);
      } else {
        expect(result.error).toBeNull();
        expect(result.mismatches).toBe(0);
        expect(result.outputCount).toBe(result.size ** 3);
      }
    }
    expect(workers.filter((worker) => /customModel\.worker/.test(worker.url))).toHaveLength(3);
  } finally {
    await attachReceipt(info, 'custom-model-receipt', {
      ...(await (await page.request.get('/browser-build.json')).json()),
      browser: page.context().browser()!.version(),
      runs,
      workers,
      scope:
        'Synthetic pointwise label oracle and 48-layer convolution workload, actual vendored ORT/WASM and fresh workers, cancellation 100 ms after inference-start notification; no clinical accuracy claim or hard allocator-limit claim.',
    });
  }
});

test('real pinned inference completes both directions, reuses sessions, works offline, cancels and recovers', async ({
  page,
}, info) => {
  const workers: Array<{ url: string; closed: boolean }> = [];
  page.on('worker', (worker) => {
    const state = { url: worker.url(), closed: false };
    workers.push(state);
    worker.on('close', () => {
      state.closed = true;
    });
  });
  await page.goto('/tests/browser/probes.html');
  await page.waitForFunction(() => Boolean(window.miraProbes));
  const build = await (await page.request.get('/browser-build.json')).json();
  const runs: Awaited<ReturnType<typeof window.miraProbes.measureInteractiveInference>>[] = [];
  let canceled: Awaited<ReturnType<typeof window.miraProbes.measureInteractiveInference>> | null = null;
  let retained: Awaited<ReturnType<typeof window.miraProbes.measureRetainedInteractiveInference>> | null = null;
  let corrected: Awaited<ReturnType<typeof window.miraProbes.measureInteractiveInference>> | null = null;
  let blockedAssetRequests = 0;
  try {
    expect(await page.evaluate(() => crossOriginIsolated)).toBe(true);
    runs.push(await page.evaluate(() => window.miraProbes.measureInteractiveInference()));
    expect(runs[0]!.error).toBeNull();
    await expect.poll(() => workers.every((worker) => worker.closed)).toBe(true);

    // A new worker cannot reuse prior sessions. It must verify its IndexedDB
    // model bytes successfully without access to their delivery URLs.
    await page.context().route('**/models/**', (route) => {
      blockedAssetRequests++;
      return route.abort();
    });
    canceled = await page.evaluate(() => window.miraProbes.measureInteractiveInference(true));
    expect(canceled.error?.name).toBe('AbortError');
    expect(canceled.cancelToReleaseMs).not.toBeNull();
    expect(canceled.result).toBeNull();
    await expect.poll(() => workers.every((worker) => worker.closed)).toBe(true);
    runs.push(await page.evaluate(() => window.miraProbes.measureInteractiveInference()));
    await expect.poll(() => workers.every((worker) => worker.closed)).toBe(true);

    for (const run of runs) {
      expect(run.error).toBeNull();
      expect(run.result?.completedFrames).toBe(4);
      expect(run.frames.map(({ index, direction }) => [index, direction])).toEqual([
        [1, 1],
        [2, 1],
        [1, -1],
        [0, -1],
      ]);
      expect(run.timings.filter((timing) => timing.stage === 'session-init')).toHaveLength(4);
      expect(
        new Set(run.timings.filter((timing) => timing.stage === 'graph-run').map((timing) => timing.asset)),
      ).toEqual(new Set(['encoder', 'decoder', 'memoryAttention', 'memoryEncoder']));
      expect(run.animationCallbacks).toBeGreaterThan(0);
      expect(run.sourceUnchanged).toBe(true);
      expect(run.ownedInputBytes).toBe(32 * 32 * 3 * 4);
    }
    expect(runs[1]!.frames).toEqual(runs[0]!.frames);
    expect(canceled.sourceUnchanged).toBe(true);
    retained = await page.evaluate(() => window.miraProbes.measureRetainedInteractiveInference());
    expect(retained.runs).toHaveLength(2);
    await expect.poll(() => workers.every((worker) => worker.closed)).toBe(true);
    corrected = await page.evaluate(() => window.miraProbes.measureInteractiveInference(false, true));
    expect(corrected.error).toBeNull();
    expect(corrected.fixture.conditioningFrames).toBe(3);
    expect(corrected.timings.filter((timing) => timing.stage === 'session-init')).toHaveLength(4);
    for (const [index, run] of retained.runs.entries()) {
      expect(run.error).toBeNull();
      expect(run.result?.completedFrames).toBe(4);
      expect(run.frames).toEqual(index === 0 ? runs[0]!.frames : corrected.frames);
      expect(run.fixture.conditioningFrames).toBe(index === 0 ? 2 : 3);
      expect(run.sourceUnchanged).toBe(true);
      expect(run.timings.filter((timing) => timing.stage === 'session-init')).toHaveLength(index === 0 ? 4 : 0);
      expect(run.timings.some((timing) => timing.stage === 'graph-run')).toBe(true);
      expect(run.retainedRuntimeAllowanceBytes).toBeGreaterThan(0);
    }
    expect(retained.runs[0]!.memoryEstimate.retainedRuntimeBytes).toBe(0);
    expect(retained.runs[1]!.memoryEstimate.retainedRuntimeBytes).toBe(retained.runs[0]!.retainedRuntimeAllowanceBytes);
    expect(retained.releasedRuntimeAllowanceBytes).toBe(0);
    await expect.poll(() => workers.every((worker) => worker.closed)).toBe(true);
    expect(blockedAssetRequests).toBe(0);
    expect(workers.filter((worker) => /interactiveTracking\.worker/.test(worker.url))).toHaveLength(5);
  } finally {
    await attachReceipt(info, 'inference-receipt', {
      ...build,
      browserVersion: page.context().browser()!.version(),
      provider: 'wasm',
      wasmThreads: 1,
      evidence:
        'Actual pinned model and worker; complete synthetic prompt snapshots, retained-session parity, verified offline bytes, cancellation and fresh-worker recovery. Not anatomical accuracy, measured peak memory, a normal-editor workflow or in-kernel cancellation proof.',
      runs,
      canceled,
      retained,
      corrected,
      blockedAssetRequests,
      workers,
    });
  }
});
