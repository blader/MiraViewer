import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SeriesFrameManifest } from '../src/utils/localApi';

const decode = vi.hoisted(() => ({
  load: vi.fn(async (imageId: string) => ({ imageId, rows: 12, columns: 16 })),
  resample: vi.fn((_image: unknown, rows: number, cols: number) => new Float32Array(rows * cols).fill(1)),
}));

vi.mock('../src/utils/decodedFrame', () => ({
  loadCornerstoneImage: decode.load,
  resampleDecodedImage: decode.resample,
}));

import {
  measureLongitudinalPlaneDrift,
  prepareDenseLongitudinalResliceInput,
  prepareLongitudinalRegistrationInput,
} from '../src/utils/svr/longitudinalFrames';

function makeManifest(
  seriesUid: string,
  count: number,
  options: { angleDeg?: number; patientKey?: string } = {},
): SeriesFrameManifest {
  const angle = ((options.angleDeg ?? 0) * Math.PI) / 180;
  return {
    seriesUid,
    studyUid: `${seriesUid}-study`,
    patientKey: options.patientKey ?? 'same-patient',
    frameOfReferenceUid: `${seriesUid}-frame`,
    frames: Array.from({ length: count }, (_, index) => ({
      sopInstanceUid: `${seriesUid}-${index}`,
      seriesInstanceUid: seriesUid,
      studyInstanceUid: `${seriesUid}-study`,
      instanceNumber: index,
      rows: 12,
      columns: 16,
      imagePositionPatient: `0\\0\\${index}`,
      imageOrientationPatient: `${Math.cos(angle)}\\0\\${Math.sin(angle)}\\0\\1\\0`,
      pixelSpacing: '2\\3',
      sliceThickness: 1.2,
      physicalSlicePosition: index,
    })),
  };
}

describe('svr/longitudinalFrames', () => {
  beforeEach(() => {
    decode.load.mockClear();
    decode.resample.mockClear();
  });

  it('decodes bounded physical stacks while retaining the exact selected reference and source provenance', async () => {
    const result = await prepareLongitudinalRegistrationInput(
      makeManifest('reference', 21),
      makeManifest('target', 21),
      7,
      {
        maxDimension: 8,
        maxSlices: 5,
      },
    );

    expect(result.referenceSourceIndices).toEqual([0, 7, 10, 15, 20]);
    expect(result.targetSourceIndices).toEqual([0, 5, 10, 15, 20]);
    expect(result.referenceSliceIndex).toBe(1);
    expect(result.referenceSlices).toHaveLength(5);
    expect(result.targetSlices).toHaveLength(5);
    expect(decode.load).toHaveBeenCalledTimes(10);
    expect(decode.load).toHaveBeenCalledWith('miradb:reference-7');

    const selected = result.referenceSlices[result.referenceSliceIndex]!;
    expect(selected.dsRows).toBe(6);
    expect(selected.dsCols).toBe(8);
    expect(selected.rowSpacingDsMm).toBe(4);
    expect(selected.colSpacingDsMm).toBe(6);
    expect(selected.ippMm).toEqual({ x: 1.5, y: 1, z: 7 });
    expect(selected.sliceThicknessMm).toBe(1.2);
    expect(selected.spacingBetweenSlicesMm).toBe(1);
    expect(selected.frameOfReferenceUid).toBe('reference-frame');
  });

  it('rejects cross-patient manifests and aborted requests before decoding', async () => {
    await expect(
      prepareLongitudinalRegistrationInput(
        makeManifest('reference', 4, { patientKey: 'patient-a' }),
        makeManifest('target', 4, { patientKey: 'patient-b' }),
        1,
      ),
    ).rejects.toThrow('same patient');

    const controller = new AbortController();
    controller.abort();
    await expect(
      prepareLongitudinalRegistrationInput(makeManifest('reference', 4), makeManifest('target', 4), 1, {
        signal: controller.signal,
      }),
    ).rejects.toThrow('cancelled');
    expect(decode.load).not.toHaveBeenCalled();
  });

  it('preserves only the selected native reference while bounding both global scoring stacks', async () => {
    const result = await prepareLongitudinalRegistrationInput(
      makeManifest('reference', 9),
      makeManifest('target', 9),
      3,
      {
        maxDimension: 8,
        outputMaxDimension: 512,
        maxSlices: 5,
      },
    );

    expect(result.referenceSlices[result.referenceSliceIndex]).toMatchObject({
      dsRows: 12,
      dsCols: 16,
      rowSpacingDsMm: 2,
      colSpacingDsMm: 3,
      ippMm: { x: 0, y: 0, z: 3 },
    });
    expect(
      result.referenceSlices
        .filter((_, index) => index !== result.referenceSliceIndex)
        .every((slice) => slice.dsRows === 6 && slice.dsCols === 8),
    ).toBe(true);
    expect(result.targetSlices.every((slice) => slice.dsRows === 6 && slice.dsCols === 8)).toBe(true);
    expect(decode.load).toHaveBeenCalledTimes(10);
    expect(result.referenceSlices.reduce((bytes, slice) => bytes + slice.pixels.byteLength, 0)).toBeLessThan(
      5 * 12 * 16 * Float32Array.BYTES_PER_ELEMENT,
    );
  });

  it('measures physical through-plane drift independently of distinct frame origins', () => {
    const drift = measureLongitudinalPlaneDrift(
      makeManifest('reference', 3),
      makeManifest('target', 3, { angleDeg: 18 }),
    );

    expect(drift.angleDegrees).toBeCloseTo(18, 6);
    expect(drift.maximumThroughPlaneDriftMm).toBeCloseTo(Math.sin((18 * Math.PI) / 180) * 22.5, 6);
    expect(drift.frameRelationship).toBe('different');
  });

  it('selects every native target slice intersecting a transformed reference plane and its interpolation guard', async () => {
    const prepared = await prepareLongitudinalRegistrationInput(
      makeManifest('reference', 101),
      makeManifest('target', 101, { angleDeg: 18 }),
      50,
      { maxDimension: 8, outputMaxDimension: 512, maxSlices: 9 },
    );
    decode.load.mockClear();
    const selected = prepared.referenceSlices[prepared.referenceSliceIndex]!;
    // The coarse registration worker owns and detaches this buffer. Dense
    // presentation requires only its immutable plane geometry.
    structuredClone(selected.pixels, { transfer: [selected.pixels.buffer] });
    expect(selected.pixels.byteLength).toBe(0);

    const dense = await prepareDenseLongitudinalResliceInput(
      makeManifest('target', 101, { angleDeg: 18 }),
      selected,
      { tx: 0, ty: 0, tz: 0, rx: 0, ry: 0, rz: 0 },
      { x: 0, y: 0, z: 0 },
      { maxSlices: 96, maxDimension: 512 },
    );

    expect(dense.sourceIndices.length).toBeGreaterThan(10);
    expect(dense.sourceIndices.length).toBeLessThan(30);
    for (let index = 1; index < dense.sourceIndices.length; index++) {
      expect(dense.sourceIndices[index]! - dense.sourceIndices[index - 1]!).toBe(1);
    }
    expect(dense.targetSlices.every((slice) => slice.dsRows === 12 && slice.dsCols === 16)).toBe(true);
    expect(dense.referencePlane).not.toHaveProperty('pixels');
    expect(decode.load).toHaveBeenCalledTimes(dense.sourceIndices.length);
  });

  it('refuses to silently sparsify a reference plane exceeding its native-slice safety budget', async () => {
    const prepared = await prepareLongitudinalRegistrationInput(
      makeManifest('reference', 101),
      makeManifest('target', 101, { angleDeg: 18 }),
      50,
      { maxSlices: 5 },
    );
    decode.load.mockClear();

    await expect(
      prepareDenseLongitudinalResliceInput(
        makeManifest('target', 101, { angleDeg: 18 }),
        prepared.referenceSlices[prepared.referenceSliceIndex]!,
        { tx: 0, ty: 0, tz: 0, rx: 0, ry: 0, rz: 0 },
        { x: 0, y: 0, z: 0 },
        { maxSlices: 3 },
      ),
    ).rejects.toThrow('native-slice safety budget');
    expect(decode.load).not.toHaveBeenCalled();
  });

  it('rejects a flipped native target frame that sparse coarse sampling did not inspect', async () => {
    const prepared = await prepareLongitudinalRegistrationInput(
      makeManifest('reference', 101),
      makeManifest('target', 101),
      50,
      { maxSlices: 5 },
    );
    const target = makeManifest('target', 101);
    target.frames[50] = {
      ...target.frames[50]!,
      imageOrientationPatient: '-1\\0\\0\\0\\1\\0',
    };
    decode.load.mockClear();

    await expect(
      prepareDenseLongitudinalResliceInput(
        target,
        prepared.referenceSlices[prepared.referenceSliceIndex]!,
        { tx: 0, ty: 0, tz: 0, rx: 0, ry: 0, rz: 0 },
        { x: 0, y: 0, z: 0 },
      ),
    ).rejects.toThrow('orientation');
    expect(decode.load).not.toHaveBeenCalled();
  });
});
