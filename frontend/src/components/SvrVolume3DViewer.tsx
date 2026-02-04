import { forwardRef, useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ChevronDown, ChevronLeft, ChevronRight } from 'lucide-react';
import type * as Ort from 'onnxruntime-web';
import type { SvrLabelVolume, SvrVolume } from '../types/svr';
import { BRATS_BASE_LABEL_META, BRATS_LABEL_ID, type BratsBaseLabelId } from '../utils/segmentation/brats';
import { buildRgbaPalette256, rgbCss } from '../utils/segmentation/labelPalette';
import { deleteModelBlob, getModelBlob, getModelSavedAtMs, putModelBlob } from '../utils/segmentation/onnx/modelCache';
import { createOrtSessionFromModelBlob } from '../utils/segmentation/onnx/ortLoader';
import { runTumorSegmentationOnnx } from '../utils/segmentation/onnx/tumorSegmentation';
import { computeSeedRange01, type RegionGrow3DRoi, type Vec3i } from '../utils/segmentation/regionGrow3D';
import { regionGrow3D_v2 } from '../utils/segmentation/regionGrow3D_v2';
import { computeRoiCubeBoundsFromSliceDrag } from '../utils/segmentation/roiCube3d';
import { resample2dAreaAverage } from '../utils/svr/resample2d';
import { formatMiB } from '../utils/svr/svrUtils';
import {
  buildRenderVolumeTexData,
  computeRenderPlan,
  downsampleLabelsNearest,
  toUint8Volume,
  type RenderDims,
  type RenderQualityPreset,
  type RenderTextureMode,
  type RenderVolumeTexData,
} from '../utils/svr/renderLod';

function clamp(x: number, min: number, max: number): number {
  return x < min ? min : x > max ? max : x;
}


/**
 * Camera model constants used by both:
 * - the fragment shader (ray origin + image plane)
 * - the 2D axes overlay projection helper (`projectWorldToCanvas`)
 *
 * Keep these in sync or the overlay will drift relative to the 3D render.
 */
const SVR3D_CAMERA_Z = 1.6;
const SVR3D_FOCAL_Z = 1.2;

// IndexedDB key for the cached tumor segmentation ONNX model.
const ONNX_TUMOR_MODEL_KEY = 'brats-tumor-v1';

// ONNX preflight: extremely large 3D volumes can trigger huge intermediate/logits allocations.
// We block full-res runs by default above a conservative budget, with an explicit user override.
const ONNX_PREFLIGHT_CLASS_COUNT = 4;
const ONNX_PREFLIGHT_LOGITS_BUDGET_BYTES = 384 * 1024 * 1024;

// Render defaults
const DEFAULT_RENDER_QUALITY: RenderQualityPreset = 'auto';
const DEFAULT_RENDER_GPU_BUDGET_MIB = 256;
const DEFAULT_RENDER_TEXTURE_MODE: RenderTextureMode = 'auto';

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

type OnnxSessionMode = 'webgpu-preferred' | 'wasm';

async function rgbaToPngBlob(params: { rgba: Uint8ClampedArray; width: number; height: number }): Promise<Blob> {
  const { rgba, width, height } = params;

  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;

  const ctx = canvas.getContext('2d');
  if (!ctx) {
    throw new Error('Failed to create 2D canvas context');
  }

  const img = ctx.createImageData(width, height);
  img.data.set(rgba);
  ctx.putImageData(img, 0, 0);

  const blob = await new Promise<Blob>((resolve, reject) => {
    canvas.toBlob((b) => {
      if (!b) {
        reject(new Error('canvas.toBlob() returned null'));
        return;
      }
      resolve(b);
    }, 'image/png');
  });

  return blob;
}

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

  // NOTE: `rotMat` here is the same u_rot we send to the shader, so object->world matches.
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

type VolumeTextureFormat =
  | { kind: 'f32'; internalFormat: number; format: number; type: number; minMagFilter: number }
  | { kind: 'u8'; internalFormat: number; format: number; type: number; minMagFilter: number };

function chooseVolumeTextureFormat(gl: WebGL2RenderingContext): {
  primary: VolumeTextureFormat;
  fallback: VolumeTextureFormat;
} {
  // Float textures preserve subtle contrast; if linear filtering isn't supported we can still sample with NEAREST.
  const floatLinear = !!gl.getExtension('OES_texture_float_linear');

  const primary: VolumeTextureFormat = {
    kind: 'f32',
    internalFormat: gl.R32F,
    format: gl.RED,
    type: gl.FLOAT,
    minMagFilter: floatLinear ? gl.LINEAR : gl.NEAREST,
  };

  const fallback: VolumeTextureFormat = {
    kind: 'u8',
    internalFormat: gl.R8,
    format: gl.RED,
    type: gl.UNSIGNED_BYTE,
    minMagFilter: gl.LINEAR,
  };

  return { primary, fallback };
}

function compileShader(gl: WebGL2RenderingContext, type: number, src: string): WebGLShader {
  const sh = gl.createShader(type);
  if (!sh) throw new Error('Failed to create shader');
  gl.shaderSource(sh, src);
  gl.compileShader(sh);
  if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(sh) || '(no log)';
    gl.deleteShader(sh);
    throw new Error(log);
  }
  return sh;
}

function createProgram(gl: WebGL2RenderingContext, vsSrc: string, fsSrc: string): WebGLProgram {
  const vs = compileShader(gl, gl.VERTEX_SHADER, vsSrc);
  const fs = compileShader(gl, gl.FRAGMENT_SHADER, fsSrc);

  const prog = gl.createProgram();
  if (!prog) throw new Error('Failed to create program');
  gl.attachShader(prog, vs);
  gl.attachShader(prog, fs);
  gl.linkProgram(prog);

  gl.deleteShader(vs);
  gl.deleteShader(fs);

  if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
    const log = gl.getProgramInfoLog(prog) || '(no log)';
    gl.deleteProgram(prog);
    throw new Error(log);
  }

  return prog;
}

type RenderBuildState = {
  status: 'idle' | 'building' | 'ready' | 'error';
  key: string | null;
  data: RenderVolumeTexData | null;
  buildMs?: number;
  error?: string;
};

export type SvrVolume3DViewerProps = {
  volume: SvrVolume | null;
  labels?: SvrLabelVolume | null;
  /**
   * Optional portal target used to render the Slice Inspector outside of the viewer layout
   * (e.g. inside the SVR generation panel).
   *
   * If this prop is provided (even as null), the viewer will NOT render the Slice Inspector inline.
   */
  sliceInspectorPortalTarget?: Element | null;
};

export type SvrVolume3DViewerHandle = {
  /** Capture the current 3D canvas frame as a PNG (best-effort). */
  capture3dPng: () => Promise<Blob | null>;
  /** Reset view + controls to a stable preset for reproducible harness captures. */
  applyHarnessPreset: () => void;
};

export const SvrVolume3DViewer = forwardRef<SvrVolume3DViewerHandle, SvrVolume3DViewerProps>(function SvrVolume3DViewer(
  { volume, labels: labelsOverride, sliceInspectorPortalTarget },
  ref,
) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const axesCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const pendingCapture3dRef = useRef<{ resolve: (b: Blob | null) => void } | null>(null);

  const glLabelStateRef = useRef<GlLabelState | null>(null);

  const [initError, setInitError] = useState<string | null>(null);
  const [glEpoch, setGlEpoch] = useState(0);

  const renderBuildIdRef = useRef(0);
  const [renderBuild, setRenderBuild] = useState<RenderBuildState>(() => ({
    status: 'idle',
    key: null,
    data: null,
  }));

  // Optional externally-provided labels (e.g. from an ML pipeline) can override internal generation.
  const [generatedLabels, setGeneratedLabels] = useState<SvrLabelVolume | null>(null);
  const labels = labelsOverride ?? generatedLabels;

  // Phase 3: ONNX model execution (offline; model cached in IndexedDB).
  const onnxSessionRef = useRef<Ort.InferenceSession | null>(null);
  const onnxSessionModeRef = useRef<OnnxSessionMode | null>(null);
  const onnxFileInputRef = useRef<HTMLInputElement | null>(null);

  const releaseOnnxSession = useCallback((reason: string) => {
    const session = onnxSessionRef.current;
    onnxSessionRef.current = null;
    onnxSessionModeRef.current = null;

    if (session) {
      // Avoid leaking WebGPU/WASM resources if the user swaps/clears models.
      void session.release().catch((e) => {
        console.warn('[onnx] Failed to release session', { reason, e });
      });
    }
  }, []);

  useEffect(() => {
    return () => {
      releaseOnnxSession('unmount');
    };
  }, [releaseOnnxSession]);
  const [onnxStatus, setOnnxStatus] = useState<{
    cached: boolean;
    savedAtMs: number | null;
    loading: boolean;
    sessionReady: boolean;
    message?: string;
    error?: string;
  }>(() => ({
    cached: false,
    savedAtMs: null,
    loading: false,
    sessionReady: false,
  }));

  // Phase 4a: Best-effort cancellation.
  // NOTE: We can't reliably abort ORT execution mid-run in the browser; cancellation just ignores late results.
  const onnxSegRunIdRef = useRef(0);
  const [onnxSegRunning, setOnnxSegRunning] = useState(false);
  const [allowUnsafeOnnxFullRes, setAllowUnsafeOnnxFullRes] = useState(false);

  const refreshOnnxCacheStatus = useCallback(() => {
    void getModelSavedAtMs(ONNX_TUMOR_MODEL_KEY)
      .then((savedAtMs) => {
        setOnnxStatus((s) => ({ ...s, cached: savedAtMs !== null, savedAtMs, error: undefined }));
      })
      .catch((e) => {
        const msg = e instanceof Error ? e.message : String(e);
        setOnnxStatus((s) => ({ ...s, error: msg }));
      });
  }, []);

  useEffect(() => {
    refreshOnnxCacheStatus();
  }, [refreshOnnxCacheStatus]);

  // Viewer controls (composite-only)
  const [controlsCollapsed, setControlsCollapsed] = useState(false);
  // Radial threshold is applied as a center->edge ramp in the shader.
  // Keep the UI range small so the slider isn't overly sensitive.
  const [threshold, setThreshold] = useState(0.05);
  const THRESHOLD_EDGE_MAX = 0.12;
  // Always use max raymarch samples for quality; no UI control.
  const steps = 256;
  const [gamma, setGamma] = useState(1.0);
  const [opacity, setOpacity] = useState(4.0);
  const [zoom, setZoom] = useState(1.0);

  // Render quality (GPU-budgeted LOD) to avoid allocating full-res 3D textures on huge volumes.
  const [renderQuality, setRenderQuality] = useState<RenderQualityPreset>(DEFAULT_RENDER_QUALITY);
  const [renderGpuBudgetMiB, setRenderGpuBudgetMiB] = useState(DEFAULT_RENDER_GPU_BUDGET_MIB);
  const [renderTextureMode, setRenderTextureMode] = useState<RenderTextureMode>(DEFAULT_RENDER_TEXTURE_MODE);

  // Optional segmentation overlay (label volume).
  // No UI controls: labels are always shown when available.
  const labelsEnabled = true;
  const labelMix = 0.65;

  const [segmentationCollapsed, setSegmentationCollapsed] = useState(false);

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
  const growRunIdRef = useRef(0);
  const growAutoTimerRef = useRef<number | null>(null);

  // For live-updating tolerance we need to *replace* the previous preview rather than accumulate.
  // We store sparse previous label values so we can revert without copying the entire label volume.
  const growOverlayRef = useRef<
    | {
        key: string;
        seedKey: string;
        workLabels: Uint8Array;
        prevIndices: Uint32Array | null;
        prevValues: Uint8Array | null;
      }
    | null
  >(null);

  const sliceInspectorDragRef = useRef<
    | {
        pointerId: number;
        startClientX: number;
        startClientY: number;
        startVoxel: Vec3i;
        lastVoxel: Vec3i;
        draggingRoi: boolean;
      }
    | null
  >(null);

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
    growRunIdRef.current++;

    if (growAutoTimerRef.current !== null) {
      window.clearTimeout(growAutoTimerRef.current);
      growAutoTimerRef.current = null;
    }

    growOverlayRef.current = null;
    sliceInspectorDragRef.current = null;

    // Cancel any in-flight ONNX segmentation (best-effort).
    onnxSegRunIdRef.current++;
    setOnnxSegRunning(false);
    setAllowUnsafeOnnxFullRes(false);
    setOnnxStatus((s) => (s.loading ? { ...s, loading: false } : s));
  }, [volume]);

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

    const counts = new Map<number, number>();
    const data = labels.data;

    for (let i = 0; i < data.length; i++) {
      const id = data[i] ?? 0;
      if (id === 0) continue;
      counts.set(id, (counts.get(id) ?? 0) + 1);
    }

    const [vx, vy, vz] = volume.voxelSizeMm;
    const voxelVolMm3 = Math.abs(vx * vy * vz);

    let totalCount = 0;
    for (const c of counts.values()) {
      totalCount += c;
    }

    const totalMl = voxelVolMm3 > 0 ? (totalCount * voxelVolMm3) / 1000 : 0;

    return { counts, voxelVolMm3, totalCount, totalMl };
  }, [hasLabels, labels, volume]);

  // Slice inspector (orthogonal slices).
  const sliceCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const [inspectPlane, setInspectPlane] = useState<'axial' | 'coronal' | 'sagittal'>('axial');
  const [inspectIndex, setInspectIndex] = useState(0);

  const paramsRef = useRef({ threshold, steps, gamma, opacity, zoom, labelsEnabled, labelMix, hasLabels });
  useEffect(() => {
    paramsRef.current = { threshold, steps, gamma, opacity, zoom, labelsEnabled, labelMix, hasLabels };
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
    const maxDim = Math.max(1, nx, ny, nz);
    return {
      volDims: { nx, ny, nz },
      boxScale: [nx / maxDim, ny / maxDim, nz / maxDim] as const,
    };
  }, [volume]);

  const renderPlan = useMemo(() => {
    if (!volume) return null;

    return computeRenderPlan({
      srcDims: volDims,
      labelsEnabled,
      hasLabels,
      budgetMiB: renderGpuBudgetMiB,
      quality: renderQuality,
      textureMode: renderTextureMode,
    });
  }, [hasLabels, labelsEnabled, renderGpuBudgetMiB, renderQuality, renderTextureMode, volume, volDims]);

  const renderBuildKey = useMemo(() => {
    if (!renderPlan) return null;
    const d = renderPlan.dims;
    return `${renderPlan.kind}:${d.nx}x${d.ny}x${d.nz}`;
  }, [renderPlan]);

  useEffect(() => {
    if (!volume || !renderPlan || !renderBuildKey) {
      setRenderBuild({ status: 'idle', key: null, data: null });
      return;
    }

    setInitError(null);

    const key = renderBuildKey;

    const srcDims: RenderDims = volDims;
    const dstDims: RenderDims = renderPlan.dims;

    const isSameDims = srcDims.nx === dstDims.nx && srcDims.ny === dstDims.ny && srcDims.nz === dstDims.nz;

    // Preserve the fast-path: full-res float uses the SVR volume buffer directly (no extra allocations).
    if (isSameDims && renderPlan.kind === 'f32') {
      setRenderBuild({
        status: 'ready',
        key,
        data: { kind: 'f32', dims: dstDims, data: volume.data },
        buildMs: 0,
      });
      return;
    }

    const buildId = ++renderBuildIdRef.current;
    const started = performance.now();

    setRenderBuild({ status: 'building', key, data: null });

    void (async () => {
      try {
        const isCancelled = () => renderBuildIdRef.current !== buildId;

        const tex = await buildRenderVolumeTexData({
          src: volume.data,
          srcDims,
          plan: { kind: renderPlan.kind, dims: dstDims },
          isCancelled,
        });

        if (renderBuildIdRef.current !== buildId) return;

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
  }, []);

  useImperativeHandle(
    ref,
    () => ({
      capture3dPng: () => {
        if (!volume) return Promise.resolve(null);
        if (!canvasRef.current) return Promise.resolve(null);

        return new Promise<Blob | null>((resolve) => {
          // Only allow one pending capture; resolve any previous request.
          if (pendingCapture3dRef.current) {
            pendingCapture3dRef.current.resolve(null);
          }

          pendingCapture3dRef.current = { resolve };

          // Safety: don't leave callers hanging if the GL loop isn't running.
          window.setTimeout(() => {
            if (pendingCapture3dRef.current?.resolve === resolve) {
              pendingCapture3dRef.current = null;
              resolve(null);
            }
          }, 1500);
        });
      },
      applyHarnessPreset: () => {
        // Stable defaults for harness screenshots.
        setThreshold(0.05);
        setGamma(1.0);
        setOpacity(4.0);

        // Keep the 3D render memory bounded for harness runs.
        setRenderQuality(DEFAULT_RENDER_QUALITY);
        setRenderGpuBudgetMiB(DEFAULT_RENDER_GPU_BUDGET_MIB);
        setRenderTextureMode(DEFAULT_RENDER_TEXTURE_MODE);

        setControlsCollapsed(false);
        resetView();
      },
    }),
    [resetView, volume],
  );

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

  const onPointerMove = useCallback((e: React.PointerEvent) => {
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

    e.preventDefault();
    e.stopPropagation();
  }, []);

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

      e.preventDefault();
      e.stopPropagation();
    };

    canvas.addEventListener('wheel', onWheel, { passive: false });
    return () => canvas.removeEventListener('wheel', onWheel);
  }, []);

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

      const [nx, ny, nz] = volume.dims;
      const strideZ = nx * ny;
      const seedIdx = seed.z * strideZ + seed.y * nx + seed.x;
      const seedValue = volume.data[seedIdx] ?? 0;

      const { min, max } = computeSeedRange01({ seedValue, tolerance });

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

      const growPromise = regionGrow3D_v2({
        volume: volume.data,
        dims: volume.dims,
        seed,
        min,
        max,
        roi,
        opts: {
          signal: controller.signal,
          maxVoxels,
          connectivity: 6,
          yieldEvery,
          debug: debugGrow3d,
          onProgress: (p) => {
            const prefix = isAuto ? 'Previewing…' : 'Growing…';
            setGrowStatus((s) => (s.running ? { ...s, message: `${prefix} ${p.queued.toLocaleString()} voxels` } : s));
          },
        },
      });

      void growPromise
        .then((res) => {
          if (controller.signal.aborted) return;
          if (growRunIdRef.current !== runId) return;

          const o = growOverlayRef.current;
          if (!o || o.key !== volumeKey || o.seedKey !== seedKey) return;

          // Restore the previous preview region (sparse).
          if (o.prevIndices && o.prevValues && o.prevValues.length === o.prevIndices.length) {
            const prev = o.prevIndices;
            const vals = o.prevValues;
            for (let i = 0; i < prev.length; i++) {
              o.workLabels[prev[i]!] = vals[i] ?? 0;
            }
          }

          // Apply the new preview, capturing previous values so we can restore on the next update.
          const idx = res.indices;
          const nextPrevValues = new Uint8Array(idx.length);
          for (let i = 0; i < idx.length; i++) {
            const vi = idx[i]!;
            nextPrevValues[i] = o.workLabels[vi] ?? 0;
            o.workLabels[vi] = targetLabel;
          }
          o.prevIndices = idx;
          o.prevValues = nextPrevValues;

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

  const onnxPreflight = useMemo(() => {
    if (!volume) return null;

    const [nx, ny, nz] = volume.dims;
    const nvox = nx * ny * nz;

    // Lower-bound estimate: logits are float32 with C channels.
    const logitsBytes = nvox * ONNX_PREFLIGHT_CLASS_COUNT * 4;
    const inputBytes = nvox * 4;

    const blockedByDefault = logitsBytes > ONNX_PREFLIGHT_LOGITS_BUDGET_BYTES;

    return { nx, ny, nz, nvox, logitsBytes, inputBytes, blockedByDefault };
  }, [volume]);

  const onnxUploadClick = useCallback(() => {
    onnxFileInputRef.current?.click();
  }, []);

  const onnxClearModel = useCallback(() => {
    releaseOnnxSession('clear-model');
    setOnnxStatus((s) => ({
      ...s,
      sessionReady: false,
      loading: true,
      message: 'Clearing cached model…',
      error: undefined,
    }));

    void deleteModelBlob(ONNX_TUMOR_MODEL_KEY)
      .then(() => {
        setOnnxStatus((s) => ({ ...s, loading: false, message: 'Cleared cached model' }));
        refreshOnnxCacheStatus();
      })
      .catch((e) => {
        const msg = e instanceof Error ? e.message : String(e);
        setOnnxStatus((s) => ({ ...s, loading: false, error: msg }));
      });
  }, [refreshOnnxCacheStatus, releaseOnnxSession]);

  const onnxHandleSelectedFile = useCallback(
    (file: File) => {
      releaseOnnxSession('upload-model');
      setOnnxStatus((s) => ({
        ...s,
        loading: true,
        sessionReady: false,
        message: `Caching model: ${file.name}`,
        error: undefined,
      }));

      void putModelBlob(ONNX_TUMOR_MODEL_KEY, file)
        .then(() => {
          setOnnxStatus((s) => ({ ...s, loading: false, message: 'Model cached' }));
          refreshOnnxCacheStatus();
        })
        .catch((e) => {
          const msg = e instanceof Error ? e.message : String(e);
          setOnnxStatus((s) => ({ ...s, loading: false, error: msg }));
        });
    },
    [refreshOnnxCacheStatus, releaseOnnxSession],
  );

  const ensureOnnxSession = useCallback(async (): Promise<{ session: Ort.InferenceSession; mode: OnnxSessionMode }> => {
    if (onnxSessionRef.current) {
      return {
        session: onnxSessionRef.current,
        mode: onnxSessionModeRef.current ?? 'webgpu-preferred',
      };
    }

    const blob = await getModelBlob(ONNX_TUMOR_MODEL_KEY);
    if (!blob) {
      throw new Error('No cached ONNX model found. Upload one first.');
    }

    try {
      const session = await createOrtSessionFromModelBlob({ model: blob, preferWebGpu: true, logLevel: 'warning' });
      onnxSessionRef.current = session;
      onnxSessionModeRef.current = 'webgpu-preferred';
      return { session, mode: 'webgpu-preferred' };
    } catch {
      // Fallback to WASM-only.
      const session = await createOrtSessionFromModelBlob({ model: blob, preferWebGpu: false, logLevel: 'warning' });
      onnxSessionRef.current = session;
      onnxSessionModeRef.current = 'wasm';
      return { session, mode: 'wasm' };
    }
  }, []);

  const initOnnxSession = useCallback(() => {
    setOnnxStatus((s) => ({ ...s, loading: true, message: 'Initializing ONNX runtime…', error: undefined }));

    void ensureOnnxSession()
      .then(({ mode }) => {
        setOnnxStatus((s) => ({
          ...s,
          loading: false,
          sessionReady: true,
          message: mode === 'wasm' ? 'ONNX session ready (WASM)' : 'ONNX session ready (WebGPU preferred)',
        }));
      })
      .catch((e) => {
        const msg = e instanceof Error ? e.message : String(e);
        setOnnxStatus((s) => ({ ...s, loading: false, sessionReady: false, error: msg }));
      });
  }, [ensureOnnxSession]);

  const runOnnxSegmentation = useCallback(() => {
    if (!volume) return;

    // Guardrail: full-res ONNX on huge volumes can OOM the tab.
    if (onnxPreflight?.blockedByDefault && !allowUnsafeOnnxFullRes) {
      const dims = `${onnxPreflight.nx}×${onnxPreflight.ny}×${onnxPreflight.nz}`;
      const msg = `ONNX blocked for huge volume by default (${dims}; est logits ${formatMiB(onnxPreflight.logitsBytes)}). Re-run SVR at lower resolution/ROI or enable the unsafe override.`;
      setOnnxStatus((s) => ({ ...s, loading: false, error: msg }));
      return;
    }

    const runId = ++onnxSegRunIdRef.current;
    setOnnxSegRunning(true);

    const started = performance.now();
    setOnnxStatus((s) => ({ ...s, loading: true, message: 'Running ONNX segmentation…', error: undefined }));

    void (async () => {
      try {
        const { session, mode } = await ensureOnnxSession();
        if (onnxSegRunIdRef.current !== runId) return;

        setOnnxStatus((s) => ({
          ...s,
          sessionReady: true,
          loading: true,
          message:
            mode === 'wasm' ? 'Running ONNX segmentation… (WASM)' : 'Running ONNX segmentation… (WebGPU preferred)',
        }));

        const res = await runTumorSegmentationOnnx({ session, volume: volume.data, dims: volume.dims });
        if (onnxSegRunIdRef.current !== runId) return;

        setGeneratedLabels({ data: res.labels, dims: volume.dims, meta: BRATS_BASE_LABEL_META });

        const ms = Math.round(performance.now() - started);
        setOnnxStatus((s) => ({
          ...s,
          loading: false,
          sessionReady: true,
          message: `Segmentation complete (${ms}ms)`,
        }));
      } catch (e) {
        if (onnxSegRunIdRef.current !== runId) return;
        const msg = e instanceof Error ? e.message : String(e);
        const hasSession = onnxSessionRef.current !== null;
        setOnnxStatus((s) => ({ ...s, loading: false, sessionReady: hasSession, error: msg }));
      } finally {
        if (onnxSegRunIdRef.current === runId) {
          setOnnxSegRunning(false);
        }
      }
    })();
  }, [allowUnsafeOnnxFullRes, ensureOnnxSession, onnxPreflight, volume]);

  const cancelOnnxSegmentation = useCallback(() => {
    if (!onnxSegRunning) return;
    onnxSegRunIdRef.current++;
    setOnnxSegRunning(false);
    setOnnxStatus((s) => ({ ...s, loading: false, message: 'Segmentation cancelled', error: undefined }));
  }, [onnxSegRunning]);

  // Draw the inspector slice to a 2D canvas.
  useEffect(() => {
    const canvas = sliceCanvasRef.current;
    if (!canvas) return;
    if (!volume) return;

    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const [nx, ny, nz] = volume.dims;
    const data = volume.data;

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
          src[outBase + x] = data[inBase + x] ?? 0;
        }
      }
    } else if (inspectPlane === 'coronal') {
      const y = idx;
      for (let z = 0; z < nz; z++) {
        const inBase = z * strideZ + y * strideY;
        const outBase = z * nx;
        for (let x = 0; x < nx; x++) {
          src[outBase + x] = data[inBase + x] ?? 0;
        }
      }
    } else {
      // sagittal
      const x = idx;
      for (let z = 0; z < nz; z++) {
        const zBase = z * strideZ;
        const outBase = z * ny;
        for (let y = 0; y < ny; y++) {
          src[outBase + y] = data[zBase + y * strideY + x] ?? 0;
        }
      }
    }

    // Downsample for interactive rendering (avoid huge canvases).
    const MAX_SIZE = 256;
    const maxDim = Math.max(srcRows, srcCols);
    const scale = maxDim > MAX_SIZE ? MAX_SIZE / maxDim : 1;
    const dsRows = Math.max(1, Math.round(srcRows * scale));
    const dsCols = Math.max(1, Math.round(srcCols * scale));

    const down = resample2dAreaAverage(src, srcRows, srcCols, dsRows, dsCols);

    if (canvas.width !== dsCols) canvas.width = dsCols;
    if (canvas.height !== dsRows) canvas.height = dsRows;

    const img = ctx.createImageData(dsCols, dsRows);
    const out = img.data;

    const overlayAlpha = hasLabels && labelsEnabled ? clamp(labelMix, 0, 1) : 0;
    const palette = hasLabels && labelsEnabled && labels ? buildRgbaPalette256(labels.meta) : null;

    for (let i = 0; i < down.length; i++) {
      const v = down[i] ?? 0;
      const b0 = Math.round(clamp(v, 0, 1) * 255);

      let r = b0;
      let g = b0;
      let b = b0;

      if (palette && overlayAlpha > 0 && labels) {
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

        const labelId = labels.data[vz * strideZ + vy * strideY + vx] ?? 0;
        if (labelId !== 0) {
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

    const drawRoiBounds = (bounds: { min: Vec3i; max: Vec3i }, opts: { stroke: string; fill?: string; dashed?: boolean }) => {
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
    inspectIndex,
    inspectPlane,
    inspectorInfo.maxIndex,
    inspectorInfo.srcCols,
    inspectorInfo.srcRows,
    labelMix,
    labels,
    labelsEnabled,
    seedVoxel,
    volume,
  ]);

  useEffect(() => {
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

    const gl = canvas.getContext('webgl2', {
      antialias: true,
      alpha: false,
      depth: false,
      stencil: false,
      preserveDrawingBuffer: false,
    });

    if (!gl) {
      setInitError('WebGL2 is not available in this browser/environment.');
      return;
    }

    // Prefer float textures for fidelity; fall back to 8-bit if unavailable.
    const { primary, fallback } = chooseVolumeTextureFormat(gl);

    const vsSrc = `#version 300 es
in vec2 a_pos;
out vec2 v_uv;
void main() {
  v_uv = a_pos * 0.5 + 0.5;
  gl_Position = vec4(a_pos, 0.0, 1.0);
}`;

    const fsSrc = `#version 300 es
precision highp float;
precision highp sampler3D;
precision highp usampler3D;
precision highp sampler2D;

in vec2 v_uv;
out vec4 outColor;

uniform sampler3D u_vol;
uniform usampler3D u_labels;
uniform sampler2D u_palette;
uniform int u_labelsEnabled;
uniform float u_labelMix;

uniform mat3 u_rot;
uniform vec3 u_box;
uniform float u_aspect;
uniform float u_zoom;
uniform float u_thr;
uniform int u_steps;
uniform float u_gamma;
uniform float u_opacity;
uniform vec3 u_texel;

const float CAM_Z = ${SVR3D_CAMERA_Z};
const float FOCAL_Z = ${SVR3D_FOCAL_Z};

float saturate(float x) {
  return clamp(x, 0.0, 1.0);
}

float radial01(vec3 pos) {
  // pos is in object space centered at the volume centroid.
  // Normalize by the half box extents so that r=1 is approximately the box surface (clamped).
  vec3 halfBox = 0.5 * u_box;
  vec3 q = pos / max(halfBox, vec3(1e-6));
  return saturate(length(q));
}

bool intersectBox(vec3 ro, vec3 rd, vec3 bmin, vec3 bmax, out float t0, out float t1) {
  vec3 invD = 1.0 / rd;
  vec3 tbot = (bmin - ro) * invD;
  vec3 ttop = (bmax - ro) * invD;
  vec3 tmin = min(ttop, tbot);
  vec3 tmax = max(ttop, tbot);
  t0 = max(max(tmin.x, tmin.y), tmin.z);
  t1 = min(min(tmax.x, tmax.y), tmax.z);
  return t1 >= max(t0, 0.0);
}

void main() {
  // NDC in [-1, 1]
  vec2 p = v_uv * 2.0 - 1.0;
  p.x *= u_aspect;
  p /= max(1e-3, u_zoom);

  // World/view ray
  vec3 roW = vec3(0.0, 0.0, CAM_Z);
  vec3 rdW = normalize(vec3(p, -FOCAL_Z));

  // Rotate ray into volume/object space (volume is rotated by u_rot).
  mat3 invR = transpose(u_rot);
  vec3 ro = invR * roW;
  vec3 rd = invR * rdW;

  vec3 bmin = -0.5 * u_box;
  vec3 bmax =  0.5 * u_box;

  float t0;
  float t1;
  if (!intersectBox(ro, rd, bmin, bmax, t0, t1)) {
    outColor = vec4(0.0, 0.0, 0.0, 1.0);
    return;
  }

  // Raymarch (front-to-back compositing)
  const int MAX_STEPS = 256;
  int n = clamp(u_steps, 8, MAX_STEPS);
  float dt = (t1 - t0) / float(n);

  // Radial prior + gradient-based shading.
  //
  // Prior: the center of the box is more likely to contain the structure of interest.
  // We use that to:
  // - keep the intensity threshold low near the center and higher near the edges
  // - boost edge shading near the center
  //
  // NOTE: Use *linear* radial ramps for predictability.
  const float EDGE_K = 14.0;
  const float CENTER_EDGE_GAIN = 2.5;

  vec3 accum = vec3(0.0);
  float aAccum = 0.0;

  float t = max(t0, 0.0);

  // View direction in object space (toward the camera).
  vec3 vDir = normalize(-rd);

  for (int i = 0; i < MAX_STEPS; i++) {
    if (i >= n) break;
    vec3 pos = ro + rd * (t + float(i) * dt);

    // Map object-space box to texture coords [0,1]
    vec3 tc = pos / u_box + 0.5;

    float r = radial01(pos);

    // thrW ramps 0 at center -> 1 at edge.
    float thrW = r;
    // centerW ramps 1 at center -> 0 at edge.
    float centerW = 1.0 - r;

    float thr = saturate(u_thr * thrW);

    float v = saturate(texture(u_vol, tc).r);

    if (v >= thr) {
      float val = saturate((v - thr) / max(1e-6, 1.0 - thr));

      // Gradient in object/texture space (central differences).
      vec3 d = u_texel;
      float vx1 = saturate(texture(u_vol, clamp(tc + vec3(d.x, 0.0, 0.0), 0.0, 1.0)).r);
      float vx0 = saturate(texture(u_vol, clamp(tc - vec3(d.x, 0.0, 0.0), 0.0, 1.0)).r);
      float vy1 = saturate(texture(u_vol, clamp(tc + vec3(0.0, d.y, 0.0), 0.0, 1.0)).r);
      float vy0 = saturate(texture(u_vol, clamp(tc - vec3(0.0, d.y, 0.0), 0.0, 1.0)).r);
      float vz1 = saturate(texture(u_vol, clamp(tc + vec3(0.0, 0.0, d.z), 0.0, 1.0)).r);
      float vz0 = saturate(texture(u_vol, clamp(tc - vec3(0.0, 0.0, d.z), 0.0, 1.0)).r);

      vec3 grad = vec3(vx1 - vx0, vy1 - vy0, vz1 - vz0);
      float gmag = length(grad);

      // Edge factor (boosted near the center).
      //
      // IMPORTANT: use an exponential mapping so the "Edge strength" slider stays responsive
      // instead of quickly saturating to 1.0 for most edges.
      float centerGain = mix(1.0, CENTER_EDGE_GAIN, saturate(centerW));
      float edgeRaw = gmag * EDGE_K * centerGain;
      float edge = 1.0 - exp(-edgeRaw * u_gamma);
      edge = saturate(edge);
      edge = edge * edge;

      // Simple shading using the gradient as a normal (view-aligned light).
      vec3 nrm = normalize(grad + vec3(1e-6));
      float diff = abs(dot(nrm, vDir));
      float shade = 0.25 + 0.75 * diff;

      // Make edges matter for visibility (opacity) and for perceived contrast (brightness).
      float a = saturate(val * (0.15 + 0.85 * edge));

      // Convert to per-step opacity; dt keeps opacity roughly stable as step count changes.
      float aStep = 1.0 - exp(-u_opacity * a * dt * 4.0);
      aStep = saturate(aStep);

      float sampleV = v * shade * (0.6 + 0.4 * edge);

      vec3 sampleColor = vec3(sampleV);

      if (u_labelsEnabled != 0) {
        uint lid = texture(u_labels, tc).r;
        if (lid != 0u) {
          vec3 labelRgb = texelFetch(u_palette, ivec2(int(lid), 0), 0).rgb;
          float mixK = clamp(u_labelMix, 0.0, 1.0);
          sampleColor = mix(sampleColor, labelRgb, mixK);
        }
      }

      accum += (1.0 - aAccum) * sampleColor * aStep;
      aAccum += (1.0 - aAccum) * aStep;

      if (aAccum > 0.98) {
        break;
      }
    }
  }

  outColor = vec4(clamp(accum, 0.0, 1.0), 1.0);
}`;

    let program: WebGLProgram | null = null;
    let vao: WebGLVertexArrayObject | null = null;
    let vbo: WebGLBuffer | null = null;
    let texVol: WebGLTexture | null = null;
    let texLabels: WebGLTexture | null = null;
    let texPalette: WebGLTexture | null = null;
    let raf = 0;

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
      let uploadedData: ArrayBufferView;

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
        uploadedData = renderTex.data;
        tryUpload(fallback, uploadedData);
      } else {
        fmt = primary;
        uploadedData = renderTex.data;

        try {
          const ok = tryUpload(primary, uploadedData);
          if (!ok) {
            // Fall back to 8-bit normalized.
            const u8 = toUint8Volume(renderTex.data as Float32Array);
            fmt = fallback;
            uploadedData = u8;
            tryUpload(fallback, uploadedData);
          }
        } catch {
          const u8 = toUint8Volume(renderTex.data as Float32Array);
          fmt = fallback;
          uploadedData = u8;
          tryUpload(fallback, uploadedData);
        }
      }

      console.info('[svr3d] Volume texture format', {
        kind: fmt.kind,
        texDims,
        sourceDims: { nx: volume.dims[0], ny: volume.dims[1], nz: volume.dims[2] },
      });

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
        labels: gl.getUniformLocation(program, 'u_labels'),
        palette: gl.getUniformLocation(program, 'u_palette'),
        labelsEnabled: gl.getUniformLocation(program, 'u_labelsEnabled'),
        labelMix: gl.getUniformLocation(program, 'u_labelMix'),

        rot: gl.getUniformLocation(program, 'u_rot'),
        box: gl.getUniformLocation(program, 'u_box'),
        aspect: gl.getUniformLocation(program, 'u_aspect'),
        zoom: gl.getUniformLocation(program, 'u_zoom'),
        thr: gl.getUniformLocation(program, 'u_thr'),
        steps: gl.getUniformLocation(program, 'u_steps'),
        gamma: gl.getUniformLocation(program, 'u_gamma'),
        opacity: gl.getUniformLocation(program, 'u_opacity'),
        texel: gl.getUniformLocation(program, 'u_texel'),
      } as const;

      const rotMat = new Float32Array(9);

      const axesCanvas = axesCanvasRef.current;
      const axesCtx = axesCanvas ? axesCanvas.getContext('2d') : null;

      const resizeAndViewport = () => {
        const dpr = window.devicePixelRatio || 1;
        const w = Math.max(1, Math.floor(canvas.clientWidth * dpr));
        const h = Math.max(1, Math.floor(canvas.clientHeight * dpr));
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
        resizeAndViewport();

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

        const labelsOn = labelsEnabled && hasLabels ? 1 : 0;
        gl.uniform1i(u.labelsEnabled, labelsOn);
        gl.uniform1f(u.labelMix, clamp(labelMix, 0, 1));

        // Uniforms
        mat3FromQuat(rotationRef.current, rotMat);
        gl.uniformMatrix3fv(u.rot, false, rotMat);
        gl.uniform3f(u.box, boxScale[0], boxScale[1], boxScale[2]);
        gl.uniform1f(u.aspect, canvas.width / Math.max(1, canvas.height));
        gl.uniform1f(u.zoom, zoom);
        // Threshold is the *edge* threshold (center is always ~0); shader applies a linear center→edge ramp.
        gl.uniform1f(u.thr, clamp(threshold, 0, THRESHOLD_EDGE_MAX));
        gl.uniform1i(u.steps, Math.round(clamp(steps, 8, 256)));
        gl.uniform1f(u.gamma, clamp(gamma, 0.1, 10));
        gl.uniform1f(u.opacity, clamp(opacity, 0.1, 20));
        gl.uniform3f(u.texel, 1 / Math.max(1, texDims.nx), 1 / Math.max(1, texDims.ny), 1 / Math.max(1, texDims.nz));

        gl.drawArrays(gl.TRIANGLES, 0, 3);

        // Overlay reference axes with mm tick marks for gauging physical size.
        if (axesCanvas && axesCtx) {
          drawAxesOverlay({ axesCanvas, axesCtx, canvas, volume, boxScale, rotMat, zoom });
        }

        // One-shot capture for the harness export: read pixels from the current frame.
        const pending = pendingCapture3dRef.current;
        if (pending) {
          pendingCapture3dRef.current = null;

          try {
            const w = canvas.width;
            const h = canvas.height;

            const rgba = new Uint8Array(w * h * 4);
            gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, rgba);

            // Flip Y (WebGL origin is bottom-left; ImageData expects top-left).
            const flipped = new Uint8ClampedArray(rgba.length);
            const rowBytes = w * 4;
            for (let y = 0; y < h; y++) {
              const srcStart = (h - 1 - y) * rowBytes;
              const dstStart = y * rowBytes;
              flipped.set(rgba.subarray(srcStart, srcStart + rowBytes), dstStart);
            }

            void rgbaToPngBlob({ rgba: flipped, width: w, height: h })
              .then((b) => pending.resolve(b))
              .catch(() => pending.resolve(null));
          } catch (e) {
            console.warn('[svr3d] Failed to capture screenshot', e);
            pending.resolve(null);
          }
        }

        // Reset bindings (avoid leaking WebGL state across frames).
        gl.activeTexture(gl.TEXTURE2);
        gl.bindTexture(gl.TEXTURE_2D, null);
        gl.activeTexture(gl.TEXTURE1);
        gl.bindTexture(gl.TEXTURE_3D, null);
        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_3D, null);

        gl.bindVertexArray(null);

        raf = window.requestAnimationFrame(draw);
      };

      raf = window.requestAnimationFrame(draw);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error('[SVR3D] Failed to initialize:', e);
      setInitError(msg);
    }

    return () => {
      if (pendingCapture3dRef.current) {
        pendingCapture3dRef.current.resolve(null);
        pendingCapture3dRef.current = null;
      }

      if (raf) window.cancelAnimationFrame(raf);

      glLabelStateRef.current = null;

      if (gl) {
        if (texVol) gl.deleteTexture(texVol);
        if (texLabels) gl.deleteTexture(texLabels);
        if (texPalette) gl.deleteTexture(texPalette);
        if (vbo) gl.deleteBuffer(vbo);
        if (vao) gl.deleteVertexArray(vao);
        if (program) gl.deleteProgram(program);
      }
    };
  }, [boxScale, renderBuild.key, renderBuild.status, renderBuild.data, volume]);

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

    const dataForUpload =
      srcDims.nx === dstDims.nx && srcDims.ny === dstDims.ny && srcDims.nz === dstDims.nz
        ? labels.data
        : downsampleLabelsNearest({ src: labels.data, srcDims, dstDims });

    try {
      // Label IDs (uint8)
      gl.activeTexture(gl.TEXTURE1);
      gl.bindTexture(gl.TEXTURE_3D, texLabels);
      gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);

      if (
        st.labelsTexDims.nx !== dstDims.nx ||
        st.labelsTexDims.ny !== dstDims.ny ||
        st.labelsTexDims.nz !== dstDims.nz
      ) {
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

      gl.bindTexture(gl.TEXTURE_3D, null);

      // Palette lookup table
      const rgba = buildRgbaPalette256(labels.meta);
      gl.activeTexture(gl.TEXTURE2);
      gl.bindTexture(gl.TEXTURE_2D, texPalette);
      gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
      gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, 256, 1, gl.RGBA, gl.UNSIGNED_BYTE, rgba);
      gl.bindTexture(gl.TEXTURE_2D, null);
    } catch (e) {
      console.warn('[svr3d] Failed to upload label textures', e);
    } finally {
      gl.activeTexture(gl.TEXTURE0);
    }
  }, [glEpoch, hasLabels, labels, labelsEnabled, volume]);

  const sliceInspectorCard = (
    <div className="border border-[var(--border-color)] rounded-lg overflow-hidden bg-[var(--bg-secondary)]">
      <div className="px-3 py-2 text-xs font-medium bg-[var(--bg-tertiary)] text-[var(--text-secondary)]">Slice Inspector</div>
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
            <div className="mt-1 text-[10px] text-[var(--text-tertiary)] tabular-nums">
              {Math.round(clamp(inspectIndex, 0, inspectorInfo.maxIndex))}/{inspectorInfo.maxIndex}
            </div>
          </label>
        </div>

        <div className="text-[10px] text-[var(--text-tertiary)]">
          Drag to draw ROI box (required) · Intensities are shown with a fixed 0 to 1 mapping.
        </div>

        <div className="border border-[var(--border-color)] rounded overflow-hidden bg-black">
            <canvas
            ref={sliceCanvasRef}
            className="w-full h-auto"
            style={{
              imageRendering: 'pixelated',
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
          <div className="text-[10px] text-[var(--text-tertiary)] tabular-nums">
            Volume dims: {volDims.nx}×{volDims.ny}×{volDims.nz}
          </div>
        ) : null}
      </div>
    </div>
  );

  const wantsSliceInspectorPortal = sliceInspectorPortalTarget !== undefined;
  const sliceInspectorPortal = sliceInspectorPortalTarget ? createPortal(sliceInspectorCard, sliceInspectorPortalTarget) : null;

  return (
    <div
      className={`h-full min-h-0 overflow-hidden grid grid-rows-1 gap-3 ${
        controlsCollapsed ? 'grid-cols-1' : 'grid-cols-[minmax(0,1fr)_minmax(320px,420px)]'
      }`}
    >
      {sliceInspectorPortal}

      <div className="min-h-0">
        <div className="border border-[var(--border-color)] rounded-lg overflow-hidden bg-black h-full min-h-0">
          <div className="relative w-full h-full min-h-0">
            <button
              type="button"
              onClick={() => setControlsCollapsed((v) => !v)}
              className="absolute right-2 top-2 z-20 p-1 rounded-full bg-black/50 border border-white/10 text-white/80 hover:bg-black/70"
              title={controlsCollapsed ? 'Show panels' : 'Hide panels'}
            >
              {controlsCollapsed ? <ChevronLeft className="w-4 h-4" /> : <ChevronRight className="w-4 h-4" />}
            </button>

            <canvas
              ref={canvasRef}
              className="absolute inset-0 w-full h-full"
              onPointerDown={onPointerDown}
              onPointerMove={onPointerMove}
              onPointerUp={onPointerUp}
              onPointerCancel={onPointerUp}
            />

            <canvas ref={axesCanvasRef} className="absolute inset-0 w-full h-full pointer-events-none" />

            {!volume ? (
              <div className="absolute inset-0 flex items-center justify-center text-xs text-white/70 bg-black/40 p-4 text-center">
                Run SVR to generate a volume for 3D viewing.
              </div>
            ) : renderBuild.status === 'error' ? (
              <div className="absolute inset-0 flex items-center justify-center text-xs text-red-300 bg-black/60 p-4 text-center">
                {renderBuild.error ?? 'Failed to prepare 3D render volume.'}
              </div>
            ) : renderBuild.status !== 'ready' ? (
              <div className="absolute inset-0 flex items-center justify-center text-xs text-white/80 bg-black/60 p-4 text-center">
                <div className="space-y-2">
                  <div>Preparing 3D render…</div>
                  {renderPlan ? (
                    <div className="text-[10px] text-white/60 tabular-nums">
                      {renderPlan.dims.nx}×{renderPlan.dims.ny}×{renderPlan.dims.nz} ·{' '}
                      {renderPlan.kind === 'f32' ? 'float' : 'u8'} · {renderPlan.note}
                    </div>
                  ) : null}
                </div>
              </div>
            ) : initError ? (
              <div className="absolute inset-0 flex items-center justify-center text-xs text-red-300 bg-black/60 p-4 text-center">
                {initError}
              </div>
            ) : (
              <div className="absolute left-2 bottom-2 text-[10px] text-white/70 bg-black/50 px-2 py-1 rounded">
                Drag to rotate · Wheel to zoom
              </div>
            )}
          </div>
        </div>
      </div>

      {controlsCollapsed ? null : (
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
              <div className="mt-1 text-[10px] text-[var(--text-tertiary)] tabular-nums">{opacity.toFixed(1)}</div>
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
              <div className="mt-1 text-[10px] text-[var(--text-tertiary)] tabular-nums">{gamma.toFixed(2)}</div>
            </label>

            <label className="col-span-2 block text-xs text-[var(--text-secondary)]">
              Threshold (radial)
              <input
                type="range"
                min={0}
                max={THRESHOLD_EDGE_MAX}
                step={0.001}
                value={threshold}
                onChange={(e) => setThreshold(Number(e.target.value))}
                className="mt-1 w-full"
                disabled={!volume}
              />
              <div className="mt-1 text-[10px] text-[var(--text-tertiary)] tabular-nums">
                Center 0.000 · Edge {threshold.toFixed(3)}
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

          <div className="text-[10px] text-[var(--text-tertiary)]">
            Composite rendering with edge shading: tune opacity/threshold, and increase edge strength to make boundaries
            pop (stronger near the box center).
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
                    <div className="mt-1 text-[10px] text-[var(--text-tertiary)] tabular-nums">×{growRoiOutsideScale.toFixed(2)}</div>
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
                    className="px-2 py-1 text-[10px] rounded border border-[var(--border-color)] bg-[var(--bg-secondary)] text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-tertiary)] disabled:opacity-50"
                  >
                    Clear ROI
                  </button>
                </div>

                <div className="flex items-center gap-2 text-[10px] text-[var(--text-tertiary)]">
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
                    <div className="mt-1 text-[10px] text-[var(--text-tertiary)] tabular-nums">±{growTolerance.toFixed(3)}</div>
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
                  <div className="text-[10px] text-red-300 bg-red-400/10 px-2 py-1 rounded">{growStatus.error}</div>
                ) : growStatus.message ? (
                  <div className="text-[10px] text-[var(--text-tertiary)]">{growStatus.message}</div>
                ) : null}

                <div className="pt-2 mt-2 border-t border-[var(--border-color)] space-y-2">
                  <div className="text-xs font-medium text-[var(--text-secondary)]">ONNX tumor model</div>

                  <input
                    ref={onnxFileInputRef}
                    type="file"
                    accept={'.onnx'}
                    className="hidden"
                    onChange={(e) => {
                      const f = e.target.files?.[0];
                      if (f) {
                        onnxHandleSelectedFile(f);
                      }
                      // Allow re-uploading the same file.
                      e.target.value = '';
                    }}
                  />

                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      onClick={onnxUploadClick}
                      disabled={onnxStatus.loading}
                      className="px-3 py-2 text-xs rounded-lg border border-[var(--border-color)] bg-[var(--bg-secondary)] text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-tertiary)] disabled:opacity-50"
                    >
                      Upload
                    </button>

                    <button
                      type="button"
                      onClick={initOnnxSession}
                      disabled={!onnxStatus.cached || onnxStatus.loading}
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
                        onnxStatus.loading ||
                        !!(onnxPreflight?.blockedByDefault && !allowUnsafeOnnxFullRes)
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


                  {onnxPreflight?.blockedByDefault ? (
                    <div className="space-y-2">
                      <div className="text-[10px] text-yellow-200 bg-yellow-400/10 px-2 py-1 rounded">
                        Full-res ONNX is disabled by default for this volume ({onnxPreflight.nx}×{onnxPreflight.ny}×
                        {onnxPreflight.nz}; est logits {formatMiB(onnxPreflight.logitsBytes)}). This may crash the tab.
                      </div>

                      <label className="flex items-center gap-2 text-xs text-[var(--text-secondary)]">
                        <input
                          type="checkbox"
                          checked={allowUnsafeOnnxFullRes}
                          onChange={(e) => setAllowUnsafeOnnxFullRes(e.target.checked)}
                        />
                        <span>Allow unsafe full-res ONNX</span>
                      </label>
                    </div>
                  ) : null}

                  {onnxStatus.error ? (
                    <div className="text-[10px] text-red-300 bg-red-400/10 px-2 py-1 rounded">{onnxStatus.error}</div>
                  ) : onnxStatus.message ? (
                    <div className="text-[10px] text-[var(--text-tertiary)]">{onnxStatus.message}</div>
                  ) : null}
                </div>

                {!hasLabels || !labels ? (
                  <div className="text-[10px] text-[var(--text-tertiary)]">No segmentation labels available yet.</div>
                ) : (
                  <div className="space-y-1">
                    {labels.meta
                      .filter((m) => m.id !== 0)
                      .map((m) => {
                        const count = labelMetrics?.counts.get(m.id) ?? 0;
                        const ml = labelMetrics ? (count * labelMetrics.voxelVolMm3) / 1000 : 0;

                        return (
                          <div
                            key={m.id}
                            className="flex items-center gap-2 text-[10px] text-[var(--text-secondary)]"
                            title={`${m.name} (id ${m.id})`}
                          >
                            <span
                              className="inline-block w-2.5 h-2.5 rounded-sm border border-black/30"
                              style={{ backgroundColor: rgbCss(m.color) }}
                            />
                            <span className="truncate">{m.name}</span>
                            <span className="ml-auto tabular-nums text-[var(--text-tertiary)]">
                              {count.toLocaleString()} vox · {ml.toFixed(2)} mL
                            </span>
                          </div>
                        );
                      })}

                    {labelMetrics ? (
                      <div className="pt-1 text-[10px] text-[var(--text-tertiary)] tabular-nums">
                        Total labeled: {labelMetrics.totalCount.toLocaleString()} vox · {labelMetrics.totalMl.toFixed(2)} mL
                      </div>
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
});
