import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_SVR_PARAMS, type SvrRoi, type SvrSelectedSeries, type SvrVolume } from '../src/types/svr';
import type { SeriesFrameManifest } from '../src/utils/localApi';
import { getSliceGeometryFromInstance } from '../src/utils/svr/dicomGeometry';
import { assembleNativeVolume, planNativeVolume, retainedSvrVolumeBytes } from '../src/utils/svr/nativeVolume';
import { createNativeSourceContext } from '../src/utils/svr/nativeSourceContext';
import { reconstructVolumeMultiPlane } from '../src/utils/svr/reconstructVolume';
import { MAX_SR_OUTPUT_VOXELS } from '../src/utils/svr/superResolutionTypes';
import { SVR_MEMORY_BUDGET_BYTES } from '../src/utils/svr/svrMemoryPlan';
import { patientToVolumeVoxel, physicalVolumeBounds, volumeVoxelToPatient } from '../src/utils/svr/volumeGeometry';

const sourceReads = vi.hoisted(() => ({ load: vi.fn(), populate: vi.fn(), revision: vi.fn(), patient: vi.fn() }));
vi.mock('cornerstone-core', () => ({
  default: { loadImage: sourceReads.load, loadAndCacheImage: sourceReads.populate },
}));
vi.mock('../src/utils/localApi', () => ({
  getDatasetRevision: sourceReads.revision,
  getSelectedPatientKey: sourceReads.patient,
  getImageIdForInstance: vi.fn(),
}));
vi.mock('../src/utils/svr/reconstructVolume', () => ({ reconstructVolumeMultiPlane: vi.fn() }));
const reconstruct = vi.mocked(reconstructVolumeMultiPlane);
beforeEach(() => {
  reconstruct.mockReset();
  sourceReads.load.mockReset();
  sourceReads.populate.mockReset();
  sourceReads.revision.mockReset().mockResolvedValue(7);
  sourceReads.patient.mockReset().mockResolvedValue('patient');
});

/** Synthetic acquired samples only; the accepted display can be a crop or an overview of this source. */
function fixture(sagittal = false, overview = false, size = 16) {
  const nativeSource: SeriesFrameManifest = {
    seriesUid: 'native',
    studyUid: 'study',
    patientKey: 'patient',
    frameOfReferenceUid: 'frame',
    ordering: 'physical',
    geometryReliable: true,
    frames: Array.from({ length: size }, (_, index) => ({
      sopInstanceUid: `native-${index}`,
      seriesInstanceUid: 'native',
      studyInstanceUid: 'study',
      frameOfReferenceUid: 'frame',
      instanceNumber: index + 1,
      rows: size,
      columns: size,
      imageOrientationPatient: sagittal ? '0\\-1\\0\\0\\0\\-1' : '1\\0\\0\\0\\1\\0',
      imagePositionPatient: sagittal ? `${index * 2.5}\\0\\0` : `0\\0\\${index * 2.5}`,
      pixelSpacing: '1.2\\0.8',
      spacingBetweenSlices: 2.5,
      sliceThickness: 2.5,
    })),
  };
  const angle = sagittal ? 0.31 : 0;
  const transform = {
    rotation: [Math.cos(angle), -Math.sin(angle), 0, Math.sin(angle), Math.cos(angle), 0, 0, 0, 1] as const,
    translationMm: [40, -10, 7] as const,
  };
  const full = planNativeVolume(nativeSource, {}, { decodedCacheBytes: 0, nativePlaneBytes: 0, transform });
  const geometry = {
    dims: [3, 4, 2] as [number, number, number],
    voxelSizeMm: full.voxelSizeMm.map((spacing) => spacing * (overview ? 2 : 1)) as [number, number, number],
    originMm: volumeVoxelToPatient(full, [3, 2, 1]),
    direction: full.direction,
  };
  const volume: SvrVolume = {
    ...geometry,
    boundsMm: physicalVolumeBounds(geometry),
    data: Float32Array.from({ length: 24 }, (_, index) => index - 17),
    observedSupport: new Uint8Array(24).fill(1),
    nativeVoxelSizeMm: full.nativeVoxelSizeMm,
    sourceProvenance: {
      mode: 'native-3d',
      datasetRevision: 7,
      patientKey: 'patient',
      studyUid: 'study',
      frameOfReferenceUid: 'frame',
      fingerprint: 'synthetic-source',
      primarySeriesUid: 'native',
      explanation: 'Synthetic original source',
      sources: [
        {
          seriesUid: 'native',
          label: 'Original',
          kind: 'original-3d',
          transform,
          contributingSopInstanceUids: [],
          frames: nativeSource.frames.map((frame) => {
            const g = getSliceGeometryFromInstance(frame);
            return {
              sopInstanceUid: frame.sopInstanceUid,
              rows: frame.rows,
              columns: frame.columns,
              originMm: [g.ippMm.x, g.ippMm.y, g.ippMm.z] as const,
              columnDirection: [g.rowDir.x, g.rowDir.y, g.rowDir.z] as const,
              rowDirection: [g.colDir.x, g.colDir.y, g.colDir.z] as const,
              pixelSpacingMm: [g.rowSpacingMm, g.colSpacingMm] as const,
            };
          }),
        },
      ],
    },
  };
  const selectedSeries: SvrSelectedSeries[] = [
    {
      seriesUid: 'native',
      studyId: 'study',
      dateIso: 'synthetic-exam',
      instanceCount: size,
      label: 'Original',
    },
  ];
  const roi: SvrRoi = { mode: 'box', sourcePlane: 'axial', sourceSeriesUid: 'native', boundsMm: volume.boundsMm };
  const options = {
    volume,
    nativeSource,
    selectedSeries,
    parameters: { ...DEFAULT_SVR_PARAMS },
    retainedBytes: retainedSvrVolumeBytes(volume) + 1234,
    decodedCacheBytes: 0,
    nativePlaneBytes: 4096,
  };
  return { options, volume, nativeSource, full, transform, roi };
}

function sourceImages(f: ReturnType<typeof fixture>) {
  const pixels = f.nativeSource.frames.map((frame, z) => new Float32Array(frame.rows * frame.columns).fill(z));
  const images = f.nativeSource.frames.map((frame, index) => ({
    rows: frame.rows,
    columns: frame.columns,
    slope: 1,
    intercept: 0,
    pixelPaddingValue: -2000,
    pixelPaddingRangeLimit: -1998,
    windowCenter: 1e4,
    windowWidth: 1,
    invert: true,
    getPixelData: () => pixels[index]!,
  }));
  sourceReads.load.mockImplementation(async (imageId: string) => {
    const index = f.nativeSource.frames.findIndex((frame) => imageId === `miradb:${frame.sopInstanceUid}`);
    if (index < 0) throw new Error('Unexpected source identity');
    return images[index]!;
  });
  return { pixels, images };
}

describe('accepted native source context', () => {
  it.each([
    [false, false],
    [true, false],
    [false, true],
    [true, true],
  ])(
    'plans the complete physical source without decoding from sagittal=%s overview=%s display',
    (sagittal, overview) => {
      const f = fixture(sagittal, overview);
      const context = createNativeSourceContext(f.options);
      expect(context.grid.dims).toEqual(f.full.dims);
      expect(context.grid.voxelSizeMm).toEqual(f.full.nativeVoxelSizeMm);
      expect(context.grid.direction).toEqual(f.full.direction);
      context.grid.originMm.forEach((value, axis) => expect(value).toBeCloseTo(f.full.originMm[axis]!, 10));
      const plan = context.plan(f.roi);
      expect(plan).toEqual(planNativeVolume(f.nativeSource, { roi: f.roi }, { ...f.options, transform: f.transform }));
      expect(plan.sourceStrides).toEqual([1, 1, 1]);
      expect(plan.overview).toBe(false);
      expect(plan.voxelSizeMm).toEqual(f.full.nativeVoxelSizeMm);
      expect(plan.dims).not.toEqual(f.volume.dims);
      expect(reconstruct).not.toHaveBeenCalled();
    },
  );

  it('does not inherit enhancement context width or its eight-times-output admission limit', () => {
    const f = fixture(false, false, 129);
    const context = createNativeSourceContext(f.options);
    const roi = { ...f.roi, boundsMm: f.full.boundsMm };
    const plan = context.plan(roi);
    expect(plan.dims).toEqual([129, 129, 129]);
    expect(plan.dims.reduce((count, size) => count * size, 1) * 8).toBeGreaterThan(MAX_SR_OUTPUT_VOXELS);
    expect(plan.totalBytes).toBeLessThan(SVR_MEMORY_BUDGET_BYTES);
    expect(context.plan(f.roi).dims.every((size) => size < 32)).toBe(true);
    expect(reconstruct).not.toHaveBeenCalled();
  });

  it('loads exact signed samples/support into owned buffers through the existing native assembler', async () => {
    const f = fixture();
    const before = f.volume.data.slice();
    const sourceFrames = f.nativeSource.frames.map((frame, z) =>
      Int16Array.from({ length: frame.rows * frame.columns }, (_, index) =>
        z === 4 && index === 6 * frame.columns + 5
          ? -32768
          : z * 1000 + Math.floor(index / frame.columns) * 10 + (index % frame.columns) - 2000,
      ),
    );
    const sourceBefore = sourceFrames.map((pixels) => pixels.slice());
    const readFrame = vi.fn(async (frame: SeriesFrameManifest['frames'][number]) => ({
      pixels: sourceFrames[frame.instanceNumber - 1]!,
      pixelPaddingValue: -32768,
    }));
    reconstruct.mockImplementation(async (request) => ({
      volume: await assembleNativeVolume(
        planNativeVolume(f.nativeSource, request.svrParams, { ...f.options, transform: f.transform }),
        readFrame,
        { signal: request.signal },
      ),
    }));
    const context = createNativeSourceContext(f.options);
    const roi = { ...f.roi, boundsMm: f.full.boundsMm };
    const signal = new AbortController().signal;
    const onProgress = vi.fn();
    const loaded = await context.load(roi, { signal, onProgress });
    expect(reconstruct).toHaveBeenCalledOnce();
    expect(reconstruct.mock.calls[0]![0]).toMatchObject({
      selectedSeries: f.options.selectedSeries,
      svrParams: { ...f.options.parameters, roi },
      retainedBytes: f.options.retainedBytes,
      signal,
      onProgress,
    });
    expect(reconstruct.mock.calls[0]![0].acceptedProvenance).toBe(f.volume.sourceProvenance);
    expect(readFrame).toHaveBeenCalledTimes(f.nativeSource.frames.length);
    expect(loaded.dims).toEqual(f.full.dims);
    const local = patientToVolumeVoxel(loaded, volumeVoxelToPatient(f.full, [5, 6, 4])).map(Math.round);
    const at = (local[2]! * loaded.dims[1] + local[1]!) * loaded.dims[0] + local[0]!;
    expect(loaded.data[at]).toBe(0);
    expect(loaded.observedSupport![at]).toBe(0);
    expect(loaded.data[at + 1]).toBe(2066);
    expect(loaded.data[0]).toBe(-2000);
    expect(loaded.data.buffer).not.toBe(f.volume.data.buffer);
    expect(loaded.observedSupport!.buffer).not.toBe(f.volume.observedSupport!.buffer);
    for (const source of sourceFrames) expect(loaded.data.buffer).not.toBe(source.buffer);
    expect(sourceFrames).toEqual(sourceBefore);
    expect(f.volume.data).toEqual(before);
  });

  it('leaves live source-phase admission to the assembler even when cache residency changes after planning', async () => {
    const f = fixture();
    const context = createNativeSourceContext(f.options);
    expect(context.plan(f.roi).totalBytes).toBeLessThan(SVR_MEMORY_BUDGET_BYTES);
    const readFrame = vi.fn(async () => ({ pixels: new Int16Array() }));
    reconstruct.mockImplementation(async (request) => ({
      volume: await assembleNativeVolume(
        planNativeVolume(f.nativeSource, request.svrParams, {
          ...f.options,
          transform: f.transform,
          decodedCacheBytes: SVR_MEMORY_BUDGET_BYTES,
        }),
        readFrame,
      ),
    }));
    await expect(context.load(f.roi)).rejects.toThrow(/memory budget/);
    expect(readFrame).not.toHaveBeenCalled();
    expect(reconstruct.mock.calls[0]![0].retainedBytes).toBe(f.options.retainedBytes);
  });

  it.each(['primary', 'patient', 'study', 'frame', 'sop', 'position', 'orientation', 'spacing', 'rows', 'columns'])(
    'rejects changed %s metadata against the accepted source before any decoding',
    (kind) => {
      const f = fixture();
      const source = f.nativeSource,
        frame = source.frames[0]!;
      if (kind === 'primary') f.volume.sourceProvenance!.primarySeriesUid = 'other';
      if (kind === 'patient') source.patientKey = 'other';
      if (kind === 'study') source.studyUid = 'other';
      if (kind === 'frame') source.frameOfReferenceUid = 'other';
      if (kind === 'sop') frame.sopInstanceUid = 'other';
      if (kind === 'position') frame.imagePositionPatient = '0.01\\0\\0';
      if (kind === 'orientation') frame.imageOrientationPatient = '0\\1\\0\\-1\\0\\0';
      if (kind === 'spacing') frame.pixelSpacing = '1.3\\0.8';
      if (kind === 'rows') frame.rows++;
      if (kind === 'columns') frame.columns++;
      expect(() => createNativeSourceContext(f.options)).toThrow(/no longer matches/);
      expect(reconstruct).not.toHaveBeenCalled();
    },
  );

  it.each(['metadata', 'pose', 'owner'])('rejects %s changes between planning and loading', async (kind) => {
    const f = fixture();
    const context = createNativeSourceContext(f.options);
    context.plan(f.roi);
    if (kind === 'metadata') f.nativeSource.frames[0]!.sliceThickness = 3;
    if (kind === 'pose')
      f.volume.sourceProvenance!.sources[0]!.transform = { ...f.transform, translationMm: [41, -10, 7] };
    if (kind === 'owner') f.volume.sourceProvenance = { ...f.volume.sourceProvenance! };
    expect(() => context.plan(f.roi)).toThrow(/source changed/);
    await expect(context.load(f.roi)).rejects.toThrow(/source changed/);
    expect(reconstruct).not.toHaveBeenCalled();
  });

  it.each(['cancel', 'metadata'])(
    'does not return a source when %s changes during its asynchronous load',
    async (kind) => {
      const f = fixture();
      const context = createNativeSourceContext(f.options);
      const controller = new AbortController();
      let finish!: (value: Awaited<ReturnType<typeof reconstructVolumeMultiPlane>>) => void;
      reconstruct.mockImplementation(
        () =>
          new Promise((resolve) => {
            finish = resolve;
          }),
      );
      const pending = context.load(f.roi, { signal: controller.signal });
      const rejected = expect(pending).rejects.toThrow(kind === 'cancel' ? /SVR cancelled/ : /source changed/);
      if (kind === 'cancel') controller.abort();
      else f.nativeSource.frames[0]!.pixelPaddingValue = -1;
      finish({ volume: f.volume });
      await rejected;
    },
  );

  it('pins caller ROI, settings and series while preserving the assembler source-identity error', async () => {
    const f = fixture();
    const context = createNativeSourceContext(f.options);
    f.options.parameters.iterations = 17;
    f.options.selectedSeries[0]!.seriesUid = 'other';
    reconstruct.mockRejectedValue(new Error('Source examination changed during loading'));
    const pending = context.load(f.roi);
    const requestedRoi = reconstruct.mock.calls[0]![0].svrParams.roi!;
    const before = structuredClone(requestedRoi);
    f.roi.boundsMm.min[0] = -999;
    expect(requestedRoi).toEqual(before);
    expect(reconstruct.mock.calls[0]![0].svrParams.iterations).toBe(DEFAULT_SVR_PARAMS.iterations);
    expect(reconstruct.mock.calls[0]![0].selectedSeries[0]!.seriesUid).toBe('native');
    await expect(pending).rejects.toThrow(/Source examination changed/);
  });

  it('requires an explicit exact region and does not start already-canceled work', async () => {
    const f = fixture();
    const context = createNativeSourceContext(f.options);
    expect(() => context.plan(undefined as unknown as SvrRoi)).toThrow(/explicit patient-space region/);
    await expect(context.load(undefined as unknown as SvrRoi)).rejects.toThrow(/explicit patient-space region/);
    const controller = new AbortController();
    controller.abort();
    await expect(context.load(f.roi, { signal: controller.signal })).rejects.toThrow(/SVR cancelled/);
    expect(reconstruct).not.toHaveBeenCalled();
  });

  it.each([false, true])(
    'scans every full native frame, including extremes outside the accepted crop, with overview=%s',
    async (overview) => {
      const f = fixture(false, overview);
      const { pixels, images } = sourceImages(f);
      pixels[0]!.set([-2000, -1999, -1998, NaN, Infinity, -Infinity, -7, 0]);
      pixels.at(-1)![pixels[0]!.length - 1] = 41;
      for (const image of images) {
        image.slope = 2;
        image.intercept = -3;
      }
      const before = pixels.map((values) => values.slice());
      const volumeBefore = f.volume.data.slice();
      f.volume.intensityRange = [500, 600];
      f.volume.displayWindow = [700, 800];
      const context = createNativeSourceContext(f.options);
      expect(context.plan(f.roi).cropMin.some((offset) => offset > 0)).toBe(true);
      const onProgress = vi.fn();
      await expect(context.intensityRange({ onProgress })).resolves.toEqual([-17, 79]);
      expect(sourceReads.load.mock.calls).toEqual(
        f.nativeSource.frames.map((frame) => [`miradb:${frame.sopInstanceUid}`]),
      );
      expect(sourceReads.populate).not.toHaveBeenCalled();
      expect(reconstruct).not.toHaveBeenCalled();
      expect(onProgress).toHaveBeenCalledTimes(f.nativeSource.frames.length);
      expect(onProgress).toHaveBeenLastCalledWith(expect.objectContaining({ current: 16, total: 16 }));
      expect(pixels).toEqual(before);
      expect(f.volume.data).toEqual(volumeBefore);
      expect(f.volume.intensityRange).toEqual([500, 600]);
      expect(f.volume.displayWindow).toEqual([700, 800]);
    },
  );

  it('retains valid zero and signed modality values, including a negative slope, without display inversion', async () => {
    const f = fixture();
    const { pixels, images } = sourceImages(f);
    for (const values of pixels) values.fill(0);
    pixels[0]![0] = -4;
    pixels.at(-1)![0] = 3;
    for (const image of images) {
      image.slope = -2;
      image.intercept = 100;
    }
    await expect(createNativeSourceContext(f.options).intensityRange()).resolves.toEqual([94, 108]);
  });

  it('retains only a completed scalar range and returns independent copies without another decode', async () => {
    const f = fixture();
    sourceImages(f);
    const context = createNativeSourceContext(f.options);
    const first = await context.intensityRange();
    first[0] = -999;
    f.volume.displayWindow = [1e4, 2e4];
    const second = await context.intensityRange();
    expect(second).toEqual([0, 15]);
    expect(second).not.toBe(first);
    second[1] = -999;
    await expect(context.intensityRange()).resolves.toEqual([0, 15]);
    expect(sourceReads.load).toHaveBeenCalledTimes(16);
    expect(sourceReads.revision).toHaveBeenCalledTimes(4);
  });

  it.each(['constant', 'padding', 'nonfinite'] as const)(
    'rejects %s-only acquisitions without caching a fabricated normalization range',
    async (kind) => {
      const f = fixture();
      const { pixels } = sourceImages(f);
      for (const values of pixels) values.fill(kind === 'constant' ? 9 : kind === 'padding' ? -1999 : NaN);
      const context = createNativeSourceContext(f.options);
      await expect(context.intensityRange()).rejects.toThrow(
        kind === 'constant' ? /no intensity variation/ : /no finite acquired intensities/,
      );
      await expect(context.intensityRange()).rejects.toThrow();
      expect(sourceReads.load).toHaveBeenCalledTimes(32);
    },
  );

  it('does not retain a partial range or failed decode and retries through the complete acquisition', async () => {
    const f = fixture();
    const { images } = sourceImages(f);
    sourceReads.load.mockResolvedValueOnce(images[0]).mockRejectedValueOnce(new Error('Synthetic decode failed'));
    const context = createNativeSourceContext(f.options);
    await expect(context.intensityRange()).rejects.toThrow('Synthetic decode failed');
    expect(sourceReads.load).toHaveBeenCalledTimes(2);
    await expect(context.intensityRange()).resolves.toEqual([0, 15]);
    expect(sourceReads.load).toHaveBeenCalledTimes(18);
  });

  it.each(['resolve', 'reject'] as const)(
    'cancels a stalled decode before its late %s without caching it',
    async (outcome) => {
      const f = fixture();
      const { images } = sourceImages(f);
      let finish!: (image: (typeof images)[number]) => void;
      let fail!: (error: Error) => void;
      let started!: () => void;
      const decoding = new Promise<void>((resolve) => {
        started = resolve;
      });
      sourceReads.load.mockResolvedValueOnce(images[0]).mockImplementationOnce(() => {
        started();
        return new Promise((resolve, reject) => {
          finish = resolve;
          fail = reject;
        });
      });
      const context = createNativeSourceContext(f.options);
      const controller = new AbortController();
      const result = context.intensityRange({ signal: controller.signal });
      const rejected = expect(result).rejects.toMatchObject({ name: 'AbortError' });
      await decoding;
      controller.abort();
      await rejected;
      if (outcome === 'resolve') finish(images[1]!);
      else fail(new Error('Late decoder failure'));
      await expect(context.intensityRange()).resolves.toEqual([0, 15]);
      expect(sourceReads.load).toHaveBeenCalledTimes(18);
    },
  );

  it.each(['before', 'last-frame', 'cached'] as const)('does not return a range when canceled %s', async (when) => {
    const f = fixture();
    sourceImages(f);
    const context = createNativeSourceContext(f.options);
    if (when === 'cached') await context.intensityRange();
    const controller = new AbortController();
    if (when !== 'last-frame') controller.abort();
    await expect(
      context.intensityRange({
        signal: controller.signal,
        onProgress: ({ current, total }) => {
          if (current === total) controller.abort();
        },
      }),
    ).rejects.toThrow(/cancelled/);
    expect(sourceReads.load).toHaveBeenCalledTimes(when === 'before' ? 0 : 16);
    await expect(context.intensityRange()).resolves.toEqual([0, 15]);
    expect(sourceReads.load).toHaveBeenCalledTimes(when === 'last-frame' ? 32 : 16);
  });

  it.each(['before', 'during', 'cached'] as const)(
    'checks source metadata and live dataset/patient identity %s a range scan',
    async (when) => {
      for (const kind of ['metadata', 'owner', 'revision', 'patient'] as const) {
        const f = fixture();
        sourceImages(f);
        sourceReads.revision.mockResolvedValue(7);
        sourceReads.patient.mockResolvedValue('patient');
        const context = createNativeSourceContext(f.options);
        if (when === 'cached') await context.intensityRange();
        const change = () => {
          if (kind === 'metadata') f.nativeSource.frames[0]!.pixelPaddingValue = -17;
          if (kind === 'owner') f.volume.sourceProvenance = { ...f.volume.sourceProvenance! };
          if (kind === 'revision') sourceReads.revision.mockResolvedValue(8);
          if (kind === 'patient') sourceReads.patient.mockResolvedValue(null);
        };
        if (when !== 'during') {
          change();
          if (kind === 'patient') sourceReads.patient.mockResolvedValue('other');
        }
        const calls = sourceReads.load.mock.calls.length;
        await expect(
          context.intensityRange({
            onProgress: ({ current }) => {
              if (when === 'during' && current === 1) change();
            },
          }),
        ).rejects.toThrow(/changed/);
        if (when !== 'during') expect(sourceReads.load).toHaveBeenCalledTimes(calls);
      }
    },
  );

  it('rejects a decoded source whose dimensions differ from the accepted native frame', async () => {
    const f = fixture();
    const { images } = sourceImages(f);
    images[0]!.rows--;
    await expect(createNativeSourceContext(f.options).intensityRange()).rejects.toThrow(/frame changed/);
    expect(sourceReads.load).toHaveBeenCalledOnce();
  });
});
