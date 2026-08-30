import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { ChevronLeft, ChevronRight, SlidersHorizontal, X } from 'lucide-react';
import type { SvrLabelVolume, SvrVolume } from '../types/svr';
import { SvrSegmentationEditor } from './SvrSegmentationEditor';
import { SvrImagingContext, useSvrImaging } from './svrImagingContext';
import { voxelPoint, type VoxelBounds, type VoxelPoint as Vec3i } from '../utils/segmentation/seededVolume';
import type { SelectionPatch } from '../utils/segmentation/selectionEditing';
import type { SelectionProposer } from '../utils/segmentation/selectionProposal';
import { BRATS_BASE_LABEL_META } from '../utils/segmentation/brats';
import { buildRgbaPalette256, rgbCss } from '../utils/segmentation/labelPalette';
import { segmentationVolumeMm3 } from '../utils/segmentation/physicalMeasurements';
import { TUMOR_MODEL_MANIFEST_EXAMPLE } from '../utils/segmentation/onnx/modelManifest';
import { formatMiB } from '../utils/svr/svrUtils';
import {
  buildRenderVolumeTexData,
  computePhysicalBoxScale,
  computeRenderPlan,
  downsampleLabelsNearest,
  toUint8Volume,
  updateLabelsNearestRegion,
  type RenderDims,
  type RenderQualityPreset,
  type RenderTextureMode,
  type RenderVolumeTexData,
} from '../utils/svr/renderLod';
import {
  RAYMARCH_FRAGMENT_SHADER,
  RAYMARCH_VERTEX_SHADER,
  SVR3D_OCC_BLOCK,
  buildOccupancyMaxGrid,
  buildOccupancyMaxGridAsync,
  chooseVolumeTextureFormat,
  createObservedSupportTexture,
  createProgram,
  float32ToFloat16Bits,
  float32ToFloat16BitsAsync,
  type OccupancyMaxGrid,
  type VolumeTextureFormat,
  createNativePlaneBinding,
  type NativePlaneBinding,
} from '../utils/svr/glRaymarch';
import { useOnnxTumorSession } from '../hooks/useOnnxTumorSession';
import { deleteVolumeSegmentation, getVolumeSegmentation, saveVolumeSegmentation } from '../utils/localApi';
import { clamp } from '../utils/math';
import { normalizedVolumeWindow, volumeSamplingLabel } from '../utils/svr/volumeDisplay';
import { useSvrNativePlane } from '../hooks/useSvrNativePlane';
import { useSvrEnhancement } from '../hooks/useSvrEnhancement';
import { createEnhancedVolumeBinding, type EnhancedVolumeBinding } from '../utils/svr/enhancedVolumeBinding';
import { nativeFrameCursor, nearestNativeFrame, projectNativePlaneMask } from '../utils/svr/nativePlane';
import { volumeCamera } from '../utils/svr/volumeCamera';
import {
  captureSelectionGeometry,
  findTransferableSelection,
  transferSavedSelection,
  type SavedSelectionMigration,
} from '../utils/svr/selectionMigration';

// Render defaults
const DEFAULT_RENDER_QUALITY: RenderQualityPreset = 'auto';
const DEFAULT_RENDER_GPU_BUDGET_MIB = 256;
const DEFAULT_RENDER_TEXTURE_MODE: RenderTextureMode = 'auto';

const COARSE_POINTER_CONTROL_TARGETS =
  '[@media(pointer:coarse)]:[&_button]:min-h-11 [@media(pointer:coarse)]:[&_button]:min-w-11 ' +
  '[@media(pointer:coarse)]:[&_input]:min-h-11 [@media(pointer:coarse)]:[&_select]:min-h-11 ' +
  '[@media(pointer:coarse)]:[&_summary]:min-h-11';

const LABEL_PLACEHOLDER_DIMS: RenderDims = { nx: 1, ny: 1, nz: 1 };
const LABEL_PLACEHOLDER_DATA = new Uint8Array([0]);
const INITIAL_VOLUME_VISIBILITY_THRESHOLD = 0.05;
type GlLabelState = {
  gl: WebGL2RenderingContext;
  texLabels: WebGLTexture;
  texPalette: WebGLTexture;
  texDims: RenderDims;
  /** Dimensions currently allocated on the GPU for texLabels. */
  labelsTexDims: RenderDims;
  labelData: Uint8Array | null;
};

type Vec3 = { x: number; y: number; z: number };
// Quaternion [x, y, z, w]
type Quat = [number, number, number, number];

function quatFromRotationRows(a: Vec3, b: Vec3, c: Vec3): Quat {
  const trace = a.x + b.y + c.z;
  if (trace > 0) {
    const s = Math.sqrt(trace + 1) * 2;
    return quatNormalize([(c.y - b.z) / s, (a.z - c.x) / s, (b.x - a.y) / s, s / 4]);
  }
  if (a.x > b.y && a.x > c.z) {
    const s = Math.sqrt(1 + a.x - b.y - c.z) * 2;
    return quatNormalize([s / 4, (a.y + b.x) / s, (a.z + c.x) / s, (c.y - b.z) / s]);
  }
  if (b.y > c.z) {
    const s = Math.sqrt(1 + b.y - a.x - c.z) * 2;
    return quatNormalize([(a.y + b.x) / s, s / 4, (b.z + c.y) / s, (a.z - c.x) / s]);
  }
  const s = Math.sqrt(1 + c.z - a.x - b.y) * 2;
  return quatNormalize([(a.z + c.x) / s, (b.z + c.y) / s, s / 4, (b.x - a.y) / s]);
}

function v3ApplyMat3(m: Float32Array, v: Vec3): Vec3 {
  // Column-major 3x3.
  return {
    x: m[0]! * v.x + m[3]! * v.y + m[6]! * v.z,
    y: m[1]! * v.x + m[4]! * v.y + m[7]! * v.z,
    z: m[2]! * v.x + m[5]! * v.y + m[8]! * v.z,
  };
}

type DrawAxesOverlayParams = {
  axesCanvas: HTMLCanvasElement;
  axesCtx: CanvasRenderingContext2D;
  canvas: HTMLCanvasElement;
  volume: SvrVolume;
  rotMat: Float32Array;
};

function drawAxesOverlay(params: DrawAxesOverlayParams): void {
  const { axesCanvas, axesCtx, canvas, volume, rotMat } = params;

  const w = axesCanvas.width;
  const h = axesCanvas.height;
  if (!(w > 0 && h > 0)) return;

  axesCtx.clearRect(0, 0, w, h);
  const dpr = canvas.clientWidth > 0 ? canvas.width / canvas.clientWidth : window.devicePixelRatio || 1;
  if (w < 132 * dpr || h < 112 * dpr) return;

  // Orientation is a corner instrument, not a ruler projected across anatomy.
  // The same forward rotation used by the shader keeps every direction truthful.
  const origin = { x: 48 * dpr, y: h - 90 * dpr };
  const axisLength = 28 * dpr;
  axesCtx.save();
  axesCtx.lineCap = 'round';
  axesCtx.lineJoin = 'round';
  axesCtx.lineWidth = Math.max(1, dpr);
  axesCtx.font = `${Math.max(12, Math.round(12 * dpr))}px SFMono-Regular, ui-monospace, monospace`;
  axesCtx.textBaseline = 'middle';
  const drawLabel = (text: string, x: number, y: number, color: string) => {
    // A narrow dark halo keeps the instrument readable over bright MRI tissue
    // without placing an opaque panel over the source anatomy.
    axesCtx.save();
    axesCtx.strokeStyle = 'rgba(8,10,9,0.95)';
    axesCtx.lineWidth = 3 * dpr;
    axesCtx.strokeText(text, x, y);
    axesCtx.fillStyle = color;
    axesCtx.fillText(text, x, y);
    axesCtx.restore();
  };

  const axes: Array<{
    name: 'L' | 'P' | 'S';
    dirObj: Vec3;
    rgba: string;
  }> = [
    {
      name: 'L',
      dirObj: { x: volume.direction?.[0] ?? 1, y: volume.direction?.[1] ?? 0, z: volume.direction?.[2] ?? 0 },
      rgba: 'rgba(199,181,140,0.86)',
    },
    {
      name: 'P',
      dirObj: { x: volume.direction?.[3] ?? 0, y: volume.direction?.[4] ?? 1, z: volume.direction?.[5] ?? 0 },
      rgba: 'rgba(143,186,178,0.82)',
    },
    {
      name: 'S',
      dirObj: { x: volume.direction?.[6] ?? 0, y: volume.direction?.[7] ?? 0, z: volume.direction?.[8] ?? 1 },
      rgba: 'rgba(166,165,155,0.78)',
    },
  ];

  for (const axis of axes) {
    const direction = v3ApplyMat3(rotMat, axis.dirObj);
    const endpoint = {
      x: origin.x + direction.x * axisLength,
      y: origin.y - direction.y * axisLength,
    };
    const projectedLength = Math.hypot(direction.x, direction.y);
    axesCtx.strokeStyle = axis.rgba;
    axesCtx.beginPath();
    if (projectedLength < 0.12) {
      axesCtx.arc(origin.x, origin.y, 2.5 * dpr, 0, Math.PI * 2);
    } else {
      axesCtx.moveTo(origin.x, origin.y);
      axesCtx.lineTo(endpoint.x, endpoint.y);
    }
    axesCtx.stroke();

    axesCtx.textAlign = direction.x < -0.2 ? 'right' : 'left';
    drawLabel(
      axis.name,
      endpoint.x + (direction.x < -0.2 ? -6 : 6) * dpr,
      endpoint.y - (projectedLength < 0.12 ? 8 : 0) * dpr,
      axis.rgba,
    );
  }

  const dimensionsMm = volume.dims.map((count, index) => Math.abs(count * volume.voxelSizeMm[index]!));
  const dimensionLabel = dimensionsMm.map((size) => (Number.isInteger(size) ? size.toFixed(0) : size.toFixed(1)));
  axesCtx.textAlign = 'left';
  drawLabel(`${dimensionLabel.join(' × ')} mm`, 16 * dpr, h - 40 * dpr, 'rgba(199,198,188,0.95)');
  axesCtx.restore();
}

function v3Normalize(v: Vec3): Vec3 {
  const len = Math.sqrt(v.x * v.x + v.y * v.y + v.z * v.z);
  if (len <= 1e-12) return { x: 0, y: 0, z: 1 };
  const inv = 1 / len;
  return { x: v.x * inv, y: v.y * inv, z: v.z * inv };
}

function quatNormalize(q: Quat): Quat {
  const [x, y, z, w] = q;
  const len = Math.sqrt(x * x + y * y + z * z + w * w);
  if (len <= 1e-12) return [0, 0, 0, 1];
  const inv = 1 / len;
  return [x * inv, y * inv, z * inv, w * inv];
}

function quatMultiply(a: Quat, b: Quat): Quat {
  // Hamilton product (composition)
  const ax = a[0];
  const ay = a[1];
  const az = a[2];
  const aw = a[3];

  const bx = b[0];
  const by = b[1];
  const bz = b[2];
  const bw = b[3];

  return [
    aw * bx + ax * bw + ay * bz - az * by,
    aw * by - ax * bz + ay * bw + az * bx,
    aw * bz + ax * by - ay * bx + az * bw,
    aw * bw - ax * bx - ay * by - az * bz,
  ];
}

function quatFromAxisAngle(axis: Vec3, angleRad: number): Quat {
  const a = v3Normalize(axis);
  const half = angleRad * 0.5;
  const s = Math.sin(half);
  const c = Math.cos(half);
  return quatNormalize([a.x * s, a.y * s, a.z * s, c]);
}

/** Reveal both the source-textured cut and the retained tissue; Face slice is explicit. */
function obliqueVolumeRotation(facing: Quat = [0, 0, 0, 1]): Quat {
  const yaw = quatFromAxisAngle({ x: 0, y: 1, z: 0 }, Math.PI / 3);
  const pitch = quatFromAxisAngle({ x: 1, y: 0, z: 0 }, -Math.PI / 9);
  return quatNormalize(quatMultiply(quatMultiply(pitch, yaw), facing));
}

const DEFAULT_VOLUME_ROTATION = obliqueVolumeRotation();

function mat3FromQuat(q: Quat, out: Float32Array): void {
  const x = q[0];
  const y = q[1];
  const z = q[2];
  const w = q[3];

  const x2 = x + x;
  const y2 = y + y;
  const z2 = z + z;

  const xx = x * x2;
  const yy = y * y2;
  const zz = z * z2;

  const xy = x * y2;
  const xz = x * z2;
  const yz = y * z2;

  const wx = w * x2;
  const wy = w * y2;
  const wz = w * z2;

  // WebGL expects column-major layout when transpose=false.
  // These are the standard quaternion->matrix terms (row/column layout handled below).
  const m00 = 1 - (yy + zz);
  const m01 = xy - wz;
  const m02 = xz + wy;

  const m10 = xy + wz;
  const m11 = 1 - (xx + zz);
  const m12 = yz - wx;

  const m20 = xz - wy;
  const m21 = yz + wx;
  const m22 = 1 - (xx + yy);

  // Column-major mat3 for WebGL.
  out[0] = m00;
  out[1] = m10;
  out[2] = m20;

  out[3] = m01;
  out[4] = m11;
  out[5] = m21;

  out[6] = m02;
  out[7] = m12;
  out[8] = m22;
}

type RenderBuildState = {
  source: SvrVolume | null;
  status: 'idle' | 'building' | 'ready' | 'error';
  key: string | null;
  data: RenderVolumeTexData | null;
  buildMs?: number;
  error?: string;
};

type VolumeVisualizationMode = 'anatomy' | 'overlay' | 'tumor';

function maskUnsupportedLabels(labels: SvrLabelVolume, observedSupport?: Uint8Array): SvrLabelVolume {
  if (!observedSupport || labels.data.length !== observedSupport.length) return labels;

  let data = labels.data;
  for (let index = 0; index < observedSupport.length; index++) {
    if (!observedSupport[index] && data[index]) {
      if (data === labels.data) data = new Uint8Array(labels.data);
      data[index] = 0;
    }
  }

  return data === labels.data ? labels : { ...labels, data, reviewState: 'draft' };
}

function touchesUnsupportedAnatomy(
  index: number,
  dims: readonly [number, number, number],
  observedSupport?: Uint8Array,
): boolean {
  if (!observedSupport) return false;
  const [nx, ny, nz] = dims;
  const strideZ = nx * ny;
  const z = Math.floor(index / strideZ);
  const inPlane = index - z * strideZ;
  const y = Math.floor(inPlane / nx);
  const x = inPlane - y * nx;

  return (
    x === 0 ||
    x + 1 === nx ||
    y === 0 ||
    y + 1 === ny ||
    z === 0 ||
    z + 1 === nz ||
    (x > 0 && !observedSupport[index - 1]) ||
    (x + 1 < nx && !observedSupport[index + 1]) ||
    (y > 0 && !observedSupport[index - nx]) ||
    (y + 1 < ny && !observedSupport[index + nx]) ||
    (z > 0 && !observedSupport[index - strideZ]) ||
    (z + 1 < nz && !observedSupport[index + strideZ])
  );
}

export type SvrVolume3DViewerProps = {
  volumeIdentity?: {
    patientKey?: string;
    studyUid?: string;
    seriesUids: string[];
    frameOfReferenceUid?: string;
    datasetRevision?: number;
  } | null;
};

function useSvrVolumeViewerModel({ volumeIdentity }: SvrVolume3DViewerProps) {
  const {
    volume,
    labels: labelsOverride,
    initialSelection,
    busy,
    refineRegion,
    loadEnhancementSource,
    proposeSelection,
  } = useSvrImaging();
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const axesCanvasRef = useRef<HTMLCanvasElement | null>(null);

  const glLabelStateRef = useRef<GlLabelState | null>(null);

  const [initError, setInitError] = useState<string | null>(null);
  const [glEpoch, setGlEpoch] = useState(0);
  const [contextEpoch, setContextEpoch] = useState(0);
  const [actualTextureFormat, setActualTextureFormat] = useState<'f16' | 'u8' | null>(null);
  const contextLostRef = useRef(false);

  const renderBuildIdRef = useRef(0);
  const preparedRenderRef = useRef<{
    data: RenderVolumeTexData;
    halfFloatBits?: Uint16Array;
    occupancy: OccupancyMaxGrid;
  } | null>(null);
  const [storedRenderBuild, setRenderBuild] = useState<RenderBuildState>(() => ({
    source: null,
    status: 'idle',
    key: null,
    data: null,
  }));
  // Geometry and pixels become visible together. Never initialize a new volume
  // with a previous volume's ready texture, even when their dimensions match.
  const renderBuild = useMemo<RenderBuildState>(
    () =>
      storedRenderBuild.source === volume
        ? storedRenderBuild
        : {
            source: volume,
            status: volume ? 'building' : 'idle',
            key: null,
            data: null,
          },
    [storedRenderBuild, volume],
  );

  // Optional externally-provided labels (e.g. from an ML pipeline) can override internal generation.
  const [storedLabels, setStoredLabels] = useState<{
    volume: SvrVolume | null;
    generatedLabels: SvrLabelVolume | null;
  }>({ volume, generatedLabels: null });
  const generatedLabels = storedLabels.volume === volume ? storedLabels.generatedLabels : null;
  const setGeneratedLabels = useCallback(
    (generatedLabels: SvrLabelVolume | null) => setStoredLabels({ volume, generatedLabels }),
    [volume],
  );
  const [hydrated, setHydrated] = useState<{ key: string; volume: SvrVolume } | null>(null);
  const [storageError, setStorageError] = useState<{ key: string; phase: 'load' | 'save' } | null>(null);
  const [storageRetry, setStorageRetry] = useState({ load: 0, save: 0 });
  const labelSourceRef = useRef<string | undefined>(undefined);
  const labelCountsRef = useRef<{
    data: Uint8Array;
    counts: Map<number, number>;
    unsupportedBoundaryCount: number;
    bounds: VoxelBounds | null;
  } | null>(null);
  const labels = useMemo(() => {
    // Persisted, ONNX, and grown labels are sanitized at their publication
    // boundary. Rechecking their full voxel buffer on each interactive grow
    // tick would turn a sparse edit back into an O(volume) main-thread stall.
    return labelsOverride ? maskUnsupportedLabels(labelsOverride, volume?.observedSupport) : generatedLabels;
  }, [generatedLabels, labelsOverride, volume]);

  const observedSupportSummary = useMemo(() => {
    const observedSupport = volume?.observedSupport;
    if (!observedSupport || !volume) return null;
    if (observedSupport.length !== volume.data.length) return { valid: false, count: 0, total: volume.data.length };

    const total = observedSupport.length;
    const knownCount = volume.supportedVoxelCount;
    if (typeof knownCount === 'number' && Number.isInteger(knownCount) && knownCount >= 0 && knownCount <= total) {
      return { valid: true, count: knownCount, total };
    }

    let count = 0;
    for (let index = 0; index < total; index++) {
      if (observedSupport[index]) count++;
    }
    return { valid: true, count, total };
  }, [volume]);

  const volumeKey = useMemo(() => {
    if (!volume || !volumeIdentity?.studyUid || volumeIdentity.seriesUids.length === 0) return null;
    return JSON.stringify({
      patient: volumeIdentity.patientKey ?? null,
      study: volumeIdentity.studyUid,
      series: [...volumeIdentity.seriesUids].sort(),
      frame: volumeIdentity.frameOfReferenceUid ?? null,
      dims: volume.dims,
      spacing: volume.voxelSizeMm,
      origin: volume.originMm,
      ...(volume.direction ? { direction: volume.direction } : {}),
      revision: volumeIdentity.datasetRevision ?? null,
      ...(volume.reconstructionFingerprint ? { reconstruction: volume.reconstructionFingerprint } : {}),
    });
  }, [volume, volumeIdentity]);
  const [savedMigration, setSavedMigration] = useState<{
    key: string;
    volume: SvrVolume;
    info: SavedSelectionMigration;
    running: boolean;
    error: string | null;
  } | null>(null);
  const savedTransferRef = useRef<AbortController | null>(null);
  useEffect(
    () => () => {
      savedTransferRef.current?.abort();
      savedTransferRef.current = null;
    },
    [volume, volumeKey],
  );

  useEffect(() => {
    if (!volume) return;
    if (!volumeKey) {
      if (initialSelection) setGeneratedLabels(maskUnsupportedLabels(initialSelection, volume.observedSupport));
      return;
    }
    let cancelled = false;
    void getVolumeSegmentation(volumeKey)
      .then(async (saved) => {
        if (cancelled) return;
        if (saved) {
          if (
            saved.labels.length !== volume.data.length ||
            saved.dims.some((size, axis) => size !== volume.dims[axis])
          ) {
            throw new Error('The saved selection does not match this reconstruction geometry.');
          }
          const metadata = Array.isArray(saved.classMetadata)
            ? (saved.classMetadata as SvrLabelVolume['meta'])
            : BRATS_BASE_LABEL_META;
          labelSourceRef.current = saved.modelKey;
          setGeneratedLabels(
            maskUnsupportedLabels(
              {
                data: saved.labels,
                dims: saved.dims,
                meta: metadata,
                seeds: saved.seeds,
                ...(saved.clippedNativeVoxels !== undefined ? { clippedNativeVoxels: saved.clippedNativeVoxels } : {}),
                ...(saved.contextLimited !== undefined ? { contextLimited: saved.contextLimited } : {}),
                reviewState: saved.reviewState === 'reviewed' ? 'reviewed' : 'draft',
              },
              volume.observedSupport,
            ),
          );
        } else if (initialSelection) {
          labelSourceRef.current = 'refined-selection-v1';
          setGeneratedLabels(maskUnsupportedLabels(initialSelection, volume.observedSupport));
        } else if (volumeIdentity) {
          try {
            const info = await findTransferableSelection(volume, volumeIdentity, volumeKey);
            if (cancelled) return;
            setSavedMigration({ key: volumeKey, volume, info, running: false, error: null });
          } catch {
            if (cancelled) return;
            setSavedMigration({
              key: volumeKey,
              volume,
              info: { candidate: null, retainedCount: 0, unavailableCount: 0, message: null },
              running: false,
              error:
                'Other saved grids could not be checked. They have not been changed; the current grid is stored separately.',
            });
          }
        }
        setStorageError(null);
        setHydrated({ key: volumeKey, volume });
      })
      .catch((error: unknown) => {
        if (!cancelled) {
          console.error('[segmentation] Failed to restore saved 3D labels', error);
          setStorageError({ key: volumeKey, phase: 'load' });
        }
      });
    return () => {
      cancelled = true;
    };
  }, [initialSelection, setGeneratedLabels, volume, volumeIdentity, volumeKey, storageRetry.load]);

  useEffect(() => {
    if (
      !volume ||
      !volumeIdentity ||
      !volumeKey ||
      hydrated?.key !== volumeKey ||
      hydrated.volume !== volume ||
      labelsOverride
    )
      return;

    // Submit each completed edit immediately. IndexedDB serializes it with later
    // reads/writes across mounts; component-local queues cannot protect a remount.
    let current = true;
    const record = generatedLabels
      ? {
          volumeKey,
          patientKey: volumeIdentity.patientKey,
          studyUid: volumeIdentity.studyUid,
          seriesUids: volumeIdentity.seriesUids,
          frameOfReferenceUid: volumeIdentity.frameOfReferenceUid,
          dims: generatedLabels.dims,
          voxelSizeMm: volume.voxelSizeMm,
          geometry: captureSelectionGeometry(volume),
          labels: generatedLabels.data,
          classMetadata: generatedLabels.meta,
          reviewState: generatedLabels.reviewState,
          seeds: generatedLabels.seeds,
          ...(generatedLabels.clippedNativeVoxels !== undefined
            ? { clippedNativeVoxels: generatedLabels.clippedNativeVoxels }
            : {}),
          ...(generatedLabels.contextLimited !== undefined ? { contextLimited: generatedLabels.contextLimited } : {}),
          modelKey: labelSourceRef.current,
          datasetRevision: volumeIdentity.datasetRevision,
          updatedAt: Date.now(),
        }
      : null;
    void (record ? saveVolumeSegmentation(record) : deleteVolumeSegmentation(volumeKey))
      .then(() => {
        if (current) setStorageError(null);
      })
      .catch((error: unknown) => {
        console.error('[segmentation] Failed to save 3D labels', error);
        if (current) setStorageError({ key: volumeKey, phase: 'save' });
      });
    return () => {
      current = false;
    };
  }, [generatedLabels, hydrated, labelsOverride, volume, volumeIdentity, volumeKey, storageRetry.save]);

  // The 256-entry label->RGBA palette depends only on the label *metadata*, which is a
  // stable object (BRATS_BASE_LABEL_META) across grow-preview ticks — only the voxel data
  // changes. Memoizing on meta keeps palette construction out of the per-tick upload and
  // slice-compositing paths.
  const labelsMeta = labels?.meta ?? null;
  const labelPalette = useMemo(() => (labelsMeta ? buildRgbaPalette256(labelsMeta) : null), [labelsMeta]);

  // A sparse edit is usable only against the exact buffer currently resident on the GPU.
  // Batched edits, model output, and context restoration safely take the full-upload path.
  const labelDirtyRef = useRef<{ data: Uint8Array; previousData: Uint8Array; min: Vec3i; max: Vec3i } | null>(null);
  // Persistent downsampled copy of the label volume, mirrored region-by-region; only valid
  // for the buffer identity + dims it was built from.
  const labelDsCacheRef = useRef<{ src: Uint8Array; key: string; data: Uint8Array } | null>(null);

  const onSelectionChange = useCallback(
    (next: SvrLabelVolume | null, patch?: SelectionPatch, previousData?: Uint8Array) => {
      if (labelsOverride) return;
      savedTransferRef.current?.abort();
      labelSourceRef.current = 'manual-seeded-v1';
      labelDirtyRef.current = null;
      if (next && patch && previousData) {
        const min = { x: Infinity, y: Infinity, z: Infinity };
        const max = { x: -Infinity, y: -Infinity, z: -Infinity };
        for (const index of patch.indices) {
          const point = voxelPoint(index, next.dims);
          for (const axis of ['x', 'y', 'z'] as const) {
            min[axis] = Math.min(min[axis], point[axis]);
            max[axis] = Math.max(max[axis], point[axis]);
          }
        }
        labelDirtyRef.current = { data: next.data, previousData, min, max };
      }
      setGeneratedLabels(next);
    },
    [labelsOverride, setGeneratedLabels],
  );

  // ONNX model execution (offline; model cached in IndexedDB).
  const onOnnxLabels = useCallback(
    (nextLabels: SvrLabelVolume) => {
      savedTransferRef.current?.abort();
      labelSourceRef.current = 'brats-tumor-v1';
      setGeneratedLabels(maskUnsupportedLabels(nextLabels, volume?.observedSupport));
    },
    [setGeneratedLabels, volume],
  );
  const onnx = useOnnxTumorSession(volume ?? null, onOnnxLabels);
  const {
    status: onnxStatus,
    preflight: onnxPreflight,
    segRunning: onnxSegRunning,
    fileInputRef: onnxFileInputRef,
    uploadClick: onnxUploadClick,
    handleSelectedFiles: onnxHandleSelectedFiles,
    clearModel: onnxClearModel,
    runSegmentation: runOnnxSegmentation,
    cancelSegmentation: cancelOnnxSegmentation,
    releaseIdleSession,
  } = onnx;

  const enhancement = useSvrEnhancement({
    volume,
    labels,
    loadSource: loadEnhancementSource,
    blocked: Boolean(busy || onnxSegRunning || savedMigration?.running),
  });
  const refineWithEnhancement = useCallback<NonNullable<typeof refineRegion>>(
    (selection, prepareMemory = 0) =>
      refineRegion?.(selection, () => {
        const bytes = typeof prepareMemory === 'function' ? prepareMemory() : prepareMemory;
        // Invalid caller estimates must reach the admission guard unchanged.
        return Number.isSafeInteger(bytes) && bytes >= 0 ? bytes + enhancement.retainedBytes : bytes;
      }),
    [refineRegion, enhancement.retainedBytes],
  );
  const glEnhancementRef = useRef<EnhancedVolumeBinding | null>(null);
  const enhancementDisplayRef = useRef(enhancement);
  const proposeWithEnhancement = useMemo<SelectionProposer | undefined>(
    () =>
      proposeSelection
        ? async (request) => {
            request.signal.throwIfAborted();
            await releaseIdleSession();
            request.signal.throwIfAborted();
            const enhancementBytes = enhancementDisplayRef.current.retainedBytes;
            const retainedBytes = request.retainedBytes + enhancementBytes;
            if (
              [request.retainedBytes, enhancementBytes, retainedBytes].some(
                (bytes) => !Number.isSafeInteger(bytes) || bytes < 0,
              )
            )
              throw new Error(
                'Interactive selection requires a valid retained-memory estimate. Your marks are unchanged.',
              );
            return proposeSelection({ ...request, retainedBytes });
          }
        : undefined,
    [proposeSelection, releaseIdleSession],
  );

  // Viewer controls (composite-only)
  const [controlsCollapsed, setControlsCollapsed] = useState(true);
  // One spatially neutral threshold preserves equal peripheral and central tissue.
  const [threshold, setThreshold] = useState(INITIAL_VOLUME_VISIBILITY_THRESHOLD);
  const THRESHOLD_MAX = 0.3;
  // Always use max raymarch samples for quality; no UI control.
  const steps = 1024;
  const [gamma, setGamma] = useState(1.0);
  const [opacity, setOpacity] = useState(4.0);
  const [windowSetting, setWindowSetting] = useState<{ volume: SvrVolume; range: [number, number] } | null>(null);
  if (windowSetting && windowSetting.volume !== volume) setWindowSetting(null);
  const windowRange = useMemo<[number, number]>(
    () => (windowSetting?.volume === volume && windowSetting ? windowSetting.range : (volume?.displayWindow ?? [0, 1])),
    [volume, windowSetting],
  );
  const setWindowRange = useCallback(
    (range: [number, number]) => {
      if (volume) setWindowSetting({ volume, range });
    },
    [volume],
  );
  const renderWindowRange = useMemo<[number, number]>(
    () => (volume ? normalizedVolumeWindow(volume, windowRange) : [0, 1]),
    [volume, windowRange],
  );
  const [slicePosition, setSlicePosition] = useState<{ volume: SvrVolume; point: Vec3i } | null>(null);
  if (slicePosition && slicePosition.volume !== volume) setSlicePosition(null);
  const cursor = useMemo(
    () =>
      slicePosition?.volume === volume && slicePosition
        ? slicePosition.point
        : {
            x: Math.floor((volume?.dims[0] ?? 1) / 2),
            y: Math.floor((volume?.dims[1] ?? 1) / 2),
            z: Math.floor((volume?.dims[2] ?? 1) / 2),
          },
    [slicePosition, volume],
  );
  const setCursor = useCallback(
    (point: Vec3i) => {
      if (volume) setSlicePosition({ volume, point });
    },
    [volume],
  );
  // One anatomical cursor owns both overview-grid navigation and native-frame
  // browsing. Keep fractional coordinates so a fine source plane is not snapped
  // back onto a coarser overview slice; only the editing views select grid cells.
  const editingCursor = useMemo(
    () => ({
      x: clamp(Math.round(cursor.x), 0, (volume?.dims[0] ?? 1) - 1),
      y: clamp(Math.round(cursor.y), 0, (volume?.dims[1] ?? 1) - 1),
      z: clamp(Math.round(cursor.z), 0, (volume?.dims[2] ?? 1) - 1),
    }),
    [cursor, volume],
  );
  const [nativeSourceUid, setNativeSourceUid] = useState<string | null>(null);
  const nativeSources = volume?.sourceProvenance?.sources;
  const selectedNativeSourceIndex = nativeSources?.findIndex((source) => source.seriesUid === nativeSourceUid) ?? -1;
  const nativeSourceIndex =
    selectedNativeSourceIndex >= 0
      ? selectedNativeSourceIndex
      : Math.max(
          0,
          nativeSources?.findIndex((source) => source.seriesUid === volume?.sourceProvenance?.primarySeriesUid) ?? 0,
        );
  const nativeSource = nativeSources?.[nativeSourceIndex];
  const nativeFrameIndex = useMemo(
    () => (volume && nativeSource ? nearestNativeFrame(volume, nativeSource, [cursor.x, cursor.y, cursor.z]) : 0),
    [volume, nativeSource, cursor],
  );
  const [nativePlaneEnabled, setNativePlaneEnabled] = useState(true);
  const nativeImage = useSvrNativePlane({
    volume: nativePlaneEnabled ? (volume ?? null) : null,
    sourceIndex: nativeSourceIndex,
    frameIndex: nativeFrameIndex,
  });
  const [nativeContour, setNativeContour] = useState(true);
  const [nativeCutaway, setNativeCutaway] = useState(true);
  const [nativeInterpolate, setNativeInterpolate] = useState(false);
  const [nativeWindowSetting, setNativeWindowSetting] = useState<{
    volume: SvrVolume;
    sourceIndex: number;
    range: [number, number];
  } | null>(null);
  if (nativeWindowSetting && nativeWindowSetting.volume !== volume) setNativeWindowSetting(null);
  const nativeWindowRange =
    nativeWindowSetting?.volume === volume && nativeWindowSetting?.sourceIndex === nativeSourceIndex
      ? nativeWindowSetting.range
      : nativeImage.plane?.windowRange;
  const setNativeWindowRange = useCallback(
    (range: [number, number]) => {
      if (volume) setNativeWindowSetting({ volume, sourceIndex: nativeSourceIndex, range });
    },
    [volume, nativeSourceIndex],
  );
  const setNativeFrameIndex = useCallback(
    (index: number) => {
      if (!volume || !nativeSource) return;
      const frame = nativeSource.frames[clamp(Math.round(index), 0, nativeSource.frames.length - 1)];
      if (!frame) return;
      const point = nativeFrameCursor(volume, nativeSource, frame, [cursor.x, cursor.y, cursor.z]);
      setCursor({ x: point[0], y: point[1], z: point[2] });
    },
    [volume, nativeSource, cursor, setCursor],
  );
  const setNativeSourceIndex = useCallback(
    (index: number) => {
      const source = nativeSources?.[index];
      if (source) setNativeSourceUid(source.seriesUid);
    },
    [nativeSources],
  );
  const nativeMask = useMemo(
    () =>
      volume && nativeImage.plane
        ? projectNativePlaneMask(
            volume,
            labels?.data.length === volume.data.length &&
              labels.dims.length === volume.dims.length &&
              labels.dims.every((size, axis) => size === volume.dims[axis])
              ? labels
              : null,
            nativeImage.plane.source,
            nativeImage.plane.frame,
          )
        : null,
    [volume, labels, nativeImage.plane],
  );
  const glNativeRef = useRef<NativePlaneBinding | null>(null);
  const nativeDisplayRef = useRef({
    plane: nativeImage.plane,
    mask: nativeMask,
    enabled: nativePlaneEnabled,
    contour: nativeContour,
    cutaway: nativeCutaway,
    windowRange: nativeWindowRange,
    interpolate: nativeInterpolate,
  });
  const [cutaway, setCutaway] = useState(false);
  const clipZ = (cursor.z + 0.5) / Math.max(1, volume?.dims[2] ?? 1);
  const [cameraZoom, setCameraZoom] = useState<{
    anatomy: number;
    focused: { bounds: { min: Vec3i; max: Vec3i }; factor: number } | null;
  }>({ anatomy: 1, focused: null });

  // Keep the accepted label texture resident across display-mode changes.
  const [visualizationMode, setVisualizationModeValue] = useState<VolumeVisualizationMode>('overlay');
  const [selectionFocusEnabled, setSelectionFocusEnabled] = useState(false);
  const setVisualizationMode = useCallback((next: VolumeVisualizationMode) => {
    setCameraZoom((current) => (current.focused ? { ...current, focused: null } : current));
    setVisualizationModeValue(next);
  }, []);
  const labelMix = 0.82;

  const hasLabels = useMemo(() => {
    if (!volume) return false;
    if (!labels) return false;

    const [nx, ny, nz] = volume.dims;
    const [lx, ly, lz] = labels.dims;
    if (nx !== lx || ny !== ly || nz !== lz) return false;

    return labels.data.length === nx * ny * nz;
  }, [labels, volume]);

  const labelMetrics = useMemo(() => {
    if (!volume) return null;
    if (!labels) return null;
    if (!hasLabels) return null;

    const data = labels.data;
    let cached = labelCountsRef.current?.data === data ? labelCountsRef.current : null;

    if (!cached) {
      const counts = new Map<number, number>();
      let unsupportedBoundaryCount = 0;
      const min = { x: Infinity, y: Infinity, z: Infinity };
      const max = { x: -Infinity, y: -Infinity, z: -Infinity };
      for (let i = 0; i < data.length; i++) {
        if (volume.observedSupport && !volume.observedSupport[i]) continue;
        const id = data[i] ?? 0;
        if (id === 0) continue;
        counts.set(id, (counts.get(id) ?? 0) + 1);
        const point = voxelPoint(i, volume.dims);
        for (const axis of ['x', 'y', 'z'] as const) {
          min[axis] = Math.min(min[axis], point[axis]);
          max[axis] = Math.max(max[axis], point[axis]);
        }
        if (touchesUnsupportedAnatomy(i, volume.dims, volume.observedSupport)) unsupportedBoundaryCount++;
      }
      cached = { data, counts, unsupportedBoundaryCount, bounds: Number.isFinite(min.x) ? { min, max } : null };
    }

    const { counts, unsupportedBoundaryCount } = cached;

    const voxelVolMm3 = segmentationVolumeMm3(1, volume.voxelSizeMm) ?? 0;

    let totalCount = 0;
    for (const c of counts.values()) {
      totalCount += c;
    }

    const totalMm3 = totalCount * voxelVolMm3;
    const totalMl = totalMm3 / 1000;

    return {
      counts,
      voxelVolMm3,
      totalCount,
      totalMm3,
      totalMl,
      unsupportedBoundaryCount,
      bounds: cached.bounds,
      cache: cached,
    };
  }, [hasLabels, labels, volume]);

  useEffect(() => {
    labelCountsRef.current = labelMetrics?.cache ?? null;
  }, [labelMetrics]);

  const hasTumorLabels = (labelMetrics?.totalCount ?? 0) > 0;
  const currentMigration =
    savedMigration?.key === volumeKey && savedMigration?.volume === volume ? savedMigration : null;
  const cancelSavedTransfer = useCallback(() => {
    savedTransferRef.current?.abort();
    savedTransferRef.current = null;
    setSavedMigration((current) => (current ? { ...current, running: false, error: null } : null));
  }, []);
  const copySavedSelection = useCallback(async () => {
    const candidate = currentMigration?.info.candidate;
    if (!candidate || !volume || !volumeKey || !volumeIdentity || hasTumorLabels || currentMigration.running) return;
    const controller = new AbortController();
    savedTransferRef.current?.abort();
    savedTransferRef.current = controller;
    setSavedMigration({ ...currentMigration, running: true, error: null });
    try {
      const transferred = await transferSavedSelection(candidate, volume, volumeIdentity, volumeKey, controller.signal);
      if (controller.signal.aborted || savedTransferRef.current !== controller) return;
      savedTransferRef.current = null;
      onSelectionChange(transferred);
      setSavedMigration(null);
    } catch (reason) {
      if (savedTransferRef.current !== controller) return;
      setSavedMigration({
        ...currentMigration,
        running: false,
        error: controller.signal.aborted
          ? null
          : reason instanceof Error
            ? reason.message
            : 'The saved selection could not be copied. Its original is unchanged.',
      });
    } finally {
      if (savedTransferRef.current === controller) savedTransferRef.current = null;
    }
  }, [currentMigration, volume, volumeKey, volumeIdentity, hasTumorLabels, onSelectionChange]);
  const activeVisualizationMode = hasTumorLabels ? visualizationMode : 'anatomy';
  const labelsEnabled = activeVisualizationMode !== 'anatomy';
  const tumorOnly = activeVisualizationMode === 'tumor';

  // Render-on-demand + interaction-time quality scaling.
  //
  // The raymarcher's frame cost is pixels × steps × texture bandwidth, and it used to pay
  // that cost every RAF forever, at full devicePixelRatio, even with nothing changing.
  // Instead: frames are scheduled only when something changed (requestRenderRef), and while
  // the user is actively rotating/zooming we render at reduced resolution + step count
  // (paired with ray jitter in the shader). A settle timer restores a final full-quality
  // frame ~180ms after the last interaction event.
  const requestRenderRef = useRef<(() => void) | null>(null);
  useLayoutEffect(() => {
    enhancementDisplayRef.current = enhancement;
    requestRenderRef.current?.();
  }, [enhancement]);
  const interactingRef = useRef(false);
  const settleTimerRef = useRef<number | null>(null);

  const markInteraction = useCallback(() => {
    interactingRef.current = true;

    // Debounced settle: each interaction event pushes the full-quality re-render out, so a
    // continuous drag stays in cheap mode and only the final frame pays full cost.
    if (settleTimerRef.current !== null) window.clearTimeout(settleTimerRef.current);
    settleTimerRef.current = window.setTimeout(() => {
      settleTimerRef.current = null;
      interactingRef.current = false;
      requestRenderRef.current?.();
    }, 180);

    requestRenderRef.current?.();
  }, []);

  useEffect(() => {
    return () => {
      if (settleTimerRef.current !== null) window.clearTimeout(settleTimerRef.current);
    };
  }, []);

  const rotationRef = useRef<Quat>(DEFAULT_VOLUME_ROTATION);
  const nativeFacingRotation = useMemo<Quat>(() => {
    const plane = nativeImage.plane;
    if (!plane) return [0, 0, 0, 1];
    const a = plane.columnStep,
      b = plane.rowStep;
    // Map native image columns right and rows down. The resulting quaternion
    // uses the same object frame as the raymarcher, including oblique sources.
    const right = v3Normalize({ x: a[0], y: a[1], z: a[2] });
    const up = v3Normalize({ x: -b[0], y: -b[1], z: -b[2] });
    const forward = {
      x: right.y * up.z - right.z * up.y,
      y: right.z * up.x - right.x * up.z,
      z: right.x * up.y - right.y * up.x,
    };
    return quatFromRotationRows(right, up, forward);
  }, [nativeImage.plane]);
  const faceNativePlane = useCallback(() => {
    if (!nativeImage.plane) return;
    rotationRef.current = nativeFacingRotation;
    requestRenderRef.current?.();
  }, [nativeFacingRotation, nativeImage.plane]);
  const nativeOrientedVolumeRef = useRef<SvrVolume | null>(null);
  useEffect(() => {
    if (!volume || !nativeImage.plane || nativeOrientedVolumeRef.current === volume) return;
    nativeOrientedVolumeRef.current = volume;
    rotationRef.current = obliqueVolumeRotation(nativeFacingRotation);
    requestRenderRef.current?.();
  }, [volume, nativeImage.plane, nativeFacingRotation]);
  useLayoutEffect(() => {
    nativeDisplayRef.current = {
      plane: nativeImage.plane,
      mask: nativeMask,
      enabled: nativePlaneEnabled,
      contour: nativeContour,
      cutaway: nativeCutaway,
      windowRange: nativeWindowRange,
      interpolate: nativeInterpolate,
    };
    requestRenderRef.current?.();
  }, [
    nativeImage.plane,
    nativeMask,
    nativePlaneEnabled,
    nativeContour,
    nativeCutaway,
    nativeWindowRange,
    nativeInterpolate,
  ]);

  const { boxScale, volDims } = useMemo(() => {
    if (!volume) {
      return {
        volDims: { nx: 1, ny: 1, nz: 1 },
        boxScale: [1, 1, 1] as const,
      };
    }

    const [nx, ny, nz] = volume.dims;
    const dims = { nx, ny, nz };
    return {
      volDims: dims,
      boxScale: computePhysicalBoxScale(dims, volume.voxelSizeMm),
    };
  }, [volume]);

  const selectedBounds = labelMetrics?.bounds ?? null;
  const tumorFocus = useMemo(() => {
    if (!(tumorOnly || selectionFocusEnabled) || !volume || !selectedBounds) return null;

    const axes = ['x', 'y', 'z'] as const;
    const spans = axes.map((axis) => selectedBounds.max[axis] - selectedBounds.min[axis] + 1);
    const margin = clamp(Math.round(Math.max(...spans) * 0.1), 2, 12);
    const center = axes.map(
      (axis, index) =>
        ((selectedBounds.min[axis] + selectedBounds.max[axis] + 1) / (2 * volume.dims[index]!) - 0.5) *
        boxScale[index]!,
    ) as [number, number, number];
    const min = axes.map(
      (axis, index) => (Math.max(0, selectedBounds.min[axis] - margin) / volume.dims[index]! - 0.5) * boxScale[index]!,
    ) as [number, number, number];
    const max = axes.map(
      (axis, index) =>
        ((Math.min(volume.dims[index]! - 1, selectedBounds.max[axis] + margin) + 1) / volume.dims[index]! - 0.5) *
        boxScale[index]!,
    ) as [number, number, number];
    const focusedBoxScale = center.map((value, axis) => 2 * Math.max(value - min[axis]!, max[axis]! - value)) as [
      number,
      number,
      number,
    ];
    return { center, min, max, boxScale: focusedBoxScale };
  }, [boxScale, selectedBounds, tumorOnly, selectionFocusEnabled, volume]);

  const focusAdjustment = cameraZoom.focused?.bounds === selectedBounds ? cameraZoom.focused.factor : 1;
  const zoom = tumorFocus ? focusAdjustment : cameraZoom.anatomy;
  const setZoom = useCallback(
    (next: number | ((current: number) => number)) => {
      setCameraZoom((current) => {
        if (!tumorFocus || !selectedBounds) {
          const anatomy = typeof next === 'function' ? next(current.anatomy) : next;
          return { anatomy, focused: null };
        }

        const adjustment = current.focused?.bounds === selectedBounds ? current.focused.factor : 1;
        const focused = typeof next === 'function' ? next(adjustment) : next;
        return {
          anatomy: current.anatomy,
          focused: { bounds: selectedBounds, factor: clamp(focused, 0.6, 10) },
        };
      });
    },
    [selectedBounds, tumorFocus],
  );

  const paramsRef = useRef({
    threshold,
    steps,
    gamma,
    opacity,
    zoom,
    labelsEnabled,
    labelMix,
    hasLabels,
    tumorOnly,
    tumorFocus,
    windowRange: renderWindowRange,
    cutaway,
    clipZ,
  });
  useEffect(() => {
    paramsRef.current = {
      threshold,
      steps,
      gamma,
      opacity,
      zoom,
      labelsEnabled,
      labelMix,
      hasLabels,
      tumorOnly,
      tumorFocus,
      windowRange: renderWindowRange,
      cutaway,
      clipZ,
    };
    // Render-on-demand: any control change must explicitly schedule a frame, since the GL
    // loop no longer free-runs (idle viewer = zero GPU work).
    requestRenderRef.current?.();
  }, [
    gamma,
    hasLabels,
    labelMix,
    labelsEnabled,
    opacity,
    steps,
    threshold,
    tumorFocus,
    tumorOnly,
    zoom,
    renderWindowRange,
    cutaway,
    clipZ,
  ]);

  const renderPlan = useMemo(() => {
    if (!volume) return null;

    return computeRenderPlan({
      srcDims: volDims,
      labelsEnabled: true,
      hasLabels: false,
      budgetMiB: DEFAULT_RENDER_GPU_BUDGET_MIB,
      quality: DEFAULT_RENDER_QUALITY,
      textureMode: DEFAULT_RENDER_TEXTURE_MODE,
      reserveLabelTexture: true,
      hasObservedSupport: Boolean(volume.observedSupport),
    });
  }, [volume, volDims]);

  const renderBuildKey = useMemo(() => {
    if (!renderPlan) return null;
    const d = renderPlan.dims;
    return `${renderPlan.kind}:${d.nx}x${d.ny}x${d.nz}`;
  }, [renderPlan]);

  useEffect(() => {
    const buildId = ++renderBuildIdRef.current;
    preparedRenderRef.current = null;
    if (!volume || !renderPlan || !renderBuildKey) {
      setRenderBuild({ source: volume, status: 'idle', key: null, data: null });
      return;
    }

    setInitError(null);

    const key = renderBuildKey;

    const srcDims: RenderDims = volDims;
    const dstDims: RenderDims = renderPlan.dims;

    if (volume.observedSupport && volume.observedSupport.length !== volume.data.length) {
      setRenderBuild({
        source: volume,
        status: 'error',
        key,
        data: null,
        error: 'Acquired-support evidence does not match this reconstructed volume.',
      });
      return;
    }

    const started = performance.now();

    setRenderBuild({ source: volume, status: 'building', key, data: null });

    void (async () => {
      try {
        const isCancelled = () => renderBuildIdRef.current !== buildId;

        const tex = await buildRenderVolumeTexData({
          src: volume.data,
          intensityRange: volume.intensityRange,
          invert: volume.displayInvert,
          srcObservedSupport: volume.observedSupport,
          srcDims,
          plan: { kind: renderPlan.kind, dims: dstDims },
          isCancelled,
        });

        if (renderBuildIdRef.current !== buildId) return;

        const halfFloatBits =
          tex.kind === 'f32' ? await float32ToFloat16BitsAsync(tex.data as Float32Array, isCancelled) : undefined;
        if (renderBuildIdRef.current !== buildId) return;

        const occupancy = await buildOccupancyMaxGridAsync(
          {
            data: tex.data,
            dims: tex.dims,
            observedSupport: tex.observedSupport,
            visibilityThreshold: INITIAL_VOLUME_VISIBILITY_THRESHOLD,
          },
          isCancelled,
        );
        if (renderBuildIdRef.current !== buildId) return;

        preparedRenderRef.current = { data: tex, halfFloatBits, occupancy };

        const ms = Math.round(performance.now() - started);
        setRenderBuild({
          source: volume,
          status: 'ready',
          key,
          data: tex,
          buildMs: ms,
        });
      } catch (e) {
        if (renderBuildIdRef.current !== buildId) return;
        const msg = e instanceof Error ? e.message : String(e);
        setRenderBuild({ source: volume, status: 'error', key, data: null, error: msg });
      }
    })();
    return () => {
      renderBuildIdRef.current = buildId + 1;
    };
  }, [renderBuildKey, renderPlan, volume, volDims]);

  const resetView = useCallback(() => {
    rotationRef.current = obliqueVolumeRotation(nativeFacingRotation);
    setSelectionFocusEnabled(false);
    setCameraZoom({ anatomy: 1, focused: null });
    // If zoom was already 1.0 the params effect won't fire, so the rotation reset needs its
    // own explicit frame request.
    requestRenderRef.current?.();
  }, [nativeFacingRotation]);

  const fitSelection = useCallback(() => {
    if (!selectedBounds) return;
    setSelectionFocusEnabled(true);
    setCameraZoom({ anatomy: 1, focused: null });
    setCursor({
      x: (selectedBounds.min.x + selectedBounds.max.x) / 2,
      y: (selectedBounds.min.y + selectedBounds.max.y) / 2,
      z: (selectedBounds.min.z + selectedBounds.max.z) / 2,
    });
  }, [selectedBounds, setCursor]);

  // Pointer drag rotation (viewport-relative yaw/pitch).
  //
  // Goal: keep controls constant relative to the viewport:
  // - horizontal mouse movement => yaw about screen vertical axis
  // - vertical mouse movement => pitch about screen horizontal axis
  const dragRef = useRef<{ lastX: number; lastY: number; pointerId: number } | null>(null);

  const onPointerDown = useCallback((e: React.PointerEvent) => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    dragRef.current = {
      lastX: e.clientX,
      lastY: e.clientY,
      pointerId: e.pointerId,
    };

    canvas.setPointerCapture(e.pointerId);
    e.preventDefault();
    e.stopPropagation();
  }, []);

  const onPointerMove = useCallback(
    (e: React.PointerEvent) => {
      const canvas = canvasRef.current;
      const d = dragRef.current;
      if (!canvas || !d || d.pointerId !== e.pointerId) return;

      const dx = e.clientX - d.lastX;
      const dy = e.clientY - d.lastY;

      d.lastX = e.clientX;
      d.lastY = e.clientY;

      const minDim = Math.max(1, Math.min(canvas.clientWidth, canvas.clientHeight));
      const anglePerPx = Math.PI / minDim;

      // Apply *delta* rotations about fixed viewport/world axes.
      //
      // Important: composing absolute yaw/pitch as `R = R_pitch * R_yaw` makes yaw behave like a local-axis
      // rotation once pitch != 0 (unintuitive). Pre-multiplying the current rotation with world-axis deltas
      // keeps both axes fixed relative to the viewport.
      // NOTE: positive clientY is down, so `deltaPitch = +dy` feels like “drag down -> tilt down”.
      const deltaYaw = dx * anglePerPx;
      const deltaPitch = dy * anglePerPx;

      const qYaw = quatFromAxisAngle({ x: 0, y: 1, z: 0 }, deltaYaw);
      const qPitch = quatFromAxisAngle({ x: 1, y: 0, z: 0 }, deltaPitch);

      // Apply yaw first (screen vertical axis), then pitch (screen horizontal axis).
      const qDelta = quatMultiply(qPitch, qYaw);
      rotationRef.current = quatNormalize(quatMultiply(qDelta, rotationRef.current));

      // Rotation lives in a ref (no React state change), so the on-demand renderer must be
      // poked explicitly; this also flips the cheap interaction-quality mode on.
      markInteraction();

      e.preventDefault();
      e.stopPropagation();
    },
    [markInteraction],
  );

  const onPointerUp = useCallback((e: React.PointerEvent) => {
    if (dragRef.current?.pointerId === e.pointerId) {
      dragRef.current = null;
    }
    e.preventDefault();
    e.stopPropagation();
  }, []);

  // Mousewheel zoom on the canvas.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const onWheel = (e: WheelEvent) => {
      if (!Number.isFinite(e.deltaY) || e.deltaY === 0) return;

      if (nativePlaneEnabled && nativeSource && !e.ctrlKey && !e.metaKey && !e.shiftKey) {
        setNativeFrameIndex(nativeFrameIndex + Math.sign(e.deltaY));
        markInteraction();
        e.preventDefault();
        e.stopPropagation();
        return;
      }

      // Multiplicative zoom feels better across trackpads (small deltas) and mouse wheels (large deltas).
      const factor = Math.exp(-e.deltaY * 0.001);
      setZoom((z) => clamp(z * factor, 0.6, 10.0));

      // The zoom state change schedules a frame via the params effect, but marking the
      // interaction here is what drops to cheap render quality during a wheel burst.
      markInteraction();

      e.preventDefault();
      e.stopPropagation();
    };

    const handleContextLost = (event: Event) => {
      event.preventDefault();
      contextLostRef.current = true;
      requestRenderRef.current = null;
      setActualTextureFormat(null);
      setInitError('Graphics context was lost. Waiting for the browser to restore the 3D volume.');
    };
    const handleContextRestored = () => {
      contextLostRef.current = false;
      setInitError(null);
      setContextEpoch((epoch) => epoch + 1);
    };

    canvas.addEventListener('wheel', onWheel, { passive: false });
    canvas.addEventListener('webglcontextlost', handleContextLost);
    canvas.addEventListener('webglcontextrestored', handleContextRestored);
    return () => {
      canvas.removeEventListener('wheel', onWheel);
      canvas.removeEventListener('webglcontextlost', handleContextLost);
      canvas.removeEventListener('webglcontextrestored', handleContextRestored);
    };
  }, [markInteraction, setZoom, nativePlaneEnabled, nativeSource, nativeFrameIndex, setNativeFrameIndex]);

  useEffect(() => {
    if (contextLostRef.current) return;
    setInitError(null);

    const canvas = canvasRef.current;
    if (!canvas) return;

    if (!volume) {
      // No volume yet; nothing to initialize.
      return;
    }

    if (renderBuild.status !== 'ready' || !renderBuild.data) {
      // Render volume is still being prepared (or failed).
      return;
    }

    const renderTex = renderBuild.data;
    const texDims = renderTex.dims;
    const preparedRender = preparedRenderRef.current?.data === renderTex ? preparedRenderRef.current : null;

    const gl = canvas.getContext('webgl2', {
      // MSAA is pure overhead for a fullscreen-quad raymarcher: there are no geometry edges
      // to antialias (all image content comes from the fragment shader), but the browser
      // would still allocate a multisampled framebuffer and pay a resolve pass per frame.
      antialias: false,
      alpha: false,
      depth: false,
      stencil: false,
      preserveDrawingBuffer: false,
      // Dual-GPU laptops default to the integrated chip for WebGL; volume raymarching is
      // exactly the workload where the discrete GPU matters.
      powerPreference: 'high-performance',
    });

    if (!gl) {
      setInitError('WebGL2 is not available in this browser/environment.');
      return;
    }

    // Prefer float textures for fidelity; fall back to 8-bit if unavailable.
    const { primary, fallback } = chooseVolumeTextureFormat(gl);

    const vsSrc = RAYMARCH_VERTEX_SHADER;
    const fsSrc = RAYMARCH_FRAGMENT_SHADER;

    let program: WebGLProgram | null = null;
    let vao: WebGLVertexArrayObject | null = null;
    let vbo: WebGLBuffer | null = null;
    let texVol: WebGLTexture | null = null;
    let texLabels: WebGLTexture | null = null;
    let texPalette: WebGLTexture | null = null;
    let texOcc: WebGLTexture | null = null;
    let texSupport: WebGLTexture | null = null;
    let supportEnabled = false;
    let occMaxCell: [number, number, number] = [0, 0, 0];
    let raf = 0;
    let resizeObserver: ResizeObserver | null = null;

    try {
      program = createProgram(gl, vsSrc, fsSrc);
      glNativeRef.current = createNativePlaneBinding(gl, program);
      glEnhancementRef.current = createEnhancedVolumeBinding(gl, program, volume);

      // Full-screen triangle (2D clip space)
      vao = gl.createVertexArray();
      vbo = gl.createBuffer();
      if (!vao || !vbo) throw new Error('Failed to allocate GL buffers');

      gl.bindVertexArray(vao);
      gl.bindBuffer(gl.ARRAY_BUFFER, vbo);

      // Triangle: (-1,-1), (3,-1), (-1,3)
      const verts = new Float32Array([-1, -1, 3, -1, -1, 3]);
      gl.bufferData(gl.ARRAY_BUFFER, verts, gl.STATIC_DRAW);

      const aPos = gl.getAttribLocation(program, 'a_pos');
      gl.enableVertexAttribArray(aPos);
      gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, 0, 0);

      gl.bindVertexArray(null);
      gl.bindBuffer(gl.ARRAY_BUFFER, null);

      // Volume texture (prefer float for fidelity; fall back to 8-bit for compatibility)
      texVol = gl.createTexture();
      if (!texVol) throw new Error('Failed to allocate 3D texture');

      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_3D, texVol);
      gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);

      // Prefer float textures for fidelity, but honor the GPU-budgeted plan (which may request u8).
      let fmt: VolumeTextureFormat;

      gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_WRAP_R, gl.CLAMP_TO_EDGE);

      const tryUpload = (candidate: VolumeTextureFormat, candidateData: ArrayBufferView) => {
        gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MIN_FILTER, candidate.minMagFilter);
        gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MAG_FILTER, candidate.minMagFilter);

        gl.texImage3D(
          gl.TEXTURE_3D,
          0,
          candidate.internalFormat,
          texDims.nx,
          texDims.ny,
          texDims.nz,
          0,
          candidate.format,
          candidate.type,
          candidateData,
        );

        const err = gl.getError();
        return err === gl.NO_ERROR;
      };

      if (renderTex.kind === 'u8') {
        fmt = fallback;
        if (!tryUpload(fallback, renderTex.data)) {
          throw new Error('The GPU could not upload the 8-bit reconstructed volume.');
        }
      } else {
        fmt = primary;
        // The float render volume uploads as R16F (half bandwidth/memory of R32F, and
        // linearly filterable in core WebGL2). The Uint16Array of half bits is transient:
        // nothing retains it after texImage3D copies it to the GPU.
        const halfFloatBits = preparedRender?.halfFloatBits ?? float32ToFloat16Bits(renderTex.data as Float32Array);
        let uploadedHalfFloat = false;

        try {
          uploadedHalfFloat = tryUpload(primary, halfFloatBits);
        } catch {
          uploadedHalfFloat = false;
        }

        if (!uploadedHalfFloat) {
          // Fall back to 8-bit normalized.
          fmt = fallback;
          if (!tryUpload(fallback, toUint8Volume(renderTex.data as Float32Array))) {
            throw new Error('The GPU could not upload either half-float or 8-bit volume textures.');
          }
        }
      }

      setActualTextureFormat(fmt.kind);

      console.info('[svr3d] Volume texture format', {
        kind: fmt.kind,
        texDims,
        sourceDims: { nx: volume.dims[0], ny: volume.dims[1], nz: volume.dims[2] },
      });

      gl.bindTexture(gl.TEXTURE_3D, null);

      // Keep acquired evidence independent from linearly filtered intensity: dark
      // acquired tissue remains valid, while unsupported gaps cannot invent anatomy.
      const supportTexture = createObservedSupportTexture(gl, {
        data: renderTex.observedSupport,
        dims: texDims,
      });
      texSupport = supportTexture.texture;
      supportEnabled = supportTexture.enabled;

      // Occupancy max-grid for empty-space skipping: one R8 texel per 8^3 block of the
      // render volume, built once per upload from the same data the volume texture holds.
      // Rays leap blocks whose conservative max can't pass the threshold test (the bulk of
      // the box on a typical brain scan), trading a full-res tap for a tiny-texture tap.
      const occGrid =
        preparedRender?.occupancy ??
        buildOccupancyMaxGrid({
          data: renderTex.data,
          dims: texDims,
          observedSupport: renderTex.observedSupport,
          visibilityThreshold: INITIAL_VOLUME_VISIBILITY_THRESHOLD,
        });
      occMaxCell = [occGrid.dims.nx - 1, occGrid.dims.ny - 1, occGrid.dims.nz - 1];
      // Frame acquired anatomy once per volume upload. Neither a browsed plane
      // nor its loading/visibility state can move this camera target.
      const visibleBounds = occGrid.visibleBounds;
      const renderDimensions = [texDims.nx, texDims.ny, texDims.nz];
      const anatomyFocus = visibleBounds
        ? {
            center: boxScale.map(
              (extent, axis) =>
                ((visibleBounds.min[axis]! + visibleBounds.max[axis]! + 1) / (2 * renderDimensions[axis]!) - 0.5) *
                extent,
            ) as [number, number, number],
            boxScale: boxScale.map(
              (extent, axis) =>
                ((visibleBounds.max[axis]! - visibleBounds.min[axis]! + 1) / renderDimensions[axis]!) * extent,
            ) as [number, number, number],
          }
        : undefined;

      texOcc = gl.createTexture();
      if (!texOcc) throw new Error('Failed to allocate occupancy 3D texture');

      gl.activeTexture(gl.TEXTURE3);
      gl.bindTexture(gl.TEXTURE_3D, texOcc);
      gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);

      gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_WRAP_R, gl.CLAMP_TO_EDGE);
      // The shader reads cells with texelFetch (exact integer coords); filtering modes are
      // set only to keep the texture complete.
      gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);

      gl.texImage3D(
        gl.TEXTURE_3D,
        0,
        gl.R8,
        occGrid.dims.nx,
        occGrid.dims.ny,
        occGrid.dims.nz,
        0,
        gl.RED,
        gl.UNSIGNED_BYTE,
        occGrid.data,
      );
      if (gl.getError() !== gl.NO_ERROR) {
        throw new Error('The GPU could not upload the empty-space acceleration grid.');
      }

      gl.bindTexture(gl.TEXTURE_3D, null);

      // Label texture (uint8 IDs). We always allocate a valid texture to keep the shader path stable,
      // even when no segmentation is present yet.
      texLabels = gl.createTexture();
      if (!texLabels) throw new Error('Failed to allocate label 3D texture');

      gl.activeTexture(gl.TEXTURE1);
      gl.bindTexture(gl.TEXTURE_3D, texLabels);
      gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);

      gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_WRAP_R, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);

      // Lazy allocation: keep a tiny 1x1x1 "no label" texture until we actually need to show labels.
      gl.texImage3D(
        gl.TEXTURE_3D,
        0,
        gl.R8UI,
        LABEL_PLACEHOLDER_DIMS.nx,
        LABEL_PLACEHOLDER_DIMS.ny,
        LABEL_PLACEHOLDER_DIMS.nz,
        0,
        gl.RED_INTEGER,
        gl.UNSIGNED_BYTE,
        LABEL_PLACEHOLDER_DATA,
      );

      gl.bindTexture(gl.TEXTURE_3D, null);

      // Palette texture: 256x1 RGBA8 lookup table for label->color.
      texPalette = gl.createTexture();
      if (!texPalette) throw new Error('Failed to allocate label palette texture');

      gl.activeTexture(gl.TEXTURE2);
      gl.bindTexture(gl.TEXTURE_2D, texPalette);
      gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);

      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);

      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, 256, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array(256 * 4));
      gl.bindTexture(gl.TEXTURE_2D, null);

      glLabelStateRef.current = {
        gl,
        texLabels,
        texPalette,
        texDims,
        labelsTexDims: LABEL_PLACEHOLDER_DIMS,
        labelData: null,
      };
      setGlEpoch((v) => v + 1);

      const u = {
        vol: gl.getUniformLocation(program, 'u_vol'),
        support: gl.getUniformLocation(program, 'u_support'),
        supportEnabled: gl.getUniformLocation(program, 'u_supportEnabled'),
        labels: gl.getUniformLocation(program, 'u_labels'),
        palette: gl.getUniformLocation(program, 'u_palette'),
        labelsEnabled: gl.getUniformLocation(program, 'u_labelsEnabled'),
        labelMix: gl.getUniformLocation(program, 'u_labelMix'),
        tumorOnly: gl.getUniformLocation(program, 'u_tumorOnly'),
        windowLow: gl.getUniformLocation(program, 'u_windowLow'),
        windowWidth: gl.getUniformLocation(program, 'u_windowWidth'),
        clipEnabled: gl.getUniformLocation(program, 'u_clipEnabled'),
        clipZ: gl.getUniformLocation(program, 'u_clipZ'),
        cameraZ: gl.getUniformLocation(program, 'u_cameraZ'),
        cameraCenter: gl.getUniformLocation(program, 'u_cameraCenter'),
        focusEnabled: gl.getUniformLocation(program, 'u_focusEnabled'),
        focusMin: gl.getUniformLocation(program, 'u_focusMin'),
        focusMax: gl.getUniformLocation(program, 'u_focusMax'),

        occ: gl.getUniformLocation(program, 'u_occ'),
        occEnabled: gl.getUniformLocation(program, 'u_occEnabled'),
        occBlock: gl.getUniformLocation(program, 'u_occBlock'),
        occMaxCell: gl.getUniformLocation(program, 'u_occMaxCell'),

        invRot: gl.getUniformLocation(program, 'u_invRot'),
        box: gl.getUniformLocation(program, 'u_box'),
        aspect: gl.getUniformLocation(program, 'u_aspect'),
        zoom: gl.getUniformLocation(program, 'u_zoom'),
        thr: gl.getUniformLocation(program, 'u_thr'),
        steps: gl.getUniformLocation(program, 'u_steps'),
        gamma: gl.getUniformLocation(program, 'u_gamma'),
        opacity: gl.getUniformLocation(program, 'u_opacity'),
        texel: gl.getUniformLocation(program, 'u_texel'),
        jitter: gl.getUniformLocation(program, 'u_jitter'),
      } as const;

      const rotMat = new Float32Array(9);
      const invRotMat = new Float32Array(9);

      const axesCanvas = axesCanvasRef.current;
      const axesCtx = axesCanvas ? axesCanvas.getContext('2d') : null;

      // Native MRI planes benefit from full device resolution. Bound the framebuffer
      // by pixels rather than reducing every high-density display to 1.5x.
      const MAX_SETTLED_PIXELS = 4_194_304;
      // While the user is actively rotating/zooming, drop to half resolution (4x fewer rays)
      // and ~1/2.7 the march steps; the shader's jittered ray start masks the step banding.
      // The settle frame after interaction restores full quality.
      const INTERACTION_SCALE = 0.5;
      const INTERACTION_STEPS = 96;

      const resizeAndViewport = (scale: number) => {
        const dpr = Math.min(
          window.devicePixelRatio || 1,
          Math.sqrt(MAX_SETTLED_PIXELS / Math.max(1, canvas.clientWidth * canvas.clientHeight)),
        );
        const w = Math.max(1, Math.floor(canvas.clientWidth * dpr * scale));
        const h = Math.max(1, Math.floor(canvas.clientHeight * dpr * scale));
        if (canvas.width !== w || canvas.height !== h) {
          canvas.width = w;
          canvas.height = h;
        }

        if (axesCanvas) {
          if (axesCanvas.width !== w || axesCanvas.height !== h) {
            axesCanvas.width = w;
            axesCanvas.height = h;
          }
        }

        gl.viewport(0, 0, canvas.width, canvas.height);
      };

      const draw = () => {
        if (contextLostRef.current || gl.isContextLost()) return;
        const interacting = interactingRef.current;

        resizeAndViewport(interacting ? INTERACTION_SCALE : 1);

        const {
          threshold,
          steps,
          gamma,
          opacity,
          zoom,
          labelsEnabled,
          labelMix,
          hasLabels,
          tumorOnly,
          tumorFocus,
          windowRange,
          cutaway,
          clipZ,
        } = paramsRef.current;

        gl.disable(gl.DEPTH_TEST);
        gl.disable(gl.CULL_FACE);

        gl.useProgram(program);
        gl.bindVertexArray(vao);

        const native = nativeDisplayRef.current;
        glNativeRef.current?.setPlane(native.enabled ? native.plane : null, native.enabled ? native.mask : null);
        glNativeRef.current?.bind({
          enabled: native.enabled && Boolean(native.plane),
          selectionOnly: hasLabels && tumorOnly,
          contour: native.contour,
          cutaway: native.cutaway,
          windowRange: native.windowRange,
          interpolate: native.interpolate,
        });

        const enhanced = enhancementDisplayRef.current;
        try {
          glEnhancementRef.current?.upload(enhanced.result, enhanced.source);
          glEnhancementRef.current?.apply({
            enabled: enhanced.enabled && Boolean(enhanced.result),
            strength: enhanced.strength,
            smoothSurface: enhanced.enabled && enhanced.strength > 0,
          });
        } catch (error) {
          glEnhancementRef.current?.apply({ enabled: false, strength: 0, smoothSurface: false });
          if (enhanced.result) enhanced.failDisplay(enhanced.result, error);
        }

        // Bind textures
        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_3D, texVol);
        gl.uniform1i(u.vol, 0);

        gl.activeTexture(gl.TEXTURE1);
        gl.bindTexture(gl.TEXTURE_3D, texLabels);
        gl.uniform1i(u.labels, 1);

        gl.activeTexture(gl.TEXTURE2);
        gl.bindTexture(gl.TEXTURE_2D, texPalette);
        gl.uniform1i(u.palette, 2);

        gl.activeTexture(gl.TEXTURE3);
        gl.bindTexture(gl.TEXTURE_3D, texOcc);
        gl.uniform1i(u.occ, 3);
        gl.uniform1i(u.occEnabled, texOcc ? 1 : 0);
        gl.uniform1i(u.occBlock, SVR3D_OCC_BLOCK);
        gl.uniform3i(u.occMaxCell, occMaxCell[0], occMaxCell[1], occMaxCell[2]);

        gl.activeTexture(gl.TEXTURE4);
        gl.bindTexture(gl.TEXTURE_3D, texSupport);
        gl.uniform1i(u.support, 4);
        gl.uniform1i(u.supportEnabled, supportEnabled ? 1 : 0);

        // One visualization mode owns both the object and its MRI cross-section.
        const labelsOn = labelsEnabled && hasLabels ? 1 : 0;
        const isolatedVolume = labelsOn && tumorOnly;
        gl.uniform1i(u.labelsEnabled, labelsOn);
        gl.uniform1i(u.tumorOnly, isolatedVolume ? 1 : 0);
        gl.uniform1f(u.windowLow, windowRange[0]);
        gl.uniform1f(u.windowWidth, Math.max(0, windowRange[1] - windowRange[0]));
        gl.uniform1i(u.clipEnabled, cutaway ? 1 : 0);
        gl.uniform1f(u.clipZ, clipZ);
        // Camera fitting never cuts an arbitrary box out of whole anatomy.
        // Bounds are only a traversal optimization for already-isolated labels.
        gl.uniform1i(u.focusEnabled, isolatedVolume && tumorFocus ? 1 : 0);
        gl.uniform3f(u.focusMin, ...(tumorFocus?.min ?? [0, 0, 0]));
        gl.uniform3f(u.focusMax, ...(tumorFocus?.max ?? [0, 0, 0]));
        gl.uniform1f(u.labelMix, clamp(labelMix, 0, 1));

        // Uniforms
        mat3FromQuat(rotationRef.current, rotMat);
        // WebGL requires transpose=false. Supply the inverse explicitly while retaining
        // the forward matrix for the physical-axis overlay.
        invRotMat[0] = rotMat[0]!;
        invRotMat[1] = rotMat[3]!;
        invRotMat[2] = rotMat[6]!;
        invRotMat[3] = rotMat[1]!;
        invRotMat[4] = rotMat[4]!;
        invRotMat[5] = rotMat[7]!;
        invRotMat[6] = rotMat[2]!;
        invRotMat[7] = rotMat[5]!;
        invRotMat[8] = rotMat[8]!;
        gl.uniformMatrix3fv(u.invRot, false, invRotMat);
        gl.uniform3f(u.box, boxScale[0], boxScale[1], boxScale[2]);
        gl.uniform1f(u.aspect, canvas.width / Math.max(1, canvas.height));
        const camera = volumeCamera(boxScale, rotMat, canvas.width, canvas.height, tumorFocus ?? anatomyFocus, zoom);
        gl.uniform1f(u.cameraZ, camera.distance);
        gl.uniform3f(u.cameraCenter, ...camera.center);
        gl.uniform1f(u.zoom, camera.zoom);
        gl.uniform1f(u.thr, clamp(threshold, 0, THRESHOLD_MAX));
        // Fewer steps while interacting (banding hidden by the jittered ray start); the
        // settled frame always marches the full configured step count.
        gl.uniform1i(u.steps, Math.round(clamp(interacting ? Math.min(INTERACTION_STEPS, steps) : steps, 8, 1024)));
        gl.uniform1f(u.jitter, interacting ? 1 : 0);
        gl.uniform1f(u.gamma, clamp(gamma, 0.1, 10));
        gl.uniform1f(u.opacity, clamp(opacity, 0.1, 20));
        gl.uniform3f(u.texel, 1 / Math.max(1, texDims.nx), 1 / Math.max(1, texDims.ny), 1 / Math.max(1, texDims.nz));

        gl.drawArrays(gl.TRIANGLES, 0, 3);

        // Keep truthful physical orientation and dimensions in the quiet corner.
        if (axesCanvas && axesCtx) {
          drawAxesOverlay({ axesCanvas, axesCtx, canvas, volume, rotMat });
        }

        // Reset bindings (avoid leaking WebGL state across frames).
        gl.activeTexture(gl.TEXTURE4);
        gl.bindTexture(gl.TEXTURE_3D, null);
        gl.activeTexture(gl.TEXTURE3);
        gl.bindTexture(gl.TEXTURE_3D, null);
        gl.activeTexture(gl.TEXTURE2);
        gl.bindTexture(gl.TEXTURE_2D, null);
        gl.activeTexture(gl.TEXTURE1);
        gl.bindTexture(gl.TEXTURE_3D, null);
        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_3D, null);

        gl.bindVertexArray(null);
      };

      // Render-on-demand scheduler: draw() no longer self-schedules. Every source of visual
      // change (rotation, zoom, control params, label uploads, resizes) calls
      // requestRender, which coalesces into at most one frame per RAF. An idle viewer
      // schedules nothing and costs zero GPU time.
      let frameFailed = false;
      const requestRender = () => {
        if (raf) return;
        raf = window.requestAnimationFrame(() => {
          raf = 0;
          try {
            draw();
            if (frameFailed) {
              frameFailed = false;
              setInitError(null);
            }
          } catch (reason) {
            frameFailed = true;
            setInitError(
              reason instanceof Error
                ? reason.message
                : 'The MRI frame could not be rendered. Try another source or disable the original-image plane.',
            );
          }
        });
      };

      requestRenderRef.current = requestRender;

      // The free-running loop used to pick up CSS size changes implicitly; on-demand
      // rendering needs an explicit nudge when the canvas is resized by layout.
      resizeObserver = new ResizeObserver(() => requestRender());
      resizeObserver.observe(canvas);

      requestRender();
      // GPU uploads own their data after texImage; release the transient
      // cooperative half-float and occupancy staging buffers immediately.
      if (preparedRenderRef.current === preparedRender) preparedRenderRef.current = null;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error('[SVR3D] Failed to initialize:', e);
      setInitError(msg);
    }

    return () => {
      // Detach the on-demand entry points first so late invalidations (settle timers,
      // label effects) can't schedule a frame against torn-down GL state.
      requestRenderRef.current = null;
      resizeObserver?.disconnect();

      if (raf) window.cancelAnimationFrame(raf);

      glLabelStateRef.current = null;
      glNativeRef.current?.dispose();
      glNativeRef.current = null;
      glEnhancementRef.current?.dispose();
      glEnhancementRef.current = null;

      if (gl) {
        if (texVol) gl.deleteTexture(texVol);
        if (texLabels) gl.deleteTexture(texLabels);
        if (texPalette) gl.deleteTexture(texPalette);
        if (texOcc) gl.deleteTexture(texOcc);
        if (texSupport) gl.deleteTexture(texSupport);
        if (vbo) gl.deleteBuffer(vbo);
        if (vao) gl.deleteVertexArray(vao);
        if (program) gl.deleteProgram(program);
      }
    };
  }, [boxScale, contextEpoch, renderBuild.key, renderBuild.status, renderBuild.data, volume]);

  // Incrementally upload label data + palette without re-initializing the whole GL program.
  // Keep the accepted label texture resident when the user temporarily views anatomy alone.
  useEffect(() => {
    const st = glLabelStateRef.current;
    if (!st) return;

    const { gl, texLabels, texPalette, texDims } = st;

    if (!volume || !labels || !hasLabels) {
      if (volume && labels && !hasLabels) {
        console.warn('[svr3d] Ignoring label volume (dims mismatch)', {
          volumeDims: volume.dims,
          labelDims: labels.dims,
          labelLen: labels.data.length,
        });
      }

      // No labels means any pending dirty region / downsample cache describes a buffer
      // that's no longer rendered.
      labelDirtyRef.current = null;
      labelDsCacheRef.current = null;
      st.labelData = null;

      // Free GPU label texture memory when not in use.
      if (
        st.labelsTexDims.nx !== LABEL_PLACEHOLDER_DIMS.nx ||
        st.labelsTexDims.ny !== LABEL_PLACEHOLDER_DIMS.ny ||
        st.labelsTexDims.nz !== LABEL_PLACEHOLDER_DIMS.nz
      ) {
        try {
          gl.activeTexture(gl.TEXTURE1);
          gl.bindTexture(gl.TEXTURE_3D, texLabels);
          gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
          gl.texImage3D(
            gl.TEXTURE_3D,
            0,
            gl.R8UI,
            LABEL_PLACEHOLDER_DIMS.nx,
            LABEL_PLACEHOLDER_DIMS.ny,
            LABEL_PLACEHOLDER_DIMS.nz,
            0,
            gl.RED_INTEGER,
            gl.UNSIGNED_BYTE,
            LABEL_PLACEHOLDER_DATA,
          );
          gl.bindTexture(gl.TEXTURE_3D, null);

          st.labelsTexDims = LABEL_PLACEHOLDER_DIMS;
        } catch (e) {
          console.warn('[svr3d] Failed to reset label texture to placeholder', e);
        } finally {
          gl.activeTexture(gl.TEXTURE0);
        }
      }

      return;
    }

    const srcDims = { nx: volume.dims[0], ny: volume.dims[1], nz: volume.dims[2] };
    const dstDims = texDims;

    const sameDims = srcDims.nx === dstDims.nx && srcDims.ny === dstDims.ny && srcDims.nz === dstDims.nz;
    const dsKey = `${srcDims.nx}x${srcDims.ny}x${srcDims.nz}>${dstDims.nx}x${dstDims.ny}x${dstDims.nz}`;

    const texAllocated =
      st.labelsTexDims.nx === dstDims.nx && st.labelsTexDims.ny === dstDims.ny && st.labelsTexDims.nz === dstDims.nz;

    // Never apply a patch to a different source buffer, even if its dimensions match.
    const dirty = labelDirtyRef.current;
    labelDirtyRef.current = null;
    const partial = texAllocated && dirty !== null && dirty.data === labels.data && dirty.previousData === st.labelData;

    try {
      // Label IDs (uint8)
      gl.activeTexture(gl.TEXTURE1);
      gl.bindTexture(gl.TEXTURE_3D, texLabels);
      gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);

      // Upload a sub-box straight out of a full-volume array: WebGL2's unpack parameters
      // describe the source row/image strides + skip offsets, so no CPU-side repack of the
      // dirty region is needed. Always reset the params — they're context-global state.
      const uploadSubBox = (data: Uint8Array, dims: RenderDims, min: Vec3i, max: Vec3i) => {
        gl.pixelStorei(gl.UNPACK_ROW_LENGTH, dims.nx);
        gl.pixelStorei(gl.UNPACK_IMAGE_HEIGHT, dims.ny);
        gl.pixelStorei(gl.UNPACK_SKIP_PIXELS, min.x);
        gl.pixelStorei(gl.UNPACK_SKIP_ROWS, min.y);
        gl.pixelStorei(gl.UNPACK_SKIP_IMAGES, min.z);
        try {
          gl.texSubImage3D(
            gl.TEXTURE_3D,
            0,
            min.x,
            min.y,
            min.z,
            max.x - min.x + 1,
            max.y - min.y + 1,
            max.z - min.z + 1,
            gl.RED_INTEGER,
            gl.UNSIGNED_BYTE,
            data,
          );
        } finally {
          gl.pixelStorei(gl.UNPACK_ROW_LENGTH, 0);
          gl.pixelStorei(gl.UNPACK_IMAGE_HEIGHT, 0);
          gl.pixelStorei(gl.UNPACK_SKIP_PIXELS, 0);
          gl.pixelStorei(gl.UNPACK_SKIP_ROWS, 0);
          gl.pixelStorei(gl.UNPACK_SKIP_IMAGES, 0);
        }
      };

      const dsCache = labelDsCacheRef.current;

      if (st.labelData === labels.data || (partial && dirty.max.x < dirty.min.x)) {
        // Review state and editing marks can change without changing any voxel labels.
      } else if (partial && sameDims) {
        // Texture is a 1:1 copy of the label volume: patch the dirty box directly.
        uploadSubBox(labels.data, srcDims, dirty.min, dirty.max);
      } else if (partial && dsCache && dsCache.src === dirty.previousData && dsCache.key === dsKey) {
        // Texture is a downsampled copy: refresh only the mapped region of the persistent
        // CPU cache, then patch that region. This is what keeps grow previews interactive
        // on volumes large enough to need a label LOD.
        const dstBox = updateLabelsNearestRegion({
          src: labels.data,
          srcDims,
          dst: dsCache.data,
          dstDims,
          srcBox: { min: dirty.min, max: dirty.max },
        });
        if (dstBox) {
          uploadSubBox(dsCache.data, dstDims, dstBox.min, dstBox.max);
        }
      } else {
        // Full path: first upload for this texture/buffer, or a buffer we have no dirty
        // info for. (Re)build the downsample cache here so subsequent ticks can go partial.
        let dataForUpload: Uint8Array;
        if (sameDims) {
          dataForUpload = labels.data;
          labelDsCacheRef.current = null;
        } else {
          dataForUpload = downsampleLabelsNearest({ src: labels.data, srcDims, dstDims });
          labelDsCacheRef.current = { src: labels.data, key: dsKey, data: dataForUpload };
        }

        if (!texAllocated) {
          // Allocate+upload in one go (avoids ever allocating a full-size zero fill array).
          gl.texImage3D(
            gl.TEXTURE_3D,
            0,
            gl.R8UI,
            dstDims.nx,
            dstDims.ny,
            dstDims.nz,
            0,
            gl.RED_INTEGER,
            gl.UNSIGNED_BYTE,
            dataForUpload,
          );
          st.labelsTexDims = { nx: dstDims.nx, ny: dstDims.ny, nz: dstDims.nz };
        } else {
          gl.texSubImage3D(
            gl.TEXTURE_3D,
            0,
            0,
            0,
            0,
            dstDims.nx,
            dstDims.ny,
            dstDims.nz,
            gl.RED_INTEGER,
            gl.UNSIGNED_BYTE,
            dataForUpload,
          );
        }
      }

      st.labelData = labels.data;
      if (labelDsCacheRef.current) labelDsCacheRef.current.src = labels.data;

      gl.bindTexture(gl.TEXTURE_3D, null);

      // Palette lookup table (memoized buffer — rebuilding it per tick was wasted work,
      // and the 1 KiB upload itself is negligible).
      if (labelPalette) {
        gl.activeTexture(gl.TEXTURE2);
        gl.bindTexture(gl.TEXTURE_2D, texPalette);
        gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
        gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, 256, 1, gl.RGBA, gl.UNSIGNED_BYTE, labelPalette);
        gl.bindTexture(gl.TEXTURE_2D, null);
      }
    } catch (e) {
      console.warn('[svr3d] Failed to upload label textures', e);
    } finally {
      gl.activeTexture(gl.TEXTURE0);
      // New label content must trigger a repaint under on-demand rendering. (The
      // placeholder-reset early return above doesn't need one: it only runs when labels
      // were just disabled/removed, and that state change repaints via the params effect.)
      requestRenderRef.current?.();
    }
  }, [glEpoch, hasLabels, labelPalette, labels, volume]);

  const onViewerKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLCanvasElement>) => {
      const { key } = event;
      if (key === 'ArrowLeft' || key === 'ArrowRight' || key === 'ArrowUp' || key === 'ArrowDown') {
        const horizontal = key === 'ArrowLeft' || key === 'ArrowRight';
        const axis = horizontal ? { x: 0, y: 1, z: 0 } : { x: 1, y: 0, z: 0 };
        const angle = key === 'ArrowLeft' || key === 'ArrowUp' ? -Math.PI / 36 : Math.PI / 36;
        rotationRef.current = quatNormalize(quatMultiply(quatFromAxisAngle(axis, angle), rotationRef.current));
        markInteraction();
      } else if (key === '+' || key === '=' || key === '-') {
        setZoom((current) => clamp(key === '-' ? current / 1.15 : current * 1.15, 0.6, 10));
        markInteraction();
      } else if (key === '0') {
        resetView();
      } else if ((key === '[' || key === ']') && nativeSource) {
        setNativeFrameIndex(nativeFrameIndex + (key === '[' ? -1 : 1));
      } else if (key === 'Escape') {
        if (!dragRef.current) return;
        dragRef.current = null;
      } else {
        return;
      }

      event.preventDefault();
      event.stopPropagation();
    },
    [markInteraction, resetView, setZoom, nativeSource, nativeFrameIndex, setNativeFrameIndex],
  );

  return {
    volume,
    enhancement,
    THRESHOLD_MAX,
    actualTextureFormat,
    axesCanvasRef,
    cancelOnnxSegmentation,
    canvasRef,
    controlsCollapsed,
    cursor,
    editingCursor,
    setCursor,
    cutaway,
    setCutaway,
    windowRange,
    setWindowRange,
    nativeImage,
    nativeSources,
    nativeSource,
    nativeSourceIndex,
    setNativeSourceIndex,
    nativeFrameIndex,
    setNativeFrameIndex,
    nativePlaneEnabled,
    setNativePlaneEnabled,
    nativeContour,
    setNativeContour,
    nativeCutaway,
    setNativeCutaway,
    nativeInterpolate,
    setNativeInterpolate,
    nativeWindowRange,
    setNativeWindowRange,
    resetNativeWindow: () => setNativeWindowSetting(null),
    faceNativePlane,
    fitSelection,
    gamma,
    hasLabels,
    hasTumorLabels,
    initError,
    labelMetrics,
    labels,
    currentMigration,
    copySavedSelection,
    cancelSavedTransfer,
    observedSupportSummary,
    onSelectionChange,
    refineRegion: refineRegion ? refineWithEnhancement : undefined,
    proposeSelection: proposeWithEnhancement,
    selectionReady:
      (!volumeKey || (hydrated?.key === volumeKey && hydrated.volume === volume)) &&
      !labelsOverride &&
      !onnxSegRunning &&
      !currentMigration?.running &&
      !enhancement.running &&
      !busy,
    selectionDisabledReason: enhancement.running
      ? 'Enhancing detail. Your selection is unchanged; cancel enhancement to edit it.'
      : currentMigration?.running
        ? 'Copying a saved selection as a draft. The original selection remains saved.'
        : busy
          ? 'Reconstructing detail. Your current selection is preserved; editing resumes when it finishes.'
          : labelsOverride
            ? 'This external selection is read-only.'
            : onnxSegRunning
              ? 'Model computation is running. Cancel it before editing.'
              : 'Loading saved selection…',
    storageError: storageError?.key === volumeKey ? storageError.phase : null,
    retryStorage: () =>
      setStorageRetry((current) => ({
        ...current,
        [storageError?.phase ?? 'load']: current[storageError?.phase ?? 'load'] + 1,
      })),
    onPointerDown,
    onPointerMove,
    onPointerUp,
    onViewerKeyDown,
    onnxClearModel,
    onnxFileInputRef,
    onnxHandleSelectedFiles,
    onnxPreflight,
    onnxSegRunning,
    onnxStatus,
    onnxUploadClick,
    opacity,
    renderBuild,
    renderPlan,
    resetView,
    runOnnxSegmentation,
    setControlsCollapsed,
    setGamma,
    setOpacity,
    setThreshold,
    setVisualizationMode,
    threshold,
    visualizationMode: activeVisualizationMode,
  };
}

type SvrVolumeViewerModel = ReturnType<typeof useSvrVolumeViewerModel>;
const SvrViewerControlsContext = createContext<SvrVolumeViewerModel | null>(null);
function useViewerControls() {
  const controls = useContext(SvrViewerControlsContext);
  if (!controls) throw new Error('The 3D controls require their reconstruction workspace.');
  return controls;
}

function SvrEnhancementControls({
  selectionRunning,
  prepareEnhancement,
}: {
  selectionRunning: boolean;
  prepareEnhancement: number | (() => number);
}) {
  const model = useViewerControls();
  const detail = model.enhancement;
  if (!model.hasTumorLabels && !detail.running && !detail.result && !detail.error && !detail.message) return null;
  return (
    <div className="svr-enhancement-controls" aria-label="Super-resolution detail">
      <div className="svr-enhancement-actions">
        {detail.running ? (
          <>
            <progress aria-label="Enhancement progress" value={detail.progress} max={1} />
            <span className="svr-enhancement-percent">{Math.round(detail.progress * 100)}%</span>
            <button type="button" onClick={detail.cancel}>
              Cancel enhancement
            </button>
          </>
        ) : detail.result ? (
          <div role="group" aria-label="Volume detail comparison" className="svr-enhancement-comparison">
            <button type="button" aria-pressed={!detail.enabled} onClick={() => detail.setEnabled(false)}>
              Original
            </button>
            <button type="button" aria-pressed={detail.enabled} onClick={() => detail.setEnabled(true)}>
              Enhanced · 2×
            </button>
          </div>
        ) : (
          <button
            type="button"
            aria-label="Enhance selection · 2×"
            disabled={!model.hasTumorLabels || !model.selectionReady || selectionRunning}
            title={
              selectionRunning
                ? 'Wait for the boundary suggestion to finish before enhancing this region.'
                : model.hasTumorLabels
                  ? 'Learn 3D detail from this examination and enhance the selected region locally.'
                  : 'Mark a region to enhance its detail.'
            }
            onClick={async () => {
              if (await detail.run(prepareEnhancement)) {
                model.setVisualizationMode('tumor');
                model.fitSelection();
              }
            }}
          >
            Enhance · 2×
          </button>
        )}
      </div>
      {detail.running ? (
        <p role="status">{detail.message}</p>
      ) : detail.result ? (
        <p className="svr-enhancement-provenance" role="status">
          {detail.enabled ? 'Inferred detail—not acquired' : 'Original source detail'}
          {model.nativePlaneEnabled && model.nativeImage.plane
            ? ' · MRI plane shows original pixels'
            : ' · Saved selection unchanged'}
        </p>
      ) : detail.message ? (
        <p role="status">{detail.message}</p>
      ) : null}
      {detail.error ? (
        <p className="svr-enhancement-error" role="alert">
          {detail.error}
        </p>
      ) : null}
    </div>
  );
}

function SvrEnhancementSettings() {
  const { enhancement: detail } = useViewerControls();
  if (!detail.result) return null;
  const stats = detail.result.stats;
  const gain = stats.baselineMse > 0 ? 100 * (1 - stats.enhancedMse / stats.baselineMse) : null;
  return (
    <details className="svr-inspector-section svr-enhancement-info">
      <summary>Enhanced detail</summary>
      <div>
        <label className="svr-enhancement-strength">
          Strength
          <input
            aria-label="Super-resolution strength"
            type="range"
            min={0}
            max={100}
            step={5}
            value={detail.strength * 100}
            disabled={!detail.enabled}
            onChange={(event) => detail.setStrength(Number(event.currentTarget.value) / 100)}
          />
        </label>
        <p>
          Self-trained 3D super-resolution · 2× per axis. Finer texture and a sub-voxel display surface are inferred,
          not acquired. Original MRI planes and selection measurements stay unchanged.
        </p>
        <p>
          {stats.trainingSamples.toLocaleString()} training patches · {stats.heldOutBlocks} separate test blocks.
        </p>
        <p>
          {gain === null
            ? 'Held-out detail gain is not measurable in this region.'
            : gain > 0
              ? `${gain.toFixed(1)}% lower error than interpolation on synthetically reduced test patches.`
              : 'The model did not improve the held-out patch error over interpolation. Treat this view as experimental.'}{' '}
          This does not establish accuracy beyond the source resolution.
        </p>
        <p>
          Grid: {detail.result.dims.join(' × ')} ·{' '}
          {detail.result.voxelSizeMm.map((pitch) => pitch.toFixed(3)).join(' × ')} mm. Computed in{' '}
          {(stats.durationMs / 1000).toFixed(1)} s.
        </p>
        <button type="button" onClick={detail.clear}>
          Discard enhancement
        </button>
      </div>
    </details>
  );
}

/** Source controls live with the 3D scene; the editing views keep one linked cursor. */
function SvrNativePlaneControls() {
  const model = useViewerControls();
  const { nativeSources, nativeSource, nativeFrameIndex } = model;
  if (!nativeSources?.length || !nativeSource) return null;
  return (
    <div className="svr-native-controls" aria-label="Original MRI plane controls">
      <button
        type="button"
        aria-pressed={model.nativePlaneEnabled}
        onClick={() => model.setNativePlaneEnabled(!model.nativePlaneEnabled)}
        title="Reveal original MRI texture on a cross-section of the 3D volume"
      >
        MRI slice
      </button>
      {model.nativePlaneEnabled ? (
        <div className="svr-native-browse">
          <button
            type="button"
            aria-label="Previous original MRI slice"
            disabled={nativeFrameIndex === 0}
            onClick={() => model.setNativeFrameIndex(nativeFrameIndex - 1)}
          >
            <ChevronLeft size={14} />
          </button>
          <input
            type="range"
            aria-label="Original MRI slice position"
            min={0}
            max={nativeSource.frames.length - 1}
            step={1}
            value={nativeFrameIndex}
            onChange={(event) => model.setNativeFrameIndex(Number(event.currentTarget.value))}
          />
          <button
            type="button"
            aria-label="Next original MRI slice"
            disabled={nativeFrameIndex >= nativeSource.frames.length - 1}
            onClick={() => model.setNativeFrameIndex(nativeFrameIndex + 1)}
          >
            <ChevronRight size={14} />
          </button>
          <label>
            <span className="sr-only">Original MRI slice</span>
            <input
              type="number"
              aria-label="Original MRI slice"
              min={1}
              max={nativeSource.frames.length}
              value={nativeFrameIndex + 1}
              onChange={(event) => {
                if (Number.isFinite(event.currentTarget.valueAsNumber))
                  model.setNativeFrameIndex(event.currentTarget.valueAsNumber - 1);
              }}
            />
            <span>/ {nativeSource.frames.length}</span>
          </label>
        </div>
      ) : null}
    </div>
  );
}

function SvrNativePlaneSettings() {
  const model = useViewerControls();
  const { nativeSources, nativeSource, nativeImage, nativeWindowRange } = model;
  if (!nativeSources?.length || !nativeSource) return null;
  const title =
    nativeSource.kind === 'derived'
      ? 'Scanner reformat'
      : nativeSource.kind === 'unknown'
        ? 'MRI source'
        : 'Original MRI';
  const width = nativeWindowRange ? nativeWindowRange[1] - nativeWindowRange[0] : 1;
  const level = nativeWindowRange ? (nativeWindowRange[0] + nativeWindowRange[1]) / 2 : 0;
  const sourceWindowWidth = Math.max(
    1,
    (nativeImage.plane?.windowRange[1] ?? 1) - (nativeImage.plane?.windowRange[0] ?? 0),
  );
  return (
    <details className="svr-inspector-section svr-native-settings">
      <summary>Source image</summary>
      <div>
        <div className="svr-native-heading">
          <span className="svr-source-kind">{title}</span>
          {nativeSources.length > 1 ? (
            <select
              aria-label="MRI plane source"
              value={model.nativeSourceIndex}
              onChange={(event) => model.setNativeSourceIndex(Number(event.currentTarget.value))}
            >
              {nativeSources.map((source, index) => (
                <option key={source.seriesUid} value={index}>
                  {source.label}
                  {source.kind === 'derived'
                    ? ' · derived'
                    : source.kind === 'unknown'
                      ? ' · unverified acquisition'
                      : ' · original'}
                </option>
              ))}
            </select>
          ) : (
            <span>{nativeSource.label}</span>
          )}
        </div>
        {model.nativePlaneEnabled ? (
          <>
            <div className="svr-native-view-options">
              <div className="svr-native-display-settings">
                <label>
                  <input
                    type="checkbox"
                    checked={model.nativeContour}
                    onChange={(event) => model.setNativeContour(event.currentTarget.checked)}
                  />{' '}
                  Selection contour
                </label>
                <label>
                  <input
                    type="checkbox"
                    checked={model.nativeCutaway}
                    onChange={(event) => model.setNativeCutaway(event.currentTarget.checked)}
                  />{' '}
                  Cut at MRI plane
                </label>
                <label title="Display interpolation only; no additional MRI detail is acquired">
                  <input
                    type="checkbox"
                    checked={model.nativeInterpolate}
                    onChange={(event) => model.setNativeInterpolate(event.currentTarget.checked)}
                  />{' '}
                  Interpolate display
                </label>
                <label>
                  Window{' '}
                  <input
                    type="range"
                    aria-label="Original MRI window width"
                    min={1}
                    max={sourceWindowWidth * 3}
                    step={Math.max(0.1, sourceWindowWidth / 500)}
                    value={width}
                    onChange={(event) => {
                      const next = Number(event.currentTarget.value);
                      model.setNativeWindowRange([level - next / 2, level + next / 2]);
                    }}
                  />
                </label>
                <label>
                  Level{' '}
                  <input
                    type="range"
                    aria-label="Original MRI window level"
                    min={(nativeImage.plane?.windowRange[0] ?? 0) - sourceWindowWidth}
                    max={(nativeImage.plane?.windowRange[1] ?? 1) + sourceWindowWidth}
                    step={Math.max(0.1, sourceWindowWidth / 500)}
                    value={level}
                    onChange={(event) => {
                      const next = Number(event.currentTarget.value);
                      model.setNativeWindowRange([next - width / 2, next + width / 2]);
                    }}
                  />
                </label>
                <button type="button" onClick={model.resetNativeWindow}>
                  Reset source contrast
                </button>
                <p>
                  The MRI cross-section follows the volume or selection view. Source contrast is independent of 3D
                  shading; original pixels stay unchanged.
                </p>
              </div>
              <span role="status" aria-live="off">
                {nativeImage.loading
                  ? 'Loading original…'
                  : nativeImage.plane
                    ? `${nativeImage.plane.frame.columns} × ${nativeImage.plane.frame.rows} · ${model.nativeInterpolate ? 'interpolated display' : 'source pixels'}`
                    : ''}
              </span>
            </div>
          </>
        ) : null}
      </div>
    </details>
  );
}

function SvrSavedSelectionNotice() {
  const model = useViewerControls();
  const migration = model.currentMigration;
  if (!migration || model.hasTumorLabels || (!migration.info.message && !migration.error)) return null;
  return (
    <div className="svr-selection-warning" role="status">
      {migration.error ?? migration.info.message}{' '}
      {migration.running ? (
        <button type="button" onClick={model.cancelSavedTransfer}>
          Cancel copy
        </button>
      ) : migration.info.candidate ? (
        <button type="button" disabled={!model.selectionReady} onClick={() => void model.copySavedSelection()}>
          Copy saved selection as draft
        </button>
      ) : null}
    </div>
  );
}

function SvrOnnxModelControls({ selectionRunning }: { selectionRunning: boolean }) {
  const model = useViewerControls();
  const {
    onnxClearModel,
    onnxFileInputRef,
    onnxHandleSelectedFiles,
    onnxPreflight,
    onnxSegRunning,
    onnxStatus,
    onnxUploadClick,
    runOnnxSegmentation,
    volume,
  } = model;

  return (
    <details className="svr-inspector-section">
      <summary>Custom model</summary>
      <div className="space-y-2">
        <p>Optional. Use your own verified ONNX model to suggest a draft selection.</p>
        <input
          ref={onnxFileInputRef}
          type="file"
          accept=".onnx,.json"
          multiple
          className="hidden"
          onChange={(e) => {
            if (e.target.files?.length) {
              onnxHandleSelectedFiles(Array.from(e.target.files));
            }
            // Allow re-uploading the same file.
            e.target.value = '';
          }}
        />

        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={onnxUploadClick}
            disabled={onnxStatus.loading}
            className="min-h-9 rounded-[4px] border border-[var(--border-color)] px-3 py-2 text-xs text-[var(--text-secondary)] transition-colors hover:bg-[var(--bg-tertiary)] hover:text-[var(--text-primary)] disabled:opacity-50"
          >
            Upload model + manifest
          </button>

          <button
            type="button"
            onClick={runOnnxSegmentation}
            disabled={
              !volume ||
              !onnxStatus.cached ||
              !onnxStatus.verified ||
              onnxStatus.loading ||
              !model.selectionReady ||
              selectionRunning ||
              !!onnxPreflight?.blockedByDefault
            }
            className="min-h-9 rounded-[4px] bg-[var(--bg-tertiary)] px-3 py-2 text-xs text-[var(--text-primary)] transition-colors hover:bg-[var(--accent)] disabled:opacity-50"
          >
            Suggest with model
          </button>

          <button
            type="button"
            onClick={onnxClearModel}
            disabled={!onnxStatus.cached || onnxStatus.loading}
            className="ml-auto min-h-9 rounded-[4px] border border-[var(--border-color)] px-3 py-2 text-xs text-[var(--text-secondary)] transition-colors hover:bg-[var(--bg-tertiary)] hover:text-[var(--text-primary)] disabled:opacity-50"
          >
            Clear model
          </button>
        </div>

        <details className="text-xs text-[var(--text-secondary)]">
          <summary className="cursor-pointer py-1 text-[var(--text-primary)]">
            Required verified model manifest (.json)
          </summary>
          <p className="mt-1">
            Select the ONNX model and its JSON sidecar together. The manifest must declare the model's exact SHA-256
            hash, MR input, preprocessing, axes, and tumor class meanings.
          </p>
          <pre className="mt-2 max-h-48 overflow-auto rounded bg-[var(--bg-primary)] p-2 text-xs">
            {JSON.stringify(TUMOR_MODEL_MANIFEST_EXAMPLE, null, 2)}
          </pre>
        </details>

        {onnxPreflight?.blockedByDefault ? (
          <div className="rounded-[4px] bg-[var(--bg-tertiary)] px-2 py-1 text-xs text-[var(--warning)]">
            Model inference would require approximately {formatMiB(onnxPreflight.estimatedPeakBytes)} of resident
            memory, exceeding the shared {formatMiB(onnxPreflight.budgetBytes)} SVR budget. Reconstruct a smaller focus
            region or use a lower resolution.
          </div>
        ) : null}

        {!onnxStatus.error && !onnxStatus.loading && !onnxSegRunning && onnxStatus.message ? (
          <div role="status" className="text-xs text-[var(--text-tertiary)]">
            {onnxStatus.message}
          </div>
        ) : null}
      </div>
    </details>
  );
}

function SvrSegmentationMetrics() {
  const model = useViewerControls();
  const { hasLabels, labelMetrics, labels } = model;

  if (labels?.reviewState !== 'reviewed')
    return (
      <div className="text-xs text-[var(--text-secondary)]">
        Review and confirm the selection before reporting a tissue volume.
      </div>
    );
  if (!hasLabels || !labels) {
    return <div className="text-xs text-[var(--text-tertiary)]">No segmentation labels available yet.</div>;
  }

  return (
    <div className="space-y-1">
      {labels.meta.map((m) => {
        if (m.id === 0) return null;
        const count = labelMetrics?.counts.get(m.id) ?? 0;
        const mm3 = count * (labelMetrics?.voxelVolMm3 ?? 0);
        const ml = mm3 / 1000;

        return (
          <div
            key={m.id}
            className="flex items-center gap-2 text-xs text-[var(--text-secondary)]"
            title={`${m.name} (id ${m.id})`}
          >
            <span
              className="inline-block w-2.5 h-2.5 rounded-sm border border-black/30"
              style={{ backgroundColor: rgbCss(m.color) }}
            />
            <span className="truncate">{m.name}</span>
            <span className="ml-auto tabular-nums text-[var(--text-tertiary)]">
              {count.toLocaleString()} vox · {mm3.toFixed(1)} mm³ · {ml.toFixed(2)} mL
            </span>
          </div>
        );
      })}

      {labelMetrics ? (
        <>
          <div className="pt-1 text-xs text-[var(--text-tertiary)] tabular-nums">
            Total labeled: {labelMetrics.totalCount.toLocaleString()} vox · {labelMetrics.totalMm3.toFixed(1)} mm³ ·{' '}
            {labelMetrics.totalMl.toFixed(2)} mL
          </div>
          {labelMetrics.unsupportedBoundaryCount > 0 ? (
            <div className="border-l-2 border-l-[var(--warning)] bg-[var(--bg-tertiary)] px-2 py-1 text-xs text-[var(--warning)]">
              Incomplete acquired coverage: {labelMetrics.unsupportedBoundaryCount.toLocaleString()} labeled boundary
              voxels touch unsupported anatomy or the reconstruction boundary. Reported volume includes observed voxels
              only and may be truncated.
            </div>
          ) : null}
        </>
      ) : null}
    </div>
  );
}

function SvrAppearanceControls() {
  const model = useViewerControls();
  const { THRESHOLD_MAX, gamma, opacity, resetView, setGamma, setOpacity, setThreshold, threshold, volume } = model;

  return (
    <section className="svr-appearance-controls" aria-label="3D appearance">
      <h3>Appearance</h3>

      <div className="grid grid-cols-2 gap-3">
        <label className="block text-xs text-[var(--text-secondary)]">
          Opacity
          <input
            type="range"
            min={0.1}
            max={20}
            step={0.1}
            value={opacity}
            onChange={(e) => setOpacity(Number(e.target.value))}
            className="mt-1 w-full"
            disabled={!volume}
          />
          <div className="mt-1 text-xs text-[var(--text-tertiary)] tabular-nums">{opacity.toFixed(1)}</div>
        </label>

        <label className="block text-xs text-[var(--text-secondary)]">
          Edge shading
          <input
            type="range"
            min={0.1}
            max={6}
            step={0.05}
            value={gamma}
            onChange={(e) => setGamma(Number(e.target.value))}
            className="mt-1 w-full"
            disabled={!volume}
          />
          <div className="mt-1 text-xs text-[var(--text-tertiary)] tabular-nums">{gamma.toFixed(2)}</div>
        </label>

        <label className="col-span-2 block text-xs text-[var(--text-secondary)]">
          Visibility threshold
          <input
            type="range"
            min={0}
            max={THRESHOLD_MAX}
            step={0.001}
            value={threshold}
            onChange={(e) => setThreshold(Number(e.target.value))}
            className="mt-1 w-full"
            disabled={!volume}
          />
          <div className="mt-1 text-xs text-[var(--text-tertiary)] tabular-nums">
            Uniform intensity cutoff {threshold.toFixed(3)}
          </div>
        </label>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={resetView}
          disabled={!volume}
          className="min-h-9 rounded-[4px] border border-[var(--border-color)] px-3 py-2 text-xs text-[var(--text-secondary)] transition-colors hover:bg-[var(--bg-tertiary)] hover:text-[var(--text-primary)] disabled:opacity-50"
        >
          Reset view
        </button>
        <button type="button" onClick={model.fitSelection} disabled={!model.hasTumorLabels}>
          Fit selection
        </button>
        {model.nativeSource ? (
          <button
            type="button"
            onClick={model.faceNativePlane}
            disabled={!model.nativeImage.plane}
            title="Look straight at the MRI slice, without changing its values or the selection"
          >
            Face slice
          </button>
        ) : null}
      </div>

      <div className="text-xs text-[var(--text-tertiary)]">
        Opacity and edge shading are applied evenly across the acquired volume; unsupported regions never become tissue.
      </div>
    </section>
  );
}

export function SvrVolume3DViewer(props: SvrVolume3DViewerProps) {
  const model = useSvrVolumeViewerModel(props);
  const {
    actualTextureFormat,
    axesCanvasRef,
    canvasRef,
    controlsCollapsed,
    initError,
    observedSupportSummary,
    onPointerDown,
    onPointerMove,
    onPointerUp,
    onViewerKeyDown,
    renderBuild,
    renderPlan,
    setControlsCollapsed,
    volume,
  } = model;
  const imaging = useMemo(
    () => ({
      volume,
      labels: model.labels,
      refineRegion: model.refineRegion,
      proposeSelection: model.proposeSelection,
    }),
    [volume, model.labels, model.refineRegion, model.proposeSelection],
  );
  const controlsButtonRef = useRef<HTMLButtonElement>(null);
  const settingsRef = useRef<HTMLElement>(null);
  useEffect(() => {
    if (!controlsCollapsed) settingsRef.current?.focus({ preventScroll: true });
  }, [controlsCollapsed]);
  const closeControls = () => {
    setControlsCollapsed(true);
    controlsButtonRef.current?.focus({ preventScroll: true });
  };
  const scene = (selectionRunning = false, prepareEnhancement: number | (() => number) = 0) => (
    <div className="svr-scene">
      {volume ? (
        <div className="svr-scene-toolbar">
          <SvrNativePlaneControls />
          <SvrEnhancementControls selectionRunning={selectionRunning} prepareEnhancement={prepareEnhancement} />
          <button
            ref={controlsButtonRef}
            type="button"
            onClick={() => setControlsCollapsed((value) => !value)}
            aria-label={controlsCollapsed ? 'Show 3D settings' : 'Hide 3D settings'}
            aria-expanded={!controlsCollapsed}
            className="svr-scene-settings-toggle"
          >
            <SlidersHorizontal size={15} aria-hidden="true" /> Settings
          </button>
        </div>
      ) : null}
      {model.nativePlaneEnabled && model.nativeImage.error ? (
        <p role="alert" className="svr-scene-notice svr-native-error">
          {model.nativeImage.error}
        </p>
      ) : null}
      {model.onnxSegRunning || model.onnxStatus.loading ? (
        <div className="svr-scene-notice" role="status">
          <span>{model.onnxStatus.message}</span>
          {model.onnxSegRunning ? (
            <button type="button" onClick={model.cancelOnnxSegmentation}>
              Cancel model suggestion
            </button>
          ) : null}
        </div>
      ) : model.onnxStatus.error ? (
        <p role="alert" className="svr-scene-notice svr-native-error">
          {model.onnxStatus.error}
        </p>
      ) : null}
      <div className="svr-scene-body" data-settings-open={!controlsCollapsed}>
        <div className="svr-scene-canvas">
          <canvas
            ref={canvasRef}
            className="absolute inset-0 w-full h-full"
            role="application"
            aria-label="Three-dimensional reconstructed MRI volume"
            aria-keyshortcuts="ArrowUp ArrowDown ArrowLeft ArrowRight + - 0 1 2 3 [ ] Escape"
            tabIndex={volume ? 0 : -1}
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
            onPointerCancel={onPointerUp}
            onKeyDown={onViewerKeyDown}
          />

          <canvas
            ref={axesCanvasRef}
            aria-hidden="true"
            className="absolute inset-0 w-full h-full pointer-events-none"
          />

          {!volume ? (
            <div className="absolute inset-0 flex items-center justify-center bg-[var(--bg-primary)] p-4 text-center text-xs text-[var(--text-secondary)]">
              Open a volume to explore it in 3D.
            </div>
          ) : initError ? (
            <div
              role="alert"
              className="absolute inset-0 flex items-center justify-center bg-[var(--bg-primary)] p-4 text-center text-sm text-[var(--warning)]"
            >
              {initError}
            </div>
          ) : renderBuild.status === 'error' ? (
            <div
              role="alert"
              className="absolute inset-0 flex items-center justify-center bg-[var(--bg-primary)] p-4 text-center text-sm text-[var(--danger)]"
            >
              {renderBuild.error ?? 'Failed to prepare 3D render volume.'}
            </div>
          ) : renderBuild.status !== 'ready' ? (
            <div className="absolute inset-0 flex items-center justify-center bg-[var(--bg-primary)] p-4 text-center text-xs text-[var(--text-secondary)]">
              <div className="space-y-2">
                <div>Preparing 3D render…</div>
                {renderPlan ? (
                  <div className="text-xs tabular-nums text-[var(--text-tertiary)]">
                    {renderPlan.dims.nx}×{renderPlan.dims.ny}×{renderPlan.dims.nz} ·{' '}
                    {renderPlan.kind === 'f32' ? 'float' : 'u8'} · {renderPlan.note}
                  </div>
                ) : null}
              </div>
            </div>
          ) : (
            <div className="absolute bottom-1 left-4 bg-[var(--bg-primary)] px-2 py-1 text-xs text-[var(--text-secondary)]">
              {model.nativePlaneEnabled && model.nativeSource
                ? 'Wheel / [ ]: MRI slices · Drag: rotate · +/−: zoom'
                : 'Drag or use arrow keys to rotate · Wheel or +/− to zoom'}
            </div>
          )}
        </div>
        {volume && !controlsCollapsed ? (
          <aside
            ref={settingsRef}
            tabIndex={-1}
            className={`svr-render-settings ${COARSE_POINTER_CONTROL_TARGETS}`}
            aria-label="3D settings"
            onKeyDown={(event) => {
              if (event.key === 'Escape') {
                event.preventDefault();
                event.stopPropagation();
                closeControls();
              }
            }}
          >
            <div className="svr-inspector-heading">
              <h2>3D settings</h2>
              <button type="button" onClick={closeControls} aria-label="Close 3D settings">
                <X size={16} aria-hidden="true" />
              </button>
            </div>
            <SvrAppearanceControls />
            <SvrNativePlaneSettings />
            <SvrEnhancementSettings />
            {renderPlan ? (
              <details className="svr-inspector-section svr-volume-details">
                <summary>
                  <span>Volume details</span>
                </summary>
                <div className="svr-volume-details-content">
                  <div className="mb-1 text-[var(--text-secondary)]">{volumeSamplingLabel(volume)}</div>
                  {volume.sourceProvenance ? (
                    <div className="mb-2 text-[var(--text-secondary)]">{volume.sourceProvenance.explanation}</div>
                  ) : null}
                  <div className="tabular-nums [font-family:var(--font-mono)]">
                    Render: {renderPlan.dims.nx} × {renderPlan.dims.ny} × {renderPlan.dims.nz}
                    {' · '}
                    {actualTextureFormat === 'f16'
                      ? '16-bit float'
                      : actualTextureFormat === 'u8'
                        ? '8-bit'
                        : 'preparing'}
                  </div>
                  {volume.acquiredOrientationCount !== undefined ? (
                    <div className="mt-1 text-[var(--text-secondary)]">
                      {volume.acquiredOrientationCount} source orientation
                      {volume.acquiredOrientationCount === 1 ? '' : 's'}
                    </div>
                  ) : null}
                  {volume.effectiveResolutionMm ? (
                    <div className="mt-1 tabular-nums text-[var(--text-secondary)]">
                      Source sampling estimate:{' '}
                      {volume.effectiveResolutionMm.map((value) => value.toFixed(2)).join(' × ')} mm
                    </div>
                  ) : null}
                  {volume.sliceProfileSource ? (
                    <div
                      className={
                        volume.sliceProfileSource === 'declared'
                          ? 'mt-1 text-[var(--text-secondary)]'
                          : 'mt-1 text-[var(--warning)]'
                      }
                    >
                      Slice profile: {volume.sliceProfileSource}
                      {volume.sliceProfileSource === 'unknown' ? ' (thickness was not declared)' : ''}
                    </div>
                  ) : null}
                  {observedSupportSummary ? (
                    <div
                      className={
                        observedSupportSummary.valid ? 'mt-1 text-[var(--evidence)]' : 'mt-1 text-[var(--warning)]'
                      }
                    >
                      {observedSupportSummary.valid
                        ? `Acquired support: ${observedSupportSummary.count.toLocaleString()} of ${observedSupportSummary.total.toLocaleString()} voxels (${Math.round((observedSupportSummary.count / Math.max(1, observedSupportSummary.total)) * 100)}%)`
                        : 'Acquired support does not match the reconstruction.'}
                    </div>
                  ) : null}
                </div>
              </details>
            ) : null}
            {model.hasTumorLabels ? (
              <details className="svr-inspector-section">
                <summary>Selection measurements</summary>
                <SvrSegmentationMetrics />
              </details>
            ) : null}
            <SvrOnnxModelControls selectionRunning={selectionRunning} />
          </aside>
        ) : null}
      </div>
    </div>
  );
  return (
    <SvrViewerControlsContext.Provider value={model}>
      <SvrImagingContext.Provider value={imaging}>
        <div className="svr-volume-layout h-full min-h-0" data-controls-open={Boolean(volume && !controlsCollapsed)}>
          {volume ? (
            <SvrSegmentationEditor
              onChange={model.onSelectionChange}
              disabled={!model.selectionReady}
              disabledReason={model.selectionDisabledReason}
              storageError={model.storageError}
              retryStorage={model.retryStorage}
              selectedVolumeMl={model.labelMetrics?.totalMl ?? 0}
              visualizationMode={model.visualizationMode}
              onVisualizationModeChange={model.setVisualizationMode}
              cursor={model.editingCursor}
              setCursor={model.setCursor}
              windowRange={model.windowRange}
              setWindowRange={model.setWindowRange}
              cutaway={model.cutaway}
              setCutaway={model.setCutaway}
              onShow3D={() => {
                model.setVisualizationMode(model.hasTumorLabels ? 'tumor' : 'anatomy');
                if (model.hasTumorLabels) {
                  model.fitSelection();
                }
              }}
              selectionNotice={<SvrSavedSelectionNotice />}
            >
              {scene}
            </SvrSegmentationEditor>
          ) : (
            scene()
          )}
        </div>
      </SvrImagingContext.Provider>
    </SvrViewerControlsContext.Provider>
  );
}
