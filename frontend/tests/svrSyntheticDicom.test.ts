import dicomParser from 'dicom-parser';
import { afterEach, describe, expect, it } from 'vitest';
import { deleteAllStoredMriData } from '../src/db/db';
import { processDicomFile } from '../src/services/dicomIngestion';
import { getComparisonData, getSeriesFrameManifest } from '../src/utils/localApi';
import { createSyntheticSvrDicomFiles } from './svrSyntheticDicom';
import { resliceDenseLongitudinalPlane, resliceStackToReferencePlane } from '../src/utils/svr/longitudinalRegistration';
import type { SvrReconstructionSlice } from '../src/utils/svr/reconstructionCore';

afterEach(async () => {
  await deleteAllStoredMriData();
});

describe('privacy-safe real-browser SVR fixture', () => {
  it('preserves padded-source rejection and admits explicitly acquired background without changing pixels', async () => {
    const sources: SvrReconstructionSlice[][] = [];
    for (const pixelPaddingValue of [0, null]) {
      const files = createSyntheticSvrDicomFiles({
        imageSize: 36,
        slicesPerOrientation: 24,
        pixelPaddingValue,
        studyDate: '20360701',
      });
      const slices = await Promise.all(
        files.slice(10, 13).map(async (file) => {
          const bytes = new Uint8Array(await file.arrayBuffer());
          const data = dicomParser.parseDicom(bytes);
          expect(data.string('x00080020')).toBe('20360701');
          expect(data.uint16('x00280120')).toBe(pixelPaddingValue ?? undefined);
          const rows = data.uint16('x00280010')!;
          const columns = data.uint16('x00280011')!;
          const view = new DataView(bytes.buffer, bytes.byteOffset + data.elements.x7fe00010!.dataOffset);
          const pixels = Float32Array.from({ length: rows * columns }, (_, index) => view.getUint16(index * 2, true));
          const [x, y, z] = data.string('x00200032')!.split('\\').map(Number) as [number, number, number];
          return {
            pixels,
            valid: Uint8Array.from(pixels, (value) => Number(value !== data.uint16('x00280120'))),
            dsRows: rows,
            dsCols: columns,
            ippMm: { x, y, z },
            rowDir: { x: 1, y: 0, z: 0 },
            colDir: { x: 0, y: 1, z: 0 },
            normalDir: { x: 0, y: 0, z: 1 },
            rowSpacingDsMm: 1,
            colSpacingDsMm: 1,
            sliceThicknessMm: 1,
            spacingBetweenSlicesMm: 1,
          } satisfies SvrReconstructionSlice;
        }),
      );
      sources.push(slices);
      const referencePlane = slices[1]!;
      const presentation = resliceStackToReferencePlane({ targetSlices: slices, referenceSlice: referencePlane });
      const admitted = resliceDenseLongitudinalPlane({
        targetSlices: slices,
        referencePlane,
        targetToReference: { tx: 0, ty: 0, tz: 0, rx: 0, ry: 0, rz: 0 },
        centerMm: referencePlane.ippMm,
        refinePose: false,
      });
      if (pixelPaddingValue === null) {
        expect(presentation.coverage).toBe(1);
        expect(admitted).toMatchObject({ ok: true, coverage: 1 });
      } else {
        expect(presentation.coverage).toBeCloseTo(0.30864197530864196, 12);
        expect(admitted).toMatchObject({ ok: false, reason: 'insufficient-coverage' });
      }
    }
    for (let index = 0; index < sources[0]!.length; index++) {
      expect(sources[0]![index]!.pixels).toEqual(sources[1]![index]!.pixels);
      expect(sources[0]![index]!.ippMm).toEqual(sources[1]![index]!.ippMm);
    }
  });

  it.each(['explicit-vr-le', 'rle'] as const)(
    'creates displayable %s stacks with independent geometry and padding-aware pixels',
    async (transferSyntax) => {
      const files = createSyntheticSvrDicomFiles({
        imageSize: 12,
        slicesPerOrientation: 5,
        orientations: 3,
        transferSyntax,
      });
      expect(files).toHaveLength(15);

      const first = dicomParser.parseDicom(new Uint8Array(await files[0]!.arrayBuffer()));
      expect(first.string('x00080060')).toBe('MR');
      expect(first.string('x00100020')).toBe('SVR-SYNTHETIC-ONLY');
      expect(first.uint16('x00280010')).toBe(12);
      expect(first.uint16('x00280100')).toBe(16);
      expect(first.uint16('x00280120')).toBe(0);
      if (transferSyntax === 'explicit-vr-le') expect(first.elements.x7fe00010?.length).toBe(12 * 12 * 2);

      for (const file of files) {
        expect(await processDicomFile(file)).toMatchObject({ status: 'ingested' });
      }

      const comparison = await getComparisonData();
      expect(comparison.sequences).toHaveLength(3);
      expect(comparison.planes).toEqual(['Axial', 'Coronal', 'Sagittal']);

      const references = Object.values(comparison.series_map).map((byDate) => Object.values(byDate)[0]!);
      const manifests = await Promise.all(references.map((reference) => getSeriesFrameManifest(reference.series_uid)));
      expect(manifests.every((manifest) => manifest.geometryReliable)).toBe(true);
      expect(new Set(manifests.map((manifest) => manifest.frameOfReferenceUid)).size).toBe(1);
      expect(manifests.every((manifest) => manifest.frames.length === 5)).toBe(true);
    },
  );
});
