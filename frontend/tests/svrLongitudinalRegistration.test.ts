import { describe, expect, it } from 'vitest';
import { buildOutputPlaneGrid } from '../src/utils/outputPlaneGrid';
import type { SvrReconstructionSlice } from '../src/utils/svr/reconstructionCore';
import {
  registerAndResliceLongitudinal,
  resliceDenseLongitudinalPlane,
  resliceStackToReferencePlane,
} from '../src/utils/svr/longitudinalRegistration';

function signalAt(x: number, y: number, z: number): number {
  const central = Math.exp(-(x * x + y * y + z * z) / 80);
  const landmark = 0.4 * Math.exp(-((x - 4) ** 2 + (y + 3) ** 2 + (z - 2) ** 2) / 9);
  return 0.1 + central + landmark;
}

function makeStack(
  params: {
    angleDeg?: number;
    frameUid?: string;
    offset?: { x: number; y: number; z: number };
    rowSpacingMm?: number;
    colSpacingMm?: number;
  } = {},
): SvrReconstructionSlice[] {
  const rows = 19;
  const cols = 19;
  const count = 19;
  const angle = ((params.angleDeg ?? 0) * Math.PI) / 180;
  const rowDir = { x: Math.cos(angle), y: 0, z: Math.sin(angle) };
  const colDir = { x: 0, y: 1, z: 0 };
  const normalDir = { x: -Math.sin(angle), y: 0, z: Math.cos(angle) };
  const rowSpacingDsMm = params.rowSpacingMm ?? 1;
  const colSpacingDsMm = params.colSpacingMm ?? 1;
  const offset = params.offset ?? { x: 0, y: 0, z: 0 };

  return Array.from({ length: count }, (_, index) => {
    const depth = index - (count - 1) / 2;
    const physicalOrigin = {
      x: normalDir.x * depth - rowDir.x * ((cols - 1) / 2) * colSpacingDsMm,
      y: normalDir.y * depth - colDir.y * ((rows - 1) / 2) * rowSpacingDsMm,
      z: normalDir.z * depth - rowDir.z * ((cols - 1) / 2) * colSpacingDsMm,
    };
    const pixels = new Float32Array(rows * cols);
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const x = physicalOrigin.x + colDir.x * r * rowSpacingDsMm + rowDir.x * c * colSpacingDsMm;
        const y = physicalOrigin.y + colDir.y * r * rowSpacingDsMm + rowDir.y * c * colSpacingDsMm;
        const z = physicalOrigin.z + colDir.z * r * rowSpacingDsMm + rowDir.z * c * colSpacingDsMm;
        pixels[r * cols + c] = signalAt(x, y, z);
      }
    }

    return {
      pixels,
      dsRows: rows,
      dsCols: cols,
      ippMm: {
        x: physicalOrigin.x + offset.x,
        y: physicalOrigin.y + offset.y,
        z: physicalOrigin.z + offset.z,
      },
      rowDir,
      colDir,
      normalDir,
      rowSpacingDsMm,
      colSpacingDsMm,
      sliceThicknessMm: 1,
      spacingBetweenSlicesMm: 1,
      frameOfReferenceUid: params.frameUid,
    };
  });
}

describe('svr/longitudinalRegistration', () => {
  it('reslices an 18-degree target stack along the exact reference plane', async () => {
    const reference = makeStack({ frameUid: 'shared' });
    const target = makeStack({ angleDeg: 18, frameUid: 'shared' });
    const result = await registerAndResliceLongitudinal({
      referenceSlices: reference,
      targetSlices: target,
      referenceSliceIndex: 9,
      maxDimension: 32,
      maxSamples: 4000,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.coverage).toBeGreaterThan(0.75);
    expect(result.diagnostics.angleDifferenceDeg).toBeCloseTo(18, 1);
    expect(result.diagnostics.scoreMargin).toBeGreaterThanOrEqual(0);
    expect(result.diagnostics.optimizedHypothesisCount).toBeGreaterThan(0);
    if (result.diagnostics.optimizedAlternativeCount === 0) expect(result.diagnostics.scoreMargin).toBe(0);
    expect(result.diagnostics.referenceIntensityVariance).toBeGreaterThan(0);
    expect(result.diagnostics.targetIntensityVariance).toBeGreaterThan(0);

    let error = 0;
    let used = 0;
    for (let r = 4; r < 15; r++) {
      for (let c = 4; c < 15; c++) {
        error += Math.abs(result.pixels[r * 19 + c]! - reference[9]!.pixels[r * 19 + c]!);
        used++;
      }
    }
    expect(error / used).toBeLessThan(0.1);
  });

  it('initializes different frames without treating their absolute coordinates as shared', async () => {
    const reference = makeStack({ frameUid: 'reference-frame' });
    const target = makeStack({
      angleDeg: 18,
      frameUid: 'target-frame',
      offset: { x: 50, y: -30, z: 10 },
    });
    const result = await registerAndResliceLongitudinal({
      referenceSlices: reference,
      targetSlices: target,
      referenceSliceIndex: 9,
      maxDimension: 32,
      maxSamples: 4000,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.provenance.frameRelationship).toBe('different');
    expect(Math.abs(result.targetToReference.tx + 50)).toBeLessThan(1);
    expect(result.coverage).toBeGreaterThan(0.75);
  });

  it('preserves anisotropic row and column spacing while sampling an exact reference plane', () => {
    const stack = makeStack({ rowSpacingMm: 1.5, colSpacingMm: 0.7 });
    const result = resliceStackToReferencePlane({ targetSlices: stack, referenceSlice: stack[9]! });

    expect(result.coverage).toBe(1);
    expect(result.pixels).toEqual(stack[9]!.pixels);
  });

  it('samples the exact requested anisotropic output lattice and records actual contributing sources', () => {
    const stack = makeStack({ rowSpacingMm: 1.5, colSpacingMm: 0.7 }).map((slice, index) => ({
      ...slice,
      sopInstanceUid: `source-${index}`,
    }));
    const reference = stack[9]!;
    const outputGrid = buildOutputPlaneGrid(
      {
        rows: reference.dsRows,
        columns: reference.dsCols,
        imagePositionPatient: `${reference.ippMm.x}\\${reference.ippMm.y}\\${reference.ippMm.z}`,
        imageOrientationPatient: '1\\0\\0\\0\\1\\0',
        pixelSpacing: '1.5\\0.7',
        sopInstanceUid: 'reference',
      },
      { mode: 'longest-edge', longestEdge: 12 },
    );

    const result = resliceStackToReferencePlane({ targetSlices: stack, referenceSlice: reference, outputGrid });

    expect(result.outputGrid).toEqual(outputGrid);
    expect(result.rows).toBe(12);
    expect(result.cols).toBe(12);
    expect(result.coverage).toBe(1);
    expect(result.valid.every(Boolean)).toBe(true);
    expect(result.contributingSourceSopInstanceUids).toEqual(['source-9']);
  });

  it('preserves every acquired-footprint edge when an identity plane is presented on a 1024 grid', () => {
    const stack = makeStack();
    const reference = stack[9]!;
    const outputGrid = buildOutputPlaneGrid(
      {
        rows: reference.dsRows,
        columns: reference.dsCols,
        imagePositionPatient: `${reference.ippMm.x}\\${reference.ippMm.y}\\${reference.ippMm.z}`,
        imageOrientationPatient: '1\\0\\0\\0\\1\\0',
        pixelSpacing: '1\\1',
      },
      { mode: 'fixed-1024' },
    );

    const result = resliceStackToReferencePlane({ targetSlices: stack, referenceSlice: reference, outputGrid });

    expect(result.rows).toBe(1024);
    expect(result.cols).toBe(1024);
    expect(result.coverage).toBe(1);
    expect(result.valid[0]).toBe(1);
    expect(result.valid[1023]).toBe(1);
    expect(result.valid[1023 * 1024]).toBe(1);
    expect(result.valid[1024 * 1024 - 1]).toBe(1);
    expect(result.pixels[0]).toBeCloseTo(reference.pixels[0]!, 5);
    expect(result.pixels[1024 * 1024 - 1]).toBeCloseTo(reference.pixels[reference.pixels.length - 1]!, 5);
  });

  it('area-filters valid native anatomy instead of aliasing a checkerboard onto a coarser output plane', () => {
    const stack = makeStack().map((slice) => {
      const pixels = new Float32Array(slice.pixels.length);
      for (let row = 0; row < slice.dsRows; row++) {
        for (let col = 0; col < slice.dsCols; col++) pixels[row * slice.dsCols + col] = (row + col) % 2;
      }
      return { ...slice, pixels };
    });
    const reference = stack[9]!;
    const outputGrid = buildOutputPlaneGrid(
      {
        rows: reference.dsRows,
        columns: reference.dsCols,
        imagePositionPatient: `${reference.ippMm.x}\\${reference.ippMm.y}\\${reference.ippMm.z}`,
        imageOrientationPatient: '1\\0\\0\\0\\1\\0',
        pixelSpacing: '1\\1',
      },
      { mode: 'longest-edge', longestEdge: 9 },
    );

    const result = resliceStackToReferencePlane({ targetSlices: stack, referenceSlice: reference, outputGrid });

    expect(result.coverage).toBe(1);
    expect(result.pixels[4 * 9 + 4]).toBeGreaterThan(0.35);
    expect(result.pixels[4 * 9 + 4]).toBeLessThan(0.65);
  });

  it('never invents acquired support by interpolating across a physical slice gap', () => {
    const stack = makeStack();
    const target = [0, 1, 2, 25, 26].map((depth, index) => ({
      ...stack[index]!,
      ippMm: { ...stack[index]!.ippMm, z: depth },
      sliceThicknessMm: 1,
      spacingBetweenSlicesMm: 1,
    }));
    const referenceSlice = { ...stack[9]!, ippMm: { ...stack[9]!.ippMm, z: 13.5 } };

    const result = resliceStackToReferencePlane({ targetSlices: target, referenceSlice });

    expect(result.coverage).toBe(0);
    expect(result.valid.every((value) => value === 0)).toBe(true);
  });

  it('retains legitimate interpolation across overlapping acquired slice footprints', () => {
    const stack = makeStack();
    const target = [0, 0.6, 1.2].map((depth, index) => ({
      ...stack[index]!,
      ippMm: { ...stack[index]!.ippMm, z: depth },
      sliceThicknessMm: 1.2,
      spacingBetweenSlicesMm: 0.6,
    }));
    const referenceSlice = { ...stack[9]!, ippMm: { ...stack[9]!.ippMm, z: 0.3 } };

    const result = resliceStackToReferencePlane({ targetSlices: target, referenceSlice });

    expect(result.coverage).toBe(1);
    expect(result.valid.every((value) => value === 1)).toBe(true);
  });

  it('refines the accepted rigid pose against freshly decoded native reference and target slabs', () => {
    const reference = makeStack({ frameUid: 'shared' });
    const target = makeStack({ frameUid: 'shared', offset: { x: 0.24, y: -0.16, z: 0.11 } });

    const result = resliceDenseLongitudinalPlane({
      targetSlices: target,
      referencePlane: reference[9]!,
      nativeReferenceSlices: reference.slice(7, 12),
      nativeReferenceSliceIndex: 2,
      targetToReference: { tx: 0, ty: 0, tz: 0, rx: 0, ry: 0, rz: 0 },
      centerMm: { x: 0, y: 0, z: 0 },
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.nativeRefinement?.sampleCount).toBeGreaterThan(64);
    expect(result.nativeRefinement?.translationStepMm).toBeLessThanOrEqual(0.1);
    expect(result.targetToReference?.tx).toBeCloseTo(-0.24, 1);
    expect(result.targetToReference?.ty).toBeCloseTo(0.16, 1);
    expect(result.targetToReference?.tz).toBeCloseTo(-0.11, 1);
  });

  it('keeps native rigid refinement symmetric when excluded lesion anatomy changes substantially', () => {
    const reference = makeStack({ frameUid: 'shared' });
    const target = makeStack({ frameUid: 'shared' });
    const mask = new Uint8Array(19 * 19);
    for (let row = 7; row <= 11; row++) {
      for (let col = 7; col <= 11; col++) {
        mask[row * 19 + col] = 1;
        for (const slice of target) slice.pixels[row * 19 + col]! += 5;
      }
    }

    const result = resliceDenseLongitudinalPlane({
      targetSlices: target,
      referencePlane: reference[9]!,
      nativeReferenceSlices: reference.slice(7, 12),
      nativeReferenceSliceIndex: 2,
      referenceExclusionMask: mask,
      targetToReference: { tx: 0, ty: 0, tz: 0, rx: 0, ry: 0, rz: 0 },
      centerMm: { x: 0, y: 0, z: 0 },
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.targetToReference).toEqual({ tx: 0, ty: 0, tz: 0, rx: 0, ry: 0, rz: 0 });
    expect(result.nativeRefinement?.forwardCoverage).toBeCloseTo(result.nativeRefinement?.reverseCoverage ?? 0, 2);
    expect(result.pixels[9 * 19 + 9]).toBeGreaterThan(5);
  });

  it('never reports more independent anatomical blocks than actually supported full or held-out samples', () => {
    const reference = makeStack({ frameUid: 'shared' });
    const target = makeStack({ frameUid: 'shared', colSpacingMm: 0.8 }).map((slice) => {
      const valid = new Uint8Array(slice.pixels.length).fill(1);
      for (let row = 0; row < slice.dsRows; row++) {
        for (let col = 3; col < slice.dsCols; col += 10) valid[row * slice.dsCols + col] = 0;
      }
      return { ...slice, valid };
    });

    const result = resliceDenseLongitudinalPlane({
      targetSlices: target,
      referencePlane: reference[9]!,
      nativeReferenceSlices: reference,
      nativeReferenceSliceIndex: 9,
      targetToReference: { tx: 0, ty: 0, tz: 0, rx: 0, ry: 0, rz: 0 },
      centerMm: { x: 0, y: 0, z: 0 },
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const diagnostics = result.nativeRefinement!;
    expect(diagnostics.effectiveIndependentSamples).toBeLessThanOrEqual(diagnostics.sampleCount);
    expect(diagnostics.heldOutEffectiveIndependentSamples).toBeLessThanOrEqual(diagnostics.heldOutSampleCount);
  });

  it('preserves a correctly shifted same-frame partial FOV instead of aligning bounding-box centers', async () => {
    const reference = makeStack({ frameUid: 'shared-patient-space' });
    const target = makeStack({ frameUid: 'shared-patient-space' }).map((slice) => {
      const croppedColumns = 15;
      const firstColumn = 4;
      const pixels = new Float32Array(slice.dsRows * croppedColumns);
      for (let row = 0; row < slice.dsRows; row++) {
        pixels.set(
          slice.pixels.subarray(row * slice.dsCols + firstColumn, row * slice.dsCols + firstColumn + croppedColumns),
          row * croppedColumns,
        );
      }
      return {
        ...slice,
        pixels,
        dsCols: croppedColumns,
        ippMm: {
          x: slice.ippMm.x + slice.rowDir.x * firstColumn * slice.colSpacingDsMm,
          y: slice.ippMm.y + slice.rowDir.y * firstColumn * slice.colSpacingDsMm,
          z: slice.ippMm.z + slice.rowDir.z * firstColumn * slice.colSpacingDsMm,
        },
      };
    });

    const result = await registerAndResliceLongitudinal({
      referenceSlices: reference,
      targetSlices: target,
      referenceSliceIndex: 9,
      maxDimension: 32,
      maxSamples: 4000,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.provenance.frameRelationship).toBe('same');
    expect(Math.abs(result.targetToReference.tx)).toBeLessThan(0.6);
    expect(result.coverage).toBeGreaterThan(0.7);
  });

  it('excludes changed lesion anatomy from registration without erasing it from the derived image', async () => {
    const reference = makeStack({ frameUid: 'shared' });
    const target = makeStack({ frameUid: 'shared' });
    const mask = new Uint8Array(19 * 19);
    for (let row = 7; row <= 11; row++) {
      for (let col = 7; col <= 11; col++) {
        mask[row * 19 + col] = 1;
        for (const slice of target) slice.pixels[row * 19 + col]! += 5;
      }
    }

    const result = await registerAndResliceLongitudinal({
      referenceSlices: reference,
      targetSlices: target,
      referenceSliceIndex: 9,
      referenceExclusionMask: mask,
      maxDimension: 16,
      maxSamples: 4000,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(Math.abs(result.targetToReference.tx)).toBeLessThan(0.6);
    expect(result.rows).toBe(19);
    expect(result.cols).toBe(19);
    expect(result.pixels[9 * 19 + 9]).toBeGreaterThan(5);
    expect(result.diagnostics.retainedSampleFraction).toBeCloseTo(result.diagnostics.reverseRetainedSampleFraction, 2);
  });

  it('keeps all six rigid parameters at identity when identical anatomy has an excluded central lesion', async () => {
    const reference = makeStack({ frameUid: 'shared' });
    const target = makeStack({ frameUid: 'shared' });
    const mask = new Uint8Array(19 * 19);
    for (let row = 7; row <= 11; row++) {
      for (let col = 7; col <= 11; col++) mask[row * 19 + col] = 1;
    }

    const result = await registerAndResliceLongitudinal({
      referenceSlices: reference,
      targetSlices: target,
      referenceSliceIndex: 9,
      referenceExclusionMask: mask,
      maxDimension: 16,
      maxSamples: 4000,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(Math.abs(result.targetToReference.tx)).toBeLessThan(0.1);
    expect(Math.abs(result.targetToReference.ty)).toBeLessThan(0.1);
    expect(Math.abs(result.targetToReference.tz)).toBeLessThan(0.1);
    expect(Math.abs(result.targetToReference.rx)).toBeLessThan(0.002);
    expect(Math.abs(result.targetToReference.ry)).toBeLessThan(0.002);
    expect(Math.abs(result.targetToReference.rz)).toBeLessThan(0.002);
    expect(result.coverage).toBe(1);
    expect(result.diagnostics.retainedSampleFraction).toBeCloseTo(result.diagnostics.reverseRetainedSampleFraction, 2);
  });

  it('ignores explicitly invalid target pixels without treating valid negative or zero anatomy as padding', () => {
    const stack = makeStack();
    const target = stack.map((slice) => ({
      ...slice,
      pixels: new Float32Array(slice.pixels),
      valid: new Uint8Array(slice.pixels.length).fill(1),
    }));
    target[9]!.pixels[0] = -12;
    target[9]!.pixels[1] = 0;
    target[9]!.pixels[2] = 999;
    target[9]!.valid[2] = 0;

    const result = resliceStackToReferencePlane({ targetSlices: target, referenceSlice: stack[9]! });

    expect(result.pixels[0]).toBe(-12);
    expect(result.valid[0]).toBe(1);
    expect(result.pixels[1]).toBe(0);
    expect(result.valid[1]).toBe(1);
    expect(result.valid[2]).toBe(0);
    expect(result.pixels[2]).toBe(0);
  });

  it('returns explicit invalid-geometry and cancellation failures', async () => {
    const reference = makeStack();
    const invalid = makeStack();
    invalid[0] = { ...invalid[0]!, rowSpacingDsMm: 0 };
    const bad = await registerAndResliceLongitudinal({
      referenceSlices: reference,
      targetSlices: invalid,
      referenceSliceIndex: 9,
    });
    expect(bad).toMatchObject({ ok: false, reason: 'invalid-geometry' });

    const controller = new AbortController();
    controller.abort();
    const cancelled = await registerAndResliceLongitudinal({
      referenceSlices: reference,
      targetSlices: makeStack(),
      referenceSliceIndex: 9,
      signal: controller.signal,
    });
    expect(cancelled).toMatchObject({ ok: false, reason: 'cancelled' });
  });

  it('rejects within-stack acquisition-axis flips instead of treating opposite normals as consistent', async () => {
    const reference = makeStack({ frameUid: 'shared' });
    const target = makeStack({ frameUid: 'shared' });
    const original = target[7]!;
    target[7] = {
      ...original,
      rowDir: { x: -original.rowDir.x, y: -original.rowDir.y, z: -original.rowDir.z },
      normalDir: { x: -original.normalDir.x, y: -original.normalDir.y, z: -original.normalDir.z },
    };

    await expect(
      registerAndResliceLongitudinal({
        referenceSlices: reference,
        targetSlices: target,
        referenceSliceIndex: 9,
      }),
    ).resolves.toMatchObject({ ok: false, reason: 'invalid-geometry' });
  });

  it('abstains when flat or numerically indistinguishable volumes contain no anatomical evidence', async () => {
    const reference = makeStack().map((slice) => ({
      ...slice,
      pixels: new Float32Array(slice.pixels.length).fill(27),
    }));
    const target = makeStack().map((slice) => ({
      ...slice,
      pixels: new Float32Array(slice.pixels.length).fill(27 + 1e-11),
    }));

    await expect(
      registerAndResliceLongitudinal({
        referenceSlices: reference,
        targetSlices: target,
        referenceSliceIndex: 9,
        maxDimension: 32,
      }),
    ).resolves.toMatchObject({ ok: false, reason: 'insufficient-evidence' });
  });

  it('abstains when materially different rigid poses have indistinguishable supported anatomy', async () => {
    const symmetric = makeStack({ frameUid: 'shared' }).map((slice, depth) => {
      const pixels = new Float32Array(slice.pixels.length);
      for (let row = 0; row < slice.dsRows; row++) {
        for (let col = 0; col < slice.dsCols; col++) {
          const radiusSquared = (row - 9) ** 2 + (col - 9) ** 2;
          pixels[row * slice.dsCols + col] = Math.exp(-radiusSquared / 36) + depth / 100;
        }
      }
      return { ...slice, pixels };
    });
    const reference = symmetric.map((slice) => ({ ...slice, pixels: new Float32Array(slice.pixels) }));

    await expect(
      registerAndResliceLongitudinal({
        referenceSlices: reference,
        targetSlices: symmetric,
        referenceSliceIndex: 9,
        initialTargetToReference: { tx: 0, ty: 0, tz: 0, rx: 0, ry: 0, rz: Math.PI / 2 },
        maxDimension: 32,
        maxSamples: 4000,
      }),
    ).resolves.toMatchObject({ ok: false, reason: 'ambiguous' });
  });

  it('defers coarse pose ambiguity but still rejects indistinguishable alternatives on native held-out anatomy', async () => {
    const symmetric = makeStack({ frameUid: 'shared' }).map((slice, depth) => {
      const pixels = new Float32Array(slice.pixels.length);
      for (let row = 0; row < slice.dsRows; row++) {
        for (let col = 0; col < slice.dsCols; col++) {
          pixels[row * slice.dsCols + col] = Math.exp(-((row - 9) ** 2 + (col - 9) ** 2) / 36) + depth / 100;
        }
      }
      return { ...slice, pixels };
    });
    const reference = symmetric.map((slice) => ({ ...slice, pixels: new Float32Array(slice.pixels) }));
    const coarse = await registerAndResliceLongitudinal({
      referenceSlices: reference,
      targetSlices: symmetric,
      referenceSliceIndex: 9,
      initialTargetToReference: { tx: 0, ty: 0, tz: 0, rx: 0, ry: 0, rz: Math.PI / 2 },
      maxDimension: 32,
      maxSamples: 4000,
      deferPresentationValidation: true,
    });

    expect(coarse.ok).toBe(true);
    if (!coarse.ok) return;
    expect(coarse.nativeCandidatePoses?.length).toBeGreaterThan(1);

    const result = resliceDenseLongitudinalPlane({
      targetSlices: symmetric,
      referencePlane: reference[9]!,
      nativeReferenceSlices: reference.slice(7, 12),
      nativeReferenceSliceIndex: 2,
      nativeCandidatePoses: coarse.nativeCandidatePoses,
      targetToReference: coarse.targetToReference,
      centerMm: coarse.centerMm,
    });

    expect(result).toMatchObject({ ok: false, reason: 'ambiguous' });
  });
});
