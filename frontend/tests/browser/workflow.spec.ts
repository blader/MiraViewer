import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { createSyntheticSvrDicomFiles } from '../svrSyntheticDicom';
import { attachReceipt, capture } from './evidence';
import type { DicomInstance } from '../../src/db/schema';
import type { VolumeSegmentationRow } from '../../src/db/schema';
import { createSyntheticCustomModel } from '../helpers/customTumorModel';

declare global {
  interface Window {
    replayWorkerStarts: number;
    customInferenceStarted: boolean;
    finishPanelWriteAudit: () => { writeStores: string[][]; sourceCatalogReads: number };
    alignmentRequests: {
      type: string;
      study: string;
      started: number;
      finished?: number;
      outputBytes?: number;
      ok?: boolean;
    }[];
  }
}

async function readSaved(page: Page) {
  return page.evaluate(async () => {
    const read = <T>(request: IDBRequest<T>) =>
      new Promise<T>((resolve, reject) => {
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
    const db = await read(indexedDB.open('MiraViewerDB'));
    try {
      const transaction = db.transaction(['studies', 'instances', 'tumor_ground_truth', 'panel_settings']);
      const [studies, instances, outlines, settings] = await Promise.all([
        read(transaction.objectStore('studies').getAllKeys()),
        read(transaction.objectStore('instances').count()),
        read(transaction.objectStore('tumor_ground_truth').getAll()),
        read(transaction.objectStore('panel_settings').getAll()),
      ]);
      return { studies, instances, outlines, settings };
    } finally {
      db.close();
    }
  });
}

async function expectAcquiredPixels(page: Page) {
  const canvas = page.locator('[data-diagnostic-surface] canvas').first();
  await expect(canvas).toBeVisible();
  await expect
    .poll(() =>
      canvas.evaluate((element) => {
        const canvas = element as HTMLCanvasElement;
        const context = canvas.getContext('2d');
        if (!context || !canvas.width || !canvas.height) return 0;
        const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
        const levels = new Set<number>();
        for (let i = 0; i < pixels.length; i += 16) levels.add(pixels[i]!);
        return levels.size;
      }),
    )
    .toBeGreaterThan(5);
}

async function goToSlice(page: Page, slice: number) {
  const field = page.getByRole('spinbutton', { name: 'Go to slice' });
  await field.fill(String(slice));
  await field.press('Enter');
  await expect(page.getByRole('group', { name: `Pan MRI slice ${slice}`, exact: true }).first()).toBeVisible();
}

async function importComparisonExaminations(
  page: Page,
  pixelPaddingValue: 0 | null,
  examinations = [
    { studyUid: '1.2.826.0.1.3680043.10.543.20350701.1', studyDate: '20350701' },
    { studyUid: '1.2.826.0.1.3680043.10.543.20360701.1', studyDate: '20360701' },
  ],
  nativeOnly = false,
) {
  await page.goto('/');
  await page.getByRole('button', { name: 'Import scans', exact: true }).click();
  const files = (
    await Promise.all(
      examinations.map(async (examination, index) =>
        Promise.all(
          createSyntheticSvrDicomFiles({
            imageSize: 36,
            slicesPerOrientation: 24,
            pixelPaddingValue,
            ...examination,
          })
            .filter((file) => !nativeOnly || file.name.startsWith('synthetic-svr-0-'))
            .map(async (file) => ({
              name: `exam-${index}-${file.name}`,
              mimeType: file.type,
              buffer: Buffer.from(await file.arrayBuffer()),
            })),
        ),
      ),
    )
  ).flat();
  const intake = page.getByRole('dialog', { name: 'Import scans' });
  await intake.getByLabel('Select DICOM image files').setInputFiles(files);
  await intake.getByRole('button', { name: 'Import scans', exact: true }).click();
  await expect(intake.getByText('Import complete', { exact: true })).toBeVisible();
  await intake.getByRole('button', { name: 'Done', exact: true }).click();
  await goToSlice(page, 12);
  return files.length;
}

async function savedVolumeSelection(page: Page) {
  return page.evaluate(async () => {
    const read = <T>(request: IDBRequest<T>) =>
      new Promise<T>((resolve, reject) => {
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
    const db = await read(indexedDB.open('MiraViewerDB'));
    try {
      const rows = (await read(
        db.transaction('volume_segmentations').objectStore('volume_segmentations').getAll(),
      )) as VolumeSegmentationRow[];
      return await Promise.all(
        rows.map(async (row) => ({
          volumeKey: row.volumeKey,
          dims: row.dims,
          modelKey: row.modelKey,
          reviewState: row.reviewState,
          selectedCount: row.labels.reduce((count, label) => count + Number(label > 0), 0),
          labelsSha256: Array.from(
            new Uint8Array(await crypto.subtle.digest('SHA-256', Uint8Array.from(row.labels))),
            (value) => value.toString(16).padStart(2, '0'),
          ).join(''),
        })),
      );
    } finally {
      db.close();
    }
  });
}

test('normal custom-model controls save a real draft, cancel and replace active workers, and reopen unchanged', async ({
  page,
}, info) => {
  const errors: string[] = [],
    workers: { url: string; closed: boolean }[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('worker', (worker) => {
    if (!/customModel\.worker/.test(worker.url())) return;
    const record = { url: worker.url(), closed: false };
    workers.push(record);
    worker.on('close', () => {
      record.closed = true;
    });
  });
  await page.addInitScript(() => {
    const NativeWorker = window.Worker;
    window.Worker = class extends NativeWorker {
      constructor(url: string | URL, options?: WorkerOptions) {
        super(url, options);
        if (String(url).includes('customModel.worker'))
          this.addEventListener('message', (event) => {
            if (event.data?.type === 'inference') window.customInferenceStarted = true;
          });
      }
    };
  });
  await importComparisonExaminations(
    page,
    null,
    [{ studyDate: '20370101', studyUid: '1.2.826.0.1.3680043.10.543.20370101.1' }],
    true,
  );
  const openVolume = async () => {
    await page.getByRole('button', { name: '3D', exact: true }).click();
    await page.getByRole('button', { name: 'Open 3D volume', exact: true }).click();
    await expect(page.getByRole('region', { name: 'Region selection workspace' })).toBeVisible();
  };
  await openVolume();
  await page.getByRole('button', { name: 'Show 3D settings', exact: true }).click();
  const custom = page.locator('details').filter({ has: page.locator('summary', { hasText: /^Custom model$/ }) });
  await custom.locator('summary').first().click();
  const upload = async (kind: 'small' | 'slow') => {
    const files = await createSyntheticCustomModel(kind);
    await custom.locator('input[type=file]').setInputFiles(
      await Promise.all(
        files.map(async (file) => ({
          name: file.name,
          mimeType: file.type,
          buffer: Buffer.from(await file.arrayBuffer()),
        })),
      ),
    );
    await expect(custom.getByRole('button', { name: 'Suggest with model' })).toBeEnabled();
  };
  const start = async () => {
    await page.evaluate(() => {
      window.customInferenceStarted = false;
    });
    await custom.getByRole('button', { name: 'Suggest with model' }).click();
    await page.waitForFunction(() => window.customInferenceStarted);
  };
  await upload('small');
  await start();
  await expect(page.getByRole('status').filter({ hasText: /Segmentation complete.*runtime released/ })).toBeVisible();
  await expect.poll(async () => (await savedVolumeSelection(page))[0]?.selectedCount ?? 0).toBeGreaterThan(0);
  const draft = await savedVolumeSelection(page);
  expect(draft[0]!.modelKey).toBe('brats-tumor-v1');
  expect(draft[0]!.reviewState).toBe('draft');
  await expect.poll(() => workers.every((worker) => worker.closed)).toBe(true);

  await upload('slow');
  await start();
  const cancelStarted = performance.now();
  await page.getByRole('button', { name: 'Cancel model suggestion' }).click();
  await expect(custom.getByRole('button', { name: 'Suggest with model' })).toBeEnabled();
  await expect.poll(() => workers.every((worker) => worker.closed)).toBe(true);
  const cancelToReadyMs = performance.now() - cancelStarted;
  await expect(
    page.getByRole('status').filter({ hasText: /Model suggestion canceled.*worker was stopped/ }),
  ).toBeInViewport();
  expect(await savedVolumeSelection(page)).toEqual(draft);
  await capture(page, info, 'custom-model-canceled-desktop');

  // The ordinary reconstruction action must also retire custom inference before
  // admitting another source image, not wait for its React busy-state effect.
  await start();
  await page.getByRole('button', { name: 'Show reconstruction sources and controls' }).click();
  await page.getByRole('button', { name: 'Open 3D volume', exact: true }).click();
  await expect.poll(() => workers.every((worker) => worker.closed)).toBe(true);
  await expect(page.getByRole('button', { name: 'Show reconstruction sources and controls' })).toBeVisible();
  await expect(page.getByRole('region', { name: 'Region selection workspace' })).toBeVisible();
  expect(await savedVolumeSelection(page)).toEqual(draft);
  await page.reload();
  await openVolume();
  await expect.poll(async () => (await savedVolumeSelection(page))[0]?.labelsSha256).toBe(draft[0]!.labelsSha256);
  expect(errors).toEqual([]);
  expect(workers.length).toBeGreaterThanOrEqual(3);
  await attachReceipt(info, 'custom-model-workflow-receipt', {
    ...(await (await page.request.get('/browser-build.json')).json()),
    browser: page.context().browser()!.version(),
    draft,
    reopened: await savedVolumeSelection(page),
    cancelToReadyMs,
    workers,
    errors,
    scope:
      'Normal production UI, synthetic native DICOM and real synthetic ONNX graphs. Draft persistence, explicit cancel, ordinary reconstruction replacement, worker retirement and reload. No anatomical accuracy claim.',
  });
});

test('imports, navigates, annotates, reopens, and restores a complete synthetic backup', async ({
  page,
  browser,
}, info) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Bring your scans into Mira.' })).toBeVisible();
  expect(await page.evaluate(() => crossOriginIsolated)).toBe(true);
  await page.getByRole('button', { name: 'Import scans', exact: true }).click();
  const files = await Promise.all(
    createSyntheticSvrDicomFiles({ imageSize: 36, slicesPerOrientation: 24 }).map(async (file) => ({
      name: file.name,
      mimeType: file.type,
      buffer: Buffer.from(await file.arrayBuffer()),
    })),
  );
  const intake = page.getByRole('dialog', { name: 'Import scans' });
  await intake.getByLabel('Select DICOM image files').setInputFiles(files);
  await intake.getByRole('button', { name: 'Import scans', exact: true }).click();
  await expect(intake.getByText('Import complete', { exact: true })).toBeVisible();
  await intake.getByRole('button', { name: 'Done', exact: true }).click();
  // The first acquired plane is intentionally outside the synthetic phantom.
  await goToSlice(page, 12);
  await expectAcquiredPixels(page);
  expect((await readSaved(page)).instances).toBe(files.length);
  for (const plane of ['Coronal', 'Axial']) {
    await page.getByRole('button', { name: plane, exact: true }).click();
    await goToSlice(page, 12);
    await expectAcquiredPixels(page);
  }

  const pan = page.getByRole('group', { name: /^Pan MRI slice/ }).first();
  const priorSlice = await pan.getAttribute('aria-label');
  await pan.hover();
  await page.mouse.wheel(0, 80);
  await expect(pan).not.toHaveAttribute('aria-label', priorSlice!);
  await expectAcquiredPixels(page);
  const bounds = (await pan.boundingBox())!;
  await page.mouse.move(bounds.x + bounds.width * 0.5, bounds.y + bounds.height * 0.5);
  await page.mouse.down();
  await page.mouse.move(bounds.x + bounds.width * 0.54, bounds.y + bounds.height * 0.53, { steps: 4 });
  await page.mouse.up();
  await expect.poll(async () => (await readSaved(page)).settings.length).toBeGreaterThan(0);

  // Corrupt only an unvisited synthetic frame, then restore its exact original
  // row. This exercises the actual miradb/WADO decoder error and local Retry.
  const currentImage = page.locator('[data-diagnostic-surface] [data-image-id]').first();
  await expect(currentImage).toHaveAttribute('aria-label', 'Slice 13');
  const currentId = (await currentImage.getAttribute('data-image-id'))!;
  const damaged = await page.evaluateHandle(async (imageId) => {
    const read = <T>(request: IDBRequest<T>) =>
      new Promise<T>((resolve, reject) => {
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
    const db = await read(indexedDB.open('MiraViewerDB'));
    try {
      const current = (await read(
        db.transaction('instances').objectStore('instances').get(imageId.slice('miradb:'.length)),
      )) as DicomInstance;
      const candidates = (await read(
        db
          .transaction('instances')
          .objectStore('instances')
          .index('by-series-instanceNumber-uid')
          .getAll(
            IDBKeyRange.bound(
              [current.seriesInstanceUid, current.instanceNumber + 1],
              [current.seriesInstanceUid, current.instanceNumber + 1, []],
            ),
          ),
      )) as DicomInstance[];
      if (candidates.length !== 1) throw new Error('Synthetic next-frame fixture is ambiguous.');
      const original = candidates[0]!;
      const transaction = db.transaction('instances', 'readwrite');
      const done = new Promise<void>((resolve, reject) => {
        transaction.oncomplete = () => resolve();
        transaction.onabort = () => reject(transaction.error);
      });
      transaction.objectStore('instances').put({ ...original, fileBlob: new Blob(['invalid synthetic DICOM']) });
      await done;
      return original;
    } finally {
      db.close();
    }
  }, currentId);
  try {
    await goToSlice(page, 14);
    await expect(page.getByRole('alert')).toContainText('Unable to load slice 14');
    await expect(currentImage).toHaveAttribute('data-image-id', currentId);
    await expect(currentImage).toHaveAttribute('aria-label', 'Slice 13');
    await expectAcquiredPixels(page);
    await capture(page, info, 'decoder-recovery-desktop');
    await page.evaluate(async (original) => {
      const db = await new Promise<IDBDatabase>((resolve, reject) => {
        const open = indexedDB.open('MiraViewerDB');
        open.onsuccess = () => resolve(open.result);
        open.onerror = () => reject(open.error);
      });
      try {
        const transaction = db.transaction('instances', 'readwrite');
        const done = new Promise<void>((resolve, reject) => {
          transaction.oncomplete = () => resolve();
          transaction.onabort = () => reject(transaction.error);
        });
        transaction.objectStore('instances').put(original);
        await done;
      } finally {
        db.close();
      }
    }, damaged);
    const retry = page.getByRole('button', { name: 'Retry image', exact: true });
    await expect(retry).toBeEnabled();
    await retry.press('Enter');
    await expect(page.getByRole('alert')).not.toBeVisible();
    await expect(currentImage).toHaveAttribute('aria-label', 'Slice 14');
    await expectAcquiredPixels(page);
  } finally {
    await damaged.dispose();
  }

  await page.getByRole('button', { name: 'Overlay', exact: true }).click();
  await expectAcquiredPixels(page);
  await page.getByRole('button', { name: 'Compare', exact: true }).click();
  await page.getByRole('button', { name: 'Adjust image' }).first().click();
  await page.getByRole('button', { name: 'Outline', exact: true }).click();
  await page.getByRole('button', { name: 'Close image adjustments' }).click();
  await expect(page.getByText('Click to add points. Click the first point (or press Enter) to close.')).toBeVisible();
  const surface = page.locator('[data-diagnostic-surface]').first();
  const area = (await surface.boundingBox())!;
  for (const [x, y] of [
    [0.4, 0.4],
    [0.6, 0.4],
    [0.55, 0.6],
    [0.4, 0.4],
  ])
    await page.mouse.click(area.x + area.width * x!, area.y + area.height * y!);
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect.poll(async () => (await readSaved(page)).outlines.length).toBe(1);
  await expect(page.getByRole('status')).toHaveText('Outline saved on this device.');
  await expect(page.getByRole('button', { name: 'Save', exact: true })).toBeDisabled();
  const saved = await readSaved(page);
  const annotatedSlice = Number(await page.getByRole('spinbutton', { name: 'Go to slice' }).inputValue());
  await capture(page, info, 'annotated-desktop');
  await page.reload();
  await goToSlice(page, annotatedSlice);
  await expectAcquiredPixels(page);
  expect((await readSaved(page)).outlines).toEqual(saved.outlines);
  await page.getByRole('button', { name: 'Adjust image' }).first().click();
  await page.getByRole('button', { name: 'Outline', exact: true }).click();
  await page.getByRole('button', { name: 'Close image adjustments' }).click();
  await expect(page.getByRole('button', { name: 'Delete saved ground-truth polygon' })).toBeVisible();
  await page.getByRole('button', { name: 'Close ground-truth polygon tool' }).click();

  // Hydration explicitly normalizes optional settings such as alignmentPaused.
  // The backup owns the state at export, not the earlier pre-reload snapshot.
  const exported = await readSaved(page);
  expect(exported.outlines).toEqual(saved.outlines);
  await page.getByRole('button', { name: 'Application menu' }).click();
  await page.getByRole('button', { name: 'Export backup (ZIP)' }).click();
  const downloadReady = page.waitForEvent('download');
  await page.getByRole('dialog').getByRole('button', { name: 'Export', exact: true }).click();
  const download = await downloadReady;
  const archive = info.outputPath('synthetic-backup.zip');
  await download.saveAs(archive);
  expect(await download.failure()).toBeNull();

  // A recoverable storage read failure must not install writable defaults.
  // This fault is limited to this synthetic browser context and fires once.
  await page.addInitScript(() => {
    const original = IDBObjectStore.prototype.getAll;
    IDBObjectStore.prototype.getAll = function (...args) {
      if (this.name === 'panel_settings' && sessionStorage.getItem('synthetic-settings-read-failed') !== '1') {
        sessionStorage.setItem('synthetic-settings-read-failed', '1');
        throw new DOMException('Synthetic recoverable settings read failure', 'UnknownError');
      }
      return original.apply(this, args);
    };
  });
  await page.reload();
  await expect(page.getByRole('button', { name: 'Retry settings' })).toBeVisible();
  await expect(page.getByRole('spinbutton', { name: 'Go to slice' })).toBeEnabled();
  await goToSlice(page, annotatedSlice === 12 ? 13 : 12);
  await expectAcquiredPixels(page);
  await page.waitForTimeout(350); // Deliberately cross the 200 ms autosave boundary.
  expect((await readSaved(page)).settings).toEqual(exported.settings);
  await capture(page, info, 'settings-read-retry');
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 1000 });
    const retry = page.getByRole('button', { name: 'Retry settings' });
    const bounds = (await retry.boundingBox())!;
    expect(bounds.x).toBeGreaterThanOrEqual(0);
    expect(bounds.x + bounds.width).toBeLessThanOrEqual(width);
    expect(
      await retry.evaluate((button) => {
        const box = button.getBoundingClientRect();
        return button.contains(document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2));
      }),
    ).toBe(true);
    if (width === 390) await capture(page, info, 'settings-read-retry-mobile');
  }
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.getByRole('button', { name: 'Retry settings' }).click();
  await expect(page.getByRole('spinbutton', { name: 'Go to slice' })).toBeEnabled();
  await expect(page.getByRole('button', { name: 'Retry settings' })).not.toBeVisible();

  // Cross the debounce boundary before measuring one ordinary pan release.
  await page.waitForTimeout(250);
  await page.evaluate(() => {
    const audit = { writeStores: [] as string[][], sourceCatalogReads: 0 };
    const transaction = IDBDatabase.prototype.transaction;
    const getAll = IDBObjectStore.prototype.getAll;
    IDBDatabase.prototype.transaction = function (...args) {
      const result = transaction.apply(this, args);
      if (result.mode === 'readwrite' && result.objectStoreNames.contains('panel_settings'))
        audit.writeStores.push(Array.from(result.objectStoreNames).sort());
      return result;
    };
    IDBObjectStore.prototype.getAll = function (...args) {
      if (this.name === 'studies' || this.name === 'series') audit.sourceCatalogReads++;
      return getAll.apply(this, args);
    };
    window.finishPanelWriteAudit = () => {
      IDBDatabase.prototype.transaction = transaction;
      IDBObjectStore.prototype.getAll = getAll;
      return audit;
    };
  });

  // Replace saved work while its old writer is still mounted. A later progress
  // change must carry the restored pan, not the live pre-restore pan.
  const livePan = page.getByRole('group', { name: /^Pan MRI slice/ }).first();
  await expect(livePan).toBeVisible();
  const liveBounds = (await livePan.boundingBox())!;
  await page.mouse.move(liveBounds.x + liveBounds.width * 0.45, liveBounds.y + liveBounds.height * 0.45);
  await page.mouse.down();
  await page.mouse.move(liveBounds.x + liveBounds.width * 0.52, liveBounds.y + liveBounds.height * 0.49, { steps: 4 });
  await page.mouse.up();
  await expect
    .poll(async () => JSON.stringify((await readSaved(page)).settings))
    .not.toBe(JSON.stringify(exported.settings));
  const panelWriteAudit = await page.evaluate(() => window.finishPanelWriteAudit());
  expect(panelWriteAudit).toEqual({ writeStores: [['app_state', 'panel_settings']], sourceCatalogReads: 0 });
  await page.getByRole('button', { name: 'Import additional scans' }).click();
  const liveRestore = page.getByRole('dialog', { name: 'Import scans' });
  await liveRestore.getByLabel('Select a complete backup or image archive').setInputFiles(archive);
  await liveRestore.getByRole('checkbox').check();
  await liveRestore.getByRole('button', { name: 'Restore complete backup', exact: true }).click();
  await expect(liveRestore.getByRole('button', { name: 'Done', exact: true })).toBeVisible();
  await liveRestore.getByRole('button', { name: 'Done', exact: true }).click();
  await goToSlice(page, annotatedSlice === 24 ? 23 : annotatedSlice + 1);
  await page.waitForTimeout(350);
  const restoredPan = (await readSaved(page)).settings.map((row) => ({
    comboId: row.comboId,
    pans: Object.entries(row.settings).map(([date, value]) => ({
      date,
      panX: (value as { panX: number }).panX,
      panY: (value as { panY: number }).panY,
    })),
  }));
  const exportedPan = exported.settings.map((row) => ({
    comboId: row.comboId,
    pans: Object.entries(row.settings).map(([date, value]) => ({
      date,
      panX: (value as { panX: number }).panX,
      panY: (value as { panY: number }).panY,
    })),
  }));
  expect(restoredPan).toEqual(exportedPan);

  // A separate context starts with no browser storage. Restoring there proves
  // the downloaded artifact owns the saved result, not a cache in the first tab.
  const restoredContext = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  try {
    const restored = await restoredContext.newPage();
    await restored.goto('http://127.0.0.1:43134/');
    await restored.getByRole('button', { name: 'Import scans', exact: true }).click();
    const restore = restored.getByRole('dialog', { name: 'Import scans' });
    await restore.getByLabel('Select a complete backup or image archive').setInputFiles(archive);
    await restore.getByRole('checkbox').check();
    await restore.getByRole('button', { name: 'Restore complete backup', exact: true }).click();
    await expect(restore.getByRole('button', { name: 'Done', exact: true })).toBeVisible();
    await restore.getByRole('button', { name: 'Done', exact: true }).click();
    await goToSlice(restored, annotatedSlice);
    await expectAcquiredPixels(restored);
    const roundTrip = await readSaved(restored);
    expect(roundTrip).toEqual(exported);
    await restored.setViewportSize({ width: 390, height: 844 });
    await expectAcquiredPixels(restored);
    const contextValues = restored.locator('.instrument-context-summary .instrument-context-value');
    await expect(contextValues).toHaveText(['Axial', 'T2 FLAIR']);
    for (const value of await contextValues.all())
      expect(
        await value.evaluate((element) => {
          const bounds = element.getBoundingClientRect();
          return element.scrollWidth <= element.clientWidth + 1 && bounds.left >= 0 && bounds.right <= innerWidth;
        }),
      ).toBe(true);
    await capture(restored, info, 'restored-mobile');
    const build = await (await page.request.get('/browser-build.json')).json();
    await attachReceipt(info, 'workflow-receipt', {
      ...build,
      browser: browser.version(),
      fixtureFiles: files.length,
      panelWriteAudit,
      completed: [
        'binary import',
        'acquired pixels',
        'slice wheel',
        'pan persistence',
        'real decoder failure with retained prior image and successful local retry',
        'compare and overlay',
        'outline save/reopen',
        'download and fresh-context restore',
        'failed settings read keeps slice browsing available and durable work unchanged; Retry restores persistence',
        'mounted restore retires the old writer before the next progress save',
        'unclipped mobile plane and sequence context',
      ],
      instances: roundTrip.instances,
      outlines: roundTrip.outlines.length,
      skipped: ['private anatomical evaluation', 'hardware performance', 'real model inference (separate command)'],
    });
  } finally {
    await restoredContext.close();
  }
  await page.getByRole('button', { name: 'Application menu' }).click();
  await page.getByRole('button', { name: 'Delete all local data' }).click();
  const clear = page.getByRole('dialog', { name: 'Clear all local data' });
  await clear.getByLabel('Type CLEAR to confirm').fill('CLEAR');
  await clear.getByRole('button', { name: 'Clear all data', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Bring your scans into Mira.' })).toBeVisible();
  await page.waitForTimeout(350);
  const cleared = await readSaved(page);
  expect(cleared.instances).toBe(0);
  expect(cleared.settings).toEqual([]);
  await attachReceipt(info, 'clear-readback', {
    instances: cleared.instances,
    settings: cleared.settings.length,
    realBrowserReload: true,
  });
  expect(errors).toEqual([]);
});

test('keeps saved source adjustments through explicit acquisition switches and a later date collision', async ({
  page,
  browser,
}, info) => {
  const studyUid = '1.2.826.0.1.3680043.10.543.20350701.1';
  await page.goto('/');
  const importSources = async (files: File[], first = false) => {
    await page.getByRole('button', { name: first ? 'Import scans' : 'Import additional scans', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'Import scans' });
    await dialog.getByLabel('Select DICOM image files').setInputFiles(
      await Promise.all(
        files.map(async (file) => ({
          name: file.name,
          mimeType: file.type,
          buffer: Buffer.from(await file.arrayBuffer()),
        })),
      ),
    );
    await dialog.getByRole('button', { name: 'Import scans', exact: true }).click();
    await expect(dialog.getByText('Import complete', { exact: true })).toBeVisible();
    await dialog.getByRole('button', { name: 'Done', exact: true }).click();
  };
  await importSources(
    createSyntheticSvrDicomFiles({ studyUid, imageSize: 24, slicesPerOrientation: 16 }).slice(0, 16),
    true,
  );
  await goToSlice(page, 8);
  const pan = page.getByRole('group', { name: /^Pan MRI slice/ }).first();
  const bounds = (await pan.boundingBox())!;
  await page.mouse.move(bounds.x + bounds.width * 0.4, bounds.y + bounds.height * 0.4);
  await page.mouse.down();
  await page.mouse.move(bounds.x + bounds.width * 0.46, bounds.y + bounds.height * 0.43, { steps: 4 });
  await page.mouse.up();
  await expect.poll(async () => (await readSaved(page)).settings.length).toBeGreaterThan(0);
  await expect
    .poll(
      async () =>
        (await readSaved(page)).settings.find((row) => row.source?.seriesUid === `${studyUid}.1`)?.settings[studyUid]
          ?.progress,
    )
    .toBe(7 / 15);
  const original = (await readSaved(page)).settings.find((row) => row.source?.seriesUid === `${studyUid}.1`)!;
  expect(original).toBeTruthy();
  await importSources(
    createSyntheticSvrDicomFiles({ studyUid, imageSize: 24, slicesPerOrientation: 20, seriesNumberOffset: 10 }).slice(
      0,
      20,
    ),
  );
  const openDates = page.getByRole('button', { name: 'Show examination dates' });
  if (await openDates.isVisible()) await openDates.click();
  const acquisition = page.getByRole('combobox', { name: /^Acquisition for/ });
  await expect(acquisition).toHaveValue(`${studyUid}.1`);
  await expect(acquisition.locator('option')).toHaveCount(2);
  await acquisition.selectOption(`${studyUid}.11`);
  const image = page.locator('[data-diagnostic-surface] [data-image-id]').first();
  await expect(image).toHaveAttribute('data-image-id', new RegExp(`miradb:${studyUid.replaceAll('.', '\\.')}.11\\.`));
  await expect(page.getByRole('spinbutton', { name: 'Go to slice' })).toHaveAttribute('max', '20');
  await acquisition.selectOption(`${studyUid}.1`);
  await expect(image).toHaveAttribute('data-image-id', new RegExp(`miradb:${studyUid.replaceAll('.', '\\.')}.1\\.`));
  expect((await readSaved(page)).settings.find((row) => row.source?.seriesUid === `${studyUid}.1`)).toEqual(original);
  await expect(page.getByRole('spinbutton', { name: 'Go to slice' })).toHaveValue('8');
  await importSources(
    createSyntheticSvrDicomFiles({
      studyUid: '1.2.826.0.1.3680043.10.543.20350701.2',
      imageSize: 24,
      slicesPerOrientation: 16,
    }).slice(0, 16),
  );
  const pause = page.getByRole('button', { name: 'Pause automatic alignment' });
  if (await pause.isVisible()) await pause.click();
  await expect(page.locator('[data-grid-cell-date]')).toHaveCount(2);
  await expect(page.getByRole('spinbutton', { name: 'Go to slice' })).toHaveValue('8');
  const retained = (await readSaved(page)).settings.find((row) => row.source?.seriesUid === `${studyUid}.1`)!;
  expect(retained.settings[studyUid].alignmentAdjustment).toEqual(original.settings[studyUid].alignmentAdjustment);
  await capture(page, info, 'acquisition-choice-collision-desktop');
  await page.setViewportSize({ width: 390, height: 844 });
  const mobileDates = page.getByRole('button', { name: 'Show examination dates' });
  if (await mobileDates.isVisible()) await mobileDates.click();
  await expect(page.getByRole('combobox', { name: /^Acquisition for/ })).toBeVisible();
  await capture(page, info, 'acquisition-choice-mobile');
  await attachReceipt(info, 'source-ownership-receipt', {
    ...(await (await page.request.get('/browser-build.json')).json()),
    browser: browser.version(),
    source: original.source,
    sourceAdjustmentPreserved: true,
    candidateCounts: [16, 20],
    dateCollision: true,
    privateDataUsed: false,
  });
});

test('replays a two-examination alignment without replacing pixels or restarting sharp work', async ({
  page,
  browser,
}, info) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.addInitScript(() => {
    window.replayWorkerStarts = 0;
    const OriginalWorker = window.Worker;
    window.Worker = class extends OriginalWorker {
      constructor(url: string | URL, options?: WorkerOptions) {
        super(url, options);
        window.replayWorkerStarts++;
      }
    };
  });
  const fixtureFiles = await importComparisonExaminations(page, null);
  const target = page.locator('[data-diagnostic-surface] [data-image-id^="miraderived:"]').first();
  await expect(target).toBeVisible();
  const alignmentStatus = page.getByRole('status', { name: 'Automatic alignment status', exact: true });
  await expect(alignmentStatus).toHaveText(/Scans aligned|Aligned with adjustments/);
  await page.getByRole('button', { name: 'Sharp slices (experimental)' }).click();
  await expect(target).toHaveAttribute('data-image-id', /:sharp:/);

  const raster = () =>
    target.evaluate(async (element) => {
      const canvas = element.querySelector('canvas')!;
      const pixels = canvas.getContext('2d')!.getImageData(0, 0, canvas.width, canvas.height).data;
      const digest = await crypto.subtle.digest('SHA-256', new Uint8Array(pixels));
      return {
        imageId: element.getAttribute('data-image-id'),
        rasterSha256: Array.from(new Uint8Array(digest), (value) => value.toString(16).padStart(2, '0')).join(''),
        transform: element.parentElement!.style.transform,
        workerStarts: window.replayWorkerStarts,
      };
    });
  const before = await raster();
  const reference = page.locator('[data-diagnostic-surface] [data-image-id^="miradb:"]').first();
  const pan = reference.locator('xpath=ancestor::*[@role="group"][1]');
  const bounds = (await pan.boundingBox())!;
  await page.mouse.move(bounds.x + bounds.width * 0.5, bounds.y + bounds.height * 0.5);
  await page.mouse.down();
  await page.mouse.move(bounds.x + bounds.width * 0.54, bounds.y + bounds.height * 0.52, { steps: 4 });
  await page.mouse.up();
  await expect
    .poll(() => target.evaluate((element) => element.parentElement!.style.transform))
    .not.toBe(before.transform);
  await expect(alignmentStatus).toHaveText(/Scans aligned|Aligned with adjustments/);
  await expect(target.locator('xpath=ancestor::*[@role="group"][1]')).not.toHaveAttribute('aria-busy', 'true');
  const after = await raster();
  expect(after.imageId).toBe(before.imageId);
  expect(after.rasterSha256).toBe(before.rasterSha256);
  expect(after.workerStarts).toBe(before.workerStarts);
  expect(errors).toEqual([]);
  await capture(page, info, 'two-exam-replay');
  const build = await (await page.request.get('/browser-build.json')).json();
  await attachReceipt(info, 'comparison-replay-receipt', {
    ...build,
    browser: browser.version(),
    fixtureFiles,
    fixture: 'two synthetic examinations with acquired zero-valued background',
    before,
    after,
    completed: ['real alignment', 'sharp display', 'reference pan', 'unchanged raster and worker count on replay'],
    skipped: ['private anatomy', 'hardware pacing', 'sustained warm navigation and peak memory'],
  });
});

test('settles the displayed overlay pair before offscreen alignment on cold and warm navigation', async ({
  page,
}, info) => {
  await page.addInitScript(() => {
    window.alignmentRequests = [];
    const NativeWorker = window.Worker;
    window.Worker = class extends NativeWorker {
      observation?: Window['alignmentRequests'][number];
      constructor(url: string | URL, options?: WorkerOptions) {
        super(url, options);
        this.addEventListener('message', (event) => {
          if (!this.observation || event.data?.type !== 'done') return;
          const result = event.data.result;
          Object.assign(this.observation, {
            finished: performance.now(),
            ok: result?.ok === true,
            outputBytes: (result?.pixels?.byteLength ?? 0) + (result?.valid?.byteLength ?? 0),
          });
        });
      }
      postMessage(message: unknown, transfer?: Transferable[] | StructuredSerializeOptions) {
        const request = message as { type?: string; options?: { targetSlices?: { sopInstanceUid?: string }[] } } | null;
        const sop = request?.options?.targetSlices?.[0]?.sopInstanceUid;
        if (sop && request?.type && ['run', 'estimate', 'reslice'].includes(request.type)) {
          this.observation = {
            type: request.type,
            study: sop.split('.').slice(0, -2).join('.'),
            started: performance.now(),
          };
          window.alignmentRequests.push(this.observation);
        }
        if (Array.isArray(transfer)) super.postMessage(message, transfer);
        else super.postMessage(message, transfer);
      }
    };
  });
  const examinations = ['01', '02', '03', '04', '05'].map((month) => ({
    studyDate: `2035${month}01`,
    studyUid: `1.2.826.0.1.3680043.10.543.2035${month}01.1`,
  }));
  await importComparisonExaminations(page, null, examinations);
  await page.getByRole('button', { name: 'Pause automatic alignment' }).click();
  const openDates = page.getByRole('button', { name: 'Show examination dates' });
  if (await openDates.isVisible()) await openDates.click();
  await page
    .getByRole('complementary', { name: 'Examination dates' })
    .getByRole('button', { name: 'All', exact: true })
    .click();
  await page.getByRole('button', { name: 'Overlay', exact: true }).click();
  await page.getByRole('navigation', { name: 'Available examinations' }).getByRole('button').first().click();
  await page.getByRole('button', { name: 'Hide examination dates' }).click();
  const visibleStudies = examinations.slice(0, 2).map((exam) => exam.studyUid);
  const measurements = [];
  for (const mode of ['cold', 'warm'] as const) {
    const started = await page.evaluate(() => {
      window.alignmentRequests = [];
      return performance.now();
    });
    if (mode === 'cold') await page.getByRole('button', { name: 'Realign visible scans' }).click();
    else {
      await page.getByRole('spinbutton', { name: 'Go to slice' }).fill('13');
      await page.getByRole('spinbutton', { name: 'Go to slice' }).press('Enter');
    }
    await expect
      .poll(() =>
        page.evaluate(
          (studies) =>
            studies.every((study) =>
              window.alignmentRequests.some(
                (entry) => entry.type === 'reslice' && entry.study === study && entry.ok === true,
              ),
            ),
          visibleStudies,
        ),
      )
      .toBe(true);
    await expect(page.locator('.study-cell[data-alignment-state="aligned"]')).toBeVisible();
    await expectAcquiredPixels(page);
    const finished = await page.evaluate(
      () =>
        new Promise<number>((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(() => resolve(performance.now()))),
        ),
    );
    const requests = await page.evaluate(() => window.alignmentRequests);
    const scheduling = requests.filter((entry) => entry.type === (mode === 'cold' ? 'estimate' : 'reslice'));
    // Visibility orders the pair before background work, not one visible exam
    // before the other. A newly presented date can take the next free slot.
    expect(new Set(scheduling.slice(0, 2).map((entry) => entry.study))).toEqual(new Set(visibleStudies));
    expect(requests.filter((entry) => entry.type === 'run')).toEqual([]);
    expect(
      requests.filter((entry) => entry.type === 'estimate' && entry.finished).every((entry) => entry.outputBytes === 0),
    ).toBe(true);
    if (mode === 'warm') expect(requests.filter((entry) => entry.type === 'estimate')).toEqual([]);
    measurements.push({ mode, visibleAcceptedMs: finished - started, requests });
    await expect(page.getByLabel('Automatic alignment status')).toHaveText('Scans aligned');
  }
  await attachReceipt(info, 'visible-alignment-receipt', {
    ...(await (await page.request.get('/browser-build.json')).json()),
    browser: page.context().browser()!.version(),
    visibleStudies,
    measurements,
    scope:
      'Five synthetic exams, real workers and actual visible image; two animation frames after accepted visible output. Not a clinical or percentile benchmark.',
  });
});

test('keeps scan context legible beside a real alignment rejection on desktop and mobile', async ({
  page,
  browser,
}, info) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await importComparisonExaminations(page, 0);
  const warning = page.getByText('Some examinations could not be aligned safely.', { exact: true });
  const measurements = [];
  for (const viewport of [
    { width: 1440, height: 1000 },
    { width: 1024, height: 800 },
    { width: 390, height: 844 },
  ]) {
    await page.setViewportSize(viewport);
    await expect(warning).toBeVisible();
    const values = page.locator('.instrument-context-summary .instrument-context-value');
    await expect(values).toHaveText(['Axial', 'T2 FLAIR']);
    const context = await values.evaluateAll((elements) =>
      elements.map((element) => {
        const bounds = element.getBoundingClientRect();
        return {
          text: element.textContent,
          width: element.clientWidth,
          contentWidth: element.scrollWidth,
          left: bounds.left,
          right: bounds.right,
          visible: element.scrollWidth <= element.clientWidth + 1 && bounds.left >= 0 && bounds.right <= innerWidth,
        };
      }),
    );
    expect(context.every((value) => value.visible)).toBe(true);
    await expect(
      page.getByRole('banner').getByRole('button', { name: /^(Show|Hide) examination dates$/ }),
    ).toBeVisible();
    measurements.push({ viewport, context });
    await capture(page, info, `alignment-warning-${viewport.width}`);
  }
  expect((await readSaved(page)).instances).toBe(144);
  expect(errors).toEqual([]);
  const build = await (await page.request.get('/browser-build.json')).json();
  await attachReceipt(info, 'alignment-warning-layout', {
    ...build,
    browser: browser.version(),
    measurements,
    fixture: 'original padded synthetic pair; insufficient-coverage rejection retained',
    skipped: ['motion and private anatomical evaluation'],
  });
});
