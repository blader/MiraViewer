import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type * as Ort from 'onnxruntime-web';
import type { SvrLabelVolume, SvrVolume } from '../types/svr';
import { BRATS_BASE_LABEL_META } from '../utils/segmentation/brats';
import { deleteModelBlob, getModelBlob, getModelRecord, putModelBlob } from '../utils/segmentation/onnx/modelCache';
import { verifyTumorModelManifest } from '../utils/segmentation/onnx/modelManifest';
import { createOrtSessionFromModelBlob } from '../utils/segmentation/onnx/ortLoader';
import { runTumorSegmentationOnnx } from '../utils/segmentation/onnx/tumorSegmentation';
import { formatMiB } from '../utils/svr/svrUtils';

const ONNX_TUMOR_MODEL_KEY = 'brats-tumor-v1';
const ONNX_TUMOR_MANIFEST_KEY = `${ONNX_TUMOR_MODEL_KEY}:manifest`;
const ONNX_PREFLIGHT_CLASS_COUNT = 4;
const ONNX_PREFLIGHT_LOGITS_BUDGET_BYTES = 384 * 1024 * 1024;

type OnnxSessionMode = 'webgpu-preferred' | 'wasm';

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
};

export function useOnnxTumorSession(
  volume: SvrVolume | null,
  onLabels: (labels: SvrLabelVolume) => void,
): UseOnnxTumorSession {
  const sessionRef = useRef<Ort.InferenceSession | null>(null);
  const sessionModeRef = useRef<OnnxSessionMode | null>(null);
  const sessionPromiseRef = useRef<Promise<{ session: Ort.InferenceSession; mode: OnnxSessionMode }> | null>(null);
  const modelGenerationRef = useRef(0);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const releaseSession = useCallback((reason: string) => {
    modelGenerationRef.current++;
    sessionPromiseRef.current = null;
    const session = sessionRef.current;
    sessionRef.current = null;
    sessionModeRef.current = null;

    if (session) {
      // Avoid leaking WebGPU/WASM resources if the user swaps/clears models.
      void session.release().catch((e) => {
        console.warn('[onnx] Failed to release session', { reason, e });
      });
    }
  }, []);

  useEffect(() => {
    return () => releaseSession('unmount');
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
  const [segRunning, setSegRunning] = useState(false);
  const [allowUnsafeFullRes, setAllowUnsafeFullRes] = useState(false);

  // A new volume invalidates any in-flight segmentation (its labels would belong to the
  // old grid — the run-id bump makes the late result a no-op) and resets the user's
  // unsafe full-res override, which was a per-volume decision. This hook owns that state,
  // so the invalidation lives here rather than in the consuming viewer.
  useEffect(() => {
    segRunIdRef.current++;
    setSegRunning(false);
    setAllowUnsafeFullRes(false);
    setStatus((s) => (s.loading ? { ...s, loading: false } : s));
  }, [volume]);

  const refreshCacheStatus = useCallback(() => {
    const generation = modelGenerationRef.current;
    void Promise.all([getModelRecord(ONNX_TUMOR_MODEL_KEY), getModelBlob(ONNX_TUMOR_MANIFEST_KEY)])
      .then(async ([record, manifest]) => {
        if (modelGenerationRef.current !== generation) return;
        if (!record?.blob || record.savedAtMs == null) {
          setStatus((s) => ({ ...s, cached: false, verified: false, savedAtMs: null, error: undefined }));
          return;
        }
        const { blob: model, savedAtMs } = record;

        try {
          await verifyTumorModelManifest(model, manifest);
          if (modelGenerationRef.current !== generation) return;
          setStatus((s) => ({ ...s, cached: true, verified: true, savedAtMs, error: undefined }));
        } catch (error) {
          if (modelGenerationRef.current !== generation) return;
          setStatus((s) => ({
            ...s,
            cached: true,
            verified: false,
            sessionReady: false,
            savedAtMs,
            error: error instanceof Error ? error.message : String(error),
          }));
        }
      })
      .catch((e) => {
        if (modelGenerationRef.current !== generation) return;
        const msg = e instanceof Error ? e.message : String(e);
        setStatus((s) => ({ ...s, verified: false, error: msg }));
      });
  }, []);

  useEffect(() => {
    refreshCacheStatus();
  }, [refreshCacheStatus]);

  const preflight = useMemo<OnnxPreflight | null>(() => {
    if (!volume) return null;
    const [nx, ny, nz] = volume.dims;
    const nvox = nx * ny * nz;
    const logitsBytes = nvox * ONNX_PREFLIGHT_CLASS_COUNT * 4;
    const inputBytes = nvox * 4;
    return {
      nx,
      ny,
      nz,
      nvox,
      logitsBytes,
      inputBytes,
      blockedByDefault: logitsBytes > ONNX_PREFLIGHT_LOGITS_BUDGET_BYTES,
    };
  }, [volume]);

  const uploadClick = useCallback(() => fileInputRef.current?.click(), []);

  const clearModel = useCallback(() => {
    releaseSession('clear-model');
    setStatus((s) => ({
      ...s,
      sessionReady: false,
      verified: false,
      loading: true,
      message: 'Clearing cached model…',
      error: undefined,
    }));

    void Promise.all([deleteModelBlob(ONNX_TUMOR_MODEL_KEY), deleteModelBlob(ONNX_TUMOR_MANIFEST_KEY)])
      .then(() => {
        setStatus((s) => ({ ...s, loading: false, message: 'Cleared cached model' }));
        refreshCacheStatus();
      })
      .catch((e) => {
        const msg = e instanceof Error ? e.message : String(e);
        setStatus((s) => ({ ...s, loading: false, error: msg }));
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
      setStatus((s) => ({
        ...s,
        loading: true,
        verified: false,
        sessionReady: false,
        message: `Verifying model: ${model.name}`,
        error: undefined,
      }));

      void (async () => {
        await deleteModelBlob(ONNX_TUMOR_MANIFEST_KEY);
        await putModelBlob(ONNX_TUMOR_MODEL_KEY, model);
        await verifyTumorModelManifest(model, manifest);
        await putModelBlob(ONNX_TUMOR_MANIFEST_KEY, manifest!);
      })()
        .then(() => {
          setStatus((s) => ({ ...s, loading: false, verified: true, message: 'Verified model and manifest cached' }));
          refreshCacheStatus();
        })
        .catch((e) => {
          const msg = e instanceof Error ? e.message : String(e);
          setStatus((s) => ({ ...s, cached: true, verified: false, loading: false, error: msg }));
        });
    },
    [refreshCacheStatus, releaseSession],
  );

  const ensureSession = useCallback(async (): Promise<{ session: Ort.InferenceSession; mode: OnnxSessionMode }> => {
    if (sessionRef.current) {
      return { session: sessionRef.current, mode: sessionModeRef.current ?? 'webgpu-preferred' };
    }

    if (sessionPromiseRef.current) return sessionPromiseRef.current;

    const generation = modelGenerationRef.current;
    const pending = (async (): Promise<{ session: Ort.InferenceSession; mode: OnnxSessionMode }> => {
      const [blob, manifest] = await Promise.all([
        getModelBlob(ONNX_TUMOR_MODEL_KEY),
        getModelBlob(ONNX_TUMOR_MANIFEST_KEY),
      ]);
      if (!blob) {
        throw new Error('No cached ONNX model found. Upload one first.');
      }
      await verifyTumorModelManifest(blob, manifest);

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
        await session.release().catch(() => undefined);
        throw new Error('Model changed during initialization');
      }

      sessionRef.current = session;
      sessionModeRef.current = mode;
      return { session, mode };
    })();

    sessionPromiseRef.current = pending;
    try {
      return await pending;
    } finally {
      if (sessionPromiseRef.current === pending) sessionPromiseRef.current = null;
    }
  }, []);

  const initSession = useCallback(() => {
    setStatus((s) => ({ ...s, loading: true, message: 'Initializing ONNX runtime…', error: undefined }));

    void ensureSession()
      .then(({ mode }) => {
        setStatus((s) => ({
          ...s,
          loading: false,
          sessionReady: true,
          message: mode === 'wasm' ? 'ONNX session ready (WASM)' : 'ONNX session ready (WebGPU preferred)',
        }));
      })
      .catch((e) => {
        const msg = e instanceof Error ? e.message : String(e);
        setStatus((s) => ({ ...s, loading: false, sessionReady: false, error: msg }));
      });
  }, [ensureSession]);

  const runSegmentation = useCallback(() => {
    if (!volume) return;

    if (preflight?.blockedByDefault && !allowUnsafeFullRes) {
      const dims = `${preflight.nx}×${preflight.ny}×${preflight.nz}`;
      const msg = `ONNX blocked for huge volume by default (${dims}; est logits ${formatMiB(preflight.logitsBytes)}). Re-run SVR at lower resolution/ROI or enable the unsafe override.`;
      setStatus((s) => ({ ...s, loading: false, error: msg }));
      return;
    }

    const runId = ++segRunIdRef.current;
    setSegRunning(true);

    const started = performance.now();
    setStatus((s) => ({ ...s, loading: true, message: 'Running ONNX segmentation…', error: undefined }));

    void (async () => {
      try {
        const { session, mode } = await ensureSession();
        if (segRunIdRef.current !== runId) return;

        setStatus((s) => ({
          ...s,
          sessionReady: true,
          loading: true,
          message:
            mode === 'wasm' ? 'Running ONNX segmentation… (WASM)' : 'Running ONNX segmentation… (WebGPU preferred)',
        }));

        const res = await runTumorSegmentationOnnx({ session, volume: volume.data, dims: volume.dims });
        if (segRunIdRef.current !== runId) return;

        onLabels({ data: res.labels, dims: volume.dims, meta: BRATS_BASE_LABEL_META });

        const ms = Math.round(performance.now() - started);
        setStatus((s) => ({ ...s, loading: false, sessionReady: true, message: `Segmentation complete (${ms}ms)` }));
      } catch (e) {
        if (segRunIdRef.current !== runId) return;
        const msg = e instanceof Error ? e.message : String(e);
        setStatus((s) => ({ ...s, loading: false, sessionReady: sessionRef.current !== null, error: msg }));
      } finally {
        if (segRunIdRef.current === runId) setSegRunning(false);
      }
    })();
  }, [allowUnsafeFullRes, ensureSession, onLabels, preflight, volume]);

  const cancelSegmentation = useCallback(() => {
    if (!segRunning) return;
    segRunIdRef.current++;
    setSegRunning(false);
    setStatus((s) => ({
      ...s,
      loading: false,
      message: 'Result discarded; the current model operation may finish in the background.',
      error: undefined,
    }));
  }, [segRunning]);

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
  };
}
