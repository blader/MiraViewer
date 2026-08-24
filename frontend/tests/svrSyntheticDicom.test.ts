import dicomParser from 'dicom-parser';
import { afterEach, describe, expect, it } from 'vitest';
import { deleteAllStoredMriData } from '../src/db/db';
import { processDicomFile } from '../src/services/dicomIngestion';
import { getComparisonData, getSeriesFrameManifest } from '../src/utils/localApi';
import { createSyntheticSvrDicomFiles } from './svrSyntheticDicom';

afterEach(async () => {
  await deleteAllStoredMriData();
});

describe('privacy-safe real-browser SVR fixture', () => {
  it('creates genuine displayable DICOM stacks with independent geometry and padding-aware pixels', async () => {
    const files = createSyntheticSvrDicomFiles({
      imageSize: 12,
      slicesPerOrientation: 5,
      orientations: 3,
    });
    expect(files).toHaveLength(15);

    const first = dicomParser.parseDicom(new Uint8Array(await files[0]!.arrayBuffer()));
    expect(first.string('x00080060')).toBe('MR');
    expect(first.string('x00100020')).toBe('SVR-SYNTHETIC-ONLY');
    expect(first.uint16('x00280010')).toBe(12);
    expect(first.uint16('x00280100')).toBe(16);
    expect(first.uint16('x00280120')).toBe(0);
    expect(first.elements.x7fe00010?.length).toBe(12 * 12 * 2);

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
  });
});
