import { validateOutputPlaneGrid, type OutputPlaneGrid } from './outputPlaneGrid';
import type { SharpSliceStack } from './sharpSliceSynthesis';
import { resliceStackToReferencePlane, type LongitudinalReferencePlane } from './svr/longitudinalRegistration';
import type { SvrReconstructionSlice } from './svr/reconstructionCore';
import type { RigidParams } from './svr/rigidRegistration';
import { assertNotAborted } from './svr/svrUtils';
import { dot, v3, type Vec3 } from './svr/vec3';

/** Additional ownership for this experiment; native resolution is never reduced to fit. */
export const MAX_SHARP_SLICE_WORKING_BYTES = 96 * 1024 * 1024;
export const sharpSliceWorkingBytes = (frames: number, nativePixels: number, outputPixels = 0) =>
  (frames + 3) * nativePixels * 5 + outputPixels * 10 + 8 * 1024 * 1024;

export type SharpSliceDisplayResult = {
  pixels: Float32Array;
  valid: Uint8Array;
  rows: number;
  columns: number;
  stats: { method: string; durationMs: number };
};

export type SharpSlicePresentationInput = {
  slices: SvrReconstructionSlice[];
  referencePlane: LongitudinalReferencePlane;
  outputGrid: OutputPlaneGrid;
  targetToReference: RigidParams;
  centerMm: Vec3;
  /** Read-only ordinary aligned presentation, including its exact acquired-support mask. */
  baselinePixels: Float32Array;
  baselineValid?: Uint8Array;
};

/** Native grid correspondence is checked before any higher-order reconstruction. */
export function nativeSharpSliceStack(slices: readonly SvrReconstructionSlice[]): SharpSliceStack {
  const first = slices[0];
  if (!first || slices.length < 4) throw new Error('Sharp slices need at least four neighboring native images.');
  for (const slice of slices) {
    const delta = v3(slice.ippMm.x - first.ippMm.x, slice.ippMm.y - first.ippMm.y, slice.ippMm.z - first.ippMm.z);
    if (
      slice.dsRows !== first.dsRows ||
      slice.dsCols !== first.dsCols ||
      Math.abs(slice.rowSpacingDsMm - first.rowSpacingDsMm) > 1e-6 ||
      Math.abs(slice.colSpacingDsMm - first.colSpacingDsMm) > 1e-6 ||
      dot(slice.rowDir, first.rowDir) < 0.999999 ||
      dot(slice.colDir, first.colDir) < 0.999999 ||
      dot(slice.normalDir, first.normalDir) < 0.999999 ||
      Math.abs(dot(delta, first.rowDir)) > first.colSpacingDsMm * 0.01 ||
      Math.abs(dot(delta, first.colDir)) > first.rowSpacingDsMm * 0.01 ||
      slice.frameOfReferenceUid !== first.frameOfReferenceUid
    )
      throw new Error('Sharp slices require a consistent native image grid; the original aligned image is unchanged.');
  }
  return {
    rows: first.dsRows,
    columns: first.dsCols,
    slices: slices.map((slice) => ({
      positionMm: dot(slice.ippMm, first.normalDir),
      pixels: slice.pixels,
      valid: slice.valid,
    })),
  };
}

/** Sample the original native stack directly, at the exact accepted plane: no virtual volume or depth quantization. */
export async function renderSharpSlicePresentation(
  input: SharpSlicePresentationInput,
  options: { signal?: AbortSignal; onProgress?: (message: string) => void } = {},
): Promise<SharpSliceDisplayResult> {
  const started = performance.now();
  assertNotAborted(options.signal);
  validateOutputPlaneGrid(input.outputGrid);
  const count = input.outputGrid.rows * input.outputGrid.columns;
  if (input.baselinePixels.length !== count || (input.baselineValid && input.baselineValid.length !== count))
    throw new Error('The sharp slice no longer matches its original aligned plane.');
  const stack = nativeSharpSliceStack(input.slices);
  if (sharpSliceWorkingBytes(input.slices.length, stack.rows * stack.columns, count) > MAX_SHARP_SLICE_WORKING_BYTES)
    throw new Error(
      'This plane needs too much native context for sharp synthesis. The original aligned image remains available.',
    );
  if (
    input.slices.some(
      (slice) =>
        slice.pixels.length !== stack.rows * stack.columns ||
        (slice.valid && slice.valid.length !== slice.pixels.length),
    )
  )
    throw new Error('The sharp slice source dimensions or support do not match.');
  options.onProgress?.('Reconstructing the sharper aligned plane…');
  assertNotAborted(options.signal);
  const result = resliceStackToReferencePlane({
    targetSlices: input.slices,
    referenceSlice: input.referencePlane,
    outputGrid: input.outputGrid,
    targetToReference: input.targetToReference,
    centerMm: input.centerMm,
    signal: options.signal,
    interpolation: 'bounded-cubic',
  });
  const valid = input.baselineValid ? Uint8Array.from(input.baselineValid) : new Uint8Array(count).fill(1);
  for (let index = 0; index < count; index++) {
    if (!valid[index] || !result.valid[index] || !Number.isFinite(result.pixels[index]))
      result.pixels[index] = input.baselinePixels[index]!;
  }
  return {
    pixels: result.pixels,
    valid,
    rows: input.outputGrid.rows,
    columns: input.outputGrid.columns,
    stats: { method: 'Bounded cubic interpolation', durationMs: performance.now() - started },
  };
}
