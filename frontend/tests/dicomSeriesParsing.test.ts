import { describe, expect, it } from 'vitest';
import {
  parsePlaneFromSeriesDescription,
  parseSequenceTypeFromSeriesDescription,
  parseSeriesDescription,
  parseWeightFromSeriesDescription,
} from '../src/utils/dicomSeriesParsing';

describe('dicomSeriesParsing', () => {
  it('parses plane from common abbreviations even with separators', () => {
    expect(parsePlaneFromSeriesDescription('AX-2')).toBe('Axial');
    expect(parsePlaneFromSeriesDescription('COR-1')).toBe('Coronal');
    expect(parsePlaneFromSeriesDescription('SAG-3')).toBe('Sagittal');

    // Loose prefix matching.
    expect(parsePlaneFromSeriesDescription('SAGIT T2')).toBe('Sagittal');
    expect(parsePlaneFromSeriesDescription('CORO T1')).toBe('Coronal');

    // Axial is sometimes written as transverse.
    expect(parsePlaneFromSeriesDescription('TRA-1')).toBe('Axial');
    expect(parsePlaneFromSeriesDescription('TRANSVERSE')).toBe('Axial');

    // Contains-anywhere fallback is intentionally aggressive.
    expect(parsePlaneFromSeriesDescription('TAX-1')).toBe('Axial');
  });

  it('parses weight from common shorthand tokens', () => {
    expect(parseWeightFromSeriesDescription('T1-MPRAGE')).toBe('T1');
    expect(parseWeightFromSeriesDescription('AX-2_T2')).toBe('T2');
    expect(parseWeightFromSeriesDescription('T1W')).toBe('T1');
    expect(parseWeightFromSeriesDescription('MPRAGET1')).toBe('T1');

    // Avoid false positives like "T10".
    expect(parseWeightFromSeriesDescription('T10')).toBeUndefined();
  });

  it('parses sequence types even when written with separators', () => {
    // Previously this would often fall through to "SE" because "SSFSE" wasn't contiguous.
    expect(parseSequenceTypeFromSeriesDescription('SS-FSE')).toBe('SSFSE');
    expect(parseSequenceTypeFromSeriesDescription('SS_FSE')).toBe('SSFSE');
  });

  it('infers weight from known sequence types when T1/T2 token is missing', () => {
    expect(parseSeriesDescription('MPRAGE')).toMatchObject({ sequenceType: 'MPRAGE', weight: 'T1' });
    expect(parseSeriesDescription('FLAIR')).toMatchObject({ sequenceType: 'FLAIR', weight: 'T2' });
  });

  it('avoids matching extremely short sequence tokens inside unrelated words', () => {
    // Regression guard: don't classify "Series 1" as SE.
    expect(parseSequenceTypeFromSeriesDescription('Series 1')).toBeUndefined();
  });
});
