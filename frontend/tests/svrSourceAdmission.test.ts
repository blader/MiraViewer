import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DATASET_REVISION_STATE_KEY, deleteAllStoredMriData, getDB } from '../src/db/db';
import type { DicomInstance } from '../src/db/schema';
import { DEFAULT_SVR_PARAMS, type SvrProgress, type SvrSelectedSeries } from '../src/types/svr';
import { setSelectedPatientKey } from '../src/utils/localApi';
import * as computeCore from '../src/utils/svr/svrComputeCore';

const cornerstone = vi.hoisted(() => ({
  loadAndCacheImage: vi.fn(),
  loadImage: vi.fn(),
  getCacheInfo: vi.fn((): { cacheSizeInBytes?: number } => ({})),
}));

vi.mock('cornerstone-core', () => ({
  default: {
    loadAndCacheImage: cornerstone.loadAndCacheImage,
    loadImage: cornerstone.loadImage,
    imageCache: { getCacheInfo: cornerstone.getCacheInfo },
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
};

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
      imagePositionPatient: coronal ? `0\\${-slicePositionMm}\\0` : `0\\0\\${slicePositionMm}`,
      imageOrientationPatient: coronal ? '1\\0\\0\\0\\0\\1' : '1\\0\\0\\0\\1\\0',
      pixelSpacing: '1\\1',
      sliceThickness: options.sliceThicknessMm ?? 1,
      spacingBetweenSlices: 1,
      pixelPaddingValue: options.pixelPaddingValue,
      fileBlob: new Blob(),
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

describe('SVR canonical source admission and acquired support', () => {
  beforeEach(() => {
    images.clear();
    localStorage.setItem('miraviewer:debug-svr', '0');
    cornerstone.getCacheInfo.mockReset();
    cornerstone.getCacheInfo.mockReturnValue({});
    cornerstone.loadAndCacheImage.mockImplementation(async (imageId: string) => {
      const image = images.get(imageId);
      if (!image) throw new Error('Synthetic source frame disappeared');
      return image;
    });
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
    expect(cornerstone.loadAndCacheImage).not.toHaveBeenCalled();
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

  it('derives independent acquisition orientations from patient-space geometry, not display labels', async () => {
    const axial = await seedSeries({ seriesUid: 'first-axial' });
    const anotherAxial = await seedSeries({ seriesUid: 'second-axial' });

    await expect(reconstruct([axial, { ...anotherAxial, plane: 'Coronal', label: 'Coronal' }])).rejects.toThrow(
      /physically independent acquisition orientations/i,
    );
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

    const decodedFrames = cornerstone.loadAndCacheImage.mock.calls.map(([imageId]) => imageId);
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

    expect(cornerstone.loadAndCacheImage.mock.calls.map(([imageId]) => imageId)).toEqual([
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

    await reconstructVolumeMultiPlane({
      selectedSeries: [axial, coronal],
      svrParams: {
        ...params,
        seriesRegistrationMode: 'roi-rigid',
        roi: { mode: 'cube', sourcePlane: 'axial', boundsMm: { min: [0, -1, 0], max: [1, 0, 1] } },
      },
    });

    expect(cornerstone.loadAndCacheImage.mock.calls.map(([imageId]) => imageId)).toEqual([
      'miradb:rigid-margin-axial.0',
      'miradb:rigid-margin-axial.1',
      'miradb:rigid-margin-axial.2',
      'miradb:rigid-margin-coronal.0',
      'miradb:rigid-margin-coronal.1',
      'miradb:rigid-margin-coronal.2',
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

    expect(cornerstone.loadAndCacheImage).toHaveBeenCalledTimes(6);
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
      return {
        volume: new Float32Array([1]),
        observedSupport: new Uint8Array([1]),
        supportedVoxelCount: 1,
        acquiredOrientationCount: 2,
        effectiveResolutionMm: [1, 1, 1],
        sliceProfileSource: 'declared',
        reconstructionFingerprint: 'synthetic-acquisition',
        dims: { nx: 1, ny: 1, nz: 1 },
        originMm: { x: 0, y: 0, z: 0 },
        voxelSizeMm: 1,
        bounds: { min: { x: 0, y: 0, z: 0 }, max: { x: 1, y: 1, z: 1 } },
      };
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
      return {
        volume: new Float32Array([1]),
        observedSupport: new Uint8Array([1]),
        supportedVoxelCount: 1,
        acquiredOrientationCount: 2,
        effectiveResolutionMm: [1, 1, 1],
        sliceProfileSource: 'declared',
        reconstructionFingerprint: 'synthetic-fractional-acquisition',
        dims: { nx: 1, ny: 1, nz: 1 },
        originMm: { x: 0, y: 0, z: 0 },
        voxelSizeMm: 1,
        bounds: { min: { x: 0, y: 0, z: 0 }, max: { x: 1, y: 1, z: 1 } },
      };
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

  it('transfers acquired-support buffers alongside pixel buffers and preserves worker result support', async () => {
    const axial = await seedSeries({ seriesUid: 'worker-axial' });
    const coronal = await seedSeries({ seriesUid: 'worker-coronal', orientation: 'coronal' });
    cornerstone.getCacheInfo.mockReturnValue({ cacheSizeInBytes: 96 * 1024 * 1024 });
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
        transferred = transfer ?? [];
        sourceMasks = message.payload!.allSlices.map((slice) => slice.valid!);
        residentCacheBytes = message.payload!.residentCacheBytes;
        queueMicrotask(() => {
          this.onmessage?.({
            data: {
              type: 'done',
              volume: new Float32Array([0.75]),
              observedSupport: new Uint8Array([1]),
              supportedVoxelCount: 1,
              acquiredOrientationCount: 2,
              effectiveResolutionMm: [1, 1, 1],
              sliceProfileSource: 'declared',
              reconstructionFingerprint: 'synthetic-worker-acquisition',
              dims: { nx: 1, ny: 1, nz: 1 },
              originMm: { x: 0, y: 0, z: 0 },
              voxelSizeMm: 1,
              bounds: { min: { x: 0, y: 0, z: 0 }, max: { x: 1, y: 1, z: 1 } },
            },
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
    expect(residentCacheBytes).toBe(96 * 1024 * 1024);
    expect(Array.from(result.volume.observedSupport ?? [])).toEqual([1]);
    expect(result.volume.supportedVoxelCount).toBe(1);
    expect(result.volume.acquiredOrientationCount).toBe(2);
    expect(result.volume.reconstructionFingerprint).toBe('synthetic-worker-acquisition');
  });

  it('safely treats missing, invalid, or inaccessible native cache telemetry as zero resident bytes', async () => {
    const axial = await seedSeries({ seriesUid: 'telemetry-axial' });
    const coronal = await seedSeries({ seriesUid: 'telemetry-coronal', orientation: 'coronal' });
    const compute = vi.spyOn(computeCore, 'computeSvrFromLoadedSlices');

    for (const cacheSizeInBytes of [Number.NaN, Number.POSITIVE_INFINITY, -50]) {
      cornerstone.getCacheInfo.mockReturnValue({ cacheSizeInBytes });
      await reconstruct([axial, coronal]);
      expect(compute).toHaveBeenLastCalledWith(expect.objectContaining({ residentCacheBytes: 0 }));
    }

    cornerstone.getCacheInfo.mockImplementation(() => {
      throw new Error('Native cache telemetry is unavailable');
    });
    await reconstruct([axial, coronal]);
    expect(compute).toHaveBeenLastCalledWith(expect.objectContaining({ residentCacheBytes: 0 }));
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

  it('rejects a dataset revision that changes while admitted source frames are decoding', async () => {
    const axial = await seedSeries({ seriesUid: 'mutated-axial' });
    const coronal = await seedSeries({ seriesUid: 'mutated-coronal', orientation: 'coronal' });
    let changed = false;
    cornerstone.loadAndCacheImage.mockImplementation(async (imageId: string) => {
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
    cornerstone.loadAndCacheImage.mockImplementation(async (imageId: string) => {
      if (!changed) {
        changed = true;
        await setSelectedPatientKey('patient-two');
      }
      return images.get(imageId)!;
    });

    await expect(reconstruct([axial, coronal])).rejects.toThrow(/selected patient changed during SVR decoding/i);
  });
});
