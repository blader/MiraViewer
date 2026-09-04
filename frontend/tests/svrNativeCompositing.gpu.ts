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
  SVR3D_FOCAL_Z,
} from '../src/utils/svr/glRaymarch';
import { makeNativePlaneData, projectNativePlaneMask, type NativePlaneData } from '../src/utils/svr/nativePlane';
import type { SvrLabelVolume, SvrNativeSource, SvrVolume } from '../src/types/svr';

export function runSvrSliceGpuProbe() {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 64;
  const gl = canvas.getContext('webgl2', { antialias: false, alpha: false, depth: false });
  if (!gl) throw new Error('The embedded MRI slice pixel tests require WebGL2.');
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

    native.bind({ enabled: true });
    const noPlane = draw();
    record('A missing MRI plane leaves the complete model unchanged', identical(baseline, noPlane), {
      samePixels: identical(baseline, noPlane),
    });
    native.setPlane(plane());
    native.bind({ enabled: true, contour: false });
    const embedded = draw();
    record('Full source field cannot draw outside the reconstructed object', red(embedded, 0, 0) === 0, {
      outsideVolume: red(embedded, 0, 0),
    });

    // Independent calibrated-luminance oracle: no 0.7 opacity, foreground fog,
    // or far-side tissue is allowed to change the acquired sample in exact mode.
    for (const [value, low, high, invert] of [
      [0, 0, 1, false],
      [1, 0, 1, false],
      [0.3, 0, 1, false],
      [-2, -4, 0, false],
      [0.25, 0, 1, true],
      [0, 0, 0, false],
      [0, 0, 0, true],
    ] as const) {
      const normalized = high > low ? Math.max(0, Math.min(1, (value - low) / (high - low))) : Number(value > low);
      const expected = Math.round(255 * (invert ? 1 - normalized : normalized));
      native.setPlane(plane(value));
      native.bind({ enabled: true, exact: true, windowRange: [low, high], invert, contour: false });
      for (const rotation of [front, back]) {
        const pixels = draw(rotation);
        const actual = [...pixels.slice((32 * 64 + 32) * 4, (32 * 64 + 32) * 4 + 3)];
        record(
          `Exact plane ${value} window [${low},${high}] invert=${invert} ${rotation === front ? 'front' : 'back'}`,
          actual.every((channel) => Math.abs(channel - expected) <= 1),
          { actual, expected },
        );
      }
    }
    native.setPlane(plane());
    native.bind({ enabled: true, exact: false, contour: false });

    // A near-transparent gap separates the tissue slabs and source section. A
    // change behind the section cannot alter foreground gradient lighting.
    // Dense foreground would normally terminate the march before the far slab.
    const gap = 0.051; // Above the section's visibility threshold, below meaningful model density.
    scalar('opacity', 40);
    for (const [name, rotation, nearStart, farStart] of [
      ['front', front, 0, 10],
      ['back', back, 10, 0],
    ] as const) {
      const bothSlabs = new Float32Array(n ** 3).fill(gap);
      bothSlabs.fill(0.9, n * n * nearStart, n * n * (nearStart + 6));
      bothSlabs.fill(0.7, n * n * farStart, n * n * (farStart + 6));
      update(0, volumeTexture, bothSlabs);
      const wholeModel = draw(rotation);
      const nearOnly = bothSlabs.slice();
      nearOnly.fill(gap, n * n * farStart, n * n * (farStart + 6));
      update(0, volumeTexture, nearOnly);
      const withoutFarTissue = draw(rotation);
      record(
        `Far tissue remains visible through the fixed MRI section from the ${name}`,
        red(wholeModel) > red(withoutFarTissue) + 5,
        { wholeModel: red(wholeModel), withoutFarTissue: red(withoutFarTissue), sourceGray: 0.24 },
      );
      const farOnly = bothSlabs.slice();
      farOnly.fill(gap, n * n * nearStart, n * n * (nearStart + 6));
      update(0, volumeTexture, farOnly);
      const withoutNearTissue = draw(rotation);
      record(
        `Foreground model context remains visible from the ${name}`,
        Math.abs(red(wholeModel) - red(withoutNearTissue)) > 5,
        { wholeModel: red(wholeModel), withoutNearTissue: red(withoutNearTissue), sourceGray: 0.24 },
      );
    }
    scalar('opacity', 4);
    update(0, volumeTexture, volume);

    native.setPlane(plane(0.9, -0.9));
    native.bind({ enabled: true });
    const outside = draw();
    record('A source plane outside the volume neither replaces nor erases it', identical(baseline, outside), {
      control: red(baseline),
      outsidePlane: red(outside),
    });

    const invalid = plane();
    invalid.image.validity.fill(0);
    native.setPlane(invalid);
    native.bind({ enabled: true });
    const invalidPixels = draw();
    record('Invalid native pixels do not obscure valid reconstructed tissue', identical(baseline, invalidPixels), {
      control: red(baseline),
      invalidPlane: red(invalidPixels),
    });
    native.setPlane(plane());
    native.bind({ enabled: true });
    update(4, supportTexture, new Uint8Array(support.length));
    const unsupported = draw();
    record('Unsupported reconstruction cells cannot acquire an MRI section', red(unsupported) === 0, red(unsupported));
    update(4, supportTexture, support);

    update(0, volumeTexture, new Float32Array(n ** 3));
    native.setPlane(plane(0.9));
    native.bind({ enabled: true });
    const air = draw();
    record(
      'Valid background follows volume visibility instead of forming a rectangular sheet',
      red(air) === 0,
      red(air),
    );
    update(0, volumeTexture, volume);

    native.setPlane(plane(), mask);
    native.bind({ enabled: true, selectionOnly: true, contour: false });
    const offMask = draw();
    record('Off-mask MRI pixels neither clip nor fade the full model', identical(baseline, offMask), {
      samePixels: identical(baseline, offMask),
    });
    integer('tumorOnly', 1);
    integer('labelsEnabled', 1);
    native.bind({ enabled: true, selectionOnly: false, contour: false });
    const emptySelection = draw();
    record('Global selection-only also masks the native image', red(emptySelection) === 0, red(emptySelection));
    labels.fill(1);
    update(1, labelTexture, labels, true);
    mask.fill(1);
    const dark = plane(0);
    const originalPixels = dark.image.pixels.slice();
    native.setPlane(dark, mask);
    native.bind({ enabled: true, windowRange: [-1, 1], contour: false });
    update(0, volumeTexture, new Float32Array(n ** 3));
    scalar('opacity', 0); // Isolate source windowing from independently shaded volume context.
    const darkSelected = draw();
    record(
      'Selected zero-valued MRI samples remain visible and source-windowed',
      Math.abs(red(darkSelected) - 0.7 * 127.5) < 1,
      { expected: 0.7 * 127.5, actual: red(darkSelected) },
    );
    native.bind({ enabled: true, windowRange: [-1, 3], invert: true, contour: false });
    const inverted = draw();
    record('Source window and inversion apply exactly once', Math.abs(red(inverted) - 0.7 * 191.25) < 1, {
      expected: 0.7 * 191.25,
      actual: red(inverted),
    });
    record(
      'Rendering never changes original MRI samples',
      dark.image.pixels.every((v, i) => v === originalPixels[i]),
      { unchanged: dark.image.pixels.every((v, i) => v === originalPixels[i]) },
    );
    native.setPlane(plane(-2), mask);
    native.bind({ enabled: true, windowRange: [-4, 0], contour: false });
    const signed = draw();
    record('Negative source samples preserve their signed display window', Math.abs(red(signed) - 0.7 * 127.5) < 1, {
      expected: 0.7 * 127.5,
      actual: red(signed),
    });
    native.setPlane(plane(-0), mask);
    native.bind({ enabled: true, windowRange: [0, 0], contour: false });
    const thresholdZero = draw();
    native.bind({ enabled: true, windowRange: [0, 0], invert: true, contour: false });
    const thresholdInverted = draw();
    record(
      'Width-one threshold treats signed zero as background before inversion',
      red(thresholdZero) === 0 && Math.abs(red(thresholdInverted) - 0.7 * 255) < 1,
      { zero: red(thresholdZero), inverted: red(thresholdInverted), expectedInverted: 0.7 * 255 },
    );

    integer('focusEnabled', 1);
    gl.uniform3f(u('focusMin'), 0.25, -0.25, -0.25);
    gl.uniform3f(u('focusMax'), 0.45, 0.25, 0.25);
    const focused = draw();
    record('Selection focus bounds constrain the section as well as the volume', red(focused) === 0, red(focused));
    integer('focusEnabled', 0);
    integer('clipEnabled', 1);
    scalar('clipZ', 0.25);
    native.setPlane(plane(0.9), mask);
    native.bind({ enabled: true, contour: false });
    const axialClipped = draw();
    native.bind({ enabled: false });
    const axialControl = draw();
    record(
      'An existing axial clip cannot be overpainted by an excluded native plane',
      identical(axialClipped, axialControl),
      { native: red(axialClipped), control: red(axialControl) },
    );
    integer('clipEnabled', 0);

    // A real CPU annotation grid is finer than the GPU label grid. Project its
    // partial selection onto a tilted source with unequal row/column pitch;
    // empty GPU labels must not erase it or turn it into a rectangular sheet.
    const cpuSize = 32;
    const cpuVolume: SvrVolume = {
      data: new Float32Array(cpuSize ** 3).fill(0.7),
      observedSupport: new Uint8Array(cpuSize ** 3).fill(1),
      dims: [cpuSize, cpuSize, cpuSize],
      voxelSizeMm: [1 / cpuSize, 1 / cpuSize, 1 / cpuSize],
      originMm: [-0.5 + 0.5 / cpuSize, -0.5 + 0.5 / cpuSize, -0.5 + 0.5 / cpuSize],
      boundsMm: { min: [-0.5, -0.5, -0.5], max: [0.5, 0.5, 0.5] },
    };
    const cpuLabels: SvrLabelVolume = { data: new Uint8Array(cpuSize ** 3), dims: cpuVolume.dims, meta: [] };
    for (let z = 0; z < cpuSize; z++)
      for (let y = 7; y <= 24; y++)
        for (let x = 7; x <= 24; x++)
          if (!(x >= 14 && x <= 17 && y >= 13 && y <= 18)) cpuLabels.data[(z * cpuSize + y) * cpuSize + x] = 1;
    const obliqueSource: SvrNativeSource = {
      ...source,
      frames: [
        {
          ...source.frames[0]!,
          rows: 48,
          columns: 80,
          originMm: [-0.79, -1.175, -0.5925],
          columnDirection: [0.8, 0, 0.6],
          rowDirection: [0, 1, 0],
          pixelSpacingMm: [0.05, 0.025],
        },
      ],
    };
    const obliqueFrame = obliqueSource.frames[0]!;
    const obliqueImage = {
      ...plane().image,
      rows: obliqueFrame.rows,
      cols: obliqueFrame.columns,
      pixels: new Float32Array(obliqueFrame.rows * obliqueFrame.columns).fill(0.6),
      validity: new Float32Array(obliqueFrame.rows * obliqueFrame.columns).fill(1),
    };
    const obliqueMask = projectNativePlaneMask(cpuVolume, cpuLabels, obliqueSource, obliqueFrame);
    const obliquePlane = makeNativePlaneData(cpuVolume, obliqueSource, 0, obliqueImage);
    labels.fill(0);
    update(1, labelTexture, labels, true);
    native.setPlane(obliquePlane, obliqueMask);
    native.bind({ enabled: true, windowRange: [0, 1], contour: false });
    for (const [name, rotation, cameraSign] of [
      ['front', front, -1],
      ['back', back, 1],
    ] as const) {
      const pixels = draw(rotation);
      let selected = 0,
        offMask = 0,
        outside = 0,
        mismatched = 0;
      let maxError = 0;
      for (let y = 0; y < 64; y++)
        for (let x = 0; x < 64; x++) {
          // Independent closed-form intersection with z = 0.75x. Pixel centers
          // and row reversal match the two camera poses, not the shader's helpers.
          const dx = (((x + 0.5) / 64) * 2 - 1) / 1.4;
          const dy = ((((y + 0.5) / 64) * 2 - 1) / 1.4) * cameraSign;
          const dz = -SVR3D_FOCAL_Z * cameraSign;
          const t = (-SVR3D_CAMERA_Z * cameraSign) / (dz - 0.75 * dx);
          const point = [dx * t, dy * t, SVR3D_CAMERA_Z * cameraSign + dz * t];
          const column = ((point[0]! + 0.79) * 0.8 + (point[2]! + 0.5925) * 0.6) / 0.025;
          const row = (point[1]! + 1.175) / 0.05;
          // Exclude only float32 tie boundaries, not selection edges or holes.
          if ([column, row].some((value) => Math.abs(value + 0.5 - Math.round(value + 0.5)) < 1e-5)) continue;
          const inObject = t > 0 && point.every((value) => value >= -0.5 && value < 0.5);
          const inSource = column >= -0.5 && column < 79.5 && row >= -0.5 && row < 47.5;
          const selectedPixel = inObject && inSource && obliqueMask[Math.round(row) * 80 + Math.round(column)]! > 0;
          if (selectedPixel) selected++;
          else if (inObject && inSource) offMask++;
          else outside++;
          const expected = selectedPixel ? 0.7 * 0.6 * 255 : 0;
          for (let channel = 0; channel < 3; channel++) {
            const error = Math.abs(pixels[(y * 64 + x) * 4 + channel]! - expected);
            maxError = Math.max(maxError, error);
            if (error > 1) mismatched++;
          }
        }
      record(
        `Oblique partial MRI selection matches exact CPU geometry from the ${name} without a sheet`,
        selected > 50 && offMask > 50 && outside > 50 && mismatched === 0,
        { selected, offMask, outside, mismatched, maxError, cpuGrid: cpuSize, gpuGrid: n, sourcePitch: [0.05, 0.025] },
      );
    }
    // Settled draws, including GPU completion, in an explicitly bounded viewport.
    // These are renderer-specific measurements, not inferred speedups or UI latency.
    canvas.width = canvas.height = 512;
    gl.viewport(0, 0, 512, 512);
    const benchmarkSize = 128;
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_3D, volumeTexture);
    gl.texImage3D(
      gl.TEXTURE_3D,
      0,
      gl.R32F,
      benchmarkSize,
      benchmarkSize,
      benchmarkSize,
      0,
      gl.RED,
      gl.FLOAT,
      Float32Array.from(
        { length: benchmarkSize ** 3 },
        (_, index) => 0.5 + 0.2 * Math.sin((index % benchmarkSize) / 12),
      ),
    );
    gl.activeTexture(gl.TEXTURE4);
    gl.bindTexture(gl.TEXTURE_3D, supportTexture);
    gl.texImage3D(
      gl.TEXTURE_3D,
      0,
      gl.R8,
      benchmarkSize,
      benchmarkSize,
      benchmarkSize,
      0,
      gl.RED,
      gl.UNSIGNED_BYTE,
      new Uint8Array(benchmarkSize ** 3).fill(255),
    );
    for (const key of ['clipEnabled', 'labelsEnabled', 'tumorOnly', 'focusEnabled', 'occEnabled']) integer(key, 0);
    integer('steps', 1024);
    scalar('jitter', 0);
    scalar('opacity', 4);
    scalar('windowLow', 0);
    scalar('windowWidth', 1);
    gl.uniform3f(u('texel'), 1 / benchmarkSize, 1 / benchmarkSize, 1 / benchmarkSize);
    gl.uniformMatrix3fv(u('invRot'), false, front);
    native.setPlane(plane());
    const completedPixel = new Uint8Array(4);
    const completeDraw = () => {
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      // gl.finish alone can return after command submission in Chromium. Read
      // an actual center pixel to require the rendered framebuffer's completion.
      gl.readPixels(256, 256, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, completedPixel);
      if (gl.isContextLost() || gl.getError() !== gl.NO_ERROR)
        throw new Error('The GPU timing context did not complete its frame.');
      if (completedPixel[0] === 0)
        throw new Error('The GPU timing frame did not contain the expected synthetic tissue.');
    };
    const settledFrames: { mode: string; elapsedMs: number }[] = [];
    for (const [round, modes] of [
      ['off', 'blended', 'exact'],
      ['exact', 'blended', 'off'],
      ['blended', 'off', 'exact'],
    ].entries()) {
      for (const mode of modes) {
        native.bind({ enabled: mode !== 'off', exact: mode === 'exact', contour: false });
        if (round === 0) completeDraw();
        const started = performance.now();
        completeDraw();
        settledFrames.push({ mode, elapsedMs: performance.now() - started });
      }
    }
    record('Settled frame timing finishes without GPU errors', gl.getError() === gl.NO_ERROR, {
      viewport: [512, 512],
      volume: [128, 128, 128],
      steps: 1024,
      method: 'drawArrays through synchronized center-pixel readPixels',
      settledFrames,
    });
    const extension = gl.getExtension('WEBGL_debug_renderer_info');
    return {
      passed: checks.every((check) => check.passed),
      checks,
      settledFrames,
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
