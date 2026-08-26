import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { getDB, resetDbForTests } from '../src/db/db';
import { getPatientIdentityKeys } from '../src/db/patientIdentity';
import { processFiles } from '../src/services/dicomIngestion';
import { getComparisonData, getDatasetRevision, getSeriesFrameManifest } from '../src/utils/localApi';

const corpusDirectory = process.env.MIRAVIEWER_IMPORT_CORPUS_DIR;
const runCorpus = corpusDirectory ? it : it.skip;
const runFullCorpus = corpusDirectory && process.env.MIRAVIEWER_IMPORT_CORPUS_SWEEP === '1' ? it : it.skip;

function* walkDicomFiles(directory: string): Generator<string> {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.name.startsWith('.')) continue;
    const path = join(directory, entry.name);
    if (entry.isDirectory()) yield* walkDicomFiles(path);
    else if (entry.isFile() && entry.name.toLowerCase().endsWith('.dcm')) yield path;
  }
}

function safeAdmissionFailureCategory(message: string): string {
  if (message.includes('slice orientations')) return 'incompatible-slice-orientation';
  if (message.includes('row or column dimensions')) return 'incompatible-image-dimensions';
  if (message.includes('row or column spacing')) return 'incompatible-pixel-spacing';
  if (message.includes('spatial frames of reference')) return 'incompatible-frame-of-reference';
  if (message.includes('patient identity')) return 'conflicting-patient-identity';
  if (message.includes('patient-identifier issuer')) return 'conflicting-patient-issuer';
  if (message.includes('patient names')) return 'conflicting-patient-name';
  if (message.includes('different examination')) return 'conflicting-examination-ownership';
  if (message.includes('multi-frame')) return 'unsupported-multiframe';
  if (message.includes('Insufficient browser storage')) return 'insufficient-storage';
  if (message.includes('Invalid DICOM')) return 'invalid-dicom-geometry';
  if (message.includes('Failed to store')) return 'generic-storage-failure';
  return 'unclassified-safe-admission-failure';
}

describe('optional private real-MRI import corpus validation', () => {
  afterEach(async () => {
    vi.restoreAllMocks();
    await resetDbForTests();
    await new Promise<void>((resolve) => {
      const request = indexedDB.deleteDatabase('MiraViewerDB');
      request.onsuccess = () => resolve();
      request.onerror = () => resolve();
      request.onblocked = () => resolve();
    });
  });

  runCorpus(
    'imports representative protected MRI acquisitions safely and replays duplicates without writes',
    async () => {
      const files: File[] = [];
      let totalBytes = 0;
      const requestedLimit = Number(process.env.MIRAVIEWER_IMPORT_CORPUS_LIMIT ?? '512');
      const limit = Number.isSafeInteger(requestedLimit) && requestedLimit > 0 ? requestedLimit : 512;

      for (const path of walkDicomFiles(corpusDirectory!)) {
        const bytes = readFileSync(path);
        totalBytes += bytes.byteLength;
        files.push(
          new File([bytes], `protected-corpus-validation-${String(files.length).padStart(4, '0')}.dcm`, {
            type: 'application/dicom',
          }),
        );
        if (files.length >= limit) break;
      }

      expect(files).toHaveLength(limit);
      const output = vi.spyOn(console, 'log').mockImplementation(() => undefined);
      const info = vi.spyOn(console, 'info').mockImplementation(() => undefined);
      const warning = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
      const transactions = vi.spyOn(IDBDatabase.prototype, 'transaction');
      const writesBefore = () =>
        transactions.mock.calls.filter(([, mode]) => mode === 'readwrite' || mode === 'readwriteflush').length;

      const coldStartedAt = performance.now();
      const cold = await processFiles(files, undefined, { batchMaxItems: 64 });
      const coldMilliseconds = performance.now() - coldStartedAt;
      const coldWriteTransactions = writesBefore();

      expect(cold.total).toBe(limit);
      expect(cold.ingested).toBeGreaterThan(0);
      expect(cold.errors).toBe(0);
      expect(cold.ingested + cold.duplicates + cold.skipped).toBe(limit);
      expect(coldWriteTransactions).toBeLessThanOrEqual(Math.ceil(cold.ingested / 64) * 2 + 4);
      expect(await getDatasetRevision()).toBe(cold.ingested);

      const writesBeforeReplay = writesBefore();
      const replayStartedAt = performance.now();
      const replay = await processFiles(files, undefined, { batchMaxItems: 64 });
      const replayMilliseconds = performance.now() - replayStartedAt;
      const replayWriteTransactions = writesBefore() - writesBeforeReplay;

      expect(replay.ingested).toBe(0);
      expect(replay.errors).toBe(0);
      expect(replay.duplicates).toBe(cold.ingested);
      expect(replay.skipped).toBe(cold.skipped);
      expect(replayWriteTransactions).toBe(0);
      expect(await getDatasetRevision()).toBe(cold.ingested);

      const database = await getDB();
      const series = await database.getAll('series');
      const studies = await database.getAll('studies');
      const comparison = await getComparisonData();
      const manifest = await getSeriesFrameManifest(series[0]!.seriesInstanceUid);
      expect(comparison.patients.length).toBeGreaterThan(0);
      expect(manifest.frames.length).toBeGreaterThan(0);

      output.mockRestore();
      info.mockRestore();
      warning.mockRestore();
      error.mockRestore();
      console.log(
        `[import-corpus] ${JSON.stringify({
          files: files.length,
          sourceBytes: totalBytes,
          coldMilliseconds: Math.round(coldMilliseconds),
          coldWriteTransactions,
          imported: cold.ingested,
          intentionallyExcluded: cold.skipped,
          errors: cold.errors,
          duplicateReplayMilliseconds: Math.round(replayMilliseconds),
          duplicateReplayWriteTransactions: replayWriteTransactions,
          duplicates: replay.duplicates,
          studies: studies.length,
          series: series.length,
          datasetRevision: await getDatasetRevision(),
        })}`,
      );
    },
    120_000,
  );

  runFullCorpus(
    'streams every protected MRI image through production admission with bounded test-only blob retention',
    async () => {
      let candidateCount = 0;
      const countedCandidates = walkDicomFiles(corpusDirectory!);
      while (!countedCandidates.next().done) candidateCount += 1;
      expect(candidateCount).toBeGreaterThan(10_000);

      const output = vi.spyOn(console, 'log').mockImplementation(() => undefined);
      const info = vi.spyOn(console, 'info').mockImplementation(() => undefined);
      const warning = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
      const transactions = vi.spyOn(IDBDatabase.prototype, 'transaction');
      const originalPut = IDBObjectStore.prototype.put;
      const placeholder = new Blob();
      vi.spyOn(IDBObjectStore.prototype, 'put').mockImplementation(function (
        this: IDBObjectStore,
        value: unknown,
        key?: IDBValidKey,
      ) {
        const record = value as { fileBlob?: Blob };
        const stored =
          this.name === 'instances' && record.fileBlob instanceof Blob ? { ...record, fileBlob: placeholder } : value;
        return key === undefined ? originalPut.call(this, stored) : originalPut.call(this, stored, key);
      });

      let sourceBytes = 0;
      async function* candidateImages(): AsyncGenerator<File> {
        let index = 0;
        for (const path of walkDicomFiles(corpusDirectory!)) {
          const bytes = readFileSync(path);
          sourceBytes += bytes.byteLength;
          yield new File([bytes], `protected-corpus-sweep-${index++}.dcm`, { type: 'application/dicom' });
        }
      }

      const startedAt = performance.now();
      const result = await processFiles(candidateImages(), undefined, { total: candidateCount, batchMaxItems: 64 });
      const elapsedMilliseconds = performance.now() - startedAt;

      expect(result.total).toBe(candidateCount);
      expect(result.ingested + result.duplicates + result.skipped + result.errors).toBe(candidateCount);
      expect(result.errors).toBe(0);
      const writeTransactions = transactions.mock.calls.filter(([, mode]) => mode === 'readwrite').length;
      expect(writeTransactions).toBeLessThanOrEqual(Math.ceil(result.ingested / 64) * 2 + 4);
      expect(await getDatasetRevision()).toBe(result.ingested);

      const database = await getDB();
      const studies = await database.getAll('studies');
      const series = await database.getAll('series');
      expect(studies.length).toBeGreaterThan(0);
      expect(series.length).toBeGreaterThan(0);
      expect(new Set(getPatientIdentityKeys(studies).values()).size).toBe(1);

      const bySeries = new Map(series.map((item) => [item.seriesInstanceUid, item]));
      const ownershipRead = database.transaction('instances', 'readonly');
      let cursor = await ownershipRead.store.openCursor();
      let scannedInstances = 0;
      let frameConflicts = 0;
      let orphanedInstances = 0;
      while (cursor) {
        scannedInstances += 1;
        const instance = cursor.value;
        const parent = bySeries.get(instance.seriesInstanceUid);
        if (!parent || parent.studyInstanceUid !== instance.studyInstanceUid) orphanedInstances += 1;
        if (
          parent?.frameOfReferenceUid &&
          instance.frameOfReferenceUid &&
          parent.frameOfReferenceUid !== instance.frameOfReferenceUid
        ) {
          frameConflicts += 1;
        }
        cursor = await cursor.continue();
      }
      await ownershipRead.done;

      expect(scannedInstances).toBe(result.ingested);
      expect(orphanedInstances).toBe(0);
      expect(frameConflicts).toBe(0);

      output.mockRestore();
      info.mockRestore();
      warning.mockRestore();
      error.mockRestore();
      console.log(
        `[import-corpus-full] ${JSON.stringify({
          files: candidateCount,
          sourceBytes,
          elapsedMilliseconds: Math.round(elapsedMilliseconds),
          writeTransactions,
          imported: result.ingested,
          duplicates: result.duplicates,
          intentionallyExcluded: result.skipped,
          exclusionReasons: result.skipReasons ?? {},
          errors: result.errors,
          errorReasons: result.errorReasons ?? {},
          sampledFailureCategories: result.errorSamples.map(safeAdmissionFailureCategory),
          studies: studies.length,
          series: series.length,
          scannedStoredInstances: scannedInstances,
          orphanedInstances,
          frameConflicts,
          datasetRevision: await getDatasetRevision(),
          blobRetention: 'empty-placeholder-in-isolated-fake-indexeddb-only',
        })}`,
      );
    },
    300_000,
  );
});
