import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import cornerstone from 'cornerstone-core';
import type { SvrLabelVolume, SvrVolume } from '../types/svr';
import { BRATS_BASE_LABEL_META } from '../utils/segmentation/brats';
import { deleteModelBlobs, getModelBlob, getModelRecord, putModelBlobs } from '../utils/segmentation/onnx/modelCache';
import { verifyTumorModelManifest } from '../utils/segmentation/onnx/modelManifest';
import {
  customModelRuntimeBytes,
  customModelBudgetBytes,
  customModelWorkingMemory,
  runCustomModelWorker,
} from '../utils/segmentation/onnx/customModelWorker';
import { formatMiB } from '../utils/svr/svrUtils';
import { estimateSvrPeakMemoryBytes } from '../utils/svr/svrMemoryPlan';
import { CORNERSTONE_MEMORY_FALLBACK_BYTES, measureCornerstoneImageMemory } from '../utils/cornerstoneMemory';
import { nativePlaneMemoryBytes, retainedSvrVolumeBytes } from '../utils/svr/nativeVolume';
import { retainedDerivedAlignmentBytes } from '../utils/derivedAlignmentFrame';

const ONNX_TUMOR_MODEL_KEY = 'brats-tumor-v1';
const ONNX_TUMOR_MANIFEST_KEY = `${ONNX_TUMOR_MODEL_KEY}:manifest`;

async function verifyPair(model: Blob, manifest: Blob | null | undefined) {
  if (customModelRuntimeBytes(model.size) > customModelBudgetBytes())
    throw new Error(
      'This model exceeds the custom-model session memory policy. Use a smaller model; the previous cache is unchanged.',
    );
  return verifyTumorModelManifest(model, manifest);
}

export type OnnxStatus = {
  cached: boolean;
  verified: boolean;
  savedAtMs: number | null;
  loading: boolean;
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
  modelRuntimeBytes: number;
  readyResidentBytes: number;
  estimatedPeakBytes: number;
  budgetBytes: number;
  blockedByDefault: boolean;
};

type Operation = { controller: AbortController; volume: SvrVolume };

/** Cached files outlive suggestions; compiled runtimes never do. */
export function useOnnxTumorSession(
  volume: SvrVolume | null,
  onLabels: (labels: SvrLabelVolume) => void,
  options: { blocked?: boolean; prepare?: () => number } = {},
) {
  const { blocked, prepare } = options;
  const modelGenerationRef = useRef(0);
  const modelWriteAbortRef = useRef<AbortController | null>(null);
  const operation = useRef<Operation | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const [modelBytes, setModelBytes] = useState(0);
  const [admission, setAdmission] = useState<{ volume: SvrVolume; modelBytes: number; plan: OnnxPreflight } | null>(
    null,
  );
  const preflight = admission?.volume === volume && admission.modelBytes === modelBytes ? admission.plan : null;
  const [segRunning, setSegRunning] = useState(false);
  const [status, setStatus] = useState<OnnxStatus>({
    cached: false,
    verified: false,
    savedAtMs: null,
    loading: false,
  });
  const cancelSegmentation = useCallback(() => {
    const current = operation.current;
    if (!current) return;
    operation.current = null;
    current.controller.abort();
    setSegRunning(false);
    setStatus((previous) => ({
      ...previous,
      loading: false,
      error: undefined,
      message: 'Model suggestion canceled. The worker was stopped; your selection is unchanged.',
    }));
  }, []);
  const replaceModel = useCallback(() => {
    cancelSegmentation();
    modelGenerationRef.current++;
    modelWriteAbortRef.current?.abort();
    modelWriteAbortRef.current = null;
  }, [cancelSegmentation]);
  useLayoutEffect(() => {
    if (operation.current && (operation.current.volume !== volume || blocked)) cancelSegmentation();
  }, [volume, blocked, cancelSegmentation]);
  useEffect(
    () => () => {
      modelGenerationRef.current++;
      modelWriteAbortRef.current?.abort();
      operation.current?.controller.abort();
      operation.current = null;
    },
    [],
  );

  const refreshCacheStatus = useCallback((operationError?: string) => {
    const generation = modelGenerationRef.current;
    return Promise.all([getModelRecord(ONNX_TUMOR_MODEL_KEY), getModelBlob(ONNX_TUMOR_MANIFEST_KEY)])
      .then(async ([record, manifest]) => {
        if (modelGenerationRef.current !== generation) return;
        if (!record?.blob || record.savedAtMs == null) {
          setModelBytes(0);
          setStatus((s) => ({
            ...s,
            cached: false,
            verified: false,
            savedAtMs: null,
            error: operationError ?? s.error,
          }));
          return;
        }
        const { blob: model, savedAtMs } = record;
        setModelBytes(model.size);

        try {
          await verifyPair(model, manifest);
          if (modelGenerationRef.current !== generation) return;
          setStatus((s) => ({ ...s, cached: true, verified: true, savedAtMs, error: operationError ?? s.error }));
        } catch (error) {
          if (modelGenerationRef.current !== generation) return;
          setStatus((s) => ({
            ...s,
            cached: true,
            verified: false,
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

  const measurePreflight = useCallback(
    (bytes: number, extra: number): OnnxPreflight | null => {
      if (!volume) return null;
      const [nx, ny, nz] = volume.dims;
      const {
        nvox,
        logitsBytes,
        inputBytes,
        preprocessingBytes,
        modelRuntimeBytes: runtimeBytes,
        labelBytes,
      } = customModelWorkingMemory(bytes, volume.dims, volume.observedSupport?.byteLength ?? 0);
      const cacheMemory = measureCornerstoneImageMemory(cornerstone);
      const maximum = cacheMemory.cacheInfo?.maximumSizeInBytes;
      const capacity = Number.isFinite(maximum) && maximum! >= 0 ? maximum! : CORNERSTONE_MEMORY_FALLBACK_BYTES;
      const decodedCacheBytes = cacheMemory.bytes + Math.max(0, capacity - cacheMemory.reservedPixelCacheBytes);
      if (!Number.isSafeInteger(extra) || extra < 0)
        throw new Error('Custom inference requires a valid retained-memory estimate. Your selection is unchanged.');
      const inferencePlan = estimateSvrPeakMemoryBytes({
        phase: 'inference',
        voxelCount: 0,
        sourceBytes: 0,
        iterations: 0,
        labelBytes,
        retainedBytes:
          retainedSvrVolumeBytes(volume) +
          decodedCacheBytes +
          nativePlaneMemoryBytes(volume.sourceProvenance?.sources ?? []) +
          extra +
          runtimeBytes +
          retainedDerivedAlignmentBytes(),
        modelTensorBytes: preprocessingBytes + inputBytes + logitsBytes,
      });
      const budgetBytes = customModelBudgetBytes();
      return {
        nx,
        ny,
        nz,
        nvox,
        logitsBytes,
        inputBytes,
        preprocessingBytes,
        modelRuntimeBytes: runtimeBytes,
        readyResidentBytes: inferencePlan.totalBytes - inferencePlan.modelTensorBytes,
        estimatedPeakBytes: inferencePlan.totalBytes,
        budgetBytes,
        blockedByDefault: inferencePlan.totalBytes > budgetBytes,
      };
    },
    [volume],
  );

  const uploadClick = useCallback(() => fileInputRef.current?.click(), []);

  const clearModel = useCallback(() => {
    replaceModel();
    const generation = modelGenerationRef.current;
    const controller = new AbortController();
    modelWriteAbortRef.current = controller;
    setStatus((s) => ({
      ...s,
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
  }, [refreshCacheStatus, replaceModel]);

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

      replaceModel();
      const generation = modelGenerationRef.current;
      const controller = new AbortController();
      modelWriteAbortRef.current = controller;
      setStatus((s) => ({
        ...s,
        loading: true,
        message: `Verifying model: ${model.name}`,
        error: undefined,
      }));

      void (async () => {
        await verifyPair(model, manifest);
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
    [refreshCacheStatus, replaceModel],
  );

  const runSegmentation = useCallback(() => {
    if (!volume || blocked || operation.current || modelWriteAbortRef.current) return;
    if (volume.observedSupport && volume.observedSupport.length !== volume.data.length) {
      setStatus((previous) => ({
        ...previous,
        loading: false,
        error: 'Cannot segment this volume: acquired-support evidence does not match its reconstructed dimensions.',
      }));
      return;
    }
    const owner = { controller: new AbortController(), volume };
    operation.current = owner;
    const generation = modelGenerationRef.current;
    const current = () =>
      operation.current === owner && !owner.controller.signal.aborted && modelGenerationRef.current === generation;
    const started = performance.now();
    setSegRunning(true);
    setStatus((previous) => ({
      ...previous,
      loading: true,
      error: undefined,
      message: 'Preparing custom-model suggestion…',
    }));
    void (async () => {
      try {
        const [model, manifest] = await Promise.all([
          getModelBlob(ONNX_TUMOR_MODEL_KEY),
          getModelBlob(ONNX_TUMOR_MANIFEST_KEY),
        ]);
        if (!current()) return;
        if (!model) throw new Error('No cached ONNX model found. Upload one first.');
        const plan = measurePreflight(model.size, prepare?.() ?? 0)!;
        setAdmission({ volume, modelBytes: model.size, plan });
        if (plan.blockedByDefault)
          throw new Error(
            `ONNX exceeds the estimated ${formatMiB(plan.budgetBytes)} custom-model memory budget ` +
              `(${plan.nx}×${plan.ny}×${plan.nz}; estimated resident peak ${formatMiB(plan.estimatedPeakBytes)}, ` +
              `including ${formatMiB(plan.modelRuntimeBytes)} model/session allowance and ${formatMiB(plan.logitsBytes)} logits). ` +
              'Use a smaller model or reconstruct a smaller focus region.',
          );
        const {
          data,
          dims,
          originMm,
          voxelSizeMm,
          boundsMm,
          direction,
          intensityRange,
          nativeVoxelSizeMm,
          observedSupport,
        } = volume;
        const result = await runCustomModelWorker(
          {
            model,
            manifest,
            volume: {
              data,
              dims,
              originMm,
              voxelSizeMm,
              boundsMm,
              direction,
              intensityRange,
              nativeVoxelSizeMm,
              observedSupport,
            },
          },
          {
            signal: owner.controller.signal,
            estimatedPeakBytes: plan.estimatedPeakBytes,
            budgetBytes: plan.budgetBytes,
            onRunning: (mode) => {
              if (current())
                setStatus((previous) => ({
                  ...previous,
                  loading: true,
                  message: `Running custom-model suggestion… (${mode === 'wasm' ? 'WASM' : 'WebGPU preferred'})`,
                }));
            },
          },
        );
        if (!current()) return;
        onLabels({ data: result.labels, dims: volume.dims, meta: BRATS_BASE_LABEL_META, reviewState: 'draft' });
        setStatus((previous) => ({
          ...previous,
          loading: false,
          message:
            `Segmentation complete (${Math.round(performance.now() - started)}ms). Model runtime released.` +
            (result.manifest.input.spatialFrame === 'source-grid'
              ? ' Source-aligned suggestion; review against original slices.'
              : ''),
        }));
      } catch (error) {
        if (current())
          setStatus((previous) => ({
            ...previous,
            loading: false,
            error: error instanceof Error ? error.message : String(error),
          }));
      } finally {
        if (operation.current === owner) {
          operation.current = null;
          setSegRunning(false);
        }
      }
    })();
  }, [volume, blocked, measurePreflight, onLabels, prepare]);

  return {
    status,
    preflight,
    segRunning,
    fileInputRef,
    uploadClick,
    handleSelectedFiles,
    clearModel,
    runSegmentation,
    cancelSegmentation,
  };
}
