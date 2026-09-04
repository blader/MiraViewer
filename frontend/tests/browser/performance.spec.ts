import { chromium, expect, test } from '@playwright/test';
import { copyFile, mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { constants } from 'node:fs';
import { execFileSync } from 'node:child_process';
import type { BrowserContext, Page, TestInfo } from '@playwright/test';
import { createHash } from 'node:crypto';
import type {} from './probes';
import { attachReceipt, capture, savedVolumeSelections } from './evidence';
import { DEFAULT_PANEL_SETTINGS } from '../../src/utils/constants';
import type { DicomInstance, DerivedAlignmentFrameRow, ModelRecord, PanelSettingsRow } from '../../src/db/schema';
import { measureSelectionEditing } from './selectionEditingWorkflow';
import { createSyntheticSvrDicomFiles } from '../svrSyntheticDicom';
import { goToSlice, importComparisonExaminations } from './comparisonWorkflow';

type BackupIo = {
  name: string;
  startedAt: number;
  finishedAt?: number;
  arrayBufferBytes: number;
  maxArrayBufferBytes: number;
  streamBytes: number;
  maxStreamChunkBytes: number;
  pending: number;
  lastReadAt: number;
};
declare global {
  interface Window {
    warmAudit: {
      phase: string;
      timeOrigin: number;
      workerStarts: { created: number; terminated?: number }[];
      jobs: {
        workerId: number;
        phase: string;
        posted?: number;
        finished?: number;
        terminated?: number;
        type?: string;
        reference?: string;
        inputBytes?: number;
        sourceFrames?: string[];
        outputBytes?: number;
        pixelsSha256?: string;
        supportSha256?: string;
        ok?: boolean;
      }[];
      draws: { phase: string; at: number; imageId: string | null }[];
      longTasks: { phase: string; at: number; duration: number }[];
    };
    startupAudit: {
      shellFrameMs?: number;
      firstImageDrawMs?: number;
      importStartedMs?: number;
      imageUnblockedFrameMs?: number;
      longTasks: { startTime: number; duration: number }[];
    };
    backupIo: { current: BackupIo | null; start: (name: string) => void; stop: () => BackupIo };
    restoreBackupWrites?: () => void;
  }
}

for (const imageSize of [256, 512] as const) {
  test(`measures correct warm planes, superseded work and final display during real slice playback (${imageSize})`, async ({
    page,
  }, info) => {
    const referenceSlice = imageSize / 4;
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.addInitScript(() => {
      window.warmAudit = {
        phase: 'cold',
        timeOrigin: performance.timeOrigin,
        workerStarts: [],
        jobs: [],
        draws: [],
        longTasks: [],
      };
      new PerformanceObserver((entries) => {
        for (const entry of entries.getEntries())
          window.warmAudit.longTasks.push({
            phase: window.warmAudit.phase,
            at: entry.startTime,
            duration: entry.duration,
          });
      }).observe({ type: 'longtask', buffered: true });
      document.addEventListener(
        'cornerstoneimagerendered',
        (event) => {
          const element = event.target;
          if (!(element instanceof HTMLElement) || !element.closest('[data-diagnostic-surface]')) return;
          const imageId = element.dataset.imageId ?? null;
          if (imageId?.startsWith('miraderived:'))
            window.warmAudit.draws.push({ phase: window.warmAudit.phase, at: performance.now(), imageId });
        },
        true,
      );
      const NativeWorker = window.Worker;
      window.Worker = class extends NativeWorker {
        record?: Window['warmAudit']['jobs'][number];
        workerId: number | null;
        constructor(url: string | URL, options?: WorkerOptions) {
          const created = performance.now();
          super(url, options);
          this.workerId = String(url).includes('longitudinalRegistration.worker')
            ? window.warmAudit.workerStarts.length
            : null;
          if (this.workerId !== null) window.warmAudit.workerStarts.push({ created });
          this.addEventListener('message', (event) => {
            const record = this.record;
            if (event.data?.type !== 'done' || !record) return;
            const result = event.data.result;
            Object.assign(record, {
              finished: performance.now(),
              ok: result?.ok === true,
              outputBytes: (result?.pixels?.byteLength ?? 0) + (result?.valid?.byteLength ?? 0),
            });
            for (const [field, values] of [
              ['pixelsSha256', result?.pixels],
              ['supportSha256', result?.valid],
            ] as const) {
              if (!values) continue;
              void crypto.subtle
                .digest('SHA-256', new Uint8Array(values.buffer, values.byteOffset, values.byteLength))
                .then((digest) => {
                  record[field] = Array.from(new Uint8Array(digest), (value) =>
                    value.toString(16).padStart(2, '0'),
                  ).join('');
                });
            }
          });
        }
        postMessage(message: unknown, transfer?: Transferable[] | StructuredSerializeOptions) {
          const request = message as {
            type?: string;
            options?: {
              referencePlane?: { sopInstanceUid?: string };
              targetSlices?: { sopInstanceUid?: string; pixels: Float32Array; valid?: Uint8Array }[];
            };
          };
          if (request?.options?.targetSlices && this.workerId !== null) {
            this.record = {
              phase: window.warmAudit.phase,
              workerId: this.workerId,
              type: request.type,
              posted: performance.now(),
              reference: request.options.referencePlane?.sopInstanceUid,
              inputBytes: request.options.targetSlices.reduce(
                (sum, frame) => sum + frame.pixels.byteLength + (frame.valid?.byteLength ?? 0),
                0,
              ),
              sourceFrames: request.options.targetSlices.map((frame) => frame.sopInstanceUid ?? ''),
            };
            window.warmAudit.jobs.push(this.record);
          }
          if (Array.isArray(transfer)) super.postMessage(message, transfer);
          else super.postMessage(message, transfer);
        }
        terminate() {
          const at = performance.now();
          if (this.workerId !== null) window.warmAudit.workerStarts[this.workerId]!.terminated = at;
          if (this.record) this.record.terminated = at;
          super.terminate();
        }
      };
    });
    const inputDirectory = info.outputPath('dicom-input');
    const count = await importComparisonExaminations(
      page,
      null,
      undefined,
      true,
      {
        imageSize,
        slicesPerOrientation: imageSize / 2,
      },
      inputDirectory,
    );
    const target = page.locator('[data-diagnostic-surface] [data-image-id^="miraderived:"]').first();
    await expect(target).toBeVisible();
    await expect(page.getByLabel('Automatic alignment status')).toHaveText('Scans aligned');
    const phases = [];
    for (const [name, speed] of [
      ['warm-step', 0],
      ['playback-8', 1],
      ['playback-16', 2],
      ['playback-32', 4],
    ] as const) {
      const started = await page.evaluate((phase) => {
        window.warmAudit.phase = phase;
        return performance.now();
      }, name);
      if (!speed) {
        for (const slice of [1, 2, 3, 4].map((offset) => referenceSlice + offset)) {
          const before = await target.getAttribute('data-image-id');
          await goToSlice(page, slice);
          await expect(target).not.toHaveAttribute('data-image-id', before!);
          await expect(page.getByLabel('Automatic alignment status')).toHaveText('Scans aligned');
        }
      } else {
        await page.getByRole('button', { name: `Playback speed ${speed} times`, exact: true }).click();
        await page.getByRole('button', { name: 'Play slices', exact: true }).click();
        await page.evaluate(() => new Promise((resolve) => setTimeout(resolve, 2000)));
        await page.getByRole('button', { name: 'Pause slice playback', exact: true }).click();
      }
      const requestedAt = await page.evaluate(() => performance.now());
      await goToSlice(page, referenceSlice);
      await expect(page.getByLabel('Automatic alignment status')).toHaveText('Scans aligned');
      const completedAt = await page.evaluate(
        () =>
          new Promise<number>((resolve) =>
            requestAnimationFrame(() => requestAnimationFrame(() => resolve(performance.now()))),
          ),
      );
      phases.push({
        name,
        speed,
        started,
        requestedAt,
        completedAt,
        finalImageId: await target.getAttribute('data-image-id'),
      });
    }
    const measured = await page.evaluate(() => window.warmAudit);
    await attachReceipt(info, 'warm-browsing', {
      build: await (await page.request.get('/browser-build.json')).json(),
      browser: page.context().browser()!.version(),
      fixture: {
        files: count,
        rows: imageSize,
        columns: imageSize,
        slices: imageSize / 2,
        examinations: 2,
        inputDirectory,
      },
      phases,
      measured,
      errors,
      scope:
        'Native synthetic source planes and actual 8/16/32-slice controls. Worker input/output and visible render events are observed without changing production rendering. No anatomical or hardware-wide pacing claim.',
    });
    expect(errors).toEqual([]);
    expect(measured.jobs.filter((record) => record.phase !== 'cold' && record.type === 'estimate')).toEqual([]);
    for (const phase of phases) {
      expect(
        measured.draws.some(
          (draw) => draw.at >= phase.started && draw.at <= phase.requestedAt && draw.phase === phase.name,
        ),
      ).toBe(true);
      expect(
        measured.jobs.some((job) => job.phase === phase.name && job.ok && job.finished! <= phase.requestedAt),
        `Uncached native planes must complete during ${phase.name}`,
      ).toBe(true);
    }
  });
}

test('measures cold startup through first image and verifies the shipped RLE decoder', async ({ browser }, info) => {
  const samples = [];
  const rasters = new Set<string>();
  let build: Record<string, unknown> | undefined;
  for (const transferSyntax of ['explicit-vr-le', 'rle'] as const) {
    const file = createSyntheticSvrDicomFiles({ orientations: 1, transferSyntax })[12]!;
    const bytes = Buffer.from(await file.arrayBuffer());
    for (let sample = 0; sample < 5; sample++) {
      const context = await browser.newContext({
        baseURL: info.project.use.baseURL,
        viewport: info.project.use.viewport,
      });
      try {
        const page = await context.newPage();
        build ??= await (await page.request.get('/browser-build.json')).json();
        const errors: string[] = [];
        page.on('pageerror', (error) => errors.push(error.message));
        await page.addInitScript(() => {
          window.startupAudit = { longTasks: [] };
          new PerformanceObserver((list) => {
            for (const entry of list.getEntries())
              window.startupAudit.longTasks.push({ startTime: entry.startTime, duration: entry.duration });
          }).observe({ type: 'longtask', buffered: true });
          const shell = new MutationObserver(() => {
            if (!document.querySelector('.instrument-empty-heading')) return;
            shell.disconnect();
            requestAnimationFrame(() => {
              window.startupAudit.shellFrameMs = performance.now();
            });
          });
          shell.observe(document, { childList: true, subtree: true });
          document.addEventListener(
            'click',
            (event) => {
              const button = event.target instanceof Element ? event.target.closest('button') : null;
              if (button?.closest('dialog') && button.textContent?.trim() === 'Import scans')
                window.startupAudit.importStartedMs = performance.now();
              if (button?.closest('dialog') && button.textContent?.trim() === 'Done')
                requestAnimationFrame(() =>
                  requestAnimationFrame(() => {
                    window.startupAudit.imageUnblockedFrameMs = performance.now();
                  }),
                );
            },
            true,
          );
          document.addEventListener(
            'cornerstoneimagerendered',
            (event) => {
              if (event.target instanceof Element && event.target.closest('[data-diagnostic-surface]'))
                window.startupAudit.firstImageDrawMs ??= performance.now();
            },
            true,
          );
        });
        await page.goto('/');
        const trigger = page.getByRole('button', { name: 'Import scans', exact: true });
        await expect(trigger).toBeVisible();
        await expect.poll(() => page.evaluate(() => window.startupAudit.shellFrameMs)).toBeGreaterThan(0);
        await trigger.click();
        const intake = page.getByRole('dialog', { name: 'Import scans', exact: true });
        await expect(intake).toBeVisible();
        await intake
          .getByLabel('Select DICOM image files')
          .setInputFiles({ name: file.name, mimeType: 'application/dicom', buffer: bytes });
        await intake.getByRole('button', { name: 'Import scans', exact: true }).click();
        await expect(intake.getByText('Import complete', { exact: true })).toBeVisible();
        await intake.getByRole('button', { name: 'Done', exact: true }).click();
        await expect.poll(() => page.evaluate(() => window.startupAudit.firstImageDrawMs)).toBeGreaterThan(0);
        const canvas = page.locator('[data-diagnostic-surface] canvas').first();
        await expect(canvas).toBeVisible();
        const raster = await canvas.evaluate(async (canvas) => {
          const pixels = (canvas as HTMLCanvasElement)
            .getContext('2d')!
            .getImageData(0, 0, (canvas as HTMLCanvasElement).width, (canvas as HTMLCanvasElement).height).data;
          const levels = new Set<number>();
          for (let offset = 0; offset < pixels.length; offset += 16) levels.add(pixels[offset]!);
          const sha = await crypto.subtle.digest('SHA-256', new Uint8Array(pixels));
          return {
            levels: levels.size,
            sha256: Array.from(new Uint8Array(sha), (value) => value.toString(16).padStart(2, '0')).join(''),
          };
        });
        expect(raster.levels).toBeGreaterThan(5);
        rasters.add(raster.sha256);
        const measured = await page.evaluate(() => ({
          ...window.startupAudit,
          isolation: crossOriginIsolated,
          navigation: performance.getEntriesByType('navigation')[0]!.toJSON(),
          resources: performance.getEntriesByType('resource').map((entry) => entry.toJSON()),
        }));
        expect(measured.isolation).toBe(true);
        expect(errors).toEqual([]);
        samples.push({
          sample,
          transferSyntax,
          fixtureSha256: createHash('sha256').update(bytes).digest('hex'),
          ...measured,
          raster,
          errors,
        });
        if (sample === 0 && transferSyntax === 'rle') await capture(page, info, 'compressed-first-image');
      } finally {
        await context.close();
      }
    }
  }
  expect(rasters.size, 'Both transfer syntaxes must produce exactly the same displayed pixels').toBe(1);
  await attachReceipt(info, 'startup-and-codec', {
    build,
    browser: browser.version(),
    channel: info.project.use.channel,
    samples,
    scope:
      'Fresh contexts and HTTP caches, local normal-production assets, fixed synthetic source and viewport. Shell animation-frame and actual Cornerstone draw completion, not physical screen latency or general hardware pacing.',
  });
});

/** Incognito IndexedDB is in-memory, so it cannot establish disk-backed backup resource costs. */
async function withBackupBrowser<T>(info: TestInfo, consume: (context: BrowserContext) => Promise<T>): Promise<T> {
  const profile = await mkdtemp(join(tmpdir(), 'miraviewer-backup-profile-'));
  let context: BrowserContext | undefined;
  try {
    context = await chromium.launchPersistentContext(profile, {
      ...info.project.use.launchOptions,
      channel: info.project.use.channel,
      headless: info.project.use.headless,
      viewport: info.project.use.viewport,
      baseURL: 'http://127.0.0.1:43134',
      acceptDownloads: true,
    });
    return await consume(context);
  } finally {
    await context?.close();
    await rm(profile, { recursive: true, force: true });
  }
}

const backupTest = test.extend({
  context: async ({ browserName }, use, info) => {
    if (browserName !== 'chromium') throw new Error('The backup resource receipt requires Chromium IndexedDB.');
    await withBackupBrowser(info, use);
  },
});

async function readBackupContents(page: Page, verifyModels = false) {
  const records = await page.evaluate(async (verify) => {
    const read = <T>(request: IDBRequest<T>) =>
      new Promise<T>((resolve, reject) => {
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
    const db = await read(indexedDB.open('MiraViewerDB'));
    const digest = async (bytes: ArrayBuffer) =>
      Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), (byte) =>
        byte.toString(16).padStart(2, '0'),
      ).join('');
    try {
      const tx = db.transaction([
        'instances',
        'models',
        'panel_settings',
        'derived_alignment_frames',
        'app_state',
        'backup_staging',
      ]);
      const [images, models, settings, frames, token, staging] = await Promise.all([
        read(tx.objectStore('instances').getAll()) as Promise<DicomInstance[]>,
        read(tx.objectStore('models').getAll()) as Promise<ModelRecord[]>,
        read(tx.objectStore('panel_settings').getAll()) as Promise<PanelSettingsRow[]>,
        read(tx.objectStore('derived_alignment_frames').getAll()) as Promise<DerivedAlignmentFrameRow[]>,
        read(tx.objectStore('app_state').get('dataset_token')),
        read(tx.objectStore('backup_staging').count()),
      ]);
      const modelRecords = [];
      for (const model of models) {
        let matches = true;
        const expected = 0x40 + Number(model.key.split('-').at(-1));
        for (let offset = 0; verify && offset < model.blob.size; offset += 1024 * 1024) {
          const bytes = new Uint8Array(await model.blob.slice(offset, offset + 1024 * 1024).arrayBuffer());
          if (!bytes.every((byte) => byte === expected)) matches = false;
        }
        modelRecords.push({
          key: model.key,
          bytes: model.blob.size,
          savedAtMs: model.savedAtMs,
          matches: verify ? matches : null,
        });
      }
      return {
        token: token?.value as string,
        staging,
        images: await Promise.all(
          images.map(async (row) => ({
            uid: row.sopInstanceUid,
            sha256: await digest(await row.fileBlob.arrayBuffer()),
          })),
        ),
        models: modelRecords,
        settings,
        frames: await Promise.all(
          frames.map(async (row) => ({
            id: row.id,
            pixels: await digest(Float32Array.from(row.pixels).buffer),
            valid: row.valid ? await digest(Uint8Array.from(row.valid).buffer) : null,
            sourceImageId: row.sourceImageId,
            referenceSopInstanceUid: row.referenceSopInstanceUid,
          })),
        ),
      };
    } finally {
      db.close();
    }
  }, verifyModels);
  return { ...records, selections: await savedVolumeSelections(page) };
}

function verifyBackupArchive(archive: string, corrupted?: string) {
  return JSON.parse(
    execFileSync(
      'python3',
      [
        '-c',
        `
import hashlib,json,os,struct,sys,zipfile
archive=sys.argv[1]; corrupted=sys.argv[2] if len(sys.argv)>2 else None; offset=None
with zipfile.ZipFile(archive) as z:
 m=json.loads(z.read('export.json')); files=[]
 for kind in ['instances','volumeSegmentations','derivedAlignmentFrames','models']:
  for row in m['records'].get(kind,[]):
   for field in ['file','validFile']:
    if field not in row: continue
    desc=row[field]; h=hashlib.sha256(); count=0
    with z.open(desc['path']) as member:
     while chunk:=member.read(1024*1024): h.update(chunk); count+=len(chunk)
    assert count==desc['byteLength'] and h.hexdigest()==desc['sha256']
    files.append({'path':desc['path'],'bytes':count,'sha256':h.hexdigest()})
 if corrupted:
  target=z.getinfo(m['records']['models'][0]['file']['path'])
  with open(corrupted,'r+b') as f:
   f.seek(target.header_offset); header=f.read(30)
   offset=target.header_offset+30+sum(struct.unpack_from('<HH',header,26))
   f.seek(offset); value=f.read(1); f.seek(offset); f.write(bytes([value[0]^255]))
print(json.dumps({'physicalBytes':os.path.getsize(archive),'verifiedMembers':len(files),'files':files,'corruptedOffset':offset}))
`,
        archive,
        ...(corrupted ? [corrupted] : []),
      ],
      { encoding: 'utf8', maxBuffer: 1024 * 1024 },
    ),
  );
}

backupTest(
  'backup capacity streams a multi-GiB archive and preserves saved work across failed and successful restores',
  async ({ page }, info) => {
    test.setTimeout(720_000);
    const errors: string[] = [];
    let downloads = 0;
    page.on('pageerror', (error) => errors.push(error.message));
    page.on('download', () => downloads++);
    await page.context().addInitScript(() => {
      const io: Window['backupIo'] = {
        current: null,
        start(name) {
          this.current = {
            name,
            startedAt: Date.now(),
            arrayBufferBytes: 0,
            maxArrayBufferBytes: 0,
            streamBytes: 0,
            maxStreamChunkBytes: 0,
            pending: 0,
            lastReadAt: Date.now(),
          };
        },
        stop() {
          const result = { ...this.current!, finishedAt: Date.now() };
          this.current = null;
          return result;
        },
      };
      window.backupIo = io;
      const arrayBuffer = Blob.prototype.arrayBuffer;
      Blob.prototype.arrayBuffer = function () {
        const record = io.current;
        if (record) {
          record.arrayBufferBytes += this.size;
          record.maxArrayBufferBytes = Math.max(record.maxArrayBufferBytes, this.size);
          record.pending++;
          record.lastReadAt = Date.now();
        }
        return arrayBuffer.call(this).finally(() => {
          if (record) {
            record.pending--;
            record.lastReadAt = Date.now();
          }
        });
      };
      const read = ReadableStreamDefaultReader.prototype.read;
      ReadableStreamDefaultReader.prototype.read = function () {
        const record = io.current;
        if (record) record.pending++;
        return read
          .call(this)
          .then((result) => {
            if (record && result.value instanceof Uint8Array) {
              record.streamBytes += result.value.byteLength;
              record.maxStreamChunkBytes = Math.max(record.maxStreamChunkBytes, result.value.byteLength);
            }
            return result;
          })
          .finally(() => {
            if (record) {
              record.pending--;
              record.lastReadAt = Date.now();
            }
          });
      };
    });
    await page.goto('/');
    await page.getByRole('button', { name: 'Import scans', exact: true }).click();
    const intake = page.getByRole('dialog', { name: 'Import scans' });
    const files = await Promise.all(
      createSyntheticSvrDicomFiles({
        imageSize: 256,
        slicesPerOrientation: 128,
        orientations: 1,
        pixelPaddingValue: null,
      }).map(async (file) => ({ name: file.name, mimeType: file.type, buffer: Buffer.from(await file.arrayBuffer()) })),
    );
    await intake.getByLabel('Select DICOM image files').setInputFiles(files);
    await intake.getByRole('button', { name: 'Import scans', exact: true }).click();
    await expect(intake.getByText('Import complete', { exact: true })).toBeVisible();
    await intake.getByRole('button', { name: 'Done', exact: true }).click();
    const source = await page.evaluate(async (defaults) => {
      const read = <T>(request: IDBRequest<T>) =>
        new Promise<T>((resolve, reject) => {
          request.onsuccess = () => resolve(request.result);
          request.onerror = () => reject(request.error);
        });
      const done = (tx: IDBTransaction) =>
        new Promise<void>((resolve, reject) => {
          tx.oncomplete = () => resolve();
          tx.onabort = () => reject(tx.error);
        });
      const db = await read(indexedDB.open('MiraViewerDB'));
      try {
        const images = (await read(db.transaction('instances').objectStore('instances').getAll())) as DicomInstance[];
        images.sort((a, b) => a.instanceNumber - b.instanceNumber);
        const first = images[0]!;
        const patientKey = (
          await read(db.transaction('app_state').objectStore('app_state').get('selected_patient_key'))
        ).value as string;
        const labels = new Uint8Array(256 * 256 * 128);
        for (let offset = 0; offset < labels.length; offset += 4096) labels[offset] = 1;
        labels[labels.length - 1] = 2;
        const seeds = {
          foreground: Uint32Array.of(0, 4096, labels.length - 1),
          background: Uint32Array.of(1, 4097),
          lastStroke: { plane: 'axial', slice: 127 },
        };
        const tx = db.transaction(['panel_settings', 'volume_segmentations', 'derived_alignment_frames'], 'readwrite');
        tx.objectStore('panel_settings').put({
          comboId: `source:${encodeURIComponent(first.seriesInstanceUid)}`,
          source: { studyUid: first.studyInstanceUid, seriesUid: first.seriesInstanceUid },
          settings: { [first.studyInstanceUid]: { ...defaults, zoom: 1.25, panX: 0.12 } },
        });
        tx.objectStore('volume_segmentations').put({
          volumeKey: 'synthetic-backup-selection',
          patientKey,
          studyUid: first.studyInstanceUid,
          seriesUids: [first.seriesInstanceUid],
          dims: [256, 256, 128],
          labels,
          seeds,
          reviewState: 'reviewed',
          updatedAt: 123,
        });
        tx.objectStore('derived_alignment_frames').put({
          id: 'synthetic-backup-plane',
          patientKey,
          datasetRevision: 1,
          sequenceId: 'synthetic-sequence',
          targetStudyUid: first.studyInstanceUid,
          targetSeriesUid: first.seriesInstanceUid,
          targetSopInstanceUid: first.sopInstanceUid,
          targetFrameIndex: 0,
          referenceStudyUid: first.studyInstanceUid,
          referenceSeriesUid: first.seriesInstanceUid,
          referenceSopInstanceUid: first.sopInstanceUid,
          referenceFrameIndex: 0,
          referenceImagePositionPatient: first.imagePositionPatient,
          referenceImageOrientationPatient: first.imageOrientationPatient,
          referencePixelSpacing: first.pixelSpacing,
          referenceRows: first.rows,
          referenceColumns: first.columns,
          rows: first.rows,
          columns: first.columns,
          sourceImageId: `miradb:${first.sopInstanceUid}`,
          pixels: new Float32Array(first.rows * first.columns).fill(12.5),
          valid: new Uint8Array(first.rows * first.columns).fill(1),
          createdAt: 123,
        });
        await done(tx);
        for (let index = 0; index < 16; index++) {
          // Real native Blob payloads and real persisted bytes, never fake size getters.
          // One model transaction at a time keeps fixture construction bounded too.
          const tile = new Blob([new Uint8Array(1024 * 1024).fill(0x40 + index)]);
          const blob = new Blob(Array.from({ length: 128 }, () => tile));
          const key = `synthetic-large-${String(index).padStart(2, '0')}`;
          const tx = db.transaction('models', 'readwrite');
          tx.objectStore('models').put({ key, blob, savedAtMs: index + 1 }, key);
          await done(tx);
        }
        return { imageCount: images.length, labelBytes: labels.length, modelBytes: 16 * 128 * 1024 * 1024 };
      } finally {
        db.close();
      }
    }, DEFAULT_PANEL_SETTINGS);
    const expected = await readBackupContents(page);
    expect(expected.images).toHaveLength(128);
    expect(expected.images.map((image) => image.sha256).sort()).toEqual(
      files.map((file) => createHash('sha256').update(file.buffer).digest('hex')).sort(),
    );
    expect(expected.models.reduce((sum, row) => sum + row.bytes, 0)).toBe(2 * 1024 ** 3);
    const phases: BackupIo[] = [];
    const openExport = async () => {
      await page.getByRole('button', { name: 'Application menu' }).click();
      await page.getByRole('button', { name: 'Export backup (ZIP)' }).click();
      return page.getByRole('dialog', { name: 'Export Backup (ZIP)' });
    };
    let dialog = await openExport();
    await page.evaluate(() => window.backupIo.start('export-cancel'));
    await dialog.getByRole('button', { name: 'Export', exact: true }).click();
    await page.waitForFunction(() => (window.backupIo.current?.arrayBufferBytes ?? 0) > 1024 * 1024);
    const exportCancelAt = Date.now();
    await dialog.getByRole('button', { name: 'Cancel export', exact: true }).click();
    await page.waitForFunction(
      () => window.backupIo.current?.pending === 0 && Date.now() - window.backupIo.current.lastReadAt > 250,
    );
    phases.push(await page.evaluate(() => window.backupIo.stop()));
    const exportCancelSettledMs = Date.now() - exportCancelAt;
    expect(downloads).toBe(0);
    dialog = await openExport();
    await page.evaluate(() => window.backupIo.start('export-multi-gib-download'));
    const downloaded = page.waitForEvent('download', { timeout: 240_000 });
    await dialog.getByRole('button', { name: 'Export', exact: true }).click();
    const download = await downloaded;
    const archive = info.outputPath('synthetic-multi-gib-backup.zip');
    await download.saveAs(archive);
    expect(await download.failure()).toBeNull();
    phases.push(await page.evaluate(() => window.backupIo.stop()));
    expect((await stat(archive)).size).toBeGreaterThan(2 * 1024 ** 3);
    expect(phases.at(-1)!.maxArrayBufferBytes).toBeLessThanOrEqual(1024 * 1024);

    const corrupted = info.outputPath('synthetic-corrupted-backup.zip');
    if (process.platform === 'darwin') execFileSync('/bin/cp', ['-c', archive, corrupted]);
    else await copyFile(archive, corrupted, constants.COPYFILE_FICLONE);
    // Independent stdlib ZIP reader checks every physical member's CRC and SHA
    // with bounded reads. Only the cloned negative fixture receives a byte flip.
    const independent = verifyBackupArchive(archive, corrupted);
    expect(independent.verifiedMembers).toBe(147); // 128 images, labels, pixels/support, 16 models.
    await attachReceipt(info, 'streaming-backup-export-checkpoint', {
      source,
      phases,
      independent,
      expected,
      exportCancelSettledMs,
    });

    // Keep a different valid dataset visible while trying cancel/corruption/quota.
    await expect(dialog).not.toBeVisible();
    await page.evaluate(async () => {
      const read = <T>(request: IDBRequest<T>) =>
        new Promise<T>((resolve, reject) => {
          request.onsuccess = () => resolve(request.result);
          request.onerror = () => reject(request.error);
        });
      const db = await read(indexedDB.open('MiraViewerDB'));
      try {
        const tx = db.transaction(['models', 'volume_segmentations', 'panel_settings'], 'readwrite');
        for (let index = 0; index < 16; index++) {
          const key = `synthetic-large-${String(index).padStart(2, '0')}`;
          tx.objectStore('models').put(
            { key, blob: new Blob([new Uint8Array(1024 * 1024).fill(0x40 + index)]), savedAtMs: index + 1 },
            key,
          );
        }
        const selection = await read(tx.objectStore('volume_segmentations').get('synthetic-backup-selection'));
        selection.labels[0] = 0;
        selection.seeds.foreground = Uint32Array.of(4096);
        selection.seeds.background = Uint32Array.of(0, 1);
        selection.reviewState = 'draft';
        tx.objectStore('volume_segmentations').put(selection);
        for (const row of (await read(tx.objectStore('panel_settings').getAll())) as PanelSettingsRow[]) {
          for (const value of Object.values(row.settings)) value.zoom = 1.75;
          tx.objectStore('panel_settings').put(row);
        }
        await new Promise<void>((resolve, reject) => {
          tx.oncomplete = () => resolve();
          tx.onabort = () => reject(tx.error);
        });
      } finally {
        db.close();
      }
    });
    await page.reload();
    await expect(page.getByRole('button', { name: 'Application menu' })).toBeVisible();
    const previous = await readBackupContents(page, true);
    const failures = [];
    for (const reason of ['cancel', 'corrupt', 'publication-quota'] as const) {
      await page.getByRole('button', { name: 'Import additional scans', exact: true }).click();
      const restore = page.getByRole('dialog', { name: 'Import scans' });
      await restore
        .getByLabel('Select a complete backup or image archive')
        .setInputFiles(reason === 'corrupt' ? corrupted : archive);
      await expect(restore.getByText(/allow space for two copies/i)).toBeVisible();
      if (reason === 'cancel') await capture(page, info, 'streaming-backup-restore-review');
      await restore.getByRole('checkbox').check();
      if (reason === 'publication-quota')
        await page.evaluate(() => {
          const put = IDBObjectStore.prototype.put;
          IDBObjectStore.prototype.put = function (...args) {
            if (this.name === 'models')
              throw new DOMException('Synthetic publication quota exhausted', 'QuotaExceededError');
            return Reflect.apply(put, this, args);
          };
          window.restoreBackupWrites = () => {
            IDBObjectStore.prototype.put = put;
          };
        });
      await page.evaluate((name) => window.backupIo.start(name), `restore-${reason}`);
      await restore.getByRole('button', { name: 'Restore complete backup', exact: true }).click();
      let cancelSettledMs: number | undefined;
      if (reason === 'cancel') {
        await expect
          .poll(() =>
            page.evaluate(async () => {
              const db = await new Promise<IDBDatabase>((resolve, reject) => {
                const r = indexedDB.open('MiraViewerDB');
                r.onsuccess = () => resolve(r.result);
                r.onerror = () => reject(r.error);
              });
              try {
                return await new Promise<number>((resolve, reject) => {
                  const r = db.transaction('backup_staging').objectStore('backup_staging').count();
                  r.onsuccess = () => resolve(r.result);
                  r.onerror = () => reject(r.error);
                });
              } finally {
                db.close();
              }
            }),
          )
          .toBeGreaterThan(0);
        const cancelAt = Date.now();
        await restore.getByRole('button', { name: 'Cancel import', exact: true }).click();
        await expect(restore.getByText('Import canceled', { exact: true })).toBeVisible();
        cancelSettledMs = Date.now() - cancelAt;
      } else
        await expect(restore.getByRole('alert')).toContainText(
          reason === 'corrupt' ? /CRC32|integrity/ : /publication quota exhausted/,
          { timeout: 240_000 },
        );
      phases.push(await page.evaluate(() => window.backupIo.stop()));
      await page.evaluate(() => window.restoreBackupWrites?.());
      const actual = await readBackupContents(page, true);
      await attachReceipt(info, `streaming-backup-${reason}-checkpoint`, {
        previous,
        actual,
        phase: phases.at(-1),
        cancelSettledMs,
      });
      expect(actual).toEqual(previous);
      failures.push({ reason, unchanged: true, cancelSettledMs });
      await restore.getByRole('button', { name: 'Done', exact: true }).click();
    }

    // Exercise the other output path with a real native writable file. Only the
    // OS picker is substituted; writes, abort/close and readback use Chromium OPFS.
    await page.evaluate(async () => {
      const root = await navigator.storage.getDirectory();
      const handle = await root.getFileHandle('synthetic-direct-backup.zip', { create: true });
      Object.defineProperty(window, 'showSaveFilePicker', { configurable: true, value: async () => handle });
    });
    dialog = await openExport();
    await page.evaluate(() => window.backupIo.start('export-native-file'));
    await dialog.getByRole('button', { name: 'Save directly…' }).click();
    await expect(dialog.getByText('Export complete')).toBeVisible({ timeout: 90_000 });
    phases.push(await page.evaluate(() => window.backupIo.stop()));
    const nativeDownloaded = page.waitForEvent('download');
    const nativeFileBytes = await page.evaluate(async () => {
      const root = await navigator.storage.getDirectory();
      const file = await (await root.getFileHandle('synthetic-direct-backup.zip')).getFile();
      const link = document.createElement('a');
      link.href = URL.createObjectURL(file);
      link.download = 'native-file-backup.zip';
      link.click();
      URL.revokeObjectURL(link.href);
      return file.size;
    });
    expect(nativeFileBytes).toBeGreaterThan(32 * 1024 * 1024);
    const nativeDownload = await nativeDownloaded;
    const nativeArchive = info.outputPath('synthetic-native-file-backup.zip');
    await nativeDownload.saveAs(nativeArchive);
    expect(await nativeDownload.failure()).toBeNull();
    const nativeVerification = verifyBackupArchive(nativeArchive);
    expect(nativeVerification.verifiedMembers).toBe(independent.verifiedMembers);

    let restored;
    let restoreTiming;
    let nativeRestored;
    await withBackupBrowser(info, async (context) => {
      const target = await context.newPage();
      target.on('pageerror', (error) => errors.push(error.message));
      await target.goto('http://127.0.0.1:43134/');
      await target.getByRole('button', { name: 'Import scans', exact: true }).click();
      const restore = target.getByRole('dialog', { name: 'Import scans' });
      await restore.getByLabel('Select a complete backup or image archive').setInputFiles(archive);
      await restore.getByRole('checkbox').check();
      const startedAt = Date.now();
      await restore.getByRole('button', { name: 'Restore complete backup', exact: true }).click();
      await expect(restore.getByText('Complete backup restored', { exact: true })).toBeVisible({ timeout: 240_000 });
      restoreTiming = { startedAt, finishedAt: Date.now() };
      restored = await readBackupContents(target, true);
      expect(restored.staging).toBe(0);
      expect(restored.images).toEqual(expected.images);
      expect(restored.models.map((row) => ({ ...row, matches: null }))).toEqual(expected.models);
      expect(restored.models.every((row) => row.matches)).toBe(true);
      expect(restored.settings).toEqual(expected.settings);
      expect(restored.frames).toEqual(expected.frames);
      expect(restored.selections).toEqual(expected.selections);
      await restore.getByRole('button', { name: 'Done', exact: true }).click();
      await target.getByRole('button', { name: 'Import additional scans', exact: true }).click();
      await restore.getByLabel('Select a complete backup or image archive').setInputFiles(nativeArchive);
      await restore.getByRole('checkbox').check();
      await restore.getByRole('button', { name: 'Restore complete backup', exact: true }).click();
      await expect(restore.getByText('Complete backup restored', { exact: true })).toBeVisible({ timeout: 90_000 });
      nativeRestored = await readBackupContents(target, true);
      expect(nativeRestored.token).not.toBe(previous.token);
      expect({ ...nativeRestored, token: previous.token }).toEqual(previous);
    });
    expect(errors).toEqual([]);
    await attachReceipt(info, 'streaming-backup-receipt', {
      build: await (await page.request.get('/browser-build.json')).json(),
      browser: page.context().browser()!.version(),
      source,
      storage: 'Separate disposable persistent Chromium profiles with disk-backed IndexedDB, not incognito contexts.',
      archiveBytes: (await stat(archive)).size,
      independent,
      phases,
      exportCancelSettledMs,
      failures,
      nativeFileBytes,
      restored,
      restoreTiming,
      nativeVerification,
      nativeRestored,
      errors,
      scope:
        'Normal production app, real multi-GiB ZIP and fresh-context restore, 128 generated DICOMs, labels, literal marks, source settings, derived pixels/support and opaque synthetic model bytes. Whole physical members independently CRC/SHA-verified with Python zipfile. Browser process RSS is recorded by the owned runner. Native file output uses a real OPFS FileSystemWritableFileStream with only the picker substituted; no OS-picker or inference claim. No private inputs.',
    });
  },
);

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
