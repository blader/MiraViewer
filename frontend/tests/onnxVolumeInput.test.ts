import { describe, expect, it } from 'vitest';
import type { SvrVolume } from '../src/types/svr';
import { TUMOR_MODEL_MANIFEST_EXAMPLE } from '../src/utils/segmentation/onnx/modelManifest';
import { assertTumorModelGrid, prepareTumorModelInput } from '../src/utils/segmentation/onnx/volumeInput';

const volume = (data: Float32Array): SvrVolume => ({
  data,
  dims: [data.length, 1, 1],
  voxelSizeMm: [1, 1, 1],
  originMm: [0, 0, 0],
  boundsMm: { min: [0, 0, 0], max: [data.length, 1, 1] },
});

describe('ONNX source intensity and geometry contract', () => {
  it('normalizes signed native units independently of narrow display windows and inversion, keeping padding zero', async () => {
    const source: SvrVolume = {
      ...volume(Float32Array.of(-100, 0, 100, 900)),
      observedSupport: Uint8Array.of(1, 1, 1, 0),
      intensityRange: [-100, 100],
      displayWindow: [0, 10],
      displayInvert: true,
    };
    const before = source.data.slice(),
      support = source.observedSupport!.slice();
    const result = await prepareTumorModelInput(source);
    expect(result).toEqual(Float32Array.of(0, 0.5, 1, 0));
    expect(result).not.toBe(source.data);
    expect(await prepareTumorModelInput({ ...source, displayWindow: [-100, 100], displayInvert: false })).toEqual(
      result,
    );
    expect(source.data).toEqual(before);
    expect(source.observedSupport).toEqual(support);
  });

  it('reuses an already normalized buffer when no pixel needs masking or clipping', async () => {
    const source = { ...volume(Float32Array.of(0, 0.5, 1, 0)), observedSupport: Uint8Array.of(1, 1, 1, 0) };
    expect(await prepareTumorModelInput(source)).toBe(source.data);
    const unsupported = { ...source, observedSupport: Uint8Array.of(1, 0, 1, 0) };
    expect(await prepareTumorModelInput(unsupported)).toEqual(Float32Array.of(0, 0, 1, 0));
    expect(source.data).toEqual(Float32Array.of(0, 0.5, 1, 0));
  });

  it('requires an explicit source-grid contract for native, oblique, or anisotropic input without silently resampling', () => {
    const source = volume(Float32Array.of(0.5));
    expect(() => assertTumorModelGrid(source, TUMOR_MODEL_MANIFEST_EXAMPLE)).not.toThrow();
    const native = { ...source, nativeVoxelSizeMm: [1, 1, 1] as [number, number, number] };
    const oblique = { ...source, direction: [0, -1, 0, 1, 0, 0, 0, 0, 1] as const };
    const anisotropic = { ...source, voxelSizeMm: [1, 2, 3] as [number, number, number] };
    for (const candidate of [native, oblique, anisotropic]) {
      expect(() => assertTumorModelGrid(candidate, TUMOR_MODEL_MANIFEST_EXAMPLE)).toThrow(/source-grid.*compatibility/);
      expect(() =>
        assertTumorModelGrid(candidate, {
          ...TUMOR_MODEL_MANIFEST_EXAMPLE,
          input: { channels: 1, axes: 'NCZYX', spatialFrame: 'source-grid' },
        }),
      ).not.toThrow();
      expect(candidate.data).toBe(source.data);
    }
  });

  it('rejects invalid ranges, missing support geometry and nonfinite acquired samples', async () => {
    await expect(prepareTumorModelInput({ ...volume(Float32Array.of(2)), intensityRange: [2, 2] })).rejects.toThrow(
      /finite native intensity range/,
    );
    await expect(
      prepareTumorModelInput({ ...volume(Float32Array.of(0)), observedSupport: new Uint8Array(2) }),
    ).rejects.toThrow(/matching volume dimensions/);
    await expect(prepareTumorModelInput(volume(Float32Array.of(NaN)))).rejects.toThrow(/finite acquired intensities/);
    expect(
      await prepareTumorModelInput({ ...volume(Float32Array.of(NaN)), observedSupport: Uint8Array.of(0) }),
    ).toEqual(Float32Array.of(0));
  });

  it('stops a stale normalization after its yield and never modifies the native input', async () => {
    const source = { ...volume(new Float32Array(65_537).fill(-10)), intensityRange: [-10, 10] as [number, number] };
    let current = true;
    const pending = prepareTumorModelInput(source, () => current);
    current = false;
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    expect(source.data.every((value) => value === -10)).toBe(true);
  });
});
