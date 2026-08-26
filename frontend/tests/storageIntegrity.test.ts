import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { createElement } from 'react';
import JSZip from 'jszip';
import dicomParser from 'dicom-parser';
import { assertStorageHeadroom, getDB, deleteAllStoredMriData, resetDbForTests } from '../src/db/db';
import type { DerivedAlignmentFrameRow } from '../src/db/schema';
import { loadSafeArchive } from '../src/services/archiveSafety';
import { processDicomFile } from '../src/services/dicomIngestion';
import { exportStudiesToZip, readSnapshotManifest, restoreSnapshot } from '../src/services/exportBackup';
import {
  clearPersistedDerivedAlignmentFrames,
  getComparisonData,
  getDatasetRevision,
  getPanelSettings,
  getSeriesFrameManifest,
  getSortedSopInstanceUidsForSeries,
  getTumorGroundTruthForInstance,
  getTumorSegmentationForInstance,
  getVolumeSegmentation,
  loadDerivedAlignmentFrames,
  MAX_DERIVED_ALIGNMENT_FRAMES,
  saveDerivedAlignmentFrame,
  saveTumorGroundTruth,
  saveTumorSegmentation,
  savePanelSettings,
  saveVolumeSegmentation,
  setSelectedPatientKey,
} from '../src/utils/localApi';
import {
  closeModelCache,
  deleteModelCache,
  getModelBlob,
  putModelBlob,
} from '../src/utils/segmentation/onnx/modelCache';
import { buildOutputPlaneGrid } from '../src/utils/outputPlaneGrid';
import { DEFAULT_PANEL_SETTINGS } from '../src/utils/constants';
import { ClearDataModal } from '../src/components/ClearDataModal';

type SyntheticDicomOptions = {
  patientId?: string;
  patientName?: string;
  patientIdIssuer?: string;
  studyUid?: string;
  seriesUid?: string;
  instanceUid?: string;
  instanceNumber?: number;
  studyDate?: string;
  studyTime?: string;
  position?: number;
  numberOfFrames?: number;
  transferSyntax?: 'implicit' | 'explicit';
  orientation?: string;
  pixelSpacing?: string;
  imagePosition?: string;
  frameOfReferenceUid?: string;
};

function makeImplicitDicom(options: SyntheticDicomOptions = {}): File {
  const encoder = new TextEncoder();
  const little16 = (value: number) => [value & 255, (value >> 8) & 255];
  const little32 = (value: number) => [value & 255, (value >> 8) & 255, (value >> 16) & 255, (value >> 24) & 255];
  const text = (value: string) => {
    const bytes = Array.from(encoder.encode(value));
    if (bytes.length % 2) bytes.push(0);
    return bytes;
  };
  const explicit = (group: number, element: number, vr: string, bytes: number[]) => [
    ...little16(group),
    ...little16(element),
    ...encoder.encode(vr),
    ...(vr === 'OW' || vr === 'OB' ? [0, 0, ...little32(bytes.length)] : little16(bytes.length)),
    ...bytes,
  ];
  const implicit = (group: number, element: number, bytes: number[]) => [
    ...little16(group),
    ...little16(element),
    ...little32(bytes.length),
    ...bytes,
  ];
  const datasetElement = (group: number, element: number, vr: string, bytes: number[]) =>
    options.transferSyntax === 'explicit' ? explicit(group, element, vr, bytes) : implicit(group, element, bytes);

  const instanceNumber = options.instanceNumber ?? 1;
  const instanceUid = options.instanceUid ?? `1.2.3.4.${instanceNumber}`;
  const dataset = [
    ...datasetElement(8, 22, 'UI', text('1.2.840.10008.5.1.4.1.1.4')),
    ...datasetElement(8, 24, 'UI', text(instanceUid)),
    ...datasetElement(8, 32, 'DA', text(options.studyDate ?? '20000101')),
    ...datasetElement(8, 48, 'TM', text(options.studyTime ?? '120000')),
    ...datasetElement(8, 50, 'TM', text(options.studyTime ?? '120000')),
    ...datasetElement(8, 96, 'CS', text('MR')),
    ...datasetElement(8, 4158, 'LO', text('Axial T2 FLAIR')),
    ...datasetElement(16, 16, 'PN', text(options.patientName ?? 'Synthetic^Patient')),
    ...datasetElement(16, 32, 'LO', text(options.patientId ?? 'synthetic-patient')),
    ...datasetElement(16, 33, 'LO', text(options.patientIdIssuer ?? '')),
    ...datasetElement(32, 13, 'UI', text(options.studyUid ?? '1.2.3')),
    ...datasetElement(32, 14, 'UI', text(options.seriesUid ?? '1.2.3.4')),
    ...datasetElement(32, 17, 'IS', text('1')),
    ...datasetElement(32, 19, 'IS', text(String(instanceNumber))),
    ...datasetElement(32, 50, 'DS', text(options.imagePosition ?? `0\\0\\${options.position ?? 0}`)),
    ...datasetElement(32, 55, 'DS', text(options.orientation ?? '1\\0\\0\\0\\1\\0')),
    ...datasetElement(32, 82, 'UI', text(options.frameOfReferenceUid ?? '1.2.840.42')),
    ...datasetElement(40, 8, 'IS', text(String(options.numberOfFrames ?? 1))),
    ...datasetElement(40, 16, 'US', little16(64)),
    ...datasetElement(40, 17, 'US', little16(64)),
    ...datasetElement(40, 48, 'DS', text(options.pixelSpacing ?? '0.5\\0.75')),
    ...datasetElement(32736, 16, 'OW', new Array(128).fill(7)),
  ];
  const meta = explicit(
    2,
    16,
    'UI',
    text(options.transferSyntax === 'explicit' ? '1.2.840.10008.1.2.1' : '1.2.840.10008.1.2'),
  );
  const bytes = new Uint8Array([...new Array(128).fill(0), 68, 73, 67, 77, ...meta, ...dataset]);
  return new File([bytes], `${instanceUid}.dcm`, { type: 'application/dicom' });
}

function importPatientStudy(patientId: string, studyUid: string, options: Partial<SyntheticDicomOptions> = {}) {
  return processDicomFile(
    makeImplicitDicom({
      patientId,
      studyUid,
      seriesUid: `${studyUid}.1`,
      instanceUid: `${studyUid}.1.1`,
      ...options,
    }),
  );
}

function makeDerivedFrame(overrides: Partial<DerivedAlignmentFrameRow> = {}): DerivedAlignmentFrameRow {
  return {
    id: 'derived-1',
    patientKey: 'synthetic-patient',
    datasetRevision: 1,
    sequenceId: 'axial-t2-flair',
    targetStudyUid: '1.2.3',
    targetSeriesUid: '1.2.3.4',
    targetSopInstanceUid: '1.2.3.4.1',
    targetFrameIndex: 0,
    referenceStudyUid: '1.2.3',
    referenceSeriesUid: '1.2.3.4',
    referenceSopInstanceUid: '1.2.3.4.1',
    referenceFrameIndex: 0,
    referenceImagePositionPatient: '0\\0\\0',
    referenceImageOrientationPatient: '1\\0\\0\\0\\1\\0',
    referencePixelSpacing: '0.5\\0.75',
    referenceRows: 64,
    referenceColumns: 64,
    referenceFrameOfReferenceUid: '1.2.840.42',
    targetFrameOfReferenceUid: '1.2.840.42',
    rows: 2,
    columns: 2,
    pixels: new Float32Array([0, 1, 2, 3]),
    sourceImageId: 'miradb:1.2.3.4.1',
    transform: [0, 0, 0, 0, 0, 0],
    centerMm: [0, 0, 0],
    coverage: 0.95,
    score: 0.9,
    margin: 0.2,
    nativeSliceSpacingMm: 1.25,
    sourceFrameCount: 64,
    runId: 'synthetic-run',
    createdAt: 1,
    ...overrides,
  };
}

describe('durable MRI storage and import contracts', () => {
  afterEach(async () => {
    await resetDbForTests();
    await closeModelCache();
    for (const name of ['MiraViewerDB', 'miraviewer:model-cache']) {
      await new Promise<void>((resolve) => {
        const request = indexedDB.deleteDatabase(name);
        request.onsuccess = () => resolve();
        request.onerror = () => resolve();
        request.onblocked = () => resolve();
      });
    }
    localStorage.clear();
    vi.restoreAllMocks();
  });

  it('imports genuine implicit-VR binary rows and columns with frame geometry', async () => {
    const file = makeImplicitDicom({ position: 12.5 });
    const parsed = dicomParser.parseDicom(new Uint8Array(await file.arrayBuffer()));
    expect(parsed.elements.x00280010?.vr).toBeUndefined();
    expect(parsed.uint16('x00280010')).toBe(64);

    const result = await processDicomFile(file);
    expect(result.status).toBe('ingested');
    const db = await getDB();
    const instance = await db.get('instances', '1.2.3.4.1');
    expect(instance).toMatchObject({
      rows: 64,
      columns: 64,
      frameOfReferenceUid: '1.2.840.42',
      physicalSlicePosition: 12.5,
    });
  });

  it('imports genuine explicit-VR binary image metadata without changing its geometry contract', async () => {
    const file = makeImplicitDicom({ transferSyntax: 'explicit' });
    const parsed = dicomParser.parseDicom(new Uint8Array(await file.arrayBuffer()));
    expect(parsed.elements.x00280010?.vr).toBe('US');
    expect(await processDicomFile(file)).toMatchObject({ status: 'ingested' });
    expect((await (await getDB()).get('instances', '1.2.3.4.1'))?.rows).toBe(64);
  });

  it('rejects enhanced multi-frame images explicitly instead of silently truncating them', async () => {
    const result = await processDicomFile(makeImplicitDicom({ numberOfFrames: 8 }));
    expect(result).toMatchObject({ status: 'error', reason: 'unsupported-multiframe' });
    expect(await (await getDB()).count('instances')).toBe(0);
  });

  it('rejects supplied degenerate orientation and uncalibrated pixel spacing', async () => {
    expect(
      await processDicomFile(
        makeImplicitDicom({
          orientation: '0\\0\\0\\0\\0\\0',
        }),
      ),
    ).toMatchObject({ status: 'error', reason: 'parse-error' });
    expect(
      await processDicomFile(
        makeImplicitDicom({
          instanceUid: '1.2.3.4.2',
          pixelSpacing: '0\\0.5',
        }),
      ),
    ).toMatchObject({ status: 'error', reason: 'parse-error' });
    expect(await (await getDB()).count('instances')).toBe(0);
  });

  it('uses measured orientation over misleading series-description text', async () => {
    await processDicomFile(makeImplicitDicom({ orientation: '1\\0\\0\\0\\0\\1' }));
    expect((await (await getDB()).get('series', '1.2.3.4'))?.plane).toBe('Coronal');
  });

  it('orders slices by physical anatomy and invalidates cached order after new imports', async () => {
    await processDicomFile(makeImplicitDicom({ instanceUid: '1.2.3.4.1', instanceNumber: 1, position: 30 }));
    await processDicomFile(makeImplicitDicom({ instanceUid: '1.2.3.4.2', instanceNumber: 2, position: 10 }));
    expect(await getSortedSopInstanceUidsForSeries('1.2.3.4')).toEqual(['1.2.3.4.2', '1.2.3.4.1']);

    await processDicomFile(makeImplicitDicom({ instanceUid: '1.2.3.4.3', instanceNumber: 3, position: 20 }));
    expect(await getSortedSopInstanceUidsForSeries('1.2.3.4')).toEqual(['1.2.3.4.2', '1.2.3.4.3', '1.2.3.4.1']);
    expect(await getSeriesFrameManifest('1.2.3.4')).toMatchObject({
      ordering: 'physical',
      geometryReliable: true,
      sliceSpacingMm: 10,
      coverageMm: 20,
    });
  });

  it('makes instance-number fallback explicit when patient-space geometry is absent', async () => {
    await processDicomFile(makeImplicitDicom({ imagePosition: '', orientation: '' }));
    expect(await getSeriesFrameManifest('1.2.3.4')).toMatchObject({
      ordering: 'instance-number',
      geometryReliable: false,
    });
  });

  it('rejects whole-stack in-plane axis changes, spacing changes, and duplicated canonical depths', async () => {
    await processDicomFile(makeImplicitDicom({ instanceUid: '1.2.3.4.1', instanceNumber: 1, position: 0 }));
    await processDicomFile(makeImplicitDicom({ instanceUid: '1.2.3.4.2', instanceNumber: 2, position: 1 }));
    const db = await getDB();
    const second = (await db.get('instances', '1.2.3.4.2'))!;

    await db.put('instances', {
      ...second,
      imageOrientationPatient: '0\\1\\0\\-1\\0\\0',
    });
    expect((await getSeriesFrameManifest('1.2.3.4')).geometryReliable).toBe(false);

    await db.put('instances', { ...second, pixelSpacing: '0.6\\0.75' });
    expect((await getSeriesFrameManifest('1.2.3.4')).geometryReliable).toBe(false);

    await db.put('instances', { ...second, imagePositionPatient: '0\\0\\0' });
    expect((await getSeriesFrameManifest('1.2.3.4')).geometryReliable).toBe(false);

    await db.put('instances', second);
    expect((await getSeriesFrameManifest('1.2.3.4')).geometryReliable).toBe(true);
  });

  it('rejects incompatible frames of reference within one anatomical series', async () => {
    await processDicomFile(makeImplicitDicom({ frameOfReferenceUid: '1.2.840.42' }));
    vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(
      await processDicomFile(
        makeImplicitDicom({
          instanceUid: '1.2.3.4.2',
          instanceNumber: 2,
          frameOfReferenceUid: '1.2.840.43',
        }),
      ),
    ).toMatchObject({ status: 'error', reason: 'db-error' });
    expect(await (await getDB()).count('instances')).toBe(1);
  });

  it('isolates patients and keeps same-day examinations distinct', async () => {
    await importPatientStudy('patient-a', '1.2.10');
    await importPatientStudy('patient-a', '1.2.11');
    await importPatientStudy('patient-b', '1.2.12');

    await setSelectedPatientKey('patient-a');
    const first = await getComparisonData();
    expect(first.patients).toHaveLength(2);
    expect(first.selected_patient_key).toBe('patient-a');
    expect(first.dates).toHaveLength(2);
    expect(first.dates[0]).not.toBe(first.dates[1]);
    expect(Object.values(first.examinations).every((exam) => exam.patient_key === 'patient-a')).toBe(true);

    await setSelectedPatientKey('patient-b');
    const second = await getComparisonData();
    expect(second.dates).toHaveLength(1);
    expect(Object.values(second.examinations)[0]?.study_uid).toBe('1.2.12');
  });

  it('scopes persisted viewer settings to their selected patient', async () => {
    await importPatientStudy('patient-a', '1.2.13');
    await importPatientStudy('patient-b', '1.2.14');
    await setSelectedPatientKey('patient-a');
    await savePanelSettings('axial-t2-flair', 'synthetic-date', {
      ...DEFAULT_PANEL_SETTINGS,
      offset: 1,
      zoom: 2,
      progress: 0.5,
    });
    await setSelectedPatientKey('patient-b');
    expect(await getPanelSettings('axial-t2-flair')).toEqual({});
    await setSelectedPatientKey('patient-a');
    expect((await getPanelSettings('axial-t2-flair'))['synthetic-date']?.zoom).toBe(2);
  });

  it('keeps an in-flight viewer-settings write bound to its original patient after durable selection changes', async () => {
    await importPatientStudy('synthetic-patient-a', '1.2.15');
    await importPatientStudy('synthetic-patient-b', '1.2.16');

    await setSelectedPatientKey('synthetic-patient-a');
    const pendingFirstPatientWrite = savePanelSettings(
      'shared-synthetic-sequence',
      '2035-01-10T12:00:00',
      { ...DEFAULT_PANEL_SETTINGS, zoom: 2, brightness: 145 },
      'synthetic-patient-a',
    );
    await setSelectedPatientKey('synthetic-patient-b');
    await pendingFirstPatientWrite;

    expect(await getPanelSettings('shared-synthetic-sequence', 'synthetic-patient-b')).toEqual({});
    expect((await getPanelSettings('shared-synthetic-sequence', 'synthetic-patient-a'))['2035-01-10T12:00:00']).toEqual(
      expect.objectContaining({ zoom: 2, brightness: 145 }),
    );

    await savePanelSettings(
      'explicitly-unscoped-sequence',
      '2035-01-10T12:00:00',
      { ...DEFAULT_PANEL_SETTINGS, zoom: 1.5 },
      null,
    );
    expect((await getPanelSettings('explicitly-unscoped-sequence', null))['2035-01-10T12:00:00']?.zoom).toBe(1.5);
    expect(await getPanelSettings('explicitly-unscoped-sequence', 'synthetic-patient-b')).toEqual({});
  });

  it('does not merge separate examinations with missing patient identities', async () => {
    await importPatientStudy('', '1.2.21');
    await importPatientStudy('', '1.2.22');
    const data = await getComparisonData();
    expect(data.patients).toHaveLength(2);
    expect(data.dates).toHaveLength(1);
  });

  it('isolates reused patient identifiers when issuer or nonempty names conflict', async () => {
    await importPatientStudy('reused-id', '1.2.23', { patientName: 'Synthetic^One' });
    await importPatientStudy('reused-id', '1.2.24', { patientName: 'Synthetic^Two' });
    await importPatientStudy('reused-id', '1.2.25', {
      patientName: 'Synthetic^One',
      patientIdIssuer: 'another-facility',
    });
    const data = await getComparisonData();
    expect(data.patients).toHaveLength(3);
    expect(data.dates).toHaveLength(1);
    expect(data.patients.some((patient) => patient.key === 'another-facility::reused-id')).toBe(true);
  });

  it('round-trips scans, annotations, labels, derived frames, settings, model sidecars, and unknown models', async () => {
    await processDicomFile(makeImplicitDicom());
    await getComparisonData();
    await saveTumorSegmentation({
      comboId: 'axial-t2-flair',
      dateIso: '2000-01-01T12:00:00',
      studyId: '1.2.3',
      seriesUid: '1.2.3.4',
      sopInstanceUid: '1.2.3.4.1',
      polygon: { points: [{ x: 0.25, y: 0.5 }] },
      threshold: { low: 1, high: 2 },
      meta: { coordinateSpace: 'image-normalized', imageSize: { w: 64, h: 64 } },
    });
    await saveTumorGroundTruth({
      comboId: 'axial-t2-flair',
      dateIso: '2000-01-01T12:00:00',
      studyId: '1.2.3',
      seriesUid: '1.2.3.4',
      sopInstanceUid: '1.2.3.4.1',
      polygon: { points: [{ x: 0.5, y: 0.25 }] },
      coordinateSpace: 'image-normalized',
      imageSize: { w: 64, h: 64 },
    });
    await saveVolumeSegmentation({
      volumeKey: 'synthetic-volume',
      patientKey: 'synthetic-patient',
      studyUid: '1.2.3',
      dims: [2, 2, 1],
      voxelSizeMm: [0.5, 0.5, 1],
      labels: new Uint8Array([0, 1, 2, 4]),
      updatedAt: 1,
    });
    await saveDerivedAlignmentFrame(makeDerivedFrame());
    await putModelBlob('synthetic-model', new Blob([new Uint8Array([1, 2, 3])]));
    await putModelBlob('brats-tumor-v1', new Blob([new Uint8Array([4, 5, 6])]));
    await putModelBlob('brats-tumor-v1:manifest', new Blob([new Uint8Array([7, 8, 9])]));
    localStorage.setItem('miraviewer:overlay-nav:v1', JSON.stringify({ overlayDate: 'synthetic-date' }));

    const archiveBlob = await exportStudiesToZip(['1.2.3']);
    await deleteModelCache();
    await deleteAllStoredMriData();
    localStorage.clear();

    const archive = await loadSafeArchive(archiveBlob);
    const manifest = await readSnapshotManifest(archive.zip);
    expect(manifest).not.toBeNull();
    const restored = await restoreSnapshot(archive.zip, manifest!);
    expect(restored.ingested).toBe(1);
    expect((await getTumorSegmentationForInstance('1.2.3.4', '1.2.3.4.1'))?.meta?.coordinateSpace).toBe(
      'image-normalized',
    );
    expect((await getTumorGroundTruthForInstance('1.2.3.4', '1.2.3.4.1'))?.imageSize).toEqual({ w: 64, h: 64 });
    expect(Array.from((await getVolumeSegmentation('synthetic-volume'))!.labels)).toEqual([0, 1, 2, 4]);
    const restoredRevision = await getDatasetRevision();
    expect(restoredRevision).toBe(2);
    const restoredFrame = (await loadDerivedAlignmentFrames('synthetic-patient', restoredRevision))[0];
    expect(restoredFrame).toMatchObject({
      datasetRevision: restoredRevision,
      referenceImagePositionPatient: '0\\0\\0',
      nativeSliceSpacingMm: 1.25,
      sourceFrameCount: 64,
    });
    expect(Array.from(restoredFrame!.pixels)).toEqual([0, 1, 2, 3]);
    for (const key of ['synthetic-model', 'brats-tumor-v1', 'brats-tumor-v1:manifest']) {
      expect(archive.zip.file(`models/${encodeURIComponent(key)}.onnx`)).not.toBeNull();
      expect(await getModelBlob(key)).not.toBeNull();
    }
    expect((await getComparisonData()).selected_patient_key).toBe('synthetic-patient');
    expect(localStorage.getItem('miraviewer:overlay-nav:v1')).toContain('synthetic-date');
  });

  it('preserves all seventeen registered examinations across a database connection restart', async () => {
    await processDicomFile(makeImplicitDicom());
    await getComparisonData();
    for (let index = 0; index < 17; index++) {
      await saveDerivedAlignmentFrame(makeDerivedFrame({ id: `examination-${index}`, createdAt: index }));
    }

    await resetDbForTests();
    const restored = await loadDerivedAlignmentFrames('synthetic-patient', 1);
    expect(restored).toHaveLength(17);
    expect(restored.map((frame) => frame.id)).toEqual(Array.from({ length: 17 }, (_, index) => `examination-${index}`));
  });

  it('retains bounded registered frames across a database connection restart', async () => {
    await processDicomFile(makeImplicitDicom());
    await getComparisonData();
    for (let index = 0; index < MAX_DERIVED_ALIGNMENT_FRAMES + 3; index++) {
      await saveDerivedAlignmentFrame(makeDerivedFrame({ id: `derived-${index}`, createdAt: index }));
    }

    await resetDbForTests();
    const restored = await loadDerivedAlignmentFrames('synthetic-patient', 1);
    expect(restored).toHaveLength(MAX_DERIVED_ALIGNMENT_FRAMES);
    expect(restored.map((frame) => frame.id)).toEqual(
      Array.from({ length: MAX_DERIVED_ALIGNMENT_FRAMES }, (_, index) => `derived-${index + 3}`),
    );
    expect(Array.from(restored[0]!.pixels)).toEqual([0, 1, 2, 3]);
    await clearPersistedDerivedAlignmentFrames('different-patient');
    expect(await loadDerivedAlignmentFrames('synthetic-patient', 1)).toHaveLength(MAX_DERIVED_ALIGNMENT_FRAMES);
    await clearPersistedDerivedAlignmentFrames('synthetic-patient');
    expect(await loadDerivedAlignmentFrames('synthetic-patient', 1)).toEqual([]);
  });

  it('removes only obsolete registered planes for the replaced examination', async () => {
    await processDicomFile(makeImplicitDicom());
    await processDicomFile(
      makeImplicitDicom({
        studyUid: '1.2.5',
        seriesUid: '1.2.5.4',
        instanceUid: '1.2.5.4.1',
      }),
    );
    await getComparisonData();
    await saveDerivedAlignmentFrame(makeDerivedFrame({ datasetRevision: 2 }));
    await saveDerivedAlignmentFrame(
      makeDerivedFrame({
        id: 'derived-preserved-reference',
        datasetRevision: 2,
        targetStudyUid: '1.2.5',
        targetSeriesUid: '1.2.5.4',
        targetSopInstanceUid: '1.2.5.4.1',
        sourceImageId: 'miradb:1.2.5.4.1',
        createdAt: 2,
      }),
    );

    await expect(clearPersistedDerivedAlignmentFrames(undefined, '1.2.3.4')).rejects.toThrow('verified patient');
    expect(await loadDerivedAlignmentFrames('synthetic-patient', 2)).toHaveLength(2);

    await clearPersistedDerivedAlignmentFrames('synthetic-patient', '1.2.3.4');
    await resetDbForTests();

    expect(await loadDerivedAlignmentFrames('synthetic-patient', 2)).toMatchObject([
      { id: 'derived-preserved-reference', targetSeriesUid: '1.2.5.4' },
    ]);
  });

  it('round-trips a 1024-pixel physical output grid, support mask, and complete source provenance', async () => {
    await processDicomFile(makeImplicitDicom());
    const reference = (await (await getDB()).get('instances', '1.2.3.4.1'))!;
    const outputGrid = buildOutputPlaneGrid(reference, { mode: 'fixed-1024' });
    const pixelCount = 1024 * 1024;
    const pixels = new Float32Array(pixelCount);
    pixels[0] = 41;
    pixels[pixelCount - 1] = 82;
    const valid = new Uint8Array(pixelCount).fill(1);
    valid[3] = 0;
    const frame = makeDerivedFrame({
      rows: 1024,
      columns: 1024,
      pixels,
      valid,
      outputGrid,
      contributingSourceSopInstanceUids: ['1.2.3.4.1'],
    });
    await expect(saveDerivedAlignmentFrame({ ...frame, valid: undefined })).rejects.toThrow('anatomical-support map');
    await expect(saveDerivedAlignmentFrame({ ...frame, contributingSourceSopInstanceUids: undefined })).rejects.toThrow(
      'contributing source images',
    );
    await expect(
      saveDerivedAlignmentFrame({
        ...frame,
        outputGrid: {
          ...outputGrid,
          originMm: [outputGrid.originMm[0] + 1, ...outputGrid.originMm.slice(1)] as [number, number, number],
        },
      }),
    ).rejects.toThrow('selected reference image');
    await saveDerivedAlignmentFrame(frame);

    const saved = (await loadDerivedAlignmentFrames('synthetic-patient', 1))[0]!;
    expect(saved.outputGrid?.rowSpacingMm).toBe(0.03125);
    expect(saved.outputGrid?.columnSpacingMm).toBe(0.046875);
    expect(saved.valid?.[3]).toBe(0);

    const blob = await exportStudiesToZip(['1.2.3']);
    await deleteAllStoredMriData();
    const archive = await loadSafeArchive(blob);
    const manifest = await readSnapshotManifest(archive.zip);
    await restoreSnapshot(archive.zip, manifest!);

    const restored = (await loadDerivedAlignmentFrames('synthetic-patient', await getDatasetRevision()))[0]!;
    expect(restored.outputGrid).toEqual(outputGrid);
    expect(restored.contributingSourceSopInstanceUids).toEqual(['1.2.3.4.1']);
    expect(restored.pixels[0]).toBe(41);
    expect(restored.pixels[pixelCount - 1]).toBe(82);
    expect(restored.valid?.[3]).toBe(0);
    expect(restored.valid?.[4]).toBe(1);
  });

  it('rejects stale registered frames after image imports change their committed dataset revision', async () => {
    await processDicomFile(makeImplicitDicom());
    await getComparisonData();
    await saveDerivedAlignmentFrame(makeDerivedFrame());
    expect(await loadDerivedAlignmentFrames('synthetic-patient', 1)).toHaveLength(1);

    await processDicomFile(
      makeImplicitDicom({
        instanceUid: '1.2.3.4.2',
        instanceNumber: 2,
        position: 10,
      }),
    );
    expect(await getDatasetRevision()).toBe(2);
    expect(await loadDerivedAlignmentFrames('synthetic-patient', 1)).toEqual([]);
    expect(await loadDerivedAlignmentFrames('synthetic-patient', 2)).toEqual([]);
    await expect(saveDerivedAlignmentFrame(makeDerivedFrame())).rejects.toThrow(/stale dataset revision/i);
  });

  it.each([
    ['patient identity', { patientKey: 'different-patient' }, /different patient/i],
    ['physical target slice', { targetSopInstanceUid: 'different-image' }, /physical target slice/i],
    ['source image identity', { sourceImageId: 'miradb:different-image' }, /source image/i],
    ['target spatial frame', { targetFrameOfReferenceUid: 'different-frame' }, /target spatial frame/i],
    ['reference spatial frame', { referenceFrameOfReferenceUid: 'different-frame' }, /reference spatial frame/i],
    ['reference plane geometry', { referenceImagePositionPatient: '0\\0\\99' }, /reference image geometry/i],
    ['rigid transform', { transform: [0, 0, Number.NaN, 0, 0, 0] }, /rigid transform/i],
    ['quality evidence', { coverage: Number.NaN }, /quality evidence/i],
    ['anatomical support map', { valid: new Uint8Array([1, 2, 1, 1]) }, /support map/i],
    ['unsupported image samples', { valid: new Uint8Array([1, 0, 1, 1]) }, /unsupported image samples/i],
    ['contributor identity', { contributingSourceSopInstanceUids: ['different-image'] }, /another examination/i],
  ] as const)('rejects derived frames with stale %s', async (_label, changes, error) => {
    await processDicomFile(makeImplicitDicom());
    await expect(saveDerivedAlignmentFrame(makeDerivedFrame(changes))).rejects.toThrow(error);
    expect(await (await getDB()).count('derived_alignment_frames')).toBe(0);
  });

  it('rejects a same-patient source image from another series before restoring any records', async () => {
    await processDicomFile(makeImplicitDicom());
    await processDicomFile(
      makeImplicitDicom({
        seriesUid: '1.2.3.5',
        instanceUid: '1.2.3.5.1',
      }),
    );
    await getComparisonData();
    await saveDerivedAlignmentFrame(makeDerivedFrame({ datasetRevision: 2 }));
    const original = await exportStudiesToZip(['1.2.3']);
    const altered = await JSZip.loadAsync(original);
    const originalManifest = JSON.parse(await altered.file('export.json')!.async('string'));
    originalManifest.records.derivedAlignmentFrames[0].targetSopInstanceUid = '1.2.3.5.1';
    originalManifest.records.derivedAlignmentFrames[0].sourceImageId = 'miradb:1.2.3.5.1';
    altered.file('export.json', JSON.stringify(originalManifest));
    const broken = await altered.generateAsync({ type: 'blob' });
    await deleteAllStoredMriData();

    const archive = await loadSafeArchive(broken);
    const manifest = await readSnapshotManifest(archive.zip);
    await expect(restoreSnapshot(archive.zip, manifest!)).rejects.toThrow(/matching patient-space sources/i);
    const db = await getDB();
    expect(await db.count('studies')).toBe(0);
    expect(await db.count('instances')).toBe(0);
    expect(await db.count('derived_alignment_frames')).toBe(0);
  });

  it('restores prior complete v2 snapshots that have no registered-frame manifest field', async () => {
    await processDicomFile(makeImplicitDicom());
    const original = await exportStudiesToZip(['1.2.3']);
    const altered = await JSZip.loadAsync(original);
    const originalManifest = JSON.parse(await altered.file('export.json')!.async('string'));
    delete originalManifest.records.derivedAlignmentFrames;
    altered.file('export.json', JSON.stringify(originalManifest));
    const legacy = await altered.generateAsync({ type: 'blob' });
    await deleteAllStoredMriData();

    const archive = await loadSafeArchive(legacy);
    const manifest = await readSnapshotManifest(archive.zip);
    expect((await restoreSnapshot(archive.zip, manifest!)).ingested).toBe(1);
    expect(await (await getDB()).count('derived_alignment_frames')).toBe(0);
  });

  it('rejects incomplete backups before restoring any images or annotations', async () => {
    await processDicomFile(makeImplicitDicom());
    const original = await exportStudiesToZip(['1.2.3']);
    const altered = await JSZip.loadAsync(original);
    const imagePath = Object.keys(altered.files).find((name) => name.endsWith('.dcm'));
    altered.remove(imagePath!);
    const broken = await altered.generateAsync({ type: 'blob' });
    await deleteAllStoredMriData();

    const archive = await loadSafeArchive(broken);
    const manifest = await readSnapshotManifest(archive.zip);
    await expect(restoreSnapshot(archive.zip, manifest!)).rejects.toThrow(/incomplete/i);
    expect(await (await getDB()).count('instances')).toBe(0);
    expect(await (await getDB()).count('studies')).toBe(0);
  });

  it('rejects conflicting image identities without creating orphaned examinations', async () => {
    await processDicomFile(makeImplicitDicom({ studyUid: '1.2.30', seriesUid: '1.2.30.1', instanceUid: '1.2.30.1.1' }));
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const conflicting = await processDicomFile(
      makeImplicitDicom({
        studyUid: '1.2.31',
        seriesUid: '1.2.31.1',
        instanceUid: '1.2.30.1.1',
      }),
    );
    expect(conflicting).toMatchObject({ status: 'error', reason: 'db-error' });
    const db = await getDB();
    expect(await db.get('studies', '1.2.31')).toBeUndefined();
    expect(await db.get('series', '1.2.31.1')).toBeUndefined();
    expect(await db.count('instances')).toBe(1);
  });

  it('keeps blocked deletion visibly pending until the other connection actually closes', async () => {
    await processDicomFile(makeImplicitDicom());
    const blocker = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open('MiraViewerDB');
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const blocked = vi.fn();
    let completed = false;
    const operation = deleteAllStoredMriData({ onBlocked: blocked }).then(() => {
      completed = true;
    });
    await vi.waitFor(() => expect(blocked).toHaveBeenCalled());
    expect(completed).toBe(false);

    blocker.close();
    await operation;
    expect(completed).toBe(true);
    expect(await (await getDB()).count('instances')).toBe(0);
  });

  it('rejects a strongly expanding archive before creating decompressed blobs', async () => {
    const archive = new JSZip();
    archive.file('synthetic.dcm', new Uint8Array(1024 * 1024));
    const blob = await archive.generateAsync({
      type: 'blob',
      compression: 'DEFLATE',
      compressionOptions: { level: 9 },
    });
    await expect(loadSafeArchive(blob)).rejects.toThrow(/expands far beyond/i);
  });

  it('recovers after a failed database open once the external version conflict disappears', async () => {
    const newer = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open('MiraViewerDB', 7);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    newer.close();
    await expect(getDB()).rejects.toThrow();
    await new Promise<void>((resolve, reject) => {
      const request = indexedDB.deleteDatabase('MiraViewerDB');
      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error);
    });
    expect((await getDB()).objectStoreNames.contains('app_state')).toBe(true);
  });

  it('preflights available quota before accepting a large import', async () => {
    const existing = Object.getOwnPropertyDescriptor(navigator, 'storage');
    Object.defineProperty(navigator, 'storage', {
      configurable: true,
      value: { estimate: async () => ({ quota: 10 * 1024 * 1024, usage: 9 * 1024 * 1024 }) },
    });
    try {
      await expect(assertStorageHeadroom(1024 * 1024)).rejects.toThrow(/insufficient browser storage/i);
    } finally {
      if (existing) Object.defineProperty(navigator, 'storage', existing);
      else Reflect.deleteProperty(navigator, 'storage');
    }
  });

  it('clears every owned key and database while preserving unrelated local storage', async () => {
    await processDicomFile(makeImplicitDicom());
    await putModelBlob('synthetic-model', new Blob([new Uint8Array([1])]));
    localStorage.setItem('miraviewer:overlay-nav:v1', 'sensitive');
    localStorage.setItem('miraviewer:tumor-grow2d-ui-v1:synthetic', 'sensitive');
    localStorage.setItem('mira-filters-v2', 'sensitive');
    localStorage.setItem('unrelated-application', 'preserve');

    const onReset = vi.fn();
    render(createElement(ClearDataModal, { onClose: () => {}, onReset }));
    expect(screen.getByText('PERMANENT REMOVAL')).toBeInTheDocument();
    expect(screen.getByLabelText('Type CLEAR to confirm')).toBe(screen.getByPlaceholderText('CLEAR'));
    expect(screen.getByRole('button', { name: /^clear all data$/i })).toBeDisabled();
    fireEvent.change(screen.getByPlaceholderText('CLEAR'), { target: { value: 'CLEAR' } });
    fireEvent.click(screen.getByRole('button', { name: /^clear all data$/i }));

    await waitFor(() => expect(screen.getByText('Data cleared')).toBeInTheDocument());
    expect(localStorage.getItem('miraviewer:overlay-nav:v1')).toBeNull();
    expect(localStorage.getItem('miraviewer:tumor-grow2d-ui-v1:synthetic')).toBeNull();
    expect(localStorage.getItem('mira-filters-v2')).toBeNull();
    expect(localStorage.getItem('unrelated-application')).toBe('preserve');
    const databases = await indexedDB.databases();
    expect(databases.some((database) => database.name === 'MiraViewerDB')).toBe(false);
    expect(databases.some((database) => database.name === 'miraviewer:model-cache')).toBe(false);
  });
});
