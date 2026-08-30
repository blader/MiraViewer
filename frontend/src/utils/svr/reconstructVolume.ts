import cornerstone from 'cornerstone-core';
import type {
  SvrParams,
  SvrProgress,
  SvrResult,
  SvrSelectedSeries,
  SvrSourceProvenance,
  SvrPatientTransform,
} from '../../types/svr';
import {
  getDatasetRevision,
  getSelectedPatientKey,
  getSeriesFrameManifest,
  type SeriesFrameManifest,
} from '../localApi';
import { decodeImageWithValidity, loadCornerstoneImage, type DecodedFrameResampleKernel } from '../decodedFrame';
import type { SliceGeometry } from './dicomGeometry';
import { downsampledSliceOriginMm, getSliceGeometryFromInstance } from './dicomGeometry';
import { computeSvrDownsampleSize } from './downsample';
import { filterSvrManifestFramesForRoi, getSvrSourceCropWindow } from './sliceRoiCrop';
import {
  classifySvrAcquisitions,
  hydrateSvrAcquisitionMetadata,
  nativeReferenceSources,
} from './acquisitionProvenance';
import { assembleNativeVolume, nativePlaneMemoryBytes, planNativeVolume } from './nativeVolume';
import { IDENTITY_PATIENT_TRANSFORM, snapshotPatientTransform } from './volumeGeometry';
import { dot } from './vec3';
import { debugSvrLog, isDebugSvrEnabled } from '../debugSvr';
import type { LoadedSlice } from './rigidRegistration';
import type {
  SvrComputePayload,
  SvrComputeResult,
  SvrComputeWorkerRequest,
  SvrComputeWorkerResponse,
} from './svrComputeCore';
import { computeSvrFromLoadedSlices } from './svrComputeCore';
import { estimateSvrSourceMemory, SVR_SOURCE_PREFETCH_LIMIT } from './sourceMemory';
import { measureCornerstoneImageMemory } from '../cornerstoneMemory';
import { SVR_MEMORY_BUDGET_BYTES } from './svrMemoryPlan';
import { assertNotAborted, formatMiB, yieldToMain } from './svrUtils';

const DECODE_PROGRESS_START = 5;
const DECODE_PROGRESS_END = 35;

type AdmittedSvrSeries = {
  series: SvrSelectedSeries;
  manifest: SeriesFrameManifest;
};

async function admitSvrSeries(
  selectedSeries: SvrSelectedSeries[],
  selectedPatientKey: string | null,
  signal?: AbortSignal,
): Promise<AdmittedSvrSeries[]> {
  const admitted: AdmittedSvrSeries[] = [];
  const seenSeries = new Set<string>();
  const seenInstances = new Set<string>();
  let referencePatient: string | undefined;
  let referenceStudy: string | undefined;
  let referenceFrame: string | undefined;
  let referenceWeight: string | undefined;
  let referenceSequence: string | undefined;

  for (const series of selectedSeries) {
    assertNotAborted(signal);
    if (seenSeries.has(series.seriesUid)) {
      throw new Error('SVR cannot reconstruct the same source series more than once');
    }
    seenSeries.add(series.seriesUid);

    const manifest = await getSeriesFrameManifest(series.seriesUid);
    if (!manifest.patientKey || (referencePatient && manifest.patientKey !== referencePatient)) {
      throw new Error('SVR source series must belong to the same patient');
    }
    if (selectedPatientKey && manifest.patientKey !== selectedPatientKey) {
      throw new Error('SVR source series do not belong to the currently selected patient');
    }
    if (referenceStudy && manifest.studyUid !== referenceStudy) {
      throw new Error('SVR source series must belong to the same examination');
    }
    if (series.studyId !== manifest.studyUid) {
      throw new Error('An SVR source does not belong to the selected examination');
    }
    if (!manifest.geometryReliable || manifest.frames.length === 0) {
      throw new Error('An SVR source has unreliable or incomplete patient-space slice geometry');
    }
    if (manifest.frames.length !== series.instanceCount) {
      throw new Error('SVR source frames changed after selection; refresh the examination and try again');
    }
    if (!manifest.frameOfReferenceUid) {
      throw new Error('SVR sources require a verified shared DICOM frame of reference');
    }
    if (referenceFrame && manifest.frameOfReferenceUid !== referenceFrame) {
      throw new Error('SVR sources have incompatible DICOM frames of reference');
    }

    const weight = series.weight?.trim().toLocaleLowerCase();
    const sequence = series.sequence?.trim().toLocaleLowerCase();
    if (
      (weight && referenceWeight && weight !== referenceWeight) ||
      (sequence && referenceSequence && sequence !== referenceSequence)
    ) {
      throw new Error('SVR source series must belong to the same acquisition contrast and sequence');
    }

    for (const frame of manifest.frames) {
      if (
        frame.seriesInstanceUid !== series.seriesUid ||
        frame.studyInstanceUid !== manifest.studyUid ||
        frame.frameOfReferenceUid !== manifest.frameOfReferenceUid
      ) {
        throw new Error('An SVR source frame does not match its admitted examination and frame of reference');
      }
      if (seenInstances.has(frame.sopInstanceUid)) {
        throw new Error('SVR source series contain a duplicate image instance');
      }
      seenInstances.add(frame.sopInstanceUid);
    }

    referencePatient ??= manifest.patientKey;
    referenceStudy ??= manifest.studyUid;
    referenceFrame ??= manifest.frameOfReferenceUid;
    referenceWeight ??= weight;
    referenceSequence ??= sequence;
    admitted.push({ series, manifest });
  }

  return admitted;
}

async function assertSvrIdentityUnchanged(datasetRevision: number, selectedPatientKey: string | null, stage: string) {
  const [currentRevision, currentPatientKey] = await Promise.all([getDatasetRevision(), getSelectedPatientKey()]);
  if (currentRevision !== datasetRevision) {
    throw new Error(`MRI data changed ${stage}; refresh the examination and try again`);
  }
  if (currentPatientKey !== selectedPatientKey) {
    throw new Error(`The selected patient changed ${stage}; refresh the examination and try again`);
  }
}

function getSvrSliceResampleKernel(debug?: boolean): DecodedFrameResampleKernel {
  if (!debug) return 'area';

  try {
    const v = localStorage.getItem('miraviewer:svr-resample-kernel');
    return v === 'lanczos3' ? 'lanczos3' : 'area';
  } catch {
    return 'area';
  }
}

async function loadSeriesSlices(params: {
  series: SvrSelectedSeries;
  seriesIndex: number;
  manifest: SeriesFrameManifest;
  svrParams: SvrParams;
  acceptedTransform?: SvrPatientTransform;
  maxIntensitySamples: number;
  signal?: AbortSignal;
  onProgress?: (p: SvrProgress) => void;
  progressBase: { current: number; total: number };
  debug?: boolean;
}): Promise<{ slices: LoadedSlice[]; intensitySamples: number[] }> {
  const { series, seriesIndex, manifest, maxIntensitySamples, signal, onProgress, progressBase, debug } = params;
  const { sliceDownsampleMode, sliceDownsampleMaxSize, targetVoxelSizeMm } = params.svrParams;

  const slices: LoadedSlice[] = [];

  // Deterministic sampling for robust global normalization.
  const intensitySamples: number[] = [];
  let intensityApproxMin = Number.POSITIVE_INFINITY;
  let intensityApproxMax = Number.NEGATIVE_INFINITY;
  let acquiredPixelCount = 0;

  const perSliceTarget = Math.max(64, Math.ceil(maxIntensitySamples / Math.max(1, manifest.frames.length)));

  const resampleKernel = getSvrSliceResampleKernel(debug);
  debugSvrLog(
    'slice.downsample',
    {
      seriesIndex,
      kernel: resampleKernel,
    },
    !!debug,
  );

  type PrefetchedImage =
    | { ok: true; image: Awaited<ReturnType<typeof loadCornerstoneImage>> }
    | { ok: false; error: unknown };
  const maximumWorkers =
    typeof navigator === 'undefined'
      ? 1
      : Math.max(1, Math.min(SVR_SOURCE_PREFETCH_LIMIT, navigator.hardwareConcurrency || 1));
  const prefetchedImages: Array<Promise<PrefetchedImage>> = [];
  let nextImageIndex = 0;
  const prefetchNextImage = () => {
    if (signal?.aborted || nextImageIndex >= manifest.frames.length) return;

    const frame = manifest.frames[nextImageIndex++]!;
    // Reuse existing display images without inserting processing frames: this
    // bounded queue and the current conversion own new decoded source images.
    // Settling failures here also prevents an unconsumed prefetched rejection
    // from escaping after an earlier image fails or reconstruction is aborted.
    prefetchedImages.push(
      Promise.resolve()
        .then(() => {
          assertNotAborted(signal);
          return loadCornerstoneImage(`miradb:${frame.sopInstanceUid}`, { cache: 'reuse-only' });
        })
        .then(
          (image): PrefetchedImage => ({ ok: true, image }),
          (error: unknown): PrefetchedImage => ({ ok: false, error }),
        ),
    );
  };

  while (prefetchedImages.length < maximumWorkers && nextImageIndex < manifest.frames.length) {
    prefetchNextImage();
  }

  for (let i = 0; i < manifest.frames.length; i++) {
    assertNotAborted(signal);

    const inst = manifest.frames[i]!;
    const sopInstanceUid = inst.sopInstanceUid;

    const sliceThicknessMm =
      typeof inst.sliceThickness === 'number' && inst.sliceThickness > 0 ? inst.sliceThickness : null;
    const spacingBetweenSlicesMm =
      typeof inst.spacingBetweenSlices === 'number' && inst.spacingBetweenSlices > 0 ? inst.spacingBetweenSlices : null;

    const geom: SliceGeometry = getSliceGeometryFromInstance(inst);

    const crop = params.svrParams.roi
      ? getSvrSourceCropWindow(inst, params.svrParams.roi, params.svrParams, params.acceptedTransform)
      : null;
    const { dsRows, dsCols } = crop
      ? { dsRows: crop.rows, dsCols: crop.columns }
      : computeSvrDownsampleSize({
          rows: geom.rows,
          cols: geom.cols,
          maxSize: sliceDownsampleMaxSize,
          mode: sliceDownsampleMode,
          rowSpacingMm: geom.rowSpacingMm,
          colSpacingMm: geom.colSpacingMm,
          targetVoxelSizeMm,
        });

    // Adjust spacings for the downsampled grid (physical FOV preserved).
    const rowSpacingDsMm = crop ? geom.rowSpacingMm : geom.rowSpacingMm * (geom.rows / dsRows);
    const colSpacingDsMm = crop ? geom.colSpacingMm : geom.colSpacingMm * (geom.cols / dsCols);

    // Decode pixels via Cornerstone (uses our miradb: loader + codecs).
    const prefetchedImage = await prefetchedImages.shift()!;
    assertNotAborted(signal);
    if (!prefetchedImage.ok) throw prefetchedImage.error;
    const image = prefetchedImage.image as unknown as Parameters<typeof decodeImageWithValidity>[0];
    if ((image.rows ?? image.height) !== geom.rows || (image.columns ?? image.width) !== geom.cols) {
      throw new Error('A decoded SVR source frame no longer matches its admitted image dimensions');
    }
    prefetchNextImage();

    // Higher-fidelity downsampling (anti-aliasing) to reduce aliasing.
    // Default is box/area averaging; Lanczos is available behind a debug flag.
    // Apply modality scaling when available. (Linear, so applying post-downsample is equivalent.)
    const decoded = decodeImageWithValidity(
      image,
      crop ? geom.rows : dsRows,
      crop ? geom.cols : dsCols,
      resampleKernel,
    );
    const down = crop ? new Float32Array(dsRows * dsCols) : decoded.pixels;
    const valid = new Uint8Array(down.length);
    for (let row = 0; row < dsRows; row++)
      for (let column = 0; column < dsCols; column++) {
        const p = row * dsCols + column;
        const source = crop ? (row + crop.rowStart) * geom.cols + column + crop.columnStart : p;
        if (crop) down[p] = decoded.pixels[source]!;
        const support = decoded.validity[source]!;
        valid[p] = support > 0 ? Math.max(1, Math.min(255, Math.round(support * 255))) : 0;
        if (valid[p]) acquiredPixelCount++;
      }

    // Sample intensities deterministically for robust global normalization.
    if (intensitySamples.length < maxIntensitySamples) {
      const stride = Math.max(1, Math.floor(down.length / perSliceTarget));
      for (let p = 0; p < down.length && intensitySamples.length < maxIntensitySamples; p += stride) {
        let acquiredIndex = p;
        const sampleLimit = Math.min(p + stride, down.length);
        while (acquiredIndex < sampleLimit && !valid[acquiredIndex]) acquiredIndex++;
        if (acquiredIndex === sampleLimit) continue;
        const v = down[acquiredIndex] ?? 0;
        if (!Number.isFinite(v)) continue;
        intensitySamples.push(v);
        if (v < intensityApproxMin) intensityApproxMin = v;
        if (v > intensityApproxMax) intensityApproxMax = v;
      }
    }

    slices.push({
      seriesUid: series.seriesUid,
      sopInstanceUid,
      pixels: down,
      valid,
      validScale: 255,
      dsRows,
      dsCols,
      srcRows: geom.rows,
      srcCols: geom.cols,
      rowSpacingMm: geom.rowSpacingMm,
      colSpacingMm: geom.colSpacingMm,
      sliceThicknessMm,
      spacingBetweenSlicesMm,
      ippMm: crop?.originMm ?? downsampledSliceOriginMm(geom, dsRows, dsCols),
      rowDir: geom.rowDir,
      colDir: geom.colDir,
      normalDir: geom.normalDir,
      rowSpacingDsMm,
      colSpacingDsMm,
      frameOfReferenceUid: inst.frameOfReferenceUid,
    });

    if (i % 8 === 0 || i === manifest.frames.length - 1) {
      const completed = progressBase.current + i + 1;
      onProgress?.({
        phase: 'loading',
        current:
          DECODE_PROGRESS_START +
          Math.round(((DECODE_PROGRESS_END - DECODE_PROGRESS_START) * completed) / Math.max(1, progressBase.total)),
        total: 100,
        message: `Decoding slices (${series.label}) ${i + 1}/${manifest.frames.length}`,
      });
      await yieldToMain();
    }
  }

  if (acquiredPixelCount === 0) {
    throw new Error('An SVR source contains no acquired image pixels');
  }

  if (debug && slices.length > 0) {
    const s0 = slices[0];
    const n0 = s0.normalDir;

    let minAbsNDot = 1;
    const along: number[] = [];

    for (const s of slices) {
      const n = s.normalDir;
      const absDot = Math.abs(dot(n, n0));
      if (absDot < minAbsNDot) minAbsNDot = absDot;

      // Use the normal from the first slice to compute approximate slice-to-slice spacing.
      along.push(dot(s.ippMm, n0));
    }

    along.sort((a, b) => a - b);
    const deltas: number[] = [];
    for (let i = 0; i < along.length - 1; i++) {
      const d = Math.abs((along[i + 1] ?? 0) - (along[i] ?? 0));
      if (Number.isFinite(d) && d > 0) deltas.push(d);
    }
    deltas.sort((a, b) => a - b);
    const sliceSpacingMm = deltas.length
      ? deltas.length % 2 === 1
        ? deltas[Math.floor(deltas.length / 2)]
        : ((deltas[deltas.length / 2 - 1] ?? 0) + (deltas[deltas.length / 2] ?? 0)) / 2
      : null;

    const median = (values: Array<number | null>): number | null => {
      const v = values
        .filter((x) => typeof x === 'number' && Number.isFinite(x))
        .sort((a, b) => (a as number) - (b as number));
      if (v.length === 0) return null;
      const mid = Math.floor(v.length / 2);
      return v.length % 2 === 1 ? (v[mid] as number) : ((v[mid - 1] as number) + (v[mid] as number)) / 2;
    };

    const sliceThicknessMedianMm = median(slices.map((s) => s.sliceThicknessMm));
    const spacingBetweenSlicesMedianMm = median(slices.map((s) => s.spacingBetweenSlicesMm));

    debugSvrLog(
      'series.loaded',
      {
        seriesIndex,
        loadedSlices: slices.length,
        srcRows: s0.srcRows,
        srcCols: s0.srcCols,
        dsRows: s0.dsRows,
        dsCols: s0.dsCols,
        rowSpacingMm: s0.rowSpacingMm,
        colSpacingMm: s0.colSpacingMm,
        rowSpacingDsMm: s0.rowSpacingDsMm,
        colSpacingDsMm: s0.colSpacingDsMm,
        approxSliceSpacingMm: sliceSpacingMm,
        sliceThicknessMedianMm,
        spacingBetweenSlicesMedianMm,
        normalConsistencyMinAbsDot: Number(minAbsNDot.toFixed(6)),
        intensityApprox: {
          min: Number.isFinite(intensityApproxMin) ? Number(intensityApproxMin.toFixed(4)) : null,
          max: Number.isFinite(intensityApproxMax) ? Number(intensityApproxMax.toFixed(4)) : null,
          samples: intensitySamples.length,
        },
      },
      true,
    );

    if (minAbsNDot < 0.999) {
      console.warn('[svr] Inconsistent slice normals detected within a series (oblique drift?)', {
        seriesIndex,
        minAbsDot: minAbsNDot,
      });
    }
  }

  return { slices, intensitySamples };
}

/**
 * Runs the SVR compute phase (svrComputeCore.ts), preferring a dedicated Web
 * Worker so the minutes-long solve doesn't compete with the UI thread.
 *
 * Fallback: when `Worker` is unavailable (vitest/jsdom) or construction throws,
 * we call computeSvrFromLoadedSlices inline — the exact function the worker
 * runs — so both paths produce identical results and tests exercise the real
 * compute code without a worker runtime.
 */
async function runSvrComputePhase(params: {
  payload: SvrComputePayload;
  signal?: AbortSignal;
  onProgress?: (p: SvrProgress) => void;
}): Promise<SvrComputeResult> {
  const { payload, signal, onProgress } = params;

  assertNotAborted(signal);

  if (typeof Worker !== 'undefined') {
    let worker: Worker | null = null;
    try {
      // This exact `new Worker(new URL('./...', import.meta.url), { type: 'module' })`
      // shape is what Vite statically detects to emit the worker as its own chunk.
      worker = new Worker(new URL('./svrCompute.worker.ts', import.meta.url), { type: 'module' });
    } catch {
      // Some environments define Worker but can't actually construct module
      // workers; degrade to the inline path below.
      worker = null;
    }

    if (worker) {
      return runSvrComputeInWorker({ worker, payload, signal, onProgress });
    }
  }

  return computeSvrFromLoadedSlices({ ...payload, signal, onProgress });
}

/**
 * Drives one single-shot compute worker through the run/progress/done protocol
 * (see svrCompute.worker.ts). Owns the worker's lifetime: every exit path —
 * done, error, abort — terminate()s it so its heap (transferred slice buffers,
 * solver scratch) is reclaimed immediately.
 */
function runSvrComputeInWorker(params: {
  worker: Worker;
  payload: SvrComputePayload;
  signal?: AbortSignal;
  onProgress?: (p: SvrProgress) => void;
}): Promise<SvrComputeResult> {
  const { worker, payload, signal, onProgress } = params;

  return new Promise<SvrComputeResult>((resolve, reject) => {
    let settled = false;

    // Single funnel for resolution: detach the abort listener, kill the
    // worker, then settle. Guards against double-settling (e.g. an 'abort'
    // racing a 'done' message already in the queue).
    const settle = (outcome: () => void): void => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener('abort', onAbort);
      worker.terminate();
      outcome();
    };

    const onAbort = (): void => {
      // Best-effort cooperative cancel: the worker observes the abort at its
      // next yieldToMain() gap. We don't wait for it — terminate() in settle()
      // guarantees the compute stops even mid-loop — and we reject with the
      // same Error message assertNotAborted throws, so callers can't tell the
      // worker path from the inline path.
      try {
        worker.postMessage({ type: 'abort' } satisfies SvrComputeWorkerRequest);
      } catch {
        // Worker may already be unusable; terminate() below handles it.
      }
      settle(() => reject(new Error('SVR cancelled')));
    };

    worker.onmessage = (ev: MessageEvent) => {
      const msg = ev.data as SvrComputeWorkerResponse;

      if (msg.type === 'progress') {
        if (!settled) onProgress?.(msg.progress);
        return;
      }

      if (msg.type === 'done') {
        const { type: _type, ...result } = msg;
        void _type;
        settle(() => resolve(result));
        return;
      }

      settle(() => reject(new Error(msg.message)));
    };

    // Worker-level failure (script failed to load/parse, uncaught throw outside
    // the protocol). No inline fallback is possible at this point: the slice
    // buffers were already transferred away, so surface the failure instead.
    worker.onerror = (ev: ErrorEvent) => {
      settle(() => reject(new Error(ev.message || 'SVR compute worker failed')));
    };

    signal?.addEventListener('abort', onAbort);
    if (signal?.aborted) {
      onAbort();
      return;
    }

    // Transfer (not copy) every slice's pixel and acquired-support buffers into the worker. The
    // main-side Float32Arrays become detached, which is fine: only the compute
    // phase needs them from here on, and the caller clears `allSlices` right
    // after. Dedupe defensively — transferring the same ArrayBuffer twice in
    // one transfer list is a DataCloneError.
    const transfer: Transferable[] = [];
    const seen = new Set<ArrayBuffer>();
    for (const s of payload.allSlices) {
      for (const source of [s.pixels, s.valid]) {
        if (!source) continue;
        const buf = source.buffer as ArrayBuffer;
        if (seen.has(buf)) continue;
        seen.add(buf);
        transfer.push(buf);
      }
    }

    try {
      worker.postMessage({ type: 'run', payload } satisfies SvrComputeWorkerRequest, transfer);
    } catch (err) {
      // e.g. DataCloneError. Buffers may already be partially detached, so an
      // inline fallback would compute on garbage — fail the reconstruction.
      settle(() => reject(err instanceof Error ? err : new Error(String(err))));
    }
  });
}

export async function reconstructVolumeMultiPlane(params: {
  selectedSeries: SvrSelectedSeries[];
  svrParams: SvrParams;
  signal?: AbortSignal;
  onProgress?: (p: SvrProgress) => void;
  acceptedProvenance?: SvrSourceProvenance;
  retainedBytes?: number;
  /** Source-only loading within an already admitted operation; never a general reconstruction override. */
  nativeContextBudgetBytes?: number;
}): Promise<SvrResult> {
  const { selectedSeries, svrParams, signal, onProgress } = params;
  if (!selectedSeries.length) throw new Error('Select a source series to open its volume.');

  const t0 = performance.now();
  onProgress?.({ phase: 'loading', current: 0, total: 100, message: 'Validating source examinations…' });

  const [datasetRevision, selectedPatientKey] = await Promise.all([getDatasetRevision(), getSelectedPatientKey()]);
  const canonicalSeries = await admitSvrSeries(selectedSeries, selectedPatientKey, signal);
  const manifests = await hydrateSvrAcquisitionMetadata(
    canonicalSeries.map((source) => source.manifest),
    { signal, datasetRevision, selectedPatientKey },
  );
  canonicalSeries.forEach((source, index) => {
    source.manifest = manifests[index]!;
  });
  await assertSvrIdentityUnchanged(datasetRevision, selectedPatientKey, 'while validating SVR sources');
  const classification = classifySvrAcquisitions(manifests);
  if (classification.mode === 'conflicting') throw new Error(classification.explanation);
  const first = canonicalSeries[0]!;
  const accepted = params.acceptedProvenance;
  if (
    accepted &&
    (accepted.datasetRevision !== datasetRevision ||
      accepted.patientKey !== first.manifest.patientKey ||
      accepted.studyUid !== first.manifest.studyUid ||
      accepted.frameOfReferenceUid !== first.manifest.frameOfReferenceUid ||
      accepted.sources.some(
        (prior) => !canonicalSeries.some((source) => prior.seriesUid === source.series.seriesUid),
      ) ||
      (classification.mode === 'independent-2d' &&
        classification.eligibleIndependentSources.some(
          (source) => !accepted.sources.some((prior) => prior.seriesUid === source.seriesUid),
        )))
  ) {
    throw new Error(
      'The accepted source geometry no longer matches this examination. Reopen the volume before refining.',
    );
  }
  if (
    params.nativeContextBudgetBytes !== undefined &&
    (!Number.isSafeInteger(params.nativeContextBudgetBytes) ||
      params.nativeContextBudgetBytes <= 0 ||
      !accepted ||
      accepted.mode === 'independent-2d' ||
      classification.mode === 'independent-2d' ||
      !svrParams.roi)
  )
    throw new Error('An explicit budget requires a valid accepted native source context and exact region.');
  const acceptedSourceTransforms = accepted
    ? Object.fromEntries(
        accepted.sources.map((source) => [source.seriesUid, snapshotPatientTransform(source.transform)]),
      )
    : undefined;
  const provenance = (
    mode: SvrSourceProvenance['mode'],
    primarySeriesUid: string,
    fingerprint: string,
    transforms: Record<string, SvrPatientTransform>,
    contributing: Record<string, readonly string[]>,
  ): SvrSourceProvenance =>
    Object.freeze({
      mode,
      datasetRevision,
      patientKey: first.manifest.patientKey,
      studyUid: first.manifest.studyUid,
      frameOfReferenceUid: first.manifest.frameOfReferenceUid!,
      primarySeriesUid,
      fingerprint,
      explanation: classification.explanation,
      sources: Object.freeze(
        canonicalSeries.flatMap(({ series, manifest }) => {
          if (!Object.hasOwn(transforms, series.seriesUid)) return [];
          const kind = classification.sources.find((source) => source.seriesUid === series.seriesUid)?.kind;
          return [
            Object.freeze({
              seriesUid: series.seriesUid,
              label: series.label,
              kind: kind === 'conflicting' || !kind ? 'unknown' : kind,
              transform: snapshotPatientTransform(transforms[series.seriesUid] ?? IDENTITY_PATIENT_TRANSFORM),
              contributingSopInstanceUids: Object.freeze([...(contributing[series.seriesUid] ?? [])]),
              frames: Object.freeze(
                manifest.frames.map((frame) => {
                  const geometry = getSliceGeometryFromInstance(frame);
                  return Object.freeze({
                    sopInstanceUid: frame.sopInstanceUid,
                    rows: frame.rows,
                    columns: frame.columns,
                    originMm: Object.freeze([geometry.ippMm.x, geometry.ippMm.y, geometry.ippMm.z] as const),
                    columnDirection: Object.freeze([geometry.rowDir.x, geometry.rowDir.y, geometry.rowDir.z] as const),
                    rowDirection: Object.freeze([geometry.colDir.x, geometry.colDir.y, geometry.colDir.z] as const),
                    pixelSpacingMm: Object.freeze([geometry.rowSpacingMm, geometry.colSpacingMm] as const),
                    windowCenter: frame.windowCenter,
                    windowWidth: frame.windowWidth,
                  });
                }),
              ),
            }),
          ];
        }),
      ),
    });
  if (classification.mode !== 'independent-2d') {
    const primary =
      canonicalSeries.find((source) => source.series.seriesUid === classification.primaryOriginal3d?.seriesUid) ??
      first;
    const references = nativeReferenceSources(manifests, primary.manifest);
    const decodedCacheBytes = measureCornerstoneImageMemory(cornerstone).bytes;
    const transform = acceptedSourceTransforms?.[primary.series.seriesUid] ?? IDENTITY_PATIENT_TRANSFORM;
    const plan = planNativeVolume(primary.manifest, svrParams, {
      retainedBytes: params.retainedBytes,
      decodedCacheBytes,
      transform,
      nativePlaneBytes: nativePlaneMemoryBytes(references),
      budgetBytes: params.nativeContextBudgetBytes,
    });
    const contributing: string[] = [];
    const volume = await assembleNativeVolume(
      plan,
      async (frame) => {
        // Cornerstone loadImage reuses an existing cache entry, but unlike
        // loadAndCacheImage it does not retain every streamed processing frame.
        const image = await cornerstone.loadImage(`miradb:${frame.sopInstanceUid}`);
        assertNotAborted(signal);
        if ((image.rows ?? image.height) !== frame.rows || (image.columns ?? image.width) !== frame.columns)
          throw new Error('A native source frame changed its accepted pixel dimensions.');
        contributing.push(frame.sopInstanceUid);
        const paddingImage = image as typeof image & { pixelPaddingValue?: number; pixelPaddingRangeLimit?: number };
        return {
          pixels: image.getPixelData(),
          slope: image.slope,
          intercept: image.intercept,
          pixelPaddingValue: paddingImage.pixelPaddingValue ?? frame.pixelPaddingValue,
          pixelPaddingRangeLimit: paddingImage.pixelPaddingRangeLimit ?? frame.pixelPaddingRangeLimit,
          invert: image.invert,
        };
      },
      {
        signal,
        onProgress: (current, total) =>
          onProgress?.({
            phase: 'loading',
            current: 5 + Math.round((90 * current) / total),
            total: 100,
            message: plan.overview ? 'Loading native-volume overview…' : 'Loading original source pixels…',
          }),
      },
    );
    await assertSvrIdentityUnchanged(datasetRevision, selectedPatientKey, 'during native volume loading');
    let hash = 2166136261;
    const identity = JSON.stringify([
      datasetRevision,
      primary.series.seriesUid,
      contributing,
      plan.dims,
      plan.originMm,
      plan.direction,
      plan.voxelSizeMm,
      transform,
    ]);
    for (let index = 0; index < identity.length; index++) hash = Math.imul(hash ^ identity.charCodeAt(index), 16777619);
    const fingerprint = `native-v1-${(hash >>> 0).toString(16)}`;
    volume.reconstructionFingerprint = fingerprint;
    volume.sourceProvenance = provenance(
      classification.mode === 'native-3d' ? 'native-3d' : 'source-stack',
      primary.series.seriesUid,
      fingerprint,
      Object.fromEntries(references.map((source) => [source.seriesUid, transform])),
      { [primary.series.seriesUid]: contributing },
    );
    onProgress?.({ phase: 'finalizing', current: 100, total: 100, message: 'Native source volume ready' });
    return { volume, parameters: svrParams };
  }
  const contributingSeries = canonicalSeries.filter((source) =>
    classification.eligibleIndependentSources.some((manifest) => manifest.seriesUid === source.series.seriesUid),
  );
  const admittedSeries = contributingSeries.map((source, sourceIndex) => {
    assertNotAborted(signal);
    const manifest = filterSvrManifestFramesForRoi(
      source.manifest,
      svrParams.roi,
      svrParams,
      acceptedSourceTransforms?.[source.series.seriesUid],
    );
    if (manifest.frames.length === 0) {
      throw new Error(`The SVR focus region does not intersect acquired frames from source ${sourceIndex + 1}`);
    }
    return manifest === source.manifest ? source : { ...source, manifest };
  });
  const cacheMemory = measureCornerstoneImageMemory(cornerstone);
  const sourceMemory = estimateSvrSourceMemory(
    contributingSeries.map((source) => source.manifest),
    svrParams,
    { cacheMemory, acceptedSourceTransforms },
  );
  const nativePlaneBytes = nativePlaneMemoryBytes(contributingSeries.map((source) => source.manifest));
  const sourceResidentFloor =
    sourceMemory.sourceBytes +
    sourceMemory.decodedSourceCacheBytes +
    sourceMemory.sourceDecodeBytes +
    (params.retainedBytes ?? 0) +
    nativePlaneBytes;
  if (sourceResidentFloor > SVR_MEMORY_BUDGET_BYTES)
    throw new Error(
      `SVR source inputs alone require an estimated ${formatMiB(sourceResidentFloor)}, exceeding the ${formatMiB(SVR_MEMORY_BUDGET_BYTES)} browser memory budget before decoding. Select a smaller focus region or clear the previous volume.`,
    );
  onProgress?.({ phase: 'loading', current: DECODE_PROGRESS_START, total: 100, message: 'Loading acquired slices…' });

  const allSlices: LoadedSlice[] = [];

  // Intensity normalization samples (global across all selected series).
  const intensitySamples: number[] = [];

  const decodeTotal = admittedSeries.reduce((acc, { manifest }) => acc + manifest.frames.length, 0);
  let decodeBase = 0;

  const debug = isDebugSvrEnabled();

  if (!debug) {
    console.info("[svr] Tip: enable verbose SVR logs with localStorage.setItem('miraviewer:debug-svr', '1')");
  }

  console.info('[svr] Reconstruction started', {
    seriesCount: selectedSeries.length,
    roi: svrParams.roi ? { mode: svrParams.roi.mode, sourcePlane: svrParams.roi.sourcePlane } : null,
    seriesRegistrationMode: svrParams.seriesRegistrationMode,
    voxelSizeMm: svrParams.targetVoxelSizeMm,
    maxVolumeDim: svrParams.maxVolumeDim,
    sliceDownsampleMode: svrParams.sliceDownsampleMode,
    sliceDownsampleMaxSize: svrParams.sliceDownsampleMaxSize,
    iterations: svrParams.iterations,
    stepSize: svrParams.stepSize,
  });

  if (debug) {
    try {
      const cacheInfo = cornerstone.imageCache?.getCacheInfo?.();
      debugSvrLog('cornerstone.imageCache', { when: 'svr-start', cacheInfo }, debug);
    } catch {
      // Ignore.
    }
  }

  const MAX_INTENSITY_SAMPLES_TOTAL = 50_000;
  const maxIntensitySamplesPerSeries = Math.max(
    2048,
    Math.ceil(MAX_INTENSITY_SAMPLES_TOTAL / Math.max(1, selectedSeries.length)),
  );

  for (const [seriesIndex, { series, manifest }] of admittedSeries.entries()) {
    assertNotAborted(signal);

    const loaded = await loadSeriesSlices({
      series,
      seriesIndex: seriesIndex + 1,
      manifest,
      svrParams,
      acceptedTransform: acceptedSourceTransforms?.[series.seriesUid],
      maxIntensitySamples: maxIntensitySamplesPerSeries,
      signal,
      onProgress,
      progressBase: { current: decodeBase, total: decodeTotal },
      debug,
    });

    const slices = loaded.slices;
    const seriesSamples = loaded.intensitySamples;

    if (slices.length > 0) {
      const s0 = slices[0];
      console.info('[svr] Series decoded', {
        seriesIndex: seriesIndex + 1,
        loadedSlices: slices.length,
        srcRows: s0.srcRows,
        srcCols: s0.srcCols,
        dsRows: s0.dsRows,
        dsCols: s0.dsCols,
        rowSpacingMm: Number(s0.rowSpacingMm.toFixed(4)),
        colSpacingMm: Number(s0.colSpacingMm.toFixed(4)),
        rowSpacingDsMm: Number(s0.rowSpacingDsMm.toFixed(4)),
        colSpacingDsMm: Number(s0.colSpacingDsMm.toFixed(4)),
      });
    }

    decodeBase += manifest.frames.length;
    allSlices.push(...slices);

    for (const v of seriesSamples) {
      intensitySamples.push(v);
    }

    await yieldToMain();
  }

  if (allSlices.length === 0) {
    throw new Error('No slices loaded for SVR');
  }
  await assertSvrIdentityUnchanged(datasetRevision, selectedPatientKey, 'during SVR decoding');

  if (debug) {
    const sliceBytes = allSlices.reduce((acc, s) => acc + (s.pixels?.byteLength ?? 0), 0);
    debugSvrLog(
      'slices.bytes',
      {
        when: 'after-decode',
        slices: allSlices.length,
        pixelsMiB: Number((sliceBytes / (1024 * 1024)).toFixed(1)),
      },
      debug,
    );

    try {
      const cacheInfo = cornerstone.imageCache?.getCacheInfo?.();
      debugSvrLog('cornerstone.imageCache', { when: 'after-decode', cacheInfo }, debug);
    } catch {
      // Ignore.
    }
  }

  // ---- Compute phase (worker boundary) -------------------------------------
  //
  // Everything between "slices are decoded" and "the fused volume exists" is
  // pure typed-array compute with no DOM dependency, so we run it in a
  // dedicated Web Worker when possible: even with cooperative yieldToMain()
  // gaps, the solver's hot loops compete with input/rendering on the main
  // thread. Decoding (above) needs cornerstone/IndexedDB, so it stays on the
  // main thread ahead of the boundary.
  //
  // Only clone-safe pixel evidence and source identity cross the boundary;
  // SvrSelectedSeries display metadata stays main-side (the compute phase needs
  // physical slices, not free-text labels or duplicate source counts).
  // The processing batch is gone; remeasure cache/display owners without
  // charging the bounded decoding phase again during reconstruction.
  const residentCacheBytes = Math.max(
    sourceMemory.decodedSourceCacheBytes,
    measureCornerstoneImageMemory(cornerstone).bytes,
  );

  const computed = await runSvrComputePhase({
    payload: {
      allSlices,
      intensitySamples,
      svrParams,
      residentCacheBytes,
      retainedBytes: params.retainedBytes,
      nativePlaneBytes,
      acceptedSourceTransforms,
      debug,
    },
    signal,
    onProgress,
  });
  await assertSvrIdentityUnchanged(datasetRevision, selectedPatientKey, 'during SVR reconstruction');

  // The compute phase consumed the slice stack: the inline path empties the
  // array itself once the solver is done, and in the worker path the pixel
  // buffers were transferred away (detached) at postMessage time. Clearing
  // again here is idempotent and drops the (tiny) main-side slice metadata
  // objects before result assembly.
  allSlices.length = 0;

  const {
    volume,
    dims,
    originMm,
    voxelSizeMm,
    bounds,
    sourceTransforms,
    contributingSopInstanceUids,
    ...acquisitionEvidence
  } = computed;

  onProgress?.({
    phase: 'finalizing',
    current: 100,
    total: 100,
    message: `Done (${Math.round(performance.now() - t0)}ms)`,
  });

  return {
    parameters: svrParams,
    volume: {
      data: volume,
      ...acquisitionEvidence,
      sourceProvenance: provenance(
        'independent-2d',
        svrParams.roi?.sourceSeriesUid ?? admittedSeries[0]!.series.seriesUid,
        computed.reconstructionFingerprint,
        sourceTransforms,
        contributingSopInstanceUids,
      ),
      effectiveResolutionMm: acquisitionEvidence.effectiveResolutionMm,
      dims: [dims.nx, dims.ny, dims.nz],
      voxelSizeMm: [voxelSizeMm, voxelSizeMm, voxelSizeMm],
      originMm: [originMm.x, originMm.y, originMm.z],
      boundsMm: {
        min: [bounds.min.x, bounds.min.y, bounds.min.z],
        max: [bounds.max.x, bounds.max.y, bounds.max.z],
      },
    },
  };
}
