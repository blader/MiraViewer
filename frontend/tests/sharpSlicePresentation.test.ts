import { describe, expect, it, vi } from 'vitest';
import { buildOutputPlaneGrid } from '../src/utils/outputPlaneGrid';
import {
  nativeSharpSliceStack,
  renderSharpSlicePresentation,
  type SharpSlicePresentationInput,
} from '../src/utils/sharpSlicePresentation';
import { resliceStackToReferencePlane } from '../src/utils/svr/longitudinalRegistration';
import type { SvrReconstructionSlice } from '../src/utils/svr/reconstructionCore';
import { v3 } from '../src/utils/svr/vec3';

const size = 16;
const signalAt = (x: number, y: number, z: number) => 100 + x + 2 * y + z * z;

function slices(): SvrReconstructionSlice[] {
  return Array.from({ length: 9 }, (_, index) => {
    const z = index - 4;
    return {
      pixels: Float32Array.from({ length: size * size }, (_, i) => signalAt(i % size, Math.floor(i / size), z)),
      valid: new Uint8Array(size * size).fill(1),
      dsRows: size,
      dsCols: size,
      ippMm: v3(0, 0, z),
      rowDir: v3(1, 0, 0),
      colDir: v3(0, 1, 0),
      normalDir: v3(0, 0, 1),
      rowSpacingDsMm: 1,
      colSpacingDsMm: 1,
      sliceThicknessMm: 1,
      spacingBetweenSlicesMm: 1,
      sopInstanceUid: `source-${index}`,
      frameOfReferenceUid: 'target-space',
    };
  });
}

function fixture(positionMm = 0.5): SharpSlicePresentationInput {
  const source = slices();
  const referencePlane = { ...source[4]!, ippMm: v3(0, 0, positionMm), sopInstanceUid: 'reference' };
  const outputGrid = buildOutputPlaneGrid({
    rows: size,
    columns: size,
    imagePositionPatient: `0\\0\\${positionMm}`,
    imageOrientationPatient: '1\\0\\0\\0\\1\\0',
    pixelSpacing: '1\\1',
    sopInstanceUid: 'reference',
    frameOfReferenceUid: 'reference-space',
  });
  const targetToReference = { tx: 0, ty: 0, tz: 0, rx: 0, ry: 0, rz: 0 };
  const centerMm = v3(7.5, 7.5, 0);
  const baseline = resliceStackToReferencePlane({ targetSlices: source, referenceSlice: referencePlane, outputGrid });
  return {
    slices: source,
    referencePlane,
    outputGrid,
    targetToReference,
    centerMm,
    baselinePixels: baseline.pixels,
    baselineValid: baseline.valid,
  };
}

describe('sharp native slab presentation', () => {
  it('reconstructs physical intermediate planes without changing source buffers or their order', async () => {
    const input = fixture();
    const before = input.slices.map((slice) => slice.pixels.slice());
    const baseline = input.baselinePixels.slice();
    const result = await renderSharpSlicePresentation(input);
    for (let y = 1; y < size - 1; y++)
      for (let x = 1; x < size - 1; x++) {
        const i = y * size + x;
        expect(baseline[i]).toBe(signalAt(x, y, 0) + 0.5);
        expect(result.pixels[i]).toBe(signalAt(x, y, 0.5));
      }
    expect(result.valid).toEqual(input.baselineValid);
    expect(input.baselinePixels).toEqual(baseline);
    input.slices.forEach((slice, index) => expect(slice.pixels).toEqual(before[index]));
    expect(result.pixels.buffer).not.toBe(input.baselinePixels.buffer);
    expect(result.stats.method).toBe('Bounded cubic interpolation');
  });

  it.each([-1, 0, 2])('preserves acquired pixel centers exactly at depth %s', async (depth) => {
    const input = fixture(depth);
    const result = await renderSharpSlicePresentation(input);
    expect(result.pixels).toEqual(input.baselinePixels);
    expect(result.valid).toEqual(input.baselineValid);
  });

  it('uses the accepted inverse transform rather than shifting the reference geometry', async () => {
    const input = fixture(1.5);
    input.targetToReference.tz = 1;
    input.targetToReference.tx = 1;
    const baseline = resliceStackToReferencePlane({
      targetSlices: input.slices,
      referenceSlice: input.referencePlane,
      outputGrid: input.outputGrid,
      targetToReference: input.targetToReference,
      centerMm: input.centerMm,
    });
    input.baselinePixels = baseline.pixels;
    input.baselineValid = baseline.valid;
    const grid = structuredClone(input.outputGrid);
    const result = await renderSharpSlicePresentation(input);
    expect(result.pixels[7 * size + 7]).toBe(signalAt(6, 7, 0.5));
    expect(result.valid).toEqual(baseline.valid);
    expect(input.outputGrid).toEqual(grid);
  });

  it('samples the exact oblique physical grid without fractional-depth quantization', async () => {
    const input = fixture();
    const angle = Math.asin(0.1);
    const cosine = Math.cos(angle);
    input.outputGrid = buildOutputPlaneGrid({
      rows: size,
      columns: size,
      imagePositionPatient: '0\\0\\-0.5',
      imageOrientationPatient: `${cosine}\\0\\0.1\\0\\1\\0`,
      pixelSpacing: '1\\1',
    });
    const baseline = resliceStackToReferencePlane({
      targetSlices: input.slices,
      referenceSlice: input.referencePlane,
      outputGrid: input.outputGrid,
    });
    input.baselinePixels = baseline.pixels;
    input.baselineValid = baseline.valid;
    const result = await renderSharpSlicePresentation(input);
    // A cubic reconstruction represents the quadratic field directly at every non-quarter depth.
    for (let x = 1; x < size - 1; x++) {
      const i = 7 * size + x;
      const truth = signalAt(x * cosine, 7, -0.5 + x * 0.1);
      expect(Math.abs(result.pixels[i]! - truth)).toBeLessThan(1e-4);
    }
    expect(result.valid).toEqual(baseline.valid);
  });

  it('never expands support or replaces unsupported baseline pixels with synthetic tissue', async () => {
    const input = fixture();
    input.baselineValid![55] = 0;
    input.baselinePixels[55] = -123;
    input.slices[4]!.valid![99] = 0;
    const result = await renderSharpSlicePresentation(input);
    expect(result.valid).toEqual(input.baselineValid);
    expect(result.pixels[55]).toBe(-123);
    expect(result.pixels[99]).toBe(input.baselinePixels[99]);
  });

  it('does not synthesize through known acquisition gaps', async () => {
    const input = fixture();
    input.slices.forEach((slice) => {
      slice.sliceThicknessMm = 0.2;
    });
    const baseline = resliceStackToReferencePlane({
      targetSlices: input.slices,
      referenceSlice: input.referencePlane,
      outputGrid: input.outputGrid,
    });
    input.baselinePixels = baseline.pixels;
    input.baselineValid = baseline.valid;
    const progress = vi.fn();
    const result = await renderSharpSlicePresentation(input, { onProgress: progress });
    expect(progress).toHaveBeenCalledOnce();
    expect(result.pixels).toEqual(baseline.pixels);
    expect(result.valid.every((value) => value === 0)).toBe(true);
  });

  it.each(['spacing', 'orientation', 'translation', 'frameOfReference'] as const)(
    'rejects non-corresponding native pixel grids: %s',
    (change) => {
      const source = slices();
      if (change === 'spacing') source[3]!.rowSpacingDsMm = 2;
      if (change === 'orientation') source[3]!.rowDir = v3(0, 1, 0);
      if (change === 'translation') source[3]!.ippMm.x = 0.02;
      if (change === 'frameOfReference') source[3]!.frameOfReferenceUid = 'other-space';
      expect(() => nativeSharpSliceStack(source)).toThrow('consistent native image grid');
    },
  );

  it('cancels without producing a replacement image', async () => {
    const abort = new AbortController();
    const input = fixture();
    await expect(
      renderSharpSlicePresentation(input, {
        signal: abort.signal,
        onProgress: () => abort.abort(),
      }),
    ).rejects.toThrow(/cancelled/i);
  });

  it('rejects mismatched baseline geometry and over-budget native context before synthesis', async () => {
    const input = fixture();
    await expect(renderSharpSlicePresentation({ ...input, baselinePixels: new Float32Array(2) })).rejects.toThrow(
      'original aligned plane',
    );
    // Metadata-only oversized fixture proves admission happens before pixel processing/allocation.
    input.slices.forEach((slice) => {
      slice.dsRows = slice.dsCols = 2048;
    });
    await expect(renderSharpSlicePresentation(input)).rejects.toThrow('too much native context');
  });
});
