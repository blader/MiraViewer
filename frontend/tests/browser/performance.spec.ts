import { expect, test } from '@playwright/test';
import { writeFile } from 'node:fs/promises';
import type {} from './probes';
import { attachReceipt } from './evidence';

test('coarse pose-only workers preserve physical evidence without returning a discarded image', async ({
  page,
}, info) => {
  await page.goto('/tests/browser/probes.html');
  await page.waitForFunction(() => Boolean(window.miraProbes));
  const measurements = [];
  for (const output of ['image', 'estimate', 'estimate', 'image', 'estimate', 'image'] as const) {
    measurements.push(await page.evaluate((mode) => window.miraProbes.measureCoarseRegistration(mode), output));
  }
  for (const measurement of measurements) {
    expect(measurement.evidence).toEqual(measurements[0]!.evidence);
    expect(measurement.outputBytes).toBe(measurement.output === 'image' ? 512 * 512 * 5 : 0);
  }
  await attachReceipt(info, 'coarse-estimate-receipt', {
    ...(await (await page.request.get('/browser-build.json')).json()),
    browser: page.context().browser()!.version(),
    measurements,
    fixture:
      'Same asymmetric physical phantom as the mathematical oracle; real fresh module workers; 512-square output lattice.',
    scope: 'Coarse complete-call timing and transferred output. Not full alignment latency or anatomical validation.',
  });
});

test('final affine scoring preserves results, frees the UI thread, and terminates during ranking', async ({
  page,
}, info) => {
  const workers = new Map<string, { closed: boolean }>();
  page.on('worker', (worker) => {
    const state = { closed: false };
    workers.set(`${workers.size}:${worker.url()}`, state);
    worker.on('close', () => {
      state.closed = true;
    });
  });
  await page.goto('/tests/browser/probes.html');
  await page.waitForFunction(() => Boolean(window.miraProbes));
  const cdp = await page.context().newCDPSession(page);
  const traceEvents: Array<{ name?: string; pid?: number; tid?: number; args?: unknown }> = [];
  cdp.on('Tracing.dataCollected', ({ value }) => traceEvents.push(...value));
  await cdp.send('Tracing.start', {
    categories: 'devtools.timeline,v8.execute,blink.user_timing,disabled-by-default-v8.cpu_profiler',
    transferMode: 'ReportEvents',
  });
  try {
    const measurements = [];
    for (const mode of ['inline', 'worker', 'worker', 'inline'] as const)
      measurements.push(await page.evaluate((selected) => window.miraProbes.measureFinalScoring(selected), mode));
    const cancelled = await page.evaluate(() => window.miraProbes.cancelFinalScoring());
    await expect.poll(() => [...workers.values()].every((worker) => worker.closed)).toBe(true);
    const tracingComplete = new Promise<void>((resolve) => cdp.once('Tracing.tracingComplete', () => resolve()));
    await cdp.send('Tracing.end');
    await tracingComplete;
    const tracePath = info.outputPath('final-scoring-trace.json');
    await writeFile(tracePath, JSON.stringify({ traceEvents }));
    await info.attach('final-scoring-trace', { path: tracePath, contentType: 'application/json' });
    const build = await (await page.request.get('/browser-build.json')).json();
    const workerMarks = traceEvents.filter((event) => event.name === 'alignment-final-scoring:start');
    const mainMarks = traceEvents.filter((event) => event.name === 'probe-final-inline:start');
    await attachReceipt(info, 'final-scoring-receipt', {
      ...build,
      browserVersion: page.context().browser()!.version(),
      workload: '256-square structural ranking, seed plus one affine; alternating order, each worker newly initialized',
      evidence: 'synthetic scoring boundary and main-thread responsiveness; not full alignment or hardware performance',
      measurements,
      cancelled,
      workers: [...workers],
      mainThreads: mainMarks.map(({ pid, tid }) => ({ pid, tid })),
      scoringThreads: workerMarks.map(({ pid, tid }) => ({ pid, tid })),
    });
    for (const result of measurements) {
      expect(result.selection).toEqual(measurements[0]!.selection);
      expect(result.ownedInputBytes).toBe(256 * 256 * 16);
      if (result.mode === 'worker') expect(result.framesWhileScoring).toBeGreaterThan(0);
    }
    expect(workers.size).toBe(3);
    expect(workerMarks.length).toBeGreaterThanOrEqual(2);
    expect(mainMarks.length).toBe(2);
    for (const mark of workerMarks)
      expect(mainMarks.some((main) => main.pid === mark.pid && main.tid === mark.tid)).toBe(false);
    expect(cancelled).toMatchObject({ started: true, published: false, ownedInputBytes: 512 * 512 * 16 });
    expect(cancelled.rejection).toContain('cancelled');
  } finally {
    await cdp.detach();
  }
});

test('maximum-size derived-frame eviction and sequence hydration avoid unrelated pixel clones', async ({
  page,
}, info) => {
  await page.goto('/tests/browser/probes.html');
  await page.waitForFunction(() => Boolean(window.miraProbes));
  const result = await page.evaluate(() => window.miraProbes.measureDerivedStorage());
  const build = await (await page.request.get('/browser-build.json')).json();
  await attachReceipt(info, 'derived-storage-receipt', {
    ...build,
    browserVersion: page.context().browser()!.version(),
    ...result,
  });
  expect(result.oldBookkeepingQuery.reads).toEqual([
    { index: 'by-created-at', records: 32, pixelAndSupportBytes: 160 * 1024 ** 2 },
  ]);
  expect(result.save.reads).toEqual([]);
  expect(result.save.keyReads).toBe(1);
  expect(result.retained.sort()).toEqual(Array.from({ length: 32 }, (_, i) => `frame-${i + 1}`).sort());
  expect(result.selectedHydration.result).toEqual(result.oldHydrationQuery.result);
  expect(result.oldHydrationQuery.reads).toEqual([
    { index: 'by-patient', records: 32, pixelAndSupportBytes: 160 * 1024 ** 2 },
  ]);
  for (const hydration of [result.selectedHydration, result.sequenceSwitch]) {
    expect(hydration.result).toHaveLength(8);
    expect(hydration.reads).toEqual([
      { index: 'by-patient-revision-source', records: 8, pixelAndSupportBytes: 40 * 1024 ** 2 },
    ]);
  }
});
