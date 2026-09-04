import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Blob as NodeBlob } from 'node:buffer';
import type CornerstoneCore from 'cornerstone-core';
import { DATASET_REVISION_STATE_KEY, deleteAllStoredMriData, getDB } from '../src/db/db';
import type { DicomAcquisitionMetadata, DicomInstance } from '../src/db/schema';
import { DEFAULT_SVR_PARAMS, type SvrProgress, type SvrSelectedSeries } from '../src/types/svr';
import { getSeriesFrameManifest, setSelectedPatientKey } from '../src/utils/localApi';
import * as computeCore from '../src/utils/svr/svrComputeCore';
import { estimateSvrSourceMemory } from '../src/utils/svr/sourceMemory';
import { createNativeSourceContext } from '../src/utils/svr/nativeSourceContext';
import { nativePlaneMemoryBytes, retainedSvrVolumeBytes } from '../src/utils/svr/nativeVolume';
import { SVR_MEMORY_BUDGET_BYTES } from '../src/utils/svr/svrMemoryPlan';
import { deferred } from './helpers/deferred';

const cornerstone = vi.hoisted(() => ({
  loadAndCacheImage: vi.fn(),
  loadImage: vi.fn(),
  getCacheInfo: vi.fn((): { cacheSizeInBytes?: number; maximumSizeInBytes?: number } => ({})),
  cachedImages: [] as { image: { getPixelData: () => Uint8Array }; sizeInBytes: number; loaded: boolean }[],
}));

vi.mock('cornerstone-core', () => ({
  default: {
    loadAndCacheImage: cornerstone.loadAndCacheImage,
    loadImage: cornerstone.loadImage,
    imageCache: { getCacheInfo: cornerstone.getCacheInfo, cachedImages: cornerstone.cachedImages },
    getEnabledElements: () => [],
  },
}));

import { reconstructVolumeMultiPlane } from '../src/utils/svr/reconstructVolume';

const params = {
  ...DEFAULT_SVR_PARAMS,
  maxVolumeDim: 12,
  targetVoxelSizeMm: 1,
  sliceDownsampleMode: 'fixed' as const,
  sliceDownsampleMaxSize: 8,
  seriesRegistrationMode: 'none' as const,
  psfMode: 'none' as const,
  multiResolution: false,
  laplacianWeight: 0,
  iterations: 0,
};

type SourceFixture = {
  seriesUid: string;
  studyUid?: string;
  patientId?: string;
  frameUid?: string;
  orientation?: 'axial' | 'coronal';
  count?: number;
  unreliableGeometry?: boolean;
  pixels?: Int16Array;
  pixelPaddingValue?: number;
  rows?: number;
  columns?: number;
  slicePositionsMm?: number[];
  sliceThicknessMm?: number;
  pixelSpacingMm?: [number, number];
  acquisitionMetadata?: Partial<DicomAcquisitionMetadata> | null;
};

let acquisitionNumber = 0;

const images = new Map<
  string,
  { rows: number; columns: number; pixelPaddingValue?: number; getPixelData: () => Int16Array }
>();

async function seedSeries(options: SourceFixture): Promise<SvrSelectedSeries> {
  const db = await getDB();
  const studyUid = options.studyUid ?? 'study-one';
  const patientId = options.patientId ?? 'patient-one';
  const count = options.slicePositionsMm?.length ?? options.count ?? 2;
  const frameUid = options.frameUid === '' ? undefined : (options.frameUid ?? 'shared-frame');
  const coronal = options.orientation === 'coronal';
  const rows = options.rows ?? 2;
  const columns = options.columns ?? 2;
  const acquisitionMetadata: DicomAcquisitionMetadata =
    options.acquisitionMetadata === null
      ? { version: 1, imageType: [], sourceSopInstanceUids: [], derivationSopInstanceUids: [], unavailable: true }
      : {
          version: 1,
          imageType: ['ORIGINAL', 'PRIMARY'],
          mrAcquisitionType: '2D',
          acquisitionNumber: ++acquisitionNumber,
          scanningSequence: ['SE'],
          echoTimeMs: 90,
          repetitionTimeMs: 4000,
          sourceSopInstanceUids: [],
          derivationSopInstanceUids: [],
          ...options.acquisitionMetadata,
        };

  await db.put('studies', {
    studyInstanceUid: studyUid,
    studyDate: '20260101',
    studyDescription: 'Synthetic study',
    patientName: patientId,
    patientId,
    modality: 'MR',
  });
  await db.put('series', {
    seriesInstanceUid: options.seriesUid,
    studyInstanceUid: studyUid,
    seriesDescription: coronal ? 'Coronal T2' : 'Axial T2',
    seriesNumber: 1,
    modality: 'MR',
    frameOfReferenceUid: frameUid,
  });

  for (let index = 0; index < count; index++) {
    const slicePositionMm = options.slicePositionsMm?.[index] ?? index;
    const sopInstanceUid = `${options.seriesUid}.${index}`;
    const instance: DicomInstance = {
      sopInstanceUid,
      seriesInstanceUid: options.seriesUid,
      studyInstanceUid: studyUid,
      instanceNumber: index + 1,
      frameOfReferenceUid: frameUid,
      physicalSlicePosition: options.unreliableGeometry ? undefined : slicePositionMm,
      rows,
      columns,
      imagePositionPatient: options.unreliableGeometry
        ? undefined
        : coronal
          ? `0\\${-slicePositionMm}\\0`
          : `0\\0\\${slicePositionMm}`,
      imageOrientationPatient: coronal ? '1\\0\\0\\0\\0\\1' : '1\\0\\0\\0\\1\\0',
      pixelSpacing: (options.pixelSpacingMm ?? [1, 1]).join('\\'),
      sliceThickness: options.sliceThicknessMm ?? 1,
      spacingBetweenSlices: 1,
      pixelPaddingValue: options.pixelPaddingValue,
      acquisitionMetadata,
      fileBlob: new NodeBlob(),
    };
    await db.put('instances', instance);

    const sourcePixels = options.pixels ?? Int16Array.from({ length: rows * columns }, (_, pixel) => pixel + 1);
    images.set(`miradb:${sopInstanceUid}`, {
      rows,
      columns,
      pixelPaddingValue: options.pixelPaddingValue,
      getPixelData: () => sourcePixels,
    });
  }

  return {
    seriesUid: options.seriesUid,
    studyId: studyUid,
    dateIso: '2026-01-01',
    instanceCount: count,
    label: coronal ? 'Coronal T2' : 'Axial T2',
    plane: coronal ? 'Coronal' : 'Axial',
    weight: 'T2',
  };
}

function reconstruct(selectedSeries: SvrSelectedSeries[], onProgress?: (progress: SvrProgress) => void) {
  return reconstructVolumeMultiPlane({ selectedSeries, svrParams: params, onProgress });
}

function syntheticComputeResult(reconstructionFingerprint: string, intensity = 1): computeCore.SvrComputeResult {
  return {
    volume: new Float32Array([intensity]),
    displayWindow: [0, 1],
    observedSupport: new Uint8Array([1]),
    supportedVoxelCount: 1,
    acquiredOrientationCount: 2,
    effectiveResolutionMm: [1, 1, 1],
    sliceProfileSource: 'declared',
    reconstructionFingerprint,
    sourceTransforms: {},
    contributingSopInstanceUids: {},
    dims: { nx: 1, ny: 1, nz: 1 },
    originMm: { x: 0, y: 0, z: 0 },
    voxelSizeMm: 1,
    bounds: { min: { x: 0, y: 0, z: 0 }, max: { x: 1, y: 1, z: 1 } },
  };
}

describe('SVR canonical source admission and acquired support', () => {
  beforeEach(() => {
    images.clear();
    acquisitionNumber = 0;
    localStorage.setItem('miraviewer:debug-svr', '0');
    cornerstone.getCacheInfo.mockReset();
    cornerstone.cachedImages.length = 0;
    cornerstone.getCacheInfo.mockReturnValue({});
    const readImage = async (imageId: string) => {
      const image = images.get(imageId);
      if (!image) throw new Error('Synthetic source frame disappeared');
      return image;
    };
    cornerstone.loadAndCacheImage.mockImplementation(readImage);
    cornerstone.loadImage.mockImplementation(readImage);
    vi.spyOn(console, 'info').mockImplementation(() => {});
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    await deleteAllStoredMriData();
    localStorage.clear();
  });

  it('rejects source series from different patients before decoding any image', async () => {
    const axial = await seedSeries({ seriesUid: 'patient-a-axial', patientId: 'patient-a', studyUid: 'study-a' });
    const coronal = await seedSeries({
      seriesUid: 'patient-b-coronal',
      patientId: 'patient-b',
      studyUid: 'study-b',
      orientation: 'coronal',
    });

    await expect(reconstruct([axial, coronal])).rejects.toThrow(/same patient/i);
    expect(cornerstone.loadImage).not.toHaveBeenCalled();
    expect(cornerstone.loadAndCacheImage).not.toHaveBeenCalled();
  });

  it('retains the accepted reconstruction parameters for subsequent source-backed refinement', async () => {
    const axial = await seedSeries({ seriesUid: 'settings-axial' });
    const coronal = await seedSeries({ seriesUid: 'settings-coronal', orientation: 'coronal' });
    const result = await reconstruct([axial, coronal]);
    expect(result.parameters).toEqual(params);
    expect(result.volume.data.length).toBeGreaterThan(0);
  });

  it('rejects source series from separate examinations of the same patient', async () => {
    const axial = await seedSeries({ seriesUid: 'first-exam', studyUid: 'study-one' });
    const coronal = await seedSeries({ seriesUid: 'second-exam', studyUid: 'study-two', orientation: 'coronal' });

    await expect(reconstruct([axial, coronal])).rejects.toThrow(/same examination/i);
  });

  it('rejects otherwise compatible sources that do not belong to the currently selected patient', async () => {
    const axial = await seedSeries({ seriesUid: 'inactive-axial' });
    const coronal = await seedSeries({ seriesUid: 'inactive-coronal', orientation: 'coronal' });
    await setSelectedPatientKey('another-active-patient');

    await expect(reconstruct([axial, coronal])).rejects.toThrow(/currently selected patient/i);
    expect(cornerstone.loadAndCacheImage).not.toHaveBeenCalled();
  });

  it('rejects a selected study identifier that does not match the canonical source manifest', async () => {
    const axial = await seedSeries({ seriesUid: 'wrong-selected-exam' });
    const coronal = await seedSeries({ seriesUid: 'matching-coronal', orientation: 'coronal' });

    await expect(reconstruct([{ ...axial, studyId: 'different-selected-study' }, coronal])).rejects.toThrow(
      /selected examination/i,
    );
  });

  it('rejects incompatible DICOM frames of reference', async () => {
    const axial = await seedSeries({ seriesUid: 'frame-a', frameUid: 'frame-a' });
    const coronal = await seedSeries({ seriesUid: 'frame-b', frameUid: 'frame-b', orientation: 'coronal' });

    await expect(reconstruct([axial, coronal])).rejects.toThrow(/incompatible.*frames of reference/i);
  });

  it('fails closed when a selected source has no verified frame of reference', async () => {
    const axial = await seedSeries({ seriesUid: 'missing-frame', frameUid: '' });
    const coronal = await seedSeries({ seriesUid: 'known-frame', orientation: 'coronal' });

    await expect(reconstruct([axial, coronal])).rejects.toThrow(/verified.*frame of reference/i);
  });

  it('rejects unreliable physical slice geometry and incomplete selected source counts', async () => {
    const unreliable = await seedSeries({ seriesUid: 'unreliable', unreliableGeometry: true });
    const coronal = await seedSeries({ seriesUid: 'reliable-coronal', orientation: 'coronal' });

    await expect(reconstruct([unreliable, coronal])).rejects.toThrow(/unreliable or incomplete/i);

    const axial = await seedSeries({ seriesUid: 'complete-axial' });
    await expect(reconstruct([{ ...axial, instanceCount: axial.instanceCount + 1 }, coronal])).rejects.toThrow(
      /source frames changed/i,
    );
  });

  it('opens one honest source stack when displayed plane labels do not establish independent geometry', async () => {
    const axial = await seedSeries({ seriesUid: 'first-axial' });
    const anotherAxial = await seedSeries({ seriesUid: 'second-axial' });
    const compute = vi.spyOn(computeCore, 'computeSvrFromLoadedSlices');
    const result = await reconstruct([axial, { ...anotherAxial, plane: 'Coronal', label: 'Coronal' }]);
    expect(compute).not.toHaveBeenCalled();
    expect(result.volume.sourceProvenance?.mode).toBe('source-stack');
    expect(result.volume.sourceProvenance?.primarySeriesUid).toBe(axial.seriesUid);
    expect(cornerstone.loadImage.mock.calls.map(([imageId]) => imageId)).toEqual([
      'miradb:first-axial.0',
      'miradb:first-axial.1',
    ]);
    expect(cornerstone.loadAndCacheImage).not.toHaveBeenCalled();
  });

  it('does not fuse unknown complementary views or treat derived reformats as additional measurements', async () => {
    const axial = await seedSeries({ seriesUid: 'unknown-axial', acquisitionMetadata: null });
    const coronal = await seedSeries({
      seriesUid: 'derived-coronal',
      orientation: 'coronal',
      acquisitionMetadata: { imageType: ['DERIVED', 'SECONDARY', 'MPR'], sourceSopInstanceUids: ['unknown-axial.0'] },
    });
    const compute = vi.spyOn(computeCore, 'computeSvrFromLoadedSlices');
    const result = await reconstruct([axial, coronal]);
    expect(compute).not.toHaveBeenCalled();
    expect(result.volume.sourceProvenance?.mode).toBe('source-stack');
    expect(result.volume.acquiredOrientationCount).toBe(1);
    expect(result.volume.data).toEqual(Float32Array.from([1, 2, 3, 4, 1, 2, 3, 4]));
    expect(result.volume.sourceProvenance?.sources.map((source) => source.contributingSopInstanceUids)).toEqual([
      ['unknown-axial.0', 'unknown-axial.1'],
    ]);
    expect(result.volume.sourceProvenance?.sources.map((source) => source.seriesUid)).toEqual(['unknown-axial']);
    expect(cornerstone.loadImage).toHaveBeenCalledTimes(2);
    expect(cornerstone.loadAndCacheImage).not.toHaveBeenCalled();
  });

  it('uses original 3D native values and canonical source frames while a regional crop never enters the inverse solver', async () => {
    const derived = await seedSeries({
      seriesUid: 'reformat',
      orientation: 'coronal',
      acquisitionMetadata: { imageType: ['DERIVED', 'SECONDARY', 'MPR'], sourceSopInstanceUids: ['original.0'] },
    });
    const original = await seedSeries({
      seriesUid: 'original',
      count: 20,
      rows: 10,
      columns: 10,
      pixels: Int16Array.from({ length: 100 }, (_, index) => index - 50),
      acquisitionMetadata: { mrAcquisitionType: '3D' },
    });
    const compute = vi.spyOn(computeCore, 'computeSvrFromLoadedSlices');
    const result = await reconstructVolumeMultiPlane({
      selectedSeries: [derived, original],
      svrParams: {
        ...params,
        maxVolumeDim: 2,
        sliceDownsampleMaxSize: 2,
        roi: { mode: 'cube', sourcePlane: 'axial', boundsMm: { min: [4, 4, 8], max: [5, 5, 10] } },
      },
    });
    expect(compute).not.toHaveBeenCalled();
    expect(result.volume.sourceProvenance?.mode).toBe('native-3d');
    expect(result.volume.nativeVoxelSizeMm).toEqual([1, 1, 1]);
    expect(result.volume.voxelSizeMm).toEqual([1, 1, 1]);
    expect(result.volume.dims).toEqual([4, 4, 5]);
    expect(result.volume.originMm).toEqual([3, 3, 7]);
    expect(result.volume.data[0]).toBe(-17);
    const source = result.volume.sourceProvenance!.sources.find((source) => source.seriesUid === 'original')!;
    expect(source.frames).toHaveLength(20);
    expect(Object.isFrozen(result.volume.sourceProvenance)).toBe(true);
    expect(Object.isFrozen(source.frames)).toBe(true);
    expect(Object.isFrozen(source.frames[0])).toBe(true);
    expect(Object.isFrozen(source.frames[0]!.originMm)).toBe(true);
    expect(Object.isFrozen(source.transform)).toBe(true);
    expect(Object.isFrozen(source.contributingSopInstanceUids)).toBe(true);
    expect(source.frames[0]).toMatchObject({ rows: 10, columns: 10, originMm: [0, 0, 0], pixelSpacingMm: [1, 1] });
    expect(source.contributingSopInstanceUids).toEqual([
      'original.7',
      'original.8',
      'original.9',
      'original.10',
      'original.11',
    ]);
    expect(cornerstone.loadImage).toHaveBeenCalledTimes(5);
    expect(cornerstone.loadAndCacheImage).not.toHaveBeenCalled();
  });

  it('streams native frames without cache insertion while reusing existing entries through real Cornerstone loadImage', async () => {
    const original = await seedSeries({
      seriesUid: 'streamed-native',
      acquisitionMetadata: { mrAcquisitionType: '3D' },
    });
    const { default: realCornerstone } = await vi.importActual<{ default: typeof CornerstoneCore }>('cornerstone-core');
    const scheme = 'native-stream-test';
    const key = (imageId: string) => imageId.replace('miradb:', `${scheme}:`);
    const loader = vi.fn((imageId: string) => {
      const image = images.get(imageId.replace(`${scheme}:`, 'miradb:'))!;
      return { promise: Promise.resolve({ ...image, imageId, sizeInBytes: image.getPixelData().byteLength }) };
    });
    realCornerstone.registerImageLoader(scheme, loader);
    const firstKey = key('miradb:streamed-native.0');
    await realCornerstone.loadAndCacheImage(firstKey);
    const before = realCornerstone.imageCache.getCacheInfo();
    loader.mockClear();
    cornerstone.loadImage.mockImplementation((imageId: string) => realCornerstone.loadImage(key(imageId)));
    try {
      const result = await reconstruct([original]);
      expect(cornerstone.loadAndCacheImage).not.toHaveBeenCalled();
      expect(loader).toHaveBeenCalledOnce();
      expect(loader).toHaveBeenCalledWith(key('miradb:streamed-native.1'), undefined);
      expect(realCornerstone.imageCache.getImageLoadObject(firstKey)).toBeDefined();
      expect(realCornerstone.imageCache.getImageLoadObject(key('miradb:streamed-native.1'))).toBeUndefined();
      expect(realCornerstone.imageCache.getCacheInfo()).toEqual(before);
      expect(result.volume.data).toEqual(Float32Array.of(1, 2, 3, 4, 1, 2, 3, 4));
    } finally {
      realCornerstone.imageCache.removeImageLoadObject(firstKey);
    }
  });

  it.each(['complete', 'failure', 'abort'] as const)(
    'streams independent 2D sources without changing the real image cache (%s)',
    async (outcome) => {
      vi.spyOn(navigator, 'hardwareConcurrency', 'get').mockReturnValue(4);
      const pixels = Int16Array.of(10, -2000, 30, 40);
      const originalPixels = pixels.slice();
      const axial = await seedSeries({ seriesUid: 'streamed-2d-axial', count: 16, pixels, pixelPaddingValue: -2000 });
      const coronal = await seedSeries({
        seriesUid: 'streamed-2d-coronal',
        count: 16,
        orientation: 'coronal',
        pixels,
        pixelPaddingValue: -2000,
      });
      const { default: real } = await vi.importActual<{ default: typeof CornerstoneCore }>('cornerstone-core');
      const scheme = `svr-stream-${outcome}`;
      const key = (id: string) => id.replace('miradb:', `${scheme}:`);
      const controller = new AbortController();
      const loader = vi.fn((id: string) => {
        if (id.endsWith('axial.2')) {
          if (outcome === 'failure') return { promise: Promise.reject(new Error('Synthetic decode failure')) };
          if (outcome === 'abort') controller.abort();
        }
        const image = images.get(id.replace(`${scheme}:`, 'miradb:'))!;
        return { promise: Promise.resolve({ ...image, imageId: id, sizeInBytes: pixels.byteLength }) };
      });
      real.registerImageLoader(scheme, loader);
      const first = key('miradb:streamed-2d-axial.0');
      await real.loadAndCacheImage(first);
      const before = real.imageCache.getCacheInfo();
      const cachedFirst = real.imageCache.getImageLoadObject(first);
      loader.mockClear();
      cornerstone.loadImage.mockImplementation((id: string) => real.loadImage(key(id)));
      const compute = vi.spyOn(computeCore, 'computeSvrFromLoadedSlices').mockImplementation(async (payload) => {
        expect(payload.allSlices).toHaveLength(32);
        for (const frame of payload.allSlices) {
          expect(frame.pixels).toEqual(Float32Array.of(10, 0, 30, 40));
          expect(frame.valid).toEqual(Uint8Array.of(255, 0, 255, 255));
          expect([frame.srcRows, frame.srcCols, frame.dsRows, frame.dsCols]).toEqual([2, 2, 2, 2]);
          expect([frame.rowSpacingMm, frame.colSpacingMm]).toEqual([1, 1]);
        }
        return syntheticComputeResult('non-inserting-2d');
      });
      try {
        const run = reconstructVolumeMultiPlane({
          selectedSeries: [axial, coronal],
          svrParams: params,
          signal: controller.signal,
        });
        if (outcome === 'complete') {
          await run;
          expect(loader).toHaveBeenCalledTimes(31);
          expect(compute).toHaveBeenCalledOnce();
        } else {
          await expect(run).rejects.toThrow(outcome === 'abort' ? /cancel/i : /Synthetic decode failure/);
          expect(loader.mock.calls.length).toBeLessThan(16);
          expect(compute).not.toHaveBeenCalled();
        }
        await Promise.resolve();
        expect(cornerstone.loadAndCacheImage).not.toHaveBeenCalled();
        expect(real.imageCache.getCacheInfo()).toEqual(before);
        expect(real.imageCache.getImageLoadObject(first)).toBe(cachedFirst);
        expect(real.imageCache.getImageLoadObject(key('miradb:streamed-2d-axial.1'))).toBeUndefined();
        expect(pixels).toEqual(originalPixels);
      } finally {
        real.imageCache.removeImageLoadObject(first);
      }
    },
  );

  it('cancels a stalled native decoder, retries successfully, and never reads or publishes its late source pixels', async () => {
    const original = await seedSeries({
      seriesUid: 'cancel-native',
      acquisitionMetadata: { mrAcquisitionType: '3D' },
    });
    const lateImage = {
      rows: 2,
      columns: 2,
      getPixelData: vi.fn(() => Int16Array.of(-1, -2, -3, -4)),
    };
    const delayed = deferred<typeof lateImage>();
    cornerstone.loadImage.mockImplementationOnce(() => delayed.promise);
    const controller = new AbortController();
    const publish = vi.fn();
    const progress = vi.fn();
    const pending = reconstructVolumeMultiPlane({
      selectedSeries: [original],
      svrParams: params,
      signal: controller.signal,
      onProgress: progress,
    }).then(publish);
    const rejected = expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    await vi.waitFor(() => expect(cornerstone.loadImage).toHaveBeenCalledOnce());
    controller.abort();
    await rejected;
    const progressAtAbort = progress.mock.calls.length;
    const retry = await reconstruct([original]);
    expect(retry.volume.data).toEqual(Float32Array.of(1, 2, 3, 4, 1, 2, 3, 4));
    expect(cornerstone.loadImage).toHaveBeenCalledTimes(3);
    expect(cornerstone.loadAndCacheImage).not.toHaveBeenCalled();
    delayed.resolve(lateImage);
    await Promise.resolve();
    await Promise.resolve();
    expect(lateImage.getPixelData).not.toHaveBeenCalled();
    expect(publish).not.toHaveBeenCalled();
    expect(progress).toHaveBeenCalledTimes(progressAtAbort);
  });

  it('does not give excluded derived sources an invented identity pose after independent-source registration', async () => {
    const axial = await seedSeries({ seriesUid: 'accepted-axial' });
    const coronal = await seedSeries({ seriesUid: 'accepted-coronal', orientation: 'coronal' });
    const derived = await seedSeries({
      seriesUid: 'excluded-derived',
      acquisitionMetadata: {
        imageType: ['DERIVED', 'SECONDARY'],
        sourceSopInstanceUids: ['accepted-coronal.0'],
      },
    });
    const result = await reconstruct([axial, coronal, derived]);
    expect(result.volume.sourceProvenance?.mode).toBe('independent-2d');
    expect(result.volume.sourceProvenance?.sources.map((source) => source.seriesUid)).toEqual([
      'accepted-axial',
      'accepted-coronal',
    ]);
    expect(cornerstone.loadImage.mock.calls.map(([imageId]) => imageId)).not.toContain('miradb:excluded-derived.0');
  });

  it('exposes only the native original and verified same-acquisition reformats and inherits the primary accepted pose', async () => {
    const original = await seedSeries({
      seriesUid: 'native-primary',
      count: 5,
      rows: 4,
      columns: 4,
      acquisitionMetadata: { mrAcquisitionType: '3D' },
    });
    const reformat = await seedSeries({
      seriesUid: 'native-reformat',
      orientation: 'coronal',
      acquisitionMetadata: { imageType: ['DERIVED', 'SECONDARY', 'MPR'], sourceSopInstanceUids: ['native-primary.0'] },
    });
    const other = await seedSeries({ seriesUid: 'other-original', acquisitionMetadata: { mrAcquisitionType: '3D' } });
    const unknown = await seedSeries({ seriesUid: 'unknown-reference', acquisitionMetadata: null });
    const selectedSeries = [original, reformat, other, unknown];
    const first = await reconstruct(selectedSeries);
    const provenance = first.volume.sourceProvenance!;
    expect(provenance.sources.map((source) => source.seriesUid)).toEqual(['native-primary', 'native-reformat']);
    const transform = { rotation: [1, 0, 0, 0, 1, 0, 0, 0, 1] as const, translationMm: [10, 20, 30] as const };
    const accepted = { ...provenance, sources: provenance.sources.map((source) => ({ ...source, transform })) };
    const snapshot = JSON.stringify(accepted);
    const refined = await reconstructVolumeMultiPlane({
      selectedSeries,
      svrParams: params,
      acceptedProvenance: accepted,
    });
    expect(refined.volume.originMm).toEqual([10, 20, 30]);
    expect(refined.volume.sourceProvenance!.sources.map((source) => source.transform)).toEqual([transform, transform]);
    expect(refined.volume.sourceProvenance!.sources[1]!.transform).not.toBe(transform);
    expect(JSON.stringify(accepted)).toBe(snapshot);
  });

  // This full-size assembly checks memory/source ownership, not a five-second latency budget on a shared test host.
  it('loads context beside the actual default overview only within its explicit combined native-source budget', async () => {
    cornerstone.getCacheInfo.mockReturnValue({ cacheSizeInBytes: 0, maximumSizeInBytes: 256 * 1024 * 1024 });
    const pixels = Int16Array.from({ length: 512 * 512 }, (_, index) => (index % 32000) - 16000);
    const original = await seedSeries({
      seriesUid: 'default-overview-context',
      count: 221,
      rows: 512,
      columns: 512,
      pixels,
      pixelSpacingMm: [0.4296875, 0.4296875],
      acquisitionMetadata: { mrAcquisitionType: '3D' },
    });
    const accepted = await reconstruct([original]);
    expect(accepted.volume.dims).toEqual([256, 512, 221]);
    const originalData = accepted.volume.data;
    const originalSample = originalData[50];
    const nativeSource = await getSeriesFrameManifest(original.seriesUid);
    const options = {
      volume: accepted.volume,
      nativeSource,
      selectedSeries: [original],
      parameters: params,
      retainedBytes: retainedSvrVolumeBytes(accepted.volume) + 1024,
      decodedCacheBytes: 0,
      nativePlaneBytes: nativePlaneMemoryBytes([nativeSource]),
    };
    const roi = {
      mode: 'box' as const,
      sourcePlane: 'axial' as const,
      boundsMm: { min: [60, 60, 0] as [number, number, number], max: [140, 140, 220] as [number, number, number] },
    };
    const ordinary = createNativeSourceContext(options);
    const plan = ordinary.plan(roi, options);
    expect(plan.budgetBytes).toBe(SVR_MEMORY_BUDGET_BYTES);
    expect(plan.totalBytes).toBeGreaterThan(SVR_MEMORY_BUDGET_BYTES);
    cornerstone.loadImage.mockClear();
    await expect(ordinary.load(roi, options)).rejects.toThrow(/memory budget/);
    expect(cornerstone.loadImage).not.toHaveBeenCalled();

    await expect(ordinary.load(roi, { ...options, budgetBytes: plan.totalBytes - 1 })).rejects.toThrow(/memory budget/);
    expect(cornerstone.loadImage).not.toHaveBeenCalled();

    const admitted = { ...options, budgetBytes: plan.totalBytes };
    expect(ordinary.plan(roi, admitted).budgetBytes).toBe(plan.totalBytes);
    const loaded = await ordinary.load(roi, admitted);
    expect(loaded.dims).toEqual(plan.dims);
    expect(loaded.voxelSizeMm).toEqual(plan.nativeVoxelSizeMm);
    expect(loaded.originMm).toEqual(plan.originMm);
    expect(loaded.sourceProvenance?.sources[0]?.transform).toEqual(
      accepted.volume.sourceProvenance?.sources[0]?.transform,
    );
    expect(loaded.data[0]).toBe(pixels[plan.cropMin[1] * 512 + plan.cropMin[0]]);
    expect(loaded.observedSupport?.every((value) => value === 1)).toBe(true);
    expect(loaded.data.buffer).not.toBe(originalData.buffer);
    expect(accepted.volume.data).toBe(originalData);
    expect(originalData[50]).toBe(originalSample);
    expect(cornerstone.loadImage).toHaveBeenCalledTimes(221);
    expect(cornerstone.loadAndCacheImage).not.toHaveBeenCalled();

    // A caller-supplied operation budget does not weaken the source identity boundary.
    cornerstone.loadImage.mockClear();
    await setSelectedPatientKey('another-active-patient');
    await expect(ordinary.load(roi, admitted)).rejects.toThrow(/currently selected patient/);
    expect(cornerstone.loadImage).not.toHaveBeenCalled();
  }, 15_000);

  it.each(['no accepted source', 'no region', 'independent source', 'invalid budget'] as const)(
    'does not apply a native-context budget to %s',
    async (kind) => {
      cornerstone.getCacheInfo.mockReturnValue({ cacheSizeInBytes: 0 });
      const selectedSeries = [
        await seedSeries({
          seriesUid: 'budget-native',
          acquisitionMetadata: kind === 'independent source' ? {} : { mrAcquisitionType: '3D' },
        }),
      ];
      if (kind === 'independent source')
        selectedSeries.push(await seedSeries({ seriesUid: 'budget-coronal', orientation: 'coronal' }));
      const accepted = await reconstruct(selectedSeries);
      cornerstone.loadImage.mockClear();
      await expect(
        reconstructVolumeMultiPlane({
          selectedSeries,
          svrParams: {
            ...params,
            ...(kind !== 'no region' && {
              roi: { mode: 'box' as const, sourcePlane: 'axial' as const, boundsMm: accepted.volume.boundsMm },
            }),
          },
          acceptedProvenance: kind === 'no accepted source' ? undefined : accepted.volume.sourceProvenance,
          nativeContextBudgetBytes: kind === 'invalid budget' ? NaN : 3 * 1024 ** 3,
        }),
      ).rejects.toThrow(/native source context/);
      expect(cornerstone.loadImage).not.toHaveBeenCalled();
    },
  );

  it('rejects an over-budget native-pitch regional source stack before any image decode or solver allocation', async () => {
    const large = { count: 60, rows: 1024, columns: 1024, pixels: Int16Array.of(1) };
    const axial = await seedSeries({ ...large, seriesUid: 'large-regional-axial' });
    const coronal = await seedSeries({ ...large, seriesUid: 'large-regional-coronal', orientation: 'coronal' });
    const compute = vi.spyOn(computeCore, 'computeSvrFromLoadedSlices');
    await expect(
      reconstructVolumeMultiPlane({
        selectedSeries: [axial, coronal],
        svrParams: {
          ...params,
          roi: { mode: 'cube', sourcePlane: 'axial', boundsMm: { min: [0, -1023, 0], max: [1023, 1023, 1023] } },
        },
      }),
    ).rejects.toThrow(/source inputs.*budget before decoding/);
    expect(cornerstone.loadImage).not.toHaveBeenCalled();
    expect(cornerstone.loadAndCacheImage).not.toHaveBeenCalled();
    expect(compute).not.toHaveBeenCalled();
  });

  it('uses the same native-pitch source-copy estimate for UI planning and the decoded worker payload', async () => {
    const axial = await seedSeries({ seriesUid: 'memory-axial', count: 4, rows: 12, columns: 12 });
    const coronal = await seedSeries({
      seriesUid: 'memory-coronal',
      count: 4,
      rows: 12,
      columns: 12,
      orientation: 'coronal',
    });
    const selectedSeries = [axial, coronal];
    const svrParams = {
      ...params,
      roi: {
        mode: 'cube' as const,
        sourcePlane: 'axial' as const,
        boundsMm: { min: [4, -2, 1] as [number, number, number], max: [6, 0, 3] as [number, number, number] },
      },
    };
    const planned = estimateSvrSourceMemory(
      await Promise.all(selectedSeries.map((source) => getSeriesFrameManifest(source.seriesUid))),
      svrParams,
    );
    let actualBytes = 0;
    vi.spyOn(computeCore, 'computeSvrFromLoadedSlices').mockImplementation(async (payload) => {
      actualBytes = payload.allSlices.reduce(
        (bytes, slice) => bytes + slice.pixels.byteLength + slice.valid!.byteLength,
        0,
      );
      return syntheticComputeResult('shared-source-memory');
    });
    await reconstructVolumeMultiPlane({ selectedSeries, svrParams });
    expect(actualBytes).toBe(planned.sourceBytes);
  });

  it('rejects physically compatible sources with explicitly conflicting acquisition contrast or sequence', async () => {
    const axial = await seedSeries({ seriesUid: 'contrast-axial' });
    const coronal = await seedSeries({ seriesUid: 'contrast-coronal', orientation: 'coronal' });

    await expect(reconstruct([axial, { ...coronal, weight: 'T1' }])).rejects.toThrow(/contrast and sequence/i);
    await expect(
      reconstruct([
        { ...axial, sequence: 'FLAIR' },
        { ...coronal, sequence: 'TSE' },
      ]),
    ).rejects.toThrow(/contrast and sequence/i);
  });

  it('rejects physically nonintersecting focus-region frames before Cornerstone decodes them', async () => {
    const axial = await seedSeries({ seriesUid: 'focused-axial', count: 12 });
    const coronal = await seedSeries({ seriesUid: 'focused-coronal', orientation: 'coronal', count: 12 });
    const progress: SvrProgress[] = [];

    await reconstructVolumeMultiPlane({
      selectedSeries: [axial, coronal],
      svrParams: {
        ...params,
        roi: { mode: 'cube', sourcePlane: 'axial', boundsMm: { min: [-1, -3, 1], max: [3, 0, 2] } },
      },
      onProgress: (value) => progress.push(value),
    });

    const decodedFrames = cornerstone.loadImage.mock.calls.map(([imageId]) => imageId);
    expect(decodedFrames).toEqual([
      'miradb:focused-axial.0',
      'miradb:focused-axial.1',
      'miradb:focused-axial.2',
      'miradb:focused-axial.3',
      'miradb:focused-coronal.0',
      'miradb:focused-coronal.1',
      'miradb:focused-coronal.2',
      'miradb:focused-coronal.3',
      'miradb:focused-coronal.4',
    ]);
    expect(progress.filter((value) => value.phase === 'loading').at(-1)?.current).toBe(35);
  });

  it('retains focus-region source slabs through their declared physical thickness and interpolation margins', async () => {
    const positions = [0, 3, 5, 10];
    const axial = await seedSeries({
      seriesUid: 'thick-axial',
      slicePositionsMm: positions,
      sliceThicknessMm: 4,
    });
    const coronal = await seedSeries({
      seriesUid: 'thick-coronal',
      orientation: 'coronal',
      slicePositionsMm: positions,
      sliceThicknessMm: 4,
    });

    await reconstructVolumeMultiPlane({
      selectedSeries: [axial, coronal],
      svrParams: {
        ...params,
        roi: { mode: 'cube', sourcePlane: 'axial', boundsMm: { min: [0, -1, 0], max: [1, 0, 1] } },
      },
    });

    expect(cornerstone.loadImage.mock.calls.map(([imageId]) => imageId)).toEqual([
      'miradb:thick-axial.0',
      'miradb:thick-axial.1',
      'miradb:thick-coronal.0',
      'miradb:thick-coronal.1',
    ]);
  });

  it('retains translation and rotation candidate evidence before focused rigid registration', async () => {
    const positions = [0, 22, 40, 90];
    const axial = await seedSeries({ seriesUid: 'rigid-margin-axial', slicePositionsMm: positions });
    const coronal = await seedSeries({
      seriesUid: 'rigid-margin-coronal',
      orientation: 'coronal',
      slicePositionsMm: positions,
    });

    const result = await reconstructVolumeMultiPlane({
      selectedSeries: [axial, coronal],
      svrParams: {
        ...params,
        seriesRegistrationMode: 'roi-rigid',
        roi: { mode: 'cube', sourcePlane: 'axial', boundsMm: { min: [0, -1, 0], max: [1, 0, 1] } },
      },
    });

    expect(cornerstone.loadImage.mock.calls.map(([imageId]) => imageId)).toEqual([
      'miradb:rigid-margin-axial.0',
      'miradb:rigid-margin-axial.1',
      'miradb:rigid-margin-axial.2',
      'miradb:rigid-margin-coronal.0',
      'miradb:rigid-margin-coronal.1',
      'miradb:rigid-margin-coronal.2',
    ]);
    expect(result.volume.sourceProvenance!.sources.map((source) => source.frames.length)).toEqual([4, 4]);
    expect(result.volume.sourceProvenance!.sources.map((source) => source.contributingSopInstanceUids)).toEqual([
      ['rigid-margin-axial.0'],
      ['rigid-margin-coronal.0'],
    ]);
  });

  it('rejects a focus region that excludes an entire source orientation before decoding any frame', async () => {
    const axial = await seedSeries({ seriesUid: 'distant-axial', slicePositionsMm: [50, 51] });
    const coronal = await seedSeries({ seriesUid: 'nearby-coronal', orientation: 'coronal' });

    await expect(
      reconstructVolumeMultiPlane({
        selectedSeries: [axial, coronal],
        svrParams: {
          ...params,
          roi: { mode: 'cube', sourcePlane: 'axial', boundsMm: { min: [0, -1, 0], max: [1, 0, 1] } },
        },
      }),
    ).rejects.toThrow(/focus region does not intersect acquired frames from source 1/i);
    expect(cornerstone.loadImage).not.toHaveBeenCalled();
    expect(cornerstone.loadAndCacheImage).not.toHaveBeenCalled();
  });

  it('keeps full source manifests when optional bounds-center registration has unbounded displacement', async () => {
    const positions = [0, 5, 10];
    const axial = await seedSeries({ seriesUid: 'centered-axial', slicePositionsMm: positions });
    const coronal = await seedSeries({
      seriesUid: 'centered-coronal',
      orientation: 'coronal',
      slicePositionsMm: positions,
    });

    await reconstructVolumeMultiPlane({
      selectedSeries: [axial, coronal],
      svrParams: {
        ...params,
        seriesRegistrationMode: 'bounds-center',
        roi: { mode: 'cube', sourcePlane: 'axial', boundsMm: { min: [0, -1, 0], max: [1, 0, 1] } },
      },
    });

    expect(cornerstone.loadImage).toHaveBeenCalledTimes(6);
  });

  it.each([false, true])(
    'never exposes patient, examination, frame, series, or image identifiers through console diagnostics (debug=%s)',
    async (debug) => {
      const privatePatient = 'private-patient-842619';
      const privateStudy = 'private-examination-842619';
      const privateFrame = 'private-frame-842619';
      const privateAxialSeries = 'private-axial-series-842619';
      const privateCoronalSeries = 'private-coronal-series-842619';
      const axial = await seedSeries({
        seriesUid: privateAxialSeries,
        patientId: privatePatient,
        studyUid: privateStudy,
        frameUid: privateFrame,
      });
      const coronal = await seedSeries({
        seriesUid: privateCoronalSeries,
        patientId: privatePatient,
        studyUid: privateStudy,
        frameUid: privateFrame,
        orientation: 'coronal',
      });
      localStorage.setItem('miraviewer:debug-svr', debug ? '1' : '0');
      const diagnosticChannels = (['log', 'info', 'warn', 'error'] as const).map((channel) =>
        vi.spyOn(console, channel).mockImplementation(() => {}),
      );

      await reconstruct([axial, coronal]);

      const diagnosticOutput = JSON.stringify(diagnosticChannels.flatMap((channel) => channel.mock.calls));
      expect(diagnosticOutput.length).toBeGreaterThan(2);
      for (const protectedIdentifier of [
        privatePatient,
        privateStudy,
        privateFrame,
        privateAxialSeries,
        privateCoronalSeries,
        `${privateAxialSeries}.0`,
        `${privateCoronalSeries}.0`,
      ]) {
        expect(diagnosticOutput).not.toContain(protectedIdentifier);
      }
    },
  );

  it('preserves padding-aware support while retaining acquired zero and negative tissue in intensity samples', async () => {
    const axial = await seedSeries({
      seriesUid: 'supported-axial',
      pixels: Int16Array.from([-2000, 0, -3, 100]),
      pixelPaddingValue: -2000,
    });
    const coronal = await seedSeries({
      seriesUid: 'supported-coronal',
      orientation: 'coronal',
      pixels: Int16Array.from([-2000, 0, -3, 100]),
      pixelPaddingValue: -2000,
    });
    let masks: number[][] = [];
    let samples: number[] = [];

    vi.spyOn(computeCore, 'computeSvrFromLoadedSlices').mockImplementation(async (input) => {
      masks = input.allSlices.map((slice) => Array.from(slice.valid ?? []));
      samples = [...input.intensitySamples];
      return syntheticComputeResult('synthetic-acquisition');
    });

    const result = await reconstruct([axial, coronal]);

    expect(masks).toEqual(Array.from({ length: 4 }, () => [0, 255, 255, 255]));
    expect(samples).toHaveLength(12);
    expect(samples).toContain(0);
    expect(samples).toContain(-3);
    expect(samples).toContain(100);
    expect(samples).not.toContain(-2000);
    expect(Array.from(result.volume.observedSupport ?? [])).toEqual([1]);
    expect(result.volume.supportedVoxelCount).toBe(1);
    expect(result.volume.acquiredOrientationCount).toBe(2);
    expect(result.volume.effectiveResolutionMm).toEqual([1, 1, 1]);
    expect(result.volume.sliceProfileSource).toBe('declared');
    expect(result.volume.reconstructionFingerprint).toBe('synthetic-acquisition');
  });

  it('preserves fractional acquired source footprints when a padding-aware image is downsampled', async () => {
    const pixels = Int16Array.from({ length: 16 }, (_, index) => (index === 0 ? -2000 : 100));
    const axial = await seedSeries({
      seriesUid: 'fractional-axial',
      pixels,
      pixelPaddingValue: -2000,
      rows: 4,
      columns: 4,
    });
    const coronal = await seedSeries({
      seriesUid: 'fractional-coronal',
      orientation: 'coronal',
      pixels,
      pixelPaddingValue: -2000,
      rows: 4,
      columns: 4,
    });
    const observed: Array<{ valid: number[]; validScale?: number; pixels: number[] }> = [];

    vi.spyOn(computeCore, 'computeSvrFromLoadedSlices').mockImplementation(async (input) => {
      for (const slice of input.allSlices) {
        observed.push({
          valid: Array.from(slice.valid ?? []),
          validScale: slice.validScale,
          pixels: Array.from(slice.pixels),
        });
      }
      return syntheticComputeResult('synthetic-fractional-acquisition');
    });

    await reconstructVolumeMultiPlane({
      selectedSeries: [axial, coronal],
      svrParams: { ...params, sliceDownsampleMaxSize: 2 },
    });

    expect(observed).toEqual(
      Array.from({ length: 4 }, () => ({
        valid: [191, 255, 255, 255],
        validScale: 255,
        pixels: [100, 100, 100, 100],
      })),
    );
  });

  it('rejects a physically present orientation whose entire source stack contains only declared padding', async () => {
    const axial = await seedSeries({ seriesUid: 'real-evidence' });
    const paddingOnly = await seedSeries({
      seriesUid: 'padding-only',
      orientation: 'coronal',
      pixels: Int16Array.from([-2000, -2000, -2000, -2000]),
      pixelPaddingValue: -2000,
    });

    await expect(reconstruct([axial, paddingOnly])).rejects.toThrow(/no acquired image pixels/i);
  });

  it('transfers acquired-support buffers without free-text series metadata and preserves worker result support', async () => {
    const axial = await seedSeries({ seriesUid: 'worker-axial' });
    const coronal = await seedSeries({ seriesUid: 'worker-coronal', orientation: 'coronal' });
    cornerstone.getCacheInfo.mockReturnValue({
      cacheSizeInBytes: 96 * 1024 * 1024,
      maximumSizeInBytes: 256 * 1024 * 1024,
    });
    const pixels = new Uint8Array(96 * 1024 * 1024);
    cornerstone.cachedImages.push({
      image: { getPixelData: () => pixels },
      loaded: true,
      sizeInBytes: pixels.byteLength,
    });
    let transferred: Transferable[] = [];
    let sourceMasks: Uint8Array[] = [];
    let residentCacheBytes: number | undefined;

    class SyntheticComputeWorker {
      onmessage: ((event: MessageEvent) => void) | null = null;
      onerror: ((event: ErrorEvent) => void) | null = null;

      postMessage(
        message: {
          type: string;
          payload?: { allSlices: Array<{ pixels: Float32Array; valid?: Uint8Array }>; residentCacheBytes?: number };
        },
        transfer?: Transferable[],
      ): void {
        if (message.type !== 'run') return;
        expect(message.payload).not.toHaveProperty('seriesMeta');
        transferred = transfer ?? [];
        sourceMasks = message.payload!.allSlices.map((slice) => slice.valid!);
        residentCacheBytes = message.payload!.residentCacheBytes;
        queueMicrotask(() => {
          this.onmessage?.({
            data: { type: 'done', ...syntheticComputeResult('synthetic-worker-acquisition', 0.75) },
          } as MessageEvent);
        });
      }

      terminate(): void {}
    }

    vi.stubGlobal('Worker', SyntheticComputeWorker);
    const result = await reconstruct([axial, coronal]);

    expect(transferred).toHaveLength(8);
    for (const mask of sourceMasks) {
      expect(transferred).toContain(mask.buffer);
    }
    // Processing frames never enter the cache; their bounded decode batch is gone before this phase.
    expect(residentCacheBytes).toBe(96 * 1024 * 1024);
    expect(Array.from(result.volume.observedSupport ?? [])).toEqual([1]);
    expect(result.volume.supportedVoxelCount).toBe(1);
    expect(result.volume.acquiredOrientationCount).toBe(2);
    expect(result.volume.reconstructionFingerprint).toBe('synthetic-worker-acquisition');
  });

  it('retains the shared conservative decoded-cache reservation when telemetry is missing, invalid, or inaccessible', async () => {
    const axial = await seedSeries({ seriesUid: 'telemetry-axial' });
    const coronal = await seedSeries({ seriesUid: 'telemetry-coronal', orientation: 'coronal' });
    const compute = vi.spyOn(computeCore, 'computeSvrFromLoadedSlices');

    for (const cacheSizeInBytes of [Number.NaN, Number.POSITIVE_INFINITY, -50]) {
      cornerstone.getCacheInfo.mockReturnValue({ cacheSizeInBytes });
      await reconstruct([axial, coronal]);
      expect(compute).toHaveBeenLastCalledWith(expect.objectContaining({ residentCacheBytes: 256 * 1024 * 1024 }));
    }

    cornerstone.getCacheInfo.mockImplementation(() => {
      throw new Error('Native cache telemetry is unavailable');
    });
    await reconstruct([axial, coronal]);
    expect(compute).toHaveBeenLastCalledWith(expect.objectContaining({ residentCacheBytes: 256 * 1024 * 1024 }));
  });

  it('keeps source-decoding progress within its monotonic 5–35% budget', async () => {
    const axial = await seedSeries({ seriesUid: 'progress-axial', count: 3 });
    const coronal = await seedSeries({ seriesUid: 'progress-coronal', count: 3, orientation: 'coronal' });
    const progress: SvrProgress[] = [];

    await reconstruct([axial, coronal], (value) => progress.push(value));

    const loading = progress.filter((value) => value.phase === 'loading');
    expect(loading[0]?.current).toBe(0);
    expect(loading.at(-1)?.current).toBe(35);
    expect(loading.every((value) => value.total === 100 && value.current <= 35)).toBe(true);
    expect(loading.map((value) => value.current)).toEqual(
      loading.map((value) => value.current).sort((left, right) => left - right),
    );
  });

  it('keeps all configured image workers busy while consuming acquired frames in exact physical-manifest order', async () => {
    vi.spyOn(navigator, 'hardwareConcurrency', 'get').mockReturnValue(4);
    const axial = await seedSeries({ seriesUid: 'parallel-axial', count: 8 });
    const coronal = await seedSeries({ seriesUid: 'parallel-coronal', count: 4, orientation: 'coronal' });
    let activeDecodes = 0;
    let maximumActiveDecodes = 0;
    let consumedSourceFrames: string[] = [];

    cornerstone.loadImage.mockImplementation(async (imageId: string) => {
      activeDecodes++;
      maximumActiveDecodes = Math.max(maximumActiveDecodes, activeDecodes);
      const frameIndex = Number(imageId.split('.').at(-1));
      await new Promise((resolve) => setTimeout(resolve, 3 + (3 - (frameIndex % 4)) * 2));
      activeDecodes--;
      return images.get(imageId)!;
    });
    vi.spyOn(computeCore, 'computeSvrFromLoadedSlices').mockImplementation(async (input) => {
      consumedSourceFrames = input.allSlices.map((slice) => slice.sopInstanceUid!);
      return syntheticComputeResult('synthetic-parallel-acquisition');
    });

    await reconstruct([axial, coronal]);

    expect(maximumActiveDecodes).toBe(4);
    expect(consumedSourceFrames).toEqual([
      ...Array.from({ length: 8 }, (_, index) => `parallel-axial.${index}`),
      ...Array.from({ length: 4 }, (_, index) => `parallel-coronal.${index}`),
    ]);
    expect(cornerstone.loadImage.mock.calls.map(([imageId]) => imageId)).toEqual(
      consumedSourceFrames.map((sopInstanceUid) => `miradb:${sopInstanceUid}`),
    );
  });

  it('never schedules more image decodes after cancellation of a bounded in-flight worker batch', async () => {
    vi.spyOn(navigator, 'hardwareConcurrency', 'get').mockReturnValue(4);
    const axial = await seedSeries({ seriesUid: 'cancel-prefetch-axial', count: 8 });
    const coronal = await seedSeries({ seriesUid: 'cancel-prefetch-coronal', count: 4, orientation: 'coronal' });
    const releaseDecodes: Array<() => void> = [];
    const controller = new AbortController();

    cornerstone.loadImage.mockImplementation(
      (imageId: string) =>
        new Promise((resolve) => {
          releaseDecodes.push(() => resolve(images.get(imageId)!));
        }),
    );

    const reconstruction = reconstructVolumeMultiPlane({
      selectedSeries: [axial, coronal],
      svrParams: params,
      signal: controller.signal,
    });

    await vi.waitFor(() => {
      expect(cornerstone.loadImage).toHaveBeenCalledTimes(4);
    });

    controller.abort();
    for (const release of releaseDecodes) release();

    await expect(reconstruction).rejects.toThrow(/cancelled/i);
    expect(cornerstone.loadImage).toHaveBeenCalledTimes(4);
    expect(cornerstone.loadAndCacheImage).not.toHaveBeenCalled();
  });

  it('rejects a dataset revision that changes while admitted source frames are decoding', async () => {
    const axial = await seedSeries({ seriesUid: 'mutated-axial' });
    const coronal = await seedSeries({ seriesUid: 'mutated-coronal', orientation: 'coronal' });
    let changed = false;
    cornerstone.loadImage.mockImplementation(async (imageId: string) => {
      if (!changed) {
        changed = true;
        await (await getDB()).put('app_state', { key: DATASET_REVISION_STATE_KEY, value: 1 });
      }
      return images.get(imageId)!;
    });

    await expect(reconstruct([axial, coronal])).rejects.toThrow(/MRI data changed during SVR decoding/i);
  });

  it('rejects a patient-selection change while an earlier patient reconstruction is decoding', async () => {
    const axial = await seedSeries({ seriesUid: 'switched-patient-axial' });
    const coronal = await seedSeries({ seriesUid: 'switched-patient-coronal', orientation: 'coronal' });
    await setSelectedPatientKey('patient-one');
    let changed = false;
    cornerstone.loadImage.mockImplementation(async (imageId: string) => {
      if (!changed) {
        changed = true;
        await setSelectedPatientKey('patient-two');
      }
      return images.get(imageId)!;
    });

    await expect(reconstruct([axial, coronal])).rejects.toThrow(/selected patient changed during SVR decoding/i);
  });
});
