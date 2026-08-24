import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ChevronDown, ChevronLeft, ChevronRight } from 'lucide-react';
import type { SvrLabelVolume, SvrVolume } from '../types/svr';
import { BRATS_BASE_LABEL_META, BRATS_LABEL_ID, type BratsBaseLabelId } from '../utils/segmentation/brats';
import { buildRgbaPalette256, rgbCss } from '../utils/segmentation/labelPalette';
import type { RegionGrow3DRoi, Vec3i } from '../utils/segmentation/regionGrow3D_v2';
import { RegionGrow3DWorkerController } from '../utils/segmentation/regionGrow3DWorker';
import { segmentationVolumeMm3 } from '../utils/segmentation/physicalMeasurements';
import { TUMOR_MODEL_MANIFEST_EXAMPLE } from '../utils/segmentation/onnx/modelManifest';
import { computeRoiCubeBoundsFromSliceDrag } from '../utils/segmentation/roiCube3d';
import { resample2dAreaAverage } from '../utils/svr/resample2d';
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
  SVR3D_CAMERA_Z,
  SVR3D_FOCAL_Z,
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
} from '../utils/svr/glRaymarch';
import { useOnnxTumorSession } from '../hooks/useOnnxTumorSession';
import { deleteVolumeSegmentation, getVolumeSegmentation, saveVolumeSegmentation } from '../utils/localApi';
import { clamp } from '../utils/math';

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

type GlLabelState = {
  gl: WebGL2RenderingContext;
  texLabels: WebGLTexture;
  texPalette: WebGLTexture;
  texDims: RenderDims;
  /** Dimensions currently allocated on the GPU for texLabels. */
  labelsTexDims: RenderDims;
};

type Vec3 = { x: number; y: number; z: number };
// Quaternion [x, y, z, w]
type Quat = [number, number, number, number];

function v3Add(a: Vec3, b: Vec3): Vec3 {
  return { x: a.x + b.x, y: a.y + b.y, z: a.z + b.z };
}

function v3Scale(v: Vec3, s: number): Vec3 {
  return { x: v.x * s, y: v.y * s, z: v.z * s };
}

function v3ApplyMat3(m: Float32Array, v: Vec3): Vec3 {
  // Column-major 3x3.
  return {
    x: m[0]! * v.x + m[3]! * v.y + m[6]! * v.z,
    y: m[1]! * v.x + m[4]! * v.y + m[7]! * v.z,
    z: m[2]! * v.x + m[5]! * v.y + m[8]! * v.z,
  };
}

function projectWorldToCanvas(params: {
  world: Vec3;
  canvasW: number;
  canvasH: number;
  aspect: number;
  zoom: number;
}): { x: number; y: number } | null {
  const { world, canvasW, canvasH, aspect, zoom } = params;

  // Must match the simple camera model used in the fragment shader:
  // roW = (0,0,CAM_Z)
  // rdW = normalize(vec3(p, -FOCAL_Z))
  const CAM_Z = SVR3D_CAMERA_Z;
  const FOCAL_Z = SVR3D_FOCAL_Z;

  const vz = world.z - CAM_Z;
  if (!(vz < -1e-6)) {
    // Point is at/behind the camera plane; skip.
    return null;
  }

  // Intersect the ray from camera origin through the point with the image plane at z = CAM_Z - FOCAL_Z.
  const t = -FOCAL_Z / vz;

  const px = world.x * t;
  const py = world.y * t;

  // In shader: p.x *= aspect; p /= zoom.
  // So inverse mapping is: ndc.x = px * zoom / aspect; ndc.y = py * zoom.
  const ndcX = (px * zoom) / Math.max(1e-6, aspect);
  const ndcY = py * zoom;

  return {
    x: (ndcX * 0.5 + 0.5) * canvasW,
    y: (1 - (ndcY * 0.5 + 0.5)) * canvasH,
  };
}

function niceStepMm(rangeMm: number, targetTicks: number): number {
  const r = Math.abs(rangeMm);
  if (!(r > 1e-6) || !(targetTicks > 0)) return 1;

  const raw = r / targetTicks;
  const pow10 = Math.pow(10, Math.floor(Math.log10(raw)));
  const x = raw / pow10;

  const nice = x <= 1 ? 1 : x <= 2 ? 2 : x <= 5 ? 5 : 10;
  return nice * pow10;
}

type DrawAxesOverlayParams = {
  axesCanvas: HTMLCanvasElement;
  axesCtx: CanvasRenderingContext2D;
  canvas: HTMLCanvasElement;
  volume: SvrVolume;
  boxScale: readonly [number, number, number];
  rotMat: Float32Array;
  zoom: number;
};

function drawAxesOverlay(params: DrawAxesOverlayParams): void {
  const { axesCanvas, axesCtx, canvas, volume, boxScale, rotMat, zoom } = params;

  const w = axesCanvas.width;
  const h = axesCanvas.height;
  if (!(w > 0 && h > 0)) return;

  // Clear.
  axesCtx.clearRect(0, 0, w, h);

  // Volume physical size in mm.
  const [nx, ny, nz] = volume.dims;
  const [vx, vy, vz] = volume.voxelSizeMm;

  const sizeMm = {
    x: Math.abs(nx * vx),
    y: Math.abs(ny * vy),
    z: Math.abs(nz * vz),
  };

  // Object-space box extents used by the shader.
  const box = { x: boxScale[0], y: boxScale[1], z: boxScale[2] };

  // Place axes on the (x-, y-, z+) corner of the box.
  const originObj: Vec3 = {
    x: -0.5 * box.x,
    y: -0.5 * box.y,
    z: 0.5 * box.z,
  };

  const aspect = w / Math.max(1, h);
  const dpr = canvas.clientWidth > 0 ? canvas.width / canvas.clientWidth : window.devicePixelRatio || 1;

  // NOTE: `rotMat` is the forward (object->world) rotation; the shader receives its
  // transpose as u_invRot, so this overlay stays consistent with the rendered volume.
  const projectObj = (obj: Vec3) => {
    const world = v3ApplyMat3(rotMat, obj);
    return projectWorldToCanvas({ world, canvasW: w, canvasH: h, aspect, zoom });
  };

  // 2D styling.
  axesCtx.save();
  axesCtx.lineCap = 'round';
  axesCtx.lineJoin = 'round';

  const fontPx = Math.max(10, Math.round(10 * dpr));
  axesCtx.font = `${fontPx}px ui-sans-serif, system-ui`;
  axesCtx.textBaseline = 'middle';

  const tickMajorPx = 7 * dpr;
  const tickMinorPx = 4 * dpr;
  const labelOffsetPx = 10 * dpr;

  const axes: Array<{
    name: 'X' | 'Y' | 'Z';
    dirObj: Vec3;
    lenObj: number;
    lenMm: number;
    rgba: string;
  }> = [
    { name: 'X', dirObj: { x: 1, y: 0, z: 0 }, lenObj: box.x, lenMm: sizeMm.x, rgba: 'rgba(255,80,80,0.9)' },
    { name: 'Y', dirObj: { x: 0, y: 1, z: 0 }, lenObj: box.y, lenMm: sizeMm.y, rgba: 'rgba(80,255,80,0.9)' },
    // Use -Z so the axis spans the full box depth from the front face into the volume.
    { name: 'Z', dirObj: { x: 0, y: 0, z: -1 }, lenObj: box.z, lenMm: sizeMm.z, rgba: 'rgba(80,160,255,0.9)' },
  ];

  for (const axis of axes) {
    if (!(axis.lenObj > 1e-9) || !(axis.lenMm > 1e-6)) continue;

    const p0 = projectObj(originObj);
    const p1 = projectObj(v3Add(originObj, v3Scale(axis.dirObj, axis.lenObj)));
    if (!p0 || !p1) continue;

    const dx = p1.x - p0.x;
    const dy = p1.y - p0.y;
    const dLen = Math.hypot(dx, dy);
    if (!(dLen > 1e-6)) continue;

    const ux = dx / dLen;
    const uy = dy / dLen;
    const px = -uy;
    const py = ux;

    // Main axis line.
    axesCtx.lineWidth = 1.25 * dpr;
    axesCtx.strokeStyle = axis.rgba;
    axesCtx.beginPath();
    axesCtx.moveTo(p0.x, p0.y);
    axesCtx.lineTo(p1.x, p1.y);
    axesCtx.stroke();

    // Ticks.
    const majorStepMm = niceStepMm(axis.lenMm, 5);
    const minorStepMm = majorStepMm >= 10 ? majorStepMm / 5 : majorStepMm / 2;

    const stepObj = axis.lenObj / axis.lenMm;

    const isNear = (a: number, b: number) => Math.abs(a - b) <= 1e-6 * Math.max(1, axis.lenMm);

    const drawTickAt = (tMm: number, isMajor: boolean) => {
      const tObj = tMm * stepObj;
      const ptObj = v3Add(originObj, v3Scale(axis.dirObj, tObj));
      const p = projectObj(ptObj);
      if (!p) return;

      const half = (isMajor ? tickMajorPx : tickMinorPx) * 0.5;
      axesCtx.lineWidth = (isMajor ? 1.25 : 1.0) * dpr;
      axesCtx.strokeStyle = axis.rgba;
      axesCtx.beginPath();
      axesCtx.moveTo(p.x - px * half, p.y - py * half);
      axesCtx.lineTo(p.x + px * half, p.y + py * half);
      axesCtx.stroke();

      if (isMajor && tMm > 0) {
        const text = `${Math.round(tMm)}mm`;
        const lx = p.x + px * labelOffsetPx;
        const ly = p.y + py * labelOffsetPx;

        axesCtx.textAlign = px >= 0 ? 'left' : 'right';
        axesCtx.lineWidth = 3 * dpr;
        axesCtx.strokeStyle = 'rgba(0,0,0,0.8)';
        axesCtx.strokeText(text, lx, ly);
        axesCtx.fillStyle = axis.rgba;
        axesCtx.fillText(text, lx, ly);
      }
    };

    // Minor ticks.
    for (let t = 0; t <= axis.lenMm + minorStepMm * 0.25; t += minorStepMm) {
      // Skip ticks that coincide with major ticks.
      const q = Math.round(t / majorStepMm);
      const isMajor = isNear(t, q * majorStepMm);
      drawTickAt(Math.min(t, axis.lenMm), isMajor);
    }

    // Axis label at end.
    {
      const text = `${axis.name}: ${Math.round(axis.lenMm)}mm`;
      const lx = p1.x + px * (labelOffsetPx * 1.2) + ux * (6 * dpr);
      const ly = p1.y + py * (labelOffsetPx * 1.2) + uy * (6 * dpr);
      axesCtx.textAlign = px >= 0 ? 'left' : 'right';
      axesCtx.lineWidth = 3 * dpr;
      axesCtx.strokeStyle = 'rgba(0,0,0,0.8)';
      axesCtx.strokeText(text, lx, ly);
      axesCtx.fillStyle = axis.rgba;
      axesCtx.fillText(text, lx, ly);
    }
  }

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
  status: 'idle' | 'building' | 'ready' | 'error';
  key: string | null;
  data: RenderVolumeTexData | null;
  buildMs?: number;
  error?: string;
};

function maskUnsupportedLabels(labels: SvrLabelVolume, observedSupport?: Uint8Array): SvrLabelVolume {
  if (!observedSupport || labels.data.length !== observedSupport.length) return labels;

  let data = labels.data;
  for (let index = 0; index < observedSupport.length; index++) {
    if (!observedSupport[index] && data[index]) {
      if (data === labels.data) data = new Uint8Array(labels.data);
      data[index] = 0;
    }
  }

  return data === labels.data ? labels : { ...labels, data };
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
    (x > 0 && !observedSupport[index - 1]) ||
    (x + 1 < nx && !observedSupport[index + 1]) ||
    (y > 0 && !observedSupport[index - nx]) ||
    (y + 1 < ny && !observedSupport[index + nx]) ||
    (z > 0 && !observedSupport[index - strideZ]) ||
    (z + 1 < nz && !observedSupport[index + strideZ])
  );
}

export type SvrVolume3DViewerProps = {
  volume: SvrVolume | null;
  labels?: SvrLabelVolume | null;
  volumeIdentity?: {
    patientKey?: string;
    studyUid?: string;
    seriesUids: string[];
    frameOfReferenceUid?: string;
    datasetRevision?: number;
  } | null;
  /**
   * Optional portal target used to render the Slice Inspector outside of the viewer layout
   * (e.g. inside the SVR generation panel).
   *
   * If this prop is provided (even as null), the viewer will NOT render the Slice Inspector inline.
   */
  sliceInspectorPortalTarget?: Element | null;
};

export function SvrVolume3DViewer({
  volume,
  labels: labelsOverride,
  volumeIdentity,
  sliceInspectorPortalTarget,
}: SvrVolume3DViewerProps) {
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
  const [renderBuild, setRenderBuild] = useState<RenderBuildState>(() => ({
    status: 'idle',
    key: null,
    data: null,
  }));

  // Optional externally-provided labels (e.g. from an ML pipeline) can override internal generation.
  const [generatedLabels, setGeneratedLabels] = useState<SvrLabelVolume | null>(null);
  const [hydratedVolumeKey, setHydratedVolumeKey] = useState<string | null>(null);
  const labelSourceRef = useRef<string | undefined>(undefined);
  const labelCountsRef = useRef<{
    data: Uint8Array;
    counts: Map<number, number>;
    unsupportedBoundaryCount: number;
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
      revision: volumeIdentity.datasetRevision ?? null,
      ...(volume.reconstructionFingerprint ? { reconstruction: volume.reconstructionFingerprint } : {}),
    });
  }, [volume, volumeIdentity]);

  useEffect(() => {
    if (!volume || !volumeKey) return;
    let cancelled = false;
    void getVolumeSegmentation(volumeKey)
      .then((saved) => {
        if (cancelled) return;
        if (saved) {
          const metadata = Array.isArray(saved.classMetadata)
            ? (saved.classMetadata as SvrLabelVolume['meta'])
            : BRATS_BASE_LABEL_META;
          labelSourceRef.current = saved.modelKey;
          setGeneratedLabels(
            maskUnsupportedLabels({ data: saved.labels, dims: saved.dims, meta: metadata }, volume.observedSupport),
          );
        }
        setHydratedVolumeKey(volumeKey);
      })
      .catch((error: unknown) => {
        if (!cancelled) console.error('[segmentation] Failed to restore saved 3D labels', error);
      });
    return () => {
      cancelled = true;
    };
  }, [volume, volumeKey]);

  useEffect(() => {
    if (!volume || !volumeIdentity || !volumeKey || hydratedVolumeKey !== volumeKey || labelsOverride) return;

    if (!generatedLabels) {
      void deleteVolumeSegmentation(volumeKey).catch((error: unknown) => {
        console.error('[segmentation] Failed to remove saved 3D labels', error);
      });
      return;
    }

    const timer = window.setTimeout(() => {
      void saveVolumeSegmentation({
        volumeKey,
        patientKey: volumeIdentity.patientKey,
        studyUid: volumeIdentity.studyUid,
        seriesUids: volumeIdentity.seriesUids,
        frameOfReferenceUid: volumeIdentity.frameOfReferenceUid,
        dims: generatedLabels.dims,
        voxelSizeMm: volume.voxelSizeMm,
        labels: generatedLabels.data,
        classMetadata: generatedLabels.meta,
        modelKey: labelSourceRef.current,
        datasetRevision: volumeIdentity.datasetRevision,
        updatedAt: Date.now(),
      }).catch((error: unknown) => {
        console.error('[segmentation] Failed to save 3D labels', error);
      });
    }, 200);

    return () => window.clearTimeout(timer);
  }, [generatedLabels, hydratedVolumeKey, labelsOverride, volume, volumeIdentity, volumeKey]);

  // The 256-entry label->RGBA palette depends only on the label *metadata*, which is a
  // stable object (BRATS_BASE_LABEL_META) across grow-preview ticks — only the voxel data
  // changes. Memoizing on meta keeps palette construction out of the per-tick upload and
  // slice-compositing paths.
  const labelsMeta = labels?.meta ?? null;
  const labelPalette = useMemo(() => (labelsMeta ? buildRgbaPalette256(labelsMeta) : null), [labelsMeta]);

  // Dirty-region tracking for the GPU label texture (and its downsampled CPU cache).
  //
  // Grow previews mutate a small set of voxels per tick, but a texture upload keyed only
  // on `labels` identity would re-push the entire volume (and re-downsample it on the CPU
  // first) every tick. Mutating paths record the changed bounding box here, tagged with
  // the exact buffer they touched; the upload effect takes the partial path only when the
  // tag matches the current label buffer AND the texture is already allocated, so unknown
  // paths (ONNX results, external overrides — always fresh buffers) safely fall back to a
  // full upload.
  const labelDirtyRef = useRef<{ data: Uint8Array; min: Vec3i; max: Vec3i } | null>(null);
  // Persistent downsampled copy of the label volume, mirrored region-by-region; only valid
  // for the buffer identity + dims it was built from.
  const labelDsCacheRef = useRef<{ src: Uint8Array; key: string; data: Uint8Array } | null>(null);

  const markLabelsDirty = useCallback((data: Uint8Array, min: Vec3i, max: Vec3i) => {
    const d = labelDirtyRef.current;
    if (d && d.data === data) {
      // Multiple mutations can land before React flushes the upload effect (e.g. two grow
      // ticks in one frame); merge into one conservative box rather than dropping one.
      d.min = { x: Math.min(d.min.x, min.x), y: Math.min(d.min.y, min.y), z: Math.min(d.min.z, min.z) };
      d.max = { x: Math.max(d.max.x, max.x), y: Math.max(d.max.y, max.y), z: Math.max(d.max.z, max.z) };
    } else {
      labelDirtyRef.current = { data, min: { ...min }, max: { ...max } };
    }
  }, []);

  // ONNX model execution (offline; model cached in IndexedDB).
  const onOnnxLabels = useCallback(
    (nextLabels: SvrLabelVolume) => {
      labelSourceRef.current = 'brats-tumor-v1';
      setGeneratedLabels(maskUnsupportedLabels(nextLabels, volume?.observedSupport));
    },
    [volume],
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
    initSession: initOnnxSession,
    runSegmentation: runOnnxSegmentation,
    cancelSegmentation: cancelOnnxSegmentation,
  } = onnx;

  // Viewer controls (composite-only)
  const [controlsCollapsed, setControlsCollapsed] = useState(false);
  // One spatially neutral threshold preserves equal peripheral and central tissue.
  const [threshold, setThreshold] = useState(0.05);
  const THRESHOLD_MAX = 0.3;
  // Always use max raymarch samples for quality; no UI control.
  const steps = 256;
  const [gamma, setGamma] = useState(1.0);
  const [opacity, setOpacity] = useState(4.0);
  const [zoom, setZoom] = useState(1.0);

  // Optional segmentation overlay (label volume).
  // No UI controls: labels are always shown when available.
  const labelsEnabled = true;
  const labelMix = 0.65;

  const [segmentationCollapsed, setSegmentationCollapsed] = useState(true);

  // Baseline interactive segmentation (Phase 2): seeded 3D region-growing.
  const [seedVoxel, setSeedVoxel] = useState<Vec3i | null>(null);
  const [growTargetLabel, setGrowTargetLabel] = useState<BratsBaseLabelId>(BRATS_LABEL_ID.ENHANCING);
  const [growTolerance, setGrowTolerance] = useState(0.12);
  const [growAuto, setGrowAuto] = useState(true);

  // ROI guidance: draw a box on the slice inspector to reduce leakage.
  // NOTE: the 2D rectangle is interpreted as an axis-aligned *3D* cube-like ROI whose depth is
  // chosen to be roughly isotropic in mm (and centered on the current inspector slice).
  // The ROI acts as a smooth radial prior about its centroid (not a hard clamp).
  const [growRoiOutsideScale, setGrowRoiOutsideScale] = useState(0.6);
  const [growRoiBounds, setGrowRoiBounds] = useState<{ min: Vec3i; max: Vec3i } | null>(null);
  const [growRoiDraftBounds, setGrowRoiDraftBounds] = useState<{ min: Vec3i; max: Vec3i } | null>(null);

  const [growStatus, setGrowStatus] = useState<{ running: boolean; message?: string; error?: string }>(() => ({
    running: false,
  }));
  const growAbortRef = useRef<AbortController | null>(null);
  const growWorkerRef = useRef<RegionGrow3DWorkerController | null>(null);
  const growRunIdRef = useRef(0);
  const growAutoTimerRef = useRef<number | null>(null);

  // For live-updating tolerance we need to *replace* the previous preview rather than accumulate.
  // We store sparse previous label values so we can revert without copying the entire label volume.
  const growOverlayRef = useRef<{
    key: string;
    seedKey: string;
    workLabels: Uint8Array;
    prevIndices: Uint32Array | null;
    prevValues: Uint8Array | null;
  } | null>(null);

  const sliceInspectorDragRef = useRef<{
    pointerId: number;
    startClientX: number;
    startClientY: number;
    startVoxel: Vec3i;
    lastVoxel: Vec3i;
    draggingRoi: boolean;
  } | null>(null);

  // When the underlying volume changes, drop any internally-generated labels, seeds, and ROI state.
  useEffect(() => {
    setGeneratedLabels(null);
    setSeedVoxel(null);
    setGrowAuto(true);
    setGrowRoiOutsideScale(0.6);
    setGrowRoiBounds(null);
    setGrowRoiDraftBounds(null);

    // Clear any pending/active grow.
    setGrowStatus({ running: false });
    growAbortRef.current?.abort();
    growAbortRef.current = null;
    growWorkerRef.current?.dispose();
    growWorkerRef.current = null;
    growRunIdRef.current++;

    if (growAutoTimerRef.current !== null) {
      window.clearTimeout(growAutoTimerRef.current);
      growAutoTimerRef.current = null;
    }

    growOverlayRef.current = null;
    sliceInspectorDragRef.current = null;

    // In-flight ONNX segmentation is cancelled by useOnnxTumorSession's own volume-change
    // effect (the hook owns that state since the extraction; the stale direct references
    // that used to live here didn't compile).
  }, [volume]);

  useEffect(() => () => growWorkerRef.current?.dispose(), []);

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
      for (let i = 0; i < data.length; i++) {
        if (volume.observedSupport && !volume.observedSupport[i]) continue;
        const id = data[i] ?? 0;
        if (id === 0) continue;
        counts.set(id, (counts.get(id) ?? 0) + 1);
        if (touchesUnsupportedAnatomy(i, volume.dims, volume.observedSupport)) unsupportedBoundaryCount++;
      }
      cached = { data, counts, unsupportedBoundaryCount };
      labelCountsRef.current = cached;
    }

    const { counts, unsupportedBoundaryCount } = cached;

    const voxelVolMm3 = segmentationVolumeMm3(1, volume.voxelSizeMm) ?? 0;

    let totalCount = 0;
    for (const c of counts.values()) {
      totalCount += c;
    }

    const totalMm3 = totalCount * voxelVolMm3;
    const totalMl = totalMm3 / 1000;

    return { counts, voxelVolMm3, totalCount, totalMm3, totalMl, unsupportedBoundaryCount };
  }, [hasLabels, labels, volume]);

  // Slice inspector (orthogonal slices).
  const sliceCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const [inspectPlane, setInspectPlane] = useState<'axial' | 'coronal' | 'sagittal'>('axial');
  const [inspectIndex, setInspectIndex] = useState(0);

  // Render-on-demand + interaction-time quality scaling.
  //
  // The raymarcher's frame cost is pixels × steps × texture bandwidth, and it used to pay
  // that cost every RAF forever, at full devicePixelRatio, even with nothing changing.
  // Instead: frames are scheduled only when something changed (requestRenderRef), and while
  // the user is actively rotating/zooming we render at reduced resolution + step count
  // (paired with ray jitter in the shader). A settle timer restores a final full-quality
  // frame ~180ms after the last interaction event.
  const requestRenderRef = useRef<(() => void) | null>(null);
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

  const paramsRef = useRef({ threshold, steps, gamma, opacity, zoom, labelsEnabled, labelMix, hasLabels });
  useEffect(() => {
    paramsRef.current = { threshold, steps, gamma, opacity, zoom, labelsEnabled, labelMix, hasLabels };
    // Render-on-demand: any control change must explicitly schedule a frame, since the GL
    // loop no longer free-runs (idle viewer = zero GPU work).
    requestRenderRef.current?.();
  }, [gamma, hasLabels, labelMix, labelsEnabled, opacity, steps, threshold, zoom]);

  const rotationRef = useRef<Quat>([0, 0, 0, 1]);

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

  const renderPlan = useMemo(() => {
    if (!volume) return null;

    return computeRenderPlan({
      srcDims: volDims,
      labelsEnabled,
      hasLabels: false,
      budgetMiB: DEFAULT_RENDER_GPU_BUDGET_MIB,
      quality: DEFAULT_RENDER_QUALITY,
      textureMode: DEFAULT_RENDER_TEXTURE_MODE,
      reserveLabelTexture: true,
      hasObservedSupport: Boolean(volume.observedSupport),
    });
  }, [labelsEnabled, volume, volDims]);

  const renderBuildKey = useMemo(() => {
    if (!renderPlan) return null;
    const d = renderPlan.dims;
    return `${renderPlan.kind}:${d.nx}x${d.ny}x${d.nz}`;
  }, [renderPlan]);

  useEffect(() => {
    const buildId = ++renderBuildIdRef.current;
    preparedRenderRef.current = null;
    if (!volume || !renderPlan || !renderBuildKey) {
      setRenderBuild({ status: 'idle', key: null, data: null });
      return;
    }

    setInitError(null);

    const key = renderBuildKey;

    const srcDims: RenderDims = volDims;
    const dstDims: RenderDims = renderPlan.dims;

    if (volume.observedSupport && volume.observedSupport.length !== volume.data.length) {
      setRenderBuild({
        status: 'error',
        key,
        data: null,
        error: 'Acquired-support evidence does not match this reconstructed volume.',
      });
      return;
    }

    const started = performance.now();

    setRenderBuild({ status: 'building', key, data: null });

    void (async () => {
      try {
        const isCancelled = () => renderBuildIdRef.current !== buildId;

        const tex = await buildRenderVolumeTexData({
          src: volume.data,
          srcObservedSupport: volume.observedSupport,
          srcDims,
          plan: { kind: renderPlan.kind, dims: dstDims },
          isCancelled,
        });

        if (renderBuildIdRef.current !== buildId) return;

        const halfFloatBits =
          tex.kind === 'f32' ? await float32ToFloat16BitsAsync(tex.data as Float32Array, isCancelled) : undefined;
        if (renderBuildIdRef.current !== buildId) return;

        const occupancy = await buildOccupancyMaxGridAsync({ data: tex.data, dims: tex.dims }, isCancelled);
        if (renderBuildIdRef.current !== buildId) return;

        preparedRenderRef.current = { data: tex, halfFloatBits, occupancy };

        const ms = Math.round(performance.now() - started);
        setRenderBuild({
          status: 'ready',
          key,
          data: tex,
          buildMs: ms,
        });
      } catch (e) {
        if (renderBuildIdRef.current !== buildId) return;
        const msg = e instanceof Error ? e.message : String(e);
        setRenderBuild({ status: 'error', key, data: null, error: msg });
      }
    })();
  }, [renderBuildKey, renderPlan, volume, volDims]);

  const resetView = useCallback(() => {
    rotationRef.current = [0, 0, 0, 1];
    setZoom(1.0);
    // If zoom was already 1.0 the params effect won't fire, so the rotation reset needs its
    // own explicit frame request.
    requestRenderRef.current?.();
  }, []);

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
  }, [markInteraction]);

  const inspectorInfo = useMemo(() => {
    if (!volume) {
      return {
        maxIndex: 0,
        srcRows: 1,
        srcCols: 1,
      };
    }

    const [nx, ny, nz] = volume.dims;

    if (inspectPlane === 'axial') {
      return {
        maxIndex: Math.max(0, nz - 1),
        srcRows: ny,
        srcCols: nx,
      };
    }

    if (inspectPlane === 'coronal') {
      return {
        maxIndex: Math.max(0, ny - 1),
        srcRows: nz,
        srcCols: nx,
      };
    }

    // sagittal
    return {
      maxIndex: Math.max(0, nx - 1),
      srcRows: nz,
      srcCols: ny,
    };
  }, [inspectPlane, volume]);

  // The selected slice and existing ROI seed already own inspection position. Derive
  // its patient-space coordinate instead of introducing a competing cursor authority.
  const inspectedCoordinate = useMemo(() => {
    if (!volume) return null;

    const [nx, ny, nz] = volume.dims;
    const voxel: Vec3i = {
      x: clamp(seedVoxel?.x ?? Math.floor(nx / 2), 0, nx - 1),
      y: clamp(seedVoxel?.y ?? Math.floor(ny / 2), 0, ny - 1),
      z: clamp(seedVoxel?.z ?? Math.floor(nz / 2), 0, nz - 1),
    };
    const slice = Math.round(clamp(inspectIndex, 0, inspectorInfo.maxIndex));
    if (inspectPlane === 'axial') voxel.z = slice;
    else if (inspectPlane === 'coronal') voxel.y = slice;
    else voxel.x = slice;

    const index = voxel.z * nx * ny + voxel.y * nx + voxel.x;
    return {
      supported: volume.observedSupport ? Boolean(volume.observedSupport[index]) : null,
      positionMm: [
        volume.originMm[0] + voxel.x * volume.voxelSizeMm[0],
        volume.originMm[1] + voxel.y * volume.voxelSizeMm[1],
        volume.originMm[2] + voxel.z * volume.voxelSizeMm[2],
      ] as const,
    };
  }, [inspectIndex, inspectPlane, inspectorInfo.maxIndex, seedVoxel, volume]);

  // Default the inspector to the mid-slice when the volume or plane changes.
  useEffect(() => {
    if (!volume) return;
    setInspectIndex(Math.floor(inspectorInfo.maxIndex / 2));
  }, [inspectPlane, inspectorInfo.maxIndex, volume]);

  const inspectorPointerToVoxel = useCallback(
    (e: React.PointerEvent<HTMLCanvasElement>): Vec3i | null => {
      if (!volume) return null;

      const rect = e.currentTarget.getBoundingClientRect();
      const w = Math.max(1, rect.width);
      const h = Math.max(1, rect.height);

      const u = (e.clientX - rect.left) / w;
      const v = (e.clientY - rect.top) / h;

      const srcCols = inspectorInfo.srcCols;
      const srcRows = inspectorInfo.srcRows;
      const sliceIdx = Math.round(clamp(inspectIndex, 0, inspectorInfo.maxIndex));

      const sx = Math.round(clamp(u, 0, 1) * Math.max(0, srcCols - 1));
      const sy = Math.round(clamp(v, 0, 1) * Math.max(0, srcRows - 1));

      if (inspectPlane === 'axial') {
        return { x: sx, y: sy, z: sliceIdx };
      }

      if (inspectPlane === 'coronal') {
        return { x: sx, y: sliceIdx, z: sy };
      }

      // sagittal
      return { x: sliceIdx, y: sx, z: sy };
    },
    [inspectIndex, inspectPlane, inspectorInfo.maxIndex, inspectorInfo.srcCols, inspectorInfo.srcRows, volume],
  );

  const computeRoiBoundsFromSliceVoxels = useCallback(
    (a: Vec3i, b: Vec3i): { min: Vec3i; max: Vec3i } | null => {
      if (!volume) return null;

      // Convert the 2D drag rectangle into a bounded 3D "cube" centered on the current inspector slice.
      // This keeps the ROI as a meaningful spatial prior (instead of spanning the full depth).
      const axisIndex = Math.round(clamp(inspectIndex, 0, inspectorInfo.maxIndex));

      return computeRoiCubeBoundsFromSliceDrag({
        plane: inspectPlane,
        dims: volume.dims,
        voxelSizeMm: volume.voxelSizeMm,
        sliceIndex: axisIndex,
        a,
        b,
        depthScale: 1,
      });
    },
    [inspectIndex, inspectPlane, inspectorInfo.maxIndex, volume],
  );

  type StartSeedGrowParams = {
    seed?: Vec3i;
    tolerance?: number;
    targetLabel?: BratsBaseLabelId;
    roiBounds?: { min: Vec3i; max: Vec3i } | null;
    roiOutsideScale?: number;
    auto?: boolean;
  };

  const cancelSeedGrow = useCallback((message?: string) => {
    growRunIdRef.current++;
    growAbortRef.current?.abort();
    growAbortRef.current = null;

    if (growAutoTimerRef.current !== null) {
      window.clearTimeout(growAutoTimerRef.current);
      growAutoTimerRef.current = null;
    }

    setGrowStatus({ running: false, message: message ?? 'Cancelled' });
  }, []);

  const startSeedGrow = useCallback(
    (params?: StartSeedGrowParams) => {
      if (!volume) return;
      if (onnxSegRunning) return;

      const roiBounds = params && 'roiBounds' in params ? (params.roiBounds ?? null) : growRoiBounds;
      if (!roiBounds) {
        setGrowStatus({ running: false, error: 'Draw an ROI box in the slice inspector first.' });
        return;
      }

      // Use a single seed at the ROI center.
      const seed: Vec3i = {
        x: Math.floor((roiBounds.min.x + roiBounds.max.x) * 0.5),
        y: Math.floor((roiBounds.min.y + roiBounds.max.y) * 0.5),
        z: Math.floor((roiBounds.min.z + roiBounds.max.z) * 0.5),
      };
      const [nx, ny, nz] = volume.dims;
      const seedIdx = seed.z * nx * ny + seed.y * nx + seed.x;
      if (volume.observedSupport && !volume.observedSupport[seedIdx]) {
        setGrowStatus({
          running: false,
          error: 'The ROI center has no acquired MRI support. Draw the box around observed anatomy.',
        });
        return;
      }

      const tolerance = params?.tolerance ?? growTolerance;
      const targetLabel = params?.targetLabel ?? growTargetLabel;

      const roiOutsideScale = params?.roiOutsideScale ?? growRoiOutsideScale;

      const isAuto = params?.auto ?? false;

      if (growAutoTimerRef.current !== null) {
        window.clearTimeout(growAutoTimerRef.current);
        growAutoTimerRef.current = null;
      }

      growAbortRef.current?.abort();

      const controller = new AbortController();
      growAbortRef.current = controller;

      const runId = ++growRunIdRef.current;

      setGrowStatus({ running: true, message: isAuto ? 'Previewing…' : 'Growing…' });

      const seedValue = volume.data[seedIdx] ?? 0;

      const boundedTolerance = Math.max(0, tolerance);
      const min = clamp(seedValue - boundedTolerance, 0, 1);
      const max = clamp(seedValue + boundedTolerance, 0, 1);

      const maxVoxels = (() => {
        const rx = Math.abs(roiBounds.max.x - roiBounds.min.x) + 1;
        const ry = Math.abs(roiBounds.max.y - roiBounds.min.y) + 1;
        const rz = Math.abs(roiBounds.max.z - roiBounds.min.z) + 1;
        const roiVoxels = rx * ry * rz;

        // Prefer sizing relative to the ROI so we don't allocate enormous output buffers.
        // Allow some slack for guide-mode margin expansion.
        return Math.min(volume.data.length, Math.min(Math.max(roiVoxels * 4, 50_000), 2_000_000));
      })();

      const roi: RegionGrow3DRoi = {
        mode: 'guide',
        min: roiBounds.min,
        max: roiBounds.max,
        outsideToleranceScale: roiOutsideScale,
      };

      const volumeKey = `${nx}x${ny}x${nz}`;
      const seedKey = `${seed.x},${seed.y},${seed.z}:${targetLabel}`;

      // Keep one working label buffer per volume. When the seed/target changes, we "commit" the
      // previous preview by dropping its bookkeeping (prevIndices/prevValues).
      let overlay = growOverlayRef.current;
      if (!overlay || overlay.key !== volumeKey) {
        const workLabels = hasLabels && labels ? new Uint8Array(labels.data) : new Uint8Array(volume.data.length);
        overlay = { key: volumeKey, seedKey, workLabels, prevIndices: null, prevValues: null };
        growOverlayRef.current = overlay;
      } else if (overlay.seedKey !== seedKey) {
        overlay.seedKey = seedKey;
        overlay.prevIndices = null;
        overlay.prevValues = null;
      }

      const yieldEvery = isAuto ? 60_000 : 160_000;

      const debugGrow3d =
        typeof localStorage !== 'undefined' && localStorage.getItem('miraviewer:debug-grow3d') === '1';

      const worker = growWorkerRef.current ?? new RegionGrow3DWorkerController();
      growWorkerRef.current = worker;
      const growPromise = worker.run({
        volume: volume.data,
        observedSupport: volume.observedSupport,
        dims: volume.dims,
        seed,
        min,
        max,
        roi,
        signal: controller.signal,
        maxVoxels,
        yieldEvery,
        debug: debugGrow3d,
        onProgress: (p) => {
          const prefix = isAuto ? 'Previewing…' : 'Growing…';
          setGrowStatus((s) => (s.running ? { ...s, message: `${prefix} ${p.queued.toLocaleString()} voxels` } : s));
        },
      });

      void growPromise
        .then((res) => {
          if (controller.signal.aborted) return;
          if (growRunIdRef.current !== runId) return;

          const o = growOverlayRef.current;
          if (!o || o.key !== volumeKey || o.seedKey !== seedKey) return;

          // Track the bounding box of every voxel this tick touches (both the restored
          // previous preview and the newly applied one) so the GPU upload effect can
          // sub-upload just that region instead of re-pushing the whole label volume.
          const [bnx, bny] = volume.dims;
          const sliceVox = bnx * bny;
          let mnX = Infinity;
          let mnY = Infinity;
          let mnZ = Infinity;
          let mxX = -Infinity;
          let mxY = -Infinity;
          let mxZ = -Infinity;
          const trackedLabels = labelCountsRef.current?.data === o.workLabels ? labelCountsRef.current : null;
          const trackedCounts = trackedLabels?.counts ?? null;
          const replaceLabel = (index: number, next: number) => {
            const previous = o.workLabels[index] ?? 0;
            if (previous === next) return;
            if (trackedLabels && touchesUnsupportedAnatomy(index, volume.dims, volume.observedSupport)) {
              if (previous === 0 && next !== 0) trackedLabels.unsupportedBoundaryCount++;
              else if (previous !== 0 && next === 0) trackedLabels.unsupportedBoundaryCount--;
            }
            if (trackedCounts && previous !== 0) {
              const remaining = (trackedCounts.get(previous) ?? 0) - 1;
              if (remaining > 0) trackedCounts.set(previous, remaining);
              else trackedCounts.delete(previous);
            }
            if (trackedCounts && next !== 0) {
              trackedCounts.set(next, (trackedCounts.get(next) ?? 0) + 1);
            }
            o.workLabels[index] = next;
          };
          const trackIndex = (vi: number) => {
            const z = (vi / sliceVox) | 0;
            const rem = vi - z * sliceVox;
            const y = (rem / bnx) | 0;
            const x = rem - y * bnx;
            if (x < mnX) mnX = x;
            if (y < mnY) mnY = y;
            if (z < mnZ) mnZ = z;
            if (x > mxX) mxX = x;
            if (y > mxY) mxY = y;
            if (z > mxZ) mxZ = z;
          };

          // Restore the previous preview region (sparse).
          if (o.prevIndices && o.prevValues && o.prevValues.length === o.prevIndices.length) {
            const prev = o.prevIndices;
            const vals = o.prevValues;
            for (let i = 0; i < prev.length; i++) {
              const vi = prev[i]!;
              replaceLabel(vi, vals[i] ?? 0);
              trackIndex(vi);
            }
          }

          // Apply the new preview, capturing previous values so we can restore on the next update.
          const idx = res.indices;
          const nextPrevValues = new Uint8Array(idx.length);
          for (let i = 0; i < idx.length; i++) {
            const vi = idx[i]!;
            if (volume.observedSupport && !volume.observedSupport[vi]) continue;
            nextPrevValues[i] = o.workLabels[vi] ?? 0;
            replaceLabel(vi, targetLabel);
            trackIndex(vi);
          }
          o.prevIndices = idx;
          o.prevValues = nextPrevValues;

          if (Number.isFinite(mnX)) {
            markLabelsDirty(o.workLabels, { x: mnX, y: mnY, z: mnZ }, { x: mxX, y: mxY, z: mxZ });
          }

          labelSourceRef.current = undefined;
          setGeneratedLabels({ data: o.workLabels, dims: volume.dims, meta: BRATS_BASE_LABEL_META });

          setGrowStatus({
            running: false,
            message: `Seed ${seedValue.toFixed(3)} ±${tolerance.toFixed(3)} → ${res.count.toLocaleString()} voxels${
              res.hitMaxVoxels ? ' (hit limit)' : ''
            } · ROI decay`,
          });
        })
        .catch((e) => {
          if (controller.signal.aborted) return;
          if (growRunIdRef.current !== runId) return;
          const msg = e instanceof Error ? e.message : String(e);
          setGrowStatus({ running: false, error: msg });
        })
        .finally(() => {
          if (growAbortRef.current === controller) {
            growAbortRef.current = null;
          }
        });
    },
    [
      growRoiBounds,
      growRoiOutsideScale,
      growTargetLabel,
      growTolerance,
      hasLabels,
      labels,
      markLabelsDirty,
      onnxSegRunning,
      volume,
    ],
  );

  const scheduleSeedGrow = useCallback(
    (params?: Omit<StartSeedGrowParams, 'auto'>) => {
      if (!growAuto) return;
      if (!volume) return;
      if (onnxSegRunning) return;

      const roiBounds = params && 'roiBounds' in params ? (params.roiBounds ?? null) : growRoiBounds;
      if (!roiBounds) return;

      // Stop any in-flight grow quickly so slider changes feel responsive.
      growAbortRef.current?.abort();

      if (growAutoTimerRef.current !== null) {
        window.clearTimeout(growAutoTimerRef.current);
      }

      growAutoTimerRef.current = window.setTimeout(() => {
        growAutoTimerRef.current = null;
        startSeedGrow({ ...params, auto: true, roiBounds });
      }, 150);
    },
    [growAuto, growRoiBounds, onnxSegRunning, startSeedGrow, volume],
  );

  const onSliceInspectorPointerDown = useCallback(
    (e: React.PointerEvent<HTMLCanvasElement>) => {
      if (!volume) return;
      if (onnxSegRunning) return;

      const voxel = inspectorPointerToVoxel(e);
      if (!voxel) return;

      sliceInspectorDragRef.current = {
        pointerId: e.pointerId,
        startClientX: e.clientX,
        startClientY: e.clientY,
        startVoxel: voxel,
        lastVoxel: voxel,
        draggingRoi: false,
      };

      setGrowRoiDraftBounds(null);

      e.currentTarget.setPointerCapture(e.pointerId);
      e.preventDefault();
      e.stopPropagation();
    },
    [inspectorPointerToVoxel, onnxSegRunning, volume],
  );

  const onSliceInspectorPointerMove = useCallback(
    (e: React.PointerEvent<HTMLCanvasElement>) => {
      const drag = sliceInspectorDragRef.current;
      if (!drag || drag.pointerId !== e.pointerId) return;

      const voxel = inspectorPointerToVoxel(e);
      if (voxel) {
        drag.lastVoxel = voxel;
      }

      const dx = e.clientX - drag.startClientX;
      const dy = e.clientY - drag.startClientY;
      const dist2 = dx * dx + dy * dy;

      // Promote from click -> drag when the pointer moves a little.
      if (!drag.draggingRoi && dist2 >= 16) {
        drag.draggingRoi = true;
      }

      if (drag.draggingRoi && voxel) {
        setGrowRoiDraftBounds(computeRoiBoundsFromSliceVoxels(drag.startVoxel, voxel));
      }

      e.preventDefault();
      e.stopPropagation();
    },
    [computeRoiBoundsFromSliceVoxels, inspectorPointerToVoxel],
  );

  const onSliceInspectorPointerUp = useCallback(
    (e: React.PointerEvent<HTMLCanvasElement>) => {
      const drag = sliceInspectorDragRef.current;
      if (!drag || drag.pointerId !== e.pointerId) return;

      sliceInspectorDragRef.current = null;

      const voxel = inspectorPointerToVoxel(e) ?? drag.lastVoxel;
      if (!voxel) return;

      if (drag.draggingRoi) {
        const bounds = computeRoiBoundsFromSliceVoxels(drag.startVoxel, voxel);
        setGrowRoiDraftBounds(null);
        if (bounds) {
          setGrowRoiBounds(bounds);

          const seed: Vec3i = {
            x: Math.floor((bounds.min.x + bounds.max.x) * 0.5),
            y: Math.floor((bounds.min.y + bounds.max.y) * 0.5),
            z: Math.floor((bounds.min.z + bounds.max.z) * 0.5),
          };
          setSeedVoxel(seed);

          if (growAuto) {
            startSeedGrow({ auto: true, roiBounds: bounds, seed });
          }
        }
      } else {
        // No single-click seeding: box draw is required.
        setGrowRoiDraftBounds(null);
      }

      e.preventDefault();
      e.stopPropagation();
    },
    [computeRoiBoundsFromSliceVoxels, growAuto, inspectorPointerToVoxel, startSeedGrow],
  );

  const onSliceInspectorPointerCancel = useCallback((e: React.PointerEvent<HTMLCanvasElement>) => {
    const drag = sliceInspectorDragRef.current;
    if (!drag || drag.pointerId !== e.pointerId) return;

    sliceInspectorDragRef.current = null;
    setGrowRoiDraftBounds(null);

    e.preventDefault();
    e.stopPropagation();
  }, []);

  // Extract + downsample the current inspector slice (a plane read over the full volume
  // plus an area-average resample). Memoized separately from the canvas compositing effect
  // below so that label-only updates — grow previews re-publish labels several times a
  // second — reuse the cached slice instead of re-reading a full volume plane each time.
  const inspectorSlice = useMemo(() => {
    if (!volume) return null;

    const [nx, ny, nz] = volume.dims;
    const data = volume.data;
    const observedSupport = volume.observedSupport;

    const idx = Math.round(clamp(inspectIndex, 0, inspectorInfo.maxIndex));

    const srcRows = inspectorInfo.srcRows;
    const srcCols = inspectorInfo.srcCols;

    const src = new Float32Array(srcRows * srcCols);

    const strideY = nx;
    const strideZ = nx * ny;

    if (inspectPlane === 'axial') {
      const z = idx;
      const zBase = z * strideZ;
      for (let y = 0; y < ny; y++) {
        const inBase = zBase + y * strideY;
        const outBase = y * nx;
        for (let x = 0; x < nx; x++) {
          const sourceIndex = inBase + x;
          src[outBase + x] = observedSupport && !observedSupport[sourceIndex] ? 0 : (data[sourceIndex] ?? 0);
        }
      }
    } else if (inspectPlane === 'coronal') {
      const y = idx;
      for (let z = 0; z < nz; z++) {
        const inBase = z * strideZ + y * strideY;
        const outBase = z * nx;
        for (let x = 0; x < nx; x++) {
          const sourceIndex = inBase + x;
          src[outBase + x] = observedSupport && !observedSupport[sourceIndex] ? 0 : (data[sourceIndex] ?? 0);
        }
      }
    } else {
      // sagittal
      const x = idx;
      for (let z = 0; z < nz; z++) {
        const zBase = z * strideZ;
        const outBase = z * ny;
        for (let y = 0; y < ny; y++) {
          const sourceIndex = zBase + y * strideY + x;
          src[outBase + y] = observedSupport && !observedSupport[sourceIndex] ? 0 : (data[sourceIndex] ?? 0);
        }
      }
    }

    // Downsample for interactive rendering (avoid huge canvases).
    const MAX_SIZE = 512;
    const maxDim = Math.max(srcRows, srcCols);
    const scale = maxDim > MAX_SIZE ? MAX_SIZE / maxDim : 1;
    const dsRows = Math.max(1, Math.round(srcRows * scale));
    const dsCols = Math.max(1, Math.round(srcCols * scale));

    const down = resample2dAreaAverage(src, srcRows, srcCols, dsRows, dsCols);

    return { down, idx, srcRows, srcCols, dsRows, dsCols };
  }, [inspectIndex, inspectPlane, inspectorInfo.maxIndex, inspectorInfo.srcCols, inspectorInfo.srcRows, volume]);

  // Composite the cached inspector slice with the label overlay and UI decorations
  // (seed crosshair, ROI boxes) onto the 2D canvas.
  useEffect(() => {
    const canvas = sliceCanvasRef.current;
    if (!canvas) return;
    if (!volume || !inspectorSlice) return;

    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const [nx, ny] = volume.dims;
    const strideY = nx;
    const strideZ = nx * ny;

    const { down, idx, srcRows, srcCols, dsRows, dsCols } = inspectorSlice;

    if (canvas.width !== dsCols) canvas.width = dsCols;
    if (canvas.height !== dsRows) canvas.height = dsRows;

    const img = ctx.createImageData(dsCols, dsRows);
    const out = img.data;

    const overlayAlpha = hasLabels && labelsEnabled ? clamp(labelMix, 0, 1) : 0;
    const palette = hasLabels && labelsEnabled && labels ? labelPalette : null;

    for (let i = 0; i < down.length; i++) {
      const v = down[i] ?? 0;
      const b0 = Math.round(clamp(v, 0, 1) * 255);

      let r = b0;
      let g = b0;
      let b = b0;

      if (volume.observedSupport || (palette && overlayAlpha > 0 && labels)) {
        const px = i % dsCols;
        const py = Math.floor(i / dsCols);

        const srcX = dsCols > 1 ? Math.round((px / (dsCols - 1)) * (srcCols - 1)) : 0;
        const srcY = dsRows > 1 ? Math.round((py / (dsRows - 1)) * (srcRows - 1)) : 0;

        let vx = 0;
        let vy = 0;
        let vz = 0;

        if (inspectPlane === 'axial') {
          vx = srcX;
          vy = srcY;
          vz = idx;
        } else if (inspectPlane === 'coronal') {
          vx = srcX;
          vy = idx;
          vz = srcY;
        } else {
          // sagittal
          vx = idx;
          vy = srcX;
          vz = srcY;
        }

        const sourceIndex = vz * strideZ + vy * strideY + vx;
        if (volume.observedSupport && !volume.observedSupport[sourceIndex]) {
          // Amber cross-hatching is evidence provenance, not invented dark tissue.
          const stripe = ((px + py) & 7) < 2;
          r = stripe ? 108 : 46;
          g = stripe ? 71 : 34;
          b = stripe ? 27 : 20;
        }

        const labelId = labels?.data[sourceIndex] ?? 0;
        if (labelId !== 0 && palette && !(volume.observedSupport && !volume.observedSupport[sourceIndex])) {
          const o = labelId * 4;
          const lr = palette[o] ?? 0;
          const lg = palette[o + 1] ?? 0;
          const lb = palette[o + 2] ?? 0;

          const a = overlayAlpha;
          r = Math.round((1 - a) * r + a * lr);
          g = Math.round((1 - a) * g + a * lg);
          b = Math.round((1 - a) * b + a * lb);
        }
      }

      const j = i * 4;
      out[j] = r;
      out[j + 1] = g;
      out[j + 2] = b;
      out[j + 3] = 255;
    }

    ctx.putImageData(img, 0, 0);

    // Draw a small crosshair for the current seed (if it lies on the current inspector slice).
    if (seedVoxel) {
      const isOnSlice =
        inspectPlane === 'axial'
          ? seedVoxel.z === idx
          : inspectPlane === 'coronal'
            ? seedVoxel.y === idx
            : seedVoxel.x === idx;

      if (isOnSlice) {
        const seedCol = inspectPlane === 'axial' ? seedVoxel.x : inspectPlane === 'coronal' ? seedVoxel.x : seedVoxel.y;
        const seedRow = inspectPlane === 'axial' ? seedVoxel.y : inspectPlane === 'coronal' ? seedVoxel.z : seedVoxel.z;

        const cx = srcCols > 1 ? (seedCol / (srcCols - 1)) * (dsCols - 1) : 0;
        const cy = srcRows > 1 ? (seedRow / (srcRows - 1)) * (dsRows - 1) : 0;

        ctx.save();
        ctx.strokeStyle = 'rgba(255, 80, 80, 0.95)';
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(cx - 6, cy);
        ctx.lineTo(cx + 6, cy);
        ctx.moveTo(cx, cy - 6);
        ctx.lineTo(cx, cy + 6);
        ctx.stroke();
        ctx.restore();
      }
    }

    const drawRoiBounds = (
      bounds: { min: Vec3i; max: Vec3i },
      opts: { stroke: string; fill?: string; dashed?: boolean },
    ) => {
      const toCanvasX = (col: number) => (srcCols > 1 ? (col / (srcCols - 1)) * (dsCols - 1) : 0);
      const toCanvasY = (row: number) => (srcRows > 1 ? (row / (srcRows - 1)) * (dsRows - 1) : 0);

      let col0 = 0;
      let col1 = 0;
      let row0 = 0;
      let row1 = 0;

      if (inspectPlane === 'axial') {
        col0 = bounds.min.x;
        col1 = bounds.max.x;
        row0 = bounds.min.y;
        row1 = bounds.max.y;
      } else if (inspectPlane === 'coronal') {
        col0 = bounds.min.x;
        col1 = bounds.max.x;
        row0 = bounds.min.z;
        row1 = bounds.max.z;
      } else {
        // sagittal
        col0 = bounds.min.y;
        col1 = bounds.max.y;
        row0 = bounds.min.z;
        row1 = bounds.max.z;
      }

      const x0 = toCanvasX(col0);
      const x1 = toCanvasX(col1);
      const y0 = toCanvasY(row0);
      const y1 = toCanvasY(row1);

      const left = Math.min(x0, x1);
      const right = Math.max(x0, x1);
      const top = Math.min(y0, y1);
      const bottom = Math.max(y0, y1);

      const w = right - left;
      const h = bottom - top;

      ctx.save();
      if (opts.dashed) ctx.setLineDash([4, 3]);

      if (opts.fill) {
        ctx.fillStyle = opts.fill;
        ctx.fillRect(left, top, w, h);
      }

      ctx.strokeStyle = opts.stroke;
      ctx.lineWidth = 1;
      ctx.strokeRect(left, top, w, h);
      ctx.restore();
    };

    const roiIntersectsCurrentSlice = (bounds: { min: Vec3i; max: Vec3i }): boolean => {
      if (inspectPlane === 'axial') {
        return idx >= bounds.min.z && idx <= bounds.max.z;
      }
      if (inspectPlane === 'coronal') {
        return idx >= bounds.min.y && idx <= bounds.max.y;
      }
      return idx >= bounds.min.x && idx <= bounds.max.x;
    };

    if (growRoiBounds && roiIntersectsCurrentSlice(growRoiBounds)) {
      drawRoiBounds(growRoiBounds, {
        stroke: 'rgba(0, 220, 255, 0.95)',
        fill: 'rgba(0, 220, 255, 0.08)',
      });
    }

    if (growRoiDraftBounds && roiIntersectsCurrentSlice(growRoiDraftBounds)) {
      drawRoiBounds(growRoiDraftBounds, {
        stroke: 'rgba(255, 210, 0, 0.95)',
        fill: 'rgba(255, 210, 0, 0.06)',
        dashed: true,
      });
    }
  }, [
    growRoiBounds,
    growRoiDraftBounds,
    hasLabels,
    inspectPlane,
    inspectorSlice,
    labelMix,
    labelPalette,
    labels,
    labelsEnabled,
    seedVoxel,
    volume,
  ]);

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
    let resizeObserverRef: ResizeObserver | null = null;

    try {
      program = createProgram(gl, vsSrc, fsSrc);

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
      const occGrid = preparedRender?.occupancy ?? buildOccupancyMaxGrid({ data: renderTex.data, dims: texDims });
      occMaxCell = [occGrid.dims.nx - 1, occGrid.dims.ny - 1, occGrid.dims.nz - 1];

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

      // Fragment cost scales with backing-store pixel count, and a shaded volume render
      // can't visually exploit pixel densities much past ~1.5x CSS resolution — a 2x-DPR
      // display would otherwise pay 4x the rays of CSS resolution for imperceptible gain.
      const MAX_DPR = 1.5;
      // While the user is actively rotating/zooming, drop to half resolution (4x fewer rays)
      // and ~1/2.7 the march steps; the shader's jittered ray start masks the step banding.
      // The settle frame after interaction restores full quality.
      const INTERACTION_SCALE = 0.5;
      const INTERACTION_STEPS = 96;

      const resizeAndViewport = (scale: number) => {
        const dpr = Math.min(window.devicePixelRatio || 1, MAX_DPR);
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

        const { threshold, steps, gamma, opacity, zoom, labelsEnabled, labelMix, hasLabels } = paramsRef.current;

        gl.disable(gl.DEPTH_TEST);
        gl.disable(gl.CULL_FACE);

        gl.useProgram(program);
        gl.bindVertexArray(vao);

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

        const labelsOn = labelsEnabled && hasLabels ? 1 : 0;
        gl.uniform1i(u.labelsEnabled, labelsOn);
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
        gl.uniform1f(u.zoom, zoom);
        gl.uniform1f(u.thr, clamp(threshold, 0, THRESHOLD_MAX));
        // Fewer steps while interacting (banding hidden by the jittered ray start); the
        // settled frame always marches the full configured step count.
        gl.uniform1i(u.steps, Math.round(clamp(interacting ? Math.min(INTERACTION_STEPS, steps) : steps, 8, 256)));
        gl.uniform1f(u.jitter, interacting ? 1 : 0);
        gl.uniform1f(u.gamma, clamp(gamma, 0.1, 10));
        gl.uniform1f(u.opacity, clamp(opacity, 0.1, 20));
        gl.uniform3f(u.texel, 1 / Math.max(1, texDims.nx), 1 / Math.max(1, texDims.ny), 1 / Math.max(1, texDims.nz));

        gl.drawArrays(gl.TRIANGLES, 0, 3);

        // Overlay reference axes with mm tick marks for gauging physical size.
        if (axesCanvas && axesCtx) {
          drawAxesOverlay({ axesCanvas, axesCtx, canvas, volume, boxScale, rotMat, zoom });
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
      const requestRender = () => {
        if (raf) return;
        raf = window.requestAnimationFrame(() => {
          raf = 0;
          draw();
        });
      };

      requestRenderRef.current = requestRender;

      // The free-running loop used to pick up CSS size changes implicitly; on-demand
      // rendering needs an explicit nudge when the canvas is resized by layout.
      const resizeObserver = new ResizeObserver(() => requestRender());
      resizeObserver.observe(canvas);
      resizeObserverRef = resizeObserver;

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
      resizeObserverRef?.disconnect();

      if (raf) window.cancelAnimationFrame(raf);

      glLabelStateRef.current = null;

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
  // IMPORTANT: allocate the full 3D label texture only when labels are enabled + present.
  useEffect(() => {
    const st = glLabelStateRef.current;
    if (!st) return;

    const { gl, texLabels, texPalette, texDims } = st;

    if (!labelsEnabled || !volume || !labels || !hasLabels) {
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

    // Consume the dirty marker. The partial path is only sound when (a) the marker
    // describes the exact buffer we're about to upload (grow ticks mutate workLabels in
    // place; fresh buffers from ONNX/overrides won't match and take the full path) and
    // (b) the texture already holds a complete prior upload to patch into.
    const dirty = labelDirtyRef.current;
    labelDirtyRef.current = null;
    const partial = texAllocated && dirty !== null && dirty.data === labels.data;

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

      if (partial && sameDims) {
        // Texture is a 1:1 copy of the label volume: patch the dirty box directly.
        uploadSubBox(labels.data, srcDims, dirty.min, dirty.max);
      } else if (partial && dsCache && dsCache.src === labels.data && dsCache.key === dsKey) {
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
  }, [glEpoch, hasLabels, labelPalette, labels, labelsEnabled, volume]);

  const onViewerKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLCanvasElement>) => {
      switch (event.key) {
        case 'ArrowLeft':
        case 'ArrowRight':
        case 'ArrowUp':
        case 'ArrowDown': {
          const horizontal = event.key === 'ArrowLeft' || event.key === 'ArrowRight';
          const axis = horizontal ? { x: 0, y: 1, z: 0 } : { x: 1, y: 0, z: 0 };
          const angle = event.key === 'ArrowLeft' || event.key === 'ArrowUp' ? -Math.PI / 36 : Math.PI / 36;
          rotationRef.current = quatNormalize(quatMultiply(quatFromAxisAngle(axis, angle), rotationRef.current));
          markInteraction();
          break;
        }
        case '+':
        case '=':
        case '-':
          setZoom((current) => clamp(event.key === '-' ? current / 1.15 : current * 1.15, 0.6, 10));
          markInteraction();
          break;
        case '0':
          resetView();
          break;
        case '1':
        case '2':
        case '3':
          setInspectPlane(event.key === '1' ? 'axial' : event.key === '2' ? 'coronal' : 'sagittal');
          break;
        case '[':
          setInspectIndex((current) => Math.max(0, current - 1));
          break;
        case ']':
          setInspectIndex((current) => Math.min(inspectorInfo.maxIndex, current + 1));
          break;
        case 'Escape':
          dragRef.current = null;
          if (growStatus.running) cancelSeedGrow();
          break;
        default:
          return;
      }

      event.preventDefault();
      event.stopPropagation();
    },
    [cancelSeedGrow, growStatus.running, inspectorInfo.maxIndex, markInteraction, resetView],
  );

  const inspectorPhysicalAspectRatio = useMemo(() => {
    if (!volume) return undefined;
    const [nx, ny, nz] = volume.dims;
    const [vx, vy, vz] = volume.voxelSizeMm;
    if (inspectPlane === 'axial') return `${nx * vx} / ${ny * vy}`;
    if (inspectPlane === 'coronal') return `${nx * vx} / ${nz * vz}`;
    return `${ny * vy} / ${nz * vz}`;
  }, [inspectPlane, volume]);

  const sliceInspectorCard = (
    <div
      className={`border border-[var(--border-color)] rounded-lg overflow-hidden bg-[var(--bg-secondary)] ${COARSE_POINTER_CONTROL_TARGETS}`}
    >
      <div className="px-3 py-2 text-xs font-medium bg-[var(--bg-tertiary)] text-[var(--text-secondary)]">
        Slice Inspector
      </div>
      <div className="p-3 space-y-2">
        <div className="grid grid-cols-2 gap-2">
          <label className="block text-xs text-[var(--text-secondary)]">
            Plane
            <select
              value={inspectPlane}
              onChange={(e) => setInspectPlane(e.target.value as 'axial' | 'coronal' | 'sagittal')}
              className="mt-1 w-full px-2 py-1 rounded border border-[var(--border-color)] bg-[var(--bg-secondary)]"
              disabled={!volume}
            >
              <option value="axial">Axial (z)</option>
              <option value="coronal">Coronal (y)</option>
              <option value="sagittal">Sagittal (x)</option>
            </select>
          </label>

          <label className="block text-xs text-[var(--text-secondary)]">
            Slice
            <input
              type="range"
              min={0}
              max={inspectorInfo.maxIndex}
              step={1}
              value={Math.round(clamp(inspectIndex, 0, inspectorInfo.maxIndex))}
              onChange={(e) => setInspectIndex(Number(e.target.value))}
              className="mt-1 w-full"
              disabled={!volume}
            />
            <div className="mt-1 text-xs text-[var(--text-tertiary)] tabular-nums">
              {Math.round(clamp(inspectIndex, 0, inspectorInfo.maxIndex))}/{inspectorInfo.maxIndex}
            </div>
          </label>
        </div>

        <div className="text-xs text-[var(--text-tertiary)]">
          Drag to draw an inspection region. Amber indicates anatomy without acquired-pixel support.
        </div>

        {inspectedCoordinate ? (
          <div
            role="status"
            aria-live="polite"
            className={`text-xs tabular-nums ${
              inspectedCoordinate.supported === false
                ? 'text-amber-200'
                : inspectedCoordinate.supported === true
                  ? 'text-cyan-200/90'
                  : 'text-[var(--text-tertiary)]'
            }`}
          >
            {inspectedCoordinate.supported === false
              ? 'No acquired support'
              : inspectedCoordinate.supported === true
                ? 'Acquired support'
                : 'Support not recorded'}
            {' · Patient position: ('}
            {inspectedCoordinate.positionMm.map((value) => value.toFixed(2)).join(', ')}
            {') mm'}
          </div>
        ) : null}

        <div className="border border-[var(--border-color)] rounded overflow-hidden bg-black">
          <canvas
            ref={sliceCanvasRef}
            className="w-full h-auto"
            role="img"
            aria-label={`${inspectPlane} reconstructed slice ${Math.round(clamp(inspectIndex, 0, inspectorInfo.maxIndex))}`}
            tabIndex={volume ? 0 : -1}
            style={{
              aspectRatio: inspectorPhysicalAspectRatio,
              cursor: volume ? 'crosshair' : 'default',
            }}
            onPointerDown={onSliceInspectorPointerDown}
            onPointerMove={onSliceInspectorPointerMove}
            onPointerUp={onSliceInspectorPointerUp}
            onPointerCancel={onSliceInspectorPointerCancel}
            onContextMenu={(e) => e.preventDefault()}
          />
        </div>

        {volume ? (
          <div className="text-xs text-[var(--text-tertiary)] tabular-nums">
            Volume dims: {volDims.nx}×{volDims.ny}×{volDims.nz}
          </div>
        ) : null}
      </div>
    </div>
  );

  const wantsSliceInspectorPortal = Boolean(sliceInspectorPortalTarget);
  const sliceInspectorPortal =
    volume && sliceInspectorPortalTarget ? createPortal(sliceInspectorCard, sliceInspectorPortalTarget) : null;
  const controlsVisible = Boolean(volume) && !controlsCollapsed;

  return (
    <div
      data-controls-open={controlsVisible}
      className={`svr-volume-layout h-full min-h-0 overflow-hidden grid grid-rows-1 gap-3 ${COARSE_POINTER_CONTROL_TARGETS} ${
        controlsVisible ? 'grid-cols-[minmax(0,1fr)_minmax(280px,380px)]' : 'grid-cols-1'
      }`}
    >
      {sliceInspectorPortal}

      <div className="min-h-0">
        <div className="border border-[var(--border-color)] rounded-lg overflow-hidden bg-black h-full min-h-0">
          <div className="relative w-full h-full min-h-0">
            {volume ? (
              <button
                type="button"
                onClick={() => setControlsCollapsed((v) => !v)}
                aria-label={controlsCollapsed ? 'Show 3D control panels' : 'Hide 3D control panels'}
                aria-expanded={!controlsCollapsed}
                className="absolute right-2 top-2 z-20 inline-flex min-h-9 min-w-9 items-center justify-center rounded-full bg-black/50 border border-white/10 text-white/80 hover:bg-black/70"
                title={controlsCollapsed ? 'Show panels' : 'Hide panels'}
              >
                {controlsCollapsed ? <ChevronLeft className="w-4 h-4" /> : <ChevronRight className="w-4 h-4" />}
              </button>
            ) : null}

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
              <div className="absolute inset-0 flex items-center justify-center text-xs text-white/70 bg-black/40 p-4 text-center">
                Run SVR to generate a volume for 3D viewing.
              </div>
            ) : initError ? (
              <div
                role="alert"
                className="absolute inset-0 flex items-center justify-center text-sm text-amber-200 bg-black/60 p-4 text-center"
              >
                {initError}
              </div>
            ) : renderBuild.status === 'error' ? (
              <div
                role="alert"
                className="absolute inset-0 flex items-center justify-center text-sm text-red-300 bg-black/60 p-4 text-center"
              >
                {renderBuild.error ?? 'Failed to prepare 3D render volume.'}
              </div>
            ) : renderBuild.status !== 'ready' ? (
              <div className="absolute inset-0 flex items-center justify-center text-xs text-white/80 bg-black/60 p-4 text-center">
                <div className="space-y-2">
                  <div>Preparing 3D render…</div>
                  {renderPlan ? (
                    <div className="text-xs text-white/60 tabular-nums">
                      {renderPlan.dims.nx}×{renderPlan.dims.ny}×{renderPlan.dims.nz} ·{' '}
                      {renderPlan.kind === 'f32' ? 'float' : 'u8'} · {renderPlan.note}
                    </div>
                  ) : null}
                </div>
              </div>
            ) : (
              <div className="absolute left-3 bottom-3 text-xs text-white/75 bg-black/60 px-3 py-2 rounded-md">
                Drag or use arrow keys to rotate · Wheel or +/− to zoom
              </div>
            )}

            {volume && renderPlan ? (
              <div className="absolute left-3 top-3 z-10 max-w-[calc(100%-4rem)] rounded-md border border-white/10 bg-black/70 px-3 py-2 text-xs text-white/80">
                <div className="tabular-nums">
                  Render: {renderPlan.dims.nx} × {renderPlan.dims.ny} × {renderPlan.dims.nz}
                  {' · '}
                  {actualTextureFormat === 'f16'
                    ? '16-bit float'
                    : actualTextureFormat === 'u8'
                      ? '8-bit'
                      : 'preparing'}
                </div>
                {volume.acquiredOrientationCount !== undefined ? (
                  <div className="mt-1 text-white/70">
                    {volume.acquiredOrientationCount} source orientation
                    {volume.acquiredOrientationCount === 1 ? '' : 's'}
                  </div>
                ) : null}
                {volume.effectiveResolutionMm ? (
                  <div className="mt-1 text-white/70 tabular-nums">
                    Acquired resolution: {volume.effectiveResolutionMm.map((value) => value.toFixed(2)).join(' × ')} mm
                  </div>
                ) : null}
                {volume.sliceProfileSource ? (
                  <div
                    className={
                      volume.sliceProfileSource === 'declared' ? 'mt-1 text-white/70' : 'mt-1 text-amber-200/90'
                    }
                  >
                    Slice profile: {volume.sliceProfileSource}
                    {volume.sliceProfileSource === 'unknown' ? ' (thickness was not declared)' : ''}
                  </div>
                ) : null}
                {observedSupportSummary ? (
                  <div className={observedSupportSummary.valid ? 'mt-1 text-cyan-200/90' : 'mt-1 text-amber-200'}>
                    {observedSupportSummary.valid
                      ? `Acquired support: ${observedSupportSummary.count.toLocaleString()} of ${observedSupportSummary.total.toLocaleString()} voxels (${Math.round((observedSupportSummary.count / Math.max(1, observedSupportSummary.total)) * 100)}%)`
                      : 'Acquired support does not match the reconstruction.'}
                  </div>
                ) : null}
              </div>
            ) : null}
          </div>
        </div>
      </div>

      {!controlsVisible ? null : (
        <div className="min-h-0 overflow-y-auto space-y-3 pr-1">
          <div className="text-xs font-medium text-[var(--text-secondary)]">3D Controls</div>

          <div className="grid grid-cols-2 gap-2">
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

          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={resetView}
              disabled={!volume}
              className="px-3 py-2 text-xs rounded-lg border border-[var(--border-color)] bg-[var(--bg-secondary)] text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-tertiary)] disabled:opacity-50"
            >
              Reset view
            </button>
          </div>

          <div className="text-xs text-[var(--text-tertiary)]">
            Opacity and edge shading are applied evenly across the acquired volume; unsupported regions never become
            tissue.
          </div>

          <div className="border border-[var(--border-color)] rounded-lg overflow-hidden bg-[var(--bg-secondary)]">
            <button
              type="button"
              onClick={() => setSegmentationCollapsed((v) => !v)}
              className="w-full px-3 py-2 flex items-center justify-between text-xs font-medium bg-[var(--bg-tertiary)] text-[var(--text-secondary)] hover:text-[var(--text-primary)]"
              aria-expanded={!segmentationCollapsed}
            >
              <span>Segmentation</span>
              {segmentationCollapsed ? <ChevronRight className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
            </button>

            {segmentationCollapsed ? null : (
              <div className="p-3 space-y-2">
                <div className="flex items-end gap-2">
                  <label className="block flex-1 text-xs text-[var(--text-secondary)]">
                    ROI falloff
                    <input
                      type="range"
                      min={0}
                      max={1}
                      step={0.05}
                      value={growRoiOutsideScale}
                      onChange={(e) => {
                        const next = Number(e.target.value);
                        setGrowRoiOutsideScale(next);
                        scheduleSeedGrow({ roiOutsideScale: next });
                      }}
                      className="mt-1 w-full"
                      disabled={!volume || onnxSegRunning || !growRoiBounds}
                    />
                    <div className="mt-1 text-xs text-[var(--text-tertiary)] tabular-nums">
                      ×{growRoiOutsideScale.toFixed(2)}
                    </div>
                  </label>

                  <button
                    type="button"
                    onClick={() => {
                      setGrowRoiBounds(null);
                      setGrowRoiDraftBounds(null);
                      setSeedVoxel(null);
                      cancelSeedGrow('Cleared ROI');
                      scheduleSeedGrow({ roiBounds: null });
                    }}
                    disabled={!growRoiBounds || onnxSegRunning}
                    className="min-h-9 px-2 py-1 text-xs rounded border border-[var(--border-color)] bg-[var(--bg-secondary)] text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-tertiary)] disabled:opacity-50"
                  >
                    Clear ROI
                  </button>
                </div>

                <div className="flex items-center gap-2 text-xs text-[var(--text-tertiary)]">
                  <span className="truncate">
                    Seed (ROI center):{' '}
                    {seedVoxel ? (
                      <span className="tabular-nums">
                        {seedVoxel.x},{seedVoxel.y},{seedVoxel.z}
                      </span>
                    ) : (
                      <span>—</span>
                    )}
                  </span>
                </div>

                <div className="grid grid-cols-2 gap-2">
                  <label className="block text-xs text-[var(--text-secondary)]">
                    Target
                    <select
                      value={growTargetLabel}
                      onChange={(e) => {
                        const next = Number(e.target.value) as BratsBaseLabelId;
                        setGrowTargetLabel(next);
                        scheduleSeedGrow({ targetLabel: next });
                      }}
                      className="mt-1 w-full px-2 py-1 rounded border border-[var(--border-color)] bg-[var(--bg-secondary)]"
                      disabled={!volume || onnxSegRunning || !growRoiBounds}
                    >
                      <option value={BRATS_LABEL_ID.NCR_NET}>Core (1)</option>
                      <option value={BRATS_LABEL_ID.EDEMA}>Edema (2)</option>
                      <option value={BRATS_LABEL_ID.ENHANCING}>Enhancing (4)</option>
                    </select>
                  </label>

                  <label className="block text-xs text-[var(--text-secondary)]">
                    Tolerance
                    <input
                      type="range"
                      min={0}
                      max={0.5}
                      step={0.005}
                      value={growTolerance}
                      onChange={(e) => {
                        const next = Number(e.target.value);
                        setGrowTolerance(next);
                        scheduleSeedGrow({ tolerance: next });
                      }}
                      className="mt-1 w-full"
                      disabled={!volume || onnxSegRunning || !growRoiBounds}
                    />
                    <div className="mt-1 text-xs text-[var(--text-tertiary)] tabular-nums">
                      ±{growTolerance.toFixed(3)}
                    </div>
                  </label>
                </div>

                <div className="flex items-center gap-2">
                  {growStatus.running ? (
                    <button
                      type="button"
                      onClick={() => cancelSeedGrow()}
                      className="px-3 py-2 text-xs rounded-lg border border-white/10 bg-black/40 text-white/80 hover:bg-black/60"
                    >
                      Cancel
                    </button>
                  ) : null}

                  <button
                    type="button"
                    onClick={() => {
                      cancelSeedGrow('Cleared segmentation');
                      growOverlayRef.current = null;
                      setGeneratedLabels(null);
                    }}
                    disabled={!generatedLabels || onnxSegRunning}
                    className="ml-auto px-3 py-2 text-xs rounded-lg border border-[var(--border-color)] bg-[var(--bg-secondary)] text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-tertiary)] disabled:opacity-50"
                  >
                    Clear seg
                  </button>
                </div>

                {growStatus.error ? (
                  <div role="alert" className="text-xs text-red-300 bg-red-400/10 px-2 py-1 rounded">
                    {growStatus.error}
                  </div>
                ) : growStatus.message ? (
                  <div role="status" className="text-xs text-[var(--text-tertiary)]">
                    {growStatus.message}
                  </div>
                ) : null}

                <details className="pt-2 mt-2 border-t border-[var(--border-color)] text-xs text-[var(--text-secondary)]">
                  <summary className="min-h-9 cursor-pointer py-2 font-medium hover:text-[var(--text-primary)]">
                    Optional verified ONNX model
                  </summary>
                  <div className="space-y-2">
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
                        className="px-3 py-2 text-xs rounded-lg border border-[var(--border-color)] bg-[var(--bg-secondary)] text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-tertiary)] disabled:opacity-50"
                      >
                        Upload model + manifest
                      </button>

                      <button
                        type="button"
                        onClick={initOnnxSession}
                        disabled={!onnxStatus.cached || !onnxStatus.verified || onnxStatus.loading}
                        className="px-3 py-2 text-xs rounded-lg bg-white/10 hover:bg-white/20 text-white disabled:opacity-50"
                      >
                        Init
                      </button>

                      <button
                        type="button"
                        onClick={runOnnxSegmentation}
                        disabled={
                          !volume ||
                          !onnxStatus.cached ||
                          !onnxStatus.verified ||
                          onnxStatus.loading ||
                          !!onnxPreflight?.blockedByDefault
                        }
                        className="px-3 py-2 text-xs rounded-lg bg-white/10 hover:bg-white/20 text-white disabled:opacity-50"
                      >
                        Run ML
                      </button>

                      {onnxSegRunning ? (
                        <button
                          type="button"
                          onClick={cancelOnnxSegmentation}
                          className="px-3 py-2 text-xs rounded-lg border border-white/10 bg-black/40 text-white/80 hover:bg-black/60"
                        >
                          Cancel
                        </button>
                      ) : null}

                      <button
                        type="button"
                        onClick={onnxClearModel}
                        disabled={!onnxStatus.cached || onnxStatus.loading}
                        className="ml-auto px-3 py-2 text-xs rounded-lg border border-[var(--border-color)] bg-[var(--bg-secondary)] text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-tertiary)] disabled:opacity-50"
                      >
                        Clear model
                      </button>
                    </div>

                    <details className="text-xs text-[var(--text-secondary)]">
                      <summary className="cursor-pointer py-1 text-[var(--text-primary)]">
                        Required verified model manifest (.json)
                      </summary>
                      <p className="mt-1">
                        Select the ONNX model and its JSON sidecar together. The manifest must declare the model's exact
                        SHA-256 hash, MR input, preprocessing, axes, and tumor class meanings.
                      </p>
                      <pre className="mt-2 max-h-48 overflow-auto rounded bg-[var(--bg-primary)] p-2 text-xs">
                        {JSON.stringify(TUMOR_MODEL_MANIFEST_EXAMPLE, null, 2)}
                      </pre>
                    </details>

                    {onnxPreflight?.blockedByDefault ? (
                      <div className="text-xs text-yellow-200 bg-yellow-400/10 px-2 py-1 rounded">
                        Model inference would require approximately {formatMiB(onnxPreflight.estimatedPeakBytes)} of
                        resident memory, exceeding the shared {formatMiB(onnxPreflight.budgetBytes)} SVR budget.
                        Reconstruct a smaller focus region or use a lower resolution.
                      </div>
                    ) : null}

                    {onnxStatus.error ? (
                      <div role="alert" className="text-xs text-red-300 bg-red-400/10 px-2 py-1 rounded">
                        {onnxStatus.error}
                      </div>
                    ) : onnxStatus.message ? (
                      <div role="status" className="text-xs text-[var(--text-tertiary)]">
                        {onnxStatus.message}
                      </div>
                    ) : null}
                  </div>
                </details>

                {!hasLabels || !labels ? (
                  <div className="text-xs text-[var(--text-tertiary)]">No segmentation labels available yet.</div>
                ) : (
                  <div className="space-y-1">
                    {labels.meta
                      .filter((m) => m.id !== 0)
                      .map((m) => {
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
                          Total labeled: {labelMetrics.totalCount.toLocaleString()} vox ·{' '}
                          {labelMetrics.totalMm3.toFixed(1)} mm³ · {labelMetrics.totalMl.toFixed(2)} mL
                        </div>
                        {labelMetrics.unsupportedBoundaryCount > 0 ? (
                          <div className="rounded bg-amber-400/10 px-2 py-1 text-xs text-amber-200">
                            Incomplete acquired coverage: {labelMetrics.unsupportedBoundaryCount.toLocaleString()}{' '}
                            labeled boundary voxels touch unsupported anatomy. Reported volume includes observed voxels
                            only.
                          </div>
                        ) : null}
                      </>
                    ) : null}
                  </div>
                )}
              </div>
            )}
          </div>

          {!wantsSliceInspectorPortal ? sliceInspectorCard : null}
        </div>
      )}
    </div>
  );
}
