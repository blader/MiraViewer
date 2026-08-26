import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SeriesFrameManifest } from '../src/utils/localApi';

const decode = vi.hoisted(() => ({
  load: vi.fn(async (imageId: string) => ({ imageId, rows: 12, columns: 16 })),
  resample: vi.fn((_image: unknown, rows: number, cols: number) => ({
    pixels: new Float32Array(rows * cols).fill(1),
    validity: new Float32Array(rows * cols).fill(1),
  })),
}));
const denseWorker = vi.hoisted(() => ({ run: vi.fn() }));

vi.mock('../src/utils/decodedFrame', () => ({
  loadCornerstoneImage: decode.load,
  decodeImageWithValidity: decode.resample,
}));
vi.mock('../src/utils/svr/runLongitudinalRegistration', () => ({
  runLongitudinalDenseReslice: denseWorker.run,
}));

import {
  densifyLongitudinalRegistration,
  measureLongitudinalPlaneDrift,
  prepareDenseLongitudinalResliceInput,
  prepareLongitudinalReferenceInput,
  prepareLongitudinalRegistrationInput,
} from '../src/utils/svr/longitudinalFrames';
import {
  attenuateLongitudinalPlaneTilt,
  resliceStackToReferencePlane,
  type LongitudinalRegistrationResult,
} from '../src/utils/svr/longitudinalRegistration';
import { selectPhysicalTargetSlice } from '../src/utils/alignmentGeometry';
import { buildOutputPlaneGrid, outputGridPixelToWorld } from '../src/utils/outputPlaneGrid';
import { applyRigidToPoint, invertRigidParams, mat3FromEulerXYZ } from '../src/utils/svr/rigidRegistration';

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

function acceptedRegistration(overrides: Partial<LongitudinalRegistrationResult> = {}): LongitudinalRegistrationResult {
  return {
    ok: true,
    targetToReference: { tx: 0, ty: 0, tz: 0, rx: 0, ry: 0, rz: 0 },
    centerMm: { x: 0, y: 0, z: 0 },
    diagnostics: {},
    ...overrides,
  } as LongitudinalRegistrationResult;
}

describe('svr/longitudinalFrames', () => {
  beforeEach(() => {
    decode.load.mockClear();
    decode.resample.mockClear();
    denseWorker.run.mockReset();
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
    expect(selected.sopInstanceUid).toBe('reference-7');
    expect(selected.valid?.every((supported) => supported === 1)).toBe(true);
  });

  it('decodes a run-scoped reference stack once while independently transferring each target worker copy', async () => {
    const reference = makeManifest('reference', 21);
    const options = { maxDimension: 8, maxSlices: 5, outputMaxDimension: 16 };
    const preparedReference = await prepareLongitudinalReferenceInput(reference, 7, options);

    expect(decode.load).toHaveBeenCalledTimes(5);
    expect(preparedReference.referenceSourceIndices).toEqual([0, 7, 10, 15, 20]);

    const first = await prepareLongitudinalRegistrationInput(reference, makeManifest('target-a', 21), 7, {
      ...options,
      preparedReference,
    });
    expect(decode.load).toHaveBeenCalledTimes(10);
    expect(first.referenceSlices[1]!.pixels.buffer).not.toBe(preparedReference.referenceSlices[1]!.pixels.buffer);
    expect(first.referenceSlices[1]!.valid!.buffer).not.toBe(preparedReference.referenceSlices[1]!.valid!.buffer);

    const transferred = first.referenceSlices.flatMap((slice) => [slice.pixels.buffer, slice.valid!.buffer]);
    structuredClone(first.referenceSlices, { transfer: transferred });
    expect(first.referenceSlices.every((slice) => slice.pixels.byteLength === 0 && slice.valid!.byteLength === 0)).toBe(
      true,
    );
    expect(
      preparedReference.referenceSlices.every((slice) => slice.pixels.byteLength > 0 && slice.valid!.byteLength > 0),
    ).toBe(true);

    const second = await prepareLongitudinalRegistrationInput(reference, makeManifest('target-b', 21), 7, {
      ...options,
      preparedReference,
    });
    expect(second.referenceSlices.every((slice) => slice.pixels.byteLength > 0 && slice.valid!.byteLength > 0)).toBe(
      true,
    );
    expect(decode.load).toHaveBeenCalledTimes(15);
    expect(decode.load.mock.calls.filter(([imageId]) => imageId.startsWith('miradb:reference-'))).toHaveLength(5);
  });

  it('refuses stale, mismatched, or cancelled run-scoped reference preparations before target decoding', async () => {
    const reference = makeManifest('reference', 9);
    const options = { maxDimension: 8, maxSlices: 5 };
    const preparedReference = await prepareLongitudinalReferenceInput(reference, 3, options);
    decode.load.mockClear();

    await expect(
      prepareLongitudinalRegistrationInput(makeManifest('reference', 9), makeManifest('target', 9), 3, {
        ...options,
        preparedReference,
      }),
    ).rejects.toThrow('prepared reference');
    await expect(
      prepareLongitudinalRegistrationInput(reference, makeManifest('target', 9), 4, {
        ...options,
        preparedReference,
      }),
    ).rejects.toThrow('prepared reference');
    await expect(
      prepareLongitudinalRegistrationInput(reference, makeManifest('target', 9), 3, {
        ...options,
        maxDimension: 16,
        preparedReference,
      }),
    ).rejects.toThrow('prepared reference');
    const outputGrid = buildOutputPlaneGrid(reference.frames[3]!, {
      frameOfReferenceUid: reference.frameOfReferenceUid,
    });
    await expect(
      prepareLongitudinalRegistrationInput(reference, makeManifest('target', 9), 3, {
        ...options,
        outputGrid,
        preparedReference,
      }),
    ).rejects.toThrow('prepared reference');

    const controller = new AbortController();
    controller.abort();
    await expect(
      prepareLongitudinalRegistrationInput(reference, makeManifest('target', 9), 3, {
        ...options,
        preparedReference,
        signal: controller.signal,
      }),
    ).rejects.toThrow('cancelled');
    expect(decode.load).not.toHaveBeenCalled();
  });

  it('stratifies sparse scoring frames across physical depth rather than dense source indices', async () => {
    const target = makeManifest('target', 21);
    target.frames = target.frames.map((frame, index) => {
      const depth = index < 16 ? index / 15 : (index - 15) * 20;
      return {
        ...frame,
        imagePositionPatient: `0\\0\\${depth}`,
        physicalSlicePosition: depth,
      };
    });

    const prepared = await prepareLongitudinalRegistrationInput(makeManifest('reference', 21), target, 7, {
      maxSlices: 6,
    });

    expect(prepared.targetSourceIndices).toEqual([0, 16, 17, 18, 19, 20]);
  });

  it('propagates stored-domain padding validity and verified physical output geometry', async () => {
    const reference = makeManifest('reference', 4);
    reference.frames[0] = { ...reference.frames[0]!, pixelPaddingValue: -2048, pixelPaddingRangeLimit: -2000 };
    decode.resample.mockImplementationOnce((_image, rows, cols) => {
      const validity = new Float32Array(rows * cols).fill(1);
      validity[0] = 0;
      validity[1] = 0.25;
      return { pixels: new Float32Array(rows * cols).fill(1), validity };
    });
    const outputGrid = buildOutputPlaneGrid(reference.frames[1]!, {
      mode: 'fixed-256',
      frameOfReferenceUid: reference.frameOfReferenceUid,
    });

    const prepared = await prepareLongitudinalRegistrationInput(reference, makeManifest('target', 4), 1, {
      outputGrid,
    });

    expect(prepared.outputGrid).toEqual(outputGrid);
    expect(Array.from(prepared.referenceSlices[0]!.valid!.subarray(0, 2))).toEqual([0, 0]);
    expect(Array.from(prepared.referenceSlices[0]!.pixels.subarray(0, 2))).toEqual([0, 0]);
    expect(decode.resample.mock.calls[0]![0]).toMatchObject({
      pixelPaddingValue: -2048,
      pixelPaddingRangeLimit: -2000,
    });
  });

  it('categorizes every decoded support value without inventing acquired anatomy', async () => {
    decode.resample.mockImplementationOnce((_image, rows, cols) => {
      const validity = new Float32Array(rows * cols).fill(1);
      validity.set([
        0,
        -0,
        -0.25,
        Number.NaN,
        Number.NEGATIVE_INFINITY,
        Number.POSITIVE_INFINITY,
        1e-38,
        0.25,
        0.999,
        0.9999995,
        1,
      ]);
      return { pixels: new Float32Array(rows * cols).fill(1), validity };
    });

    const prepared = await prepareLongitudinalRegistrationInput(
      makeManifest('reference', 4),
      makeManifest('target', 4),
      1,
    );

    expect(Array.from(prepared.referenceSlices[0]!.valid!.subarray(0, 11))).toEqual([0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 1]);
    expect(Array.from(prepared.referenceSlices[0]!.pixels.subarray(0, 11))).toEqual([0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 1]);
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

  it('measures all four selected-plane corners instead of underestimating diagonal obliquity', () => {
    const angle = Math.PI / 180;
    const axis = Math.SQRT1_2;
    const reference = makeManifest('reference', 3);
    const target = makeManifest('target', 3);
    reference.frames = reference.frames.map((frame) => ({
      ...frame,
      rows: 201,
      columns: 201,
      imagePositionPatient: '-100\\-100\\0',
      pixelSpacing: '1\\1',
    }));
    target.frames = target.frames.map((frame) => ({
      ...frame,
      imageOrientationPatient: `${axis}\\${-axis}\\0\\${Math.cos(angle) * axis}\\${Math.cos(angle) * axis}\\${-Math.sin(angle)}`,
    }));

    const drift = measureLongitudinalPlaneDrift(reference, target);

    expect(drift.angleDegrees).toBeCloseTo(1, 7);
    expect(drift.maximumThroughPlaneDriftMm).toBeCloseTo(Math.SQRT2 * 100 * Math.sin(angle), 7);
    expect(drift.maximumThroughPlaneDriftMm).toBeGreaterThan(2);
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

  it('admits acquired support for anchor-preserving oblique anatomy without adding unverified native hypotheses', async () => {
    const reference = makeManifest('reference', 121);
    const target = makeManifest('target', 121, { angleDeg: 18 });
    for (const manifest of [reference, target]) {
      manifest.frames = manifest.frames.map((frame) => ({ ...frame, pixelSpacing: '8\\\\8' }));
    }
    const outputGrid = buildOutputPlaneGrid(reference.frames[60]!, {
      frameOfReferenceUid: reference.frameOfReferenceUid,
    });
    const prepared = await prepareLongitudinalRegistrationInput(reference, target, 60, {
      maxSlices: 5,
      outputGrid,
    });
    const selected = prepared.referenceSlices[prepared.referenceSliceIndex]!;
    const centerMm = outputGridPixelToWorld(outputGrid, (outputGrid.rows - 1) / 2, (outputGrid.columns - 1) / 2);
    const aligned = { tx: 0, ty: 0, tz: 0, rx: 0, ry: (18 * Math.PI) / 180, rz: 0 };
    const referenceExclusionMask = new Uint8Array(selected.dsRows * selected.dsCols);
    referenceExclusionMask[Math.floor(referenceExclusionMask.length / 2)] = 1;
    const options = {
      maxSlices: 96,
      outputGrid,
      referenceManifest: reference,
      referenceSliceIndex: 60,
      referenceExclusionMask,
    };

    const dense = await prepareDenseLongitudinalResliceInput(target, selected, aligned, centerMm, options);
    const oblique = attenuateLongitudinalPlaneTilt(aligned, centerMm, selected, outputGrid, 0.5);
    const presentation = resliceStackToReferencePlane({
      targetSlices: dense.targetSlices,
      referenceSlice: selected,
      targetToReference: oblique,
      centerMm,
      outputGrid,
    });

    expect(dense.sourceIndices.length).toBeGreaterThan(30);
    expect(presentation.coverage).toBeGreaterThan(0.9);
    const amplified = attenuateLongitudinalPlaneTilt(aligned, centerMm, selected, outputGrid, 1.75);
    expect(
      resliceStackToReferencePlane({
        targetSlices: dense.targetSlices,
        referenceSlice: selected,
        targetToReference: amplified,
        centerMm,
        outputGrid,
      }).coverage,
    ).toBeGreaterThan(0.9);
    expect(dense.nativeCandidatePoses).toBeUndefined();

    const bounded = await prepareDenseLongitudinalResliceInput(target, selected, aligned, centerMm, {
      ...options,
      maxSlices: 5,
    });
    expect(bounded.sourceIndices.length).toBeLessThanOrEqual(5);
    expect(bounded.nativeCandidatePoses).toBeUndefined();
  });

  it('keeps the acquired plane anchor and source slice fixed while changing through-plane tilt', async () => {
    const reference = makeManifest('reference', 121);
    const target = makeManifest('target', 121, { angleDeg: 18 });
    const outputGrid = buildOutputPlaneGrid(reference.frames[60]!, {
      frameOfReferenceUid: reference.frameOfReferenceUid,
    });
    const prepared = await prepareLongitudinalRegistrationInput(reference, target, 60, { outputGrid });
    const selected = prepared.referenceSlices[prepared.referenceSliceIndex]!;
    const anchor = outputGridPixelToWorld(outputGrid, (outputGrid.rows - 1) / 2, (outputGrid.columns - 1) / 2);
    const centerMm = { x: anchor.x + 43, y: anchor.y - 31, z: anchor.z + 12 };
    const original = { tx: 4.2, ty: -2.1, tz: 3.6, rx: 0.18, ry: 0.09, rz: 0.04 };
    const sourceAnchor = (rigid: typeof original) => {
      const inverse = invertRigidParams(rigid);
      return applyRigidToPoint(anchor, centerMm, mat3FromEulerXYZ(inverse.rx, inverse.ry, inverse.rz), {
        x: inverse.tx,
        y: inverse.ty,
        z: inverse.tz,
      });
    };
    const referenceAnchor = (rigid: typeof original) =>
      applyRigidToPoint(anchor, centerMm, mat3FromEulerXYZ(rigid.rx, rigid.ry, rigid.rz), {
        x: rigid.tx,
        y: rigid.ty,
        z: rigid.tz,
      });
    const expectedAnchor = sourceAnchor(original);
    const expectedReferenceAnchor = referenceAnchor(original);
    const expectedSlice = selectPhysicalTargetSlice(reference, target, 60, {
      rigid: original,
      centerMm,
      outputGrid,
    });

    for (const factor of [0.5, 0.75, 1.25, 1.5]) {
      const broadAnatomy = attenuateLongitudinalPlaneTilt(original, centerMm, selected, outputGrid, factor);
      const broadAnchor = referenceAnchor(broadAnatomy);
      expect(broadAnchor.x).toBeCloseTo(expectedReferenceAnchor.x, 8);
      expect(broadAnchor.y).toBeCloseTo(expectedReferenceAnchor.y, 8);
      expect(broadAnchor.z).toBeCloseTo(expectedReferenceAnchor.z, 8);
      const adjusted = attenuateLongitudinalPlaneTilt(original, centerMm, selected, outputGrid, factor, 'acquired');
      const actualAnchor = sourceAnchor(adjusted);
      expect(actualAnchor.x).toBeCloseTo(expectedAnchor.x, 8);
      expect(actualAnchor.y).toBeCloseTo(expectedAnchor.y, 8);
      expect(actualAnchor.z).toBeCloseTo(expectedAnchor.z, 8);
      expect(selectPhysicalTargetSlice(reference, target, 60, { rigid: adjusted, centerMm, outputGrid })).toBe(
        expectedSlice,
      );
    }
  });

  it('unions native target coverage across bounded physically distinct winner and rival poses', async () => {
    const reference = makeManifest('reference', 101);
    const target = makeManifest('target', 101);
    const prepared = await prepareLongitudinalRegistrationInput(reference, target, 50, { maxSlices: 5 });
    const selected = prepared.referenceSlices[prepared.referenceSliceIndex]!;
    const winner = { tx: 0, ty: 0, tz: 0, rx: 0, ry: 0, rz: 0 };
    const rivals = [winner, { ...winner, tz: 2.5 }, { ...winner, tz: -2.5 }];

    const dense = await prepareDenseLongitudinalResliceInput(
      target,
      selected,
      winner,
      { x: 0, y: 0, z: 0 },
      {
        nativeCandidatePoses: rivals,
      },
    );

    expect(dense.sourceIndices).toEqual([47, 48, 49, 50, 51, 52, 53]);
    expect(dense.nativeCandidatePoses).toEqual(rivals);
    const expanded = await prepareDenseLongitudinalResliceInput(
      target,
      selected,
      winner,
      { x: 0, y: 0, z: 0 },
      {
        nativeCandidatePoses: rivals,
        referenceManifest: reference,
        referenceSliceIndex: 50,
      },
    );
    expect(expanded.sourceIndices).toEqual(Array.from({ length: 19 }, (_, index) => index + 41));
    await expect(
      prepareDenseLongitudinalResliceInput(
        target,
        selected,
        winner,
        { x: 0, y: 0, z: 0 },
        {
          nativeCandidatePoses: [...rivals, winner],
        },
      ),
    ).rejects.toThrow('at most three');
    await expect(
      prepareDenseLongitudinalResliceInput(
        target,
        selected,
        winner,
        { x: 0, y: 0, z: 0 },
        {
          nativeCandidatePoses: [rivals[1]!, winner],
        },
      ),
    ).rejects.toThrow('winner-first');
  });

  it('retains bounded acquired neighboring anatomy for axial landmark depth correction', async () => {
    const reference = makeManifest('reference', 101);
    const target = makeManifest('target', 101);
    const prepared = await prepareLongitudinalRegistrationInput(reference, target, 50, { maxSlices: 5 });
    const selected = prepared.referenceSlices[prepared.referenceSliceIndex]!;
    const exclusion = new Uint8Array(selected.dsRows * selected.dsCols);
    exclusion[Math.floor(exclusion.length / 2)] = 1;
    const rigid = { tx: 0, ty: 0, tz: 0, rx: 0, ry: 0, rz: 0 };

    const expanded = await prepareDenseLongitudinalResliceInput(
      target,
      selected,
      rigid,
      { x: 0, y: 0, z: 0 },
      {
        referenceManifest: reference,
        referenceSliceIndex: 50,
        referenceExclusionMask: exclusion,
      },
    );

    expect(expanded.sourceIndices).toEqual(Array.from({ length: 27 }, (_, index) => index + 37));

    const bounded = await prepareDenseLongitudinalResliceInput(
      target,
      selected,
      rigid,
      { x: 0, y: 0, z: 0 },
      {
        maxSlices: 5,
        referenceManifest: reference,
        referenceSliceIndex: 50,
        referenceExclusionMask: exclusion,
      },
    );

    expect(bounded.sourceIndices).toEqual([48, 49, 50, 51, 52]);

    const sameFrame = await prepareDenseLongitudinalResliceInput(
      { ...target, frameOfReferenceUid: reference.frameOfReferenceUid },
      selected,
      rigid,
      { x: 0, y: 0, z: 0 },
      { referenceManifest: reference, referenceSliceIndex: 50, referenceExclusionMask: exclusion },
    );

    expect(sameFrame.sourceIndices).toEqual([49, 50, 51]);
  });

  it('preserves minimal sagittal and coronal envelopes without applying axial-only depth correction', async () => {
    const orient = (manifest: SeriesFrameManifest, plane: 'sagittal' | 'coronal'): SeriesFrameManifest => ({
      ...manifest,
      frames: manifest.frames.map((frame, index) => ({
        ...frame,
        imageOrientationPatient: plane === 'sagittal' ? '0\\1\\0\\0\\0\\1' : '1\\0\\0\\0\\0\\-1',
        imagePositionPatient: plane === 'sagittal' ? `${index}\\0\\0` : `0\\${index}\\0`,
      })),
    });
    const rigid = { tx: 0, ty: 0, tz: 0, rx: 0, ry: 0, rz: 0 };
    for (const plane of ['sagittal', 'coronal'] as const) {
      const reference = orient(makeManifest(`${plane}-reference`, 101), plane);
      const target = orient(makeManifest(`${plane}-target`, 101), plane);
      const prepared = await prepareLongitudinalRegistrationInput(reference, target, 50, { maxSlices: 5 });
      const selected = prepared.referenceSlices[prepared.referenceSliceIndex]!;
      const result = await prepareDenseLongitudinalResliceInput(
        target,
        selected,
        rigid,
        { x: 0, y: 0, z: 0 },
        {
          referenceManifest: reference,
          referenceSliceIndex: 50,
          ...(plane === 'coronal'
            ? { referenceExclusionMask: new Uint8Array(selected.dsRows * selected.dsCols).fill(1) }
            : {}),
        },
      );

      expect(result.sourceIndices).toEqual([49, 50, 51]);
      expect(result.nativeCandidatePoses).toBeUndefined();
    }
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

  it('refines with at most five freshly decoded native reference slices and a conservative exclusion mask', async () => {
    const reference = makeManifest('reference', 11);
    const target = makeManifest('target', 11);
    const prepared = await prepareLongitudinalRegistrationInput(reference, target, 5, {
      maxDimension: 8,
      maxSlices: 5,
    });
    const selected = prepared.referenceSlices[prepared.referenceSliceIndex]!;
    const exclusion = new Uint8Array(selected.dsRows * selected.dsCols);
    exclusion[selected.dsCols + 2] = 1;
    structuredClone(
      { pixels: selected.pixels, valid: selected.valid },
      { transfer: [selected.pixels.buffer, selected.valid!.buffer] },
    );
    const rigid = { tx: 0, ty: 0, tz: 0, rx: 0, ry: 0, rz: 0 };
    const refined = { ...rigid, tx: 0.125 };
    denseWorker.run.mockResolvedValueOnce({
      ok: true,
      pixels: new Float32Array(selected.dsRows * selected.dsCols),
      valid: new Uint8Array(selected.dsRows * selected.dsCols).fill(1),
      rows: selected.dsRows,
      cols: selected.dsCols,
      coverage: 1,
      targetToReference: refined,
      contributingSourceSopInstanceUids: ['target-5'],
      nativeRefinement: { score: 0.98, sampleCount: 150 },
    });
    decode.load.mockClear();

    const result = await densifyLongitudinalRegistration(
      target,
      selected,
      acceptedRegistration({ targetToReference: rigid }),
      { referenceManifest: reference, referenceSliceIndex: 5, referenceExclusionMask: exclusion },
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.targetToReference).toEqual(refined);
    expect(result.contributingSourceSopInstanceUids).toEqual(['target-5']);
    expect(result.nativeRefinement).toMatchObject({ score: 0.98, sampleCount: 150 });
    const options = denseWorker.run.mock.calls[0]![0];
    expect(options.nativeReferenceSlices).toHaveLength(5);
    expect(options.nativeReferenceSlices.map((slice: { sopInstanceUid: string }) => slice.sopInstanceUid)).toEqual([
      'reference-3',
      'reference-4',
      'reference-5',
      'reference-6',
      'reference-7',
    ]);
    expect(options.nativeReferenceSliceIndex).toBe(2);
    expect(options.nativeReferenceSlices[2]).toMatchObject({ dsRows: 12, dsCols: 16 });
    expect(options.referenceExclusionMask).toHaveLength(12 * 16);
    expect(options.referenceExclusionMask[2 * 16 + 4]).toBe(1);
  });

  it('scores visible aligned reference tissue without changing its verified acquired plane or source identity', async () => {
    const reference = makeManifest('reference', 11);
    const target = makeManifest('target', 11);
    const outputGrid = buildOutputPlaneGrid(reference.frames[5]!, {
      mode: 'fixed-256',
      frameOfReferenceUid: reference.frameOfReferenceUid,
    });
    const prepared = await prepareLongitudinalRegistrationInput(reference, target, 5, { outputGrid, maxSlices: 5 });
    const selected = prepared.referenceSlices[prepared.referenceSliceIndex]!;
    const pixels = new Float32Array(outputGrid.rows * outputGrid.columns).fill(17);
    const valid = new Uint8Array(pixels.length).fill(1);
    for (let row = 0; row < 22; row++) valid.fill(0, row * outputGrid.columns, row * outputGrid.columns + 16);
    denseWorker.run.mockResolvedValueOnce({
      ok: true,
      pixels: new Float32Array(pixels.length),
      valid: new Uint8Array(pixels.length).fill(1),
      rows: outputGrid.rows,
      cols: outputGrid.columns,
      coverage: 1,
      outputGrid,
      contributingSourceSopInstanceUids: ['target-5'],
      nativeRefinement: { score: 0.9, sampleCount: 100 },
    });

    const result = await densifyLongitudinalRegistration(target, selected, acceptedRegistration(), {
      outputGrid,
      referenceManifest: reference,
      referenceSliceIndex: 5,
      referenceImage: { pixels, valid, rows: outputGrid.rows, columns: outputGrid.columns, outputGrid },
    });

    expect(result.ok).toBe(true);
    const context = denseWorker.run.mock.calls[0]![0];
    const visibleReference = context.nativeReferenceSlices[context.nativeReferenceSliceIndex];
    expect(visibleReference.sopInstanceUid).toBe('reference-5');
    expect(visibleReference.ippMm).toEqual(selected.ippMm);
    expect(visibleReference.valid[0]).toBe(0);
    expect(visibleReference.pixels[0]).toBe(0);
    expect(visibleReference.valid[1]).toBe(1);
    expect(visibleReference.pixels[1]).toBe(17);
    expect(context.nativeReferenceSlices[0].pixels[1]).toBe(1);
    expect(visibleReference.pixels.buffer).not.toBe(pixels.buffer);
    expect(visibleReference.valid.buffer).not.toBe(valid.buffer);

    denseWorker.run.mockClear();
    const differentGrid = buildOutputPlaneGrid(reference.frames[5]!, {
      frameOfReferenceUid: reference.frameOfReferenceUid,
    });
    await expect(
      densifyLongitudinalRegistration(target, selected, acceptedRegistration(), {
        outputGrid,
        referenceManifest: reference,
        referenceSliceIndex: 5,
        referenceImage: {
          pixels,
          valid,
          rows: outputGrid.rows,
          columns: outputGrid.columns,
          outputGrid: differentGrid,
        },
      }),
    ).resolves.toMatchObject({ ok: false, message: expect.stringContaining('verified physical output grid') });
    expect(denseWorker.run).not.toHaveBeenCalled();
  });

  it('keeps the entire selected-examination reference volume coherent in its immutable acquired anchor frame', async () => {
    const anchor = makeManifest('anchor', 11);
    const anatomy = makeManifest('selected', 11);
    anatomy.frames = anatomy.frames.map((frame, index) => ({
      ...frame,
      imagePositionPatient: `10\\\\20\\\\${index}`,
    }));
    const target = makeManifest('target', 11);
    const outputGrid = buildOutputPlaneGrid(anchor.frames[5]!, {
      frameOfReferenceUid: anchor.frameOfReferenceUid,
    });
    const referenceAnatomy = {
      manifest: anatomy,
      sourceIndex: 5,
      rigidTransform: [-10, -20, 0, 0, 0, 0] as [number, number, number, number, number, number],
      rotationCenterMm: [0, 0, 0] as [number, number, number],
    };
    const options = { outputGrid, maxSlices: 5, referenceAnatomy };

    const retained = await prepareLongitudinalReferenceInput(anchor, 5, options);
    const prepared = await prepareLongitudinalRegistrationInput(anchor, target, 5, {
      ...options,
      preparedReference: retained,
    });

    expect(retained.referenceManifest).toBe(anchor);
    expect(prepared.referenceSlices.every((slice) => slice.sopInstanceUid?.startsWith('selected-'))).toBe(true);
    expect(prepared.referenceSlices.every((slice) => slice.frameOfReferenceUid === anchor.frameOfReferenceUid)).toBe(
      true,
    );
    const selected = prepared.referenceSlices[prepared.referenceSliceIndex]!;
    expect(selected.sopInstanceUid).toBe('selected-5');
    expect(selected.ippMm).toEqual({ x: outputGrid.originMm[0], y: outputGrid.originMm[1], z: outputGrid.originMm[2] });
    expect(prepared.referenceSlices[0]!.ippMm.x).toBeCloseTo(0, 6);
    expect(prepared.referenceSlices[0]!.ippMm.y).toBeCloseTo(0, 6);

    denseWorker.run.mockResolvedValueOnce({
      ok: true,
      pixels: new Float32Array(outputGrid.rows * outputGrid.columns),
      valid: new Uint8Array(outputGrid.rows * outputGrid.columns).fill(1),
      rows: outputGrid.rows,
      cols: outputGrid.columns,
      coverage: 1,
      outputGrid,
      contributingSourceSopInstanceUids: ['target-5'],
      nativeRefinement: { score: 0.9, sampleCount: 100 },
    });
    const result = await densifyLongitudinalRegistration(target, selected, acceptedRegistration(), {
      outputGrid,
      referenceManifest: anchor,
      referenceSliceIndex: 5,
      referenceAnatomy,
    });

    expect(result.ok).toBe(true);
    const native = denseWorker.run.mock.calls[0]![0];
    expect(native.nativeReferenceSlices.map((slice: { sopInstanceUid: string }) => slice.sopInstanceUid)).toEqual([
      'selected-3',
      'selected-4',
      'selected-5',
      'selected-6',
      'selected-7',
    ]);
    expect(native.nativeReferenceSlices[2]!.ippMm).toEqual(selected.ippMm);
    expect(native.nativeReferenceSlices[1]!.ippMm).toEqual({ x: 0, y: 0, z: 4 });

    await expect(
      prepareLongitudinalReferenceInput(anchor, 5, {
        ...options,
        referenceAnatomy: { ...referenceAnatomy, manifest: makeManifest('other', 11, { patientKey: 'different' }) },
      }),
    ).rejects.toThrow('same patient');
  });

  it('rejects worker pixels bound to a different output lattice or unknown source examination', async () => {
    const reference = makeManifest('reference', 5);
    const target = makeManifest('target', 5);
    const outputGrid = buildOutputPlaneGrid(reference.frames[2]!, {
      frameOfReferenceUid: reference.frameOfReferenceUid,
    });
    const prepared = await prepareLongitudinalRegistrationInput(reference, target, 2, { outputGrid });
    const selected = prepared.referenceSlices[prepared.referenceSliceIndex]!;
    const coarse = acceptedRegistration();
    const validResult = {
      ok: true,
      pixels: new Float32Array(outputGrid.rows * outputGrid.columns),
      valid: new Uint8Array(outputGrid.rows * outputGrid.columns).fill(1),
      rows: outputGrid.rows,
      cols: outputGrid.columns,
      coverage: 1,
      outputGrid,
    };
    denseWorker.run.mockResolvedValueOnce({
      ...validResult,
      outputGrid: buildOutputPlaneGrid(reference.frames[2]!, {
        mode: 'fixed-256',
        frameOfReferenceUid: reference.frameOfReferenceUid,
      }),
    });

    await expect(densifyLongitudinalRegistration(target, selected, coarse, { outputGrid })).resolves.toMatchObject({
      ok: false,
      reason: 'invalid-geometry',
      message: expect.stringContaining('different physical output grid'),
    });

    denseWorker.run.mockResolvedValueOnce({
      ...validResult,
      contributingSourceSopInstanceUids: ['different-examination'],
    });
    await expect(densifyLongitudinalRegistration(target, selected, coarse, { outputGrid })).resolves.toMatchObject({
      ok: false,
      reason: 'invalid-geometry',
      message: expect.stringContaining('unverified contributing source'),
    });
  });

  it('never promotes ambiguous coarse poses without acquired native reference adjudication', async () => {
    const reference = makeManifest('reference', 5);
    const target = makeManifest('target', 5);
    const prepared = await prepareLongitudinalRegistrationInput(reference, target, 2);
    const winner = { tx: 0, ty: 0, tz: 0, rx: 0, ry: 0, rz: 0 };

    await expect(
      densifyLongitudinalRegistration(
        target,
        prepared.referenceSlices[prepared.referenceSliceIndex]!,
        acceptedRegistration({ targetToReference: winner, nativeCandidatePoses: [winner, { ...winner, tz: 1 }] }),
      ),
    ).resolves.toMatchObject({ ok: false, reason: 'ambiguous' });
    expect(denseWorker.run).not.toHaveBeenCalled();
  });

  it('widens only ambiguous acquired context to thirteen slices and covers every rival in the target slab', async () => {
    const reference = makeManifest('reference', 101);
    const target = makeManifest('target', 101);
    const prepared = await prepareLongitudinalRegistrationInput(reference, target, 50, { maxSlices: 5 });
    const selected = prepared.referenceSlices[prepared.referenceSliceIndex]!;
    const winner = { tx: 0, ty: 0, tz: 0, rx: 0, ry: 0, rz: 0 };
    const candidates = [winner, { ...winner, tz: 2.5 }, { ...winner, tz: -2.5 }];
    denseWorker.run.mockResolvedValueOnce({
      ok: true,
      pixels: new Float32Array(selected.dsRows * selected.dsCols),
      valid: new Uint8Array(selected.dsRows * selected.dsCols).fill(1),
      rows: selected.dsRows,
      cols: selected.dsCols,
      coverage: 1,
      nativeRefinement: { score: 0.95, sampleCount: 500 },
    });

    const result = await densifyLongitudinalRegistration(
      target,
      selected,
      acceptedRegistration({ targetToReference: winner, nativeCandidatePoses: candidates }),
      { referenceManifest: reference, referenceSliceIndex: 50 },
    );

    expect(result.ok).toBe(true);
    const options = denseWorker.run.mock.calls[0]![0];
    expect(options.nativeReferenceSlices).toHaveLength(13);
    expect(options.nativeReferenceSliceIndex).toBe(6);
    expect(options.nativeReferenceSlices[0].sopInstanceUid).toBe('reference-44');
    expect(options.nativeReferenceSlices[12].sopInstanceUid).toBe('reference-56');
    expect(options.targetSlices.map((slice: { sopInstanceUid: string }) => slice.sopInstanceUid)).toEqual(
      Array.from({ length: 19 }, (_, index) => `target-${index + 41}`),
    );
    expect(options.nativeCandidatePoses).toEqual(candidates);
  });
});
