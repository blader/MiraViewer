import { describe, expect, it, vi } from 'vitest';
import type { SvrVolume } from '../src/types/svr';
import {
  createEnhancedVolumeBinding,
  enhancedTextureFromBase,
  ENHANCED_TEXTURE_BYTES_PER_VOXEL,
  ORIGINAL_ROI_TEXTURE_BYTES_PER_VOXEL,
} from '../src/utils/svr/enhancedVolumeBinding';
import { float32ToFloat16Bits, RAYMARCH_FRAGMENT_SHADER } from '../src/utils/svr/glRaymarch';
import { MAX_SR_OUTPUT_VOXELS, type SvrEnhancedVolume } from '../src/utils/svr/superResolutionTypes';
import { normalizedVolumeWindow } from '../src/utils/svr/volumeDisplay';

function fixture() {
  const original: SvrVolume = {
    data: Float32Array.of(-100, 100),
    observedSupport: Uint8Array.of(1, 1),
    dims: [2, 1, 1],
    originMm: [10, 20, 30],
    voxelSizeMm: [1, 2, 3],
    intensityRange: [-100, 100],
    boundsMm: { min: [9.5, 19, 28.5], max: [11.5, 21, 31.5] },
  };
  const result: SvrEnhancedVolume = {
    ...original,
    data: Float32Array.from({ length: 16 }, (_, index) => (index % 4 < 2 ? -75 : 75)),
    observedSupport: new Uint8Array(16).fill(1),
    dims: [4, 2, 2],
    originMm: [9.75, 19.5, 29.25],
    voxelSizeMm: [0.5, 1, 1.5],
    stats: {
      method: 'synthetic-render-fixture',
      trainingSamples: 0,
      calibrationSamples: 0,
      heldOutSamples: 0,
      trainingBlocks: 0,
      calibrationBlocks: 0,
      heldOutBlocks: 0,
      baselineMse: 0,
      enhancedMse: 0,
      consistencyMaxError: 0,
      durationMs: 0,
      modelStrength: 1,
    },
  };
  return { original, result };
}

function textureGl() {
  return {
    NO_ERROR: 0,
    TEXTURE0: 100,
    TEXTURE_3D: 101,
    UNPACK_ALIGNMENT: 102,
    UNPACK_ROW_LENGTH: 103,
    UNPACK_IMAGE_HEIGHT: 104,
    UNPACK_SKIP_PIXELS: 105,
    UNPACK_SKIP_ROWS: 106,
    UNPACK_SKIP_IMAGES: 107,
    TEXTURE_MIN_FILTER: 108,
    TEXTURE_MAG_FILTER: 109,
    TEXTURE_WRAP_S: 110,
    TEXTURE_WRAP_T: 111,
    TEXTURE_WRAP_R: 112,
    NEAREST: 113,
    LINEAR: 114,
    CLAMP_TO_EDGE: 115,
    R16F: 116,
    R8: 117,
    RED: 118,
    HALF_FLOAT: 119,
    UNSIGNED_BYTE: 120,
    MAX_3D_TEXTURE_SIZE: 121,
    createTexture: vi.fn(() => ({})),
    deleteTexture: vi.fn(),
    getUniformLocation: vi.fn((_program, name: string) => name),
    activeTexture: vi.fn(),
    bindTexture: vi.fn(),
    pixelStorei: vi.fn(),
    texParameteri: vi.fn(),
    texImage3D: vi.fn(),
    getError: vi.fn(() => 0),
    getParameter: vi.fn(() => 2048),
    uniform1i: vi.fn(),
    uniform1f: vi.fn(),
    uniform3f: vi.fn(),
    uniformMatrix4fv: vi.fn(),
  };
}

function map(matrix: Float32Array, point: readonly [number, number, number]) {
  return [0, 1, 2].map(
    (row) => matrix[12 + row]! + point.reduce((sum, value, column) => sum + value * matrix[column * 4 + row]!, 0),
  );
}

/** Decode recorded GPU upload bytes independently of the production encoder. */
function readHalfFloats(data: Uint16Array): number[] {
  return Array.from(data, (bits) => {
    const sign = bits & 0x8000 ? -1 : 1;
    const exponent = (bits >> 10) & 0x1f;
    const fraction = bits & 0x3ff;
    if (exponent === 0x1f) return fraction ? NaN : sign * Infinity;
    return sign * (exponent === 0 ? fraction * 2 ** -24 : (1 + fraction / 1024) * 2 ** (exponent - 15));
  });
}

describe('physical enhanced-region texture mapping', () => {
  it('shares cell-edge FOV at 2x while preserving voxel-center origins and anisotropic pitch', () => {
    const { original, result } = fixture();
    const matrix = enhancedTextureFromBase(original, result);
    for (const point of [
      [0, 0, 0],
      [0.25, 0.5, 0.5],
      [1, 1, 1],
    ] as const) {
      expect(map(matrix, point)).toEqual([...point]);
    }
  });

  it('maps cropped native regions independently of coarse base texture dimensions', () => {
    const { original, result } = fixture();
    const base = {
      ...original,
      dims: [10, 8, 6] as [number, number, number],
      originMm: [7, 16, 27] as [number, number, number],
    };
    const matrix = enhancedTextureFromBase(base, result);
    expect(map(matrix, [3 / 10, 2 / 8, 1 / 6])).toEqual([0, 0, 0]);
    expect(map(matrix, [5 / 10, 3 / 8, 2 / 6])).toEqual([1, 1, 1]);
    expect(map(matrix, [0, 0, 0]).every((value) => value < 0)).toBe(true);
  });

  it('handles distinct rotated/flipped patient grids rather than assuming axis identity', () => {
    const { original, result } = fixture();
    const base = {
      ...original,
      dims: [5, 6, 7] as [number, number, number],
      voxelSizeMm: [2, 3, 4] as [number, number, number],
      direction: [0, -1, 0, 1, 0, 0, 0, 0, 1] as const,
    };
    const enhanced = {
      ...result,
      dims: [8, 10, 12] as [number, number, number],
      originMm: [-12, 40, 24] as [number, number, number],
      voxelSizeMm: [0.5, 1, 2] as [number, number, number],
      direction: [1, 0, 0, 0, -1, 0, 0, 0, 1] as const,
    };
    const matrix = enhancedTextureFromBase(base, enhanced);
    for (const voxel of [
      [0, 0, 0],
      [2, 3, 4],
      [4, 5, 6],
    ]) {
      const patient = [10 - 3 * voxel[1]!, 20 + 2 * voxel[0]!, 30 + 4 * voxel[2]!];
      const expected = [
        ((patient[0]! + 12) / 0.5 + 0.5) / 8,
        (40 - patient[1]! + 0.5) / 10,
        ((patient[2]! - 24) / 2 + 0.5) / 12,
      ];
      const tc = voxel.map((value, axis) => (value + 0.5) / base.dims[axis]!) as [number, number, number];
      map(matrix, tc).forEach((value, axis) => expect(value).toBeCloseTo(expected[axis]!, 6));
    }
  });

  it.each(['spacing', 'origin', 'direction', 'dimensions', 'overflow'] as const)(
    'rejects unsafe %s geometry',
    (kind) => {
      const { original, result } = fixture();
      if (kind === 'spacing') result.voxelSizeMm[0] = 0;
      if (kind === 'origin') result.originMm[0] = NaN;
      if (kind === 'direction') result.direction = [1, 1, 0, 0, 1, 0, 0, 0, 1];
      if (kind === 'dimensions') result.dims[1] = 0.5;
      if (kind === 'overflow') result.originMm[0] = 1e100;
      expect(() => enhancedTextureFromBase(original, result)).toThrow(/geometry|orthonormal|precision/i);
    },
  );
});

describe('bounded enhancement GPU resources', () => {
  it('normalizes through bounded half-float output views without allocating a second full output', () => {
    const input = Float32Array.of(0, 0.5, 1);
    const output = Uint16Array.of(123, 456, 456, 456);
    const target = output.subarray(1);
    expect(float32ToFloat16Bits(input, target)).toBe(target);
    expect(output).toEqual(Uint16Array.of(123, 0, 0x3800, 0x3c00));
    expect(input).toEqual(Float32Array.of(0, 0.5, 1));
    expect(() => float32ToFloat16Bits(input, output)).toThrow(/dimensions/);
  });
  it('uploads separate original/enhanced half-floats with one base normalization and categorical validity', () => {
    const { original, result } = fixture();
    const gl = textureGl();
    const binding = createEnhancedVolumeBinding(gl as unknown as WebGL2RenderingContext, {} as WebGLProgram, {
      ...original,
      displayInvert: true,
    });
    gl.texImage3D.mockClear();
    const before = result.data.slice(),
      sourceBefore = original.data.slice();
    result.intensityRange = [0, 10]; // Must never independently stretch the inferred image.
    result.displayInvert = false;
    binding.upload(result, original);
    expect(gl.texImage3D.mock.calls.map((call) => call[2])).toEqual([gl.R16F, gl.R8, gl.R16F]);
    expect(gl.texImage3D.mock.calls[0]![9]).toEqual(
      float32ToFloat16Bits(Float32Array.from(result.data, (value) => 1 - (value + 100) / 200)),
    );
    expect(gl.texImage3D.mock.calls[1]![9]).toBe(result.observedSupport);
    expect(gl.texImage3D.mock.calls[2]![9]).toEqual(float32ToFloat16Bits(Float32Array.of(1, 0)));
    expect(gl.texParameteri).toHaveBeenCalledWith(gl.TEXTURE_3D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    expect(gl.texParameteri).toHaveBeenCalledWith(gl.TEXTURE_3D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    expect(result.data).toEqual(before);
    expect(original.data).toEqual(sourceBefore);
    binding.dispose();
  });

  it.each([
    { name: 'above-range', values: [150, 200], window: [0, 200], invert: false, displayed: [0.75, 1] },
    { name: 'signed', values: [-50, 150], window: [-100, 200], invert: false, displayed: [1 / 6, 5 / 6] },
    { name: 'inverted signed', values: [-50, 150], window: [-100, 200], invert: true, displayed: [5 / 6, 1 / 6] },
  ])(
    'retains $name native and enhanced intensities until display windowing',
    ({ values, window, invert, displayed }) => {
      const { original, result } = fixture();
      const base: SvrVolume = { ...original, intensityRange: [0, 100], displayInvert: invert };
      original.data.set(values);
      result.data.set(Array.from({ length: result.data.length }, (_, index) => values[index % 4 < 2 ? 0 : 1]!));
      const originalBefore = original.data.slice(),
        enhancedBefore = result.data.slice();
      const gl = textureGl();
      const binding = createEnhancedVolumeBinding(gl as unknown as WebGL2RenderingContext, {} as WebGLProgram, base);
      gl.texImage3D.mockClear();
      binding.upload(result, original);
      const expectedNormalized = values.map((value) => (invert ? 1 - value / 100 : value / 100));
      const [low, high] = normalizedVolumeWindow(base, window as [number, number]);
      // Inspect both real upload payloads. The cut shader applies this final window,
      // so 1.5/2.0 retained in R16F become .75/1 rather than the old flattened .5/.5.
      for (const [call, sampleIndices] of [
        [gl.texImage3D.mock.calls[0]!, [0, 2]],
        [gl.texImage3D.mock.calls[2]!, [0, 1]],
      ] as const) {
        const uploaded = readHalfFloats(call[9] as Uint16Array);
        const samples = sampleIndices.map((index) => uploaded[index]!);
        expect(samples).toEqual(expectedNormalized);
        samples.forEach((value, index) =>
          expect(Math.max(0, Math.min(1, (value - low) / (high - low)))).toBeCloseTo(displayed[index]!, 6),
        );
      }
      expect(original.data).toEqual(originalBefore);
      expect(result.data).toEqual(enhancedBefore);
      binding.dispose();
    },
  );

  it('preserves the positive and negative finite half-float limits without clipping', () => {
    const { original, result } = fixture();
    original.data.set([-65504, 65504]);
    result.data.set(Array.from({ length: result.data.length }, (_, index) => (index % 4 < 2 ? -65504 : 65504)));
    const gl = textureGl();
    const binding = createEnhancedVolumeBinding(gl as unknown as WebGL2RenderingContext, {} as WebGLProgram, {
      ...original,
      intensityRange: [0, 1],
    });
    gl.texImage3D.mockClear();
    binding.upload(result, original);
    expect(readHalfFloats(gl.texImage3D.mock.calls[0]![9] as Uint16Array)).toEqual(Array.from(result.data));
    expect(readHalfFloats(gl.texImage3D.mock.calls[2]![9] as Uint16Array)).toEqual([-65504, 65504]);
    binding.dispose();
  });

  it.each(['original', 'enhanced', 'negative', 'inverted', 'non-finite normalization'] as const)(
    'rejects unrepresentable %s values without publishing a clipped or partial layer',
    (kind) => {
      const { original, result } = fixture();
      const base: SvrVolume = { ...original, intensityRange: [0, 1], displayInvert: kind === 'inverted' };
      if (kind === 'original') original.data[0] = 65505;
      if (kind === 'enhanced') result.data[0] = 65505;
      if (kind === 'negative') result.data[0] = -65505;
      if (kind === 'inverted') result.data[0] = -65504; // Final inverted value is 65505.
      if (kind === 'non-finite normalization') base.intensityRange = [0, Number.MIN_VALUE];
      const originalBefore = original.data.slice(),
        enhancedBefore = result.data.slice();
      const gl = textureGl();
      const binding = createEnhancedVolumeBinding(gl as unknown as WebGL2RenderingContext, {} as WebGLProgram, base);
      expect(() => binding.upload(result, original)).toThrow(/GPU floating-point display range.*native detail/);
      binding.apply({ enabled: true, strength: 1, smoothSurface: true });
      expect(gl.uniform1i).toHaveBeenCalledWith('u_enhancedEnabled', 0);
      expect(gl.uniform1i).toHaveBeenCalledWith('u_enhancedOriginalAvailable', 0);
      expect(gl.texImage3D.mock.calls.slice(-3).every((call) => call.slice(3, 6).every((size) => size === 1))).toBe(
        true,
      );
      expect(original.data).toEqual(originalBefore);
      expect(result.data).toEqual(enhancedBefore);
      binding.dispose();
      binding.dispose();
      expect(gl.deleteTexture).toHaveBeenCalledTimes(3);
    },
  );

  it('switches original/enhanced without reuploading, and retains native original availability while enhanced is off', () => {
    const { original, result } = fixture();
    const gl = textureGl();
    const binding = createEnhancedVolumeBinding(gl as unknown as WebGL2RenderingContext, {} as WebGLProgram, original);
    binding.upload(result, original);
    gl.texImage3D.mockClear();
    binding.upload(result, original);
    binding.apply({ enabled: false, strength: 0.6, smoothSurface: true });
    expect(gl.uniform1i).toHaveBeenCalledWith('u_enhancedEnabled', 0);
    expect(gl.uniform1i).toHaveBeenCalledWith('u_enhancedOriginalAvailable', 1);
    expect(gl.uniform1i).toHaveBeenCalledWith('u_enhancedSmoothSurface', 0);
    binding.apply({ enabled: true, strength: 1.5, smoothSurface: true });
    expect(gl.uniform1i).toHaveBeenCalledWith('u_enhancedVolume', 8);
    expect(gl.uniform1i).toHaveBeenCalledWith('u_enhancedSupport', 9);
    expect(gl.uniform1i).toHaveBeenCalledWith('u_enhancedOriginal', 10);
    expect(gl.uniform1i).toHaveBeenCalledWith('u_enhancedEnabled', 1);
    expect(gl.uniform1f).toHaveBeenCalledWith('u_enhancedStrength', 1);
    expect(gl.uniform3f).toHaveBeenCalledWith('u_enhancedTexel', 0.25, 0.5, 0.5);
    expect(gl.texImage3D).not.toHaveBeenCalled();
    binding.upload(null);
    binding.apply({ enabled: true, strength: 1, smoothSurface: true });
    expect(gl.uniform1i.mock.calls.filter(([name]) => name === 'u_enhancedEnabled').at(-1)).toEqual([
      'u_enhancedEnabled',
      0,
    ]);
    expect(gl.uniform1i.mock.calls.filter(([name]) => name === 'u_enhancedOriginalAvailable').at(-1)).toEqual([
      'u_enhancedOriginalAvailable',
      0,
    ]);
    expect(gl.texImage3D.mock.calls.every((call) => call.slice(3, 6).every((size) => size === 1))).toBe(true);
    binding.dispose();
    binding.dispose();
    expect(gl.deleteTexture).toHaveBeenCalledTimes(3);
  });

  it.each(['origin', 'pitch', 'direction', 'dimensions', 'support'] as const)(
    'rejects an unfair native-original comparison with mismatched %s',
    (kind) => {
      const { original, result } = fixture();
      const gl = textureGl();
      const binding = createEnhancedVolumeBinding(
        gl as unknown as WebGL2RenderingContext,
        {} as WebGLProgram,
        original,
      );
      if (kind === 'origin') result.originMm[0] += 0.25;
      if (kind === 'pitch') result.voxelSizeMm[0] *= 1.1;
      if (kind === 'direction') result.direction = [0, -1, 0, 1, 0, 0, 0, 0, 1];
      if (kind === 'dimensions') original.dims = [1, 2, 1];
      if (kind === 'support') result.observedSupport[0] = 0;
      expect(() => binding.upload(result, original)).toThrow(/same physical region|source footprint/);
      binding.apply({ enabled: true, strength: 1, smoothSurface: true });
      expect(gl.uniform1i).toHaveBeenCalledWith('u_enhancedEnabled', 0);
      expect(gl.uniform1i).toHaveBeenCalledWith('u_enhancedOriginalAvailable', 0);
      binding.dispose();
    },
  );

  it('keeps invalid footprint values out of intensity interpolation and refuses non-finite supported predictions', () => {
    const { original, result } = fixture();
    const gl = textureGl();
    const binding = createEnhancedVolumeBinding(gl as unknown as WebGL2RenderingContext, {} as WebGLProgram, original);
    result.observedSupport[0] = 0;
    result.data[0] = NaN;
    binding.upload(result);
    binding.apply({ enabled: true, strength: 1, smoothSurface: false });
    expect(gl.uniform1i).toHaveBeenCalledWith('u_enhancedAllSupported', 0);
    expect((gl.texImage3D.mock.calls[3]![9] as Uint16Array)[0]).toBe(0);
    const invalid = { ...result, observedSupport: new Uint8Array(result.data.length).fill(1) };
    expect(() => binding.upload(invalid)).toThrow(/non-finite supported/);
    binding.apply({ enabled: true, strength: 1, smoothSurface: true });
    expect(gl.uniform1i).toHaveBeenCalledWith('u_enhancedEnabled', 0);
    binding.dispose();
  });

  it('rejects oversized GPU uploads and the shared output cap without silent downsampling', () => {
    const { original, result } = fixture();
    const gl = textureGl();
    const binding = createEnhancedVolumeBinding(gl as unknown as WebGL2RenderingContext, {} as WebGLProgram, original);
    gl.getParameter.mockReturnValue(2);
    expect(() => binding.upload(result)).toThrow(/2-voxel.*not been downsampled/);
    expect(() => binding.upload({ ...result, dims: [MAX_SR_OUTPUT_VOXELS + 1, 1, 1] })).toThrow(
      /memory budget.*not been downsampled/,
    );
    expect(ENHANCED_TEXTURE_BYTES_PER_VOXEL * 8 + ORIGINAL_ROI_TEXTURE_BYTES_PER_VOXEL).toBe(26);
    binding.dispose();
  });

  it('disables partially uploaded layers and releases partially allocated textures on failure', () => {
    const { original, result } = fixture();
    const gl = textureGl();
    const binding = createEnhancedVolumeBinding(gl as unknown as WebGL2RenderingContext, {} as WebGLProgram, original);
    gl.getError.mockReturnValueOnce(0).mockReturnValueOnce(1285);
    expect(() => binding.upload(result, original)).toThrow(/GPU could not upload/);
    binding.apply({ enabled: true, strength: 1, smoothSurface: true });
    expect(gl.uniform1i).toHaveBeenCalledWith('u_enhancedEnabled', 0);
    expect(gl.uniform1i).toHaveBeenCalledWith('u_enhancedOriginalAvailable', 0);
    binding.dispose();
    gl.createTexture.mockReturnValueOnce({}).mockReturnValueOnce(null as unknown as object);
    expect(() =>
      createEnhancedVolumeBinding(gl as unknown as WebGL2RenderingContext, {} as WebGLProgram, original),
    ).toThrow(/could not allocate/);
    expect(gl.deleteTexture).toHaveBeenCalledTimes(4);
  });

  it('keeps enhanced sampling out of the original MRI plane and bypasses stale base occupancy for either comparison', () => {
    const shader = RAYMARCH_FRAGMENT_SHADER;
    const native = shader.slice(shader.indexOf('vec4 nativeSurface'), shader.indexOf('void main()'));
    expect(native).not.toContain('displayedIntensity');
    expect(native).not.toContain('u_enhanced');
    expect(shader).toContain('u_enhancedEnabled == 0 && u_enhancedOriginalAvailable == 0');
    expect(shader).toContain('enhancedFootprintValid(enhancedTc, 2)');
    expect(shader).toContain('enhancedFootprintValid(enhancedTc, 1)');
    expect(shader).toContain('gradient * vec3(size) / u_box');
  });

  it('owns continuous cut isolation in compositing, not categorical intensity/normal taps', () => {
    const shader = RAYMARCH_FRAGMENT_SHADER;
    const field = shader.slice(shader.indexOf('float displayedIntensity'), shader.indexOf('void addLesionSample'));
    expect(field).not.toContain('u_labels');
    const cut = shader.slice(shader.indexOf('vec4 cutSurface'), shader.indexOf('bool intersectBox'));
    expect(cut).toContain('lesionCoverage(tc, label)');
    expect(cut).toContain('smoothstep(0.5 - 0.5 * width, 0.5 + 0.5 * width, coverage)');
    expect(cut).toContain('selected ? displayedIntensity(tc) : texture(u_vol, tc).r');
    expect(shader).toContain('outColor = vec4(section.rgb * section.a, 1.0)');
    expect(shader.indexOf('cutPixelWidth = fwidth')).toBeLessThan(shader.indexOf('if (nativeHit && u_nativeCutaway'));
    expect(shader).toContain('selected ? displayedIntensity(xp) : texture(u_vol, xp).r');
  });

  it('keeps continuous selection isolation without lighting tissue from coarse categorical cells', () => {
    const shader = RAYMARCH_FRAGMENT_SHADER;
    const lighting = shader.slice(shader.indexOf('vec3 normalGradient'), shader.indexOf('float shade ='));
    expect(lighting).toContain('grad / max(d * u_box');
    expect(lighting).not.toContain('lesionGradient');
    expect(lighting).not.toContain('labelCoverage');
    expect(shader).toContain('smoothstep(0.45, 0.55, labelCoverage)');
    expect(shader).toContain('dot(abs(lesionGradient(tc) * u_box), pixelWidth)');
  });
});
