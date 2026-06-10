/**
 * WebGL2 ray-marching shader + helpers for the SVR 3D viewer.
 *
 * The camera constants (CAM_Z / FOCAL_Z) must match `projectWorldToCanvas` in the 2D axes
 * overlay or the overlay will drift relative to the rendered volume.
 */

import { clamp } from '../math';

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

/**
 * Convert float32 samples to IEEE 754 half-float bit patterns for HALF_FLOAT texture upload
 * (WebGL2 requires the data view for HALF_FLOAT to be a Uint16Array of raw f16 bits).
 *
 * Bit-twiddling port of the classic public-domain float->half routine: reads the f32 bits
 * directly through a Uint32Array view (no per-element scratch writes), keeps the top 11
 * mantissa bits and rounds to nearest. Volume data is normalized ~[0,1], so the
 * subnormal/overflow branches are correctness backstops rather than hot paths.
 */
export function float32ToFloat16Bits(src: Float32Array): Uint16Array {
  const n = src.length;
  const out = new Uint16Array(n);
  // Float32Array is always 4-byte aligned, so reinterpreting its buffer is safe.
  const words = new Uint32Array(src.buffer, src.byteOffset, n);

  for (let i = 0; i < n; i++) {
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

  return out;
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
export function buildOccupancyMaxGrid(params: {
  data: Float32Array | Uint8Array;
  dims: { nx: number; ny: number; nz: number };
  blockSize?: number;
}): { data: Uint8Array; dims: { nx: number; ny: number; nz: number } } {
  const { data, dims } = params;
  const B = Math.max(2, Math.round(params.blockSize ?? SVR3D_OCC_BLOCK));

  const ox = Math.max(1, Math.ceil(dims.nx / B));
  const oy = Math.max(1, Math.ceil(dims.ny / B));
  const oz = Math.max(1, Math.ceil(dims.nz / B));

  // Uint8Array sources are raw R8 texel bytes (the GPU sees byte/255); Float32Array
  // sources are normalized intensities. Track the max in source units, quantize at the end.
  const isU8 = data instanceof Uint8Array;

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
        const v = data[base + x] ?? 0;
        const oi = oBase + ((x / B) | 0);
        if (v > rawMax[oi]!) rawMax[oi] = v;
      }
    }
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
  }

  return { data: out, dims: { nx: ox, ny: oy, nz: oz } };
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
uniform usampler3D u_labels;
uniform sampler2D u_palette;
uniform int u_labelsEnabled;
uniform float u_labelMix;

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

const float CAM_Z = ${SVR3D_CAMERA_Z};
const float FOCAL_Z = ${SVR3D_FOCAL_Z};

float saturate(float x) {
  return clamp(x, 0.0, 1.0);
}

float radial01(vec3 pos) {
  // pos is in object space centered at the volume centroid.
  // Normalize by the half box extents so r=1 is approximately the box surface (clamped).
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

  // Rotate ray into volume/object space (the volume is rotated; rays go the other way).
  vec3 ro = u_invRot * roW;
  vec3 rd = u_invRot * rdW;

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
  // occPad bounds how much the radial coordinate can change across one occupancy cell
  // (cell size in r-units is 2x its size in texture units, since r normalizes by the half
  // box): subtracting it from r gives a threshold floor valid for the entire cell.
  vec3 occCellSizeTc = vec3(float(u_occBlock)) * u_texel;
  float occPad = 2.0 * length(occCellSizeTc);
  vec3 rdTc = rd / u_box;
  vec3 aRdTc = abs(rdTc) + 1e-12;

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

    if (u_occEnabled != 0) {
      // Empty-space skipping: if even the lowest threshold anywhere in this occupancy
      // cell exceeds the cell's conservative max, no sample in the cell can pass the
      // visibility test below — leap the ray to the cell exit instead of sampling the
      // full-res volume texture step by step through background.
      ivec3 vox = ivec3(clamp(tc, 0.0, 1.0) / u_texel);
      ivec3 cell = clamp(vox / u_occBlock, ivec3(0), u_occMaxCell);
      float occMax = texelFetch(u_occ, cell, 0).r;
      float thrFloor = saturate(u_thr * saturate(r - occPad));

      if (thrFloor > 0.0 && occMax < thrFloor) {
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
