import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { X } from 'lucide-react';
import type { SvrVolume } from '../types/svr';

function clamp(x: number, min: number, max: number): number {
  return x < min ? min : x > max ? max : x;
}

function mat3FromYawPitch(yaw: number, pitch: number): Float32Array {
  const cy = Math.cos(yaw);
  const sy = Math.sin(yaw);
  const cp = Math.cos(pitch);
  const sp = Math.sin(pitch);

  // Column-major mat3 (WebGL expects column-major when transpose=false).
  // R = Ry(yaw) * Rx(pitch)
  return new Float32Array([
    cy,
    0,
    -sy,

    sy * sp,
    cp,
    cy * sp,

    sy * cp,
    -sp,
    cy * cp,
  ]);
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

export type SvrVolume3DModalProps = {
  volume: SvrVolume;
  onClose: () => void;
};

export function SvrVolume3DModal({ volume, onClose }: SvrVolume3DModalProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  const [initError, setInitError] = useState<string | null>(null);

  // Viewer controls
  const [threshold, setThreshold] = useState(0.05);
  const [steps, setSteps] = useState(160);
  const [gamma, setGamma] = useState(1.0);
  const [zoom, setZoom] = useState(1.0);
  const [yaw, setYaw] = useState(0);
  const [pitch, setPitch] = useState(0);

  const paramsRef = useRef({ threshold, steps, gamma, zoom, yaw, pitch });
  useEffect(() => {
    paramsRef.current = { threshold, steps, gamma, zoom, yaw, pitch };
  }, [gamma, pitch, steps, threshold, yaw, zoom]);

  const { boxScale, dims } = useMemo(() => {
    const [nx, ny, nz] = volume.dims;
    const maxDim = Math.max(1, nx, ny, nz);
    return {
      dims: { nx, ny, nz },
      boxScale: [nx / maxDim, ny / maxDim, nz / maxDim] as const,
    };
  }, [volume.dims]);

  const resetView = useCallback(() => {
    setYaw(0);
    setPitch(0);
    setZoom(1.0);
  }, []);

  // Pointer drag rotation (simple yaw/pitch trackball).
  const dragRef = useRef<{ x: number; y: number; yaw: number; pitch: number } | null>(null);

  const onPointerDown = useCallback((e: React.PointerEvent) => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    dragRef.current = {
      x: e.clientX,
      y: e.clientY,
      yaw,
      pitch,
    };

    canvas.setPointerCapture(e.pointerId);
    e.preventDefault();
    e.stopPropagation();
  }, [pitch, yaw]);

  const onPointerMove = useCallback((e: React.PointerEvent) => {
    const d = dragRef.current;
    if (!d) return;

    const dx = e.clientX - d.x;
    const dy = e.clientY - d.y;

    const nextYaw = d.yaw + dx * 0.01;
    const nextPitch = clamp(d.pitch + dy * 0.01, -Math.PI / 2 + 1e-3, Math.PI / 2 - 1e-3);

    setYaw(nextYaw);
    setPitch(nextPitch);

    e.preventDefault();
    e.stopPropagation();
  }, []);

  const onPointerUp = useCallback((e: React.PointerEvent) => {
    dragRef.current = null;
    e.preventDefault();
    e.stopPropagation();
  }, []);

  useEffect(() => {
    setInitError(null);

    const canvas = canvasRef.current;
    if (!canvas) return;

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

in vec2 v_uv;
out vec4 outColor;

uniform sampler3D u_vol;
uniform mat3 u_rot;
uniform vec3 u_box;
uniform float u_aspect;
uniform float u_zoom;
uniform float u_thr;
uniform int u_steps;
uniform float u_gamma;

float saturate(float x) {
  return clamp(x, 0.0, 1.0);
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
  vec3 roW = vec3(0.0, 0.0, 1.6);
  vec3 rdW = normalize(vec3(p, -1.2));

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

  // MIP raymarch
  const int MAX_STEPS = 256;
  int n = clamp(u_steps, 8, MAX_STEPS);
  float dt = (t1 - t0) / float(n);

  float m = 0.0;
  float t = max(t0, 0.0);

  for (int i = 0; i < MAX_STEPS; i++) {
    if (i >= n) break;
    vec3 pos = ro + rd * (t + float(i) * dt);

    // Map object-space box to texture coords [0,1]
    vec3 tc = pos / u_box + 0.5;

    float v = texture(u_vol, tc).r;
    if (v >= u_thr) {
      m = max(m, v);
    }
  }

  float g = max(1e-3, u_gamma);
  float c = pow(saturate(m), 1.0 / g);
  outColor = vec4(vec3(c), 1.0);
}`;

    let program: WebGLProgram | null = null;
    let vao: WebGLVertexArrayObject | null = null;
    let vbo: WebGLBuffer | null = null;
    let tex: WebGLTexture | null = null;
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
      tex = gl.createTexture();
      if (!tex) throw new Error('Failed to allocate 3D texture');

      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_3D, tex);
      gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);

      let fmt: VolumeTextureFormat = primary;

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
          const u8 = toUint8Volume(volume.data);
          fmt = fallback;
          tryUpload(fallback, u8);
        }
      } catch {
        const u8 = toUint8Volume(volume.data);
        fmt = fallback;
        tryUpload(fallback, u8);
      }

      console.info('[svr3d] Volume texture format', { kind: fmt.kind, dims });

      gl.bindTexture(gl.TEXTURE_3D, null);

      const uVolLoc = gl.getUniformLocation(program, 'u_vol');
      const uRotLoc = gl.getUniformLocation(program, 'u_rot');
      const uBoxLoc = gl.getUniformLocation(program, 'u_box');
      const uAspectLoc = gl.getUniformLocation(program, 'u_aspect');
      const uZoomLoc = gl.getUniformLocation(program, 'u_zoom');
      const uThrLoc = gl.getUniformLocation(program, 'u_thr');
      const uStepsLoc = gl.getUniformLocation(program, 'u_steps');
      const uGammaLoc = gl.getUniformLocation(program, 'u_gamma');

      const resizeAndViewport = () => {
        const dpr = window.devicePixelRatio || 1;
        const w = Math.max(1, Math.floor(canvas.clientWidth * dpr));
        const h = Math.max(1, Math.floor(canvas.clientHeight * dpr));
        if (canvas.width !== w || canvas.height !== h) {
          canvas.width = w;
          canvas.height = h;
        }
        gl.viewport(0, 0, canvas.width, canvas.height);
      };

      const draw = () => {
        resizeAndViewport();

        const { threshold, steps, gamma, zoom, yaw, pitch } = paramsRef.current;

        gl.disable(gl.DEPTH_TEST);
        gl.disable(gl.CULL_FACE);

        gl.useProgram(program);
        gl.bindVertexArray(vao);

        // Bind texture
        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_3D, tex);
        gl.uniform1i(uVolLoc, 0);

        // Uniforms
        const rot = mat3FromYawPitch(yaw, pitch);
        gl.uniformMatrix3fv(uRotLoc, false, rot);
        gl.uniform3f(uBoxLoc, boxScale[0], boxScale[1], boxScale[2]);
        gl.uniform1f(uAspectLoc, canvas.width / Math.max(1, canvas.height));
        gl.uniform1f(uZoomLoc, zoom);
        gl.uniform1f(uThrLoc, clamp(threshold, 0, 1));
        gl.uniform1i(uStepsLoc, Math.round(clamp(steps, 8, 256)));
        gl.uniform1f(uGammaLoc, clamp(gamma, 0.25, 4));

        gl.drawArrays(gl.TRIANGLES, 0, 3);

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
      if (raf) window.cancelAnimationFrame(raf);

      if (gl) {
        if (tex) gl.deleteTexture(tex);
        if (vbo) gl.deleteBuffer(vbo);
        if (vao) gl.deleteVertexArray(vao);
        if (program) gl.deleteProgram(program);
      }
    };
    // We intentionally re-init when volume changes.
  }, [boxScale, dims, volume.data]);

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/60 backdrop-blur-sm">
      <div className="w-[960px] max-w-[96vw] bg-[var(--bg-secondary)] border border-[var(--border-color)] rounded-xl shadow-2xl overflow-hidden">
        <div className="flex items-center justify-between px-4 py-3 border-b border-[var(--border-color)]">
          <div className="min-w-0">
            <div className="text-sm font-semibold text-[var(--text-primary)]">SVR 3D Viewer</div>
            <div className="text-[10px] text-[var(--text-tertiary)] truncate">
              MIP volume render · {dims.nx}×{dims.ny}×{dims.nz}
            </div>
          </div>

          <button
            onClick={onClose}
            className="p-1 rounded-lg text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-tertiary)]"
            title="Close"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="p-4 grid grid-cols-3 gap-4">
          <div className="col-span-2">
            <div className="border border-[var(--border-color)] rounded-lg overflow-hidden bg-black">
              <div className="relative w-full" style={{ aspectRatio: '16 / 10' }}>
                <canvas
                  ref={canvasRef}
                  className="absolute inset-0 w-full h-full"
                  onPointerDown={onPointerDown}
                  onPointerMove={onPointerMove}
                  onPointerUp={onPointerUp}
                  onPointerCancel={onPointerUp}
                />

                {initError ? (
                  <div className="absolute inset-0 flex items-center justify-center text-xs text-red-300 bg-black/60 p-4 text-center">
                    {initError}
                  </div>
                ) : (
                  <div className="absolute left-2 top-2 text-[10px] text-white/70 bg-black/50 px-2 py-1 rounded">
                    Drag to rotate
                  </div>
                )}
              </div>
            </div>
          </div>

          <div className="col-span-1 space-y-3">
            <div className="text-xs font-medium text-[var(--text-secondary)]">Controls</div>

            <label className="block text-xs text-[var(--text-secondary)]">
              Threshold
              <input
                type="range"
                min={0}
                max={1}
                step={0.01}
                value={threshold}
                onChange={(e) => setThreshold(Number(e.target.value))}
                className="mt-1 w-full"
              />
              <div className="mt-1 text-[10px] text-[var(--text-tertiary)] tabular-nums">{threshold.toFixed(2)}</div>
            </label>

            <label className="block text-xs text-[var(--text-secondary)]">
              Steps
              <input
                type="range"
                min={32}
                max={256}
                step={1}
                value={steps}
                onChange={(e) => setSteps(Number(e.target.value))}
                className="mt-1 w-full"
              />
              <div className="mt-1 text-[10px] text-[var(--text-tertiary)] tabular-nums">{Math.round(steps)}</div>
            </label>

            <label className="block text-xs text-[var(--text-secondary)]">
              Gamma
              <input
                type="range"
                min={0.5}
                max={2.5}
                step={0.05}
                value={gamma}
                onChange={(e) => setGamma(Number(e.target.value))}
                className="mt-1 w-full"
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
              />
              <div className="mt-1 text-[10px] text-[var(--text-tertiary)] tabular-nums">{zoom.toFixed(2)}</div>
            </label>

            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={resetView}
                className="px-3 py-2 text-xs rounded-lg border border-[var(--border-color)] bg-[var(--bg-secondary)] text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-tertiary)]"
              >
                Reset view
              </button>
            </div>

            <div className="text-[10px] text-[var(--text-tertiary)]">
              This is a lightweight in-browser volume render (MIP). It’s meant for quick visual inspection of the SVR output.
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
