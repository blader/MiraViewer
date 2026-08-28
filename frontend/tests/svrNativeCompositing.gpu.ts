/**
 * Browser-only pixel regressions for the actual production shader. Import from
 * the running Vite app and call runSvrSliceGpuProbe(); jsdom cannot execute GLSL.
 * This synthetic fixture is independent of private MRI visual validation.
 */
import {
  createNativePlaneBinding,
  createProgram,
  RAYMARCH_FRAGMENT_SHADER,
  RAYMARCH_VERTEX_SHADER,
  SVR3D_CAMERA_Z,
} from '../src/utils/svr/glRaymarch';
import type { NativePlaneData } from '../src/utils/svr/nativePlane';

export function runSvrSliceGpuProbe() {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 64;
  const gl = canvas.getContext('webgl2', { antialias: false, alpha: false, depth: false });
  if (!gl) throw new Error('The native-cutaway pixel tests require WebGL2.');
  const checks: { name: string; passed: boolean; detail: unknown }[] = [];
  const record = (name: string, passed: boolean, detail: unknown) => checks.push({ name, passed, detail });
  const textures: WebGLTexture[] = [];
  const program = createProgram(gl, RAYMARCH_VERTEX_SHADER, RAYMARCH_FRAGMENT_SHADER);
  const native = createNativePlaneBinding(gl, program);
  const vao = gl.createVertexArray();
  const buffer = gl.createBuffer();
  const n = 16;
  const source = {
    seriesUid: 'gpu-phantom',
    label: 'Synthetic GPU fixture',
    kind: 'original-3d' as const,
    transform: { rotation: [1, 0, 0, 0, 1, 0, 0, 0, 1] as const, translationMm: [0, 0, 0] as const },
    contributingSopInstanceUids: ['gpu-frame'],
    frames: [
      {
        sopInstanceUid: 'gpu-frame',
        rows: 64,
        columns: 64,
        originMm: [0, 0, 0] as const,
        columnDirection: [1, 0, 0] as const,
        rowDirection: [0, 1, 0] as const,
        pixelSpacingMm: [1, 1] as const,
      },
    ],
  };
  const plane = (value = 0.24, z = 0): NativePlaneData => ({
    source,
    frame: source.frames[0]!,
    frameIndex: 0,
    image: {
      pixels: new Float32Array(64 * 64).fill(value),
      validity: new Float32Array(64 * 64).fill(1),
      rows: 64,
      cols: 64,
      imageId: 'miradb:gpu-frame',
      seriesUid: 'gpu-phantom',
      sopInstanceUid: 'gpu-frame',
    },
    origin: [-1.96875, -1.96875, z],
    columnStep: [0.0625, 0, 0],
    rowStep: [0, 0.0625, 0],
    windowRange: [0, 1],
    invert: false,
  });
  const u = (name: string) => gl.getUniformLocation(program, `u_${name}`);
  const integer = (name: string, value: number) => gl.uniform1i(u(name), value);
  const scalar = (name: string, value: number) => gl.uniform1f(u(name), value);
  const front = [1, 0, 0, 0, -1, 0, 0, 0, -1];
  const back = [1, 0, 0, 0, 1, 0, 0, 0, 1];
  const volume = new Float32Array(n ** 3).fill(0.7);
  const support = new Uint8Array(n ** 3).fill(255);
  const labels = new Uint8Array(n ** 3);
  const mask = new Uint8Array(64 * 64);
  const texture3d = (slot: number, data: Float32Array | Uint8Array, categorical = false) => {
    const texture = gl.createTexture();
    if (!texture) throw new Error('GPU fixture texture allocation failed.');
    textures.push(texture);
    gl.activeTexture(gl.TEXTURE0 + slot);
    gl.bindTexture(gl.TEXTURE_3D, texture);
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    for (const axis of [gl.TEXTURE_WRAP_S, gl.TEXTURE_WRAP_T, gl.TEXTURE_WRAP_R])
      gl.texParameteri(gl.TEXTURE_3D, axis, gl.CLAMP_TO_EDGE);
    gl.texImage3D(
      gl.TEXTURE_3D,
      0,
      categorical ? gl.R8UI : data instanceof Float32Array ? gl.R32F : gl.R8,
      n,
      n,
      n,
      0,
      categorical ? gl.RED_INTEGER : gl.RED,
      data instanceof Float32Array ? gl.FLOAT : gl.UNSIGNED_BYTE,
      data,
    );
    return texture;
  };
  const update = (slot: number, texture: WebGLTexture, data: Float32Array | Uint8Array, categorical = false) => {
    gl.activeTexture(gl.TEXTURE0 + slot);
    gl.bindTexture(gl.TEXTURE_3D, texture);
    gl.texSubImage3D(
      gl.TEXTURE_3D,
      0,
      0,
      0,
      0,
      n,
      n,
      n,
      categorical ? gl.RED_INTEGER : gl.RED,
      data instanceof Float32Array ? gl.FLOAT : gl.UNSIGNED_BYTE,
      data,
    );
  };
  const draw = (rotation: number[] = front) => {
    gl.uniformMatrix3fv(u('invRot'), false, rotation);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    const pixels = new Uint8Array(64 * 64 * 4);
    gl.readPixels(0, 0, 64, 64, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
    const error = gl.getError();
    if (error !== gl.NO_ERROR) throw new Error(`Production shader GPU error: ${error}`);
    return pixels;
  };
  const red = (pixels: Uint8Array, x = 32, y = 32) => pixels[(y * 64 + x) * 4]!;
  const identical = (a: Uint8Array, b: Uint8Array) => a.every((value, index) => value === b[index]);

  try {
    gl.useProgram(program);
    gl.bindVertexArray(vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    const position = gl.getAttribLocation(program, 'a_pos');
    gl.enableVertexAttribArray(position);
    gl.vertexAttribPointer(position, 2, gl.FLOAT, false, 0, 0);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    const volumeTexture = texture3d(0, volume);
    const labelTexture = texture3d(1, labels, true);
    texture3d(3, new Float32Array(n ** 3).fill(1));
    const supportTexture = texture3d(4, support);
    const palette = gl.createTexture();
    if (!palette) throw new Error('GPU fixture palette allocation failed.');
    textures.push(palette);
    gl.activeTexture(gl.TEXTURE2);
    gl.bindTexture(gl.TEXTURE_2D, palette);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, 256, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array(1024).fill(255));
    for (const [name, slot] of [
      ['vol', 0],
      ['labels', 1],
      ['palette', 2],
      ['occ', 3],
      ['support', 4],
    ] as const)
      integer(name, slot);
    integer('supportEnabled', 1);
    integer('steps', 256);
    scalar('windowWidth', 1);
    scalar('cameraZ', SVR3D_CAMERA_Z);
    scalar('aspect', 1);
    scalar('zoom', 1.4);
    scalar('thr', 0.05);
    scalar('gamma', 1);
    scalar('opacity', 4);
    gl.uniform3f(u('box'), 1, 1, 1);
    gl.uniform3f(u('texel'), 1 / n, 1 / n, 1 / n);
    gl.viewport(0, 0, 64, 64);
    native.bind({ enabled: false });
    const baseline = draw();
    record('Control volume is visible', red(baseline) > 10, { center: red(baseline) });

    native.setPlane(plane());
    native.bind({ enabled: true, cutaway: true, contour: false });
    const cutFront = draw();
    record('Original MRI gray is exact on the exposed cap', Math.abs(red(cutFront) - 0.24 * 255) < 1, {
      expected: 0.24 * 255,
      actual: red(cutFront),
    });
    record('Full source field cannot draw outside the reconstructed object', red(cutFront, 0, 0) === 0, {
      outsideVolume: red(cutFront, 0, 0),
    });
    const cutBack = draw(back);
    record('Retained anatomy stays in front of the cap when viewed from behind', red(cutBack) > red(cutFront) + 5, {
      front: red(cutFront),
      back: red(cutBack),
    });

    const removedHalfChanged = volume.slice();
    // Leave the cut's gradient footprint intact: these samples are strictly
    // inside the removed half, not inputs to retained-surface lighting.
    removedHalfChanged.fill(0, 0, n * n * (n / 2 - 2));
    update(0, volumeTexture, removedHalfChanged);
    const sameHalfSpace = draw(back);
    record('Orbiting preserves the same physical cut half-space', identical(cutBack, sameHalfSpace), {
      changedOnlyRemovedHalf: true,
      samePixels: identical(cutBack, sameHalfSpace),
    });
    update(0, volumeTexture, volume);

    native.setPlane(plane(0.9, -0.9));
    native.bind({ enabled: true, cutaway: true });
    const outside = draw();
    record('A source plane outside the volume neither replaces nor erases it', identical(baseline, outside), {
      control: red(baseline),
      outsidePlane: red(outside),
    });

    const invalid = plane();
    invalid.image.validity.fill(0);
    native.setPlane(invalid);
    native.bind({ enabled: true, cutaway: false });
    const invalidPixels = draw();
    record('Invalid native pixels do not obscure valid reconstructed tissue', identical(baseline, invalidPixels), {
      control: red(baseline),
      invalidPlane: red(invalidPixels),
    });
    native.setPlane(plane());
    native.bind({ enabled: true, cutaway: true });
    update(
      4,
      supportTexture,
      support.map(() => 0),
    );
    const unsupported = draw();
    record('Unsupported reconstruction cells cannot acquire an MRI cap', red(unsupported) === 0, red(unsupported));
    update(4, supportTexture, support);

    update(0, volumeTexture, new Float32Array(n ** 3));
    native.setPlane(plane(0.9));
    native.bind({ enabled: true, cutaway: true });
    const air = draw();
    record(
      'Valid background follows volume visibility instead of forming a rectangular sheet',
      red(air) === 0,
      red(air),
    );
    update(0, volumeTexture, volume);

    integer('tumorOnly', 1);
    integer('labelsEnabled', 1);
    native.setPlane(plane(), mask);
    native.bind({ enabled: true, cutaway: true, selectionOnly: false, contour: false });
    const emptySelection = draw();
    record('Global selection-only also masks the native image', red(emptySelection) === 0, red(emptySelection));
    labels.fill(1);
    update(1, labelTexture, labels, true);
    mask.fill(1);
    const dark = plane(0);
    const originalPixels = dark.image.pixels.slice();
    native.setPlane(dark, mask);
    native.bind({ enabled: true, cutaway: true, windowRange: [-1, 1], contour: false });
    update(0, volumeTexture, new Float32Array(n ** 3));
    const darkSelected = draw();
    record(
      'Selected zero-valued MRI samples remain visible and source-windowed',
      Math.abs(red(darkSelected) - 127.5) < 1,
      { expected: 127.5, actual: red(darkSelected) },
    );
    native.bind({ enabled: true, cutaway: true, windowRange: [-1, 3], invert: true, contour: false });
    const inverted = draw();
    record('Source window and inversion apply exactly once', Math.abs(red(inverted) - 191.25) < 1, {
      expected: 191.25,
      actual: red(inverted),
    });
    record(
      'Rendering never changes original MRI samples',
      dark.image.pixels.every((v, i) => v === originalPixels[i]),
      { unchanged: dark.image.pixels.every((v, i) => v === originalPixels[i]) },
    );

    integer('focusEnabled', 1);
    gl.uniform3f(u('focusMin'), 0.25, -0.25, -0.25);
    gl.uniform3f(u('focusMax'), 0.45, 0.25, 0.25);
    const focused = draw();
    record('Selection focus bounds constrain the cap as well as the volume', red(focused) === 0, red(focused));
    integer('focusEnabled', 0);
    integer('clipEnabled', 1);
    scalar('clipZ', 0.25);
    native.setPlane(plane(0.9), mask);
    native.bind({ enabled: true, cutaway: false, contour: false });
    const axialClipped = draw();
    native.bind({ enabled: false });
    const axialControl = draw();
    record(
      'An existing axial clip cannot be overpainted by an excluded native plane',
      identical(axialClipped, axialControl),
      { native: red(axialClipped), control: red(axialControl) },
    );
    const extension = gl.getExtension('WEBGL_debug_renderer_info');
    return {
      passed: checks.every((check) => check.passed),
      checks,
      renderer: extension ? gl.getParameter(extension.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER),
    };
  } finally {
    native.dispose();
    textures.forEach((texture) => gl.deleteTexture(texture));
    gl.deleteBuffer(buffer);
    gl.deleteVertexArray(vao);
    gl.deleteProgram(program);
    gl.getExtension('WEBGL_lose_context')?.loseContext();
  }
}
