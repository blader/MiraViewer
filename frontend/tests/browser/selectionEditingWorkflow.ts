import { expect, type Page, type TestInfo } from '@playwright/test';
import { createSyntheticSvrDicomFiles } from '../svrSyntheticDicom';
import { attachReceipt, savedVolumeSelections } from './evidence';

type EditingWork = {
  pointerInputs: number;
  draftRasterAllocations: number;
  commitRasterAllocations: number;
  fullMaskSliceCalls: number;
  persistedLabelBytes: number;
  persistedMarkBytes: number;
  wholeMaskResets: number;
  completedSaves: number;
  failedSaves: number;
  inputToCanvasSubmissionMs: number[];
  inputToNextFrameMs: number[];
  longTasksMs: number[];
  elapsedMs: number;
};

declare global {
  interface Window {
    selectionEditingAudit: { start: (maskBytes: number) => void; stop: () => EditingWork; current: () => EditingWork };
  }
}

/** Same native input and UI actions for the historical build and current application. */
export async function measureSelectionEditing(page: Page, info: TestInfo) {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.addInitScript(() => {
    const blank = (): EditingWork => ({
      pointerInputs: 0,
      draftRasterAllocations: 0,
      commitRasterAllocations: 0,
      fullMaskSliceCalls: 0,
      persistedLabelBytes: 0,
      persistedMarkBytes: 0,
      wholeMaskResets: 0,
      completedSaves: 0,
      failedSaves: 0,
      inputToCanvasSubmissionMs: [],
      inputToNextFrameMs: [],
      longTasksMs: [],
      elapsedMs: 0,
    });
    let work = blank(),
      enabled = false,
      drawing = false,
      maskBytes = 0,
      started = 0;
    let pendingInput: number | null = null;
    const transactions = new WeakSet<IDBTransaction>();
    for (const event of ['pointerdown', 'pointermove', 'pointerup'] as const)
      document.addEventListener(
        event,
        (input) => {
          if (!enabled || !(input.target instanceof HTMLCanvasElement) || input.target.dataset.plane !== 'axial')
            return;
          if (event === 'pointerdown') drawing = true;
          if (drawing) {
            work.pointerInputs++;
            pendingInput = performance.now();
          }
          if (event === 'pointerup') drawing = false;
        },
        true,
      );
    const allocate = CanvasRenderingContext2D.prototype.createImageData;
    CanvasRenderingContext2D.prototype.createImageData = function (...args: unknown[]): ImageData {
      if (enabled) {
        if (drawing) work.draftRasterAllocations++;
        else work.commitRasterAllocations++;
      }
      return Reflect.apply(allocate, this, args);
    };
    const draw = CanvasRenderingContext2D.prototype.drawImage;
    CanvasRenderingContext2D.prototype.drawImage = function (...args: unknown[]): void {
      const result = Reflect.apply(draw, this, args);
      if (
        enabled &&
        pendingInput !== null &&
        this.canvas instanceof HTMLCanvasElement &&
        this.canvas.dataset.plane === 'axial'
      ) {
        const input = pendingInput,
          sample = work;
        pendingInput = null;
        sample.inputToCanvasSubmissionMs.push(performance.now() - input);
        requestAnimationFrame(() => sample.inputToNextFrameMs.push(performance.now() - input));
      }
      return result;
    };
    const slice = Uint8Array.prototype.slice;
    Uint8Array.prototype.slice = function (...args) {
      if (enabled && this.byteLength === maskBytes) work.fullMaskSliceCalls++;
      return Reflect.apply(slice, this, args);
    };
    const put = IDBObjectStore.prototype.put;
    IDBObjectStore.prototype.put = function (value, ...args) {
      if (enabled && (this.name === 'volume_segmentations' || this.name === 'volume_segmentation_chunks')) {
        work.persistedLabelBytes += value.labels?.byteLength ?? value.data?.byteLength ?? 0;
        work.persistedMarkBytes +=
          (value.seeds?.foreground?.byteLength ?? 0) + (value.seeds?.background?.byteLength ?? 0);
        const tx = this.transaction,
          sample = work;
        if (!transactions.has(tx)) {
          transactions.add(tx);
          tx.addEventListener('complete', () => sample.completedSaves++);
          tx.addEventListener('abort', () => sample.failedSaves++);
        }
      }
      return Reflect.apply(put, this, [value, ...args]);
    };
    const remove = IDBObjectStore.prototype.delete;
    IDBObjectStore.prototype.delete = function (key) {
      if (enabled && this.name === 'volume_segmentation_chunks' && key instanceof IDBKeyRange) work.wholeMaskResets++;
      return remove.call(this, key);
    };
    const observer = new PerformanceObserver((list) => {
      if (enabled)
        for (const entry of list.getEntries()) if (entry.startTime >= started) work.longTasksMs.push(entry.duration);
    });
    observer.observe({ type: 'longtask' });
    window.selectionEditingAudit = {
      start(bytes) {
        work = blank();
        maskBytes = bytes;
        drawing = false;
        pendingInput = null;
        started = performance.now();
        enabled = true;
      },
      stop() {
        for (const entry of observer.takeRecords())
          if (entry.startTime >= started) work.longTasksMs.push(entry.duration);
        enabled = false;
        work.elapsedMs = performance.now() - started;
        return work;
      },
      current: () => work,
    };
  });
  await page.goto('/');
  const build = await (await page.request.get('/browser-build.json')).json();
  const fixture = {
    imageSize: 256,
    slicesPerOrientation: 128,
    orientations: 1 as const,
    pixelPaddingValue: null,
    studyUid: '1.2.826.0.1.3680043.10.543.20370904.1',
    studyDate: '20370904',
  };
  const files = await Promise.all(
    createSyntheticSvrDicomFiles(fixture).map(async (file) => ({
      name: file.name,
      mimeType: file.type,
      buffer: Buffer.from(await file.arrayBuffer()),
    })),
  );
  await page.getByRole('button', { name: 'Import scans', exact: true }).click();
  const intake = page.getByRole('dialog', { name: 'Import scans' });
  await intake.getByLabel('Select DICOM image files').setInputFiles(files);
  await intake.getByRole('button', { name: 'Import scans', exact: true }).click();
  await expect(intake.getByText('Import complete', { exact: true })).toBeVisible();
  await intake.getByRole('button', { name: 'Done', exact: true }).click();
  const openVolume = async () => {
    await page.getByRole('button', { name: '3D', exact: true }).click();
    await page.getByRole('button', { name: 'Open 3D volume', exact: true }).click();
    await expect(page.getByRole('region', { name: 'Region selection workspace' })).toBeVisible();
  };
  await openVolume();
  await page.getByRole('button', { name: 'Select tissue', exact: true }).click();
  await page.getByRole('checkbox', { name: 'Auto-fill' }).uncheck();
  await expect(page.getByRole('slider', { name: 'Selection brush radius in millimeters' })).toHaveValue('2');
  const canvas = page.getByRole('application', { name: /axial reconstructed slice/i });
  const box = (await canvas.boundingBox())!;
  const gesture = async (index: number, kind: 'Add' | 'Remove') => {
    await page.getByRole('button', { name: kind, exact: true }).click();
    const y = box.y + box.height * (0.43 + index * 0.015);
    await page.mouse.move(box.x + box.width * 0.4, y);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width * 0.6, y, { steps: 40 });
    await page.mouse.up();
  };
  await gesture(0, 'Add');
  await expect.poll(async () => (await savedVolumeSelections(page))[0]?.selectedCount ?? 0).toBeGreaterThan(0);
  const initial = (await savedVolumeSelections(page))[0]!;
  const settle = async () => {
    await page.waitForFunction(() => window.selectionEditingAudit.current().completedSaves > 0);
    await page.evaluate(
      () => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))),
    );
    return page.evaluate(() => window.selectionEditingAudit.stop());
  };
  const measurements = [];
  let previous = initial;
  for (let i = 1; i <= 5; i++) {
    await page.evaluate((bytes) => window.selectionEditingAudit.start(bytes), initial.labelBytes);
    const kind = i === 4 ? 'Remove' : 'Add';
    await gesture(i === 4 ? 2 : i, kind);
    const work = await settle();
    const saved = (await savedVolumeSelections(page))[0]!;
    measurements.push({ operation: kind, work, saved });
    if (i < 5) previous = saved;
  }
  const final = measurements.at(-1)!.saved;
  for (const [operation, expected] of [
    ['Undo', previous],
    ['Redo', final],
  ] as const) {
    await page.evaluate((bytes) => window.selectionEditingAudit.start(bytes), initial.labelBytes);
    await page.getByRole('button', { name: `${operation} selection edit`, exact: true }).click();
    const work = await settle();
    const saved = (await savedVolumeSelections(page))[0]!;
    expect(saved).toEqual(expected);
    measurements.push({ operation, work, saved });
  }
  const raster = await canvas.evaluate(async (element) => {
    const image = element as HTMLCanvasElement;
    const pixels = image.getContext('2d')!.getImageData(0, 0, image.width, image.height).data;
    return {
      width: image.width,
      height: image.height,
      sha256: Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', pixels)), (value) =>
        value.toString(16).padStart(2, '0'),
      ).join(''),
    };
  });
  await page.getByRole('button', { name: 'Done', exact: true }).click();
  await expect.poll(async () => (await savedVolumeSelections(page))[0]?.reviewState).toBe('reviewed');
  const reviewed = (await savedVolumeSelections(page))[0]!;
  expect(reviewed).toEqual({ ...final, reviewState: 'reviewed' });
  await page.reload();
  await openVolume();
  await expect(page.getByRole('button', { name: 'Edit selection', exact: true })).toBeEnabled();
  const reopened = (await savedVolumeSelections(page))[0]!;
  expect(reopened).toEqual(reviewed);
  await page.getByRole('button', { name: 'Application menu' }).click();
  await page.getByRole('button', { name: 'Export backup (ZIP)' }).click();
  const downloadReady = page.waitForEvent('download');
  await page.getByRole('dialog').getByRole('button', { name: 'Export', exact: true }).click();
  const download = await downloadReady;
  const archive = info.outputPath('synthetic-selection-backup.zip');
  await download.saveAs(archive);
  expect(await download.failure()).toBeNull();
  const restoredContext = await page
    .context()
    .browser()!
    .newContext({ viewport: { width: 1440, height: 1000 } });
  let restored;
  try {
    const target = await restoredContext.newPage();
    await target.goto('http://127.0.0.1:43134/');
    await target.getByRole('button', { name: 'Import scans', exact: true }).click();
    const restore = target.getByRole('dialog', { name: 'Import scans' });
    await restore.getByLabel('Select a complete backup or image archive').setInputFiles(archive);
    await restore.getByRole('checkbox').check();
    await restore.getByRole('button', { name: 'Restore complete backup', exact: true }).click();
    await expect(restore.getByRole('button', { name: 'Done', exact: true })).toBeVisible();
    restored = (await savedVolumeSelections(target))[0]!;
    expect(restored).toEqual(reviewed);
  } finally {
    await restoredContext.close();
  }
  expect(errors).toEqual([]);
  const result = {
    build,
    browser: page.context().browser()!.version(),
    fixture,
    initial,
    measurements,
    raster,
    reopened,
    restored,
    errors,
    scope:
      'Normal built UI and IndexedDB with synthetic DICOM only. Raster allocations, whole-mask Uint8Array.slice calls, submitted label/mark bytes, durable commits and observed long tasks. Latencies end at canvas command submission or the following animation-frame callback, not measured physical screen presentation. No inference or anatomical claim.',
  };
  await attachReceipt(info, 'selection-editing-receipt', result);
  return result;
}
