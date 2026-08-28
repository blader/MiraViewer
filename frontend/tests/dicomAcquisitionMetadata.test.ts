import { afterEach, describe, expect, it, vi } from 'vitest';
import dicomParser from 'dicom-parser';
import type { DicomInstance } from '../src/db/schema';
import {
  extractDicomAcquisitionMetadata,
  MAX_ACQUISITION_HEADER_BYTES,
  readDicomAcquisitionMetadata,
} from '../src/services/dicomAcquisitionMetadata';

function dataset(tags: Record<string, string> = {}, matrix?: number[]): dicomParser.DataSet {
  return {
    string: (tag: string) => tags[tag],
    uint16: (_tag: string, index: number) => matrix?.[index],
    elements: matrix ? { x00181310: { length: matrix.length * 2 } } : {},
  } as unknown as dicomParser.DataSet;
}
const instance = (fileBlob: Blob): DicomInstance => ({
  sopInstanceUid: 'synthetic-image',
  seriesInstanceUid: 'synthetic-series',
  studyInstanceUid: 'synthetic-study',
  rows: 2,
  columns: 2,
  instanceNumber: 1,
  fileBlob,
});

afterEach(() => vi.restoreAllMocks());

describe('canonical DICOM acquisition metadata extraction', () => {
  it('retains original encoding, pre-reconstruction matrix/FOV, physical sequence, and acquisition identity', () => {
    const source = dataset(
      {
        x00080008: ' ORIGINAL\\PRIMARY\\OTHER ',
        x00180023: '3D',
        x00181100: '220',
        x00180093: '100',
        x00180094: '90',
        x00200012: '3',
        x00080022: '20260101',
        x00080032: '103015.123',
        x00180020: 'SE\\IR',
        x00180021: 'NONE',
        x00180081: '113.215',
        x00180080: '6500',
        x00180082: '1800',
      },
      [0, 224, 224, 0],
    );
    expect(extractDicomAcquisitionMetadata(source)).toEqual({
      version: 1,
      imageType: ['ORIGINAL', 'PRIMARY', 'OTHER'],
      mrAcquisitionType: '3D',
      acquisitionMatrix: [0, 224, 224, 0],
      reconstructionDiameterMm: 220,
      percentSampling: 100,
      percentPhaseFieldOfView: 90,
      acquisitionNumber: 3,
      acquisitionDateTime: '20260101103015.123',
      scanningSequence: ['SE', 'IR'],
      sequenceVariant: ['NONE'],
      echoTimeMs: 113.215,
      repetitionTimeMs: 6500,
      inversionTimeMs: 1800,
      sourceSopInstanceUids: [],
      derivationSopInstanceUids: [],
      derivationDescription: undefined,
    });
  });

  it('retains averaged reformat declarations and distinct direct/derivation source relationships', () => {
    const source = dataset({
      x00080008: 'DERIVED\\SECONDARY\\REFORMATTED\\AVERAGE',
      x00082111: 'Synthetic averaged reformat',
    });
    const reference = (uid: string) => ({ dataSet: dataset({ x00081155: uid }) });
    source.elements.x00082112 = {
      items: [reference('source-a'), reference('source-a'), reference('source-b')],
    } as dicomParser.Element;
    const derivation = dataset();
    derivation.elements.x00082112 = { items: [reference('source-c')] } as dicomParser.Element;
    source.elements.x00089124 = { items: [{ dataSet: derivation }] } as dicomParser.Element;
    expect(extractDicomAcquisitionMetadata(source)).toMatchObject({
      imageType: ['DERIVED', 'SECONDARY', 'REFORMATTED', 'AVERAGE'],
      sourceSopInstanceUids: ['source-a', 'source-b'],
      derivationSopInstanceUids: ['source-c'],
      derivationDescription: 'Synthetic averaged reformat',
    });
  });

  it('leaves absent or malformed acquisition evidence unknown instead of substituting displayed resolution', () => {
    const source = dataset(
      { x00180023: 'unknown', x00181100: 'NaN', x00200012: '1.5', x0008002a: 'not-a-time', x00180081: '-1' },
      [0, 224],
    );
    expect(extractDicomAcquisitionMetadata(source)).toMatchObject({
      version: 1,
      imageType: [],
      sourceSopInstanceUids: [],
      derivationSopInstanceUids: [],
    });
    for (const field of [
      'mrAcquisitionType',
      'acquisitionMatrix',
      'reconstructionDiameterMm',
      'acquisitionNumber',
      'acquisitionDateTime',
      'echoTimeMs',
    ] as const)
      expect(extractDicomAcquisitionMetadata(source)[field]).toBeUndefined();
  });

  it('bounds legacy reads without decoding pixels or surfacing parser exceptions', async () => {
    const file = new Blob([new Uint8Array(MAX_ACQUISITION_HEADER_BYTES + 100)]);
    const slices = vi.spyOn(Blob.prototype, 'slice');
    const parser = vi.spyOn(dicomParser, 'parseDicom').mockImplementation(() => {
      throw new Error('PRIVATE PARSER CONTENT');
    });
    const result = await readDicomAcquisitionMetadata(instance(file));
    expect(result).toMatchObject({ unavailable: true, imageType: [] });
    expect(parser).toHaveBeenCalled();
    expect(slices.mock.calls.every(([start, end]) => start === 0 && end! <= MAX_ACQUISITION_HEADER_BYTES)).toBe(true);
    expect(slices.mock.calls.at(-1)?.[1]).toBe(MAX_ACQUISITION_HEADER_BYTES);
  });

  it('honors cancellation before reading a legacy header', async () => {
    const controller = new AbortController();
    controller.abort();
    const slices = vi.spyOn(Blob.prototype, 'slice');
    await expect(
      readDicomAcquisitionMetadata(instance(new Blob([new Uint8Array(32)])), controller.signal),
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(slices).not.toHaveBeenCalled();
  });
});
