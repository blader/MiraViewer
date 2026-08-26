import { describe, expect, it } from 'vitest';
import { getPatientIdentityKey, getPatientIdentityKeys } from '../src/db/patientIdentity';
import type { DicomStudy } from '../src/db/schema';

function makeStudy(overrides: Partial<DicomStudy> & Pick<DicomStudy, 'studyInstanceUid'>): DicomStudy {
  return {
    studyDate: '20350101',
    studyDescription: 'Synthetic examination',
    patientName: 'Synthetic Patient',
    patientId: 'synthetic-patient',
    modality: 'MR',
    ...overrides,
  };
}

describe('patient identity grouping', () => {
  it('preserves unknown identities, issuer boundaries, and conservative conflicting-name isolation', () => {
    const studies = [
      makeStudy({ studyInstanceUid: 'unknown-a', patientId: '', patientName: '' }),
      makeStudy({ studyInstanceUid: 'unknown-b', patientId: '', patientName: '' }),
      makeStudy({ studyInstanceUid: 'matching-a', patientName: 'Synthetic   Patient' }),
      makeStudy({ studyInstanceUid: 'matching-b', patientName: 'synthetic patient' }),
      makeStudy({ studyInstanceUid: 'issuer-a', patientIdIssuer: 'facility-a' }),
      makeStudy({ studyInstanceUid: 'issuer-b', patientIdIssuer: 'facility-b' }),
      makeStudy({ studyInstanceUid: 'conflict-a', patientId: 'reused', patientName: 'One' }),
      makeStudy({ studyInstanceUid: 'conflict-b', patientId: 'reused', patientName: 'Two' }),
      makeStudy({ studyInstanceUid: 'conflict-blank', patientId: 'reused', patientName: '' }),
    ];

    const identities = getPatientIdentityKeys(studies);

    expect(identities.get('unknown-a')).toBe('unknown:unknown-a');
    expect(identities.get('unknown-b')).toBe('unknown:unknown-b');
    expect(identities.get('matching-a')).toBe('synthetic-patient');
    expect(identities.get('matching-b')).toBe('synthetic-patient');
    expect(identities.get('issuer-a')).toBe('facility-a::synthetic-patient');
    expect(identities.get('issuer-b')).toBe('facility-b::synthetic-patient');
    expect(identities.get('conflict-a')).toBe('reused#conflict-a');
    expect(identities.get('conflict-b')).toBe('reused#conflict-b');
    expect(identities.get('conflict-blank')).toBe('reused#conflict-blank');
    expect(studies.map((study) => identities.get(study.studyInstanceUid))).toEqual(
      studies.map((study) => getPatientIdentityKey(study, studies)),
    );
  });

  it('builds all patient identities with linear metadata access', () => {
    let identityReads = 0;
    const studies = Array.from({ length: 600 }, (_, index) => {
      const study = makeStudy({ studyInstanceUid: `synthetic-study-${index}` });
      Object.defineProperty(study, 'patientId', {
        configurable: true,
        enumerable: true,
        get: () => {
          identityReads += 1;
          return 'synthetic-patient';
        },
      });
      return study;
    });

    const identities = getPatientIdentityKeys(studies);

    expect(identities.size).toBe(600);
    expect(identityReads).toBeLessThanOrEqual(studies.length * 4);
  });
});
