import { createHash } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import { selectPhysicalTargetSlice } from '../src/utils/alignmentGeometry';
import { applyAlignmentSliceOffset } from '../src/utils/alignmentSliceCorrection';
import { buildOutputPlaneGrid, outputGridFingerprint, outputGridPixelToWorld } from '../src/utils/outputPlaneGrid';
import { getSliceGeometryFromInstance } from '../src/utils/svr/dicomGeometry';
import { resliceDenseLongitudinalPlane } from '../src/utils/svr/longitudinalRegistration';
import type { SvrReconstructionSlice } from '../src/utils/svr/reconstructionCore';
import { applyRigidToPoint, mat3FromEulerXYZ, mat3MulVec3, type RigidParams } from '../src/utils/svr/rigidRegistration';
import { dot, type Vec3 } from '../src/utils/svr/vec3';
import {
  alignmentCorpusManifest,
  decodeAlignmentRegistrationSlice,
  inspectAlignmentCorpus,
  loadAlignmentLosslessCodec,
  type AlignmentCorpusPlane,
  type AlignmentCorpusSeries,
} from './helpers/alignmentRealCorpus';

const corpusRoot = process.env.MIRAVIEWER_ALIGNMENT_DESKTOP_CORPUS_DIR;
const runManualCorpus = process.env.MIRAVIEWER_ALIGNMENT_MANUAL_CORPUS === '1';
// Existing desktop-gold axial landmarks, zero-based. They locate a small
// sampling neighborhood; this test does not certify a tumor contour or pose.
const examinations = [
  { examination: 15, axialIndex: 91 },
  { examination: 17, axialIndex: 96 },
  { examination: 18, axialIndex: 78 },
] as const;
const planes: AlignmentCorpusPlane[] = ['AX', 'COR', 'SAG'];
const cases = examinations.flatMap((examination) => planes.map((plane) => ({ ...examination, plane })));
const identity: RigidParams = { tx: 0, ty: 0, tz: 0, rx: 0, ry: 0, rz: 0 };
const knownPose: RigidParams = { tx: 3.1, ty: -2.2, tz: 1.4, rx: 0.031, ry: -0.043, rz: 0.027 };

function fingerprint(pixels: Float32Array | Uint8Array): string {
  return createHash('sha256')
    .update(new Uint8Array(pixels.buffer, pixels.byteOffset, pixels.byteLength))
    .digest('hex');
}

function transformedReference(source: SvrReconstructionSlice, pose: RigidParams, center: Vec3) {
  const rotation = mat3FromEulerXYZ(pose.rx, pose.ry, pose.rz);
  const rotate = (point: Vec3) => mat3MulVec3(rotation, point.x, point.y, point.z);
  return {
    ...source,
    ippMm: applyRigidToPoint(source.ippMm, center, rotation, { x: pose.tx, y: pose.ty, z: pose.tz }),
    rowDir: rotate(source.rowDir),
    colDir: rotate(source.colDir),
    normalDir: rotate(source.normalDir),
  };
}

function compareNativeSamples(
  presentation: { pixels: Float32Array; valid: Uint8Array },
  acquired: SvrReconstructionSlice,
) {
  let count = 0;
  let maximumError = 0;
  let totalError = 0;
  let minimum = Number.POSITIVE_INFINITY;
  let maximum = Number.NEGATIVE_INFINITY;
  // Borders are excluded only to avoid floating-point edge support ambiguity.
  // Every supported interior pixel participates, including low-signal anatomy.
  for (let row = 2; row < acquired.dsRows - 2; row++) {
    for (let column = 2; column < acquired.dsCols - 2; column++) {
      const index = row * acquired.dsCols + column;
      if (!presentation.valid[index] || !acquired.valid?.[index]) continue;
      const raw = acquired.pixels[index]!;
      const error = Math.abs(presentation.pixels[index]! - raw);
      minimum = Math.min(minimum, raw);
      maximum = Math.max(maximum, raw);
      maximumError = Math.max(maximumError, error);
      totalError += error;
      count++;
    }
  }
  const expectedCount = (acquired.dsRows - 4) * (acquired.dsCols - 4);
  expect(count).toBeGreaterThanOrEqual(expectedCount * 0.995);
  expect(maximum - minimum, 'The native neighborhood must contain actual MRI signal').toBeGreaterThan(0);
  const range = Math.max(1, maximum - minimum);
  const meanError = totalError / Math.max(1, count);
  // Native DICOM direction/position decimals and Float32 interpolation introduce
  // small numerical error, bounded here relative to the raw signal range.
  // No windowing, contrast adjustment, or image normalization occurs.
  expect(maximumError).toBeLessThanOrEqual(Math.max(0.001, range * 0.00005));
  expect(meanError).toBeLessThanOrEqual(Math.max(0.0001, range * 0.000005));
  return { count, maximumError, meanError };
}

describe.skipIf(!runManualCorpus)(
  'manual physical sampling on the private MRI corpus (not registration accuracy)',
  () => {
    let sources: AlignmentCorpusSeries[];
    let codec: ReturnType<typeof loadAlignmentLosslessCodec>;

    beforeAll(() => {
      if (!corpusRoot) throw new Error('Set MIRAVIEWER_ALIGNMENT_DESKTOP_CORPUS_DIR to the private MRI corpus');
      // Header inspection happens once, restricted to three examinations. July's
      // extensionless DICOM files use the existing corpus helper's preamble check.
      sources = inspectAlignmentCorpus(corpusRoot, {
        studyOrdinals: examinations.map(({ examination }) => examination),
        includeExtensionlessDicom: true,
      });
      codec = loadAlignmentLosslessCodec();
    }, 60_000);

    it.each(cases)(
      'preserves native pixels through manual correction in E$examination $plane',
      async ({ examination, axialIndex, plane }) => {
        const started = performance.now();
        const candidates = sources
          .filter((source) => source.examinationOrdinal === examination && /flair/i.test(source.contrast))
          .sort((first, second) => second.frames.length - first.frames.length);
        const axial = candidates.find((source) => source.plane === 'AX');
        expect(axial, `E${examination} must contain its reviewed axial FLAIR acquisition`).toBeDefined();
        if (!axial) return;
        const axialFrame = axial.frames[axialIndex];
        expect(axialFrame, `E${examination} axial landmark must remain inside its acquisition`).toBeDefined();
        if (!axialFrame) return;
        const axialGrid = buildOutputPlaneGrid(axialFrame);
        // The existing central tumor-neighbor point is transferred only within the
        // same examination and DICOM FrameOfReference, never across scan dates.
        const neighborhood = outputGridPixelToWorld(
          axialGrid,
          (axialGrid.rows - 1) * 0.453,
          (axialGrid.columns - 1) * 0.503,
        );
        const series = candidates.find(
          (source) => source.plane === plane && source.frameOfReferenceUid === axial.frameOfReferenceUid,
        );
        expect(series, `E${examination} must contain a same-frame ${plane} FLAIR acquisition`).toBeDefined();
        if (!series) return;
        const normal = getSliceGeometryFromInstance(series.frames[0]!).normalDir;
        const desiredDepth = dot(neighborhood, normal);
        const centerIndex =
          plane === 'AX'
            ? axialIndex
            : series.frames.reduce(
                (nearest, frame, index) =>
                  Math.abs(frame.positionMm - desiredDepth) <
                  Math.abs(series.frames[nearest]!.positionMm - desiredDepth)
                    ? index
                    : nearest,
                0,
              );
        expect(centerIndex).toBeGreaterThanOrEqual(3);
        expect(centerIndex).toBeLessThan(series.frames.length - 3);
        expect(
          Math.max(series.rows, series.columns),
          'Keep the native corpus check bounded, without downsampling',
        ).toBeLessThanOrEqual(1024);
        const indices = Array.from({ length: 7 }, (_, index) => centerIndex + index - 3);
        const acquired = await Promise.all(
          indices.map((index) => decodeAlignmentRegistrationSlice(series, index, codec)),
        );
        const originalPixels = acquired.map((slice) => fingerprint(slice.pixels));
        const originalValidity = acquired.map((slice) => fingerprint(slice.valid!));
        const manifest = alignmentCorpusManifest(series);
        const originalGeometry = JSON.stringify(manifest);
        const center = neighborhood;
        let comparisons = 0;
        let checkedPixels = 0;
        let maximumNativeError = 0;

        for (const level of [-2, 0, 2]) {
          const referenceIndex = centerIndex + level;
          const reference = acquired[level + 3]!;
          for (const pose of [identity, knownPose]) {
            const referencePlane = transformedReference(reference, pose, center);
            const outputGrid = buildOutputPlaneGrid({
              rows: reference.dsRows,
              columns: reference.dsCols,
              imagePositionPatient: [referencePlane.ippMm.x, referencePlane.ippMm.y, referencePlane.ippMm.z].join('\\'),
              imageOrientationPatient: [
                referencePlane.rowDir.x,
                referencePlane.rowDir.y,
                referencePlane.rowDir.z,
                referencePlane.colDir.x,
                referencePlane.colDir.y,
                referencePlane.colDir.z,
              ].join('\\'),
              pixelSpacing: `${reference.rowSpacingDsMm}\\${reference.colSpacingDsMm}`,
            });
            const gridIdentity = outputGridFingerprint(outputGrid);
            const reslice = (manualSliceOffset: number) => {
              const correctedPose = applyAlignmentSliceOffset(manifest, pose, manualSliceOffset);
              const result = resliceDenseLongitudinalPlane({
                targetSlices: acquired,
                referencePlane,
                outputGrid,
                targetToReference: correctedPose,
                centerMm: center,
                minCoverage: 0.95,
              });
              if (!result.ok) throw new Error(`E${examination} ${plane}: ${result.reason}: ${result.message}`);
              expect(
                selectPhysicalTargetSlice(manifest, manifest, referenceIndex, {
                  rigid: correctedPose,
                  centerMm: center,
                  outputGrid,
                }),
              ).toBe(referenceIndex + manualSliceOffset);
              expect(outputGridFingerprint(result.outputGrid!)).toBe(gridIdentity);
              return result;
            };
            const baseline = reslice(0);
            for (const manualSliceOffset of [0, 1, -1]) {
              const result = manualSliceOffset === 0 ? baseline : reslice(manualSliceOffset);
              const expected = acquired[level + manualSliceOffset + 3]!;
              const measured = compareNativeSamples(result, expected);
              maximumNativeError = Math.max(maximumNativeError, measured.maximumError);
              checkedPixels += measured.count;
              comparisons++;
            }
            const reset = reslice(0);
            expect(fingerprint(reset.pixels)).toBe(fingerprint(baseline.pixels));
            expect(fingerprint(reset.valid)).toBe(fingerprint(baseline.valid));
            expect(outputGridFingerprint(outputGrid)).toBe(gridIdentity);
          }
        }
        expect(acquired.map((slice) => fingerprint(slice.pixels))).toEqual(originalPixels);
        expect(acquired.map((slice) => fingerprint(slice.valid!))).toEqual(originalValidity);
        expect(JSON.stringify(manifest)).toBe(originalGeometry);
        // Only anonymous test labels and aggregate numeric measurements are emitted.
        // No MRI images, patient identifiers, source paths, or artifacts are written.
        console.info(
          '[alignment-manual-corpus]',
          JSON.stringify({
            examination: `E${examination}`,
            plane,
            nativeRows: series.rows,
            nativeColumns: series.columns,
            sourceFrames: acquired.length,
            levels: [-2, 0, 2].map((level) => centerIndex + level),
            knownPoses: 2,
            comparisons,
            checkedPixels,
            maximumNativeError,
            elapsedMs: Math.round(performance.now() - started),
          }),
        );
      },
      90_000,
    );
  },
);
