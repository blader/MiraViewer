import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type * as Ort from 'onnxruntime-web';
import cornerstone from 'cornerstone-core';
import type { SvrLabelVolume, SvrVolume } from '../types/svr';
import { BRATS_BASE_LABEL_META } from '../utils/segmentation/brats';
import { deleteModelBlobs, getModelBlob, getModelRecord, putModelBlobs } from '../utils/segmentation/onnx/modelCache';
import {
  TUMOR_MODEL_MANIFEST_EXAMPLE,
  verifyTumorModelManifest,
  type TumorModelManifest,
} from '../utils/segmentation/onnx/modelManifest';
import { createOrtSessionFromModelBlob } from '../utils/segmentation/onnx/ortLoader';
import { runTumorSegmentationOnnx } from '../utils/segmentation/onnx/tumorSegmentation';
import { assertTumorModelGrid, prepareTumorModelInput } from '../utils/segmentation/onnx/volumeInput';
import { formatMiB } from '../utils/svr/svrUtils';
import { estimateSvrPeakMemoryBytes, SVR_MEMORY_BUDGET_BYTES } from '../utils/svr/svrMemoryPlan';
import { CORNERSTONE_MEMORY_FALLBACK_BYTES, measureCornerstoneImageMemory } from '../utils/cornerstoneMemory';
import { nativePlaneMemoryBytes, retainedSvrVolumeBytes } from '../utils/svr/nativeVolume';

const ONNX_TUMOR_MODEL_KEY = 'brats-tumor-v1';
const ONNX_TUMOR_MANIFEST_KEY = `${ONNX_TUMOR_MODEL_KEY}:manifest`;
const ONNX_PREFLIGHT_CLASS_COUNT = TUMOR_MODEL_MANIFEST_EXAMPLE.classes.length;

type OnnxSessionMode = 'webgpu-preferred' | 'wasm';
type VerifiedOnnxSession = { session: Ort.InferenceSession; mode: OnnxSessionMode; manifest: TumorModelManifest };

export type OnnxStatus = {
  cached: boolean;
  verified: boolean;
  savedAtMs: number | null;
  loading: boolean;
  sessionReady: boolean;
  message?: string;
  error?: string;
};

export type OnnxPreflight = {
  nx: number;
  ny: number;
  nz: number;
  nvox: number;
  logitsBytes: number;
  inputBytes: number;
  preprocessingBytes: number;
  readyResidentBytes: number;
  estimatedPeakBytes: number;
  budgetBytes: number;
  blockedByDefault: boolean;
};

export type UseOnnxTumorSession = {
  status: OnnxStatus;
  preflight: OnnxPreflight | null;
  segRunning: boolean;
  allowUnsafeFullRes: boolean;
  setAllowUnsafeFullRes: (v: boolean) => void;
  fileInputRef: React.RefObject<HTMLInputElement | null>;
  uploadClick: () => void;
  handleSelectedFiles: (files: File[]) => void;
  clearModel: () => void;
  initSession: () => void;
  runSegmentation: () => void;
  cancelSegmentation: () => void;
  /** Release an idle runtime without deleting its verified cached model. */
  releaseIdleSession: () => Promise<void>;
};

export function useOnnxTumorSession(
  volume: SvrVolume | null,
  onLabels: (labels: SvrLabelVolume) => void,
): UseOnnxTumorSession {
  const sessionRef = useRef<VerifiedOnnxSession | null>(null);
  const sessionPromiseRef = useRef<Promise<VerifiedOnnxSession> | null>(null);
  const sessionReleaseRef = useRef<Promise<void> | null>(null);
  const modelGenerationRef = useRef(0);
  const modelWriteAbortRef = useRef<AbortController | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const releaseRuntime = useCallback((session: Ort.InferenceSession, reason: string) => {
    const pending = Promise.all([sessionReleaseRef.current, Promise.resolve().then(() => session.release())]).then(
      () => undefined,
    );
    sessionReleaseRef.current = pending;
    void pending.then(
      () => {
        if (sessionReleaseRef.current === pending) sessionReleaseRef.current = null;
      },
      (error) => {
        // Failed cleanup remains a live admission barrier, not a zero-byte owner.
        console.warn('[onnx] Failed to release session', { reason, error });
      },
    );
    return pending;
  }, []);

  const releaseSession = useCallback(
    (reason: string) => {
      modelGenerationRef.current++;
      modelWriteAbortRef.current?.abort();
      modelWriteAbortRef.current = null;
      // A superseded initializer still owns runtime memory until it actually settles.
      const session = sessionRef.current?.session;
      sessionRef.current = null;

      return session ? releaseRuntime(session, reason) : (sessionReleaseRef.current ?? Promise.resolve());
    },
    [releaseRuntime],
  );

  useEffect(() => {
    return () => {
      void releaseSession('unmount');
    };
  }, [releaseSession]);

  const [status, setStatus] = useState<OnnxStatus>(() => ({
    cached: false,
    verified: false,
    savedAtMs: null,
    loading: false,
    sessionReady: false,
  }));

  // We can't reliably abort ORT execution mid-run in the browser; cancellation just ignores late results.
  const segRunIdRef = useRef(0);
  const inferenceTaskRef = useRef<Promise<void> | null>(null);
  const [segRunning, setSegRunning] = useState(false);
  const releaseIdleSession = useCallback(async () => {
    if (sessionPromiseRef.current || inferenceTaskRef.current || modelWriteAbortRef.current)
      throw new Error(
        'Wait for the other model operation to finish before suggesting a boundary. Your marks are unchanged.',
      );
    if (!sessionRef.current) {
      if (sessionReleaseRef.current) await sessionReleaseRef.current;
      return;
    }
    const released = releaseSession('interactive-selection');
    const generation = modelGenerationRef.current;
    setStatus((current) => ({
      ...current,
      sessionReady: false,
      loading: true,
      message: 'Releasing the idle model runtime…',
    }));
    try {
      await released;
      if (modelGenerationRef.current === generation)
        setStatus((current) => ({
          ...current,
          loading: false,
          message: 'Model cached; runtime released for interactive selection.',
        }));
    } catch (error) {
      if (modelGenerationRef.current === generation)
        setStatus((current) => ({
          ...current,
          loading: false,
          error: 'The other model runtime could not release its memory. Reopen the viewer before trying again.',
        }));
      throw error;
    }
  }, [releaseSession]);
  const [unsafeFullResOverride, setUnsafeFullResOverride] = useState<{ volume: SvrVolume | null; allowed: boolean }>({
    volume: null,
    allowed: false,
  });
  const allowUnsafeFullRes = unsafeFullResOverride.volume === volume && unsafeFullResOverride.allowed;
  const setAllowUnsafeFullRes = useCallback(
    (allowed: boolean) => setUnsafeFullResOverride({ volume, allowed }),
    [volume],
  );

  // A new volume invalidates any in-flight segmentation (its labels would belong to the
  // old grid — the run-id bump makes the late result a no-op) and resets the user's
  // unsafe full-res override, which was a per-volume decision. This hook owns that state,
  // so the invalidation lives here rather than in the consuming viewer.
  useEffect(() => {
    segRunIdRef.current++;
    setSegRunning(inferenceTaskRef.current !== null);
  }, [volume]);

  const refreshCacheStatus = useCallback((operationError?: string) => {
    const generation = modelGenerationRef.current;
    return Promise.all([getModelRecord(ONNX_TUMOR_MODEL_KEY), getModelBlob(ONNX_TUMOR_MANIFEST_KEY)])
      .then(async ([record, manifest]) => {
        if (modelGenerationRef.current !== generation) return;
        if (!record?.blob || record.savedAtMs == null) {
          setStatus((s) => ({ ...s, cached: false, verified: false, savedAtMs: null, error: operationError }));
          return;
        }
        const { blob: model, savedAtMs } = record;

        try {
          await verifyTumorModelManifest(model, manifest);
          if (modelGenerationRef.current !== generation) return;
          setStatus((s) => ({ ...s, cached: true, verified: true, savedAtMs, error: operationError }));
        } catch (error) {
          if (modelGenerationRef.current !== generation) return;
          setStatus((s) => ({
            ...s,
            cached: true,
            verified: false,
            sessionReady: false,
            savedAtMs,
            error: operationError ?? (error instanceof Error ? error.message : String(error)),
          }));
        }
      })
      .catch((e) => {
        if (modelGenerationRef.current !== generation) return;
        const msg = e instanceof Error ? e.message : String(e);
        setStatus((s) => ({ ...s, verified: false, error: operationError ?? msg }));
      });
  }, []);

  useEffect(() => {
    refreshCacheStatus();
  }, [refreshCacheStatus]);

  const measurePreflight = useCallback((): OnnxPreflight | null => {
    if (!volume) return null;
    const [nx, ny, nz] = volume.dims;
    const nvox = nx * ny * nz;
    const logitsBytes = nvox * ONNX_PREFLIGHT_CLASS_COUNT * 4;
    const inputBytes = nvox * 4;
    const preprocessingBytes = nvox * 4;
    const cacheMemory = measureCornerstoneImageMemory(cornerstone);
    // Long model operations may overlap continued interactive browsing,
    // unlike the bounded non-inserting native assembly pass. Reserve remaining
    // pixel capacity once, beside all currently retained parsed/display buffers.
    const maximum = cacheMemory.cacheInfo?.maximumSizeInBytes;
    const capacity = Number.isFinite(maximum) && maximum! >= 0 ? maximum! : CORNERSTONE_MEMORY_FALLBACK_BYTES;
    const decodedCacheBytes = cacheMemory.bytes + Math.max(0, capacity - cacheMemory.reservedPixelCacheBytes);
    // The existing labels remain visible while inference builds their
    // replacement. Both overlap the immutable supported result and tensors.
    const inferencePlan = estimateSvrPeakMemoryBytes({
      phase: 'inference',
      voxelCount: 0,
      sourceBytes: 0,
      iterations: 0,
      labelBytes: nvox * Uint8Array.BYTES_PER_ELEMENT * 2,
      retainedBytes:
        retainedSvrVolumeBytes(volume) +
        decodedCacheBytes +
        nativePlaneMemoryBytes(volume.sourceProvenance?.sources ?? []),
      modelTensorBytes: preprocessingBytes + inputBytes + logitsBytes,
    });
    const readyResidentBytes = inferencePlan.totalBytes - inferencePlan.modelTensorBytes;
    const estimatedPeakBytes = inferencePlan.totalBytes;
    return {
      nx,
      ny,
      nz,
      nvox,
      logitsBytes,
      inputBytes,
      preprocessingBytes,
      readyResidentBytes,
      estimatedPeakBytes,
      budgetBytes: SVR_MEMORY_BUDGET_BYTES,
      blockedByDefault: estimatedPeakBytes > SVR_MEMORY_BUDGET_BYTES,
    };
  }, [volume]);
  const preflight = useMemo(measurePreflight, [measurePreflight]);

  const uploadClick = useCallback(() => fileInputRef.current?.click(), []);

  const clearModel = useCallback(() => {
    releaseSession('clear-model');
    const generation = modelGenerationRef.current;
    const controller = new AbortController();
    modelWriteAbortRef.current = controller;
    setStatus((s) => ({
      ...s,
      sessionReady: false,
      verified: false,
      loading: true,
      message: 'Clearing cached model…',
      error: undefined,
    }));

    void deleteModelBlobs([ONNX_TUMOR_MODEL_KEY, ONNX_TUMOR_MANIFEST_KEY], { signal: controller.signal })
      .then(() => {
        if (modelGenerationRef.current !== generation) return;
        setStatus((s) => ({ ...s, loading: false, message: 'Cleared cached model' }));
        refreshCacheStatus();
      })
      .catch(async (e) => {
        if (modelGenerationRef.current !== generation) return;
        const msg = e instanceof Error ? e.message : String(e);
        setStatus((s) => ({ ...s, error: msg }));
        await refreshCacheStatus(msg);
        if (modelGenerationRef.current === generation) setStatus((s) => ({ ...s, loading: false }));
      })
      .finally(() => {
        if (modelWriteAbortRef.current === controller) modelWriteAbortRef.current = null;
      });
  }, [refreshCacheStatus, releaseSession]);

  const handleSelectedFiles = useCallback(
    (files: File[]) => {
      const model = files.find((file) => file.name.toLowerCase().endsWith('.onnx'));
      const manifest = files.find((file) => file.name.toLowerCase().endsWith('.json'));
      if (!model) {
        setStatus((s) => ({
          ...s,
          error: 'Select an .onnx model together with its SHA-256-bound .json manifest.',
        }));
        return;
      }

      releaseSession('upload-model');
      const generation = modelGenerationRef.current;
      const controller = new AbortController();
      modelWriteAbortRef.current = controller;
      setStatus((s) => ({
        ...s,
        loading: true,
        sessionReady: false,
        message: `Verifying model: ${model.name}`,
        error: undefined,
      }));

      void (async () => {
        await verifyTumorModelManifest(model, manifest);
        if (modelGenerationRef.current !== generation) return;
        // Keep the prior pair intact until verification succeeds, then replace both
        // artifacts atomically. Abort also fences a write awaiting database access.
        await putModelBlobs(
          [
            { key: ONNX_TUMOR_MODEL_KEY, blob: model },
            { key: ONNX_TUMOR_MANIFEST_KEY, blob: manifest! },
          ],
          { signal: controller.signal },
        );
      })()
        .then(() => {
          if (modelGenerationRef.current !== generation) return;
          setStatus((s) => ({ ...s, loading: false, verified: true, message: 'Verified model and manifest cached' }));
          refreshCacheStatus();
        })
        .catch(async (e) => {
          if (modelGenerationRef.current !== generation) return;
          const msg = e instanceof Error ? e.message : String(e);
          setStatus((s) => ({ ...s, error: msg }));
          await refreshCacheStatus(msg);
          if (modelGenerationRef.current === generation) setStatus((s) => ({ ...s, loading: false }));
        })
        .finally(() => {
          if (modelWriteAbortRef.current === controller) modelWriteAbortRef.current = null;
        });
    },
    [refreshCacheStatus, releaseSession],
  );

  const ensureSession = useCallback(async (): Promise<VerifiedOnnxSession> => {
    if (sessionReleaseRef.current)
      throw new Error('Wait for the previous model runtime to release its memory before initializing another.');
    if (sessionRef.current) {
      return sessionRef.current;
    }

    if (sessionPromiseRef.current) return sessionPromiseRef.current;

    const generation = modelGenerationRef.current;
    const pending = (async (): Promise<VerifiedOnnxSession> => {
      const [blob, manifest] = await Promise.all([
        getModelBlob(ONNX_TUMOR_MODEL_KEY),
        getModelBlob(ONNX_TUMOR_MANIFEST_KEY),
      ]);
      if (modelGenerationRef.current !== generation) throw new Error('Model changed during initialization');
      if (!blob) {
        throw new Error('No cached ONNX model found. Upload one first.');
      }
      const verifiedManifest = await verifyTumorModelManifest(blob, manifest);
      if (modelGenerationRef.current !== generation) throw new Error('Model changed during initialization');

      let session: Ort.InferenceSession;
      let mode: OnnxSessionMode = 'webgpu-preferred';
      try {
        session = await createOrtSessionFromModelBlob({ model: blob, preferWebGpu: true, logLevel: 'warning' });
      } catch {
        if (modelGenerationRef.current !== generation) throw new Error('Model changed during initialization');
        session = await createOrtSessionFromModelBlob({ model: blob, preferWebGpu: false, logLevel: 'warning' });
        mode = 'wasm';
      }

      if (modelGenerationRef.current !== generation) {
        await releaseRuntime(session, 'superseded-initialization');
        throw new Error('Model changed during initialization');
      }

      const accepted = { session, mode, manifest: verifiedManifest };
      sessionRef.current = accepted;
      return accepted;
    })();

    sessionPromiseRef.current = pending;
    try {
      return await pending;
    } finally {
      if (sessionPromiseRef.current === pending) sessionPromiseRef.current = null;
    }
  }, [releaseRuntime]);

  const initSession = useCallback(() => {
    const generation = modelGenerationRef.current;
    setStatus((s) => ({ ...s, loading: true, message: 'Initializing ONNX runtime…', error: undefined }));

    void ensureSession()
      .then(({ mode }) => {
        if (modelGenerationRef.current !== generation) return;
        setStatus((s) => ({
          ...s,
          loading: false,
          sessionReady: true,
          message: mode === 'wasm' ? 'ONNX session ready (WASM)' : 'ONNX session ready (WebGPU preferred)',
        }));
      })
      .catch((e) => {
        if (modelGenerationRef.current !== generation) return;
        const msg = e instanceof Error ? e.message : String(e);
        setStatus((s) => ({ ...s, loading: false, sessionReady: false, error: msg }));
      });
  }, [ensureSession]);

  const runSegmentation = useCallback(() => {
    if (!volume) return;

    if (inferenceTaskRef.current) {
      setSegRunning(true);
      setStatus((current) => ({
        ...current,
        loading: true,
        message: 'Waiting for the previous model operation to release its memory…',
      }));
      return;
    }

    const observedSupport = volume.observedSupport;
    if (observedSupport && observedSupport.length !== volume.data.length) {
      setStatus((s) => ({
        ...s,
        loading: false,
        error: 'Cannot segment this volume: acquired-support evidence does not match its reconstructed dimensions.',
      }));
      return;
    }

    const preflight = measurePreflight();
    if (preflight?.blockedByDefault) {
      const dims = `${preflight.nx}×${preflight.ny}×${preflight.nz}`;
      const msg =
        `ONNX exceeds the shared ${formatMiB(preflight.budgetBytes)} memory budget ` +
        `(${dims}; estimated resident peak ${formatMiB(preflight.estimatedPeakBytes)}, ` +
        `including ${formatMiB(preflight.logitsBytes)} model logits). ` +
        'Reconstruct a smaller focus region or use a lower resolution.';
      setStatus((s) => ({ ...s, loading: false, error: msg }));
      return;
    }

    const runId = ++segRunIdRef.current;
    const generation = modelGenerationRef.current;
    const isCurrent = () => segRunIdRef.current === runId && modelGenerationRef.current === generation;
    setSegRunning(true);

    const started = performance.now();
    setStatus((s) => ({ ...s, loading: true, message: 'Running ONNX segmentation…', error: undefined }));

    const inferenceTask: Promise<void> = (async () => {
      try {
        const { session, mode, manifest } = await ensureSession();
        if (!isCurrent()) return;
        assertTumorModelGrid(volume, manifest);

        setStatus((s) => ({
          ...s,
          sessionReady: true,
          loading: true,
          message: `Running ONNX segmentation… (${mode === 'wasm' ? 'WASM' : 'WebGPU preferred'})${manifest.input.spatialFrame === 'source-grid' ? ' · Source-aligned input; no resampling.' : ''}`,
        }));

        const modelInput = await prepareTumorModelInput(volume, isCurrent);
        if (!isCurrent()) return;

        const res = await runTumorSegmentationOnnx({ session, volume: modelInput, dims: volume.dims });
        if (!isCurrent()) return;

        if (observedSupport) {
          for (let index = 0; index < res.labels.length; index++) {
            if (!observedSupport[index]) res.labels[index] = 0;
          }
        }

        onLabels({ data: res.labels, dims: volume.dims, meta: BRATS_BASE_LABEL_META, reviewState: 'draft' });

        const ms = Math.round(performance.now() - started);
        setStatus((s) => ({
          ...s,
          loading: false,
          sessionReady: true,
          message: `Segmentation complete (${ms}ms)${manifest.input.spatialFrame === 'source-grid' ? ' · Source-aligned model suggestion; review against original slices.' : ''}`,
        }));
      } catch (e) {
        if (!isCurrent()) return;
        const msg = e instanceof Error ? e.message : String(e);
        setStatus((s) => ({ ...s, loading: false, sessionReady: sessionRef.current !== null, error: msg }));
      } finally {
        // Admission forbids a second task until this one settles, so the
        // single in-flight ref itself is the only lifecycle authority.
        inferenceTaskRef.current = null;
        setSegRunning(false);
        if (segRunIdRef.current !== runId && modelGenerationRef.current === generation) {
          setStatus((current) => ({
            ...current,
            loading: false,
            message: 'The canceled model operation has finished and released its memory.',
          }));
        }
      }
    })();
    inferenceTaskRef.current = inferenceTask;
  }, [ensureSession, onLabels, measurePreflight, volume]);

  const cancelSegmentation = useCallback(() => {
    if (!inferenceTaskRef.current) return;
    segRunIdRef.current++;
    setStatus((s) => ({
      ...s,
      loading: true,
      message: 'Result discarded; waiting for the current model operation to release its memory…',
      error: undefined,
    }));
  }, []);

  return {
    status,
    preflight,
    segRunning,
    allowUnsafeFullRes,
    setAllowUnsafeFullRes,
    fileInputRef,
    uploadClick,
    handleSelectedFiles,
    clearModel,
    initSession,
    runSegmentation,
    cancelSegmentation,
    releaseIdleSession,
  };
}
