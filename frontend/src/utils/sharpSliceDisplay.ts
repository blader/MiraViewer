import type { DerivedAlignmentFrame } from './derivedAlignmentFrame';
import { getDatasetRevision, getSeriesFrameManifest, type SeriesFrameManifest } from './localApi';
import { validateOutputGridReference } from './outputPlaneGrid';
import {
  MAX_SHARP_SLICE_WORKING_BYTES,
  sharpSliceWorkingBytes,
  type SharpSliceDisplayResult,
} from './sharpSlicePresentation';
import type { SharpSliceWorkerRequest, SharpSliceWorkerResponse } from './sharpSliceDisplay.worker';
import { getSliceGeometryFromInstance } from './svr/dicomGeometry';
import { decodeLongitudinalReferenceFrame, selectDenseLongitudinalSourceEnvelope } from './svr/longitudinalFrames';
import type { SvrReconstructionSlice } from './svr/reconstructionCore';
import { assertNotAborted, yieldToMain } from './svr/svrUtils';
import { v3 } from './svr/vec3';

export type { SharpSliceDisplayResult } from './sharpSlicePresentation';
type Options = { signal?: AbortSignal; onProgress?: (message: string) => void };
const TIMEOUT_MS = 60_000;
let active = false;
const waiting = new Set<() => void>();
// Cornerstone's source load cannot be cancelled. An abandoned waiter may not start a second native decode.
let nativeLoadInFlight: Promise<unknown> | null = null;

function cancelled() {
  return new DOMException('Sharp-slice reconstruction cancelled.', 'AbortError');
}

/** One reconstruction owns native/worker buffers at a time across all mounted panels. */
async function acquire(signal?: AbortSignal): Promise<() => void> {
  assertNotAborted(signal);
  if (active)
    await new Promise<void>((resolve, reject) => {
      const ready = () => {
        signal?.removeEventListener('abort', abort);
        resolve();
      };
      const abort = () => {
        waiting.delete(ready);
        reject(cancelled());
      };
      waiting.add(ready);
      signal?.addEventListener('abort', abort, { once: true });
    });
  // A granted slot must be released even if its owner was cancelled in the same turn.
  active = true;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const next = waiting.values().next().value;
    if (next) {
      waiting.delete(next);
      next();
    } else active = false;
  };
}

function bounded<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (action: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      action();
    };
    const abort = () => finish(() => reject(cancelled()));
    const timer = setTimeout(
      () => finish(() => reject(new Error('Loading native sharp-slice context timed out.'))),
      TIMEOUT_MS,
    );
    signal?.addEventListener('abort', abort, { once: true });
    promise.then(
      (value) => finish(() => resolve(value)),
      (error) => finish(() => reject(error)),
    );
    if (signal?.aborted) abort();
  });
}

async function worker(request: SharpSliceWorkerRequest, options: Options): Promise<SharpSliceWorkerResponse> {
  assertNotAborted(options.signal);
  if (typeof Worker === 'undefined') throw new Error('Sharp slices require browser background-worker support.');
  const instance = new Worker(new URL('./sharpSliceDisplay.worker.ts', import.meta.url), { type: 'module' });
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error: Error | null, response?: SharpSliceWorkerResponse) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', abort);
      instance.onmessage = null;
      instance.onerror = null;
      instance.onmessageerror = null;
      instance.terminate();
      if (error) reject(error);
      else resolve(response!);
    };
    const abort = () => finish(cancelled());
    const timer = setTimeout(
      () => finish(new Error('Sharp-slice reconstruction exceeded its one-minute limit.')),
      TIMEOUT_MS,
    );
    instance.onmessage = (event: MessageEvent<SharpSliceWorkerResponse>) => {
      const response = event.data;
      if (response?.type === 'progress' && typeof response.message === 'string') {
        try {
          options.onProgress?.(response.message);
        } catch (error) {
          finish(error instanceof Error ? error : new Error('Sharp-slice progress could not be displayed.'));
        }
      } else if (response?.type === 'error') finish(new Error(response.message));
      else if (response?.type === 'image') finish(null, response);
      else finish(new Error('The sharp-slice worker returned an invalid response.'));
    };
    instance.onerror = (event) => finish(new Error(event.message || 'The sharp-slice worker failed.'));
    instance.onmessageerror = () => finish(new Error('The sharp-slice worker response could not be decoded.'));
    options.signal?.addEventListener('abort', abort, { once: true });
    if (options.signal?.aborted) {
      abort();
      return;
    }
    const transfers = new Set<ArrayBuffer>();
    for (const slice of request.input.slices) {
      transfers.add(slice.pixels.buffer as ArrayBuffer);
      if (slice.valid) transfers.add(slice.valid.buffer as ArrayBuffer);
    }
    transfers.add(request.input.baselinePixels.buffer as ArrayBuffer);
    if (request.input.baselineValid) transfers.add(request.input.baselineValid.buffer as ArrayBuffer);
    // These buffers were freshly decoded or copied by this request; cached/source pixels never transfer.
    try {
      instance.postMessage(request, Array.from(transfers));
    } catch (error) {
      finish(error instanceof Error ? error : new Error('Sharp-slice input transfer failed.'));
    }
  });
}

async function decode(
  manifest: SeriesFrameManifest,
  indices: readonly number[],
  options: Options,
): Promise<SvrReconstructionSlice[]> {
  const frame = manifest.frames[0]!;
  const geometry = getSliceGeometryFromInstance(frame);
  for (const index of indices) {
    const candidate = manifest.frames[index];
    if (!candidate || candidate.rows !== frame.rows || candidate.columns !== frame.columns)
      throw new Error('Sharp slices require matching native dimensions; source detail will not be downsampled.');
    const other = getSliceGeometryFromInstance(candidate);
    if (
      Math.abs(other.rowSpacingMm - geometry.rowSpacingMm) > 1e-6 ||
      Math.abs(other.colSpacingMm - geometry.colSpacingMm) > 1e-6
    )
      throw new Error('Sharp slices require consistent native pixel spacing.');
  }
  const slices: SvrReconstructionSlice[] = [];
  for (const index of indices) {
    if (nativeLoadInFlight)
      await bounded(
        nativeLoadInFlight.catch(() => undefined),
        options.signal,
      );
    assertNotAborted(options.signal);
    const pending = decodeLongitudinalReferenceFrame(
      manifest,
      index,
      Math.max(frame.rows, frame.columns),
      options.signal,
      (load) => {
        nativeLoadInFlight = load;
        const settled = () => {
          if (nativeLoadInFlight === load) nativeLoadInFlight = null;
        };
        void load.then(settled, settled);
      },
    );
    slices.push(await bounded(pending, options.signal));
    await yieldToMain();
  }
  return slices;
}

async function currentRevision(frame: DerivedAlignmentFrame, signal?: AbortSignal) {
  assertNotAborted(signal);
  if ((await bounded(getDatasetRevision(), signal)) !== frame.datasetRevision)
    throw new Error('MRI data changed while preparing the sharp slice.');
  assertNotAborted(signal);
}

/** A second presentation only: no writes to MRI, registration results, tone, annotations or IndexedDB. */
export async function requestSharpSliceDisplay(
  frame: DerivedAlignmentFrame,
  options: Options = {},
): Promise<SharpSliceDisplayResult> {
  const release = await acquire(options.signal);
  try {
    assertNotAborted(options.signal);
    if (
      !frame.outputGrid ||
      !frame.rigidTransform ||
      !frame.rotationCenterMm ||
      !frame.patientKey ||
      !frame.sequenceId ||
      !frame.referenceSeriesUid ||
      !Number.isSafeInteger(frame.referenceFrameIndex) ||
      !Number.isSafeInteger(frame.datasetRevision) ||
      frame.rows !== frame.outputGrid.rows ||
      frame.columns !== frame.outputGrid.columns ||
      frame.pixels.length !== frame.rows * frame.columns ||
      (frame.valid && frame.valid.length !== frame.pixels.length) ||
      frame.rigidTransform.length !== 6 ||
      frame.rotationCenterMm.length !== 3 ||
      [...frame.rigidTransform, ...frame.rotationCenterMm].some((value) => !Number.isFinite(value))
    )
      throw new Error('Sharp slices need a verified, physically aligned MRI plane.');
    await currentRevision(frame, options.signal);
    const [manifest, reference] = await bounded(
      Promise.all([getSeriesFrameManifest(frame.seriesUid), getSeriesFrameManifest(frame.referenceSeriesUid)]),
      options.signal,
    );
    const referenceFrame = reference.frames[frame.referenceFrameIndex!];
    const targetFrame = manifest.frames[frame.instanceIndex];
    if (
      !manifest.geometryReliable ||
      !reference.geometryReliable ||
      manifest.patientKey !== frame.patientKey ||
      reference.patientKey !== frame.patientKey ||
      manifest.studyUid !== frame.targetStudyUid ||
      !referenceFrame ||
      referenceFrame.sopInstanceUid !== frame.referenceSopInstanceUid ||
      reference.studyUid !== frame.referenceStudyUid ||
      !targetFrame ||
      targetFrame.sopInstanceUid !== frame.targetSopInstanceUid ||
      frame.sourceImageId !== `miradb:${targetFrame.sopInstanceUid}`
    )
      throw new Error('The sharp slice no longer matches its original MRI sources.');
    validateOutputGridReference(frame.outputGrid, referenceFrame, reference.frameOfReferenceUid);
    const first = manifest.frames[0]!;
    if (manifest.frames.length < 4) throw new Error('Sharp slices need at least four neighboring native images.');
    const geometry = getSliceGeometryFromInstance(referenceFrame);
    const referencePlane = {
      dsRows: geometry.rows,
      dsCols: geometry.cols,
      ippMm: geometry.ippMm,
      rowDir: geometry.rowDir,
      colDir: geometry.colDir,
      normalDir: geometry.normalDir,
      rowSpacingDsMm: geometry.rowSpacingMm,
      colSpacingDsMm: geometry.colSpacingMm,
      sliceThicknessMm: referenceFrame.sliceThickness ?? null,
      spacingBetweenSlicesMm: referenceFrame.spacingBetweenSlices ?? null,
      frameOfReferenceUid: reference.frameOfReferenceUid,
      sopInstanceUid: referenceFrame.sopInstanceUid,
    };
    const [tx, ty, tz, rx, ry, rz] = frame.rigidTransform;
    const targetToReference = { tx, ty, tz, rx, ry, rz },
      centerMm = v3(...frame.rotationCenterMm);
    const envelope = selectDenseLongitudinalSourceEnvelope(manifest, referencePlane, targetToReference, centerMm, {
      outputGrid: frame.outputGrid,
      refinePose: false,
      maxDimension: Math.max(first.rows, first.columns),
    });
    const from = Math.max(0, envelope.sourceIndices[0]! - 2),
      to = Math.min(manifest.frames.length - 1, envelope.sourceIndices.at(-1)! + 2);
    const indices = Array.from({ length: to - from + 1 }, (_, index) => from + index);
    // Admission precedes decoding; direct sampling needs no enlarged or synthetic volume.
    if (
      sharpSliceWorkingBytes(indices.length, first.rows * first.columns, frame.pixels.length) >
      MAX_SHARP_SLICE_WORKING_BYTES
    )
      throw new Error('This native stack exceeds the sharp-slice memory budget. Original detail will not be reduced.');
    options.onProgress?.('Preparing the sharper aligned plane…');
    const slices = await decode(manifest, indices, options);
    await currentRevision(frame, options.signal);
    const response = await worker(
      {
        type: 'render',
        input: {
          slices,
          referencePlane,
          outputGrid: frame.outputGrid,
          targetToReference,
          centerMm,
          baselinePixels: Float32Array.from(frame.pixels),
          baselineValid: frame.valid ? Uint8Array.from(frame.valid) : undefined,
        },
      },
      options,
    );
    await currentRevision(frame, options.signal);
    if (response.type !== 'image') throw new Error('The sharp-slice worker did not return an image.');
    const result = response.image;
    if (
      result.rows !== frame.rows ||
      result.columns !== frame.columns ||
      !(result.pixels instanceof Float32Array) ||
      !(result.valid instanceof Uint8Array) ||
      result.pixels.length !== frame.pixels.length ||
      result.valid.length !== frame.pixels.length ||
      !result.stats ||
      typeof result.stats.method !== 'string' ||
      !Number.isFinite(result.stats.durationMs) ||
      result.stats.durationMs < 0
    )
      throw new Error('The synthesized image does not match its original aligned plane.');
    for (let index = 0; index < result.pixels.length; index++) {
      if (!Number.isFinite(result.pixels[index]) || result.valid[index] !== (frame.valid?.[index] ?? 1))
        throw new Error('Sharp synthesis changed native support or returned invalid intensities.');
    }
    return result;
  } finally {
    release();
  }
}
