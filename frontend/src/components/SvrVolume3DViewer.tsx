import { forwardRef, useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState } from 'react';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import type { SvrLabelVolume, SvrVolume } from '../types/svr';
import { BRATS_BASE_LABEL_META, BRATS_LABEL_ID, type BratsBaseLabelId } from '../utils/segmentation/brats';
import { buildRgbaPalette256, rgbCss } from '../utils/segmentation/labelPalette';
import { computeSeedRange01, regionGrow3D, type Vec3i } from '../utils/segmentation/regionGrow3D';
import { resample2dAreaAverage } from '../utils/svr/resample2d';

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


function toUint8Volume(data: Float32Array): Uint8Array {
  const out = new Uint8Array(data.length);
  for (let i = 0; i < data.length; i++) {
    const v = data[i] ?? 0;
    const b = Math.round(clamp(v, 0, 1) * 255);
    out[i] = b;
  }
  return out;
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

export type SvrVolume3DViewerProps = {
  volume: SvrVolume | null;
  labels?: SvrLabelVolume | null;
};

export type SvrVolume3DViewerHandle = {
  /** Capture the current 3D canvas frame as a PNG (best-effort). */
  capture3dPng: () => Promise<Blob | null>;
  /** Reset view + controls to a stable preset for reproducible harness captures. */
  applyHarnessPreset: () => void;
};

export const SvrVolume3DViewer = forwardRef<SvrVolume3DViewerHandle, SvrVolume3DViewerProps>(function SvrVolume3DViewer(
  { volume, labels: labelsOverride },
  ref
) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const axesCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const pendingCapture3dRef = useRef<{ resolve: (b: Blob | null) => void } | null>(null);

  const glLabelStateRef = useRef<
    | {
        gl: WebGL2RenderingContext;
        texLabels: WebGLTexture;
        texPalette: WebGLTexture;
        dims: { nx: number; ny: number; nz: number };
      }
    | null
  >(null);

  const [initError, setInitError] = useState<string | null>(null);

  // Optional externally-provided labels (e.g. from an ML pipeline) can override internal generation.
  const [generatedLabels, setGeneratedLabels] = useState<SvrLabelVolume | null>(null);
  const labels = labelsOverride ?? generatedLabels;

  // Viewer controls (composite-only)
  const [controlsCollapsed, setControlsCollapsed] = useState(false);
  const [threshold, setThreshold] = useState(0.05);
  const [steps, setSteps] = useState(160);
  const [gamma, setGamma] = useState(1.0);
  const [opacity, setOpacity] = useState(4.0);
  const [zoom, setZoom] = useState(1.0);

  // Optional segmentation overlay (label volume).
  const [labelsEnabled, setLabelsEnabled] = useState(true);
  const [labelMix, setLabelMix] = useState(0.65);

  // Baseline interactive segmentation (Phase 2): seeded 3D region-growing.
  const [seedVoxel, setSeedVoxel] = useState<Vec3i | null>(null);
  const [growTargetLabel, setGrowTargetLabel] = useState<BratsBaseLabelId>(BRATS_LABEL_ID.ENHANCING);
  const [growTolerance, setGrowTolerance] = useState(0.12);
  const [growStatus, setGrowStatus] = useState<{ running: boolean; message?: string; error?: string }>(() => ({
    running: false,
  }));
  const growAbortRef = useRef<AbortController | null>(null);

  // When the underlying volume changes, drop any internally-generated labels and seed.
  useEffect(() => {
    setGeneratedLabels(null);
    setSeedVoxel(null);
    setGrowStatus({ running: false });
    growAbortRef.current?.abort();
    growAbortRef.current = null;
  }, [volume]);

  const hasLabels = useMemo(() => {
    if (!volume) return false;
    if (!labels) return false;

    const [nx, ny, nz] = volume.dims;
    const [lx, ly, lz] = labels.dims;
    if (nx !== lx || ny !== ly || nz !== lz) return false;

    return labels.data.length === nx * ny * nz;
  }, [labels, volume]);

  // Slice inspector (orthogonal slices).
  const sliceCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const [inspectPlane, setInspectPlane] = useState<'axial' | 'coronal' | 'sagittal'>('axial');
  const [inspectIndex, setInspectIndex] = useState(0);

  const paramsRef = useRef({ threshold, steps, gamma, opacity, zoom, labelsEnabled, labelMix, hasLabels });
  useEffect(() => {
    paramsRef.current = { threshold, steps, gamma, opacity, zoom, labelsEnabled, labelMix, hasLabels };
  }, [gamma, hasLabels, labelMix, labelsEnabled, opacity, steps, threshold, zoom]);

  const rotationRef = useRef<Quat>([0, 0, 0, 1]);

  const { boxScale, dims } = useMemo(() => {
    if (!volume) {
      return {
        dims: { nx: 1, ny: 1, nz: 1 },
        boxScale: [1, 1, 1] as const,
      };
    }

    const [nx, ny, nz] = volume.dims;
    const maxDim = Math.max(1, nx, ny, nz);
    return {
      dims: { nx, ny, nz },
      boxScale: [nx / maxDim, ny / maxDim, nz / maxDim] as const,
    };
  }, [volume]);

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
        setSteps(160);
        setGamma(1.0);
        setOpacity(4.0);
        setControlsCollapsed(false);
        resetView();
      },
    }),
    [resetView, volume]
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

  const onSliceInspectorPointerDown = useCallback(
    (e: React.PointerEvent<HTMLCanvasElement>) => {
      if (!volume) return;

      const rect = e.currentTarget.getBoundingClientRect();
      const nx = Math.max(1, rect.width);
      const ny = Math.max(1, rect.height);

      const u = (e.clientX - rect.left) / nx;
      const v = (e.clientY - rect.top) / ny;

      const srcCols = inspectorInfo.srcCols;
      const srcRows = inspectorInfo.srcRows;
      const sliceIdx = Math.round(clamp(inspectIndex, 0, inspectorInfo.maxIndex));

      const sx = Math.round(clamp(u, 0, 1) * Math.max(0, srcCols - 1));
      const sy = Math.round(clamp(v, 0, 1) * Math.max(0, srcRows - 1));

      let seed: Vec3i;
      if (inspectPlane === 'axial') {
        seed = { x: sx, y: sy, z: sliceIdx };
      } else if (inspectPlane === 'coronal') {
        seed = { x: sx, y: sliceIdx, z: sy };
      } else {
        // sagittal
        seed = { x: sliceIdx, y: sx, z: sy };
      }

      setSeedVoxel(seed);

      e.preventDefault();
      e.stopPropagation();
    },
    [inspectIndex, inspectPlane, inspectorInfo.maxIndex, inspectorInfo.srcCols, inspectorInfo.srcRows, volume]
  );

  const cancelSeedGrow = useCallback(() => {
    growAbortRef.current?.abort();
    growAbortRef.current = null;
    setGrowStatus({ running: false, message: 'Cancelled' });
  }, []);

  const runSeedGrow = useCallback(() => {
    if (!volume) return;

    if (!seedVoxel) {
      setGrowStatus({ running: false, error: 'Click the slice inspector to place a seed first.' });
      return;
    }

    growAbortRef.current?.abort();

    const controller = new AbortController();
    growAbortRef.current = controller;

    setGrowStatus({ running: true, message: 'Growing…' });

    const [nx, ny] = volume.dims;
    const strideZ = nx * ny;
    const seedIdx = seedVoxel.z * strideZ + seedVoxel.y * nx + seedVoxel.x;
    const seedValue = volume.data[seedIdx] ?? 0;

    const { min, max } = computeSeedRange01({ seedValue, tolerance: growTolerance });
    const maxVoxels = Math.min(volume.data.length, 2_000_000);

    void regionGrow3D({
      volume: volume.data,
      dims: volume.dims,
      seed: seedVoxel,
      min,
      max,
      opts: {
        signal: controller.signal,
        maxVoxels,
        connectivity: 6,
        yieldEvery: 160_000,
        onProgress: (p) => {
          setGrowStatus((s) => (s.running ? { ...s, message: `Growing… ${p.queued.toLocaleString()} voxels` } : s));
        },
      },
    })
      .then((res) => {
        if (controller.signal.aborted) return;

        const next = labels ? new Uint8Array(labels.data) : new Uint8Array(volume.data.length);
        for (let i = 0; i < res.mask.length; i++) {
          if (res.mask[i]) next[i] = growTargetLabel;
        }

        setGeneratedLabels({ data: next, dims: volume.dims, meta: BRATS_BASE_LABEL_META });
        setLabelsEnabled(true);

        setGrowStatus({
          running: false,
          message: `Seed ${seedValue.toFixed(3)} → ${res.count.toLocaleString()} voxels${res.hitMaxVoxels ? ' (hit limit)' : ''}`,
        });
      })
      .catch((e) => {
        if (controller.signal.aborted) return;
        const msg = e instanceof Error ? e.message : String(e);
        setGrowStatus({ running: false, error: msg });
      })
      .finally(() => {
        if (growAbortRef.current === controller) {
          growAbortRef.current = null;
        }
      });
  }, [growTargetLabel, growTolerance, labels, seedVoxel, volume]);

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
        const seedCol =
          inspectPlane === 'axial' ? seedVoxel.x : inspectPlane === 'coronal' ? seedVoxel.x : seedVoxel.y;
        const seedRow =
          inspectPlane === 'axial' ? seedVoxel.y : inspectPlane === 'coronal' ? seedVoxel.z : seedVoxel.z;

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
  }, [hasLabels, inspectIndex, inspectPlane, inspectorInfo.maxIndex, inspectorInfo.srcCols, inspectorInfo.srcRows, labelMix, labels, labelsEnabled, seedVoxel, volume]);

  useEffect(() => {
    setInitError(null);

    const canvas = canvasRef.current;
    if (!canvas) return;

    if (!volume) {
      // No volume yet; nothing to initialize.
      return;
    }

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

      // We'll try float first; if WebGL rejects it, re-upload as R8.
      let fmt: VolumeTextureFormat = primary;
      let data: ArrayBufferView = volume.data;

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
          dims.nx,
          dims.ny,
          dims.nz,
          0,
          candidate.format,
          candidate.type,
          candidateData
        );

        const err = gl.getError();
        return err === gl.NO_ERROR;
      };

      try {
        const ok = tryUpload(primary, volume.data);
        if (!ok) {
          // Fall back to 8-bit normalized.
          const u8 = toUint8Volume(volume.data);
          fmt = fallback;
          data = u8;
          tryUpload(fallback, data);
        }
      } catch {
        const u8 = toUint8Volume(volume.data);
        fmt = fallback;
        data = u8;
        tryUpload(fallback, data);
      }

      console.info('[svr3d] Volume texture format', { kind: fmt.kind, dims });

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

      // Initialize to zeros so sampling produces "no label" deterministically.
      const zeros = new Uint8Array(dims.nx * dims.ny * dims.nz);
      gl.texImage3D(
        gl.TEXTURE_3D,
        0,
        gl.R8UI,
        dims.nx,
        dims.ny,
        dims.nz,
        0,
        gl.RED_INTEGER,
        gl.UNSIGNED_BYTE,
        zeros
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

      glLabelStateRef.current = { gl, texLabels, texPalette, dims };

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
        // Threshold is an edge "scale" (0..5). The shader maps it to a linear 0-at-center threshold.
        gl.uniform1f(u.thr, clamp(threshold, 0, 5));
        gl.uniform1i(u.steps, Math.round(clamp(steps, 8, 256)));
        gl.uniform1f(u.gamma, clamp(gamma, 0.1, 10));
        gl.uniform1f(u.opacity, clamp(opacity, 0.1, 20));
        gl.uniform3f(
          u.texel,
          1 / Math.max(1, dims.nx),
          1 / Math.max(1, dims.ny),
          1 / Math.max(1, dims.nz)
        );

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
  }, [boxScale, dims, volume]);

  // Incrementally upload label data + palette without re-initializing the whole GL program.
  useEffect(() => {
    if (!volume) return;
    if (!labels) return;

    if (!hasLabels) {
      console.warn('[svr3d] Ignoring label volume (dims mismatch)', {
        volumeDims: volume.dims,
        labelDims: labels.dims,
        labelLen: labels.data.length,
      });
      return;
    }

    const st = glLabelStateRef.current;
    if (!st) return;

    const { gl, texLabels, texPalette, dims } = st;

    try {
      // Label IDs
      gl.activeTexture(gl.TEXTURE1);
      gl.bindTexture(gl.TEXTURE_3D, texLabels);
      gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
      gl.texSubImage3D(
        gl.TEXTURE_3D,
        0,
        0,
        0,
        0,
        dims.nx,
        dims.ny,
        dims.nz,
        gl.RED_INTEGER,
        gl.UNSIGNED_BYTE,
        labels.data
      );
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
  }, [hasLabels, labels, volume]);

  return (
    <div className={`h-full grid gap-3 ${controlsCollapsed ? 'grid-cols-1' : 'grid-cols-3'}`}>
      <div className={controlsCollapsed ? 'col-span-1' : 'col-span-2'}>
        <div className="border border-[var(--border-color)] rounded-lg overflow-hidden bg-black h-full">
          <div className="relative w-full h-full">
            <button
              type="button"
              onClick={() => setControlsCollapsed((v) => !v)}
              className="absolute right-2 top-2 z-20 p-1 rounded-full bg-black/50 border border-white/10 text-white/80 hover:bg-black/70"
              title={controlsCollapsed ? 'Show 3D controls' : 'Hide 3D controls'}
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
        <div className="col-span-1 space-y-3">
          <div className="text-xs font-medium text-[var(--text-secondary)]">3D Controls</div>

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
            Threshold (radial)
            <input
              type="range"
              min={0}
              max={5}
              step={0.01}
              value={threshold}
              onChange={(e) => setThreshold(Number(e.target.value))}
              className="mt-1 w-full"
              disabled={!volume}
            />
            <div className="mt-1 text-[10px] text-[var(--text-tertiary)] tabular-nums">
              Center 0.00 · Edge scale {threshold.toFixed(2)}
            </div>
          </label>

        <label className="block text-xs text-[var(--text-secondary)]">
          Steps (ray samples)
          <input
            type="range"
            min={32}
            max={256}
            step={1}
            value={steps}
            onChange={(e) => setSteps(Number(e.target.value))}
            className="mt-1 w-full"
            disabled={!volume}
          />
          <div className="mt-1 text-[10px] text-[var(--text-tertiary)] tabular-nums">{Math.round(steps)}</div>
        </label>

        <label className="block text-xs text-[var(--text-secondary)]">
          Edge shading strength
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

        <label className="block text-xs text-[var(--text-secondary)]">
          Zoom
          <input
            type="range"
            min={0.6}
            max={10.0}
            step={0.02}
            value={zoom}
            onChange={(e) => setZoom(Number(e.target.value))}
            className="mt-1 w-full"
            disabled={!volume}
          />
          <div className="mt-1 text-[10px] text-[var(--text-tertiary)] tabular-nums">{zoom.toFixed(2)}</div>
        </label>

        <div className="border border-[var(--border-color)] rounded-lg overflow-hidden bg-[var(--bg-secondary)]">
          <div className="px-3 py-2 text-xs font-medium bg-[var(--bg-tertiary)] text-[var(--text-secondary)]">Segmentation</div>
          <div className="p-3 space-y-2">
            <label className="flex items-center gap-2 text-xs text-[var(--text-secondary)]">
              <input
                type="checkbox"
                checked={labelsEnabled}
                onChange={(e) => setLabelsEnabled(e.target.checked)}
                disabled={!volume}
              />
              <span>Show labels</span>
            </label>

            <label className="block text-xs text-[var(--text-secondary)]">
              Label mix
              <input
                type="range"
                min={0}
                max={1}
                step={0.01}
                value={labelMix}
                onChange={(e) => setLabelMix(Number(e.target.value))}
                className="mt-1 w-full"
                disabled={!hasLabels || !labelsEnabled}
              />
              <div className="mt-1 text-[10px] text-[var(--text-tertiary)] tabular-nums">{labelMix.toFixed(2)}</div>
            </label>

            <div className="flex items-center gap-2 text-[10px] text-[var(--text-tertiary)]">
              <span className="truncate">
                Seed:{' '}
                {seedVoxel ? (
                  <span className="tabular-nums">
                    {seedVoxel.x},{seedVoxel.y},{seedVoxel.z}
                  </span>
                ) : (
                  <span>Click the slice inspector to set</span>
                )}
              </span>
              <button
                type="button"
                onClick={() => setSeedVoxel(null)}
                disabled={!seedVoxel || growStatus.running}
                className="ml-auto px-2 py-1 text-[10px] rounded border border-[var(--border-color)] bg-[var(--bg-secondary)] text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-tertiary)] disabled:opacity-50"
              >
                Clear
              </button>
            </div>

            <div className="grid grid-cols-2 gap-2">
              <label className="block text-xs text-[var(--text-secondary)]">
                Target
                <select
                  value={growTargetLabel}
                  onChange={(e) => setGrowTargetLabel(Number(e.target.value) as BratsBaseLabelId)}
                  className="mt-1 w-full px-2 py-1 rounded border border-[var(--border-color)] bg-[var(--bg-secondary)]"
                  disabled={!volume || growStatus.running}
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
                  onChange={(e) => setGrowTolerance(Number(e.target.value))}
                  className="mt-1 w-full"
                  disabled={!volume || growStatus.running}
                />
                <div className="mt-1 text-[10px] text-[var(--text-tertiary)] tabular-nums">±{growTolerance.toFixed(3)}</div>
              </label>
            </div>

            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={runSeedGrow}
                disabled={!volume || !seedVoxel || growStatus.running}
                className="px-3 py-2 text-xs rounded-lg bg-white/10 hover:bg-white/20 text-white disabled:opacity-50"
              >
                Grow from seed
              </button>

              {growStatus.running ? (
                <button
                  type="button"
                  onClick={cancelSeedGrow}
                  className="px-3 py-2 text-xs rounded-lg border border-white/10 bg-black/40 text-white/80 hover:bg-black/60"
                >
                  Cancel
                </button>
              ) : null}

              <button
                type="button"
                onClick={() => {
                  setGeneratedLabels(null);
                  setGrowStatus({ running: false, message: 'Cleared segmentation' });
                }}
                disabled={!generatedLabels || growStatus.running}
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

            {!hasLabels || !labels ? (
              <div className="text-[10px] text-[var(--text-tertiary)]">No segmentation labels available yet.</div>
            ) : (
              <div className="space-y-1">
                {labels.meta
                  .filter((m) => m.id !== 0)
                  .map((m) => (
                    <div key={m.id} className="flex items-center gap-2 text-[10px] text-[var(--text-secondary)]">
                      <span
                        className="inline-block w-2.5 h-2.5 rounded-sm border border-black/30"
                        style={{ backgroundColor: rgbCss(m.color) }}
                        title={`Label ${m.id}`}
                      />
                      <span className="truncate">{m.name}</span>
                      <span className="ml-auto tabular-nums text-[var(--text-tertiary)]">{m.id}</span>
                    </div>
                  ))}
              </div>
            )}
          </div>
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
          Composite rendering with edge shading: tune opacity/threshold, and increase edge strength to make boundaries pop (stronger near the box center).
        </div>

        <div className="mt-3 border border-[var(--border-color)] rounded-lg overflow-hidden bg-[var(--bg-secondary)]">
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
              Intensities are shown with a fixed 0 to 1 mapping.
            </div>

            <div className="border border-[var(--border-color)] rounded overflow-hidden bg-black">
              <canvas
                ref={sliceCanvasRef}
                className="w-full h-auto"
                style={{ imageRendering: 'pixelated', cursor: volume ? 'crosshair' : 'default' }}
                onPointerDown={onSliceInspectorPointerDown}
              />
            </div>

            {volume ? (
              <div className="text-[10px] text-[var(--text-tertiary)] tabular-nums">
                Volume dims: {dims.nx}×{dims.ny}×{dims.nz}
              </div>
            ) : null}
          </div>
        </div>
      </div>
      )}
    </div>
  );
});
