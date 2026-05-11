import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type * as Ort from 'onnxruntime-web';
import type { SvrLabelVolume, SvrVolume } from '../types/svr';
import { BRATS_BASE_LABEL_META } from '../utils/segmentation/brats';
import {
  deleteModelBlob,
  getModelBlob,
  getModelSavedAtMs,
  putModelBlob,
} from '../utils/segmentation/onnx/modelCache';
import { createOrtSessionFromModelBlob } from '../utils/segmentation/onnx/ortLoader';
import { runTumorSegmentationOnnx } from '../utils/segmentation/onnx/tumorSegmentation';
import { formatMiB } from '../utils/svr/svrUtils';

const ONNX_TUMOR_MODEL_KEY = 'brats-tumor-v1';
const ONNX_PREFLIGHT_CLASS_COUNT = 4;
const ONNX_PREFLIGHT_LOGITS_BUDGET_BYTES = 384 * 1024 * 1024;

type OnnxSessionMode = 'webgpu-preferred' | 'wasm';

export type OnnxStatus = {
  cached: boolean;
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
  handleSelectedFile: (file: File) => void;
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
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const releaseSession = useCallback((reason: string) => {
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
    savedAtMs: null,
    loading: false,
    sessionReady: false,
  }));

  // We can't reliably abort ORT execution mid-run in the browser; cancellation just ignores late results.
  const segRunIdRef = useRef(0);
  const [segRunning, setSegRunning] = useState(false);
  const [allowUnsafeFullRes, setAllowUnsafeFullRes] = useState(false);

  const refreshCacheStatus = useCallback(() => {
    void getModelSavedAtMs(ONNX_TUMOR_MODEL_KEY)
      .then((savedAtMs) => {
        setStatus((s) => ({ ...s, cached: savedAtMs !== null, savedAtMs, error: undefined }));
      })
      .catch((e) => {
        const msg = e instanceof Error ? e.message : String(e);
        setStatus((s) => ({ ...s, error: msg }));
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
    return { nx, ny, nz, nvox, logitsBytes, inputBytes, blockedByDefault: logitsBytes > ONNX_PREFLIGHT_LOGITS_BUDGET_BYTES };
  }, [volume]);

  const uploadClick = useCallback(() => fileInputRef.current?.click(), []);

  const clearModel = useCallback(() => {
    releaseSession('clear-model');
    setStatus((s) => ({ ...s, sessionReady: false, loading: true, message: 'Clearing cached model…', error: undefined }));

    void deleteModelBlob(ONNX_TUMOR_MODEL_KEY)
      .then(() => {
        setStatus((s) => ({ ...s, loading: false, message: 'Cleared cached model' }));
        refreshCacheStatus();
      })
      .catch((e) => {
        const msg = e instanceof Error ? e.message : String(e);
        setStatus((s) => ({ ...s, loading: false, error: msg }));
      });
  }, [refreshCacheStatus, releaseSession]);

  const handleSelectedFile = useCallback(
    (file: File) => {
      releaseSession('upload-model');
      setStatus((s) => ({
        ...s,
        loading: true,
        sessionReady: false,
        message: `Caching model: ${file.name}`,
        error: undefined,
      }));

      void putModelBlob(ONNX_TUMOR_MODEL_KEY, file)
        .then(() => {
          setStatus((s) => ({ ...s, loading: false, message: 'Model cached' }));
          refreshCacheStatus();
        })
        .catch((e) => {
          const msg = e instanceof Error ? e.message : String(e);
          setStatus((s) => ({ ...s, loading: false, error: msg }));
        });
    },
    [refreshCacheStatus, releaseSession],
  );

  const ensureSession = useCallback(async (): Promise<{ session: Ort.InferenceSession; mode: OnnxSessionMode }> => {
    if (sessionRef.current) {
      return { session: sessionRef.current, mode: sessionModeRef.current ?? 'webgpu-preferred' };
    }

    const blob = await getModelBlob(ONNX_TUMOR_MODEL_KEY);
    if (!blob) {
      throw new Error('No cached ONNX model found. Upload one first.');
    }

    try {
      const session = await createOrtSessionFromModelBlob({ model: blob, preferWebGpu: true, logLevel: 'warning' });
      sessionRef.current = session;
      sessionModeRef.current = 'webgpu-preferred';
      return { session, mode: 'webgpu-preferred' };
    } catch {
      const session = await createOrtSessionFromModelBlob({ model: blob, preferWebGpu: false, logLevel: 'warning' });
      sessionRef.current = session;
      sessionModeRef.current = 'wasm';
      return { session, mode: 'wasm' };
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
    setStatus((s) => ({ ...s, loading: false, message: 'Segmentation cancelled', error: undefined }));
  }, [segRunning]);

  return {
    status,
    preflight,
    segRunning,
    allowUnsafeFullRes,
    setAllowUnsafeFullRes,
    fileInputRef,
    uploadClick,
    handleSelectedFile,
    clearModel,
    initSession,
    runSegmentation,
    cancelSegmentation,
  };
}
