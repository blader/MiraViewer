/**
 * WebGL2 ray-marching shader + helpers for the SVR 3D viewer.
 *
 * Camera distance, center, and focal length must match the 2D overlay projection or
 * the overlay will drift relative to the rendered volume.
 */

import { clamp } from '../math';
import { yieldToMain } from './svrUtils';
import type { NativePlaneData } from './nativePlane';

export const SVR3D_CAMERA_Z = 1.6;
export const SVR3D_FOCAL_Z = 1.2;

export type VolumeTextureFormat =
  | { kind: 'f16'; internalFormat: number; format: number; type: number; minMagFilter: number }
  | { kind: 'u8'; internalFormat: number; format: number; type: number; minMagFilter: number };

export function chooseVolumeTextureFormat(gl: WebGL2RenderingContext): {
  primary: VolumeTextureFormat;
  fallback: VolumeTextureFormat;
} {
  // R16F over R32F: raymarching is texture-bandwidth-bound (up to 7 taps per sample with
  // gradients), so halving bytes/voxel directly buys frame time and GPU memory. Half-float
  // is also linearly filterable in core WebGL2, whereas R32F needs OES_texture_float_linear
  // and silently degraded to NEAREST (blocky sampling) where the extension was missing.
  // 11-bit mantissa precision is far beyond what a display-normalized [0,1] volume needs.
  const primary: VolumeTextureFormat = {
    kind: 'f16',
    internalFormat: gl.R16F,
    format: gl.RED,
    type: gl.HALF_FLOAT,
    minMagFilter: gl.LINEAR,
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

const ALWAYS_SUPPORTED_PLACEHOLDER = new Uint8Array([255]);

/** Upload acquired support separately: normalized intensity zero is still valid evidence. */
export function createObservedSupportTexture(
  gl: WebGL2RenderingContext,
  params: { data?: Uint8Array; dims: { nx: number; ny: number; nz: number } },
): { texture: WebGLTexture; enabled: boolean } {
  const support = params.data;
  const voxelCount = params.dims.nx * params.dims.ny * params.dims.nz;
  if (support && support.length !== voxelCount) {
    throw new Error('Acquired-support evidence does not match the displayed reconstruction.');
  }

  const texture = gl.createTexture();
  if (!texture) throw new Error('Failed to allocate the acquired-support 3D texture.');

  gl.activeTexture(gl.TEXTURE4);
  gl.bindTexture(gl.TEXTURE_3D, texture);

  try {
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_WRAP_R, gl.CLAMP_TO_EDGE);
    // Support is categorical evidence: filtering would invent observations across gaps.
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);

    gl.texImage3D(
      gl.TEXTURE_3D,
      0,
      gl.R8,
      support ? params.dims.nx : 1,
      support ? params.dims.ny : 1,
      support ? params.dims.nz : 1,
      0,
      gl.RED,
      gl.UNSIGNED_BYTE,
      support ?? ALWAYS_SUPPORTED_PLACEHOLDER,
    );

    if (gl.getError() !== gl.NO_ERROR) {
      throw new Error('The GPU could not upload acquired-support evidence.');
    }
  } catch (error) {
    gl.bindTexture(gl.TEXTURE_3D, null);
    gl.deleteTexture(texture);
    throw error;
  }

  gl.bindTexture(gl.TEXTURE_3D, null);
  return { texture, enabled: Boolean(support) };
}

/**
 * Convert float32 samples to IEEE 754 half-float bit patterns for HALF_FLOAT texture upload
 * (WebGL2 requires the data view for HALF_FLOAT to be a Uint16Array of raw f16 bits).
 *
 * Bit-twiddling port of the classic public-domain float->half routine: reads the f32 bits
 * directly through a Uint32Array view (no per-element scratch writes), keeps the top 11
 * mantissa bits and rounds to nearest. Volume data is normalized ~[0,1], so the
 * subnormal/overflow branches are correctness backstops rather than hot paths.
 */
function writeFloat16Range(words: Uint32Array, out: Uint16Array, start: number, end: number): void {
  for (let i = start; i < end; i++) {
    const x = words[i]!;
    let h = (x >> 16) & 0x8000; // sign
    const e = (x >> 23) & 0xff; // f32 exponent
    const m = (x >> 12) & 0x07ff; // top 10 mantissa bits + 1 round bit

    // |v| < 2^-24 underflows to signed zero (h already holds just the sign).
    if (e >= 103) {
      if (e > 142) {
        // |v| >= 2^16 overflows to infinity; preserve NaN-ness with a quiet-NaN bit.
        h |= 0x7c00;
        if (e === 255 && (x & 0x7fffff) !== 0) h |= 0x200;
      } else if (e < 113) {
        // f16 subnormal range: add the implicit leading 1, shift into place, round.
        const sub = m | 0x0800;
        h |= (sub >> (114 - e)) + ((sub >> (113 - e)) & 1);
      } else {
        // Normalized: re-bias exponent (127 -> 15) and round the mantissa. A mantissa
        // rounding carry overflows cleanly into the exponent field by construction.
        h |= ((e - 112) << 10) | (m >> 1);
        h += m & 1;
      }
    }

    out[i] = h;
  }
}

async function runCooperatively<T>(work: Generator<void, T, void>, isCancelled: () => boolean): Promise<T> {
  if (isCancelled()) throw new Error('3D render preparation cancelled');
  let started = performance.now();

  for (let current = work.next(); ; current = work.next()) {
    if (isCancelled()) throw new Error('3D render preparation cancelled');
    if (current.done) return current.value;

    if (performance.now() - started >= 8) {
      await yieldToMain();
      if (isCancelled()) throw new Error('3D render preparation cancelled');
      started = performance.now();
    }
  }
}

export function float32ToFloat16Bits(src: Float32Array, out = new Uint16Array(src.length)): Uint16Array {
  if (out.length !== src.length) throw new Error('Half-float output dimensions do not match the input.');
  // Float32Array is always 4-byte aligned, so reinterpreting its buffer is safe.
  const words = new Uint32Array(src.buffer, src.byteOffset, src.length);
  writeFloat16Range(words, out, 0, src.length);
  return out;
}

/** Prepare the same exact half-float representation without a long main-thread task. */
export async function float32ToFloat16BitsAsync(src: Float32Array, isCancelled: () => boolean): Promise<Uint16Array> {
  if (isCancelled()) throw new Error('3D render preparation cancelled');
  const out = new Uint16Array(src.length);
  const words = new Uint32Array(src.buffer, src.byteOffset, src.length);

  function* prepare(): Generator<void, Uint16Array, void> {
    const chunkSize = 131_072;
    for (let start = 0; start < words.length; start += chunkSize) {
      writeFloat16Range(words, out, start, Math.min(words.length, start + chunkSize));
      yield;
    }
    return out;
  }

  return runCooperatively(prepare(), isCancelled);
}

export function compileShader(gl: WebGL2RenderingContext, type: number, src: string): WebGLShader {
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

export function createProgram(gl: WebGL2RenderingContext, vsSrc: string, fsSrc: string): WebGLProgram {
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

/** Edge length (in render-volume voxels) of one occupancy cell. */
export const SVR3D_OCC_BLOCK = 8;

/**
 * Build a conservative coarse "max intensity per block" grid for empty-space skipping.
 *
 * The raymarcher's visibility test is `v >= thr`; in background regions every sample fails
 * it, yet each one still costs a full-resolution 3D texture tap. This grid lets the shader
 * answer "can anything in this 8^3 block ever pass the threshold?" with one tiny-texture
 * tap and leap empty cells entirely.
 *
 * Conservativeness (the skip must NEVER hide a visible sample):
 * - Each cell stores the max over its own block, then a second pass dilates by taking the
 *   max over the 3x3x3 neighboring cells — trilinear filtering of a sample inside one cell
 *   can read voxels up to 1 voxel into a neighbor, and whole-cell dilation covers that
 *   with simple code (slightly fewer skips than exact 1-voxel dilation, never incorrect).
 * - Values quantize to u8 with ceil() PLUS one extra quantum of headroom, which also
 *   swallows the R16F upload's round-to-nearest (which can land a hair above the f32
 *   source value). Bigger stored max == fewer skips == always safe.
 */
type OccupancyMaxGridParams = {
  data: Float32Array | Uint8Array;
  dims: { nx: number; ny: number; nz: number };
  blockSize?: number;
  observedSupport?: Uint8Array;
  visibilityThreshold?: number;
};

export type OccupancyMaxGrid = {
  data: Uint8Array;
  dims: { nx: number; ny: number; nz: number };
  visibleBounds?: {
    min: [number, number, number];
    max: [number, number, number];
  };
};

function* prepareOccupancyMaxGrid(params: OccupancyMaxGridParams): Generator<void, OccupancyMaxGrid, void> {
  const { data, dims, observedSupport } = params;
  const B = Math.max(2, Math.round(params.blockSize ?? SVR3D_OCC_BLOCK));

  if (observedSupport && observedSupport.length !== data.length) {
    throw new Error('Acquired-support evidence does not match the displayed reconstruction.');
  }

  const ox = Math.max(1, Math.ceil(dims.nx / B));
  const oy = Math.max(1, Math.ceil(dims.ny / B));
  const oz = Math.max(1, Math.ceil(dims.nz / B));

  // Uint8Array sources are raw R8 texel bytes (the GPU sees byte/255); Float32Array
  // sources are normalized intensities. Track the max in source units, quantize at the end.
  const isU8 = data instanceof Uint8Array;
  const visibilityThreshold =
    typeof params.visibilityThreshold === 'number' && Number.isFinite(params.visibilityThreshold)
      ? params.visibilityThreshold * (isU8 ? 255 : 1)
      : undefined;
  let minVisibleX = dims.nx;
  let minVisibleY = dims.ny;
  let minVisibleZ = dims.nz;
  let maxVisibleX = -1;
  let maxVisibleY = -1;
  let maxVisibleZ = -1;

  // Pass 1: plain per-cell max — every voxel visits exactly one cell (O(nvox)).
  const rawMax = new Float32Array(ox * oy * oz);
  const strideY = dims.nx;
  const strideZ = dims.nx * dims.ny;
  const occStrideY = ox;
  const occStrideZ = ox * oy;

  for (let z = 0; z < dims.nz; z++) {
    const cz = (z / B) | 0;
    const zBase = z * strideZ;
    const ozBase = cz * occStrideZ;

    for (let y = 0; y < dims.ny; y++) {
      const cy = (y / B) | 0;
      const base = zBase + y * strideY;
      const oBase = ozBase + cy * occStrideY;

      for (let x = 0; x < dims.nx; x++) {
        const sourceIndex = base + x;
        const v = data[sourceIndex] ?? 0;
        const oi = oBase + ((x / B) | 0);
        if (v > rawMax[oi]!) rawMax[oi] = v;

        if (
          visibilityThreshold !== undefined &&
          v >= visibilityThreshold &&
          (!observedSupport || observedSupport[sourceIndex])
        ) {
          if (x < minVisibleX) minVisibleX = x;
          if (x > maxVisibleX) maxVisibleX = x;
          if (y < minVisibleY) minVisibleY = y;
          if (y > maxVisibleY) maxVisibleY = y;
          if (z < minVisibleZ) minVisibleZ = z;
          if (z > maxVisibleZ) maxVisibleZ = z;
        }
      }
    }
    yield;
  }

  // Pass 2: dilate over neighboring cells + quantize conservatively. The occupancy grid is
  // ~B^3 smaller than the volume, so this pass is negligible.
  const out = new Uint8Array(ox * oy * oz);

  for (let z = 0; z < oz; z++) {
    const z0 = Math.max(0, z - 1);
    const z1 = Math.min(oz - 1, z + 1);

    for (let y = 0; y < oy; y++) {
      const y0 = Math.max(0, y - 1);
      const y1 = Math.min(oy - 1, y + 1);

      for (let x = 0; x < ox; x++) {
        const x0 = Math.max(0, x - 1);
        const x1 = Math.min(ox - 1, x + 1);

        let m = 0;
        for (let zz = z0; zz <= z1; zz++) {
          for (let yy = y0; yy <= y1; yy++) {
            const nBase = zz * occStrideZ + yy * occStrideY;
            for (let xx = x0; xx <= x1; xx++) {
              const v = rawMax[nBase + xx]!;
              if (v > m) m = v;
            }
          }
        }

        // u8 sources already sit on the 1/255 grid; float sources round up to it. The +1
        // headroom quantum keeps the stored max strictly above any filtered sample value.
        const q = isU8 ? m : Math.ceil(clamp(m, 0, 1) * 255);
        out[z * occStrideZ + y * occStrideY + x] = Math.min(255, q + 1);
      }
    }
    yield;
  }

  const visibleBounds: OccupancyMaxGrid['visibleBounds'] =
    maxVisibleX >= 0
      ? { min: [minVisibleX, minVisibleY, minVisibleZ], max: [maxVisibleX, maxVisibleY, maxVisibleZ] }
      : undefined;

  return { data: out, dims: { nx: ox, ny: oy, nz: oz }, ...(visibleBounds ? { visibleBounds } : {}) };
}

export function buildOccupancyMaxGrid(params: OccupancyMaxGridParams): OccupancyMaxGrid {
  const work = prepareOccupancyMaxGrid(params);
  for (let current = work.next(); ; current = work.next()) {
    if (current.done) return current.value;
  }
}

/** Build the identical conservative grid while yielding between physical slabs. */
export function buildOccupancyMaxGridAsync(
  params: OccupancyMaxGridParams,
  isCancelled: () => boolean,
): Promise<OccupancyMaxGrid> {
  return runCooperatively(prepareOccupancyMaxGrid(params), isCancelled);
}

export type NativePlaneDisplay = {
  enabled: boolean;
  selectionOnly?: boolean;
  contour?: boolean;
  windowRange?: readonly [number, number];
  invert?: boolean;
  interpolate?: boolean;
  cutaway?: boolean;
};

export type NativePlaneBinding = {
  setPlane: (plane: NativePlaneData | null, mask?: Uint8Array | null) => void;
  /** Call with this program active, on every draw (including when no native plane is visible). */
  bind: (display: NativePlaneDisplay) => void;
  dispose: () => void;
};

/** R32F preserves original samples; NEAREST + explicit interpolation needs no float-linear extension. */
export function createNativePlaneBinding(gl: WebGL2RenderingContext, program: WebGLProgram): NativePlaneBinding {
  const textures: WebGLTexture[] = [];
  const uniforms = Object.fromEntries(
    [
      'Image',
      'Validity',
      'Mask',
      'Enabled',
      'MaskEnabled',
      'SelectionOnly',
      'Contour',
      'WindowLow',
      'WindowWidth',
      'Invert',
      'Interpolate',
      'Cutaway',
      'Origin',
      'ColumnStep',
      'RowStep',
    ].map((name) => [name, gl.getUniformLocation(program, `u_native${name}`)]),
  );
  let current: NativePlaneData | null = null;
  let currentMask: Uint8Array | null = null;
  let uploadedImage: NativePlaneData['image'] | null = null;
  let disposed = false;
  const upload = (slot: number, width: number, height: number, data: Float32Array | Uint8Array) => {
    gl.activeTexture(gl.TEXTURE0 + 5 + slot);
    gl.bindTexture(gl.TEXTURE_2D, textures[slot]!);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.pixelStorei(gl.UNPACK_ROW_LENGTH, 0);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texImage2D(
      gl.TEXTURE_2D,
      0,
      slot === 0 ? gl.R32F : gl.R8,
      width,
      height,
      0,
      gl.RED,
      slot === 0 ? gl.FLOAT : gl.UNSIGNED_BYTE,
      data,
    );
    if (gl.getError() !== gl.NO_ERROR)
      throw new Error('The GPU could not preserve the original MRI plane at its native resolution.');
  };
  try {
    for (let slot = 0; slot < 3; slot++) {
      const texture = gl.createTexture();
      if (!texture) throw new Error('The GPU could not allocate the original MRI plane.');
      textures.push(texture);
      upload(slot, 1, 1, slot === 0 ? new Float32Array(1) : new Uint8Array(1));
    }
  } catch (error) {
    for (const texture of textures) gl.deleteTexture(texture);
    throw error;
  } finally {
    gl.activeTexture(gl.TEXTURE0);
  }
  return {
    setPlane(plane, mask = null) {
      if (disposed) return;
      current = null;
      if (!plane) return;
      const { image } = plane;
      const length = image.rows * image.cols;
      if (image.pixels.length !== length || image.validity.length !== length || (mask && mask.length !== length))
        throw new Error('The original MRI plane and projected selection have different dimensions.');
      const maxSize = gl.getParameter(gl.MAX_TEXTURE_SIZE) as number;
      if (image.rows > maxSize || image.cols > maxSize)
        throw new Error('The original MRI plane exceeds this GPU’s native texture size; it has not been downsampled.');
      try {
        const changedImage = uploadedImage !== image;
        if (changedImage) {
          upload(0, image.cols, image.rows, image.pixels);
          upload(
            1,
            image.cols,
            image.rows,
            Uint8Array.from(image.validity, (value) => (value > 0 ? 255 : 0)),
          );
        }
        if (changedImage || currentMask !== mask)
          upload(2, mask ? image.cols : 1, mask ? image.rows : 1, mask ?? new Uint8Array(1));
        uploadedImage = image;
        currentMask = mask;
        current = plane;
      } finally {
        gl.activeTexture(gl.TEXTURE0);
      }
    },
    bind(display) {
      if (disposed) return;
      for (let slot = 0; slot < 3; slot++) {
        gl.activeTexture(gl.TEXTURE0 + 5 + slot);
        gl.bindTexture(gl.TEXTURE_2D, textures[slot]!);
        gl.uniform1i(uniforms[['Image', 'Validity', 'Mask'][slot]!]!, 5 + slot);
      }
      gl.uniform1i(uniforms.Enabled!, display.enabled && current ? 1 : 0);
      gl.uniform1i(uniforms.MaskEnabled!, currentMask ? 1 : 0);
      if (current) {
        const range = display.windowRange ?? current.windowRange;
        gl.uniform1i(uniforms.SelectionOnly!, display.selectionOnly ? 1 : 0);
        gl.uniform1i(uniforms.Contour!, display.contour === false ? 0 : 1);
        gl.uniform1i(uniforms.Invert!, (display.invert ?? current.invert) ? 1 : 0);
        gl.uniform1i(uniforms.Interpolate!, display.interpolate ? 1 : 0);
        gl.uniform1i(uniforms.Cutaway!, display.cutaway ? 1 : 0);
        gl.uniform1f(uniforms.WindowLow!, range[0]);
        gl.uniform1f(uniforms.WindowWidth!, Math.max(0, range[1] - range[0]));
        gl.uniform3f(uniforms.Origin!, ...current.origin);
        gl.uniform3f(uniforms.ColumnStep!, ...current.columnStep);
        gl.uniform3f(uniforms.RowStep!, ...current.rowStep);
      }
      gl.activeTexture(gl.TEXTURE0);
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      for (const texture of textures) gl.deleteTexture(texture);
      current = null;
      uploadedImage = null;
      currentMask = null;
    },
  };
}

export const RAYMARCH_VERTEX_SHADER = `#version 300 es
in vec2 a_pos;
out vec2 v_uv;
void main() {
  v_uv = a_pos * 0.5 + 0.5;
  gl_Position = vec4(a_pos, 0.0, 1.0);
}`;

export const RAYMARCH_FRAGMENT_SHADER = `#version 300 es
precision highp float;
precision highp sampler3D;
precision highp usampler3D;
precision highp sampler2D;

in vec2 v_uv;
out vec4 outColor;

uniform sampler3D u_vol;
uniform sampler3D u_support;
uniform int u_supportEnabled;
uniform usampler3D u_labels;
uniform sampler2D u_palette;
uniform int u_labelsEnabled;
uniform int u_tumorOnly;
uniform float u_windowLow;
uniform float u_windowWidth;
uniform int u_clipEnabled;
uniform float u_clipZ;
uniform int u_focusEnabled;
uniform vec3 u_focusMin;
uniform vec3 u_focusMax;
uniform float u_labelMix;

// Optional inferred intensities are a separate physical crop, never the base MRI or labels.
uniform sampler3D u_enhancedVolume;
uniform sampler3D u_enhancedSupport;
uniform sampler3D u_enhancedOriginal;
uniform int u_enhancedOriginalAvailable;
uniform int u_enhancedEnabled;
uniform int u_enhancedAllSupported;
uniform int u_enhancedSmoothSurface;
uniform float u_enhancedStrength;
uniform mat4 u_enhancedFromBase;
uniform vec3 u_enhancedDims;
uniform vec3 u_enhancedTexel;

uniform sampler2D u_nativeImage;
uniform sampler2D u_nativeValidity;
uniform sampler2D u_nativeMask;
uniform int u_nativeEnabled;
uniform int u_nativeMaskEnabled;
uniform int u_nativeSelectionOnly;
uniform int u_nativeContour;
uniform float u_nativeWindowLow;
uniform float u_nativeWindowWidth;
uniform int u_nativeInvert;
uniform int u_nativeInterpolate;
uniform int u_nativeCutaway;
uniform vec3 u_nativeOrigin;
uniform vec3 u_nativeColumnStep;
uniform vec3 u_nativeRowStep;

// Empty-space skipping: a coarse per-block conservative max of the volume (see
// buildOccupancyMaxGrid). u_occMaxCell clamps texelFetch coords at the grid edge.
uniform sampler3D u_occ;
uniform int u_occEnabled;
uniform int u_occBlock;
uniform ivec3 u_occMaxCell;

// Inverse (camera->object) rotation, computed once per frame on the CPU.
// A rotation's inverse is its transpose, so the JS side uploads the transpose of the
// rotation matrix instead of paying for a per-fragment transpose() here.
uniform mat3 u_invRot;
uniform float u_cameraZ;
uniform vec3 u_cameraCenter;
uniform vec3 u_box;
uniform float u_aspect;
uniform float u_zoom;
uniform float u_thr;
uniform int u_steps;
uniform float u_gamma;
uniform float u_opacity;
uniform vec3 u_texel;
// 0 at rest, 1 during interaction: scales a per-pixel ray-start offset that converts
// the banding from a reduced interaction-time step count into imperceptible noise.
uniform float u_jitter;

const float FOCAL_Z = ${SVR3D_FOCAL_Z};

float saturate(float x) {
  return clamp(x, 0.0, 1.0);
}

float windowed(float intensity) {
  return u_windowWidth > 0.0 ? saturate((intensity - u_windowLow) / u_windowWidth) : (intensity > u_windowLow ? 1.0 : 0.0);
}

bool enhancedFootprintValid(vec3 tc, int stride) {
  if (u_enhancedAllSupported != 0) return true;
  if (texture(u_enhancedSupport, tc).r <= 0.0) return false;
  // Original and 2x child grids share cell-edge FOV and exact source-footprint validity.
  // Each sampler checks its own interpolation footprint, never bridging invalid tissue.
  ivec3 size = textureSize(u_enhancedSupport, 0) / stride;
  vec3 coordinates = tc * vec3(size) - 0.5;
  ivec3 lower = ivec3(floor(coordinates));
  vec3 fraction = fract(coordinates);
  for (int z = 0; z < 2; z++) for (int y = 0; y < 2; y++) for (int x = 0; x < 2; x++) {
    float weight = (x == 0 ? 1.0 - fraction.x : fraction.x) * (y == 0 ? 1.0 - fraction.y : fraction.y) * (z == 0 ? 1.0 - fraction.z : fraction.z);
    ivec3 pixel = clamp(lower + ivec3(x, y, z), ivec3(0), size - 1) * stride;
    if (weight > 0.0 && texelFetch(u_enhancedSupport, pixel, 0).r <= 0.0) return false;
  }
  return true;
}

float displayedIntensity(vec3 tc, out float resolutionScale) {
  resolutionScale = 0.0;
  float original = texture(u_vol, tc).r;
  if (u_enhancedEnabled == 0 && u_enhancedOriginalAvailable == 0) return original;
  vec3 enhancedTc = (u_enhancedFromBase * vec4(tc, 1.0)).xyz;
  if (any(lessThan(enhancedTc, vec3(0.0))) || any(greaterThan(enhancedTc, vec3(1.0)))) return original;
  if (u_enhancedOriginalAvailable != 0 && enhancedFootprintValid(enhancedTc, 2)) {
    original = texture(u_enhancedOriginal, enhancedTc).r;
    resolutionScale = 2.0;
  }
  if (u_enhancedEnabled == 0 || u_enhancedStrength <= 0.0 || !enhancedFootprintValid(enhancedTc, 1)) return original;
  resolutionScale = 1.0;
  return mix(original, texture(u_enhancedVolume, enhancedTc).r, u_enhancedStrength);
}

float displayedIntensity(vec3 tc) {
  float resolutionScale;
  return displayedIntensity(tc, resolutionScale);
}

void addLesionSample(
  ivec3 coordinates,
  ivec3 maxCoordinates,
  float weight,
  inout float coverage,
  inout float strongest,
  inout uint label
) {
  uint sampleLabel = texelFetch(u_labels, clamp(coordinates, ivec3(0), maxCoordinates), 0).r;
  if (sampleLabel == 0u) return;
  coverage += weight;
  if (weight > strongest) {
    strongest = weight;
    label = sampleLabel;
  }
}

// Integer label textures cannot use linear filtering. Interpolate categorical
// occupancy before choosing a label so boundaries soften without another texture.
float lesionCoverage(vec3 tc, out uint label) {
  ivec3 size = textureSize(u_labels, 0);
  vec3 coordinates = tc * vec3(size) - 0.5;
  ivec3 lower = ivec3(floor(coordinates));
  ivec3 upper = size - ivec3(1);
  vec3 fraction = fract(coordinates);
  vec3 inverse = 1.0 - fraction;
  float coverage = 0.0;
  float strongest = -1.0;
  label = 0u;

  addLesionSample(lower, upper, inverse.x * inverse.y * inverse.z, coverage, strongest, label);
  addLesionSample(lower + ivec3(1, 0, 0), upper, fraction.x * inverse.y * inverse.z, coverage, strongest, label);
  addLesionSample(lower + ivec3(0, 1, 0), upper, inverse.x * fraction.y * inverse.z, coverage, strongest, label);
  addLesionSample(lower + ivec3(1, 1, 0), upper, fraction.x * fraction.y * inverse.z, coverage, strongest, label);
  addLesionSample(lower + ivec3(0, 0, 1), upper, inverse.x * inverse.y * fraction.z, coverage, strongest, label);
  addLesionSample(lower + ivec3(1, 0, 1), upper, fraction.x * inverse.y * fraction.z, coverage, strongest, label);
  addLesionSample(lower + ivec3(0, 1, 1), upper, inverse.x * fraction.y * fraction.z, coverage, strongest, label);
  addLesionSample(lower + ivec3(1, 1, 1), upper, fraction.x * fraction.y * fraction.z, coverage, strongest, label);

  return coverage;
}

// Analytic derivative of binary coverage, used only for cut-edge antialiasing.
vec3 lesionGradient(vec3 tc) {
  ivec3 size = textureSize(u_labels, 0);
  vec3 coordinates = tc * vec3(size) - 0.5;
  ivec3 lower = ivec3(floor(coordinates));
  vec3 fraction = fract(coordinates);
  vec3 gradient = vec3(0.0);
  for (int z = 0; z < 2; z++) for (int y = 0; y < 2; y++) for (int x = 0; x < 2; x++) {
    if (texelFetch(u_labels, clamp(lower + ivec3(x, y, z), ivec3(0), size - 1), 0).r == 0u) continue;
    vec3 weight = vec3(x == 0 ? 1.0 - fraction.x : fraction.x, y == 0 ? 1.0 - fraction.y : fraction.y, z == 0 ? 1.0 - fraction.z : fraction.z);
    vec3 sign = vec3(x == 0 ? -1.0 : 1.0, y == 0 ? -1.0 : 1.0, z == 0 ? -1.0 : 1.0);
    gradient += sign * vec3(weight.y * weight.z, weight.x * weight.z, weight.x * weight.y);
  }
  return gradient * vec3(size) / u_box;
}

// A cut surface is an MRI section, not a shaded or accumulated density sample.
// Sample the exact crosshair plane with the same window as the orthogonal views.
// Acquired support remains categorical. The optional continuous selection iso is
// presentation only; original MRI planes and authoritative labels remain untouched.
vec4 cutSurface(vec3 position, vec3 pixelWidth) {
  vec3 tc = position / u_box + 0.5;
  if (u_supportEnabled != 0 && texture(u_support, tc).r <= 0.0) return vec4(0.0);
  uint label = 0u;
  if (u_labelsEnabled != 0 || u_tumorOnly != 0) label = texture(u_labels, tc).r;
  float alpha = 1.0;
  if (u_tumorOnly != 0) {
    if (u_enhancedSmoothSurface != 0) {
      float coverage = lesionCoverage(tc, label);
      float width = max(1e-4, dot(abs(lesionGradient(tc) * u_box), pixelWidth));
      alpha = smoothstep(0.5 - 0.5 * width, 0.5 + 0.5 * width, coverage);
      if (alpha <= 0.0) return vec4(0.0);
    } else if (label == 0u) return vec4(0.0);
  }
  bool selected = label != 0u;
  float value = windowed(selected ? displayedIntensity(tc) : texture(u_vol, tc).r);
  vec3 color = vec3(value);
  if (u_labelsEnabled != 0 && label != 0u) {
    color = mix(color, texelFetch(u_palette, ivec2(int(label), 0), 0).rgb * value, 0.08);
  }
  return vec4(color, alpha);
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

float nativeMaskAt(ivec2 pixel) {
  if (u_nativeMaskEnabled == 0 || any(lessThan(pixel, ivec2(0))) || any(greaterThanEqual(pixel, textureSize(u_nativeMask, 0)))) return 0.0;
  return texelFetch(u_nativeMask, pixel, 0).r;
}

// A native image textures a cross-section of the reconstructed object, not a
// freestanding rectangle. Geometry/support/visibility come from the volume;
// displayed intensities still come directly from the original MRI pixels.
vec4 nativeSurface(vec3 ro, vec3 rd, out float planeT) {
  planeT = -1.0;
  if (u_nativeEnabled == 0) return vec4(0.0);
  vec3 normal = cross(u_nativeColumnStep, u_nativeRowStep);
  float denominator = dot(rd, normal);
  bool parallel = abs(denominator) < 1e-12;
  planeT = dot(u_nativeOrigin - ro, normal) / (parallel ? 1e-12 : denominator);
  vec3 offset = ro + rd * planeT - u_nativeOrigin;
  vec2 coordinates = vec2(dot(offset, u_nativeColumnStep) / dot(u_nativeColumnStep, u_nativeColumnStep), dot(offset, u_nativeRowStep) / dot(u_nativeRowStep, u_nativeRowStep));
  // Derivatives precede every per-fragment return, including validity/mask clipping.
  vec2 coordinateWidth = max(fwidth(coordinates), vec2(1e-6));
  if (parallel || planeT < 0.0) return vec4(0.0);
  vec3 tc = (ro + rd * planeT) / u_box + 0.5;
  if (any(lessThan(tc, vec3(0.0))) || any(greaterThanEqual(tc, vec3(1.0)))) return vec4(0.0);
  if (u_supportEnabled != 0 && texture(u_support, tc).r <= 0.0) return vec4(0.0);
  ivec2 size = textureSize(u_nativeImage, 0);
  if (any(lessThan(coordinates, vec2(-0.5))) || any(greaterThanEqual(coordinates, vec2(size) - 0.5))) return vec4(0.0);
  ivec2 pixel = ivec2(floor(coordinates + 0.5));
  if (texelFetch(u_nativeValidity, pixel, 0).r <= 0.0) return vec4(0.0);
  float mask = nativeMaskAt(pixel);
  if (u_tumorOnly != 0 || u_nativeSelectionOnly != 0) {
    // Use the exact CPU-projected annotation, never a reduced GPU label grid.
    // A selected dark MRI pixel is still valid tissue, not transparent air.
    if (mask <= 0.0) return vec4(0.0);
  } else if (windowed(texture(u_vol, tc).r) < saturate(u_thr) && !(u_labelsEnabled != 0 && mask > 0.0)) {
    return vec4(0.0);
  }
  float value = texelFetch(u_nativeImage, pixel, 0).r;
  if (u_nativeInterpolate != 0) {
    ivec2 lower = ivec2(floor(coordinates));
    vec2 fraction = fract(coordinates);
    float weighted = 0.0, weight = 0.0;
    for (int y = 0; y < 2; y++) for (int x = 0; x < 2; x++) {
      ivec2 neighbor = clamp(lower + ivec2(x, y), ivec2(0), size - 1);
      float contribution = (x == 0 ? 1.0 - fraction.x : fraction.x) * (y == 0 ? 1.0 - fraction.y : fraction.y);
      if (texelFetch(u_nativeValidity, neighbor, 0).r > 0.0) { weighted += texelFetch(u_nativeImage, neighbor, 0).r * contribution; weight += contribution; }
    }
    if (weight > 0.0) value = weighted / weight;
  }
  value = u_nativeWindowWidth > 0.0 ? saturate((value - u_nativeWindowLow) / u_nativeWindowWidth) : (value > u_nativeWindowLow ? 1.0 : 0.0);
  if (u_nativeInvert != 0) value = 1.0 - value;
  vec3 color = vec3(value);
  if (u_nativeContour != 0 && mask > 0.0) {
    // Categorical boundaries stay exact; only their display stroke is screen-sized.
    vec2 local = coordinates - vec2(pixel);
    vec4 edges = vec4(0.5 - local.x, 0.5 + local.x, 0.5 - local.y, 0.5 + local.y) / coordinateWidth.xxyy;
    float boundaryDistance = 1e6;
    if (nativeMaskAt(pixel + ivec2(1, 0)) != mask) boundaryDistance = min(boundaryDistance, edges.x);
    if (nativeMaskAt(pixel + ivec2(-1, 0)) != mask) boundaryDistance = min(boundaryDistance, edges.y);
    if (nativeMaskAt(pixel + ivec2(0, 1)) != mask) boundaryDistance = min(boundaryDistance, edges.z);
    if (nativeMaskAt(pixel + ivec2(0, -1)) != mask) boundaryDistance = min(boundaryDistance, edges.w);
    color = mix(color, vec3(0.404, 0.812, 0.757), 0.8 * (1.0 - smoothstep(0.75, 1.5, boundaryDistance)));
  }
  return vec4(color, 1.0);
}

void main() {
  // NDC in [-1, 1]
  vec2 p = v_uv * 2.0 - 1.0;
  p.x *= u_aspect;
  p /= max(1e-3, u_zoom);

  // World/view ray
  vec3 roW = vec3(0.0, 0.0, u_cameraZ);
  vec3 rdW = normalize(vec3(p, -FOCAL_Z));

  // Rotate ray into volume/object space (the volume is rotated; rays go the other way).
  vec3 ro = u_invRot * roW + u_cameraCenter;
  vec3 rd = u_invRot * rdW;

  float cutZ = (u_clipZ - 0.5) * u_box.z;
  vec3 cutPixelWidth = vec3(0.0);
  if (u_clipEnabled != 0 && u_enhancedSmoothSurface != 0) {
    float denominator = abs(rd.z) < 1e-8 ? (rd.z < 0.0 ? -1e-8 : 1e-8) : rd.z;
    vec3 cutPoint = ro + rd * ((cutZ - ro.z) / denominator);
    // Derivatives precede all ray/selection-dependent returns, including box misses.
    cutPixelWidth = fwidth(cutPoint / u_box + 0.5);
  }

  float nativeT;
  vec4 nativeSection = nativeSurface(ro, rd, nativeT);

  vec3 bmin = -0.5 * u_box;
  vec3 bmax =  0.5 * u_box;
  if (u_focusEnabled != 0) {
    // The bounds include the complete seed-grow search domain. Rejecting rays
    // outside that acquired region reduces work without clipping lesion labels.
    bmin = max(bmin, u_focusMin);
    bmax = min(bmax, u_focusMax);
  }

  if (u_clipEnabled != 0) bmax.z = min(bmax.z, cutZ);

  float t0;
  float t1;
  if (any(lessThan(bmax, bmin)) || !intersectBox(ro, rd, bmin, bmax, t0, t1)) {
    outColor = vec4(0.0, 0.0, 0.0, 1.0);
    return;
  }
  t0 = max(t0, 0.0);
  bool nativeHit = nativeSection.a > 0.0 && nativeT >= t0 && nativeT <= t1;
  if (u_nativeEnabled != 0 && u_nativeCutaway != 0) {
    vec3 normal = normalize(cross(u_nativeColumnStep, u_nativeRowStep));
    vec3 center = (bmin + bmax) * 0.5;
    float radius = dot((bmax - bmin) * 0.5, abs(normal));
    // Browsing beyond a cropped object must not replace or erase that object.
    if (abs(dot(center - u_nativeOrigin, normal)) <= radius) {
      float slope = dot(rd, normal);
      float distance = dot(ro - u_nativeOrigin, normal);
      // Retain the same physical half-space when the camera orbits. The native
      // facing view looks into it; from behind the retained volume stays in front.
      if (abs(slope) < 1e-6) {
        if (distance < 0.0) { outColor = vec4(0.0, 0.0, 0.0, 1.0); return; }
      } else {
        float boundary = -distance / slope;
        if (slope > 0.0) t0 = max(t0, boundary);
        else t1 = min(t1, boundary);
      }
    }
  }
  if (nativeHit && nativeT <= t0 + 1e-6 && t0 <= t1 + 1e-6) { outColor = nativeSection; return; }
  // Composite only the bounded cross-section, in the same depth order as tissue.
  if (nativeHit) t1 = min(t1, nativeT);
  if (t1 <= t0) { outColor = vec4(0.0, 0.0, 0.0, 1.0); return; }

  // When looking into the cut, preserve its acquired grayscale exactly. Fog
  // integration behind it otherwise washes out texture even at high resolution.
  if (u_clipEnabled != 0 && rd.z < -1e-6 && abs((ro + rd * t0).z - cutZ) < 1e-5) {
    vec4 section = cutSurface(ro + rd * t0, cutPixelWidth);
    if (section.a > 0.0) { outColor = vec4(section.rgb * section.a, 1.0); return; }
  }

  // Raymarch (front-to-back compositing)
  const int MAX_STEPS = 1536;
  // Settled sampling follows physical voxel traversal, not a fixed count across every grid.
  float traversedVoxels = length(((t1 - t0) * rd / u_box) / u_texel);
  if ((u_enhancedEnabled != 0 && u_enhancedStrength > 0.0) || u_enhancedOriginalAvailable != 0) {
    vec3 enhancedTraversal = mat3(u_enhancedFromBase) * ((t1 - t0) * rd / u_box);
    float resolutionScale = u_enhancedEnabled != 0 && u_enhancedStrength > 0.0 ? 1.0 : 0.5;
    traversedVoxels = max(traversedVoxels, length(enhancedTraversal * u_enhancedDims) * resolutionScale);
  }
  int n = clamp(u_jitter > 0.0 ? u_steps : max(u_steps, int(ceil(traversedVoxels * 1.5))), 8, MAX_STEPS);
  float dt = (t1 - t0) / float(n);

  // The transfer function is spatially neutral: equal acquired intensities and
  // gradients must remain equally visible at the center and at the periphery.
  const float EDGE_K = 14.0;
  // A categorical lesion remains visible even when its acquired intensity is
  // below the anatomy threshold; the acquired-support gate still applies.
  float thr = u_tumorOnly != 0 ? 0.0 : saturate(u_thr);

  vec3 accum = vec3(0.0);
  float aAccum = 0.0;
  vec3 lesionAccum = vec3(0.0);
  float lesionAlpha = 0.0;

  // Interleaved gradient noise (Jimenez 2014): a stable per-pixel value in [0,1) used to
  // offset each ray's start by up to one step. During interaction we march fewer steps
  // (larger dt), which would show as banding; jittering decorrelates the bands across
  // neighboring pixels so they read as faint noise instead. u_jitter is 0 at rest, so
  // settled frames remain deterministic (screenshot capture relies on that).
  float ign = fract(52.9829189 * fract(dot(gl_FragCoord.xy, vec2(0.06711056, 0.00583715))));
  float t = max(t0, 0.0) + ign * dt * u_jitter;

  // View direction in object space (toward the camera).
  vec3 vDir = normalize(-rd);

  // Frame-constant terms for empty-space skipping, hoisted out of the march loop.
  vec3 occCellSizeTc = vec3(float(u_occBlock)) * u_texel;
  vec3 rdTc = rd / u_box;
  vec3 aRdTc = abs(rdTc) + 1e-12;

  for (int i = 0; i < MAX_STEPS; i++) {
    if (i >= n) break;
    vec3 pos = ro + rd * (t + float(i) * dt);

    // Map object-space box to texture coords [0,1]
    vec3 tc = pos / u_box + 0.5;

    if (u_occEnabled != 0 && u_enhancedEnabled == 0 && u_enhancedOriginalAvailable == 0) {
      // Empty-space skipping: if even the lowest threshold anywhere in this occupancy
      // cell exceeds the cell's conservative max, no sample in the cell can pass the
      // visibility test below — leap the ray to the cell exit instead of sampling the
      // full-res volume texture step by step through background. Check this before
      // categorical support so unsupported background can also be crossed by whole cells.
      ivec3 vox = ivec3(clamp(tc, 0.0, 1.0) / u_texel);
      ivec3 cell = clamp(vox / u_occBlock, ivec3(0), u_occMaxCell);
      float occMax = texelFetch(u_occ, cell, 0).r;
      if (u_labelsEnabled == 0 && thr > 0.0 && occMax < u_windowLow + thr * u_windowWidth) {
        // Distance (in ray-parameter units) to this cell's exit, via per-axis positive
        // distances — formulated to avoid div-by-zero/NaN for axis-aligned rays. The eps
        // in aRdTc only shrinks the leap, never overshoots.
        vec3 cMin = vec3(cell) * occCellSizeTc;
        vec3 distAx = mix(tc - cMin, cMin + occCellSizeTc - tc, step(vec3(0.0), rdTc));
        float tExit = max(min(min(distAx.x / aRdTc.x, distAx.y / aRdTc.y), distAx.z / aRdTc.z), 0.0);

        // floor() + the loop's own i++ lands the next sample just past the boundary;
        // worst case (tExit < dt) this degenerates to normal single-step progress.
        i += int(floor(tExit / dt));
        continue;
      }
    }

    // Acquired bytes are 0/1; normalized R8 turns supported 1 into 1/255,
    // so any positive value is evidence. Never infer support from intensity.
    if (u_supportEnabled != 0 && texture(u_support, tc).r <= 0.0) {
      continue;
    }

    // Reject non-lesion anatomy before its intensity and six gradient fetches.
    // Labels are categorical annotations, never evidence of acquired support.
    uint lid = 0u;
    float labelCoverage = 0.0;
    bool smoothSurface = u_enhancedSmoothSurface != 0 && u_tumorOnly != 0;
    if (u_labelsEnabled != 0 || u_tumorOnly != 0) {
      if (u_tumorOnly != 0) {
        labelCoverage = lesionCoverage(tc, lid);
        if (labelCoverage <= (smoothSurface ? 0.45 : 0.08)) {
          continue;
        }
      } else {
        lid = texture(u_labels, tc).r;
        if (lid != 0u) {
          labelCoverage = lesionCoverage(tc, lid);
        }
      }
    }

    float resolutionScale = 0.0;
    bool selected = lid != 0u || ((u_enhancedEnabled != 0 || u_enhancedOriginalAvailable != 0) && texture(u_labels, tc).r != 0u);
    float v = windowed(selected ? displayedIntensity(tc, resolutionScale) : texture(u_vol, tc).r);
    bool refined = resolutionScale > 0.0;

    if (v >= thr || (u_labelsEnabled != 0 && lid != 0u)) {
      float val = u_tumorOnly != 0
        ? max(v, 0.18)
        : saturate((v - thr) / max(1e-6, 1.0 - thr));

      // Gradient in object/texture space (central differences).
      vec3 d = refined ? min(u_texel, u_enhancedTexel * resolutionScale) : u_texel;
      vec3 xp = clamp(tc + vec3(d.x, 0.0, 0.0), 0.0, 1.0), xm = clamp(tc - vec3(d.x, 0.0, 0.0), 0.0, 1.0);
      vec3 yp = clamp(tc + vec3(0.0, d.y, 0.0), 0.0, 1.0), ym = clamp(tc - vec3(0.0, d.y, 0.0), 0.0, 1.0);
      vec3 zp = clamp(tc + vec3(0.0, 0.0, d.z), 0.0, 1.0), zm = clamp(tc - vec3(0.0, 0.0, d.z), 0.0, 1.0);
      float vx1 = windowed(selected ? displayedIntensity(xp) : texture(u_vol, xp).r);
      float vx0 = windowed(selected ? displayedIntensity(xm) : texture(u_vol, xm).r);
      float vy1 = windowed(selected ? displayedIntensity(yp) : texture(u_vol, yp).r);
      float vy0 = windowed(selected ? displayedIntensity(ym) : texture(u_vol, ym).r);
      float vz1 = windowed(selected ? displayedIntensity(zp) : texture(u_vol, zp).r);
      float vz0 = windowed(selected ? displayedIntensity(zm) : texture(u_vol, zm).r);

      vec3 grad = vec3(vx1 - vx0, vy1 - vy0, vz1 - vz0);
      float gmag = length(refined ? grad * (u_texel / d) : grad);

      // Edge factor, applied uniformly throughout the physical volume.
      // IMPORTANT: use an exponential mapping so the "Edge strength" slider stays responsive
      // instead of quickly saturating to 1.0 for most edges.
      float edgeRaw = gmag * EDGE_K;
      float edge = 1.0 - exp(-edgeRaw * u_gamma);
      edge = saturate(edge);
      edge = edge * edge;

      // Light MRI texture with its own gradient. Binary coverage derivatives jump
      // at coarse annotation-cell faces and would imprint that grid onto tissue.
      vec3 normalGradient = refined ? grad / max(d * u_box, vec3(1e-12)) : grad;
      vec3 nrm = normalize(normalGradient + vec3(1e-6));
      float diff = abs(dot(nrm, vDir));
      float shade = 0.65 + 0.35 * diff;

      // Edges control visibility, not a second darkening of the MRI intensities.
      float a = saturate(val * (u_tumorOnly != 0
        ? 0.55 + 0.45 * edge
        : 0.15 + 0.85 * edge));
      if (u_tumorOnly != 0) {
        a *= smoothSurface ? smoothstep(0.45, 0.55, labelCoverage) : smoothstep(0.12, 0.78, labelCoverage);
      }

      // Convert to per-step opacity; dt keeps opacity roughly stable as step count changes.
      float emphasis = u_tumorOnly != 0 ? 14.0 : 4.0;
      float aStep = 1.0 - exp(-u_opacity * a * dt * emphasis);
      aStep = saturate(aStep);

      float sampleV = v * shade;

      vec3 sampleColor = vec3(sampleV);

      if (u_labelsEnabled != 0 && lid != 0u) {
        vec3 labelRgb = texelFetch(u_palette, ivec2(int(lid), 0), 0).rgb;
        if (u_tumorOnly != 0) {
          // The mask gates anatomy; it must not replace MRI texture with a synthetic surface.
          float tissue = v * (0.65 + 0.35 * diff);
          sampleColor = mix(vec3(tissue), labelRgb * tissue, 0.10);
        } else {
          float mixK = clamp(u_labelMix * smoothstep(0.35, 0.9, labelCoverage), 0.0, 0.22);
          sampleColor = mix(sampleColor, labelRgb * v, mixK);
          // A separate categorical channel survives foreground tissue. Its
          // final composition shows the selected lesion in anatomical context
          // without making normal MRI opacity authoritative for annotations.
          float boundary = smoothstep(0.35, 0.9, labelCoverage);
          float lesionStep = 1.0 - exp(-u_opacity * max(0.48, val) * dt * 12.0 * boundary);
          lesionAccum += (1.0 - lesionAlpha) * mix(vec3(v), labelRgb * v, 0.35) * lesionStep;
          lesionAlpha += (1.0 - lesionAlpha) * lesionStep;
        }
      }

      accum += (1.0 - aAccum) * sampleColor * aStep;
      aAccum += (1.0 - aAccum) * aStep;

      if (aAccum > 0.98 && (u_labelsEnabled == 0 || u_tumorOnly != 0)) {
        break;
      }
    }
  }

  if (!nativeHit && u_labelsEnabled != 0 && u_tumorOnly == 0 && lesionAlpha > 0.0) {
    vec3 visibleLesion = lesionAccum / max(lesionAlpha, 1e-6);
    accum = mix(accum, visibleLesion, clamp(lesionAlpha * 1.15, 0.0, 0.58));
  }

  // The same plane remains visible through transparent tissue from the reverse
  // side, in the correct depth order rather than drawn over nearer anatomy.
  if (u_clipEnabled != 0 && rd.z > 1e-6 && (!nativeHit || nativeT > t1 + 1e-6) && abs((ro + rd * t1).z - cutZ) < 1e-5) {
    vec4 section = cutSurface(ro + rd * t1, cutPixelWidth);
    accum += (1.0 - aAccum) * section.rgb * section.a;
    aAccum += (1.0 - aAccum) * section.a;
  }
  if (nativeHit) accum += (1.0 - aAccum) * nativeSection.rgb;

  outColor = vec4(clamp(accum, 0.0, 1.0), 1.0);
}`;
