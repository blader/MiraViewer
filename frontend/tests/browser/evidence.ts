import { writeFile } from 'node:fs/promises';
import type { Page, TestInfo } from '@playwright/test';
import type { StoredVolumeSegmentationRow, VolumeSegmentationChunk } from '../../src/db/schema';

/** Independent durable readback, including the earlier dense format used by comparison builds. */
export async function savedVolumeSelections(page: Page) {
  return page.evaluate(async () => {
    const read = <T>(request: IDBRequest<T>) =>
      new Promise<T>((resolve, reject) => {
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
    const db = await read(indexedDB.open('MiraViewerDB'));
    try {
      const chunked = db.objectStoreNames.contains('volume_segmentation_chunks');
      const transaction = db.transaction(
        chunked ? ['volume_segmentations', 'volume_segmentation_chunks'] : ['volume_segmentations'],
      );
      const rows = (await read(
        transaction.objectStore('volume_segmentations').getAll(),
      )) as StoredVolumeSegmentationRow[];
      const masks = [];
      for (const row of rows) {
        let labels: Uint8Array;
        if ('labels' in row) labels = row.labels;
        else {
          const chunks = (await read(
            transaction
              .objectStore('volume_segmentation_chunks')
              .getAll(IDBKeyRange.bound([row.volumeKey, 0], [row.volumeKey, Number.MAX_SAFE_INTEGER])),
          )) as VolumeSegmentationChunk[];
          if (chunks.length !== row.chunkCount) throw new Error('Incomplete saved label chunks.');
          labels = new Uint8Array(row.labelBytes);
          for (const chunk of chunks) labels.set(chunk.data, chunk.offset);
        }
        masks.push({ row, labels });
      }
      return await Promise.all(
        masks.map(async ({ row, labels }) => ({
          volumeKey: row.volumeKey,
          dims: row.dims,
          modelKey: row.modelKey,
          reviewState: row.reviewState,
          labelBytes: labels.byteLength,
          selectedCount: labels.reduce((count, label) => count + Number(label > 0), 0),
          labelsSha256: Array.from(
            new Uint8Array(await crypto.subtle.digest('SHA-256', Uint8Array.from(labels))),
            (value) => value.toString(16).padStart(2, '0'),
          ).join(''),
          seeds: row.seeds
            ? {
                foreground: Array.from(row.seeds.foreground),
                background: Array.from(row.seeds.background),
                lastStroke: row.seeds.lastStroke,
              }
            : undefined,
        })),
      );
    } finally {
      db.close();
    }
  });
}

export async function attachReceipt(info: TestInfo, name: string, value: unknown) {
  const path = info.outputPath(`${name}.json`);
  await writeFile(path, JSON.stringify(value, null, 2));
  await info.attach(name, { path, contentType: 'application/json' });
}

export async function capture(page: Page, info: TestInfo, name: string) {
  const path = info.outputPath(`${name}.png`);
  await page.screenshot({ path });
  await info.attach(name, { path, contentType: 'image/png' });
}
