import { expect } from '@playwright/test';
import type { Page } from '@playwright/test';
import { createSyntheticSvrDicomFiles } from '../svrSyntheticDicom';
import type { SyntheticSvrFixtureOptions } from '../svrSyntheticDicom';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';

export async function expectAcquiredPixels(page: Page) {
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

export async function goToSlice(page: Page, slice: number) {
  const field = page.getByRole('spinbutton', { name: 'Go to slice' });
  await field.fill(String(slice));
  await field.press('Enter');
  await expect(page.getByRole('group', { name: `Pan MRI slice ${slice}`, exact: true }).first()).toBeVisible();
}

export async function importComparisonExaminations(
  page: Page,
  pixelPaddingValue: 0 | null,
  examinations = [
    { studyUid: '1.2.826.0.1.3680043.10.543.20350701.1', studyDate: '20350701' },
    { studyUid: '1.2.826.0.1.3680043.10.543.20360701.1', studyDate: '20360701' },
  ],
  nativeOnly = false,
  fixture: Pick<SyntheticSvrFixtureOptions, 'imageSize' | 'slicesPerOrientation'> = {},
  inputDirectory?: string,
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
            orientations: nativeOnly ? 1 : 3,
            pixelPaddingValue,
            ...examination,
            ...fixture,
          }).map(async (file) => ({
            name: `exam-${index}-${file.name}`,
            mimeType: file.type,
            buffer: Buffer.from(await file.arrayBuffer()),
          })),
        ),
      ),
    )
  ).flat();
  const intake = page.getByRole('dialog', { name: 'Import scans' });
  if (inputDirectory) {
    await mkdir(inputDirectory, { recursive: true });
    const inputs = [];
    for (const file of files) {
      const path = join(inputDirectory, file.name);
      await writeFile(path, file.buffer, { flag: 'wx' });
      inputs.push({ path, bytes: file.buffer.length, sha256: createHash('sha256').update(file.buffer).digest('hex') });
    }
    await writeFile(
      join(inputDirectory, 'manifest.json'),
      JSON.stringify({ fixture: 'synthetic only', inputs }, null, 2),
      { flag: 'wx' },
    );
    await intake.getByLabel('Select DICOM image files').setInputFiles(inputs.map((input) => input.path));
  } else {
    await intake.getByLabel('Select DICOM image files').setInputFiles(files);
  }
  await intake.getByRole('button', { name: 'Import scans', exact: true }).click();
  await expect(intake.getByText('Import complete', { exact: true })).toBeVisible();
  await intake.getByRole('button', { name: 'Done', exact: true }).click();
  await goToSlice(page, Math.max(1, Math.floor((fixture.slicesPerOrientation ?? 24) / 2)));
  return files.length;
}
