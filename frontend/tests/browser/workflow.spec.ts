import { expect, test } from '@playwright/test';
import type { Locator, Page } from '@playwright/test';
import { createSyntheticSvrDicomFiles } from '../svrSyntheticDicom';
import { attachReceipt, capture, savedVolumeSelections as savedVolumeSelection } from './evidence';
import type { DicomInstance, StoredVolumeSegmentationRow, VolumeSegmentationChunk } from '../../src/db/schema';
import { createSyntheticCustomModel } from '../helpers/customTumorModel';
import { createHash } from 'node:crypto';
import { DEFAULT_PANEL_SETTINGS } from '../../src/utils/constants';

declare global {
  interface Window {
    replayWorkerStarts: number;
    customInferenceStarted: boolean;
    customInferenceAction?: () => void;
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

test.beforeAll(async ({ browser }, info) => {
  const context = await browser.newContext();
  try {
    const page = await context.newPage();
    const graphics = await page.evaluate(() => {
      const gl = document.createElement('canvas').getContext('webgl2', { powerPreference: 'high-performance' });
      if (!gl) return null;
      const debug = gl.getExtension('WEBGL_debug_renderer_info');
      const result = {
        version: gl.getParameter(gl.VERSION),
        vendor: gl.getParameter(debug?.UNMASKED_VENDOR_WEBGL ?? gl.VENDOR),
        renderer: gl.getParameter(debug?.UNMASKED_RENDERER_WEBGL ?? gl.RENDERER),
      };
      gl.getExtension('WEBGL_lose_context')?.loseContext();
      return result;
    });
    await attachReceipt(info, 'browser-environment', {
      browser: browser.version(),
      platform: process.platform,
      channel: info.project.use.channel,
      headless: info.project.use.headless,
      graphics,
      scope: 'Runtime metadata from a disposable context in the workflow browser, not performance evidence.',
    });
    expect(graphics, 'The workflow browser must provide WebGL2 for its 3D scenarios').not.toBeNull();
  } finally {
    await context.close();
  }
});

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

async function openLegacySyntheticStudy(page: Page) {
  const studyUid = '1.2.826.0.1.3680043.10.543.20370904.1';
  const seriesUid = studyUid + '.1';
  const files = await Promise.all(
    createSyntheticSvrDicomFiles({
      imageSize: 36,
      slicesPerOrientation: 24,
      orientations: 1,
      studyUid,
      studyDate: '20370904',
      pixelPaddingValue: null,
    }).map(async (file) => ({ name: file.name, mimeType: file.type, buffer: Buffer.from(await file.arrayBuffer()) })),
  );
  // Bootstrap only a synthetic older database before loading any application
  // code. All subsequent navigation uses the unmodified production document.
  await page.route('**/legacy-fixture-bootstrap', (route) =>
    route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>Synthetic legacy database setup</title>' }),
  );
  try {
    await page.goto('/legacy-fixture-bootstrap');
  } finally {
    await page.unroute('**/legacy-fixture-bootstrap');
  }
  await page.evaluate(
    async ({ studyUid, seriesUid, payloads, settings }) => {
      const opened = indexedDB.open('MiraViewerDB', 6);
      opened.onupgradeneeded = () => {
        const db = opened.result;
        db.createObjectStore('studies', { keyPath: 'studyInstanceUid' }).put({
          studyInstanceUid: studyUid,
          studyDate: '20370904',
          studyTime: '120000',
          studyDescription: 'SYNTHETIC SVR VALIDATION ONLY',
          patientName: 'SYNTHETIC^SVR^NO^PATIENT^DATA',
          patientId: 'SVR-SYNTHETIC-ONLY',
          modality: 'MR',
        });
        db.createObjectStore('series', { keyPath: 'seriesInstanceUid' }).put({
          seriesInstanceUid: seriesUid,
          studyInstanceUid: studyUid,
          seriesDescription: 'Axial T2 FLAIR',
          seriesNumber: 1,
          modality: 'MR',
          plane: 'Axial',
          weight: 'T2',
          sequenceType: 'FLAIR',
          frameOfReferenceUid: studyUid + '.999',
        });
        const instances = db.createObjectStore('instances', { keyPath: 'sopInstanceUid' });
        payloads.forEach((bytes, index) =>
          instances.put({
            sopInstanceUid: seriesUid + '.' + (index + 1),
            seriesInstanceUid: seriesUid,
            studyInstanceUid: studyUid,
            instanceNumber: payloads.length - index,
            rows: 36,
            columns: 36,
            windowCenter: 500,
            windowWidth: 1000,
            fileBlob: new Blob([Uint8Array.from(bytes)], { type: 'application/dicom' }),
          }),
        );
        db.createObjectStore('panel_settings', { keyPath: 'comboId' }).put({
          comboId: 'source:' + encodeURIComponent(seriesUid),
          source: { studyUid, seriesUid },
          settings: { [studyUid]: settings },
        });
        db.createObjectStore('volume_segmentations', { keyPath: 'volumeKey' }).put({
          volumeKey: 'synthetic-retained-legacy-grid',
          studyUid,
          seriesUids: [seriesUid],
          frameOfReferenceUid: studyUid + '.999',
          dims: [2, 2, 2],
          voxelSizeMm: [1, 1, 1],
          labels: Uint8Array.of(1, 0, 0, 0, 0, 0, 0, 0),
          reviewState: 'reviewed',
          seeds: {
            foreground: Uint32Array.of(0),
            background: Uint32Array.of(1),
            lastStroke: { plane: 'axial', slice: 0 },
          },
          updatedAt: 42,
        });
        const state = db.createObjectStore('app_state', { keyPath: 'key' });
        state.put({ key: 'dataset_revision', value: 7 });
        state.put({ key: 'dataset_token', value: 'synthetic-legacy-metadata-token' });
      };
      const db = await new Promise<IDBDatabase>((resolve, reject) => {
        opened.onsuccess = () => resolve(opened.result);
        opened.onerror = () => reject(opened.error);
      });
      if (db.version !== 6) throw new Error('Expected the isolated synthetic schema-6 database.');
      db.close();
    },
    {
      studyUid,
      seriesUid,
      payloads: files.map((file) => Array.from(file.buffer)),
      settings: { ...DEFAULT_PANEL_SETTINGS, zoom: 1.25, panX: 0.12 },
    },
  );
  await page.goto('/');
  await expect(page.getByRole('button', { name: 'Import additional scans' })).toBeVisible();
  return {
    files,
    studyUid,
    seriesUid,
    hashes: files.map((file, index) => ({
      uid: seriesUid + '.' + (index + 1),
      sha256: createHash('sha256').update(file.buffer).digest('hex'),
    })),
  };
}

async function metadataSnapshot(page: Page) {
  return page.evaluate(async () => {
    const read = <T>(request: IDBRequest<T>) =>
      new Promise<T>((resolve, reject) => {
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
    const db = await read(indexedDB.open('MiraViewerDB'));
    try {
      const tx = db.transaction(['instances', 'app_state']);
      const [rows, token, revision] = await Promise.all([
        read(tx.objectStore('instances').getAll()) as Promise<DicomInstance[]>,
        read(tx.objectStore('app_state').get('dataset_token')),
        read(tx.objectStore('app_state').get('dataset_revision')),
      ]);
      const frames = await Promise.all(
        rows.map(async (row) => ({
          uid: row.sopInstanceUid,
          metadataVersion: row.metadataVersion,
          physicalPosition: row.physicalSlicePosition,
          geometry: {
            position: row.imagePositionPatient,
            orientation: row.imageOrientationPatient,
            spacing: row.pixelSpacing,
            frame: row.frameOfReferenceUid,
          },
          sha256: Array.from(
            new Uint8Array(await crypto.subtle.digest('SHA-256', await row.fileBlob.arrayBuffer())),
            (byte) => byte.toString(16).padStart(2, '0'),
          ).join(''),
        })),
      );
      return { schema: db.version, token: token?.value, revision: revision?.value, frames };
    } finally {
      db.close();
    }
  });
}

async function openSelectionAndVerifyPixels(page: Page) {
  await page.getByRole('button', { name: 'Select tissue', exact: true }).click();
  await expectGrayscalePixels(page.getByRole('application', { name: /^Axial reconstructed slice/ }));
}

async function expectGrayscalePixels(canvas: Locator) {
  await expect(canvas).toBeVisible();
  await expect
    .poll(() =>
      canvas.evaluate((element) => {
        const canvas = element as HTMLCanvasElement;
        const context = canvas.getContext('2d');
        if (!context || !canvas.width || !canvas.height) return 0;
        const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
        const levels = new Set<number>();
        for (let index = 0; index < pixels.length; index += 4)
          if (pixels[index] === pixels[index + 1] && pixels[index] === pixels[index + 2]) levels.add(pixels[index]!);
        return levels.size;
      }),
    )
    .toBeGreaterThan(5);
}

test('shows a clear metadata-only repair summary for existing scans on desktop and mobile', async ({ page }, info) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const input = await openLegacySyntheticStudy(page);
  await page.getByRole('button', { name: 'Import additional scans' }).click();
  const dialog = page.getByRole('dialog', { name: 'Import scans' });
  await dialog.getByLabel('Select DICOM image files').setInputFiles(input.files);
  await dialog.getByRole('button', { name: 'Import scans', exact: true }).click();
  await expect(dialog.getByText('Existing scan metadata updated', { exact: true })).toBeVisible();
  await expect(dialog.getByText(/24 metadata updated; original images and saved work kept/)).toBeVisible();
  await capture(page, info, 'legacy-metadata-repair-desktop');
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(dialog.getByRole('button', { name: 'Done', exact: true })).toBeInViewport();
  await capture(page, info, 'legacy-metadata-repair-mobile');
  expect(errors).toEqual([]);
  await attachReceipt(info, 'metadata-ui-receipt', {
    build: await (await page.request.get('/browser-build.json')).json(),
    browser: page.context().browser()!.version(),
    errors,
    scope:
      'Real metadata-only reimport from a schema-6 synthetic database. Static desktop/mobile summary and reachable Done control; no anatomical or motion verdict.',
  });
});

test('upgrades a legacy database for physical viewing and preserves original bytes and saved work through backup restore', async ({
  page,
  browser,
}, info) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const input = await openLegacySyntheticStudy(page);
  await goToSlice(page, 12);
  await expect.poll(async () => (await readSaved(page)).settings[0]?.settings[input.studyUid]?.progress).toBe(11 / 23);
  const original = await metadataSnapshot(page);
  const saved = await readSaved(page);
  const selections = await savedVolumeSelection(page);
  await page.getByRole('button', { name: '3D', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Open 3D volume', exact: true })).toBeEnabled();
  await page.getByRole('button', { name: 'Show reconstruction sources and controls' }).click();
  await page.locator('summary', { hasText: 'Focus region (optional)' }).click();
  await expectGrayscalePixels(page.getByRole('img', { name: 'Acquired MRI slice preview' }));
  await capture(page, info, 'legacy-metadata-focus');
  await page.getByRole('button', { name: 'Hide reconstruction sources and controls' }).click();
  await page.getByRole('button', { name: 'Open 3D volume', exact: true }).click();
  await expect(page.getByRole('region', { name: 'Region selection workspace' })).toBeVisible();
  const upgraded = await metadataSnapshot(page);
  await openSelectionAndVerifyPixels(page);
  await capture(page, info, 'legacy-metadata-selection');
  expect(
    upgraded.frames.every(
      (frame) =>
        frame.metadataVersion === 1 &&
        frame.geometry.position &&
        frame.geometry.spacing &&
        frame.geometry.orientation &&
        frame.geometry.frame,
    ),
  ).toBe(true);
  expect(
    upgraded.frames
      .map((frame) => ({ uid: frame.uid, sha256: frame.sha256 }))
      .sort((a, b) => a.uid.localeCompare(b.uid)),
  ).toEqual([...input.hashes].sort((a, b) => a.uid.localeCompare(b.uid)));
  expect(upgraded.frames.map((frame) => frame.physicalPosition).sort((a, b) => a! - b!)).toEqual(
    Array.from({ length: 24 }, (_, index) => index),
  );
  expect(upgraded.token).toBe(original.token);
  expect(upgraded.revision).toBe(original.revision);
  expect((await readSaved(page)).settings).toEqual(saved.settings);
  expect(await savedVolumeSelection(page)).toEqual(selections);
  await page.reload();
  await expect(page.getByRole('button', { name: 'Import additional scans' })).toBeVisible();
  expect(await metadataSnapshot(page)).toEqual(upgraded);
  expect(await savedVolumeSelection(page)).toEqual(selections);
  await page.getByRole('button', { name: 'Application menu' }).click();
  await page.getByRole('button', { name: 'Export backup (ZIP)' }).click();
  const pending = page.waitForEvent('download');
  await page.getByRole('dialog').getByRole('button', { name: 'Export', exact: true }).click();
  const download = await pending;
  const archive = info.outputPath('synthetic-legacy-metadata-backup.zip');
  await download.saveAs(archive);
  expect(await download.failure()).toBeNull();
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  let restoredSnapshot: Awaited<ReturnType<typeof metadataSnapshot>>;
  try {
    const restored = await context.newPage();
    restored.on('pageerror', (error) => errors.push(error.message));
    await restored.goto(new URL('/', page.url()).href);
    await restored.getByRole('button', { name: 'Import scans', exact: true }).click();
    const intake = restored.getByRole('dialog', { name: 'Import scans' });
    await intake.getByLabel('Select a complete backup or image archive').setInputFiles(archive);
    await intake.getByRole('checkbox').check();
    await intake.getByRole('button', { name: 'Restore complete backup', exact: true }).click();
    await expect(intake.getByRole('button', { name: 'Done', exact: true })).toBeVisible();
    await intake.getByRole('button', { name: 'Done', exact: true }).click();
    restoredSnapshot = await metadataSnapshot(restored);
    expect(restoredSnapshot.frames).toEqual(upgraded.frames);
    expect((await readSaved(restored)).settings).toEqual(saved.settings);
    expect(await savedVolumeSelection(restored)).toEqual(selections);
    await restored.getByRole('button', { name: '3D', exact: true }).click();
    await restored.getByRole('button', { name: 'Open 3D volume', exact: true }).click();
    await expect(restored.getByRole('region', { name: 'Region selection workspace' })).toBeVisible();
    await openSelectionAndVerifyPixels(restored);
    await capture(restored, info, 'legacy-metadata-restored-selection');
  } finally {
    await context.close();
  }
  expect(errors).toEqual([]);
  await attachReceipt(info, 'legacy-metadata-receipt', {
    build: await (await page.request.get('/browser-build.json')).json(),
    browser: browser.version(),
    input: { schema: 6, frames: input.hashes },
    original,
    upgraded,
    restored: restoredSnapshot!,
    settings: saved.settings,
    selections,
    errors,
    scope:
      'Synthetic legacy metadata and saved-work preservation. Real source-stack admission, reopen, ZIP export and fresh-context restore; retained legacy labels are storage evidence, not automatic remapping to the newly opened grid or anatomical evidence.',
  });
});

test('keeps exact source-bound selections through unrelated import, legacy recovery, editing and fresh-context restore', async ({
  page,
  browser,
}, info) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await importComparisonExaminations(
    page,
    null,
    [{ studyDate: '20370904', studyUid: '1.2.826.0.1.3680043.10.543.20370904.1' }],
    true,
  );
  const openVolume = async (target: Page) => {
    await target.getByRole('button', { name: '3D', exact: true }).click();
    await target.getByRole('button', { name: 'Open 3D volume', exact: true }).click();
    await expect(target.getByRole('region', { name: 'Region selection workspace' })).toBeVisible();
  };
  await openVolume(page);
  await openSelectionAndVerifyPixels(page);
  await page.getByRole('checkbox', { name: 'Auto-fill' }).uncheck();
  const mark = async (target: Page, kind: 'Add' | 'Remove', x: number) => {
    await target.getByRole('button', { name: kind, exact: true }).click();
    const canvas = target.getByRole('application', { name: /^Axial reconstructed slice/ });
    const box = (await canvas.boundingBox())!;
    await canvas.click({ position: { x: box.width * x, y: box.height * 0.5 } });
  };
  await mark(page, 'Add', 0.5);
  await expect.poll(async () => (await savedVolumeSelection(page))[0]?.selectedCount ?? 0).toBeGreaterThan(0);
  await mark(page, 'Remove', 0.65);
  await expect
    .poll(async () => (await savedVolumeSelection(page))[0]?.seeds?.background.length ?? 0)
    .toBeGreaterThan(0);
  await page.getByRole('button', { name: 'Done', exact: true }).click();
  await expect.poll(async () => (await savedVolumeSelection(page))[0]?.reviewState).toBe('reviewed');
  const reviewed = (await savedVolumeSelection(page))[0]!;
  const original = await metadataSnapshot(page);

  // Downgrade only this isolated synthetic selection to the historical dense
  // key/fingerprint format while the application is unmounted. This is fixture
  // setup, not a production migration or a replacement for the actual reopen.
  await page.route('**/legacy-selection-bootstrap', (route) =>
    route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>Synthetic selection fixture</title>' }),
  );
  try {
    await page.goto('/legacy-selection-bootstrap');
  } finally {
    await page.unroute('**/legacy-selection-bootstrap');
  }
  const legacyKey = await page.evaluate(async (currentKey) => {
    const read = <T>(request: IDBRequest<T>) =>
      new Promise<T>((resolve, reject) => {
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
    const db = await read(indexedDB.open('MiraViewerDB'));
    try {
      const tx = db.transaction(['volume_segmentations', 'volume_segmentation_chunks'], 'readwrite');
      const complete = new Promise<void>((resolve, reject) => {
        tx.oncomplete = () => resolve();
        tx.onabort = () => reject(tx.error);
      });
      const heads = tx.objectStore('volume_segmentations');
      const row = (await read(heads.get(currentKey))) as StoredVolumeSegmentationRow;
      if ('labels' in row || !row.geometry) throw new Error('Expected a current, source-verified chunked selection.');
      const { storage, revision, labelBytes, chunkCount, ...record } = row;
      const chunks = tx.objectStore('volume_segmentation_chunks');
      const range = IDBKeyRange.bound([currentKey, 0], [currentKey, Number.MAX_SAFE_INTEGER]);
      const payloads = (await read(chunks.getAll(range))) as VolumeSegmentationChunk[];
      if (storage !== 'chunks-v1' || !revision || payloads.length !== chunkCount)
        throw new Error('Incomplete fixture selection.');
      const labels = new Uint8Array(labelBytes);
      for (const chunk of payloads) labels.set(chunk.data, chunk.offset);
      const geometry = row.geometry;
      const primary = geometry.sourceProvenance.sources.find(
        (source) => source.seriesUid === geometry.sourceProvenance.primarySeriesUid,
      )!;
      const input = JSON.stringify([
        record.datasetRevision,
        primary.seriesUid,
        primary.sopInstanceUids,
        record.dims,
        geometry.originMm,
        geometry.direction,
        record.voxelSizeMm,
        primary.transform,
      ]);
      let hash = 2166136261;
      for (let i = 0; i < input.length; i++) hash = Math.imul(hash ^ input.charCodeAt(i), 16777619);
      const reconstruction = `native-v1-${(hash >>> 0).toString(16)}`;
      const volumeKey = JSON.stringify({
        patient: record.patientKey,
        study: record.studyUid,
        series: record.seriesUids,
        frame: record.frameOfReferenceUid,
        dims: record.dims,
        spacing: record.voxelSizeMm,
        origin: geometry.originMm,
        direction: geometry.direction,
        revision: record.datasetRevision,
        reconstruction,
      });
      await read(
        heads.put({
          ...record,
          volumeKey,
          labels,
          geometry: { ...geometry, reconstructionFingerprint: reconstruction },
        }),
      );
      await read(heads.delete(currentKey));
      await read(chunks.delete(range));
      await complete;
      return volumeKey;
    } finally {
      db.close();
    }
  }, reviewed.volumeKey);
  const legacy = (await savedVolumeSelection(page))[0]!;
  expect(legacy).toEqual({ ...reviewed, volumeKey: legacyKey });
  await page.goto('/');
  await page.getByRole('button', { name: 'Import additional scans' }).click();
  const intake = page.getByRole('dialog', { name: 'Import scans' });
  await intake.getByLabel('Select DICOM image files').setInputFiles(
    await Promise.all(
      createSyntheticSvrDicomFiles({
        orientations: 1,
        studyUid: '1.2.826.0.1.3680043.10.543.20360904.1',
        studyDate: '20360904',
        pixelPaddingValue: null,
      }).map(async (file) => ({
        name: file.name,
        mimeType: file.type,
        buffer: Buffer.from(await file.arrayBuffer()),
      })),
    ),
  );
  await intake.getByRole('button', { name: 'Import scans', exact: true }).click();
  await expect(intake.getByText('Import complete', { exact: true })).toBeVisible();
  await intake.getByRole('button', { name: 'Done', exact: true }).click();
  const imported = await metadataSnapshot(page);
  expect(imported.revision).toBeGreaterThan(original.revision);
  expect(imported.token).toBe(original.token);
  await openVolume(page);
  await expect(page.getByText(/Reviewed selection ·/)).toBeVisible();
  await page.getByRole('button', { name: 'Edit selection', exact: true }).click();
  await expectGrayscalePixels(page.getByRole('application', { name: /^Axial reconstructed slice/ }));
  await page.getByRole('checkbox', { name: 'Auto-fill' }).uncheck();
  expect(await savedVolumeSelection(page)).toEqual([legacy]);
  await capture(page, info, 'durable-grid-recovered-desktop');
  await mark(page, 'Add', 0.4);
  await expect.poll(async () => (await savedVolumeSelection(page)).length).toBe(2);
  await page.getByRole('button', { name: 'Done', exact: true }).click();
  await expect
    .poll(
      async () => (await savedVolumeSelection(page)).find((row) => row.volumeKey === reviewed.volumeKey)?.reviewState,
    )
    .toBe('reviewed');
  const edited = await savedVolumeSelection(page);
  const canonical = edited.find((row) => row.volumeKey === reviewed.volumeKey)!;
  expect(canonical.selectedCount).toBeGreaterThan(reviewed.selectedCount);
  expect(canonical.seeds!.foreground).toEqual(expect.arrayContaining(reviewed.seeds!.foreground));
  expect(canonical.seeds!.background).toEqual(reviewed.seeds!.background);
  expect(edited.find((row) => row.volumeKey === legacyKey)).toEqual(legacy);
  await page.getByRole('button', { name: 'Application menu' }).click();
  await page.getByRole('button', { name: 'Export backup (ZIP)' }).click();
  const pending = page.waitForEvent('download');
  await page.getByRole('dialog').getByRole('button', { name: 'Export', exact: true }).click();
  const download = await pending;
  const archive = info.outputPath('synthetic-durable-selection-backup.zip');
  await download.saveAs(archive);
  expect(await download.failure()).toBeNull();
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  let restoredSnapshot: Awaited<ReturnType<typeof metadataSnapshot>>;
  let cleared: Awaited<ReturnType<typeof savedVolumeSelection>>;
  try {
    const restored = await context.newPage();
    restored.on('pageerror', (error) => errors.push(error.message));
    await restored.goto(new URL('/', page.url()).href);
    await restored.getByRole('button', { name: 'Import scans', exact: true }).click();
    const restore = restored.getByRole('dialog', { name: 'Import scans' });
    await restore.getByLabel('Select a complete backup or image archive').setInputFiles(archive);
    await restore.getByRole('checkbox').check();
    await restore.getByRole('button', { name: 'Restore complete backup', exact: true }).click();
    await expect(restore.getByRole('button', { name: 'Done', exact: true })).toBeVisible();
    await restore.getByRole('button', { name: 'Done', exact: true }).click();
    restoredSnapshot = await metadataSnapshot(restored);
    expect(restoredSnapshot.frames).toEqual(imported.frames);
    expect(restoredSnapshot.token).not.toBe(imported.token);
    expect(await savedVolumeSelection(restored)).toEqual(edited);
    await openVolume(restored);
    await expect(restored.getByText(/Reviewed selection ·/)).toBeVisible();
    await restored.getByRole('button', { name: 'Edit selection', exact: true }).click();
    await capture(restored, info, 'durable-grid-restored-desktop');
    await restored.getByRole('button', { name: 'Clear selection' }).click();
    await expect
      .poll(
        async () =>
          (await savedVolumeSelection(restored)).find((row) => row.volumeKey === canonical.volumeKey)?.selectedCount,
      )
      .toBe(0);
    cleared = await savedVolumeSelection(restored);
    expect(cleared.find((row) => row.volumeKey === legacyKey)).toEqual(legacy);
    expect(cleared.find((row) => row.volumeKey === canonical.volumeKey)?.seeds).toBeUndefined();
    await restored.reload();
    await openVolume(restored);
    await expect(restored.getByRole('button', { name: 'Select tissue', exact: true })).toBeEnabled();
    expect(await savedVolumeSelection(restored)).toEqual(cleared);
    await openSelectionAndVerifyPixels(restored);
    await capture(restored, info, 'durable-grid-cleared-reopened');
  } finally {
    await context.close();
  }
  expect(errors).toEqual([]);
  await attachReceipt(info, 'durable-grid-receipt', {
    build: await (await page.request.get('/browser-build.json')).json(),
    browser: browser.version(),
    original,
    imported,
    restored: restoredSnapshot!,
    reviewed,
    legacy,
    edited,
    cleared: cleared!,
    errors,
    scope:
      'Normal production application and synthetic DICOM only. Exact reviewed labels and literal marks survive a historical native key, unrelated import, guarded editing and fresh-context ZIP restoration. Clear persists while the legacy original remains intact. No anatomical or performance claim.',
  });
});

test('backup controls show per-file limits and a reachable direct-save action', async ({ page }, info) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await importComparisonExaminations(
    page,
    null,
    [{ studyDate: '20370101', studyUid: '1.2.826.0.1.3680043.10.543.20370101.1' }],
    true,
  );
  await page.getByRole('button', { name: 'Application menu' }).click();
  await page.getByRole('button', { name: 'Export backup (ZIP)' }).click();
  const dialog = page.getByRole('dialog', { name: 'Export Backup (ZIP)' });
  await expect(dialog.getByText(/each individual file can be up to 512 MiB/i)).toBeVisible();
  await expect(dialog.getByRole('button', { name: 'Save directly…' })).toBeInViewport();
  await capture(page, info, 'streaming-backup-export-desktop');
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(dialog.getByRole('button', { name: 'Save directly…' })).toBeInViewport();
  await expect(dialog.getByRole('button', { name: 'Export', exact: true })).toBeInViewport();
  await capture(page, info, 'streaming-backup-export-mobile');
  expect(errors).toEqual([]);
  await attachReceipt(info, 'backup-ui-receipt', {
    build: await (await page.request.get('/browser-build.json')).json(),
    browser: page.context().browser()!.version(),
    viewports: [
      { width: 1440, height: 1000 },
      { width: 390, height: 844 },
    ],
    errors,
    scope:
      'Normal production backup dialog with an imported synthetic examination. Static desktop/mobile controls; not a file-picker, throughput, or large-restore proof.',
  });
});

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
            if (event.data?.type === 'inference') {
              window.customInferenceStarted = true;
              window.customInferenceAction?.();
            }
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
  const start = async (onInference?: Locator) => {
    await page.evaluate(() => {
      window.customInferenceStarted = false;
      window.customInferenceAction = undefined;
    });
    if (onInference) {
      await expect(onInference).toBeEnabled();
      await onInference.evaluate((button) => {
        window.customInferenceAction = () => (button as HTMLButtonElement).click();
      });
    }
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
  // Trigger its real button at inference start: a fast model can otherwise
  // finish legitimately between the two Playwright clicks before replacement.
  await page.getByRole('button', { name: 'Show reconstruction sources and controls' }).click();
  await start(page.getByRole('button', { name: 'Open 3D volume', exact: true }));
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
