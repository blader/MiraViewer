import { describe, expect, it } from 'vitest';
import { applyAlignmentSliceOffset } from '../src/utils/alignmentSliceCorrection';
import type { SeriesFrameManifest } from '../src/utils/localApi';
import { buildOutputPlaneGrid, outputGridFingerprint } from '../src/utils/outputPlaneGrid';
import { getSliceGeometryFromInstance } from '../src/utils/svr/dicomGeometry';
import { selectDenseLongitudinalSourceEnvelope } from '../src/utils/svr/longitudinalFrames';
import { resliceStackToReferencePlane } from '../src/utils/svr/longitudinalRegistration';
import type { SvrReconstructionSlice } from '../src/utils/svr/reconstructionCore';
import { applyRigidToPoint, mat3FromEulerXYZ, mat3MulVec3, type RigidParams } from '../src/utils/svr/rigidRegistration';

const identity: RigidParams = { tx: 0, ty: 0, tz: 0, rx: 0, ry: 0, rz: 0 };

function acquisition(depths = [0, 1, 2, 3, 4], angle = 0): SeriesFrameManifest {
  const row = [Math.cos(angle), 0, -Math.sin(angle)];
  const normal = [Math.sin(angle), 0, Math.cos(angle)];
  return {
    seriesUid: 'target',
    studyUid: 'target-study',
    patientKey: 'patient',
    frameOfReferenceUid: 'target-space',
    ordering: 'physical',
    geometryReliable: true,
    frames: depths.map((depth, index) => ({
      sopInstanceUid: `target-${index}`,
      seriesInstanceUid: 'target',
      studyInstanceUid: 'target-study',
      instanceNumber: index,
      rows: 5,
      columns: 5,
      imagePositionPatient: [normal[0]! * depth - 2 * row[0]!, -2, normal[2]! * depth - 2 * row[2]!].join('\\'),
      imageOrientationPatient: [...row, 0, 1, 0].join('\\'),
      pixelSpacing: '1\\1',
      physicalSlicePosition: depth,
      frameOfReferenceUid: 'target-space',
    })),
  };
}

describe('manual physical slice correction', () => {
  it('keeps the unadjusted pose immutable and uses a fixed median signed acquisition spacing', () => {
    const baseline = Object.freeze({ ...identity, tx: 4, tz: -3 });
    const target = acquisition([0, 1, 2, 8, 9]);

    expect(applyAlignmentSliceOffset(target, baseline, 0)).toBe(baseline);
    expect(applyAlignmentSliceOffset(target, baseline, 1)).toEqual({ ...baseline, tz: -4 });
    expect(applyAlignmentSliceOffset(target, baseline, -1)).toEqual({ ...baseline, tz: -2 });
    expect(applyAlignmentSliceOffset(target, baseline, 3)).toEqual({ ...baseline, tz: -6 });
    expect(baseline).toEqual({ ...identity, tx: 4, tz: -3 });
  });

  it('rotates an oblique acquisition displacement into reference coordinates with the correct inverse sign', () => {
    const angle = Math.PI / 6;
    const baseline = { ...identity, tx: 3, ty: -2, tz: 1, rz: Math.PI / 2 };
    const adjusted = applyAlignmentSliceOffset(acquisition([0, 2, 4], angle), baseline, 1);

    expect(adjusted.tx).toBeCloseTo(3);
    expect(adjusted.ty).toBeCloseTo(-3);
    expect(adjusted.tz).toBeCloseTo(1 - Math.sqrt(3));
    expect(adjusted.rz).toBe(baseline.rz);
    expect(applyAlignmentSliceOffset(acquisition([0, 2, 4], angle), baseline, -1).ty).toBeCloseTo(-1);
  });

  it('moves the native decoding envelope with the correction instead of reusing the old source slab', () => {
    const target = acquisition();
    const geometry = getSliceGeometryFromInstance(target.frames[2]!);
    const referencePlane = { ...geometry, dsRows: 5, dsCols: 5, rowSpacingDsMm: 1, colSpacingDsMm: 1 };
    const outputGrid = buildOutputPlaneGrid(target.frames[2]!);
    const envelope = (offset: number) =>
      selectDenseLongitudinalSourceEnvelope(
        target,
        referencePlane,
        applyAlignmentSliceOffset(target, identity, offset),
        { x: 0, y: 0, z: 0 },
        { refinePose: false, outputGrid },
      );

    expect(envelope(0).sourceIndices).toEqual([1, 2, 3]);
    expect(envelope(1).sourceIndices).toEqual([2, 3, 4]);
    expect(envelope(-1).sourceIndices).toEqual([0, 1, 2]);
    expect(envelope(0).sourceIndices).toEqual([1, 2, 3]);
    expect(() => envelope(20)).toThrow(/adjacent native target slices/);
  });

  it.each([0, Math.PI / 7])('resamples real target pixels and preserves texture on an oblique %s stack', (angle) => {
    const target = acquisition(undefined, angle);
    const stack: SvrReconstructionSlice[] = target.frames.map((frame, index) => {
      const geometry = getSliceGeometryFromInstance(frame);
      return {
        ...geometry,
        pixels: Float32Array.from({ length: 25 }, (_, pixel) => 100 * index + 3 * Math.floor(pixel / 5) + (pixel % 5)),
        valid: new Uint8Array(25).fill(1),
        dsRows: 5,
        dsCols: 5,
        rowSpacingDsMm: 1,
        colSpacingDsMm: 1,
        sliceThicknessMm: 1,
        spacingBetweenSlicesMm: 1,
        sopInstanceUid: frame.sopInstanceUid,
      };
    });
    const originalPixels = stack.map((slice) => Array.from(slice.pixels));
    const baseline = { ...identity, tx: 8, ty: -3, tz: 1, rx: 0.11, ry: -0.15, rz: 0.21 };
    const rotation = mat3FromEulerXYZ(baseline.rx, baseline.ry, baseline.rz);
    const center = { x: 1, y: 2, z: -3 };
    const source = stack[2]!;
    const rotate = (point: typeof center) => mat3MulVec3(rotation, point.x, point.y, point.z);
    const plane = {
      ...source,
      ippMm: applyRigidToPoint(source.ippMm, center, rotation, { x: baseline.tx, y: baseline.ty, z: baseline.tz }),
      rowDir: rotate(source.rowDir),
      colDir: rotate(source.colDir),
      normalDir: rotate(source.normalDir),
    };
    const grid = buildOutputPlaneGrid({
      sopInstanceUid: 'reference-plane',
      frameOfReferenceUid: 'reference-space',
      rows: 5,
      columns: 5,
      imagePositionPatient: [plane.ippMm.x, plane.ippMm.y, plane.ippMm.z].join('\\'),
      imageOrientationPatient: [
        plane.rowDir.x,
        plane.rowDir.y,
        plane.rowDir.z,
        plane.colDir.x,
        plane.colDir.y,
        plane.colDir.z,
      ].join('\\'),
      pixelSpacing: '1\\1',
    });
    const fingerprint = outputGridFingerprint(grid);
    const reslice = (offset: number) =>
      resliceStackToReferencePlane({
        targetSlices: stack,
        referenceSlice: plane,
        outputGrid: grid,
        targetToReference: applyAlignmentSliceOffset(target, baseline, offset),
        centerMm: center,
      });

    for (const offset of [1, -1, 0, 0.5]) {
      const result = reslice(offset);
      for (let row = 1; row < 4; row++) {
        for (let column = 1; column < 4; column++) {
          const index = row * 5 + column;
          expect(result.valid[index]).toBe(1);
          expect(result.pixels[index]).toBeCloseTo((2 + offset) * 100 + row * 3 + column, 4);
        }
      }
      expect(outputGridFingerprint(result.outputGrid!)).toBe(fingerprint);
    }
    expect(reslice(20).coverage).toBe(0);
    expect(stack.map((slice) => Array.from(slice.pixels))).toEqual(originalPixels);
    expect(outputGridFingerprint(grid)).toBe(fingerprint);
  });

  it.each([Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY])(
    'rejects a non-finite correction %s',
    (offset) => {
      expect(() => applyAlignmentSliceOffset(acquisition(), identity, offset)).toThrow(/finite/);
    },
  );

  it('refuses missing geometry, duplicate planes, and reversed physical manifests', () => {
    expect(() => applyAlignmentSliceOffset({ ...acquisition(), geometryReliable: false }, identity, 1)).toThrow(
      /physical/,
    );
    expect(() => applyAlignmentSliceOffset(acquisition([1]), identity, 1)).toThrow(/physical/);
    expect(() => applyAlignmentSliceOffset(acquisition([0, 0, 1]), identity, 1)).toThrow(/spacing/);
    expect(() => applyAlignmentSliceOffset(acquisition([2, 1, 0]), identity, 1)).toThrow(/spacing/);
    expect(() => applyAlignmentSliceOffset(acquisition([0, 2, 4]), identity, Number.MAX_VALUE)).toThrow(/finite/);
  });
});
