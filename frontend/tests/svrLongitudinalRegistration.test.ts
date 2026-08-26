import { describe, expect, it } from 'vitest';
import { buildOutputPlaneGrid } from '../src/utils/outputPlaneGrid';
import type { SvrReconstructionSlice } from '../src/utils/svr/reconstructionCore';
import {
  registerAndResliceLongitudinal,
  resliceDenseLongitudinalPlane,
  resliceStackToReferencePlane,
} from '../src/utils/svr/longitudinalRegistration';
import {
  minimumBilateralAnatomicalRetention,
  prepareAnatomicalPlaneLandmarks,
  scoreAnatomicalPlaneLandmarks,
} from '../src/utils/svr/anatomicalPlaneLandmarks';

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

function outputGridFrame(reference: SvrReconstructionSlice, pixelSpacing = '1\\1') {
  return {
    rows: reference.dsRows,
    columns: reference.dsCols,
    imagePositionPatient: `${reference.ippMm.x}\\${reference.ippMm.y}\\${reference.ippMm.z}`,
    imageOrientationPatient: '1\\0\\0\\0\\1\\0',
    pixelSpacing,
  };
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

  it('optimizes physically indistinguishable cross-frame seed poses only once', async () => {
    const result = await registerAndResliceLongitudinal({
      referenceSlices: makeStack({ frameUid: 'reference-frame' }),
      targetSlices: makeStack({ frameUid: 'target-frame' }),
      referenceSliceIndex: 9,
      maxDimension: 32,
      maxSamples: 4000,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.provenance.frameRelationship).toBe('different');
    expect(result.diagnostics.optimizedHypothesisCount).toBe(1);
    expect(result.diagnostics.optimizedAlternativeCount).toBe(0);
    expect(result.score).toBeCloseTo(1, 12);
    expect(result.targetToReference).toEqual({ tx: 0, ty: 0, tz: 0, rx: 0, ry: 0, rz: 0 });
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
      { ...outputGridFrame(reference, '1.5\\0.7'), sopInstanceUid: 'reference' },
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
    const outputGrid = buildOutputPlaneGrid(outputGridFrame(reference), { mode: 'fixed-1024' });

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
    const outputGrid = buildOutputPlaneGrid(outputGridFrame(reference), { mode: 'longest-edge', longestEdge: 9 });

    const result = resliceStackToReferencePlane({ targetSlices: stack, referenceSlice: reference, outputGrid });

    expect(result.coverage).toBe(1);
    expect(result.pixels[4 * 9 + 4]).toBeGreaterThan(0.35);
    expect(result.pixels[4 * 9 + 4]).toBeLessThan(0.65);
  });

  it.each([
    { terminal: 'first', index: 0, direction: -1 },
    { terminal: 'last', index: 18, direction: 1 },
  ])('preserves only the physically acquired half-slab beyond the $terminal slice center', ({ index, direction }) => {
    const stack = makeStack().map((slice, sourceIndex) => ({
      ...slice,
      sopInstanceUid: `source-${sourceIndex}`,
    }));
    const terminalSlice = stack[index]!;
    const withinAcquiredSlab = {
      ...terminalSlice,
      ippMm: { ...terminalSlice.ippMm, z: terminalSlice.ippMm.z + direction * 0.49 },
    };
    const supported = resliceStackToReferencePlane({ targetSlices: stack, referenceSlice: withinAcquiredSlab });

    expect(supported.coverage).toBe(1);
    expect(supported.valid.every(Boolean)).toBe(true);
    expect(supported.pixels).toEqual(terminalSlice.pixels);
    expect(supported.contributingSourceSopInstanceUids).toEqual([`source-${index}`]);

    const beyondAcquiredSlab = {
      ...terminalSlice,
      ippMm: { ...terminalSlice.ippMm, z: terminalSlice.ippMm.z + direction * 0.51 },
    };
    const unsupported = resliceStackToReferencePlane({ targetSlices: stack, referenceSlice: beyondAcquiredSlab });

    expect(unsupported.coverage).toBe(0);
    expect(unsupported.valid.every((value) => value === 0)).toBe(true);
    expect(unsupported.contributingSourceSopInstanceUids).toBeUndefined();
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

  it.each(['AX', 'COR', 'SAG'] as const)(
    'uses lesion correspondence only for explicitly requested native %s through-plane localization',
    (plane) => {
      const rotate = (point: { x: number; y: number; z: number }) =>
        plane === 'COR'
          ? { x: point.x, y: point.z, z: -point.y }
          : plane === 'SAG'
            ? { x: point.z, y: point.y, z: -point.x }
            : point;
      const orient = (stack: SvrReconstructionSlice[]) =>
        stack.map((slice) => ({
          ...slice,
          ippMm: rotate(slice.ippMm),
          rowDir: rotate(slice.rowDir),
          colDir: rotate(slice.colDir),
          normalDir: rotate(slice.normalDir),
        }));
      const reference = orient(makeStack({ frameUid: 'reference-frame' }));
      const target = orient(makeStack({ frameUid: 'target-frame' }));
      const mask = new Uint8Array(19 * 19);
      for (let row = 5; row <= 13; row++) mask.fill(1, row * 19 + 5, row * 19 + 14);
      const addLesion = (slice: SvrReconstructionSlice, contrast: number) => {
        slice.pixels[9 * 19 + 9]! += contrast;
      };
      addLesion(reference[9]!, 3);
      for (const index of [11, 12, 13]) addLesion(target[index]!, index === 12 ? 3 : 2);

      const options = {
        targetSlices: target,
        referencePlane: reference[9]!,
        nativeReferenceSlices: reference.slice(7, 12),
        nativeReferenceSliceIndex: 2,
        referenceExclusionMask: mask,
        targetToReference: { tx: 0, ty: 0, tz: 0, rx: 0, ry: 0, rz: 0 },
        centerMm: { x: 0, y: 0, z: 0 },
      };
      const anatomy = resliceDenseLongitudinalPlane(options);
      const focused = resliceDenseLongitudinalPlane({ ...options, alignmentFocus: 'tumor' });

      expect(anatomy.ok).toBe(true);
      expect(focused.ok).toBe(true);
      if (!anatomy.ok || !focused.ok) return;
      const normal = reference[9]!.normalDir;
      const throughPlaneOffset = (rigid: NonNullable<typeof anatomy.targetToReference>) =>
        rigid.tx * normal.x + rigid.ty * normal.y + rigid.tz * normal.z;

      expect(Math.abs(throughPlaneOffset(anatomy.targetToReference!))).toBeLessThan(0.5);
      expect(throughPlaneOffset(focused.targetToReference!)).toBeLessThan(-1.5);
      expect(focused.pixels[9 * 19 + 9]).toBeGreaterThan(anatomy.pixels[9 * 19 + 9]! + 0.5);
    },
  );

  it('keeps already verified bilateral anatomy when an opted-in tumor match would erase both orbital cavities', () => {
    const size = 64;
    const makeOrbitalStack = (frameUid: string) =>
      makeStack({ frameUid }).map((slice) => {
        const pixels = new Float32Array(size * size);
        for (let row = 0; row < size; row++) {
          for (let column = 0; column < size; column++) {
            const x = (column - size / 2) / (size * 0.42);
            const y = (row - size / 2) / (size * 0.44);
            if (x * x + y * y >= 1) continue;
            pixels[row * size + column] = 0.38 + 0.2 * Math.cos(x * 2) * Math.cos(y * 2);
            for (const center of [size * 0.35, size * 0.65]) {
              if (((column - center) / (size * 0.075)) ** 2 + ((row - size * 0.23) / (size * 0.055)) ** 2 < 1) {
                pixels[row * size + column] = 0;
              }
            }
          }
        }
        return {
          ...slice,
          pixels,
          dsRows: size,
          dsCols: size,
          ippMm: { ...slice.ippMm, x: -(size - 1) / 2, y: -(size - 1) / 2 },
        };
      });
    const reference = makeOrbitalStack('reference-frame');
    const target = makeOrbitalStack('target-frame');
    const mask = new Uint8Array(size * size);
    for (let row = 24; row <= 40; row++) mask.fill(1, row * size + 24, row * size + 41);
    const addTumor = (slice: SvrReconstructionSlice, contrast: number) => {
      for (let row = 30; row <= 33; row++) {
        for (let column = 30; column <= 33; column++) slice.pixels[row * size + column]! += contrast;
      }
    };
    addTumor(reference[9]!, 1);
    addTumor(target[9]!, 0.4);
    addTumor(target[12]!, 3);
    for (let row = 10; row <= 21; row++) {
      for (let column = 12; column <= 51; column++) {
        if (target[12]!.pixels[row * size + column] === 0) {
          target[12]!.pixels[row * size + column] = 0.5;
        }
      }
    }
    const prepared = prepareAnatomicalPlaneLandmarks(
      {
        pixels: reference[9]!.pixels,
        rows: size,
        cols: size,
        ippMm: reference[9]!.ippMm,
        rowDir: reference[9]!.rowDir,
        colDir: reference[9]!.colDir,
        rowSpacingDsMm: reference[9]!.rowSpacingDsMm,
        colSpacingDsMm: reference[9]!.colSpacingDsMm,
      },
      mask,
    );
    expect(prepared?.bilateral).toBeDefined();
    if (!prepared) return;

    const options = {
      targetSlices: target,
      referencePlane: reference[9]!,
      nativeReferenceSlices: reference.slice(7, 12),
      nativeReferenceSliceIndex: 2,
      referenceExclusionMask: mask,
      targetToReference: { tx: 0, ty: 0, tz: 0, rx: 0, ry: 0, rz: 0 },
      centerMm: { x: 0, y: 0, z: 0 },
    };
    const anatomy = resliceDenseLongitudinalPlane(options);
    const result = resliceDenseLongitudinalPlane({ ...options, alignmentFocus: 'tumor' });

    expect(anatomy.ok).toBe(true);
    expect(result.ok).toBe(true);
    if (!anatomy.ok || !result.ok) return;
    expect(scoreAnatomicalPlaneLandmarks(prepared, result)).toBeGreaterThan(0);
    expect(minimumBilateralAnatomicalRetention(prepared, result)).toBeGreaterThanOrEqual(0.35);
    expect(result.pixels[32 * size + 32]).toBeGreaterThan(anatomy.pixels[32 * size + 32]! + 0.5);
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

  it('selects the strongest valid rigid pose when supported alternatives are numerically indistinguishable', async () => {
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

    const result = await registerAndResliceLongitudinal({
      referenceSlices: reference,
      targetSlices: symmetric,
      referenceSliceIndex: 9,
      initialTargetToReference: { tx: 0, ty: 0, tz: 0, rx: 0, ry: 0, rz: Math.PI / 2 },
      maxDimension: 32,
      maxSamples: 4000,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.diagnostics.optimizedAlternativeCount).toBeGreaterThan(0);
    expect(result.diagnostics.scoreMargin).toBeLessThanOrEqual(result.diagnostics.minimumDistinguishableScoreMargin);
    expect(result.coverage).toBe(1);
  });

  it('selects the best native held-out pose even when its supported alternative is numerically indistinguishable', async () => {
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

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.nativeRefinement?.optimizedAlternativeCount).toBeGreaterThan(0);
    expect(result.nativeRefinement?.scoreMargin).toBeLessThanOrEqual(
      result.nativeRefinement!.minimumDistinguishableScoreMargin!,
    );
    expect(result.coverage).toBe(1);
  });
});
