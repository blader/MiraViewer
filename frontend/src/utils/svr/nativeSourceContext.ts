import type { SvrParams, SvrProgress, SvrRoi, SvrSelectedSeries, SvrVolume } from '../../types/svr';
import { getDatasetRevision, getSelectedPatientKey, type SeriesFrameManifest } from '../localApi';
import { getDecodedFrameBySopInstanceUid } from '../decodedFrame';
import { getSliceGeometryFromInstance } from './dicomGeometry';
import { planNativeVolume } from './nativeVolume';
import { waitForNativeFrame } from './nativeFrameWait';
import { reconstructVolumeMultiPlane } from './reconstructVolume';
import { assertNotAborted, yieldToMain } from './svrUtils';
import { snapshotPatientTransform, volumeVoxelToPatient } from './volumeGeometry';

export type NativeSourceGrid = Pick<SvrVolume, 'dims' | 'voxelSizeMm' | 'originMm' | 'direction'>;
export type NativeSourceLoadOptions = {
  signal?: AbortSignal;
  onProgress?: (progress: SvrProgress) => void;
};
export type NativeSourceMemory = {
  /** Current owners, not future source/model allocations. Measured anew for each operation. */
  retainedBytes: number;
  decodedCacheBytes: number;
  nativePlaneBytes: number;
  /** Ordinary refinement keeps the native default; learned selection admits its own envelope. */
  budgetBytes?: number;
};

// Source metadata contains only plain records, arrays and scalar values, never MRI buffers.
function freezeMetadata<T>(value: T): T {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) freezeMetadata(child);
    Object.freeze(value);
  }
  return value;
}

/**
 * Plan real acquired context in the accepted patient pose before allocating pixels.
 * Retain this with the accepted source, not one correction. Only metadata and a
 * completed normalization range survive calls; live memory admission never does.
 */
export function createNativeSourceContext({
  volume,
  nativeSource,
  selectedSeries,
  parameters,
}: {
  volume: SvrVolume;
  nativeSource: SeriesFrameManifest;
  selectedSeries: SvrSelectedSeries[];
  parameters: SvrParams;
}) {
  const acceptedProvenance = volume.sourceProvenance;
  const acceptedSource = acceptedProvenance?.sources.find((source) => source.seriesUid === nativeSource.seriesUid);
  if (!acceptedProvenance || !acceptedSource)
    throw new Error('The accepted original source pose is unavailable. Reopen this examination.');
  const acceptedFrames = new Map(acceptedSource.frames.map((frame) => [frame.sopInstanceUid, frame]));
  if (
    acceptedProvenance.mode === 'independent-2d' ||
    nativeSource.seriesUid !== acceptedProvenance.primarySeriesUid ||
    nativeSource.patientKey !== acceptedProvenance.patientKey ||
    nativeSource.studyUid !== acceptedProvenance.studyUid ||
    nativeSource.frameOfReferenceUid !== acceptedProvenance.frameOfReferenceUid ||
    nativeSource.frames.length !== acceptedFrames.size ||
    nativeSource.frames.some((frame) => {
      const accepted = acceptedFrames.get(frame.sopInstanceUid);
      if (!accepted) return true;
      const geometry = getSliceGeometryFromInstance(frame);
      const current = [
        geometry.rows,
        geometry.cols,
        geometry.ippMm.x,
        geometry.ippMm.y,
        geometry.ippMm.z,
        geometry.rowDir.x,
        geometry.rowDir.y,
        geometry.rowDir.z,
        geometry.colDir.x,
        geometry.colDir.y,
        geometry.colDir.z,
        geometry.rowSpacingMm,
        geometry.colSpacingMm,
      ];
      const prior = [
        accepted.rows,
        accepted.columns,
        ...accepted.originMm,
        ...accepted.columnDirection,
        ...accepted.rowDirection,
        ...accepted.pixelSpacingMm,
      ];
      return current.some((value, index) => value !== prior[index]);
    })
  )
    throw new Error('The original source metadata no longer matches the accepted volume. Reopen this examination.');
  const sourceState = () => JSON.stringify([nativeSource, acceptedProvenance]);
  const acceptedState = sourceState();
  const [source, provenance] = freezeMetadata(structuredClone([nativeSource, acceptedProvenance] as const));
  const assertOwner = () => {
    if (volume.sourceProvenance !== acceptedProvenance)
      throw new Error('The accepted original source changed while preparing its context. Reopen this examination.');
  };
  const assertCurrent = () => {
    assertOwner();
    // Check mutable callers only at operation boundaries. The frame loop reads
    // our frozen snapshot, so it cannot mix geometry or serialize N frames N times.
    if (sourceState() !== acceptedState)
      throw new Error('The accepted original source changed while preparing its context. Reopen this examination.');
  };
  const transform = snapshotPatientTransform(acceptedSource.transform);
  // Metadata only: derive the complete acquired grid even when the accepted
  // native volume is a small focus crop. This never allocates source pixels.
  const extent = planNativeVolume(
    source,
    { roi: { mode: 'box', sourcePlane: 'axial', boundsMm: volume.boundsMm } },
    { decodedCacheBytes: 0, nativePlaneBytes: 0, transform },
  );
  const offsets = extent.sourceAxes.map((axis, outputAxis) =>
    extent.sourceFlips[outputAxis] === 1
      ? -extent.cropMin[axis]!
      : -(extent.sourceDims[axis]! - 1 - extent.cropMax[axis]!),
  ) as [number, number, number];
  const grid: NativeSourceGrid = freezeMetadata({
    dims: extent.sourceAxes.map((axis) => extent.sourceDims[axis]!) as [number, number, number],
    voxelSizeMm: extent.nativeVoxelSizeMm,
    direction: extent.direction,
    originMm: volumeVoxelToPatient(extent, offsets),
  });
  const acceptedParameters = { ...parameters };
  const acceptedSeries = selectedSeries.map((series) => ({ ...series }));
  const requested = (roi: SvrRoi): SvrParams => {
    assertCurrent();
    // An absent ROI permits overview subsampling; a source context must remain exact.
    if (!roi) throw new Error('Native source context requires an explicit patient-space region.');
    return {
      ...acceptedParameters,
      roi: { ...roi, boundsMm: { min: [...roi.boundsMm.min], max: [...roi.boundsMm.max] } },
    };
  };
  let range: [number, number] | undefined;
  const rangeOwner = async (signal?: AbortSignal) => {
    assertNotAborted(signal);
    assertOwner();
    const [revision, patient] = await Promise.all([getDatasetRevision(), getSelectedPatientKey()]);
    assertNotAborted(signal);
    assertCurrent();
    if (revision !== provenance.datasetRevision || (patient && patient !== provenance.patientKey))
      throw new Error('MRI data changed while measuring source intensities. Reopen this examination.');
    return patient;
  };
  return {
    grid,
    plan: (roi: SvrRoi, memory: NativeSourceMemory) =>
      planNativeVolume(source, requested(roi), { ...memory, transform }),
    /** Full-acquisition modality values, independent of ROI, overview stride and display tone. */
    async intensityRange(options: NativeSourceLoadOptions = {}): Promise<[number, number]> {
      const patient = await rangeOwner(options.signal);
      assertNotAborted(options.signal);
      assertOwner();
      if (range) return [...range];
      let minimum = Infinity,
        maximum = -Infinity;
      for (const [index, frame] of source.frames.entries()) {
        assertNotAborted(options.signal);
        assertOwner();
        // The decoded frame is owned only by this iteration, not by the retained scalar result.
        {
          const image = await waitForNativeFrame(
            getDecodedFrameBySopInstanceUid(source.seriesUid, frame.sopInstanceUid, { cache: 'reuse-only' }),
            options.signal,
          );
          assertNotAborted(options.signal);
          assertOwner();
          if (
            image.seriesUid !== source.seriesUid ||
            image.sopInstanceUid !== frame.sopInstanceUid ||
            image.rows !== frame.rows ||
            image.cols !== frame.columns ||
            image.pixels.length !== frame.rows * frame.columns ||
            image.validity.length !== image.pixels.length
          )
            throw new Error('A native source frame changed while measuring source intensities.');
          for (let pixel = 0; pixel < image.pixels.length; pixel++) {
            const value = image.pixels[pixel]!;
            if (!(image.validity[pixel]! > 0) || !Number.isFinite(value)) continue;
            minimum = Math.min(minimum, value);
            maximum = Math.max(maximum, value);
          }
        }
        options.onProgress?.({
          phase: 'loading',
          current: index + 1,
          total: source.frames.length,
          message: 'Measuring original source intensities…',
        });
        await yieldToMain();
      }
      const finalPatient = await rangeOwner(options.signal);
      assertNotAborted(options.signal);
      assertOwner();
      if (finalPatient !== patient)
        throw new Error('The selected patient changed while measuring source intensities. Reopen this examination.');
      if (!Number.isFinite(minimum)) throw new Error('The original source contains no finite acquired intensities.');
      if (!(maximum > minimum))
        throw new Error('The original source has no intensity variation for interactive normalization.');
      range = [minimum, maximum];
      return [...range];
    },
    async load(roi: SvrRoi, options: NativeSourceLoadOptions & NativeSourceMemory): Promise<SvrVolume> {
      assertNotAborted(options.signal);
      const svrParams = requested(roi);
      // The existing assembler revalidates dataset/patient identity, measures live
      // cache residency, admits its own peak, and streams into exclusively owned buffers.
      const result = await reconstructVolumeMultiPlane({
        selectedSeries: acceptedSeries,
        svrParams,
        acceptedProvenance: provenance,
        retainedBytes: options.retainedBytes,
        nativeContextBudgetBytes: options.budgetBytes,
        signal: options.signal,
        onProgress: options.onProgress,
      });
      assertNotAborted(options.signal);
      assertCurrent();
      return result.volume;
    },
  };
}

export type NativeSourceContext = ReturnType<typeof createNativeSourceContext>;
