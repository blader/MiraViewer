import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Blob as NativeBlob, File as NativeFile } from 'node:buffer';
import dicomParser from 'dicom-parser';
import { DATASET_REVISION_STATE_KEY, deleteAllStoredMriData, getDB } from '../src/db/db';
import type { DicomAcquisitionMetadata } from '../src/db/schema';
import { processDicomFile } from '../src/services/dicomIngestion';
import * as extraction from '../src/services/dicomAcquisitionMetadata';
import {
  getDatasetRevision,
  getSeriesFrameManifest,
  setSelectedPatientKey,
  type SeriesFrameManifest,
} from '../src/utils/localApi';
import {
  classifySvrAcquisitions,
  hydrateSvrAcquisitionMetadata,
  nativeReferenceSources,
} from '../src/utils/svr/acquisitionProvenance';
import { createSyntheticSvrDicomFiles } from './svrSyntheticDicom';

function metadata(overrides: Partial<DicomAcquisitionMetadata> = {}): DicomAcquisitionMetadata {
  return {
    version: 1,
    imageType: ['ORIGINAL', 'PRIMARY'],
    mrAcquisitionType: '3D',
    acquisitionMatrix: [0, 224, 224, 0],
    reconstructionDiameterMm: 220,
    acquisitionNumber: 1,
    acquisitionDateTime: '20260101100000',
    scanningSequence: ['SE', 'IR'],
    sequenceVariant: ['NONE'],
    echoTimeMs: 110,
    repetitionTimeMs: 6500,
    inversionTimeMs: 1800,
    sourceSopInstanceUids: [],
    derivationSopInstanceUids: [],
    ...overrides,
  };
}

function manifest(
  seriesUid: string,
  acquisitionMetadata: DicomAcquisitionMetadata | undefined = metadata(),
  orientation = '1\\0\\0\\0\\1\\0',
): SeriesFrameManifest {
  return {
    seriesUid,
    studyUid: 'study',
    patientKey: 'patient',
    frameOfReferenceUid: 'frame',
    ordering: 'physical',
    geometryReliable: true,
    sliceSpacingMm: 0.6,
    coverageMm: 0.6,
    frames: [0, 1].map((index) => ({
      sopInstanceUid: `${seriesUid}.${index}`,
      seriesInstanceUid: seriesUid,
      studyInstanceUid: 'study',
      instanceNumber: index + 1,
      frameOfReferenceUid: 'frame',
      physicalSlicePosition: index * 0.6,
      rows: 512,
      columns: 512,
      imageOrientationPatient: orientation,
      imagePositionPatient: `0\\0\\${index * 0.6}`,
      pixelSpacing: '0.4297\\0.4297',
      sliceThickness: 1.2,
      acquisitionMetadata,
    })),
  };
}

describe('conservative acquisition provenance', () => {
  it('prefers the original 3D acquisition without treating its averaged reformats as independent measurements', () => {
    const sagittal = manifest('native', metadata(), '0\\1\\0\\0\\0\\1');
    const derived = metadata({ imageType: ['DERIVED', 'SECONDARY', 'REFORMATTED', 'AVERAGE'] });
    const axial = manifest('axial-reformat', derived);
    const coronal = manifest('coronal-reformat', derived, '1\\0\\0\\0\\0\\1');
    const result = classifySvrAcquisitions([axial, coronal, sagittal]);
    expect(result.mode).toBe('native-3d');
    expect(result.primaryOriginal3d).toBe(sagittal);
    expect(result.eligibleIndependentSources).toEqual([]);
    expect(result.sources.map((source) => source.kind)).toEqual(['derived', 'derived', 'original-3d']);
    expect(result.warnings.join(' ')).toMatch(/not counted as independent/);
  });

  it('admits complementary original 2D acquisitions with positive acquisition identity and matching contrast', () => {
    const axial = manifest('original-a', metadata({ mrAcquisitionType: '2D', acquisitionNumber: 1 }));
    const coronal = manifest(
      'original-b',
      metadata({ mrAcquisitionType: '2D', acquisitionNumber: 2 }),
      '1\\0\\0\\0\\0\\1',
    );
    const result = classifySvrAcquisitions([axial, coronal]);
    expect(result.mode).toBe('independent-2d');
    expect(result.eligibleIndependentSources).toEqual([axial, coronal]);
    expect(result.primaryOriginal3d).toBeNull();
  });

  it('recognizes separate acquisition times without confusing equivalent fractional timestamp encodings', () => {
    const axial = manifest('timed-a', metadata({ mrAcquisitionType: '2D', acquisitionDateTime: '20260101100000.0' }));
    const sameTime = manifest(
      'timed-b',
      metadata({ mrAcquisitionType: '2D', acquisitionDateTime: '20260101100000.000000' }),
      '1\\0\\0\\0\\0\\1',
    );
    expect(classifySvrAcquisitions([axial, sameTime]).mode).toBe('unknown');
    const later = manifest(
      'timed-c',
      metadata({ mrAcquisitionType: '2D', acquisitionDateTime: '20260101101500' }),
      '1\\0\\0\\0\\0\\1',
    );
    expect(classifySvrAcquisitions([axial, later]).mode).toBe('independent-2d');
  });

  it('does not infer independence from new SOPs, rotated views, unknown acquisition types, or mismatched contrast', () => {
    const axial = manifest('a', metadata({ mrAcquisitionType: '2D' }));
    const coronal = manifest('b', metadata({ mrAcquisitionType: '2D' }), '1\\0\\0\\0\\0\\1');
    expect(classifySvrAcquisitions([axial, coronal]).mode).toBe('unknown');
    for (const frame of coronal.frames) frame.acquisitionMetadata = metadata({ mrAcquisitionType: undefined });
    expect(classifySvrAcquisitions([axial, coronal]).mode).toBe('unknown');
    for (const frame of coronal.frames)
      frame.acquisitionMetadata = metadata({ mrAcquisitionType: '2D', acquisitionNumber: 2, echoTimeMs: 12 });
    expect(classifySvrAcquisitions([axial, coronal]).mode).toBe('unknown');
  });

  it('retains unknown and single-frame sources without labeling them original volumetric evidence', () => {
    const unknown = manifest('legacy');
    for (const frame of unknown.frames) delete frame.acquisitionMetadata;
    expect(classifySvrAcquisitions([unknown])).toMatchObject({ mode: 'unknown', primaryOriginal3d: null });
    const single = manifest('single');
    single.frames.length = 1;
    expect(classifySvrAcquisitions([single]).mode).toBe('unknown');
  });

  it('rejects conflicting original declarations, mixed acquisition types, duplicate SOPs, and cyclic derivation', () => {
    const native = manifest('native');
    const originalWithSource = manifest('contradictory', metadata({ sourceSopInstanceUids: ['native.0'] }));
    expect(classifySvrAcquisitions([native, originalWithSource]).mode).toBe('conflicting');
    const mixed = manifest('mixed');
    mixed.frames[1]!.acquisitionMetadata = metadata({ mrAcquisitionType: '2D' });
    expect(classifySvrAcquisitions([mixed]).mode).toBe('conflicting');
    expect(classifySvrAcquisitions([native, native]).mode).toBe('conflicting');
    const a = manifest(
      'derived-a',
      metadata({ imageType: ['DERIVED', 'SECONDARY'], sourceSopInstanceUids: ['derived-b.0'] }),
    );
    const b = manifest(
      'derived-b',
      metadata({ imageType: ['DERIVED', 'SECONDARY'], derivationSopInstanceUids: ['derived-a.0'] }),
    );
    expect(classifySvrAcquisitions([a, b]).mode).toBe('conflicting');
  });

  it('does not fuse patient, examination, or frame-of-reference mismatches', () => {
    const native = manifest('native');
    for (const changed of [
      { ...manifest('other'), patientKey: 'different-patient' },
      { ...manifest('other'), studyUid: 'different-study' },
      { ...manifest('other'), frameOfReferenceUid: 'different-frame' },
    ])
      expect(classifySvrAcquisitions([native, changed]).mode).toBe('conflicting');
  });
});

describe('native reference source admission', () => {
  const reformat = (seriesUid: string, overrides: Partial<DicomAcquisitionMetadata> = {}) =>
    manifest(seriesUid, metadata({ imageType: ['DERIVED', 'SECONDARY', 'REFORMATTED', 'AVERAGE'], ...overrides }));

  it.each([
    { matrix: [0, 224, 224, 0] as const, diameter: 220, twoTimes: false },
    { matrix: [0, 232, 232, 0] as const, diameter: 232, twoTimes: false },
    { matrix: [0, 224, 224, 0] as const, diameter: 220, twoTimes: true },
    { matrix: [0, 224, 224, 0] as const, diameter: 220, twoTimes: false },
  ])('retains the coherent original3D/reformat triplet: %o', ({ matrix, diameter, twoTimes }) => {
    const common = {
      acquisitionMatrix: [...matrix] as [number, number, number, number],
      reconstructionDiameterMm: diameter,
    };
    const primary = manifest('native', metadata(common), '0\\1\\0\\0\\0\\1');
    if (twoTimes)
      primary.frames[1]!.acquisitionMetadata = metadata({ ...common, acquisitionDateTime: '20260101100001' });
    const axial = reformat('axial', { ...common, acquisitionDateTime: '20260101100000.000000' });
    const coronal = reformat('coronal', common);
    for (const frame of axial.frames) {
      frame.rows = 256;
      frame.pixelSpacing = '0.8\\0.8';
      frame.sliceThickness = 2;
    }
    expect(nativeReferenceSources([axial, primary, coronal], primary)).toEqual([axial, primary, coronal]);
  });

  it('excludes unknown sources, another original acquisition, and an unrelated same-FOR reformat', () => {
    const primary = manifest('native');
    const other = manifest('other-original', metadata({ acquisitionNumber: 2, acquisitionDateTime: '20260101100500' }));
    const unknown = manifest('unknown');
    for (const frame of unknown.frames) delete frame.acquisitionMetadata;
    const unrelated = reformat('unrelated', { acquisitionNumber: 2, acquisitionDateTime: '20260101100500' });
    const related = reformat('related');
    expect(nativeReferenceSources([primary, other, unknown, unrelated, related], primary)).toEqual([primary, related]);
  });

  it('requires unambiguous source references when original volumes reuse the same acquisition metadata', () => {
    const primary = manifest('native');
    const duplicateMetadata = manifest('other-original');
    const ambiguous = reformat('ambiguous');
    const explicit = reformat('explicit', {
      sourceSopInstanceUids: ['native.0', 'native.1'],
      acquisitionDateTime: undefined,
      acquisitionMatrix: undefined,
    });
    expect(nativeReferenceSources([primary, duplicateMetadata, ambiguous, explicit], primary)).toEqual([
      primary,
      explicit,
    ]);
  });

  it.each([
    { acquisitionNumber: undefined },
    { acquisitionDateTime: undefined },
    { acquisitionDateTime: '20260101100000+0100' },
    { acquisitionMatrix: undefined },
    { acquisitionMatrix: [0, 128, 128, 0] as [number, number, number, number] },
    { reconstructionDiameterMm: undefined },
    { echoTimeMs: 120 },
    { scanningSequence: ['GR'] },
    { imageType: ['DERIVED', 'SECONDARY', 'OTHER'] },
    { sourceSopInstanceUids: ['another-original.0'] },
    { derivationSopInstanceUids: ['native.0', 'unresolved-source'] },
  ])('does not invent a shared pose from incomplete or contradictory evidence: %o', (overrides) => {
    const primary = manifest('native');
    const derived = reformat('derived', overrides);
    expect(nativeReferenceSources([primary, derived], primary)).toEqual([primary]);
  });

  it('checks every frame and source scope, and keeps unknown fallback stacks primary-only', () => {
    const primary = manifest('native');
    const mixed = reformat('mixed');
    mixed.frames[1]!.acquisitionMetadata = metadata({
      imageType: ['DERIVED', 'SECONDARY', 'REFORMATTED'],
      acquisitionNumber: 3,
    });
    const foreign = { ...reformat('foreign'), patientKey: 'other' };
    expect(nativeReferenceSources([primary, mixed, foreign], primary)).toEqual([primary]);
    for (const frame of primary.frames) delete frame.acquisitionMetadata;
    expect(nativeReferenceSources([primary, reformat('derived')], primary)).toEqual([primary]);
  });
});

async function legacyNativeSeries() {
  const files = createSyntheticSvrDicomFiles({ imageSize: 3, slicesPerOrientation: 2, orientations: 2 }).slice(0, 2);
  let seriesUid = '';
  for (const file of files) {
    const bytes = new Uint8Array(await file.arrayBuffer());
    const original = dicomParser.parseDicom(bytes);
    const offset = original.elements.x00180050!.dataOffset - 8;
    const type3d = new Uint8Array([0x18, 0, 0x23, 0, 67, 83, 2, 0, 51, 68]);
    const combined = new Uint8Array(bytes.length + type3d.length);
    combined.set(bytes.subarray(0, offset));
    combined.set(type3d, offset);
    combined.set(bytes.subarray(offset), offset + type3d.length);
    expect((await processDicomFile(new File([combined], 'synthetic-native.dcm'))).status).toBe('ingested');
    seriesUid = original.string('x0020000e')!;
  }
  const db = await getDB();
  const instances = await db.getAllFromIndex('instances', 'by-series', seriesUid);
  for (const instance of instances) {
    const legacy = { ...instance };
    delete legacy.acquisitionMetadata;
    await db.put('instances', legacy);
  }
  return {
    manifest: await getSeriesFrameManifest(seriesUid),
    original: instances,
    revision: await getDatasetRevision(),
  };
}

describe('legacy acquisition metadata hydration', () => {
  beforeEach(() => {
    vi.stubGlobal('Blob', NativeBlob);
    vi.stubGlobal('File', NativeFile);
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    await deleteAllStoredMriData();
  });

  it('hydrates existing raw Blobs without reimport, pixel changes, manifest mutation, or a revision bump', async () => {
    const seeded = await legacyNativeSeries();
    const [hydrated] = await hydrateSvrAcquisitionMetadata([seeded.manifest], {
      datasetRevision: seeded.revision,
      selectedPatientKey: null,
    });
    expect(classifySvrAcquisitions([hydrated!]).mode).toBe('native-3d');
    expect(seeded.manifest.frames.every((frame) => !frame.acquisitionMetadata)).toBe(true);
    const db = await getDB();
    for (const original of seeded.original) {
      const stored = (await db.get('instances', original.sopInstanceUid))!;
      expect(stored.acquisitionMetadata).toEqual(original.acquisitionMetadata);
      expect(await stored.fileBlob.arrayBuffer()).toEqual(await original.fileBlob.arrayBuffer());
    }
    expect(await getDatasetRevision()).toBe(seeded.revision);
    const reader = vi.spyOn(extraction, 'readDicomAcquisitionMetadata');
    const fresh = await getSeriesFrameManifest(seeded.manifest.seriesUid);
    await hydrateSvrAcquisitionMetadata([fresh]);
    expect(reader).not.toHaveBeenCalled();
  });

  it.each(['patient', 'revision', 'frame'] as const)(
    'rejects a concurrent %s change before persisting any stale metadata',
    async (change) => {
      const seeded = await legacyNativeSeries();
      const read = extraction.readDicomAcquisitionMetadata;
      vi.spyOn(extraction, 'readDicomAcquisitionMetadata').mockImplementationOnce(async (instance, signal) => {
        const db = await getDB();
        if (change === 'patient') await setSelectedPatientKey('another-patient');
        else if (change === 'revision')
          await db.put('app_state', { key: DATASET_REVISION_STATE_KEY, value: seeded.revision + 1 });
        else await db.put('instances', { ...instance, rows: instance.rows + 1 });
        return read(instance, signal);
      });
      await expect(hydrateSvrAcquisitionMetadata([seeded.manifest])).rejects.toThrow(/changed|selected patient/i);
      const db = await getDB();
      for (const original of seeded.original)
        expect((await db.get('instances', original.sopInstanceUid))?.acquisitionMetadata).toBeUndefined();
    },
  );

  it('cancels during header reading without persisting the incomplete batch', async () => {
    const seeded = await legacyNativeSeries();
    const controller = new AbortController();
    const read = extraction.readDicomAcquisitionMetadata;
    vi.spyOn(extraction, 'readDicomAcquisitionMetadata').mockImplementationOnce(async (instance, signal) => {
      controller.abort();
      return read(instance, signal);
    });
    await expect(hydrateSvrAcquisitionMetadata([seeded.manifest], { signal: controller.signal })).rejects.toMatchObject(
      { name: 'AbortError' },
    );
    const db = await getDB();
    for (const original of seeded.original)
      expect((await db.get('instances', original.sopInstanceUid))?.acquisitionMetadata).toBeUndefined();
  });

  it('does not reveal raw parser errors or promote an unreadable legacy header into independent evidence', async () => {
    const seeded = await legacyNativeSeries();
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => {});
    const warningLog = vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(dicomParser, 'parseDicom').mockImplementation(() => {
      throw new Error('PRIVATE DATA MUST NOT ESCAPE');
    });
    const [hydrated] = await hydrateSvrAcquisitionMetadata([seeded.manifest]);
    expect(hydrated!.frames.every((frame) => frame.acquisitionMetadata?.unavailable)).toBe(true);
    expect(classifySvrAcquisitions([hydrated!]).mode).toBe('unknown');
    expect(errorLog).not.toHaveBeenCalled();
    expect(warningLog).not.toHaveBeenCalled();
  });

  it('fails closed when a legacy Blob belongs to a different image identity', async () => {
    const seeded = await legacyNativeSeries();
    const db = await getDB();
    const first = (await db.get('instances', seeded.original[0]!.sopInstanceUid))!;
    const second = seeded.original[1]!;
    await db.put('instances', { ...first, fileBlob: second.fileBlob });
    await expect(hydrateSvrAcquisitionMetadata([seeded.manifest])).rejects.toThrow(/does not match.*identity/i);
    expect((await db.get('instances', first.sopInstanceUid))?.acquisitionMetadata).toBeUndefined();
  });
});
