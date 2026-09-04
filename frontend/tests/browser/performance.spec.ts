import { expect, test } from '@playwright/test';
import { writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import type {} from './probes';
import { attachReceipt, capture } from './evidence';
import { measureSelectionEditing } from './selectionEditingWorkflow';
import { createSyntheticSvrDicomFiles } from '../svrSyntheticDicom';

test('backup capacity rejects oversized input and restores sparse below-limit payloads', async ({ page }, info) => {
  const errors: string[] = [];
  let downloads = 0;
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('download', () => downloads++);
  await page.goto('/');
  await page.getByRole('button', { name: 'Import scans', exact: true }).click();
  const intake = page.getByRole('dialog', { name: 'Import scans' });
  const files = await Promise.all(
    createSyntheticSvrDicomFiles({ imageSize: 8, slicesPerOrientation: 1, orientations: 1 }).map(async (file) => ({
      name: file.name,
      mimeType: file.type,
      buffer: Buffer.from(await file.arrayBuffer()),
    })),
  );
  await intake.getByLabel('Select DICOM image files').setInputFiles(files);
  await intake.getByRole('button', { name: 'Import scans', exact: true }).click();
  await expect(intake.getByText('Import complete', { exact: true })).toBeVisible();
  await intake.getByRole('button', { name: 'Done', exact: true }).click();
  const declaredModelBytes = await page.evaluate(async () => {
    // These are real native Blob sizes, composed from shared synthetic blocks,
    // not patched size getters or real ONNX weights. Export treats cached bytes
    // as opaque input; inference and large-file DICOM parsing are out of scope.
    const tile = new Blob([new Uint8Array(1024 * 1024).fill(0x5a)]);
    const blob = new Blob(Array.from({ length: 256 }, () => tile));
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open('MiraViewerDB');
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    try {
      const tx = db.transaction('models', 'readwrite');
      for (const key of ['synthetic-capacity-a', 'synthetic-capacity-b'])
        tx.objectStore('models').put({ key, blob, savedAtMs: 0 }, key);
      await new Promise<void>((resolve, reject) => {
        tx.oncomplete = () => resolve();
        tx.onabort = () => reject(tx.error);
      });
    } finally {
      db.close();
    }
    const work = { arrayBufferCalls: 0, streamCalls: 0, readBytes: 0 };
    const arrayBuffer = Blob.prototype.arrayBuffer,
      stream = Blob.prototype.stream;
    Blob.prototype.arrayBuffer = function () {
      if (this.size >= 1024 * 1024) {
        work.arrayBufferCalls++;
        work.readBytes += this.size;
      }
      return arrayBuffer.call(this);
    };
    Blob.prototype.stream = function () {
      if (this.size >= 1024 * 1024) {
        work.streamCalls++;
        work.readBytes += this.size;
      }
      return stream.call(this);
    };
    Object.assign(window, { backupCapacityWork: work });
    return blob.size * 2;
  });
  expect(declaredModelBytes).toBe(512 * 1024 * 1024);
  await page.getByRole('button', { name: 'Application menu' }).click();
  await page.getByRole('button', { name: 'Export backup (ZIP)' }).click();
  const exportDialog = page.getByRole('dialog', { name: 'Export Backup (ZIP)' });
  await exportDialog.getByRole('button', { name: 'Export', exact: true }).click();
  await expect(exportDialog.getByRole('alert')).toContainText('512 MiB safe restore limit');
  await expect(exportDialog.getByRole('alert')).toContainText('DICOM reimport alone does not restore saved work');
  const work = await page.evaluate(
    () =>
      (
        window as unknown as {
          backupCapacityWork: { arrayBufferCalls: number; streamCalls: number; readBytes: number };
        }
      ).backupCapacityWork,
  );
  expect(work).toEqual({ arrayBufferCalls: 0, streamCalls: 0, readBytes: 0 });
  expect(downloads).toBe(0);
  expect(errors).toEqual([]);
  await expect(exportDialog.getByRole('button', { name: 'Export', exact: true })).toBeEnabled();
  await capture(page, info, 'backup-capacity-desktop');
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(exportDialog.getByRole('button', { name: 'Export', exact: true })).toBeInViewport();
  await capture(page, info, 'backup-capacity-mobile');

  // The small form of the same highly compressible payload must also survive
  // the actual reader's expansion checks. Only these synthetic cache records
  // are changed; the imported DICOM and all ordinary app controls are retained.
  await page.setViewportSize({ width: 1440, height: 1000 });
  await exportDialog.getByRole('button', { name: 'Cancel', exact: true }).click();
  await page.evaluate(async () => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open('MiraViewerDB');
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    try {
      const tx = db.transaction('models', 'readwrite');
      tx.objectStore('models').put(
        { key: 'synthetic-capacity-a', blob: new Blob([new Uint8Array(1024 * 1024).fill(0x5a)]), savedAtMs: 0 },
        'synthetic-capacity-a',
      );
      tx.objectStore('models').delete('synthetic-capacity-b');
      await new Promise<void>((resolve, reject) => {
        tx.oncomplete = () => resolve();
        tx.onabort = () => reject(tx.error);
      });
    } finally {
      db.close();
    }
  });
  await page.getByRole('button', { name: 'Application menu' }).click();
  await page.getByRole('button', { name: 'Export backup (ZIP)' }).click();
  const downloaded = page.waitForEvent('download');
  await page.getByRole('dialog').getByRole('button', { name: 'Export', exact: true }).click();
  const download = await downloaded;
  const archive = info.outputPath('synthetic-sparse-backup.zip');
  await download.saveAs(archive);
  expect(await download.failure()).toBeNull();
  const context = await page.context().browser()!.newContext();
  let restored;
  try {
    const target = await context.newPage();
    target.on('pageerror', (error) => errors.push(error.message));
    await target.goto('http://127.0.0.1:43134/');
    await target.getByRole('button', { name: 'Import scans', exact: true }).click();
    const restore = target.getByRole('dialog', { name: 'Import scans' });
    await restore.getByLabel('Select a complete backup or image archive').setInputFiles(archive);
    await restore.getByRole('checkbox').check();
    await restore.getByRole('button', { name: 'Restore complete backup', exact: true }).click();
    await expect(restore.getByRole('button', { name: 'Done', exact: true })).toBeVisible();
    restored = await target.evaluate(async () => {
      const read = <T>(request: IDBRequest<T>) =>
        new Promise<T>((resolve, reject) => {
          request.onsuccess = () => resolve(request.result);
          request.onerror = () => reject(request.error);
        });
      const data = await read(indexedDB.open('MiraViewerDB'));
      try {
        const [instances, savedModels] = await Promise.all([
          read(data.transaction('instances').objectStore('instances').getAll()),
          read(data.transaction('models').objectStore('models').getAll()),
        ]);
        const pixels = await instances[0].fileBlob.arrayBuffer();
        const model = new Uint8Array(await savedModels[0].blob.arrayBuffer());
        return {
          images: instances.length,
          models: savedModels.map((row) => row.key),
          dicomSha256: Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', pixels)), (byte) =>
            byte.toString(16).padStart(2, '0'),
          ).join(''),
          modelBytes: model.byteLength,
          modelMatches: model.every((byte) => byte === 0x5a),
        };
      } finally {
        data.close();
      }
    });
    expect(restored).toEqual({
      images: 1,
      models: ['synthetic-capacity-a'],
      dicomSha256: createHash('sha256').update(files[0]!.buffer).digest('hex'),
      modelBytes: 1024 * 1024,
      modelMatches: true,
    });
  } finally {
    await context.close();
  }
  expect(errors).toEqual([]);
  await attachReceipt(info, 'backup-capacity-receipt', {
    build: await (await page.request.get('/browser-build.json')).json(),
    browser: page.context().browser()!.version(),
    declaredModelBytes,
    dicomBytes: files.reduce((sum, file) => sum + file.buffer.byteLength, 0),
    work,
    downloadsAfterRejection: 0,
    completedDownloads: downloads,
    restored,
    errors,
    scope:
      'Normal production export UI. One imported synthetic DICOM and two composed native Blob cache records. No virtual size getters, private data, real model weights, inference, or claim of 512 MiB resident allocation. Oversized rejection precedes any large payload read; a 1 MiB sparse model then round-trips through export and fresh-context restore with exact source bytes.',
  });
});

test('sparse brush edits preserve durable history without rebuilding grayscale or copying whole masks', async ({
  page,
}, info) => {
  const result = await measureSelectionEditing(page, info);
  for (const { work } of result.measurements) {
    expect(work.draftRasterAllocations).toBe(0);
    expect(work.fullMaskSliceCalls).toBe(0);
    expect(work.wholeMaskResets).toBe(0);
    expect(work.failedSaves).toBe(0);
    expect(work.completedSaves).toBe(1);
    expect(work.persistedLabelBytes).toBeLessThan(result.initial.labelBytes / 4);
  }
});

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
