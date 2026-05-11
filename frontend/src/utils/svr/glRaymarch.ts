/**
 * WebGL2 ray-marching shader + helpers for the SVR 3D viewer.
 *
 * The camera constants (CAM_Z / FOCAL_Z) must match `projectWorldToCanvas` in the 2D axes
 * overlay or the overlay will drift relative to the rendered volume.
 */

export const SVR3D_CAMERA_Z = 1.6;
export const SVR3D_FOCAL_Z = 1.2;

export type VolumeTextureFormat =
  | { kind: 'f32'; internalFormat: number; format: number; type: number; minMagFilter: number }
  | { kind: 'u8'; internalFormat: number; format: number; type: number; minMagFilter: number };

export function chooseVolumeTextureFormat(gl: WebGL2RenderingContext): {
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
