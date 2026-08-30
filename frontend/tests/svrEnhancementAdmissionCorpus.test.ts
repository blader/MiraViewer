import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { SvrLabelVolume, SvrVolume } from '../src/types/svr';
import { measureCornerstoneImageMemory } from '../src/utils/cornerstoneMemory';
import { buildOutputPlaneGrid, outputGridPixelToWorld } from '../src/utils/outputPlaneGrid';
import { SELECTION_LABEL_META } from '../src/utils/segmentation/selectionEditing';
import { getSliceGeometryFromInstance } from '../src/utils/svr/dicomGeometry';
import {
  assembleNativeVolume,
  nativePlaneMemoryBytes,
  planNativeVolume,
  retainedSvrVolumeBytes,
} from '../src/utils/svr/nativeVolume';
import { enhanceVolume2x } from '../src/utils/svr/superResolution';
import {
  assertEnhancementFits,
  enhancementSelectionRoi,
  enhancementWorkingBytes,
  prepareEnhancementMemory,
} from '../src/utils/svr/superResolutionRegion';
import { MAX_SR_OUTPUT_VOXELS, MIN_SR_CONTEXT_DIM } from '../src/utils/svr/superResolutionTypes';
import { SVR_MEMORY_BUDGET_BYTES } from '../src/utils/svr/svrMemoryPlan';
import {
  IDENTITY_PATIENT_TRANSFORM,
  patientToVolumeVoxel,
  volumeVoxelToPatient,
} from '../src/utils/svr/volumeGeometry';
import {
  alignmentCorpusManifest,
  decodeAlignmentCorpusFrame,
  inspectAlignmentCorpus,
  loadAlignmentLosslessCodec,
} from './helpers/alignmentRealCorpus';

const corpusRoot = process.env.MIRAVIEWER_ALIGNMENT_DESKTOP_CORPUS_DIR;
const runCorpus = process.env.MIRAVIEWER_SVR_ENHANCEMENT_CORPUS === '1';
const MiB = 1024 * 1024;
type Triple = [number, number, number];

function fingerprint(data: Float32Array | Uint8Array | Uint32Array): string {
  return createHash('sha256')
    .update(new Uint8Array(data.buffer, data.byteOffset, data.byteLength))
    .digest('hex');
}

/** Decoded Float32 owners only; this fixture does not retain or model parsed DICOM datasets. */
function decodedFrameCache() {
  const cachedImages: {
    loaded: boolean;
    imageId: string;
    timeStamp: number;
    sizeInBytes: number;
    image: { imageId: string; sizeInBytes: number; getPixelData: () => Float32Array };
    imageLoadObject: object;
  }[] = [];
  let clock = 0;
  let size = 0;
  let evictionCount = 0;
  return {
    cachedImages,
    getCacheInfo: () => ({ cacheSizeInBytes: size, maximumSizeInBytes: 256 * MiB }),
    getImageLoadObject: (imageId: string) => cachedImages.find((entry) => entry.imageId === imageId)?.imageLoadObject,
    get evictionCount() {
      return evictionCount;
    },
    remember(imageId: string, pixels: Float32Array) {
      const image = { imageId, sizeInBytes: pixels.byteLength, getPixelData: () => pixels };
      cachedImages.push({
        loaded: true,
        imageId,
        timeStamp: ++clock,
        sizeInBytes: pixels.byteLength,
        image,
        imageLoadObject: { promise: Promise.resolve(image) },
      });
      size += pixels.byteLength;
      while (size > 256 * MiB) size -= cachedImages.shift()!.sizeInBytes;
    },
    removeImageLoadObject(imageId: string) {
      const index = cachedImages.findIndex((entry) => entry.imageId === imageId);
      if (index < 0) throw new Error('The requested decoded MRI cache entry is absent');
      size -= cachedImages.splice(index, 1)[0]!.sizeInBytes;
      evictionCount++;
    },
  };
}

it('exposes measurable corpus cache owners and retains the displayed image after cache removal', async () => {
  const cache = decodedFrameCache();
  const pixels = Float32Array.of(1, 2, 3, 4);
  const id = 'miradb:synthetic-corpus-owner';
  cache.remember(id, pixels);
  const image = cache.cachedImages[0]!.image;
  const getEnabledElements = () => [{ image }];
  const measured = measureCornerstoneImageMemory({ imageCache: cache, getEnabledElements });
  expect(measured.measured).toBe(true);
  expect(measured.bytes).toBe(pixels.byteLength);
  await expect(
    prepareEnhancementMemory(MIN_SR_CONTEXT_DIM ** 3, 0, cache, new Set([id]), undefined, getEnabledElements),
  ).resolves.toBe(pixels.byteLength);
  cache.removeImageLoadObject(id);
  expect(measureCornerstoneImageMemory({ imageCache: cache, getEnabledElements }).bytes).toBe(pixels.byteLength);
  expect(measureCornerstoneImageMemory({ imageCache: cache, getEnabledElements: () => [] }).bytes).toBe(0);
  expect(image.getPixelData()).toBe(pixels);
});

function markNeighborhood(volume: SvrVolume, center: Triple, radius: number): SvrLabelVolume {
  const data = new Uint8Array(volume.data.length);
  const inside: number[] = [];
  const at = (x: number, y: number, z: number) => (z * volume.dims[1] + y) * volume.dims[0] + x;
  for (let z = -radius; z <= radius; z++)
    for (let y = -radius; y <= radius; y++)
      for (let x = -radius; x <= radius; x++) {
        if (x * x + y * y + z * z > radius * radius) continue;
        const index = at(center[0] + x, center[1] + y, center[2] + z);
        expect(volume.observedSupport![index]).toBe(1);
        data[index] = 1;
        inside.push(index);
      }
  return {
    data,
    dims: [...volume.dims],
    meta: SELECTION_LABEL_META,
    reviewState: 'draft',
    seeds: {
      foreground: Uint32Array.from(inside),
      background: Uint32Array.of(at(center[0] + 10, center[1], center[2])),
    },
  };
}

describe.skipIf(!runCorpus)('2x enhancement admission on the private full MRI overview', () => {
  it('enhances a single-voxel selection while retaining the full overview and original native detail', async () => {
    if (!corpusRoot) throw new Error('Set MIRAVIEWER_ALIGNMENT_DESKTOP_CORPUS_DIR to the private MRI corpus');
    const started = performance.now();
    const candidates = inspectAlignmentCorpus(corpusRoot, {
      studyOrdinals: [18],
      includeExtensionlessDicom: true,
    })
      .filter((source) => source.examinationOrdinal === 18 && /flair/i.test(source.contrast))
      .sort((first, second) => second.frames.length - first.frames.length);
    const source = candidates.find((series) => series.plane === 'SAG');
    const axial = candidates.find(
      (series) => series.plane === 'AX' && series.frameOfReferenceUid === source?.frameOfReferenceUid,
    );
    expect(source, 'The representative full sagittal source must remain present').toBeDefined();
    expect(axial, 'The same-examination axial landmark must remain present').toBeDefined();
    if (!source || !axial) return;
    expect(source.plane).toBe('SAG');
    expect(source.examinationOrdinal).toBe(18);
    expect(source.patientKey === axial.patientKey).toBe(true);
    expect(source.studyUid === axial.studyUid).toBe(true);
    expect(source.frames.length).toBeGreaterThanOrEqual(256);
    const manifest = alignmentCorpusManifest(source);
    manifest.frames.forEach((frame, index) => {
      frame.windowCenter = source.frames[index]!.windowCenter;
      frame.windowWidth = source.frames[index]!.windowWidth;
    });
    const codec = loadAlignmentLosslessCodec();
    const byUid = new Map(source.frames.map((frame) => [frame.sopInstanceUid, frame]));
    const cache = decodedFrameCache();
    let decodedFrames = 0;
    let compressedFrames = 0;
    const readFrame = async (frame: (typeof manifest.frames)[number], remember = false) => {
      const cached = cache.cachedImages.find((entry) => entry.imageId === `miradb:${frame.sopInstanceUid}`);
      if (cached) return { pixels: cached.image.getPixelData() };
      const original = byUid.get(frame.sopInstanceUid);
      if (!original) throw new Error('A requested native source frame is absent from the MRI corpus');
      const decoded = await decodeAlignmentCorpusFrame(original, codec);
      decodedFrames++;
      compressedFrames += decoded.compressed ? 1 : 0;
      if (remember) cache.remember(`miradb:${frame.sopInstanceUid}`, decoded.pixels);
      return { pixels: decoded.pixels };
    };
    const overviewPlan = planNativeVolume(manifest, {}, { decodedCacheBytes: 0 });
    expect(overviewPlan.overview).toBe(true);
    expect(overviewPlan.sourceDims).toEqual([source.columns, source.rows, source.frames.length]);
    expect(overviewPlan.cropMin).toEqual([0, 0, 0]);
    expect(overviewPlan.cropMax).toEqual(overviewPlan.sourceDims.map((size) => size - 1));
    expect(overviewPlan.dims).toEqual(
      overviewPlan.sourceAxes.map(
        (axis) => Math.floor((overviewPlan.sourceDims[axis]! - 1) / overviewPlan.sourceStrides[axis]!) + 1,
      ),
    );
    expect(overviewPlan.dims.reduce((product, size) => product * size, 1)).toBeGreaterThanOrEqual(16 * 1024 * 1024);
    expect(overviewPlan.totalBytes).toBeLessThanOrEqual(SVR_MEMORY_BUDGET_BYTES);
    // Retain real decoded frames in this same decode pass to model subsequent
    // slice browsing without replaying 256 decodes. Native assembly itself does
    // not populate Cornerstone's cache in the application.
    const overview = await assembleNativeVolume(overviewPlan, (frame) => readFrame(frame, true));
    overview.sourceProvenance = {
      mode: 'source-stack',
      datasetRevision: 0,
      patientKey: source.patientKey,
      studyUid: source.studyUid,
      frameOfReferenceUid: source.frameOfReferenceUid,
      fingerprint: 'private-corpus-native-overview',
      primarySeriesUid: source.seriesUid,
      explanation: 'Native source geometry for an opt-in numerical regression; not a clinical segmentation.',
      sources: [
        {
          seriesUid: source.seriesUid,
          label: 'Private native source',
          kind: 'unknown',
          transform: IDENTITY_PATIENT_TRANSFORM,
          contributingSopInstanceUids: source.frames.map((frame) => frame.sopInstanceUid),
          frames: source.frames.map((frame) => {
            const geometry = getSliceGeometryFromInstance(frame);
            return {
              sopInstanceUid: frame.sopInstanceUid,
              rows: frame.rows,
              columns: frame.columns,
              originMm: [geometry.ippMm.x, geometry.ippMm.y, geometry.ippMm.z],
              columnDirection: [geometry.rowDir.x, geometry.rowDir.y, geometry.rowDir.z],
              rowDirection: [geometry.colDir.x, geometry.colDir.y, geometry.colDir.z],
              pixelSpacingMm: [geometry.rowSpacingMm, geometry.colSpacingMm],
            };
          }),
        },
      ],
    };
    const initialCacheBytes = cache.getCacheInfo().cacheSizeInBytes;
    expect(initialCacheBytes).toBe(256 * MiB);
    const originalPixels = fingerprint(overview.data);
    const originalSupport = fingerprint(overview.observedSupport!);
    const originalGeometry = createHash('sha256').update(JSON.stringify(overviewPlan)).digest('hex');
    const nativePlaneBytes = nativePlaneMemoryBytes([manifest]);
    const retainedBytes = retainedSvrVolumeBytes(overview) + nativePlaneBytes;
    // This is the pre-fix admission equation: a smaller selection could not
    // overcome its fixed retained-volume/cache floor, even at minimum context.
    expect(retainedBytes + initialCacheBytes + enhancementWorkingBytes(MIN_SR_CONTEXT_DIM ** 3)).toBeGreaterThan(
      SVR_MEMORY_BUDGET_BYTES,
    );

    const landmark = buildOutputPlaneGrid(axial.frames[78]!);
    const point = outputGridPixelToWorld(landmark, (landmark.rows - 1) * 0.453, (landmark.columns - 1) * 0.503);
    const center = patientToVolumeVoxel(overview, [point.x, point.y, point.z]).map(Math.round) as Triple;
    for (let axis = 0; axis < 3; axis++) {
      expect(center[axis]).toBeGreaterThan(16);
      expect(center[axis]).toBeLessThan(overview.dims[axis]! - 17);
    }
    const protectedFrame = source.frames[Math.floor(source.frames.length / 2)]!;
    const protectedId = `miradb:${protectedFrame.sopInstanceUid}`;
    const protectedImage = cache.cachedImages.find((entry) => entry.imageId === protectedId);
    expect(protectedImage).toBeDefined();
    const protectedPixels = fingerprint(protectedImage!.image.getPixelData());
    const protectedIds = new Set([protectedId]);
    const getEnabledElements = () => [{ image: protectedImage!.image }];
    const measureCache = () => measureCornerstoneImageMemory({ imageCache: cache, getEnabledElements });
    expect(measureCache().measured).toBe(true);
    // Every retained allocation in this decoded-only model is a whole Float32 frame.
    expect(measureCache().bytes).toBe(initialCacheBytes);
    // Complete acquired-grid metadata, not a silently upsampled overview.
    const extent = planNativeVolume(manifest, {
      roi: { mode: 'box', sourcePlane: 'axial', boundsMm: overview.boundsMm },
    });
    const offsets = extent.sourceAxes.map((axis, outputAxis) =>
      extent.sourceFlips[outputAxis] === 1
        ? -extent.cropMin[axis]!
        : -(extent.sourceDims[axis]! - 1 - extent.cropMax[axis]!),
    ) as Triple;
    const nativeGrid = {
      dims: extent.sourceAxes.map((axis) => extent.sourceDims[axis]!) as Triple,
      voxelSizeMm: extent.nativeVoxelSizeMm,
      originMm: volumeVoxelToPatient(extent, offsets),
      direction: extent.direction,
    };
    const selections: { selectedVoxels: number; nativeDims: Triple; cacheMiB: number }[] = [];
    let enhancedSource: SvrVolume | undefined;
    let finalLabels: SvrLabelVolume | undefined;
    let finalLabelFingerprint: string | undefined;
    let finalSeedFingerprints: string[] | undefined;
    for (const radius of [4, 2, 0]) {
      const labels = markNeighborhood(overview, center, radius);
      const maskBefore = fingerprint(labels.data);
      const seedsBefore = [fingerprint(labels.seeds!.foreground), fingerprint(labels.seeds!.background)];
      const roi = await enhancementSelectionRoi(overview, labels, undefined, nativeGrid);
      let plan = planNativeVolume(
        manifest,
        { roi },
        {
          retainedBytes: retainedSvrVolumeBytes(overview),
          decodedCacheBytes: measureCache().bytes,
          nativePlaneBytes,
        },
      );
      expect(plan.sourceStrides).toEqual([1, 1, 1]);
      expect(plan.voxelSizeMm).toEqual(overview.nativeVoxelSizeMm);
      const count = plan.dims.reduce((product, size) => product * size, 1);
      console.info(
        'SVR native-context admission',
        JSON.stringify({
          overviewDims: overview.dims,
          selectedVoxels: labels.seeds!.foreground.length,
          nativeDims: plan.dims,
          fixedRetainedMiB: retainedBytes / MiB,
          initialCacheMiB: initialCacheBytes / MiB,
          oldPeakMiB: (retainedBytes + initialCacheBytes + enhancementWorkingBytes(count)) / MiB,
        }),
      );
      // Oblique contexts can expand when represented as patient-axis AABBs.
      // Independently project the marked cells' physical outer corners: every
      // corner must keep at least six ORIGINAL native context samples per side.
      // This tests source coverage, not a cap copied from an older examination.
      expect(plan.dims.every((size) => size >= MIN_SR_CONTEXT_DIM)).toBe(true);
      expect(count * 8).toBeLessThanOrEqual(MAX_SR_OUTPUT_VOXELS);
      for (const x of [-radius - 0.5, radius + 0.5])
        for (const y of [-radius - 0.5, radius + 0.5])
          for (const z of [-radius - 0.5, radius + 0.5]) {
            const corner = patientToVolumeVoxel(
              plan,
              volumeVoxelToPatient(overview, [center[0] + x, center[1] + y, center[2] + z]),
            );
            for (let axis = 0; axis < 3; axis++) {
              expect(corner[axis]).toBeGreaterThanOrEqual(5.5 - 0.0001);
              expect(corner[axis]).toBeLessThanOrEqual(plan.dims[axis]! - 6.5 + 0.0001);
            }
          }
      expect(() => assertEnhancementFits(count, retainedBytes + initialCacheBytes)).toThrow(
        /no room for even a small/i,
      );
      const decodedCacheBytes = await prepareEnhancementMemory(
        count,
        retainedBytes,
        cache,
        protectedIds,
        undefined,
        getEnabledElements,
      );
      expect(decodedCacheBytes).toBeLessThan(initialCacheBytes);
      expect(() => assertEnhancementFits(count, retainedBytes + decodedCacheBytes)).not.toThrow();
      plan = planNativeVolume(
        manifest,
        { roi },
        {
          retainedBytes: retainedSvrVolumeBytes(overview),
          decodedCacheBytes,
          nativePlaneBytes,
        },
      );
      expect(plan.totalBytes).toBeLessThanOrEqual(SVR_MEMORY_BUDGET_BYTES);
      expect(fingerprint(labels.data)).toBe(maskBefore);
      expect([fingerprint(labels.seeds!.foreground), fingerprint(labels.seeds!.background)]).toEqual(seedsBefore);
      selections.push({
        selectedVoxels: labels.seeds!.foreground.length,
        nativeDims: plan.dims,
        cacheMiB: decodedCacheBytes / MiB,
      });
      if (radius === 0) {
        enhancedSource = await assembleNativeVolume(plan, readFrame);
        await prepareEnhancementMemory(
          enhancedSource.data.length,
          retainedBytes,
          cache,
          protectedIds,
          undefined,
          getEnabledElements,
        );
        finalLabels = labels;
        finalLabelFingerprint = maskBefore;
        finalSeedFingerprints = seedsBefore;
      }
    }
    expect(selections.map(({ selectedVoxels }) => selectedVoxels)).toEqual([257, 33, 1]);
    expect(cache.evictionCount).toBeGreaterThan(0);
    expect(enhancedSource).toBeDefined();
    if (!enhancedSource) return;
    const nativeBefore = fingerprint(enhancedSource.data);
    const nativeSupportBefore = fingerprint(enhancedSource.observedSupport!);
    const enhanced = await enhanceVolume2x(enhancedSource);
    expect(enhanced.dims).toEqual(enhancedSource.dims.map((size) => size * 2));
    expect(enhanced.voxelSizeMm).toEqual(enhancedSource.nativeVoxelSizeMm!.map((pitch) => pitch / 2));
    expect(enhanced.data.length).toBe(enhancedSource.data.length * 8);
    expect(enhanced.stats.trainingSamples).toBeGreaterThanOrEqual(128);
    expect(enhanced.stats.heldOutSamples).toBeGreaterThanOrEqual(32);
    expect(enhanced.stats.calibrationSamples).toBeGreaterThanOrEqual(32);
    expect(enhanced.displayWindow).toEqual(enhancedSource.displayWindow);
    let maximumMeanError = 0;
    let maximumMagnitude = 0;
    let supportMismatches = 0;
    let nonFiniteOutputs = 0;
    const [nx, ny, nz] = enhancedSource.dims;
    for (let z = 0; z < nz; z++)
      for (let y = 0; y < ny; y++)
        for (let x = 0; x < nx; x++) {
          const index = (z * ny + y) * nx + x;
          let sum = 0;
          for (let child = 0; child < 8; child++) {
            const output =
              ((2 * z + (child >> 2)) * enhanced.dims[1] + 2 * y + ((child >> 1) & 1)) * enhanced.dims[0] +
              2 * x +
              (child & 1);
            supportMismatches += enhanced.observedSupport[output] === enhancedSource.observedSupport![index] ? 0 : 1;
            nonFiniteOutputs += Number.isFinite(enhanced.data[output]) ? 0 : 1;
            sum += enhanced.data[output]!;
          }
          if (!enhancedSource.observedSupport![index]) continue;
          maximumMagnitude = Math.max(maximumMagnitude, Math.abs(enhancedSource.data[index]!));
          maximumMeanError = Math.max(maximumMeanError, Math.abs(sum / 8 - enhancedSource.data[index]!));
        }
    expect(maximumMagnitude).toBeGreaterThan(1);
    expect(supportMismatches).toBe(0);
    expect(nonFiniteOutputs).toBe(0);
    expect(maximumMeanError).toBeLessThanOrEqual(Math.max(0.00001, maximumMagnitude * 0.000001));
    expect(fingerprint(enhancedSource.data)).toBe(nativeBefore);
    expect(fingerprint(enhancedSource.observedSupport!)).toBe(nativeSupportBefore);
    expect(fingerprint(overview.data)).toBe(originalPixels);
    expect(fingerprint(overview.observedSupport!)).toBe(originalSupport);
    expect(createHash('sha256').update(JSON.stringify(overviewPlan)).digest('hex')).toBe(originalGeometry);
    expect(fingerprint(finalLabels!.data)).toBe(finalLabelFingerprint);
    expect([fingerprint(finalLabels!.seeds!.foreground), fingerprint(finalLabels!.seeds!.background)]).toEqual(
      finalSeedFingerprints,
    );
    expect(finalLabels!.reviewState).toBe('draft');
    expect(cache.cachedImages.find((entry) => entry.imageId === protectedId) === protectedImage).toBe(true);
    expect(fingerprint(protectedImage!.image.getPixelData())).toBe(protectedPixels);
    // Numeric, anonymized evidence only: never persist source images, identifiers,
    // paths, or patient data. Cache ownership is modeled; this is not browser QA.
    console.info(
      'SVR enhancement admission corpus',
      JSON.stringify({
        overviewDims: overview.dims,
        nativeVoxelSizeMm: overview.nativeVoxelSizeMm,
        decodedFrames,
        compressedFrames,
        cacheModelUsesRealDecodedPixels: true,
        cacheModelRetainsParsedDicomDatasets: false,
        modeledDisplayedImages: 1,
        initialCacheMiB: initialCacheBytes / MiB,
        retainedMiB: retainedBytes / MiB,
        evictedFrames: cache.evictionCount,
        selections,
        outputDims: enhanced.dims,
        maximumMeanError,
        supportMismatches,
        nonFiniteOutputs,
        sourceAndAnnotationsUnchanged: true,
        enhancementDurationMs: enhanced.stats.durationMs,
        elapsedMs: performance.now() - started,
      }),
    );
  }, 180_000);
});
