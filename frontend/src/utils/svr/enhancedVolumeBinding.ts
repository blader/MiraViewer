import type { SvrVolume } from '../../types/svr';
import { clamp } from '../math';
import { float32ToFloat16Bits } from './glRaymarch';
import { MAX_SR_OUTPUT_VOXELS, type SvrEnhancedVolume } from './superResolutionTypes';
import { IDENTITY_DIRECTION, patientToVolumeVoxel, volumeVoxelToPatient } from './volumeGeometry';

/** Additional GPU residency, separate from retained native MRI/labels and model workspaces. */
export const ENHANCED_TEXTURE_BYTES_PER_VOXEL = 3;
export const ORIGINAL_ROI_TEXTURE_BYTES_PER_VOXEL = 2;
/** Bounded normalization scratch; the half-float upload buffer is also transient. */
export const ENHANCED_NORMALIZATION_SCRATCH_BYTES = 131_072 * Float32Array.BYTES_PER_ELEMENT;

type Grid = Pick<SvrVolume, 'dims' | 'originMm' | 'voxelSizeMm' | 'direction'>;

function validateGrid(grid: Grid): void {
  const direction = grid.direction ?? IDENTITY_DIRECTION;
  if (
    grid.dims.length !== 3 ||
    grid.dims.some((value) => !Number.isSafeInteger(value) || value < 1) ||
    grid.originMm.length !== 3 ||
    !grid.originMm.every(Number.isFinite) ||
    grid.voxelSizeMm.length !== 3 ||
    grid.voxelSizeMm.some((value) => !Number.isFinite(value) || value <= 0) ||
    direction.length !== 9 ||
    !direction.every(Number.isFinite)
  )
    throw new Error('The enhanced MRI grid must have finite physical geometry and positive dimensions.');
  for (let axis = 0; axis < 3; axis++)
    for (let other = axis; other < 3; other++) {
      const dot = [0, 1, 2].reduce((sum, row) => sum + direction[row * 3 + axis]! * direction[row * 3 + other]!, 0);
      if (Math.abs(dot - (axis === other ? 1 : 0)) > 1e-4)
        throw new Error('The enhanced MRI grid directions must be orthonormal.');
    }
}

/** Column-major base texture -> enhanced texture coordinates, including pixel-center origins. */
export function enhancedTextureFromBase(base: Grid, enhanced: Grid): Float32Array {
  validateGrid(base);
  validateGrid(enhanced);
  const map = (tc: [number, number, number]) => {
    const voxel = tc.map((value, axis) => value * base.dims[axis]! - 0.5) as [number, number, number];
    return patientToVolumeVoxel(enhanced, volumeVoxelToPatient(base, voxel)).map(
      (value, axis) => (value + 0.5) / enhanced.dims[axis]!,
    ) as [number, number, number];
  };
  const offset = map([0, 0, 0]);
  const columns = [
    [1, 0, 0],
    [0, 1, 0],
    [0, 0, 1],
  ].flatMap((axis) => [...map(axis as [number, number, number]).map((value, row) => value - offset[row]!), 0]);
  const matrix = new Float32Array([...columns, ...offset, 1]);
  if (!matrix.every(Number.isFinite)) throw new Error('The enhanced MRI geometry exceeds finite GPU precision.');
  return matrix;
}

function validateOriginalPair(result: SvrEnhancedVolume, original: SvrVolume): void {
  validateGrid(original);
  const direction = original.direction ?? IDENTITY_DIRECTION;
  const enhancedDirection = result.direction ?? IDENTITY_DIRECTION;
  const origin = volumeVoxelToPatient(original, [-0.25, -0.25, -0.25]);
  if (
    result.dims.some((value, axis) => value !== original.dims[axis]! * 2) ||
    result.voxelSizeMm.some((value, axis) => Math.abs(value * 2 - original.voxelSizeMm[axis]!) > 1e-6) ||
    result.originMm.some((value, axis) => Math.abs(value - origin[axis]!) > 1e-5) ||
    enhancedDirection.some((value, index) => Math.abs(value - direction[index]!) > 1e-6) ||
    original.data.length !== original.dims.reduce((product, value) => product * value, 1) ||
    (original.observedSupport && original.observedSupport.length !== original.data.length)
  )
    throw new Error('Original and enhanced MRI must describe the same physical region at exactly 2x sampling.');
}

export type EnhancedVolumeDisplay = { enabled: boolean; strength: number; smoothSurface: boolean };
export type EnhancedVolumeBinding = {
  upload(result: SvrEnhancedVolume | null, original?: SvrVolume | null): void;
  apply(display: EnhancedVolumeDisplay): void;
  dispose(): void;
};

/** Owns only an optional display layer; never writes native samples, support, labels or measurements. */
export function createEnhancedVolumeBinding(
  gl: WebGL2RenderingContext,
  program: WebGLProgram,
  baseVolume: SvrVolume,
): EnhancedVolumeBinding {
  const uniforms = Object.fromEntries(
    [
      'Volume',
      'Support',
      'Original',
      'OriginalAvailable',
      'Enabled',
      'Strength',
      'SmoothSurface',
      'AllSupported',
      'FromBase',
      'Dims',
      'Texel',
    ].map((name) => [name, gl.getUniformLocation(program, `u_enhanced${name}`)]),
  );
  const textures: WebGLTexture[] = [];
  let current: SvrEnhancedVolume | null = null;
  let currentOriginal: SvrVolume | null = null;
  let matrix: Float32Array = new Float32Array(16);
  let texel: [number, number, number] = [1, 1, 1];
  let allSupported = false;
  let disposed = false;

  const uploadTexture = (slot: number, dims: readonly number[], data: Uint16Array | Uint8Array) => {
    gl.activeTexture(gl.TEXTURE0 + 8 + slot);
    gl.bindTexture(gl.TEXTURE_3D, textures[slot]!);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.pixelStorei(gl.UNPACK_ROW_LENGTH, 0);
    gl.pixelStorei(gl.UNPACK_IMAGE_HEIGHT, 0);
    gl.pixelStorei(gl.UNPACK_SKIP_PIXELS, 0);
    gl.pixelStorei(gl.UNPACK_SKIP_ROWS, 0);
    gl.pixelStorei(gl.UNPACK_SKIP_IMAGES, 0);
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_WRAP_R, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MIN_FILTER, slot === 1 ? gl.NEAREST : gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MAG_FILTER, slot === 1 ? gl.NEAREST : gl.LINEAR);
    gl.texImage3D(
      gl.TEXTURE_3D,
      0,
      slot === 1 ? gl.R8 : gl.R16F,
      dims[0]!,
      dims[1]!,
      dims[2]!,
      0,
      gl.RED,
      slot === 1 ? gl.UNSIGNED_BYTE : gl.HALF_FLOAT,
      data,
    );
    if (gl.getError() !== gl.NO_ERROR)
      throw new Error('The GPU could not upload the enhanced MRI region. Original MRI remains available.');
    gl.bindTexture(gl.TEXTURE_3D, null);
  };
  const resetTextures = () => {
    uploadTexture(0, [1, 1, 1], new Uint16Array(1));
    uploadTexture(1, [1, 1, 1], new Uint8Array(1));
    uploadTexture(2, [1, 1, 1], new Uint16Array(1));
  };
  const uploadIntensity = (
    slot: number,
    source: Pick<SvrVolume, 'data' | 'dims' | 'observedSupport'>,
    original?: SvrVolume | null,
  ) => {
    const [low, high] = baseVolume.intensityRange ?? [0, 1];
    if (!Number.isFinite(low) || !Number.isFinite(high) || high <= low)
      throw new Error('The original MRI display range must be finite and increasing.');
    const count = source.data.length;
    const normalized = new Float32Array(Math.min(count, ENHANCED_NORMALIZATION_SCRATCH_BYTES / 4));
    const half = new Uint16Array(count);
    let supported = 0;
    for (let start = 0; start < count; start += normalized.length) {
      const length = Math.min(normalized.length, count - start);
      for (let index = 0; index < length; index++) {
        const position = start + index;
        const valid = !source.observedSupport || source.observedSupport[position]! > 0;
        if (valid && !Number.isFinite(source.data[position]))
          throw new Error(
            'The enhanced MRI region contains non-finite supported intensities. Original MRI remains available.',
          );
        if (original) {
          const x = position % source.dims[0],
            yz = Math.floor(position / source.dims[0]);
          const parent =
            (Math.floor(yz / source.dims[1] / 2) * original.dims[1] + Math.floor((yz % source.dims[1]) / 2)) *
              original.dims[0] +
            Math.floor(x / 2);
          if (valid !== (!original.observedSupport || original.observedSupport[parent]! > 0))
            throw new Error('Enhanced MRI validity does not match the original source footprint.');
        }
        supported += valid ? 1 : 0;
        // Native detail can exceed the overview's sampled range. Preserve it in
        // floating point; only the selected display window may clip intensities.
        const value = valid ? (source.data[position]! - low) / (high - low) : 0;
        const displayValue = valid && baseVolume.displayInvert ? 1 - value : value;
        if (!Number.isFinite(displayValue) || Math.abs(displayValue) > 65504)
          throw new Error(
            'The MRI region exceeds the GPU floating-point display range. Open native detail for this selection before enhancing; original MRI remains available.',
          );
        normalized[index] = displayValue;
      }
      float32ToFloat16Bits(normalized.subarray(0, length), half.subarray(start, start + length));
    }
    if (!supported) throw new Error('The enhanced MRI region has no valid source footprint. Select supported tissue.');
    uploadTexture(slot, source.dims, half);
    return supported === count;
  };
  try {
    for (let slot = 0; slot < 3; slot++) {
      const texture = gl.createTexture();
      if (!texture) throw new Error('The GPU could not allocate the enhanced MRI region.');
      textures.push(texture);
    }
    resetTextures();
  } catch (error) {
    for (const texture of textures) gl.deleteTexture(texture);
    throw error;
  }

  return {
    upload(result, original = null) {
      if (disposed) throw new Error('The enhanced MRI renderer has been disposed.');
      if (result === current && original === currentOriginal) return;
      current = null;
      currentOriginal = null;
      try {
        if (!result) {
          resetTextures();
          return;
        }
        const nextMatrix = enhancedTextureFromBase(baseVolume, result);
        const count = result.dims.reduce((product, value) => product * value, 1);
        if (!Number.isSafeInteger(count) || count > MAX_SR_OUTPUT_VOXELS)
          throw new Error(
            'The enhanced MRI region exceeds the bounded display-memory budget. Select a smaller region; it has not been downsampled.',
          );
        const maximum = Number(gl.getParameter(gl.MAX_3D_TEXTURE_SIZE));
        if (!Number.isFinite(maximum) || maximum < 1 || result.dims.some((value) => value > maximum))
          throw new Error(
            `The enhanced MRI region exceeds this GPU's ${maximum || 'available'}-voxel 3D texture limit. Select a smaller region; it has not been downsampled.`,
          );
        if (result.data.length !== count || result.observedSupport.length !== count)
          throw new Error('Enhanced MRI samples and source-footprint validity must match their declared grid.');
        if (original) validateOriginalPair(result, original);
        allSupported = uploadIntensity(0, result, original);
        uploadTexture(1, result.dims, result.observedSupport);
        if (original) uploadIntensity(2, original);
        else uploadTexture(2, [1, 1, 1], new Uint16Array(1));
        matrix = nextMatrix;
        texel = [0, 1, 2].map(
          (axis) => 1 / Math.hypot(...[0, 1, 2].map((row) => matrix[axis * 4 + row]! * result.dims[row]!)),
        ) as [number, number, number];
        current = result;
        currentOriginal = original;
      } catch (error) {
        // No mixed old geometry/new pixels can be drawn after a partial upload.
        try {
          resetTextures();
        } catch {
          /* The original failure is the actionable one. */
        }
        throw error;
      }
    },
    apply(display) {
      if (disposed) return;
      for (let slot = 0; slot < 3; slot++) {
        gl.activeTexture(gl.TEXTURE0 + 8 + slot);
        gl.bindTexture(gl.TEXTURE_3D, textures[slot]!);
        gl.uniform1i(uniforms[['Volume', 'Support', 'Original'][slot]!]!, 8 + slot);
      }
      const enabled = display.enabled && current !== null;
      gl.uniform1i(uniforms.Enabled!, enabled ? 1 : 0);
      gl.uniform1i(uniforms.OriginalAvailable!, currentOriginal ? 1 : 0);
      gl.uniform1i(uniforms.SmoothSurface!, enabled && display.smoothSurface ? 1 : 0);
      gl.uniform1i(uniforms.AllSupported!, allSupported ? 1 : 0);
      gl.uniform1f(uniforms.Strength!, Number.isFinite(display.strength) ? clamp(display.strength, 0, 1) : 0);
      gl.uniformMatrix4fv(uniforms.FromBase!, false, matrix);
      gl.uniform3f(uniforms.Dims!, ...(current?.dims ?? [1, 1, 1]));
      gl.uniform3f(uniforms.Texel!, ...texel);
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      current = null;
      currentOriginal = null;
      for (const texture of textures) gl.deleteTexture(texture);
      textures.length = 0;
    },
  };
}
