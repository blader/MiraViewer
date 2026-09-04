import { DATASET_REVISION_STATE_KEY, getDB, SELECTED_PATIENT_STATE_KEY } from '../../src/db/db';
import type { DerivedAlignmentFrameRow } from '../../src/db/schema';
import { loadDerivedAlignmentFrames, saveDerivedAlignmentFrame } from '../../src/utils/localApi';

type Read = { index: string; records: number; pixelAndSupportBytes: number };

/** Count actual value results materialized by the browser, not estimated process RAM. */
async function measureReads<T>(action: () => Promise<T>) {
  const reads: Read[] = [];
  let keyReads = 0;
  const getAll = IDBIndex.prototype.getAll;
  const getAllKeys = IDBIndex.prototype.getAllKeys;
  IDBIndex.prototype.getAll = function (query, count) {
    const request = getAll.call(this, query, count);
    if (this.objectStore.name === 'derived_alignment_frames') {
      const index = this.name;
      request.addEventListener('success', () => {
        const rows = request.result as DerivedAlignmentFrameRow[];
        reads.push({
          index,
          records: rows.length,
          pixelAndSupportBytes: rows.reduce(
            (sum, row) => sum + row.pixels.byteLength + (row.valid?.byteLength ?? 0),
            0,
          ),
        });
      });
    }
    return request;
  };
  IDBIndex.prototype.getAllKeys = function (query, count) {
    const request = getAllKeys.call(this, query, count);
    if (this.objectStore.name === 'derived_alignment_frames') keyReads++;
    return request;
  };
  const start = performance.now();
  try {
    const result = await action();
    return { result, elapsedMs: performance.now() - start, reads, keyReads };
  } finally {
    IDBIndex.prototype.getAll = getAll;
    IDBIndex.prototype.getAllKeys = getAllKeys;
  }
}

export async function measureDerivedStorage() {
  const db = await getDB();
  const patientKey = 'synthetic-storage-patient';
  const studyUid = 'synthetic-storage-study';
  const seriesUid = 'synthetic-storage-series';
  const sopUid = 'synthetic-storage-instance';
  await db.put('studies', {
    studyInstanceUid: studyUid,
    studyDate: '20350110',
    studyDescription: 'Synthetic storage fixture',
    patientId: patientKey,
    patientName: 'Synthetic',
    modality: 'MR',
  });
  await db.put('series', {
    seriesInstanceUid: seriesUid,
    studyInstanceUid: studyUid,
    seriesDescription: 'Synthetic',
    seriesNumber: 1,
    modality: 'MR',
  });
  await db.put('instances', {
    sopInstanceUid: sopUid,
    seriesInstanceUid: seriesUid,
    studyInstanceUid: studyUid,
    instanceNumber: 1,
    rows: 1024,
    columns: 1024,
    fileBlob: new Blob(['synthetic metadata fixture; never decoded']),
  });
  await db.put('app_state', { key: SELECTED_PATIENT_STATE_KEY, value: patientKey });
  await db.put('app_state', { key: DATASET_REVISION_STATE_KEY, value: 1 });
  const pixels = new Float32Array(1024 * 1024).fill(0.5);
  const valid = new Uint8Array(1024 * 1024).fill(1);
  const frame = (number: number): DerivedAlignmentFrameRow => ({
    id: `frame-${number}`,
    patientKey,
    datasetRevision: 1,
    sequenceId: `sequence-${number % 4}`,
    targetStudyUid: studyUid,
    targetSeriesUid: seriesUid,
    targetSopInstanceUid: sopUid,
    targetFrameIndex: 0,
    rows: 1024,
    columns: 1024,
    pixels,
    valid,
    sourceImageId: `miradb:${sopUid}`,
    createdAt: number,
  });
  // Exactly 160 MiB of pixel/support payload, written one frame at a time.
  for (let i = 0; i < 32; i++) await saveDerivedAlignmentFrame(frame(i));
  const oldBookkeepingQuery = await measureReads(async () => {
    const rows = await db.getAllFromIndex('derived_alignment_frames', 'by-created-at');
    return rows.map((row) => row.id);
  });
  const save = await measureReads(async () => {
    await saveDerivedAlignmentFrame(frame(32));
  });
  const retained = await db.getAllKeys('derived_alignment_frames');
  const oldHydrationQuery = await measureReads(async () => {
    const rows = await db.getAllFromIndex('derived_alignment_frames', 'by-patient', patientKey);
    return rows
      .filter((row) => row.sequenceId === 'sequence-0')
      .map((row) => row.id)
      .sort();
  });
  const selectedHydration = await measureReads(async () => {
    const rows = await loadDerivedAlignmentFrames(patientKey, 1, {
      sequenceId: 'sequence-0',
      seriesUids: new Set([seriesUid]),
    });
    return rows.map((row) => row.id).sort();
  });
  const sequenceSwitch = await measureReads(async () => {
    const rows = await loadDerivedAlignmentFrames(patientKey, 1, {
      sequenceId: 'sequence-1',
      seriesUids: new Set([seriesUid]),
    });
    return rows.map((row) => row.id).sort();
  });
  return {
    workload: {
      frames: 32,
      rows: 1024,
      columns: 1024,
      pixelAndSupportBytesPerFrame: pixels.byteLength + valid.byteLength,
    },
    evidence:
      'actual IndexedDB payload bytes materialized; timings include current validation, not peak process memory',
    oldBookkeepingQuery,
    save,
    retained,
    oldHydrationQuery,
    selectedHydration,
    sequenceSwitch,
  };
}
