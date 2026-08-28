import { describe, expect, it } from 'vitest';
import { selectInformativeAlignmentPlane } from '../src/utils/contextualAlignment';
import {
  registerAndResliceLongitudinal,
  resliceDenseLongitudinalPlane,
} from '../src/utils/svr/longitudinalRegistration';
import {
  applyRigidToPoint,
  invertRigidParams,
  mat3FromEulerXYZ,
  mat3MulVec3,
} from '../src/utils/svr/rigidRegistration';
import type { SvrReconstructionSlice } from '../src/utils/svr/reconstructionCore';
import {
  decodeAlignmentRegistrationSlice,
  inspectAlignmentCorpus,
  loadAlignmentLosslessCodec,
} from './helpers/alignmentRealCorpus';

const corpusRoot = process.env.MIRAVIEWER_ALIGNMENT_DESKTOP_CORPUS_DIR;

describe.skipIf(!corpusRoot)('automatic alignment on private MRI with independently known physical transforms', () => {
  it.each(['AX', 'COR', 'SAG'] as const)(
    'recovers a known pose with changed local signal in %s, without a tumor selection',
    async (plane) => {
      const sources = inspectAlignmentCorpus(corpusRoot!, { studyOrdinals: new Set([15]) });
      const series = sources
        .filter((source) => source.plane === plane && /flair/i.test(source.contrast))
        .sort((a, b) => b.frames.length - a.frames.length)[0];
      expect(series, `The private corpus must include the E15 ${plane} FLAIR source`).toBeDefined();
      if (!series) return;
      const codec = loadAlignmentLosslessCodec();
      const sourceIndices = Array.from({ length: Math.min(48, series.frames.length) }, (_, index) =>
        Math.round((index * (series.frames.length - 1)) / Math.min(47, series.frames.length - 1)),
      );
      const references = await Promise.all(
        sourceIndices.map((index) => decodeAlignmentRegistrationSlice(series, index, codec, 96)),
      );
      const selected = selectInformativeAlignmentPlane(
        references.map((slice) => ({
          pixels: slice.pixels,
          valid: slice.valid,
          rows: slice.dsRows,
          cols: slice.dsCols,
        })),
      );
      expect(selected).not.toBeNull();
      const selectedSource = sourceIndices[selected!]!;
      const known = {
        tx: 3.1,
        ty: -2.2,
        tz: 1.4,
        rx: Math.PI / 180,
        ry: (-2 * Math.PI) / 180,
        rz: (2.5 * Math.PI) / 180,
      };
      const knownCenter = { x: 0, y: 0, z: 0 };
      const inverse = invertRigidParams(known);
      const rotation = mat3FromEulerXYZ(inverse.rx, inverse.ry, inverse.rz);
      const translation = { x: inverse.tx, y: inverse.ty, z: inverse.tz };
      const transformed = (slice: SvrReconstructionSlice): SvrReconstructionSlice => ({
        ...slice,
        frameOfReferenceUid: 'known-synthetic-moving-frame',
        ippMm: applyRigidToPoint(slice.ippMm, knownCenter, rotation, translation),
        rowDir: mat3MulVec3(rotation, slice.rowDir.x, slice.rowDir.y, slice.rowDir.z),
        colDir: mat3MulVec3(rotation, slice.colDir.x, slice.colDir.y, slice.colDir.z),
        normalDir: mat3MulVec3(rotation, slice.normalDir.x, slice.normalDir.y, slice.normalDir.z),
        pixels: Float32Array.from(slice.pixels, (value, index) => {
          const y = Math.floor(index / slice.dsCols) / slice.dsRows;
          const x = (index % slice.dsCols) / slice.dsCols;
          const changedRegion = (x - 0.51) ** 2 + (y - 0.48) ** 2 < 0.04 ** 2;
          return value * (changedRegion ? 1.6 : 1.15) + 5;
        }),
      });
      const started = performance.now();
      const coarse = await registerAndResliceLongitudinal({
        referenceSlices: references,
        targetSlices: references.map(transformed),
        referenceSliceIndex: selected!,
        maxDimension: 96,
        maxSamples: 12_000,
        minCoverage: 0.55,
        deferPresentationValidation: true,
      });
      expect(coarse.ok, !coarse.ok ? coarse.message : undefined).toBe(true);
      if (!coarse.ok) return;
      const first = Math.max(0, selectedSource - 20);
      const last = Math.min(series.frames.length - 1, selectedSource + 20);
      const native = await Promise.all(
        Array.from({ length: last - first + 1 }, (_, i) =>
          decodeAlignmentRegistrationSlice(series, first + i, codec, 256),
        ),
      );
      const localIndex = selectedSource - first;
      const referenceStart = Math.max(0, localIndex - 4);
      const nativeReference = native.slice(referenceStart, Math.min(native.length, localIndex + 5));
      const dense = resliceDenseLongitudinalPlane({
        targetSlices: native.map(transformed),
        referencePlane: native[localIndex]!,
        nativeReferenceSlices: nativeReference,
        nativeReferenceSliceIndex: localIndex - referenceStart,
        targetToReference: coarse.targetToReference,
        centerMm: coarse.centerMm,
        minCoverage: 0.55,
      });
      expect(dense.ok, !dense.ok ? dense.message : undefined).toBe(true);
      if (!dense.ok) return;
      const recovered = dense.targetToReference ?? coarse.targetToReference;
      const recoveredRotation = mat3FromEulerXYZ(recovered.rx, recovered.ry, recovered.rz);
      const errors: number[] = [];
      for (const slice of [nativeReference[0]!, native[localIndex]!, nativeReference.at(-1)!]) {
        for (const rowFraction of [0.3, 0.5, 0.7])
          for (const colFraction of [0.3, 0.5, 0.7]) {
            const row = rowFraction * (slice.dsRows - 1) * slice.rowSpacingDsMm;
            const col = colFraction * (slice.dsCols - 1) * slice.colSpacingDsMm;
            const fixed = {
              x: slice.ippMm.x + slice.colDir.x * row + slice.rowDir.x * col,
              y: slice.ippMm.y + slice.colDir.y * row + slice.rowDir.y * col,
              z: slice.ippMm.z + slice.colDir.z * row + slice.rowDir.z * col,
            };
            const moving = applyRigidToPoint(fixed, knownCenter, rotation, translation);
            const actual = applyRigidToPoint(moving, coarse.centerMm, recoveredRotation, {
              x: recovered.tx,
              y: recovered.ty,
              z: recovered.tz,
            });
            errors.push(Math.hypot(actual.x - fixed.x, actual.y - fixed.y, actual.z - fixed.z));
          }
      }
      const rmsMm = Math.sqrt(errors.reduce((sum, error) => sum + error ** 2, 0) / errors.length);
      console.info(
        '[automatic-alignment-known-truth]',
        JSON.stringify({
          examination: 15,
          plane,
          selectedSource,
          rmsMm,
          maximumMm: Math.max(...errors),
          coverage: dense.coverage,
          milliseconds: performance.now() - started,
        }),
      );
      expect(rmsMm).toBeLessThan(1);
      expect(Math.max(...errors)).toBeLessThan(1.5);
      expect(dense.coverage).toBeGreaterThan(0.9);
    },
    120_000,
  );
});
