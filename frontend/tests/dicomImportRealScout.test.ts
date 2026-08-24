import { closeSync, openSync, readFileSync, readdirSync, readSync, statSync } from 'node:fs';
import { join } from 'node:path';
import dicomParser from 'dicom-parser';
import { afterEach, describe, expect, it } from 'vitest';
import { getDB, resetDbForTests } from '../src/db/db';
import { processFiles } from '../src/services/dicomIngestion';

const corpusDirectory = process.env.MIRAVIEWER_IMPORT_CORPUS_DIR;
const runCorpus = corpusDirectory ? it : it.skip;

function* walkDicomFiles(directory: string): Generator<string> {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.name.startsWith('.')) continue;
    const path = join(directory, entry.name);
    if (entry.isDirectory()) yield* walkDicomFiles(path);
    else if (entry.isFile() && entry.name.toLowerCase().endsWith('.dcm')) yield path;
  }
}

function readScoutHeader(path: string): { seriesUid: string; orientation: string } | undefined {
  const descriptor = openSync(path, 'r');
  try {
    const header = new Uint8Array(Math.min(16 * 1024, statSync(path).size));
    const length = readSync(descriptor, header, 0, header.length, 0);
    let dataSet: dicomParser.DataSet | undefined;
    try {
      dataSet = dicomParser.parseDicom(header.subarray(0, length), { untilTag: 'x00200037' });
    } catch (error) {
      if (typeof error === 'object' && error && 'dataSet' in error) dataSet = error.dataSet as dicomParser.DataSet;
    }
    if (!dataSet) return undefined;
    const description = ['x0008103e', 'x00181030', 'x00180024', 'x00080008']
      .map((tag) => dataSet.string(tag) ?? '')
      .join(' ');
    if (!/(?:locali[sz]er|scout|survey)/i.test(description)) return undefined;
    const seriesUid = dataSet.string('x0020000e');
    const orientation = dataSet.string('x00200037');
    return seriesUid && orientation ? { seriesUid, orientation } : undefined;
  } catch {
    return undefined;
  } finally {
    closeSync(descriptor);
  }
}

function findHeterogeneousScout(directory: string): { files: File[]; orientationCount: number } {
  for (const folder of readdirSync(directory, { withFileTypes: true })) {
    if (!folder.isDirectory() || folder.name.startsWith('.')) continue;
    const groups = new Map<string, { paths: string[]; orientations: Set<string> }>();
    let inspected = 0;
    for (const path of walkDicomFiles(join(directory, folder.name))) {
      const header = readScoutHeader(path);
      if (header) {
        let group = groups.get(header.seriesUid);
        if (!group) {
          group = { paths: [], orientations: new Set() };
          groups.set(header.seriesUid, group);
        }
        group.paths.push(path);
        group.orientations.add(header.orientation);
        if (group.paths.length >= 9 && group.orientations.size >= 3) {
          return {
            files: group.paths.map(
              (source, index) =>
                new File([readFileSync(source)], `protected-scout-${index}.dcm`, { type: 'application/dicom' }),
            ),
            orientationCount: group.orientations.size,
          };
        }
      }
      if (++inspected >= 300) break;
    }
  }
  throw new Error('No representative multi-orientation scout was found in the bounded protected-corpus sample.');
}

describe('optional protected heterogeneous scout admission', () => {
  afterEach(async () => {
    await resetDbForTests();
    await new Promise<void>((resolve) => {
      const request = indexedDB.deleteDatabase('MiraViewerDB');
      request.onsuccess = () => resolve();
      request.onerror = () => resolve();
      request.onblocked = () => resolve();
    });
  });

  runCorpus(
    'classifies genuine orthogonal scout frames explicitly without weakening diagnostic stack geometry',
    async () => {
      const sample = findHeterogeneousScout(corpusDirectory!);
      const summary = await processFiles(sample.files, undefined, { batchMaxItems: 64 });

      expect(sample.orientationCount).toBe(3);
      expect(summary).toMatchObject({
        total: 9,
        ingested: 3,
        skipped: 6,
        errors: 0,
        skipReasons: { 'excluded-localizer-orientation': 6 },
      });
      expect(await (await getDB()).count('instances')).toBe(3);
      console.info(
        `[import-scout-corpus] ${JSON.stringify({
          frames: sample.files.length,
          orientations: sample.orientationCount,
          imported: summary.ingested,
          excludedLocalizers: summary.skipReasons?.['excluded-localizer-orientation'] ?? 0,
          errors: summary.errors,
        })}`,
      );
    },
  );
});
